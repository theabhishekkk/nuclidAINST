/**
 * peakFinderContinuumStats -- the data-led derivations behind the four "teaching"
 * Estimate-Continuum sub-pages (LLS / SNIP / inverse-LLS / net).
 *
 * Pure presentation over the manager's ALREADY-computed arrays (Principle 9): every
 * figure here is either a field the {@link PeakFinderManager} exposes or a pure DISPLAY
 * transform of one (a sum, a min/max, a count, a ratio). Nothing re-runs the engine --
 * there is no call into `estimateContinuum` / `analyzeSpectrumTraced` from this file, so
 * the committed reference-parity fixtures stay byte-identical. `app.ts` calls this per
 * page id and only RENDERS the returned structures (into `.cfg-recap` + `.pf-table`).
 *
 * CHANNEL SPACE ONLY: no energy / keV field is ever read or displayed (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate).
 *
 * Representative-channel sampling (Option A, signed off): detection has NOT run at the
 * continuum stage, so the LLS + inverse-LLS pages sample five channels STRUCTURALLY, by
 * input-count magnitude (min / 25th / median / 75th / max). Both pages call
 * {@link sampleChannels} over the SAME `counts`, so -- being deterministic -- they track
 * the identical five channels LLS -> clip -> inverse.
 */

/** The manager arrays these pages read -- all already exposed on {@link PeakFinderManager}
 * (`selectedInput.counts`, `backgroundSpectrum`, `netSpectrum`, `llsInput`, `llsBackground`)
 * plus the effective SNIP iteration count (`snipIterations`). Passed in as plain data so the
 * derivations stay pure + unit-testable without constructing a manager. */
export interface ContinuumStatsInput {
  readonly counts: readonly number[];
  readonly background: readonly number[];
  readonly net: readonly number[];
  readonly llsInput: readonly number[];
  readonly llsBackground: readonly number[];
  readonly snipIterations: number;
}

/** One label/value pair for the `.cfg-recap` stat grid (value pre-formatted for display). */
export interface ContinuumStatPair {
  readonly label: string;
  readonly value: string;
}

/** A small sample table (already-formatted cells) for the `.pf-table` sample grid. */
export interface ContinuumSampleTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

/** The three DYNAMIC figures on the Working Copy stage's Source-Spectrum card (the rest of the
 * page is static reassurance/education). No math happens on this stage -- the working copy is a
 * byte-identical duplicate of the selected input -- so these are pure display reads of that
 * input: which spectrum it is, its channel count, and its total counts (Principle 9). */
export interface WorkingCopyStats {
  /** "Raw Spectrum" | "Savitzky–Golay Smoothed Spectrum" -- tracks `continuumInput`. */
  readonly sourceLabel: string;
  /** `counts.length`, thousands-grouped. */
  readonly channels: string;
  /** Σ`counts`, rounded + thousands-grouped. */
  readonly totalCounts: string;
}

/** Every figure the redesigned LLS Transform stage's four cards need, all derived PURELY from
 * the two arrays the manager already holds -- `counts` (before) and `llsInput` (after). Nothing
 * re-runs the engine: each field is a min / max / mean / stddev / ratio over those arrays, or a
 * structural truth of the per-channel transform (length, sign). Values are pre-formatted for
 * display (counts thousands-grouped, LLS to 3 dp, ratios as `N.N×`); the two booleans stay raw
 * so the card renderer can turn them into honest Yes/No / Unchanged strings. */
export interface LlsTransformStats {
  // --- Transformation Summary card ---
  /** Max counts before, thousands-grouped (`amax(counts)`). */
  readonly maxBefore: string;
  /** Max LLS value after, 3 dp (`amax(llsInput)`). */
  readonly maxAfter: string;
  /** Input dynamic range ÷ LLS dynamic range, as `N.N×`. */
  readonly compressionRatio: string;
  /** maxCounts / max(1, minCounts), as `N.N×`. */
  readonly dynamicRangeBefore: string;
  /** maxLls / max(ε, minLls), as `N.N×`. */
  readonly dynamicRangeAfter: string;
  /** Always "Applied" -- the transform ran to reach this page. */
  readonly status: string;
  // --- Effect card (booleans -> the card renders honest Yes/No / Unchanged strings) ---
  /** `counts.length === llsInput.length` (always true for a per-channel transform). */
  readonly lengthUnchanged: boolean;
  /** `amin(llsInput) < 0` (always false: the +1 offsets keep LLS non-negative at y=0). */
  readonly negativesIntroduced: boolean;
  // --- Transformation Statistics table: Before (counts) vs After (llsInput) ---
  readonly table: {
    readonly min: { before: string; after: string };
    readonly max: { before: string; after: string };
    readonly mean: { before: string; after: string };
    readonly stddev: { before: string; after: string };
  };
}

/** Every figure the redesigned Inverse LLS Transform stage's cards need, derived PURELY from the
 * two arrays the manager already holds -- `background` (the estimated continuum in detector counts,
 * AFTER the inverse) and `llsBackground` (SNIP's output in the compressed LLS domain, BEFORE it).
 * The inverse ESTIMATES nothing: it restores the numerical scale of an already-estimated continuum,
 * so every field is a min / max / mean / ratio / length read over those committed arrays -- nothing
 * re-runs the engine. Mirror of {@link LlsTransformStats}: the counterpart stage compresses counts →
 * LLS; this one restores LLS → counts. Values are pre-formatted (counts thousands-grouped, LLS to
 * 3 dp, ratio as `N.N×`); the four representation/status/ready strings are STATIC (the inverse always
 * ran to reach this page); `lengthUnchanged` stays raw so the card renders an honest "Unchanged". */
export interface InverseLlsStats {
  // --- Transformation Summary card (static reps + reinforcing max reads) ---
  /** Always "LLS Space" -- the compressed domain the inverse reads from. */
  readonly inputRepresentation: string;
  /** Always "Detector Counts" -- the physical scale the inverse restores to. */
  readonly outputRepresentation: string;
  /** Always "Applied" -- the inverse ran to reach this page. */
  readonly status: string;
  /** Always "Yes" -- the background now lives in counts, ready to subtract. */
  readonly readyForSubtraction: string;
  /** Max LLS-domain background, 3 dp (`amax(llsBackground)`) -- the before scale. */
  readonly maxBefore: string;
  /** Max counts-domain background, thousands-grouped (`amax(background)`) -- the restored scale. */
  readonly maxAfter: string;
  // --- Effect card (boolean drives the honest "Unchanged" string) ---
  /** `background.length === llsBackground.length` (always true for a per-channel inverse). */
  readonly lengthUnchanged: boolean;
  // --- Background Statistics card (counts-domain, meaningful only after the inverse) ---
  readonly minCounts: string; // fmtCount(amin(background))
  readonly maxCounts: string; // fmtCount(amax(background))
  readonly meanCounts: string; // fmtCount(amean(background))
  /** maxCounts / max(1, minCounts), as `N.N×`. */
  readonly dynamicRange: string;
}

/** The dynamic Clipping-Progress figures for one SELECTED SNIP checkpoint -- the only figures on
 * the SNIP page that change as the iteration stepper moves. Split out so the stepper's click
 * handler can re-derive just these (via {@link deriveSnipProgress}) without touching the arrays. */
export interface SnipProgress {
  /** The selected checkpoint, thousands-grouped (e.g. "45"). */
  readonly currentIteration: string;
  /** The total pass count, thousands-grouped. */
  readonly totalIterations: string;
  /** The clipping-window half-width at the selected pass (= the iteration), e.g. "20 channels". */
  readonly currentWindow: string;
  /** The clipping-window half-width at the final pass, e.g. "45 channels". */
  readonly maxWindow: string;
  /** "Completed" at the final checkpoint; else "Iteration k of N". */
  readonly status: string;
}

/** Every figure the redesigned SNIP Peak Clipping stage's cards need, derived PURELY from the
 * committed arrays (`counts` / `background` / `llsInput` / `llsBackground`) + the manager's
 * `snipTrace` (iteration count + per-pass change series). Nothing re-runs the engine here -- the
 * single traced clip already happened in the manager. The ① Clipping-Progress fields are for the
 * DEFAULT (final) selection; the stepper re-derives them per selection via {@link deriveSnipProgress}.
 * Continuum Summary (③) is reported in the COUNTS domain (matching the existing SNIP page and the
 * physically meaningful scale -- see the redesign handoff's OPEN DECISION, resolved to counts). */
export interface SnipClipStats {
  // ① Clipping Progress (default = final selection; dynamic via deriveSnipProgress) ------------
  readonly progress: SnipProgress;
  // ② Effect of Peak Clipping (final clipped state: llsInput vs llsBackground) -----------------
  /** Channels the clip lowered: #{ i : llsBackground[i] < llsInput[i] − ε }, thousands-grouped. */
  readonly channelsClipped: string;
  /** channelsClipped / channels, as `N.N%`. */
  readonly pctClipped: string;
  /** max_i(llsInput[i] − llsBackground[i]) in the LLS domain, 3 dp. */
  readonly maxReductionLls: string;
  /** Plain-language stability band derived from the final per-pass change, e.g. "High (Δ 3.1e-4)". */
  readonly continuumStability: string;
  /** The final iteration index, thousands-grouped. */
  readonly finalIteration: string;
  // ③ Continuum Summary (counts domain) -------------------------------------------------------
  readonly minContinuum: string; // fmtCount(amin(background))
  readonly maxContinuum: string; // fmtCount(amax(background))
  readonly meanContinuum: string; // fmtCount(amean(background))
  /** maxContinuum / max(1, minContinuum), as `N.N×`. */
  readonly dynamicRange: string;
  readonly channelsProcessed: string; // fmtInt(counts.length)
  // ⑥ Algorithm Parameters (structural truth) -------------------------------------------------
  readonly maxIterationsParam: string; // fmtInt(iterations)
  readonly initialWindow: string; // "1 channel"
  readonly finalWindow: string; // `${iterations} channels`
  readonly llsDomain: string; // "Enabled"
  // ⑦ Convergence Summary (honest -- SNIP has NO early stop) -----------------------------------
  /** The final per-pass change, changeSeries[last], formatted (e.g. "3.1e-4"). */
  readonly finalChange: string;
  readonly finalIterationCompleted: string; // `${iterations} / ${iterations}`
  readonly schedule: string; // "Fixed 45-pass schedule — no early stopping"
  readonly continuumReady: string; // "Yes"
}

/** The plain-data input for {@link deriveSnipClipStats}: the committed continuum arrays plus the
 * two figures the manager's `snipTrace` carries. Passed as plain data (not a manager) so the
 * derivation stays pure + unit-testable. */
export interface SnipClipInput {
  readonly counts: readonly number[];
  readonly background: readonly number[];
  readonly llsInput: readonly number[];
  readonly llsBackground: readonly number[];
  readonly iterations: number;
  /** The trace's per-iteration max-change series (`snipTrace.changeSeries`). */
  readonly changeSeries: readonly number[];
}

/** Everything one teaching page needs to render: the stat grid, an optional sample table,
 * a filled dynamic sentence, and an honest note when the spectrum was too flat to sample. */
export interface ContinuumPageStats {
  readonly stats: readonly ContinuumStatPair[];
  readonly sample?: ContinuumSampleTable;
  readonly copy: string;
  readonly note?: string;
}

/** The five sampled channel indices + whether they were chosen structurally (fallback). */
export interface ChannelSample {
  /** The representative channel indices (5 for a normal spectrum; fewer / first-N flat). */
  readonly channels: readonly number[];
  /** `true` when the spectrum was too flat (all-equal counts, or n < 5) to sample by
   * magnitude -- the channels are then just the first N and {@link FLAT_SAMPLE_NOTE} shows. */
  readonly flat: boolean;
}

/** Honest note surfaced when {@link sampleChannels} falls back to structural sampling. */
export const FLAT_SAMPLE_NOTE =
  'Spectrum too flat to sample by magnitude — showing the first channels instead.';

/** Guard against zero denominators in the dynamic-range / percentage figures. */
const EPS = 1e-9;

// --- pure array helpers (reduce-based: safe for multi-thousand-channel spectra, where
//     Math.min(...arr) would risk a call-stack overflow on the argument spread) ----------
const asum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const amin = (a: readonly number[]): number => a.reduce((m, v) => (v < m ? v : m), Infinity);
const amax = (a: readonly number[]): number => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const amean = (a: readonly number[]): number => (a.length ? asum(a) / a.length : 0);
/** Population standard deviation (÷n, not ÷n-1): a display statistic, not an inferential
 * estimate, so the whole-spectrum population deviation is the honest figure. */
const astddev = (a: readonly number[], m: number): number =>
  a.length ? Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / a.length) : 0;

// --- display formatting -------------------------------------------------------
/** Round to a whole count and group thousands. `en-US` is pinned so the output is
 * locale-stable (the unit tests assert on these exact strings). */
function fmtCount(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** Integer counter (points/channels) -- same rounding + grouping as counts. */
function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** LLS-domain values are small (~0.5 … 3); three decimals is enough to read the transform. */
function fmtLls(v: number): string {
  return v.toFixed(3);
}
function fmtRatio(v: number): string {
  return `${v.toFixed(1)}×`;
}
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}
function fmtRange(lo: number, hi: number, fmt: (n: number) => string): string {
  return `${fmt(lo)} … ${fmt(hi)}`;
}

// --- representative-channel sampling (Option A) -------------------------------

/**
 * Pick five representative channels by input-count MAGNITUDE: the channels holding the
 * min, 25th-percentile, median, 75th-percentile, and max counts. Percentiles are
 * nearest-rank over the counts distribution; ties break to the LOWEST channel index
 * (the count-ascending sort's secondary key). For n >= 5 the five nearest-rank positions
 * are strictly increasing, so five DISTINCT channels are always returned.
 *
 * Degenerate fallback (all-equal counts, or n < 5): sampling by magnitude is meaningless,
 * so return the first N (<= 5) channel indices and flag `flat` (the caller surfaces
 * {@link FLAT_SAMPLE_NOTE}) -- never crash.
 */
export function sampleChannels(counts: readonly number[]): ChannelSample {
  const n = counts.length;
  const flat = n < 5 || amin(counts) === amax(counts);
  if (flat) {
    const k = Math.min(5, n);
    return { channels: Array.from({ length: k }, (_, i) => i), flat: true };
  }
  // Channel indices ordered by count ascending, ties -> lowest index.
  const order = counts.map((_, i) => i).sort((a, b) => counts[a] - counts[b] || a - b);
  const pick = (p: number): number => order[Math.round(p * (n - 1))];
  return { channels: [pick(0), pick(0.25), pick(0.5), pick(0.75), pick(1)], flat: false };
}

// --- working-copy derivation (no math -- pure reads of the selected input) -----

/**
 * Derive the Working Copy stage's dynamic Source-Spectrum figures. The Working Copy stage
 * performs NO computation -- it duplicates the selected input so continuum estimation can
 * modify a copy while the original is preserved -- so this only READS the input it copied:
 * which spectrum (`input`), how many channels (`counts.length`), and the total counts
 * (Σ`counts`). Everything else on the page is static reassurance/education text (built in
 * `app.ts`). Formatting reuses the module's `fmtInt`/`fmtCount`, so the grouping matches the
 * teaching pages exactly.
 */
export function deriveWorkingCopyStats(
  counts: readonly number[],
  input: 'raw' | 'smoothed',
): WorkingCopyStats {
  return {
    sourceLabel: input === 'smoothed' ? 'Savitzky–Golay Smoothed Spectrum' : 'Raw Spectrum',
    channels: fmtInt(counts.length),
    totalCounts: fmtCount(asum(counts)),
  };
}

// --- LLS Transform stage derivation (pure display over counts + llsInput) ------

/**
 * Derive every figure the redesigned LLS Transform stage's cards show, PURELY from the two
 * arrays the manager already holds: `counts` (the working copy, before) and `llsInput` (its
 * log-log-sqrt transform, after). Nothing re-runs the engine -- `llsInput` is the manager's
 * committed array, and every output is a min / max / mean / stddev / ratio over those two
 * arrays, or a structural truth of the per-channel transform. The compression ratio reuses the
 * same dynamic-range math as {@link deriveLlsPage} (input-dynamic-range ÷ LLS-dynamic-range).
 * `lengthUnchanged` / `negativesIntroduced` are driven from the data so the "Unchanged" / "No"
 * reassurance the card renders is honest, not asserted. Additive -- {@link deriveLlsPage} still
 * feeds the sample table and lesson sentence; this only powers the summary/effect/statistics
 * cards.
 */
export function deriveLlsTransformStats(
  counts: readonly number[],
  llsInput: readonly number[],
): LlsTransformStats {
  const inLo = amin(counts);
  const inHi = amax(counts);
  const llLo = amin(llsInput);
  const llHi = amax(llsInput);
  const inputDynamicRange = inHi / Math.max(1, inLo);
  const llsDynamicRange = llHi / Math.max(EPS, llLo);
  const compression = inputDynamicRange / Math.max(EPS, llsDynamicRange);
  const meanBefore = amean(counts);
  const meanAfter = amean(llsInput);
  const sdBefore = astddev(counts, meanBefore);
  const sdAfter = astddev(llsInput, meanAfter);
  return {
    maxBefore: fmtCount(inHi),
    maxAfter: fmtLls(llHi),
    compressionRatio: fmtRatio(compression),
    dynamicRangeBefore: fmtRatio(inputDynamicRange),
    dynamicRangeAfter: fmtRatio(llsDynamicRange),
    status: 'Applied',
    lengthUnchanged: counts.length === llsInput.length,
    negativesIntroduced: amin(llsInput) < 0,
    table: {
      min: { before: fmtCount(inLo), after: fmtLls(llLo) },
      max: { before: fmtCount(inHi), after: fmtLls(llHi) },
      mean: { before: fmtCount(meanBefore), after: fmtLls(meanAfter) },
      stddev: { before: fmtCount(sdBefore), after: fmtLls(sdAfter) },
    },
  };
}

// --- Inverse LLS Transform stage derivation (pure display over background + llsBackground) --

/**
 * Derive every figure the redesigned Inverse LLS Transform stage's cards show, PURELY from the two
 * arrays the manager already holds: `background` (the estimated continuum restored to detector
 * counts, AFTER) and `llsBackground` (SNIP's clipped output in the LLS domain, BEFORE). The inverse
 * ESTIMATES nothing new -- it restores the numerical scale of an already-estimated continuum -- so
 * nothing re-runs the engine: each output is a min / max / mean / ratio over those committed arrays,
 * or the structural length truth. Counterpart of {@link deriveLlsTransformStats} (which compresses
 * counts → LLS); here we read the LLS-domain max (before) and the counts-domain min/max/mean/range
 * (meaningful only after the inverse). The representation/status/ready strings are STATIC -- the
 * inverse always ran to reach this page -- and `lengthUnchanged` is driven from the data so the
 * "Unchanged" reassurance the card renders is honest, not asserted. Additive -- {@link deriveInvLlsPage}
 * still feeds the (optional) background-vs-input sample table; this only powers the redesigned cards.
 */
export function deriveInverseLlsStats(
  background: readonly number[],
  llsBackground: readonly number[],
): InverseLlsStats {
  const bgLo = amin(background);
  const bgHi = amax(background);
  const bgMean = amean(background);
  const llsHi = amax(llsBackground);
  const dynamicRange = bgHi / Math.max(1, bgLo);
  return {
    inputRepresentation: 'LLS Space',
    outputRepresentation: 'Detector Counts',
    status: 'Applied',
    readyForSubtraction: 'Yes',
    maxBefore: fmtLls(llsHi),
    maxAfter: fmtCount(bgHi),
    lengthUnchanged: background.length === llsBackground.length,
    minCounts: fmtCount(bgLo),
    maxCounts: fmtCount(bgHi),
    meanCounts: fmtCount(bgMean),
    dynamicRange: fmtRatio(dynamicRange),
  };
}

// --- Net Spectrum stage derivation (pure display over counts + background + net) -------------

/** Every figure the redesigned Net Spectrum stage's cards need, derived PURELY from the three
 * arrays the manager already holds -- `counts` (the raw/working input chosen on the SG stage),
 * `background` (the estimated continuum restored to detector counts) and `net` (max(0, input −
 * background), already clamped by the engine). The subtraction ALREADY happened in the manager;
 * nothing here re-runs the engine -- each field is a sum / min / max / mean / count / fraction over
 * those committed arrays. Mirror of {@link InverseLlsStats}: this is the pay-off page that answers
 * "what remains after the estimated background is removed?". Values are pre-formatted for display
 * (counts thousands-grouped, fractions as `N.N%`); `lengthUnchanged` stays raw so the card renders
 * an honest "Unchanged". Channel space only -- no keV. */
export interface NetSpectrumStats {
  // --- Subtraction Statistics card ---
  /** Σ`counts`, thousands-grouped. */
  readonly totalRawCounts: string;
  /** Σ`background`, thousands-grouped. */
  readonly totalBackgroundCounts: string;
  /** Σ`net`, thousands-grouped. */
  readonly totalNetCounts: string;
  /** Σbg / max(1, Σraw), as `N.N%`. */
  readonly backgroundFraction: string;
  /** Σnet / max(1, Σraw), as `N.N%`. */
  readonly netFraction: string;
  /** (Σraw − Σnet) / max(1, Σraw), as `N.N%`. */
  readonly backgroundRemoved: string;
  // --- Net Spectrum Statistics card (net only) ---
  readonly minNet: string; // fmtCount(amin(net))
  readonly maxNet: string; // fmtCount(amax(net))
  readonly meanNet: string; // fmtCount(amean(net))
  // --- Effect / Processing Integrity cards ---
  /** #{ i : counts[i] − background[i] <= 0 }, thousands-grouped (channels clamped to zero). */
  readonly clampedCount: string;
  /** `counts.length === net.length` (always true for a per-channel subtraction). */
  readonly lengthUnchanged: boolean;
}

/**
 * Derive every figure the redesigned Net Spectrum stage's cards show, PURELY from the three arrays
 * the manager already holds: `counts` (the selected input), `background` (the estimated continuum in
 * counts) and `net` (the engine-clamped `max(0, input − background)`). Nothing re-runs the engine --
 * each output is a sum / min / max / mean / count / fraction over those committed arrays. The three
 * total fractions guard their denominator with the module's `Math.max(1, …)` idiom (a zero total
 * spectrum can never divide-by-zero); `clampedCount` counts the channels where the background met or
 * exceeded the counts (the physically-necessary clamp -- a count rate cannot be negative);
 * `lengthUnchanged` is driven from the data so the "Unchanged" reassurance the card renders is honest.
 * Counterpart of {@link deriveInverseLlsStats}: where that restores the background's scale, this
 * subtracts it away to isolate the net signal peak detection searches. Additive -- {@link deriveNetPage}
 * still feeds the (now-unrendered) parity stat grid; this only powers the redesigned cards.
 */
export function deriveNetSpectrumStats(
  counts: readonly number[],
  background: readonly number[],
  net: readonly number[],
): NetSpectrumStats {
  const sumRaw = asum(counts);
  const sumBg = asum(background);
  const sumNet = asum(net);
  const denom = Math.max(1, sumRaw);
  let clamped = 0;
  const n = counts.length;
  for (let i = 0; i < n; i++) if (counts[i] - background[i] <= 0) clamped++;
  return {
    totalRawCounts: fmtCount(sumRaw),
    totalBackgroundCounts: fmtCount(sumBg),
    totalNetCounts: fmtCount(sumNet),
    backgroundFraction: fmtPct((sumBg / denom) * 100),
    netFraction: fmtPct((sumNet / denom) * 100),
    backgroundRemoved: fmtPct(((sumRaw - sumNet) / denom) * 100),
    minNet: fmtCount(amin(net)),
    maxNet: fmtCount(amax(net)),
    meanNet: fmtCount(amean(net)),
    clampedCount: fmtInt(clamped),
    lengthUnchanged: counts.length === net.length,
  };
}

// --- SNIP Peak Clipping stage derivation (pure display over committed arrays + snipTrace) ----

/** Format a tiny LLS-domain per-pass change honestly: sub-milli values in `N.Ne±E` scientific
 * form (so "3.1e-4" is not rounded away to "0.000"), larger values to 4 dp, exact zero as "0". */
function fmtChange(v: number): string {
  if (v === 0) return '0';
  if (v < 1e-3) return v.toExponential(1);
  return v.toFixed(4);
}

/**
 * Derive the ① Clipping-Progress figures for one SELECTED checkpoint. Split from
 * {@link deriveSnipClipStats} because the iteration stepper re-derives ONLY these on each click
 * (the rest of the page reflects the final clipped state and never moves). `selected` is a real
 * pass index (1 … iterations); at the final pass the status reads "Completed". Pure display --
 * no arrays touched, so the stepper can call it with just the two counts it already knows.
 */
export function deriveSnipProgress(iterations: number, selected: number): SnipProgress {
  const isFinal = selected >= iterations;
  return {
    currentIteration: fmtInt(selected),
    totalIterations: fmtInt(iterations),
    currentWindow: `${fmtInt(selected)} ${selected === 1 ? 'channel' : 'channels'}`,
    maxWindow: `${fmtInt(iterations)} channels`,
    status: isFinal ? 'Completed' : `Iteration ${fmtInt(selected)} of ${fmtInt(iterations)}`,
  };
}

/**
 * Derive every figure the redesigned SNIP Peak Clipping stage's cards show, PURELY from the
 * committed continuum arrays + the manager's traced change series -- nothing re-runs the engine
 * (the one traced clip already happened in the manager). ② reads the FINAL clipped state
 * (`llsInput` vs `llsBackground`); ③ summarises the estimated continuum in the counts domain
 * (the physically meaningful scale, matching the existing SNIP page -- handoff OPEN DECISION
 * resolved to counts); ⑥ is structural truth (the window = iteration fact, `SNIP_DEFAULT_ITERATIONS`);
 * ⑦ is HONEST -- the final per-pass change speaks for itself, no invented "converged" event, because
 * SNIP runs a fixed schedule with no early-stopping test. `selected` seeds ① at the default (final)
 * checkpoint; the stepper moves it via {@link deriveSnipProgress}.
 */
export function deriveSnipClipStats(inp: SnipClipInput, selected: number): SnipClipStats {
  const { counts, background, llsInput, llsBackground, iterations, changeSeries } = inp;
  const n = llsInput.length;
  let channelsClipped = 0;
  let maxReduction = 0;
  for (let i = 0; i < n; i++) {
    if (llsBackground[i] < llsInput[i] - EPS) channelsClipped++;
    const r = llsInput[i] - llsBackground[i];
    if (r > maxReduction) maxReduction = r;
  }
  const pctClipped = n ? (channelsClipped / n) * 100 : 0;
  const bgLo = amin(background);
  const bgHi = amax(background);
  const bgMean = amean(background);
  const change = changeSeries.length ? changeSeries[changeSeries.length - 1] : 0;
  // Plain-language stability band from the final per-pass change -- the number is ALWAYS shown
  // alongside so the label is honest, not asserted (handoff: derive the threshold + wording here).
  const band = change < 1e-3 ? 'High' : change < 1e-2 ? 'Moderate' : 'Low';
  return {
    progress: deriveSnipProgress(iterations, selected),
    channelsClipped: fmtInt(channelsClipped),
    pctClipped: fmtPct(pctClipped),
    maxReductionLls: fmtLls(maxReduction),
    continuumStability: `${band} (Δ ${fmtChange(change)})`,
    finalIteration: fmtInt(iterations),
    minContinuum: fmtCount(bgLo),
    maxContinuum: fmtCount(bgHi),
    meanContinuum: fmtCount(bgMean),
    dynamicRange: fmtRatio(bgHi / Math.max(1, bgLo)),
    channelsProcessed: fmtInt(counts.length),
    maxIterationsParam: fmtInt(iterations),
    initialWindow: '1 channel',
    finalWindow: `${fmtInt(iterations)} channels`,
    llsDomain: 'Enabled',
    finalChange: fmtChange(change),
    finalIterationCompleted: `${fmtInt(iterations)} / ${fmtInt(iterations)}`,
    schedule: `Fixed ${fmtInt(iterations)}-pass schedule — no early stopping`,
    continuumReady: 'Yes',
  };
}

// --- per-page derivations -----------------------------------------------------

/** 3.1 LLS Transform: how the log-log-sqrt domain compresses the count dynamic range. */
function deriveLlsPage(inp: ContinuumStatsInput, sample: ChannelSample): ContinuumPageStats {
  const { counts, llsInput } = inp;
  const inLo = amin(counts);
  const inHi = amax(counts);
  const llLo = amin(llsInput);
  const llHi = amax(llsInput);
  const inputDynamicRange = inHi / Math.max(1, inLo);
  const llsDynamicRange = llHi / Math.max(EPS, llLo);
  const compression = inputDynamicRange / Math.max(EPS, llsDynamicRange);
  const rows = sample.channels.map((ch) => [String(ch), fmtCount(counts[ch]), fmtLls(llsInput[ch])]);
  return {
    stats: [
      { label: 'Input range (counts)', value: fmtRange(inLo, inHi, fmtCount) },
      { label: 'LLS range', value: fmtRange(llLo, llHi, fmtLls) },
      { label: 'Input dynamic range', value: fmtRatio(inputDynamicRange) },
      { label: 'LLS dynamic range', value: fmtRatio(llsDynamicRange) },
      { label: 'Compression factor', value: fmtRatio(compression) },
    ],
    sample: { columns: ['Channel', 'Counts', 'LLS value'], rows },
    copy:
      `The log-log-sqrt transform compresses a ${fmtRatio(inputDynamicRange)} count range into a ` +
      `${fmtRatio(llsDynamicRange)} LLS range, so a single SNIP clipping window works across the whole spectrum.`,
    ...(sample.flat ? { note: FLAT_SAMPLE_NOTE } : {}),
  };
}

/** 3.2 SNIP Peak Clipping: how many channels the clip lowered, and to what continuum. */
function deriveSnipPage(inp: ContinuumStatsInput): ContinuumPageStats {
  const { llsInput, llsBackground, background, snipIterations } = inp;
  const n = llsInput.length;
  let pointsModified = 0;
  for (let i = 0; i < n; i++) if (llsBackground[i] < llsInput[i] - EPS) pointsModified++;
  const pctModified = n ? (pointsModified / n) * 100 : 0;
  const bgLo = amin(background);
  const bgHi = amax(background);
  const meanBackground = n ? asum(background) / n : 0;
  return {
    stats: [
      { label: 'SNIP iterations', value: String(snipIterations) },
      { label: 'Points modified', value: fmtInt(pointsModified) },
      { label: '% modified', value: fmtPct(pctModified) },
      { label: 'Background range (counts)', value: fmtRange(bgLo, bgHi, fmtCount) },
      { label: 'Mean background (counts)', value: fmtCount(meanBackground) },
    ],
    copy:
      `SNIP ran ${snipIterations} clipping ${snipIterations === 1 ? 'pass' : 'passes'}, lowering ` +
      `${fmtPct(pctModified)} of channels to the slowly-varying continuum beneath the peaks.`,
  };
}

/** 3.3 Inverse-LLS Transform: the background reconstructed back into counts, <= the input. */
function deriveInvLlsPage(inp: ContinuumStatsInput, sample: ChannelSample): ContinuumPageStats {
  const { counts, background, llsBackground } = inp;
  const n = counts.length;
  let holds = 0;
  let overshoot = 0;
  for (let i = 0; i < n; i++) {
    if (background[i] <= counts[i]) holds++;
    const o = background[i] - counts[i];
    if (o > overshoot) overshoot = o;
  }
  const rows = sample.channels.map((ch) => [
    String(ch),
    fmtLls(llsBackground[ch]),
    fmtCount(background[ch]),
    fmtCount(counts[ch]),
  ]);
  return {
    stats: [
      { label: 'Background ≤ input holds for', value: `${fmtInt(holds)} / ${fmtInt(n)} channels` },
      { label: 'Max overshoot (counts)', value: fmtCount(Math.max(0, overshoot)) },
      { label: 'Background domain', value: 'counts' },
    ],
    sample: { columns: ['Channel', 'LLS background', 'Reconstructed', 'Input'], rows },
    copy: '',
    ...(sample.flat ? { note: FLAT_SAMPLE_NOTE } : {}),
  };
}

/** 3.4 Net Spectrum: how much of the total counts the background subtraction removed. */
function deriveNetPage(inp: ContinuumStatsInput): ContinuumPageStats {
  const { counts, background, net } = inp;
  const n = counts.length;
  const totalBefore = asum(counts);
  const totalAfter = asum(net);
  const removed = totalBefore - totalAfter;
  const pctRemoved = (removed / Math.max(1, totalBefore)) * 100;
  const peakNet = n ? amax(net) : 0;
  let clamped = 0;
  for (let i = 0; i < n; i++) if (counts[i] - background[i] <= 0) clamped++;
  return {
    stats: [
      { label: 'Total counts before', value: fmtCount(totalBefore) },
      { label: 'Total counts after (net)', value: fmtCount(totalAfter) },
      { label: 'Background removed', value: fmtCount(removed) },
      { label: '% removed', value: fmtPct(pctRemoved) },
      { label: 'Peak net signal (counts)', value: fmtCount(peakNet) },
      { label: 'Channels clamped to zero', value: fmtInt(clamped) },
    ],
    copy:
      `Subtracting the background removed ${fmtPct(pctRemoved)} of the total counts as continuum; ` +
      `what remains is the net signal peak detection searches. ${fmtInt(clamped)} ` +
      `${clamped === 1 ? 'channel' : 'channels'} went to zero (background met or exceeded the counts there).`,
  };
}

/**
 * Derive the teaching-page data for one Estimate-Continuum sub-page id. Returns `null` for
 * ids this module does not own (`cont-working`, `cont-sg` -- untouched by this phase) so the
 * caller keeps their existing markup. The LLS + inverse pages share ONE sample of the same
 * five channels (each calls {@link sampleChannels} over the identical `counts`).
 */
export function deriveContinuumPageStats(
  inp: ContinuumStatsInput,
  pageId: string,
): ContinuumPageStats | null {
  switch (pageId) {
    case 'cont-lls':
      return deriveLlsPage(inp, sampleChannels(inp.counts));
    case 'cont-snip':
      return deriveSnipPage(inp);
    case 'cont-invlls':
      return deriveInvLlsPage(inp, sampleChannels(inp.counts));
    case 'cont-net':
      return deriveNetPage(inp);
    default:
      return null;
  }
}
