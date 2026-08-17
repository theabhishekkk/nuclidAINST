/**
 * peakFinderFitStats -- data-led derivations behind the "Peak Fitting" Run stage
 * (`fit` / `run-6`, the seventh Run stage, Finalize group).
 *
 * Sibling of {@link module:peakFinderDetectStats} but for the CULMINATION stage: where the
 * detect pages read the pre-gate candidate population, this page reads the ALREADY-computed
 * fit of the CURRENTLY SELECTED peak -- a {@link FittedPeak} (kept or rejected) or an
 * {@link UnfittableSurvivor} -- plus the global continuum (`background`) and raw `counts`
 * arrays the manager already holds. Pure presentation over already-computed data (Principle 9):
 * every figure is either read verbatim off the fit record or an honest DISPLAY transform the
 * UI is entitled to compute (the residual `raw − model` and its RMS). Nothing re-runs the fit
 * -- there is no call into `fit.ts` / `analyzeSpectrum` here, so the committed reference-parity
 * fixtures stay byte-identical. `app.ts` calls this and only RENDERS the returned structures.
 *
 * HONESTY BOUNDARY (D-A): only values the engine truthfully exposes, plus display-derivable
 * residuals, appear. NO iteration count, NO initial-guess vector, NO area uncertainty, NO
 * reduced χ² -- the backend does not expose degrees of freedom, so χ² is shown verbatim
 * ("—" when null). Optimizer / convergence status is derived from the real `status`.
 *
 * CHANNEL SPACE ONLY: `energyKeV` is calibration-only and is NEVER read here (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate).
 *
 * Inputs are passed as PLAIN DATA -- never a manager or a report -- so the derivations stay pure
 * and unit-testable, and cannot perturb the engine or its fixtures.
 */

import type { FittedPeak, UnfittableSurvivor } from '../domain/types';
import { FWHM_PER_SIGMA } from '../pipeline/fit';

/** One label/value pair for a `.cfg-recap` stat card (value pre-formatted for display). */
export interface FitStatPair {
  readonly label: string;
  readonly value: string;
}

/** The Gaussian shape parameters of the selected fit, in channel/count space -- read verbatim
 * off the record (σ derived from FWHM). `null` when there is no fitted selection. */
export interface FitShape {
  readonly amplitude: number;
  readonly centroidChannel: number;
  /** σ = fwhmChannels / FWHM_PER_SIGMA. */
  readonly sigma: number;
  readonly fwhmChannels: number;
}

/**
 * The per-channel decomposition of a fitted peak over its window, for the single-peak zoom
 * chart (P3) and the residual chart (P4). All series share the same `channels` x-axis.
 * `null` when there is no fitted selection or the width is non-physical (σ ≤ 0).
 */
export interface FitDecomposition {
  /** Window start channel (inclusive). */
  readonly lo: number;
  /** Window end channel (inclusive). */
  readonly hi: number;
  /** The x positions `lo..hi` (integers). */
  readonly channels: readonly number[];
  /** Raw counts over the window. */
  readonly raw: readonly number[];
  /** The estimated continuum (global background) over the window (O-2). */
  readonly background: readonly number[];
  /** The Gaussian component `A·exp(−½((x−μ)/σ)²)` over the window. */
  readonly gaussian: readonly number[];
  /** Combined model `gaussian + background` over the window. */
  readonly combined: readonly number[];
  /** Residual `raw − combined` over the window. */
  readonly residual: readonly number[];
  /** `sqrt(mean(residual²))` over the window -- 0 for a perfectly-matched window. */
  readonly residualRms: number;
}

/** Everything the redesigned "Peak Fitting" stage's cards + charts need for the selected peak,
 * derived PURELY from {@link FitStatsInput}. */
export interface FitStats {
  /** Is there a selected item at all? */
  readonly hasSelection: boolean;
  /** Is the selection a {@link FittedPeak} (vs an {@link UnfittableSurvivor} or nothing)? */
  readonly isFitted: boolean;
  /** Fit Summary card: compact confidence panel. */
  readonly summary: readonly FitStatPair[];
  /** Peak Measurements card (emphasised `--why`): the authoritative measurements. */
  readonly measurements: readonly FitStatPair[];
  /** Fit Quality card: χ² (verbatim), residual RMS (derived), convergence. */
  readonly quality: readonly FitStatPair[];
  /** Optimization Summary card: qualitative, honest -- no iteration count / guess vector. */
  readonly optimization: readonly FitStatPair[];
  /** The selected fit's Gaussian shape (for Math Details + the chart), or `null`. */
  readonly shape: FitShape | null;
  /** The per-channel decomposition over the window (for the P3/P4 charts), or `null`. */
  readonly decomposition: FitDecomposition | null;
}

/** Plain-data input for {@link deriveFitStats}. */
export interface FitStatsInput {
  /** The currently selected item: a fitted peak (kept or rejected), an unfittable survivor, or
   * `null` when nothing is selected. */
  readonly selected: FittedPeak | UnfittableSurvivor | null;
  /** The global estimated continuum (SNIP background) array (O-2). */
  readonly background: readonly number[];
  /** The raw counts array the fit ran on. */
  readonly counts: readonly number[];
  /** Half-window size in FWHM units for the decomposition zoom (default 2.5). */
  readonly windowHalfFwhm?: number;
  /** Minimum half-window in channels, so a very narrow peak still gets a legible window
   * (default 6). */
  readonly minHalfWindow?: number;
}

/** Placeholder for a value that is not available (null χ², unfittable/absent selection). */
const NA = '—';

const DEFAULT_WINDOW_HALF_FWHM = 2.5;
const DEFAULT_MIN_HALF_WINDOW = 6;

// --- display formatting -------------------------------------------------------
/** Round to a whole count and group thousands. `en-US` is pinned so the output is
 * locale-stable (the unit tests assert on these exact strings). */
function fmtCount(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** A channel-space value to 2 dp with a trailing unit. */
function fmtCh(v: number): string {
  return `${v.toFixed(2)} ch`;
}
/** χ² verbatim: locale-stable, up to 2 fractional digits, thousands-grouped. Only ever called
 * on a finite value -- the null case is handled by the caller ("—"). */
function fmtChi(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
/** Humanise a fit-failure reason for display (`no-convergence` -> `no convergence`). */
function humanReason(reason: string): string {
  return reason.replace(/-/g, ' ');
}

/** Type guard: a {@link FittedPeak} carries a `centroidChannel`; an {@link UnfittableSurvivor}
 * does not. */
function isFittedPeak(x: FittedPeak | UnfittableSurvivor): x is FittedPeak {
  return 'centroidChannel' in x;
}

/**
 * Build the per-channel decomposition of a fitted peak over its window. Returns `null` when the
 * width is non-physical (σ ≤ 0) so the caller can fall back to a "no chart" shape. The window is
 * `centroid ± max(round(windowHalfFwhm·FWHM), minHalfWindow)`, clamped to the counts array.
 */
function buildDecomposition(
  peak: FittedPeak,
  background: readonly number[],
  counts: readonly number[],
  windowHalfFwhm: number,
  minHalfWindow: number,
): FitDecomposition | null {
  const sigma = peak.fwhmChannels / FWHM_PER_SIGMA;
  if (!(sigma > 0)) return null;
  const n = counts.length;
  if (n <= 0) return null;

  const half = Math.max(Math.round(windowHalfFwhm * peak.fwhmChannels), minHalfWindow);
  const centre = Math.round(peak.centroidChannel);
  const lo = Math.max(0, centre - half);
  const hi = Math.min(n - 1, centre + half);
  if (hi < lo) return null;

  const channels: number[] = [];
  const raw: number[] = [];
  const bg: number[] = [];
  const gaussian: number[] = [];
  const combined: number[] = [];
  const residual: number[] = [];
  let sse = 0;
  for (let ch = lo; ch <= hi; ch++) {
    const z = (ch - peak.centroidChannel) / sigma;
    const g = peak.amplitude * Math.exp(-0.5 * z * z);
    const b = background.length > ch ? background[ch] : 0;
    const c = g + b;
    const r = (counts[ch] ?? 0) - c;
    channels.push(ch);
    raw.push(counts[ch] ?? 0);
    bg.push(b);
    gaussian.push(g);
    combined.push(c);
    residual.push(r);
    sse += r * r;
  }
  const residualRms = Math.sqrt(sse / residual.length);
  return { lo, hi, channels, raw, background: bg, gaussian, combined, residual, residualRms };
}

/**
 * Pure derivation for the "Peak Fitting" (`fit` / `run-6`) educational stage. Every returned
 * figure is either read verbatim off the selected record or an honest display transform of the
 * passed-in arrays -- no engine call, no fixture touch (Principle 9). See {@link FitStats}.
 *
 * Three selection shapes, all well-formed (never throws):
 *  - a {@link FittedPeak} (`isFitted: true`) -- full measurements + decomposition;
 *  - an {@link UnfittableSurvivor} -- "no fit" shape (measurements "—", reason surfaced);
 *  - `null` -- empty-state shape (everything "—", no decomposition).
 */
export function deriveFitStats(input: FitStatsInput): FitStats {
  const { selected, background, counts } = input;
  const windowHalfFwhm = input.windowHalfFwhm ?? DEFAULT_WINDOW_HALF_FWHM;
  const minHalfWindow = input.minHalfWindow ?? DEFAULT_MIN_HALF_WINDOW;

  // --- empty state (no selection) --------------------------------------------
  if (!selected) {
    return {
      hasSelection: false,
      isFitted: false,
      summary: [
        { label: 'Selected Peak', value: NA },
        { label: 'Fit Status', value: NA },
        { label: 'Optimizer Status', value: NA },
        { label: 'Status', value: NA },
      ],
      measurements: [
        { label: 'Centroid', value: NA },
        { label: 'Centroid Uncertainty', value: NA },
        { label: 'Net Area', value: NA },
        { label: 'FWHM', value: NA },
        { label: 'Peak Height', value: NA },
      ],
      quality: [
        { label: 'χ²', value: NA },
        { label: 'Residual RMS', value: NA },
        { label: 'Convergence Status', value: NA },
      ],
      optimization: [
        { label: 'Initial Guess', value: NA },
        { label: 'Final Optimized Solution', value: NA },
        { label: 'Optimization', value: NA },
      ],
      shape: null,
      decomposition: null,
    };
  }

  // --- unfittable survivor (no FittedPeak) -----------------------------------
  if (!isFittedPeak(selected)) {
    const reason = humanReason(selected.reason);
    return {
      hasSelection: true,
      isFitted: false,
      summary: [
        { label: 'Selected Peak', value: `Channel ${Math.round(selected.detectedChannel)}` },
        { label: 'Fit Status', value: `Unfittable (${reason})` },
        { label: 'Optimizer Status', value: 'Did not converge' },
        { label: 'Status', value: 'Needs review' },
      ],
      measurements: [
        { label: 'Centroid', value: NA },
        { label: 'Centroid Uncertainty', value: NA },
        { label: 'Net Area', value: NA },
        { label: 'FWHM', value: NA },
        { label: 'Peak Height', value: NA },
      ],
      quality: [
        { label: 'χ²', value: NA },
        { label: 'Residual RMS', value: NA },
        { label: 'Convergence Status', value: 'Did not converge' },
      ],
      optimization: [
        { label: 'Initial Guess', value: 'Seeded from the detected height, centroid and width' },
        { label: 'Final Optimized Solution', value: NA },
        { label: 'Optimization', value: 'Failed' },
      ],
      shape: null,
      decomposition: null,
    };
  }

  // --- a fitted peak (kept or rejected) --------------------------------------
  const peak = selected;
  const converged = peak.status === 'kept';
  const sigma = peak.fwhmChannels / FWHM_PER_SIGMA;
  const shape: FitShape = {
    amplitude: peak.amplitude,
    centroidChannel: peak.centroidChannel,
    sigma,
    fwhmChannels: peak.fwhmChannels,
  };
  const decomposition = buildDecomposition(
    peak,
    background,
    counts,
    windowHalfFwhm,
    minHalfWindow,
  );

  const summary: FitStatPair[] = [
    { label: 'Selected Peak', value: `Channel ${Math.round(peak.detectedChannel)}` },
    { label: 'Fit Status', value: converged ? 'Successful' : 'Rejected' },
    { label: 'Optimizer Status', value: converged ? 'Converged' : 'Did not converge' },
    { label: 'Status', value: converged ? 'Ready' : 'Needs review' },
  ];

  const measurements: FitStatPair[] = [
    { label: 'Centroid', value: fmtCh(peak.centroidChannel) },
    {
      label: 'Centroid Uncertainty',
      // A rejected fit carries a non-finite centroidError (the guard rejects before the
      // covariance stats are computed) -- show "—" rather than a fabricated ±.
      value: Number.isFinite(peak.centroidError)
        ? `± ${peak.centroidError.toFixed(2)} ch (1σ)`
        : NA,
    },
    { label: 'Net Area', value: `${fmtCount(peak.netArea)} counts` },
    { label: 'FWHM', value: fmtCh(peak.fwhmChannels) },
    { label: 'Peak Height', value: fmtCount(peak.amplitude) },
  ];

  const quality: FitStatPair[] = [
    { label: 'χ²', value: peak.chiSquare === null ? NA : fmtChi(peak.chiSquare) },
    {
      label: 'Residual RMS',
      value: decomposition ? fmtCount(decomposition.residualRms) : NA,
    },
    { label: 'Convergence Status', value: converged ? 'Converged' : 'Did not converge' },
  ];

  const optimization: FitStatPair[] = [
    { label: 'Initial Guess', value: 'Seeded from the detected height, centroid and width' },
    {
      label: 'Final Optimized Solution',
      value: `A ${fmtCount(peak.amplitude)}, μ ${peak.centroidChannel.toFixed(2)} ch, σ ${sigma.toFixed(2)} ch`,
    },
    { label: 'Optimization', value: converged ? 'Successful' : 'Failed' },
  ];

  return {
    hasSelection: true,
    isFitted: true,
    summary,
    measurements,
    quality,
    optimization,
    shape,
    decomposition,
  };
}
