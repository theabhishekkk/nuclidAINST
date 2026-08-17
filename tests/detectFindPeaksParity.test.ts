import { describe, it, expect } from 'vitest';
import {
  detectTraced,
  PROMINENCE,
  DISTANCE,
  MIN_WIDTH,
  REL_HEIGHT,
} from '../src/pipeline/detect';
import { findPeaks } from '../src/signal';
import type { ConditionedSpectrum, Spectrum } from '../src/domain/types';

import Cs137 from './fixtures/reference/Cs-137.json';

/**
 * DEBT-26 parity guard. `detectTraced` deliberately re-derives the scipy
 * `find_peaks` composition inline (localMaxima1d -> selectByPeakDistance ->
 * peakProminences -> peakWidths) so it can tag every local maximum with its
 * first-failing gate. `src/signal/findPeaks.ts` remains the REFERENCE composition;
 * nothing else cross-checks the two, so they could drift silently.
 *
 * This test pins the divergence: the survivor set `detectTraced` keeps, and every
 * survivor property it measures (fwhm / sub-channel ips / prominence), must be
 * EXACTLY what `findPeaks` returns for the same conditioned series and the same
 * gate settings. Exact equality is expected -- same primitives, same inputs -- so
 * these use strict `toEqual`/`toBe`; if that ever fails it is a real drift to flag,
 * not something to loosen to an approximate tolerance.
 */

interface Fixture {
  source: string;
  counts: number[];
  snip_background: number[];
  net_smoothed: number[];
  peaks: number[];
}

function spectrumOf(counts: readonly number[], fileName: string): Spectrum {
  return {
    counts,
    metadata: {
      fileName,
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

/** ConditionedSpectrum from a fixture's EXACT reference arrays (mirrors detect.test). */
function conditionedFromFixture(f: Fixture): ConditionedSpectrum {
  const counts = f.counts;
  const background = f.snip_background;
  const netCounts = counts.map((c, i) => Math.max(0, c - background[i]));
  return {
    source: spectrumOf(counts, `${f.source}.TKA`),
    background,
    netCounts,
    smoothed: f.net_smoothed,
  };
}

/** A bare ConditionedSpectrum around an arbitrary smoothed series (for the synthetic
 * non-default-options case). Counts/background do not affect the survivor set or the
 * width/prominence values this test compares. */
function bareConditioned(smoothed: number[]): ConditionedSpectrum {
  const counts = smoothed.map((v) => Math.max(0, Math.round(v)));
  const background = new Array<number>(smoothed.length).fill(0);
  return { source: spectrumOf(counts, 'synthetic.TKA'), background, netCounts: counts, smoothed };
}

/** Assert survivor-vs-findPeaks parity: identical channels and identical per-survivor
 * width / sub-channel ips / prominence, index-aligned. */
function expectParity(
  conditioned: ConditionedSpectrum,
  options: Parameters<typeof detectTraced>[1],
): void {
  const opts = options ?? {};
  const prominence = opts.prominence ?? PROMINENCE;
  const distance = opts.distance ?? DISTANCE;
  const width = opts.minWidth ?? MIN_WIDTH;
  const relHeight = opts.relHeight ?? REL_HEIGHT;

  const survivors = detectTraced(conditioned, opts).survivors;
  const ref = findPeaks(conditioned.smoothed, { prominence, distance, width, relHeight });

  // Same surviving channels, exactly and in order.
  expect(survivors.map((p) => p.channel)).toEqual(ref.peaks);

  // Per survivor, the measured quantities equal the aligned findPeaks properties
  // EXACTLY (same primitives, same inputs -- these are per-peak, list-independent).
  const widths = ref.properties.widths!;
  const leftIps = ref.properties.leftIps!;
  const rightIps = ref.properties.rightIps!;
  const prominences = ref.properties.prominences!;
  for (let i = 0; i < survivors.length; i++) {
    expect(survivors[i].fwhmChannels).toBe(widths[i]);
    expect(survivors[i].leftIp).toBe(leftIps[i]);
    expect(survivors[i].rightIp).toBe(rightIps[i]);
    expect(survivors[i].prominence).toBe(prominences[i]);
  }
}

describe('detectTraced survivors are byte-identical to the findPeaks reference composition (DEBT-26)', () => {
  it('Cs-137 (real fixture, default gates): survivor channels + fwhm/ips/prominence match findPeaks', () => {
    const conditioned = conditionedFromFixture(Cs137 as unknown as Fixture);
    // Guard the guard: the fixture actually yields survivors, so parity is non-vacuous.
    expect(detectTraced(conditioned).survivors.length).toBeGreaterThan(0);
    expectParity(conditioned, {});
  });

  it('non-default options (synthetic array): the two paths still agree exactly', () => {
    // Three well-separated triangular peaks; all clear prominence 5, distance 3, width 1.
    const smoothed = [0, 1, 2, 10, 2, 1, 0, 0, 0, 15, 0, 0, 0, 1, 20, 1, 0];
    const conditioned = bareConditioned(smoothed);
    expect(
      detectTraced(conditioned, { prominence: 5, distance: 3, minWidth: 1 }).survivors.length,
    ).toBeGreaterThan(0);
    expectParity(conditioned, { prominence: 5, distance: 3, minWidth: 1 });
  });
});
