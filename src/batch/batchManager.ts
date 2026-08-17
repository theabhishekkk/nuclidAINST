/**
 * BatchManager -- the stateful, subscribe-driven orchestrator for the Batch Peak Finder
 * (Phase 3 core, headless). It is the L3b spine: the Import surface and the Queue view both
 * bind to it, exactly as `calibrationManager` / `peakFinderManager` are the single objects
 * their views talk to.
 *
 * It owns the batch state (entries + shared default config + phase) and a background WORKER
 * LOOP: `start()` processes `queued` entries one at a time through the pure {@link processEntry}
 * (the shared headless core), yielding between files via a 0ms timer so the UI thread never
 * blocks -- the serial + main-thread-yielding model (open Q1, v1). Because `processEntry` is a
 * pure function of serializable inputs, this loop can move into a Worker later with no science
 * change.
 *
 * Fail-loud + isolated: one entry's fault marks it `failed` and the loop continues. Nothing
 * here recomputes science or fabricates a result; every displayed number comes from the report.
 *
 * NOTE: this is the Peak Finder FILE batch, distinct from the Calibrate/inspector "batch" of
 * declared source cards (`batchRowMarkup`).
 */
import type { Spectrum } from '../domain/types';
import type { PeakFinderConfig } from '../pipeline/peakFinderConfig';
import { DEFAULT_PEAK_FINDER_CONFIG } from '../pipeline/peakFinderConfig';
import type { BatchEntry, BatchSummary, PeakFinderBatch } from './batchTypes';
import { batchPhase, makeBatchEntry, processEntry, summarizeBatch } from './batchRunner';

/** The manager contract the batch views depend on. */
export interface BatchManager {
  readonly entries: readonly BatchEntry[];
  readonly defaultConfig: PeakFinderConfig;
  readonly phase: PeakFinderBatch['phase'];
  /** Whether the worker loop is running and not paused. */
  readonly active: boolean;
  /** Whether the loop has been started AND is currently paused (distinguishes Resume from a
   * fresh Start -- `phase` cannot, since it reads 'processing' from any queued entry). */
  readonly paused: boolean;
  summary(): BatchSummary;

  // --- import (Phase 2 feeds these) ---
  /** Add a parsed spectrum as a fresh `queued` entry; returns its stable id. Picked up by the
   * loop immediately if processing is active. */
  addSpectrum(spectrum: Spectrum): string;
  /** Quarantine an unreadable file as a `failed` entry carrying its parse error (import never
   * blocks on a bad file). Returns the entry id. */
  addImportFailure(fileName: string, message: string): string;
  removeEntry(id: string): void;

  // --- config (Hybrid model) ---
  /** Replace the shared default. When `reprocessInherited`, non-overridden terminal entries are
   * re-queued (pinned/overridden entries are never clobbered) and the loop resumes. */
  setDefaultConfig(config: PeakFinderConfig, reprocessInherited?: boolean): void;
  /** Pin (or clear) a per-file override; re-queues that one entry so it reprocesses. */
  setOverride(id: string, config: PeakFinderConfig | null): void;

  // --- worker loop ---
  start(): void;
  pause(): void;
  resume(): void;
  retry(id: string): void;
  retryAllFailed(): void;
  exclude(id: string): void;
  /** Return an excluded entry to the queue. */
  include(id: string): void;

  subscribe(listener: () => void): () => void;
  /** Stop the loop timer without altering state (view unmount). */
  stop(): void;
}

class BatchManagerImpl implements BatchManager {
  private _entries: BatchEntry[] = [];
  private _defaultConfig: PeakFinderConfig = DEFAULT_PEAK_FINDER_CONFIG;
  private _started = false;
  private _paused = false;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _seq = 0;
  private readonly _listeners = new Set<() => void>();

  get entries(): readonly BatchEntry[] {
    return this._entries;
  }
  get defaultConfig(): PeakFinderConfig {
    return this._defaultConfig;
  }
  get phase(): PeakFinderBatch['phase'] {
    return batchPhase(this._entries);
  }
  get active(): boolean {
    return this._started && !this._paused;
  }
  get paused(): boolean {
    return this._started && this._paused;
  }
  summary(): BatchSummary {
    return summarizeBatch(this._entries);
  }

  // --- import ---------------------------------------------------------------

  addSpectrum(spectrum: Spectrum): string {
    const id = this._nextId();
    this._entries.push(makeBatchEntry(id, spectrum));
    this._pumpIfActive();
    this._emit();
    return id;
  }

  addImportFailure(fileName: string, message: string): string {
    const id = this._nextId();
    // A quarantined import: no spectrum to process -> a terminal `failed` entry. The spectrum
    // field is required by the type; a zero-channel placeholder keeps it honest (never analysed).
    const spectrum: Spectrum = {
      counts: [],
      metadata: {
        fileName,
        format: 'tka',
        liveTimeSec: null,
        realTimeSec: null,
        channelCount: 0,
        statedNuclideHint: null,
        fileSizeBytes: null,
        detector: null,
        sampleName: null,
        measurementDate: null,
      },
    };
    this._entries.push({
      ...makeBatchEntry(id, spectrum),
      status: 'failed',
      error: { stage: 'load', message },
    });
    this._emit();
    return id;
  }

  removeEntry(id: string): void {
    const i = this._entries.findIndex((e) => e.id === id);
    if (i < 0) return;
    this._entries.splice(i, 1);
    this._emit();
  }

  // --- config ---------------------------------------------------------------

  setDefaultConfig(config: PeakFinderConfig, reprocessInherited = false): void {
    this._defaultConfig = config;
    if (reprocessInherited) {
      this._entries = this._entries.map((e) =>
        e.configOverride === null && isTerminal(e.status) ? requeue(e) : e,
      );
      this._pumpIfActive();
    }
    this._emit();
  }

  setOverride(id: string, config: PeakFinderConfig | null): void {
    this._entries = this._entries.map((e) =>
      e.id === id ? requeue({ ...e, configOverride: config }) : e,
    );
    this._pumpIfActive();
    this._emit();
  }

  // --- worker loop ----------------------------------------------------------

  start(): void {
    this._started = true;
    this._paused = false;
    this._pump();
    this._emit();
  }

  pause(): void {
    this._paused = true;
    this._emit();
  }

  resume(): void {
    this._paused = false;
    this._pump();
    this._emit();
  }

  retry(id: string): void {
    this._entries = this._entries.map((e) => (e.id === id ? requeue(e) : e));
    this._pumpIfActive();
    this._emit();
  }

  retryAllFailed(): void {
    this._entries = this._entries.map((e) => (e.status === 'failed' ? requeue(e) : e));
    this._pumpIfActive();
    this._emit();
  }

  exclude(id: string): void {
    this._setStatus(id, 'excluded');
    this._emit();
  }

  include(id: string): void {
    this._entries = this._entries.map((e) => (e.id === id ? requeue(e) : e));
    this._pumpIfActive();
    this._emit();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  stop(): void {
    this._clearTimer();
  }

  // --- internals ------------------------------------------------------------

  /** Schedule one processing step. A 0ms timer yields between files so a 500-entry batch never
   * freezes the UI thread. Idempotent: a step already scheduled is not double-booked. */
  private _pump(): void {
    if (this._timer !== null || this._paused) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._paused) return;
      const next = this._entries.find((e) => e.status === 'queued');
      if (!next) return; // drained -> settled
      // Mark running (a momentary state -- processEntry is synchronous), emit so the row shows it,
      // then process and apply. Yield to the next file via a fresh timer.
      this._replace(next.id, { ...next, status: 'running' });
      this._emit();
      const processed = processEntry({ ...next, status: 'queued' }, this._defaultConfig);
      this._replace(next.id, processed);
      this._emit();
      this._pump();
    }, 0);
  }

  private _pumpIfActive(): void {
    if (this._started && !this._paused) this._pump();
  }

  private _setStatus(id: string, status: BatchEntry['status']): void {
    this._entries = this._entries.map((e) => (e.id === id ? { ...e, status } : e));
  }

  private _replace(id: string, entry: BatchEntry): void {
    const i = this._entries.findIndex((e) => e.id === id);
    if (i >= 0) this._entries[i] = entry;
  }

  private _nextId(): string {
    return `entry-${++this._seq}`;
  }

  private _clearTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _emit(): void {
    for (const listener of this._listeners) listener();
  }
}

/** Terminal-for-settlement states (a re-queue candidate when the default config changes). */
function isTerminal(status: BatchEntry['status']): boolean {
  return status === 'done' || status === 'warning' || status === 'failed';
}

/** Reset an entry to a clean `queued` state (drop its prior result/error). */
function requeue(entry: BatchEntry): BatchEntry {
  return { ...entry, status: 'queued', result: null, error: null };
}

/** Create a fresh, empty batch manager. One instance per batch mount. */
export function createBatchManager(): BatchManager {
  return new BatchManagerImpl();
}
