/**
 * Signal core (F2) -- general, SciPy-parity 1-D signal primitives shared by the
 * detection pipeline (built once, reused by Calibrate and Identify). These are
 * array-in / array-out and NOT spectroscopy-aware. Wiring them into condition.ts
 * / detect.ts is C1; F2 ships them standalone with only tests as consumers.
 */
export { savitzkyGolay } from './savgol';
export { peakProminences, type Prominences } from './peakProminences';
export { peakWidths, type PeakWidthsResult, DEFAULT_REL_HEIGHT } from './peakWidths';
export {
  findPeaks,
  localMaxima1d,
  selectByPeakDistance,
  type FindPeaksOptions,
  type FindPeaksResult,
} from './findPeaks';
