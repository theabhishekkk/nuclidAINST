/**
 * Stage 3 -- Detect: the reference detection stack (`Calibration Mode.py`), wired
 * onto the F2 signal primitives.
 *
 *   1. find_peaks on the SMOOTHED net (prominence / distance / width @ rel_height).
 *   2. FWHM per surviving peak from peak_widths @ rel_height 0.5.
 *   3. measure   -- net / gross area over a +/- window_factor*FWHM window, taken
 *      from the RAW counts and the (un-clipped) net -- NEVER the smoothed series.
 *      significance = net_area / sqrt(gross_area).
 *   4. resolution model FWHM(ch) ~ k*sqrt(ch), k fixed from the STRONGEST peak
 *      (by net counts), and a width-ratio classification against it.
 *
 * Every threshold is a named constant below, overridable via {@link DetectOptions}
 * but reference-matched by default. Output is element-agnostic: a peak list, no
 * isotope shaping (RISK-02).
 */
import type {
  ConditionedSpectrum,
  DetectedPeak,
  DetectRejectReason,
  PeakClass,
  Spectrum,
} from '../domain/types';
import { localMaxima1d, selectByPeakDistance, peakProminences, peakWidths } from '../signal';

// --- Detection thresholds (reference `detect_candidates` / `smooth_spectrum`). ---
/** Minimum prominence a peak must rise above its surroundings. */
export const PROMINENCE = 200;
/** Minimum channel separation between kept peaks (tallest wins). */
export const DISTANCE = 8;
/** Minimum width (channels) at `REL_HEIGHT`. */
export const MIN_WIDTH = 2;
/** Relative height (of the prominence) at which width/FWHM is measured. */
export const REL_HEIGHT = 0.5;

// --- Measurement / classification (reference `measure_peak` / `classify_candidate`). ---
/** Integration half-window = round(WINDOW_FACTOR * FWHM), floored at MIN_HALF_WINDOW. */
export const WINDOW_FACTOR = 1.5;
/** Minimum integration half-window (channels). */
export const MIN_HALF_WINDOW = 3;
/** Below this counting significance a peak is `weak`. */
export const MIN_SIGNIFICANCE = 4.0;
/** Above this measured/expected width ratio a peak is `broad`. */
export const MAX_WIDTH_RATIO = 2.0;

export interface DetectOptions {
  /** Minimum prominence (default {@link PROMINENCE}). */
  readonly prominence?: number;
  /** Minimum channel separation (default {@link DISTANCE}). */
  readonly distance?: number;
  /** Minimum width at `relHeight` (default {@link MIN_WIDTH}). */
  readonly minWidth?: number;
  /** Relative height for the width measurement (default {@link REL_HEIGHT}). */
  readonly relHeight?: number;
}

/**
 * Resolve a partial {@link DetectOptions} to the fully-defaulted gate settings a
 * run actually uses (module defaults merged with any per-run overrides). Exported
 * so the merge logic lives in ONE place: {@link detectTraced} defaults through it,
 * and the orchestrator threads the same resolved values onto the report so the
 * inspector labels the gates this run really applied (DEBT-27) -- not the module
 * defaults, which would mislabel a custom-options run.
 */
export function resolveDetectOptions(options: DetectOptions = {}): Required<DetectOptions> {
  return {
    prominence: options.prominence ?? PROMINENCE,
    distance: options.distance ?? DISTANCE,
    minWidth: options.minWidth ?? MIN_WIDTH,
    relHeight: options.relHeight ?? REL_HEIGHT,
  };
}

/**
 * Python `round` is round-half-to-even (banker's rounding); JS `Math.round` rounds
 * half toward +Inf. The reference uses `int(round(...))`, so we mirror its rule to
 * keep integration windows bit-identical for the (rare) exact-.5 case.
 */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // Exactly .5 -> round to even.
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Detector resolution constant `k` from one trusted (anchor) peak, where
 * `FWHM(ch) ~ k*sqrt(ch)`. Mirrors `make_resolution_model`: `k = fwhm/sqrt(ch)`.
 */
export function resolutionConstantK(anchorChannel: number, anchorFwhm: number): number {
  return anchorFwhm / Math.sqrt(anchorChannel);
}

/**
 * Width a genuine line should have at `channel` for resolution constant `k`.
 * Mirrors the reference `expected_fwhm`: `k*sqrt(max(channel, 1))`.
 */
export function expectedFwhmChannels(channel: number, k: number): number {
  return k * Math.sqrt(Math.max(channel, 1));
}

export interface PeakMeasurement {
  readonly netArea: number;
  readonly grossArea: number;
  readonly significance: number;
}

/**
 * Net / gross area and counting significance for one peak. Mirrors the reference
 * `measure_peak`: an inclusive `+/- round(windowFactor*FWHM)` window (floored at
 * `MIN_HALF_WINDOW`), net taken from the UN-CLIPPED net = counts - background, and
 * `significance = net_area / sqrt(max(gross_area, 1))`.
 *
 * @param net  un-clipped net counts (counts - background), NOT the smoothed series.
 */
export function measurePeak(
  peakChannel: number,
  fwhmChannels: number,
  counts: readonly number[],
  net: readonly number[],
  windowFactor: number = WINDOW_FACTOR,
): PeakMeasurement {
  const half = Math.max(pyRound(windowFactor * fwhmChannels), MIN_HALF_WINDOW);
  const lo = Math.max(peakChannel - half, 0);
  const hi = Math.min(peakChannel + half, counts.length - 1);
  let netArea = 0;
  let grossArea = 0;
  for (let i = lo; i <= hi; i++) {
    netArea += net[i];
    grossArea += counts[i];
  }
  const significance = netArea / Math.sqrt(Math.max(grossArea, 1));
  return { netArea, grossArea, significance };
}

/**
 * Classify a peak from its width ratio and significance. Mirrors the reference
 * `classify_candidate` (significance gate FIRST, then width):
 *   - significance < MIN_SIGNIFICANCE -> `weak`
 *   - widthRatio   > MAX_WIDTH_RATIO   -> `broad`
 *   - otherwise                        -> `line`
 */
export function classifyPeak(widthRatio: number, significance: number): PeakClass {
  if (significance < MIN_SIGNIFICANCE) return 'weak';
  if (widthRatio > MAX_WIDTH_RATIO) return 'broad';
  return 'line';
}

/** Detection output split into the full tagged list and the post-gate survivors. */
export interface DetectTrace {
  /** EVERY local maximum, ascending by channel, tagged passed / rejectReason. */
  readonly all: DetectedPeak[];
  /** `passed === true` — byte-identical to what {@link detect} returns. */
  readonly survivors: DetectedPeak[];
}

/**
 * Detect, retaining the rejected candidates the inspector needs (Peak Pipeline
 * Inspector, Phase 0). This re-walks the EXACT scipy `find_peaks` gate sequence
 * (distance -> prominence -> width) over the full local-maxima set and records,
 * per candidate, the FIRST gate it failed — without re-ordering or re-tuning a
 * gate. The survivor set and every survivor property value are identical to the
 * pre-instrumentation `detect()` output:
 *   - the distance filter runs on the full local-maxima set, exactly as scipy's
 *     step 2, so its survivors match;
 *   - prominence and width are per-peak quantities (independent of which other
 *     peaks are in the list), so measuring them over ALL local maxima yields the
 *     same value a survivor would get from the gated path.
 */
export function detectTraced(
  conditioned: ConditionedSpectrum,
  options: DetectOptions = {},
  rawSource?: Spectrum,
  strengthSource: 'raw' | 'working' = 'raw',
): DetectTrace {
  const { prominence, distance, minWidth, relHeight } = resolveDetectOptions(options);

  const smoothed = conditioned.smoothed;
  // GROSS source is ALWAYS raw (D-4a -- gross never moves): the significance denominator
  // (`√grossArea`) stays Poisson-correct on the untouched total counts. `rawSource`
  // (threaded from the orchestrator; set by Peak Finder) supplies the untouched raw
  // spectrum; absent (Calibrate / Identify) it defaults to `conditioned.source`, raw
  // there, so those paths stay byte-identical.
  const counts = (rawSource ?? conditioned.source).counts;
  const background = conditioned.background;
  // STRENGTH NET -- the series the net area (measurePeak) and the resolution anchor rank
  // by. Two modes, PF-scoped:
  //  - 'raw' (DEFAULT; Calibrate / Identify): the RAW un-clipped net (counts - background),
  //    matching the Python reference exactly -- so the committed reference fixtures and
  //    the §8.3 "no smoothed series leaks into a filtering/confidence signal" guarantee
  //    hold for every caller that does NOT opt in.
  //  - 'working' (Peak Finder, #4): the WORKING series detection ran on. `conditioned.smoothed`
  //    IS the net-or-smoothed-net the Peak Finder chose (the mandatory Net / Smoothed-Net
  //    pick; clipped >= 0). Only the net-for-area + the resolution anchor move to it; the
  //    gross source and the significance denominator stay raw (D-4a). Fit still measures
  //    physics from raw (R1), unchanged.
  // (conditioned.netCounts is the clipped net and is not used for the 'raw' path.)
  const net =
    strengthSource === 'working'
      ? conditioned.smoothed
      : counts.map((c, i) => c - background[i]);

  // Divergence: this re-derives the findPeaks (scipy find_peaks) composition inline
  // (localMaxima1d -> selectByPeakDistance -> peakProminences -> peakWidths) so every
  // local maximum can be tagged with its first-failing gate. src/signal/findPeaks.ts
  // remains the reference composition; parity is guarded by
  // tests/detectFindPeaksParity.test.ts (DEBT-26).
  // Step 1 -- every strict local maximum (plateau midpoints), pre-gate.
  const maxima = localMaxima1d(smoothed);
  if (maxima.length === 0) return { all: [], survivors: [] };

  // Step 2 -- distance filter on the FULL local-maxima set (scipy order). A peak
  // removed here fails the distance gate first.
  const keepDistance = selectByPeakDistance(
    maxima,
    maxima.map((p) => smoothed[p]),
    distance,
  );
  // Prominence + width measured for every local maximum (per-peak independent of
  // the set, so survivors get identical values to the gated path).
  const prom = peakProminences(smoothed, maxima);
  const widths = peakWidths(smoothed, maxima, relHeight, prom);

  // First-failing gate per candidate, in the fixed distance -> prominence -> width
  // order. `null` => survivor. scipy keeps where pmin <= value, so a value strictly
  // below the threshold is rejected.
  const reasons: (DetectRejectReason | null)[] = maxima.map((_, i) => {
    if (!keepDistance[i]) return 'distance';
    if (prom.prominences[i] < prominence) return 'prominence';
    if (widths.widths[i] < minWidth) return 'width';
    return null;
  });

  // Resolution anchor: the strongest SURVIVOR by NET counts (reference run_pipeline).
  // A single survivor anchors on itself -> widthRatio === 1 exactly. With no
  // survivors (rejected-only trace) we anchor on the strongest local maximum so the
  // rejected candidates still carry a meaningful widthRatio.
  let anchorIdx = -1;
  for (let i = 0; i < maxima.length; i++) {
    if (reasons[i] !== null) continue;
    if (anchorIdx < 0 || net[maxima[i]] > net[maxima[anchorIdx]]) anchorIdx = i;
  }
  if (anchorIdx < 0) {
    anchorIdx = 0;
    for (let i = 1; i < maxima.length; i++) {
      if (net[maxima[i]] > net[maxima[anchorIdx]]) anchorIdx = i;
    }
  }
  const k = resolutionConstantK(maxima[anchorIdx], widths.widths[anchorIdx]);

  const all: DetectedPeak[] = [];
  const survivors: DetectedPeak[] = [];
  for (let i = 0; i < maxima.length; i++) {
    const channel = maxima[i];
    const fwhmChannels = widths.widths[i];
    const { netArea, grossArea, significance } = measurePeak(channel, fwhmChannels, counts, net);
    const expected = expectedFwhmChannels(channel, k);
    const widthRatio = fwhmChannels / expected;
    const reason = reasons[i];
    const peak: DetectedPeak = {
      channel,
      height: smoothed[channel],
      fwhmChannels,
      leftIp: widths.leftIps[i],
      rightIp: widths.rightIps[i],
      prominence: prom.prominences[i],
      netArea,
      grossArea,
      significance,
      expectedFwhmChannels: expected,
      widthRatio,
      classification: classifyPeak(widthRatio, significance),
      passed: reason === null,
      ...(reason !== null ? { rejectReason: reason } : {}),
    };
    all.push(peak);
    if (reason === null) survivors.push(peak);
  }
  // local maxima are ascending; both lists preserve that order.
  return { all, survivors };
}

export function detect(conditioned: ConditionedSpectrum, options: DetectOptions = {}): DetectedPeak[] {
  return detectTraced(conditioned, options).survivors;
}
