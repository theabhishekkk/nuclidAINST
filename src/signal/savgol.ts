/**
 * Signal core -- Savitzky-Golay smoothing, matching `scipy.signal.savgol_filter`
 * (mode "interp", deriv 0) exactly.
 *
 * A general array-in / array-out primitive (not spectroscopy-aware). SciPy's
 * actual implementation is the authority (RULEBOOK RISK-04: match the reference,
 * don't approximate), so this reproduces its two distinct computations:
 *
 *   1. INTERIOR points -- cross-correlate the signal with the SG smoothing
 *      coefficients. The coefficients are `savgol_coeffs(window, polyorder)`: the
 *      impulse response of a least-squares polynomial smoother, identical to
 *      scipy's `savgol_coeffs` (an under-determined min-norm solve, below).
 *
 *   2. EDGES -- the first and last `window // 2` samples. Mode "interp" does NOT
 *      mirror/pad; it fits ONE polynomial of degree `polyorder` to the first
 *      (resp. last) `window` samples and evaluates it at the edge positions. This
 *      mirrors scipy's `_fit_edges_polyfit` -> `np.polyfit` + `np.polyval`.
 *
 * NO CLIPPING. This matches RAW `savgol_filter`. The reference's `smooth_spectrum`
 * additionally clips negatives to 0; that clip belongs to C1's detection wrapper,
 * not this primitive (see HANDOFF_F2). Consequence: a per-source `net_smoothed`
 * fixture equals `clip(savitzkyGolay(net, 9, 3), 0, inf)`.
 *
 * NUMERICS. Two small linear-algebra problems, both solved here so the F1 numeric
 * modules stay untouched (this module only *imports* the shared matrix inverse):
 *   - `savgol_coeffs` solves an UNDER-determined system A c = y (A is
 *     (polyorder+1) x window, full row rank), whose unique minimum-norm solution
 *     is  c = Aᵀ (A Aᵀ)⁻¹ y. The (polyorder+1)-square system A Aᵀ is well
 *     conditioned and inverted with the shared Gauss-Jordan kernel.
 *   - the edge `polyfit` is an OVER-determined fit solved by column-scaled
 *     Householder QR (mirroring numpy's scaled `lstsq`), which is markedly more
 *     accurate near the 1e-9 tolerance than squaring the Vandermonde into normal
 *     equations would be.
 */
import { ValidationError } from '../domain/errors';
import { invertMatrix } from '../numeric/linalg';

/**
 * Savitzky-Golay smoothing filter (deriv 0, delta 1, mode "interp").
 *
 * @param x             input samples (length must be >= windowLength).
 * @param windowLength  length of the filter window; must be a positive ODD
 *                      integer and strictly greater than `polyorder`.
 * @param polyorder     order of the polynomial fit; integer in [0, windowLength).
 * @returns             the smoothed signal, same length as `x`.
 * @throws ValidationError on a non-odd / non-integer window, polyorder >= window,
 *   or (mode "interp") windowLength > x.length -- it never pads to fake an answer.
 */
export function savitzkyGolay(
  x: readonly number[],
  windowLength: number,
  polyorder: number,
): number[] {
  // --- fail loud on misuse (RULEBOOK RISK-01); mirror scipy's own checks ----
  if (!Number.isInteger(windowLength) || windowLength <= 0) {
    throw new ValidationError(
      `savitzkyGolay: windowLength must be a positive integer; got ${windowLength}.`,
    );
  }
  if (windowLength % 2 === 0) {
    throw new ValidationError(`savitzkyGolay: windowLength must be odd; got ${windowLength}.`);
  }
  if (!Number.isInteger(polyorder) || polyorder < 0) {
    throw new ValidationError(
      `savitzkyGolay: polyorder must be a non-negative integer; got ${polyorder}.`,
    );
  }
  if (polyorder >= windowLength) {
    throw new ValidationError(
      `savitzkyGolay: polyorder (${polyorder}) must be less than windowLength (${windowLength}).`,
    );
  }
  // mode "interp" cannot fit an edge polynomial to fewer than windowLength points.
  if (windowLength > x.length) {
    throw new ValidationError(
      `savitzkyGolay: mode "interp" requires windowLength (${windowLength}) <= input length (${x.length}).`,
    );
  }

  const n = x.length;
  const half = (windowLength - 1) / 2;
  const coeffs = savgolCoeffs(windowLength, polyorder);

  const out = new Array<number>(n);

  // --- interior: cross-correlate with the (symmetric) SG coefficients -------
  // out[i] = sum_j coeffs[j] * x[i - half + j], for i in [half, n - half).
  // (For the interior every index i-half..i+half is in bounds, so the boundary
  //  mode is irrelevant -- and the edges below are overwritten regardless.)
  for (let i = half; i < n - half; i++) {
    let acc = 0;
    const base = i - half;
    for (let j = 0; j < windowLength; j++) acc += coeffs[j] * x[base + j];
    out[i] = acc;
  }

  // --- edges: one polynomial fit per end, evaluated at the edge positions ---
  // Left  : fit poly to x[0 .. window-1] on abscissa 0..window-1, eval at 0..half-1.
  // Right : fit poly to x[n-window .. n-1] on abscissa 0..window-1, eval at
  //         window-half .. window-1 (which map to channels n-half .. n-1).
  fitEdge(x, 0, windowLength, 0, half, polyorder, out);
  fitEdge(x, n - windowLength, n, n - half, n, polyorder, out);

  return out;
}

/**
 * Savitzky-Golay convolution coefficients -- identical to
 * `scipy.signal.savgol_coeffs(windowLength, polyorder)` (deriv 0, delta 1,
 * default centred `pos`, `use="conv"`).
 *
 * Builds A[i][j] = pos_x[j]^i for i in 0..polyorder, where pos_x runs from
 * `half` down to `-half` (the `use="conv"` reversal of -half..half), and returns
 * the minimum-norm solution of A c = e0, i.e. c = Aᵀ (A Aᵀ)⁻¹ e0.
 */
function savgolCoeffs(windowLength: number, polyorder: number): number[] {
  const half = (windowLength - 1) / 2;
  const order = polyorder + 1;

  // pos_x reversed for use="conv": [half, half-1, ..., -half].
  const posX = new Array<number>(windowLength);
  for (let j = 0; j < windowLength; j++) posX[j] = half - j;

  // A: (order) x (windowLength), A[i][j] = posX[j]^i.
  const a = Array.from({ length: order }, () => new Array<number>(windowLength));
  for (let j = 0; j < windowLength; j++) {
    let pow = 1;
    for (let i = 0; i < order; i++) {
      a[i][j] = pow;
      pow *= posX[j];
    }
  }

  // Gram of rows: AAt[i][k] = sum_j A[i][j] * A[k][j]  (order x order, SPD).
  const aat = Array.from({ length: order }, () => new Array<number>(order).fill(0));
  for (let i = 0; i < order; i++) {
    for (let k = i; k < order; k++) {
      let s = 0;
      for (let j = 0; j < windowLength; j++) s += a[i][j] * a[k][j];
      aat[i][k] = s;
      aat[k][i] = s;
    }
  }

  const aatInv = invertMatrix(aat, order);
  if (aatInv === null) {
    // Cannot occur for a valid (odd window > polyorder) grid, but never fabricate.
    throw new ValidationError(
      `savitzkyGolay: degenerate coefficient system (window ${windowLength}, polyorder ${polyorder}).`,
    );
  }

  // y = e0 (deriv 0). t = (A Aᵀ)⁻¹ y = first column of the inverse.
  // c = Aᵀ t  =>  c[j] = sum_i A[i][j] * t[i].
  const t = new Array<number>(order);
  for (let i = 0; i < order; i++) t[i] = aatInv[i][0];

  const c = new Array<number>(windowLength);
  for (let j = 0; j < windowLength; j++) {
    let s = 0;
    for (let i = 0; i < order; i++) s += a[i][j] * t[i];
    c[j] = s;
  }
  return c;
}

/**
 * Fit a degree-`polyorder` polynomial to x[windowStart .. windowStop) on abscissa
 * 0,1,...,(windowStop-windowStart-1) and write its values at the channels
 * [interpStart, interpStop) into `out`. Mirrors scipy's `_fit_edge` (deriv 0).
 */
function fitEdge(
  x: readonly number[],
  windowStart: number,
  windowStop: number,
  interpStart: number,
  interpStop: number,
  polyorder: number,
  out: number[],
): void {
  const m = windowStop - windowStart; // == windowLength
  const order = polyorder + 1;

  // Vandermonde, highest power first (np.polyfit / np.vander convention):
  // V[r][c] = r^(polyorder - c), r = 0..m-1.
  const v = Array.from({ length: m }, () => new Array<number>(order));
  for (let r = 0; r < m; r++) {
    let pow = 1;
    for (let c = order - 1; c >= 0; c--) {
      v[r][c] = pow;
      pow *= r;
    }
  }
  const yb = new Array<number>(m);
  for (let r = 0; r < m; r++) yb[r] = x[windowStart + r];

  const coeffs = polyfitScaledQR(v, yb, order); // highest power first

  // Evaluate (Horner) at each edge position and store.
  for (let p = interpStart; p < interpStop; p++) {
    const pos = p - windowStart;
    let acc = 0;
    for (let c = 0; c < order; c++) acc = acc * pos + coeffs[c];
    out[p] = acc;
  }
}

/**
 * Least-squares solve of the over-determined Vandermonde system V c ~= y, using
 * numpy's `polyfit` recipe: column-scale V by each column's L2 norm, solve the
 * scaled system by Householder QR, then un-scale. QR (an orthogonal factorisation)
 * preserves the conditioning, unlike forming the normal equations VᵀV.
 */
function polyfitScaledQR(v: number[][], y: readonly number[], order: number): number[] {
  const m = v.length;

  // Column scale = L2 norm of each Vandermonde column (numpy's `scale`).
  const scale = new Array<number>(order).fill(0);
  for (let c = 0; c < order; c++) {
    let s = 0;
    for (let r = 0; r < m; r++) s += v[r][c] * v[r][c];
    scale[c] = s > 0 ? Math.sqrt(s) : 1;
  }

  // Working copies: R = V / scale, qtb = y. Householder QR in place.
  const r = Array.from({ length: m }, (_, i) => {
    const row = new Array<number>(order);
    for (let c = 0; c < order; c++) row[c] = v[i][c] / scale[c];
    return row;
  });
  const qtb = y.slice();

  const vk = new Array<number>(m);
  for (let k = 0; k < order; k++) {
    // Householder vector zeroing R[k+1.., k]: alpha = -sign(R[k][k]) * ||col||.
    let norm = 0;
    for (let i = k; i < m; i++) norm += r[i][k] * r[i][k];
    norm = Math.sqrt(norm);
    if (norm === 0) continue; // column already zero (cannot happen for full-rank V)
    if (r[k][k] < 0) norm = -norm;
    for (let i = k; i < m; i++) vk[i] = r[i][k];
    vk[k] += norm;
    let vtv = 0;
    for (let i = k; i < m; i++) vtv += vk[i] * vk[i];
    if (vtv === 0) continue;

    // Apply H = I - 2 v vᵀ / (vᵀv) to the remaining columns of R and to qtb.
    for (let c = k; c < order; c++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += vk[i] * r[i][c];
      const f = (2 * dot) / vtv;
      for (let i = k; i < m; i++) r[i][c] -= f * vk[i];
    }
    let dotb = 0;
    for (let i = k; i < m; i++) dotb += vk[i] * qtb[i];
    const fb = (2 * dotb) / vtv;
    for (let i = k; i < m; i++) qtb[i] -= fb * vk[i];
  }

  // Back-substitute the upper-triangular R[0..order, 0..order] c_scaled = qtb.
  const cScaled = new Array<number>(order).fill(0);
  for (let i = order - 1; i >= 0; i--) {
    let s = qtb[i];
    for (let j = i + 1; j < order; j++) s -= r[i][j] * cScaled[j];
    cScaled[i] = s / r[i][i];
  }

  // Un-scale: c[c] = c_scaled[c] / scale[c].
  const c = new Array<number>(order);
  for (let k = 0; k < order; k++) c[k] = cScaled[k] / scale[k];
  return c;
}
