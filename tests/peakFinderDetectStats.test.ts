import { describe, it, expect } from 'vitest';

import {
  deriveLocalMaximaStats,
  type LocalMaximaCandidate,
  type LocalMaximaStatsInput,
} from '../src/ui/peakFinderDetectStats';

/**
 * peakFinderDetectStats is the PURE derivation behind the "Find Local Maxima" teaching stage.
 * It reads ONLY plain data (a channel count + a `{channel, height}` candidate list + a label),
 * never the engine or a report -- so these tests construct candidate lists directly and prove
 * the display transforms (count / min / max / mean / median / density / binning) without ever
 * running detection. A passing test therefore also proves the file cannot perturb the
 * reference-parity fixtures (Principle 9).
 */

/** The placeholder the derivation emits for an absent statistic (em dash). */
const NA = '—';

function cand(channel: number, height: number): LocalMaximaCandidate {
  return { channel, height };
}

/** Look up a stat pair's value by label from one of the returned card arrays. */
function valueOf(
  pairs: readonly { label: string; value: string }[],
  label: string,
): string | undefined {
  return pairs.find((p) => p.label === label)?.value;
}

function input(overrides: Partial<LocalMaximaStatsInput> = {}): LocalMaximaStatsInput {
  return {
    channels: 4096,
    candidates: [],
    detectionSpectrumLabel: 'Net Spectrum',
    ...overrides,
  };
}

describe('deriveLocalMaximaStats -- summary card', () => {
  it('reports the channel count and candidate count, thousands-grouped', () => {
    const s = deriveLocalMaximaStats(
      input({ candidates: [cand(10, 100), cand(2000, 200), cand(4000, 300)] }),
    );
    expect(valueOf(s.summary, 'Channels Scanned')).toBe('4,096');
    expect(valueOf(s.summary, 'Local Maxima Found')).toBe('3');
    expect(valueOf(s.summary, 'Status')).toBe('Completed');
  });

  it('passes the detection-spectrum label through verbatim to summary + quality', () => {
    const s = deriveLocalMaximaStats(input({ detectionSpectrumLabel: 'Smoothed Net Spectrum' }));
    expect(valueOf(s.summary, 'Detection Spectrum')).toBe('Smoothed Net Spectrum');
    expect(valueOf(s.quality, 'Detection Spectrum')).toBe('Smoothed Net Spectrum');
  });
});

describe('deriveLocalMaximaStats -- detection statistics', () => {
  it('computes highest / lowest / mean / median from candidate heights', () => {
    const s = deriveLocalMaximaStats(
      input({ candidates: [cand(1, 100), cand(2, 200), cand(3, 300)] }),
    );
    expect(valueOf(s.statistics, 'Highest Candidate')).toBe('300');
    expect(valueOf(s.statistics, 'Lowest Candidate')).toBe('100');
    expect(valueOf(s.statistics, 'Mean Height')).toBe('200');
    expect(valueOf(s.statistics, 'Median Height')).toBe('200');
  });

  it('averages the two middle heights for an even-length list (median)', () => {
    const s = deriveLocalMaximaStats(
      input({ candidates: [cand(1, 10), cand(2, 20), cand(3, 30), cand(4, 40)] }),
    );
    // sorted [10,20,30,40] -> median = (20+30)/2 = 25
    expect(valueOf(s.statistics, 'Median Height')).toBe('25');
  });

  it('reports candidate density as candidates per 1000 channels (1 dp)', () => {
    const s = deriveLocalMaximaStats(
      input({ channels: 4096, candidates: [cand(1, 1), cand(2, 1), cand(3, 1)] }),
    );
    // 1000 * 3 / 4096 = 0.732... -> "0.7 per 1000 ch"
    expect(valueOf(s.statistics, 'Candidate Density')).toBe('0.7 per 1000 ch');
  });
});

describe('deriveLocalMaximaStats -- distribution', () => {
  it('builds a histogram whose bins sum to the candidate count', () => {
    const candidates = [cand(0, 5), cand(100, 5), cand(2048, 5), cand(4095, 5)];
    const s = deriveLocalMaximaStats(input({ channels: 4096, candidates }));
    expect(s.distribution.histogram.bins.length).toBe(24);
    const total = s.distribution.histogram.bins.reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
    expect(s.distribution.histogram.binWidth).toBeCloseTo(4096 / 24, 6);
  });

  it('folds a candidate on the top edge into the last bin (no out-of-range bin)', () => {
    const s = deriveLocalMaximaStats(input({ channels: 100, candidates: [cand(99, 1)] }));
    const bins = s.distribution.histogram.bins;
    expect(bins.reduce((a, b) => a + b, 0)).toBe(1);
    expect(bins[bins.length - 1]).toBe(1);
  });

  it('preserves the raw channel positions for the channel-map view', () => {
    const s = deriveLocalMaximaStats(
      input({ candidates: [cand(7, 1), cand(42, 1), cand(1000, 1)] }),
    );
    expect(s.distribution.positions).toEqual([7, 42, 1000]);
  });

  it('emits a non-negative density curve on the requested grid, peaking near a cluster', () => {
    const candidates = Array.from({ length: 20 }, (_, i) => cand(2000 + i, 1));
    const s = deriveLocalMaximaStats(input({ channels: 4096, candidates, densitySamples: 96 }));
    const { grid, values } = s.distribution.density;
    expect(grid.length).toBe(96);
    expect(values.length).toBe(96);
    expect(grid[0]).toBe(0);
    expect(grid[grid.length - 1]).toBeCloseTo(4096, 6);
    expect(values.every((v) => v >= 0)).toBe(true);
    // The peak of the curve should sit near the 2000-channel cluster, not the edges.
    let peakIdx = 0;
    for (let j = 1; j < values.length; j++) if (values[j] > values[peakIdx]) peakIdx = j;
    expect(grid[peakIdx]).toBeGreaterThan(1500);
    expect(grid[peakIdx]).toBeLessThan(2500);
  });
});

describe('deriveLocalMaximaStats -- edge cases', () => {
  it('zero candidates: stats are placeholders, density is 0, histogram is empty of counts', () => {
    const s = deriveLocalMaximaStats(input({ channels: 1000, candidates: [] }));
    expect(valueOf(s.summary, 'Local Maxima Found')).toBe('0');
    expect(valueOf(s.statistics, 'Highest Candidate')).toBe(NA);
    expect(valueOf(s.statistics, 'Lowest Candidate')).toBe(NA);
    expect(valueOf(s.statistics, 'Mean Height')).toBe(NA);
    expect(valueOf(s.statistics, 'Median Height')).toBe(NA);
    // density with 0 candidates is still a well-defined 0.0 (not a placeholder)
    expect(valueOf(s.statistics, 'Candidate Density')).toBe('0.0 per 1000 ch');
    expect(s.distribution.positions).toEqual([]);
    expect(s.distribution.histogram.bins.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.distribution.density.values.every((v) => v === 0)).toBe(true);
  });

  it('single candidate: mean == median == its height, density is finite', () => {
    const s = deriveLocalMaximaStats(input({ candidates: [cand(512, 777)] }));
    expect(valueOf(s.statistics, 'Highest Candidate')).toBe('777');
    expect(valueOf(s.statistics, 'Lowest Candidate')).toBe('777');
    expect(valueOf(s.statistics, 'Mean Height')).toBe('777');
    expect(valueOf(s.statistics, 'Median Height')).toBe('777');
    expect(s.distribution.density.values.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('all-equal heights: mean, median, highest, lowest collapse to that height', () => {
    const s = deriveLocalMaximaStats(
      input({ candidates: [cand(1, 500), cand(2, 500), cand(3, 500), cand(4, 500)] }),
    );
    expect(valueOf(s.statistics, 'Highest Candidate')).toBe('500');
    expect(valueOf(s.statistics, 'Lowest Candidate')).toBe('500');
    expect(valueOf(s.statistics, 'Mean Height')).toBe('500');
    expect(valueOf(s.statistics, 'Median Height')).toBe('500');
  });

  it('channels = 0: no divide-by-zero -- density placeholder + empty distribution', () => {
    const s = deriveLocalMaximaStats(input({ channels: 0, candidates: [] }));
    expect(valueOf(s.summary, 'Channels Scanned')).toBe(NA);
    expect(valueOf(s.statistics, 'Candidate Density')).toBe(NA);
    expect(s.distribution.histogram.bins).toEqual([]);
    expect(s.distribution.histogram.binWidth).toBe(0);
    expect(s.distribution.density.grid).toEqual([]);
    expect(s.distribution.density.values).toEqual([]);
  });
});
