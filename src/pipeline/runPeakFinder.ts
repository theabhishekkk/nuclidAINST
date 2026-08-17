/**
 * runPeakFinder -- the headless Peak Finder core (Batch Peak Finder, Phase 0).
 *
 * This is the extraction of {@link PeakFinderManager}'s private compute choreography into a
 * pure function of `(rawSpectrum, PeakFinderConfig)`. It is the SINGLE source of a file's
 * result: the interactive manager delegates its detection run here, and the batch worker calls
 * it directly. Because both paths run the same function, an interactively-inspected spectrum
 * and a batch-queued spectrum produce byte-identical reports by construction (Gap B, closed).
 *
 * No UI, no timers, no `matchMedia`, no `_emit` -- pure and Worker-safe (a serializable config
 * in, an {@link AnalysisReport} out), which is what lets the batch move off the main thread
 * later with zero science changes.
 *
 * Faithful to the manager's `_computeDetection`: the report is `analyzeSpectrum(selectedInput,
 * { condition, rawSource: raw, strengthSource: 'working' })`. The continuum background/net that
 * the education pages draw are presentation-only and stay in the manager (they never enter the
 * report -- the engine's own `condition()` recomputes the net inside `analyzeSpectrum`).
 */
import type { AnalysisReport, PipelineTrace, Spectrum, StageTrace } from '../domain/types';
import { savitzkyGolay } from '../signal';
import { analyzeSpectrum, analyzeSpectrumTraced, type AnalyzeOptions } from './orchestrator';
import { buildPipelineTrace } from './pipelineTrace';
import { deriveSpectrumStatus, type SpectrumStatus } from './spectrumStatus';
import type { PeakFinderConfig } from './peakFinderConfig';

/** The light result the batch stores for every file (results-always tier). */
export interface PeakFinderResult {
  readonly report: AnalysisReport;
}

/** The full inspection bundle a drill-in needs (traces-on-demand tier) -- the report plus the
 * projections the manager assigns after a run: per-stage timing, the four-state status contract,
 * and the inspector pipeline trace. */
export interface PeakFinderTracedResult {
  readonly report: AnalysisReport;
  readonly stageTrace: readonly StageTrace[];
  readonly status: SpectrumStatus;
  readonly pipelineTrace: PipelineTrace;
}

/**
 * Resolve the spectrum detection analyses: the raw spectrum, or -- when the config selects the
 * smoothed input -- the Load-stage Savitzky-Golay of the raw (clip-non-negative), carried as its
 * OWN spectrum with the raw's metadata. Byte-identical to the manager's `_recomputeSmoothed` +
 * `selectedInput` getter, so delegating cannot change which series is analysed.
 */
export function resolveSelectedInput(raw: Spectrum, config: PeakFinderConfig): Spectrum {
  if (config.continuum.input !== 'smoothed') return raw;
  const { window, polyorder } = config.preprocessing.sg;
  const smoothed = savitzkyGolay(raw.counts, window, polyorder).map((v) => (v > 0 ? v : 0));
  return { counts: smoothed, metadata: raw.metadata };
}

/**
 * The engine options that realise a config for the detection run. The Peak Finder divergences
 * are ALWAYS applied: fit areas come from the raw spectrum (R1, `rawSource`) and strength is
 * measured from the chosen working series (#4, `strengthSource: 'working'`). The net-SG choice
 * maps to `condition.smoothing`: `smoothed-net` runs Savitzky-Golay on the net with the
 * detection-SG params; `net` keeps `'none'` (the SNIP net straight through). detect/validate
 * overrides are spread only when present, so an unset config is byte-identical to the manager's
 * default-options call.
 */
function toAnalyzeOptions(raw: Spectrum, config: PeakFinderConfig): AnalyzeOptions {
  const condition =
    config.detection.netInput === 'smoothed-net'
      ? {
          smoothing: 'savgol' as const,
          savgolWindow: config.detection.sg.window,
          savgolPolyorder: config.detection.sg.polyorder,
        }
      : { smoothing: 'none' as const };
  return {
    condition,
    ...(config.detection.options ? { detect: config.detection.options } : {}),
    ...(config.validate ? { validate: config.validate } : {}),
    rawSource: raw,
    strengthSource: 'working',
  };
}

/** Run the Peak Finder pipeline and return the light report (results-always). */
export function runPeakFinder(raw: Spectrum, config: PeakFinderConfig): PeakFinderResult {
  const input = resolveSelectedInput(raw, config);
  const report = analyzeSpectrum(input, toAnalyzeOptions(raw, config));
  return { report };
}

/** Run the Peak Finder pipeline and return the full inspection bundle (traces-on-demand). The
 * report is identical to {@link runPeakFinder}'s; this additionally captures the per-stage trace
 * and derives the status + inspector pipeline trace, exactly as the manager does after a run. */
export function runPeakFinderTraced(raw: Spectrum, config: PeakFinderConfig): PeakFinderTracedResult {
  const input = resolveSelectedInput(raw, config);
  const { report, trace } = analyzeSpectrumTraced(input, toAnalyzeOptions(raw, config));
  return {
    report,
    stageTrace: trace,
    status: deriveSpectrumStatus(report),
    pipelineTrace: buildPipelineTrace(report),
  };
}
