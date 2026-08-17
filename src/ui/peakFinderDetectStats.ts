/**
 * peakFinderDetectStats -- data-led derivations behind the "teaching" Detect-Peaks Run
 * stages (starting with the first, "Find Local Maxima" / `local-maxima` / `run-0`).
 *
 * Sibling of {@link module:peakFinderContinuumStats} but for the DETECT half of the flow:
 * where the continuum pages read the manager's continuum arrays, these pages read the
 * already-computed {@link PipelineTrace} (`trace.detected.all` -- every local maximum before
 * any gate) and its {@link DetectedPeak} records. Pure presentation over ALREADY-computed
 * data (Principle 9): every figure here is a count / min / max / mean / median / ratio, or a
 * pure binning of the candidate channel list. Nothing re-runs detection -- there is no call
 * into `findPeaks` / `analyzeSpectrum` from this file, so the committed reference-parity
 * fixtures stay byte-identical. `app.ts` calls this and only RENDERS the returned structures.
 *
 * CHANNEL SPACE ONLY: no energy / keV field is ever read or displayed (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate).
 *
 * Inputs are passed as PLAIN DATA (a channel count + a `{channel, height}` list + the
 * detection-spectrum label the earlier SG/net choice already fixed) -- never a manager or a
 * report -- so the derivations stay pure and unit-testable without constructing either, and
 * cannot perturb the engine or its fixtures.
 */

/** One local-maximum candidate, reduced to the two fields this page reads off a
 * {@link DetectedPeak}: its channel index and its detection-series `height` (the savgol height
 * that the local-maximum test itself compared -- no new computation). */
export interface LocalMaximaCandidate {
  readonly channel: number;
  readonly height: number;
}

/** Plain-data input for {@link deriveLocalMaximaStats}. */
export interface LocalMaximaStatsInput {
  /** `counts.length` -- the number of channels the local-maximum search scanned. */
  readonly channels: number;
  /** Every strict local maximum before any gate (`trace.detected.all`), reduced to
   * `{channel, height}`. Order is not assumed; the derivation sorts where it needs to. */
  readonly candidates: readonly LocalMaximaCandidate[];
  /** The detection series the search ran on -- e.g. "Net Spectrum" / "Smoothed Net Spectrum"
   * -- resolved by the caller from the SG/net choice made earlier in the flow. Shown verbatim. */
  readonly detectionSpectrumLabel: string;
  /** Histogram bin count for the Candidate Distribution (default 24). */
  readonly histogramBins?: number;
  /** Density-curve grid resolution for the Candidate Distribution (default 96). */
  readonly densitySamples?: number;
}

/** One label/value pair for a `.cfg-recap` stat card (value pre-formatted for display). */
export interface LocalMaximaStatPair {
  readonly label: string;
  readonly value: string;
}

/** Equal-width histogram of candidate positions across the channel axis. */
export interface LocalMaximaHistogram {
  /** Width of one bin in channels (0 when there is no channel span to bin over). */
  readonly binWidth: number;
  /** Candidate count in each bin, in channel order (empty when `channels <= 0`). */
  readonly bins: readonly number[];
}

/** A fixed-bandwidth Gaussian kernel-density estimate of candidate positions, sampled on a
 * uniform grid over the channel axis (both empty when `channels <= 0`). */
export interface LocalMaximaDensity {
  /** The x sample positions (channels) the curve is evaluated at. */
  readonly grid: readonly number[];
  /** The density value at each grid point (all 0 when there are no candidates). */
  readonly values: readonly number[];
}

/** The three interchangeable Candidate-Distribution views, all pure transforms of the same
 * candidate channel list -- the app's canvas draws whichever the toggle selects. */
export interface LocalMaximaDistribution {
  /** The channel axis span the views are drawn over (`= channels`). */
  readonly channels: number;
  /** Histogram view (default). */
  readonly histogram: LocalMaximaHistogram;
  /** Channel-map view: the raw candidate channel list, one tick each. */
  readonly positions: readonly number[];
  /** Density view: the KDE curve. */
  readonly density: LocalMaximaDensity;
}

/** Everything the redesigned "Find Local Maxima" stage's cards + distribution need, derived
 * PURELY from {@link LocalMaximaStatsInput}. */
export interface LocalMaximaStats {
  /** Candidate Summary card: scale-of-generation figures. */
  readonly summary: readonly LocalMaximaStatPair[];
  /** Detection Statistics card: objective summary of the candidate height population. */
  readonly statistics: readonly LocalMaximaStatPair[];
  /** Detection Quality card: a small "the stage ran correctly" confidence panel. */
  readonly quality: readonly LocalMaximaStatPair[];
  /** The three Candidate-Distribution views. */
  readonly distribution: LocalMaximaDistribution;
}

/** Placeholder for a statistic that has no value (e.g. no candidates to summarize). */
const NA = '—';

// --- pure array helpers (reduce-based: safe for multi-thousand-element lists, where
//     Math.min(...arr) would risk a call-stack overflow on the argument spread) ----------
const asum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const amin = (a: readonly number[]): number => a.reduce((m, v) => (v < m ? v : m), Infinity);
const amax = (a: readonly number[]): number => a.reduce((m, v) => (v > m ? v : m), -Infinity);
const amean = (a: readonly number[]): number => (a.length ? asum(a) / a.length : 0);

/** Median of a numeric list (mean of the two middle values when the length is even). Returns
 * NaN for an empty list -- callers guard on `length` before formatting. */
function median(a: readonly number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- display formatting -------------------------------------------------------
/** Round to a whole count and group thousands. `en-US` is pinned so the output is
 * locale-stable (the unit tests assert on these exact strings). */
function fmtCount(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** Integer counter (candidates/channels) -- same rounding + grouping as counts. */
function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}

/**
 * Equal-width histogram of the candidate channels over `[0, channels)`.
 *
 * Bin count is the requested `bins` clamped so it never exceeds the channel span (a spectrum
 * with fewer channels than requested bins gets one bin per channel, not empty tail bins). A
 * candidate landing exactly on the top edge folds into the last bin. Returns an all-empty
 * histogram when there is no channel span to bin over.
 */
function buildHistogram(
  channels: number,
  positions: readonly number[],
  bins: number,
): LocalMaximaHistogram {
  if (channels <= 0) return { binWidth: 0, bins: [] };
  const binCount = Math.max(1, Math.min(Math.floor(bins), Math.floor(channels)));
  const binWidth = channels / binCount;
  const out = new Array<number>(binCount).fill(0);
  for (const ch of positions) {
    if (ch < 0 || ch >= channels) continue;
    const idx = Math.min(binCount - 1, Math.floor(ch / binWidth));
    out[idx] += 1;
  }
  return { binWidth, bins: out };
}

/**
 * Fixed-bandwidth Gaussian KDE of the candidate positions, sampled on a uniform grid over
 * `[0, channels]`. The bandwidth scales with the channel span (`channels / 64`, floored at 1)
 * so the curve reads the same regardless of spectrum length. Density is normalized by the
 * candidate count, so the curve integrates to ~1 and comparisons between spectra are fair.
 * All-zero values when there are no candidates; empty grid when there is no channel span.
 */
function buildDensity(
  channels: number,
  positions: readonly number[],
  samples: number,
): LocalMaximaDensity {
  if (channels <= 0) return { grid: [], values: [] };
  const n = Math.max(2, Math.floor(samples));
  const bandwidth = Math.max(1, channels / 64);
  const grid = new Array<number>(n);
  const values = new Array<number>(n).fill(0);
  const step = channels / (n - 1);
  const norm = positions.length
    ? 1 / (positions.length * bandwidth * Math.sqrt(2 * Math.PI))
    : 0;
  for (let j = 0; j < n; j++) {
    const x = j * step;
    grid[j] = x;
    if (!norm) continue;
    let acc = 0;
    for (const ch of positions) {
      const z = (x - ch) / bandwidth;
      acc += Math.exp(-0.5 * z * z);
    }
    values[j] = acc * norm;
  }
  return { grid, values };
}

/**
 * Pure derivation for the "Find Local Maxima" (`local-maxima` / `run-0`) educational stage.
 * Every returned figure is a display transform of the passed-in candidate list + channel
 * count -- no engine call, no fixture touch (Principle 9). See {@link LocalMaximaStats}.
 */
export function deriveLocalMaximaStats(input: LocalMaximaStatsInput): LocalMaximaStats {
  const { channels, candidates, detectionSpectrumLabel } = input;
  const count = candidates.length;
  const heights = candidates.map((c) => c.height);
  const positions = candidates.map((c) => c.channel);

  const summary: LocalMaximaStatPair[] = [
    { label: 'Channels Scanned', value: channels > 0 ? fmtInt(channels) : NA },
    { label: 'Local Maxima Found', value: fmtInt(count) },
    { label: 'Detection Spectrum', value: detectionSpectrumLabel },
    { label: 'Status', value: 'Completed' },
  ];

  // Candidate density = candidates per 1000 channels (1 dp). Guarded against channels = 0.
  const densityPer1000 = channels > 0 ? (1000 * count) / channels : NaN;
  const statistics: LocalMaximaStatPair[] = [
    { label: 'Highest Candidate', value: count ? fmtCount(amax(heights)) : NA },
    { label: 'Lowest Candidate', value: count ? fmtCount(amin(heights)) : NA },
    { label: 'Mean Height', value: count ? fmtCount(amean(heights)) : NA },
    { label: 'Median Height', value: count ? fmtCount(median(heights)) : NA },
    {
      label: 'Candidate Density',
      value: Number.isFinite(densityPer1000) ? `${densityPer1000.toFixed(1)} per 1000 ch` : NA,
    },
  ];

  const quality: LocalMaximaStatPair[] = [
    { label: 'Detection Spectrum', value: detectionSpectrumLabel },
    { label: 'Local-Maximum Search', value: 'Completed' },
    { label: 'Candidate Generation', value: 'Successful' },
  ];

  const distribution: LocalMaximaDistribution = {
    channels,
    histogram: buildHistogram(channels, positions, input.histogramBins ?? 24),
    positions,
    density: buildDensity(channels, positions, input.densitySamples ?? 96),
  };

  return { summary, statistics, quality, distribution };
}
