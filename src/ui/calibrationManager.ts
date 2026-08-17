/**
 * CalibrationManager -- the UI-layer orchestrator for the execution-driven
 * Calibrate stepper (Manager / Engine split). It is the ONLY object the Calibrate
 * view talks to: it collects every input the calibration needs up front (the
 * source batch + each source's declared identity + the linear/quadratic/auto model
 * choice), then on Build hands a finalized job to the engine in one pass.
 *
 * Manager gathers, engine executes. The engine (`calibrate()` in
 * `src/pipeline/calibrate.ts`) is called AS-IS with an existing option
 * (`defaultModel`) -- its numbers are byte-identical to the golden tests, nothing
 * in `src/pipeline/*` is touched. The "execution" the stepper shows is a
 * presentational reveal of that one synchronous result + its `trace`: the engine
 * runs once, start to finish, asking for nothing (per the approved design).
 *
 * Identity is an INPUT, never a filename (Rule 12). Each batch row carries an
 * editable declared `sourceId`; the filename only pre-fills a `suggestedId` hint.
 *
 * Assignment capture (Declare Identities, Phase 2). Each row also carries a
 * per-peak `assignments` array (one {@link PeakAssignment} per fitted peak) the
 * scientist edits in the Declare step, plus the navigator's active-row cursor.
 * CAPTURED ONLY this phase: assignments are NOT yet engine inputs -- Build still
 * runs the two-pass auto-matcher (the `calibrateFromMatches` switch is Phase 4),
 * so assignment edits deliberately do NOT invalidate a built run.
 *
 * The view binds via {@link CalibrationManager.subscribe}; the manager notifies on
 * every state change (collection edits, the timed stage reveal, completion, error)
 * and the view re-renders / drives the stepper from the new state.
 */
import type {
  AnalysisReport,
  CalibrationModelPolicy,
  CalibrationResult,
  FittedPeak,
  PeakAssignment,
} from '../domain/types';
import { NuclidError, ValidationError } from '../domain/errors';
import { calibrateFromMatches, MIN_FIT_POINTS } from '../pipeline/calibrate';
import { validate, validPeaks } from '../pipeline/validate';
import { CALIBRATION_KIT } from '../data/calibrationKit';
import { calibrationStore } from '../data/calibrationStore';

/** The model the operator chooses up front; passed straight to the engine as
 * `CalibrateOptions.defaultModel`. Mirrors {@link CalibrationModelPolicy}. */
export type ModelChoice = CalibrationModelPolicy;

/** One source the operator added to the batch (Rule 12: identity is editable). */
export interface ManagedSource {
  /** Unique per added file (for remove/edit); never derived from content. */
  readonly rowId: string;
  readonly fileName: string;
  /** Declared identity -- editable; '' until chosen. The engine input (Rule 12). */
  sourceId: string;
  /** `suggestKitId(fileName)` -- a hint only, always overridable. */
  readonly suggestedId: string;
  /** `validPeaks(validate(report.peaks))` -- the C2 fitted peaks handed to the engine. */
  readonly fittedPeaks: readonly FittedPeak[];
  /** Per-peak scientist decisions (Declare Identities, Phase 2). Parallels
   * `fittedPeaks` order; `peakId` = `${rowId}:${index}` is the stable
   * within-source id. Mutable like `sourceId`; reset by {@link CalibrationManager.setIdentity}
   * (the old source's lines no longer apply). Captured only this phase. */
  assignments: PeakAssignment[];
  /** This source's raw spectrum counts, retained for the per-file QC chart and the
   * stage walkthrough (stages 3 & 4 draw centroid / tight-window plots from these). */
  readonly counts: readonly number[];
  readonly channelCount: number;
  /** The full engine report for this source -- in-memory ONLY (never persisted),
   * retained so the Peak Pipeline Inspector can build a {@link PipelineTrace} via
   * `buildPipelineTrace(report)`. The persisted shape is `CalibrationResult`, not
   * the batch, so this carries no storage cost. */
  readonly report: AnalysisReport;
}

/** The top-level state of a calibration run, one surface on screen at a time. */
export type RunPhase =
  | { kind: 'collecting' } // Source Manager visible
  | { kind: 'running'; stageIndex: number } // auto-revealing stages 0..7
  | { kind: 'done' } // rail freely navigable
  | { kind: 'error'; message: string }; // engine ValidationError -- honest hard check

/** The manager contract the Calibrate view depends on (UI layer, not the engine). */
export interface CalibrationManager {
  // --- collection (Source Manager) ---
  /** Push a row from an already-parsed report (caller ran `analyze()`). */
  addParsedSource(report: AnalysisReport): void;
  removeSource(rowId: string): void;
  /** Rule 12: the operator's explicit identity assertion for a row. Also resets
   * that row's per-peak assignments -- the old source's lines no longer apply. */
  setIdentity(rowId: string, sourceId: string): void;
  setModel(choice: ModelChoice): void;
  readonly sources: readonly ManagedSource[];
  readonly model: ModelChoice;
  /** Build enabled? (cheap pre-check; the engine is the definitive gate -- §2.1). */
  readonly ready: boolean;
  /** Why Build is disabled, or null when ready. */
  readonly gateMessage: string | null;

  // --- assignment capture (Declare Identities, Phase 2; NOT engine inputs yet) ---
  /** Assign a peak to one of the declared source's kit lines. `tier`/`reliable`
   * are looked up from the kit line matching `energyKeV` for that source. */
  assignPeak(rowId: string, peakId: string, energyKeV: number): void;
  /** Exclude a peak from any future manual fit (scientist's veto). */
  excludePeak(rowId: string, peakId: string): void;
  /** Return a peak to the undecided default. */
  clearPeak(rowId: string, peakId: string): void;
  /** The navigator's cursor: which source the Declare surface is editing.
   * Defaults to the first source; advances to a neighbour when the active row
   * is removed; null when the batch is empty. */
  readonly activeRowId: string | null;
  setActiveRow(rowId: string): void;

  // --- execution ---
  /** Finalize the batch -> one `calibrate()` call -> start the timed stage reveal. */
  build(): void;
  readonly phase: RunPhase;
  readonly result: CalibrationResult | null;

  // --- review / post-run ---
  readonly viewModel: 'linear' | 'quadratic';
  setViewModel(m: 'linear' | 'quadratic'): void;
  /** UI-only sub-state choosing which `done` surface renders: the dedicated Review
   * summary (default), or the full 8-stage walkthrough. Never touches {@link RunPhase}
   * or the engine -- `done` stays the single engine phase; this only selects the view. */
  readonly reviewView: 'summary' | 'walkthrough';
  /** Switch the `done` surface and re-render. */
  setReviewView(v: 'summary' | 'walkthrough'): void;
  /** Programmatic stage jump (only honoured when `done`). */
  goToStage(i: number): void;
  /** `calibrationStore.save` + `setActive`; throws on a store fault (fail-loud). */
  save(name: string): { name: string; id: string };
  /** New batch -> empty Source Manager (`collecting`). */
  reset(): void;
  /** Return to the Source Manager keeping the current batch + model (the error
   * surface's "Back to sources"). Distinct from {@link reset}, which empties it. */
  backToCollecting(): void;

  // --- view binding ---
  subscribe(listener: () => void): () => void;

  // --- lifecycle ---
  /** Cancel any in-flight reveal timer without altering phase/result, so no timer
   * fires into a torn-down view (called when the Calibrate view unmounts). */
  stopReveal(): void;
}

/** User-facing gate copy when the batch cannot yet build. The threshold mirrors
 * `MIN_FIT_POINTS` (the engine's ValidationError is the hard check). */
const GATE_MESSAGE =
  'Assign a known energy to at least 3 detected peaks (across any of your sources) to build a calibration.';

/** Eight stages, indices 0..7; the reveal advances to LAST_STAGE_INDEX then `done`. */
const LAST_STAGE_INDEX = 7;
/** Readable per-stage reveal pace; honours `prefers-reduced-motion` (instant). */
const STAGE_REVEAL_MS = 800;

class CalibrationManagerImpl implements CalibrationManager {
  private readonly _sources: ManagedSource[] = [];
  private _model: ModelChoice = 'auto';
  private _phase: RunPhase = { kind: 'collecting' };
  private _result: CalibrationResult | null = null;
  private _viewModel: 'linear' | 'quadratic' = 'linear';
  /** UI-only: which `done` surface renders. Reset to 'summary' on every entry to
   * `done` and on `reset`, so re-entering Review always lands on the summary first. */
  private _reviewView: 'summary' | 'walkthrough' = 'summary';
  /** The Declare navigator's cursor (Phase 2). */
  private _activeRowId: string | null = null;
  private _rowSeq = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private readonly _listeners = new Set<() => void>();

  // --- collection ----------------------------------------------------------

  addParsedSource(report: AnalysisReport): void {
    const fittedPeaks = validPeaks(report.validatedPeaks ?? validate(report.peaks));
    const fileName = report.spectrum.metadata.fileName;
    const suggestedId = suggestKitId(fileName);
    const rowId = `row-${++this._rowSeq}`;
    this._sources.push({
      rowId,
      fileName,
      sourceId: suggestedId, // pre-filled from the suggestion (Rule 12, editable)
      suggestedId,
      fittedPeaks,
      assignments: initialAssignments(rowId, fittedPeaks),
      counts: report.spectrum.counts,
      channelCount: report.spectrum.counts.length,
      report, // in-memory only (never persisted) -- for buildPipelineTrace
    });
    if (this._activeRowId === null) this._activeRowId = rowId; // first add = default cursor
    this._invalidateRun();
    this._emit();
  }

  removeSource(rowId: string): void {
    const i = this._sources.findIndex((s) => s.rowId === rowId);
    if (i < 0) return;
    // Removing the active row advances the cursor to a neighbour BEFORE the list
    // mutates: next-else-previous, null when none remain.
    if (this._activeRowId === rowId) {
      const neighbour = this._sources[i + 1] ?? this._sources[i - 1] ?? null;
      this._activeRowId = neighbour ? neighbour.rowId : null;
    }
    this._sources.splice(i, 1);
    this._invalidateRun();
    this._emit();
  }

  setIdentity(rowId: string, sourceId: string): void {
    const row = this._sources.find((s) => s.rowId === rowId);
    if (!row) return;
    row.sourceId = sourceId;
    // The old source's lines no longer apply: every decision resets to unassigned.
    row.assignments = initialAssignments(row.rowId, row.fittedPeaks);
    this._invalidateRun();
    this._emit();
  }

  setModel(choice: ModelChoice): void {
    this._model = choice;
    this._invalidateRun();
    this._emit();
  }

  get sources(): readonly ManagedSource[] {
    return this._sources;
  }
  get model(): ModelChoice {
    return this._model;
  }

  get ready(): boolean {
    // The build now fits from the scientist's assignments (calibrateFromMatches), so the
    // gate is simply "enough peaks have an energy assigned": >= MIN_FIT_POINTS assigned
    // decisions pooled across every source (a covariance-bearing fit needs that many).
    return this._assignedCount() >= MIN_FIT_POINTS;
  }

  /** Total `assigned` peak->energy decisions pooled across all sources -- the single count
   * the readiness gate reads (the same points `calibrateFromMatches` fits from). */
  private _assignedCount(): number {
    return this._sources.reduce(
      (n, s) => n + s.assignments.filter((a) => a.state === 'assigned').length,
      0,
    );
  }

  get gateMessage(): string | null {
    return this.ready ? null : GATE_MESSAGE;
  }

  // --- assignment capture (DDI Phase 4: now ENGINE INPUTS) -------------------
  // The assignments DRIVE the fit (`build` -> `calibrateFromMatches`), so an edit
  // must invalidate any built calibration -- exactly like a source/model change --
  // so the next Build re-fits from the current assignments (`_invalidateRun`).

  assignPeak(rowId: string, peakId: string, energyKeV: number): void {
    const found = this._findAssignment(rowId, peakId);
    if (!found) return;
    const { row, index } = found;
    const line = CALIBRATION_KIT.entries
      .find((e) => e.id === row.sourceId)
      ?.lines.find((l) => l.energyKeV === energyKeV);
    row.assignments[index] = {
      ...assignmentBase(row.assignments[index]),
      state: 'assigned',
      energyKeV,
      ...(row.sourceId ? { sourceId: row.sourceId } : {}),
      ...(line ? { tier: line.tier, reliable: line.reliable } : {}),
    };
    this._invalidateRun();
    this._emit();
  }

  excludePeak(rowId: string, peakId: string): void {
    const found = this._findAssignment(rowId, peakId);
    if (!found) return;
    const { row, index } = found;
    row.assignments[index] = { ...assignmentBase(row.assignments[index]), state: 'excluded' };
    this._invalidateRun();
    this._emit();
  }

  clearPeak(rowId: string, peakId: string): void {
    const found = this._findAssignment(rowId, peakId);
    if (!found) return;
    const { row, index } = found;
    row.assignments[index] = { ...assignmentBase(row.assignments[index]), state: 'unassigned' };
    this._invalidateRun();
    this._emit();
  }

  get activeRowId(): string | null {
    return this._activeRowId;
  }

  setActiveRow(rowId: string): void {
    if (this._activeRowId === rowId) return;
    if (!this._sources.some((s) => s.rowId === rowId)) return;
    this._activeRowId = rowId;
    this._emit();
  }

  // --- execution -----------------------------------------------------------

  build(): void {
    this._clearTimer();
    try {
      // The scientist's manual assignments DRIVE the fit (DDI Phase 4): pool every
      // `assigned` peak->energy decision across all sources into ONE equation via
      // `calibrateFromMatches` (global pooling; advisory σ-clip). The old two-pass
      // auto-matcher (`calibrate()`) is retired here -- the consolidated Assign-energies
      // step is now the authoritative channel->energy source, not filename-inferred kit
      // matching. Result shape is identical, so Review / the stage walkthrough are unchanged.
      const assignments = this._sources.flatMap((s) => s.assignments);
      this._result = calibrateFromMatches(assignments, { defaultModel: this._model });
      this._viewModel = this._result.selected; // honour the chosen / auto model
      this._startReveal();
    } catch (err) {
      this._result = null;
      this._phase = { kind: 'error', message: errText(err) };
      this._emit();
    }
  }

  get phase(): RunPhase {
    return this._phase;
  }
  get result(): CalibrationResult | null {
    return this._result;
  }

  // --- review / post-run ---------------------------------------------------

  get viewModel(): 'linear' | 'quadratic' {
    return this._viewModel;
  }

  setViewModel(m: 'linear' | 'quadratic'): void {
    if (this._viewModel === m) return;
    this._viewModel = m;
    this._emit();
  }

  get reviewView(): 'summary' | 'walkthrough' {
    return this._reviewView;
  }

  setReviewView(v: 'summary' | 'walkthrough'): void {
    if (this._reviewView === v) return;
    this._reviewView = v;
    this._emit();
  }

  goToStage(i: number): void {
    if (this._phase.kind !== 'done') return;
    const clamped = Math.min(Math.max(0, Math.floor(i)), LAST_STAGE_INDEX);
    void clamped; // post-run position is owned by the stage view (app.ts); see report
    this._emit();
  }

  save(name: string): { name: string; id: string } {
    if (!this._result) {
      throw new ValidationError('calibrationManager: no built calibration to save.');
    }
    const sources = this._sources.map((s) => s.sourceId);
    const rec = calibrationStore.save({ name, sources, result: this._result });
    calibrationStore.setActive(rec.id); // this becomes the active calibration for Identify
    return { name: rec.name, id: rec.id };
  }

  reset(): void {
    this._clearTimer();
    this._sources.length = 0;
    this._result = null;
    this._viewModel = 'linear';
    this._reviewView = 'summary'; // a New batch re-enters Review on the summary
    this._activeRowId = null;
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  backToCollecting(): void {
    this._clearTimer();
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  // --- view binding --------------------------------------------------------

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  stopReveal(): void {
    this._clearTimer();
  }

  // --- internals -----------------------------------------------------------

  private _findAssignment(
    rowId: string,
    peakId: string,
  ): { row: ManagedSource; index: number } | null {
    const row = this._sources.find((s) => s.rowId === rowId);
    if (!row) return null;
    const index = row.assignments.findIndex((a) => a.peakId === peakId);
    return index < 0 ? null : { row, index };
  }

  /** Set `phase: running, stageIndex 0`, then a cancellable timer advances the
   * index 0 -> 7 (~800 ms/stage). `prefers-reduced-motion` jumps straight to
   * `done`. On reaching the last stage, `phase: done`. */
  private _startReveal(): void {
    this._clearTimer();
    this._reviewView = 'summary'; // entering Review always lands on the summary first
    if (prefersReducedMotion()) {
      this._phase = { kind: 'done' };
      this._emit();
      return;
    }
    this._phase = { kind: 'running', stageIndex: 0 };
    this._emit();
    const tick = (): void => {
      if (this._phase.kind !== 'running') return;
      const next = this._phase.stageIndex + 1;
      if (next > LAST_STAGE_INDEX) {
        this._timer = null;
        this._phase = { kind: 'done' };
        this._emit();
        return;
      }
      this._phase = { kind: 'running', stageIndex: next };
      this._emit();
      this._timer = setTimeout(tick, STAGE_REVEAL_MS);
    };
    this._timer = setTimeout(tick, STAGE_REVEAL_MS);
  }

  /** A collection edit invalidates any in-flight / finished run: cancel the timer
   * and return to the Source Manager so the engine is re-run on the next Build. */
  private _invalidateRun(): void {
    this._clearTimer();
    this._result = null;
    if (this._phase.kind !== 'collecting') this._phase = { kind: 'collecting' };
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

/** Create a fresh manager. One instance is held per Calibrate mount (app.ts). */
export function createCalibrationManager(): CalibrationManager {
  return new CalibrationManagerImpl();
}

// --- helpers ----------------------------------------------------------------

/** Fresh all-unassigned decisions for a row's fitted peaks. `peakId` is
 * `${rowId}:${index}` -- stable within the source because `fittedPeaks` is
 * readonly. A non-finite centroid error (never expected from validPeaks) is
 * omitted rather than carried (matching the Phase 1 weightable rule). */
function initialAssignments(rowId: string, peaks: readonly FittedPeak[]): PeakAssignment[] {
  return peaks.map((p, i) => ({
    peakId: `${rowId}:${i}`,
    centroidChannel: p.centroidChannel,
    ...(Number.isFinite(p.centroidError) ? { centroidError: p.centroidError } : {}),
    state: 'unassigned' as const,
  }));
}

/** The identity fields every transition preserves (a decision never changes
 * WHICH peak it is about). Drops energy/source/tier/reliable so `assigned`
 * leftovers cannot leak into `excluded`/`unassigned` states. */
function assignmentBase(a: PeakAssignment): Pick<
  PeakAssignment,
  'peakId' | 'centroidChannel' | 'centroidError'
> {
  return {
    peakId: a.peakId,
    centroidChannel: a.centroidChannel,
    ...(a.centroidError != null ? { centroidError: a.centroidError } : {}),
  };
}

/** Review progress of one source's assignments (Declare navigator indicator).
 * `reviewed` = every peak decided (assigned or excluded); `untouched` = nothing
 * decided yet (including the zero-peak case -- there is nothing to mark done);
 * anything else is `in-progress`. NON-GATING: display only, never a build gate. */
export type ReviewStatus = 'untouched' | 'in-progress' | 'reviewed';
export function deriveReviewStatus(assignments: readonly PeakAssignment[]): ReviewStatus {
  if (!assignments.length) return 'untouched';
  if (assignments.every((a) => a.state === 'unassigned')) return 'untouched';
  if (assignments.every((a) => a.state !== 'unassigned')) return 'reviewed';
  return 'in-progress';
}

/** Best-effort identity suggestion from a filename (Rule 12: a hint only, always
 * overridable -- never authoritative). Matches each kit isotope's symbol+mass in
 * either order, so "137Cs-..." -> Cs-137 and "60Co-..." -> Co-60. */
export function suggestKitId(fileName: string): string {
  const f = fileName.toLowerCase();
  for (const e of CALIBRATION_KIT.entries) {
    const [sym, mass] = e.id.split('-');
    const s = sym.toLowerCase();
    if (f.includes(`${mass}${s}`) || f.includes(`${s}-${mass}`) || f.includes(`${s}${mass}`)) {
      return e.id;
    }
  }
  return '';
}

/** True when the OS asks for reduced motion (-> instant reveal). Guarded for
 * non-browser / test environments where `matchMedia` is absent. */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Engine fault -> honest message; anything else -> a labelled unexpected error. */
function errText(err: unknown): string {
  if (err instanceof NuclidError) return err.message;
  return `Unexpected error: ${(err as Error).message}`;
}
