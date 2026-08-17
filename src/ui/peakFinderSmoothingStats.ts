/**
 * peakFinderSmoothingStats -- the data-led derivations behind the two "Effect of Smoothing"
 * decision cards on the Savitzky-Golay stage.
 *
 * Pure presentation over the manager's ALREADY-computed arrays (Principle 9): every figure
 * is a pure function of the two count arrays (`rawSpectrum.counts`, `smoothedSpectrum.counts`)
 * and the current SG window. Nothing here re-runs the engine or touches the pipeline -- the
 * two cards TRANSLATE the raw-vs-smoothed overlay into plain numbers, they never change what
 * detection runs on. `app.ts` calls this once per render and only RENDERS the returned rows.
 *
 * CHANNEL SPACE ONLY, raw-vs-smoothed ONLY: no background / net / continuum / candidate /
 * area / FWHM-of-a-detected-peak / significance / calibration / identity figure is ever read
 * or displayed. (`findPeaks`/`peakWidths` run internally ONLY to characterise the window vs
 * typical-peak-width ratio for the strength descriptor -- no peaks, widths, or counts from
 * that pass are ever surfaced.)
 *
 * Graceful hiding (never render `NaN`): a degenerate metric (constant spectrum -> Pearson r
 * undefined, no channels above the high-count floor, flat spectrum -> zero noise) omits its
 * OWN row; if every row of a card is hidden the whole card is hidden (its getter returns
 * `null`).
 */

import { findPeaks } from '../signal';

/** The two count arrays these cards read (both already exposed on the manager) plus the
 * current SG window. Passed as plain data so the derivations stay pure + unit-testable
 * without constructing a manager. */
export interface SmoothingStatsInput {
  readonly raw: readonly number[];
  readonly smoothed: readonly number[];
  readonly sgWindow: number;
}

/** One metric row: label (left) + primary value (right), an optional secondary detail line
 * (e.g. `at channel 512`, a strength descriptor, a normalised percentage), and an optional
 * 0..1 meter fraction rendered as a thin bar. */
export interface SmoothingMetric {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  /** 0..1 fill fraction for a thin meter bar; omitted when the metric has no meter. */
  readonly meter?: number;
}

/** A titled card of one-or-more metric rows (never empty -- an all-hidden card is `null`). */
export interface SmoothingCard {
  readonly title: string;
  readonly metrics: readonly SmoothingMetric[];
}

/** Both decision cards; either is `null` when all of its rows were hidden as degenerate. */
export interface SmoothingEffect {
  /** Card A -- interpreted, human-facing effects (noise down, shape kept, strength band). */
  readonly effect: SmoothingCard | null;
  /** Card B -- the raw numerical delta between the two arrays. */
  readonly comparison: SmoothingCard | null;
}

/** Guard against zero denominators in the normalised / percentage figures. */
const EPS = 1e-9;

// --- pure array helpers (reduce-based: safe for multi-thousand-channel spectra) ----------
const asum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const amean = (a: readonly number[]): number => (a.length ? asum(a) / a.length : 0);

/** Robust successive-difference (Von Neumann) noise estimator: sqrt(mean (x[i+1]-x[i])^2 / 2).
 * Undefined (returns null) for fewer than two samples. */
function vonNeumannNoise(x: readonly number[]): number | null {
  const n = x.length;
  if (n < 2) return null;
  let acc = 0;
  for (let i = 1; i < n; i++) {
    const d = x[i] - x[i - 1];
    acc += d * d;
  }
  return Math.sqrt(acc / (2 * (n - 1)));
}

/** Pearson correlation of two equal-length arrays; null when either has zero variance
 * (a constant spectrum -> correlation is undefined). */
function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  const ma = amean(a);
  const mb = amean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  if (saa < EPS || sbb < EPS) return null;
  return sab / Math.sqrt(saa * sbb);
}

/** Median of a numeric array (ascending copy); null when empty. */
function median(a: readonly number[]): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank pth quantile (0..1) over a copy of `a`; null when empty. */
function quantile(a: readonly number[], p: number): number | null {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

// --- display formatting -------------------------------------------------------
/** Percent to one decimal. `en-US` pinned so the unit tests assert exact strings. */
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}
/** Signed percent to one decimal (leading + / − so a peak-height DROP reads unambiguously). */
function fmtSignedPct(v: number): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(1)}%`;
}
/** Counts to 0-1 decimals, thousands grouped. Diffs can be sub-unit, so keep one decimal. */
function fmtCounts(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
}

/** Descriptor bands for the window-vs-peak-width ratio (a window approaching the peak FWHM
 * materially broadens / suppresses peaks). */
function strengthBandFromRatio(ratio: number): string {
  if (ratio <= 0.4) return 'Gentle';
  if (ratio <= 0.8) return 'Moderate';
  if (ratio <= 1.2) return 'Strong';
  return 'Aggressive';
}

/** Fallback descriptor when no prominent peaks resolve: derive the band from how much
 * high-frequency noise the smoothing removed instead. */
function strengthBandFromNoise(noiseReductionPct: number): string {
  if (noiseReductionPct < 20) return 'Gentle';
  if (noiseReductionPct < 45) return 'Moderate';
  if (noiseReductionPct < 70) return 'Strong';
  return 'Aggressive';
}

/**
 * Median FWHM (in channels) of the PROMINENT raw local maxima, used only to scale the SG
 * window for the strength descriptor. "Prominent" = prominence above a robust noise floor
 * (3x the successive-difference noise), so single-channel noise spikes don't count. Returns
 * null when the spectrum resolves no such peaks (flat / sparse) so the caller can fall back.
 * Defensive against any pathological throw from the signal core.
 */
function medianFwhmChannels(raw: readonly number[], noise: number | null): number | null {
  if (raw.length < 3) return null;
  const promFloor = Math.max(1, 3 * (noise ?? 0));
  try {
    const { properties } = findPeaks(raw, { prominence: promFloor, width: 1 });
    const widths = properties.widths ?? [];
    if (!widths.length) return null;
    const m = median(widths);
    return m && m > EPS ? m : null;
  } catch {
    return null;
  }
}

// --- Card A: Effect of Smoothing (interpreted) --------------------------------
function deriveEffectCard(inp: SmoothingStatsInput): SmoothingCard | null {
  const { raw, smoothed, sgWindow } = inp;
  const n = raw.length;
  const metrics: SmoothingMetric[] = [];

  // Noise reduction: (1 - noise(S)/noise(R)) * 100. Undefined when the raw is flat.
  const noiseR = vonNeumannNoise(raw);
  const noiseS = vonNeumannNoise(smoothed);
  let noiseReductionPct: number | null = null;
  if (noiseR != null && noiseS != null && noiseR > EPS) {
    noiseReductionPct = (1 - noiseS / noiseR) * 100;
    const clamped = Math.max(0, Math.min(100, noiseReductionPct));
    metrics.push({
      label: 'Noise reduction',
      value: fmtPct(noiseReductionPct),
      meter: clamped / 100,
    });
  }

  // Shape preservation: Pearson r(R,S) * 100. Undefined for a constant spectrum.
  const r = pearson(raw, smoothed);
  if (r != null) {
    metrics.push({ label: 'Shape preservation', value: fmtPct(r * 100) });
  }

  // Maximum intensity change: largest single-channel change as % of the LOCAL raw value,
  // over the top decile of raw counts only (so low-count noise can't dominate the ratio).
  const floor = quantile(raw, 0.9);
  if (floor != null) {
    let worst = 0; // signed, largest |Δ%|
    let worstCh = -1;
    for (let i = 0; i < n; i++) {
      if (raw[i] < floor || raw[i] <= EPS) continue;
      const pct = ((smoothed[i] - raw[i]) / raw[i]) * 100;
      if (Math.abs(pct) > Math.abs(worst)) {
        worst = pct;
        worstCh = i;
      }
    }
    if (worstCh >= 0) {
      metrics.push({
        label: 'Maximum intensity change',
        value: fmtSignedPct(worst),
        detail: `at channel ${worstCh}`,
      });
    }
  }

  // Overall smoothing strength: window relative to the median prominent-peak FWHM, with a
  // noise-derived qualitative fallback when no peaks resolve. Hidden only when BOTH the FWHM
  // ratio AND the noise fallback are undefined (a flat spectrum).
  const fwhm = medianFwhmChannels(raw, noiseR);
  if (fwhm != null) {
    const ratio = sgWindow / fwhm;
    metrics.push({
      label: 'Overall smoothing strength',
      value: strengthBandFromRatio(ratio),
      detail: `${ratio.toFixed(1)}× median peak width`,
    });
  } else if (noiseReductionPct != null) {
    metrics.push({
      label: 'Overall smoothing strength',
      value: strengthBandFromNoise(noiseReductionPct),
      detail: 'estimated from noise reduction',
    });
  }

  return metrics.length ? { title: 'Effect of Smoothing', metrics } : null;
}

// --- Card B: Spectrum Comparison (raw numerical delta) ------------------------
function deriveComparisonCard(inp: SmoothingStatsInput): SmoothingCard | null {
  const { raw, smoothed } = inp;
  const n = raw.length;
  if (!n) return null;
  const metrics: SmoothingMetric[] = [];

  let sumSq = 0;
  let sumAbs = 0;
  let maxAbs = 0;
  let maxCh = 0;
  let modified = 0; // channels changed by more than one Poisson sigma of the raw counts
  for (let i = 0; i < n; i++) {
    const d = smoothed[i] - raw[i];
    const ad = Math.abs(d);
    sumSq += d * d;
    sumAbs += ad;
    if (ad > maxAbs) {
      maxAbs = ad;
      maxCh = i;
    }
    const poissonSigma = Math.sqrt(Math.max(1, raw[i]));
    if (ad > poissonSigma) modified++;
  }

  const rms = Math.sqrt(sumSq / n);
  const meanRaw = amean(raw);
  metrics.push({
    label: 'RMS difference',
    value: `${fmtCounts(rms)} counts`,
    ...(meanRaw > EPS ? { detail: `${fmtPct((rms / meanRaw) * 100)} of mean` } : {}),
  });
  metrics.push({ label: 'Mean absolute difference', value: `${fmtCounts(sumAbs / n)} counts` });
  metrics.push({
    label: 'Maximum difference',
    value: `${fmtCounts(maxAbs)} counts`,
    detail: `at channel ${maxCh}`,
  });
  metrics.push({ label: 'Channels modified', value: fmtPct((modified / n) * 100) });

  return { title: 'Spectrum Comparison', metrics };
}

/**
 * Derive both "Effect of Smoothing" decision cards from the raw + smoothed count arrays.
 * Returns `{ effect: null, comparison: null }` when the two arrays are unusable (smoothed
 * absent / empty / length-mismatched) so the caller renders no cards rather than `NaN`.
 */
export function deriveSmoothingEffect(inp: SmoothingStatsInput): SmoothingEffect {
  const { raw, smoothed } = inp;
  if (!raw.length || smoothed.length !== raw.length) {
    return { effect: null, comparison: null };
  }
  return { effect: deriveEffectCard(inp), comparison: deriveComparisonCard(inp) };
}
