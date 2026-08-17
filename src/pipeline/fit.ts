/**
 * Stage 4 -- Fit: a Gaussian + linear-background least-squares fit per detected
 * peak, giving a sub-channel centroid (+- 1-sigma), FWHM, net area and chi-square.
 *
 * Ported from the reference `energy_calibration.fit_gaussian` (Gaussian + linear
 * background via `scipy.optimize.curve_fit`, Poisson weights, centroid +- error
 * from the covariance), run here on the F1 Levenberg-Marquardt solver:
 *
 *     f(x) = amp * exp(-0.5 * ((x - mu) / sigma)^2) + m * x + b
 *     params = [amp, mu, sigma, m, b]            (the reference's order)
 *
 * The fit is on the RAW counts over the peak window -- the linear term IS the
 * background, so no SNIP pre-subtraction (the reference fits raw too). Per point
 * the weight is the Poisson 1/sigma_i = 1/sqrt(max(counts_i, 1)).
 *
 * Centroid uncertainty. `lmFit` reports `parameterErrors` in scipy's DEFAULT
 * `absolute_sigma=False` convention (rescaled by the fit's reduced chi-square s^2).
 * The reference `fit_gaussian` uses `absolute_sigma=True` -- it TRUSTS the Poisson
 * variances and does NOT rescale. To match the reference (and feed C3 the same
 * weighting), we undo the rescale: with s = sqrt(reducedChiSquare),
 *     centroidError = parameterErrors[mu] / s.
 * We compute chiSquare here anyway, so s is free. (We never edit `lmFit`; this is
 * a caller-side reconciliation -- see the flagged note in the C2 report.)
 *
 * Peak-hopping guard (RISK-01 -- fail loud, never a confident wrong centroid). LM
 * can settle in a wrong local minimum and still report `converged: true`, and the
 * reference's lenient anchor-path even "accepts" a fit whose centroid has slid to
 * the window edge (a broad Compton feature pinned to `lo`). We refuse such fits:
 * `rejectFit` drops any fit that did not converge, whose centroid left or pinned
 * against its window, whose amplitude/width is non-physical, or whose error/chi-
 * square is non-finite. `fit` returns only the surviving good fits; the per-peak
 * primitive `fitPeak` exposes the accept/reject verdict for tests and diagnostics.
 *
 * Element-agnostic (RISK-02): nothing here is isotope-shaped -- it fits whatever
 * peaks detection hands it. Every threshold is a named, documented constant.
 */
import type {
  ConditionedSpectrum,
  DetectedPeak,
  FittedPeak,
  FitRejectReason,
  FitFailureReason,
  Spectrum,
  UnfittableSurvivor,
} from '../domain/types';
import { lmFit } from '../numeric/lmFit';

// --- fit-window rule (reference anchor-path call in `energy_calibration.calibrate`) ---
/** Half-window = max(HW_FLOOR, round(HW_FACTOR * FWHM_ch)). */
export const HW_FACTOR = 2.5;
/** Minimum fit half-window (channels). */
export const HW_FLOOR = 12;
/** A window must hold at least this many points (the reference's `hi - lo >= 6`). */
export const MIN_FIT_POINTS = 6;

// --- model bounds / starting guess (reference `fit_gaussian`) ---
/** Lower bound on the Gaussian sigma (channels); the reference uses 0.5. */
export const SIGMA_LOWER_BOUND = 0.5;
/** Starting sigma = max(half_window / SIGMA0_WINDOW_DIVISOR, SIGMA0_FLOOR). */
const SIGMA0_WINDOW_DIVISOR = 3.0;
const SIGMA0_FLOOR = 1.5;
/** Proxy for the reference's +-inf bounds on amplitude / slope / intercept. Large
 * enough never to bind a real fit (counts are ~1e6 at most), finite because
 * `ml-levenberg-marquardt` fills unset bounds with finite sentinels. */
const BOUND_INF = 1e12;

// --- peak-hopping guard ---
/**
 * Reject a fit whose centroid sits within this many channels of either window
 * edge: a centroid that has slid to the boundary is a hop onto a neighbour / a
 * broad-feature slide, not a real line. Real lines sit well inside their window
 * (the window is +-2.5*FWHM around the peak), so 1 channel cleanly separates them.
 */
export const EDGE_MARGIN_CHANNELS = 1.0;
/**
 * Reject a fit whose centroid drifted more than this many detected-FWHMs from the
 * detection channel -- the centroid has hopped onto a neighbouring line or a
 * Compton tail. A genuine line's fit centroid stays within a small fraction of a
 * FWHM of where detection placed it (the real v4 lines all drift < 0.2 FWHM);
 * a drift past a whole FWHM is a hop, not a refinement (RISK-01: never a confident
 * wrong centroid). This is the C2 analogue of the reference calibrate()'s
 * pass-two `mu_tol` bound, expressed in the line's own width.
 */
export const MAX_CENTROID_DRIFT_FWHM = 1.0;

// --- solver budget ---
/** Max LM iterations per peak (generous; clean Gaussian fits converge in << 100). */
const MAX_FIT_ITERATIONS = 200;

// --- shape constants ---
/** FWHM = FWHM_PER_SIGMA * sigma for a Gaussian. */
export const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2); // 2.354820045...
/** Analytic area of a Gaussian: integral = amp * sigma * sqrt(2*pi). */
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Parameter index map for the [amp, mu, sigma, m, b] vector. */
const P_AMP = 0;
const P_MU = 1;
const P_SIGMA = 2;

/**
 * Python `round` is round-half-to-even; JS `Math.round` rounds half up. The
 * reference uses `int(round(...))` for the window, so we mirror its rule to keep
 * windows bit-identical for the (rare) exact-.5 case.
 */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** numpy-style median (average of the two central values for an even count) -- the
 * reference's `np.median(y)` used for the linear-background starting guess. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The Gaussian-plus-linear model, parameterised exactly as the reference. */
function gaussianPlusLinear(params: readonly number[]): (x: number) => number {
  const [amp, mu, sigma, m, b] = params;
  return (x: number): number => {
    const z = (x - mu) / sigma;
    return amp * Math.exp(-0.5 * z * z) + m * x + b;
  };
}

/** The fit window [lo, hi) for a peak: `hi` is EXCLUSIVE, matching the reference. */
export interface FitWindow {
  readonly lo: number;
  readonly hi: number;
}

/** The per-peak fit result BEFORE detection provenance and the fit-trace verdict
 * are stamped on. `fit()`/`fitTraced` augment this into a public {@link FittedPeak}
 * by carrying the originating {@link DetectedPeak}'s classification/significance/
 * detectedChannel (DEBT-09) and stamping the kept/rejected `status` + `rejectReason`
 * (DEBT-28: those tags are required on the public type, so they are omitted here and
 * added by `fitTraced`). Kept as the `fitPeak` output so the synthetic fit-guard unit
 * tests -- which call `fitPeak` with a bare channel/FWHM and no DetectedPeak -- need
 * no provenance. */
export type CoreFittedPeak = Omit<
  FittedPeak,
  'classification' | 'significance' | 'detectedChannel' | 'status' | 'rejectReason'
>;

/** Outcome of fitting a single peak. `accepted` fits carry a {@link CoreFittedPeak};
 * rejected ones carry a machine-readable `reason` and never a confident centroid. */
/** The converged Gaussian shape (LM result) before any guard verdict. */
export interface ConvergedShape {
  readonly amplitude: number;
  readonly mu: number;
  readonly sigma: number;
}

export interface PeakFitOutcome {
  readonly accepted: boolean;
  /** Rejection reason (machine-readable token) when `accepted` is false, else null. */
  readonly reason: string | null;
  /** The core fit when `accepted`, else null (provenance stamped later by `fit`). */
  readonly peak: CoreFittedPeak | null;
  /** The window the fit ran over (always reported, even on rejection). */
  readonly window: FitWindow;
  /**
   * The converged amp/centroid/sigma, present once the LM fit produced a usable
   * shape — on accept AND on a peak-hop / edge guard rejection (so the inspector
   * can show a rejected fit's centroid). `null` when the fit never converged, had
   * too few points, or was non-physical.
   */
  readonly converged: ConvergedShape | null;
}

function rejected(
  reason: string,
  window: FitWindow,
  converged: ConvergedShape | null = null,
): PeakFitOutcome {
  return { accepted: false, reason, peak: null, window, converged };
}

/**
 * Fit one peak. `counts` is the RAW spectrum; `channel` the integer peak channel
 * and `fwhmChannels` its detected FWHM (peak_widths @ 0.5). Returns an accept /
 * reject verdict; a rejected peak never yields a {@link FittedPeak}.
 */
export function fitPeak(
  counts: readonly number[],
  channel: number,
  fwhmChannels: number,
): PeakFitOutcome {
  const n = counts.length;
  const halfWindow = Math.max(HW_FLOOR, pyRound(HW_FACTOR * fwhmChannels));
  const lo = Math.max(pyRound(channel - halfWindow), 0);
  const hi = Math.min(pyRound(channel + halfWindow) + 1, n);
  const window: FitWindow = { lo, hi };
  const nWin = hi - lo;
  if (nWin < MIN_FIT_POINTS) return rejected('too_few_points', window);

  const x = new Array<number>(nWin);
  const y = new Array<number>(nWin);
  const weights = new Array<number>(nWin);
  for (let i = 0; i < nWin; i++) {
    const ch = lo + i;
    x[i] = ch;
    const c = counts[ch];
    y[i] = c;
    weights[i] = 1 / Math.sqrt(Math.max(c, 1)); // Poisson 1/sigma_i, clipped at 1
  }

  // Starting guess + bounds, verbatim from the reference `fit_gaussian`.
  const base = median(y);
  const amp0 = Math.max(Math.max(...y) - base, 1);
  const sigma0 = Math.max(halfWindow / SIGMA0_WINDOW_DIVISOR, SIGMA0_FLOOR);
  const mu0 = Math.min(Math.max(channel, lo), hi);
  const initialValues = [amp0, mu0, sigma0, 0, base];
  const minValues = [0, lo, SIGMA_LOWER_BOUND, -BOUND_INF, -BOUND_INF];
  const maxValues = [BOUND_INF, hi, nWin, BOUND_INF, BOUND_INF];

  const result = lmFit({ x, y }, gaussianPlusLinear, {
    initialValues,
    minValues,
    maxValues,
    weights,
    maxIterations: MAX_FIT_ITERATIONS,
  });

  if (!result.converged) return rejected('not_converged', window);

  const amp = result.parameters[P_AMP];
  const mu = result.parameters[P_MU];
  const sigma = Math.abs(result.parameters[P_SIGMA]);
  // The converged shape, kept so the position-guard rejections below can surface a
  // rejected fit's centroid to the inspector (the non-physical checks reject first
  // and so carry no usable shape).
  const converged: ConvergedShape = { amplitude: amp, mu, sigma };

  // --- peak-hopping / non-physical guard (fail loud, never a fake centroid) ---
  if (!(amp > 0)) return rejected('nonpositive_amplitude', window);
  if (!(sigma > SIGMA_LOWER_BOUND)) return rejected('sigma_at_or_below_lower_bound', window);
  if (!(mu >= lo && mu <= hi)) return rejected('centroid_out_of_window', window, converged);
  if (mu - lo < EDGE_MARGIN_CHANNELS || hi - mu < EDGE_MARGIN_CHANNELS) {
    return rejected('centroid_pinned_to_window_edge', window, converged);
  }
  if (Math.abs(mu - channel) > MAX_CENTROID_DRIFT_FWHM * fwhmChannels) {
    return rejected('centroid_drifted_off_peak', window, converged);
  }

  // --- chi-square (weighted SSR) + absolute_sigma=True centroid error ---------
  const f = gaussianPlusLinear(result.parameters);
  let chiSquare = 0;
  for (let i = 0; i < nWin; i++) {
    const r = y[i] - f(x[i]);
    chiSquare += (r * r) / Math.max(y[i], 1);
  }
  const dof = nWin - initialValues.length;
  if (dof <= 0) return rejected('insufficient_dof', window);
  if (!Number.isFinite(chiSquare) || chiSquare <= 0) return rejected('nonfinite_chi_square', window);

  const muErrRelative = result.parameterErrors[P_MU]; // absolute_sigma=False (s-scaled)
  if (!Number.isFinite(muErrRelative)) return rejected('nonfinite_centroid_error', window);
  const s = Math.sqrt(chiSquare / dof);
  const centroidError = muErrRelative / s; // undo the reduced-chi-square rescale
  if (!Number.isFinite(centroidError) || centroidError <= 0) {
    return rejected('nonfinite_centroid_error', window);
  }

  const peak: CoreFittedPeak = {
    centroidChannel: mu,
    centroidError,
    amplitude: amp,
    fwhmChannels: FWHM_PER_SIGMA * sigma,
    netArea: amp * sigma * SQRT_2PI, // fitted-Gaussian area (background excluded); see DEBT-04
    chiSquare,
    energyKeV: null, // stays null until calibration (C3)
  };
  return { accepted: true, reason: null, peak, window, converged };
}

/** Detection-token reject reasons that map to a retained, inspector-visible fit. */
const FIT_REJECT_MAP: Record<string, FitRejectReason> = {
  centroid_out_of_window: 'edge',
  centroid_pinned_to_window_edge: 'edge',
  centroid_drifted_off_peak: 'peak-hop',
};

/** `fitPeak` failure tokens that produced NO usable line -> {@link FitFailureReason}
 * (GAP-07). These have `converged === null`; the catch-all `else` in `fitTraced`
 * buckets them, defaulting to `'degenerate'` for any unmapped/absent token. */
const FIT_FAILURE_MAP: Record<string, FitFailureReason> = {
  too_few_points: 'too-few-points',
  not_converged: 'no-convergence',
  nonpositive_amplitude: 'non-physical',
  sigma_at_or_below_lower_bound: 'non-physical',
  insufficient_dof: 'degenerate',
  nonfinite_chi_square: 'degenerate',
  nonfinite_centroid_error: 'degenerate',
};

/** Fit output split into the kept fits, the full list including the fits the peak-hop
 * / edge guard rejected, and the survivors that produced no usable line at all. The
 * three lists are the structural partition of the survivors (GAP-07, Phase 0/4a). */
export interface FitTrace {
  /** Kept fits + edge/hop-rejected fits, in detection (ascending-channel) order. */
  readonly all: FittedPeak[];
  /** `status === 'kept'` — byte-identical to what {@link fit} returns. */
  readonly kept: FittedPeak[];
  /** Survivors that produced no usable Gaussian line (incl. caught throws). */
  readonly unfittable: UnfittableSurvivor[];
}

/**
 * Fit every detected peak, retaining the fits the peak-hop / edge guard rejected.
 * Kept fits are computed EXACTLY as before (so {@link AnalysisReport.peaks} and the
 * calibration are unchanged); a rejected fit is retained only when the guard fires
 * after the LM produced a converged shape, carrying that shape's centroid/amp/FWHM
 * (with `chiSquare: null` and a non-finite `centroidError`, since the guard rejects
 * before those statistics are computed). Other failures (too few points, non-
 * convergence, non-physical) yield no usable line and are not retained.
 */
export function fitTraced(
  conditioned: ConditionedSpectrum,
  candidates: readonly DetectedPeak[],
  rawSource?: Spectrum,
): FitTrace {
  // // Divergence (R1 -- area integrity): the quantitative fit (centroid / area /
  // FWHM) is ALWAYS summed over the ORIGINAL raw counts, never a smoothed working
  // series. `rawSource` lets a caller (Peak Finder, whose working spectrum may be
  // SG-smoothed) point the fit back at the untouched raw spectrum; absent, it
  // defaults to `conditioned.source` so the Calibrate / Identify path is byte-
  // identical (there the conditioned source IS the raw spectrum).
  const counts = (rawSource ?? conditioned.source).counts;
  const kept: FittedPeak[] = [];
  const all: FittedPeak[] = [];
  const unfittable: UnfittableSurvivor[] = [];
  for (const c of candidates) {
    let outcome: PeakFitOutcome;
    try {
      // Per-survivor resilience (narrowly scoped, operator ruling): ONLY the fit
      // unit of work is guarded. A single fit throwing must not abort the run, but a
      // real bug still screams (console.error) and the survivor is surfaced as
      // unfittable('error') -- never silently hidden. Nothing broader is caught.
      outcome = fitPeak(counts, c.channel, c.fwhmChannels);
    } catch (err) {
      console.error(
        `fitTraced: fitPeak threw for survivor channel=${c.channel} fwhm=${c.fwhmChannels}`,
        err,
      );
      unfittable.push({ detectedChannel: c.channel, reason: 'error' });
      continue;
    }
    if (outcome.accepted && outcome.peak) {
      // DEBT-09: stamp the originating DetectedPeak's quality signals onto the
      // emitted FittedPeak (pure carry-through; the fit values are untouched).
      const peak: FittedPeak = {
        ...outcome.peak,
        classification: c.classification,
        significance: c.significance,
        detectedChannel: c.channel,
        status: 'kept',
      };
      kept.push(peak);
      all.push(peak);
      continue;
    }
    const reason = outcome.reason ? FIT_REJECT_MAP[outcome.reason] : undefined;
    if (reason && outcome.converged) {
      const { amplitude, mu, sigma } = outcome.converged;
      all.push({
        centroidChannel: mu,
        centroidError: NaN, // the guard rejects before the covariance-based term
        amplitude,
        fwhmChannels: FWHM_PER_SIGMA * sigma,
        netArea: amplitude * sigma * SQRT_2PI,
        chiSquare: null,
        energyKeV: null,
        classification: c.classification,
        significance: c.significance,
        detectedChannel: c.channel,
        status: 'rejected',
        rejectReason: reason,
      });
      continue;
    }
    // Structural catch-all: any survivor still here produced no usable line. This
    // makes the partition total by construction -- no survivor can fall through
    // un-bucketed whatever the outcome shape or a future change.
    unfittable.push({
      detectedChannel: c.channel,
      reason: FIT_FAILURE_MAP[outcome.reason ?? ''] ?? 'degenerate',
    });
  }
  return { all, kept, unfittable };
}

/**
 * Fit every detected peak; return only the fits that survive the peak-hopping
 * guard, in detection (ascending-channel) order. Rejected peaks are dropped from
 * this list -- {@link fitTraced} retains the edge/hop ones for the inspector.
 */
export function fit(
  conditioned: ConditionedSpectrum,
  candidates: readonly DetectedPeak[],
): FittedPeak[] {
  return fitTraced(conditioned, candidates).kept;
}
