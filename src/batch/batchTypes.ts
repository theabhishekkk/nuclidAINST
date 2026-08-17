/**
 * Batch Peak Finder -- domain types (Phase 1).
 *
 * A batch is an ordered set of spectrum entries plus one shared default {@link PeakFinderConfig},
 * turned into a reviewed, calibration-ready set of per-file results. This module holds ONLY the
 * data shapes and inheritance rule -- no engine, no UI, no timers. The pure runner
 * ({@link processEntry}) and, later, the stateful manager (Phase 3) build on it.
 *
 * NOTE on the word "batch": the existing `batchRowMarkup` / `batchRowStatus` surface is the
 * Calibrate/inspector "batch" of declared SOURCE cards -- a different domain. This is the Peak
 * Finder file batch; types here are prefixed `Batch*`/`PeakFinderBatch` to keep them distinct.
 *
 * Generic-by-design (open question #5, resolved): an entry's result carries the full
 * {@link AnalysisReport}, which is exactly what any downstream consumer ingests
 * (Calibrate's `addParsedSource(report)` today; Identify/Quantify later). The batch is a
 * "reviewed set of per-spectrum reports", not a Peak-Finder-only construct.
 */
import type { AnalysisReport, Spectrum } from '../domain/types';
import type { PeakFinderConfig } from '../pipeline/peakFinderConfig';

/**
 * The lifecycle state of one entry. Terminal-for-settlement: `done` | `warning` | `failed` |
 * `excluded` (the batch may proceed once every entry is one of these). `queued` | `running` |
 * `paused` keep the batch un-settled.
 */
export type BatchEntryStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'warning'
  | 'failed'
  | 'paused'
  | 'excluded';

/** At-a-glance numbers the Review table renders (all derived from the report, never recomputed
 * science). */
export interface BatchEntryMetrics {
  /** Valid validated peaks (SpectrumStatus semantics) -- the canonical peak count. */
  readonly validCount: number;
  /** Validated peaks that failed the gate (flagged, not dropped). */
  readonly flaggedCount: number;
  /** Sum of raw counts across the spectrum -- the low-counts warning reads this. */
  readonly totalCounts: number;
  /** Mean FWHM (channels) over the kept fitted peaks, or null when there are none. */
  readonly meanFwhmChannels: number | null;
}

/** The light result held for every processed file (results-always tier). The `report` is the
 * calibration-relevant payload the Calibrate hand-off consumes; `peaks`/`validated` are read
 * from it, never stored twice. */
export interface BatchEntryResult {
  readonly report: AnalysisReport;
  /** Valid validated peaks -- mirrors {@link BatchEntryMetrics.validCount}, surfaced for the row. */
  readonly peakCount: number;
  /** Soft-issue flags (e.g. `few-peaks`, `low-counts`, `wide-fwhm`); non-empty => `warning`. */
  readonly warnings: readonly string[];
  readonly metrics: BatchEntryMetrics;
}

/** An honest failure record (set iff status === 'failed'). */
export interface BatchEntryError {
  readonly stage: string;
  readonly message: string;
}

/** One file in the batch. `configOverride` null => inherit the batch default (Hybrid model). */
export interface BatchEntry {
  readonly id: string;
  readonly fileName: string;
  /** The parsed spectrum -- the input to `runPeakFinder`; held for background processing + drill-in. */
  readonly spectrum: Spectrum;
  status: BatchEntryStatus;
  configOverride: PeakFinderConfig | null;
  result: BatchEntryResult | null;
  error: BatchEntryError | null;
}

/** The whole batch: ordered entries + the shared inheritance root + a coarse phase. */
export interface PeakFinderBatch {
  entries: BatchEntry[];
  defaultConfig: PeakFinderConfig;
  phase: 'importing' | 'processing' | 'settled';
}

/** A settled-state aggregate for the progress summary + Review verdict header. */
export interface BatchSummary {
  readonly total: number;
  readonly done: number;
  readonly warning: number;
  readonly failed: number;
  readonly excluded: number;
  readonly queued: number;
  readonly running: number;
  readonly paused: number;
  /** Files eligible for the Calibrate hand-off: done or warning, not failed/excluded. */
  readonly kept: number;
  /** Total valid peaks across kept files. */
  readonly totalPeaks: number;
}
