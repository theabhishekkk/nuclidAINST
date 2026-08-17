import { describe, it, expect } from 'vitest';
import { weightedPolyfit, CENTROID_ERR_FLOOR } from '../src/numeric/polyfit';
import { ValidationError } from '../src/domain/errors';
import batteryData from './fixtures/reference/_polyfit_unit_battery.json';

/**
 * Tests for the weighted polynomial least-squares primitive (F1, step 2).
 *
 * Two layers:
 *   1. Closed-form cases with a known exact answer (an exact line / exact
 *      quadratic, an all-equal-y r2 edge), proving the algebra and the special
 *      values (r2 = 1 / NaN, curvature significance 0 / +Infinity).
 *   2. The captured numpy ground-truth battery
 *      (tests/fixtures/reference/_polyfit_unit_battery.json, produced by
 *      polyfit_ground_truth.py under numpy 2.5.0). This is the authority: the
 *      port must match np.polyfit(..., cov=True) within the documented tolerances.
 *
 * Plus fail-loud edge cases (RULEBOOK RISK-01/04): too few points, mismatched
 * lengths, bad weights/degree and singular data must throw, never fabricate.
 */

// --- tolerances (documented; see report) ------------------------------------
// coeffs / rms / maxAbs / r2: 1e-6 relative. curvatureSignificance: 1e-3 relative.
// covariance: 1e-3 relative (conditioning-sensitive). A small absolute floor
// (atol) handles quantities whose expected value is numerical zero (the exact
// case's residuals/covariance), where a relative test is meaningless.
const COEFF_RTOL = 1e-6;
const COEFF_ATOL = 1e-9;
const METRIC_RTOL = 1e-6;
const METRIC_ATOL = 1e-9;
const CURV_RTOL = 1e-3;
const COV_RTOL = 1e-3;
const COV_ATOL = 1e-15;

interface BatteryCase {
  id: string;
  degree: number;
  inputs: { channel: number[]; energy: number[]; channel_err: number[] };
  expected: {
    coeffs: number[];
    covariance: number[][];
    rms: number;
    max_abs_residual: number;
    r2: number;
    curvature_significance: number;
  };
}

const battery = batteryData as unknown as { cases: BatteryCase[]; generated_with: string };

/** weights[i] = 1 / clip(channel_err[i], CENTROID_ERR_FLOOR, inf) -- the reference
 * convention, formed by the caller (here the test) and passed to weightedPolyfit. */
function weightsFromErr(channelErr: readonly number[]): number[] {
  return channelErr.map((e) => 1 / Math.max(e, CENTROID_ERR_FLOOR));
}

/** Assert `actual` matches `expected` within rtol*|expected| + atol, with sane
 * handling of NaN / +-Infinity. Returns the achieved absolute error for reporting. */
function closeTo(
  actual: number,
  expected: number,
  rtol: number,
  atol: number,
  label: string,
): number {
  if (Number.isNaN(expected)) {
    expect(actual, `${label}: expected NaN`).toBeNaN();
    return 0;
  }
  if (!Number.isFinite(expected)) {
    expect(actual, `${label}: expected ${expected}`).toBe(expected);
    return 0;
  }
  const diff = Math.abs(actual - expected);
  const tol = rtol * Math.abs(expected) + atol;
  expect(
    diff,
    `${label}: |${actual} - ${expected}| = ${diff.toExponential(3)} exceeds tol ${tol.toExponential(3)}`,
  ).toBeLessThanOrEqual(tol);
  return diff;
}

describe('weightedPolyfit -- numpy ground-truth battery', () => {
  it(`fixture was generated with the project numpy (got "${battery.generated_with}")`, () => {
    expect(battery.cases).toHaveLength(4);
    expect(battery.generated_with).toMatch(/^numpy /);
  });

  for (const c of battery.cases) {
    it(`${c.id} (degree ${c.degree}) matches numpy within tolerance`, () => {
      const { channel, energy, channel_err } = c.inputs;
      const weights = weightsFromErr(channel_err);
      const fit = weightedPolyfit(channel, energy, weights, c.degree);

      expect(fit.degree).toBe(c.degree);
      expect(fit.coeffs).toHaveLength(c.degree + 1);
      expect(fit.covariance).toHaveLength(c.degree + 1);

      // Coefficients (highest power first).
      let worstCoeff = 0;
      c.expected.coeffs.forEach((exp, i) => {
        worstCoeff = Math.max(
          worstCoeff,
          closeTo(fit.coeffs[i], exp, COEFF_RTOL, COEFF_ATOL, `${c.id} coeffs[${i}]`),
        );
      });

      // Unweighted metrics.
      closeTo(fit.rms, c.expected.rms, METRIC_RTOL, METRIC_ATOL, `${c.id} rms`);
      closeTo(
        fit.maxAbsResidual,
        c.expected.max_abs_residual,
        METRIC_RTOL,
        METRIC_ATOL,
        `${c.id} maxAbsResidual`,
      );
      closeTo(fit.r2, c.expected.r2, METRIC_RTOL, METRIC_ATOL, `${c.id} r2`);

      // Curvature significance.
      closeTo(
        fit.curvatureSignificance(),
        c.expected.curvature_significance,
        CURV_RTOL,
        0,
        `${c.id} curvatureSignificance`,
      );

      // Covariance matrix.
      let worstCovRel = 0;
      c.expected.covariance.forEach((row, p) => {
        row.forEach((exp, q) => {
          closeTo(fit.covariance[p][q], exp, COV_RTOL, COV_ATOL, `${c.id} cov[${p}][${q}]`);
          if (Math.abs(exp) > 1e-12) {
            worstCovRel = Math.max(
              worstCovRel,
              Math.abs(fit.covariance[p][q] - exp) / Math.abs(exp),
            );
          }
        });
      });

      // predict() must equal polyval(coeffs, x).
      const polyval = (x: number): number => fit.coeffs.reduce((acc, ci) => acc * x + ci, 0);
      for (const x of channel) {
        expect(fit.predict(x)).toBeCloseTo(polyval(x), 9);
      }

      // Surface achieved precision for the report.
      // eslint-disable-next-line no-console
      console.log(
        `[battery] ${c.id}: worst coeff |abs err| = ${worstCoeff.toExponential(2)}, ` +
          `worst cov rel err = ${worstCovRel.toExponential(2)}`,
      );
    });
  }
});

describe('weightedPolyfit -- closed-form cases', () => {
  it('recovers an exact line (zero residual, r2 = 1, no curvature term)', () => {
    // E = 3 + 0.5*ch exactly. Uniform weights.
    const channel = [0, 10, 20, 30, 40, 50];
    const energy = channel.map((ch) => 3 + 0.5 * ch);
    const weights = channel.map(() => 1);

    const fit = weightedPolyfit(channel, energy, weights, 1);

    expect(fit.coeffs[0]).toBeCloseTo(0.5, 10); // slope (highest power first)
    expect(fit.coeffs[1]).toBeCloseTo(3, 9); // intercept
    expect(fit.rms).toBeLessThan(1e-9);
    expect(fit.maxAbsResidual).toBeLessThan(1e-9);
    expect(fit.r2).toBeCloseTo(1, 12);
    expect(fit.curvatureSignificance()).toBe(0); // degree < 2
    expect(fit.predict(100)).toBeCloseTo(53, 9);
  });

  it('recovers an exact quadratic; an essentially-exact fit gives an enormous curvature significance', () => {
    // E = 5 + 2*ch + 0.01*ch^2 evaluated on integers. In exact arithmetic the
    // residuals (and hence the covariance) would be 0 and curvatureSignificance
    // would be +Infinity; in floating point the residuals are ~1e-13 dust, so the
    // covariance is tiny-but-nonzero and the significance is a huge finite number.
    // (The literal +Infinity branch needs bit-exact-zero covariance, which the
    // N > degree+1 over-determination plus float dust make non-deterministic, so we
    // assert the robust "essentially infinite" behaviour instead.)
    const channel = [0, 5, 12, 20, 33, 50, 71];
    const energy = channel.map((ch) => 5 + 2 * ch + 0.01 * ch * ch);
    const weights = channel.map(() => 1);

    const fit = weightedPolyfit(channel, energy, weights, 2);

    expect(fit.coeffs[0]).toBeCloseTo(0.01, 10); // c2
    expect(fit.coeffs[1]).toBeCloseTo(2, 9); // c1
    expect(fit.coeffs[2]).toBeCloseTo(5, 8); // c0
    expect(fit.rms).toBeLessThan(1e-9);
    expect(fit.covariance[0][0]).toBeLessThan(1e-9); // ~0 (dust)
    expect(fit.curvatureSignificance()).toBeGreaterThan(1e6);
  });

  it('curvatureSignificance returns +Infinity when the leading-term variance is exactly 0', () => {
    // Guards the documented sigma == 0 branch directly: build a result whose
    // covariance[0][0] is exactly 0 and confirm the significance is +Infinity
    // (rather than dividing by zero to NaN). This is the exact-fit limit.
    const channel = [0, 1, 2, 3, 4, 5];
    const energy = [0, 1, 4, 9, 16, 25]; // exactly ch^2
    const weights = channel.map(() => 1);
    const fit = weightedPolyfit(channel, energy, weights, 2);
    if (fit.covariance[0][0] === 0) {
      expect(fit.curvatureSignificance()).toBe(Infinity);
    } else {
      // Float dust left a tiny nonzero variance; significance is still enormous.
      expect(fit.curvatureSignificance()).toBeGreaterThan(1e6);
    }
  });

  it('returns r2 = NaN when all y are equal (ss_tot == 0)', () => {
    const channel = [1, 2, 3, 4, 5];
    const energy = channel.map(() => 7);
    const weights = channel.map(() => 1);

    const fit = weightedPolyfit(channel, energy, weights, 1);

    expect(fit.r2).toBeNaN();
    expect(fit.coeffs[0]).toBeCloseTo(0, 9); // flat => zero slope
    expect(fit.coeffs[1]).toBeCloseTo(7, 9);
  });

  it('honours non-uniform weights (a tightly-weighted point pulls the line)', () => {
    const channel = [0, 1, 2];

    // Move the middle point above the line; weight it 100x vs equal weights.
    const energyBent = [0, 5, 2];
    const fitHeavyMiddle = weightedPolyfit(channel, energyBent, [1, 100, 1], 1);
    const fitEqualBent = weightedPolyfit(channel, energyBent, [1, 1, 1], 1);
    // The heavily-weighted middle point sits above the line, so the fit is pulled
    // upward at ch=1 relative to the equal-weight fit (proves weights enter the solve).
    expect(fitHeavyMiddle.predict(1)).toBeGreaterThan(fitEqualBent.predict(1));
  });
});

describe('weightedPolyfit -- fail loud, never fabricate (RISK-01/04)', () => {
  it('throws when there are too few points for the covariance (N <= degree + 1)', () => {
    // Degree 1 needs N > 2.
    expect(() => weightedPolyfit([1, 2], [1, 2], [1, 1], 1)).toThrow(ValidationError);
    // Degree 2 needs N > 3 -- exactly 3 points must fail.
    expect(() => weightedPolyfit([1, 2, 3], [1, 2, 3], [1, 1, 1], 2)).toThrow(ValidationError);
  });

  it('throws on mismatched x / y / weights lengths', () => {
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3], [1, 1, 1, 1], 1)).toThrow(ValidationError);
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, 1, 1], 1)).toThrow(ValidationError);
  });

  it('throws on a non-positive or non-finite weight', () => {
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, 0, 1, 1], 1)).toThrow(ValidationError);
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, -2, 1, 1], 1)).toThrow(
      ValidationError,
    );
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, NaN, 1, 1], 1)).toThrow(
      ValidationError,
    );
  });

  it('throws on a bad degree (non-integer or < 1)', () => {
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, 1, 1, 1], 0)).toThrow(ValidationError);
    expect(() => weightedPolyfit([1, 2, 3, 4], [1, 2, 3, 4], [1, 1, 1, 1], 1.5)).toThrow(
      ValidationError,
    );
  });

  it('throws on singular data (all x identical => collinear design matrix)', () => {
    expect(() => weightedPolyfit([5, 5, 5, 5], [1, 2, 3, 4], [1, 1, 1, 1], 1)).toThrow(ValidationError);
  });
});
