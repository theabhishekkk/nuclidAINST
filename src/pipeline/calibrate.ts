/**
 * Stage 5 -- Calibrate: turn fitted peaks from operator-declared known sources
 * into a channel -> energy equation.
 *
 * Full port of the reference's eight-step `energy_calibration.calibrate`
 * (Gamma Spectroscopy Suite / Energy Calibration Equation V3). The one
 * deliberate adaptation is dictated by the v4 stage contract: the reference
 * *re-fits* a Gaussian inside `calibrate` (anchor-path wide, secondary-path in a
 * tight `mu_tol` window); here C1 (detect) + C2 (fit) have ALREADY produced
 * `FittedPeak.centroidChannel ± centroidError`, so pass two MATCHES a pre-fitted
 * centroid inside the same tight window instead of fitting one. The window/tol
 * arithmetic, the 0.85·mu_tol hop test, the σ-clip rule, the curvature-
 * significance model choice and the valid-range definition are ported verbatim.
 *
 * Identity is an INPUT (Rule 12): each source carries the operator-declared kit
 * id; nothing is read from a filename. The kit is a general N-line list (RISK-02)
 * -- no isotope is special-cased.
 *
 * Eight steps, mapped to the reference:
 *   1. declared identity -> kit lines              (caller supplies `sourceId`)
 *   2. rough survey -> preliminary scale            ({@link preliminaryLinear})
 *   3. precise centroids                            (C2 `FittedPeak`, consumed here)
 *   4. two-pass anchor->secondary, tight windows    (pass one / pass two below)
 *   5. assemble weighted points (w = 1/centroidError)
 *   6. weighted polyfit linear & quadratic + cov    (F1 `weightedPolyfit`)
 *   7. σ-clip prune unreliable outliers, refit
 *   8. report BOTH equations + metrics (rms / max|resid| / r² / valid-range) and
 *      mark one `selected` per the {@link CalibrationModelPolicy}.
 *
 * Dual output + selectable default. `calibrate` returns a {@link CalibrationResult}
 * carrying BOTH the linear and (when ≥4 used points) the quadratic equation, with
 * one marked `selected` by the `defaultModel` policy so the M4 UI can switch
 * between them. The σ-clipped weighted point set feeds BOTH fits (the reference
 * σ-clips once, on the quadratic, then fits linear & quadratic on that same kept
 * set -- ported verbatim).
 *
 * Model-choice policy. The V3 reference hard-codes linear; the canonical Suite
 * chooses quadratic when the curvature term is ≥ 3σ from zero. That Suite logic is
 * the `'auto'` policy (the dev-phase default): on the real lab data the curvature
 * IS significant (curv_sig ≈ 9.5), so `'auto'` selects quadratic, matching the
 * reference; `'linear'` always keeps the line; `'quadratic'` prefers the curve and
 * falls back to linear when unavailable. See {@link CURVATURE_SIGNIFICANCE_THRESHOLD}.
 *
 * Two entry points share one fit core. `calibrate` (above) drives steps 1-5 from
 * the two-pass auto-matcher; `calibrateFromMatches` takes human-provided
 * (channel -> energy) assignments from Declare Identities instead. Both feed the
 * same internal `selectAndFit` (steps 6-8), differing only in σ-clip authority:
 * the auto path PRUNES an unreliable outlier, the human path only ADVISES on it.
 */
import type {
  Calibration,
  CalibrationKit,
  CalibrationKitEntry,
  CalibrationLine,
  CalibrationModel,
  CalibrationModelPolicy,
  CalibrationPoint,
  CalibrationResult,
  CalibrationTrace,
  FittedPeak,
  PeakAssignment,
} from '../domain/types';
import { ValidationError } from '../domain/errors';
import { CENTROID_ERR_FLOOR, weightedPolyfit, type PolyFitResult } from '../numeric/polyfit';
import { CALIBRATION_KIT } from '../data/calibrationKit';

// --- named thresholds, ported from energy_calibration.calibrate -------------

/** Minimum anchor lines needed to establish a channel->energy scale (reference:
 * `len(anchor_points) < 2 -> raise`). */
export const MIN_ANCHOR_LINES = 2;
/** Fallback resolution coefficient σ(ch) ≈ k·√ch when no anchor sigma is usable
 * (reference: `ksig = ... else 0.6`). */
export const KSIG_FALLBACK = 0.6;

// `_window_and_tol`: half_window = clip(1.7·predσ, 7, 45); the tight centroid
// tolerance = clip(0.42·gap_ch, 2.5, max(1.6·predσ, 3)), then min(·, hw-1).
export const HALF_WINDOW_SIGMA_FACTOR = 1.7;
export const HALF_WINDOW_MIN = 7.0;
export const HALF_WINDOW_MAX = 45.0;
export const MU_TOL_GAP_FACTOR = 0.42;
export const MU_TOL_MIN = 2.5;
export const MU_TOL_SIGMA_FACTOR = 1.6;
export const MU_TOL_SIGMA_FLOOR = 3.0;
/** Neighbour gap (channels) assumed for a line with no same-source neighbour
 * (reference: `... else 60.0`). */
export const DEFAULT_NEIGHBOUR_GAP_CH = 60.0;

/** Pass two rejects a match whose centroid sits past this fraction of the
 * centroid tolerance from the prediction -- it has hopped onto a neighbour
 * (reference: `abs(mu - pred) > 0.85 * mu_tol`). */
export const HOP_REJECT_FRACTION = 0.85;
/** A predicted channel within this margin of the spectrum edge is off-scale and
 * skipped (reference: `pred < 2 or pred > nchan - 2`). */
export const PRED_EDGE_MARGIN_CH = 2.0;

// σ-clip: while > 6 points remain, drop the single worst UNRELIABLE point whose
// residual exceeds max(3·rms, 2 keV) on the quadratic fit, then refit.
export const SIGMA_CLIP_MIN_POINTS = 6;
export const SIGMA_CLIP_RESID_FACTOR = 3.0;
export const SIGMA_CLIP_RESID_FLOOR = 2.0;

/** Choose quadratic only when the curvature term is at least this many σ from
 * zero (reference Suite: `curvature_significance() >= 3.0`). */
export const CURVATURE_SIGNIFICANCE_THRESHOLD = 3.0;

/** Fewest matched points for an honest covariance-bearing fit. `weightedPolyfit`
 * needs N > degree+1, so a linear (degree 1) fit needs ≥ 3 points. */
export const MIN_FIT_POINTS = 3;

/** FWHM = FWHM_PER_SIGMA · σ for a Gaussian (used to recover σ from a fitted FWHM). */
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

// --- public input shape -----------------------------------------------------

/** One operator-declared known source: its kit identity plus the C2 fitted peaks
 * of its spectrum. Identity is asserted, never derived from a filename (Rule 12). */
export interface DeclaredSource {
  /** Kit entry id, e.g. "Co-60". Must exist in the kit passed to {@link calibrate}. */
  readonly sourceId: string;
  /** The fitted peaks of this source's spectrum (C1 detect -> C2 fit). */
  readonly fittedPeaks: readonly FittedPeak[];
  /** Optional spectrum length; when given, pass-two predictions outside
   * [2, channelCount-2] are skipped (the reference's `nchan` edge guard). */
  readonly channelCount?: number;
}

/** Options for {@link calibrate}. */
export interface CalibrateOptions {
  /** Which equation to mark active; default `'auto'` (dev-phase). See
   * {@link CalibrationModelPolicy}. */
  readonly defaultModel?: CalibrationModelPolicy;
}

// --- small numeric helpers --------------------------------------------------

function clip(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** numpy-style median (mean of the two central values for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Evaluate an ASCENDING-power polynomial at x (Horner). Mirrors
 * {@link applyCalibrationToChannel} for use on a raw coefficient array. */
function evalAscending(coeffs: readonly number[], x: number): number {
  let e = 0;
  for (let k = coeffs.length - 1; k >= 0; k--) e = e * x + coeffs[k];
  return e;
}

/**
 * Re-order a {@link PolyFitResult} from numpy's highest-power-first convention to
 * the ascending order this module's `coefficients`/covariance use. For a quadratic
 * `[c2,c1,c0] -> [c0,c1,c2]` and `cov[i][j] -> cov[order-1-i][order-1-j]`.
 */
function toAscending(fit: PolyFitResult): { coeffs: number[]; cov: number[][] } {
  const order = fit.coeffs.length;
  const coeffs = fit.coeffs.slice().reverse();
  const cov = Array.from({ length: order }, (_, i) =>
    Array.from({ length: order }, (_, j) => fit.covariance[order - 1 - i][order - 1 - j]),
  );
  return { coeffs, cov };
}

/** Weighted polynomial fit over calibration points, weighting each by
 * `1/clip(centroidError, FLOOR, ∞)` (an absent error -> weight 1). */
function weightedFit(points: readonly CalibrationPoint[], degree: number): PolyFitResult {
  const x = points.map((p) => p.channel);
  const y = points.map((p) => p.energyKeV);
  const w = points.map((p) => 1 / Math.max(p.centroidError ?? 1, CENTROID_ERR_FLOOR));
  return weightedPolyfit(x, y, w, degree);
}

/** Preliminary E = a0 + b0·ch from the anchors (pass-one scale). A two-parameter
 * weighted least-squares -- no covariance, so (unlike `weightedPolyfit`) it works
 * with as few as two anchors. Matches the reference `_preliminary_linear`
 * (`np.polyfit(ch, en, 1, w=1/clip(err,1e-3,None))`). */
function preliminaryLinear(anchors: readonly CalibrationPoint[]): { a0: number; b0: number } {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (const p of anchors) {
    const w = 1 / Math.max(p.centroidError ?? 1, CENTROID_ERR_FLOOR);
    const w2 = w * w; // np.polyfit scales the residual by w, i.e. W = w² in the normal equations
    const x = p.channel;
    const y = p.energyKeV;
    sw += w2;
    swx += w2 * x;
    swy += w2 * y;
    swxx += w2 * x * x;
    swxy += w2 * x * y;
  }
  const denom = sw * swxx - swx * swx;
  if (!(Math.abs(denom) > 0) || !Number.isFinite(denom)) {
    throw new ValidationError(
      'calibrate: anchor channels are collinear/degenerate; cannot form a preliminary scale.',
    );
  }
  const b0 = (sw * swxy - swx * swy) / denom;
  const a0 = (swy - b0 * swx) / sw;
  return { a0, b0 };
}

/** Half-window (wide enough for the peak) and centroid tolerance (tight enough to
 * forbid hopping) for a secondary line in pass two. Verbatim from the reference
 * `_window_and_tol`. */
function windowAndTol(
  line: CalibrationLine,
  sourceLines: readonly CalibrationLine[],
  predCh: number,
  gain: number,
  ksig: number,
): { halfWindow: number; muTol: number } {
  const predSigma = ksig * Math.sqrt(Math.max(predCh, 1));
  const others = sourceLines
    .filter((l) => l.energyKeV !== line.energyKeV)
    .map((l) => l.energyKeV);
  const gapCh = others.length
    ? Math.min(...others.map((e) => Math.abs(line.energyKeV - e))) / gain
    : DEFAULT_NEIGHBOUR_GAP_CH;
  const halfWindow = clip(HALF_WINDOW_SIGMA_FACTOR * predSigma, HALF_WINDOW_MIN, HALF_WINDOW_MAX);
  let muTol = clip(
    MU_TOL_GAP_FACTOR * gapCh,
    MU_TOL_MIN,
    Math.max(MU_TOL_SIGMA_FACTOR * predSigma, MU_TOL_SIGMA_FLOOR),
  );
  muTol = Math.min(muTol, halfWindow - 1);
  return { halfWindow, muTol };
}

function pointLabel(sourceId: string, energyKeV: number): string {
  return `${sourceId} ${energyKeV} keV`;
}

// --- the two-pass orchestration --------------------------------------------

/**
 * Build a channel->energy calibration from declared known sources and the kit.
 * Returns BOTH candidate equations with one marked `selected` per `options.defaultModel`.
 *
 * @throws ValidationError on no sources, an unknown declared id, too few anchors,
 *   a degenerate preliminary scale, or too few usable points for an honest fit --
 *   it never fabricates an equation (RISK-01/04).
 */
export function calibrate(
  sources: readonly DeclaredSource[],
  kit: CalibrationKit = CALIBRATION_KIT,
  options: CalibrateOptions = {},
): CalibrationResult {
  const defaultModel: CalibrationModelPolicy = options.defaultModel ?? 'auto';
  if (!sources.length) throw new ValidationError('calibrate: no declared sources supplied.');
  const kitById = new Map<string, CalibrationKitEntry>(kit.entries.map((e) => [e.id, e]));

  // Per source: indices of fitted peaks already consumed (so one peak -> one line).
  const consumed = new Map<string, Set<number>>();
  const consumedFor = (id: string): Set<number> => {
    let s = consumed.get(id);
    if (!s) {
      s = new Set<number>();
      consumed.set(id, s);
    }
    return s;
  };

  // ---- pass one: match strong anchor lines to the biggest fitted peaks ------
  const anchorPoints: CalibrationPoint[] = [];
  const anchorMeta: { channel: number; sigma: number }[] = [];
  for (const src of sources) {
    const entry = kitById.get(src.sourceId);
    if (!entry) {
      throw new ValidationError(
        `calibrate: declared source "${src.sourceId}" is not in the calibration kit.`,
      );
    }
    const anchors = entry.lines.filter((l) => l.tier === 'anchor');
    if (!anchors.length) continue;

    // Pass-one anchor selection, ported verbatim from the reference
    // `energy_calibration.calibrate` (V3): filter the survey candidates to the
    // `line` class, rank by NET AREA (descending), take the strongest #anchors,
    // then order by channel and zip to the energy-sorted anchor lines
    //   line_cands = [c for c in cands if line] or cands
    //   strong = sorted(line_cands, key=net_area, reverse=True)[:len(anchors)]
    //   strong = sorted(strong, key=channel)
    //
    // DEBT-16: the prior v4 build ranked by raw AMPLITUDE without the line filter
    // (a `FittedPeak` carried no `classification` then). On real NaI spectra a tall
    // low-energy BACKSCATTER feature can out-peak the photopeak, so a single-anchor
    // source like Cs-137 bound its 661.7 keV anchor to channel ~30 instead of ~590,
    // collapsing the whole fit. With DEBT-09's `classification`/`netArea` carried
    // onto `FittedPeak`, we now port the reference exactly: the line filter excludes
    // broad/weak features and net-area ranking favours the photopeak (a sharp,
    // high-area line) over a tall-but-narrow or broad decoy. On clean photopeak-
    // dominant inputs (the parity + synthetic fixtures) line-class + net-area order
    // the anchors identically to before, so C3 parity is preserved. The `|| cands`
    // fallback (use all candidates when none is line-classified) matches the
    // reference and keeps reconstructed/clean inputs working.
    const indexed = src.fittedPeaks.map((p, i) => ({ p, i }));
    const lineCands = indexed.filter((x) => x.p.classification === 'line');
    const pool = lineCands.length ? lineCands : indexed;
    const ranked = pool
      .slice()
      .sort((a, b) => b.p.netArea - a.p.netArea)
      .slice(0, anchors.length)
      .sort((a, b) => a.p.centroidChannel - b.p.centroidChannel);
    const sortedAnchors = [...anchors].sort((a, b) => a.energyKeV - b.energyKeV);

    const used = consumedFor(src.sourceId);
    const n = Math.min(sortedAnchors.length, ranked.length);
    for (let k = 0; k < n; k++) {
      const line = sortedAnchors[k];
      const { p, i } = ranked[k];
      used.add(i);
      anchorPoints.push({
        channel: p.centroidChannel,
        energyKeV: line.energyKeV,
        sourceLabel: pointLabel(src.sourceId, line.energyKeV),
        centroidError: p.centroidError,
        sourceId: src.sourceId,
        tier: 'anchor',
        reliable: line.reliable,
        used: true,
        note: '',
      });
      anchorMeta.push({ channel: p.centroidChannel, sigma: p.fwhmChannels / FWHM_PER_SIGMA });
    }
  }

  if (anchorPoints.length < MIN_ANCHOR_LINES) {
    throw new ValidationError(
      `calibrate: need at least ${MIN_ANCHOR_LINES} anchor lines to establish a scale; ` +
        `matched ${anchorPoints.length}. Declare more known sources or check the fitted peaks.`,
    );
  }

  const { a0, b0 } = preliminaryLinear(anchorPoints);
  if (!Number.isFinite(b0) || b0 === 0) {
    throw new ValidationError('calibrate: preliminary gain is zero or non-finite (degenerate anchors).');
  }

  // Resolution model from the anchors: σ(ch) ≈ ksig·√ch.
  const ks = anchorMeta
    .filter((m) => m.sigma > 0)
    .map((m) => m.sigma / Math.sqrt(Math.max(m.channel, 1)));
  const ksig = ks.length ? median(ks) : KSIG_FALLBACK;

  // Trace (display-only, additive): the rough per-anchor gain profile (reference
  // `gain_profile`, Stage 2), sorted ascending by energy. Captured from locals
  // already computed; never fed back into any fit.
  const gainProfile: CalibrationTrace['gainProfile'] = anchorPoints
    .map((p) => ({ energyKeV: p.energyKeV, channel: p.channel, gain: p.energyKeV / p.channel }))
    .sort((a, b) => a.energyKeV - b.energyKeV);
  // One entry per secondary line attempted, restating the pass-two branch taken.
  const secondaryWindows: CalibrationTrace['secondaryWindows'][number][] = [];

  // ---- pass two: predict + tightly match the secondary / congested lines ----
  const points: CalibrationPoint[] = [...anchorPoints];
  for (const src of sources) {
    const entry = kitById.get(src.sourceId)!;
    const secondaries = entry.lines.filter((l) => l.tier !== 'anchor');
    if (!secondaries.length) continue;
    const used = consumedFor(src.sourceId);

    for (const line of secondaries) {
      const pred = (line.energyKeV - a0) / b0;
      const base = {
        energyKeV: line.energyKeV,
        sourceLabel: pointLabel(src.sourceId, line.energyKeV),
        sourceId: src.sourceId,
        tier: 'secondary' as const,
        reliable: line.reliable,
      };
      if (
        pred < PRED_EDGE_MARGIN_CH ||
        (src.channelCount != null && pred > src.channelCount - PRED_EDGE_MARGIN_CH)
      ) {
        points.push({ ...base, channel: pred, used: false, note: 'predicted off-scale' });
        secondaryWindows.push({
          sourceId: src.sourceId,
          energyKeV: line.energyKeV,
          predictedChannel: pred,
          halfWindow: NaN, // off-scale: skipped windowing before windowAndTol
          muTol: NaN,
          matchedChannel: null,
          outcome: 'off-scale',
        });
        continue;
      }

      const { halfWindow, muTol } = windowAndTol(line, entry.lines, pred, b0, ksig);

      // Nearest UNCONSUMED fitted peak inside the (wide) half-window.
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < src.fittedPeaks.length; i++) {
        if (used.has(i)) continue;
        const d = Math.abs(src.fittedPeaks[i].centroidChannel - pred);
        if (d <= halfWindow && d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      if (best < 0) {
        points.push({ ...base, channel: pred, used: false, note: 'no fitted peak in window' });
        secondaryWindows.push({
          sourceId: src.sourceId,
          energyKeV: line.energyKeV,
          predictedChannel: pred,
          halfWindow,
          muTol,
          matchedChannel: null,
          outcome: 'no-peak',
        });
        continue;
      }

      const peak = src.fittedPeaks[best];
      // Tight (mu_tol) gate: a match past 0.85·mu_tol has hopped onto a neighbour.
      if (Math.abs(peak.centroidChannel - pred) > HOP_REJECT_FRACTION * muTol) {
        points.push({
          ...base,
          channel: peak.centroidChannel,
          centroidError: peak.centroidError,
          used: false,
          note: 'rejected: peak-hop',
        });
        secondaryWindows.push({
          sourceId: src.sourceId,
          energyKeV: line.energyKeV,
          predictedChannel: pred,
          halfWindow,
          muTol,
          matchedChannel: peak.centroidChannel,
          outcome: 'hop-rejected',
        });
        continue;
      }
      used.add(best);
      points.push({
        ...base,
        channel: peak.centroidChannel,
        centroidError: peak.centroidError,
        used: true,
        note: '',
      });
      secondaryWindows.push({
        sourceId: src.sourceId,
        energyKeV: line.energyKeV,
        predictedChannel: pred,
        halfWindow,
        muTol,
        matchedChannel: peak.centroidChannel,
        outcome: 'used',
      });
    }
  }

  // ---- steps 6-8: shared σ-clip + fit + model selection ----------------------
  // The auto-matched path prunes: an unreliable high-residual point is dropped
  // and the kept set refit (reference verbatim; see selectAndFit).
  const core = selectAndFit(points, defaultModel, { sigmaClip: 'prune' });

  // Bundle the display-only intermediates captured above (additive — never an
  // input to any fit; existing fields/numeric results are unchanged).
  const trace: CalibrationTrace = {
    preliminary: { a0, b0 },
    gainProfile,
    secondaryWindows,
    ksig,
  };

  return { ...core, trace };
}

// --- the human-match entry point ---------------------------------------------

/** Options for {@link calibrateFromMatches}. */
export interface CalibrateFromMatchesOptions {
  /** Which equation to mark active; default `'auto'` (same policy as {@link calibrate}). */
  readonly defaultModel?: CalibrationModelPolicy;
}

/**
 * Fit a channel -> energy calibration from human-provided assignments (Declare
 * Identities). Only assignments with `state === 'assigned'` (and a finite
 * `energyKeV`) are used; `'excluded'`/`'unassigned'` are ignored. Points are
 * pooled across all sources into ONE equation (global pooling). Returns BOTH
 * candidate equations with one marked `selected` per the policy -- identical
 * shape to {@link calibrate}, with two deliberate differences:
 *
 *  - ADVISORY σ-clip (O1): the fit uses ALL assigned points. A point the prune
 *    rule would have dropped (unreliable AND |resid| > max(3·rms, 2 keV) on the
 *    quadratic) is annotated in its `note` (`advisory: high residual …`) with
 *    `used: true` -- the scientist chose these points; the engine flags, it
 *    doesn't overrule.
 *  - No two-pass `trace`: there is no survey/window matching on this path.
 *    Walkthrough stages that read `trace` are a Phase 4 concern.
 *
 * @throws ValidationError when: no assigned matches; an assigned match lacks a
 *   finite `energyKeV` or `centroidChannel`; fewer than {@link MIN_FIT_POINTS}
 *   usable points; or a degenerate fit.
 */
export function calibrateFromMatches(
  assignments: readonly PeakAssignment[],
  options: CalibrateFromMatchesOptions = {},
): CalibrationResult {
  const defaultModel: CalibrationModelPolicy = options.defaultModel ?? 'auto';
  const assigned = assignments.filter((a) => a.state === 'assigned');
  if (!assigned.length) {
    throw new ValidationError('calibrateFromMatches: no assigned matches supplied.');
  }

  const points: CalibrationPoint[] = assigned.map((a) => {
    if (a.energyKeV == null || !Number.isFinite(a.energyKeV)) {
      throw new ValidationError(
        `calibrateFromMatches: assigned peak "${a.peakId}" has no finite energyKeV.`,
      );
    }
    if (!Number.isFinite(a.centroidChannel)) {
      throw new ValidationError(
        `calibrateFromMatches: assigned peak "${a.peakId}" has a non-finite centroidChannel.`,
      );
    }
    // Conditional spreads: absent optionals stay ABSENT (exactOptionalPropertyTypes).
    return {
      channel: a.centroidChannel,
      energyKeV: a.energyKeV,
      sourceLabel: pointLabel(a.sourceId ?? 'manual', a.energyKeV),
      ...(a.centroidError != null ? { centroidError: a.centroidError } : {}),
      ...(a.sourceId != null ? { sourceId: a.sourceId } : {}),
      ...(a.tier != null ? { tier: a.tier } : {}),
      ...(a.reliable != null ? { reliable: a.reliable } : {}),
      used: true,
      note: '',
    };
  });

  if (points.length < MIN_FIT_POINTS) {
    throw new ValidationError(
      `calibrateFromMatches: ${points.length} assigned point(s); ` +
        `need >= ${MIN_FIT_POINTS} for a covariance-bearing fit.`,
    );
  }

  return selectAndFit(points, defaultModel, { sigmaClip: 'advisory' });
}

// --- shared fit / model-selection core (steps 6-8) ----------------------------

/** How the σ-clip pass treats a detected unreliable high-residual point:
 *  - `'prune'`    drop it and refit (reference verbatim; {@link calibrate}).
 *  - `'advisory'` keep EVERY point in the fit, stamping an `advisory:` note on
 *                 would-be-pruned points ({@link calibrateFromMatches} -- the
 *                 scientist chose the points; the engine flags, never overrules).
 *  - `'off'`      no σ-clip pass (tests / future callers). */
type SigmaClipMode = 'prune' | 'advisory' | 'off';

/**
 * Steps 6-8, shared by BOTH entry points so the fit/model-selection logic exists
 * exactly once: σ-clip over the weightable used points, weighted linear +
 * quadratic fits on the kept set, metrics, and the model-selection policy.
 * `points` is the full candidate list (used and not); returns the complete
 * result minus `trace` (only the two-pass path has one).
 */
function selectAndFit(
  points: readonly CalibrationPoint[],
  defaultModel: CalibrationModelPolicy,
  opts: { sigmaClip: SigmaClipMode },
): Omit<CalibrationResult, 'trace'> {
  // Working set: used points that can be weighted. An ABSENT centroidError is
  // weightable (weightedFit gives it weight 1, per the CalibrationPoint
  // contract); a defined-but-non-finite one (a rejected C2 fit's NaN) is not.
  let usedIdx = points
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.used && (x.p.centroidError == null || Number.isFinite(x.p.centroidError)))
    .map((x) => x.i);

  // σ-clip detection (reference verbatim): while > SIGMA_CLIP_MIN_POINTS remain,
  // find the single worst UNRELIABLE point whose |residual| on the quadratic
  // exceeds max(3·rms, 2 keV), then repeat without it. Under 'prune' the drop is
  // real; under 'advisory' the detection runs identically but the final fit
  // keeps every point (only the note records what prune would have done).
  const prunedNotes = new Map<number, string>();
  const advisoryNotes = new Map<number, string>();
  if (opts.sigmaClip !== 'off') {
    let clipIdx = usedIdx;
    while (clipIdx.length > SIGMA_CLIP_MIN_POINTS) {
      const pts = clipIdx.map((i) => points[i]);
      const qf = weightedFit(pts, 2);
      const asc = qf.coeffs.slice().reverse();
      const resids = clipIdx.map((i) => points[i].energyKeV - evalAscending(asc, points[i].channel));
      const rms = Math.sqrt(resids.reduce((s, r) => s + r * r, 0) / resids.length);
      let worst = 0;
      for (let k = 1; k < resids.length; k++) {
        if (Math.abs(resids[k]) > Math.abs(resids[worst])) worst = k;
      }
      const wi = clipIdx[worst];
      const wr = resids[worst];
      if (
        !points[wi].reliable &&
        Math.abs(wr) > Math.max(SIGMA_CLIP_RESID_FACTOR * rms, SIGMA_CLIP_RESID_FLOOR)
      ) {
        if (opts.sigmaClip === 'prune') {
          prunedNotes.set(wi, `pruned (|resid| ${Math.abs(wr).toFixed(1)} keV)`);
        } else {
          advisoryNotes.set(wi, `advisory: high residual ${Math.abs(wr).toFixed(1)} keV`);
        }
        clipIdx = clipIdx.filter((i) => i !== wi);
      } else {
        break;
      }
    }
    if (opts.sigmaClip === 'prune') usedIdx = clipIdx;
  }

  const finalUsed = usedIdx.map((i) => points[i]);
  if (finalUsed.length < MIN_FIT_POINTS) {
    throw new ValidationError(
      `calibrate: only ${finalUsed.length} usable calibration point(s) after matching/pruning; ` +
        `need >= ${MIN_FIT_POINTS} for a covariance-bearing fit.`,
    );
  }

  // Both candidates come from the SAME σ-clipped weighted set (the reference
  // σ-clips once on the quadratic, then fits linear & quadratic on the kept set).
  const linearFit = weightedFit(finalUsed, 1);
  // Quadratic needs N > 3 for an honest covariance; unavailable below that.
  const quadraticFit = finalUsed.length > 3 ? weightedFit(finalUsed, 2) : null;

  const energies = finalUsed.map((p) => p.energyKeV);
  const validRange: [number, number] = [Math.min(...energies), Math.max(...energies)];

  // Stamp σ-clip outcomes back onto the reported point list (shared by both
  // candidates): a prune drops the point; an advisory keeps it and only annotates.
  const finalPoints: CalibrationPoint[] = points.map((p, i) => {
    const pruned = prunedNotes.get(i);
    if (pruned) return { ...p, used: false, note: p.note ? `${p.note}; ${pruned}` : pruned };
    const advisory = advisoryNotes.get(i);
    if (advisory) return { ...p, note: p.note ? `${p.note}; ${advisory}` : advisory };
    return p;
  });

  const linear = buildCalibration(linearFit, 'linear', finalPoints, validRange);
  const quadratic = quadraticFit
    ? buildCalibration(quadraticFit, 'quadratic', finalPoints, validRange)
    : null;
  const curvatureSignificance = quadraticFit ? quadraticFit.curvatureSignificance() : 0;

  // Apply the policy; availability always wins (never select an absent model).
  let selected: 'linear' | 'quadratic' = 'linear';
  let selectionFellBack = false;
  if (defaultModel === 'linear') {
    selected = 'linear';
  } else if (defaultModel === 'quadratic') {
    if (quadratic) selected = 'quadratic';
    else selectionFellBack = true; // requested quadratic but <4 points -> linear
  } else {
    // 'auto': the reference's curvature-significance choice.
    selected =
      quadratic && curvatureSignificance >= CURVATURE_SIGNIFICANCE_THRESHOLD ? 'quadratic' : 'linear';
  }

  return { linear, quadratic, selected, policy: defaultModel, selectionFellBack, curvatureSignificance };
}

/** Assemble a {@link Calibration} from a fit result, in ascending-power order. */
function buildCalibration(
  fit: PolyFitResult,
  model: CalibrationModel,
  points: readonly CalibrationPoint[],
  validRange: readonly [number, number],
): Calibration {
  const asc = toAscending(fit);
  return {
    model,
    coefficients: asc.coeffs,
    covariance: asc.cov,
    points,
    rSquared: fit.r2,
    rms: fit.rms,
    maxAbsResidual: fit.maxAbsResidual,
    validRange,
  };
}

/** The active equation of a {@link CalibrationResult} — what `applyCalibrationToChannel`
 * / `calibratePeaks` should consume. Never returns null: `selected` is only
 * `'quadratic'` when the quadratic candidate exists. */
export function activeCalibration(result: CalibrationResult): Calibration {
  return result.selected === 'quadratic' && result.quadratic ? result.quadratic : result.linear;
}

// --- thin direct fit (kept for callers that already hold (channel,energy) pts) -

/**
 * Least-squares fit of E = c0 + c1·ch + ... + c_degree·ch^degree over ready-made
 * points, via F1 `weightedPolyfit` (covariance + metrics). Weights are
 * `1/centroidError` where present, else uniform. Used by tests and any caller
 * that already has matched points; the two-pass entry point is {@link calibrate}.
 */
export function fitCalibration(points: readonly CalibrationPoint[], degree = 1): Calibration {
  const fit = weightedFit(points, degree); // throws on too-few-points / singular
  const asc = toAscending(fit);
  const model: CalibrationModel =
    degree === 1 ? 'linear' : degree === 2 ? 'quadratic' : 'polynomial';
  const energies = points.map((p) => p.energyKeV);
  const validRange: [number, number] = [Math.min(...energies), Math.max(...energies)];
  return {
    model,
    coefficients: asc.coeffs,
    covariance: asc.cov,
    points: points.slice(),
    rSquared: fit.r2,
    rms: fit.rms,
    maxAbsResidual: fit.maxAbsResidual,
    validRange,
  };
}

/** Apply E = sum c_k · ch^k (Horner); `coefficients` are ascending powers. */
export function applyCalibrationToChannel(cal: Calibration, channel: number): number {
  return evalAscending(cal.coefficients, channel);
}

/** Attach energies to fitted peaks via the calibration. */
export function calibratePeaks(cal: Calibration, peaks: readonly FittedPeak[]): FittedPeak[] {
  return peaks.map((p) => ({ ...p, energyKeV: applyCalibrationToChannel(cal, p.centroidChannel) }));
}
