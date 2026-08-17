import { describe, it, expect } from 'vitest';

import {
  deriveDistanceGateStats,
  resolveRejectionComparison,
  type DistanceCandidate,
  type DistanceGateStatsInput,
} from '../src/ui/peakFinderDistanceStats';
import { detectTraced, DISTANCE } from '../src/pipeline/detect';
import type { ConditionedSpectrum, DetectedPeak, Spectrum } from '../src/domain/types';

import Eu152 from './fixtures/reference/Eu-152.json';

/**
 * peakFinderDistanceStats is the PURE derivation behind the "Distance Gate" teaching stage. It
 * reads ONLY plain data (a channel count + a `{channel, height, passed, rejectedByDistance}`
 * list + the minimum-separation constant + a label), never the engine or a report -- so the
 * synthetic tests construct candidate lists directly and prove the display transforms + the
 * winner reconstruction without running detection.
 *
 * The PARITY block additionally runs the REAL engine (`detectTraced`) on the Eu-152 reference
 * fixture and feeds its `trace.detected.all` into the derivation, proving the reconstruction's
 * five invariants hold against genuine scipy-parity output. The derivation stays pure; only the
 * test touches the engine (to obtain honest input), so the reference fixtures are untouched.
 */

const NA = '—';

function cand(
  channel: number,
  height: number,
  opts: { passed?: boolean; rejectedByDistance?: boolean } = {},
): DistanceCandidate {
  return {
    channel,
    height,
    passed: opts.passed ?? true,
    rejectedByDistance: opts.rejectedByDistance ?? false,
  };
}

function valueOf(
  pairs: readonly { label: string; value: string }[],
  label: string,
): string | undefined {
  return pairs.find((p) => p.label === label)?.value;
}

function input(overrides: Partial<DistanceGateStatsInput> = {}): DistanceGateStatsInput {
  return {
    channels: 4096,
    candidates: [],
    minDistance: 4,
    detectionSpectrumLabel: 'Net Spectrum',
    ...overrides,
  };
}

describe('deriveDistanceGateStats -- summary + impact + statistics cards', () => {
  it('reports the entering / passing / removed counts and the reduction percentage', () => {
    // 5 entering; 2 struck by distance -> 3 pass, 40% reduction.
    const candidates = [
      cand(10, 300),
      cand(12, 100, { passed: false, rejectedByDistance: true }),
      cand(40, 500),
      cand(42, 200, { passed: false, rejectedByDistance: true }),
      cand(80, 400),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(valueOf(s.summary, 'Candidates Entering')).toBe('5');
    expect(valueOf(s.summary, 'Minimum Separation')).toBe('4 channels');
    expect(valueOf(s.impact, 'Entering')).toBe('5');
    expect(valueOf(s.impact, 'Passing Gate')).toBe('3');
    expect(valueOf(s.impact, 'Removed (Too Close)')).toBe('2');
    expect(valueOf(s.impact, 'Reduction')).toBe('40.0%');
    expect(valueOf(s.statistics, 'Accepted')).toBe('3');
    expect(valueOf(s.statistics, 'Rejected')).toBe('2');
    expect(valueOf(s.statistics, 'Accept Rate')).toBe('60.0%');
    expect(valueOf(s.statistics, 'Reject Rate')).toBe('40.0%');
    expect(s.beforeAfter).toEqual({ entering: 5, leaving: 3, removed: 2, reductionPct: 40 });
  });

  it('counts a candidate that failed a LATER gate as a distance-gate survivor', () => {
    // channel 12 cleared distance but later failed prominence -> still "passing" here.
    const candidates = [
      cand(10, 300),
      cand(12, 100, { passed: false, rejectedByDistance: false }),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(valueOf(s.impact, 'Passing Gate')).toBe('2');
    expect(valueOf(s.impact, 'Removed (Too Close)')).toBe('0');
    expect(s.comparisons).toEqual([]);
  });

  it('passes the detection-spectrum label through verbatim to summary + integrity', () => {
    const s = deriveDistanceGateStats(
      input({ detectionSpectrumLabel: 'Savitzky-Golay Smoothed Net' }),
    );
    expect(valueOf(s.summary, 'Detection Spectrum')).toBe('Savitzky-Golay Smoothed Net');
    expect(valueOf(s.integrity, 'Detection Spectrum')).toBe('Savitzky-Golay Smoothed Net');
  });

  it('rounds the enforced minimum up to ceil(distance)', () => {
    const s = deriveDistanceGateStats(input({ minDistance: 3.2 }));
    expect(valueOf(s.summary, 'Minimum Separation')).toBe('4 channels');
  });
});

describe('deriveDistanceGateStats -- winner reconstruction (§7/§8 comparisons)', () => {
  it('maps each rejected candidate to the tallest in-window survivor and its separation', () => {
    // Two survivors at ch 10 (h 300) and ch 40 (h 500); a reject at ch 12 (within 4 of ch 10),
    // and a reject at ch 42 (within 4 of ch 40). minDistance 4 -> window strict < 4.
    const candidates = [
      cand(10, 300),
      cand(12, 100, { passed: false, rejectedByDistance: true }),
      cand(40, 500),
      cand(42, 200, { passed: false, rejectedByDistance: true }),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(s.comparisons).toEqual([
      {
        rejectedChannel: 12,
        rejectedHeight: 100,
        winnerChannel: 10,
        winnerHeight: 300,
        separation: 2,
        minAllowed: 4,
      },
      {
        rejectedChannel: 42,
        rejectedHeight: 200,
        winnerChannel: 40,
        winnerHeight: 500,
        separation: 2,
        minAllowed: 4,
      },
    ]);
  });

  it('picks the TALLER of two in-window survivors as the winner', () => {
    // Reject at ch 12 sits within 4 of BOTH ch 10 (h 250) and ch 14 (h 900); 900 wins.
    const candidates = [
      cand(10, 250),
      cand(12, 100, { passed: false, rejectedByDistance: true }),
      cand(14, 900),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(s.comparisons[0].winnerChannel).toBe(14);
    expect(s.comparisons[0].winnerHeight).toBe(900);
    expect(s.comparisons[0].separation).toBe(2);
  });

  it('breaks a height tie between in-window survivors to the ascending-channel one (documented)', () => {
    // ch 8 and ch 14 both height 500, both within 4 of the reject at ch 11 -> ch 8 wins (lower).
    const candidates = [
      cand(8, 500),
      cand(11, 100, { passed: false, rejectedByDistance: true }),
      cand(14, 500),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(s.comparisons[0].winnerChannel).toBe(8);
  });

  it('emits comparisons in ascending rejected-channel order regardless of input order', () => {
    const candidates = [
      cand(42, 200, { passed: false, rejectedByDistance: true }),
      cand(40, 500),
      cand(10, 300),
      cand(12, 100, { passed: false, rejectedByDistance: true }),
    ];
    const s = deriveDistanceGateStats(input({ candidates }));
    expect(s.comparisons.map((c) => c.rejectedChannel)).toEqual([12, 42]);
  });
});

describe('resolveRejectionComparison', () => {
  const candidates = [
    cand(10, 300),
    cand(12, 100, { passed: false, rejectedByDistance: true }),
    cand(40, 500),
    cand(42, 200, { passed: false, rejectedByDistance: true }),
  ];
  const stats = deriveDistanceGateStats(input({ candidates }));

  it('returns the comparison for a selected rejected candidate', () => {
    expect(resolveRejectionComparison(stats, 42)?.rejectedChannel).toBe(42);
  });

  it('defaults to the first rejected candidate when nothing is selected', () => {
    expect(resolveRejectionComparison(stats, null)?.rejectedChannel).toBe(12);
  });

  it('defaults to the first rejected candidate when a SURVIVOR is selected', () => {
    expect(resolveRejectionComparison(stats, 10)?.rejectedChannel).toBe(12);
  });

  it('returns null when nothing was rejected by the distance gate', () => {
    const none = deriveDistanceGateStats(input({ candidates: [cand(10, 300), cand(40, 500)] }));
    expect(resolveRejectionComparison(none, null)).toBeNull();
  });
});

describe('deriveDistanceGateStats -- edge cases', () => {
  it('no rejections: comparisons empty, reduction 0%, everyone passes', () => {
    const s = deriveDistanceGateStats(input({ candidates: [cand(10, 1), cand(40, 1)] }));
    expect(s.comparisons).toEqual([]);
    expect(valueOf(s.impact, 'Reduction')).toBe('0.0%');
    expect(valueOf(s.statistics, 'Accept Rate')).toBe('100.0%');
    expect(s.beforeAfter).toEqual({ entering: 2, leaving: 2, removed: 0, reductionPct: 0 });
  });

  it('single candidate: passes, no comparison', () => {
    const s = deriveDistanceGateStats(input({ candidates: [cand(512, 777)] }));
    expect(valueOf(s.impact, 'Passing Gate')).toBe('1');
    expect(s.comparisons).toEqual([]);
  });

  it('no candidates at all: guarded percentages become the placeholder, no throw', () => {
    const s = deriveDistanceGateStats(input({ candidates: [] }));
    expect(valueOf(s.impact, 'Entering')).toBe('0');
    expect(valueOf(s.impact, 'Reduction')).toBe(NA);
    expect(valueOf(s.statistics, 'Accept Rate')).toBe(NA);
    expect(valueOf(s.statistics, 'Reject Rate')).toBe(NA);
    expect(s.beforeAfter).toEqual({ entering: 0, leaving: 0, removed: 0, reductionPct: 0 });
  });

  it('channels = 0: integrity channel figure is the placeholder, no divide-by-zero', () => {
    const s = deriveDistanceGateStats(input({ channels: 0, candidates: [cand(1, 1)] }));
    expect(valueOf(s.integrity, 'Channels Scanned')).toBe(NA);
  });
});

// --- PARITY: the reconstruction against REAL engine output on the Eu-152 fixture -------------

interface Fixture {
  source: string;
  counts: number[];
  snip_background: number[];
  net_smoothed: number[];
  peaks: number[];
}

function conditionedFromFixture(f: Fixture): ConditionedSpectrum {
  const counts = f.counts;
  const background = f.snip_background;
  const netCounts = counts.map((c, i) => Math.max(0, c - background[i]));
  const source: Spectrum = {
    counts,
    metadata: {
      fileName: `${f.source}.TKA`,
      format: 'tka',
      liveTimeSec: null,
      realTimeSec: null,
      channelCount: counts.length,
      statedNuclideHint: null,
      fileSizeBytes: null,
      detector: null,
      sampleName: null,
      measurementDate: null,
    },
  };
  return { source, background, netCounts, smoothed: f.net_smoothed };
}

function toCandidate(d: DetectedPeak): DistanceCandidate {
  return {
    channel: d.channel,
    height: d.height,
    passed: d.passed,
    rejectedByDistance: !d.passed && d.rejectReason === 'distance',
  };
}

describe('deriveDistanceGateStats -- winner reconstruction is exact on the Eu-152 fixture', () => {
  const conditioned = conditionedFromFixture(Eu152 as unknown as Fixture);
  const all = detectTraced(conditioned).all;
  const candidates = all.map(toCandidate);
  const minAllowed = Math.ceil(DISTANCE);
  const stats = deriveDistanceGateStats({
    channels: conditioned.source.counts.length,
    candidates,
    minDistance: DISTANCE,
    detectionSpectrumLabel: 'Net Spectrum',
  });

  it('the fixture actually produces distance rejections (non-vacuous guard)', () => {
    expect(candidates.some((c) => c.rejectedByDistance)).toBe(true);
    expect(stats.comparisons.length).toBe(
      candidates.filter((c) => c.rejectedByDistance).length,
    );
  });

  it('every distance-rejected candidate has a reconstructed winner (existence, invariant a)', () => {
    // A comparison is emitted for each rejection; a real winner never collapses to itself.
    for (const c of stats.comparisons) {
      expect(c.winnerChannel).not.toBe(c.rejectedChannel);
    }
  });

  it('the winner is a survivor, taller, and within ceil(distance) (invariants b/c/d)', () => {
    const survivorByChannel = new Map(
      candidates.filter((c) => !c.rejectedByDistance).map((c) => [c.channel, c]),
    );
    for (const cmp of stats.comparisons) {
      expect(survivorByChannel.has(cmp.winnerChannel)).toBe(true); // (b) winner in survivor set
      expect(cmp.winnerHeight).toBeGreaterThan(cmp.rejectedHeight); // (c) strictly taller
      expect(cmp.separation).toBeLessThan(minAllowed); // (d) strict window
    }
  });

  it('the winner is the MAX-height survivor in the rejected candidate window (invariant e)', () => {
    const survivors = candidates.filter((c) => !c.rejectedByDistance);
    for (const cmp of stats.comparisons) {
      const inWindow = survivors.filter(
        (s) => Math.abs(s.channel - cmp.rejectedChannel) < minAllowed,
      );
      const maxHeight = inWindow.reduce((m, s) => Math.max(m, s.height), -Infinity);
      expect(cmp.winnerHeight).toBe(maxHeight);
    }
  });
});
