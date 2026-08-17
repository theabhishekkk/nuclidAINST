import { describe, it, expect } from 'vitest';

import { detectTraced, measurePeak, WINDOW_FACTOR, MIN_HALF_WINDOW } from '../src/pipeline/detect';
import type { ConditionedSpectrum, Spectrum } from '../src/domain/types';

/**
 * #4 -- `strengthSource: 'raw' | 'working'`. Locks the deliberate split: with `'working'`
 * (Peak Finder) the net area + the resolution anchor come from the working series
 * (`conditioned.smoothed` -- the chosen net-or-smoothed-net), while GROSS stays the raw
 * total counts (D-4a) so significance = net / sqrt(gross) keeps a Poisson-correct
 * denominator. The default `'raw'` reproduces the reference behaviour exactly (guarding
 * Calibrate / Identify parity without a full fixture here).
 *
 * The fixture builds a ConditionedSpectrum whose `smoothed` (the working series) differs
 * MEASURABLY from the raw net (`counts - background`), so the two modes must diverge.
 */

function spectrumOf(counts: readonly number[]): Spectrum {
  return {
    counts,
    metadata: {
      fileName: 'synthetic.TKA',
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
}

const N = 41;
const BG = 5;
// Raw net: an isolated peak at channel 20 (magnitude ~50).
const RAW_NET = new Array<number>(N).fill(0);
Object.assign(RAW_NET, { 18: 10, 19: 30, 20: 50, 21: 30, 22: 10 });
const COUNTS = RAW_NET.map((v) => v + BG); // raw total counts
const BACKGROUND = new Array<number>(N).fill(BG);
// Working series (e.g. SG-smoothed net): SAME peak location, DIFFERENT magnitude (~100),
// so `smoothed` != `counts - background` -- the two strength modes must give different nets.
const SMOOTHED = new Array<number>(N).fill(0);
Object.assign(SMOOTHED, { 18: 20, 19: 60, 20: 100, 21: 60, 22: 20 });

const COND: ConditionedSpectrum = {
  source: spectrumOf(COUNTS),
  background: BACKGROUND,
  netCounts: COUNTS.map((c, i) => Math.max(0, c - BACKGROUND[i])),
  smoothed: SMOOTHED,
};

// Relaxed gates so the single peak at ch 20 is guaranteed a survivor.
const OPTS = { prominence: 10, distance: 1, minWidth: 1, relHeight: 0.5 };

/** Python round-half-to-even -- the exact window rule measurePeak uses. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The inclusive integration window measurePeak uses for a peak at `channel` with `fwhm`. */
function windowOf(channel: number, fwhm: number): { lo: number; hi: number } {
  const half = Math.max(pyRound(WINDOW_FACTOR * fwhm), MIN_HALF_WINDOW);
  return { lo: Math.max(channel - half, 0), hi: Math.min(channel + half, N - 1) };
}

function sum(arr: readonly number[], lo: number, hi: number): number {
  let s = 0;
  for (let i = lo; i <= hi; i++) s += arr[i];
  return s;
}

describe('detectTraced -- strengthSource split (#4)', () => {
  it("'working': net area comes from the working series; gross stays raw", () => {
    const { survivors } = detectTraced(COND, OPTS, spectrumOf(COUNTS), 'working');
    expect(survivors).toHaveLength(1);
    const p = survivors[0];
    expect(p.channel).toBe(20);
    const { lo, hi } = windowOf(p.channel, p.fwhmChannels);
    // net area = sum of the WORKING series over the window
    expect(p.netArea).toBeCloseTo(sum(SMOOTHED, lo, hi), 10);
    // gross area = sum of RAW counts over the window (D-4a: gross never moves)
    expect(p.grossArea).toBeCloseTo(sum(COUNTS, lo, hi), 10);
    // significance denominator is the raw gross
    expect(p.significance).toBeCloseTo(p.netArea / Math.sqrt(Math.max(p.grossArea, 1)), 10);
  });

  it("'raw' (default) reproduces the raw-net measurement exactly", () => {
    const raw = spectrumOf(COUNTS);
    const dfl = detectTraced(COND, OPTS, raw).survivors[0]; // default 4th arg = 'raw'
    const explicit = detectTraced(COND, OPTS, raw, 'raw').survivors[0];
    expect(dfl).toEqual(explicit); // omitting the arg == 'raw'

    const { lo, hi } = windowOf(dfl.channel, dfl.fwhmChannels);
    const rawNet = COUNTS.map((c, i) => c - BACKGROUND[i]);
    const expected = measurePeak(dfl.channel, dfl.fwhmChannels, COUNTS, rawNet);
    expect(dfl.netArea).toBeCloseTo(expected.netArea, 10);
    expect(dfl.netArea).toBeCloseTo(sum(rawNet, lo, hi), 10);
    expect(dfl.grossArea).toBeCloseTo(expected.grossArea, 10);
  });

  it('the two modes differ (the working series is not the raw net)', () => {
    const raw = spectrumOf(COUNTS);
    const working = detectTraced(COND, OPTS, raw, 'working').survivors[0];
    const rawMode = detectTraced(COND, OPTS, raw, 'raw').survivors[0];
    // gross identical (proves gross did not move); net differs (proves net moved)
    expect(working.grossArea).toBeCloseTo(rawMode.grossArea, 10);
    expect(working.netArea).not.toBeCloseTo(rawMode.netArea, 5);
  });
});
