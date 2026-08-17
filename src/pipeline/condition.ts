/**
 * Stage 2 -- Condition: estimate the background continuum and smooth for detection.
 *
 * Background uses SNIP (Statistics-sensitive Non-linear Iterative Peak-clipping)
 * on the LLS-transformed spectrum -- the standard, element-agnostic continuum
 * estimator. Smoothing is a Savitzky-Golay filter (F2) used ONLY for peak
 * detection; peak areas must come from the raw net counts, never the smoothed
 * series. The defaults (snip 45, savgol 9/3) match the reference
 * `Calibration Mode.py` and the committed `tests/fixtures/reference/*.json`.
 */
import type { ConditionedSpectrum, Spectrum } from '../domain/types';
import { savitzkyGolay } from '../signal';

export interface ConditionOptions {
  /** SNIP clipping window (iterations). Larger removes broader structure. */
  readonly snipIterations?: number;
  /** Savitzky-Golay window length (odd, > polyorder) for the detection series. */
  readonly savgolWindow?: number;
  /** Savitzky-Golay polynomial order for the detection series. */
  readonly savgolPolyorder?: number;
  /**
   * // Divergence (Peak Finder Load-owned smoothing, R4): whether to Savitzky-Golay
   * smooth the net before detection. Default `'savgol'` -- the reference / Calibrate
   * / Identify path, unchanged (so the committed reference-parity fixtures stay
   * green). Peak Finder passes `'none'`: it has ALREADY (optionally) smoothed the RAW
   * spectrum at the Load stage, so a second smoothing pass here would double-smooth.
   * With `'none'` the detection series is the (clipped) net residual directly.
   */
  readonly smoothing?: 'savgol' | 'none';
}

/** SNIP clipping-window default (iterations). Exported so a display surface (the Peak
 * Finder's Estimate Continuum SNIP page) can report the EFFECTIVE iteration count the
 * manager ran without hard-coding a literal -- it is a display re-export, the numeric
 * default is unchanged, so the committed reference-parity fixtures stay byte-identical. */
export const SNIP_DEFAULT_ITERATIONS = 45;

const DEFAULTS = { snipIterations: SNIP_DEFAULT_ITERATIONS, savgolWindow: 9, savgolPolyorder: 3 } as const;

/** Log-Log-Sqrt transform stabilizes the wide dynamic range before SNIP. Exported so the
 * Peak Finder's Estimate Continuum sub-pages can render the LLS-domain working copy and the
 * SNIP background in that domain WITHOUT re-running SNIP (display reconstruction only -- the
 * numerics here are unchanged, preserving the committed reference-parity fixtures). */
export function lls(y: number): number {
  return Math.log(Math.log(Math.sqrt(Math.max(0, y) + 1) + 1) + 1);
}
export function invLls(z: number): number {
  const a = Math.exp(Math.exp(z) - 1) - 1;
  return a * a - 1;
}

/**
 * The SNIP clip CORE: run `iterations` peak-clipping passes over an ALREADY-LLS-transformed
 * working array `v`, mutating it in place. The clipping-window half-width `p` runs 1 →
 * `iterations`, so the window expands one channel per pass. This is the SINGLE clip
 * implementation -- both {@link estimateBackground} (the reference-parity path) and
 * {@link estimateBackgroundTraced} (the education trace) delegate here, so the two can never
 * numerically drift. `onPass(p, v, prev)` fires AFTER each pass with the post-pass array and its
 * pre-pass snapshot -- used only for tracing; omitted on the hot path (no per-pass allocation
 * beyond the `prev` slice the algorithm already needs). The loop body is byte-identical to the
 * former inline `estimateBackground` loop, so the committed reference-parity fixtures stay green.
 */
function snipClip(
  v: number[],
  n: number,
  iterations: number,
  onPass?: (p: number, v: readonly number[], prev: readonly number[]) => void,
): void {
  for (let p = 1; p <= iterations; p++) {
    const prev = v.slice();
    for (let i = p; i < n - p; i++) {
      const avg = (prev[i - p] + prev[i + p]) / 2;
      if (avg < v[i]) v[i] = avg;
    }
    onPass?.(p, v, prev);
  }
}

export function estimateBackground(counts: readonly number[], iterations: number): number[] {
  const n = counts.length;
  const v = counts.map(lls);
  snipClip(v, n, iterations);
  return v.map(invLls).map((x) => (x > 0 ? x : 0));
}

/**
 * One traced SNIP run for the Peak Finder's SNIP Peak Clipping education page: the LLS-domain
 * working array snapshotted at the requested checkpoints, plus the per-iteration maximum change.
 * Additive -- {@link estimateBackgroundTraced} produces this from a SEPARATE clip; it never alters
 * the committed background numerics.
 */
export interface SnipTrace {
  /** Iteration indices captured, ascending, last === {@link iterations}, e.g. `[1,5,10,20,45]`. */
  readonly checkpoints: readonly number[];
  /** LLS-domain snapshot of the working array AFTER each checkpoint pass (pre-`invLls`), aligned
   * to {@link checkpoints}. `snapshotsLls[last]`'s `invLls` (clamped ≥ 0) is the committed
   * background; `snapshotsLls[k]`'s is `estimateBackground(counts, checkpoints[k])`. */
  readonly snapshotsLls: readonly (readonly number[])[];
  /** Per-iteration maximum absolute change `max_i |v_p(i) − v_{p-1}(i)|`, length ===
   * {@link iterations}. Decays as the clip converges; the last entry is the honest final change
   * (SNIP has no early-stopping test, so this is a metric, not a "converged" event). */
  readonly changeSeries: readonly number[];
  /** The SNIP pass count this trace ran (= the effective iteration count). */
  readonly iterations: number;
  /** The clipping-window half-width at the first pass (always 1 channel). */
  readonly windowInitial: number;
  /** The clipping-window half-width at the final pass (=== {@link iterations} channels). */
  readonly windowFinal: number;
}

/**
 * A single SNIP run, TRACED for the SNIP Peak Clipping education page. Captures the LLS-domain
 * working array at the requested `checkpoints` and the per-iteration maximum change -- exact
 * intermediate states, from ONE clip over the same `counts`/`iterations` the committed background
 * came from. Purely additive: it never changes {@link estimateBackground}'s output.
 *
 * Snapshots are LLS-domain (`v.slice()` BEFORE `invLls`) because the SNIP page's chart lives in
 * that domain; the inverse is the next stage's job. `changeSeries[p-1]` is `max_i |v_p(i) −
 * v_{p-1}(i)|`, the honest per-pass convergence metric.
 *
 * Parity (locked by the unit tests): `invLls(snapshotsLls[last])` clamped ≥ 0 equals
 * `estimateBackground(counts, iterations)` element-wise, and more generally `snapshotsLls[k]`'s
 * `invLls` (clamped) equals `estimateBackground(counts, checkpoints[k])` -- because SNIP is
 * strictly iterative, so the state after k passes IS `estimateBackground(counts, k)`'s state.
 */
export function estimateBackgroundTraced(
  counts: readonly number[],
  iterations: number,
  checkpoints: readonly number[],
): SnipTrace {
  const n = counts.length;
  const v = counts.map(lls);
  // Normalise the requested checkpoints: keep only real passes (1 … iterations), dedupe, sort
  // ascending, and ALWAYS end at `iterations` so the last snapshot is the committed final clip.
  const wanted = new Set<number>();
  for (const c of checkpoints) {
    const k = Math.round(c);
    if (k >= 1 && k <= iterations) wanted.add(k);
  }
  if (iterations >= 1) wanted.add(iterations);
  const cps = Array.from(wanted).sort((a, b) => a - b);
  const cpSet = new Set(cps);
  const snapshotsLls: number[][] = [];
  const changeSeries: number[] = [];
  snipClip(v, n, iterations, (p, cur, prev) => {
    let maxChange = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(cur[i] - prev[i]);
      if (d > maxChange) maxChange = d;
    }
    changeSeries.push(maxChange);
    if (cpSet.has(p)) snapshotsLls.push(cur.slice());
  });
  return {
    checkpoints: cps,
    snapshotsLls,
    changeSeries,
    iterations,
    windowInitial: 1,
    windowFinal: iterations,
  };
}

/** The estimated continuum for one input spectrum: the SNIP background and the net
 * (input − background, clamped ≥ 0). */
export interface ContinuumEstimate {
  readonly background: number[];
  /** input.counts − background, clamped at ≥ 0. */
  readonly net: number[];
}

/**
 * Estimate the continuum for a single input spectrum -- the continuum CORE, factored
 * so the SNIP numerics live in exactly ONE place ({@link estimateBackground}).
 *
 * It runs SNIP on `input.counts` and returns the background plus `net = input −
 * background` (clamped ≥ 0). Both {@link condition} (the Calibrate / Identify path)
 * and the Peak Finder's Estimate Continuum stage call this, so an input-selectable
 * continuum needs NO second SNIP implementation -- the SNIP reference parity locked by
 * the committed fixtures is inherited unchanged. No smoothing here (that is a detection
 * concern condition owns); this is background + net only.
 */
export function estimateContinuum(
  input: Spectrum,
  options: { snipIterations?: number } = {},
): ContinuumEstimate {
  const iterations = options.snipIterations ?? DEFAULTS.snipIterations;
  const counts = input.counts;
  const background = estimateBackground(counts, iterations);
  const net = counts.map((c, i) => Math.max(0, c - background[i]));
  return { background, net };
}

/**
 * Centered moving average. Retired from the conditioning path (C1 replaced it with
 * Savitzky-Golay) but kept exported -- harmless, self-contained, and still tested.
 */
export function movingAverage(data: readonly number[], window: number): number[] {
  if (window <= 1) return data.slice();
  const half = Math.floor(window / 2);
  const n = data.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < n) {
        sum += data[j];
        cnt++;
      }
    }
    out[i] = sum / cnt;
  }
  return out;
}

export function condition(spectrum: Spectrum, options: ConditionOptions = {}): ConditionedSpectrum {
  const iterations = options.snipIterations ?? DEFAULTS.snipIterations;
  const savgolWindow = options.savgolWindow ?? DEFAULTS.savgolWindow;
  const savgolPolyorder = options.savgolPolyorder ?? DEFAULTS.savgolPolyorder;
  const counts = spectrum.counts;
  // The continuum CORE (SNIP background + clamped net), shared with the Peak Finder's
  // Estimate Continuum stage so the SNIP numerics are single-sourced. Byte-identical to
  // the former inline `estimateBackground` + net map.
  const { background, net: netCounts } = estimateContinuum(spectrum, { snipIterations: iterations });
  // Detection series. Default: Savitzky-Golay on the (un-clipped) net, then clip
  // negatives to 0 -- exactly the reference's `smooth_spectrum`. Areas never read
  // this; they come from the raw counts / net in detect (RULEBOOK: no areas from
  // smoothed).
  // // Divergence (R4): with `smoothing: 'none'` (the Peak Finder path) the detection
  // series is the clipped net residual itself -- NO SG here, because the Peak Finder
  // already owns smoothing at the Load stage and a pass here would double-smooth.
  const smoothing = options.smoothing ?? 'savgol';
  const smoothed =
    smoothing === 'none'
      ? netCounts
      : savitzkyGolay(
          counts.map((c, i) => c - background[i]),
          savgolWindow,
          savgolPolyorder,
        ).map((v) => (v > 0 ? v : 0));
  return { source: spectrum, background, netCounts, smoothed };
}
