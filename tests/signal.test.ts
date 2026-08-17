import { describe, it, expect } from 'vitest';
import { savitzkyGolay } from '../src/signal/savgol';
import { peakProminences } from '../src/signal/peakProminences';
import { peakWidths } from '../src/signal/peakWidths';
import { findPeaks, localMaxima1d, selectByPeakDistance } from '../src/signal/findPeaks';
import { ValidationError } from '../src/domain/errors';

import battery from './fixtures/reference/_function_unit_battery.json';
import Am241 from './fixtures/reference/Am-241.json';
import Ba133 from './fixtures/reference/Ba-133.json';
import Co57 from './fixtures/reference/Co-57.json';
import Co60 from './fixtures/reference/Co-60.json';
import Cs137 from './fixtures/reference/Cs-137.json';
import Eu152 from './fixtures/reference/Eu-152.json';
import Mn54 from './fixtures/reference/Mn-54.json';

/**
 * Tests for the F2 signal core (savitzkyGolay / findPeaks / peakProminences /
 * peakWidths), verified IN ISOLATION against SciPy ground truth captured by
 * tests/fixtures/reference/capture_reference_detection.py (scipy 1.18.0 /
 * numpy 2.5.0) run on the reference's own functions and the real v4 spectra.
 *
 * Layers:
 *   1. Function unit battery -- small hand-checkable vectors.
 *   2. Per-source batteries  -- the 7 real spectra, each stage's stored I/O.
 *   3. Closed-form / degenerate cases (Gaussian FWHM, flat array, plateau,
 *      equal-peaks-within-distance, polynomial reproduction).
 *   4. Fail-loud cases (RULEBOOK RISK-01/04).
 *
 * Tolerances: peak INDICES must match EXACTLY (they are integers). Float
 * quantities (savgol output, widths/ips/heights) use 1e-9 ABS. The achieved
 * worst-case error is logged for the report.
 */

const FLOAT_ATOL = 1e-9;
const SAVGOL_WINDOW = 9;
const SAVGOL_POLYORDER = 3;

/** Max abs error between two arrays (asserts equal length). */
function maxAbsErr(actual: readonly number[], expected: readonly number[], label: string): number {
  expect(actual.length, `${label}: length`).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > worst) worst = d;
  }
  return worst;
}

function expectClose(
  actual: readonly number[],
  expected: readonly number[],
  atol: number,
  label: string,
): number {
  const worst = maxAbsErr(actual, expected, label);
  expect(
    worst,
    `${label}: worst |abs err| ${worst.toExponential(3)} exceeds ${atol}`,
  ).toBeLessThanOrEqual(atol);
  return worst;
}

const clipNonNeg = (v: readonly number[]): number[] => v.map((y) => (y < 0 ? 0 : y));

// --- fixture typings --------------------------------------------------------
interface PerSource {
  source: string;
  n_channels: number;
  net: number[];
  net_smoothed: number[];
  peaks: number[];
  peak_widths: {
    widths: number[];
    width_heights: number[];
    left_ips: number[];
    right_ips: number[];
  };
  params: { prominence: number; distance: number; width: number; rel_height: number };
  generated_with: string;
}
const SOURCES = [Am241, Ba133, Co57, Co60, Cs137, Eu152, Mn54] as unknown as PerSource[];

interface SavgolCase {
  id: string;
  input: number[];
  window_length: number;
  polyorder: number;
  savgol_output: number[];
}
interface FindPeaksCase {
  id: string;
  input: number[];
  options: { prominence?: number; distance?: number; width?: number };
  find_peaks_peaks: number[];
}
interface PeakWidthsCase {
  id: string;
  input: number[];
  peaks: number[];
  rel_height: number;
  expected: { widths: number[]; width_heights: number[]; left_ips: number[]; right_ips: number[] };
}
const bat = battery as unknown as {
  generated_with: string;
  savgol: SavgolCase[];
  find_peaks: FindPeaksCase[];
  peak_widths: PeakWidthsCase[];
};

// =====================================================================
// 1. Function unit battery
// =====================================================================
describe('signal core -- function unit battery (SciPy ground truth)', () => {
  it(`fixture was generated with scipy/numpy (got "${bat.generated_with}")`, () => {
    expect(bat.generated_with).toMatch(/^scipy /);
  });

  let worstSavgol = 0;
  for (const c of bat.savgol) {
    it(`savitzkyGolay ${c.id} (w=${c.window_length}, p=${c.polyorder}) matches savgol_filter`, () => {
      const out = savitzkyGolay(c.input, c.window_length, c.polyorder);
      worstSavgol = Math.max(
        worstSavgol,
        expectClose(out, c.savgol_output, FLOAT_ATOL, `savgol ${c.id}`),
      );
    });
  }

  for (const c of bat.find_peaks) {
    it(`findPeaks ${c.id} matches find_peaks (exact indices)`, () => {
      const res = findPeaks(c.input, c.options);
      expect(res.peaks, c.id).toEqual(c.find_peaks_peaks);
    });
  }

  for (const c of bat.peak_widths) {
    it(`peakWidths ${c.id} matches peak_widths`, () => {
      const res = peakWidths(c.input, c.peaks, c.rel_height);
      expectClose(res.widths, c.expected.widths, FLOAT_ATOL, `${c.id} widths`);
      expectClose(res.widthHeights, c.expected.width_heights, FLOAT_ATOL, `${c.id} heights`);
      expectClose(res.leftIps, c.expected.left_ips, FLOAT_ATOL, `${c.id} leftIps`);
      expectClose(res.rightIps, c.expected.right_ips, FLOAT_ATOL, `${c.id} rightIps`);
    });
  }

  it('reports the achieved savgol battery tolerance', () => {
    // eslint-disable-next-line no-console
    console.log(`[battery] worst savgol |abs err| = ${worstSavgol.toExponential(2)}`);
    expect(worstSavgol).toBeLessThanOrEqual(FLOAT_ATOL);
  });
});

// =====================================================================
// 2. Per-source batteries (real v4 spectra)
// =====================================================================
describe('signal core -- per-source batteries (7 real spectra)', () => {
  let worstSavgol = 0;
  let worstWidths = 0;
  let worstIps = 0;

  for (const src of SOURCES) {
    describe(src.source, () => {
      it('savgol(net, 9, 3) + clip matches net_smoothed (1e-9 abs)', () => {
        const out = clipNonNeg(savitzkyGolay(src.net, SAVGOL_WINDOW, SAVGOL_POLYORDER));
        worstSavgol = Math.max(
          worstSavgol,
          expectClose(out, src.net_smoothed, FLOAT_ATOL, `${src.source} net_smoothed`),
        );
      });

      it('findPeaks(prominence 200, distance 8, width 2) matches peaks (EXACT)', () => {
        const res = findPeaks(src.net_smoothed, {
          prominence: src.params.prominence,
          distance: src.params.distance,
          width: src.params.width,
        });
        expect(res.peaks, `${src.source} peaks`).toEqual(src.peaks);
      });

      it('peakWidths(rel_height 0.5) matches stored widths/heights/ips (1e-9 abs)', () => {
        const res = peakWidths(src.net_smoothed, src.peaks, src.params.rel_height);
        worstWidths = Math.max(
          worstWidths,
          expectClose(res.widths, src.peak_widths.widths, FLOAT_ATOL, `${src.source} widths`),
        );
        expectClose(
          res.widthHeights,
          src.peak_widths.width_heights,
          FLOAT_ATOL,
          `${src.source} heights`,
        );
        worstIps = Math.max(
          worstIps,
          expectClose(res.leftIps, src.peak_widths.left_ips, FLOAT_ATOL, `${src.source} leftIps`),
          expectClose(res.rightIps, src.peak_widths.right_ips, FLOAT_ATOL, `${src.source} rightIps`),
        );
      });
    });
  }

  it('reports achieved per-source tolerances', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[per-source] worst savgol=${worstSavgol.toExponential(2)} ` +
        `widths=${worstWidths.toExponential(2)} ips=${worstIps.toExponential(2)}`,
    );
    expect(Math.max(worstSavgol, worstWidths, worstIps)).toBeLessThanOrEqual(FLOAT_ATOL);
  });
});

// =====================================================================
// 3. Closed-form / degenerate cases
// =====================================================================
describe('savitzkyGolay -- closed-form', () => {
  it('reproduces a polynomial of degree <= polyorder exactly', () => {
    // y = 2 + 3x + 0.5x^2 over 0..20; window 5, polyorder 2 -> output == input.
    const x = Array.from({ length: 21 }, (_, i) => 2 + 3 * i + 0.5 * i * i);
    const out = savitzkyGolay(x, 5, 2);
    expect(maxAbsErr(out, x, 'poly reproduce')).toBeLessThan(1e-7);
  });

  it('polyorder 0 is a centred moving average in the interior', () => {
    const x = [1, 2, 9, 2, 1, 2, 9, 2, 1];
    const out = savitzkyGolay(x, 3, 0);
    for (let i = 1; i < x.length - 1; i++) {
      expect(out[i]).toBeCloseTo((x[i - 1] + x[i] + x[i + 1]) / 3, 10);
    }
  });
});

describe('peakWidths -- closed-form Gaussian FWHM', () => {
  it('recovers FWHM = 2.3548*sigma for an isolated Gaussian', () => {
    const sigma = 25;
    const center = 200;
    const n = 401;
    const amp = 1000;
    const x = Array.from(
      { length: n },
      (_, i) => amp * Math.exp(-((i - center) ** 2) / (2 * sigma * sigma)),
    );
    const { peaks } = findPeaks(x, { prominence: 1 });
    expect(peaks).toContain(center);
    const res = peakWidths(x, [center], 0.5);
    const expectedFwhm = 2.354820045 * sigma; // ~58.87 samples
    expect(res.widths[0]).toBeGreaterThan(expectedFwhm * 0.99);
    expect(res.widths[0]).toBeLessThan(expectedFwhm * 1.01);
    // width line sits at half the amplitude (prominence ~= amp on zero baseline).
    expect(res.widthHeights[0]).toBeCloseTo(amp / 2, 2);
  });
});

describe('findPeaks / localMaxima1d -- degenerate', () => {
  it('a flat array has no peaks', () => {
    expect(localMaxima1d([5, 5, 5, 5, 5])).toEqual([]);
    expect(findPeaks([5, 5, 5, 5, 5], { prominence: 1 }).peaks).toEqual([]);
  });

  it('a monotonic ramp has no peaks (endpoints never count)', () => {
    expect(localMaxima1d([0, 1, 2, 3, 4])).toEqual([]);
  });

  it('reports the plateau midpoint (floor) as the peak index', () => {
    expect(localMaxima1d([0, 1, 2, 2, 2, 1, 0])).toEqual([3]); // (2+4)//2
    expect(localMaxima1d([0, 1, 3, 3, 3, 3, 1, 0])).toEqual([3]); // (2+5)//2 floor
  });

  it('distance filter keeps exactly one of two equal peaks within distance', () => {
    // Peaks at 1 and 3 (equal height 5), distance 3 (= ceil) -> one survivor.
    const x = [0, 5, 0, 5, 0];
    const res = findPeaks(x, { distance: 3 });
    expect(res.peaks).toHaveLength(1);
    expect([1, 3]).toContain(res.peaks[0]);
  });

  it('distance filter keeps the taller of two unequal close peaks', () => {
    const x = [0, 5, 0, 4, 0];
    expect(findPeaks(x, { distance: 3 }).peaks).toEqual([1]);
    const keep = selectByPeakDistance([1, 3], [5, 4], 3);
    expect(keep).toEqual([true, false]);
  });

  it('prominence is the rise above the higher base (peakProminences)', () => {
    // isolated triangle on zero baseline: prominence == peak height.
    const x = [0, 1, 2, 3, 4, 3, 2, 1, 0];
    const prom = peakProminences(x, [4]);
    expect(prom.prominences[0]).toBeCloseTo(4, 12);
    expect(prom.leftBases[0]).toBe(0);
    expect(prom.rightBases[0]).toBe(8);
  });
});

// =====================================================================
// 4. Fail-loud, never fabricate (RISK-01/04)
// =====================================================================
describe('signal core -- fail loud', () => {
  it('savitzkyGolay rejects an even window', () => {
    expect(() => savitzkyGolay([1, 2, 3, 4, 5, 6], 4, 2)).toThrow(ValidationError);
  });
  it('savitzkyGolay rejects polyorder >= window', () => {
    expect(() => savitzkyGolay([1, 2, 3, 4, 5], 5, 5)).toThrow(ValidationError);
    expect(() => savitzkyGolay([1, 2, 3, 4, 5], 3, 5)).toThrow(ValidationError);
  });
  it('savitzkyGolay rejects window > input length (mode interp, no padding)', () => {
    expect(() => savitzkyGolay([1, 2, 3], 5, 2)).toThrow(ValidationError);
    expect(() => savitzkyGolay([], 9, 3)).toThrow(ValidationError);
  });
  it('savitzkyGolay rejects non-integer window / negative polyorder', () => {
    expect(() => savitzkyGolay([1, 2, 3, 4, 5], 5.5, 2)).toThrow(ValidationError);
    expect(() => savitzkyGolay([1, 2, 3, 4, 5], 5, -1)).toThrow(ValidationError);
  });
  it('findPeaks rejects distance < 1', () => {
    expect(() => findPeaks([0, 1, 0], { distance: 0 })).toThrow(ValidationError);
  });
  it('peakProminences rejects an out-of-bounds peak and wlen <= 1', () => {
    expect(() => peakProminences([0, 1, 0], [5])).toThrow(ValidationError);
    expect(() => peakProminences([0, 1, 0], [1], 1)).toThrow(ValidationError);
  });
  it('peakWidths rejects relHeight < 0', () => {
    expect(() => peakWidths([0, 1, 0], [1], -0.1)).toThrow(ValidationError);
  });
});
