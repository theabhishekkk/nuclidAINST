/**
 * Numerical core -- small, shared dense linear-algebra kernels.
 *
 * Extracted so the covariance machinery is written ONCE and reused by every
 * least-squares primitive (lmFit's `Cov = s^2 * (J^T W J)^-1`, polyfit's
 * `Cov = s^2 * (A^T A)^-1`) rather than each module carrying its own copy of
 * Gauss-Jordan (RULEBOOK: no duplicated math).
 */

/** A pivot magnitude below this is treated as zero when inverting -- i.e. the
 * matrix is (numerically) singular and the system is unidentifiable. Matches the
 * singularity guard used in src/pipeline/calibrate.ts (1e-12). */
export const MATRIX_PIVOT_EPSILON = 1e-12;

/**
 * Invert an m x m matrix by Gauss-Jordan elimination with partial pivoting.
 *
 * Returns `null` (never a fabricated answer) if the matrix is singular -- a pivot
 * falls below {@link MATRIX_PIVOT_EPSILON} -- so the caller decides how to fail:
 * a covariance estimate returns "do not trust", a direct solve throws.
 *
 * NOTE on conditioning: this is a plain inverse with NO internal column scaling.
 * For a matrix whose columns span many orders of magnitude (e.g. a raw Vandermonde
 * Gram over channels in the thousands), the caller should column-normalise BEFORE
 * inverting and un-scale after, or precision is lost in the elimination.
 */
export function invertMatrix(a: readonly number[][], m: number): number[][] | null {
  const work = a.map((row) => row.slice());
  const inv = Array.from({ length: m }, (_, i) => {
    const row = new Array<number>(m).fill(0);
    row[i] = 1;
    return row;
  });
  for (let col = 0; col < m; col++) {
    let pivot = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(work[r][col]) > Math.abs(work[pivot][col])) pivot = r;
    }
    if (Math.abs(work[pivot][col]) < MATRIX_PIVOT_EPSILON) return null;
    [work[col], work[pivot]] = [work[pivot], work[col]];
    [inv[col], inv[pivot]] = [inv[pivot], inv[col]];
    const pv = work[col][col];
    for (let c = 0; c < m; c++) {
      work[col][c] /= pv;
      inv[col][c] /= pv;
    }
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const factor = work[r][col];
      if (factor === 0) continue;
      for (let c = 0; c < m; c++) {
        work[r][c] -= factor * work[col][c];
        inv[r][c] -= factor * inv[col][c];
      }
    }
  }
  return inv;
}
