/**
 * Batch Peak Finder -- the pure runner (Phase 1).
 *
 * Turns a queued entry into a reviewed result by running the SAME headless core the interactive
 * manager delegates to ({@link runPeakFinder}), so a batch-processed file and a drill-in of that
 * file are byte-identical. Everything here is a pure function of its inputs: no timers, no shared
 * mutable state, no UI. That is what lets the batch scale (map over 500 entries) and, later, move
 * off the main thread into a Worker with zero changes.
 *
 * Fail-loud + isolated (the design's Q7 posture): a parse/engine fault marks ONE entry `failed`
 * with its reason and returns it; callers process the rest untouched. Nothing here aborts a batch.
 */
import { NuclidError } from '../domain/errors';
import type { AnalysisReport } from '../domain/types';
import type { PeakFinderConfig } from '../pipeline/peakFinderConfig';
import { runPeakFinder } from '../pipeline/runPeakFinder';
import { deriveSpectrumStatus } from '../pipeline/spectrumStatus';
import type {
  BatchEntry,
  BatchEntryError,
  BatchEntryMetrics,
  BatchEntryResult,
  BatchSummary,
  PeakFinderBatch,
} from './batchTypes';

/**
 * Warning thresholds (open question #4 -- provisional, pending an operator ruling like the
 * validation flags got). Named + exported so the ruling is a one-line change and the tests
 * pin the current contract. A warning never fails or excludes a file; it flags a usable-but-
 * marginal result for the operator's judgement in Review.
 */
export const FEW_PEAKS_THRESHOLD = 3; // fewer than this many valid peaks (but > 0) => 'few-peaks'
export const LOW_COUNTS_THRESHOLD = 1000; // total raw counts below this => 'low-counts'
export const WIDE_FWHM_THRESHOLD = 50; // mean fitted FWHM (channels) above this => 'wide-fwhm'

/** The Hybrid config rule: an entry's override wins, else it inherits the batch default. */
export function effectiveConfig(entry: BatchEntry, defaultConfig: PeakFinderConfig): PeakFinderConfig {
  return entry.configOverride ?? defaultConfig;
}

/** A fresh queued entry. `id` is caller-supplied (stable across reorder/rerun -- never derived
 * from array position). */
export function makeBatchEntry(id: string, spectrum: BatchEntry['spectrum']): BatchEntry {
  return {
    id,
    fileName: spectrum.metadata.fileName,
    spectrum,
    status: 'queued',
    configOverride: null,
    result: null,
    error: null,
  };
}

/** Read the light metrics off a report (no science recomputed -- only counts + a mean). */
export function deriveMetrics(report: AnalysisReport): BatchEntryMetrics {
  const validated = report.validatedPeaks ?? [];
  const validCount = validated.filter((v) => v.valid).length;
  const flaggedCount = validated.filter((v) => !v.valid).length;
  const totalCounts = report.spectrum.counts.reduce((a, b) => a + b, 0);
  const fwhms = report.peaks.map((p) => p.fwhmChannels).filter((w) => Number.isFinite(w));
  const meanFwhmChannels = fwhms.length ? fwhms.reduce((a, b) => a + b, 0) / fwhms.length : null;
  return { validCount, flaggedCount, totalCounts, meanFwhmChannels };
}

/** Soft-issue flags for a processed file. 0 peaks is a valid (if unhelpful) result -> `no-peaks`
 * warning, never a failure. Order is stable so the Review grouping is deterministic. */
export function deriveWarnings(peakCount: number, metrics: BatchEntryMetrics): string[] {
  const warnings: string[] = [];
  if (peakCount === 0) warnings.push('no-peaks');
  else if (peakCount < FEW_PEAKS_THRESHOLD) warnings.push('few-peaks');
  if (metrics.totalCounts < LOW_COUNTS_THRESHOLD) warnings.push('low-counts');
  if (metrics.meanFwhmChannels != null && metrics.meanFwhmChannels > WIDE_FWHM_THRESHOLD)
    warnings.push('wide-fwhm');
  return warnings;
}

/** Map an engine fault to an honest, displayable error record. */
function toBatchError(err: unknown): BatchEntryError {
  if (err instanceof NuclidError) return { stage: 'pipeline', message: err.message };
  return { stage: 'unexpected', message: (err as Error).message };
}

/**
 * Process one entry through the shared core. `excluded` / `paused` entries pass through
 * untouched (they are the operator's choices, not work to do). Returns a NEW entry -- the pure
 * runner never mutates; the Phase-3 manager applies the result in place.
 */
export function processEntry(entry: BatchEntry, defaultConfig: PeakFinderConfig): BatchEntry {
  if (entry.status === 'excluded' || entry.status === 'paused') return entry;
  try {
    const { report } = runPeakFinder(entry.spectrum, effectiveConfig(entry, defaultConfig));
    const metrics = deriveMetrics(report);
    const peakCount = deriveSpectrumStatus(report).peakCount;
    const warnings = deriveWarnings(peakCount, metrics);
    const result: BatchEntryResult = { report, peakCount, warnings, metrics };
    return { ...entry, status: warnings.length ? 'warning' : 'done', result, error: null };
  } catch (err) {
    return { ...entry, status: 'failed', result: null, error: toBatchError(err) };
  }
}

/** A batch is settled when no entry is still queued / running / paused. Only then does Review
 * unlock (the design's §5 gate). */
export function isSettled(entries: readonly BatchEntry[]): boolean {
  return !entries.some((e) => e.status === 'queued' || e.status === 'running' || e.status === 'paused');
}

/** The coarse phase for {@link PeakFinderBatch} derived from its entries. */
export function batchPhase(entries: readonly BatchEntry[]): PeakFinderBatch['phase'] {
  if (!entries.length) return 'importing';
  return isSettled(entries) ? 'settled' : 'processing';
}

/** The progress-summary aggregate (always-visible header + Review verdict). Kept = done|warning
 * (usable), excluding failed/excluded. */
export function summarizeBatch(entries: readonly BatchEntry[]): BatchSummary {
  const count = (s: BatchEntry['status']): number => entries.filter((e) => e.status === s).length;
  const kept = entries.filter((e) => e.status === 'done' || e.status === 'warning');
  const totalPeaks = kept.reduce((n, e) => n + (e.result?.peakCount ?? 0), 0);
  return {
    total: entries.length,
    done: count('done'),
    warning: count('warning'),
    failed: count('failed'),
    excluded: count('excluded'),
    queued: count('queued'),
    running: count('running'),
    paused: count('paused'),
    kept: kept.length,
    totalPeaks,
  };
}
