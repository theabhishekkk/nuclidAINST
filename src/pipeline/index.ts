/** Public surface of the Nuclid pipeline. */
export * from '../domain/types';
export * from '../domain/errors';

export { parseSpectrum, nuclideHintFromName, type ParseOptions } from '../io/parse';
export { load, type LoadInput } from './load';
export {
  condition,
  estimateBackground,
  movingAverage,
  type ConditionOptions,
} from './condition';
export { detect, type DetectOptions } from './detect';
export { fit } from './fit';
export { validate, validPeaks, type ValidateOptions } from './validate';
export {
  calibrate,
  activeCalibration,
  fitCalibration,
  applyCalibrationToChannel,
  calibratePeaks,
  type DeclaredSource,
  type CalibrateOptions,
} from './calibrate';
export {
  applyCalibration,
  applyActiveCalibration,
  calibrationSlopeAtChannel,
  CALIBRATION_PARAM_ERROR_DEFERRED,
} from './applyCalibration';
export {
  identify,
  type IdentifyOptions,
  ARTIFACTS_ARE_FLAG_ONLY,
  DEFAULT_ENERGY_TOLERANCE_KEV,
  DEFAULT_FRAC_FWHM,
  DEFAULT_REQUIRED_FRAC,
  DEFAULT_MIN_SCORE,
  STRONG_SCORE_THRESHOLD,
  STRONG_COMPLETENESS_THRESHOLD,
  TENTATIVE_SCORE_THRESHOLD,
} from './identify';
export { quantify } from './quantify';
export { assembleReport, type ReportParts } from './report';
export { buildPipelineTrace } from './pipelineTrace';
export {
  buildOverlay,
  summarizeIdentification,
  exportIdentificationJson,
  exportIdentificationCsv,
  CAVEAT_SINGLE_LINE,
  CAVEAT_ARTIFACT_PEAK,
  CAVEAT_MISSING_STRONG,
  CSV_ISOTOPE_COLUMNS,
  CSV_PEAK_COLUMNS,
} from './identifyReport';
export { analyze, analyzeTraced, type AnalyzeOptions } from './orchestrator';
