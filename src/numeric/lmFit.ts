/**
 * Numerical core -- nonlinear least-squares via Levenberg-Marquardt (LM).
 *
 * A thin, project-owned wrapper over `ml-levenberg-marquardt`. The rest of the
 * codebase imports THIS module, never the library directly, so the dependency
 * stays swappable and every call site speaks one stable, general interface.
 *
 * What the primitive does: given (x, y) samples and a parametric model
 *     y ~= model(params)(x)
 * it finds the parameter vector that minimises the (optionally weighted) sum of
 * squared residuals, and reports a 1-sigma uncertainty for each parameter. The
 * model is arbitrary -- a Gaussian is just one caller; nothing here is
 * peak-shaped (RISK-02, element-agnostic).
 *
 * Why this wrapper computes its OWN parameter errors:
 *   `ml-levenberg-marquardt` (5.x) returns a single scalar `parameterError` --
 *   the weighted residual sum of squares at the optimum -- NOT a per-parameter
 *   uncertainty, and it exposes no covariance. To hand the caller an honest
 *   1-sigma per parameter we derive the parameter covariance here, the same way
 *   `scipy.optimize.curve_fit` does:
 *       Cov = s^2 * (J^T W J)^-1 ,   s^2 = (sum_i w_i r_i^2) / (n - p)
 *   where J is the Jacobian of `model` at the solution (central differences),
 *   W = diag(w_i) the inverse-variance weights, r_i the residuals, n the number
 *   of points and p the number of parameters. parameterErrors[k] is the square
 *   root of the k-th diagonal entry of Cov. s^2 is the reduced chi-square, so an
 *   over- or under-estimated weight scale cancels out -- matching scipy's default
 *   (absolute_sigma = false). Copying the library's scalar into every slot would
 *   be a plausible-but-wrong answer, which the RULEBOOK forbids.
 *
 * Fail loud, never fake (RULEBOOK RISK-01 / RISK-04):
 *   - Misuse -- mismatched x/y lengths, empty initialValues, wrong-length bounds
 *     or weights -- throws `ValidationError`. A programming error is surfaced
 *     loudly, not absorbed.
 *   - A fit that RAN but cannot be trusted -- non-finite parameters, or a singular
 *     / non-positive covariance (e.g. a Gaussian fitted to flat data, where the
 *     centroid and width are unidentifiable) -- returns `converged: false` with
 *     non-finite `parameterErrors`, so a careless caller that ignores the flag
 *     still cannot read a fake small uncertainty as a real one.
 *
 * Conventions:
 *   - `weights[i]` is the reciprocal standard deviation 1/sigma_i (the same
 *     meaning ml-levenberg-marquardt gives it). The inverse-variance weight used
 *     internally is therefore w_i = weights[i]^2. For Poisson counts, the natural
 *     choice is weights[i] = 1 / sqrt(y_i).
 *   - All thresholds are named, documented constants (PORTING_PLAN convention).
 */
import { levenbergMarquardt } from 'ml-levenberg-marquardt';
import type { LevenbergMarquardtOptions } from 'ml-levenberg-marquardt';
import { ValidationError } from '../domain/errors';
import { invertMatrix } from './linalg';

// --- tuning constants -------------------------------------------------------

/** ml-levenberg-marquardt default: max LM iterations before the solver stops. */
const DEFAULT_MAX_ITERATIONS = 100;

/** ml-levenberg-marquardt default LM damping (lambda). Small lambda -> Gauss-Newton
 * steps; large lambda -> gradient-descent steps. */
const DEFAULT_DAMPING = 1e-2;

/** Relative step for the central-difference Jacobian:
 * h_k = JACOBIAN_RELATIVE_STEP * max(|p_k|, 1). Near the cube root of machine
 * epsilon, the sweet spot for central differences. */
const JACOBIAN_RELATIVE_STEP = 1e-6;

// --- public interface -------------------------------------------------------

export interface LmFitResult {
  /** Best-fit parameter values, in the order given by `initialValues`. */
  readonly parameters: number[];
  /** 1-sigma uncertainty per parameter (sqrt of the covariance diagonal).
   * NaN entries appear when `converged` is false. */
  readonly parameterErrors: number[];
  /** Number of LM iterations actually run. */
  readonly iterations: number;
  /**
   * True only when the fit is mathematically self-consistent: all parameters
   * finite AND a well-defined (non-singular, positive) covariance, so the
   * reported `parameterErrors` are all finite. `false` => the caller MUST treat
   * the result as a failed fit, not a guess (the errors will contain NaN).
   *
   * IMPORTANT -- this is NOT a claim that the GLOBAL optimum was found. Like any
   * local optimiser, LM can settle into a wrong local minimum (e.g. from a
   * far-off starting guess) and still report `converged: true` with finite local
   * error bars. Detecting that -- a fit whose centroid has wandered out of its
   * expected window -- needs domain knowledge the solver does not have, and is
   * the caller's job (the peak-hopping guard in the fit stage). Feed a sensible
   * starting guess and, where appropriate, bounds.
   */
  readonly converged: boolean;
}

export interface LmFitOptions {
  /** Starting parameter vector. Its length defines the parameter count p. */
  readonly initialValues: readonly number[];
  /** Optional lower bounds, one per parameter (length must equal p). */
  readonly minValues?: readonly number[];
  /** Optional upper bounds, one per parameter (length must equal p). */
  readonly maxValues?: readonly number[];
  /** Per-point weight = 1/sigma_i, or a single scalar applied to all points.
   * Omit for an unweighted fit (sigma = 1). An array must have one entry per
   * data point. */
  readonly weights?: number | readonly number[];
  /** Maximum LM iterations (default {@link DEFAULT_MAX_ITERATIONS}). */
  readonly maxIterations?: number;
  /** LM damping lambda (default {@link DEFAULT_DAMPING}). */
  readonly damping?: number;
}

/** Fit y ~= model(params)(x) by Levenberg-Marquardt and report per-parameter
 * 1-sigma errors. See the file header for the covariance derivation and the
 * fail-loud contract. */
export function lmFit(
  data: { readonly x: readonly number[]; readonly y: readonly number[] },
  model: (params: readonly number[]) => (x: number) => number,
  options: LmFitOptions,
): LmFitResult {
  const { x, y } = data;
  const n = x.length;
  const p = options.initialValues.length;

  // --- fail loud on misuse -------------------------------------------------
  if (n !== y.length) {
    throw new ValidationError(
      `lmFit: x and y must have the same length (got ${n} and ${y.length}).`,
    );
  }
  if (n < 2) {
    throw new ValidationError(`lmFit: need at least 2 data points; got ${n}.`);
  }
  if (p < 1) {
    throw new ValidationError('lmFit: initialValues must contain at least one parameter.');
  }
  if (options.minValues && options.minValues.length !== p) {
    throw new ValidationError(
      `lmFit: minValues length ${options.minValues.length} != parameter count ${p}.`,
    );
  }
  if (options.maxValues && options.maxValues.length !== p) {
    throw new ValidationError(
      `lmFit: maxValues length ${options.maxValues.length} != parameter count ${p}.`,
    );
  }
  if (Array.isArray(options.weights) && options.weights.length !== n) {
    throw new ValidationError(
      `lmFit: weights array length ${options.weights.length} != data point count ${n}.`,
    );
  }

  // --- run the LM solver ---------------------------------------------------
  const lmOptions: LevenbergMarquardtOptions = {
    initialValues: options.initialValues,
    maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    damping: options.damping ?? DEFAULT_DAMPING,
  };
  if (options.minValues !== undefined) lmOptions.minValues = options.minValues;
  if (options.maxValues !== undefined) lmOptions.maxValues = options.maxValues;
  if (options.weights !== undefined) lmOptions.weights = options.weights;

  // The library hands the parameter array (a plain number[]) to the model on
  // every evaluation; our model only reads it.
  const parameterizedFunction = (params: number[]): ((x: number) => number) => model(params);
  const lm = levenbergMarquardt({ x, y }, parameterizedFunction, lmOptions);
  const parameters = lm.parameterValues;

  // --- per-parameter 1-sigma errors via the parameter covariance -----------
  const inverseVariance = resolveInverseVariance(options.weights, n);
  const { parameterErrors, covarianceOk } = estimateParameterErrors(
    x,
    y,
    model,
    parameters,
    inverseVariance,
    n,
    p,
  );

  const converged = parameters.every((v) => Number.isFinite(v)) && covarianceOk;
  return { parameters, parameterErrors, iterations: lm.iterations, converged };
}

// --- covariance estimation --------------------------------------------------

/** Map the user's weights (= 1/sigma_i) onto inverse-variance weights w_i =
 * weights[i]^2 -- the same effective weighting the library minimises. */
function resolveInverseVariance(
  weights: number | readonly number[] | undefined,
  n: number,
): number[] {
  if (weights === undefined) return new Array<number>(n).fill(1);
  if (typeof weights === 'number') {
    const w = weights * weights;
    return new Array<number>(n).fill(w);
  }
  // Array length already validated to equal n by the caller.
  return weights.map((wi) => wi * wi);
}

interface ErrorEstimate {
  readonly parameterErrors: number[];
  readonly covarianceOk: boolean;
}

/** All-NaN errors with covarianceOk = false: the honest "do not trust" result. */
function failedEstimate(p: number): ErrorEstimate {
  return { parameterErrors: new Array<number>(p).fill(NaN), covarianceOk: false };
}

function estimateParameterErrors(
  x: readonly number[],
  y: readonly number[],
  model: (params: readonly number[]) => (x: number) => number,
  parameters: readonly number[],
  inverseVariance: readonly number[],
  n: number,
  p: number,
): ErrorEstimate {
  const dof = n - p;

  // Residuals and the weighted residual sum of squares at the optimum.
  const f = model(parameters);
  let weightedSSR = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - f(x[i]);
    weightedSSR += inverseVariance[i] * r * r;
  }
  // Need at least one degree of freedom to estimate a variance, and a finite SSR.
  if (dof <= 0 || !Number.isFinite(weightedSSR)) return failedEstimate(p);

  const jacobian = buildJacobian(x, model, parameters, n, p);
  if (jacobian === null) return failedEstimate(p);

  // H = J^T W J (p x p, symmetric). Fill the upper triangle, then mirror.
  const h = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < n; i++) {
    const wi = inverseVariance[i];
    const row = jacobian[i];
    for (let a = 0; a < p; a++) {
      const wJa = wi * row[a];
      for (let b = a; b < p; b++) h[a][b] += wJa * row[b];
    }
  }
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < a; b++) h[a][b] = h[b][a];
  }

  const cov = invertMatrix(h, p);
  if (cov === null) return failedEstimate(p);

  const reducedChiSquare = weightedSSR / dof;
  const parameterErrors = new Array<number>(p);
  let covarianceOk = true;
  for (let k = 0; k < p; k++) {
    const variance = reducedChiSquare * cov[k][k];
    if (!Number.isFinite(variance) || variance < 0) {
      parameterErrors[k] = NaN;
      covarianceOk = false;
    } else {
      parameterErrors[k] = Math.sqrt(variance);
    }
  }
  return { parameterErrors, covarianceOk };
}

/** Jacobian J[i][k] = d model / d p_k at x_i, by central differences. Returns
 * null if any partial derivative is non-finite. */
function buildJacobian(
  x: readonly number[],
  model: (params: readonly number[]) => (x: number) => number,
  parameters: readonly number[],
  n: number,
  p: number,
): number[][] | null {
  const jacobian = Array.from({ length: n }, () => new Array<number>(p));
  const forward = parameters.slice();
  const backward = parameters.slice();
  for (let k = 0; k < p; k++) {
    const h = JACOBIAN_RELATIVE_STEP * Math.max(Math.abs(parameters[k]), 1);
    forward[k] = parameters[k] + h;
    backward[k] = parameters[k] - h;
    const fForward = model(forward);
    const fBackward = model(backward);
    const inv2h = 1 / (2 * h);
    for (let i = 0; i < n; i++) {
      const d = (fForward(x[i]) - fBackward(x[i])) * inv2h;
      if (!Number.isFinite(d)) return null;
      jacobian[i][k] = d;
    }
    // Restore for the next parameter.
    forward[k] = parameters[k];
    backward[k] = parameters[k];
  }
  return jacobian;
}
