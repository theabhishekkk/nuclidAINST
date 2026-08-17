/**
 * Peak Pipeline Inspector -- the lazy assembler for {@link PipelineTrace}.
 *
 * `buildPipelineTrace` is a PURE PROJECTION over an {@link AnalysisReport}: it
 * references the arrays the engine already produced (no cloning of the large
 * conditioned series, no new numeric computation) and only derives the trivial
 * channel index range. Nothing on the default `analyze()` path calls it, so a
 * production run carries zero added cost; the (future) UI calls it when the
 * inspector opens.
 *
 * Backward-compatible by construction: if a report predates the additive
 * retention (no `allDetected` / `allFitted`), the trace falls back to the
 * survivor / kept lists, so `detected.all`/`fitted.all` are never undefined.
 */
import type { AnalysisReport, PipelineTrace } from '../domain/types';
import {
  PROMINENCE,
  DISTANCE,
  MIN_WIDTH,
  REL_HEIGHT,
  WINDOW_FACTOR,
  MIN_HALF_WINDOW,
  MIN_SIGNIFICANCE,
  MAX_WIDTH_RATIO,
} from './detect';

export function buildPipelineTrace(report: AnalysisReport): PipelineTrace {
  const raw = report.spectrum.counts;
  // The only constructed array: the channel axis [0 .. channelCount-1].
  const channels = raw.map((_, i) => i);

  const conditioned = report.conditioned
    ? {
        background: report.conditioned.background,
        netCounts: report.conditioned.netCounts,
        smoothed: report.conditioned.smoothed,
      }
    : null;

  return {
    spectrumId: report.spectrum.metadata.fileName,
    channels,
    raw,
    conditioned,
    detected: {
      // Full tagged list when retained; otherwise the survivors are all we have.
      all: report.allDetected ?? report.detectedCandidates,
      survivors: report.detectedCandidates,
    },
    fitted: {
      all: report.allFitted ?? report.peaks,
      kept: report.peaks,
      unfittable: report.unfittable ?? [],
    },
    validated: report.validatedPeaks ?? [],
    constants: {
      // The four OVERRIDABLE detect gates: prefer the effective per-run settings
      // this run actually applied, falling back to the module defaults for a report
      // that predates the additive field (DEBT-27).
      prominence: report.detectSettings?.prominence ?? PROMINENCE,
      distance: report.detectSettings?.distance ?? DISTANCE,
      minWidth: report.detectSettings?.minWidth ?? MIN_WIDTH,
      relHeight: report.detectSettings?.relHeight ?? REL_HEIGHT,
      // The four measurement/classification constants are NOT overridable by
      // DetectOptions, so they stay module-sourced.
      windowFactor: WINDOW_FACTOR,
      minHalfWindow: MIN_HALF_WINDOW,
      minSignificance: MIN_SIGNIFICANCE,
      maxWidthRatio: MAX_WIDTH_RATIO,
    },
    timing: report.trace,
    version: 1,
  };
}
