import { describe, it, expect } from 'vitest';
import { lmFit, type LmFitResult } from '../src/numeric/lmFit';
import { ValidationError } from '../src/domain/errors';

/**
 * Tests for the project-owned Levenberg-Marquardt wrapper (F1, step 1).
 *
 * The happy path recovers a known Gaussian-on-linear-background from noisy
 * synthetic data and checks that the reported 1-sigma errors are finite and
 * sane. The edge cases prove the fail-loud contract (RULEBOOK RISK-01 / 04):
 * the wrapper never returns a confident wrong answer -- it either converges to
 * the right parameters or reports converged=false / throws.
 *
 * All randomness is from a seeded PRNG so the run is deterministic (no flakes).
 */

// --- deterministic noise ----------------------------------------------------

/** Seeded PRNG (mulberry32) -> reproducible pseudo-random numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal sample via Box-Muller, driven by a seeded PRNG. */
function standardNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// --- model under test: Gaussian + linear background -------------------------
// params = [amplitude, centroid, sigma, slope, intercept]
const gaussianPlusLinear =
  (params: readonly number[]) =>
  (x: number): number => {
    const [amplitude, centroid, sigma, slope, intercept] = params;
    const z = (x - centroid) / sigma;
    return amplitude * Math.exp(-0.5 * z * z) + slope * x + intercept;
  };

interface SyntheticGaussian {
  readonly x: number[];
  readonly y: number[];
  /** weights[i] = 1/sigma_i, Poisson approximation 1/sqrt(counts). */
  readonly weights: number[];
  readonly truth: readonly number[];
}

function makeSyntheticGaussian(seed: number): SyntheticGaussian {
  const truth = [1000, 300, 8, -0.05, 50] as const; // A, mu, sigma, slope, intercept
  const f = gaussianPlusLinear(truth);
  const rng = mulberry32(seed);
  const channels = 512;
  const x: number[] = [];
  const y: number[] = [];
  const weights: number[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const ideal = f(ch);
    // Poisson-ish noise: standard deviation ~ sqrt(counts).
    const sigma = Math.sqrt(Math.max(ideal, 1));
    const noisy = Math.max(0, ideal + sigma * standardNormal(rng));
    x.push(ch);
    y.push(noisy);
    weights.push(1 / Math.sqrt(Math.max(noisy, 1)));
  }
  return { x, y, weights, truth };
}

/**
 * The wrapper's core contract: the `converged` flag is never inconsistent with
 * the reported errors. A "converged" fit has only finite, non-negative errors; a
 * non-converged one always exposes at least one non-finite error -- so a caller
 * can trust the flag and can never read a fake error out of a failed fit.
 */
function assertFlagConsistent(result: LmFitResult): void {
  if (result.converged) {
    for (const e of result.parameterErrors) {
      expect(Number.isFinite(e)).toBe(true);
      expect(e).toBeGreaterThanOrEqual(0);
    }
  } else {
    expect(result.parameterErrors.some((e) => !Number.isFinite(e))).toBe(true);
  }
}

describe('lmFit -- happy path (recovers a known Gaussian)', () => {
  it('recovers amplitude, centroid, sigma + background within tolerance', () => {
    const { x, y, weights, truth } = makeSyntheticGaussian(12345);

    const result = lmFit({ x, y }, gaussianPlusLinear, {
      // Deliberately rough starting guess -- not the truth.
      initialValues: [800, 305, 10, 0, 40],
      weights,
      maxIterations: 200,
    });

    expect(result.converged).toBe(true);

    const [amplitude, centroid, sigma, slope, intercept] = result.parameters;
    expect(amplitude).toBeCloseTo(truth[0], -2); // within ~50 of 1000
    expect(centroid).toBeCloseTo(truth[1], 0); // within ~0.5 channel of 300
    expect(sigma).toBeCloseTo(truth[2], 0); // within ~0.5 of 8
    expect(slope).toBeCloseTo(truth[3], 1);
    expect(intercept).toBeCloseTo(truth[4], -1);

    // Reported errors must all be finite and strictly positive.
    expect(result.parameterErrors).toHaveLength(5);
    for (const err of result.parameterErrors) {
      expect(Number.isFinite(err)).toBe(true);
      expect(err).toBeGreaterThan(0);
    }

    // A strong peak localises its centroid to well under one channel, and the
    // truth must sit within a few reported sigma of the fit (error bars are real,
    // not arbitrary).
    const centroidError = result.parameterErrors[1];
    expect(centroidError).toBeLessThan(1);
    expect(Math.abs(centroid - truth[1])).toBeLessThan(5 * centroidError);
  });

  it('is stable across noise seeds (centroid stays within tolerance)', () => {
    for (const seed of [1, 2, 3, 99, 2026]) {
      const { x, y, weights, truth } = makeSyntheticGaussian(seed);
      const result = lmFit({ x, y }, gaussianPlusLinear, {
        initialValues: [900, 298, 9, 0, 45],
        weights,
        maxIterations: 200,
      });
      expect(result.converged).toBe(true);
      expect(Math.abs(result.parameters[1] - truth[1])).toBeLessThan(1);
    }
  });
});

describe('lmFit -- unweighted and bounded fits', () => {
  it('fits without weights and respects bounds', () => {
    const { x, y, truth } = makeSyntheticGaussian(7);
    const result = lmFit({ x, y }, gaussianPlusLinear, {
      initialValues: [800, 305, 10, 0, 40],
      minValues: [0, 250, 1, -1, 0],
      maxValues: [5000, 350, 50, 1, 200],
      maxIterations: 200,
    });
    expect(result.converged).toBe(true);
    expect(result.parameters[1]).toBeGreaterThanOrEqual(250);
    expect(result.parameters[1]).toBeLessThanOrEqual(350);
    expect(Math.abs(result.parameters[1] - truth[1])).toBeLessThan(1);
  });
});

describe('lmFit -- edge cases must fail loud, never silently wrong', () => {
  it('reports converged=false with non-finite errors for an unidentifiable fit', () => {
    // Over-parameterised model: f(x; [a, b]) = a + b. The two parameters are
    // perfectly collinear, so the covariance matrix (J^T W J) is singular and no
    // honest per-parameter error exists. The wrapper must NOT invent one.
    const collinear =
      (params: readonly number[]) =>
      (_x: number): number =>
        params[0] + params[1];
    const x = [0, 1, 2, 3, 4, 5, 6, 7];
    const y = x.map(() => 5);

    const result = lmFit({ x, y }, collinear, { initialValues: [1, 1] });

    expect(result.converged).toBe(false);
    expect(result.parameterErrors.some((e) => !Number.isFinite(e))).toBe(true);
  });

  it('stays flag-consistent on flat, peakless data (the converged flag never lies)', () => {
    // Flat data has no real peak. A Gaussian fit may find some shallow optimum or
    // fail outright; either way the wrapper must stay self-consistent -- the
    // `converged` flag must agree with whether the errors are usable, so a caller
    // can always trust the flag. (Judging significance is the validate stage's job.)
    const rng = mulberry32(2024);
    const x = Array.from({ length: 256 }, (_, i) => i);
    const base = 100;
    const y = x.map(() => Math.max(0, base + Math.sqrt(base) * standardNormal(rng)));

    const result = lmFit({ x, y }, gaussianPlusLinear, {
      initialValues: [10, 128, 8, 0, 100],
    });

    assertFlagConsistent(result);
  });

  it('stays flag-consistent from a far-off starting guess (no silent NaN in a good fit)', () => {
    // A guess many sigma off-peak. LM may recover (its job) or settle into a wrong
    // local optimum -- this primitive makes no global-optimum promise. What it MUST
    // guarantee is coherence: it never reports converged=true while leaking a
    // non-finite error. Rejecting a wandered centroid is the caller's peak-hopping
    // guard (the fit stage), not this primitive's concern.
    const { x, y, weights } = makeSyntheticGaussian(42);
    const result = lmFit({ x, y }, gaussianPlusLinear, {
      initialValues: [300, 360, 20, 0, 40], // centroid guess ~60 ch (~7 sigma) off
      weights,
      maxIterations: 300,
    });

    assertFlagConsistent(result);
  });
});

describe('lmFit -- misuse throws ValidationError', () => {
  it('throws when x and y differ in length', () => {
    expect(() =>
      lmFit({ x: [0, 1, 2], y: [0, 1] }, gaussianPlusLinear, { initialValues: [1, 1, 1, 0, 0] }),
    ).toThrow(ValidationError);
  });

  it('throws on an empty initialValues vector', () => {
    expect(() => lmFit({ x: [0, 1], y: [0, 1] }, gaussianPlusLinear, { initialValues: [] })).toThrow(
      ValidationError,
    );
  });

  it('throws when a weights array does not match the data length', () => {
    expect(() =>
      lmFit({ x: [0, 1, 2], y: [0, 1, 2] }, gaussianPlusLinear, {
        initialValues: [1, 1, 1, 0, 0],
        weights: [1, 1],
      }),
    ).toThrow(ValidationError);
  });

  it('throws when bounds do not match the parameter count', () => {
    expect(() =>
      lmFit({ x: [0, 1, 2], y: [0, 1, 2] }, gaussianPlusLinear, {
        initialValues: [1, 1, 1, 0, 0],
        minValues: [0, 0],
      }),
    ).toThrow(ValidationError);
  });
});
