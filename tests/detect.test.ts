import { describe, it, expect } from 'vitest';
import { condition } from '../src/pipeline/condition';
import {
  detect,
  classifyPeak,
  measurePeak,
  expectedFwhmChannels,
  resolutionConstantK,
} from '../src/pipeline/detect';
import type { ConditionedSpectrum, PeakClass, Spectrum } from '../src/domain/types';

import Am241 from './fixtures/reference/Am-241.json';
import Ba133 from './fixtures/reference/Ba-133.json';
import Co57 from './fixtures/reference/Co-57.json';
import Co60 from './fixtures/reference/Co-60.json';
import Cs137 from './fixtures/reference/Cs-137.json';
import Eu152 from './fixtures/reference/Eu-152.json';
import Mn54 from './fixtures/reference/Mn-54.json';

/**
 * C1 detection tests, verified against the reference (`Calibration Mode.py`) via
 * the committed per-source fixtures (scipy 1.18.0 / numpy 2.5.0):
 *
 *   - Scope B: `detect` peaks == fixture `peaks` EXACTLY; fwhm == peak_widths.widths.
 *   - Scope C: net/gross area, significance, expected_fwhm, width_ratio and
 *     classification == the fixture `measure` block (the reference's own chain).
 *   - Scope A: `condition` reproduces snip_background and net_smoothed.
 *   - Pure-function units + degenerate cases (empty/flat/single/edge).
 *
 * The detect-parity tests feed the fixture's EXACT conditioned arrays so detect is
 * isolated from any SNIP drift; a separate end-to-end test runs the real
 * condition() so the whole C1 path is exercised too.
 */

interface Fixture {
  source: string;
  counts: number[];
  snip_background: number[];
  net: number[];
  net_smoothed: number[];
  peaks: number[];
  peak_widths: { widths: number[]; width_heights: number[]; left_ips: number[]; right_ips: number[] };
  resolution: { k: number | null };
  measure: {
    net_area: number[];
    gross_area: number[];
    significance: number[];
    expected_fwhm: number[];
    width_ratio: number[];
    classification: string[];
  };
}

const FIXTURES: Fixture[] = [
  Am241, Ba133, Co57, Co60, Cs137, Eu152, Mn54,
] as unknown as Fixture[];

/** Reference flag string -> our PeakClass identifier. */
const FLAG_TO_CLASS: Record<string, PeakClass> = {
  'CANDIDATE LINE': 'line',
  'broad - continuum/backscatter, NOT a line': 'broad',
  'weak - likely noise': 'weak',
};

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

/** Build a ConditionedSpectrum from a fixture's EXACT reference arrays. */
function conditionedFromFixture(f: Fixture): ConditionedSpectrum {
  const counts = f.counts;
  const background = f.snip_background;
  const netCounts = counts.map((c, i) => Math.max(0, c - background[i]));
  return { source: spectrumOf(counts, `${f.source}.TKA`), background, netCounts, smoothed: f.net_smoothed };
}

/** Absolute error tolerant of float-sum reordering for large (1e6-scale) areas. */
function close(actual: number, expected: number, label: string, rtol = 1e-9, atol = 1e-6): void {
  const tol = atol + rtol * Math.abs(expected);
  expect(Math.abs(actual - expected), `${label}: |${actual} - ${expected}| > ${tol}`).toBeLessThanOrEqual(tol);
}

describe('detect -- per-source parity with the reference fixtures', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: peaks/fwhm/measure/classification match`, () => {
      const peaks = detect(conditionedFromFixture(f));

      // Scope B: peak channels exactly equal, in ascending order.
      expect(peaks.map((p) => p.channel)).toEqual(f.peaks);

      for (let i = 0; i < peaks.length; i++) {
        const p = peaks[i];
        // FWHM (and sub-channel ips) from peak_widths @ 0.5.
        close(p.fwhmChannels, f.peak_widths.widths[i], `${f.source}[${i}] fwhm`);
        close(p.leftIp, f.peak_widths.left_ips[i], `${f.source}[${i}] leftIp`);
        close(p.rightIp, f.peak_widths.right_ips[i], `${f.source}[${i}] rightIp`);

        // Scope C: areas, significance, resolution model, classification.
        close(p.grossArea, f.measure.gross_area[i], `${f.source}[${i}] grossArea`);
        close(p.netArea, f.measure.net_area[i], `${f.source}[${i}] netArea`);
        close(p.significance, f.measure.significance[i], `${f.source}[${i}] significance`);
        close(p.expectedFwhmChannels, f.measure.expected_fwhm[i], `${f.source}[${i}] expectedFwhm`);
        close(p.widthRatio, f.measure.width_ratio[i], `${f.source}[${i}] widthRatio`);
        expect(p.classification, `${f.source}[${i}] classification`).toBe(
          FLAG_TO_CLASS[f.measure.classification[i]],
        );
      }
    });
  }
});

describe('condition -- reproduces the reference SNIP background and savgol detection series', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: background and smoothed match`, () => {
      const cond = condition(spectrumOf(f.counts, `${f.source}.TKA`));
      let worstBg = 0;
      let worstSm = 0;
      for (let i = 0; i < f.counts.length; i++) {
        worstBg = Math.max(worstBg, Math.abs(cond.background[i] - f.snip_background[i]));
        worstSm = Math.max(worstSm, Math.abs(cond.smoothed[i] - f.net_smoothed[i]));
      }
      expect(worstBg, `${f.source} background worst |err| ${worstBg.toExponential(3)}`).toBeLessThanOrEqual(1e-6);
      expect(worstSm, `${f.source} smoothed worst |err| ${worstSm.toExponential(3)}`).toBeLessThanOrEqual(1e-6);
    });
  }
});

describe('detect -- end-to-end via the real condition() reproduces the fixture peaks', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: condition()->detect() channels equal fixture peaks`, () => {
      const peaks = detect(condition(spectrumOf(f.counts, `${f.source}.TKA`)));
      expect(peaks.map((p) => p.channel)).toEqual(f.peaks);
    });
  }
});

describe('classifyPeak -- reference classify_candidate branches', () => {
  it('weak when significance below the floor (checked before width)', () => {
    expect(classifyPeak(1.0, 3.99)).toBe('weak');
    // Significance gate wins even if also too broad.
    expect(classifyPeak(5.0, 3.99)).toBe('weak');
  });
  it('broad when significant but width ratio above the cap', () => {
    expect(classifyPeak(2.0001, 100)).toBe('broad');
  });
  it('line at the exact thresholds (boundaries are inclusive towards line)', () => {
    expect(classifyPeak(2.0, 4.0)).toBe('line'); // ratio == cap, signif == floor
    expect(classifyPeak(1.0, 1000)).toBe('line');
  });
});

describe('measurePeak -- window and significance match the reference', () => {
  it('floors the half-window at MIN_HALF_WINDOW (3) for small FWHM', () => {
    const counts = [0, 0, 10, 100, 10, 0, 0];
    const net = [0, 0, 8, 90, 8, 0, 0];
    // fwhm 2 -> round(1.5*2)=3 -> half 3 -> window covers the whole length here.
    const m = measurePeak(3, 2, counts, net);
    expect(m.grossArea).toBe(120);
    expect(m.netArea).toBe(106);
    expect(m.significance).toBeCloseTo(106 / Math.sqrt(120), 12);
  });

  it('uses round-half-to-even (banker rounding), not round-half-up', () => {
    const n = 30;
    const counts = new Array<number>(n).fill(1);
    const net = new Array<number>(n).fill(1);
    // 1.5 * 3 = 4.5 -> banker rounds to 4 (even); half-up would give 5.
    const m = measurePeak(15, 3, counts, net);
    expect(m.grossArea).toBe(9); // indices 11..19 inclusive = 9 channels
  });

  it('clamps the window at the array edges', () => {
    const counts = [1, 1, 1, 1, 1];
    const net = [1, 1, 1, 1, 1];
    const m = measurePeak(4, 4, counts, net); // half 6, clamps lo=0..hi=4
    expect(m.grossArea).toBe(5);
  });
});

describe('resolution model', () => {
  it('k anchors so the anchor channel reproduces its own FWHM (ratio 1)', () => {
    const k = resolutionConstantK(100, 12);
    expect(expectedFwhmChannels(100, k)).toBeCloseTo(12, 12);
  });
  it('expected FWHM grows as sqrt(channel) and floors channel at 1', () => {
    const k = 2;
    expect(expectedFwhmChannels(400, k)).toBeCloseTo(40, 12);
    expect(expectedFwhmChannels(0, k)).toBeCloseTo(2, 12); // max(channel,1)
  });
});

describe('detect -- degenerate and edge cases', () => {
  const bareConditioned = (counts: number[], background: number[], smoothed: number[]): ConditionedSpectrum => ({
    source: spectrumOf(counts, 'synthetic.TKA'),
    background,
    netCounts: counts.map((c, i) => Math.max(0, c - background[i])),
    smoothed,
  });

  it('empty spectrum -> no peaks', () => {
    expect(detect(bareConditioned([], [], []))).toEqual([]);
  });

  it('flat spectrum -> no peaks', () => {
    const n = 50;
    const flat = new Array<number>(n).fill(5);
    expect(detect(bareConditioned(flat, new Array<number>(n).fill(0), flat))).toEqual([]);
  });

  it('single clear peak -> one detected peak, widthRatio exactly 1 (self-anchored)', () => {
    const n = 60;
    const smoothed = new Array<number>(n).fill(0);
    const counts = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const g = 1000 * Math.exp(-((i - 30) * (i - 30)) / (2 * 16)); // sigma 4, ampl 1000
      smoothed[i] = g;
      counts[i] = Math.round(g);
    }
    const peaks = detect(bareConditioned(counts, new Array<number>(n).fill(0), smoothed));
    expect(peaks).toHaveLength(1);
    expect(peaks[0].channel).toBe(30);
    expect(peaks[0].widthRatio).toBeCloseTo(1, 12);
    expect(peaks[0].classification).toBe('line'); // tall -> highly significant
  });

  it('peak near the array edge is detected and its window clamps without error', () => {
    const n = 40;
    const smoothed = new Array<number>(n).fill(0);
    const counts = new Array<number>(n).fill(0);
    const center = n - 4;
    for (let i = 0; i < n; i++) {
      const g = 1000 * Math.exp(-((i - center) * (i - center)) / (2 * 9)); // sigma 3
      smoothed[i] = g;
      counts[i] = Math.round(g);
    }
    const peaks = detect(bareConditioned(counts, new Array<number>(n).fill(0), smoothed));
    expect(peaks).toHaveLength(1);
    expect(peaks[0].channel).toBe(center);
    expect(Number.isFinite(peaks[0].netArea)).toBe(true);
    expect(Number.isFinite(peaks[0].significance)).toBe(true);
  });
});
