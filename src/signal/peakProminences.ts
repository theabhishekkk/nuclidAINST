/**
 * Signal core -- peak prominences, matching `scipy.signal._peak_prominences`
 * (the C routine behind `scipy.signal.peak_prominences`) exactly.
 *
 * The prominence of a peak is how far it rises above the higher of its two
 * "bases". For each peak we walk LEFT while samples stay <= the peak height
 * (stopping at a higher sample, the array boundary, or the optional `wlen`
 * window edge), tracking the minimum encountered -> that minimum is the left
 * base. We walk RIGHT the same way for the right base. Then
 *     prominence = x[peak] - max(left_min, right_min).
 *
 * General array-in / array-out; not spectroscopy-aware.
 */
import { ValidationError } from '../domain/errors';

export interface Prominences {
  /** Prominence of each peak, in the order `peaks` was given. */
  prominences: number[];
  /** Index of the left base (the minimum on the left walk) for each peak. */
  leftBases: number[];
  /** Index of the right base (the minimum on the right walk) for each peak. */
  rightBases: number[];
}

/**
 * Calculate the prominence of each peak in `x`.
 *
 * @param x      the signal.
 * @param peaks  indices of peaks in `x` (must be valid, in [0, x.length)).
 * @param wlen   optional window length bounding each base search. SciPy uses the
 *               full array when `wlen` is undefined or < 2; when >= 2 the window
 *               is `peak +/- wlen//2` (clipped to the array). A given `wlen` is
 *               rounded UP to the next integer, matching scipy's
 *               `_arg_wlen_as_expected` + the implicit odd-rounding in the C loop.
 * @throws ValidationError if a peak index is out of bounds, or `wlen` is given
 *   but <= 1 (matching scipy, which rejects `wlen <= 1`).
 */
export function peakProminences(
  x: readonly number[],
  peaks: readonly number[],
  wlen?: number,
): Prominences {
  const n = x.length;

  // Match scipy._arg_wlen_as_expected: undefined -> -1 (full array); >1 ->
  // ceil; <=1 -> error. The `2 <= wlen` gate below then decides if it applies.
  let wlenInternal: number;
  if (wlen === undefined) {
    wlenInternal = -1;
  } else if (wlen > 1) {
    wlenInternal = Math.ceil(wlen);
  } else {
    throw new ValidationError(`peakProminences: wlen must be larger than 1; got ${wlen}.`);
  }

  const prominences = new Array<number>(peaks.length);
  const leftBases = new Array<number>(peaks.length);
  const rightBases = new Array<number>(peaks.length);

  for (let pn = 0; pn < peaks.length; pn++) {
    const peak = peaks[pn];
    if (!Number.isInteger(peak) || peak < 0 || peak >= n) {
      throw new ValidationError(
        `peakProminences: peak index ${peak} (entry ${pn}) is out of bounds for length ${n}.`,
      );
    }

    let iMin = 0;
    let iMax = n - 1;
    if (wlenInternal >= 2) {
      // Window around the peak; an even wlen is implicitly rounded to odd here.
      iMin = Math.max(peak - Math.floor(wlenInternal / 2), iMin);
      iMax = Math.min(peak + Math.floor(wlenInternal / 2), iMax);
    }

    // Left base: scan from the peak while in window and <= peak height.
    let i = peak;
    leftBases[pn] = peak;
    let leftMin = x[peak];
    while (iMin <= i && x[i] <= x[peak]) {
      if (x[i] < leftMin) {
        leftMin = x[i];
        leftBases[pn] = i;
      }
      i -= 1;
    }

    // Right base: scan from the peak while in window and <= peak height.
    i = peak;
    rightBases[pn] = peak;
    let rightMin = x[peak];
    while (i <= iMax && x[i] <= x[peak]) {
      if (x[i] < rightMin) {
        rightMin = x[i];
        rightBases[pn] = i;
      }
      i += 1;
    }

    prominences[pn] = x[peak] - Math.max(leftMin, rightMin);
  }

  return { prominences, leftBases, rightBases };
}
