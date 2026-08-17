/**
 * PeakFinderManager -- the UI-layer orchestrator for the Peak Finder workflow, the
 * third instance of the manager pattern beside {@link CalibrationManager} and
 * {@link IdentifyManager}. It is the ONLY object the Peak Finder view talks to.
 *
 * Single responsibility (approved plan `PLAN_PEAK_DETECTION_MODE.md` Rev 2):
 * spectrum in -> peak detection -> detected peaks out. CHANNEL SPACE ONLY -- no
 * energies, no calibration, no identification, ever.
 *
 * The engine runs ONCE, synchronously, when the user hits Continue, producing the
 * full result across the eight PF Run stages (local-maxima -> distance -> prominence
 * -> width -> strength -> classification -> fit -> validated); focus then lands
 * directly on the Review step. (The former timed stage-by-stage reveal animation was
 * removed 2026-07-07.) Detection uses default `DetectOptions` only (tunable controls
 * are PARKED -- see PARK-13).
 *
 * // Divergence: Configure collapses to a single Load step -- no identities, no
 * // model choice, no library (Peak Finder has exactly one input).
 * // Divergence (R2, revised Load stage 2026-07-04): loading a spectrum parses it and
 * // HOLDS it (`preprocessing` phase) -- it no longer auto-runs. The run starts on an
 * // EXPLICIT Continue (`run()`), after the optional Load-stage smoothing step.
 * // Divergence (R4): the Load stage OWNS Savitzky-Golay smoothing. The manager keeps
 * // an immutable `rawSpectrum` and, when SG is enabled, a `smoothedSpectrum` as its own
 * // series (neither overwrites the other, §2/§3).
 * // Divergence (Estimate Continuum, SD3): continuum estimation is a distinct interactive
 * // stage. `continuumInput` selects which representation (Raw / Smoothed) feeds the
 * // shared SNIP core; detection then analyses that input with condition `smoothing:'none'`
 * // (no double-smooth) and fits areas from raw (R1, `rawSource`).
 *
 * The view binds via {@link PeakFinderManager.subscribe}; the manager notifies on
 * every state change (the load-stage SG toggles, detection completion, error, resets).
 */
import type { AnalysisReport, PipelineTrace, Spectrum, StageTrace } from '../domain/types';
import { NuclidError } from '../domain/errors';
import { load as parseSpectrum } from '../pipeline/load';
import {
  estimateContinuum,
  estimateBackgroundTraced,
  lls,
  SNIP_DEFAULT_ITERATIONS,
  type SnipTrace,
} from '../pipeline/condition';
import { runPeakFinderTraced } from '../pipeline/runPeakFinder';
import type { PeakFinderConfig } from '../pipeline/peakFinderConfig';
import type { SpectrumStatus } from '../pipeline/spectrumStatus';
import { savitzkyGolay } from '../signal';
import { PF_STEP_IDS } from './peakFinderStepper';

/** Flat navigation indices (single source: {@link PF_STEP_IDS}). The manager latches its
 * `reached` / `focus` markers on these; the stepper renders from the same ordered list, so
 * the two never drift. */
const DETECT_OFFSET = PF_STEP_IDS.indexOf('run-0');
const REVIEW_INDEX = PF_STEP_IDS.length - 1;

/** Recommended Savitzky-Golay defaults for the Load stage. Window 9 / polyorder 3 is
 * the confirmed sweet spot (O1 research, `FINDINGS_PEAK_FINDER_SG_DEFAULTS.md`).
 * Pre-filled + reset target; editable only when SG is enabled. */
export const SG_DEFAULT_WINDOW = 9;
export const SG_DEFAULT_POLYORDER = 3;

/** Manual-entry guardrails for the SG fields (O1 §6b, "clamp + advisory"). The window
 * is HARD-clamped to an odd value in [5, 15]; polyorder to [2, 4] (always < window since
 * window >= 5). Over-smoothing (large window) is the dangerous direction — real
 * photopeaks vanish past window ~13 — so the band caps it; under-smoothing is benign.
 * // Divergence / caveat: the band is tied to the shipped NaI / 2046-channel regime
 * (FINDINGS §6b); re-centre it if the §5 adaptive-window rule is ever adopted. */
const SG_WINDOW_MIN = 5;
const SG_WINDOW_MAX = 15;
const SG_POLYORDER_MIN = 2;
const SG_POLYORDER_MAX = 4;
/** In-band advisory messages (non-blocking): shown at the low edge (5) and the high
 * edge (13/15); the no-warn band 7/9/11 gets `null`. */
const SG_ADVISORY_LOW = 'Light smoothing — more false candidates may appear.';
const SG_ADVISORY_HIGH = 'Heavy smoothing — narrow peaks may be suppressed or merged.';

/** Detection-SG (Phase 2) combined over-smoothing advisory (non-blocking). Distinct from
 * the Load-stage {@link SG_ADVISORY_HIGH}: it fires against the EFFECTIVE (combined) window
 * only when BOTH the preprocessing SG (smoothed input) and this detection SG are active, so
 * stacked smoothing is a visible, guarded choice (understanding doc §8, rule 2). */
const DETECTION_SG_ADVISORY_HEAVY =
  'Combined smoothing is heavy — narrow peaks may be suppressed or merged. ' +
  'Consider a smaller detection window or the raw input.';
/** The window at/above which the Load-stage advisory calls smoothing "heavy"; reused as the
 * detection-SG effective-window threshold so both advisories share ONE band (rule 2). */
const SG_WINDOW_HEAVY = 13;

/** An identifier for one selectable continuum INPUT representation. The registry ships
 * with Raw + the Load-stage Savitzky–Golay smoothed spectrum; future denoisers
 * (Wavelet / Median / …) plug in here with no engine change (the "select an input
 * spectrum" paradigm -- the engine is fixed; the input is chosen). */
export type SpectrumInputId = 'raw' | 'smoothed';

/** One selectable continuum input: its id, a display label, and the spectrum itself.
 * {@link PeakFinderManager.availableInputs} returns Raw always, plus Smoothed when a
 * Load-stage SG spectrum exists. */
export interface SpectrumInput {
  readonly id: SpectrumInputId;
  readonly label: string;
  readonly spectrum: Spectrum;
}

/**
 * The Peak Finder execution / animation state (2026-07-05 free-navigation restructure).
 * Navigation position is carried SEPARATELY by `focus` / `reached` (flat indices); this
 * enum is execution state ONLY. `held` covers "a spectrum is loaded and the user is
 * navigating Load + Continuum freely"; whether detection has run is read from
 * `report != null`, and `done` is simply `held` with a report present. Local to this
 * module (Isolation principle -- never import another mode's phase).
 */
export type PeakFinderRunPhase =
  | { kind: 'collecting' } // the empty Load step -- no spectrum yet
  | { kind: 'held' } // a spectrum is held; free navigation across the unlocked steps
  | { kind: 'error'; message: string }; // engine NuclidError -- honest fail-loud

/** The manager contract the Peak Finder view depends on (UI layer, not the engine). */
export interface PeakFinderManager {
  // --- the single input: parse-and-hold; the app then auto-runs to Review ---
  /** Parse the loaded spectrum and HOLD it at Load Spectrum (the `held` phase). The raw
   * chart + info cards are ready; the run is driven separately. A parse fault lands on the
   * honest `error` phase. The interactive app calls {@link performPeakFitting} immediately
   * after a successful load (straight-to-output); a direct caller stays held so each stage
   * op can be exercised in isolation. `fileSizeBytes` (when known) is threaded into the
   * parsed metadata for the Load stage's File Information card. */
  load(text: string, fileName: string, fileSizeBytes?: number): void;

  /** The immutable raw spectrum as parsed -- never overwritten while it is held
   * (§3 invariant). `null` before a spectrum is loaded / after a reset. */
  readonly rawSpectrum: Spectrum | null;
  /** The Load-stage Savitzky-Golay smoothed spectrum, persisted as its OWN spectrum
   * (never overwriting the raw). `null` when SG is not applied. It is one selectable
   * continuum input, NOT an implicit working series (§2 paradigm shift). */
  readonly smoothedSpectrum: Spectrum | null;
  /** Which representation feeds continuum estimation (default `'smoothed'`, 2026-07-07; the
   * smoothed input is computed on the SG stage before the continuum reads it, and until then
   * {@link selectedInput} falls back to raw). */
  readonly continuumInput: SpectrumInputId;
  /** The resolved spectrum the continuum + detection actually consume for the current
   * {@link continuumInput} (raw, or the smoothed input when selected + available).
   * `null` until a spectrum is held. */
  readonly selectedInput: Spectrum | null;
  /** The input registry: Raw always, plus Smoothed when {@link smoothedSpectrum} exists.
   * The extension seam -- future preprocessors register another `{ id, label, spectrum }`
   * with no engine change. Empty until a spectrum is held. */
  availableInputs(): readonly SpectrumInput[];
  /** The SNIP background for the selected input (Estimate Continuum stage). `null` until
   * the continuum has been estimated. */
  readonly backgroundSpectrum: readonly number[] | null;
  /** The net = selected input − background (clamped ≥ 0), the series detection consumes.
   * `null` until the continuum has been estimated. */
  readonly netSpectrum: readonly number[] | null;
  /** The selected input in the LLS (log-log-sqrt) domain -- the working copy the SNIP
   * peak-clipping operates on. Display reconstruction (no re-run); `null` until computed. */
  readonly llsInput: readonly number[] | null;
  /** The SNIP background in the LLS domain (the pre-inverse-LLS clipped state, reconstructed
   * as `background.map(lls)` for display -- honest to within the ≥ 0 clamp). `null` until
   * computed. */
  readonly llsBackground: readonly number[] | null;
  /** The EFFECTIVE SNIP iteration count the continuum estimation ran (the module default,
   * single-sourced from `condition.ts`) -- for the SNIP education page's honest report. */
  readonly snipIterations: number;
  /** A traced SNIP run over the selected input (LLS-domain checkpoint snapshots + per-iteration
   * max-change), captured once when the continuum is estimated -- the data the SNIP Peak Clipping
   * education page's iteration stepper + convergence card read. `null` until the continuum has
   * been estimated. Additive: the committed background is byte-identical with or without it. */
  readonly snipTrace: SnipTrace | null;
  /** The net the detection actually consumes: the (un-clipped) net Savitzky-Golay-smoothed
   * then clipped ≥ 0 when the net SG is on, else the clipped net itself (= {@link netSpectrum}).
   * Matches `condition`'s savgol branch exactly. `null` until the continuum is computed. */
  readonly workingNet: readonly number[] | null;
  /** Current SG window length (pre-filled {@link SG_DEFAULT_WINDOW}). */
  readonly sgWindow: number;
  /** Current SG polynomial order (pre-filled {@link SG_DEFAULT_POLYORDER}). */
  readonly sgPolyorder: number;
  /** The engine's fail-loud message when the current SG params are invalid, else
   * `null`. Surfaced inline; the run is blocked while it is set. */
  readonly sgError: string | null;
  /** A NON-blocking advisory when the (in-band) window sits at an edge of the sensible
   * range — light smoothing at 5, heavy at 13/15 — else `null`. Distinct from
   * {@link sgError}: it NEVER blocks the run (O1 §6b, clamp + advisory). */
  readonly sgAdvisory: string | null;

  /** Set the SG window + polyorder and recompute the smoothed spectrum. The params are
   * CLAMPED to the sensible band (window 5..15 odd, polyorder 2..4) before storing, so
   * the field re-renders showing what will actually run (O1 §6b). `smoothing` stage only. */
  setSgParams(params: { window: number; polyorder: number }): void;
  /** Restore the recommended SG defaults and recompute. `smoothing` stage only. */
  resetSgDefaults(): void;

  // --- Net Savitzky-Golay (#3): the net-SG stage mirrors the raw-SG stage -- the smoothed-net
  // is ALWAYS computed, and the Net / Smoothed-Net choice picks which series carries into
  // detection + strength. No on/off toggle (D-3a); default Smoothed-Net (2026-07-07). ---
  /** Which net series carries forward: the Net / Smoothed-Net choice (mirrors the raw stage's
   * Raw / Smoothed {@link continuumInput}). Default `'smoothed-net'` (2026-07-07; re-tunable on
   * the Review page). The smoothed-net is always computed ({@link smoothedNetSpectrum}); this
   * only chooses which one detection + strength consume. */
  readonly netInput: 'net' | 'smoothed-net';
  /** The always-computed SG-smoothed clipped net -- previewable regardless of {@link netInput}
   * so the selector can show Net vs Smoothed-Net side by side (mirrors {@link smoothedSpectrum}
   * for the raw stage). `null` until the continuum is computed. */
  readonly smoothedNetSpectrum: readonly number[] | null;
  /** Detection-SG window length (its OWN param, independent of {@link sgWindow}). */
  readonly detectionSgWindow: number;
  /** Detection-SG polynomial order (its OWN param, independent of {@link sgPolyorder}). */
  readonly detectionSgPolyorder: number;
  /** A NON-blocking advisory when the EFFECTIVE (combined) smoothing is heavy — only when
   * BOTH the preprocessing SG (smoothed input) and the detection SG are on; else `null`. */
  readonly detectionSgAdvisory: string | null;
  /** The detection-series lineage, e.g. `Raw → SG(w=9) → SNIP net → SG(w=7)`, reflecting the
   * REAL provenance: preprocessing SG (iff the smoothed input is selected) → SNIP net →
   * detection SG (iff on). Rendered on the Estimate Continuum stage (rule 1). */
  readonly detectionProvenance: string;
  /** #3: choose which net series carries forward (Net vs Smoothed-Net). Valid once the
   * continuum is computed. Mirrors {@link setContinuumInput}. */
  setNetInput(input: 'net' | 'smoothed-net'): void;
  /** Set the detection-SG window + polyorder, CLAMPED to the same sensible band as the
   * Load-stage SG (window 5..15 odd, polyorder 2..4). Valid once the continuum is computed. */
  setDetectionSgParams(params: { window: number; polyorder: number }): void;
  /** Restore the recommended detection-SG defaults. Valid once the continuum is computed. */
  resetDetectionSgDefaults(): void;

  // --- free navigation: `reached` (unlock high-water) + `focus` (on-screen step) ---
  /** The monotone high-water flat index: every step at or before it is UNLOCKED (directly
   * clickable in the rail). Advanced only by the Continue actions below; reset only by
   * {@link reset} / {@link backToCollecting}. Never pulled back by {@link goToStep}. */
  readonly reached: number;
  /** The flat index of the step currently on screen (the `.current` rail row). */
  readonly focus: number;
  /** The id of the focused step ({@link PF_STEP_IDS}`[focus]`) -- the panel-routing key. */
  readonly focusId: string;
  /** Move focus to an already-reached step by id (free backward/forward navigation). No-op
   * for an unknown / locked id, or (during the reveal) a detect step ahead of the cursor.
   * Focus-only: never changes any step's lock / status / `reached`. */
  goToStep(id: string): void;

  // --- forward milestones (each advances `reached` + focuses the new frontier) ---
  /** Continue from Load Spectrum to the raw Savitzky-Golay stage. No-op without a held
   * spectrum. Computes the smoothed spectrum on entry. */
  continueToSmoothing(): void;
  /** Continue from the raw Savitzky-Golay stage to Estimate Continuum: resolve the selected
   * input and estimate the continuum (SNIP background + net) for it. No-op without a held
   * spectrum or while an SG param is invalid. */
  continueToContinuum(): void;
  /** Choose which spectrum (Raw / Savitzky-Golay smoothed) feeds ALL downstream stages (the
   * single input-choice point, SD-1). No-op for an unavailable input or a no-op re-selection,
   * or once detection has run (slice 3 relaxes this for live recompute). Fitting always uses
   * raw (R1) regardless of this choice. */
  setContinuumInput(id: SpectrumInputId): void;
  /** Continue from Estimate Continuum to Detection: analyse the selected input (condition
   * `smoothing:'none'` unless the detection SG is on, fit areas from `rawSpectrum` -- R1),
   * derive the status contract + {@link PipelineTrace}, then start the detection reveal.
   * No-op unless the continuum is computed. */
  runDetection(): void;

  /** "Perform Peak Fitting" (2026-07-08): run the WHOLE pipeline -- smoothed then continuum then
   * detection -- in one shot and land directly on the Review page (the final output) with every
   * step `reached`. Safe to call straight after a fresh {@link load} (the app's straight-to-output
   * path) as well as from either Savitzky-Golay stage; it (re)computes the smoothed series itself
   * and falls back to raw if the smoothed pick is unavailable, so a run always yields output. A
   * no-op unless a spectrum is held. On an engine fault it lands the honest `error` phase. */
  performPeakFitting(): void;

  /** Seed the manager from an ALREADY-PARSED spectrum + a full {@link PeakFinderConfig} and run to
   * the done state -- the drill-in entry point from the batch. It applies every knob (the inverse
   * of the internal config snapshot), computes the continuum, runs detection, and lands `held`
   * with every step reached and focus on Review -- no re-parse, no animation. Because it drives
   * the SAME `runPeakFinder` path a batch queue entry used, the drilled-in report is byte-identical
   * to that entry's result. On an engine fault it lands the honest `error` phase. */
  hydrate(spectrum: Spectrum, config: PeakFinderConfig): void;

  /** The manager's current knobs as a {@link PeakFinderConfig} value -- the inverse read of
   * {@link hydrate}. The batch drill-in captures this on return to persist any operator tuning as
   * the entry's per-file override. */
  currentConfig(): PeakFinderConfig;

  readonly report: AnalysisReport | null;
  /** The orchestrator's per-stage timing trace (kept for the P2 summary panel). */
  readonly stageTrace: readonly StageTrace[] | null;
  /** The precomputed inspector trace every stage chart draws from. */
  readonly pipelineTrace: PipelineTrace | null;
  /** The Phase-1 status contract, derived ONCE here (single source of truth). */
  readonly status: SpectrumStatus | null;
  readonly phase: PeakFinderRunPhase;

  /** Whole seconds left before the `error` phase auto-returns to the Load step, or
   * `null` when no recovery countdown is running (any non-error phase). Additive
   * read-only signal the error surface renders; see {@link PeakFinderManager.load}. */
  readonly errorCountdown: number | null;

  // --- lifecycle ---
  /** Drop the loaded spectrum + run -> empty Load step (`collecting`). */
  reset(): void;
  /** Return to the Load step keeping nothing stale (the error surface's back path). */
  backToCollecting(): void;
  subscribe(listener: () => void): () => void;
  /** Cancel the in-flight error-recovery countdown timer without altering phase/result.
   * (Named for the historical reveal it also used to cancel; the stepping animations are gone.) */
  stopReveal(): void;
}

/** On a load/engine fault the honest `error` surface shows for this long, counting
 * down per second, then auto-returns to the Load step via {@link backToCollecting}
 * (operator ruling, Rev 4). Cancellable -- see {@link _startErrorRecovery}. */
const PF_ERROR_RECOVERY_MS = 5000;

class PeakFinderManagerImpl implements PeakFinderManager {
  private _report: AnalysisReport | null = null;
  private _stageTrace: readonly StageTrace[] | null = null;
  private _pipelineTrace: PipelineTrace | null = null;
  private _status: SpectrumStatus | null = null;
  private _phase: PeakFinderRunPhase = { kind: 'collecting' };
  // Free-navigation markers (2026-07-05): `_reached` is the monotone unlock high-water,
  // `_focus` the on-screen step -- both flat indices into PF_STEP_IDS. `_focus` follows the
  // frontier on a Continue and is set freely by goToStep; `_reached` only advances (Continue)
  // and only resets on reset()/backToCollecting.
  private _reached = 0;
  private _focus = 0;
  // A single cancellable timer drives the error-recovery countdown. (The continuum walkthrough
  // and detect-reveal stepping animations were removed 2026-07-07 -- Continue/Run now land on
  // their destination step instantly.) `_clearTimer` stops it on every lifecycle transition.
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _errorCountdown: number | null = null;
  private readonly _listeners = new Set<() => void>();

  // Load-stage + continuum state (§2/§3: all independent; the raw is never overwritten).
  // `_rawSpectrum` is immutable while held; `_smoothedSpectrum` is the SG result as its
  // OWN spectrum (null when SG off); `_continuumInput` selects which feeds continuum;
  // `_background`/`_net` are the SNIP output + net for the selected input.
  private _rawSpectrum: Spectrum | null = null;
  private _smoothedSpectrum: Spectrum | null = null;
  // Default input is the Savitzky-Golay smoothed spectrum (2026-07-07): the SG stages are no
  // longer a mandatory upfront decision -- the pipeline runs smoothed by default and the user
  // re-tunes the choice from the Review page if unsatisfied. `_smoothedSpectrum` is null on a
  // fresh load but computed by `continueToSmoothing` before the continuum reads `selectedInput`.
  private _continuumInput: SpectrumInputId = 'smoothed';
  private _background: readonly number[] | null = null;
  private _net: readonly number[] | null = null;
  // A traced SNIP run over the selected input, captured alongside `_background` in
  // `_computeContinuum` (one extra clip, isolated in the engine). Feeds the SNIP page's iteration
  // stepper + convergence card; `null` until the continuum is computed.
  private _snipTrace: SnipTrace | null = null;
  // The net the detection consumes (= net or smoothed-net per `_netInput`), kept as its own
  // series so the cont-sg preview equals exactly what `condition`'s savgol branch produces.
  private _workingNet: readonly number[] | null = null;
  // The always-computed SG-smoothed clipped net (previewable regardless of `_netInput`), so the
  // Net / Smoothed-Net selector can show both (mirrors `_smoothedSpectrum` for the raw stage).
  private _smoothedNet: readonly number[] | null = null;
  private _sgWindow = SG_DEFAULT_WINDOW;
  private _sgPolyorder = SG_DEFAULT_POLYORDER;
  private _sgError: string | null = null;
  private _sgAdvisory: string | null = null;
  // Net SG (#3): the smoothed-net is ALWAYS computed; `_netInput` is the Net / Smoothed-Net
  // choice of which series carries forward. Default 'smoothed-net' (2026-07-07): the net SG is
  // no longer a mandatory upfront gate -- detection runs on the smoothed net by default and the
  // user re-tunes from the Review page if unsatisfied. The SG params are its OWN, independent of
  // the Load-stage SG.
  private _netInput: 'net' | 'smoothed-net' = 'smoothed-net';
  private _detectionSgWindow = SG_DEFAULT_WINDOW;
  private _detectionSgPolyorder = SG_DEFAULT_POLYORDER;

  // --- Load stage: parse-and-hold (the app layer then auto-runs to Review) ----

  load(text: string, fileName: string, fileSizeBytes?: number): void {
    this._clearTimer();
    this._errorCountdown = null;
    try {
      // Parse only (Stage 1) and HOLD the spectrum at Load Spectrum. The interactive app drives
      // the full run immediately after (straight-to-output, 2026-07-08); a direct manager caller
      // stays held so the granular stage ops remain independently exercisable.
      const spectrum = parseSpectrum({
        text,
        fileName,
        ...(fileSizeBytes !== undefined ? { fileSizeBytes } : {}),
      });
      this._clearRun(); // drop any prior run's artifacts
      // Fresh file = fresh continuum: drop any stale SNIP background/net so `reached` cannot
      // read a prior run's continuum as still-computed.
      this._background = null;
      this._net = null;
      this._snipTrace = null;
      this._workingNet = null;
      this._rawSpectrum = spectrum;
      this._resetSgState(); // recommended SG defaults + SG-smoothed input choice on every fresh load
      // The smoothed series is null until `_recomputeSmoothed` runs; until then `selectedInput`
      // falls back to the raw (the guard in its getter). continuumInput defaults to 'smoothed' via
      // _resetSgState (2026-07-07: SG is the standing default, re-tunable on Review). The app layer
      // drives the full run right after this (loadPeakFinderSpectrum -> performPeakFitting), landing
      // the operator on Review; a direct manager caller (unit tests) stays parked at Load Spectrum.
      this._reached = 0;
      this._focus = 0;
      this._phase = { kind: 'held' };
      this._emit();
    } catch (err) {
      this._clearRun();
      this._clearLoad();
      this._phase = { kind: 'error', message: errText(err) };
      // Fail-loud, then auto-recover -- show the message with a visible per-second
      // countdown and return to the Load step (backToCollecting).
      this._startErrorRecovery();
    }
  }

  // --- free navigation ------------------------------------------------------

  get reached(): number {
    return this._reached;
  }
  get focus(): number {
    return this._focus;
  }
  get focusId(): string {
    return PF_STEP_IDS[this._focus] ?? PF_STEP_IDS[0];
  }

  /** Focus-only navigation to an already-reached step. No-op for unknown / locked ids. */
  goToStep(id: string): void {
    const idx = PF_STEP_IDS.indexOf(id);
    if (idx < 0 || idx > this._reached) return; // unknown or locked
    if (idx === this._focus) return;
    this._focus = idx;
    this._emit();
  }

  get rawSpectrum(): Spectrum | null {
    return this._rawSpectrum;
  }
  get smoothedSpectrum(): Spectrum | null {
    return this._smoothedSpectrum;
  }
  get continuumInput(): SpectrumInputId {
    return this._continuumInput;
  }
  get selectedInput(): Spectrum | null {
    if (!this._rawSpectrum) return null;
    if (this._continuumInput === 'smoothed' && this._smoothedSpectrum) return this._smoothedSpectrum;
    return this._rawSpectrum;
  }
  availableInputs(): readonly SpectrumInput[] {
    const raw = this._rawSpectrum;
    if (!raw) return [];
    const inputs: SpectrumInput[] = [{ id: 'raw', label: 'Raw Spectrum', spectrum: raw }];
    if (this._smoothedSpectrum)
      inputs.push({ id: 'smoothed', label: 'Savitzky–Golay Smoothed', spectrum: this._smoothedSpectrum });
    return inputs;
  }
  get backgroundSpectrum(): readonly number[] | null {
    return this._background;
  }
  get netSpectrum(): readonly number[] | null {
    return this._net;
  }
  get llsInput(): readonly number[] | null {
    const input = this.selectedInput;
    return input ? input.counts.map(lls) : null;
  }
  get llsBackground(): readonly number[] | null {
    // Honest display reconstruction: the SNIP background transformed back INTO the LLS domain
    // (estimateBackground's pre-invLls state, modulo its ≥ 0 clamp). No SNIP re-run.
    return this._background ? this._background.map(lls) : null;
  }
  /** The EFFECTIVE SNIP iteration count the continuum estimation ran (for the SNIP
   * education page). `_computeContinuum` calls `estimateContinuum(input)` with no override,
   * so the effective value IS the module default. Single-sourced from `condition.ts` -- if
   * the manager ever passes an override, return that here and the page tracks it for free. */
  get snipIterations(): number {
    return SNIP_DEFAULT_ITERATIONS;
  }
  get snipTrace(): SnipTrace | null {
    return this._snipTrace;
  }
  get workingNet(): readonly number[] | null {
    return this._workingNet;
  }
  get sgWindow(): number {
    return this._sgWindow;
  }
  get sgPolyorder(): number {
    return this._sgPolyorder;
  }
  get sgError(): string | null {
    return this._sgError;
  }
  get sgAdvisory(): string | null {
    return this._sgAdvisory;
  }
  get netInput(): 'net' | 'smoothed-net' {
    return this._netInput;
  }
  get smoothedNetSpectrum(): readonly number[] | null {
    return this._smoothedNet;
  }
  get detectionSgWindow(): number {
    return this._detectionSgWindow;
  }
  get detectionSgPolyorder(): number {
    return this._detectionSgPolyorder;
  }
  get detectionSgAdvisory(): string | null {
    // Only relevant when the smoothed-net is actually carried forward.
    if (this._netInput !== 'smoothed-net') return null;
    const bothOn = this._continuumInput === 'smoothed' && this._smoothedSpectrum != null;
    // Two successive SG passes of windows w1, w2 smooth over a combined extent of about
    // w1 + w2 - 1 channels (convolution support). Warn once that effective width crosses the
    // same heavy-smoothing threshold the Load-stage advisory uses. Detection SG alone (raw
    // input, or smoothed input not selected) is not "combined", so no combined advisory.
    if (!bothOn) return null;
    const effective = this._sgWindow + this._detectionSgWindow - 1;
    return effective >= SG_WINDOW_HEAVY ? DETECTION_SG_ADVISORY_HEAVY : null;
  }
  get detectionProvenance(): string {
    // Real lineage: Raw → (preprocessing SG iff smoothed input) → SNIP net → (detection SG iff on).
    const parts = ['Raw'];
    if (this._continuumInput === 'smoothed' && this._smoothedSpectrum)
      parts.push(`SG(w=${this._sgWindow})`);
    parts.push('SNIP net');
    if (this._netInput === 'smoothed-net') parts.push(`SG(w=${this._detectionSgWindow})`);
    return parts.join(' → ');
  }

  setNetInput(input: 'net' | 'smoothed-net'): void {
    if (!this._detsgEditable()) return;
    if (this._netInput === input) return;
    this._netInput = input;
    this._cascadeNetSgChange(); // refresh the cont-sg working net + re-run detection if it has run
    this._emit();
  }

  setDetectionSgParams(params: { window: number; polyorder: number }): void {
    if (!this._detsgEditable()) return;
    // Same clamp band as the Load-stage SG (window 5..15 odd, polyorder 2..4).
    this._detectionSgWindow = clampSgWindow(params.window);
    this._detectionSgPolyorder = clampSgPolyorder(params.polyorder);
    this._cascadeNetSgChange();
    this._emit();
  }

  resetDetectionSgDefaults(): void {
    if (!this._detsgEditable()) return;
    this._detectionSgWindow = SG_DEFAULT_WINDOW;
    this._detectionSgPolyorder = SG_DEFAULT_POLYORDER;
    this._cascadeNetSgChange();
    this._emit();
  }

  setSgParams(params: { window: number; polyorder: number }): void {
    if (!this._sgEditable()) return;
    // Hard-clamp to the sensible band and store the CLAMPED values, so a typed
    // out-of-range entry visibly snaps to what will actually run (O1 §6b).
    this._sgWindow = clampSgWindow(params.window);
    this._sgPolyorder = clampSgPolyorder(params.polyorder);
    this._recomputeSmoothed();
    this._cascadeSmoothedChange(); // live recompute iff the smoothed input feeds downstream
    this._emit();
  }

  resetSgDefaults(): void {
    if (!this._sgEditable()) return;
    this._sgWindow = SG_DEFAULT_WINDOW;
    this._sgPolyorder = SG_DEFAULT_POLYORDER;
    this._recomputeSmoothed();
    this._cascadeSmoothedChange();
    this._emit();
  }

  // --- forward milestones (advance `reached`, focus the new frontier) ----------
  // // Divergence (2026-07-05 free-nav): backward motion (backToLoad / backToSmoothing) is
  // gone -- Prev is a focus-only goToStep in app.ts; only these forward Continues advance
  // `reached`. Slice 3 adds the live-recompute cascade on the SG / input / net-SG edits.

  continueToSmoothing(): void {
    if (this._phase.kind !== 'held' || !this._rawSpectrum) return;
    this._clearTimer();
    this._errorCountdown = null;
    // Always-apply SG (redesign): the smoothed spectrum is computed on entering the stage
    // (SD-3), so the raw-vs-smoothed overlay + the working-input choice are ready.
    this._recomputeSmoothed();
    const idx = PF_STEP_IDS.indexOf('load-sg');
    this._reached = Math.max(this._reached, idx);
    this._focus = idx;
    this._emit();
  }

  continueToContinuum(): void {
    if (this._phase.kind !== 'held' || !this._rawSpectrum) return;
    if (this._sgError) return; // invalid SG params (pathological) -> cannot continue
    this._clearTimer();
    this._errorCountdown = null;
    // Guard: if the smoothed input was chosen but somehow is absent, fall back to raw.
    if (this._continuumInput === 'smoothed' && !this._smoothedSpectrum) this._continuumInput = 'raw';
    this._computeContinuum(); // background + net for the selected input (SNIP core)
    // Eager unlock: reaching the continuum group unlocks ALL its pages at once -- `reached`
    // jumps to the LAST continuum step (DETECT_OFFSET - 1), which is also where focus lands: the
    // net-SG gate, the actionable Net/Smoothed-Net pick. (No walkthrough animation -- 2026-07-07;
    // all continuum pages are unlocked so the user can review them by navigating back freely.)
    this._reached = Math.max(this._reached, DETECT_OFFSET - 1);
    this._focus = DETECT_OFFSET - 1;
    this._emit();
  }

  /** Choose which spectrum feeds ALL downstream stages (continuum + detection), the single
   * input-choice point (SD-1). Slice 3: valid whenever a spectrum is held -- if the continuum
   * is already computed it recomputes in place, and if detection has already run it re-runs
   * non-animated (live recompute). Fitting always uses raw (R1) regardless. */
  setContinuumInput(id: SpectrumInputId): void {
    if (this._phase.kind !== 'held') return;
    if (id === 'smoothed' && !this._smoothedSpectrum) return; // unavailable
    if (this._continuumInput === id) return;
    this._continuumInput = id;
    this._cascadeInputChange(); // recompute continuum + net + re-run detection if it has run
    this._emit();
  }

  runDetection(): void {
    if (this._phase.kind !== 'held' || this._background == null) return; // continuum required
    this._clearTimer();
    this._errorCountdown = null;
    if (!this._computeDetection()) return; // failure already landed on the error phase
    // Detection ran: every step is now unlocked and focus lands directly on the Review page
    // (no detect-reveal stepping animation -- 2026-07-07).
    this._reached = REVIEW_INDEX;
    this._phase = { kind: 'held' };
    this._focus = REVIEW_INDEX;
    this._emit();
  }

  performPeakFitting(): void {
    if (this._phase.kind !== 'held' || !this._rawSpectrum) return;
    this._clearTimer();
    this._errorCountdown = null;
    // Ensure the smoothed series exists (idempotent) so this is safe to call straight after a
    // fresh load AND from either SG stage. `_recomputeSmoothed` (re)sets `_sgError`/`_sgAdvisory`.
    this._recomputeSmoothed();
    // Resolve the working input: fall back to raw if the smoothed pick is unavailable (a
    // pathological SG on a very short spectrum) so a run ALWAYS produces output.
    if (this._continuumInput === 'smoothed' && !this._smoothedSpectrum) this._continuumInput = 'raw';
    // Compose continuum + detection with a SINGLE emit (no intermediate stage render), then land
    // directly on Review.
    this._computeContinuum(); // background + net for the selected input (SNIP core)
    if (this._background == null) return; // continuum could not be computed (defensive)
    if (!this._computeDetection()) return; // fault already landed the honest error phase
    this._reached = REVIEW_INDEX;
    this._phase = { kind: 'held' };
    this._focus = REVIEW_INDEX;
    this._emit();
  }

  hydrate(spectrum: Spectrum, config: PeakFinderConfig): void {
    this._clearTimer();
    this._errorCountdown = null;
    this._clearRun();
    // Seed the held spectrum + apply every knob from the config (the inverse of `_toConfig`).
    this._rawSpectrum = spectrum;
    this._smoothedSpectrum = null;
    this._background = null;
    this._net = null;
    this._snipTrace = null;
    this._workingNet = null;
    this._smoothedNet = null;
    this._sgWindow = config.preprocessing.sg.window;
    this._sgPolyorder = config.preprocessing.sg.polyorder;
    this._continuumInput = config.continuum.input;
    this._netInput = config.detection.netInput;
    this._detectionSgWindow = config.detection.sg.window;
    this._detectionSgPolyorder = config.detection.sg.polyorder;
    this._sgError = null;
    this._phase = { kind: 'held' };
    // Rebuild the derived series exactly as the Continue chain would: smoothed -> continuum ->
    // detection. `_recomputeSmoothed` sets `_sgError` / `_sgAdvisory`; guard a stale smoothed pick.
    this._recomputeSmoothed();
    if (this._continuumInput === 'smoothed' && !this._smoothedSpectrum) this._continuumInput = 'raw';
    this._computeContinuum();
    // Detection goes through the shared core (`_toConfig` == the config we just applied), so the
    // drilled-in report equals the batch entry's result. A fault lands the honest error phase.
    if (!this._computeDetection()) return;
    this._reached = REVIEW_INDEX;
    this._focus = REVIEW_INDEX;
    this._emit();
  }

  currentConfig(): PeakFinderConfig {
    return this._toConfig();
  }

  /** Load-stage SG params are editable while a spectrum is held (slice 3: post-detection too
   * -- an edit re-runs detection live). */
  private _sgEditable(): boolean {
    return this._phase.kind === 'held';
  }
  /** The detection (net) SG is editable once the continuum is computed (slice 3:
   * post-detection too -- an edit re-runs detection live). */
  private _detsgEditable(): boolean {
    return this._phase.kind === 'held' && this._background != null;
  }

  get report(): AnalysisReport | null {
    return this._report;
  }
  get stageTrace(): readonly StageTrace[] | null {
    return this._stageTrace;
  }
  get pipelineTrace(): PipelineTrace | null {
    return this._pipelineTrace;
  }
  get status(): SpectrumStatus | null {
    return this._status;
  }
  get phase(): PeakFinderRunPhase {
    return this._phase;
  }
  get errorCountdown(): number | null {
    return this._errorCountdown;
  }

  // --- lifecycle ---------------------------------------------------------------

  reset(): void {
    this._clearTimer();
    this._errorCountdown = null;
    this._clearRun();
    this._clearLoad();
    this._reached = 0;
    this._focus = 0;
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  backToCollecting(): void {
    this._clearTimer();
    this._errorCountdown = null;
    // "Keep nothing stale" back path: drop the held spectrum + SG state so the Load
    // step returns to its empty upload surface.
    this._clearLoad();
    this._reached = 0;
    this._focus = 0;
    this._phase = { kind: 'collecting' };
    this._emit();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  stopReveal(): void {
    // Cancel the in-flight error-recovery countdown without altering phase/focus. (The stepping
    // animations that this also used to cancel are gone -- 2026-07-07.)
    this._clearTimer();
  }

  // --- internals -----------------------------------------------------------

  /** Estimate the continuum (SNIP background + net) for the currently selected input
   * via the shared {@link estimateContinuum} core -- the ONE SNIP implementation -- then
   * (re)derive the working net the detection consumes. */
  private _computeContinuum(): void {
    const input = this.selectedInput;
    if (!input) {
      this._background = null;
      this._net = null;
      this._snipTrace = null;
      this._workingNet = null;
      return;
    }
    const { background, net } = estimateContinuum(input);
    this._background = background;
    this._net = net;
    // Trace SNIP over the SAME input + iteration count the committed background came from, so the
    // final snapshot's invLls matches `background`. One extra clip, isolated here in the engine; the
    // SNIP education page reads only `_snipTrace` (Principle 9 preserved for the presentation layer).
    this._snipTrace = estimateBackgroundTraced(input.counts, this.snipIterations, [
      1, 5, 10, 20, this.snipIterations,
    ]);
    this._recomputeWorkingNet();
  }

  /** Derive the working net EXACTLY as `condition`'s savgol branch does, so the cont-sg
   * preview equals what detection consumes: Savitzky-Golay the UN-clipped net (input −
   * background), then clip ≥ 0 -- when the net SG is on; else the clipped net (= netSpectrum).
   * Wrapped in try/catch so a pathologically short spectrum falls back to the clipped net. */
  private _recomputeWorkingNet(): void {
    const input = this.selectedInput;
    const background = this._background;
    if (!input || !background) {
      this._workingNet = null;
      this._smoothedNet = null;
      return;
    }
    const unclipped = input.counts.map((c, i) => c - background[i]);
    const clippedNet = unclipped.map((v) => (v > 0 ? v : 0));
    // The smoothed-net is ALWAYS computed (#3): SG on the un-clipped net, then clip ≥ 0 --
    // matching `condition`'s savgol branch exactly. On a pathologically short spectrum SG
    // throws; fall back to the clipped net so the preview + working series never break.
    let smoothedNet: readonly number[];
    try {
      smoothedNet = savitzkyGolay(
        unclipped,
        this._detectionSgWindow,
        this._detectionSgPolyorder,
      ).map((v) => (v > 0 ? v : 0));
    } catch {
      smoothedNet = clippedNet;
    }
    this._smoothedNet = smoothedNet;
    // The working series is the user's Net / Smoothed-Net pick (default 'smoothed-net', 2026-07-07).
    this._workingNet = this._netInput === 'smoothed-net' ? smoothedNet : clippedNet;
  }

  // --- live-recompute cascade (slice 3) ---------------------------------------
  // Editing an unlocked upstream control refreshes everything downstream in place, and -- if
  // detection has already run -- re-runs it NON-animated (never replays the reveal). The
  // engine is synchronous and fast, so this is affordable.

  /** Run the engine ONCE on the selected input + current net-SG condition, updating the run
   * artifacts in place. Returns true on success; on an engine fault it lands the honest error
   * phase (and resets focus/reached) and returns false. Does NOT emit or start the reveal --
   * the caller owns those. Shared by {@link runDetection} (then reveal) and the live re-run. */
  private _computeDetection(): boolean {
    const raw = this._rawSpectrum;
    if (!raw) return false;
    try {
      // Phase-0 delegation: the manager no longer runs the engine inline -- it snapshots its
      // live Load/continuum/net-SG state as a `PeakFinderConfig` and hands it to the shared
      // headless core. This is the SAME function the batch worker calls, so an interactively
      // inspected file and a batch-queued file are byte-identical by construction. The input
      // resolution (raw vs SG-smoothed), the net-SG -> condition mapping, and the Peak Finder
      // divergences (R1 rawSource, #4 strengthSource 'working') all live in `runPeakFinder` now.
      const { report, stageTrace, status, pipelineTrace } = runPeakFinderTraced(raw, this._toConfig());
      this._report = report;
      this._stageTrace = stageTrace;
      this._status = status;
      this._pipelineTrace = pipelineTrace;
      return true;
    } catch (err) {
      this._clearRun();
      this._phase = { kind: 'error', message: errText(err) };
      this._reached = 0;
      this._focus = 0;
      this._startErrorRecovery();
      return false;
    }
  }

  /** Snapshot the manager's current Load / continuum / net-SG state as a {@link PeakFinderConfig}
   * -- the single value that drives the shared headless core. Keeping this the ONLY place the
   * manager describes its run guarantees the interactive result equals the batch result: both go
   * through `runPeakFinder(raw, config)`. `_toConfig` is a pure read of the live knobs; it holds
   * no engine logic (that lives in `runPeakFinder`). detect/validate overrides stay unset (PARK-13
   * parks the tunable controls), matching the prior default-options call exactly. */
  private _toConfig(): PeakFinderConfig {
    return {
      preprocessing: { sg: { window: this._sgWindow, polyorder: this._sgPolyorder } },
      continuum: { input: this._continuumInput },
      detection: {
        netInput: this._netInput,
        sg: { window: this._detectionSgWindow, polyorder: this._detectionSgPolyorder },
      },
    };
  }

  /** Re-run detection in place (no reveal) ONLY when it has already run -- so downstream
   * Detect + Review pages reflect an upstream edit immediately. Focus / reached / phase are
   * untouched on success (the user stays on whatever page they edited). */
  private _reRunDetectionIfNeeded(): void {
    if (this._report == null) return; // detection hasn't run -> nothing downstream to refresh
    this._clearTimer();
    this._computeDetection();
  }

  /** Cascade from a continuum-INPUT change (raw <-> smoothed, or the smoothed series itself
   * changing while it is the selected input): recompute the continuum (background / net / LLS
   * / working net) then re-run detection if it has run. No-op before the continuum exists. */
  private _cascadeInputChange(): void {
    if (this._background == null) return;
    this._computeContinuum();
    this._reRunDetectionIfNeeded();
  }

  /** Cascade from a Load-stage SG edit: it only affects downstream when the SMOOTHED spectrum
   * is the selected continuum input; otherwise the raw-input continuum is unchanged. */
  private _cascadeSmoothedChange(): void {
    if (this._continuumInput !== 'smoothed') return;
    this._cascadeInputChange();
  }

  /** Cascade from a net-SG edit: refresh the working net (the cont-sg preview) then re-run
   * detection if it has run. */
  private _cascadeNetSgChange(): void {
    if (this._background == null) return;
    this._recomputeWorkingNet();
    this._reRunDetectionIfNeeded();
  }

  /** Error auto-recovery (Rev 4): from the `error` phase, count down whole seconds
   * (PF_ERROR_RECOVERY_MS) then `backToCollecting()`. A single chained, cancellable `_timer`:
   * scheduled ONCE on the load-catch (never per render,
   * so no double-fire), and cleared by `_clearTimer` on any phase change (reset /
   * backToCollecting / a fresh load). The countdown runs regardless of reduced motion
   * (operator: the countdown itself still runs) -- reduced motion only skips the
   * reveal animation, not this honest recovery notice. */
  private _startErrorRecovery(): void {
    this._clearTimer();
    this._errorCountdown = Math.ceil(PF_ERROR_RECOVERY_MS / 1000);
    this._emit();
    const tick = (): void => {
      if (this._phase.kind !== 'error') return; // phase changed out -> abandon
      const remaining = (this._errorCountdown ?? 0) - 1;
      if (remaining <= 0) {
        this.backToCollecting(); // clears timer + countdown, sets collecting, emits
        return;
      }
      this._errorCountdown = remaining;
      this._emit();
      this._timer = setTimeout(tick, 1000);
    };
    this._timer = setTimeout(tick, 1000);
  }

  /** Drop every derived artifact of the run (NOT the held raw/working spectrum). */
  private _clearRun(): void {
    this._report = null;
    this._stageTrace = null;
    this._pipelineTrace = null;
    this._status = null;
  }

  /** Drop the held spectrum + SG + continuum state (the Load-stage inputs). */
  private _clearLoad(): void {
    this._rawSpectrum = null;
    this._background = null;
    this._net = null;
    this._snipTrace = null;
    this._workingNet = null;
    this._smoothedNet = null;
    this._resetSgState();
  }

  /** SG params back to the recommended defaults + no error/advisory; smoothed input
   * dropped (recomputed on the SG stage) and working input reset to the Savitzky-Golay
   * smoothed default (2026-07-07 -- SG is the standing default, re-tunable on Review). */
  private _resetSgState(): void {
    this._smoothedSpectrum = null;
    this._continuumInput = 'smoothed';
    this._sgWindow = SG_DEFAULT_WINDOW;
    this._sgPolyorder = SG_DEFAULT_POLYORDER;
    this._sgError = null;
    this._sgAdvisory = null;
    // Net SG (#3) resets to the default Smoothed-Net choice + recommended SG params on every
    // fresh load (2026-07-07: SG-smoothed is the standing default, re-tunable on Review).
    this._netInput = 'smoothed-net';
    this._detectionSgWindow = SG_DEFAULT_WINDOW;
    this._detectionSgPolyorder = SG_DEFAULT_POLYORDER;
  }

  /** Recompute the SMOOTHED spectrum from the raw + current SG settings (§3 contract).
   * Always-apply (redesign): SG is ALWAYS computed once a spectrum is held -- clip-non-neg
   * Savitzky-Golay of the RAW counts, persisted as its OWN Spectrum with the raw's metadata
   * (never overwriting the raw). Params are clamped, so `sgError` is only reachable in
   * pathological cases (e.g. window > channelCount); when it is set the last smoothed series
   * is kept and the UI blocks Continue. Raw never mutated. The user's Raw-vs-smoothed choice
   * is `continuumInput`, NOT whether this runs. */
  private _recomputeSmoothed(): void {
    const raw = this._rawSpectrum;
    if (!raw) return;
    try {
      const smoothed = savitzkyGolay(raw.counts, this._sgWindow, this._sgPolyorder).map((v) =>
        v > 0 ? v : 0,
      );
      this._smoothedSpectrum = { counts: smoothed, metadata: raw.metadata };
      this._sgError = null;
      // Non-blocking advisory for the in-band edges (never sets `sgError`, never blocks).
      this._sgAdvisory = sgWindowAdvisory(this._sgWindow);
    } catch (err) {
      this._sgError = errText(err);
      this._sgAdvisory = null;
    }
  }

  private _clearTimer(): void {
    // The one timer drives the error-recovery countdown; a single clear on every lifecycle
    // transition stops it -- no leak.
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  private _emit(): void {
    for (const listener of this._listeners) listener();
  }
}

/** Create a fresh manager. One instance is held per Peak Finder mount (app.ts). */
export function createPeakFinderManager(): PeakFinderManager {
  return new PeakFinderManagerImpl();
}

// --- helpers ----------------------------------------------------------------

/** Engine fault -> honest message; anything else -> a labelled unexpected error. */
function errText(err: unknown): string {
  if (err instanceof NuclidError) return err.message;
  return `Unexpected error: ${(err as Error).message}`;
}

// --- SG manual-entry guardrails (O1 §6b, clamp + advisory) -------------------

/** Clamp a typed window to an ODD integer in [SG_WINDOW_MIN, SG_WINDOW_MAX]. Non-finite
 * falls back to the default. Rounds to the nearest integer, coerces to the nearest odd
 * (down), then clamps. The edge case of a spectrum with < SG_WINDOW_MIN channels is left
 * to `_recomputeSmoothed`'s try/catch, which fails loud via `sgError`. */
function clampSgWindow(w: number): number {
  if (!Number.isFinite(w)) return SG_DEFAULT_WINDOW;
  let v = Math.round(w);
  if (v % 2 === 0) v -= 1; // nearest odd (down); clamp then re-odds the floor case
  v = Math.min(SG_WINDOW_MAX, Math.max(SG_WINDOW_MIN, v));
  if (v % 2 === 0) v += 1; // SG_WINDOW_MIN/MAX are odd, so this only fixes an even floor
  return v;
}

/** Clamp a typed polyorder to an integer in [SG_POLYORDER_MIN, SG_POLYORDER_MAX].
 * Non-finite falls back to the default. window >= 5 keeps polyorder < window. */
function clampSgPolyorder(p: number): number {
  if (!Number.isFinite(p)) return SG_DEFAULT_POLYORDER;
  return Math.min(SG_POLYORDER_MAX, Math.max(SG_POLYORDER_MIN, Math.round(p)));
}

/** The in-band advisory for an (already-clamped, odd) window: low edge (5) -> light,
 * high edge (13/15) -> heavy, no-warn band (7/9/11) -> null. */
function sgWindowAdvisory(window: number): string | null {
  if (window <= SG_WINDOW_MIN) return SG_ADVISORY_LOW;
  if (window >= SG_WINDOW_HEAVY) return SG_ADVISORY_HIGH;
  return null;
}
