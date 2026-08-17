/** Stage 9 -- Report: assemble whatever the run produced into one AnalysisReport. */
import type {
  ActivityEstimate,
  AnalysisReport,
  Calibration,
  ConditionedSpectrum,
  DetectedPeak,
  FittedPeak,
  IdentificationResult,
  PeakIdentification,
  Spectrum,
  StageTrace,
  UnfittableSurvivor,
} from '../domain/types';
import type { DetectOptions } from './detect';

export interface ReportParts {
  readonly spectrum: Spectrum;
  readonly conditioned: ConditionedSpectrum | null;
  readonly detectedCandidates: readonly DetectedPeak[];
  readonly peaks: readonly FittedPeak[];
  readonly calibration: Calibration | null;
  readonly identifications: readonly PeakIdentification[];
  readonly activities: readonly ActivityEstimate[];
  readonly trace: readonly StageTrace[];
  /** I2 fingerprint result (Stage 6), optional and additive. */
  readonly identification?: IdentificationResult;
  /** Every local maximum detection found, tagged passed/rejectReason (Inspector). */
  readonly allDetected?: readonly DetectedPeak[];
  /** Every attempted fit that produced a line, tagged status/rejectReason (Inspector). */
  readonly allFitted?: readonly FittedPeak[];
  /** Survivors that produced no usable fit (GAP-07, Inspector). */
  readonly unfittable?: readonly UnfittableSurvivor[];
  /** The effective detect gate settings this run used (DEBT-27). Optional/additive. */
  readonly detectSettings?: Required<DetectOptions>;
}

export function assembleReport(parts: ReportParts): AnalysisReport {
  return {
    spectrum: parts.spectrum,
    conditioned: parts.conditioned,
    detectedCandidates: parts.detectedCandidates,
    peaks: parts.peaks,
    calibration: parts.calibration,
    identifications: parts.identifications,
    activities: parts.activities,
    trace: parts.trace,
    // Only attach when supplied, so callers that never identify keep the field absent.
    ...(parts.identification !== undefined ? { identification: parts.identification } : {}),
    ...(parts.allDetected !== undefined ? { allDetected: parts.allDetected } : {}),
    ...(parts.allFitted !== undefined ? { allFitted: parts.allFitted } : {}),
    ...(parts.unfittable !== undefined ? { unfittable: parts.unfittable } : {}),
    ...(parts.detectSettings !== undefined ? { detectSettings: parts.detectSettings } : {}),
  };
}
