/**
 * Signal core -- peak widths, matching `scipy.signal._peak_widths`
 * (the C routine behind `scipy.signal.peak_widths`) exactly.
 *
 * For each peak the evaluation height is
 *     height = x[peak] - prominence * relHeight
 * (relHeight 0.5 => width at half-prominence, i.e. FWHM). From the peak we walk
 * LEFT until a sample drops BELOW that height (bounded by the peak's left base),
 * then LINEARLY interpolate the sub-sample crossing -> leftIp; likewise to the
 * right -> rightIp. width = rightIp - leftIp.
 *
 * The prominence data may be supplied (as `find_peaks` does, reusing the
 * prominences it already computed); otherwise it is computed here with the full
 * array as the window (`wlen` unset), matching standalone `scipy.peak_widths`.
 *
 * General array-in / array-out; not spectroscopy-aware.
 */
import { ValidationError } from '../domain/errors';
import { peakProminences, type Prominences } from './peakProminences';

/** Default `rel_height`, matching the reference `peak_widths(..., rel_height=0.5)`. */
export const DEFAULT_REL_HEIGHT = 0.5;

export interface PeakWidthsResult {
  /** Width of each peak (rightIp - leftIp), in sample units. */
  widths: number[];
  /** The height at which each width was measured (x[peak] - prominence*relHeight). */
  widthHeights: number[];
  /** Sub-sample left intersection position of each width line. */
  leftIps: number[];
  /** Sub-sample right intersection position of each width line. */
  rightIps: number[];
}

/**
 * Calculate the width of each peak in `x`.
 *
 * @param x               the signal.
 * @param peaks           indices of peaks in `x`.
 * @param relHeight       relative height (of the prominence) at which the width is
 *                        measured; defaults to 0.5 (FWHM). Must be >= 0.
 * @param prominenceData  optional prominences/leftBases/rightBases (e.g. from
 *                        {@link peakProminences} or `find_peaks`). If omitted they
 *                        are computed here with the full array as the window.
 * @throws ValidationError on relHeight < 0, an out-of-bounds peak, or supplied
 *   prominence data that doesn't bracket a peak (`leftBase <= peak <= rightBase`).
 */
export function peakWidths(
  x: readonly number[],
  peaks: readonly number[],
  relHeight: number = DEFAULT_REL_HEIGHT,
  prominenceData?: Prominences,
): PeakWidthsResult {
  if (relHeight < 0) {
    throw new ValidationError(`peakWidths: relHeight must be >= 0; got ${relHeight}.`);
  }

  // Standalone behaviour: compute prominences with the full array as window.
  const prom = prominenceData ?? peakProminences(x, peaks);
  const { prominences, leftBases, rightBases } = prom;
  if (
    prominences.length !== peaks.length ||
    leftBases.length !== peaks.length ||
    rightBases.length !== peaks.length
  ) {
    throw new ValidationError('peakWidths: prominenceData length does not match peaks.');
  }

  const n = x.length;
  const widths = new Array<number>(peaks.length);
  const widthHeights = new Array<number>(peaks.length);
  const leftIps = new Array<number>(peaks.length);
  const rightIps = new Array<number>(peaks.length);

  for (let p = 0; p < peaks.length; p++) {
    const iMin = leftBases[p];
    const iMax = rightBases[p];
    const peak = peaks[p];
    // scipy guards 0 <= iMin <= peak <= iMax < n; a violation means the supplied
    // prominence data is inconsistent with `peaks` -- fail loud, never fabricate.
    if (!(0 <= iMin && iMin <= peak && peak <= iMax && iMax < n)) {
      throw new ValidationError(
        `peakWidths: peak ${peak} (entry ${p}) not bracketed by bases [${iMin}, ${iMax}] in length ${n}.`,
      );
    }

    const height = x[peak] - prominences[p] * relHeight;
    widthHeights[p] = height;

    // Left intersection: step left while strictly above `height` (bounded by base).
    let i = peak;
    while (iMin < i && height < x[i]) i -= 1;
    let leftIp = i;
    if (x[i] < height) {
      // The true crossing lies between samples i and i+1 -- interpolate.
      leftIp += (height - x[i]) / (x[i + 1] - x[i]);
    }

    // Right intersection: step right while strictly above `height`.
    i = peak;
    while (i < iMax && height < x[i]) i += 1;
    let rightIp = i;
    if (x[i] < height) {
      rightIp -= (height - x[i]) / (x[i - 1] - x[i]);
    }

    widths[p] = rightIp - leftIp;
    leftIps[p] = leftIp;
    rightIps[p] = rightIp;
  }

  return { widths, widthHeights, leftIps, rightIps };
}
