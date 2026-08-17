/**
 * The orchestrator composes the stage functions and produces a traced report.
 *
 * It runs only the stages that are actually built (load -> condition -> detect)
 * and records the rest as `skipped` with an honest reason -- never fabricating a
 * downstream result. As each later stage is implemented, light it up here.
 */
import type { AnalysisReport, Spectrum, StageName, StageTrace } from '../domain/types';
import { load, type LoadInput } from './load';
import { condition, type ConditionOptions } from './condition';
import { detectTraced, resolveDetectOptions, type DetectOptions } from './detect';
import { fitTraced } from './fit';
import { validate, validPeaks, type ValidateOptions } from './validate';
import { assembleReport } from './report';

export interface AnalyzeOptions {
  readonly condition?: ConditionOptions;
  readonly detect?: DetectOptions;
  readonly validate?: ValidateOptions;
  /**
   * // Divergence (Peak Finder, R1): the RAW spectrum the fit stage sums areas over,
   * when it differs from the analysed spectrum. Peak Finder analyses a possibly
   * SG-smoothed WORKING spectrum but must fit centroid / area / FWHM from the
   * untouched raw spectrum, so it passes `rawSource: rawSpectrum`. Absent (Calibrate /
   * Identify), the fit defaults to the analysed spectrum -- behaviour unchanged.
   */
  readonly rawSource?: Spectrum;
  /**
   * // Divergence (Peak Finder, #4): which series detection measures peak STRENGTH from
   * (net area + the resolution anchor). `'working'` = the conditioned working series
   * (the net-or-smoothed-net Peak Finder chose); `'raw'` (DEFAULT) = the raw un-clipped
   * net. Gross / significance-denominator stay raw either way (D-4a). Default `'raw'`
   * keeps Calibrate / Identify byte-identical (they never pass this).
   */
  readonly strengthSource?: 'raw' | 'working';
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

const SKIP_NOTES: Record<string, string> = {
  calibrate: 'awaiting multi-point calibration anchors (GATE-C)',
  identify: 'awaiting calibrated energies',
  quantify: 'awaiting efficiency curve (DEBT-02)',
};

export function analyze(input: LoadInput, options: AnalyzeOptions = {}): AnalysisReport {
  // Stage 1 -- load (parse errors propagate loudly; the run stops on bad input),
  // then run the shared pipeline on the parsed spectrum.
  const loaded = timed(() => load(input));
  return analyzeSpectrum(loaded.value, options, loaded.ms);
}

/**
 * Run the pipeline on an ALREADY-PARSED spectrum -- the same `condition -> detect ->
 * fit -> validate` composition {@link analyze} runs, but skipping the internal
 * `load()` because the caller supplies the parsed `Spectrum` directly.
 *
 * // Divergence (Peak Finder): the Peak Finder supplies a WORKING spectrum (raw, or
 * SG-smoothed at the Load stage) as `spectrum`, and the untouched raw spectrum via
 * `options.rawSource` so the fit stage's areas stay raw (R1). Calibrate / Identify
 * keep using {@link analyze}, so their behaviour is untouched. `loadMs` is the
 * caller's parse time (0 when it was not measured); the spectrum is already parsed
 * here, so the recorded `load` stage is a formality carrying that timing.
 */
export function analyzeSpectrum(
  spectrum: Spectrum,
  options: AnalyzeOptions = {},
  loadMs = 0,
): AnalysisReport {
  const trace: StageTrace[] = [];
  const record = (stage: StageName, status: StageTrace['status'], note: string, durationMs: number) =>
    trace.push({ stage, status, note, durationMs });

  record('load', 'ok', `${spectrum.metadata.channelCount} channels`, loadMs);

  // Stage 2 -- condition.
  const cond = timed(() => condition(spectrum, options.condition ?? {}));
  const conditioned = cond.value;
  record('condition', 'ok', 'SNIP background + Savitzky-Golay smoothing', cond.ms);

  // Stage 3 -- detect (retain the full tagged candidate list for the inspector;
  // `candidates` is the byte-identical survivor set used by every later stage).
  // Divergence (Peak Finder, Phase 1): detection strength heuristics are measured from
  // the RAW spectrum, so the same `rawSource` the fit stage uses is threaded here too.
  // Absent (Calibrate / Identify) detection defaults to `conditioned.source` -- raw
  // there -- so their behaviour is byte-identical.
  const det = timed(() =>
    detectTraced(conditioned, options.detect ?? {}, options.rawSource, options.strengthSource ?? 'raw'),
  );
  const candidates = det.value.survivors;
  const allDetected = det.value.all;
  // The EFFECTIVE gate settings this run applied (defaults merged with any per-run
  // overrides), threaded onto the report so the inspector labels the real gates
  // rather than the module defaults (DEBT-27). Resolved once, here, via the shared
  // resolver so detectTraced and the trace can never disagree.
  const detectSettings = resolveDetectOptions(options.detect);
  record('detect', 'ok', `${candidates.length} peak candidate(s)`, det.ms);

  // Stage 4 -- fit (Gaussian + linear background per peak; only good fits survive
  // the peak-hopping guard, so the count may be below the candidate count). The
  // full list also retains the edge/hop-rejected fits for the inspector.
  const fitted = timed(() => fitTraced(conditioned, candidates, options.rawSource));
  const peaks = fitted.value.kept;
  const allFitted = fitted.value.all;
  const unfittable = fitted.value.unfittable;
  record('fit', 'ok', `${peaks.length} of ${candidates.length} peak(s) fitted`, fitted.ms);

  // Stage 5 -- validate (peak-quality gate; every peak kept with its verdict).
  const validated = timed(() => validate(peaks, options.validate ?? {}));
  const validatedPeaks = validated.value;
  const validCount = validPeaks(validatedPeaks).length;
  record('validate', 'ok', `${validCount} of ${peaks.length} peak(s) valid`, validated.ms);

  // Stages 6-8 -- not yet built; record honestly as skipped.
  for (const stage of ['calibrate', 'identify', 'quantify'] as StageName[]) {
    record(stage, 'skipped', SKIP_NOTES[stage] ?? 'not implemented', 0);
  }

  // Stage 9 -- report.
  record('report', 'ok', 'assembled partial report', 0);
  return {
    ...assembleReport({
      spectrum,
      conditioned,
      detectedCandidates: candidates,
      peaks,
      calibration: null,
      identifications: [],
      activities: [],
      trace,
      allDetected,
      allFitted,
      unfittable,
      detectSettings,
    }),
    validatedPeaks,
  };
}

/** Convenience wrapper returning the report and its trace separately. */
export function analyzeTraced(
  input: LoadInput,
  options: AnalyzeOptions = {},
): { report: AnalysisReport; trace: readonly StageTrace[] } {
  const report = analyze(input, options);
  return { report, trace: report.trace };
}

/** {@link analyzeSpectrum}'s traced wrapper -- the pre-parsed sibling of
 * {@link analyzeTraced}. Peak Finder uses this so stage `durationMs` is captured for
 * its Review summary panel. */
export function analyzeSpectrumTraced(
  spectrum: Spectrum,
  options: AnalyzeOptions = {},
): { report: AnalysisReport; trace: readonly StageTrace[] } {
  const report = analyzeSpectrum(spectrum, options);
  return { report, trace: report.trace };
}
