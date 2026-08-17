import { describe, it, expect } from 'vitest';

import {
  sampleChannels,
  deriveContinuumPageStats,
  deriveWorkingCopyStats,
  deriveLlsTransformStats,
  deriveInverseLlsStats,
  deriveNetSpectrumStats,
  deriveSnipClipStats,
  deriveSnipProgress,
  FLAT_SAMPLE_NOTE,
  type ContinuumStatsInput,
  type SnipClipInput,
} from '../src/ui/peakFinderContinuumStats';
import {
  estimateContinuum,
  estimateBackgroundTraced,
  lls,
  invLls,
  SNIP_DEFAULT_ITERATIONS,
} from '../src/pipeline/condition';
import { load } from '../src/pipeline/load';
import { syntheticTka } from '../src/data/synthetic';

/**
 * peakFinderContinuumStats (#5) is the PURE derivation behind the four data-led
 * Estimate-Continuum teaching pages. These tests prove the DoD "number parity" gate: every
 * figure the page shows equals the engine field it claims -- so the pages can never quietly
 * drift from the numbers detection actually ran on. The input is built the SAME way the
 * manager builds it (estimateContinuum on the selected input; llsInput/llsBackground via
 * `lls`), so a passing test means the displayed value == the manager value.
 */

/** Build the module input exactly as the manager exposes it, from the real engine. */
function realInput(): ContinuumStatsInput {
  const spec = load({ text: syntheticTka(), fileName: 'synthetic-demo.tka' });
  const counts = spec.counts;
  const { background, net } = estimateContinuum(spec);
  return {
    counts,
    background,
    net,
    llsInput: counts.map(lls),
    llsBackground: background.map(lls),
    snipIterations: SNIP_DEFAULT_ITERATIONS,
  };
}

const sum = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0);
const statValue = (
  page: NonNullable<ReturnType<typeof deriveContinuumPageStats>>,
  label: string,
): string => {
  const found = page.stats.find((s) => s.label === label);
  if (!found) throw new Error(`no stat labelled "${label}"`);
  return found.value;
};

describe('sampleChannels (representative-channel sampling, Option A)', () => {
  it('returns 5 DISTINCT channels for a normal spectrum, flagged non-flat', () => {
    const { counts } = realInput();
    const { channels, flat } = sampleChannels(counts);
    expect(flat).toBe(false);
    expect(channels).toHaveLength(5);
    expect(new Set(channels).size).toBe(5);
  });

  it('picks the min-count channel first and the max-count channel last', () => {
    // counts by index: 0:5 1:1 2:9 3:3 4:7 5:2 6:8 -> min at ch1, max at ch2.
    const { channels } = sampleChannels([5, 1, 9, 3, 7, 2, 8]);
    expect(channels[0]).toBe(1); // min counts
    expect(channels[4]).toBe(2); // max counts
    expect(new Set(channels).size).toBe(5);
  });

  it('breaks count ties to the LOWEST channel index', () => {
    // min value 1 appears at ch1 and ch2 -> the sampler must take the lower index.
    const { channels } = sampleChannels([2, 1, 1, 3, 4, 5, 9]);
    expect(channels[0]).toBe(1);
  });

  it('falls back to the first N channels for an all-equal (flat) spectrum', () => {
    const { channels, flat } = sampleChannels(new Array(10).fill(7));
    expect(flat).toBe(true);
    expect(channels).toEqual([0, 1, 2, 3, 4]);
  });

  it('falls back for n < 5 without crashing', () => {
    const { channels, flat } = sampleChannels([3, 1, 2]);
    expect(flat).toBe(true);
    expect(channels).toEqual([0, 1, 2]);
  });
});

describe('deriveContinuumPageStats -- ownership', () => {
  it('owns only the four teaching pages; cont-working / cont-sg return null', () => {
    const inp = realInput();
    expect(deriveContinuumPageStats(inp, 'cont-working')).toBeNull();
    expect(deriveContinuumPageStats(inp, 'cont-sg')).toBeNull();
    expect(deriveContinuumPageStats(inp, 'cont-lls')).not.toBeNull();
    expect(deriveContinuumPageStats(inp, 'cont-snip')).not.toBeNull();
    expect(deriveContinuumPageStats(inp, 'cont-invlls')).not.toBeNull();
    expect(deriveContinuumPageStats(inp, 'cont-net')).not.toBeNull();
  });
});

describe('cont-net -- number parity with the engine net', () => {
  it('displays sum(counts), sum(net) and their difference verbatim', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-net')!;
    const before = Math.round(sum(inp.counts)).toLocaleString('en-US');
    const after = Math.round(sum(inp.net)).toLocaleString('en-US');
    const removed = Math.round(sum(inp.counts) - sum(inp.net)).toLocaleString('en-US');
    expect(statValue(page, 'Total counts before')).toBe(before);
    expect(statValue(page, 'Total counts after (net)')).toBe(after);
    expect(statValue(page, 'Background removed')).toBe(removed);
  });

  it('the clamped-to-zero count equals the channels where the engine net is 0', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-net')!;
    const clamped = inp.counts.filter((c, i) => c - inp.background[i] <= 0).length;
    expect(statValue(page, 'Channels clamped to zero')).toBe(clamped.toLocaleString('en-US'));
  });
});

describe('cont-snip -- iteration single-sourcing + clip accounting', () => {
  it('reports the effective SNIP iteration count from the manager field (never a literal)', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-snip')!;
    expect(statValue(page, 'SNIP iterations')).toBe(String(inp.snipIterations));
    expect(statValue(page, 'SNIP iterations')).toBe(String(SNIP_DEFAULT_ITERATIONS));
  });

  it('counts the channels the clip actually lowered in the LLS domain', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-snip')!;
    const modified = inp.llsInput.filter((v, i) => inp.llsBackground[i] < v - 1e-9).length;
    expect(statValue(page, 'Points modified')).toBe(modified.toLocaleString('en-US'));
    expect(modified).toBeGreaterThan(0); // a spectrum with peaks always clips somewhere
  });
});

describe('cont-lls -- sample rows track the LLS transform of the sampled channels', () => {
  it('each sample row shows counts[ch] and lls(counts[ch]) for the shared 5 channels', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-lls')!;
    const { channels } = sampleChannels(inp.counts);
    expect(page.sample).toBeDefined();
    expect(page.sample!.rows).toHaveLength(channels.length);
    channels.forEach((ch, r) => {
      const row = page.sample!.rows[r];
      expect(row[0]).toBe(String(ch));
      expect(row[1]).toBe(Math.round(inp.counts[ch]).toLocaleString('en-US'));
      expect(row[2]).toBe(lls(inp.counts[ch]).toFixed(3));
    });
  });
});

describe('cont-invlls -- the reconstruction identity is the lesson', () => {
  it('background[ch] ~= invLls(llsBackground[ch]) for every sampled channel (within the >=0 clamp)', () => {
    const inp = realInput();
    const { channels } = sampleChannels(inp.counts);
    for (const ch of channels) {
      const reconstructed = invLls(inp.llsBackground[ch]);
      // Round-trip through exp/log carries a tiny numerical error; scale the tolerance to
      // the magnitude of the value being reconstructed.
      expect(Math.abs(inp.background[ch] - reconstructed)).toBeLessThan(1e-6 * (inp.background[ch] + 1));
    }
  });

  it('the sample table Reconstructed + Input cells are the engine background + counts', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-invlls')!;
    const { channels } = sampleChannels(inp.counts);
    channels.forEach((ch, r) => {
      const row = page.sample!.rows[r];
      expect(row[2]).toBe(Math.round(inp.background[ch]).toLocaleString('en-US')); // Reconstructed
      expect(row[3]).toBe(Math.round(inp.counts[ch]).toLocaleString('en-US')); // Input
    });
  });

  it('background <= input holds for (nearly) every channel', () => {
    const inp = realInput();
    const page = deriveContinuumPageStats(inp, 'cont-invlls')!;
    const holds = inp.background.filter((b, i) => b <= inp.counts[i]).length;
    expect(statValue(page, 'Background ≤ input holds for')).toBe(
      `${holds.toLocaleString('en-US')} / ${inp.counts.length.toLocaleString('en-US')} channels`,
    );
  });
});

describe('flat-spectrum fallback surfaces the honest note', () => {
  it('cont-lls on an all-equal spectrum carries FLAT_SAMPLE_NOTE', () => {
    const counts = new Array(8).fill(4);
    const background = new Array(8).fill(0);
    const net = new Array(8).fill(4);
    const inp: ContinuumStatsInput = {
      counts,
      background,
      net,
      llsInput: counts.map(lls),
      llsBackground: background.map(lls),
      snipIterations: SNIP_DEFAULT_ITERATIONS,
    };
    const page = deriveContinuumPageStats(inp, 'cont-lls')!;
    expect(page.note).toBe(FLAT_SAMPLE_NOTE);
  });
});

describe('deriveLlsTransformStats -- the LLS Transform stage summary/statistics figures', () => {
  const grp = (v: number): string => Math.round(v).toLocaleString('en-US');
  const f3 = (v: number): string => v.toFixed(3);
  const mean = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: readonly number[]): number => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };

  it('reports before/after maxima and the before/after Min/Max/Mean/StdDev table (with grouping)', () => {
    // A large-count case exercises the thousands-grouping path for every "before" cell.
    const counts = [0, 100, 10_000, 1_000_000];
    const llsInput = counts.map(lls);
    const s = deriveLlsTransformStats(counts, llsInput);
    // Summary maxima: counts thousands-grouped, LLS to 3 dp (max is monotonic under lls).
    expect(s.maxBefore).toBe('1,000,000');
    expect(s.maxAfter).toBe(f3(Math.max(...llsInput)));
    // Before column -- counts, rounded + thousands-grouped.
    expect(s.table.min.before).toBe('0');
    expect(s.table.max.before).toBe('1,000,000');
    expect(s.table.mean.before).toBe(grp(mean(counts)));
    expect(s.table.stddev.before).toBe(grp(std(counts)));
    // After column -- LLS domain, 3 decimals.
    expect(s.table.min.after).toBe(f3(Math.min(...llsInput)));
    expect(s.table.max.after).toBe(f3(Math.max(...llsInput)));
    expect(s.table.mean.after).toBe(f3(mean(llsInput)));
    expect(s.table.stddev.after).toBe(f3(std(llsInput)));
  });

  it('computes the compression ratio as input-dynamic-range / LLS-dynamic-range', () => {
    const counts = [1, 10, 100, 1000, 100_000];
    const llsInput = counts.map(lls);
    const s = deriveLlsTransformStats(counts, llsInput);
    const inHi = Math.max(...counts);
    const inLo = Math.min(...counts);
    const llHi = Math.max(...llsInput);
    const llLo = Math.min(...llsInput);
    const inputDR = inHi / Math.max(1, inLo);
    const llsDR = llHi / Math.max(1e-9, llLo);
    expect(s.dynamicRangeBefore).toBe(`${inputDR.toFixed(1)}×`);
    expect(s.dynamicRangeAfter).toBe(`${llsDR.toFixed(1)}×`);
    expect(s.compressionRatio).toBe(`${(inputDR / Math.max(1e-9, llsDR)).toFixed(1)}×`);
  });

  it('drives the length + negatives reassurance honestly on a representative LLS array', () => {
    const counts = [5, 50, 500, 5000, 50_000];
    const llsInput = counts.map(lls);
    const s = deriveLlsTransformStats(counts, llsInput);
    expect(s.lengthUnchanged).toBe(true); // per-channel transform never changes length
    expect(s.negativesIntroduced).toBe(false); // the +1 offsets keep LLS non-negative
    expect(s.status).toBe('Applied');
  });

  it('flags a length mismatch defensively (a truncated transform is not silently "Unchanged")', () => {
    const s = deriveLlsTransformStats([1, 2, 3], [lls(1), lls(2)]);
    expect(s.lengthUnchanged).toBe(false);
  });
});

describe('deriveInverseLlsStats -- the Inverse LLS Transform stage summary/statistics figures', () => {
  const grp = (v: number): string => Math.round(v).toLocaleString('en-US');
  const f3 = (v: number): string => v.toFixed(3);
  const mean = (a: readonly number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

  it('reports counts-domain min/max/mean (thousands-grouped) and the LLS-domain max (3 dp)', () => {
    // A large-count case exercises the thousands-grouping path for every counts cell.
    const background = [0, 250, 12_500, 1_250_000];
    const llsBackground = background.map(lls);
    const s = deriveInverseLlsStats(background, llsBackground);
    expect(s.minCounts).toBe('0');
    expect(s.maxCounts).toBe('1,250,000');
    expect(s.meanCounts).toBe(grp(mean(background)));
    // maxAfter is the restored counts-domain max (== maxCounts); maxBefore is the LLS-domain max.
    expect(s.maxAfter).toBe('1,250,000');
    expect(s.maxBefore).toBe(f3(Math.max(...llsBackground)));
  });

  it('computes the background dynamic range as maxCounts / max(1, minCounts)', () => {
    const background = [2, 20, 200, 2000, 40_000];
    const s = deriveInverseLlsStats(background, background.map(lls));
    const hi = Math.max(...background);
    const lo = Math.min(...background);
    expect(s.dynamicRange).toBe(`${(hi / Math.max(1, lo)).toFixed(1)}×`);
  });

  it('guards a zero minimum in the dynamic range (the max(1, min) denominator)', () => {
    const background = [0, 0, 500, 5000];
    const s = deriveInverseLlsStats(background, background.map(lls));
    // min is 0 -> denominator clamps to 1 -> the ratio is just the max counts.
    expect(s.dynamicRange).toBe(`${(5000).toFixed(1)}×`);
  });

  it('emits the static representation/status/ready strings and an honest length flag', () => {
    const background = [10, 100, 1000, 10_000];
    const s = deriveInverseLlsStats(background, background.map(lls));
    expect(s.inputRepresentation).toBe('LLS Space');
    expect(s.outputRepresentation).toBe('Detector Counts');
    expect(s.status).toBe('Applied');
    expect(s.readyForSubtraction).toBe('Yes');
    expect(s.lengthUnchanged).toBe(true); // equal-length per-channel inverse
  });

  it('flags a length mismatch defensively (a truncated inverse is not silently "Unchanged")', () => {
    const s = deriveInverseLlsStats([1, 2, 3], [lls(1), lls(2)]);
    expect(s.lengthUnchanged).toBe(false);
  });
});

describe('deriveNetSpectrumStats -- the Net Spectrum stage subtraction/statistics figures', () => {
  const grp = (v: number): string => Math.round(v).toLocaleString('en-US');
  const amin = (a: readonly number[]): number => a.reduce((m, v) => (v < m ? v : m), Infinity);
  const amax = (a: readonly number[]): number => a.reduce((m, v) => (v > m ? v : m), -Infinity);
  const mean = (a: readonly number[]): number => sum(a) / a.length;

  it('formats the subtraction totals + fractions (no clamp: raw = background + net exactly)', () => {
    const counts = [100, 200, 300, 400];
    const background = [10, 20, 30, 40];
    const net = counts.map((c, i) => Math.max(0, c - background[i])); // [90,180,270,360]
    const s = deriveNetSpectrumStats(counts, background, net);
    expect(s.totalRawCounts).toBe('1,000');
    expect(s.totalBackgroundCounts).toBe('100');
    expect(s.totalNetCounts).toBe('900');
    // No channel clamped, so Σraw === Σbackground + Σnet.
    expect(sum(counts)).toBe(sum(background) + sum(net));
    expect(s.backgroundFraction).toBe('10.0%');
    expect(s.netFraction).toBe('90.0%');
    expect(s.backgroundRemoved).toBe('10.0%');
    expect(s.clampedCount).toBe('0');
    expect(s.lengthUnchanged).toBe(true);
  });

  it('reports the net min/max/mean (thousands-grouped) over the engine-clamped net', () => {
    const counts = [500, 5, 40_000, 1_250_000];
    const background = [50, 20, 4000, 125_000];
    // Engine-clamped net: channel 1 (5 − 20) goes to zero.
    const net = counts.map((c, i) => Math.max(0, c - background[i])); // [450,0,36000,1125000]
    const s = deriveNetSpectrumStats(counts, background, net);
    expect(s.minNet).toBe('0');
    expect(s.maxNet).toBe('1,125,000');
    expect(s.meanNet).toBe(grp(mean(net)));
  });

  it('counts every channel where the background meets or exceeds the counts (clamped to zero)', () => {
    // Channels 1 (5 ≤ 20) and 3 (30 = 30) both clamp; channels 0 and 2 do not.
    const counts = [100, 5, 300, 30];
    const background = [10, 20, 30, 30];
    const net = counts.map((c, i) => Math.max(0, c - background[i]));
    const s = deriveNetSpectrumStats(counts, background, net);
    expect(s.clampedCount).toBe('2');
  });

  it('guards a zero-total spectrum against divide-by-zero (max(1, Σraw) denominator)', () => {
    const s = deriveNetSpectrumStats([0, 0, 0], [0, 0, 0], [0, 0, 0]);
    expect(s.backgroundFraction).toBe('0.0%');
    expect(s.netFraction).toBe('0.0%');
    expect(s.backgroundRemoved).toBe('0.0%');
    expect(s.clampedCount).toBe('3'); // 0 − 0 = 0 ≤ 0 at every channel
  });

  it('flags a length mismatch defensively (a truncated net is not silently "Unchanged")', () => {
    const s = deriveNetSpectrumStats([1, 2, 3], [0, 0, 0], [1, 2]);
    expect(s.lengthUnchanged).toBe(false);
  });

  it('matches the real engine net: parity of totals, min/max/mean, clamp count, and reconciliation', () => {
    const inp = realInput();
    const { counts, background, net } = inp;
    const s = deriveNetSpectrumStats(counts, background, net);
    // Formatted totals equal the summed arrays.
    expect(s.totalRawCounts).toBe(grp(sum(counts)));
    expect(s.totalBackgroundCounts).toBe(grp(sum(background)));
    expect(s.totalNetCounts).toBe(grp(sum(net)));
    // Net stats track the engine net exactly.
    expect(s.minNet).toBe(grp(amin(net)));
    expect(s.maxNet).toBe(grp(amax(net)));
    expect(s.meanNet).toBe(grp(mean(net)));
    // Clamp count is the number of channels the engine drove to zero.
    let clamped = 0;
    for (let i = 0; i < counts.length; i++) if (counts[i] - background[i] <= 0) clamped++;
    expect(s.clampedCount).toBe(clamped.toLocaleString('en-US'));
    // Removed = raw − net, and it can never exceed the total background (clamping only removes counts).
    const removed = sum(counts) - sum(net);
    expect(removed).toBeGreaterThanOrEqual(0);
    expect(removed).toBeLessThanOrEqual(sum(background) + 1e-6);
    // Net% + Removed% reconcile to 100 within 1-dp rounding.
    expect(Math.abs(parseFloat(s.netFraction) + parseFloat(s.backgroundRemoved) - 100)).toBeLessThanOrEqual(0.1);
    // Sanity: the untouched parity stat page (deriveNetPage) agrees on the clamp count.
    expect(statValue(deriveContinuumPageStats(inp, 'cont-net')!, 'Channels clamped to zero')).toBe(
      clamped.toLocaleString('en-US'),
    );
  });
});

describe('deriveWorkingCopyStats -- the Working Copy stage source figures', () => {
  it('labels a raw input "Raw Spectrum" and reports channels + total counts', () => {
    const stats = deriveWorkingCopyStats([10, 20, 30, 40], 'raw');
    expect(stats.sourceLabel).toBe('Raw Spectrum');
    expect(stats.channels).toBe('4');
    expect(stats.totalCounts).toBe('100');
  });

  it('labels a smoothed input "Savitzky–Golay Smoothed Spectrum"', () => {
    const stats = deriveWorkingCopyStats([1, 2, 3], 'smoothed');
    expect(stats.sourceLabel).toBe('Savitzky–Golay Smoothed Spectrum');
    expect(stats.channels).toBe('3');
    expect(stats.totalCounts).toBe('6');
  });

  it('rounds fractional (smoothed) counts and groups thousands in the total', () => {
    // 8192 channels, each 100.4 counts -> Σ = 822,476.8 -> rounds to 822,477.
    const counts = new Array(8192).fill(100.4);
    const stats = deriveWorkingCopyStats(counts, 'smoothed');
    expect(stats.channels).toBe('8,192');
    expect(stats.totalCounts).toBe('822,477');
  });

  it('a large raw spectrum groups both the channel count and the total', () => {
    // 16,384 channels each holding 1,000 counts -> 16,384,000 total.
    const counts = new Array(16384).fill(1000);
    const stats = deriveWorkingCopyStats(counts, 'raw');
    expect(stats.channels).toBe('16,384');
    expect(stats.totalCounts).toBe('16,384,000');
  });
});

// --- SNIP Peak Clipping stage (deriveSnipProgress / deriveSnipClipStats) --------------------

/** Build the SNIP derivation input exactly as the manager exposes it: estimateContinuum for the
 * committed background, `lls` for the LLS-domain arrays, and a real traced clip for the change
 * series -- so a passing test means the page value == the manager value. */
function realSnipInput(): { inp: SnipClipInput; llsInput: number[]; llsBackground: number[] } {
  const spec = load({ text: syntheticTka(), fileName: 'synthetic-demo.tka' });
  const counts = spec.counts;
  const { background } = estimateContinuum(spec);
  const llsInput = counts.map(lls);
  const llsBackground = background.map(lls);
  const trace = estimateBackgroundTraced(counts, SNIP_DEFAULT_ITERATIONS, [
    1, 5, 10, 20, SNIP_DEFAULT_ITERATIONS,
  ]);
  return {
    inp: {
      counts,
      background,
      llsInput,
      llsBackground,
      iterations: trace.iterations,
      changeSeries: trace.changeSeries,
    },
    llsInput,
    llsBackground,
  };
}

describe('deriveSnipProgress (dynamic clipping-progress figures)', () => {
  const N = SNIP_DEFAULT_ITERATIONS;

  it('reads "Completed" at the final checkpoint with the full window', () => {
    const p = deriveSnipProgress(N, N);
    expect(p.currentIteration).toBe('45');
    expect(p.totalIterations).toBe('45');
    expect(p.currentWindow).toBe('45 channels');
    expect(p.maxWindow).toBe('45 channels');
    expect(p.status).toBe('Completed');
  });

  it('reads "Iteration k of N" mid-clip and singularises a 1-channel window', () => {
    const p = deriveSnipProgress(N, 1);
    expect(p.currentIteration).toBe('1');
    expect(p.currentWindow).toBe('1 channel');
    expect(p.status).toBe('Iteration 1 of 45');
  });

  it('groups thousands in a large-iteration window string', () => {
    const p = deriveSnipProgress(2000, 1500);
    expect(p.currentWindow).toBe('1,500 channels');
    expect(p.maxWindow).toBe('2,000 channels');
    expect(p.status).toBe('Iteration 1,500 of 2,000');
  });
});

describe('deriveSnipClipStats (SNIP page card figures)', () => {
  const EPS = 1e-9;

  it('reports Channels Clipped / % Clipped as the real llsInput-vs-llsBackground count', () => {
    const { inp, llsInput, llsBackground } = realSnipInput();
    let clipped = 0;
    for (let i = 0; i < llsInput.length; i++)
      if (llsBackground[i] < llsInput[i] - EPS) clipped++;
    const s = deriveSnipClipStats(inp, inp.iterations);
    expect(s.channelsClipped).toBe(clipped.toLocaleString('en-US'));
    const pct = (clipped / llsInput.length) * 100;
    expect(s.pctClipped).toBe(`${pct.toFixed(1)}%`);
  });

  it('seeds ① at the final selection and reports the structural parameters honestly', () => {
    const { inp } = realSnipInput();
    const s = deriveSnipClipStats(inp, inp.iterations);
    expect(s.progress.status).toBe('Completed');
    expect(s.maxIterationsParam).toBe('45');
    expect(s.initialWindow).toBe('1 channel');
    expect(s.finalWindow).toBe('45 channels');
    expect(s.llsDomain).toBe('Enabled');
    expect(s.finalIterationCompleted).toBe('45 / 45');
    expect(s.schedule).toBe('Fixed 45-pass schedule — no early stopping');
    expect(s.continuumReady).toBe('Yes');
  });

  it('continuum summary reads the committed background (counts domain), thousands-grouped', () => {
    const { inp } = realSnipInput();
    const s = deriveSnipClipStats(inp, inp.iterations);
    const bg = inp.background;
    const min = Math.round(Math.min(...bg)).toLocaleString('en-US');
    const max = Math.round(Math.max(...bg)).toLocaleString('en-US');
    expect(s.minContinuum).toBe(min);
    expect(s.maxContinuum).toBe(max);
    expect(s.channelsProcessed).toBe(inp.counts.length.toLocaleString('en-US'));
    expect(s.dynamicRange).toMatch(/×$/);
  });

  it('gives an honest final-change convergence figure with a plain-language stability band', () => {
    // A synthetic change series whose final entry is tiny -> scientific notation + "High" band.
    const inp: SnipClipInput = {
      counts: [10, 20, 30],
      background: [1, 2, 3],
      llsInput: [1, 2, 3].map(lls),
      llsBackground: [0.5, 1, 1.5].map(lls),
      iterations: 45,
      changeSeries: [0.5, 0.1, 0.00031],
    };
    const s = deriveSnipClipStats(inp, 45);
    expect(s.finalChange).toBe('3.1e-4');
    expect(s.continuumStability).toBe('High (Δ 3.1e-4)');
  });

  it('bands a larger final change as Moderate / Low and never hides the number', () => {
    const base: SnipClipInput = {
      counts: [10, 20, 30],
      background: [1, 2, 3],
      llsInput: [1, 2, 3].map(lls),
      llsBackground: [0.5, 1, 1.5].map(lls),
      iterations: 45,
      changeSeries: [0.5],
    };
    const moderate = deriveSnipClipStats({ ...base, changeSeries: [0.005] }, 45);
    expect(moderate.continuumStability).toBe('Moderate (Δ 0.0050)');
    const low = deriveSnipClipStats({ ...base, changeSeries: [0.2] }, 45);
    expect(low.continuumStability).toBe('Low (Δ 0.2000)');
  });
});
