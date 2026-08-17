/**
 * Signal core -- `find_peaks`, matching `scipy.signal.find_peaks` exactly for the
 * subset the detection pipeline uses: prominence, distance and width filters.
 *
 * The ORDER of operations matters and is reproduced precisely (scipy applies the
 * filters in this fixed sequence regardless of argument order):
 *
 *   1. LOCAL MAXIMA   -- `_local_maxima_1d`: a sample strictly greater than both
 *      neighbours; for a flat plateau the reported index is the plateau MIDPOINT
 *      (floor). First and last samples are never peaks.
 *   2. DISTANCE       -- `_select_by_peak_distance`: keep peaks by priority
 *      (tallest first); using `distance_ = ceil(distance)`, remove any not-yet
 *      -removed peak within `distance_` samples of a kept taller peak.
 *   3. PROMINENCE     -- `_peak_prominences` (full array unless `wlen` given),
 *      then keep peaks whose prominence is in range.
 *   4. WIDTH          -- `_peak_widths` at `relHeight` (0.5) USING THE PROMINENCE
 *      DATA FROM STEP 3 (not recomputed), then keep peaks whose width is in range.
 *
 * `height`, `threshold` and `plateau_size` filters are intentionally omitted: the
 * reference's `detect_candidates` uses only prominence/distance/width.
 *
 * General array-in / array-out; not spectroscopy-aware.
 */
import { ValidationError } from '../domain/errors';
import { peakProminences } from './peakProminences';
import { peakWidths, DEFAULT_REL_HEIGHT } from './peakWidths';

/** An inclusive [min, max] interval; `max` may be `null` for "no upper bound". */
type Interval = number | [number, number | null];

export interface FindPeaksOptions {
  /** Required minimum (and optional maximum) prominence. */
  prominence?: Interval;
  /** Minimum spacing (in samples) between kept peaks; tallest wins. Must be >= 1. */
  distance?: number;
  /** Required minimum (and optional maximum) width, measured at `relHeight`. */
  width?: Interval;
  /** Window bounding the prominence base search (scipy `wlen`). Default: full array. */
  wlen?: number;
  /** Relative height for the width measurement (scipy `rel_height`). Default 0.5. */
  relHeight?: number;
}

export interface FindPeaksResult {
  /** The surviving peak indices, ascending. */
  peaks: number[];
  /** Properties scipy computes alongside the peaks, aligned with `peaks`. Each is
   * present only if the corresponding filter ran (prominence/width requested). */
  properties: {
    prominences?: number[];
    leftBases?: number[];
    rightBases?: number[];
    widths?: number[];
    widthHeights?: number[];
    leftIps?: number[];
    rightIps?: number[];
  };
}

/**
 * Find peaks in `x`, filtered by prominence, distance and/or width.
 *
 * @throws ValidationError if `distance` is given and < 1 (matching scipy).
 */
export function findPeaks(x: readonly number[], opts: FindPeaksOptions = {}): FindPeaksResult {
  const { prominence, distance, width, wlen, relHeight = DEFAULT_REL_HEIGHT } = opts;

  if (distance !== undefined && distance < 1) {
    throw new ValidationError(`findPeaks: distance must be >= 1; got ${distance}.`);
  }

  // 1. Local maxima (plateau midpoints).
  let peaks = localMaxima1d(x);

  // 2. Distance filter.
  if (distance !== undefined) {
    const keep = selectByPeakDistance(
      peaks,
      peaks.map((p) => x[p]),
      distance,
    );
    peaks = peaks.filter((_, i) => keep[i]);
  }

  const properties: FindPeaksResult['properties'] = {};

  // 3. Prominence (computed if prominence OR width requested; filtered if requested).
  if (prominence !== undefined || width !== undefined) {
    const prom = peakProminences(x, peaks, wlen);
    properties.prominences = prom.prominences;
    properties.leftBases = prom.leftBases;
    properties.rightBases = prom.rightBases;

    if (prominence !== undefined) {
      const [pmin, pmax] = unpackCondition(prominence);
      const keep = selectByProperty(prom.prominences, pmin, pmax);
      peaks = peaks.filter((_, i) => keep[i]);
      properties.prominences = prom.prominences.filter((_, i) => keep[i]);
      properties.leftBases = prom.leftBases.filter((_, i) => keep[i]);
      properties.rightBases = prom.rightBases.filter((_, i) => keep[i]);
    }
  }

  // 4. Width -- reuses the (already-filtered) prominence data from step 3.
  if (width !== undefined) {
    const widthsRes = peakWidths(x, peaks, relHeight, {
      prominences: properties.prominences!,
      leftBases: properties.leftBases!,
      rightBases: properties.rightBases!,
    });
    properties.widths = widthsRes.widths;
    properties.widthHeights = widthsRes.widthHeights;
    properties.leftIps = widthsRes.leftIps;
    properties.rightIps = widthsRes.rightIps;

    const [wmin, wmax] = unpackCondition(width);
    const keep = selectByProperty(widthsRes.widths, wmin, wmax);
    peaks = peaks.filter((_, i) => keep[i]);
    for (const k of [
      'prominences',
      'leftBases',
      'rightBases',
      'widths',
      'widthHeights',
      'leftIps',
      'rightIps',
    ] as const) {
      const arr = properties[k];
      if (arr) properties[k] = arr.filter((_, i) => keep[i]);
    }
  }

  return { peaks, properties };
}

/**
 * Strict local maxima of `x`, plateau index = midpoint (floor). Mirrors
 * `scipy.signal._peak_finding_utils._local_maxima_1d`. First/last samples are
 * never peaks.
 */
export function localMaxima1d(x: readonly number[]): number[] {
  const midpoints: number[] = [];
  const iMax = x.length - 1; // last sample can't be a maximum
  let i = 1; // first sample can't be a maximum
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let iAhead = i + 1;
      // Walk across a flat top of samples equal to x[i].
      while (iAhead < iMax && x[iAhead] === x[i]) iAhead += 1;
      if (x[iAhead] < x[i]) {
        const leftEdge = i;
        const rightEdge = iAhead - 1;
        midpoints.push((leftEdge + rightEdge) >> 1); // floor((l+r)/2)
        i = iAhead; // skip the plateau
      }
    }
    i += 1;
  }
  return midpoints;
}

/**
 * Keep peaks separated by at least `ceil(distance)` samples, evaluating tallest
 * first. Mirrors `scipy.signal._peak_finding_utils._select_by_peak_distance`.
 *
 * Note on ties: scipy uses `np.argsort` (not stable) to order by priority; we use
 * a stable ascending sort. The two differ only when peaks have EXACTLY equal
 * priority AND are within `distance_` of each other -- which does not occur for
 * the real spectra here. Documented so the difference is a known, bounded one.
 */
export function selectByPeakDistance(
  peaks: readonly number[],
  priority: readonly number[],
  distance: number,
): boolean[] {
  const size = peaks.length;
  const distance_ = Math.ceil(distance);
  const keep = new Array<boolean>(size).fill(true);

  // Indices sorted by ascending priority (so we can iterate tallest-first by
  // walking the result in reverse). Stable to make ties deterministic.
  const order = Array.from({ length: size }, (_, i) => i).sort((a, b) => {
    const d = priority[a] - priority[b];
    return d !== 0 ? d : a - b;
  });

  for (let idx = size - 1; idx >= 0; idx--) {
    const j = order[idx]; // current peak (by descending priority)
    if (!keep[j]) continue; // already removed by a taller peak

    let k = j - 1;
    while (k >= 0 && peaks[j] - peaks[k] < distance_) {
      keep[k] = false;
      k -= 1;
    }
    k = j + 1;
    while (k < size && peaks[k] - peaks[j] < distance_) {
      keep[k] = false;
      k += 1;
    }
  }

  return keep;
}

/** Mirror scipy `_unpack_condition_args`: a scalar => [min, no-upper-bound]. */
function unpackCondition(interval: Interval): [number | null, number | null] {
  if (Array.isArray(interval)) return [interval[0], interval[1]];
  return [interval, null];
}

/** Mirror scipy `_select_by_property`: keep where pmin <= value <= pmax. */
function selectByProperty(
  values: readonly number[],
  pmin: number | null,
  pmax: number | null,
): boolean[] {
  return values.map((v) => (pmin === null || pmin <= v) && (pmax === null || v <= pmax));
}
