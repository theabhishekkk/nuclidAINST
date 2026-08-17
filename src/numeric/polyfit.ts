/**
 * Numerical core -- weighted polynomial least-squares with coefficient covariance.
 *
 * A general (any-degree) primitive that fits
 *     y ~= c[0]*x^degree + c[1]*x^(degree-1) + ... + c[degree]
 * minimising the WEIGHTED sum of squared residuals and reporting the full
 * coefficient covariance matrix plus the usual (unweighted) fit metrics.
 *
 * Full-fidelity port of the reference `weighted_polyfit()` / `PolyFit` dataclass
 * (Energy Calibration Equation/Version 3/energy_calibration.py), which is
 *     coeffs, cov = np.polyfit(x, y, degree, w=weights, cov=True)
 * The point of this module is to match numpy's conventions exactly, not to look
 * plausible (RULEBOOK RISK-04). Specifically:
 *
 *   1. WEIGHTING. numpy minimises  sum_i (w_i * r_i)^2 , i.e. the weight scales
 *      the RESIDUAL (entering the normal equations as w_i^2). We build the
 *      Vandermonde design matrix, scale each row i and the matching y_i by w_i,
 *      and solve that least-squares system. (We do NOT pre-square the weights.)
 *
 *   2. COVARIANCE. With cov=True numpy returns  inv(A^T A) * fac , where A is the
 *      ROW-WEIGHTED Vandermonde and
 *          fac = ss_res_weighted / (N - degree - 1),
 *          ss_res_weighted = sum_i (w_i * r_i)^2 .
 *      This is exactly the `Cov = s^2 * (J^T W J)^-1` formula lmFit already uses
 *      (here J = the unweighted Vandermonde, W = diag(w_i^2), and `fac` is the
 *      reduced chi-square s^2). The matrix inverse is the shared Gauss-Jordan
 *      kernel in ./linalg -- not a second copy. numpy requires N > degree + 1 to
 *      form `fac`; fewer points cannot yield an honest covariance, so we throw
 *      ValidationError rather than return a bogus one.
 *
 *   3. METRICS use UNWEIGHTED residuals (r_i = y_i - predict(x_i)): rms, max
 *      absolute residual and r^2 are reported on the raw scale even though the
 *      fit itself is weighted -- matching the reference exactly.
 *
 * Numerical note: a raw Vandermonde Gram matrix over channels in the thousands is
 * badly conditioned. We column-normalise the design matrix before inverting and
 * un-scale after (the same trick numpy uses internally), so the shared inverse
 * operates on a well-scaled, unit-diagonal matrix.
 *
 * This primitive is element-agnostic and not calibration-aware: it knows nothing
 * about channels or energy. Wiring it into the calibration stage is C3.
 */
import { ValidationError } from '../domain/errors';
import { invertMatrix } from './linalg';

// --- documented constants ---------------------------------------------------

/**
 * Floor (in the units of the centroid error) the CALLER clamps centroid errors to
 * before forming weights: `weights[i] = 1 / clip(centroidErr[i], CENTROID_ERR_FLOOR, Inf)`.
 * It guards against a zero/absurdly-small error producing an infinite weight that
 * would let one point dominate the fit. Mirrors the reference's `np.clip(err, 1e-3, None)`.
 *
 * `weightedPolyfit` receives the already-formed `weights`; this constant documents
 * (and will be reused by) the C3 calibration caller and the ground-truth fixture
 * generator so the convention lives in exactly one place.
 */
export const CENTROID_ERR_FLOOR = 1e-3;

// --- public interface -------------------------------------------------------

export interface PolyFitResult {
  /**
   * Best-fit coefficients, HIGHEST power first (the np.polyfit convention):
   * degree 2 => [c2, c1, c0] for y = c2*x^2 + c1*x + c0. So coeffs[0] is always
   * the leading (highest-power) term and coeffs[degree] the constant term.
   */
  readonly coeffs: number[];
  /** (degree+1) x (degree+1) coefficient covariance matrix, indexed in the same
   * highest-power-first order as `coeffs` (covariance[0][0] is the variance of the
   * leading term). */
  readonly covariance: number[][];
  /** sqrt(mean(r^2)) over the UNWEIGHTED residuals r_i = y_i - predict(x_i). */
  readonly rms: number;
  /** max(|r_i|) over the UNWEIGHTED residuals. */
  readonly maxAbsResidual: number;
  /** 1 - ss_res/ss_tot on the UNWEIGHTED residuals; NaN when ss_tot == 0 (all y equal). */
  readonly r2: number;
  /** Polynomial degree of the fit. */
  readonly degree: number;
  /** Evaluate the fitted polynomial at x (== np.polyval(coeffs, x), Horner). */
  predict(x: number): number;
  /**
   * Significance of the leading (curvature) term: how many sigma the highest-power
   * coefficient sits from zero. `degree < 2 => 0` (a line has no curvature term);
   * otherwise `|coeffs[0]| / sqrt(|covariance[0][0]|)`, and `+Infinity` if that
   * denominator is 0 (an exact fit, zero covariance). Drives the linear-vs-quadratic
   * model choice in C3. Matches the reference `curvature_significance()`.
   */
  curvatureSignificance(): number;
}

/**
 * Weighted polynomial least-squares.
 *
 * @param x        sample abscissae (e.g. MCA channels)
 * @param y        sample ordinates (e.g. energies, keV)
 * @param weights  per-point weight w_i = 1/sigma_i (the reference forms these as
 *                 `1 / clip(centroidErr, CENTROID_ERR_FLOOR, Inf)`). The fit
 *                 minimises sum_i (w_i * (y_i - poly(x_i)))^2. Must be finite & > 0.
 * @param degree   polynomial degree (>= 1; 1 = linear, 2 = quadratic, ...).
 *
 * @throws ValidationError on misuse (mismatched lengths, bad degree, non-finite or
 *   non-positive inputs) or when there are too few points for an honest covariance
 *   (N <= degree + 1), or when the system is singular (collinear/degenerate data).
 */
export function weightedPolyfit(
  x: readonly number[],
  y: readonly number[],
  weights: readonly number[],
  degree: number,
): PolyFitResult {
  const n = x.length;
  const order = degree + 1; // number of coefficients

  // --- fail loud on misuse (RULEBOOK RISK-01) ------------------------------
  if (!Number.isInteger(degree) || degree < 1) {
    throw new ValidationError(`weightedPolyfit: degree must be an integer >= 1; got ${degree}.`);
  }
  if (y.length !== n || weights.length !== n) {
    throw new ValidationError(
      `weightedPolyfit: x, y and weights must have equal length (got ${n}, ${y.length}, ${weights.length}).`,
    );
  }
  // numpy cov=True needs N > degree + 1 to scale the covariance; fewer points
  // cannot give an honest covariance, so refuse rather than fabricate one.
  if (n <= order) {
    throw new ValidationError(
      `weightedPolyfit: need more than ${order} points for a degree-${degree} covariance; got ${n}.`,
    );
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) {
      throw new ValidationError(
        `weightedPolyfit: non-finite data at index ${i} (x=${x[i]}, y=${y[i]}).`,
      );
    }
    if (!Number.isFinite(weights[i]) || weights[i] <= 0) {
      throw new ValidationError(
        `weightedPolyfit: weights must be finite and > 0; got ${weights[i]} at index ${i}.`,
      );
    }
  }

  // --- build the row-weighted Vandermonde design matrix --------------------
  // A[i][j] = w_i * x_i^(degree - j), highest power first (column 0 = x^degree).
  // b[i]    = w_i * y_i.  Solving A c = b in least-squares minimises sum (w_i r_i)^2.
  const a = Array.from({ length: n }, () => new Array<number>(order));
  const b = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const wi = weights[i];
    // Fill from the constant term (lowest power) up, so column `order-1` is x^0.
    let pow = 1;
    for (let j = order - 1; j >= 0; j--) {
      a[i][j] = wi * pow;
      pow *= x[i];
    }
    b[i] = wi * y[i];
  }

  // --- normal equations, column-scaled for conditioning --------------------
  // gram = A^T A (== J^T W J), grad = A^T b (== J^T W y).
  const gram = Array.from({ length: order }, () => new Array<number>(order).fill(0));
  const grad = new Array<number>(order).fill(0);
  for (let i = 0; i < n; i++) {
    const row = a[i];
    const bi = b[i];
    for (let p = 0; p < order; p++) {
      const rp = row[p];
      grad[p] += rp * bi;
      for (let q = p; q < order; q++) gram[p][q] += rp * row[q];
    }
  }
  for (let p = 0; p < order; p++) {
    for (let q = 0; q < p; q++) gram[p][q] = gram[q][p];
  }

  // Column scale = sqrt of each Gram diagonal = norm of each weighted Vandermonde
  // column (exactly numpy's `scale`). Normalise the system, invert the well-scaled
  // matrix with the shared kernel, then un-scale.
  const scale = new Array<number>(order);
  for (let p = 0; p < order; p++) {
    const d = gram[p][p];
    scale[p] = d > 0 ? Math.sqrt(d) : 1; // a zero column can only arise from x === 0 everywhere
  }
  const scaledGram = Array.from({ length: order }, (_, p) =>
    Array.from({ length: order }, (_, q) => gram[p][q] / (scale[p] * scale[q])),
  );
  const scaledInv = invertMatrix(scaledGram, order);
  if (scaledInv === null) {
    throw new ValidationError(
      `weightedPolyfit: design matrix is singular for a degree-${degree} fit (collinear or degenerate points?).`,
    );
  }

  // Solve in scaled space: c_scaled = scaledInv * (A^T b / scale); then c = c_scaled / scale.
  const scaledGrad = grad.map((g, p) => g / scale[p]);
  const coeffs = new Array<number>(order);
  for (let p = 0; p < order; p++) {
    let s = 0;
    for (let q = 0; q < order; q++) s += scaledInv[p][q] * scaledGrad[q];
    coeffs[p] = s / scale[p];
  }

  // Un-scaled inverse of the Gram matrix: inv(A^T A)[p][q] = scaledInv[p][q] / (scale[p] scale[q]).
  const gramInv = Array.from({ length: order }, (_, p) =>
    Array.from({ length: order }, (_, q) => scaledInv[p][q] / (scale[p] * scale[q])),
  );

  // --- residuals, metrics and covariance scaling ---------------------------
  // Metrics use UNWEIGHTED residuals; the covariance scale uses WEIGHTED ones.
  const predict = (xi: number): number => {
    let acc = 0;
    for (let p = 0; p < order; p++) acc = acc * xi + coeffs[p];
    return acc;
  };

  let meanY = 0;
  for (let i = 0; i < n; i++) meanY += y[i];
  meanY /= n;

  let ssResUnweighted = 0;
  let ssResWeighted = 0;
  let maxAbsResidual = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - predict(x[i]);
    ssResUnweighted += r * r;
    const wr = weights[i] * r;
    ssResWeighted += wr * wr;
    const absR = Math.abs(r);
    if (absR > maxAbsResidual) maxAbsResidual = absR;
    const dy = y[i] - meanY;
    ssTot += dy * dy;
  }

  const fac = ssResWeighted / (n - order); // numpy fac = ss_res_weighted / (N - degree - 1)
  const covariance = gramInv.map((rowP) => rowP.map((v) => v * fac));

  const rms = Math.sqrt(ssResUnweighted / n);
  const r2 = ssTot > 0 ? 1 - ssResUnweighted / ssTot : NaN;

  const curvatureSignificance = (): number => {
    if (degree < 2) return 0;
    const sigma = Math.sqrt(Math.abs(covariance[0][0]));
    return sigma > 0 ? Math.abs(coeffs[0]) / sigma : Infinity;
  };

  return {
    coeffs,
    covariance,
    rms,
    maxAbsResidual,
    r2,
    degree,
    predict,
    curvatureSignificance,
  };
}
