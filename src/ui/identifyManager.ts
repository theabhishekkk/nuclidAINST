/**
 * IdentifyManager -- the UI-layer orchestrator for the execution-driven Identify
 * stepper (Manager / Engine split), the mirror of {@link CalibrationManager}. It is
 * the ONLY object the Identify view talks to: it collects every input the
 * identification needs up front (the unknown spectrum + the chosen calibration +
 * the nuclide library), then on Identify hands a finalized job to the engine in one
 * pass.
 *
 * Manager gathers, engine executes. The engine chain
 * (`applyCalibration` -> `identify` -> `summarizeIdentification`) is called AS-IS --
 * its numbers are byte-identical to the golden tests, nothing in `src/pipeline/*` is
 * touched. {@link build} is `runIdentify()`'s former body, moved here verbatim. The
 * "execution" the stepper shows is a presentational reveal of that one synchronous
 * result: the engine runs once, start to finish (per the approved design).
 *
 * LIVE-object discipline (DEBT-12): the {@link IdentificationResult} is stored
 * directly and rendered by object identity (caveat/overlay linkage); it is never
 * serialised / reparsed.
 *
 * Identity is an INPUT, never a filename (Rule 12): identity comes only from the
 * calibrated energies + the library. Fail-loud (RISK-01): with no calibration the
 * engine is not run and energies are never fabricated.
 *
 * The view binds via {@link IdentifyManager.subscribe}; the manager notifies on
 * every state change (collection edits, the timed stage reveal, completion, error).
 */
import type {
  AnalysisReport,
  Calibration,
  EnergisedPeak,
  IdentificationResult,
  IdentificationSummary,
  NuclideLibrary,
} from '../domain/types';
import { NuclidError, ValidationError } from '../domain/errors';
import { applyCalibration } from '../pipeline/applyCalibration';
import { applyCalibrationToChannel } from '../pipeline/calibrate';
import { identify, type IdentifyOptions } from '../pipeline/identify';
import { summarizeIdentification } from '../pipeline/identifyReport';
import { validate, validPeaks } from '../pipeline/validate';

/** The operator's chosen calibration: a saved record id + its resolved (selected)
 * equation + a display name. Identity is an INPUT -- the app resolves the equation
 * from the saved-calibrations library and hands it in (the manager never reads the
 * store directly). */
export interface IdentifyCalibrationChoice {
  /** Saved calibration record id (provenance; '' for a future built-in default). */
  readonly id: string;
  /** The resolved selected equation applied to the unknown's peaks. */
  readonly cal: Calibration;
  /** Operator-facing name (provenance display). */
  readonly name: string;
}

/** Tunable identification parameters -- the extensibility seam for the deferred
 * "Library + parameters" Configure step (hand-off §A). Iteration 1 surfaces none of
 * the tuning in the UI; only `library` is set (by the app, once the async load
 * completes). Everything else defaults to the engine's validated defaults. */
export interface IdentifyParams {
  /** The nuclide library to match against (the built-in is loaded by the app). */
  readonly library?: NuclideLibrary;
  /** Energy match floor, keV (engine default {@link IdentifyOptions.energyToleranceKeV}). */
  readonly energyToleranceKeV?: number;
  /** FWHM fraction widening the tolerance (engine default). */
  readonly fracFwhm?: number;
  /** Required-line intensity fraction (engine default). */
  readonly requiredFrac?: number;
  /** Score floor for inclusion (engine default). */
  readonly minScore?: number;
}

/** The top-level state of an identification run, one surface on screen at a time.
 * Local to this module (do NOT import Calibrate's `RunPhase` -- Isolation principle). */
export type IdentifyRunPhase =
  | { kind: 'collecting' } // Configure visible
  | { kind: 'running'; stageIndex: number } // auto-revealing stages 0..6
  | { kind: 'done' } // rail freely navigable
  | { kind: 'error'; message: string }; // engine NuclidError -- honest fail-loud

/** The manager contract the Identify view depends on (UI layer, not the engine). */
export interface IdentifyManager {
  // --- collection (Configure) ---
  /** The loaded unknown (its validatedPeaks + counts + metadata). Clears any prior run. */
  setSpectrum(report: AnalysisReport): void;
  /** Which saved calibration to apply (null = none selected). Clears any prior run. */
  setCalibration(choice: IdentifyCalibrationChoice | null): void;
  /** Merge tunable params (the deferred-tuning seam + the library). Clears any prior
   * run iff a provided value actually changed. */
  setParams(partial: Partial<IdentifyParams>): void;
  readonly report: AnalysisReport | null;
  readonly calibration: IdentifyCalibrationChoice | null;
  readonly params: IdentifyParams;
  /** Identify enabled? (cheap pre-check; the engine is the definitive gate). */
  readonly ready: boolean;
  /** Why Identify is disabled, or null when ready. */
  readonly gateMessage: string | null;

  // --- execution ---
  /** Finalize inputs -> one engine chain -> start the timed stage reveal. */
  build(): void;
  readonly phase: IdentifyRunPhase;
  readonly result: IdentificationResult | null;
  readonly summary: IdentificationSummary | null;
  /** The energised peaks the run scored (LIVE objects; for the stages). */
  readonly energised: readonly EnergisedPeak[] | null;
  /** The applied calibration + its display name (for the energy axis + provenance). */
  readonly cal: Calibration | null;
  readonly calName: string;

  // --- review / post-run ---
  /** UI-only sub-state choosing which `done` surface renders: the Review summary
   * (default) or the full 7-stage walkthrough. Never touches {@link IdentifyRunPhase}. */
  readonly reviewView: 'summary' | 'walkthrough';
  setReviewView(v: 'summary' | 'walkthrough'): void;
  /** Which ranked isotope the Stage 5/7 overlay highlights (null = top-ranked). */
  readonly overlayId: string | null;
  setOverlay(isotopeId: string | null): void;
  /** Programmatic stage jump (only honoured when `done`). */
  goToStage(i: number): void;

  // --- lifecycle ---
  /** New unknown -> empty Configure (`collecting`); keeps the library + tuning. */
  reset(): void;
  /** Return to Configure keeping the inputs (the error surface's "Back"). */
  backToCollecting(): void;
  subscribe(listener: () => void): () => void;
  /** Cancel any in-flight reveal timer without altering phase/result. */
  stopReveal(): void;
}

/** Seven stages, indices 0..6; the reveal advances to LAST_STAGE_INDEX then `done`. */
const LAST_STAGE_INDEX = 6;
/** Readable per-stage reveal pace; honours `prefers-reduced-motion` (instant). */
const STAGE_REVEAL_MS = 800;

class IdentifyManagerImpl implements IdentifyManager {
  private _report: AnalysisReport | null = null;
  private _calibration: IdentifyCalibrationChoice | null = null;
  private _params: IdentifyParams = {};
  private _phase: IdentifyRunPhase = { kind: 'collecting' };
  private _result: IdentificationResult | null = null;
  private _summary: IdentificationSummary | null = null;
  private _energised: readonly EnergisedPeak[] | null = null;
  private _cal: Calibration | null = null;
  private _calName = '';
  private _overlayId: string | null = null;
  private _reviewView: 'summary' | 'walkthrough' = 'summary';
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private readonly _listeners = new Set<() => void>();

  // --- collection ----------------------------------------------------------

  setSpectrum(report: AnalysisReport): void {
    this._report = report;
    this._invalidateRun();
    this._emit();
  }

  setCalibration(choice: IdentifyCalibrationChoice | null): void {
    this._calibration = choice;
    this._invalidateRun();
    this._emit();
  }

  setParams(partial: Partial<IdentifyParams>): void {
    // Only invalidate when a provided value actually changes -- so re-pushing the
    // already-loaded library on a later render is a no-op (no spurious run reset).
    let changed = false;
    const next: IdentifyParams = { ...this._params };
    for (const key of Object.keys(partial) as (keyof IdentifyParams)[]) {
      const v = partial[key];
      if (next[key] !== v) {
        (next as Record<string, unknown>)[key] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this._params = next;
    this._invalidateRun();
    this._emit();
  }

  get report(): AnalysisReport | null {
    return this._report;
  }
  get calibration(): IdentifyCalibrationChoice | null {
    return this._calibration;
  }
  get params(): IdentifyParams {
    return this._params;
  }

  get ready(): boolean {
    return this._report != null && this._calibration != null && this._params.library != null;
  }

  get gateMessage(): string | null {
    if (this._report == null) return 'Load an unknown spectrum to identify.';
    if (this._params.library == null)
      return 'Nuclide library is still loading -- try again in a moment.';
    if (this._calibration == null) return 'Select a saved calibration to set the energy axis.';
    return null;
  }

  // --- execution -----------------------------------------------------------

  /** {@link runIdentify}'s former body, verbatim: resolve the calibration, energise
   * the validated peaks (I1), identify against the library (I2), summarise (I3), then
   * start the reveal. Fail-loud on a thrown NuclidError (honest message, no fabricated
   * energies). */
  build(): void {
    this._clearTimer();
    try {
      const report = this._report;
      const choice = this._calibration;
      const library = this._params.library;
      if (!report) throw new ValidationError('Load an unknown spectrum before identifying.');
      if (!library)
        throw new ValidationError('Nuclide library is still loading -- try again in a moment.');
      if (!choice) {
        throw new ValidationError(
          'No calibration selected -- pick a saved calibration (Calibrate mode) before identifying; ' +
            'energies are never fabricated from an uncalibrated spectrum.',
        );
      }
      const cal = choice.cal;
      const fitted = validPeaks(report.validatedPeaks ?? validate(report.peaks));
      const energised = applyCalibration(fitted, cal); // I1
      // Pass the calibrated full-spectrum span as the in-range window (mirrors the
      // reference `calib.energy` over [0, nchan-1]). Without it I2 falls back to the
      // measured peak span, which can clip a library line just beyond the outermost
      // peak (e.g. Cs-137's 661.7 keV line) -- see the A1d browser-gate note.
      const lastChannel = report.spectrum.counts.length - 1;
      const energyRange: [number, number] = [
        applyCalibrationToChannel(cal, 0),
        applyCalibrationToChannel(cal, lastChannel),
      ];
      const result = identify(energised, library, this._identifyOptions(energyRange)); // I2 -- LIVE (DEBT-12)
      const summary = summarizeIdentification(result); // I3
      this._result = result;
      this._summary = summary;
      this._energised = energised;
      this._cal = cal;
      this._calName = choice.name;
      this._overlayId = result.ranked[0]?.nuclide.id ?? null;
      this._startReveal();
    } catch (err) {
      this._clearResult();
      this._phase = { kind: 'error', message: errText(err) };
      this._emit();
    }
  }

  /** Build the engine options: the calibrated energy range + any tuning the deferred
   * params seam carries (all undefined in iteration 1 -> the engine's defaults). */
  private _identifyOptions(energyRange: [number, number]): IdentifyOptions {
    const p = this._params;
    return {
      energyRange,
      ...(p.energyToleranceKeV != null ? { energyToleranceKeV: p.energyToleranceKeV } : {}),
      ...(p.fracFwhm != null ? { fracFwhm: p.fracFwhm } : {}),
      ...(p.requiredFrac != null ? { requiredFrac: p.requiredFrac } : {}),
      ...(p.minScore != null ? { minScore: p.minScore } : {}),
    };
  }

  get phase(): IdentifyRunPhase {
    return this._phase;
  }
  get result(): IdentificationResult | null {
    return this._result;
  }
  get summary(): IdentificationSummary | null {
    return this._summary;
  }
  get energised(): readonly EnergisedPeak[] | null {
    return this._energised;
  }
  get cal(): Calibration | null {
    return this._cal;
  }
  get calName(): string {
    return this._calName;
  }

  // --- review / post-run ---------------------------------------------------

  get reviewView(): 'summary' | 'walkthrough' {
    return this._reviewView;
  }

  setReviewView(v: 'summary' | 'walkthrough'): void {
    if (this._reviewView === v) return;
    this._reviewView = v;
    this._emit();
  }

  get overlayId(): string | null {
    return this._overlayId;
  }

  setOverlay(isotopeId: string | null): void {
    if (this._overlayId === isotopeId) return;
    this._overlayId = isotopeId;
    this._emit();
  }

  goToStage(i: number): void {
    if (this._phase.kind !== 'done') return;
    const clamped = Math.min(Math.max(0, Math.floor(i)), LAST_STAGE_INDEX);
    void clamped; // post-run position is owned by the stage view (app.ts); mirrors Calibrate
    this._emit();
  }

  // --- lifecycle -----------------------------------------------------------

  reset(): void {
    this._clearTimer();
    this._report = null;
    this._clearResult();
    this._reviewView = 'summary';
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  backToCollecting(): void {
    this._clearTimer();
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  stopReveal(): void {
    this._clearTimer();
  }

  // --- internals -----------------------------------------------------------

  /** Set `phase: running, stageIndex 0`, then a cancellable timer advances the index
   * 0 -> 6 (~800 ms/stage). `prefers-reduced-motion` jumps straight to `done`. */
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

  /** A collection edit invalidates any in-flight / finished run: cancel the timer,
   * clear the result, and return to Configure so the engine re-runs on the next build. */
  private _invalidateRun(): void {
    this._clearTimer();
    this._clearResult();
    if (this._phase.kind !== 'collecting') this._phase = { kind: 'collecting' };
  }

  /** Drop the live run outputs (DEBT-12: the live objects, never serialised). */
  private _clearResult(): void {
    this._result = null;
    this._summary = null;
    this._energised = null;
    this._cal = null;
    this._calName = '';
    this._overlayId = null;
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

/** Create a fresh manager. One instance is held per Identify mount (app.ts). */
export function createIdentifyManager(): IdentifyManager {
  return new IdentifyManagerImpl();
}

// --- helpers ----------------------------------------------------------------

/** True when the OS asks for reduced motion (-> instant reveal). Guarded for
 * non-browser / test environments where `matchMedia` is absent. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Engine fault -> honest message; anything else -> a labelled unexpected error. */
function errText(err: unknown): string {
  if (err instanceof NuclidError) return err.message;
  return `Unexpected error: ${(err as Error).message}`;
}
