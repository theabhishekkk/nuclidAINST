/**
 * Nuclid app shell (M4 A1b/A1c): a browser-only two-mode SPA over the existing
 * analysis engine. View-state (landing | calibrate | identify | resources |
 * project-status) + a DR-7 toolbar (brand + platform-nav only), a Help dialog
 * (DR-8), history-faithful Back (DR-2), and the shared analysis view.
 *
 * A1c adds the live CALIBRATE walkthrough: load known source(s) -> declare each
 * identity (Rule 12, operator's explicit choice; the filename only suggests) ->
 * run load..validate per source -> calibrate() the pooled declared lines -> show
 * the dual-model result (linear/quadratic switch + metrics + points) -> save it
 * active to calibrationStore. The x-axis flips Channel -> Energy (keV) once a
 * calibration is applied. Identify wiring is A1d.
 *
 * UI/wiring only -- the numeric engine (calibrate/validate/store/kit/pipeline) is
 * called, never changed. Overlays and the cursor readout are display-only.
 */
import { analyze } from '../pipeline/orchestrator';
import { load as parseSpectrum } from '../pipeline/load';
import { runPeakFinder } from '../pipeline/runPeakFinder';
import { DEFAULT_PEAK_FINDER_CONFIG } from '../pipeline/peakFinderConfig';
import { buildPipelineTrace } from '../pipeline';
// Deep path, not the barrel: adding a barrel line would touch src/pipeline/*,
// which is out of scope this phase (mirrors the DEBT-29 discussion; operator
// may fold a barrel re-export in later).
import { deriveSpectrumStatus, isInspectable } from '../pipeline/spectrumStatus';
import type { SpectrumStatus } from '../pipeline/spectrumStatus';
import {
  type AnalysisReport,
  type Calibration,
  type CalibrationResult,
  type CalibrationPoint,
  type EnergisedPeak,
  type FittedPeak,
  type IdentificationResult,
  type IdentificationSummary,
  type NuclideLibrary,
  type PipelineTrace,
  type SpectrumMetadata,
  type UnfittableSurvivor,
  type ValidatedPeak,
} from '../domain/types';
import { deadTimeFraction } from '../domain/types';
import { activeCalibration, applyCalibrationToChannel } from '../pipeline/calibrate';
import {
  exportIdentificationJson,
  exportIdentificationCsv,
  CAVEAT_SINGLE_LINE,
  CAVEAT_ARTIFACT_PEAK,
  CAVEAT_MISSING_STRONG,
} from '../pipeline/identifyReport';
import { calibrationStore, type StoredCalibration } from '../data/calibrationStore';
import { CALIBRATION_KIT } from '../data/calibrationKit';
import {
  drawSpectrum,
  GRAPH_HELP,
  nearestChannelIndex,
  type ChartSeries,
  type ChartMarker,
  type ChartView,
  type ChartGeometry,
} from '../viz/spectrumChart';
import {
  mountChartInteraction,
  fitYToWindow,
  reprojectView,
  type XWindow,
} from '../viz/chartInteraction';
import { syntheticTka } from '../data/synthetic';
import {
  DEFAULT_IDENTIFY_CALIBRATION,
  DEFAULT_IDENTIFY_CALIBRATION_ID,
  DEFAULT_IDENTIFY_CALIBRATION_NAME,
} from '../data/defaultCalibration';
import { loadGammaLibrary } from '../io/loadGammaLibrary';
import { NuclidError, ParseError } from '../domain/errors';
import { createStageView, type StageViewHandle } from './stageView';
import {
  FX_FIT_MODEL,
  FX_GAUSSIAN,
  FX_LINEAR_BG,
  FX_POISSON,
  FX_FWHM,
  FX_GAUSS_AREA,
  FX_LLS,
  FX_INV_LLS,
  FX_SNIP,
  FX_NET,
  FX_LOCAL_MAXIMA,
  FX_DISTANCE_GATE,
} from './mathml';
import {
  buildCalibrateStages,
  displayedCal,
  equationString,
  usedPoints,
  type CalibrateStageSource,
} from './calibrateStages';
import {
  createCalibrationManager,
  type CalibrationManager,
  type ManagedSource,
  type ModelChoice,
} from './calibrationManager';
import { declareIdentitiesMarkup, EXCLUDE_OPTION_VALUE } from './declareIdentities';
import { getCalibrationLibrary, type CalibrationLibrary } from './calibrationLibrary';
import {
  deriveBuildSteps,
  buildStepperRailMarkup,
  activeStepCardMarkup,
  activeStepLabel,
  type BuildStepModel,
} from './buildStepper';
import { createIdentifyManager, type IdentifyManager } from './identifyManager';
import {
  deriveIdentifySteps,
  identifyStepperRailMarkup,
  identifyActiveStepCardMarkup,
  identifyActiveStepLabel,
  type IdentifyStepModel,
} from './identifyStepper';
import { buildIdentifyStages, type IdentifyStagesInput } from './identifyStages';
import {
  mountInspectorWorkspace,
  emptyInspectorState,
  INSPECTOR_STAGES,
  type InspectorWorkspaceHandle,
  type InspectorWorkspaceState,
} from './inspectorWorkspace';
import { WINDOW_FACTOR, MIN_HALF_WINDOW } from '../pipeline/detect';
import {
  createPeakFinderManager,
  type PeakFinderManager,
  type SpectrumInputId,
} from './peakFinderManager';
import { PF_RUN_STAGES } from './peakFinderStages';
import { createBatchManager, type BatchManager } from '../batch/batchManager';
import { effectiveConfig } from '../batch/batchRunner';
import { mountBatchView, type BatchViewHandle } from './batchView';
import {
  derivePeakFinderSteps,
  peakFinderStepperRailMarkup,
  peakFinderActiveStepCardMarkup,
  peakFinderActiveStepLabel,
  peakFinderFirstStepOfGroup,
  PF_STEP_IDS,
  type PeakFinderStepModel,
  type PeakFinderGroup,
  type PeakFinderBoundaryStage,
} from './peakFinderStepper';
import {
  peakFinderTableSectionMarkup,
  peakFinderCountStrip,
  DEFAULT_TABLE_SORT,
  DEFAULT_TABLE_FILTER,
  type PeakFinderTableSort,
  type PeakFinderTableFilter,
} from './peakFinderTables';
import {
  deriveContinuumPageStats,
  deriveWorkingCopyStats,
  deriveLlsTransformStats,
  deriveInverseLlsStats,
  deriveNetSpectrumStats,
  deriveSnipClipStats,
  type ContinuumPageStats,
  type ContinuumStatsInput,
  type SnipProgress,
} from './peakFinderContinuumStats';
import { deriveLocalMaximaStats, type LocalMaximaStats } from './peakFinderDetectStats';
import {
  deriveDistanceGateStats,
  resolveRejectionComparison,
  fmtDistanceHeight,
  type DistanceGateStats,
  type RejectionComparison,
} from './peakFinderDistanceStats';
import { deriveFitStats, type FitStatPair } from './peakFinderFitStats';
import {
  deriveValidationStats,
  type ValStatPair,
  type ValChecklistItem,
} from './peakFinderValidationStats';
import {
  MIN_SIGNIFICANCE,
  MAX_FWHM_CHANNELS,
  MAX_CENTROID_ERROR_CHANNELS,
} from '../pipeline/validate';
import {
  derivePeakStatistics,
  deriveSpectrumStatistics,
  deriveReviewPeakRows,
  buildProcessingReport,
  buildPeaksCsv,
  buildPeaksJson,
  buildPeakList,
  canProceedToCalibration,
  acceptedPeakCount,
  MIN_CALIBRATION_PEAKS,
  type ReviewStatPair,
  type ReviewPeakRow,
} from './peakFinderReviewStats';
import {
  deriveSmoothingEffect,
  type SmoothingCard,
} from './peakFinderSmoothingStats';

/** Real demo sources shipped in public/sample-data. File picker only: identity is
 * never inferred from these names beyond the untrusted hint (Rule 12). */
const SAMPLE_FILES: readonly string[] = [
  '241Am-4cm-1800s-no1.TKA',
  '133Ba-4cm-1800s-no1.TKA',
  '57Co-4cm-1800s-no1.TKA',
  '60Co-4cm-1800s-no1.TKA',
  '137Cs-4cm-1800s-no1.TKA',
  '152Eu-4cm-3600s-no1.TKA',
  '54Mn-4cm-1800s-no1.TKA',
];

type View =
  | 'landing'
  | 'peak-finder'
  | 'batch'
  | 'calibrate'
  | 'identify'
  | 'quantification'
  | 'resources'
  | 'project-status';

// Peak Finder FIRST, then the landing order (operator default D, P1 hand-off).
const NAV_ORDER: readonly View[] = [
  'peak-finder',
  'batch',
  'calibrate',
  'identify',
  'quantification',
  'resources',
  'project-status',
];
const VIEW_LABEL: Record<View, string> = {
  landing: 'Home',
  'peak-finder': 'Peak Finder',
  batch: 'Batch',
  identify: 'Identify Mode',
  calibrate: 'Calibrate Mode',
  quantification: 'Quantification',
  resources: 'Resources',
  'project-status': 'Project Status',
};

const ROADMAP: readonly { id: string; name: string; status: 'done' | 'now' | 'next' | 'later' }[] = [
  { id: 'M0', name: 'Scaffold & governance', status: 'done' },
  { id: 'M1', name: 'Foundations (numeric, signal, data)', status: 'done' },
  { id: 'M2', name: 'Calibrate mode engine', status: 'done' },
  { id: 'M3', name: 'Identify mode engine', status: 'done' },
  { id: 'M4', name: 'App shell + walkthroughs', status: 'now' },
];
const STATUS_LABEL: Record<'done' | 'now' | 'next' | 'later', string> = {
  done: 'Done',
  now: 'In progress',
  next: 'Next',
  later: 'Later',
};

/** Saved-calibrations library sort order (Scenario 1). */
export type LibrarySort = 'newest' | 'oldest' | 'residual';
/** Saved-calibrations library model filter (Scenario 1). */
export type LibraryFilter = 'all' | 'linear' | 'quadratic' | 'active';
/** The toolbar-driven view inputs `selectLibraryRows` reads (search/filter/sort). */
export interface LibraryView {
  readonly query: string;
  readonly sort: LibrarySort;
  readonly filter: LibraryFilter;
}

/** Which Calibrate surface is showing: the saved-calibrations Manager, or the
 * Build Calibration creation flow. */
export type CalibrateSurface = 'manager' | 'builder';

/** Calibrate-mode UI state. The {@link CalibrationManager} owns the batch, the run,
 * and the result; the app holds only the view-local bits around it. */
interface CalibViewState {
  /** Which Calibrate surface is showing: the saved-calibrations Manager, or the
   * Build Calibration flow. */
  mode: CalibrateSurface;
  /** The orchestrator (created on first Calibrate mount; subscribed once). */
  manager: CalibrationManager | null;
  /** Which batch row's per-file QC spectrum is expanded (Source Manager), or null. */
  expandedRowId: string | null;
  /** Assign-energies step: the peakId of the currently selected peak -- the one
   * highlighted on the spectrum graph AND its card. Links the graph <-> the cards
   * (click either to select). Reset to null on a source (pager) switch. */
  assignSelectedPeak: string | null;
  /** DR-9 zoom/pan window for the expanded QC chart (null = full range); reset on
   * row change. The count (Y) axis auto-fits to whatever X window is visible (Batch C). */
  qcView: XWindow | null;
  /** Geometry of the last QC-chart draw, for the pointer->channel cursor readout and
   * the zoom/pan pixel math (mirrors {@link inspectorGeometry}). */
  qcGeometry: ChartGeometry | null;
  /** Peak Pipeline Inspector workspace state (Phase 3): the five former loose
   * inspector fields grouped into the workspace-owned shape. `subjectId` is the
   * open batch rowId (was inspectorRowId); the disclosure stays independent of
   * {@link expandedRowId} (the QC chart). Build still owns this object -- where
   * it ultimately lives is the deferred Phase 6 decision. */
  inspector: InspectorWorkspaceState;
  /** A file that failed to parse while being added to the batch (fail-loud). */
  loadError: string | null;
  /** The just-saved calibration (Save-panel confirmation), or null. */
  saved: { name: string; id: string } | null;
  /** Current step of the staged walkthrough (persisted across app re-renders). */
  stageIndex: number;
  /** Current Configure sub-step (0..3) within the grouped Build stepper. UI-only
   * position, persisted across re-renders like {@link stageIndex}; never widens the
   * engine-truth run phase. */
  configStep: number;
  /** The operator explicitly picked a model (Select-model step completion). The
   * manager's default `model='auto'` is NOT a pick -- this flips true only on an
   * explicit Linear/Quadratic/Auto click, and resets with a fresh/empty batch. */
  modelChosen: boolean;
  /** Saved-calibrations library view-state (Scenario 1): toolbar + detail selection,
   * persisted across re-renders. `focusSearch` is set before a search-triggered
   * render and consumed (refocus the box) after it. */
  library: {
    query: string;
    sort: LibrarySort;
    filter: LibraryFilter;
    selectedId: string | null;
    focusSearch: boolean;
    /** Set when the operator tried to delete the active calibration while others
     * exist -- drives the inline "choose a new active first" prompt; cleared once
     * they re-point active, cancel, or re-enter Calibrate. */
    pendingActiveDeleteId: string | null;
  };
}

/** A1d: live Identify-mode state. The {@link IdentificationResult} is the LIVE
 * object returned by `identify(...)` -- rendered directly, never round-tripped
 * through JSON/the store (DEBT-12: caveat/overlay linkage is by object identity). */
interface IdentifyViewState {
  /** The Identify orchestrator (created on first Identify mount; subscribed once).
   * Owns the inputs + the run + the live result; the app holds only the view-local
   * bits around it (mirrors `calib.manager`). */
  manager: IdentifyManager | null;
  /** Current Configure sub-step (0..2) within the grouped Identify stepper. UI-only. */
  configStep: number;
  /** Current Run stage (0..6) when walking the reveal (persisted across re-renders). */
  stageIndex: number;
  /** Which saved calibration id the selector has chosen, or null = the active default. */
  calChoiceId: string | null;
  /** A file that failed to parse while loading the unknown (fail-loud). */
  loadError: string | null;
  /** DR-9 zoom/pan window for the cfg-spectrum preview (null = full range); reset when
   * a new spectrum is loaded. The count (Y) axis auto-fits the visible slice (Batch C). */
  identView: XWindow | null;
  /** Geometry of the last preview draw, for the pointer->channel cursor readout and the
   * zoom/pan pixel math (mirrors the QC/inspector geometry). */
  identGeometry: ChartGeometry | null;

  // --- live run mirror (synced FROM the manager each render; DEBT-12 by identity) ---
  ran: boolean; // an Identify attempt has been made (drives the fail-loud message)
  result: IdentificationResult | null;
  summary: IdentificationSummary | null;
  energised: EnergisedPeak[] | null;
  cal: Calibration | null; // the active calibration applied (energy axis + overlay)
  calName: string; // active calibration's operator name, for provenance display
  overlayId: string | null; // which ranked isotope to overlay (default = top)
  error: string | null; // fail-loud: no active calibration / library not ready
}

/** Peak Finder view state (P1). The {@link PeakFinderManager} owns the loaded
 * spectrum + the run; the app holds only the view-local bits around it.
 * `chart` reuses the inspector's state shape so the stage panel can call the
 * exported inspector stage drawer verbatim (single source of truth for stage
 * visuals -- the same charts the Peak Pipeline Inspector shows); `stageIndex`
 * is the post-run walkthrough position (mirrors `ident.stageIndex`). */
interface PeakFinderViewState {
  manager: PeakFinderManager | null;
  stageIndex: number;
  chart: InspectorWorkspaceState;
  /** Shared zoom/pan window for the Estimate Continuum chart (input / background / net
   * overlaid). Persists across selector switches; null = full range. */
  contView: XWindow | null;
  /** Display-manager visibility per continuum series (DM1). All true by default. */
  contSeries: { input: boolean; background: boolean; net: boolean };
  /** View-only Run-table sort (#7). Applied over the #6 channel-ascending base order;
   * default = channel ascending. Persists across stage navigation. */
  tableSort: PeakFinderTableSort;
  /** View-only gate-stage candidate filter (#8): All / Advancing / Rejected. Hides rows by
   * `resultKind` only; default 'all'. Resets per stage (D-8a) + on load/clear. */
  tableFilter: PeakFinderTableFilter;
  /** Which Candidate-Distribution view the "Find Local Maxima" stage shows (D3): histogram
   * (default) / channel map / density. A pure view preference -- toggling it only redraws the
   * distribution canvas, never re-renders the stage. */
  distView: PeakFinderDistView;
  /** Which view the LLS Transform stage's shared chart shows (redraw-only toggle). */
  llsView: PeakFinderLlsView;
  /** Which view the Inverse LLS Transform stage's shared chart shows (redraw-only toggle). */
  invLlsView: PeakFinderInvLlsView;
  /** Peak Fitting stage (`fit` / run-6) decomposition-overlay visibility (P3). Independent
   * multi-select toggles over the selected peak's series; all on except residuals. Toggling
   * only redraws the stage chart, never re-renders. */
  fitOverlays: PeakFinderFitOverlays;
  /** Final Review hero-graph overlay visibility (full-spectrum view). Independent multi-select
   * toggles over the whole-spectrum result; toggling only redraws `#pfReviewChart`, never
   * re-renders. Distinct from `fitOverlays` (which drives the single-peak decomposition). */
  reviewOverlays: PeakFinderReviewOverlays;
  loadError: string | null;
  /** View-local routing for the workflow-boundary teaching pages (2026-07-07). null => normal
   * pipeline routing; a boundary stage id => that locked-stage page is shown. Never touches the
   * manager (channel-space-only); cleared by every pipeline nav / load / clear. */
  boundaryView: PeakFinderBoundaryStage['id'] | null;
}

/** Which decomposition series the Peak Fitting stage chart draws for the selected peak. */
interface PeakFinderFitOverlays {
  raw: boolean;
  gaussian: boolean;
  continuum: boolean;
  combined: boolean;
  residuals: boolean;
}

/** Which overlays the Final Review hero graph draws over the full-spectrum result: the estimated
 * continuum, the fitted Gaussian model, the rejected (flagged) peak markers, and the per-peak ID
 * labels. Independent of {@link PeakFinderFitOverlays}. */
interface PeakFinderReviewOverlays {
  continuum: boolean;
  gaussian: boolean;
  rejected: boolean;
  labels: boolean;
}

/** The three interchangeable Candidate-Distribution views on the "Find Local Maxima" stage. */
type PeakFinderDistView = 'histogram' | 'channelMap' | 'density';

/** Which view the LLS Transform stage's single shared chart shows: the working spectrum
 * (counts) or its LLS transform (LLS domain). A pure view preference -- toggling only
 * redraws the canvas, never re-renders the stage (mirrors {@link PeakFinderDistView}). */
type PeakFinderLlsView = 'raw' | 'lls';

/** Which view the Inverse LLS Transform stage's single shared chart shows: the background in
 * LLS space (SNIP output) or restored to detector counts. Pure view preference -- redraw only. */
type PeakFinderInvLlsView = 'lls' | 'counts';

interface AppState {
  view: View;
  history: View[];
  report: AnalysisReport | null;
  logY: boolean;
  error: string | null;
  library: NuclideLibrary | null;
  libraryNote: string;
  overlays: { baseline: boolean; smoothed: boolean };
  helpOpen: boolean;
  geometry: ChartGeometry | null;
  /** DR-9 visible chart window (zoom/pan); null = full data range. */
  chartView: ChartView | null;
  calib: CalibViewState;
  ident: IdentifyViewState;
  pf: PeakFinderViewState;
}

/** A fresh (un-run) Identify state. */
function emptyIdentState(): IdentifyViewState {
  return {
    manager: null,
    configStep: 0,
    stageIndex: 0,
    calChoiceId: null,
    loadError: null,
    identView: null,
    identGeometry: null,
    ran: false,
    result: null,
    summary: null,
    energised: null,
    cal: null,
    calName: '',
    overlayId: null,
    error: null,
  };
}

const state: AppState = {
  view: 'landing',
  history: [],
  report: null,
  logY: true, // log is the sensible default for inspecting peaks (DESIGN.md S4).
  error: null,
  library: null,
  libraryNote: '',
  overlays: { baseline: false, smoothed: false },
  helpOpen: false,
  geometry: null,
  chartView: null,
  calib: {
    mode: 'manager',
    manager: null,
    expandedRowId: null,
    assignSelectedPeak: null,
    qcView: null,
    qcGeometry: null,
    inspector: emptyInspectorState(),
    loadError: null,
    saved: null,
    stageIndex: 0,
    configStep: 0,
    modelChosen: false,
    library: {
      query: '',
      sort: 'newest',
      filter: 'all',
      selectedId: null,
      focusSearch: false,
      pendingActiveDeleteId: null,
    },
  },
  ident: emptyIdentState(),
  pf: {
    manager: null,
    stageIndex: 0,
    chart: emptyInspectorState(),
    contView: null,
    contSeries: { input: true, background: true, net: true },
    tableSort: DEFAULT_TABLE_SORT,
    tableFilter: DEFAULT_TABLE_FILTER,
    distView: 'histogram',
    llsView: 'raw',
    invLlsView: 'lls',
    fitOverlays: { raw: true, gaussian: true, continuum: true, combined: true, residuals: false },
    reviewOverlays: { continuum: false, gaussian: false, rejected: true, labels: true },
    loadError: null,
    // View-local routing for the workflow-boundary teaching pages (2026-07-07): null => normal
    // pipeline routing; a stage id => that locked-stage page is shown. Never touches the manager
    // (channel-space-only); cleared by every pipeline nav / load / clear (goToPeakFinderStep +
    // peakFinderNavStep + the load/clear paths).
    boundaryView: null as PeakFinderBoundaryStage['id'] | null,
  },
};

let rootEl: HTMLElement;

/** The live staged-walkthrough handle (calibrate mode). Short-lived: destroyed and
 * recreated each render so the arrow-key listener never leaks (see stageView.ts). */
let stageViewHandle: StageViewHandle | null = null;

/** The live QC-chart interaction binding (Calibrate). Destroyed + re-mounted each
 * render like {@link stageViewHandle}, since `#calQc` is a fresh node per render. */
let qcInteraction: { destroy(): void } | null = null;

/** The live Peak Pipeline Inspector workspace handle (Phase 3). Same lifecycle as
 * {@link qcInteraction}: its mount root is a fresh node per render, so the handle
 * is destroyed + re-mounted each render. */
let inspectorWorkspace: InspectorWorkspaceHandle | null = null;

/** The live Identify cfg-spectrum preview interaction binding (C3). Same lifecycle as
 * {@link qcInteraction}: `#identPreview` is a fresh node per render. */
let identInteraction: { destroy(): void } | null = null;

/** The live Peak Finder stage/Review chart interaction binding. Same lifecycle as
 * {@link identInteraction}: its canvas is a fresh node per render. */
let pfInteraction: { destroy(): void } | null = null;
// Batch Peak Finder: the manager persists across app renders (it holds the queue + worker loop);
// the view handle is re-bound each render (the DOM is replaced), like the other mode handles.
let batchManager: BatchManager | null = null;
let batchViewHandle: BatchViewHandle | null = null;
// True while the Peak Finder view is showing a batch-drilled file (adds the "Back to batch"
// affordance + routes Back to the batch queue). Cleared by any normal navigation.
let batchDrillReturn = false;
// The batch entry currently drilled into -- so the return path can persist any operator tuning
// as that entry's per-file override and re-run just it. Null when not drilling.
let batchDrillEntryId: string | null = null;

/** The Savitzky–Golay stage scroll-cue binding (scroll + ResizeObserver listeners on the
 * `.step-main` scroller). Torn down on every render like {@link pfInteraction} so a fresh
 * stage never leaks the old stage's listeners. */
let pfSmoothScrollCue: { destroy(): void } | null = null;

/** The Estimate Continuum stage's three synchronized-chart interaction bindings (input /
 * background / net). All share `state.pf.contView`; destroyed together on re-render. */
let pfContInteractions: { destroy(): void }[] = [];

/** Which of the Net Spectrum stage's three comparison series are toggled on. */
type PfNetSeries = 'input' | 'background' | 'net';

/** The Net Spectrum stage's binding: the series-toggle click handlers + the hover subtraction
 * animation's rAF/mouseenter listeners. Torn down on every render like {@link pfSmoothScrollCue}
 * so a fresh stage never leaks the old stage's listeners or a running tween. */
let pfNetStage: { destroy(): void } | null = null;

export function mountApp(root: HTMLElement): void {
  rootEl = root;

  window.addEventListener('resize', () => {
    if (state.view === 'identify') {
      stageViewHandle?.refresh();
      drawIdentPreview();
    }
    if (state.view === 'calibrate') {
      stageViewHandle?.refresh();
      drawRowQC();
      inspectorWorkspace?.redraw(); // DEBT-32: keep a zoomed inspector correct on resize
    }
    if (state.view === 'peak-finder') drawPfCurrentChart();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.helpOpen) {
      state.helpOpen = false;
      render();
    }
  });

  // Saved-calibrations library (app-scoped, single source of truth). Re-render the
  // Calibrate surface whenever the library changes (save/activate/remove/refresh).
  getCalibrationLibrary().subscribe(() => {
    if (state.view === 'calibrate') render();
  });

  render();

  void loadGammaLibrary()
    .then((lib) => {
      state.library = lib;
      const lineCount = lib.entries.reduce((n, e) => n + e.lines.length, 0);
      state.libraryNote = `Identify library loaded: ${lib.entries.length} nuclides, ${lineCount} lines.`;
      console.info(`[F3] ${state.libraryNote}`);
      // Push the now-loaded library into the Identify manager's params seam (if it
      // already exists) so the Identify gate flips ready without a fresh mount.
      state.ident.manager?.setParams({ library: lib });
      render();
    })
    .catch((err) => {
      state.error =
        err instanceof NuclidError ? err.message : `Library load failed: ${(err as Error).message}`;
      render();
    });
}

// --- navigation (DR-2 / DR-7) ----------------------------------------------

function isMode(v: View): v is 'peak-finder' | 'batch' | 'calibrate' | 'identify' | 'quantification' {
  return (
    v === 'calibrate' ||
    v === 'identify' ||
    v === 'peak-finder' ||
    v === 'batch' ||
    v === 'quantification'
  );
}

function navigate(view: View): void {
  if (view === state.view) return;
  // Any normal navigation ends a batch drill-in (drillIntoEntry re-sets it after navigating).
  batchDrillReturn = false;
  batchDrillEntryId = null;
  if (state.view === 'calibrate') {
    state.calib.manager?.stopReveal();
    // 4c lifecycle trigger 3: navigating out of Calibrate while in the builder
    // ends the inspector session (the builder is never resumed cross-view).
    if (state.calib.mode === 'builder') state.calib.inspector = emptyInspectorState();
  }
  if (state.view === 'identify') state.ident.manager?.stopReveal();
  if (state.view === 'peak-finder') state.pf.manager?.stopReveal();
  state.history.push(state.view);
  state.helpOpen = false;
  state.view = view;
  // Calibrate always opens on the Manager (operator ruling 2026-06-29); the builder
  // is launched from there, never resumed on cross-view re-entry. The detail panel
  // also defaults to the Active calibration -- clear any stale preview selection.
  if (view === 'calibrate') {
    state.calib.mode = 'manager';
    state.calib.library.selectedId = null;
    state.calib.library.pendingActiveDeleteId = null;
  }
  render();
}

function back(): void {
  if (state.view === 'calibrate') {
    state.calib.manager?.stopReveal();
    // 4c lifecycle trigger 3 (same as navigate): leaving Build ends the session.
    if (state.calib.mode === 'builder') state.calib.inspector = emptyInspectorState();
  }
  if (state.view === 'identify') state.ident.manager?.stopReveal();
  if (state.view === 'peak-finder') state.pf.manager?.stopReveal();
  const prev = state.history.pop() ?? 'landing';
  state.helpOpen = false;
  state.view = prev;
  // Calibrate always opens on the Manager (operator ruling 2026-06-29); the builder
  // is launched from there, never resumed on cross-view re-entry. The detail panel
  // also defaults to the Active calibration -- clear any stale preview selection.
  if (prev === 'calibrate') {
    state.calib.mode = 'manager';
    state.calib.library.selectedId = null;
    state.calib.library.pendingActiveDeleteId = null;
  }
  render();
}

function navItems(): View[] {
  let items = NAV_ORDER.filter((v) => v !== state.view);
  if (state.view === 'landing') items = items.filter((v) => !isMode(v));
  return items;
}

// --- render ----------------------------------------------------------------

function render(): void {
  // Tear down the previous stage view before the DOM is replaced, so its
  // document-level arrow-key listener never leaks across renders (stageView.ts).
  if (stageViewHandle) {
    stageViewHandle.destroy();
    stageViewHandle = null;
  }
  // Same reason: the QC binding's listeners and the inspector workspace's canvas
  // live on the about-to-be-replaced `#calQc` / `.inspector-mount` nodes.
  if (qcInteraction) {
    qcInteraction.destroy();
    qcInteraction = null;
  }
  if (inspectorWorkspace) {
    inspectorWorkspace.destroy();
    inspectorWorkspace = null;
  }
  if (identInteraction) {
    identInteraction.destroy();
    identInteraction = null;
  }
  if (pfInteraction) {
    pfInteraction.destroy();
    pfInteraction = null;
  }
  // Unbind the previous batch view before the DOM is replaced (its delegated listeners live on
  // the about-to-be-replaced #batchRoot). The manager persists -- only the view is re-bound.
  if (batchViewHandle) {
    batchViewHandle.destroy();
    batchViewHandle = null;
  }
  if (pfSmoothScrollCue) {
    pfSmoothScrollCue.destroy();
    pfSmoothScrollCue = null;
  }
  if (pfNetStage) {
    pfNetStage.destroy();
    pfNetStage = null;
  }
  if (pfContInteractions.length) {
    for (const b of pfContInteractions) b.destroy();
    pfContInteractions = [];
  }
  // Both `.step-*` shells (Peak Finder and, since 2026-07-04, Identify) supply their
  // OWN `.step-topbar` inside their body markup; suppress the shared app-header + global
  // dev-banner in those modes so the chrome is not rendered twice (D1/§5.1). Each shell
  // re-embeds the shared global "under development" `.dev-banner` inside its own body
  // (R2: Identify now does too), so the disclaimer still shows exactly once per mode.
  // The Calibrate *builder* now rides the same `.step-*` shell as Peak Finder / Identify /
  // Batch (2026-07-07 DOM convergence); the Calibrate *manager* (saved-calibrations library)
  // stays a normal page-scroll with the shared app header.
  const calibBuilder = state.view === 'calibrate' && state.calib.mode === 'builder';
  const isStepShell =
    state.view === 'peak-finder' ||
    state.view === 'identify' ||
    state.view === 'batch' ||
    state.view === 'quantification' ||
    calibBuilder;
  const appHeader = isStepShell
    ? ''
    : `
    <header class="app-header">
      <button class="brand" id="home" type="button" aria-label="Nuclid home">
        <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
          <title>Nuclid</title>
          <g transform="translate(8,10)">
            <rect width="52" height="52" rx="12" fill="#0F6E56"/>
            <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
            <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
          </g>
          <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
        </svg>
      </button>
      <nav class="toolbar-nav" aria-label="Platform navigation">
        ${navItems()
          .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
          .join('')}
        ${
          state.view === 'landing'
            ? ''
            : `<button class="nav-btn nav-help" id="helpTrigger" type="button"
          aria-label="Graph &amp; interaction help">?</button>`
        }
      </nav>
    </header>`;
  const devBanner = isStepShell
    ? ''
    : `<div class="dev-banner" role="status">under development - numbers are not yet validated</div>`;
  rootEl.innerHTML = `
    ${appHeader}
    ${devBanner}
    <main class="shell">${viewBody()}</main>
    ${state.helpOpen ? helpDialog() : ''}`;

  // The legacy `mode-build-calibration` flex-shell is retired: the Calibrate builder now
  // uses the shared `.step-*` shell via `mode-peak-finder` below (2026-07-07 convergence),
  // so this modifier is never applied. Its now-unused CSS rules stay parked in style.css
  // (harmless, no element carries `.build-surface` any more).
  document.body.classList.remove('mode-build-calibration');
  // The `.step-*` flex-shell (viewport-height column, fixed chrome, single scrolling
  // `.step-main`) now drives Peak Finder, Identify, Batch AND the Calibrate builder --
  // they share the same DOM, so they share the same body-class hook. // DEVIATION: the
  // hook keeps the historical name `mode-peak-finder` to satisfy the zero-new-CSS bar
  // (the flex-shell rules are keyed on it); a future rename to a neutral
  // `mode-step-shell` is logged as a PARK. The gate includes #app in the flex chain.
  document.body.classList.toggle(
    'mode-peak-finder',
    state.view === 'peak-finder' ||
      state.view === 'identify' ||
      state.view === 'batch' ||
      state.view === 'quantification' ||
      calibBuilder,
  );

  attachShellHandlers();
  if (state.view === 'identify') {
    syncIdentFromManager();
    attachIdentifyHandlers();
    mountIdentify();
  } else if (state.view === 'calibrate') {
    attachCalibrateHandlers();
    mountCalibrate();
  } else if (state.view === 'peak-finder') {
    attachPeakFinderHandlers();
    mountPeakFinder();
    if (batchDrillReturn) injectBatchBack();
  } else if (state.view === 'batch') {
    mountBatch();
  }
  if (state.helpOpen) attachHelpHandlers();
}

function viewBody(): string {
  switch (state.view) {
    case 'landing':
      return landingBody();
    case 'peak-finder':
      return peakFinderBody();
    case 'batch':
      return batchBody();
    case 'calibrate':
      return calibrateBody();
    case 'identify':
      return modeBody('identify');
    case 'quantification':
      return quantificationBody();
    case 'resources':
      return resourcesBody();
    case 'project-status':
      return projectStatusBody();
  }
}

function backBar(): string {
  return `<div class="page-actions"><button class="btn back-btn" id="back" type="button">&larr; Back</button></div>`;
}

function landingBody(): string {
  return `
    <section class="landing">
      <h1 class="landing-title">Nuclid</h1>
      <p class="landing-lede">From a raw gamma spectrum to an identified radionuclide -- every step shown,
        entirely in your browser.</p>
      <div class="landing-actions">
        <button class="btn" type="button" data-nav="peak-finder">Peak Finder</button>
        <button class="btn" type="button" data-nav="batch">Batch Peak Finder</button>
        <button class="btn" type="button" data-nav="calibrate">Calibrate Mode</button>
        <button class="btn" type="button" data-nav="identify">Identify Mode</button>
        <button class="btn" type="button" data-nav="quantification">Quantification</button>
      </div>
      <p class="landing-note">Peak Finder locates the peaks in a spectrum, in channel space, with no further
        analysis. Identify applies a saved calibration to an unknown. Calibrate builds one from
        known sources.</p>
    </section>`;
}

/** Batch Peak Finder -- the mode home (design's Manager surface). A normal page-scrolling shell
 * (not the Peak Finder `.step-*` flex shell): the app header/nav stays so the operator can leave.
 * The batch view mounts into `#batchRoot` via {@link mountBatch}; the manager persists on a
 * module-level handle across renders. */
function batchBody(): string {
  // The immersive `.step-*` flex-shell -- the SAME chrome Peak Finder / Identify use (reused
  // classes, no new CSS): a fixed topbar (brand + sibling-view nav), the embedded dev-banner, and
  // a `.step-body` the batch view fills with its phase rail + scrolling `.step-main`.
  const batchNav: View[] = ['peak-finder', 'calibrate', 'identify', 'resources', 'project-status'];
  return `
    <div class="step-app" id="batchApp">
      <div class="step-topbar">
        <button class="brand" id="batchHome" type="button" aria-label="Nuclid home">
          <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
            <title>Nuclid</title>
            <g transform="translate(8,10)">
              <rect width="52" height="52" rx="12" fill="#0F6E56"/>
              <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
              <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
            </g>
            <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
          </svg>
        </button>
        <nav class="toolbar-nav" aria-label="Platform navigation">
          ${batchNav
            .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
            .join('')}
        </nav>
      </div>
      <div class="dev-banner" role="status">under development - numbers are not yet validated</div>
    </div>`;
}

/** Mount (or re-bind) the batch view. The manager is created once and persists on
 * {@link batchManager}, so its queue + running worker loop survive app re-renders. */
function mountBatch(): void {
  if (!batchManager) batchManager = createBatchManager();
  // The batch view appends its `.step-body` + `.step-nav` footer directly into the step-app (after
  // the topbar + dev-banner), so the footer is a literal direct child of `.step-app` like PF.
  const app = rootEl.querySelector<HTMLElement>('#batchApp');
  if (!app) return;
  batchViewHandle = mountBatchView(app, batchManager, {
    onOpen: drillIntoEntry,
    onContinue: handoffToCalibrate,
    onClose: () => navigate('landing'),
  });
  // Topbar chrome lives outside #batchRoot (the shell), so wire it here once per render; it
  // survives the batch view's inner re-renders (which only replace #batchRoot's contents).
  rootEl
    .querySelector<HTMLButtonElement>('#batchHome')
    ?.addEventListener('click', () => navigate('landing'));
  rootEl
    .querySelectorAll<HTMLButtonElement>('.step-topbar [data-nav]')
    .forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav as View)));
}

/** Hand the reviewed batch to Calibration (P6): feed every kept entry's report into the
 * Calibrate manager as a declared-source row, then open Calibrate's builder landed on Declare
 * identities (past Load -- the batch already did that work). The batch object itself survives:
 * Calibrate consuming the reports is non-destructive. */
function handoffToCalibrate(): void {
  if (!batchManager) return;
  const kept = batchManager.entries.filter(
    (e) => (e.status === 'done' || e.status === 'warning') && e.result != null,
  );
  if (!kept.length) return;
  const mgr = ensureManager();
  mgr.reset(); // clean slate -- clear any prior Calibrate sources before the hand-off
  for (const e of kept) mgr.addParsedSource(e.result!.report);
  // navigate() forces Calibrate's Manager surface; override to the builder landed on Declare.
  navigate('calibrate');
  state.calib.mode = 'builder';
  state.calib.loadError = null;
  state.calib.saved = null;
  state.calib.stageIndex = 0;
  state.calib.modelChosen = false;
  state.calib.expandedRowId = null;
  state.calib.inspector = emptyInspectorState();
  state.calib.configStep = CONFIG_STEP_IDS.indexOf('cfg-identity'); // Declare identities
  render();
}

/** Drill into a batch entry: hydrate the Peak Finder manager with that file's spectrum + its
 * effective config (the SAME the queue used, so the surface matches its result), then show the
 * full Peak Finder with a "Back to batch" affordance. */
function drillIntoEntry(id: string): void {
  if (!batchManager) return;
  const entry = batchManager.entries.find((e) => e.id === id);
  if (!entry) return;
  const mgr = ensurePeakFinderManager();
  mgr.hydrate(entry.spectrum, effectiveConfig(entry, batchManager.defaultConfig));
  navigate('peak-finder'); // resets the drill flags; re-set them and re-render to show Back
  batchDrillReturn = true;
  batchDrillEntryId = id;
  render();
}

/** On leaving a drill-in, persist any operator tuning: if the Peak Finder's current config differs
 * from the entry's effective config, pin it as that entry's per-file override -- which re-runs just
 * that one file through the shared core, so the batch reflects the hand-tuned result. No change =>
 * no override (the file stays inherited, no "custom settings" badge). */
function persistDrillTuning(): void {
  const mgr = state.pf.manager;
  if (!mgr || !batchManager || !batchDrillEntryId) return;
  const entry = batchManager.entries.find((e) => e.id === batchDrillEntryId);
  if (!entry) return;
  const tuned = mgr.currentConfig();
  // "Custom settings" means the config differs from the batch DEFAULT. Comparing against the
  // default (not the entry's effective config) makes the pin a clean toggle: tuning away from the
  // default pins an override; resetting back to the default in the drill-in CLEARS an existing pin
  // (the file returns to inherited). Both re-run the one file; a no-change no-op avoids needless work.
  const matchesDefault = JSON.stringify(tuned) === JSON.stringify(batchManager.defaultConfig);
  if (matchesDefault) {
    if (entry.configOverride !== null) batchManager.setOverride(batchDrillEntryId, null);
  } else {
    batchManager.setOverride(batchDrillEntryId, tuned);
  }
}

/** Inject a fixed "Back to batch" button over the Peak Finder step-shell during a drill-in. The
 * shell suppresses the app header, so this is the only way back to the queue. Inline-styled to
 * avoid a new stylesheet dependency; re-injected each render (it lives inside the replaced root). */
function injectBatchBack(): void {
  rootEl.insertAdjacentHTML(
    'afterbegin',
    `<button id="batchBack" type="button" style="position:fixed;top:12px;left:12px;z-index:2000;font:inherit;font-weight:600;padding:6px 12px;background:var(--surface);color:var(--text);border:1px solid var(--border-strong);border-radius:var(--radius-control);cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.12)">&#9666; Back to batch</button>`,
  );
  rootEl.querySelector<HTMLButtonElement>('#batchBack')?.addEventListener('click', () => {
    persistDrillTuning(); // capture any tuning as the entry's override BEFORE the flags clear
    navigate('batch');
  });
}

/** Identify Mode -- the grouped vertical stepper (mirror of the Calibrate builder
 * surface, the reference interaction model for this product family). The left rail
 * lists Configure / Run / Review with padlocks; the right `.build-panel` shows the
 * active-step card over the active step's body, with a Prev/Next toolbar beneath.
 * The `error` phase shows the honest engine message with the rail parked on Configure.
 *
 * Divergence (intentional, hand-off §"One product family"): 3 Configure steps (not
 * 4), a calibration *selector* (Calibrate builds equations; Identify picks one), and
 * "Run identification" gate copy (vs. "Create calibration"). */
function modeBody(_mode: 'identify'): string {
  const mgr = ensureIdentifyManager();
  const configComplete = identifyConfigCompleteFor(mgr);
  // Clamp the stored Configure position back if an earlier step became incomplete.
  if (mgr.phase.kind === 'collecting' || mgr.phase.kind === 'error') {
    state.ident.configStep = Math.min(
      state.ident.configStep,
      reachableIdentifyConfigMax(configComplete),
    );
  }
  const model = deriveIdentifySteps({
    phase: mgr.phase,
    ready: mgr.ready,
    hasResult: mgr.result != null,
    configStep: state.ident.configStep,
    stageIndex: state.ident.stageIndex,
    reviewView: mgr.reviewView,
    configComplete,
  });
  const isError = mgr.phase.kind === 'error';
  const card = isError ? '' : identifyActiveStepCardMarkup(model);
  // Operator decision 2026-07-04: Identify uses the SAME DOM as Peak Finder -- the v3
  // `.step-app` flex-shell with its own `.step-topbar` (brand + sibling-view nav), the
  // fully-expanded `.step-film` rail, a single scrolling `.step-main`, and the `.step-nav`
  // bottom toolbar. The top bar reuses the landing header's exact brand + nav components
  // (Reference-model principle) so the chrome reads as native V4. `#identBrandHome` routes
  // to landing -- a distinct id from the rail-footer's `#identHome` (Close workspace) so
  // each keeps its own binding. The nav shows the sibling views (all except Identify
  // itself), labels from VIEW_LABEL. // R2 (2026-07-04 operator decision): Identify
  // embeds the SHARED global "under development" `.dev-banner` inside the step-shell
  // (after `.step-topbar`, before `.step-body`), mirroring Peak Finder's embed pattern.
  // The render()-level shared banner stays suppressed for this mode (isStepShell), so
  // the disclaimer is shown exactly once.
  const identNav: View[] = ['peak-finder', 'calibrate', 'resources', 'project-status'];
  return `
    <div class="step-app">
      <div class="step-topbar">
        <button class="brand" id="identBrandHome" type="button" aria-label="Nuclid home">
          <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
            <title>Nuclid</title>
            <g transform="translate(8,10)">
              <rect width="52" height="52" rx="12" fill="#0F6E56"/>
              <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
              <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
            </g>
            <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
          </svg>
        </button>
        <nav class="toolbar-nav" aria-label="Platform navigation">
          ${identNav
            .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
            .join('')}
        </nav>
      </div>
      <div class="dev-banner" role="status">under development - numbers are not yet validated</div>
      <div class="step-body">
        ${identifyStepperRailMarkup(model, { hasRun: mgr.result != null })}
        <section class="step-main">
          ${card}
          ${identifyPanelBodyMarkup(mgr, model)}
        </section>
      </div>
      ${identifyToolbarMarkup(mgr, model)}
    </div>`;
}

// --- Identify mode: grouped stepper (manager-driven) ------------------------

/** Configure sub-step count + Run stage count for Identify -- derived from the
 * stepper meta so a future 4th Configure step needs no change here. */
const IDENT_CONFIG_STEP_COUNT = 3;
const IDENT_RUN_STAGE_COUNT = 7;
/** Configure sub-step ids in order, mapping a rail id to its `configStep` index. */
const IDENT_CONFIG_STEP_IDS = ['cfg-spectrum', 'cfg-calibration', 'cfg-identify'] as const;

/** The single {@link IdentifyManager}, created + subscribed on first Identify mount. */
function ensureIdentifyManager(): IdentifyManager {
  if (state.ident.manager) return state.ident.manager;
  const mgr = createIdentifyManager();
  // Assign BEFORE any emit so a notify during seeding returns the cached instance
  // (never re-creates -> no recursion). Seed the library BEFORE subscribing so the
  // seed's emit reaches no listener (no re-entrant render mid-mount); later edits
  // (the async library-load callback, user input) emit to the subscriber normally.
  state.ident.manager = mgr;
  if (state.library) mgr.setParams({ library: state.library });
  mgr.subscribe(() => onIdentifyManagerNotify(mgr));
  return mgr;
}

/** Manager notification. During the reveal (`running`) only the visible stage
 * advances -- drive the stage-view handle + patch the rail/card in place, no full
 * re-render. Every other transition falls through to a full re-render. Ignored when
 * the Identify view is not mounted (a timer that outlived a navigation away). */
function onIdentifyManagerNotify(mgr: IdentifyManager): void {
  if (state.view !== 'identify') return;
  const phase = mgr.phase;
  if (phase.kind === 'running' && stageViewHandle) {
    stageViewHandle.showStage(phase.stageIndex);
    refreshIdentifyChrome(mgr);
    return;
  }
  render();
}

/** During the timed reveal, patch the grouped rail + active-step card + toolbar label
 * in place so they track the engine's stage without a full re-render (which would
 * remount StageView every tick). Mirrors `refreshBuildChrome`. */
function refreshIdentifyChrome(mgr: IdentifyManager): void {
  const model = deriveIdentifySteps({
    phase: mgr.phase,
    ready: mgr.ready,
    hasResult: mgr.result != null,
    configStep: state.ident.configStep,
    stageIndex: state.ident.stageIndex,
    reviewView: mgr.reviewView,
    configComplete: identifyConfigCompleteFor(mgr),
  });
  const railEl = rootEl.querySelector('.step-film');
  if (railEl) {
    railEl.outerHTML = identifyStepperRailMarkup(model, { hasRun: mgr.result != null });
    // The rail was replaced wholesale, so its footer action buttons lost their
    // listeners -- rebind them. The rail STEP rows are intentionally not rebound here:
    // during the reveal the reveal owns position and forward steps stay locked/inert.
    wireIdentRailActions(mgr);
  }
  const cardEl = rootEl.querySelector('.build-step-card');
  if (cardEl) cardEl.outerHTML = identifyActiveStepCardMarkup(model);
  const label = identifyActiveStepLabel(model);
  const progressEl = rootEl.querySelector('.step-progress');
  if (label && progressEl) progressEl.textContent = identProgressText(label);
}

/** Cumulative completion of the three Configure steps (spectrum / calibration /
 * run-gate). Cumulative by construction (each predicate ANDs the previous). */
function identifyConfigCompleteFor(mgr: IdentifyManager): boolean[] {
  const spectrumLoaded = mgr.report != null;
  const calibrationSelected = spectrumLoaded && mgr.calibration != null;
  const runGate = calibrationSelected && mgr.ready; // the existing Identify gate
  return [spectrumLoaded, calibrationSelected, runGate];
}

/** Highest reachable Configure index given cumulative completion (first incomplete). */
function reachableIdentifyConfigMax(configComplete: readonly boolean[]): number {
  let leading = 0;
  while (leading < IDENT_CONFIG_STEP_COUNT && configComplete[leading]) leading++;
  return Math.min(leading, IDENT_CONFIG_STEP_COUNT - 1);
}

/** Sync the live-result mirror on `state.ident` from the manager (DEBT-12: the same
 * live objects, by identity -- never serialised). Read by `identifyResultMarkup`. */
function syncIdentFromManager(): void {
  const mgr = ensureIdentifyManager();
  state.ident.result = mgr.result;
  state.ident.summary = mgr.summary;
  state.ident.energised = (mgr.energised as EnergisedPeak[] | null) ?? null;
  state.ident.cal = mgr.cal;
  state.ident.calName = mgr.calName;
  state.ident.overlayId = mgr.overlayId;
  state.ident.ran = mgr.result != null || mgr.phase.kind === 'error';
  state.ident.error = mgr.phase.kind === 'error' ? mgr.phase.message : null;
}

/** Route the active step id to its panel body. */
function identifyPanelBodyMarkup(mgr: IdentifyManager, model: IdentifyStepModel): string {
  if (mgr.phase.kind === 'error') return identifyStepperErrorMarkup(mgr.phase.message);
  const id = model.steps[model.activeIndex]?.id ?? 'cfg-spectrum';
  switch (id) {
    case 'cfg-spectrum':
      return identifyConfigSpectrumMarkup(mgr);
    case 'cfg-calibration':
      return identifyConfigCalibrationMarkup(mgr);
    case 'cfg-identify':
      return identifyConfigRunMarkup(mgr);
    case 'review':
      return identifyReviewMarkup(mgr);
    default:
      return identifyStagesShellMarkup(mgr); // run-0..run-6
  }
}

/** Configure step 1 -- Load spectrum: the loader controls + a preview of the loaded
 * unknown (channel-axis spectrum with detected peaks), or the empty dropzone. */
function identifyConfigSpectrumMarkup(mgr: IdentifyManager): string {
  const loadError = state.ident.loadError
    ? `<div class="disclaimer">${escapeHtml(state.ident.loadError)}</div>`
    : '';
  const loaded = mgr.report != null;
  const fileName = loaded ? mgr.report!.spectrum.metadata.fileName : '';
  const preview = loaded
    ? `<div class="ident-preview-head">
         <span class="ident-preview-name">${escapeHtml(fileName)}</span>
         <span class="muted">${mgr.report!.spectrum.counts.length} channels · ${mgr.report!.detectedCandidates.length} peaks</span>
         <button class="btn btn-ghost ident-reset" type="button" ${state.ident.identView ? '' : 'disabled'}>Reset view</button>
       </div>
       <div class="ident-preview-wrap">
         <canvas id="identPreview" class="chart"></canvas>
         <div class="ident-chip" hidden></div>
       </div>`
    : `<div id="identDrop" class="sm-dropzone">Drag &amp; drop a spectrum file here, or use the controls above.</div>`;
  return `
    <div class="cfg-step">
      <p class="sm-objective">Add the unknown spectrum you want to identify.</p>
      <div class="sm-loader">
        <label class="btn">
          <input id="identFile" type="file" accept=".tka,.csv,.txt,.spe" hidden />
          Load spectrum file
        </label>
        <select id="identSample" class="select" aria-label="Load a real demo source">
          <option value="">Real source...</option>
          ${SAMPLE_FILES.map((f) => `<option value="${f}">${f}</option>`).join('')}
        </select>
        <button id="identDemo" class="btn btn-ghost" type="button">Load synthetic demo</button>
      </div>
      ${loadError}
      ${preview}
    </div>`;
}

/** Configure step 2 -- Select calibration: a dropdown of saved calibrations (the
 * active one is the default), showing the resolved equation. The future
 * "Library + parameters" step slots in as a 4th Configure step after this one. */
function identifyConfigCalibrationMarkup(mgr: IdentifyManager): string {
  const library = getCalibrationLibrary();
  const items = library.items;
  const choice = mgr.calibration;
  const builtinSelected = choice?.id === DEFAULT_IDENTIFY_CALIBRATION_ID;

  // The built-in default (GAP-06): always offered, appended LAST so a saved/active
  // calibration stays the default. Rule 12 -- approximate + detector-specific, applied
  // only by explicit operator selection; the framing note below says so.
  const builtinOption = `<option value="${DEFAULT_IDENTIFY_CALIBRATION_ID}" ${builtinSelected ? 'selected' : ''}>${escapeHtml(DEFAULT_IDENTIFY_CALIBRATION_NAME)}</option>`;
  const builtinNote =
    'The built-in default is approximate and specific to the standard demo NaI detector -- ' +
    'a calibration you derive in Calibrate mode is always better.';

  if (!items.length) {
    // Fresh profile: no saved calibrations. Offer the built-in as an explicit pick so
    // Identify is runnable, alongside the honest "build one" path (GAP-06).
    const eq = equationString(DEFAULT_IDENTIFY_CALIBRATION);
    return `
      <div class="cfg-step">
        <p class="sm-objective">Choose the calibration that sets the energy axis.</p>
        <div class="disclaimer">No saved calibrations yet. Build one in Calibrate mode for the best
          results -- Identify never fabricates energies from an uncalibrated spectrum.</div>
        <div class="ident-cal-pick">
          <label class="ident-cal-label" for="identCalSelect">Calibration</label>
          <select id="identCalSelect" class="select">
            <option value="" ${builtinSelected ? '' : 'selected'} disabled>Select a calibration...</option>
            ${builtinOption}
          </select>
        </div>
        ${builtinSelected ? `<p class="ident-cal-eq muted">${escapeHtml(eq)}</p>` : ''}
        <p class="ident-cal-builtin-note muted">${escapeHtml(builtinNote)}</p>
        <div class="calib-actions">
          <button id="identToCalibrate" class="btn" type="button">Go to Calibrate mode</button>
        </div>
      </div>`;
  }

  const selectedId = choice?.id ?? library.activeId ?? items[0].id;
  const savedOptions = items
    .map((r) => {
      const active = r.id === library.activeId ? ' (active)' : '';
      return `<option value="${escapeHtml(r.id)}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.name)}${active}</option>`;
    })
    .join('');
  // Resolve the equation for the current selection -- the built-in is not a store record.
  const selectedCal = builtinSelected
    ? DEFAULT_IDENTIFY_CALIBRATION
    : activeCalibration((items.find((r) => r.id === selectedId) ?? items[0]).result);
  const eq = equationString(selectedCal);
  return `
    <div class="cfg-step">
      <p class="sm-objective">Choose the calibration that sets the energy axis. The active calibration is the default.</p>
      <div class="ident-cal-pick">
        <label class="ident-cal-label" for="identCalSelect">Calibration</label>
        <select id="identCalSelect" class="select">${savedOptions}${builtinOption}</select>
      </div>
      <p class="ident-cal-eq muted">${escapeHtml(eq)}</p>
      ${builtinSelected ? `<p class="ident-cal-builtin-note muted">${escapeHtml(builtinNote)}</p>` : ''}
    </div>`;
}

/** Configure step 3 -- Identify: an inputs recap + the gated "Run identification"
 * button (reuses `#identify` so the existing handler maps cleanly). */
function identifyConfigRunMarkup(mgr: IdentifyManager): string {
  if (!mgr.report) return `<div class="cfg-step"><p class="muted sm-empty">Load a spectrum first.</p></div>`;
  const fileName = mgr.report.spectrum.metadata.fileName;
  const calName = mgr.calibration?.name ?? '(none selected)';
  const nuclideCount = state.library?.entries.length ?? 0;
  const gate = mgr.ready
    ? ''
    : `<span class="sm-gate muted">${escapeHtml(mgr.gateMessage ?? '')}</span>`;
  return `
    <div class="cfg-step">
      <p class="sm-objective">Confirm the inputs, then identify.</p>
      <dl class="cfg-recap">
        <div><dt>Spectrum</dt><dd>${escapeHtml(fileName)}</dd></div>
        <div><dt>Calibration</dt><dd>${escapeHtml(calName)}</dd></div>
        <div><dt>Library</dt><dd>${nuclideCount ? `${nuclideCount} nuclides` : 'loading...'}</dd></div>
      </dl>
      <div class="sm-build">
        <button id="identify" class="btn btn-primary" type="button" ${mgr.ready ? '' : 'disabled'}>
          Run identification
        </button>
        ${gate}
      </div>
    </div>`;
}

/** Run -- the StageView shell mounted by `mountIdentifyStages` into `#identStageRoot`.
 * While running, `.stepper-running` locks the embedded chrome (the engine owns
 * position). The global amber disclaimer (RISK-01) is shown once here. */
function identifyStagesShellMarkup(mgr: IdentifyManager): string {
  const running = mgr.phase.kind === 'running';
  const controls =
    mgr.phase.kind === 'done'
      ? `<button id="identBackToReview" class="btn btn-primary" type="button">&larr; Back to review</button>`
      : `<span class="stepper-status muted">Running identification...</span>`;
  return `
    <section class="exec-stepper">
      <div class="disclaimer">Unvalidated calibration -- for demonstration only.</div>
      <div class="stepper-head">
        <h2 class="page-h2">Identification walkthrough</h2>
        <div class="stepper-controls">${controls}</div>
      </div>
      <div id="identStageRoot" class="card${running ? ' stepper-running' : ''}"></div>
    </section>`;
}

/** Review -- the at-a-glance identification summary (the resting `done` surface):
 * the verdict + ranked isotopes + caveats (reusing `identifyResultMarkup`), plus
 * export + walkthrough + new-spectrum controls. */
function identifyReviewMarkup(mgr: IdentifyManager): string {
  const result = mgr.result;
  const summary = mgr.summary;
  if (!result || !summary) {
    return `<section class="exec-stepper"><div class="disclaimer">No identification to review.</div></section>`;
  }
  return `
    <section class="review-summary ident-review">
      ${identifyResultMarkup(result, summary)}
      <div class="review-controls">
        <button id="identViewWalkthrough" class="btn" type="button">View walkthrough →</button>
        <button id="identExportJson" class="btn" type="button">Export JSON</button>
        <button id="identExportCsv" class="btn" type="button">Export CSV</button>
      </div>
    </section>`;
}

/** The bottom navigation toolbar (mirror of `buildToolbarMarkup`). */
function identifyToolbarMarkup(mgr: IdentifyManager, model: IdentifyStepModel): string {
  const kind = mgr.phase.kind;
  let prevDisabled = false;
  let nextDisabled = false;
  let onRun = false;
  if (kind === 'error' || kind === 'running') {
    prevDisabled = true;
    nextDisabled = true;
  } else if (kind === 'collecting') {
    const cc = identifyConfigCompleteFor(mgr);
    const cur = state.ident.configStep;
    prevDisabled = cur <= 0;
    onRun = cur >= IDENT_CONFIG_STEP_COUNT - 1;
    nextDisabled = onRun ? !mgr.ready : !cc[cur];
  } else {
    // done: position 0..6 = Run stages, IDENT_RUN_STAGE_COUNT = Review summary.
    const pos = mgr.reviewView === 'summary' ? IDENT_RUN_STAGE_COUNT : clampIdentStage(state.ident.stageIndex);
    prevDisabled = pos <= 0;
    nextDisabled = pos >= IDENT_RUN_STAGE_COUNT;
  }
  // Identify-specific: the run gate keeps its "Run identification →" label (Peak Finder
  // has no gate). Everything else adopts Peak Finder's `.step-nav` grammar.
  const nextLabel = onRun ? 'Run identification &rarr;' : 'Next &rarr;';
  const label = kind === 'error' ? null : identifyActiveStepLabel(model);
  const progress = label ? escapeHtml(identProgressText(label)) : '';
  return `
    <div class="step-nav">
      <button id="identPrev" class="step-prev" type="button" ${prevDisabled ? 'disabled' : ''}>&larr; Prev</button>
      <span class="step-progress">${progress}</span>
      <button id="identNext" class="step-next primary" type="button" ${nextDisabled ? 'disabled' : ''}>${nextLabel}</button>
    </div>`;
}

/** The `.step-nav` centred readout for Identify: "{group} · Step n of N · {stage}".
 * Mirrors {@link pfProgressText}, but keeps the group prefix: Identify numbers per group
 * (n resets each group), so the prefix disambiguates -- unlike Peak Finder's continuous
 * 1..8 progress, which drops it. The single source both the bottom-nav markup and the
 * reveal-time chrome patch ({@link refreshIdentifyChrome}) read. */
function identProgressText(label: { group: string; n: number; N: number; name: string }): string {
  return `${label.group} · Step ${label.n} of ${label.N} · ${label.name}`;
}

/** Clamp a Run stage index into 0..IDENT_RUN_STAGE_COUNT-1. */
function clampIdentStage(i: number): number {
  return Math.min(Math.max(0, Math.floor(i)), IDENT_RUN_STAGE_COUNT - 1);
}

/** The engine-error surface (mirror of `stepperErrorMarkup`): the honest message
 * plus a route back to Configure (inputs preserved). */
function identifyStepperErrorMarkup(message: string): string {
  return `
    <section class="exec-stepper">
      <div class="disclaimer">${escapeHtml(message)}</div>
      <div class="stepper-controls">
        <button id="identBackToConfig" class="btn" type="button">Back to inputs</button>
      </div>
    </section>`;
}

/** Run `mgr.build()` from Configure (the Run button or Next-from-Identify). Resets
 * the Run/Configure positions for the fresh run; the collecting->running structural
 * transition needs a full render to mount the StageView panel. */
function doIdentify(mgr: IdentifyManager): void {
  if (!mgr.ready) return;
  state.ident.stageIndex = 0;
  state.ident.configStep = 0;
  mgr.build(); // emits running | error
  render();
}

/** Navigate the grouped rail to a step by id (mirror of `goToBuildStep`). */
function goToIdentifyStep(id: string, mgr: IdentifyManager): void {
  if (id.startsWith('cfg-')) {
    const idx = (IDENT_CONFIG_STEP_IDS as readonly string[]).indexOf(id);
    if (idx >= 0) state.ident.configStep = idx;
    render();
  } else if (id.startsWith('run-')) {
    if (mgr.phase.kind !== 'done') return;
    state.ident.stageIndex = clampIdentStage(Number(id.slice(4)));
    if (mgr.reviewView !== 'walkthrough') mgr.setReviewView('walkthrough');
    else render();
  } else if (id === 'review') {
    if (mgr.reviewView !== 'summary') mgr.setReviewView('summary');
    else render();
  }
}

/** Bottom toolbar Prev/Next (mirror of `buildNavStep`). */
function identifyNavStep(mgr: IdentifyManager, dir: -1 | 1): void {
  const kind = mgr.phase.kind;
  if (kind === 'error' || kind === 'running') return;
  if (kind === 'collecting') {
    const cur = state.ident.configStep;
    if (dir === 1) {
      if (cur >= IDENT_CONFIG_STEP_COUNT - 1) {
        doIdentify(mgr); // Next from Identify -> run (no-op when not ready)
        return;
      }
      if (!identifyConfigCompleteFor(mgr)[cur]) return;
      state.ident.configStep = cur + 1;
      render();
      return;
    }
    if (cur <= 0) return;
    state.ident.configStep = cur - 1;
    render();
    return;
  }
  // done: position 0..6 = Run stages, IDENT_RUN_STAGE_COUNT = Review summary.
  const pos = mgr.reviewView === 'summary' ? IDENT_RUN_STAGE_COUNT : clampIdentStage(state.ident.stageIndex);
  const next = Math.min(Math.max(0, pos + dir), IDENT_RUN_STAGE_COUNT);
  if (next === pos) return;
  if (next === IDENT_RUN_STAGE_COUNT) {
    if (mgr.reviewView !== 'summary') mgr.setReviewView('summary');
    else render();
  } else {
    state.ident.stageIndex = next;
    if (mgr.reviewView !== 'walkthrough') mgr.setReviewView('walkthrough');
    else render();
  }
}

// --- Peak Finder mode: grouped stepper (manager-driven) ----------------------

/** Run stage count for Peak Finder -- the six inspector pipeline stages. */
const PF_RUN_STAGE_COUNT = PF_RUN_STAGES.length;

/** The single {@link PeakFinderManager}, created + subscribed on first mount. */
function ensurePeakFinderManager(): PeakFinderManager {
  if (state.pf.manager) return state.pf.manager;
  const mgr = createPeakFinderManager();
  state.pf.manager = mgr;
  mgr.subscribe(() => onPeakFinderNotify());
  return mgr;
}

/** Manager notification: every transition falls through to a full re-render. (The timed
 * detect reveal / continuum walkthrough that used to patch chrome in place were removed
 * 2026-07-07 -- Continue/Run land on their step instantly.) Ignored when the Peak Finder
 * view is not mounted. */
function onPeakFinderNotify(): void {
  if (state.view !== 'peak-finder') return;
  render();
}

/** Build the grouped step model from the manager's free-navigation state. Single source
 * every render reads (`reached` unlock, `focus` on-screen). */
function pfModel(mgr: PeakFinderManager): PeakFinderStepModel {
  return derivePeakFinderSteps({
    reached: mgr.reached,
    focus: mgr.focus,
  });
}

/** The `.step-nav` centred readout: "Step {n} of {N} · {stage}". With global 1..8
 * numbering the group prefix is redundant, so it is dropped (Rev 3, §B). The single
 * source both the bottom-nav markup and the reveal-time chrome patch read. */
function pfProgressText(label: { group: string; n: number; N: number; name: string }): string {
  return `Step ${label.n} of ${label.N} · ${label.name}`;
}

/** Peak Finder -- the third grouped-stepper surface (mirror of {@link modeBody},
 * the reference interaction model). Divergences from that model are commented
 * `// Divergence:` at their sites (single-step Configure; auto-run on load). */
function peakFinderBody(): string {
  const mgr = ensurePeakFinderManager();
  const model = pfModel(mgr);
  const isError = mgr.phase.kind === 'error';
  // Suppress the pipeline step-card when a boundary page is open -- that page renders its own
  // header (peakFinderBoundaryMarkup). Error still wins over both.
  const boundaryOpen = mgr.phase.kind !== 'error' && state.pf.boundaryView != null;
  const card = isError || boundaryOpen ? '' : peakFinderActiveStepCardMarkup(model);
  // The Peak Finder top bar reuses the landing header's exact `.brand` / `.brand-logo`
  // / `.toolbar-nav` / `.nav-btn` components (Reference-model principle) so the chrome
  // reads as native V4. The container keeps `class="step-topbar"` (flex-shell hook)
  // and `#pfHome` keeps the route-to-landing handler. The nav shows exactly the four
  // sibling views (labels sourced from VIEW_LABEL); New file moved to the rail bottom.
  const pfNav: View[] = ['calibrate', 'identify', 'resources', 'project-status'];
  return `
    <div class="step-app">
      <div class="step-topbar">
        <button class="brand" id="pfHome" type="button" aria-label="Nuclid home">
          <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
            <title>Nuclid</title>
            <g transform="translate(8,10)">
              <rect width="52" height="52" rx="12" fill="#0F6E56"/>
              <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
              <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
            </g>
            <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
          </svg>
        </button>
        <nav class="toolbar-nav" aria-label="Platform navigation">
          ${pfNav
            .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
            .join('')}
        </nav>
      </div>
      <div class="dev-banner" role="status">under development - numbers are not yet validated</div>
      <div class="step-body">
        ${peakFinderStepperRailMarkup(model, { hasSpectrum: mgr.rawSpectrum != null, activeBoundary: state.pf.boundaryView })}
        <section class="step-main">
          ${card}
          ${peakFinderPanelBodyMarkup(mgr, model)}
          ${pfSmoothScrollCueMarkup(model)}
        </section>
      </div>
      ${peakFinderToolbarMarkup(mgr, model)}
    </div>`;
}

/** Route the FOCUSED step id to its panel body (2026-07-05 free-nav: routing follows focus,
 * not the execution phase, so a done workspace can revisit any earlier page). */
function peakFinderPanelBodyMarkup(mgr: PeakFinderManager, model: PeakFinderStepModel): string {
  if (mgr.phase.kind === 'error')
    return peakFinderErrorMarkup(mgr.phase.message, mgr.errorCountdown);
  // Workflow-boundary short-circuit (2026-07-07): a locked downstream stage's teaching page is a
  // view-local surface (state.pf.boundaryView), routed here BELOW the error phase (a fault must
  // always win) and ABOVE the pipeline `switch`. No manager involvement (channel-space-only).
  if (state.pf.boundaryView) return peakFinderBoundaryMarkup(mgr, state.pf.boundaryView);
  const id = model.steps[model.activeIndex]?.id ?? 'load-spectrum';
  switch (id) {
    case 'load-spectrum':
      return peakFinderLoadMarkup(mgr);
    case 'load-sg':
      return peakFinderSmoothMarkup(mgr);
    case 'cont-working':
    case 'cont-lls':
    case 'cont-snip':
    case 'cont-invlls':
    case 'cont-net':
    case 'cont-sg':
      return peakFinderContinuumMarkup(mgr, id);
    case 'review':
      return peakFinderReviewMarkup(mgr);
    default:
      return peakFinderStageMarkup(mgr); // run-0..run-7
  }
}

// --- workflow boundary teaching pages (2026-07-07) --------------------------

/** Content for one boundary teaching page. Single source (mirrors PF_CONT_PAGE_COPY): the
 * renderer is generic, the copy lives here. `cta.target` null + `disabled` => a greyed
 * "Coming soon" button (D-4, Quantification has no View to open). */
interface PfBoundaryContent {
  readonly title: string;
  readonly purpose: string; // what this stage is
  readonly whyLocked: string; // why Peak Finder cannot do it
  readonly requirements: readonly string[]; // inputs it needs (channel-space peaks aside)
  readonly transition: string; // the channel-space -> energy conceptual explanation
  readonly cta: { readonly label: string; readonly target: View | null; readonly disabled?: boolean };
}

const PF_BOUNDARY_CONTENT: Record<PeakFinderBoundaryStage['id'], PfBoundaryContent> = {
  'energy-cal': {
    title: 'Energy Calibration',
    purpose:
      'Energy Calibration converts detector channel numbers into physical gamma-ray energies ' +
      '(keV) by fitting a calibration equation from validated peaks and known reference energies.',
    whyLocked:
      'Peak Finder extracts and validates peaks but does not know their physical identity. ' +
      'Calibration needs detector-specific information that only exists in Calibration Mode.',
    requirements: [
      'Validated peaks',
      'Reference gamma-ray energies',
      'Peak-to-energy assignments',
      'Calibration configuration',
    ],
    transition:
      'Everything produced so far exists in detector channel space. Calibration teaches the ' +
      'detector to convert channel numbers into physical energies; once a calibration equation ' +
      'exists, future spectra read directly in keV.',
    cta: { label: 'Open Calibration Mode →', target: 'calibrate' },
  },
  'radionuclide-id': {
    title: 'Radionuclide Identification',
    purpose:
      'Radionuclide Identification determines which radionuclides produced the peaks by matching ' +
      'calibrated energies against a gamma-ray reference library.',
    whyLocked:
      'Identification needs an energy calibration first (peaks must be in keV), plus a nuclide ' +
      'library and matching tolerances — none of which exist inside Peak Finder.',
    requirements: [
      'Energy-calibrated peaks',
      'Gamma-ray reference library',
      'Match tolerances',
      'Confidence criteria',
    ],
    transition:
      'With peaks now in keV, identification compares each energy against known nuclide lines. ' +
      'Peak Finder stops at channel-space measurement; naming the source is the next mode.',
    cta: { label: 'Open Identify Mode →', target: 'identify' },
  },
  quantification: {
    title: 'Quantification',
    purpose:
      'Quantification computes activities or concentrations from net peak areas using efficiency ' +
      'calibration and live-time.',
    whyLocked:
      'Quantification needs energy and efficiency calibration, identified nuclides, and ' +
      'acquisition metadata (live-time, geometry) that are not present in Peak Finder.',
    requirements: [
      'Identified nuclides',
      'Efficiency calibration',
      'Live-time and geometry',
      'Decay corrections',
    ],
    transition:
      'Once nuclides are identified, their net areas become activities through efficiency and ' +
      'live-time corrections. This stage is planned but not yet built.',
    cta: { label: 'Open Quantification', target: null, disabled: true },
  },
};

/** One "Current status" row's derived state (pure; exported for tests). */
export interface PfBoundaryStatusRow {
  readonly label: string;
  readonly state: 'done' | 'todo' | 'wait';
  readonly note: string;
}

/** The pipeline "Current status" derivation, PURE (channel-space booleans only, no engine touch):
 * detection + measurement are done once a report exists; validation once the trace has validated
 * peaks; detector calibration always waits for Calibration Mode. Reachable before any run (D-2),
 * so `hasReport === false` shows the three pipeline rows as "Not started". Exported so the
 * report-absent / report-present / validated cases can be unit-tested without a live manager. */
export function pfBoundaryStatus(hasReport: boolean, hasValidated: boolean): PfBoundaryStatusRow[] {
  const done = (b: boolean): PfBoundaryStatusRow['state'] => (b ? 'done' : 'todo');
  const note = (b: boolean): string => (b ? 'Complete' : 'Not started');
  return [
    { label: 'Peak detection', state: done(hasReport), note: note(hasReport) },
    { label: 'Peak measurement', state: done(hasReport), note: note(hasReport) },
    { label: 'Peak validation', state: done(hasValidated), note: note(hasValidated) },
    { label: 'Detector calibration', state: 'wait', note: 'Waiting for Calibration Mode' },
  ];
}

/** Render the "Current status" rows from a manager (channel-space reads only). */
function pfBoundaryStatusRows(mgr: PeakFinderManager): string {
  const validated = mgr.pipelineTrace?.validated;
  const hasValidated = Array.isArray(validated) && validated.length > 0;
  return pfBoundaryStatus(mgr.report != null, hasValidated)
    .map((r) => {
      const mod =
        r.state === 'wait'
          ? 'pf-boundary-req--wait'
          : r.state === 'done'
            ? 'pf-boundary-req--done'
            : 'pf-boundary-req--todo';
      const glyph = r.state === 'wait' ? '◷' : r.state === 'done' ? '✓' : '○';
      return `<li class="pf-boundary-req ${mod}">
        <span class="pf-boundary-req-glyph" aria-hidden="true">${glyph}</span>
        <span class="pf-boundary-req-label">${escapeHtml(r.label)}</span>
        <span class="pf-boundary-req-note">${escapeHtml(r.note)}</span>
      </li>`;
    })
    .join('');
}

/** A workflow-boundary teaching page (2026-07-07). A view-local surface (state.pf.boundaryView),
 * NOT a pipeline step: it explains a stage beyond Peak Finder's responsibility and, where a mode
 * exists, offers a CTA into it. Reuses `.build-step-card` for the header + `.btn` for actions;
 * the page-specific chrome is PF-local `.pf-boundary-*` CSS. */
function peakFinderBoundaryMarkup(mgr: PeakFinderManager, id: PeakFinderBoundaryStage['id']): string {
  const c = PF_BOUNDARY_CONTENT[id];
  // Requirements are the inputs this stage NEEDS (neutral dots) -- the truthful "what is done"
  // signal lives in the separate Current-status card, so we never imply a not-yet-met input is met.
  const reqs = c.requirements
    .map(
      (r) => `<li class="pf-boundary-req pf-boundary-req--todo">
        <span class="pf-boundary-req-glyph" aria-hidden="true">○</span>
        <span class="pf-boundary-req-label">${escapeHtml(r)}</span>
      </li>`,
    )
    .join('');
  const ctaDisabled = c.cta.disabled === true || c.cta.target == null;
  const cta = ctaDisabled
    ? `<button class="btn pf-boundary-cta" type="button" disabled aria-disabled="true">${escapeHtml(c.cta.label)}</button>
       <span class="pf-boundary-soon">Coming soon</span>`
    : `<button class="btn primary pf-boundary-cta" type="button" data-boundary-cta="${c.cta.target}">${escapeHtml(c.cta.label)}</button>`;
  return `
    <div class="pf-boundary-page">
      <div class="build-step-card">
        <span class="build-card-eyebrow">Locked · Next: Calibration</span>
        <h2 class="build-card-title">${escapeHtml(c.title)}<span class="pf-boundary-lock-pill">Locked</span></h2>
        <p class="build-card-subtitle">${escapeHtml(c.purpose)}</p>
      </div>
      <div class="pf-boundary-grid">
        <div class="pf-boundary-card">
          <h3 class="pf-boundary-card-title">Why this is the next mode</h3>
          <p class="pf-boundary-why">${escapeHtml(c.whyLocked)}</p>
        </div>
        <div class="pf-boundary-card">
          <h3 class="pf-boundary-card-title">What it needs</h3>
          <ul class="pf-boundary-reqs">${reqs}</ul>
        </div>
        <div class="pf-boundary-card">
          <h3 class="pf-boundary-card-title">Current status</h3>
          <ul class="pf-boundary-reqs">${pfBoundaryStatusRows(mgr)}</ul>
        </div>
      </div>
      <div class="pf-boundary-callout">${escapeHtml(c.transition)}</div>
      <div class="pf-boundary-actions">
        ${cta}
        <button class="btn pf-boundary-back" type="button" data-boundary-back>← Back to detected peaks</button>
      </div>
    </div>`;
}

/** Open a boundary teaching page (view-local: no manager emit -- the manager is channel-space-only,
 * so mirror the .pf-reset / navigate direct-render precedents and render() straight away). */
function showPeakFinderBoundary(id: PeakFinderBoundaryStage['id']): void {
  state.pf.boundaryView = id;
  render();
}

/** The upload controls for the EMPTY Load step: a Real Source dropdown + a file button.
 * // Divergence (R2): loading no longer auto-runs -- it parses + holds the spectrum for
 * the preprocessing step. Once a spectrum is held, the body no longer renders this (the
 * file-management actions move to the rail, §D); so it is the empty state's loader only. */
function pfUploaderMarkup(): string {
  return `
    <div class="sm-loader">
      <label class="btn">
        <input id="pfFile" type="file" accept=".tka,.csv,.txt,.spe" hidden />
        Load Spectrum File
      </label>
      <select id="pfSample" class="select" aria-label="Load a real source">
        <option value="">Real Source…</option>
        ${SAMPLE_FILES.map((f) => `<option value="${f}">${f}</option>`).join('')}
      </select>
    </div>`;
}

/**
 * One-pass summary of a raw counts array for the Load-stage Spectrum Overview card.
 * Pure and side-effect-free; exported so a unit test can assert the arithmetic
 * directly. Only pre-processing facts -- nothing derived from a later analysis stage.
 */
export function spectrumOverview(counts: readonly number[]): {
  total: number;
  max: number;
  argmax: number;
  mean: number;
  nonZero: number;
  channelCount: number;
} {
  let total = 0;
  let max = -Infinity;
  let argmax = 0;
  let nonZero = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    total += c;
    if (c > max) {
      max = c;
      argmax = i;
    }
    if (c > 0) nonZero++;
  }
  const n = counts.length;
  return { total, max: n ? max : 0, argmax, mean: n ? total / n : 0, nonZero, channelCount: n };
}

/** Humanise a byte count: B / KB / MB, 1 dp above 1 KiB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render one Load-stage info card as a `<dl>`, dropping any row whose value is null
 * (§5c: hide unavailable data, never a placeholder). Labels are static; callers must
 * pre-escape any file-derived string value. */
function pfInfoCard(title: string, rows: readonly (readonly [string, string | null])[]): string {
  const body = rows
    .filter((r) => r[1] != null)
    .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
    .join('');
  return `<article class="card pf-info-card"><h4>${title}</h4><dl class="pf-info-grid">${body}</dl></article>`;
}

/** Spectrum Overview card -- everything derivable from the raw counts in one pass. */
function pfOverviewCard(counts: readonly number[]): string {
  const o = spectrumOverview(counts);
  return pfInfoCard('Spectrum Overview', [
    ['Total Counts', o.total.toLocaleString()],
    ['Maximum Counts', o.max.toLocaleString()],
    ['Highest Count Channel', o.argmax.toLocaleString()],
    ['Mean Counts per Channel', o.mean.toFixed(2)],
    ['Non-zero Channels', `${o.nonZero.toLocaleString()} / ${o.channelCount.toLocaleString()}`],
  ]);
}

/** File Information card. File Size row hidden when the size is unknown (null). */
function pfFileCard(meta: SpectrumMetadata): string {
  return pfInfoCard('File Information', [
    ['Filename', escapeHtml(meta.fileName)],
    ['File Format', escapeHtml(meta.format.toUpperCase())],
    ['File Size', meta.fileSizeBytes != null ? formatBytes(meta.fileSizeBytes) : null],
    ['Number of Channels', meta.channelCount.toLocaleString()],
  ]);
}

/** Acquisition Information card -- rendered ONLY when at least one acquisition field
 * is known (§5c: no empty card, no placeholder). Dead Time is derived from live/real,
 * a property of the acquisition, so it stays pre-processing-safe. */
function pfAcquisitionCard(meta: SpectrumMetadata): string {
  const dt = deadTimeFraction(meta);
  const rows: (readonly [string, string | null])[] = [
    ['Live Time', meta.liveTimeSec != null ? `${meta.liveTimeSec} s` : null],
    ['Real Time', meta.realTimeSec != null ? `${meta.realTimeSec} s` : null],
    ['Dead Time', dt != null ? `${(dt * 100).toFixed(1)}%` : null],
    ['Detector', meta.detector != null ? escapeHtml(meta.detector) : null],
    ['Sample Name', meta.sampleName != null ? escapeHtml(meta.sampleName) : null],
    ['Measurement Date', meta.measurementDate != null ? escapeHtml(meta.measurementDate) : null],
  ];
  if (rows.every((r) => r[1] == null)) return '';
  return pfInfoCard('Acquisition Information', rows);
}

/** Data Quality card -- positive checks derived from the parse result + counts. A
 * held spectrum already passed the parser's hard gates, so these normally all tick;
 * the ⚠ branch stays implemented so the section is truthful if the invariant changes. */
function pfDataQualityCard(counts: readonly number[], channelCount: number): string {
  const allLoaded = counts.length === channelCount;
  const noMissing = counts.every((c) => Number.isFinite(c));
  const noNegative = counts.every((c) => c >= 0);
  const row = (ok: boolean, okText: string, warnText: string): string =>
    ok
      ? `<div class="pf-check ok"><span class="pf-check-mark" aria-hidden="true">✓</span>${okText}</div>`
      : `<div class="pf-check warn"><span class="pf-check-mark" aria-hidden="true">⚠</span>${warnText}</div>`;
  return `<article class="card pf-info-card"><h4>Data Quality</h4><div class="pf-checks">${row(
    true,
    'File parsed successfully',
    'File parse incomplete',
  )}${row(allLoaded, 'All channels loaded', 'Channel count mismatch')}${row(
    noMissing,
    'No missing values',
    'Missing or non-finite values detected',
  )}${row(noNegative, 'No negative counts', 'Negative counts detected')}</div></article>`;
}

/** Load Spectrum -- the single Load step. // Divergence: smoothing moved to its own
 * Savitzky-Golay stage; the Load stage is now upload -> raw preview -> Continue only.
 * Before a spectrum is held (`collecting`) only the uploader shows; once held
 * (`preprocessing`) the raw preview + the "What did I upload?" info cards appear.
 * Exported as a test seam (jsdom markup test). */
export function peakFinderLoadMarkup(mgr: PeakFinderManager): string {
  const loadError = state.pf.loadError
    ? `<div class="disclaimer">${escapeHtml(state.pf.loadError)}</div>`
    : '';
  // Free-nav: the raw preview shows whenever a spectrum is held (the focused step is
  // Load Spectrum), regardless of how far the run has progressed; the empty uploader shows
  // only before any spectrum is loaded (`collecting`).
  const held = mgr.rawSpectrum != null;
  if (!held) {
    return `
    <div class="cfg-step">
      <p class="sm-objective">Load a spectrum to find its peaks. Preview it, then continue through the
        smoothing and continuum stages to run the detection pipeline. Peak positions are channel indices.</p>
      <p class="sm-help muted">Each stage narrows the candidate set, from every local maximum down to the
        validated peaks. Once the run finishes, the peak tables and the chart are linked — select a
        row or a peak to highlight it in both.</p>
      ${pfUploaderMarkup()}
      ${loadError}
      <div id="pfDrop" class="sm-dropzone">Drag &amp; drop a spectrum file here, or use the controls above.</div>
    </div>`;
  }
  // Once a spectrum is held the body carries NO file-management controls (no uploader /
  // demo / Continue) -- those live in the rail (§D) and the bottom nav (§F). Just the
  // uploaded-file info + the raw preview; smoothing is the next stage.
  const meta = mgr.rawSpectrum!.metadata;
  const counts = mgr.rawSpectrum!.counts;
  // Info region below the chart answers "What did I upload?" -- pre-processing facts
  // only (§ hard constraint). The chart block above is UNCHANGED. The old muted
  // `pf-file-info` caption is absorbed into the File Information card.
  return `
    <div class="cfg-step">
      <p class="sm-objective">Preview the raw spectrum, then continue to the next stage.
        Positions are channel indices.</p>
      ${loadError}
      ${pfChartBlock({ toolbar: pfChartToolbarMarkup(), charts: [{ id: 'pfLoadChart' }] })}
      <section class="pf-load-info">
        ${pfOverviewCard(counts)}
        ${pfFileCard(meta)}
        ${pfAcquisitionCard(meta)}
        ${pfDataQualityCard(counts, meta.channelCount)}
      </section>
    </div>`;
}

/** The two Savitzky-Golay preview colours (raw vs smoothed), shared by the graph + legend. */
const PF_SMOOTH_COLORS = { raw: '#0F6E56', smoothed: '#04342C' } as const;

/** The static legend under the SG preview graph (Raw · Savitzky–Golay), mirroring the
 * continuum legend chip pattern (non-interactive here -- it labels the two overlaid series). */
function pfSmoothLegendMarkup(): string {
  const item = (color: string, label: string): string =>
    `<span class="pf-cont-series is-on"><span class="pf-cont-swatch" style="background:${color}"></span>${label}</span>`;
  return `<div class="pf-cont-legend" aria-label="Series">${item(PF_SMOOTH_COLORS.raw, 'Raw Spectrum')}${item(
    PF_SMOOTH_COLORS.smoothed,
    'Savitzky–Golay Smoothed Spectrum',
  )}</div>`;
}

/** One "Effect of Smoothing" decision card (Card A or B) -- a titled spec-sheet of
 * label-left / value-right metric rows (mirroring the `.cal-resid-*` row idiom), with an
 * optional secondary detail line and an optional thin meter bar. Returns '' when the card is
 * null (every row hidden as degenerate), so the grid simply drops it. The `data-cue-label`
 * lets the scroll cue name this section when it is below the fold. */
function pfSmoothCardMarkup(card: SmoothingCard | null): string {
  if (!card) return '';
  const rows = card.metrics
    .map((m) => {
      const detail = m.detail
        ? `<span class="pf-sg-metric-detail">${escapeHtml(m.detail)}</span>`
        : '';
      const meter =
        m.meter != null
          ? `<div class="pf-sg-meter"><span class="pf-sg-meter-fill" style="width:${(
              Math.max(0, Math.min(1, m.meter)) * 100
            ).toFixed(1)}%"></span></div>`
          : '';
      return `
        <div class="pf-sg-metric">
          <div class="pf-sg-metric-head">
            <span class="pf-sg-metric-label">${escapeHtml(m.label)}</span>
            <span class="pf-sg-metric-value">${escapeHtml(m.value)}</span>
          </div>
          ${detail}
          ${meter}
        </div>`;
    })
    .join('');
  return `
    <div class="pf-sg-card" data-cue-label="${escapeHtml(card.title)}">
      <h4 class="pf-sg-card-title">${escapeHtml(card.title)}</h4>
      <div class="pf-sg-metrics">${rows}</div>
    </div>`;
}

/** The Savitzky–Golay stage's scroll cue: a gentle "more below" affordance pinned to the
 * bottom edge of the `.step-main` viewport (it IS the scroller). Rendered only for the SG
 * stage, only mounted (its listeners wired) in {@link mountPeakFinder}. It sits in the DOM
 * ALWAYS but with zero flow height (a `position:sticky; bottom:0; height:0` shell whose
 * visible chip is an absolutely-positioned child) so it never inflates the clip measurement;
 * JS toggles `.is-visible` and fills the section label. */
function pfSmoothScrollCueMarkup(model: PeakFinderStepModel): string {
  const id = model.steps[model.activeIndex]?.id ?? '';
  // Divergence: the cue is now shared by nine stages -- the two Savitzky–Golay stages
  // (`load-sg`, `cont-sg`), the Working Copy stage (`cont-working`), the LLS / SNIP / Inverse
  // LLS Transform stages (`cont-lls`, `cont-snip`, `cont-invlls`), the Net Spectrum stage
  // (`cont-net`), the "Find Local Maxima" Detect stage (`run-0`), the "Peak Fitting" Finalize
  // stage (`run-6`), and the "Validate Peaks" Finalize stage (`run-7`), all of whose educational
  // cards sit below the fold. The `.pf-sg-scrollcue` class name is kept (lower churn) though it is
  // no longer SG-only; the mount logic is fully generic (scans `[data-cue-label]`).
  if (
    id !== 'load-sg' &&
    id !== 'cont-sg' &&
    id !== 'cont-working' &&
    id !== 'cont-lls' &&
    id !== 'cont-snip' &&
    id !== 'cont-invlls' &&
    id !== 'cont-net' &&
    id !== 'run-0' &&
    id !== 'run-6' &&
    id !== 'run-7' &&
    id !== 'review'
  )
    return '';
  return `
    <div class="pf-sg-scrollcue" aria-hidden="true">
      <button class="pf-sg-scrollcue-btn" type="button" tabindex="-1">
        <span class="pf-sg-scrollcue-label"></span>
        <span class="pf-sg-scrollcue-chevron" aria-hidden="true">⌄</span>
      </button>
    </div>`;
}

/** Savitzky–Golay -- the dedicated smoothing stage (redesign, always-apply). SG is ALWAYS
 * applied to the raw spectrum (no on/off toggle); the params are always editable; a
 * raw-vs-smoothed overlay graph (`#pfSmoothChart`, SD-C) with a legend beneath shows the
 * effect. The smoothed spectrum is carried forward through the rest of the analysis by
 * DEFAULT (`continuumInput`, default Savitzky–Golay smoothed) -- no raw-vs-smoothed choice is
 * solicited here (2026-07-08): the walkthrough never stops for that input; the preselected
 * default is taken and the user re-tunes it later on the Review page's Adjust-smoothing panel.
 * A disclaimer states the scope: SG feeds continuum + detection only; centroids/areas/FWHM
 * always come from raw (R1). Channel-space only. */
function peakFinderSmoothMarkup(mgr: PeakFinderManager): string {
  return `
    <div class="cfg-step">
      <p class="sm-objective">Savitzky–Golay smoothing is applied to the raw spectrum and carried through
        background (continuum) estimation and peak detection. Review its effect below; positions are channel
        indices. No choice is required here — the smoothed spectrum is used by default.</p>
      ${pfChartBlock({
        toolbar: pfChartToolbarMarkup(),
        charts: [{ id: 'pfSmoothChart' }],
        legend: pfSmoothLegendMarkup(),
      })}
      <div class="pf-sg-disclaimer" role="note">
        Savitzky–Golay smoothing is applied only through background (continuum) estimation and peak
        detection. Peak <strong>centroids, areas, and FWHM are always measured from the raw spectrum</strong>
        — smoothing never affects your quantitative results. Prefer the raw spectrum? You can switch back
        from the <strong>Review</strong> step.
      </div>
      <div class="pf-sg-divider" role="separator">
        <span>Configure the Savitzky–Golay parameters and see their effect below</span>
      </div>
      <div class="pf-sg-grid">
        <div class="pf-sg-card pf-sg-card--params">
          <h4 class="pf-sg-card-title">Savitzky–Golay parameters</h4>
          ${peakFinderPreprocessMarkup(mgr)}
        </div>
        ${(() => {
          const eff = deriveSmoothingEffect({
            raw: mgr.rawSpectrum?.counts ?? [],
            smoothed: mgr.smoothedSpectrum?.counts ?? [],
            sgWindow: mgr.sgWindow,
          });
          return `${pfSmoothCardMarkup(eff.effect)}${pfSmoothCardMarkup(eff.comparison)}`;
        })()}
      </div>
    </div>`;
}

/** The Savitzky-Golay parameter panel (redesign): window + polyorder fields, ALWAYS
 * editable (SG is always applied now -- no on/off gate), plus Reset-to-defaults. The clamp
 * keeps params in-band; a non-blocking advisory shows at the edges. `sgError` (pathological
 * only) surfaces inline and blocks Continue. // Divergence (R1): smoothing feeds continuum +
 * detection only; areas stay raw. */
function peakFinderPreprocessMarkup(mgr: PeakFinderManager): string {
  const sgErr = mgr.sgError
    ? `<div class="disclaimer pf-sg-error">${escapeHtml(mgr.sgError)}</div>`
    : '';
  const sgAdvisory =
    !mgr.sgError && mgr.sgAdvisory ? `<p class="pf-sg-advisory">${escapeHtml(mgr.sgAdvisory)}</p>` : '';
  // Unpacked (no inner `.pf-preprocess` box): these sit directly inside the outer
  // `.pf-sg-card--params` surface, so the panel reads as a single card, not a card-in-a-card.
  return `
    <p class="pf-sg-hint muted">Smoothing steadies the candidate search. Adjust the window length and
      polynomial order; larger windows smooth more but can suppress narrow peaks.</p>
    <div class="pf-sg-params">
      <div class="pf-sg-fields">
        <label class="pf-sg-field">
          <span>Window length</span>
          <input id="pfSgWindow" class="pf-sg-input" type="number" min="5" max="15" step="2"
            value="${mgr.sgWindow}" />
        </label>
        <label class="pf-sg-field">
          <span>Polynomial order</span>
          <input id="pfSgPoly" class="pf-sg-input" type="number" min="2" max="4" step="1"
            value="${mgr.sgPolyorder}" />
        </label>
      </div>
      <div class="pf-sg-actions">
        <button id="pfSgApply" class="btn pf-sg-apply" type="button">Apply</button>
        <button id="pfSgReset" class="btn btn-primary pf-sg-reset" type="button">Reset to Defaults</button>
      </div>
    </div>
    ${sgErr}
    ${sgAdvisory}`;
}

/** The Estimate Continuum stage's chart toolbar: the shared Linear/Log Y-scale toggle
 * (`.pf-scale`, wired verbatim) plus a continuum-scoped Reset View (`.pf-cont-reset`,
 * driven by the separate `state.pf.contView` window so it never fights the stage chart's
 * reset). */
function pfContToolbarMarkup(): string {
  const linActive = state.logY ? '' : ' active';
  const logActive = state.logY ? ' active' : '';
  return `
    <div class="step-charttoolbar">
      <div class="toggle-group" role="group" aria-label="Y axis scale">
        <button class="pf-scale${linActive}" type="button" data-scale="linear">Linear</button>
        <button class="pf-scale${logActive}" type="button" data-scale="log">Log</button>
      </div>
      <div class="step-charttoolbar-right">
        <span class="step-zoomhint">scroll to zoom · drag to pan</span>
        <button class="pf-cont-reset step-reset" type="button" ${state.pf.contView ? '' : 'disabled'}>Reset View</button>
      </div>
    </div>`;
}

/** The continuum series' distinct display colours (single source shared by the page legends
 * and {@link drawPfContinuum}). Legible on the parchment background: Input = dark ink,
 * Background = accent green (drawn dashed), Net = a distinct blue; the net-SG page adds a
 * muted raw-net and a dark smoothed-net. */
const PF_CONT_COLORS = {
  input: '#2C2C2A',
  background: '#0F6E56',
  net: '#2F6DB3',
  rawNet: '#8A877F',
  smoothedNet: '#04342C',
} as const;

/** One legend swatch (static -- the split pages label a fixed overlay, no toggles). */
function pfContSwatch(color: string, label: string): string {
  return `<span class="pf-cont-series is-on"><span class="pf-cont-swatch" style="background:${color}"></span>${escapeHtml(label)}</span>`;
}

/** Per-page copy for the six Estimate Continuum sub-pages: the legend swatches + the caption
 * beneath the chart. `cont-sg`'s legend is dynamic (see below), so it is filled in there. */
const PF_CONT_PAGE_COPY: Record<string, { legend: string; caption: string }> = {
  'cont-working': {
    legend: pfContSwatch(PF_CONT_COLORS.input, 'Working Copy'),
    caption:
      'The working copy the continuum estimation operates on — the input spectrum you chose ' +
      'on the Savitzky–Golay stage.',
  },
  'cont-lls': {
    legend: pfContSwatch(PF_CONT_COLORS.input, 'LLS working copy'),
    caption:
      'The working copy in the log-log-sqrt (LLS) domain. SNIP peak-clipping operates here — ' +
      'the transform compresses the wide dynamic range so a single clipping window works ' +
      'across the whole spectrum.',
  },
  'cont-snip': {
    legend:
      pfContSwatch(PF_CONT_COLORS.input, 'LLS input') +
      pfContSwatch(PF_CONT_COLORS.background, 'SNIP background (LLS)'),
    caption:
      'SNIP iteratively clips peaks down to the slowly-varying continuum, shown here in the ' +
      'LLS domain over the LLS input.',
  },
  'cont-invlls': {
    legend:
      pfContSwatch(PF_CONT_COLORS.input, 'Input') +
      pfContSwatch(PF_CONT_COLORS.background, 'Background'),
    caption:
      'The clipped continuum transformed back to counts (inverse LLS), overlaid on the input.',
  },
  'cont-net': {
    legend: pfContSwatch(PF_CONT_COLORS.net, 'Net'),
    caption:
      'Net = input − background, clamped at zero — the series peak detection searches for ' +
      'local maxima.',
  },
  'cont-sg': {
    legend: '', // filled dynamically (raw-net vs smoothed-net depends on the toggle)
    caption:
      'Optionally smooth the net before detection. Smoothing steadies local-maxima finding ' +
      'only — centroids, areas, and FWHM are always measured from the raw counts.',
  },
};

/** Gather the manager's already-computed continuum arrays into the pure derivation module's
 * input (#5). Returns null until the continuum has been estimated (background/net present) so
 * the teaching pages render only real data -- never a placeholder. Principle 9: these are all
 * existing manager fields; nothing is recomputed here or in the module. */
function pfContStatsInput(mgr: PeakFinderManager): ContinuumStatsInput | null {
  const input = mgr.selectedInput;
  const background = mgr.backgroundSpectrum;
  const net = mgr.netSpectrum;
  const llsInput = mgr.llsInput;
  const llsBackground = mgr.llsBackground;
  if (!input || !background || !net || !llsInput || !llsBackground) return null;
  return {
    counts: input.counts,
    background,
    net,
    llsInput,
    llsBackground,
    snipIterations: mgr.snipIterations,
  };
}

/** Render one teaching page's derived data (#5): the honest flat-sample note (if any), the
 * optional 5-row sample table (reusing `.pf-table`), the `.cfg-recap` stat grid, and the
 * filled lesson sentence. Pure rendering -- all arithmetic already happened in the module. */
function pfContStatsMarkup(page: ContinuumPageStats): string {
  const note = page.note ? `<p class="pf-cont-flatnote muted">${escapeHtml(page.note)}</p>` : '';
  const sample = page.sample
    ? `<table class="review-table pf-table pf-cont-sample">
        <thead><tr>${page.sample.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${page.sample.rows
          .map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
          .join('')}</tbody>
      </table>`
    : '';
  const grid = `<dl class="cfg-recap pf-cont-stats">${page.stats
    .map((s) => `<div><dt>${escapeHtml(s.label)}</dt><dd>${escapeHtml(s.value)}</dd></div>`)
    .join('')}</dl>`;
  const copy = page.copy ? `<p class="pf-cont-lesson">${escapeHtml(page.copy)}</p>` : '';
  return `<div class="pf-cont-data">${note}${sample}${grid}${copy}</div>`;
}

/** The Working Copy stage's educational card block (rendered as `cont-working`'s `dataBlock`,
 * below the untouched chart). The stage does NO math -- it duplicates the selected input so
 * continuum estimation modifies a copy while the original is preserved for quantitative peak
 * fitting -- so the page TEACHES the pipeline rather than visualising a difference (the copy is
 * byte-identical to the source). A responsive 2×2 grid: ① Source Spectrum (the only dynamic
 * figures -- source label / channels / total counts, from `deriveWorkingCopyStats`), ② Working
 * Copy Status (static reassurance), ③ Why a Working Copy? (the emphasised key lesson), ④ Next
 * Step (LLS Transform preview). Each card carries `data-cue-label` so the shared scroll cue can
 * name + scroll to the first card below the fold. Guarded on `selectedInput` -- renders nothing
 * until an input exists (the page only reaches focus once one does). No later-stage data here. */
function pfWorkingCopyCardsMarkup(mgr: PeakFinderManager): string {
  const input = mgr.selectedInput;
  if (!input) return '';
  const stats = deriveWorkingCopyStats(input.counts, mgr.continuumInput);
  const recapRow = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return `
    <div class="pf-wc-cards">
      <section class="pf-wc-card" data-cue-label="Source Spectrum">
        <h4 class="pf-wc-card-title">Source Spectrum</h4>
        <dl class="cfg-recap">
          ${recapRow('Source Spectrum', stats.sourceLabel)}
          ${recapRow('Number of Channels', stats.channels)}
          ${recapRow('Total Counts', stats.totalCounts)}
        </dl>
      </section>
      <section class="pf-wc-card" data-cue-label="Working Copy Status">
        <h4 class="pf-wc-card-title">Working Copy Status</h4>
        <dl class="cfg-recap">
          ${recapRow('Working Copy', 'Created')}
          ${recapRow('Copy Status', 'Successful')}
          ${recapRow('Processing', 'Ready for Continuum Estimation')}
          ${recapRow('Data Integrity', 'Identical to Source Spectrum')}
        </dl>
      </section>
      <section class="pf-wc-card pf-wc-card--why" data-cue-label="Why a Working Copy">
        <h4 class="pf-wc-card-title">Why a Working Copy?</h4>
        <p class="pf-wc-why">A duplicate of the selected spectrum is created so that continuum
          estimation can modify the working copy without affecting the original measurement. The
          original spectrum is preserved throughout the workflow and will later be used for
          quantitative peak fitting, ensuring that centroid, FWHM, and peak area measurements
          always originate from the unmodified data.</p>
      </section>
      <section class="pf-wc-card pf-wc-card--next" data-cue-label="Next Step">
        <h4 class="pf-wc-card-title">Next Step — LLS Transform</h4>
        <p class="pf-wc-next">Prepares the working copy for continuum estimation by compressing the
          dynamic range before SNIP background estimation.</p>
      </section>
    </div>`;
}

/** Caption (title + unit) for each LLS Transform chart view -- shared by the initial markup
 * and the redraw so the caption always names the series currently on the single chart. */
function pfLlsViewCaption(v: PeakFinderLlsView): { title: string; unit: string } {
  return v === 'raw'
    ? { title: 'Working Spectrum', unit: 'counts' }
    : { title: 'LLS-Transformed Spectrum', unit: 'LLS domain' };
}

/** The LLS Transform stage's primary visual: ONE full-size chart (`#pfLlsChart`, the standard
 * `.step-chartwrap` height so it matches the earlier continuum stages) plus a Working Spectrum /
 * LLS-Transformed toggle that swaps which series occupies the shared space. The two series live
 * on incompatible Y-scales (counts ~10⁰…10⁵ vs LLS ~0.5…3), so rather than co-plot them (a shared
 * axis flattens the LLS curve; a merged legend can't reconcile the units) the toggle shows only
 * the opted-for view, each auto-scaling its own Y-axis. Redraw-only interaction (the `.toggle-group`
 * idiom): switching never re-renders the stage, so nothing here touches `state.pf.contView` or the
 * other pages' `#pfContChart`. Drawn by {@link drawPfLlsCompare}, wired from {@link mountPeakFinder}. */
function pfLlsCompareMarkup(): string {
  const cur = state.pf.llsView;
  const cap = pfLlsViewCaption(cur);
  const btn = (id: PeakFinderLlsView, label: string): string =>
    `<button class="pf-lls-view${id === cur ? ' active' : ''}" type="button"
        data-llsview="${id}" aria-pressed="${id === cur}">${label}</button>`;
  return pfChartBlock({
    toolbar: `<div class="step-charttoolbar pf-lls-compare-head">
      <p class="pf-lls-panel-cap" id="pfLlsCap">${cap.title} <span class="muted">— ${cap.unit}</span></p>
      <div class="toggle-group pf-lls-views" role="group" aria-label="Spectrum view">
        ${btn('raw', 'Working Spectrum')}${btn('lls', 'LLS-Transformed Spectrum')}
      </div>
    </div>`,
    charts: [{ id: 'pfLlsChart' }],
  });
}

/** The LLS Transform stage's educational card grid (rendered as `cont-lls`'s `dataBlock`, below
 * the twin comparison charts). Answers "what transform is applied, why is it necessary, and what
 * changed" WITHOUT dumping the transformed spectrum -- it teaches. A responsive 2-column grid
 * (collapses to 1-up on narrow): ① Transformation Summary (before/after maxima + dynamic ranges
 * + compression ratio), ② Effect of Transformation (what changed vs what did NOT -- length /
 * sign driven honestly from the derivation), ③ Transformation Statistics (a before/after
 * Min/Max/Mean/StdDev table), ④ Why LLS? (the emphasised key lesson), ⑤ Mathematical Details (a
 * collapsed-by-default native `<details>`, full-width), ⑥ Next Step (SNIP preview, full-width).
 * Every figure is a pure read of `counts` + `llsInput` via {@link deriveLlsTransformStats} --
 * NO engine re-run, no later-stage data. Each card carries `data-cue-label` so the shared scroll
 * cue names + scrolls to the first card below the fold. Guarded on `selectedInput && llsInput`. */
function pfLlsCardsMarkup(mgr: PeakFinderManager): string {
  const input = mgr.selectedInput;
  const lls = mgr.llsInput;
  if (!input || !lls) return '';
  const s = deriveLlsTransformStats(input.counts, lls);
  const recapRow = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const statRow = (metric: string, before: string, after: string): string =>
    `<tr><td>${escapeHtml(metric)}</td><td>${escapeHtml(before)}</td><td>${escapeHtml(after)}</td></tr>`;
  return `
    <div class="pf-lls-cards">
      <section class="pf-lls-card" data-cue-label="Transformation Summary">
        <h4 class="pf-lls-card-title">Transformation Summary</h4>
        <dl class="cfg-recap">
          ${recapRow('Maximum Value (Before)', s.maxBefore)}
          ${recapRow('Maximum Value (After)', s.maxAfter)}
          ${recapRow('Dynamic Range (Before)', s.dynamicRangeBefore)}
          ${recapRow('Dynamic Range (After)', s.dynamicRangeAfter)}
          ${recapRow('Compression Ratio', s.compressionRatio)}
          ${recapRow('Transformation Status', s.status)}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Effect of Transformation">
        <h4 class="pf-lls-card-title">Effect of Transformation</h4>
        <dl class="cfg-recap">
          ${recapRow('Dynamic Range', 'Reduced')}
          ${recapRow('Relative Peak Ordering', 'Preserved')}
          ${recapRow('Spectrum Length', s.lengthUnchanged ? 'Unchanged' : 'Changed')}
          ${recapRow('Negative Values Introduced', s.negativesIntroduced ? 'Yes' : 'No')}
          ${recapRow('Channel Positions', 'Preserved')}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Transformation Statistics">
        <h4 class="pf-lls-card-title">Transformation Statistics</h4>
        <table class="review-table pf-table pf-lls-stats">
          <thead><tr><th>Metric</th><th>Before</th><th>After</th></tr></thead>
          <tbody>
            ${statRow('Minimum', s.table.min.before, s.table.min.after)}
            ${statRow('Maximum', s.table.max.before, s.table.max.after)}
            ${statRow('Mean', s.table.mean.before, s.table.mean.after)}
            ${statRow('Standard Deviation', s.table.stddev.before, s.table.stddev.after)}
          </tbody>
        </table>
      </section>
      <section class="pf-lls-card pf-lls-card--why" data-cue-label="Why LLS">
        <h4 class="pf-lls-card-title">Why LLS?</h4>
        <p class="pf-lls-why">Gamma-ray spectra often contain count values that span several
          orders of magnitude. Without compressing this dynamic range, very large peaks dominate
          the background estimation process. The LLS transform compresses the numerical range
          while preserving the overall spectral structure, allowing the SNIP algorithm to
          estimate the continuum more reliably.</p>
      </section>
      <details class="pf-lls-card pf-lls-math" data-cue-label="Mathematical Details">
        <summary class="pf-lls-math-summary">Mathematical Details</summary>
        <div class="pf-lls-math-body">
          <p class="pf-lls-equation">${FX_LLS}</p>
          <p class="pf-lls-math-note">The transform is applied channel-by-channel. The inner
            <strong>√(y + 1)</strong> compresses large counts most aggressively (square-root
            growth); the two nested <strong>log(… + 1)</strong> stages each compress what remains
            further, so a count range spanning several orders of magnitude collapses into a small
            numerical range. The <strong>+ 1</strong> offsets keep every operation defined and
            non-negative at y = 0, so no negative values are introduced. Because the transform is
            monotonic and applied per channel, the relative ordering and the channel positions of
            the peaks are unchanged — only their numerical scale is compressed. SNIP later runs in
            this compressed domain and the result is inverted back to counts.</p>
        </div>
      </details>
      <section class="pf-lls-card pf-lls-card--next" data-cue-label="Next Step">
        <h4 class="pf-lls-card-title">Next Step — SNIP Peak Clipping</h4>
        <p class="pf-lls-next">Estimate the continuum by iteratively clipping peaks from the
          LLS-transformed spectrum until only the smooth continuum remains.</p>
      </section>
    </div>`;
}

/** Caption (title + unit) for each Inverse LLS chart view -- shared by the initial markup and
 * the redraw so the caption always names the background series currently on the single chart. */
function pfInvLlsViewCaption(v: PeakFinderInvLlsView): { title: string; unit: string } {
  return v === 'lls'
    ? { title: 'Background in LLS Space', unit: 'SNIP output' }
    : { title: 'Background in Detector Counts', unit: 'counts' };
}

/** The Inverse LLS Transform stage's primary visual: ONE full-size chart (`#pfInvLlsChart`) plus
 * an LLS Space / Detector Counts toggle -- the direct mirror of {@link pfLlsCompareMarkup}. The two
 * series live on incompatible Y-scales (the LLS-domain background is ~0.5…3, the counts-domain
 * background is ~10⁰…10⁵), so the toggle shows only the opted-for view (each auto-scaling its own
 * Y-axis) rather than co-plotting them. Redraw-only interaction (the `.toggle-group` idiom): it
 * never re-renders the stage, so nothing here touches `state.pf.contView` or the other pages'
 * `#pfContChart`. Drawn by {@link drawPfInvLlsCompare}, wired from {@link mountPeakFinder}. */
function pfInvLlsCompareMarkup(): string {
  const cur = state.pf.invLlsView;
  const cap = pfInvLlsViewCaption(cur);
  const btn = (id: PeakFinderInvLlsView, label: string): string =>
    `<button class="pf-invlls-view${id === cur ? ' active' : ''}" type="button"
        data-invllsview="${id}" aria-pressed="${id === cur}">${label}</button>`;
  return pfChartBlock({
    toolbar: `<div class="step-charttoolbar pf-lls-compare-head">
      <p class="pf-lls-panel-cap" id="pfInvLlsCap">${cap.title} <span class="muted">— ${cap.unit}</span></p>
      <div class="toggle-group pf-lls-views" role="group" aria-label="Background view">
        ${btn('lls', 'LLS Space')}${btn('counts', 'Detector Counts')}
      </div>
    </div>`,
    charts: [{ id: 'pfInvLlsChart' }],
  });
}

/** The Inverse LLS Transform stage's educational card grid (rendered as `cont-invlls`'s `dataBlock`,
 * below the twin comparison charts). Counterpart of {@link pfLlsCardsMarkup}: where the LLS stage
 * compresses counts → LLS, this stage restores LLS → counts, so the two read as a matched pair
 * (same `.pf-lls-*` classes, same layout). Answers "why must the estimated background be converted
 * back into detector counts, and what changed" WITHOUT re-estimating anything. A responsive 2-column
 * grid (collapses to 1-up on narrow): ① Transformation Summary (static reps + before/after maxima),
 * ② Effect of Transformation (what was restored vs preserved -- length driven honestly), ③ Background
 * Statistics (counts-domain min/max/mean/range, meaningful only after the inverse), ④ Why Inverse
 * LLS? (the emphasised key lesson), ⑤ Mathematical Details (a collapsed-by-default native `<details>`,
 * full-width), ⑥ Continuum Estimation Progress (static workflow ticks, full-width), ⑦ Next Step
 * (Net Spectrum preview). Every dynamic figure is a pure read of `background` + `llsBackground` via
 * {@link deriveInverseLlsStats} -- NO engine re-run, no later-stage data. Each card carries
 * `data-cue-label` so the shared scroll cue names + scrolls to the first card below the fold.
 * Guarded on `backgroundSpectrum && llsBackground` -- renders nothing until both exist. */
function pfInvLlsCardsMarkup(mgr: PeakFinderManager): string {
  const background = mgr.backgroundSpectrum;
  const llsBackground = mgr.llsBackground;
  if (!background || !llsBackground) return '';
  const s = deriveInverseLlsStats(background, llsBackground);
  const recapRow = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  const progressStep = (label: string): string =>
    `<li class="pf-invlls-step is-done">${escapeHtml(label)}</li>`;
  return `
    <div class="pf-lls-cards">
      <section class="pf-lls-card" data-cue-label="Transformation Summary">
        <h4 class="pf-lls-card-title">Transformation Summary</h4>
        <dl class="cfg-recap">
          ${recapRow('Input Representation', s.inputRepresentation)}
          ${recapRow('Output Representation', s.outputRepresentation)}
          ${recapRow('Transformation Status', s.status)}
          ${recapRow('Background Ready for Subtraction', s.readyForSubtraction)}
          ${recapRow('Maximum (LLS)', s.maxBefore)}
          ${recapRow('Maximum (Counts)', s.maxAfter)}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Effect of Transformation">
        <h4 class="pf-lls-card-title">Effect of Transformation</h4>
        <dl class="cfg-recap">
          ${recapRow('Numerical Representation', 'Restored')}
          ${recapRow('Detector Count Scale', 'Restored')}
          ${recapRow('Continuum Shape', 'Preserved')}
          ${recapRow('Channel Positions', 'Preserved')}
          ${recapRow('Spectrum Length', s.lengthUnchanged ? 'Unchanged' : 'Changed')}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Background Statistics">
        <h4 class="pf-lls-card-title">Background Statistics</h4>
        <dl class="cfg-recap">
          ${recapRow('Minimum Background Counts', s.minCounts)}
          ${recapRow('Maximum Background Counts', s.maxCounts)}
          ${recapRow('Mean Background Counts', s.meanCounts)}
          ${recapRow('Background Dynamic Range', s.dynamicRange)}
        </dl>
      </section>
      <section class="pf-lls-card pf-lls-card--why" data-cue-label="Why Inverse LLS">
        <h4 class="pf-lls-card-title">Why Inverse LLS?</h4>
        <p class="pf-lls-why">The SNIP algorithm estimates the continuum while operating in the
          compressed LLS domain. Before the estimated background can be subtracted from the spectrum,
          it must be converted back into the original detector count scale. The Inverse LLS Transform
          restores the numerical representation while preserving the estimated continuum, making it
          suitable for subsequent background subtraction.</p>
      </section>
      <details class="pf-lls-card pf-lls-math" data-cue-label="Mathematical Details">
        <summary class="pf-lls-math-summary">Mathematical Details</summary>
        <div class="pf-lls-math-body">
          <p class="pf-lls-equation">${FX_INV_LLS}</p>
          <p class="pf-lls-math-note">This is the exact inverse of the forward transform
            <strong>LLS(y) = log( log( √(y + 1) + 1 ) + 1 )</strong>, applied channel-by-channel. Each
            <strong>log(… + 1)</strong> is undone by an <strong>exp(…) − 1</strong>, and the inner
            <strong>√(y + 1)</strong> is undone by squaring and subtracting the + 1 offset — so the
            operations unwind in reverse order to recover the original detector-count scale. Because
            the mapping is monotonic and per-channel, the continuum's shape and the channel positions
            are unchanged; only the numerical representation is restored. The estimated continuum
            itself is not re-estimated here.</p>
        </div>
      </details>
      <section class="pf-lls-card pf-invlls-progress" data-cue-label="Continuum Progress">
        <h4 class="pf-lls-card-title">Continuum Estimation Progress</h4>
        <ol class="pf-invlls-steps">
          ${progressStep('Working Copy')}
          ${progressStep('LLS Transform')}
          ${progressStep('SNIP Peak Clipping')}
          ${progressStep('Inverse LLS')}
          <li class="pf-invlls-step is-current">Background Ready</li>
        </ol>
      </section>
      <section class="pf-lls-card" data-cue-label="Next Step">
        <h4 class="pf-lls-card-title">Next Step — Compute Net Spectrum</h4>
        <p class="pf-lls-next">Subtract the estimated background from the working spectrum to isolate
          the photopeaks for peak detection.</p>
      </section>
    </div>`;
}

/** The SNIP Peak Clipping stage's primary visual: a single full-range chart in the LLS domain
 * (`#pfSnipChart`), drawn by {@link drawPfSnipClip} and mounted from {@link mountPeakFinder}. Both
 * series (the LLS working spectrum + the final SNIP continuum snapshot) sit on the same
 * ~0.5…3 scale, so ONE shared Y-axis is correct here (unlike the LLS / Inverse LLS twins, whose
 * series live on incompatible scales). Static full-range (v1): no zoom toolbar, so the other five
 * continuum pages' `#pfContChart` zoom binding is left completely untouched. The chart lands on the
 * final checkpoint (the completed continuum); both series are drawn once and never move. */
function pfSnipVizMarkup(): string {
  return pfChartBlock({
    charts: [{ id: 'pfSnipChart' }],
    legend: `<div class="pf-cont-legend" aria-label="Series">
      ${pfContSwatch(PF_CONT_COLORS.input, 'LLS working spectrum')}${pfContSwatch(PF_CONT_COLORS.background, 'SNIP continuum (LLS)')}
    </div>`,
    caption: 'SNIP Peak Clipping — LLS domain',
  });
}

/** The five Clipping-Progress rows (① card) -- shared by the initial markup and the stepper's
 * live update, so the DEFAULT (final) render and every re-selection format identically. */
function pfSnipProgressRowsMarkup(p: SnipProgress): string {
  const row = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return (
    row('Current Iteration', p.currentIteration) +
    row('Total Iterations', p.totalIterations) +
    row('Current Window', p.currentWindow) +
    row('Maximum Window', p.maxWindow) +
    row('Processing Status', p.status)
  );
}

/** The SNIP Peak Clipping stage's educational card grid (rendered as `cont-snip`'s `dataBlock`,
 * below the LLS-domain visualization). Transforms SNIP from a black box into a visible, iterative
 * process WITHOUT dumping the clipped spectrum. A responsive 2-column grid (collapses 1-up on
 * narrow): ① Clipping Progress, ② Effect of Peak Clipping, ③ Continuum
 * Summary (counts domain), ⑥ Algorithm Parameters, ④ Why SNIP? (emphasised), ⑦ Convergence Summary
 * (honest -- SNIP has no early stop), ⑧ Mathematical Details (collapsed `<details>`, full-width),
 * ⑨ Next Step (full-width). Every dynamic figure is a pure read of the committed arrays + the
 * manager's `snipTrace` via {@link deriveSnipClipStats} -- NO engine re-run, no later-stage data.
 * Each card carries `data-cue-label` for the shared scroll cue. Guarded on `snipTrace` + the
 * continuum arrays -- renders nothing until the trace exists. */
function pfSnipCardsMarkup(mgr: PeakFinderManager): string {
  const trace = mgr.snipTrace;
  const input = mgr.selectedInput;
  const background = mgr.backgroundSpectrum;
  const llsInput = mgr.llsInput;
  const llsBackground = mgr.llsBackground;
  if (!trace || !input || !background || !llsInput || !llsBackground) return '';
  const s = deriveSnipClipStats(
    {
      counts: input.counts,
      background,
      llsInput,
      llsBackground,
      iterations: trace.iterations,
      changeSeries: trace.changeSeries,
    },
    trace.iterations, // default selection = the final checkpoint (page lands on the completed continuum)
  );
  const recapRow = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  return `
    <div class="pf-lls-cards pf-snip-cards">
      <section class="pf-lls-card" data-cue-label="Clipping Progress">
        <h4 class="pf-lls-card-title">Clipping Progress</h4>
        <dl class="cfg-recap" id="pfSnipProgress">${pfSnipProgressRowsMarkup(s.progress)}</dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Effect of Peak Clipping">
        <h4 class="pf-lls-card-title">Effect of Peak Clipping</h4>
        <dl class="cfg-recap">
          ${recapRow('Channels Clipped', s.channelsClipped)}
          ${recapRow('% Clipped', s.pctClipped)}
          ${recapRow('Maximum Reduction (LLS)', s.maxReductionLls)}
          ${recapRow('Continuum Stability', s.continuumStability)}
          ${recapRow('Final Iteration', s.finalIteration)}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Continuum Summary">
        <h4 class="pf-lls-card-title">Continuum Summary</h4>
        <dl class="cfg-recap">
          ${recapRow('Minimum Continuum Counts', s.minContinuum)}
          ${recapRow('Maximum Continuum Counts', s.maxContinuum)}
          ${recapRow('Mean Continuum Counts', s.meanContinuum)}
          ${recapRow('Continuum Dynamic Range', s.dynamicRange)}
          ${recapRow('Channels Processed', s.channelsProcessed)}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Algorithm Parameters">
        <h4 class="pf-lls-card-title">Algorithm Parameters</h4>
        <dl class="cfg-recap">
          ${recapRow('Maximum Iterations', s.maxIterationsParam)}
          ${recapRow('Initial Window Size', s.initialWindow)}
          ${recapRow('Final Window Size', s.finalWindow)}
          ${recapRow('LLS Domain', s.llsDomain)}
        </dl>
      </section>
      <section class="pf-lls-card pf-lls-card--why" data-cue-label="Why SNIP">
        <h4 class="pf-lls-card-title">Why SNIP?</h4>
        <p class="pf-lls-why">The SNIP (Statistics-sensitive Non-linear Iterative Peak-clipping)
          algorithm estimates the continuum by repeatedly comparing each channel with the average of
          its neighbours over an expanding window. Whenever a channel sits significantly higher than
          its surroundings, it is clipped downward. Repeating this gradually removes narrow photopeaks
          while preserving the slowly-varying continuum beneath them.</p>
      </section>
      <section class="pf-lls-card" data-cue-label="Convergence Summary">
        <h4 class="pf-lls-card-title">Convergence Summary</h4>
        <dl class="cfg-recap">
          ${recapRow('Final Change Between Iterations', s.finalChange)}
          ${recapRow('Final Iteration Completed', s.finalIterationCompleted)}
          ${recapRow('Schedule', s.schedule)}
          ${recapRow('Continuum Ready', s.continuumReady)}
        </dl>
        <p class="pf-snip-conv-note muted">The per-pass change has decayed to ${escapeHtml(s.finalChange)},
          so further passes would barely move the continuum.</p>
      </section>
      <details class="pf-lls-card pf-lls-math" data-cue-label="Mathematical Details">
        <summary class="pf-lls-math-summary">Mathematical Details</summary>
        <div class="pf-lls-math-body">
          <p class="pf-lls-equation">${FX_SNIP}</p>
          <p class="pf-lls-math-note">Applied channel-by-channel each pass, in the LLS domain.
            <strong>p</strong> is the window half-width; it expands from 1 to
            ${escapeHtml(s.maxIterationsParam)} over successive passes. Neighbouring channels are
            averaged because a smooth continuum is well-approximated by the mean of two symmetric
            neighbours, whereas a sharp photopeak is not — so the average sits below a peak's apex.
            Only larger values are clipped (the <strong>min</strong>) so the continuum is only ever
            pushed down toward the baseline, never raised — troughs and the continuum are left
            untouched. The window expands each pass so that early narrow passes remove sharp lines and
            later wide passes remove broader structure, leaving only the slowly-varying continuum.</p>
        </div>
      </details>
      <section class="pf-lls-card pf-lls-card--next" data-cue-label="Next Step">
        <h4 class="pf-lls-card-title">Next Step — Inverse LLS Transform</h4>
        <p class="pf-lls-next">Convert the estimated continuum from the compressed LLS domain back into
          detector count space, so it can be subtracted from the spectrum.</p>
      </section>
    </div>`;
}

/** The Net Spectrum stage's primary visual: a single counts-domain overlay chart (`#pfNetChart`,
 * NOT the shared `#pfContChart`) of the three series -- Raw/Working, Estimated Background, Net --
 * with an INTERACTIVE toggle legend. Divergence (logged): unlike the sibling continuum pages'
 * static `pfContSwatch` legend, each swatch here is a `<button data-series>` the user clicks to
 * show/hide that series (the `.pf-cont-series` on/off look already carries the dimmed state). All
 * three share ONE counts Y-axis (the series live in the same domain, so no twin panels). The
 * chart is drawn/toggled/animated by {@link mountPfNetStage}; hovering the chart runs a one-shot
 * subtraction animation (user-intent-gated, not autoplay). Static full-range -- no zoom binding,
 * so the other pages' `#pfContChart` window is untouched. */
function pfNetCompareMarkup(): string {
  const C = PF_CONT_COLORS;
  const toggle = (key: PfNetSeries, color: string, label: string): string => `
      <button class="pf-cont-series is-on" type="button" data-series="${key}" aria-pressed="true">
        <span class="pf-cont-swatch" style="background:${color}"></span>${escapeHtml(label)}</button>`;
  return pfChartBlock({
    charts: [{ id: 'pfNetChart' }],
    legend: `<div class="pf-cont-legend" aria-label="Series">
        ${toggle('input', C.input, 'Raw / Working')}
        ${toggle('background', C.background, 'Estimated Background')}
        ${toggle('net', C.net, 'Net Spectrum')}
      </div>`,
    caption: 'Raw − Background = Net. Hover the chart to watch the background subtract away.',
  });
}

/** The Net Spectrum stage's educational card grid (rendered as `cont-net`'s `dataBlock`, below the
 * comparison chart) -- the pay-off page of the continuum pipeline. Counterpart of
 * {@link pfInvLlsCardsMarkup}: it reuses the `.pf-lls-*` card family verbatim so all five continuum
 * teaching stages read as a matched set. Answers "what remains after the estimated background is
 * removed?" WITHOUT dumping later-stage data. A responsive 2-up grid (collapses 1-up under 760px):
 * ① Background Subtraction Summary, ② Subtraction Statistics, ③ Effect of Background Removal, ④ Net
 * Spectrum Statistics, ⑤ Why Net Spectrum? (emphasised), ⑥ Processing Integrity, with ⑦ Mathematical
 * Details (collapsed `<details>`), ⑧ Visual Relationship (the `.pf-ns-flow` step list) and ⑨ Next
 * Step (Detect Peaks preview) full-width. Every dynamic figure is a pure read of the selected input,
 * background and net via {@link deriveNetSpectrumStats} -- NO engine re-run, no later-stage data.
 * Each card carries `data-cue-label` for the shared scroll cue. Guarded on `selectedInput &&
 * backgroundSpectrum && netSpectrum` -- renders nothing until all three exist. */
function pfNetCardsMarkup(mgr: PeakFinderManager): string {
  const input = mgr.selectedInput;
  const background = mgr.backgroundSpectrum;
  const net = mgr.netSpectrum;
  if (!input || !background || !net) return '';
  const s = deriveNetSpectrumStats(input.counts, background, net);
  const recapRow = (label: string, value: string): string =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
  // Visual Relationship (⑧): a vertical step list joined by downward connectors (▼). Reuses the
  // muted → text colour treatment; the connectors are decorative (aria-hidden).
  const flowLabels = [
    'Raw Spectrum',
    'Estimated Background',
    'Channel-by-Channel Subtraction',
    'Net Spectrum',
  ];
  const flow = flowLabels
    .map((label, i) => {
      const conn = i < flowLabels.length - 1 ? `<li class="pf-ns-flow-conn" aria-hidden="true">▼</li>` : '';
      return `<li class="pf-ns-flow-step">${escapeHtml(label)}</li>${conn}`;
    })
    .join('');
  return `
    <div class="pf-lls-cards">
      <section class="pf-lls-card" data-cue-label="Background Subtraction Summary">
        <h4 class="pf-lls-card-title">Background Subtraction Summary</h4>
        <dl class="cfg-recap">
          ${recapRow('Background Estimated', 'Successful')}
          ${recapRow('Background Subtracted', 'Successful')}
          ${recapRow('Net Spectrum', 'Generated')}
          ${recapRow('Processing Status', 'Complete')}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Subtraction Statistics">
        <h4 class="pf-lls-card-title">Subtraction Statistics</h4>
        <dl class="cfg-recap">
          ${recapRow('Total Raw Counts', s.totalRawCounts)}
          ${recapRow('Total Background Counts', s.totalBackgroundCounts)}
          ${recapRow('Total Net Counts', s.totalNetCounts)}
          ${recapRow('Background Fraction', s.backgroundFraction)}
          ${recapRow('Net Fraction', s.netFraction)}
          ${recapRow('Background Removed', s.backgroundRemoved)}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Effect of Background Removal">
        <h4 class="pf-lls-card-title">Effect of Background Removal</h4>
        <dl class="cfg-recap">
          ${recapRow('Background', 'Removed')}
          ${recapRow('Photopeaks', 'Preserved')}
          ${recapRow('Negative Values Clipped', s.clampedCount)}
          ${recapRow('Dynamic Range', 'Changed')}
          ${recapRow('Spectrum Ready for Peak Detection', 'Yes')}
        </dl>
      </section>
      <section class="pf-lls-card" data-cue-label="Net Spectrum Statistics">
        <h4 class="pf-lls-card-title">Net Spectrum Statistics</h4>
        <dl class="cfg-recap">
          ${recapRow('Minimum Counts', s.minNet)}
          ${recapRow('Maximum Counts', s.maxNet)}
          ${recapRow('Mean Counts', s.meanNet)}
          ${recapRow('Total Counts', s.totalNetCounts)}
        </dl>
      </section>
      <section class="pf-lls-card pf-lls-card--why" data-cue-label="Why Net Spectrum">
        <h4 class="pf-lls-card-title">Why Net Spectrum?</h4>
        <p class="pf-lls-why">The measured spectrum contains both photopeaks and continuum
          background. By subtracting the estimated background, the Net Spectrum isolates the
          photopeaks while minimising the influence of scattered radiation and other slowly-varying
          contributions. This greatly improves the reliability of subsequent peak detection and
          peak fitting.</p>
      </section>
      <section class="pf-lls-card" data-cue-label="Processing Integrity">
        <h4 class="pf-lls-card-title">Processing Integrity</h4>
        <dl class="cfg-recap">
          ${recapRow('Background Subtraction', 'Completed')}
          ${recapRow('Negative Values Clipped', s.clampedCount)}
          ${recapRow('Processing', 'Successful')}
          ${recapRow('Ready for Peak Detection', 'Yes')}
        </dl>
      </section>
      <details class="pf-lls-card pf-lls-math" data-cue-label="Mathematical Details">
        <summary class="pf-lls-math-summary">Mathematical Details</summary>
        <div class="pf-lls-math-body">
          <p class="pf-lls-equation">${FX_NET}</p>
          <p class="pf-lls-math-note">Subtraction is performed channel-by-channel. Any channel where
            the <strong>background meets or exceeds the measured counts</strong> is clipped to zero (a
            count rate cannot be negative). The resulting Net Spectrum becomes the input to the Peak
            Detection stage.</p>
        </div>
      </details>
      <section class="pf-lls-card pf-ns-flow-card" data-cue-label="Visual Relationship">
        <h4 class="pf-lls-card-title">Visual Relationship</h4>
        <ol class="pf-ns-flow">${flow}</ol>
      </section>
      <section class="pf-lls-card pf-lls-card--next" data-cue-label="Next Step">
        <h4 class="pf-lls-card-title">Next Step — Detect Candidate Peaks</h4>
        <p class="pf-lls-next">Locate potential photopeaks by identifying local maxima within the
          Net Spectrum.</p>
      </section>
    </div>`;
}

/** Estimate Continuum -- one of six navigable sub-pages (2026-07-05), each visualising a
 * single slice of the SNIP pipeline the engine already computed (no re-run): the working
 * copy, its LLS domain, the SNIP background in that domain, the inverse-LLS background over
 * the input, the net, and the optional Savitzky–Golay on the net (which rehomes the former
 * detection-SG controls). All six share one channel-space chart (`#pfContChart`) + zoom/pan
 * window (`state.pf.contView`). Channel-space only -- no energy wording. */
function peakFinderContinuumMarkup(mgr: PeakFinderManager, id: string): string {
  const inputLabel = mgr.continuumInput === 'smoothed' ? 'Savitzky–Golay Smoothed' : 'Raw';
  const copy = PF_CONT_PAGE_COPY[id] ?? PF_CONT_PAGE_COPY['cont-working'];
  let legend = copy.legend;
  let netSg = '';
  if (id === 'cont-sg') {
    // #3: the net-SG chart always overlays Net vs Smoothed-Net (mirroring the raw stage), so
    // the legend shows both swatches whenever the smoothed-net exists (always, once computed).
    legend =
      mgr.smoothedNetSpectrum != null
        ? pfContSwatch(PF_CONT_COLORS.rawNet, 'Net Spectrum') +
          pfContSwatch(PF_CONT_COLORS.smoothedNet, 'Savitzky–Golay Smoothed Net')
        : pfContSwatch(PF_CONT_COLORS.net, 'Net Spectrum');
    netSg = peakFinderDetectionSgMarkup(mgr);
  }
  // #5 data-led teaching pages: LLS / SNIP / inverse / net gain a derived stat grid (+ sample
  // table). `deriveContinuumPageStats` returns null for `cont-working` / `cont-sg`, so those two
  // keep their existing chart-only layout untouched. The LLS + inverse pages lead with the data
  // and keep a SMALL supporting chart beneath; SNIP + net keep the chart primary, stats below.
  const statsInput = pfContStatsInput(mgr);
  const pageStats = statsInput ? deriveContinuumPageStats(statsInput, id) : null;
  // `cont-working` is a teaching-only stage (no engine data) -- its `dataBlock` is the
  // educational card grid, not the derived-stat grid the other pages use.
  // `cont-lls` + `cont-invlls` are now twin-chart teaching pages (redesign, a matched pair): each
  // `dataBlock` is its own educational card grid and its "chart" is a stacked auto-scaled twin
  // comparison (built in the body below), so neither takes the `pfContStatsMarkup` grid nor the
  // shared `#pfContChart`.
  const isLls = id === 'cont-lls';
  const isInvLls = id === 'cont-invlls';
  // `cont-snip` (redesign): its own single LLS-domain chart (`#pfSnipChart`) with a discrete
  // iteration stepper + educational card grid, so it too skips `pfContStatsMarkup` and the shared
  // `#pfContChart` (routed like the LLS / Inverse LLS twins).
  const isSnip = id === 'cont-snip';
  // `cont-net` (redesign): the pay-off page -- its own single counts-domain comparison chart
  // (`#pfNetChart`) with interactive series toggles + a hover subtraction animation + educational
  // card grid, so it too skips `pfContStatsMarkup` and the shared `#pfContChart` (routed like the
  // LLS / Inverse LLS twins). `deriveNetPage`/`pageStats` still compute for parity but go unrendered.
  const isNet = id === 'cont-net';
  const dataBlock =
    id === 'cont-working'
      ? pfWorkingCopyCardsMarkup(mgr)
      : isLls
        ? pfLlsCardsMarkup(mgr)
        : isInvLls
          ? pfInvLlsCardsMarkup(mgr)
          : isSnip
            ? pfSnipCardsMarkup(mgr)
            : isNet
              ? pfNetCardsMarkup(mgr)
              : pageStats
                ? pfContStatsMarkup(pageStats)
                : '';
  const isNetSg = id === 'cont-sg';
  const legendBlock = `<div class="pf-cont-legend" aria-label="Series">${legend}</div>`;
  // Standardised on the Detected Peaks chart block (toolbar -> chart -> legend -> caption). The
  // net-SG page carries no caption (its intro is the `.sm-objective` above the toolbar); every
  // other continuum page keeps its per-page caption after the chart, like the reference.
  const chartBlock = pfChartBlock({
    toolbar: pfContToolbarMarkup(),
    charts: [{ id: 'pfContChart' }],
    legend: legendBlock,
    ...(isNetSg ? {} : { caption: copy.caption }),
  });
  // `cont-lls` / `cont-invlls`: twin comparison charts full-width on top, then the stage's card
  // grid. Every other page keeps its single-chart-first layout.
  const compare = isLls
    ? pfLlsCompareMarkup()
    : isInvLls
      ? pfInvLlsCompareMarkup()
      : isSnip
        ? pfSnipVizMarkup()
        : isNet
          ? pfNetCompareMarkup()
          : '';
  const body = compare ? `${compare}${dataBlock}` : `${chartBlock}${dataBlock}`;
  // The read-only "Continuum estimated from: <input>" note is dropped on `cont-working` and
  // `cont-net`: the Source Spectrum card / the "Raw / Working" legend already name the input, so
  // the sentence would be redundant there (recommendation, handoff §6.3, consistent with
  // `cont-working`). Other continuum pages (which have no such label) keep it.
  const showInputNote = !isNetSg && id !== 'cont-working' && id !== 'cont-net';
  return `
    <div class="pf-continuum${isNetSg ? ' pf-continuum--sg' : ''}">
      ${
        isNetSg
          ? `<p class="sm-objective">Savitzky–Golay smoothing is applied to the net spectrum. Adjust the parameters,
        then choose which series to run peak detection on. Positions are channel indices.</p>`
          : showInputNote
            ? `<p class="pf-cont-inputnote">Continuum estimated from: <strong>${inputLabel}</strong>
        <span class="muted">— chosen on the Savitzky–Golay stage. Peak areas are always measured from the raw counts.</span></p>`
            : ''
      }
      ${body}
      ${netSg}
    </div>`;
}

/** Net Savitzky–Golay stage (#3) -- mirrors the raw-SG stage (`peakFinderSmoothMarkup`): the
 * smoothed-net is ALWAYS computed and the user makes a MANDATORY Net / Smoothed-Net choice of
 * which series carries into detection + strength. No on/off toggle (D-3a); default Net (D-3b).
 * Same structure as the raw stage -- params always shown, scope disclaimer, and the
 * `.pf-cont-selector` toggle-group. The params ids are unchanged so their handlers survive.
 * A lineage line makes the stacked smoothing visible; a combined over-smoothing advisory shows
 * when both SGs push the effective window heavy. Areas are always raw (R1).
 * // No net-SG gate (2026-07-08): the walkthrough no longer halts here for a Net / Smoothed-Net
 * // pick. The preselected default (`netInput`, Smoothed-Net) is taken automatically; the user
 * // re-tunes it on the Review page's Adjust-smoothing panel. */
function peakFinderDetectionSgMarkup(mgr: PeakFinderManager): string {
  const advisory = mgr.detectionSgAdvisory
    ? `<p class="pf-sg-advisory">${escapeHtml(mgr.detectionSgAdvisory)}</p>`
    : '';
  // Same teaching layout as the raw SG stage (scope note → divider → grid of params + two
  // effect cards); only the CONTEXT differs -- the effect is measured on Net vs Smoothed-Net
  // (not Raw vs Smoothed) and the params drive the SECOND, detection-only SG.
  const eff = deriveSmoothingEffect({
    raw: mgr.netSpectrum ?? [],
    smoothed: mgr.smoothedNetSpectrum ?? [],
    sgWindow: mgr.detectionSgWindow,
  });
  // No wrapper element: these are emitted as direct children of `.pf-continuum` (right after
  // the legend) so the layout + gaps match the raw SG stage exactly.
  return `
      <div class="pf-sg-disclaimer" role="note">
        Smoothing the net steadies local-maxima finding and the strength heuristics only. The
        smoothed net is used by default. Peak <strong>centroids, areas, and FWHM are always measured
        from the raw spectrum</strong> — your quantitative results are unaffected. Prefer the
        unsmoothed net? You can switch back from the <strong>Review</strong> step.
      </div>
      <div class="pf-sg-divider" role="separator">
        <span>Configure the net Savitzky–Golay parameters and see their effect below</span>
      </div>
      <div class="pf-sg-grid">
        <div class="pf-sg-card pf-sg-card--params">
          <h4 class="pf-sg-card-title">Detection Savitzky–Golay parameters</h4>
          <p class="pf-sg-hint muted">A second, independent Savitzky–Golay applied to the net signal only, to
            steady local-maxima finding. It never affects measured areas — those always come from the raw counts.</p>
          <div class="pf-sg-params">
            <div class="pf-sg-fields">
              <label class="pf-sg-field">
                <span>Window length</span>
                <input id="pfDetSgWindow" class="pf-sg-input" type="number" min="5" max="15" step="2"
                  value="${mgr.detectionSgWindow}" />
              </label>
              <label class="pf-sg-field">
                <span>Polynomial order</span>
                <input id="pfDetSgPoly" class="pf-sg-input" type="number" min="2" max="4" step="1"
                  value="${mgr.detectionSgPolyorder}" />
              </label>
            </div>
            <div class="pf-sg-actions">
              <button id="pfDetSgApply" class="btn pf-sg-apply" type="button">Apply</button>
              <button id="pfDetSgReset" class="btn btn-primary pf-sg-reset" type="button">Reset to Defaults</button>
            </div>
          </div>
          ${advisory}
        </div>
        ${pfSmoothCardMarkup(eff.effect)}${pfSmoothCardMarkup(eff.comparison)}
      </div>`;
}

/** One Run stage (P1 slice): the stage chart in its own section, over the
 * truthful stage caption from INSPECTOR_STAGES (single source of truth). NO peak
 * table yet (tables are P2) and no space reserved for one. While running,
 * `.stepper-running` marks the reveal as engine-owned (rail steps ahead are
 * locked by the step model; the toolbar is disabled). */
function peakFinderStageMarkup(mgr: PeakFinderManager): string {
  const stage = currentPfStage(mgr);
  // The first Detect stage ("Find Local Maxima" / `local-maxima` / run-0) is the educational
  // redesign: the same chart + caption + candidate table, wrapped with the teaching card grid.
  // Every other Run stage keeps the plain chart-toolbar + chart + caption + table below.
  if (PF_RUN_STAGES[clampPfStage(stage)].id === 'local-maxima')
    return peakFinderLocalMaximaMarkup(mgr, stage);
  // The second Run stage ("Distance Gate" / `distance` / run-1) is the first FILTERING-stage
  // redesign: the same chart + caption + candidate table, wrapped with the teaching card grid +
  // the winner-reconstruction comparison, derived PURELY from the trace via deriveDistanceGateStats.
  if (PF_RUN_STAGES[clampPfStage(stage)].id === 'distance')
    return peakFinderDistanceGateMarkup(mgr, stage);
  // The seventh Run stage ("Peak Fitting" / `fit` / run-6) is the culmination redesign: the same
  // chart + caption + table, wrapped with the measurement card grid derived from the selected fit.
  if (PF_RUN_STAGES[clampPfStage(stage)].id === 'fit') return peakFinderFitMarkup(mgr, stage);
  // The eighth Run stage ("Validate Peaks" / `validated` / run-7) is the quality-control redesign:
  // the same chart + caption + table, wrapped with the validation card grid derived from
  // `trace.validated` (the engine's already-computed verdicts -- display only, no re-validation).
  if (PF_RUN_STAGES[clampPfStage(stage)].id === 'validated')
    return peakFinderValidatedMarkup(mgr, stage);
  // Content only: all workflow/navigation controls live in the rail action footer
  // (Rev 3, §A). The reveal state is shown by the rail's active step + the bottom
  // toolbar, so no in-body "Finding peaks…" status or action row remains here.
  return `
    <div class="pf-stage">
      ${pfChartBlock({
        toolbar: pfChartToolbarMarkup(),
        charts: [{ id: 'pfStageChart' }],
        caption: pfCaption(stage),
      })}
      ${pfTableSection(mgr, stage)}
    </div>`;
}

/** One legend swatch for the "Find Local Maxima" chart: a line stroke (the detection spectrum)
 * or a tick glyph (the pre-gate local-maxima markers), mirroring the chart's own visual
 * language (the smoothed ghost line + the neutral candidate rug in {@link drawPfStage}). */
function pfLmSwatch(kind: 'line' | 'tick', label: string): string {
  return `<span class="pf-lm-swatch"><span class="pf-lm-swatch-mark pf-lm-swatch-mark--${kind}" aria-hidden="true"></span>${escapeHtml(
    label,
  )}</span>`;
}

/**
 * The redesigned "Find Local Maxima" (`local-maxima` / run-0) educational stage. Presentation
 * only (Principle 9): the chart, caption, and candidate table are the SAME surfaces every Run
 * stage uses -- this only adds a teaching card grid derived PURELY from the already-computed
 * trace via {@link deriveLocalMaximaStats}. No engine re-run, no fixture touch. Layout:
 *   [ chart toolbar + #pfStageChart + legend + caption ]
 *   [ Candidate Summary | Detection Statistics ]
 *   [ Candidate Distribution | Detection Quality ]
 *   [ Candidate Table (full width) ]
 *   [ Why Local Maxima? | Why So Many Candidates? ]
 *   [ Mathematical Details (collapsed) ]
 *   [ Next Step: Distance Gate (full width) ]
 * Before a run exists (no trace) it falls back to the plain chart + table, exactly like the
 * other Run stages. */
function peakFinderLocalMaximaMarkup(mgr: PeakFinderManager, stage: number): string {
  const chartBlock = pfChartBlock({
    toolbar: pfChartToolbarMarkup(),
    charts: [{ id: 'pfStageChart' }],
    legend: `<div class="pf-lm-legend" aria-label="Chart series">
      ${pfLmSwatch('line', 'Detection Spectrum')}${pfLmSwatch('tick', 'Local Maxima Markers')}
    </div>`,
  });
  // The stage caption is a STANDALONE connective sentence between the chart and the candidate table
  // (not a chart footnote) -- equal space above/below, justified -- mirroring the Final Review hero
  // caption treatment. The sort toolbar is grouped tight to the table via the `.pf-tableblock` idiom.
  const stageCaption = `<p class="pf-stage-caption">${pfCaption(stage)}</p>`;
  const tableBlock = `<div class="pf-tableblock">${pfTableSection(mgr, stage)}</div>`;
  const trace = mgr.pipelineTrace;
  // Teaching cards only in the settled (`held`) state. During the animated reveal the stage
  // shows just the chart + caption + inert table (reveal-lock) exactly like every other Run
  // stage, so no cards linger when the walkthrough advances to the next stage; the cards land
  // when the reveal settles and a full render runs.
  if (!trace || mgr.phase.kind !== 'held')
    return `<div class="pf-lm pf-lm--report">${chartBlock}${stageCaption}${tableBlock}</div>`;

  const detectionLabel =
    mgr.netInput === 'smoothed-net' ? 'Savitzky–Golay Smoothed Net' : 'Net Spectrum';
  const stats = deriveLocalMaximaStats({
    channels: trace.raw.length,
    candidates: trace.detected.all.map((d) => ({ channel: d.channel, height: d.height })),
    detectionSpectrumLabel: detectionLabel,
  });

  const recap = (pairs: LocalMaximaStats['summary']): string =>
    `<dl class="cfg-recap">${pairs
      .map((p) => `<div><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
      .join('')}</dl>`;

  // A labeled section divider (a rule with a centred caption naming what follows) that chapters the
  // stacked teaching report -- the same `.pf-review-divider` used on the Final Review page.
  const divider = (label: string): string =>
    `<div class="pf-review-divider" role="separator" aria-label="${escapeHtml(label)}"><span class="pf-review-divider-label">${escapeHtml(label)}</span></div>`;

  const summaryCard = `
    <section class="pf-lm-card" data-cue-label="Candidate Summary">
      <h4 class="pf-lm-card-title">Candidate Summary</h4>
      ${recap(stats.summary)}
    </section>`;
  const statsCard = `
    <section class="pf-lm-card" data-cue-label="Detection Statistics">
      <h4 class="pf-lm-card-title">Detection Statistics</h4>
      ${recap(stats.statistics)}
    </section>`;
  const distributionCard = pfLmDistributionCardMarkup();
  const qualityCard = `
    <section class="pf-lm-card" data-cue-label="Detection Quality">
      <h4 class="pf-lm-card-title">Detection Quality</h4>
      ${recap(stats.quality)}
    </section>`;

  // "How This Works" chapter: the two teaching cards + the collapsed math details. Uniform boxes --
  // the `--why`/`--next` accent modifiers are dropped so every card is the same neutral sunk card.
  const whyCards = `
    <div class="pf-lm-grid">
      <section class="pf-lm-card" data-cue-label="Why Local Maxima">
        <h4 class="pf-lm-card-title">Why Local Maxima?</h4>
        <p class="pf-lm-prose">A local maximum is any channel whose count is higher than the
          channel on either side of it — a small peak in the detection spectrum. Every real gamma
          photopeak sits on top of a local maximum, so finding all of them is how Nuclid guarantees
          it hasn't missed a genuine peak. This stage makes <strong>no judgement</strong> about
          which candidates are real: it simply lists every potential peak so the later gates have a
          complete set to work from.</p>
      </section>
      <section class="pf-lm-card" data-cue-label="Why So Many Candidates">
        <h4 class="pf-lm-card-title">Why So Many Candidates?</h4>
        <p class="pf-lm-prose">This stage deliberately favours <strong>completeness over
          accuracy</strong> — it over-detects on purpose so that no genuine peak is ever missed.
          The list therefore mixes true photopeaks with statistical fluctuations in the background,
          and that is expected. The next three stages — <strong>Distance</strong>,
          <strong>Prominence</strong>, and <strong>Width</strong> — do the removing, progressively
          filtering these candidates down to the real peaks.</p>
      </section>
    </div>`;

  const mathDetails = `
    <details class="pf-lm-card pf-lm-math" data-cue-label="Mathematical Details">
      <summary class="pf-lm-math-summary">Mathematical Details</summary>
      <div class="pf-lm-math-body">
        <p class="pf-lm-equation">${FX_LOCAL_MAXIMA}</p>
        <p class="pf-lm-prose">A channel <em>i</em> is reported as a local maximum when its
          detection-spectrum value is strictly greater than both of its immediate neighbours.
          ${escapeHtml(PF_LM_PLATEAU_NOTE)}</p>
      </div>
    </details>`;

  const nextStep = `
    <section class="pf-lm-card" data-cue-label="Next Step">
      <h4 class="pf-lm-card-title">Next Step — Distance Gate</h4>
      <p class="pf-lm-prose">Removes duplicate candidates that sit too close together — when two
        maxima are within the minimum separation, the taller one wins and the other is dropped.</p>
    </section>`;

  // Top-to-bottom report, chaptered like the Final Review page: the chart + caption + candidate
  // table form the first chapter (the primary output); the derived statistics, the explanation, and
  // the next-step pointer follow as their own labeled chapters.
  return `
    <div class="pf-lm pf-lm--report">
      ${divider('Candidate Peaks')}
      ${chartBlock}
      ${stageCaption}
      ${tableBlock}
      ${divider('Detection Summary')}
      <div class="pf-lm-grid">${summaryCard}${statsCard}</div>
      <div class="pf-lm-grid">${distributionCard}${qualityCard}</div>
      ${divider('How This Works')}
      ${whyCards}
      ${mathDetails}
      ${divider('Next Step')}
      ${nextStep}
    </div>`;
}

/** One legend swatch for the Distance Gate chart: the detection line, an accepted (alive) tick, or
 * a rejected (struck) tick -- reusing the local-maxima swatch base with the chart's own ALIVE /
 * STRUCK tick colours so the accepted/rejected language matches {@link drawPfStage} exactly. */
function pfDistSwatch(kind: 'line' | 'alive' | 'struck', label: string): string {
  const mark =
    kind === 'line'
      ? 'pf-lm-swatch-mark--line'
      : `pf-lm-swatch-mark--tick pf-dist-swatch-mark--${kind}`;
  return `<span class="pf-lm-swatch"><span class="pf-lm-swatch-mark ${mark}" aria-hidden="true"></span>${escapeHtml(
    label,
  )}</span>`;
}

/** A `.cfg-recap` label/value grid (the shared card-body shape across the PF teaching stages). */
function pfDistRecap(pairs: readonly { label: string; value: string }[]): string {
  return `<dl class="cfg-recap">${pairs
    .map((p) => `<div><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
    .join('')}</dl>`;
}

/** The §3 Before-vs-After count bars: an "Entering" reference bar (full width) + a proportional
 * "Passing" bar, with the removed remainder called out. The fill grows from 0 via the
 * `pf-dist-grow` keyframe on each mount (i.e. on the settled `held` re-render), so it animates
 * with the stage reveal without JS (static under reduced motion). */
function pfDistBarsMarkup(ba: DistanceGateStats['beforeAfter']): string {
  const pct = ba.entering > 0 ? (ba.leaving / ba.entering) * 100 : 0;
  const fmt = (v: number): string => v.toLocaleString('en-US');
  return `
    <div class="pf-dist-bars">
      <div class="pf-dist-bar-row">
        <span class="pf-dist-bar-label">Entering</span>
        <span class="pf-dist-bar-track"><span class="pf-dist-bar-fill pf-dist-bar-fill--enter" style="width:100%"></span></span>
        <span class="pf-dist-bar-val">${fmt(ba.entering)}</span>
      </div>
      <div class="pf-dist-bar-row">
        <span class="pf-dist-bar-label">Passing</span>
        <span class="pf-dist-bar-track"><span class="pf-dist-bar-fill pf-dist-bar-fill--pass" style="width:${pct.toFixed(
          2,
        )}%"></span></span>
        <span class="pf-dist-bar-val">${fmt(ba.leaving)}</span>
      </div>
      <p class="pf-dist-bar-removed muted">${fmt(
        ba.removed,
      )} removed — too close to a stronger neighbour.</p>
    </div>`;
}

const PF_DIST_SELECT_HINT = 'Select a rejected (red) candidate to see why it was removed.';
const PF_DIST_NONE_HINT = 'No candidates were removed by the distance gate.';

/** The §7 Candidate Comparison card BODY (inner content only; the outer section + title live in
 * the markup so this can be re-rendered IN PLACE on selection via {@link updatePfDistanceComparison}). */
function pfDistComparisonInner(cmp: RejectionComparison | null, selectedIsRejected: boolean): string {
  if (!cmp) return `<p class="pf-lm-prose muted">${PF_DIST_NONE_HINT}</p>`;
  const compare = `
    <div class="pf-dist-compare">
      <div class="pf-dist-compare-cell pf-dist-compare-cell--rejected">
        <span class="pf-dist-compare-role">Rejected</span>
        <span class="pf-dist-compare-ch">ch ${cmp.rejectedChannel}</span>
        <span class="pf-dist-compare-h">height ${escapeHtml(fmtDistanceHeight(cmp.rejectedHeight))}</span>
      </div>
      <span class="pf-dist-compare-vs" aria-hidden="true">vs</span>
      <div class="pf-dist-compare-cell pf-dist-compare-cell--winner">
        <span class="pf-dist-compare-role">Winner</span>
        <span class="pf-dist-compare-ch">ch ${cmp.winnerChannel}</span>
        <span class="pf-dist-compare-h">height ${escapeHtml(fmtDistanceHeight(cmp.winnerHeight))}</span>
      </div>
    </div>`;
  const recap = pfDistRecap([
    { label: 'Distance to Winner', value: `${cmp.separation} channels` },
    { label: 'Minimum Allowed', value: `${cmp.minAllowed} channels` },
    { label: 'Decision', value: 'Rejected — Too Close' },
  ]);
  const hint = selectedIsRejected
    ? ''
    : `<p class="pf-dist-hint muted">${PF_DIST_SELECT_HINT}</p>`;
  return `${compare}${recap}${hint}`;
}

/** The §8 Why Rejected? card BODY (inner content only; re-rendered in place on selection). */
function pfDistWhyInner(cmp: RejectionComparison | null): string {
  if (!cmp) return `<p class="pf-lm-prose muted">${PF_DIST_NONE_HINT}</p>`;
  const chs = cmp.separation === 1 ? 'channel' : 'channels';
  return `<p class="pf-lm-prose">Rejected because its distance to a stronger neighbouring candidate
    is <strong>${cmp.separation} ${chs}</strong>, below the minimum required
    <strong>${cmp.minAllowed} channels</strong>. The winning candidate at
    <strong>channel ${cmp.winnerChannel}</strong> (height ${escapeHtml(
      fmtDistanceHeight(cmp.winnerHeight),
    )}) is taller, so it is kept and this one is dropped.</p>`;
}

/** Re-derive + re-render the §7/§8 cards IN PLACE when the shared channel selection changes on
 * the Distance Gate stage (mirrors {@link drawPfFitResidual}'s targeted-update precedent, so the
 * selection stays a chart+cards update, never a full render that would reset scroll/reveal).
 * No-op off the distance stage / before a run (cards absent). */
function updatePfDistanceComparison(): void {
  const compareBody = rootEl.querySelector<HTMLElement>('#pfDistCompareCard .pf-dist-compare-body');
  const whyBody = rootEl.querySelector<HTMLElement>('#pfDistWhyCard .pf-dist-why-body');
  if (!compareBody && !whyBody) return;
  const mgr = state.pf.manager;
  const trace = mgr?.pipelineTrace;
  if (!trace) return;
  const detectionLabel =
    mgr?.netInput === 'smoothed-net' ? 'Savitzky–Golay Smoothed Net' : 'Net Spectrum';
  const stats = deriveDistanceGateStats({
    channels: trace.raw.length,
    candidates: trace.detected.all.map((d) => ({
      channel: d.channel,
      height: d.height,
      passed: d.passed,
      rejectedByDistance: !d.passed && d.rejectReason === 'distance',
    })),
    minDistance: trace.constants.distance,
    detectionSpectrumLabel: detectionLabel,
  });
  const sel = state.pf.chart.selectedCandidate;
  const cmp = resolveRejectionComparison(stats, sel);
  const selectedIsRejected = cmp != null && sel === cmp.rejectedChannel;
  if (compareBody) compareBody.innerHTML = pfDistComparisonInner(cmp, selectedIsRejected);
  if (whyBody) whyBody.innerHTML = pfDistWhyInner(cmp);
}

/**
 * The redesigned "Distance Gate" (`distance` / run-1) educational stage -- the FIRST filtering
 * stage. Presentation only (Principle 9): the chart, caption, and candidate table are the SAME
 * surfaces every Run stage uses; this adds a teaching card grid + the winner-reconstruction
 * comparison, derived PURELY from the already-computed trace via {@link deriveDistanceGateStats}.
 * No engine re-run, no fixture touch. Chaptered like the Final Review / Find Local Maxima report
 * (see {@link peakFinderLocalMaximaMarkup}) with `.pf-review-divider` chapters:
 *   [ Gate Results ]        chart + standalone caption + candidate table (`.pf-tableblock`)
 *   [ Filter Summary ]      Distance Gate Summary | Filter Impact ; Before vs After | Detection Statistics
 *   [ Inspect a Rejection ] Candidate Comparison (§7) | Why Rejected? (§8) -- selection-driven
 *   [ How This Works ]      Why Distance Filtering? | Processing Integrity ; Mathematical Details
 *   [ Next Step ]           Prominence Gate
 * Before a run exists (no trace) or during the reveal it falls back to the plain chart + inert
 * table, exactly like the other Run stages. */
function peakFinderDistanceGateMarkup(mgr: PeakFinderManager, stage: number): string {
  const chartBlock = pfChartBlock({
    toolbar: pfChartToolbarMarkup(),
    charts: [{ id: 'pfStageChart' }],
    legend: `<div class="pf-lm-legend" aria-label="Chart series">
      ${pfDistSwatch('line', 'Detection Spectrum')}${pfDistSwatch(
        'alive',
        'Accepted',
      )}${pfDistSwatch('struck', 'Rejected')}
    </div>`,
  });
  // Standalone justified caption between the chart and the table (mirrors the Review hero caption);
  // the sort/filter toolbar is grouped tight to the table via the `.pf-tableblock` idiom.
  const stageCaption = `<p class="pf-stage-caption">${pfCaption(stage)}</p>`;
  const tableBlock = `<div class="pf-tableblock">${pfTableSection(mgr, stage)}</div>`;
  const trace = mgr.pipelineTrace;
  // Teaching cards only in the settled (`held`) state -- during the reveal the stage shows just
  // the chart + caption + inert table (reveal-lock), exactly like the other Run stages.
  if (!trace || mgr.phase.kind !== 'held')
    return `<div class="pf-lm pf-lm--report">${chartBlock}${stageCaption}${tableBlock}</div>`;

  const detectionLabel =
    mgr.netInput === 'smoothed-net' ? 'Savitzky–Golay Smoothed Net' : 'Net Spectrum';
  const stats = deriveDistanceGateStats({
    channels: trace.raw.length,
    candidates: trace.detected.all.map((d) => ({
      channel: d.channel,
      height: d.height,
      passed: d.passed,
      rejectedByDistance: !d.passed && d.rejectReason === 'distance',
    })),
    minDistance: trace.constants.distance,
    detectionSpectrumLabel: detectionLabel,
  });

  const sel = state.pf.chart.selectedCandidate;
  const cmp = resolveRejectionComparison(stats, sel);
  const selectedIsRejected = cmp != null && sel === cmp.rejectedChannel;

  const card = (
    title: string,
    pairs: readonly { label: string; value: string }[],
    cue = title,
  ): string => `
    <section class="pf-lm-card" data-cue-label="${escapeHtml(cue)}">
      <h4 class="pf-lm-card-title">${escapeHtml(title)}</h4>
      ${pfDistRecap(pairs)}
    </section>`;

  const summaryCard = card('Distance Gate Summary', stats.summary);
  const impactCard = card('Filter Impact', stats.impact);
  const beforeAfterCard = `
    <section class="pf-lm-card" data-cue-label="Before vs After">
      <h4 class="pf-lm-card-title">Before vs After</h4>
      ${pfDistBarsMarkup(stats.beforeAfter)}
    </section>`;
  const statisticsCard = card('Detection Statistics', stats.statistics);

  const comparisonCard = `
    <section class="pf-lm-card pf-dist-compare-card" data-cue-label="Candidate Comparison" id="pfDistCompareCard">
      <h4 class="pf-lm-card-title">Candidate Comparison</h4>
      <div class="pf-dist-compare-body">${pfDistComparisonInner(cmp, selectedIsRejected)}</div>
    </section>`;
  const whyRejectedCard = `
    <section class="pf-lm-card pf-dist-why-card" data-cue-label="Why Rejected" id="pfDistWhyCard">
      <h4 class="pf-lm-card-title">Why Rejected?</h4>
      <div class="pf-dist-why-body">${pfDistWhyInner(cmp)}</div>
    </section>`;

  const whyDistanceCard = `
    <section class="pf-lm-card" data-cue-label="Why Distance Filtering">
      <h4 class="pf-lm-card-title">Why Distance Filtering?</h4>
      <p class="pf-lm-prose">A single gamma photopeak often produces <strong>several</strong> local
        maxima packed within a few channels of each other — statistical ripples on one true peak.
        Keeping all of them would report one peak many times over. The distance gate enforces a
        <strong>minimum separation</strong>: when two candidates sit closer than that, only the
        <strong>taller</strong> one is kept and the rest are dropped, so each real peak is counted
        once.</p>
    </section>`;
  const integrityCard = card('Processing Integrity', stats.integrity);

  const mathDetails = `
    <details class="pf-lm-card pf-lm-math" data-cue-label="Mathematical Details">
      <summary class="pf-lm-math-summary">Mathematical Details</summary>
      <div class="pf-lm-math-body">
        <p class="pf-lm-equation">${FX_DISTANCE_GATE}</p>
        <p class="pf-lm-prose">Candidates are visited <em>tallest first</em>. Each kept candidate
          removes every remaining candidate within <strong>⌈distance⌉ = ${stats.beforeAfter.entering >= 0 ? '' : ''}${escapeHtml(
            String(Math.max(1, Math.ceil(trace.constants.distance))),
          )}</strong> channels of it; only kept candidates remove others. This is scipy's
          <code>select_by_peak_distance</code> rule, so each rejected candidate's “winner” is the
          tallest surviving candidate inside its window.</p>
      </div>
    </details>`;

  const nextCard = `
    <section class="pf-lm-card" data-cue-label="Next Step">
      <h4 class="pf-lm-card-title">Next Step — Prominence Gate</h4>
      <p class="pf-lm-prose">Removes candidates that do not stand out enough from the surrounding
        baseline — a peak must rise a minimum <strong>prominence</strong> above its local
        neighbourhood to survive.</p>
    </section>`;

  // A labeled section divider (rule + centred caption) chaptering the report -- the same
  // `.pf-review-divider` used on the Final Review and Find Local Maxima pages.
  const divider = (label: string): string =>
    `<div class="pf-review-divider" role="separator" aria-label="${escapeHtml(label)}"><span class="pf-review-divider-label">${escapeHtml(label)}</span></div>`;

  // Top-to-bottom report: the chart + caption + result table form the first chapter (the primary
  // output); the derived summary, the selection-driven rejection inspector, the explanation, and
  // the next-step pointer follow as their own labeled chapters.
  return `
    <div class="pf-lm pf-lm--report">
      ${divider('Gate Results')}
      ${chartBlock}
      ${stageCaption}
      ${tableBlock}
      ${divider('Filter Summary')}
      <div class="pf-lm-grid">${summaryCard}${impactCard}</div>
      <div class="pf-lm-grid">${beforeAfterCard}${statisticsCard}</div>
      ${divider('Inspect a Rejection')}
      <div class="pf-lm-grid">${comparisonCard}${whyRejectedCard}</div>
      ${divider('How This Works')}
      <div class="pf-lm-grid">${whyDistanceCard}${integrityCard}</div>
      ${mathDetails}
      ${divider('Next Step')}
      ${nextCard}
    </div>`;
}

/** The stage-specific candidate table for "Distance Gate" (run-1, D-2): four columns --
 * Channel · Peak Height (`DetectedPeak.height`) · Distance to Winner (the reconstructed
 * separation for a distance-rejected row, "—" for an accepted row that had no winner) · Result
 * (Accepted / Rejected — Too Close). Rows cover every entering candidate (`trace.detected.all`);
 * the shared All / Advancing / Rejected filter maps to All / Accepted / Rejected. CRITICAL: each
 * row keeps `class="pf-row"` + integer `data-channel` so `wirePfTableHandlers` / `selectPfChannel`
 * / `syncPfRowHighlight` bind unchanged and the row<->marker selection keeps working. The
 * Distance-to-Winner column reuses the SAME pure {@link deriveDistanceGateStats} reconstruction as
 * the §7/§8 cards -- no engine re-run (Principle 9). */
function peakFinderDistanceGateTableMarkup(
  trace: PipelineTrace,
  selectedChannel: number | null,
  sort: PeakFinderTableSort,
  filter: PeakFinderTableFilter,
  interactive: boolean,
): string {
  const columns = ['Channel', 'Peak Height', 'Distance to Winner', 'Result'];
  const DASH = '—';
  const fmtInt = (v: number): string => Math.round(v).toLocaleString('en-US');
  const stats = deriveDistanceGateStats({
    channels: trace.raw.length,
    candidates: trace.detected.all.map((d) => ({
      channel: d.channel,
      height: d.height,
      passed: d.passed,
      rejectedByDistance: !d.passed && d.rejectReason === 'distance',
    })),
    minDistance: trace.constants.distance,
    detectionSpectrumLabel: 'Net Spectrum',
  });
  const sepByChannel = new Map<number, number>();
  stats.comparisons.forEach((c) => sepByChannel.set(c.rejectedChannel, c.separation));

  interface DistRow {
    channel: number;
    height: string;
    sep: string;
    statusText: string;
    kind: 'pass' | 'drop';
  }
  const rowsAll: DistRow[] = trace.detected.all.map((d) => {
    const rejected = !d.passed && d.rejectReason === 'distance';
    const sep = rejected ? sepByChannel.get(d.channel) : undefined;
    return {
      channel: d.channel,
      height: fmtInt(d.height),
      sep: sep == null ? DASH : `${sep} ch`,
      statusText: rejected ? 'Rejected — Too Close' : 'Accepted',
      kind: rejected ? 'drop' : 'pass',
    };
  });
  const byChannel = [...rowsAll].sort((a, b) => a.channel - b.channel);
  const shown = byChannel.filter((r) =>
    filter === 'all' ? true : filter === 'advancing' ? r.kind === 'pass' : r.kind === 'drop',
  );
  const rows = sort.dir === 'desc' ? [...shown].reverse() : shown;
  const entering = byChannel.length;
  const passing = byChannel.reduce((n, r) => n + (r.kind === 'pass' ? 1 : 0), 0);
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const strip = `${entering.toLocaleString('en-US')} ${
    entering === 1 ? 'candidate' : 'candidates'
  } → ${passing.toLocaleString('en-US')} pass the distance gate.`;
  const body =
    rows.length === 0
      ? `<tr class="pf-row-empty"><td colspan="${columns.length}" class="muted">No candidates match this filter.</td></tr>`
      : rows
          .map((r) => {
            const selected = selectedChannel != null && r.channel === selectedChannel;
            const lock = interactive ? '' : ' is-locked';
            const attrs = interactive ? ` data-channel="${r.channel}" tabindex="0"` : '';
            return `<tr class="pf-row pf-dist-row pf-row--${r.kind}${
              selected ? ' is-selected' : ''
            }${lock}"${attrs}>
              <td>${r.channel}</td>
              <td>${r.height}</td>
              <td>${r.sep}</td>
              <td class="pf-result">${escapeHtml(r.statusText)}</td>
            </tr>`;
          })
          .join('');
  return `
    <div class="pf-table-section card">
      <h3 class="pf-table-title">Candidate table</h3>
      <p class="pf-count-strip muted">${escapeHtml(strip)}</p>
      <table class="review-table pf-table">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** Is the currently-selected validated peak flagged? Drives the verdict-aware swatch colour on the
 * `validated` / Review overlay legend (the Gaussian/Combined lines go warning-amber when flagged,
 * mirroring {@link drawPfStage}). False when there is no trace/selection or the peak is accepted. */
function pfSelectedValidatedFlagged(mgr: PeakFinderManager): boolean {
  const trace = mgr.pipelineTrace;
  if (!trace) return false;
  const v = resolveSelectedValidated(trace, state.pf.chart.selectedCandidate);
  return v != null && !v.valid;
}

/** The Peak Fitting / Validate Peaks chart's decomposition-overlay toggles (P3): five independent
 * multi-select buttons (Raw · Continuum · Gaussian · Combined · Residuals) using the `.toggle-group`
 * idiom. Each carries a COLOUR SWATCH matching the line {@link drawPfStage} strokes, so the group
 * doubles as the chart's legend (colour <-> series) -- the standard every multi-plot PF chart
 * follows. State lives in `state.pf.fitOverlays`; toggling redraws the chart only (wired in
 * {@link mountPeakFinder}), never re-renders. `aria-pressed` reflects each series' visibility.
 *
 * `verdictAware` (the `validated`/Review chart) colours Gaussian/Combined by the selected peak's
 * verdict: warning-amber when `flagged`, else the accepted greens -- exactly what the chart draws.
 * Because selection is redraw-only, {@link syncPfOverlaySwatches} keeps those two swatches in step
 * as the selection changes; the `data-verdict-aware` marker scopes that sync to this legend. */
function pfFitOverlayToggleMarkup(verdictAware = false, flagged = false): string {
  const ov = state.pf.fitOverlays;
  const GHOST = '#C9C7BF';
  const MUTED = '#6B6A63';
  const ACCENT = '#0F6E56';
  const INK = '#04342C';
  const WARN = '#7A5B12';
  const color: Record<keyof PeakFinderFitOverlays, string> = {
    raw: GHOST,
    gaussian: verdictAware && flagged ? WARN : ACCENT,
    continuum: MUTED,
    combined: verdictAware && flagged ? WARN : INK,
    residuals: WARN,
  };
  const btn = (id: keyof PeakFinderFitOverlays, label: string): string =>
    `<button class="pf-fit-overlay${ov[id] ? ' active' : ''}" type="button"
        data-overlay="${id}" aria-pressed="${ov[id]}"><span class="pf-cont-swatch" style="background:${color[id]}" aria-hidden="true"></span>${label}</button>`;
  return `
    <div class="pf-fit-overlays toggle-group" role="group" aria-label="Chart series"${
      verdictAware ? ' data-verdict-aware="1"' : ''
    }>
      ${btn('raw', 'Raw')}${btn('continuum', 'Continuum')}${btn('gaussian', 'Gaussian')}${btn(
        'combined',
        'Combined',
      )}${btn('residuals', 'Residuals')}
    </div>`;
}

/** Keep the verdict-aware overlay legend's Gaussian/Combined swatches in step with the selected
 * peak's verdict after a selection change (which is redraw-only, so the toggle markup would
 * otherwise go stale). No-op unless the currently-mounted legend is verdict-aware (validated /
 * Review); the fit stage's legend carries no `data-verdict-aware` marker and is left untouched. */
function syncPfOverlaySwatches(): void {
  const group = rootEl.querySelector<HTMLElement>('.pf-fit-overlays[data-verdict-aware]');
  const mgr = state.pf.manager;
  if (!group || !mgr) return;
  const ACCENT = '#0F6E56';
  const INK = '#04342C';
  const WARN = '#7A5B12';
  const flagged = pfSelectedValidatedFlagged(mgr);
  const set = (id: keyof PeakFinderFitOverlays, c: string): void => {
    const sw = group.querySelector<HTMLElement>(`.pf-fit-overlay[data-overlay="${id}"] .pf-cont-swatch`);
    if (sw) sw.style.background = c;
  };
  set('gaussian', flagged ? WARN : ACCENT);
  set('combined', flagged ? WARN : INK);
}

/** Resolve the peak the Peak Fitting cards + charts describe from the shared integer-channel
 * selection. A selected channel matches a fitted peak by its `detectedChannel` or an unfittable
 * survivor by its rounded channel; with nothing selected the page defaults to the first kept fit
 * (channel order) so the cards are populated on arrival. Returns `null` only when there is
 * genuinely nothing fitted (empty-state shape). */
function resolveSelectedFit(
  trace: PipelineTrace,
  selectedChannel: number | null,
): FittedPeak | UnfittableSurvivor | null {
  if (selectedChannel != null) {
    const f = trace.fitted.all.find((p) => p.detectedChannel === selectedChannel);
    if (f) return f;
    const u = trace.fitted.unfittable.find(
      (x) => Math.round(x.detectedChannel) === selectedChannel,
    );
    if (u) return u;
  }
  const kept = [...trace.fitted.kept].sort((a, b) => a.detectedChannel - b.detectedChannel);
  return kept[0] ?? trace.fitted.all[0] ?? trace.fitted.unfittable[0] ?? null;
}

/** The stable 1..N Peak ID of a fit at `detectedChannel` -- the SAME ordering the fit table uses
 * (ascending detected channel over every fitted + unfittable peak), so the chart's peak label and
 * the table's Peak ID column always agree. Returns 0 when the channel isn't among the fitted set. */
function fitPeakId(trace: PipelineTrace, detectedChannel: number): number {
  const chans = [
    ...trace.fitted.all.map((p) => Math.round(p.detectedChannel)),
    ...trace.fitted.unfittable.map((u) => Math.round(u.detectedChannel)),
  ].sort((a, b) => a - b);
  return chans.indexOf(Math.round(detectedChannel)) + 1;
}

/**
 * The redesigned "Peak Fitting" (`fit` / run-6) culmination stage. Presentation only (Principle
 * 9): the chart, caption, and peak table are the SAME surfaces every Run stage uses -- this adds
 * a measurement card grid derived PURELY from the selected fit via {@link deriveFitStats}. No
 * engine re-run, no fixture touch. Cards read the CURRENTLY SELECTED peak (table/chart selection);
 * the table lists every fitted peak. Layout:
 *   [ chart toolbar + #pfStageChart + caption ]
 *   [ Fit Summary | Peak Measurements (--why) ]
 *   [ Fit Quality | Optimization Summary ]
 *   [ Residual Analysis | Model Components ]
 *   [ Peak Table (full width) ]
 *   [ Why Gaussian Fitting? | Processing Integrity ]
 *   [ Mathematical Details (collapsed) ]
 *   [ Next Step: Validate Peaks (full width) ]
 * Before a run exists (no trace) or during the reveal it falls back to the plain chart + table,
 * exactly like every other Run stage. */
function peakFinderFitMarkup(mgr: PeakFinderManager, stage: number): string {
  const chartBlock = pfChartBlock({
    toolbar: pfChartToolbarMarkup(),
    charts: [{ id: 'pfStageChart' }],
    legend: pfFitOverlayToggleMarkup(),
  });
  // Standalone caption between the chart group and what follows -- equal spacing above/below and
  // justified, so it reads as a connective line rather than a chart footnote (mirrors the Detected
  // Peaks / Validate Peaks report pages).
  const stageCaption = `<p class="pf-stage-caption">${pfCaption(stage)}</p>`;
  const trace = mgr.pipelineTrace;
  // Auto-select the default fit on arrival (held only) so the table row, chart marker, and the
  // per-peak measurement cards all describe the SAME peak. Idempotent: only fills a null selection.
  if (trace && mgr.phase.kind === 'held' && state.pf.chart.selectedCandidate == null) {
    const def = resolveSelectedFit(trace, null);
    if (def) state.pf.chart.selectedCandidate = Math.round(def.detectedChannel);
  }
  const table = pfTableSection(mgr, stage);
  // Teaching cards only in the settled (`held`) state -- during the reveal the stage shows just
  // the chart + caption + inert table (reveal-lock), exactly like the other Run stages.
  if (!trace || mgr.phase.kind !== 'held')
    return `<div class="pf-fit">${chartBlock}${stageCaption}${table}</div>`; // fit: no verdict colouring

  const stats = deriveFitStats({
    selected: resolveSelectedFit(trace, state.pf.chart.selectedCandidate),
    background: trace.conditioned?.background ?? [],
    counts: trace.raw,
  });

  const recap = (pairs: readonly FitStatPair[]): string =>
    `<dl class="cfg-recap">${pairs
      .map((p) => `<div><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
      .join('')}</dl>`;

  const card = (
    title: string,
    pairs: readonly FitStatPair[],
    variant = '',
    cue = title,
  ): string => `
    <section class="pf-fit-card${variant}" data-cue-label="${escapeHtml(cue)}">
      <h4 class="pf-fit-card-title">${escapeHtml(title)}</h4>
      ${recap(pairs)}
    </section>`;

  const summaryCard = card('Fit Summary', stats.summary);
  const measurementsCard = card('Peak Measurements', stats.measurements);
  const qualityCard = card('Fit Quality', stats.quality);
  const optimizationCard = card('Optimization Summary', stats.optimization);

  // Residual Analysis (P4): the residual chart (`#pfFitResidualChart`, drawn by
  // `drawPfFitResidual` on the same redraw paths as the main chart) + the residual RMS +
  // teaching copy. `stats.quality` already carries the RMS pair, surfaced here beside the plot.
  const residualRms =
    stats.quality.find((p) => p.label === 'Residual RMS')?.value ?? '—';
  const residualCard = `
    <section class="pf-fit-card pf-fit-card--residual" data-cue-label="Residual Analysis">
      <h4 class="pf-fit-card-title">Residual Analysis</h4>
      <div class="pf-fit-residual-chartwrap">
        <canvas id="pfFitResidualChart" class="pf-fit-residual-chart"></canvas>
      </div>
      <dl class="cfg-recap"><div><dt>Residual RMS</dt><dd>${escapeHtml(residualRms)}</dd></div></dl>
      <p class="pf-fit-prose">The residual is <strong>raw − model</strong> at each channel, plotted
        about a zero baseline over the selected peak's window. A good fit leaves residuals scattered
        randomly about zero; systematic structure (an S-shape, a skew) reveals where the
        Gaussian-plus-continuum model does not match the data.</p>
    </section>`;

  // Model Components: the first three values are typeset MathML (raw markup, NOT escaped); the
  // last is plain prose. So this card is built directly rather than through the escaping `recap`.
  const modelRows: readonly { label: string; value: string; math?: boolean }[] = [
    { label: 'Gaussian Peak', value: FX_GAUSSIAN, math: true },
    { label: 'Linear Background', value: FX_LINEAR_BG, math: true },
    { label: 'Poisson Weighting', value: FX_POISSON, math: true },
    { label: 'Optimization', value: 'Levenberg–Marquardt least squares' },
  ];
  const modelCard = `
    <section class="pf-fit-card" data-cue-label="Model Components">
      <h4 class="pf-fit-card-title">Model Components</h4>
      <dl class="cfg-recap">${modelRows
        .map(
          (r) =>
            `<div><dt>${escapeHtml(r.label)}</dt><dd>${r.math ? r.value : escapeHtml(r.value)}</dd></div>`,
        )
        .join('')}</dl>
    </section>`;

  const whyCard = `
    <section class="pf-fit-card" data-cue-label="Why Gaussian Fitting">
      <h4 class="pf-fit-card-title">Why Gaussian Fitting?</h4>
      <p class="pf-fit-prose">Fitting a Gaussian on a linear background estimates the
        <strong>true</strong> centroid, net area and width of a photopeak while suppressing the
        statistical scatter in individual channels. This is far more reliable than reading the
        channel of maximum counts or naively summing a window — and, unlike those shortcuts, it
        yields an <strong>uncertainty</strong> on the centroid. These fitted values are the
        authoritative measurements every later stage consumes.</p>
    </section>`;


  // σ for the model formula, from the selected fit's FWHM (derivable); symbolic when absent.
  const sigmaTxt = stats.shape ? `${stats.shape.sigma.toFixed(2)} ch` : 'σ';
  const mathCard = `
    <details class="pf-fit-math" data-cue-label="Mathematical Details">
      <summary class="pf-fit-math-summary">Mathematical Details</summary>
      <div class="pf-fit-math-body">
        <p class="pf-fit-equation">${FX_FIT_MODEL}</p>
        <p class="pf-fit-prose">A = amplitude (peak height), μ = centroid, σ = Gaussian width
          (${escapeHtml(sigmaTxt)}), m = background slope, b = background intercept.
          ${FX_FWHM} and the analytic model area is ${FX_GAUSS_AREA}.</p>
        <p class="pf-fit-note">The reported <strong>Net Area</strong> is the integrated net counts
          over the fit window — the authoritative value. A·σ·√(2π) is the area of the fitted
          Gaussian model; the two agree only for a perfectly Gaussian peak. The background slope and
          intercept (m, b) are internal to the fit and are not reported per peak.</p>
      </div>
    </details>`;

  const nextCard = `
    <section class="pf-fit-card" data-cue-label="Next Step">
      <h4 class="pf-fit-card-title">Next Step — Validate Peaks</h4>
      <p class="pf-fit-prose">Verify each fitted peak meets the quality criteria required before
        calibration, identification and quantification — keeping every peak with its verdict rather
        than silently dropping any.</p>
    </section>`;

  // Labeled section divider (a rule with a centred caption naming the content that follows) --
  // the same chaptering helper the Detected Peaks / Validate Peaks report pages use.
  const divider = (label: string): string =>
    `<div class="pf-review-divider" role="separator" aria-label="${escapeHtml(label)}"><span class="pf-review-divider-label">${escapeHtml(label)}</span></div>`;

  // Top-to-bottom report: chart -> caption -> table (tight-grouped under the chart) -> the fit
  // measurements chapter -> the how-it-works chapter -> next steps. Mirrors the Validate Peaks page
  // so the two consecutive Finalize stages read as evenly-labeled chapters.
  return `
    <div class="pf-fit">
      ${divider('Fitted Peaks')}
      ${chartBlock}
      ${stageCaption}
      <div class="pf-tableblock">${table}</div>
      ${divider('Fit Measurements')}
      <div class="pf-fit-grid">${summaryCard}${measurementsCard}</div>
      <div class="pf-fit-grid">${qualityCard}${optimizationCard}</div>
      ${residualCard}
      ${divider('How Fitting Works')}
      <div class="pf-fit-grid">${whyCard}${modelCard}</div>
      ${mathCard}
      ${divider('Next Steps')}
      ${nextCard}
    </div>`;
}

/** Resolve the {@link ValidatedPeak} the "Validate Peaks" cards + chart describe from the shared
 * integer-channel selection. A selected channel matches a verdict by its peak's rounded
 * `detectedChannel`; with nothing selected the page defaults to the first ACCEPTED verdict (channel
 * order), falling back to the first verdict, so the cards are populated on arrival. Returns `null`
 * only when there is genuinely nothing validated (empty-state shape). */
function resolveSelectedValidated(
  trace: PipelineTrace,
  selectedChannel: number | null,
): ValidatedPeak | null {
  const all = trace.validated;
  if (selectedChannel != null) {
    const hit = all.find((v) => Math.round(v.peak.detectedChannel) === selectedChannel);
    if (hit) return hit;
  }
  const byChannel = [...all].sort((a, b) => a.peak.detectedChannel - b.peak.detectedChannel);
  return byChannel.find((v) => v.valid) ?? byChannel[0] ?? null;
}

/**
 * The redesigned "Validate Peaks" (`validated` / run-7) quality-control stage. Presentation only
 * (Principle 9): the chart, caption, and peak table are the SAME surfaces every Run stage uses --
 * this adds a validation card grid derived PURELY from `trace.validated` via
 * {@link deriveValidationStats}. NO re-validation, no engine call, no fixture touch. Cards read the
 * CURRENTLY SELECTED verdict (table/chart selection); the table lists every validated peak. Layout:
 *   [ chart toolbar + #pfStageChart + overlay toggles + caption ]
 *   [ Validation Summary | Validation Checklist (centrepiece) ]
 *   [ Validation Metrics | Validation Decision ]
 *   [ Validation Statistics (+ funnel) | Processing Integrity ]
 *   [ Validation Table (full width) ]
 *   [ Validation Report (full width) ]
 *   [ Why Peak Validation? | Validation Rules ]
 *   [ Mathematical Details (collapsed) ]
 *   [ Workflow Summary | Next Step: Energy Calibration ]
 * Before a run exists (no trace) or during the reveal it falls back to the plain chart + table,
 * exactly like every other Run stage. */
function peakFinderValidatedMarkup(mgr: PeakFinderManager, stage: number): string {
  const chartBlock = pfChartBlock({
    toolbar: pfChartToolbarMarkup(),
    charts: [{ id: 'pfStageChart' }],
    legend: pfFitOverlayToggleMarkup(true, pfSelectedValidatedFlagged(mgr)),
  });
  // Standalone caption between the chart group and what follows -- equal spacing above/below and
  // justified, so it reads as a connective line rather than a chart footnote (mirrors the Detected
  // Peaks page).
  const stageCaption = `<p class="pf-stage-caption">${pfCaption(stage)}</p>`;
  const trace = mgr.pipelineTrace;
  // Auto-select the default peak on arrival (held only) so the table row, the chart marker, and the
  // per-peak cards all describe the SAME peak -- no silent "phantom" default that the cards show but
  // nothing highlights. Idempotent: only fills a null selection, so it never overrides a click.
  if (trace && mgr.phase.kind === 'held' && state.pf.chart.selectedCandidate == null) {
    const def = resolveSelectedValidated(trace, null);
    if (def) state.pf.chart.selectedCandidate = Math.round(def.peak.detectedChannel);
  }
  const table = pfTableSection(mgr, stage);
  // Teaching cards only in the settled (`held`) state -- during the reveal the stage shows just
  // the chart + caption + inert table (reveal-lock), exactly like the other Run stages.
  if (!trace || mgr.phase.kind !== 'held')
    return `<div class="pf-val">${chartBlock}${stageCaption}${table}</div>`;

  const stats = deriveValidationStats({
    validated: trace.validated,
    selected: resolveSelectedValidated(trace, state.pf.chart.selectedCandidate),
    survivors: trace.detected.survivors.length,
    fitted: trace.fitted.kept.length,
  });

  const recap = (pairs: readonly ValStatPair[]): string =>
    `<dl class="cfg-recap">${pairs
      .map((p) => `<div><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
      .join('')}</dl>`;

  // Labeled section divider (a rule with a centred caption naming the content that follows) --
  // the same chaptering helper the Detected Peaks page uses.
  const divider = (label: string): string =>
    `<div class="pf-review-divider" role="separator" aria-label="${escapeHtml(label)}"><span class="pf-review-divider-label">${escapeHtml(label)}</span></div>`;

  // 1. Validation Summary -- the first thing the scientist reads after the chart. The status badge
  // + card accent turn warning-coloured when the selected peak is flagged.
  const flagged = stats.hasSelection && !stats.selectedValid;
  const summaryCard = `
    <section class="pf-fit-card pf-val-summary" data-cue-label="Validation Summary">
      <h4 class="pf-fit-card-title">Validation Summary</h4>
      <div class="pf-val-status pf-val-status--${flagged ? 'fail' : stats.hasSelection ? 'pass' : 'none'}">
        ${flagged ? '⚑' : stats.hasSelection ? '✓' : '—'} ${escapeHtml(stats.statusText)}
      </div>
      ${recap([
        { label: 'Decision', value: stats.decisionText },
        { label: 'Reason', value: stats.reasonText },
      ])}
    </section>`;

  // 2. Validation Checklist -- the centrepiece. Every rule shown individually with a pass/fail
  // glyph and (on failure) a short detail, so a rejection is never a black box.
  const checkItem = (c: ValChecklistItem, i: number): string => `
    <li class="pf-val-check pf-val-check--${c.passed ? 'pass' : 'fail'}">
      <span class="pf-val-check-glyph" aria-hidden="true">${c.passed ? '✓' : '✗'}</span>
      <span class="pf-val-check-rule">${escapeHtml(c.rule)}</span>
      <span class="pf-val-check-explanation">${escapeHtml(stats.report[i]?.explanation ?? '')}</span>
    </li>`;
  const checklistCard = `
    <section class="pf-fit-card pf-val-card--checklist" data-cue-label="Validation Checklist">
      <h4 class="pf-fit-card-title">Validation Checklist</h4>
      ${
        stats.hasSelection
          ? `<ul class="pf-val-checklist">${stats.checklist.map(checkItem).join('')}</ul>`
          : `<p class="pf-fit-prose muted">Select a peak in the chart or table to see its validation checklist.</p>`
      }
    </section>`;

  // 3. Validation Metrics -- the measurements being evaluated, read verbatim (no recompute).
  const metricsCard = `
    <section class="pf-fit-card" data-cue-label="Validation Metrics">
      <h4 class="pf-fit-card-title">Validation Metrics</h4>
      ${recap(stats.metrics)}
    </section>`;

  // (The former "Validation Decision" card was merged into the Validation Summary above -- both
  // stated the decision; the Summary now carries the plain-language rationale too.)

  // 5. Validation Statistics -- the spectrum-level assessment + the honest upstream funnel (D-2).
  const statisticsCard = `
    <section class="pf-fit-card" data-cue-label="Validation Statistics">
      <h4 class="pf-fit-card-title">Validation Statistics</h4>
      ${recap(stats.statistics)}
    </section>`;


  // (The former "Validation Report" table was merged into the Validation Checklist above -- each
  // checklist row now carries the plain-language explanation, so the two are no longer duplicated.)

  // 6. Why Peak Validation? -- the purpose (why, not how).
  const whyCard = `
    <section class="pf-fit-card" data-cue-label="Why Peak Validation">
      <h4 class="pf-fit-card-title">Why Peak Validation?</h4>
      <p class="pf-fit-prose">Peak fitting produces precise measurements, but not every fitted peak
        is a trustworthy line. Validation checks each fitted peak against fixed quality criteria —
        classification, width, centroid uncertainty, and numerical fit validity — and
        <strong>flags</strong> the ones that fail, with the reason. Only peaks that pass every check
        are handed to calibration and radionuclide identification. Nothing is silently discarded:
        every peak keeps its verdict and its flags.</p>
    </section>`;

  // 7. Acceptance Criteria -- the ACTUAL numeric thresholds the engine applies (the "passing marks"
  // behind each ✓ / ✗ in the checklist). Values come straight from pipeline/validate.ts constants,
  // so the displayed criteria can never drift from what the engine enforces.
  const criteriaCard = `
    <section class="pf-fit-card" data-cue-label="Acceptance Criteria">
      <h4 class="pf-fit-card-title">Acceptance Criteria</h4>
      <table class="review-table pf-val-rules">
        <thead><tr><th>Check</th><th>A peak passes when…</th></tr></thead>
        <tbody>
          <tr><td>Classification = Line</td><td>significance ≥ ${MIN_SIGNIFICANCE.toFixed(1)}σ (below &rarr; <strong>Weak</strong>) <em>and</em> width ≤ 2× the expected detector width (above &rarr; <strong>Broad</strong>)</td></tr>
          <tr><td>FWHM Acceptable</td><td>finite and 0 &lt; FWHM ≤ ${MAX_FWHM_CHANNELS} channels</td></tr>
          <tr><td>Centroid Error Acceptable</td><td>finite and 0 &lt; 1σ error ≤ ${MAX_CENTROID_ERROR_CHANNELS.toFixed(1)} channels</td></tr>
          <tr><td>χ² Numerically Valid</td><td>finite — a degenerate fit yields NaN/∞; magnitude is <em>not</em> scored</td></tr>
        </tbody>
      </table>
    </section>`;

  // 11. Mathematical Details -- the scientific rationale (collapsed by default; prose, no equations).
  const mathCard = `
    <details class="pf-fit-math" data-cue-label="Mathematical Details">
      <summary class="pf-fit-math-summary">Mathematical Details</summary>
      <div class="pf-fit-math-body">
        <p class="pf-fit-prose">Only peaks classified as <strong>Line</strong> proceed: the
          classifier accepts a peak whose significance clears the noise floor and whose width ratio
          is consistent with a real photopeak, rejecting weak fluctuations and broad Compton
          shelves. An <strong>unrealistic FWHM</strong> (non-physical or absurdly wide) marks a fit
          that blew up rather than a real line. An <strong>excessive centroid uncertainty</strong>
          means the peak's centre cannot be localised, so it would poison a calibration.</p>
        <p class="pf-fit-note">χ² here is the total weighted sum of squared residuals over the fit
          window — <strong>not</strong> a reduced χ². Its magnitude scales with peak amplitude and
          window width, so an absolute goodness cut would be detector- and isotope-shaped. Nuclid
          therefore uses χ² only as a <strong>numerical-validity</strong> indicator: a non-finite
          value signals a degenerate fit, while a finite value (including a not-computed “—”) is
          accepted.</p>
      </div>
    </details>`;

  // 14. Next Step -- the upcoming phase (Energy Calibration), no downstream OUTPUTS shown.
  const nextCard = `
    <section class="pf-fit-card" data-cue-label="Next Step">
      <h4 class="pf-fit-card-title">Next Step — Energy Calibration</h4>
      <p class="pf-fit-prose">Use the validated peaks to establish the detector's channel-to-energy
        calibration — the relationship that turns channel positions into gamma energies (keV) for
        radionuclide identification.</p>
    </section>`;

  return `
    <div class="pf-val pf-fit">
      ${divider('Validated Peaks')}
      ${chartBlock}
      ${stageCaption}
      <div class="pf-tableblock">${table}</div>
      ${divider('Validation Verdict')}
      <div class="pf-fit-grid">${summaryCard}${checklistCard}</div>
      <div class="pf-fit-grid">${metricsCard}${statisticsCard}</div>
      ${divider('How Validation Works')}
      <div class="pf-fit-grid">${whyCard}${criteriaCard}</div>
      ${mathCard}
      ${divider('Next Steps')}
      ${nextCard}
    </div>`;
}

/** The Candidate-Distribution card: a canvas (`#pfLmDistChart`) drawn by
 * {@link drawPfLmDistribution} + a Histogram / Channel Map / Density toggle (the Linear/Log
 * `.toggle-group` idiom). The active view is `state.pf.distView`; toggling redraws the canvas
 * only (wired in {@link mountPeakFinder}). */
function pfLmDistributionCardMarkup(): string {
  const cur = state.pf.distView;
  const btn = (id: PeakFinderDistView, label: string): string =>
    `<button class="pf-lm-distview${id === cur ? ' active' : ''}" type="button"
        data-distview="${id}" aria-pressed="${id === cur}">${label}</button>`;
  return `
    <section class="pf-lm-card pf-lm-card--dist" data-cue-label="Candidate Distribution">
      <div class="pf-lm-dist-head">
        <h4 class="pf-lm-card-title">Candidate Distribution</h4>
        <div class="toggle-group pf-lm-distviews" role="group" aria-label="Candidate distribution view">
          ${btn('histogram', 'Histogram')}${btn('channelMap', 'Channel Map')}${btn('density', 'Density')}
        </div>
      </div>
      <div class="pf-lm-dist-chartwrap"><canvas id="pfLmDistChart" class="pf-lm-dist-chart"></canvas></div>
      <p class="pf-lm-dist-hint muted">Where the candidates fall across the channel axis — clusters
        reveal peak-rich regions.</p>
    </section>`;
}

/** The plateau-handling note for the Mathematical Details card -- the ACTUAL rule
 * `signal/findPeaks.ts` (`localMaxima1d`) uses: a strictly-higher flat top is reported once at
 * its midpoint channel (floor), and the first / last channels can never be maxima. */
const PF_LM_PLATEAU_NOTE =
  'When several adjacent channels share the same value and together sit higher than the channels ' +
  'on either side (a flat top), the plateau is reported once, at its midpoint channel (rounded ' +
  'down). The very first and very last channels can never be local maxima.';

/** The v3 `.step-charttoolbar`: the Linear/Log Y-scale toggle (D3 — valid for
 * counts in channel space, driven by the shared `state.logY` log path) on the
 * left, the zoom hint + Reset-view button on the right. Shared by the stage and
 * Review charts. `.pf-reset` is kept alongside `.step-reset` so `syncPfResetButton`
 * still finds it; `.pf-scale` is the handler hook for the toggle. */
function pfChartToolbarMarkup(): string {
  const linActive = state.logY ? '' : ' active';
  const logActive = state.logY ? ' active' : '';
  return `
    <div class="step-charttoolbar">
      <div class="toggle-group" role="group" aria-label="Y axis scale">
        <button class="pf-scale${linActive}" type="button" data-scale="linear">Linear</button>
        <button class="pf-scale${logActive}" type="button" data-scale="log">Log</button>
      </div>
      <div class="step-charttoolbar-right">
        <span class="step-zoomhint">scroll to zoom · drag to pan</span>
        <button class="step-reset pf-reset" type="button" ${state.pf.chart.view ? '' : 'disabled'}>Reset View</button>
      </div>
    </div>`;
}

/** The ONE canonical Peak Finder chart block -- the Detected Peaks reference structure every
 * chart-bearing step renders through, so the toolbar / legend / caption / spacing can never drift
 * per stage. It emits, ALWAYS in this order: an optional toolbar, one or more `.step-chartwrap`
 * canvas cards, an optional legend slot, then an optional `.pf-caption`. `charts` is a single canvas
 * for most stages; the twin-compare stages (LLS / Inverse LLS) pass two, and a per-chart `label`
 * renders that canvas's before/after title above it. Callers pass the toolbar/legend markup they
 * already build (`pfChartToolbarMarkup()`, `pfFitOverlayToggleMarkup()`, `.pf-cont-legend`, ...);
 * the block only fixes the scaffold, never the slot contents. */
function pfChartBlock(opts: {
  toolbar?: string;
  charts: readonly { id: string; label?: string }[];
  legend?: string;
  caption?: string;
}): string {
  const charts = opts.charts
    .map((c) => {
      const label = c.label ? `<p class="pf-chart-label muted">${c.label}</p>` : '';
      return `${label}<div class="step-chartwrap"><canvas id="${c.id}" class="pf-stage-chart"></canvas></div>`;
    })
    .join('');
  const caption = opts.caption ? `<p class="pf-caption muted">${opts.caption}</p>` : '';
  // Wrapped in `.pf-chartblock` (a flex-column, NO-gap block -- like `.pf-review`) so the block is a
  // SINGLE flex item in whatever step container hosts it. That isolates the internal toolbar -> chart
  // -> legend -> caption spacing (driven by the --space-2 margin rules) from the container's own flex
  // `gap` (e.g. `.cfg-step` / `.pf-continuum` use --space-4), which would otherwise inflate every gap
  // and make the reference (Detected Peaks, hosted in the no-gap `.pf-review`) the odd one out.
  return `<div class="pf-chartblock">${opts.toolbar ?? ''}${charts}${opts.legend ?? ''}${caption}</div>`;
}

/** The per-stage peak-table section (P2, 4a): BELOW the chart, its own
 * full-width section (never beside it -- layout LOCKED). Rendered from the
 * precomputed trace + the status contract; '' only before any run exists.
 * // Divergence: the table is rendered INERT while the reveal is `running`
 * // (operator ruling, P2 addendum) -- rows regain selection + the expander only
 * // on `done`, matching the rail/toolbar's "reveal owns position" lock. */
function pfTableSection(mgr: PeakFinderManager, stage: number): string {
  const trace = mgr.pipelineTrace;
  const status = mgr.status;
  if (!trace || !status) return '';
  // Interactive (selection + expanders) once a result exists (held); inert before any run.
  const interactive = mgr.phase.kind === 'held' && mgr.report != null;
  const stageId = PF_RUN_STAGES[clampPfStage(stage)].id;
  // #7: the view-only sort toolbar sits ABOVE the table section, interactive only (its
  // `data-stage-id` lets the click handler swap the sibling section in place, stage-correct
  // on both the run panel and Review). Hidden while inert/reveal-locked. #8 will extend
  // this same toolbar container with the candidate filter.
  const toolbar = interactive ? pfTableToolbarMarkup(stageId) : '';
  return (
    toolbar +
    pfTableSectionMarkupRouted(
      trace,
      status,
      stageId,
      state.pf.chart.selectedCandidate,
      interactive,
      state.pf.tableSort,
      state.pf.tableFilter,
    )
  );
}

/** Route the per-stage table body: the "Find Local Maxima" stage (run-0) gets its OWN
 * stage-specific 4-column candidate table (D1 -- the deprecated five-fixed-column model no
 * longer applies here); every other Run stage keeps the shared {@link peakFinderTableSectionMarkup}
 * verbatim. Shared by the render path AND the in-place sort / filter / reveal-time swaps, so the
 * local-maxima table survives a re-sort. */
function pfTableSectionMarkupRouted(
  trace: PipelineTrace,
  status: SpectrumStatus,
  stageId: string,
  selectedChannel: number | null,
  interactive: boolean,
  sort: PeakFinderTableSort,
  filter: PeakFinderTableFilter,
): string {
  if (stageId === 'local-maxima')
    return peakFinderLocalMaximaTableMarkup(trace, selectedChannel, sort, interactive);
  if (stageId === 'distance')
    return peakFinderDistanceGateTableMarkup(trace, selectedChannel, sort, filter, interactive);
  if (stageId === 'fit')
    return peakFinderFitTableMarkup(trace, status, selectedChannel, sort, filter, interactive);
  if (stageId === 'validated')
    return peakFinderValidatedTableMarkup(trace, selectedChannel, sort, filter, interactive);
  if (stageId === 'review')
    return peakFinderReviewTableMarkup(trace, selectedChannel, sort, filter, interactive);
  return peakFinderTableSectionMarkup(
    trace,
    status,
    stageId,
    selectedChannel,
    interactive,
    sort,
    filter,
  );
}

/** The stage-specific candidate table for "Find Local Maxima" (run-0): four columns --
 * Candidate ID (a stable 1..N display index assigned in ascending channel order, so identity
 * survives a re-sort) · Channel · Counts (Peak Height, = `DetectedPeak.height`, the detection-
 * series value the local-maximum test itself compared) · Status (always "Candidate" -- no gate
 * has run). No expander drawer. CRITICAL: each row keeps `class="pf-row"` + integer
 * `data-channel` so `wirePfTableHandlers` / `selectPfChannel` / `syncPfRowHighlight` bind
 * unchanged and the row<->marker selection keeps working. Channel ascending / descending honours
 * `sort.dir`; there is NO filter here (nothing has been rejected yet). Every value is a pure read
 * of `trace.detected.all` -- no engine re-run (Principle 9). */
function peakFinderLocalMaximaTableMarkup(
  trace: PipelineTrace,
  selectedChannel: number | null,
  sort: PeakFinderTableSort,
  interactive: boolean,
): string {
  const columns = ['Candidate ID', 'Channel', 'Counts (Peak Height)', 'Status'];
  // Stable IDs by ascending channel; identity is independent of the display sort direction.
  const byChannel = [...trace.detected.all].sort((a, b) => a.channel - b.channel);
  const idOf = new Map<number, number>();
  byChannel.forEach((d, i) => idOf.set(d.channel, i + 1));
  const rows = sort.dir === 'desc' ? [...byChannel].reverse() : byChannel;
  const count = byChannel.length;
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const strip = `${count.toLocaleString('en-US')} local ${
    count === 1 ? 'maximum' : 'maxima'
  } — every candidate before any gate.`;
  const body =
    count === 0
      ? `<tr class="pf-row-empty"><td colspan="${columns.length}" class="muted">No candidates at this stage.</td></tr>`
      : rows
          .map((d) => {
            const selected = selectedChannel != null && d.channel === selectedChannel;
            const id = idOf.get(d.channel) ?? 0;
            const height = Math.round(d.height).toLocaleString('en-US');
            // Inert while running: no data-channel / tabindex (the row handler keys off
            // `.pf-row[data-channel]`, so it never wires) -- mirrors the shared table's lock.
            const lock = interactive ? '' : ' is-locked';
            const attrs = interactive ? ` data-channel="${d.channel}" tabindex="0"` : '';
            return `<tr class="pf-row pf-lm-row${selected ? ' is-selected' : ''}${lock}"${attrs}>
              <td>${id}</td>
              <td>${d.channel}</td>
              <td>${height}</td>
              <td class="pf-result">Candidate</td>
            </tr>`;
          })
          .join('');
  return `
    <div class="pf-table-section card">
      <h3 class="pf-table-title">Candidate table</h3>
      <p class="pf-count-strip muted">${strip}</p>
      <table class="review-table pf-table">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** The stage-specific fitted-measurements table for "Peak Fitting" (fit / run-6, P5): six
 * columns -- Peak ID (a stable 1..N index by ascending detected channel, so identity survives a
 * re-sort) · Centroid (sub-channel) · Net Area (integrated net counts) · FWHM (channels) · χ²
 * (verbatim, "—" when null) · Status (Successful / Rejected / Unfittable). Rows cover the full
 * fit partition -- `trace.fitted.all` (kept + guard-rejected) plus the `unfittable` survivors --
 * so the funnel stays honest (GAP-07). The O-4 filter maps the shared All / Advancing / Rejected
 * control to All / Successful (kept) / Unfittable (rejected + unfittable). CRITICAL: each row
 * keeps `class="pf-row"` + integer `data-channel` (= detectedChannel) so `wirePfTableHandlers` /
 * `selectPfChannel` / `syncPfRowHighlight` bind unchanged and the row<->marker selection keeps
 * working. Every value is a pure read of the trace -- no engine re-run (Principle 9). */
function peakFinderFitTableMarkup(
  trace: PipelineTrace,
  status: SpectrumStatus,
  selectedChannel: number | null,
  sort: PeakFinderTableSort,
  filter: PeakFinderTableFilter,
  interactive: boolean,
): string {
  const columns = ['Peak ID', 'Channel', 'Centroid', 'Net Area', 'FWHM', 'χ²', 'Status'];
  const DASH = '—';
  interface FitRow {
    channel: number;
    centroid: string;
    netArea: string;
    fwhm: string;
    chi: string;
    statusText: string;
    kind: 'pass' | 'drop';
  }
  const fmtInt = (v: number): string => Math.round(v).toLocaleString('en-US');
  const fitRows: FitRow[] = trace.fitted.all.map((p) => {
    const kept = p.status === 'kept';
    return {
      channel: Math.round(p.detectedChannel),
      centroid: p.centroidChannel.toFixed(2),
      netArea: fmtInt(p.netArea),
      fwhm: p.fwhmChannels.toFixed(1),
      chi:
        p.chiSquare == null
          ? DASH
          : p.chiSquare.toLocaleString('en-US', { maximumFractionDigits: 2 }),
      statusText: kept ? 'Successful' : 'Rejected',
      kind: kept ? 'pass' : 'drop',
    };
  });
  const unfitRows: FitRow[] = trace.fitted.unfittable.map((u) => ({
    channel: Math.round(u.detectedChannel),
    centroid: DASH,
    netArea: DASH,
    fwhm: DASH,
    chi: DASH,
    statusText: `Unfittable: ${u.reason}`,
    kind: 'drop',
  }));
  // Stable Peak IDs by ascending detected channel, independent of the display sort direction.
  const byChannel = [...fitRows, ...unfitRows].sort((a, b) => a.channel - b.channel);
  const idOf = new Map<number, number>();
  byChannel.forEach((r, i) => idOf.set(r.channel, i + 1));
  // Filter (O-4) over the stable-ID base order, then apply the view-only channel sort.
  const shown = byChannel.filter((r) =>
    filter === 'all' ? true : filter === 'advancing' ? r.kind === 'pass' : r.kind === 'drop',
  );
  const rows = sort.dir === 'desc' ? [...shown].reverse() : shown;
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const strip = peakFinderCountStrip(trace, status, 'fit');
  const body =
    rows.length === 0
      ? `<tr class="pf-row-empty"><td colspan="${columns.length}" class="muted">No peaks match this filter.</td></tr>`
      : rows
          .map((r) => {
            const selected = selectedChannel != null && r.channel === selectedChannel;
            const id = idOf.get(r.channel) ?? 0;
            // Inert while running: no data-channel / tabindex (mirrors the shared/local-maxima lock).
            const lock = interactive ? '' : ' is-locked';
            const attrs = interactive ? ` data-channel="${r.channel}" tabindex="0"` : '';
            return `<tr class="pf-row pf-fit-row pf-row--${r.kind}${selected ? ' is-selected' : ''}${lock}"${attrs}>
              <td>${id}</td>
              <td>${r.channel}</td>
              <td>${r.centroid}</td>
              <td>${r.netArea}</td>
              <td>${r.fwhm}</td>
              <td>${r.chi}</td>
              <td class="pf-result">${escapeHtml(r.statusText)}</td>
            </tr>`;
          })
          .join('');
  return `
    <div class="pf-table-section card">
      <h3 class="pf-table-title">Fitted measurements</h3>
      <p class="pf-count-strip muted">${escapeHtml(strip)}</p>
      <table class="review-table pf-table">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** The stage-specific validation table for "Validate Peaks" (`validated` / run-7): five columns --
 * Peak ID (a stable 1..N index by ascending detected channel, so identity survives a re-sort) ·
 * Classification · FWHM (channels) · χ² (verbatim, "—" when null) · Status (Accepted / Flagged).
 * One row per `trace.validated` verdict (the fitted peaks that reached validation); guard-rejected
 * fits + unfittable survivors never get a verdict and are surfaced in the Statistics funnel, not
 * here. The filter maps the shared All / Advancing / Rejected tokens to All / Accepted / Flagged.
 * CRITICAL: each row keeps `class="pf-row"` + integer `data-channel` (= detectedChannel) so
 * `wirePfTableHandlers` / `selectPfChannel` / `syncPfRowHighlight` bind unchanged and the
 * row<->marker selection keeps working. Every value is a pure read of `trace.validated` -- no
 * engine re-run (Principle 9). */
function peakFinderValidatedTableMarkup(
  trace: PipelineTrace,
  selectedChannel: number | null,
  sort: PeakFinderTableSort,
  filter: PeakFinderTableFilter,
  interactive: boolean,
): string {
  const columns = ['Peak ID', 'Channel', 'Classification', 'FWHM', 'Centroid Error', 'χ²', 'Status'];
  const DASH = '—';
  const cap = (s: string): string => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1));
  interface ValRow {
    channel: number;
    cls: string;
    fwhm: string;
    ce: string;
    chi: string;
    statusText: string;
    kind: 'pass' | 'drop';
  }
  const rowsAll: ValRow[] = trace.validated.map((v) => {
    const p = v.peak;
    return {
      channel: Math.round(p.detectedChannel),
      cls: cap(p.classification),
      fwhm: Number.isFinite(p.fwhmChannels) ? p.fwhmChannels.toFixed(1) : DASH,
      ce: Number.isFinite(p.centroidError) ? `± ${p.centroidError.toFixed(2)}` : DASH,
      chi:
        p.chiSquare == null
          ? DASH
          : p.chiSquare.toLocaleString('en-US', { maximumFractionDigits: 2 }),
      statusText: v.valid ? 'Accepted' : 'Flagged',
      kind: v.valid ? 'pass' : 'drop',
    };
  });
  // Stable Peak IDs by ascending detected channel, independent of the display sort direction.
  const byChannel = [...rowsAll].sort((a, b) => a.channel - b.channel);
  const idOf = new Map<number, number>();
  byChannel.forEach((r, i) => idOf.set(r.channel, i + 1));
  const shown = byChannel.filter((r) =>
    filter === 'all' ? true : filter === 'advancing' ? r.kind === 'pass' : r.kind === 'drop',
  );
  const rows = sort.dir === 'desc' ? [...shown].reverse() : shown;
  const total = byChannel.length;
  const accepted = byChannel.reduce((n, r) => n + (r.kind === 'pass' ? 1 : 0), 0);
  const flagged = total - accepted;
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const strip = `${total.toLocaleString('en-US')} validated ${
    total === 1 ? 'peak' : 'peaks'
  } — ${accepted.toLocaleString('en-US')} accepted · ${flagged.toLocaleString('en-US')} flagged.`;
  const body =
    rows.length === 0
      ? `<tr class="pf-row-empty"><td colspan="${columns.length}" class="muted">No peaks match this filter.</td></tr>`
      : rows
          .map((r) => {
            const selected = selectedChannel != null && r.channel === selectedChannel;
            const id = idOf.get(r.channel) ?? 0;
            const lock = interactive ? '' : ' is-locked';
            const attrs = interactive ? ` data-channel="${r.channel}" tabindex="0"` : '';
            return `<tr class="pf-row pf-val-row pf-row--${r.kind}${selected ? ' is-selected' : ''}${lock}"${attrs}>
              <td>${id}</td>
              <td>${r.channel}</td>
              <td>${escapeHtml(r.cls)}</td>
              <td>${r.fwhm}</td>
              <td>${r.ce}</td>
              <td>${r.chi}</td>
              <td class="pf-result">${escapeHtml(r.statusText)}</td>
            </tr>`;
          })
          .join('');
  return `
    <div class="pf-table-section card">
      <h3 class="pf-table-title">Validated peaks</h3>
      <p class="pf-count-strip muted">${escapeHtml(strip)}</p>
      <table class="review-table pf-table">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** The Final Peak Table for the "Detected Peaks" REVIEW page (`review`): seven columns --
 * Peak ID (stable 1..N by ascending detected channel) · Channel · FWHM (channels) · Net Area ·
 * χ² (verbatim, "—" when null) · Status (Accepted / Flagged) · Remarks (the plain-language reason
 * behind the status). Rows carry the same `.pf-row` / `data-channel` machinery every PF table uses
 * so the graph↔table selection sync + the sort/filter swaps work unchanged. Derived PURELY from
 * `trace.validated` via {@link deriveReviewPeakRows} (no recompute). */
function peakFinderReviewTableMarkup(
  trace: PipelineTrace,
  selectedChannel: number | null,
  sort: PeakFinderTableSort,
  _filter: PeakFinderTableFilter, // final Review is accepted-only; no filter applied
  interactive: boolean,
): string {
  // The final Review lists ONLY the accepted peaks (those that qualified validation) -- the flagged
  // ones are not part of the final result. IDs are numbered over the accepted set.
  const all = deriveReviewPeakRows(trace.validated.filter((v) => v.valid));
  const columns = ['Peak ID', 'Channel', 'FWHM', 'Net Area', 'χ²'];
  const rows = sort.dir === 'desc' ? [...all].reverse() : all;
  const total = all.length;
  const thead = `<thead><tr>${columns.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  const strip = `${total.toLocaleString('en-US')} accepted ${
    total === 1 ? 'peak' : 'peaks'
  } — the final Peak Finder result.`;
  const body =
    rows.length === 0
      ? `<tr class="pf-row-empty"><td colspan="${columns.length}" class="muted">No peaks were accepted.</td></tr>`
      : rows
          .map((r) => {
            const selected = selectedChannel != null && r.channel === selectedChannel;
            const lock = interactive ? '' : ' is-locked';
            const attrs = interactive ? ` data-channel="${r.channel}" tabindex="0"` : '';
            return `<tr class="pf-row pf-val-row pf-row--${r.kind}${selected ? ' is-selected' : ''}${lock}"${attrs}>
              <td>${r.id}</td>
              <td>${r.channel}</td>
              <td>${r.fwhm}</td>
              <td>${r.netArea}</td>
              <td>${r.chi}</td>
            </tr>`;
          })
          .join('');
  return `
    <div class="pf-table-section card">
      <h3 class="pf-table-title">Final peak table</h3>
      <p class="pf-count-strip muted">${escapeHtml(strip)}</p>
      <table class="review-table pf-table pf-review-table">
        ${thead}
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

/** The gate stages that expose the #8 candidate filter (the spec's list: Distance / Prominence
 * / Width). D-8b default -- extend this set to add the filter to other stages later. The Peak
 * Fitting stage (`fit`, P5/O-4) also exposes it, with fit-specific labels (see the toolbar). The
 * Final Review page (`review`) reuses it with the validated Accepted / Flagged labels. */
const PF_FILTER_STAGES = new Set(['distance', 'prominence', 'width', 'fit', 'validated']);

/** The #7 sort toolbar + the #8 gate-stage filter, in one `.pf-table-toolbar` container.
 * Reuses the `.step-charttoolbar` + `.toggle-group` idiom (visual precedent: the Linear/Log
 * scale toggle). `data-stage-id` is read back by the click handlers so the in-place table swap
 * targets the right stage. The filter renders only on gate stages (#8); the sort renders on all. */
function pfTableToolbarMarkup(stageId: string): string {
  const { dir } = state.pf.tableSort;
  const asc = dir === 'asc';
  const sort = `
      <span class="pf-table-toolbar-label muted">Sort</span>
      <div class="toggle-group" role="group" aria-label="Sort peak table by channel">
        <button class="pf-sort${asc ? ' active' : ''}" type="button"
          data-sort-dir="asc" aria-pressed="${asc}">Channel ↑</button>
        <button class="pf-sort${asc ? '' : ' active'}" type="button"
          data-sort-dir="desc" aria-pressed="${!asc}">Channel ↓</button>
      </div>`;
  let filter = '';
  if (PF_FILTER_STAGES.has(stageId)) {
    const cur = state.pf.tableFilter;
    const btn = (id: PeakFinderTableFilter, label: string): string =>
      `<button class="pf-filter${id === cur ? ' active' : ''}" type="button"
          data-filter="${id}" aria-pressed="${id === cur}">${label}</button>`;
    // The fit + validated stages reuse the same filter tokens with stage-specific labels:
    // fit -> Successful / Unfittable; validated -> Accepted / Flagged; gates -> Advancing / Rejected.
    const isFit = stageId === 'fit';
    const isVal = stageId === 'validated' || stageId === 'review';
    const advLabel = isVal ? 'Accepted' : isFit ? 'Successful' : 'Advancing';
    const rejLabel = isVal ? 'Flagged' : isFit ? 'Unfittable' : 'Rejected';
    filter = `
      <span class="pf-table-toolbar-label muted">Show</span>
      <div class="toggle-group" role="group" aria-label="Filter peaks">
        ${btn('all', 'All')}${btn('advancing', advLabel)}${btn('rejected', rejLabel)}
      </div>`;
  }
  return `
    <div class="step-charttoolbar pf-table-toolbar" data-stage-id="${stageId}">
      ${sort}${filter}
    </div>`;
}

/**
 * The Peak Finder FINAL REVIEW page (`review` / "Detected Peaks", the last step). This is the
 * final destination of the whole workflow -- it performs NO additional processing, only
 * consolidates the already-computed results into one scientific report (Principle 9). Every
 * figure is derived PURELY from the committed trace via {@link module:peakFinderReviewStats}.
 * Layout (design brief):
 *   [ Hero graph: toolbar + #pfReviewChart (full spectrum, all peaks) + overlay toggles + caption ]
 *   [ Peak Statistics | Spectrum Statistics ]
 *   [ Peak Quality Summary (full width) ]
 *   [ Final Peak Table (Peak ID · Channel · FWHM · Net Area · χ² · Status · Remarks) ]
 *   [ Adjust smoothing panel (kept -- the post-run re-tune escape hatch) ]
 *   [ Processing Report | Export ]
 *   [ Educational Summary | Energy Calibration (locked; CTA gated on ≥2 accepted peaks) ]
 * Before a run exists / mid-reveal it falls back to the plain chart + table, like the stages. */
function peakFinderReviewMarkup(mgr: PeakFinderManager): string {
  const trace = mgr.pipelineTrace;
  const status = mgr.status;
  const chartBlock = pfChartBlock({
    toolbar: pfChartToolbarMarkup(),
    charts: [{ id: 'pfReviewChart' }],
    legend: pfReviewOverlayToggleMarkup(),
  });
  // The hero caption is a STANDALONE sentence between the chart group and the table group -- NOT
  // part of the chart block -- with equal space above and below and justified text, so it reads as
  // its own connective line rather than a chart footnote.
  const heroCaption =
    `<p class="pf-review-hero-caption">The final Peak Finder result — the raw spectrum with every ` +
    `accepted peak marked in green. Only peaks that qualified validation are shown. Click a peak or ` +
    `a table row to frame it.</p>`;
  if (!trace || !status || mgr.phase.kind !== 'held')
    return `<div class="pf-review pf-fit">${chartBlock}${heroCaption}${pfTableSection(mgr, PF_RUN_STAGE_COUNT - 1)}</div>`;

  const validated = trace.validated;
  const peakStats = derivePeakStatistics({
    validated,
    survivors: trace.detected.survivors.length,
  });
  const specStats = deriveSpectrumStatistics({
    raw: trace.raw,
    background: trace.conditioned?.background ?? null,
    liveTimeSec: mgr.report?.spectrum.metadata.liveTimeSec ?? null,
  });
  const recap = (pairs: readonly ReviewStatPair[]): string =>
    `<dl class="cfg-recap">${pairs
      .map((p) => `<div><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`)
      .join('')}</dl>`;

  // A labeled section divider (a rule with a centred caption) that names the content that follows,
  // so the stacked report reads as clearly-separated chapters.
  const divider = (label: string): string =>
    `<div class="pf-review-divider" role="separator" aria-label="${escapeHtml(label)}"><span class="pf-review-divider-label">${escapeHtml(label)}</span></div>`;

  // §1 Peak Statistics | §2 Spectrum Statistics
  const statsGrid = `
    <div class="pf-fit-grid">
      <section class="pf-fit-card" data-cue-label="Peak Statistics">
        <h4 class="pf-fit-card-title">Peak Statistics</h4>${recap(peakStats)}
      </section>
      <section class="pf-fit-card" data-cue-label="Spectrum Statistics">
        <h4 class="pf-fit-card-title">Spectrum Statistics</h4>${recap(specStats)}
      </section>
    </div>`;

  // §4 Final Peak Table (with Remarks) + §5 the shared graph↔table selection sync (data-channel).
  const table = pfReviewTableSection(mgr);

  // §6 Processing Report | §8 Export
  const reportCard = `
    <section class="pf-fit-card" data-cue-label="Processing Report">
      <h4 class="pf-fit-card-title">Processing Report</h4>
      <p class="pf-fit-prose">${escapeHtml(buildProcessingReport(validated))}</p>
    </section>`;

  // §7 Educational Summary | §9 Energy Calibration (locked)
  const eduCard = `
    <section class="pf-fit-card" data-cue-label="Educational Summary">
      <h4 class="pf-fit-card-title">Educational Summary</h4>
      <p class="pf-fit-prose">Peak Finder has completed the extraction, measurement, and validation
        of spectral peaks. The values shown here are the final measured peak parameters in detector
        <strong>channel space</strong>. Energy calibration and radionuclide identification are
        performed separately, using these validated peaks.</p>
    </section>`;

  return `
    <div class="pf-review pf-fit">
      ${divider('Detected Peaks')}
      ${chartBlock}
      ${heroCaption}
      ${table}
      ${divider('Refine Analysis')}
      ${peakFinderReviewAdjustMarkup(mgr)}
      ${divider('Analysis Statistics')}
      ${statsGrid}
      ${divider('Report & Export')}
      <div class="pf-fit-grid">${reportCard}${peakFinderReviewExportMarkup()}</div>
      ${divider('Next Steps')}
      <div class="pf-fit-grid pf-review-close">${eduCard}${peakFinderReviewNextStepMarkup(validated)}</div>
    </div>`;
}

/** The Final Review hero graph's overlay toggles (full-spectrum view): Continuum / Gaussian Fits /
 * Rejected Peaks / Labels. Independent multi-select buttons reusing the `.pf-fit-overlay` idiom;
 * each carries a colour swatch matching the hero draw. State lives in `state.pf.reviewOverlays`;
 * toggling redraws `#pfReviewChart` only (wired in {@link mountPeakFinder}), never re-renders. */
function pfReviewOverlayToggleMarkup(): string {
  const ov = state.pf.reviewOverlays;
  const MUTED = '#6B6A63';
  const ACCENT = '#0F6E56';
  const WARN = '#7A5B12';
  const INK = '#04342C';
  const color: Record<keyof PeakFinderReviewOverlays, string> = {
    continuum: MUTED,
    gaussian: ACCENT,
    rejected: WARN,
    labels: INK,
  };
  const btn = (id: keyof PeakFinderReviewOverlays, label: string): string =>
    `<button class="pf-fit-overlay pf-review-overlay${ov[id] ? ' active' : ''}" type="button"
        data-review-overlay="${id}" aria-pressed="${ov[id]}"><span class="pf-cont-swatch" style="background:${color[id]}" aria-hidden="true"></span>${label}</button>`;
  return `
    <div class="pf-fit-overlays toggle-group" role="group" aria-label="Chart overlays">
      ${btn('continuum', 'Show Continuum')}${btn('gaussian', 'Show Gaussian Fits')}${btn('labels', 'Show Labels')}
    </div>`;
}

/** The Final Peak Table section (§4): the sort/filter toolbar + the review table, routed through
 * the shared `pfTableSectionMarkupRouted` (stage id `'review'`) so it inherits the in-place
 * sort/filter swap + the `.pf-row[data-channel]` selection sync for free. Interactive only once a
 * result exists (held). */
function pfReviewTableSection(mgr: PeakFinderManager): string {
  const trace = mgr.pipelineTrace;
  const status = mgr.status;
  if (!trace || !status) return '';
  const interactive = mgr.phase.kind === 'held' && mgr.report != null;
  const toolbar = interactive ? pfTableToolbarMarkup('review') : '';
  const table = pfTableSectionMarkupRouted(
    trace,
    status,
    'review',
    state.pf.chart.selectedCandidate,
    interactive,
    state.pf.tableSort,
    state.pf.tableFilter,
  );
  // Group the sort/filter toolbar + table into ONE block (mirrors `.pf-chartblock`'s
  // toolbar→chart→legend grouping) so the controls sit tight against the table they drive,
  // instead of floating a full section-gap above it.
  return `<div class="pf-tableblock">${toolbar}${table}</div>`;
}

/** The Export section (§8): CSV / JSON / Peak-List downloads, all reusing the shared
 * `downloadText` primitive (wired in {@link mountPeakFinder}). PDF report + Save Session are
 * intentionally omitted -- there is no export infrastructure for them yet, and a dead button
 * would misrepresent the capability. */
function peakFinderReviewExportMarkup(): string {
  return `
    <section class="pf-fit-card pf-review-export" data-cue-label="Export">
      <h4 class="pf-fit-card-title">Export</h4>
      <p class="pf-fit-prose muted">Download the completed analysis for record-keeping or as the
        hand-off to downstream tools.</p>
      <div class="pf-review-export-actions">
        <button class="btn pf-review-export-btn" type="button" id="pfExportCsv">Export Peak Table (CSV)</button>
        <button class="btn pf-review-export-btn" type="button" id="pfExportJson">Export Analysis (JSON)</button>
        <button class="btn pf-review-export-btn" type="button" id="pfExportList">Export Peak List</button>
      </div>
    </section>`;
}

/** The Next Step section (§9): Energy Calibration, presented as the LOCKED next stage. Reuses the
 * boundary copy (`PF_BOUNDARY_CONTENT['energy-cal']`). The forward ACTION lives in the bottom
 * toolbar (the footer Next becomes "Open Calibration Mode →" when ≥2 accepted peaks -- see
 * {@link peakFinderToolbarMarkup}); this card is the explainer + requirements only, and surfaces the
 * "workflow ends here" note below the calibration threshold (operator ruling). */
function peakFinderReviewNextStepMarkup(validated: readonly ValidatedPeak[]): string {
  const c = PF_BOUNDARY_CONTENT['energy-cal'];
  const ok = canProceedToCalibration(validated);
  const accepted = acceptedPeakCount(validated);
  // Requirements: "Validated peaks" is satisfied now; the rest are provided inside Calibration Mode.
  const reqRow = (label: string, done: boolean): string =>
    `<li class="pf-boundary-req ${done ? 'pf-boundary-req--done' : 'pf-boundary-req--wait'}">
      <span class="pf-boundary-req-glyph" aria-hidden="true">${done ? '✓' : '◷'}</span>
      <span class="pf-boundary-req-label">${escapeHtml(label)}</span>
      <span class="pf-boundary-req-note">${done ? 'Ready' : 'In Calibration Mode'}</span>
    </li>`;
  const reqs = c.requirements
    .map((r, i) => reqRow(r, i === 0 && accepted > 0))
    .join('');
  const note = ok
    ? `<p class="pf-fit-note">Ready — use <strong>Open Calibration Mode &rarr;</strong> in the toolbar
        below to continue.</p>`
    : `<p class="pf-fit-note pf-review-endnote">Energy calibration needs at least ${MIN_CALIBRATION_PEAKS}
        accepted peaks to fit a channel-to-energy relationship; this spectrum has ${accepted}. The
        Peak Finder workflow ends here.</p>`;
  return `
    <section class="pf-fit-card pf-review-nextstep" data-cue-label="Energy Calibration">
      <span class="pf-review-nextstep-eyebrow">Next stage · Locked</span>
      <h4 class="pf-fit-card-title pf-review-nextstep-title">Energy Calibration
        <span class="pf-review-lock-pill">Locked</span></h4>
      <p class="pf-fit-prose">${escapeHtml(c.whyLocked)}</p>
      <p class="pf-review-req-title">Requirements</p>
      <ul class="pf-boundary-reqs pf-review-reqs">${reqs}</ul>
      ${note}
    </section>`;
}

/** The Review-page "Adjust smoothing" panel (2026-07-07): the guided affordance to change the
 * Savitzky-Golay defaults AFTER seeing the results. The pipeline now runs SG-smoothed by default
 * (both the analysis input and the detection net), so the two upfront SG stages are no longer a
 * mandatory decision -- a user who is happy simply clicks through. This panel is the escape hatch
 * for a user who is NOT: two toggle groups that reuse the SAME `.pf-cont-input` / `.pf-net-input`
 * buttons the Load-SG and net-SG stages use, so they are wired for free (the unconditional
 * bindings) and each flip live-recomputes detection in place (the slice-3 cascade). The default
 * (smoothed) choice is listed FIRST in each group. Fitting always uses raw (R1), so the note
 * reassures that quantitative results are unaffected by the choice. */
export function peakFinderReviewAdjustMarkup(mgr: PeakFinderManager): string {
  const input = mgr.continuumInput;
  const net = mgr.netInput;
  const inputBtn = (id: SpectrumInputId, label: string): string =>
    `<button class="pf-cont-input${id === input ? ' active' : ''}" type="button"
      data-input="${id}" aria-pressed="${id === input}">${label}</button>`;
  const netBtn = (id: 'net' | 'smoothed-net', label: string): string =>
    `<button class="pf-net-input${id === net ? ' active' : ''}" type="button"
      data-net-input="${id}" aria-pressed="${id === net}">${label}</button>`;
  return `
    <section class="pf-review-adjust" aria-label="Adjust smoothing">
      <div class="pf-review-adjust-head">
        <h3 class="pf-review-adjust-title">Not satisfied with the results?</h3>
        <p class="pf-review-adjust-hint muted">The analysis runs on the Savitzky–Golay smoothed
          spectrum by default. Switch either input below and the peaks re-compute instantly.
          Centroids, areas, and FWHM are always measured from the raw counts, so your quantitative
          results are unaffected.</p>
      </div>
      <div class="pf-review-adjust-row">
        <span class="pf-cont-selector-label">Analysis input:</span>
        <div class="pf-cont-selector toggle-group" role="group" aria-label="Working spectrum">
          ${inputBtn('smoothed', 'Savitzky–Golay Smoothed')}${inputBtn('raw', 'Raw Spectrum')}
        </div>
      </div>
      <div class="pf-review-adjust-row">
        <span class="pf-cont-selector-label">Detection net:</span>
        <div class="pf-cont-selector toggle-group" role="group" aria-label="Detection net series">
          ${netBtn('smoothed-net', 'Savitzky–Golay Smoothed Net')}${netBtn('net', 'Net Spectrum')}
        </div>
      </div>
    </section>`;
}

/** The engine-error surface (mirror of `identifyStepperErrorMarkup`): the honest
 * message plus a visible auto-recovery countdown (Rev 4, §C). The manager owns the
 * timer and returns to the Load step when it elapses; `countdown` is the whole
 * seconds left (null outside the countdown). "Close Workspace" stays available in
 * the rail footer throughout, so the user can also leave immediately. */
function peakFinderErrorMarkup(message: string, countdown: number | null): string {
  const recovery =
    countdown != null
      ? `<p class="pf-error-countdown muted" role="status">Returning to the load step in ${countdown}s…</p>`
      : '';
  return `
    <section class="exec-stepper">
      <div class="disclaimer">${escapeHtml(message)}</div>
      ${recovery}
    </section>`;
}

/** The bottom navigation toolbar (mirror of `identifyToolbarMarkup`). Prev is a focus-only
 * step back (never below the first step); Next either moves focus forward to an already-
 * reached step or, at the frontier (`focus === reached`), fires the milestone Continue that
 * advances `reached`. The frontier milestone Next carries a descriptive label ("Continue to
 * …"). Both are inert on `error`. // Divergence: this milestone-label rule is the Peak Finder
 * go-forward convention; Calibrate/Identify are intentionally NOT retrofitted. */
function peakFinderToolbarMarkup(mgr: PeakFinderManager, model: PeakFinderStepModel): string {
  const kind = mgr.phase.kind;
  const { focus, reached } = mgr;
  let prevDisabled = true;
  let nextDisabled = true;
  let nextLabel = 'Next &rarr;';
  if (kind === 'error') {
    // The error surface auto-recovers -- both inert.
    prevDisabled = true;
    nextDisabled = true;
  } else {
    prevDisabled = focus <= 0;
    if (focus < reached) {
      // An already-reached step lies ahead -- Next is a plain focus move.
      nextDisabled = false;
    } else {
      // Frontier: Next fires the milestone Continue that advances `reached`.
      const id = mgr.focusId;
      if (id === 'load-spectrum') {
        nextDisabled = mgr.rawSpectrum == null; // nothing to continue until a spectrum loads
        nextLabel = 'Continue to Savitzky–Golay &rarr;';
      } else if (id === 'load-sg') {
        // "Perform Peak Fitting" (2026-07-08): both SG stages run the whole pipeline to the
        // Review output in one click; blocked only while an SG param is invalid.
        nextDisabled = mgr.sgError != null;
        nextLabel = 'Perform Peak Fitting';
      } else if (id === 'cont-sg') {
        // The net-SG stage also fits straight through to Review (same action as load-sg).
        nextDisabled = mgr.sgError != null;
        nextLabel = 'Perform Peak Fitting';
      } else {
        nextDisabled = true; // detect / review frontier -- reached is already at the end
      }
    }
  }
  const label = kind === 'error' ? null : peakFinderActiveStepLabel(model);
  // D-5: while a boundary teaching page is open, hide the "Step n of N" counter (the on-screen
  // surface is not a pipeline step) but keep Prev/Next live -- they return to the pipeline.
  const progress = label && state.pf.boundaryView == null ? escapeHtml(pfProgressText(label)) : '';
  // On the final Review step the forward action IS "proceed to Energy Calibration" -- but only when
  // the spectrum has enough accepted peaks to calibrate (>=2). The footer Next then becomes the
  // calibration CTA, navigating to Calibrate via the shared `data-boundary-cta` binding rather than
  // firing a (non-existent) pipeline Next. Below the threshold the workflow ends here (Next stays
  // disabled). Never on a boundary teaching page (that surface has its own CTA).
  const onReviewStep =
    kind !== 'error' &&
    state.pf.boundaryView == null &&
    mgr.focusId === 'review' &&
    mgr.pipelineTrace != null;
  const canCalibrate = onReviewStep && canProceedToCalibration(mgr.pipelineTrace.validated);
  // On the final Review step the forward button is ALWAYS "Open Calibration Mode" -- ACTIVE (and
  // navigating to Calibrate via the shared `data-boundary-cta` binding) when there are >=2 accepted
  // peaks, otherwise shown DISABLED so the next stage is always visible (the card explains why it is
  // locked). Off the Review step it stays the normal pipeline Next.
  const nextButton = !onReviewStep
    ? `<button id="pfNext" class="step-next primary" type="button" ${nextDisabled ? 'disabled' : ''}>${nextLabel}</button>`
    : canCalibrate
      ? `<button class="step-next primary pf-review-footer-cta" type="button" data-boundary-cta="calibrate">Open Calibration Mode &rarr;</button>`
      : `<button class="step-next primary pf-review-footer-cta" type="button" disabled aria-disabled="true">Open Calibration Mode &rarr;</button>`;
  return `
    <div class="step-nav">
      <button id="pfPrev" class="step-prev" type="button" ${prevDisabled ? 'disabled' : ''}>&larr; Prev</button>
      <span class="step-progress">${progress}</span>
      ${nextButton}
    </div>`;
}

/** Clamp a Run stage index into 0..PF_RUN_STAGE_COUNT-1. */
function clampPfStage(i: number): number {
  return Math.min(Math.max(0, Math.floor(i)), PF_RUN_STAGE_COUNT - 1);
}

/** The Detect stage the chart should show right now: the focused Detect step (`run-k`), else
 * the last-shown stage position (defensive fallback for non-detect focus). */
function currentPfStage(mgr: PeakFinderManager): number {
  const id = mgr.focusId;
  if (id.startsWith('run-')) return clampPfStage(Number(id.slice(4)));
  return clampPfStage(state.pf.stageIndex);
}

/** The Run stage caption, from the PF-owned {@link PF_RUN_STAGES} (single source of
 * truth; Peak Finder captions are channel-space and never share Calibrate's
 * energy-calibration wording). Tokens are substituted from the trace: `{all}` local
 * maxima, the cumulative per-gate survivor counts `{afterDistance}`/`{afterProminence}`,
 * `{survivors}` (post-gate), and the effective gate constants `{distance}`/`{prominence}`/
 * `{minWidth}` (from `trace.constants`, DEBT-27 -- the gates THIS run applied). */
function pfCaption(stage: number): string {
  const s = clampPfStage(stage);
  const caption = PF_RUN_STAGES[s].caption;
  const trace = state.pf.manager?.pipelineTrace;
  if (!trace) return caption;
  const all = trace.detected.all;
  // Cumulative per-gate survivors from the first-failing `rejectReason` (gate order is
  // fixed distance -> prominence -> width): after distance = not struck by distance;
  // after prominence = not struck by distance or prominence (survivors + width-rejected).
  const afterDistance = all.filter((d) => d.passed || d.rejectReason !== 'distance').length;
  const afterProminence = all.filter(
    (d) => d.passed || (d.rejectReason !== 'distance' && d.rejectReason !== 'prominence'),
  ).length;
  return caption
    .replace('{all}', String(all.length))
    .replace('{afterDistance}', String(afterDistance))
    .replace('{afterProminence}', String(afterProminence))
    .replace('{survivors}', String(trace.detected.survivors.length))
    .replace('{distance}', String(trace.constants.distance))
    .replace('{prominence}', String(trace.constants.prominence))
    .replace('{minWidth}', String(trace.constants.minWidth));
}

/** Navigate the grouped rail to a step by id (free backward/forward focus, 2026-07-05).
 * Delegates to the manager's focus-only {@link PeakFinderManager.goToStep}, which clamps to
 * the reached / reveal-locked range and emits (the notify re-renders). Focus-only: never
 * changes any step's `status` / `reached`. Keeps `state.pf.stageIndex` in sync so the chart
 * shows the focused Detect stage. */
function goToPeakFinderStep(id: string, mgr: PeakFinderManager): void {
  // Any pipeline navigation returns to normal routing -- the single choke point every rail
  // step-click, group-click, and focus-move Prev/Next flows through (2026-07-07 boundary).
  const wasBoundary = state.pf.boundaryView != null;
  state.pf.boundaryView = null;
  if (id.startsWith('run-')) {
    state.pf.stageIndex = clampPfStage(Number(id.slice(4)));
    // #8 D-8a: each gate stage is a fresh view -- reset the candidate filter to All so a
    // sticky "Rejected" is not carried between stages. (Flip to persist by dropping this.)
    state.pf.tableFilter = DEFAULT_TABLE_FILTER;
  }
  // mgr.goToStep emits (-> render) only when the focus actually changes. When a boundary page is
  // open the focus stays on its pipeline step, so returning to that SAME step (a rail click on the
  // focused row, or the back-link's 'review' clamped to the frontier pre-run) leaves the manager
  // focus unchanged -> no emit. Compare focus before/after (robust to the manager's clamp) and
  // render() explicitly in that case so the cleared boundaryView takes effect on screen.
  const focusBefore = mgr.focusId;
  mgr.goToStep(id);
  if (wasBoundary && mgr.focusId === focusBefore) render();
}

/** Navigate the accordion rail by GROUP header (#1): move focus to the group's first step,
 * which re-expands that group (expansion derives from focus). Focus-only via
 * {@link goToPeakFinderStep} -> the manager clamps to the reached/reveal-locked range, so an
 * unreached group is a no-op even if fired; the rail also marks unreached headers
 * `aria-disabled`, so they are never wired in the first place. */
function goToPeakFinderGroup(group: PeakFinderGroup, mgr: PeakFinderManager): void {
  const id = peakFinderFirstStepOfGroup(group);
  if (id) goToPeakFinderStep(id, mgr);
}

/** Bottom toolbar Prev/Next. Prev is a focus-only step back; Next moves focus forward to an
 * already-reached step, or (at the frontier) fires the milestone Continue that advances
 * `reached`. Inert on `error` (Next/Prev are disabled). */
function peakFinderNavStep(mgr: PeakFinderManager, dir: -1 | 1): void {
  if (mgr.phase.kind === 'error') return;
  // Prev/Next always return to the pipeline (D-5). The focus-move branches route through
  // goToPeakFinderStep (which clears boundaryView), but the FRONTIER-advance branch below fires
  // manager Continue milestones directly, bypassing it -- so clear here too, else a frontier Next
  // would advance the pipeline yet leave the boundary page showing.
  state.pf.boundaryView = null;
  const { focus, reached } = mgr;
  if (dir === -1) {
    if (focus > 0) goToPeakFinderStep(PF_STEP_IDS[focus - 1], mgr);
    return;
  }
  // dir === +1
  if (focus < reached) {
    goToPeakFinderStep(PF_STEP_IDS[focus + 1], mgr);
    return;
  }
  // Frontier advance: fire the Continue milestone for the current frontier step.
  const id = mgr.focusId;
  if (id === 'load-spectrum') mgr.continueToSmoothing();
  // Both SG stages "Perform Peak Fitting": run the whole pipeline and land on Review (2026-07-08).
  else if (id === 'load-sg' || id === 'cont-sg') mgr.performPeakFitting();
  // detect / review frontier: nothing further to reach.
}

// --- Peak Finder mode: handlers ----------------------------------------------

/** Feed a loaded file to the manager, then immediately run the whole pipeline to the Review
 * output (straight-to-output, 2026-07-08): the moment a spectrum is uploaded the backend processes
 * it end-to-end and lands the operator on the final page -- they inspect or re-tune the
 * intermediate stages by navigating BACK. A parse/engine fault lands on the honest error phase
 * (performPeakFitting is a no-op when the parse already failed). A fresh spectrum resets the
 * view-local walkthrough position + chart window. */
function loadPeakFinderSpectrum(text: string, fileName: string, fileSizeBytes?: number): void {
  const mgr = ensurePeakFinderManager();
  state.pf.loadError = null;
  state.pf.stageIndex = 0;
  state.pf.chart = emptyInspectorState();
  state.pf.contView = null;
  state.pf.contSeries = { input: true, background: true, net: true };
  state.pf.tableSort = DEFAULT_TABLE_SORT;
  state.pf.tableFilter = DEFAULT_TABLE_FILTER;
  state.pf.boundaryView = null; // a fresh load starts on load-spectrum, never a boundary page
  mgr.load(text, fileName, fileSizeBytes); // parse + hold (or error)
  // Straight-to-output: run the full pipeline and land on Review. No-op if the parse faulted
  // (phase !== 'held'), so an unparseable file still surfaces its honest error page.
  mgr.performPeakFitting(); // emits Review | error -> the notify renders
}

/** Fetch a shipped sample into the Peak Finder (mirror of `loadSample`, scoped to
 * this view's state -- a fetch fault surfaces on the Load step, fail-loud). */
async function loadPeakFinderSample(name: string): Promise<void> {
  try {
    const url = `${import.meta.env.BASE_URL}sample-data/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new ParseError(`Failed to load sample "${name}": HTTP ${res.status}.`);
    // No reliable Content-Length after transfer encoding -- measure the fetched text.
    const text = await res.text();
    loadPeakFinderSpectrum(text, name, new Blob([text]).size);
  } catch (err) {
    state.pf.loadError =
      err instanceof NuclidError ? err.message : `Unexpected error: ${(err as Error).message}`;
    render();
  }
}

/** (Re)bind the rail action-footer buttons (Rev 3, §A). Extracted so both the
 * initial attach AND the reveal-time rail patch (refreshPeakFinderChrome, which
 * replaces `.step-film` wholesale) keep them live. "Load New Spectrum" is the single
 * consolidated reset (was #pfNewFile + #pfNewSpectrum); "Close Workspace" returns to
 * the parent landing view. // Rev 5, §A: the View Walkthrough / Back To Detected
 * Peaks buttons were removed -- navigation is the rail step-clicks + Prev/Next only. */
function wirePfRailActions(mgr: PeakFinderManager): void {
  const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel);
  // §D: "Load Another File" -- the rail file picker REPLACES the current spectrum
  // (D1 replace-on-select: cancelling the picker leaves the current one intact). Mirrors
  // the body #pfFile handler; loadPeakFinderSpectrum re-holds via mgr.load + resets the
  // view-local walkthrough/chart. Re-bound after the reveal-time rail patch too.
  q<HTMLInputElement>('#pfRailFile')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => loadPeakFinderSpectrum(text, file.name, file.size));
  });
  // §D: "Clear Current Spectrum" -- the consolidated reset (renamed from #pfNewSpectrum).
  // reset() drops the run + held spectrum and returns to `collecting`; the notify renders
  // the empty Load step and the step model re-locks Run + Review via `hasResult`.
  // "Clear Workspace" (id kept `#pfClearSpectrum`): the consolidated reset. reset() drops
  // the run + held spectrum and returns to `collecting`; the notify renders the empty Load
  // step and the step model re-locks Continuum + Run + Review via `hasResult`.
  q<HTMLButtonElement>('#pfClearSpectrum')?.addEventListener('click', () => clearPfWorkspace(mgr));
  // "Close Workspace": clear the workspace FIRST, then leave (operator intent -- re-entry
  // starts fresh). clearPfWorkspace -> mgr.reset() also clears any error-recovery timer, so
  // the former error-phase special-case is no longer needed.
  q<HTMLButtonElement>('#pfCloseWorkspace')?.addEventListener('click', () => {
    clearPfWorkspace(mgr);
    navigate('landing');
  });
}

/** Reset the whole Peak Finder workspace to the empty Load step: drop the view-local
 * walkthrough / chart / continuum state and `mgr.reset()` (which also clears any in-flight
 * timer). Shared by "Clear Workspace" and "Close Workspace". */
function clearPfWorkspace(mgr: PeakFinderManager): void {
  state.pf.stageIndex = 0;
  state.pf.chart = emptyInspectorState();
  state.pf.contView = null;
  state.pf.contSeries = { input: true, background: true, net: true };
  state.pf.tableSort = DEFAULT_TABLE_SORT;
  state.pf.tableFilter = DEFAULT_TABLE_FILTER;
  state.pf.loadError = null;
  state.pf.boundaryView = null;
  mgr.reset();
}

function attachPeakFinderHandlers(): void {
  const mgr = ensurePeakFinderManager();
  const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel);

  // Configure -- the single Load step (// Divergence R2: loading parses + holds; the
  // run starts on the explicit Continue below, not on load).
  q<HTMLInputElement>('#pfFile')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => loadPeakFinderSpectrum(text, file.name, file.size));
  });
  q<HTMLSelectElement>('#pfSample')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (!name) return;
    void loadPeakFinderSample(name);
  });
  const drop = q<HTMLDivElement>('#pfDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dropzone-over');
    });
    drop.addEventListener('dragleave', (e) => {
      if (e.target === drop) drop.classList.remove('dropzone-over');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dropzone-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void file.text().then((text) => loadPeakFinderSpectrum(text, file.name, file.size));
    });
  }

  // Savitzky-Golay stage (redesign): SG is always applied; the params / apply / reset drive
  // the manager, which recomputes the smoothed spectrum + re-renders (the preview redraws on
  // remount). Params commit on `change` (blur / Enter) AND via the explicit Apply button so a
  // full re-render never fires mid-keystroke. The manager guards each against the wrong phase,
  // so binding them unconditionally is safe.
  const sgWin = q<HTMLInputElement>('#pfSgWindow');
  const sgPoly = q<HTMLInputElement>('#pfSgPoly');
  const applySgParams = (): void =>
    mgr.setSgParams({ window: Number(sgWin?.value), polyorder: Number(sgPoly?.value) });
  sgWin?.addEventListener('change', applySgParams);
  sgPoly?.addEventListener('change', applySgParams);
  q<HTMLButtonElement>('#pfSgApply')?.addEventListener('click', applySgParams);
  q<HTMLButtonElement>('#pfSgReset')?.addEventListener('click', () => mgr.resetSgDefaults());

  // Top-bar nav (v3 `.step-topbar` right cluster): route to the sibling views.
  // The shared app-header is suppressed in this mode, so its nav wiring in
  // attachShellHandlers finds nothing -- these buttons carry the routing here.
  rootEl.querySelectorAll<HTMLButtonElement>('.step-topbar [data-nav]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.nav as View)),
  );
  // Y-scale toggle (D3): drive the shared `state.logY` log path and redraw in
  // place (like Reset view -- not a full render, so the panel scroll is kept).
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-scale[data-scale]').forEach((b) =>
    b.addEventListener('click', () => {
      const wantLog = b.dataset.scale === 'log';
      if (state.logY === wantLog) return;
      state.logY = wantLog;
      rootEl
        .querySelectorAll<HTMLButtonElement>('.pf-scale')
        .forEach((x) => x.classList.toggle('active', (x.dataset.scale === 'log') === wantLog));
      drawPfCurrentChart();
    }),
  );

  // Peak Fitting decomposition-overlay toggles (P3): independent multi-select series visibility.
  // Redraw-only (mirrors the Y-scale toggle) -- flip the flag, restyle the button, redraw.
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-fit-overlay[data-overlay]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.overlay as keyof PeakFinderFitOverlays;
      if (!(key in state.pf.fitOverlays)) return;
      const next = !state.pf.fitOverlays[key];
      state.pf.fitOverlays[key] = next;
      b.classList.toggle('active', next);
      b.setAttribute('aria-pressed', String(next));
      drawPfCurrentChart();
    }),
  );

  // Final Review hero-graph overlay toggles: Continuum / Gaussian Fits / Rejected Peaks / Labels.
  // Redraw-only (mirrors the fit-overlay handler) -- flip the flag, restyle the button, redraw.
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-review-overlay[data-review-overlay]').forEach((b) =>
    b.addEventListener('click', () => {
      const key = b.dataset.reviewOverlay as keyof PeakFinderReviewOverlays;
      if (!(key in state.pf.reviewOverlays)) return;
      const next = !state.pf.reviewOverlays[key];
      state.pf.reviewOverlays[key] = next;
      b.classList.toggle('active', next);
      b.setAttribute('aria-pressed', String(next));
      drawPfCurrentChart();
    }),
  );

  // Final Review export buttons: CSV / JSON / Peak List via the shared `downloadText` primitive.
  // Rows are derived fresh on click from the current validated set (no stale snapshot).
  const reviewRows = (): readonly ReviewPeakRow[] =>
    deriveReviewPeakRows(state.pf.manager?.pipelineTrace?.validated ?? []);
  q<HTMLButtonElement>('#pfExportCsv')?.addEventListener('click', () =>
    downloadText(buildPeaksCsv(reviewRows()), 'peak-finder-peaks.csv', 'text/csv'),
  );
  q<HTMLButtonElement>('#pfExportJson')?.addEventListener('click', () =>
    downloadText(buildPeaksJson(reviewRows()), 'peak-finder-analysis.json', 'application/json'),
  );
  q<HTMLButtonElement>('#pfExportList')?.addEventListener('click', () =>
    downloadText(buildPeakList(reviewRows()), 'peak-finder-peaklist.txt', 'text/plain'),
  );

  // Peak-table sort toggle (#7): view-only reorder over the #6 channel-ascending base
  // order. Swaps the sibling `.pf-table-section` in place (stage taken from the toolbar's
  // `data-stage-id`, so it is correct on both the run panel and Review) -- keeps the panel
  // scroll + chart zoom, like the reveal-time table patch. Falls back to a full render if
  // the trace is momentarily unavailable.
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-sort[data-sort-dir]').forEach((b) =>
    b.addEventListener('click', () => {
      const dir: PeakFinderTableSort['dir'] = b.dataset.sortDir === 'desc' ? 'desc' : 'asc';
      if (state.pf.tableSort.dir === dir) return;
      state.pf.tableSort = { key: 'channel', dir };
      const toolbar = b.closest<HTMLElement>('.pf-table-toolbar');
      const stageId = toolbar?.dataset.stageId;
      const section = rootEl.querySelector<HTMLElement>('.pf-table-section');
      const m = state.pf.manager;
      if (toolbar && stageId && section && m?.pipelineTrace && m.status) {
        toolbar.querySelectorAll<HTMLButtonElement>('.pf-sort').forEach((x) => {
          const on = x.dataset.sortDir === dir;
          x.classList.toggle('active', on);
          x.setAttribute('aria-pressed', String(on));
        });
        section.outerHTML = pfTableSectionMarkupRouted(
          m.pipelineTrace,
          m.status,
          stageId,
          state.pf.chart.selectedCandidate,
          true,
          state.pf.tableSort,
          state.pf.tableFilter,
        );
        wirePfTableHandlers();
      } else {
        render();
      }
    }),
  );

  // Peak-table candidate filter (#8): view-only All / Advancing / Rejected on gate stages.
  // Mirrors the sort handler exactly -- sets state.pf.tableFilter, swaps the sibling section in
  // place (stage from the toolbar's `data-stage-id`), and rebinds the filter button actives.
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-filter[data-filter]').forEach((b) =>
    b.addEventListener('click', () => {
      const f = b.dataset.filter as PeakFinderTableFilter;
      if (state.pf.tableFilter === f) return;
      state.pf.tableFilter = f;
      const toolbar = b.closest<HTMLElement>('.pf-table-toolbar');
      const stageId = toolbar?.dataset.stageId;
      const section = rootEl.querySelector<HTMLElement>('.pf-table-section');
      const m = state.pf.manager;
      if (toolbar && stageId && section && m?.pipelineTrace && m.status) {
        toolbar.querySelectorAll<HTMLButtonElement>('.pf-filter').forEach((x) => {
          const on = x.dataset.filter === f;
          x.classList.toggle('active', on);
          x.setAttribute('aria-pressed', String(on));
        });
        section.outerHTML = pfTableSectionMarkupRouted(
          m.pipelineTrace,
          m.status,
          stageId,
          state.pf.chart.selectedCandidate,
          true,
          state.pf.tableSort,
          state.pf.tableFilter,
        );
        wirePfTableHandlers();
      } else {
        render();
      }
    }),
  );

  // Estimate Continuum -- input selector (re-runs SNIP on the chosen input) + the
  // continuum-scoped Reset View (its own `state.pf.contView` window). The manager guards
  // setContinuumInput against the wrong phase, so binding unconditionally is safe.
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-cont-input[data-input]').forEach((b) =>
    b.addEventListener('click', () => mgr.setContinuumInput(b.dataset.input as SpectrumInputId)),
  );
  // // 2026-07-05: the combined-page display-manager series legend is retired -- each of the
  // six continuum sub-pages draws a fixed, labelled overlay (pfContSeriesFor), so there are
  // no per-series toggles to wire.
  q<HTMLButtonElement>('.pf-cont-reset')?.addEventListener('click', () => {
    state.pf.contView = null;
    drawPfContinuum();
    syncPfContReset();
  });

  // Net SG (#3): the mandatory Net / Smoothed-Net selector + its OWN SG params. The selector
  // mirrors the raw stage's `.pf-cont-input` -> `setContinuumInput` wiring; params commit on
  // `change` (blur / Enter). All live-recompute downstream once detection has run -- the
  // manager emit drives the full re-render via onPeakFinderNotify (no explicit render() needed).
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-net-input[data-net-input]').forEach((b) =>
    b.addEventListener('click', () => mgr.setNetInput(b.dataset.netInput as 'net' | 'smoothed-net')),
  );
  const detWin = q<HTMLInputElement>('#pfDetSgWindow');
  const detPoly = q<HTMLInputElement>('#pfDetSgPoly');
  const applyDetSg = (): void =>
    mgr.setDetectionSgParams({ window: Number(detWin?.value), polyorder: Number(detPoly?.value) });
  detWin?.addEventListener('change', applyDetSg);
  detPoly?.addEventListener('change', applyDetSg);
  q<HTMLButtonElement>('#pfDetSgApply')?.addEventListener('click', applyDetSg);
  q<HTMLButtonElement>('#pfDetSgReset')?.addEventListener('click', () =>
    mgr.resetDetectionSgDefaults(),
  );

  // Grouped stepper -- rail clicks (locked steps excluded) + Prev/Next toolbar.
  rootEl.querySelectorAll<HTMLElement>('.step-film [data-step]:not([aria-disabled])').forEach((el) => {
    const go = (): void => goToPeakFinderStep(el.dataset.step ?? '', mgr);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  });
  // #1 accordion -- collapsed group headers (reached only; unreached carry aria-disabled and
  // are excluded). Clicking/Entering one moves focus to that group's first step, re-expanding
  // it. Only the main-render path needs this; the reveal-time rail patch does not re-bind it
  // (nav is locked during the reveal).
  rootEl.querySelectorAll<HTMLElement>('.step-film [data-group]:not([aria-disabled])').forEach((el) => {
    const go = (): void => goToPeakFinderGroup(el.dataset.group as PeakFinderGroup, mgr);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  });
  // Workflow-boundary rows (2026-07-07): locked-but-clickable downstream stages carry `data-boundary`
  // (not `data-step`/`data-group`), so they are wired ONLY here in the Peak Finder handler -- the
  // Identify rail shares the `.step-film` class but never emits `[data-boundary]`, so its own
  // binding block is unaffected (isolation). Opens the stage's teaching page (view-local render).
  rootEl.querySelectorAll<HTMLElement>('.step-film [data-boundary]').forEach((el) => {
    const go = (): void =>
      showPeakFinderBoundary(el.dataset.boundary as PeakFinderBoundaryStage['id']);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  });
  // Boundary teaching-page CTAs: the live buttons route to the sibling mode (Calibrate/Identify);
  // the disabled Quantification button carries no data-boundary-cta, so it is never wired. The
  // back link returns to the pipeline (goToPeakFinderStep clears boundaryView + clamps to reached).
  q<HTMLButtonElement>('[data-boundary-cta]')?.addEventListener('click', (e) =>
    navigate((e.currentTarget as HTMLElement).dataset.boundaryCta as View),
  );
  q<HTMLButtonElement>('[data-boundary-back]')?.addEventListener('click', () =>
    goToPeakFinderStep('review', mgr),
  );
  q<HTMLButtonElement>('#pfPrev')?.addEventListener('click', () => peakFinderNavStep(mgr, -1));
  q<HTMLButtonElement>('#pfNext')?.addEventListener('click', () => peakFinderNavStep(mgr, 1));

  // Rail action footer (Rev 3, §A): the contextual + workspace buttons.
  wirePfRailActions(mgr);
  q<HTMLButtonElement>('#pfHome')?.addEventListener('click', () => navigate('landing'));
  // Reset view: back to the full spectrum. Direct redraw (not a full render),
  // matching the interaction binding's dblclick reset path.
  q<HTMLButtonElement>('.pf-reset')?.addEventListener('click', () => {
    state.pf.chart.view = null;
    drawPfCurrentChart();
    syncPfResetButton();
  });

  // Stage/Review peak table (P2): row selection + detail drawers.
  wirePfTableHandlers();
}

/** Wire the stage/Review table's interactions: row click (or Enter/Space)
 * toggles selection -- the shared inspector selection model -- and the chevron
 * toggles the per-row secondary-measurement drawer. Called from attach AND after
 * the reveal's in-place table swap (swapped nodes need fresh listeners). */
function wirePfTableHandlers(): void {
  rootEl.querySelectorAll<HTMLTableRowElement>('.pf-row[data-channel]').forEach((row) => {
    const toggle = (): void => {
      const ch = Number(row.dataset.channel);
      selectPfChannel(state.pf.chart.selectedCandidate === ch ? null : ch);
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggle();
      }
    });
  });
  rootEl.querySelectorAll<HTMLButtonElement>('.pf-expand').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the drawer toggle must not flip row selection
      const detail = btn.closest('tr')?.nextElementSibling as HTMLElement | null;
      if (!detail?.classList.contains('pf-detail')) return;
      detail.hidden = !detail.hidden;
      btn.setAttribute('aria-expanded', String(!detail.hidden));
      btn.textContent = detail.hidden ? '▸' : '▾';
    });
  });
}

/** Row<->chart selection (P2, 4c), both ways, IN PLACE: store the integer
 * detection channel on the shared inspector chart state (the exported drawer
 * already renders the selection marker), redraw the visible chart, and re-derive
 * the row highlight. Deliberately not a full render -- selection must not reset
 * the panel scroll or disturb the reveal. */
function selectPfChannel(channel: number | null): void {
  state.pf.chart.selectedCandidate = channel;
  // On the Peak Fitting stage the chart is a single-peak zoom, so a new selection must re-zoom
  // to that peak: clear any manual pan/zoom window so the default fit window (recomputed for the
  // new selection) applies. Other stages leave the shared window untouched.
  const mgr = state.pf.manager;
  // Only trust the stage id when an actual Run step is focused (`run-k`). On the Detected Peaks
  // (`review`) page `currentPfStage` falls back to a stale index, which must NOT be read as a run
  // stage here (Review selection is a chart-frame + row-highlight update, never a full render).
  const stageId =
    mgr && mgr.focusId.startsWith('run-') ? PF_RUN_STAGES[currentPfStage(mgr)]?.id : undefined;
  if (stageId === 'fit') state.pf.chart.view = null;
  // The Peak Fitting + Validate Peaks stages carry PER-PEAK cards (measurements / verdict) that
  // describe the SELECTED peak, so a new selection must rebuild them. Re-render the panel but
  // preserve the `.step-main` scroll position, so repeated row clicks update the cards in place
  // without jumping the page back to the top.
  if (stageId === 'fit' || stageId === 'validated') {
    const top = rootEl.querySelector<HTMLElement>('.step-main')?.scrollTop ?? 0;
    render();
    const scroller = rootEl.querySelector<HTMLElement>('.step-main');
    if (scroller) scroller.scrollTop = top;
    return;
  }
  drawPfCurrentChart();
  syncPfOverlaySwatches(); // keep the verdict-aware legend's Gaussian/Combined swatches in step
  syncPfRowHighlight();
  // Distance Gate (run-1): re-render the §7/§8 comparison cards in place for the new selection
  // (no-op off that stage / before a run). Keeps selection a chart+cards update, never a full render.
  updatePfDistanceComparison();
}

/** Mark the row whose integer channel equals the selected candidate (both the
 * table->chart and the chart->table halves converge here). */
function syncPfRowHighlight(): void {
  const sel = state.pf.chart.selectedCandidate;
  rootEl.querySelectorAll<HTMLElement>('.pf-row[data-channel]').forEach((row) => {
    row.classList.toggle('is-selected', sel != null && Number(row.dataset.channel) === sel);
  });
}

// --- Peak Finder mode: mounting + drawing -------------------------------------

/** Mount the Peak Finder chart after a render: the stage chart (running |
 * done-walkthrough) or the Review chart (done-summary). One interaction binding
 * per render, on whichever canvas is present. */
/** Wire the Savitzky–Golay stage's scroll cue against the `.step-main` scroller: show a
 * gentle bottom gradient + downward chevron + context label ("<Section> below") only while
 * the content is clipped AND the user is at the top; fade it the moment they scroll; name the
 * first section below the fold; clicking it smooth-scrolls there (static under reduced
 * motion). No-op when the cue markup is absent (any non-SG stage) or the platform lacks the
 * layout APIs (test DOM). The returned handle tears the listeners down on the next render. */
function mountPfSmoothScrollCue(): void {
  const cue = rootEl.querySelector<HTMLElement>('.pf-sg-scrollcue');
  const scroller = rootEl.querySelector<HTMLElement>('.step-main');
  if (!cue || !scroller) return;
  const btn = cue.querySelector<HTMLButtonElement>('.pf-sg-scrollcue-btn');
  const labelEl = cue.querySelector<HTMLElement>('.pf-sg-scrollcue-label');

  // First labelled section whose TOP is below the scroller's visible bottom (the fold).
  const firstBelowFold = (): HTMLElement | null => {
    const foldBottom = scroller.getBoundingClientRect().bottom;
    for (const el of Array.from(scroller.querySelectorAll<HTMLElement>('[data-cue-label]'))) {
      if (el.getBoundingClientRect().top > foldBottom - 4) return el;
    }
    return null;
  };

  let target: HTMLElement | null = null;
  const update = (): void => {
    const clipped = scroller.scrollHeight - scroller.clientHeight > 8;
    const atTop = scroller.scrollTop <= 8;
    target = firstBelowFold();
    const visible = clipped && atTop && target != null;
    cue.classList.toggle('is-visible', visible);
    if (visible && labelEl) {
      const name = target?.dataset.cueLabel;
      labelEl.textContent = name ? `${name} below` : 'More information below';
    }
    if (btn) btn.tabIndex = visible ? 0 : -1;
    cue.setAttribute('aria-hidden', visible ? 'false' : 'true');
  };

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const onClick = (): void => {
    (target ?? firstBelowFold())?.scrollIntoView({
      behavior: reduce ? 'auto' : 'smooth',
      block: 'nearest',
    });
  };

  scroller.addEventListener('scroll', update, { passive: true });
  btn?.addEventListener('click', onClick);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
  ro?.observe(scroller);
  update();

  pfSmoothScrollCue = {
    destroy(): void {
      scroller.removeEventListener('scroll', update);
      btn?.removeEventListener('click', onClick);
      ro?.disconnect();
    },
  };
}

function mountPeakFinder(): void {
  // Savitzky–Golay stage scroll cue: wire it before any early return (it lives in `.step-main`
  // whichever stage is focused, but the markup only renders it for the SG stage).
  mountPfSmoothScrollCue();
  // LLS Transform stage (redesign): one full-size chart + a Working Spectrum / LLS-Transformed
  // toggle. Keyed on its own canvas so it mounts before -- and independently of -- the shared
  // continuum chart. The toggle is a REDRAW-ONLY interaction (mirrors the Find-Local-Maxima
  // distribution toggle): swap `state.pf.llsView`, restyle the buttons, redraw the one canvas.
  if (rootEl.querySelector('#pfLlsChart')) {
    drawPfLlsCompare();
    rootEl.querySelectorAll<HTMLButtonElement>('.pf-lls-view').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.llsview as PeakFinderLlsView | undefined;
        if (!v || v === state.pf.llsView) return;
        state.pf.llsView = v;
        rootEl.querySelectorAll<HTMLButtonElement>('.pf-lls-view').forEach((b) => {
          const on = b.dataset.llsview === v;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        drawPfLlsCompare();
      });
    });
    return;
  }
  // Inverse LLS Transform stage (redesign): one full-size chart + an LLS Space / Detector Counts
  // toggle -- the mirror of the LLS mount, same redraw-only discipline.
  if (rootEl.querySelector('#pfInvLlsChart')) {
    drawPfInvLlsCompare();
    rootEl.querySelectorAll<HTMLButtonElement>('.pf-invlls-view').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.invllsview as PeakFinderInvLlsView | undefined;
        if (!v || v === state.pf.invLlsView) return;
        state.pf.invLlsView = v;
        rootEl.querySelectorAll<HTMLButtonElement>('.pf-invlls-view').forEach((b) => {
          const on = b.dataset.invllsview === v;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        drawPfInvLlsCompare();
      });
    });
    return;
  }
  // SNIP Peak Clipping stage (redesign): a single LLS-domain chart driven by the iteration stepper.
  // Keyed on its own canvas so it mounts before -- and independently of -- the shared continuum chart.
  if (rootEl.querySelector('#pfSnipChart')) {
    mountPfSnipStage();
    return;
  }
  // Net Spectrum stage (redesign): a single counts-domain comparison chart with interactive series
  // toggles + a hover subtraction animation. Keyed on its own canvas so it mounts before -- and
  // independently of -- the shared continuum chart.
  if (rootEl.querySelector('#pfNetChart')) {
    mountPfNetStage();
    return;
  }
  // Estimate Continuum page: one chart with its own shared window. Keyed on canvas presence
  // (focus-driven) rather than phase, so free-nav back into it re-mounts correctly.
  if (rootEl.querySelector('#pfContChart')) {
    mountPeakFinderContinuum();
    return;
  }
  // Load + Savitzky-Golay stages: the preview canvas draws from the held raw spectrum (no
  // pipeline trace yet); the stage/Review canvases need a finished trace.
  const previewCanvas =
    rootEl.querySelector<HTMLCanvasElement>('#pfLoadChart') ??
    rootEl.querySelector<HTMLCanvasElement>('#pfSmoothChart');
  const canvas =
    previewCanvas ??
    rootEl.querySelector<HTMLCanvasElement>('#pfStageChart') ??
    rootEl.querySelector<HTMLCanvasElement>('#pfReviewChart');
  if (!canvas) return;
  if (previewCanvas) {
    if (!state.pf.manager?.rawSpectrum) return;
  } else if (!state.pf.manager?.pipelineTrace) {
    return;
  }
  drawPfCurrentChart();
  pfInteraction = mountChartInteraction(canvas, {
    getGeometry: () => state.pf.chart.geometry,
    // The user's explicit pan/zoom window, or -- when they have NOT interacted -- the effective
    // window the stage actually drew. The `fit` stage auto-zooms to the selected peak (P3) while
    // `state.pf.chart.view` stays null; without this, the interaction layer would read null (=
    // full range) and compute the first wheel-zoom/pan against the whole spectrum, snapping the
    // view and stranding the user (the Detected-Peaks trap, now also guarded here for `fit`). A
    // genuine full-range draw returns null, so pan/Reset stay exactly as before on every other
    // stage.
    getView: () => {
      const st = state.pf.chart;
      if (st.view) return st.view;
      const g = st.geometry;
      if (!g || (g.xMin <= 0 && g.xMax >= g.n - 1)) return null; // full range -> null
      return { xMin: g.xMin, xMax: g.xMax };
    },
    setView: (view) => {
      state.pf.chart.view = view;
      drawPfCurrentChart();
      syncPfResetButton();
    },
  });
  // The Load / SG previews have no per-candidate selection (no trace) -- pan/zoom only.
  if (previewCanvas) return;
  // Chart -> table selection (P2, 4c): the same hit-test the inspector canvas
  // uses -- nearestChannelIndex over EVERY local maximum, one selection model.
  // The interaction binding's pan threshold suppresses the click after a drag,
  // so pan and click-select coexist exactly as on the inspector canvas. A click
  // past the pixel tolerance (axis padding / empty space) clears the selection.
  // Reveal-lock (operator ruling, P2 addendum): selection is a `done`-only
  // interaction. The ruling names the table, but gating BOTH halves keeps one
  // consistent selection model -- no chart marker can appear while the table it
  // would pair with is inert. Pan/zoom stay live throughout.
  canvas.addEventListener('click', (e) => {
    const m = state.pf.manager;
    if (m?.phase.kind !== 'held' || m.report == null) return; // selection only once done
    const geo = state.pf.chart.geometry;
    const trace = state.pf.manager?.pipelineTrace;
    if (!geo || !trace) return;
    const xCss = e.clientX - canvas.getBoundingClientRect().left;
    const channels = trace.detected.all.map((d) => d.channel);
    const idx = nearestChannelIndex(geo, xCss, channels);
    selectPfChannel(idx == null ? null : channels[idx]);
  });
  // "Find Local Maxima" Candidate-Distribution (P3): draw the current view, then wire the
  // Histogram / Channel Map / Density toggle as a REDRAW-ONLY interaction (no re-render, so the
  // panel scroll + selection are undisturbed -- mirrors the table sort/filter discipline).
  const distCanvas = rootEl.querySelector<HTMLCanvasElement>('#pfLmDistChart');
  if (distCanvas) {
    drawPfLmDistribution();
    rootEl.querySelectorAll<HTMLButtonElement>('.pf-lm-distview').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.distview as PeakFinderDistView | undefined;
        if (!v || v === state.pf.distView) return;
        state.pf.distView = v;
        rootEl.querySelectorAll<HTMLButtonElement>('.pf-lm-distview').forEach((b) => {
          const on = b.dataset.distview === v;
          b.classList.toggle('active', on);
          b.setAttribute('aria-pressed', String(on));
        });
        drawPfLmDistribution();
      });
    });
  }
}

/** Draw the current Peak Finder chart. During preprocessing (revised Load stage) that
 * is the raw spectrum with an optional smoothed-preview overlay; during the run it is
 * the stage/Review chart. No-op without a canvas or the data the surface needs. */
function drawPfCurrentChart(): void {
  if (rootEl.querySelector('#pfContChart')) {
    drawPfContinuum();
    return;
  }
  const loadCanvas = rootEl.querySelector<HTMLCanvasElement>('#pfLoadChart');
  if (loadCanvas) {
    drawPfLoadChart(loadCanvas);
    return;
  }
  const smoothCanvas = rootEl.querySelector<HTMLCanvasElement>('#pfSmoothChart');
  if (smoothCanvas) {
    drawPfSmoothChart(smoothCanvas);
    return;
  }
  const mgr = state.pf.manager;
  if (!mgr?.pipelineTrace) return;
  const stageCanvas = rootEl.querySelector<HTMLCanvasElement>('#pfStageChart');
  const reviewCanvas = rootEl.querySelector<HTMLCanvasElement>('#pfReviewChart');
  // The Final Review page draws its OWN full-spectrum hero (all validated peaks), not the
  // per-peak decomposition the Run stages use. Its canvas is `#pfReviewChart` and never
  // coexists with `#pfStageChart`.
  if (reviewCanvas && !stageCanvas) {
    drawPfReviewHero(reviewCanvas);
    return;
  }
  if (!stageCanvas) return;
  drawPfStage(stageCanvas, currentPfStage(mgr));
  // P4: keep the fit-stage residual chart in step with the main chart on every redraw path
  // (selection, Y-scale toggle, reset view, mount). No-op off the fit stage (canvas absent).
  drawPfFitResidual();
}

/** Draw a Load / Savitzky-Golay preview onto `canvas` from the given series, sharing the
 * `state.pf.chart` view/geometry + the same `drawSpectrum` primitive as the run stages. */
function drawPfPreview(canvas: HTMLCanvasElement, series: ChartSeries[]): void {
  const inspView = state.pf.chart.view;
  const view = inspView
    ? { ...inspView, ...fitYToWindow(series.map((s) => s.values), inspView) }
    : undefined;
  state.pf.chart.geometry =
    drawSpectrum(canvas, series, [], {
      logY: state.logY,
      xLabel: 'Channel',
      yLabel: 'counts',
      overlays: [],
      ...(view ? { view } : {}),
    }) ?? null;
}

/** The Load-stage preview: the raw spectrum in channel space (raw only -- smoothing is now
 * the next, dedicated stage). */
function drawPfLoadChart(canvas: HTMLCanvasElement): void {
  const raw = state.pf.manager?.rawSpectrum;
  if (!raw) return;
  drawPfPreview(canvas, [{ values: raw.counts, color: '#0F6E56', label: 'counts', width: 1.2, step: true }]);
}

/** The Savitzky-Golay stage preview (SD-C): raw + smoothed ALWAYS overlaid in the two
 * legend colours (SG is always applied now). The smoothed series is drawn on top of raw
 * (R1: DISPLAY overlay only; areas are never taken from it). Falls back to raw-only in the
 * pathological case where the smoothed series is absent. */
function drawPfSmoothChart(canvas: HTMLCanvasElement): void {
  const mgr = state.pf.manager;
  const raw = mgr?.rawSpectrum;
  if (!mgr || !raw) return;
  const smoothed = mgr.smoothedSpectrum;
  const series: ChartSeries[] = smoothed
    ? [
        { values: raw.counts, color: PF_SMOOTH_COLORS.raw, label: 'raw', width: 1.2, step: true },
        { values: smoothed.counts, color: PF_SMOOTH_COLORS.smoothed, label: 'smoothed', width: 1.2, step: true },
      ]
    : [{ values: raw.counts, color: PF_SMOOTH_COLORS.raw, label: 'counts', width: 1.2, step: true }];
  drawPfPreview(canvas, series);
}

/** Hit-test geometry for the single Estimate Continuum chart (drag-pan maps pixels to
 * channels through it). Refreshed on every {@link drawPfContinuum}. */
let pfContGeom: ChartGeometry | null = null;

/** The series + Y-axis label for the FOCUSED continuum sub-page. Each page draws a fixed,
 * labelled overlay over the same channel axis (no per-series toggles): the working copy, its
 * LLS domain, the SNIP background in that domain, the inverse-LLS background over the input,
 * the net, or the net-SG preview. All read data the manager already computed. */
function pfContSeriesFor(mgr: PeakFinderManager): { series: ChartSeries[]; yLabel: string } | null {
  const input = mgr.selectedInput;
  const background = mgr.backgroundSpectrum;
  const net = mgr.netSpectrum;
  if (!input || !background || !net) return null;
  const C = PF_CONT_COLORS;
  const step = (values: readonly number[], color: string, label: string): ChartSeries => ({
    values,
    color,
    label,
    width: 1.2,
    step: true,
  });
  const dashed = (values: readonly number[], color: string, label: string): ChartSeries => ({
    values,
    color,
    label,
    width: 1.2,
    dash: [4, 3],
  });
  switch (mgr.focusId) {
    case 'cont-working':
      return { series: [step(input.counts, C.input, 'Working Copy')], yLabel: 'counts' };
    case 'cont-lls': {
      const lls = mgr.llsInput;
      return lls ? { series: [step(lls, C.input, 'LLS working copy')], yLabel: 'LLS' } : null;
    }
    case 'cont-snip': {
      const lls = mgr.llsInput;
      const llsBg = mgr.llsBackground;
      return lls && llsBg
        ? { series: [step(lls, C.input, 'LLS input'), dashed(llsBg, C.background, 'SNIP background')], yLabel: 'LLS' }
        : null;
    }
    case 'cont-invlls':
      return {
        series: [step(input.counts, C.input, 'Input'), dashed(background, C.background, 'Background')],
        yLabel: 'counts',
      };
    case 'cont-net':
      return { series: [step(net, C.net, 'Net')], yLabel: 'counts' };
    case 'cont-sg': {
      // #3: mirror the raw stage -- ALWAYS overlay Net vs Smoothed-Net so the choice can be
      // previewed regardless of the current pick. `smoothedNetSpectrum` is always computed.
      const smoothedNet = mgr.smoothedNetSpectrum;
      if (smoothedNet)
        return {
          series: [step(net, C.rawNet, 'Net'), step(smoothedNet, C.smoothedNet, 'Smoothed net')],
          yLabel: 'counts',
        };
      return { series: [step(net, C.net, 'Net')], yLabel: 'counts' };
    }
    default:
      return { series: [step(input.counts, C.input, 'Working Copy')], yLabel: 'counts' };
  }
}

/** Draw the focused Estimate Continuum sub-page onto `#pfContChart`. The shared X window
 * (`state.pf.contView`) persists across the six pages. */
function drawPfContinuum(): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfContChart');
  if (!canvas) return;
  const spec = pfContSeriesFor(mgr);
  if (!spec) return;
  const win = state.pf.contView;
  const view = win ? { ...win, ...fitYToWindow(spec.series.map((s) => s.values), win) } : undefined;
  pfContGeom =
    drawSpectrum(canvas, spec.series, [], {
      logY: state.logY,
      xLabel: 'Channel',
      yLabel: spec.yLabel,
      overlays: [],
      ...(view ? { view } : {}),
    }) ?? null;
}

/** Draw the LLS Transform stage's single shared chart (`#pfLlsChart`) in the currently-selected
 * view (`state.pf.llsView`): the working spectrum (counts) or its LLS transform (LLS domain). The
 * chosen series occupies the full-size chart and auto-scales its own Y-axis, so switching views
 * shows the same shape at wildly different scales -- the compression reads off the axis labels
 * while the structure is visibly preserved. The caption (`#pfLlsCap`) is synced to the active
 * view. Redraw-only: no zoom/pan binding, so nothing here touches `state.pf.contView` or the other
 * pages' `#pfContChart`. No-op until both the selected input and the LLS array exist (the page only
 * reaches focus once the continuum ran). */
function drawPfLlsCompare(): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const input = mgr.selectedInput;
  const lls = mgr.llsInput;
  if (!input || !lls) return;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfLlsChart');
  if (!canvas) return;
  const view = state.pf.llsView;
  const series: ChartSeries = {
    values: view === 'raw' ? input.counts : lls,
    color: PF_CONT_COLORS.input,
    label: view === 'raw' ? 'Working spectrum' : 'LLS transformed',
    width: 1.2,
    step: true,
  };
  // Linear Y: the counts view's spiky dominant peak vs the LLS view's compressed structure IS
  // the teaching contrast (a shared log toggle would blunt it and is not needed).
  drawSpectrum(canvas, [series], [], {
    logY: false,
    xLabel: 'Channel',
    yLabel: view === 'raw' ? 'counts' : 'LLS',
    overlays: [],
  });
  const capEl = rootEl.querySelector('#pfLlsCap');
  if (capEl) {
    const c = pfLlsViewCaption(view);
    capEl.innerHTML = `${c.title} <span class="muted">— ${c.unit}</span>`;
  }
}

/** Draw the Inverse LLS Transform stage's single shared chart (`#pfInvLlsChart`) in the currently-
 * selected view (`state.pf.invLlsView`) -- the mirror of {@link drawPfLlsCompare}. The chosen
 * series occupies the full-size chart and auto-scales its own Y-axis, so switching between the
 * LLS-domain background (~0.5…3) and the restored counts-domain background (~10⁰…10⁵) shows the
 * same continuum shape at both scales -- the restoration reads off the axis labels. Both series are
 * the manager's committed `llsBackground` and `backgroundSpectrum`; nothing re-runs the engine. The
 * caption (`#pfInvLlsCap`) is synced to the active view. Redraw-only: no zoom/pan binding, so
 * nothing here touches `state.pf.contView` or the other pages' `#pfContChart`. No-op until both
 * background arrays exist (the page only reaches focus once the continuum ran). */
function drawPfInvLlsCompare(): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const background = mgr.backgroundSpectrum;
  const llsBackground = mgr.llsBackground;
  if (!background || !llsBackground) return;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfInvLlsChart');
  if (!canvas) return;
  const view = state.pf.invLlsView;
  const series: ChartSeries = {
    values: view === 'lls' ? llsBackground : background,
    color: PF_CONT_COLORS.background,
    label: view === 'lls' ? 'Background (LLS)' : 'Background (counts)',
    width: 1.2,
    step: true,
  };
  // Linear Y: the LLS-domain background's compressed structure vs the counts-domain background's
  // restored scale IS the teaching contrast -- the shape matches, the axes reveal the ~3 → ~10⁵
  // restoration.
  drawSpectrum(canvas, [series], [], {
    logY: false,
    xLabel: 'Channel',
    yLabel: view === 'lls' ? 'LLS' : 'counts',
    overlays: [],
  });
  const capEl = rootEl.querySelector('#pfInvLlsCap');
  if (capEl) {
    const c = pfInvLlsViewCaption(view);
    capEl.innerHTML = `${c.title} <span class="muted">— ${c.unit}</span>`;
  }
}

/** Draw the "Find Local Maxima" stage's Candidate-Distribution canvas (`#pfLmDistChart`) in the
 * currently-selected view (`state.pf.distView`): a histogram of candidate positions (default), a
 * channel-map strip (one tick per candidate), or a kernel-density curve. Every view is a pure
 * transform of the pre-gate candidate channel list via {@link deriveLocalMaximaStats} -- no engine
 * re-run. Bespoke small-canvas rendering (not `drawSpectrum`): the axis is just the 0…N channel
 * span, no Y ticks, no zoom/pan -- so nothing here touches the run chart's view/geometry state.
 * No-op without the canvas or a trace. */
function drawPfLmDistribution(): void {
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfLmDistChart');
  if (!canvas) return;
  const mgr = state.pf.manager;
  const trace = mgr?.pipelineTrace;
  if (!mgr || !trace) return;
  const detectionLabel =
    mgr.netInput === 'smoothed-net' ? 'Savitzky–Golay Smoothed Net' : 'Net Spectrum';
  const { distribution } = deriveLocalMaximaStats({
    channels: trace.raw.length,
    candidates: trace.detected.all.map((d) => ({ channel: d.channel, height: d.height })),
    detectionSpectrumLabel: detectionLabel,
  });
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 160;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 10;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const plotW = Math.max(1, cssW - padL - padR);
  const plotH = Math.max(1, cssH - padT - padB);
  const channels = distribution.channels;
  const ACCENT = '#0F6E56';
  const MUTED = '#6B6A63';
  const AXIS = '#C9C7BF';
  const baseY = padT + plotH;
  const xOf = (ch: number): number => padL + (channels > 0 ? (ch / channels) * plotW : 0);

  // Baseline channel axis + the two endpoint labels (0 … N), the only reference the views need.
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, baseY + 0.5);
  ctx.lineTo(padL + plotW, baseY + 0.5);
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('0', padL, baseY + 5);
  ctx.textAlign = 'right';
  ctx.fillText(channels > 0 ? channels.toLocaleString('en-US') : '—', padL + plotW, baseY + 5);
  ctx.textAlign = 'left';

  if (distribution.positions.length === 0) {
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No candidates to plot', padL + plotW / 2, padT + plotH / 2);
    return;
  }

  switch (state.pf.distView) {
    case 'channelMap': {
      ctx.strokeStyle = 'rgba(15, 110, 86, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const ch of distribution.positions) {
        const x = Math.round(xOf(ch)) + 0.5;
        ctx.moveTo(x, padT);
        ctx.lineTo(x, baseY);
      }
      ctx.stroke();
      break;
    }
    case 'density': {
      const { grid, values } = distribution.density;
      const maxV = values.reduce((m, v) => (v > m ? v : m), 0) || 1;
      const yOf = (v: number): number => baseY - (v / maxV) * plotH;
      ctx.beginPath();
      for (let j = 0; j < grid.length; j++) {
        const x = xOf(grid[j]);
        const y = yOf(values[j]);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // Close the path down to the baseline for a soft fill under the curve.
      ctx.lineTo(xOf(grid[grid.length - 1]), baseY);
      ctx.lineTo(xOf(grid[0]), baseY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(15, 110, 86, 0.12)';
      ctx.fill();
      ctx.beginPath();
      for (let j = 0; j < grid.length; j++) {
        const x = xOf(grid[j]);
        const y = yOf(values[j]);
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      break;
    }
    default: {
      // histogram
      const bins = distribution.histogram.bins;
      const maxBin = bins.reduce((m, v) => (v > m ? v : m), 0) || 1;
      const bw = plotW / Math.max(1, bins.length);
      ctx.fillStyle = ACCENT;
      for (let i = 0; i < bins.length; i++) {
        if (bins[i] <= 0) continue;
        const h = (bins[i] / maxBin) * plotH;
        const x = padL + i * bw;
        ctx.fillRect(x + 0.5, baseY - h, Math.max(1, bw - 1), h);
      }
      break;
    }
  }
}

/** Draw the SNIP Peak Clipping stage's chart (`#pfSnipChart`) at one checkpoint INDEX: the static
 * LLS working spectrum plus the traced SNIP-continuum snapshot for that checkpoint (dashed). Both
 * series share ONE auto-scaled Y-axis (they live on the same ~0.5…3 LLS scale). The page lands on
 * the final checkpoint so the teaching moment is the fully-clipped continuum sitting beneath the
 * working curve. Reads only committed data (`llsInput` + `snipTrace`); no engine re-run. No-op until
 * both exist / a snapshot is present. */
function drawPfSnipClip(checkpointIdx: number): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const lls = mgr.llsInput;
  const trace = mgr.snipTrace;
  if (!lls || !trace || trace.snapshotsLls.length === 0) return;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfSnipChart');
  if (!canvas) return;
  const idx = Math.max(0, Math.min(checkpointIdx, trace.snapshotsLls.length - 1));
  const snap = trace.snapshotsLls[idx];
  const C = PF_CONT_COLORS;
  drawSpectrum(
    canvas,
    [
      { values: lls, color: C.input, label: 'LLS working spectrum', width: 1.2, step: true },
      { values: snap, color: C.background, label: 'SNIP continuum (LLS)', width: 1.2, dash: [4, 3] },
    ],
    [],
    { logY: false, xLabel: 'Channel', yLabel: 'LLS', overlays: [] },
  );
}

/** Mount the SNIP Peak Clipping stage: draw the final checkpoint (the completed continuum the page
 * lands on). Static: no zoom/pan binding, so nothing here touches `state.pf.contView` or the other
 * pages' `#pfContChart`. The Clipping-Progress card (①) reports the final iteration's figures from
 * the initial markup and no longer changes -- the discrete iteration stepper has been removed. */
function mountPfSnipStage(): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const trace = mgr.snipTrace;
  if (!trace || trace.checkpoints.length === 0) return;
  drawPfSnipClip(trace.checkpoints.length - 1); // the final checkpoint
}

/** Draw the Net Spectrum stage's comparison chart (`#pfNetChart`) with only the toggled-on series.
 * All three (Raw/Working = dark step, Estimated Background = accent dashed, Net = blue step) share
 * ONE auto-scaled counts Y-axis (same domain). Static full-range, no zoom binding, so nothing here
 * touches `state.pf.contView` or the other pages' `#pfContChart`. An empty `active` set just draws an
 * empty axis (acceptable). No-op until the three arrays exist (the page only reaches focus once the
 * continuum ran). */
function drawPfNetCompare(active: ReadonlySet<PfNetSeries>): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  const input = mgr.selectedInput;
  const background = mgr.backgroundSpectrum;
  const net = mgr.netSpectrum;
  if (!input || !background || !net) return;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfNetChart');
  if (!canvas) return;
  const C = PF_CONT_COLORS;
  const series: ChartSeries[] = [];
  if (active.has('input'))
    series.push({ values: input.counts, color: C.input, label: 'Raw / Working', width: 1.2, step: true });
  if (active.has('background'))
    series.push({ values: background, color: C.background, label: 'Estimated Background', width: 1.2, dash: [4, 3] });
  if (active.has('net'))
    series.push({ values: net, color: C.net, label: 'Net Spectrum', width: 1.2, step: true });
  drawSpectrum(canvas, series, [], { logY: false, xLabel: 'Channel', yLabel: 'counts', overlays: [] });
}

/** Mount the Net Spectrum stage: draw all three series and wire the interactive series toggles.
 * The toggles diverge from the sibling pages' static legend (each `.pf-cont-series[data-series]`
 * click flips `is-on`/`aria-pressed` and redraws the selected view). Static: no zoom/pan binding.
 * Listeners tear down on the next render via {@link pfNetStage}. */
function mountPfNetStage(): void {
  const active = new Set<PfNetSeries>(['input', 'background', 'net']);
  drawPfNetCompare(active);

  // Series toggles: flip visibility + aria-pressed, then redraw the selected view.
  const buttons = Array.from(rootEl.querySelectorAll<HTMLButtonElement>('.pf-cont-series[data-series]'));
  const clickBindings = buttons.map((btn) => {
    const handler = (): void => {
      const key = btn.dataset.series as PfNetSeries | undefined;
      if (key !== 'input' && key !== 'background' && key !== 'net') return;
      const on = !active.has(key);
      if (on) active.add(key);
      else active.delete(key);
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
      drawPfNetCompare(active);
    };
    btn.addEventListener('click', handler);
    return { btn, handler };
  });

  pfNetStage = {
    destroy(): void {
      for (const { btn, handler } of clickBindings) btn.removeEventListener('click', handler);
    },
  };
}

/** Mount the single continuum chart + its zoom/pan binding (the window is now trivially
 * "synchronized" -- one chart). Torn down on the next render (see the `pfContInteractions`
 * cleanup). */
function mountPeakFinderContinuum(): void {
  const mgr = state.pf.manager;
  if (!mgr) return;
  // Focus-driven: the continuum canvas is only in the DOM when its page is focused; guard on
  // the data it needs (the continuum must be computed) rather than the execution phase.
  if (!mgr.selectedInput || !mgr.backgroundSpectrum || !mgr.netSpectrum) return;
  drawPfContinuum();
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfContChart');
  if (!canvas) return;
  pfContInteractions.push(
    mountChartInteraction(canvas, {
      getGeometry: () => pfContGeom,
      getView: () => state.pf.contView,
      setView: (view) => {
        state.pf.contView = view;
        drawPfContinuum();
        syncPfContReset();
      },
    }),
  );
}

/** Enable the continuum Reset-view button only when the shared window is zoomed/panned. */
function syncPfContReset(): void {
  const btn = rootEl.querySelector<HTMLButtonElement>('.pf-cont-reset');
  if (btn) btn.disabled = state.pf.contView === null;
}

/** Preliminary-classification marker colours: line = accent (a genuine line), broad =
 * amber, weak = grey (likely noise). Shared by the classification stage's markers +
 * its inline legend so the two never disagree. */
const PF_CLASS_COLORS: Record<string, string> = {
  line: '#0F6E56',
  broad: '#B26B00',
  weak: '#8A877F',
};

/** Render one PF Run stage onto `canvas`. Peak-Finder-OWNED (Phase 3): unlike the pre-P3
 * path this does NOT call the shared `drawInspectorChart` -- it keys on the PF stage
 * `id` (from {@link PF_RUN_STAGES}), so Calibrate's inspector renderer stays byte-unchanged
 * and the two hosts never couple on a numeric index. The six detection sub-stages are
 * reconstructed from `trace.detected.all` (first-failing `rejectReason`); Fit + Validated
 * reproduce the former inspector cases 4/5 verbatim. No backend/trace change. */
function drawPfStage(canvas: HTMLCanvasElement, stage: number): void {
  const trace = state.pf.manager?.pipelineTrace;
  if (!trace) return;
  const st = state.pf.chart;
  st.stageIndex = clampPfStage(stage);
  const id = PF_RUN_STAGES[st.stageIndex].id;

  // Adopted visual-language colours (mirrors the inspector drawer's palette).
  const ACCENT = '#0F6E56';
  const MUTED = '#6B6A63';
  const GHOST = '#C9C7BF';
  const RUG = 'rgba(107, 106, 99, 0.35)';
  const ALIVE = 'rgba(15, 110, 86, 0.5)'; // candidate still in play at this gate
  const STRUCK = 'rgba(154, 59, 59, 0.55)'; // candidate struck out by THIS gate
  const INK = '#04342C';
  const WARN = '#7A5B12';

  const raw = trace.raw;
  const n = raw.length;
  const background = trace.conditioned?.background ?? null;
  const smoothed = trace.conditioned?.smoothed ?? null;
  const smoothedDisp: readonly number[] =
    smoothed && background ? smoothed.map((v, ch) => v + background[ch]) : raw;

  const rawStep = (color: string, width: number): ChartSeries => ({
    values: raw,
    color,
    label: 'counts',
    width,
    step: true,
  });
  const ghostSmoothed = (): ChartSeries => ({
    values: smoothedDisp,
    color: GHOST,
    label: 'smoothed',
    width: 1,
    step: true,
  });
  const bgLine = (): ChartSeries[] =>
    background ? [{ values: background, color: MUTED, label: 'background', width: 1, dash: [4, 3] }] : [];
  const marks = (chs: readonly number[], color = ACCENT): ChartMarker[] =>
    chs.map((c) => ({ channel: Math.round(c), label: '', color }));

  const all = trace.detected.all;
  type Cand = (typeof all)[number];
  // Cumulative entering sets, from the first-failing rejectReason (order distance ->
  // prominence -> width). Each gate stage shows the set that ENTERED it, striking the
  // ones removed HERE and leaving the rest alive.
  const notDistance = all.filter((d) => d.passed || d.rejectReason !== 'distance');
  const afterProminence = all.filter(
    (d) => d.passed || (d.rejectReason !== 'distance' && d.rejectReason !== 'prominence'),
  );

  let series: ChartSeries[] = [];
  let markers: ChartMarker[] = [];
  let ticks: { channel: number; color: string }[] | undefined;
  let shadedRegions: { x0: number; x1: number; color?: string }[] | undefined;
  // The Peak Fitting stage (`fit`) zooms to the selected peak's decomposition window (P3); set
  // in the `fit` branch and used as the default X window below when the user has not manually
  // panned/zoomed.
  let fitWindow: { xMin: number; xMax: number } | null = null;

  const gateTicks = (entering: readonly Cand[], gate: string): { channel: number; color: string }[] =>
    entering.map((d) => ({
      channel: d.channel,
      color: !d.passed && d.rejectReason === gate ? STRUCK : ALIVE,
    }));

  switch (id) {
    case 'local-maxima': // every strict local maximum, pre-gate, as a neutral rug
      series = [ghostSmoothed()];
      ticks = all.map((d) => ({ channel: d.channel, color: RUG }));
      break;
    case 'distance': // entering = all; distance-struck greyed-red, the rest alive
      series = [ghostSmoothed()];
      ticks = gateTicks(all, 'distance');
      break;
    case 'prominence': // entering = post-distance survivors
      series = [ghostSmoothed()];
      ticks = gateTicks(notDistance, 'prominence');
      break;
    case 'width': // entering = post-prominence survivors; width-struck vs final survivors
      series = [ghostSmoothed()];
      ticks = gateTicks(afterProminence, 'width');
      break;
    case 'strength': // survivors, emphasized + annotated with their significance (SNR)
      series = [ghostSmoothed()];
      markers = trace.detected.survivors.map((d) => ({
        channel: d.channel,
        label: `SNR ${d.significance.toFixed(0)}`,
        color: ACCENT,
      }));
      break;
    case 'classification': // survivors coloured + labelled by preliminary class
      series = [ghostSmoothed()];
      markers = trace.detected.survivors.map((d) => ({
        channel: d.channel,
        label: d.classification,
        color: PF_CLASS_COLORS[d.classification] ?? ACCENT,
      }));
      break;
    case 'fit': {
      // P3 single-peak framing: zoom to the SELECTED fit and draw its decomposition as four
      // toggleable series (Raw / Gaussian / Estimated Continuum / Combined) + an optional
      // Residuals overlay. Every series is a pure display transform of the selected FittedPeak +
      // the continuum array (via deriveFitStats -- same source as the cards). When the selection
      // is unfittable / absent (no decomposition) we fall back to the whole-spectrum kept model.
      const selected = resolveSelectedFit(trace, st.selectedCandidate);
      const stats = deriveFitStats({ selected, background: background ?? [], counts: raw });
      const d = stats.decomposition;
      const ov = state.pf.fitOverlays;
      if (d && stats.shape && selected) {
        const { amplitude, centroidChannel, sigma } = stats.shape;
        const gaussianFull = new Array<number>(n).fill(0);
        const combinedFull = new Array<number>(n).fill(0);
        const residualFull = new Array<number>(n).fill(0);
        for (let ch = 0; ch < n; ch++) {
          const z = (ch - centroidChannel) / sigma;
          const g = amplitude * Math.exp(-0.5 * z * z);
          const b = background ? background[ch] : 0;
          gaussianFull[ch] = g;
          combinedFull[ch] = g + b;
          residualFull[ch] = raw[ch] - (g + b);
        }
        series = [];
        if (ov.raw) series.push(rawStep(GHOST, 1));
        if (ov.continuum && background)
          series.push({
            values: background,
            color: MUTED,
            label: 'Estimated Continuum',
            width: 1,
            dash: [4, 3],
          });
        if (ov.gaussian)
          series.push({ values: gaussianFull, color: ACCENT, label: 'Gaussian Fit', width: 1.25 });
        if (ov.combined)
          series.push({
            values: combinedFull,
            color: INK,
            label: 'Combined Fit',
            width: 1.5,
            step: true,
            fillColor: 'rgba(15, 110, 86, 0.35)',
            ...(background ? { fillTo: background } : {}),
          });
        if (ov.residuals)
          series.push({ values: residualFull, color: WARN, label: 'Residuals', width: 1, step: true });
        // Label the selected peak with its stable table Peak ID, so the zoomed single-peak view
        // names which peak it is (matching the Peak ID column) rather than showing a bare marker.
        markers = [
          { channel: Math.round(centroidChannel), label: `#${fitPeakId(trace, selected.detectedChannel)}`, color: INK },
        ];
        // Keep the selected peak's ±1.5·FWHM measurement window + integration interval shaded.
        const surv = trace.detected.survivors.find((p) => p.channel === selected.detectedChannel);
        if (surv) {
          const hw = Math.max(Math.round(WINDOW_FACTOR * surv.fwhmChannels), MIN_HALF_WINDOW);
          shadedRegions = [
            { x0: surv.channel - hw, x1: surv.channel + hw, color: 'rgba(107, 106, 99, 0.08)' },
            { x0: surv.leftIp, x1: surv.rightIp, color: 'rgba(107, 106, 99, 0.16)' },
          ];
        }
        fitWindow = { xMin: d.lo, xMax: d.hi };
      } else {
        // No fitted selection (unfittable survivor / empty): whole-spectrum kept model, so the
        // stage still shows the overall fit rather than an empty chart.
        const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
        const model = new Array<number>(n);
        for (let ch = 0; ch < n; ch++) model[ch] = background ? background[ch] : 0;
        for (const p of trace.fitted.kept) {
          const sigma = p.fwhmChannels / FWHM_PER_SIGMA;
          if (!(sigma > 0)) continue;
          for (let ch = 0; ch < n; ch++) {
            const z = (ch - p.centroidChannel) / sigma;
            model[ch] += p.amplitude * Math.exp(-0.5 * z * z);
          }
        }
        series = [
          rawStep(GHOST, 1),
          ...bgLine(),
          {
            values: model,
            color: ACCENT,
            label: 'fit',
            width: 1.25,
            step: true,
            fillColor: 'rgba(15, 110, 86, 0.6)',
            ...(background ? { fillTo: background } : {}),
          },
        ];
        markers = marks(trace.fitted.kept.map((p) => p.centroidChannel));
      }
      break;
    }
    case 'validated': {
      // Single-peak framing mirroring `fit`, but coloured by the VALIDATION VERDICT: the selected
      // peak's Gaussian / combined model + marker turn warning-coloured when the peak is FLAGGED,
      // so the chart shows WHY a peak passed or failed (design §Existing Graph). Every series is a
      // pure display transform of the selected FittedPeak + the continuum (via deriveFitStats --
      // same source as the cards); the verdict comes from `trace.validated`. When there is no
      // fitted selection we fall back to whole-spectrum validated markers (accepted vs flagged).
      const verdict = resolveSelectedValidated(trace, st.selectedCandidate);
      const selectedPeak = verdict?.peak ?? null;
      const isFlagged = verdict != null && !verdict.valid;
      const stats = deriveFitStats({ selected: selectedPeak, background: background ?? [], counts: raw });
      const d = stats.decomposition;
      const ov = state.pf.fitOverlays;
      const PEAK = isFlagged ? WARN : ACCENT; // Gaussian stroke
      const PEAK_INK = isFlagged ? WARN : INK; // combined + marker
      if (d && stats.shape && selectedPeak) {
        const { amplitude, centroidChannel, sigma } = stats.shape;
        const gaussianFull = new Array<number>(n).fill(0);
        const combinedFull = new Array<number>(n).fill(0);
        const residualFull = new Array<number>(n).fill(0);
        for (let ch = 0; ch < n; ch++) {
          const z = (ch - centroidChannel) / sigma;
          const g = amplitude * Math.exp(-0.5 * z * z);
          const b = background ? background[ch] : 0;
          gaussianFull[ch] = g;
          combinedFull[ch] = g + b;
          residualFull[ch] = raw[ch] - (g + b);
        }
        series = [];
        if (ov.raw) series.push(rawStep(GHOST, 1));
        if (ov.continuum && background)
          series.push({
            values: background,
            color: MUTED,
            label: 'Estimated Continuum',
            width: 1,
            dash: [4, 3],
          });
        if (ov.gaussian)
          series.push({
            values: gaussianFull,
            color: PEAK,
            label: isFlagged ? 'Gaussian Fit (flagged)' : 'Gaussian Fit',
            width: 1.25,
          });
        if (ov.combined)
          series.push({
            values: combinedFull,
            color: PEAK_INK,
            label: 'Combined Fit',
            width: 1.5,
            step: true,
            fillColor: isFlagged ? 'rgba(122, 91, 18, 0.28)' : 'rgba(15, 110, 86, 0.35)',
            ...(background ? { fillTo: background } : {}),
          });
        if (ov.residuals)
          series.push({ values: residualFull, color: WARN, label: 'Residuals', width: 1, step: true });
        markers = [
          { channel: Math.round(centroidChannel), label: isFlagged ? 'flagged' : '', color: PEAK_INK },
        ];
        // (No `fitWindow` here: the Review chart defaults to the full range -- see `effWindow` below.)
      } else {
        // No fitted selection: whole-spectrum validated markers, accepted vs flagged coloured.
        series = [rawStep(GHOST, 1)];
        markers = trace.validated.map((v) => ({
          channel: Math.round(v.peak.centroidChannel),
          label: '',
          color: v.valid ? ACCENT : WARN,
        }));
      }
      break;
    }
  }

  // Unfittable survivors (GAP-07): amber markers with their reason on Fit + Validated.
  if (id === 'fit' || id === 'validated') {
    for (const u of trace.fitted.unfittable) {
      markers.push({ channel: Math.round(u.detectedChannel), label: u.reason, color: WARN });
    }
  }
  // Click-to-inspect selection: a single emphasized dark marker at the selected channel.
  if (st.selectedCandidate != null) {
    markers.push({ channel: Math.round(st.selectedCandidate), label: '', color: INK });
  }

  // The `fit` stage defaults to the selected peak's window (P3) until the user manually
  // pans/zooms (which sets `st.view` and takes over); other stages -- including the `validated`
  // Review chart -- default to the full range. (The `validated` stage must NOT auto-zoom: its
  // displayed window would then diverge from the interaction layer's `getView()` == null, so the
  // first wheel-zoom is computed against the full range and snaps the view, stranding the user.)
  const effWindow = st.view ?? (id === 'fit' ? fitWindow : null);
  const view = effWindow
    ? { ...effWindow, ...fitYToWindow(series.map((s) => s.values), effWindow) }
    : undefined;
  st.geometry =
    drawSpectrum(canvas, series, markers, {
      logY: state.logY,
      xLabel: 'Channel',
      yLabel: 'counts',
      overlays: [],
      ...(ticks ? { ticks } : {}),
      ...(shadedRegions ? { shadedRegions } : {}),
      ...(view ? { view } : {}),
    }) ?? null;
}

/** Draw the Final Review hero graph (`#pfReviewChart`): the FULL raw spectrum with EVERY validated
 * peak marked (accepted green / rejected amber), plus optional Continuum + whole-spectrum Gaussian
 * model overlays and per-peak ID labels (all toggled via `state.pf.reviewOverlays`). Selecting a
 * peak (chart click or table row) adds an emphasised marker and frames that peak's window. Unlike
 * {@link drawPfStage} (per-peak decomposition), this shows the overall result -- the "what were the
 * final peaks?" view. Pure display transform of the committed trace (Principle 9); no re-run.
 *
 * Follows the getView-vs-effWindow rule (see the chart-view desync fix): when a peak is selected we
 * auto-frame its window while `st.view` stays null, and `getView()` surfaces that same window from
 * the drawn geometry, so zoom/pan never strands the user. A full-range draw returns null. */
function drawPfReviewHero(canvas: HTMLCanvasElement): void {
  const trace = state.pf.manager?.pipelineTrace;
  if (!trace) return;
  const st = state.pf.chart;
  const ov = state.pf.reviewOverlays;

  const RAW = '#3F3E38';
  const ACCENT = '#0F6E56';
  const MUTED = '#6B6A63';
  const INK = '#04342C';

  const raw = trace.raw;
  const n = raw.length;
  const background = trace.conditioned?.background ?? null;
  // The final Review shows ONLY the peaks that qualified validation (accepted); flagged peaks are
  // not part of the final result. IDs are numbered over the accepted set, matching the table.
  const acceptedRows = deriveReviewPeakRows(trace.validated.filter((v) => v.valid));
  const acceptedPeaks = trace.validated.filter((v) => v.valid).map((v) => v.peak);

  const series: ChartSeries[] = [
    { values: raw, color: RAW, label: 'counts', width: 1, step: true },
  ];
  if (ov.continuum && background)
    series.push({
      values: background,
      color: MUTED,
      label: 'Estimated Continuum',
      width: 1,
      dash: [4, 3],
    });
  if (ov.gaussian) {
    // The fitted model: the continuum plus every ACCEPTED peak's Gaussian.
    const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
    const model = new Array<number>(n);
    for (let ch = 0; ch < n; ch++) model[ch] = background ? background[ch] : 0;
    for (const p of acceptedPeaks) {
      const sigma = p.fwhmChannels / FWHM_PER_SIGMA;
      if (!(sigma > 0)) continue;
      for (let ch = 0; ch < n; ch++) {
        const z = (ch - p.centroidChannel) / sigma;
        model[ch] += p.amplitude * Math.exp(-0.5 * z * z);
      }
    }
    series.push({
      values: model,
      color: ACCENT,
      label: 'Gaussian Fits',
      width: 1.25,
      step: true,
      fillColor: 'rgba(15, 110, 86, 0.28)',
      ...(background ? { fillTo: background } : {}),
    });
  }

  // One marker per ACCEPTED peak (green), ID-labelled to match the table IDs.
  const markers: ChartMarker[] = [];
  for (const r of acceptedRows) {
    markers.push({
      channel: r.channel,
      label: ov.labels ? `#${r.id}` : '',
      color: ACCENT,
    });
  }
  // Emphasised selection marker + auto-frame the selected peak's window (accepted peaks only).
  let frame: { xMin: number; xMax: number } | null = null;
  if (st.selectedCandidate != null) {
    const selCh = Math.round(st.selectedCandidate);
    const sel = acceptedPeaks.find((p) => Math.round(p.detectedChannel) === selCh);
    if (sel) {
      markers.push({ channel: selCh, label: '', color: INK });
      const fwhm = Number.isFinite(sel.fwhmChannels) ? sel.fwhmChannels : 12;
      const hw = Math.max(Math.round(fwhm * 6), 24);
      frame = { xMin: Math.max(0, selCh - hw), xMax: Math.min(n - 1, selCh + hw) };
    }
  }

  const effWindow = st.view ?? frame;
  const view = effWindow
    ? { ...effWindow, ...fitYToWindow(series.map((s) => s.values), effWindow) }
    : undefined;
  st.geometry =
    drawSpectrum(canvas, series, markers, {
      logY: state.logY,
      xLabel: 'Channel',
      yLabel: 'counts',
      overlays: [],
      ...(view ? { view } : {}),
    }) ?? null;
}

/** Draw the Peak Fitting stage's Residual Analysis chart (`#pfFitResidualChart`, P4): the
 * per-channel residual `raw − combined` over the SELECTED peak's window, on a fixed zero
 * baseline. A good fit scatters residuals about zero; systematic structure reveals model
 * inadequacy. Linear-only (residuals go negative, so a log axis is meaningless) and
 * independent of the main chart's pan/zoom — its window is the decomposition window of the
 * currently selected fit, with symmetric y-bounds so zero sits mid-chart. Every value is a
 * pure display transform of the selected FittedPeak + the continuum array (via
 * `deriveFitStats` — the same source as the cards and the main chart). No-op when the canvas
 * is absent (any non-fit stage); clears the canvas when the selection is unfittable/absent
 * (no decomposition — there is no residual to show). */
function drawPfFitResidual(): void {
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#pfFitResidualChart');
  if (!canvas) return;
  const trace = state.pf.manager?.pipelineTrace;
  if (!trace) return;
  const background = trace.conditioned?.background ?? [];
  const selected = resolveSelectedFit(trace, state.pf.chart.selectedCandidate);
  const stats = deriveFitStats({ selected, background, counts: trace.raw });
  const d = stats.decomposition;
  if (!d) {
    // Unfittable / no selection: no residual exists. Clear so a stale plot from a previous
    // (fitted) selection never lingers behind the "—" RMS.
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round((canvas.clientWidth || 1) * dpr);
      canvas.height = Math.round((canvas.clientHeight || 1) * dpr);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }
  const n = trace.raw.length;
  const WARN = '#7A5B12';
  const MUTED = '#6B6A63';
  // Full-length series (so the shared channel-indexed view model applies), viewed to the window.
  const residualFull = new Array<number>(n).fill(0);
  const zeroFull = new Array<number>(n).fill(0);
  for (let i = 0; i < d.channels.length; i++) residualFull[d.channels[i]] = d.residual[i];
  // Symmetric bounds so the zero baseline sits mid-chart; guard the flat-window case.
  let maxAbs = 0;
  for (const r of d.residual) maxAbs = Math.max(maxAbs, Math.abs(r));
  const M = (maxAbs > 0 ? maxAbs : 1) * 1.15;
  const series: ChartSeries[] = [
    { values: zeroFull, color: MUTED, label: 'zero', width: 1, dash: [3, 3] },
    { values: residualFull, color: WARN, label: 'residual', width: 1.25, step: true },
  ];
  drawSpectrum(canvas, series, [], {
    logY: false, // residuals go negative -- a log axis is meaningless here
    xLabel: 'Channel',
    yLabel: 'raw − model',
    view: { xMin: d.lo, xMax: d.hi, yMin: -M, yMax: M },
  });
}

/** Enable the Reset-view button only when the chart is zoomed/panned. */
function syncPfResetButton(): void {
  const btn = rootEl.querySelector<HTMLButtonElement>('.pf-reset');
  if (btn) btn.disabled = state.pf.chart.view === null;
}

// --- Calibrate mode: Source Manager + Execution Stepper (manager-driven) ----

/** The single {@link CalibrationManager}, created + subscribed on first Calibrate
 * mount. The subscriber drives the stepper during the timed reveal and re-renders
 * on every structural change. */
function ensureManager(): CalibrationManager {
  if (state.calib.manager) return state.calib.manager;
  const mgr = createCalibrationManager();
  mgr.subscribe(() => onManagerNotify(mgr));
  state.calib.manager = mgr;
  return mgr;
}

/** Manager notification. During the reveal (`running`) only the visible stage
 * advances -- drive the existing stage-view handle, no full re-render. The
 * collecting->running transition (when no handle exists yet) and every other
 * transition fall through to a full re-render. Ignored when the Calibrate view is
 * not mounted (a timer that outlived a navigation away). */
function onManagerNotify(mgr: CalibrationManager): void {
  if (state.view !== 'calibrate') return;
  const phase = mgr.phase;
  if (phase.kind === 'running' && stageViewHandle) {
    stageViewHandle.showStage(phase.stageIndex);
    refreshBuildChrome(mgr); // advance the rail + card with the reveal (no full render)
    return;
  }
  render();
}

/** During the timed reveal, patch the grouped stepper's rail + active-step card in
 * place so they track the engine's current stage without a full re-render (which
 * would remount StageView every ~800 ms tick). The canvas itself is driven by
 * `stageViewHandle.showStage`; only the two chrome nodes are replaced here. The
 * replaced nodes carry no click handlers, which is correct while `running` -- the
 * reveal owns position and the rail is non-interactive until `done` re-renders. */
function refreshBuildChrome(mgr: CalibrationManager): void {
  if (state.calib.mode !== 'builder') return;
  const model = deriveBuildSteps({
    phase: mgr.phase,
    ready: mgr.ready,
    hasResult: mgr.result != null,
    configStep: state.calib.configStep,
    stageIndex: state.calib.stageIndex,
    reviewView: mgr.reviewView,
    configComplete: configCompleteFor(mgr),
  });
  const railEl = rootEl.querySelector('.step-film');
  if (railEl) {
    railEl.outerHTML = buildStepperRailMarkup(model);
    // The rail was replaced wholesale, so its footer + step listeners were lost -- re-bind
    // them (mirrors refreshIdentifyChrome / wirePfRailActions). During the reveal the
    // reveal owns position and forward steps stay locked/inert, so this is safe.
    wireBuildRailActions(mgr);
  }
  const cardEl = rootEl.querySelector('.build-step-card');
  if (cardEl) cardEl.outerHTML = activeStepCardMarkup(model);
  // Track the bottom `.step-nav` progress readout with the reveal cursor too -- text only;
  // the buttons (and their handlers) are untouched and stay disabled while running.
  const label = activeStepLabel(model);
  const progressEl = rootEl.querySelector('.step-progress');
  if (label && progressEl) progressEl.textContent = buildProgressText(label);
}

/** Calibrate mode renders ONE of two distinct surfaces by `state.calib.mode`: the
 * Calibration Manager (saved calibrations only) or the Build Calibration flow (the
 * creation form as Stage 1 -> engine run -> review/save). Each surface emits its
 * own <h1>; there is no page-level Back button (the shell toolbar #home is the way
 * out of Calibrate). */
function calibrateBody(): string {
  const mgr = ensureManager();
  if (state.calib.mode === 'manager') return managerSurfaceMarkup();
  return builderSurfaceMarkup(mgr);
}

/** Calibration Library surface: the saved-calibrations library only (no creation
 * form, no Back button). When empty, both entry points (Add synthetic demo / New
 * calibration) live in the onboarding card; when populated, only "New calibration"
 * shows, in the page header (top-right). */
function managerSurfaceMarkup(): string {
  const library = getCalibrationLibrary();
  // New calibration lives in the page header only when the library has entries
  // (populated state). When empty, both entry points live in the onboarding card.
  const headerNew = library.items.length
    ? `<button id="calLibNew" class="btn btn-primary" type="button">New calibration</button>`
    : '';
  return `
    <div class="cal-manager-head">
      <div class="cal-manager-titles">
        <span class="cal-manager-eyebrow">Calibrate Mode</span>
        <h1 class="page-title">Calibration Library</h1>
        <p class="cal-manager-subtitle">Manage saved calibration equations, inspect fit quality, and choose the active equation for Identify Mode.</p>
      </div>
      ${headerNew}
    </div>
    ${savedCalibrationsMarkup()}`;
}

/** Configure sub-step count (Load / Identities / Model / Create) and Run stage
 * count (the 8 engine stages). Named so the toolbar position math has no magic
 * numbers; they mirror the static step model in `buildStepper.ts`. */
const CONFIG_STEP_COUNT = 4;
const RUN_STAGE_COUNT = 8;
/** Configure sub-step ids in order, mapping a rail id to its `configStep` index.
 * Mirrors the static Configure metadata in `buildStepper.ts`. */
const CONFIG_STEP_IDS = ['cfg-load', 'cfg-identity', 'cfg-model', 'cfg-create'] as const;

/* The `#calInspect` "Inspect Peak Detection" header entry (Phase 5) is RETIRED
 * (Declare-Identities Phase 3): the inspector is no longer a separate
 * destination -- its evidence is embedded in the active-source surface
 * (`mountActiveSourceInspector`), so `activeStepCardMarkup` takes its default
 * empty header action. */

/** Cumulative completion of the four Configure steps (load / identity / model /
 * create-gate). The single source of truth the rail derivation, the active-step
 * clamp, and the Prev/Next toolbar all read, so sequential gating stays consistent.
 * Cumulative by construction (each predicate ANDs the previous), satisfying the
 * monotonic contract `deriveBuildSteps` expects. */
function configCompleteFor(mgr: CalibrationManager): boolean[] {
  const hasSources = mgr.sources.length > 0;
  // The "Assign energies" step (cfg-identity) is complete once enough peaks carry an
  // assigned energy to fit -- `mgr.ready` (>= MIN_FIT_POINTS assigned across all sources).
  // Model then Create follow, both still gated by the same readiness.
  const assignDone = hasSources && mgr.ready;
  const modelDone = assignDone && state.calib.modelChosen;
  const createDone = modelDone && mgr.ready;
  return [hasSources, assignDone, modelDone, createDone];
}

/** Highest reachable Configure index given cumulative completion: the first
 * incomplete step (capped at the last index). */
function reachableConfigMax(configComplete: readonly boolean[]): number {
  let leading = 0;
  while (leading < CONFIG_STEP_COUNT && configComplete[leading]) leading++;
  return Math.min(leading, CONFIG_STEP_COUNT - 1);
}

/** Build Calibration surface: the grouped stepper in Peak Finder's `.step-*` shell. The
 * left `.step-film` rail (`buildStepperRailMarkup`) lists all 13 steps across the three
 * groups Configure / Run / Review with padlocks; the scrolling `.step-main` shows the
 * active-step card (`activeStepCardMarkup`) over the active step's body, with the `.step-nav`
 * Prev/Next toolbar beneath. The body is routed by the active step id: the four Configure
 * bodies, the Run StageView (`stepperMarkup`), or the Review summary. The `error` phase
 * shows the honest engine message in the panel with the rail parked on Configure. The whole
 * flow is one continuous guided experience (Configure -> auto-advance into Run ->
 * auto-advance into Review), all derived from `mgr`. */
function builderSurfaceMarkup(mgr: CalibrationManager): string {
  const configComplete = configCompleteFor(mgr);
  // Clamp the stored Configure position back if an earlier step became incomplete
  // (e.g. the operator removed all sources), so the rail, card, and toolbar agree.
  if (mgr.phase.kind === 'collecting' || mgr.phase.kind === 'error') {
    state.calib.configStep = Math.min(state.calib.configStep, reachableConfigMax(configComplete));
  }
  const model = deriveBuildSteps({
    phase: mgr.phase,
    ready: mgr.ready,
    hasResult: mgr.result != null,
    configStep: state.calib.configStep,
    stageIndex: state.calib.stageIndex,
    reviewView: mgr.reviewView,
    configComplete,
  });
  const isError = mgr.phase.kind === 'error';
  const card = isError ? '' : activeStepCardMarkup(model);
  // Peak Finder `.step-*` flex-shell (2026-07-07 DOM convergence -- the same migration
  // HANDOFF_IDENTIFY_PF_DOM.md ran on Identify, now on the Calibrate builder). Gated by
  // body.mode-peak-finder in render(): a viewport-height column of fixed chrome (the
  // `.step-topbar` brand+nav, the embedded `.dev-banner`, and the `.step-nav` bottom
  // toolbar) around a single scrolling `.step-main`. The rail is the `.step-film`
  // film-strip (`buildStepperRailMarkup`); the panel body flows as a direct child of
  // `.step-main` after the active-step card (no inner scroller wrapper -- `.step-main`
  // IS the scroller), mirroring Peak Finder / Identify. The "Saved calibrations" exit
  // moved into the rail's `.step-film-actions` footer. `#calBrandHome` (the top-bar
  // logo) routes to landing; the nav shows the sibling views.
  const calNav: View[] = ['peak-finder', 'batch', 'identify', 'resources', 'project-status'];
  return `
    <div class="step-app">
      <div class="step-topbar">
        <button class="brand" id="calBrandHome" type="button" aria-label="Nuclid home">
          <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
            <title>Nuclid</title>
            <g transform="translate(8,10)">
              <rect width="52" height="52" rx="12" fill="#0F6E56"/>
              <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
              <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
            </g>
            <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
          </svg>
        </button>
        <nav class="toolbar-nav" aria-label="Platform navigation">
          ${calNav
            .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
            .join('')}
        </nav>
      </div>
      <div class="dev-banner" role="status">under development - numbers are not yet validated</div>
      <div class="step-body">
        ${buildStepperRailMarkup(model)}
        <section class="step-main">
          ${card}
          ${buildPanelBodyMarkup(mgr, model)}
        </section>
      </div>
      ${buildToolbarMarkup(mgr, model)}
    </div>`;
}

/** Route the active step id to its panel body. Reuses the existing surfaces
 * unchanged in substance: the four Configure bodies (slices of the old Source
 * Manager), the Run StageView shell (`stepperMarkup`), and the Review summary. */
function buildPanelBodyMarkup(mgr: CalibrationManager, model: BuildStepModel): string {
  if (mgr.phase.kind === 'error') return stepperErrorMarkup(mgr.phase.message);
  const id = model.steps[model.activeIndex]?.id ?? 'cfg-load';
  switch (id) {
    case 'cfg-load':
      return configLoadMarkup(mgr);
    case 'cfg-identity':
      return configIdentityMarkup(mgr);
    case 'cfg-model':
      return configModelMarkup(mgr);
    case 'cfg-create':
      return configCreateMarkup(mgr);
    case 'review':
      return reviewSummaryMarkup(mgr);
    default:
      return stepperMarkup(mgr); // run-0..run-7
  }
}

/** The bottom navigation toolbar in Peak Finder's `.step-nav` grammar (2026-07-07 DOM
 * convergence): the `#buildPrev .step-prev` button, a centred `.step-progress` readout
 * ("{Group} · Step n of N · {Step}", from `buildProgressText`), and the `#buildNext
 * .step-next primary` button (its label becomes "Create calibration →" on the Create gate).
 * On the error phase there is no active step, so the progress readout is empty and both
 * buttons disable. Prev/Next IDs + disabled logic are preserved verbatim. */
function buildToolbarMarkup(mgr: CalibrationManager, model: BuildStepModel): string {
  const kind = mgr.phase.kind;
  let prevDisabled = false;
  let nextDisabled = false;
  let onCreate = false;
  if (kind === 'error' || kind === 'running') {
    prevDisabled = true;
    nextDisabled = true;
  } else if (kind === 'collecting') {
    const cc = configCompleteFor(mgr);
    const cur = state.calib.configStep;
    prevDisabled = cur <= 0;
    onCreate = cur >= CONFIG_STEP_COUNT - 1;
    // Next from Create needs a ready batch; on any earlier step it needs THAT step
    // complete (sequential gating) before the next sub-step unlocks.
    nextDisabled = onCreate ? !mgr.ready : !cc[cur];
  } else {
    // done: position 0..7 = Run stages, RUN_STAGE_COUNT = Review summary.
    const pos = mgr.reviewView === 'summary' ? RUN_STAGE_COUNT : clampStage(state.calib.stageIndex);
    prevDisabled = pos <= 0;
    nextDisabled = pos >= RUN_STAGE_COUNT;
  }
  // The Create gate keeps its "Create calibration →" label (Peak Finder has no gate);
  // everything else adopts Peak Finder's `.step-nav` grammar. On the error phase there is
  // no active step, so the centred progress readout is empty and both buttons disable.
  const nextLabel = onCreate ? 'Create calibration &rarr;' : 'Next &rarr;';
  const label = kind === 'error' ? null : activeStepLabel(model);
  const progress = label ? escapeHtml(buildProgressText(label)) : '';
  return `
    <div class="step-nav">
      <button id="buildPrev" class="step-prev" type="button" ${prevDisabled ? 'disabled' : ''}>&larr; Prev</button>
      <span class="step-progress">${progress}</span>
      <button id="buildNext" class="step-next primary" type="button" ${nextDisabled ? 'disabled' : ''}>${nextLabel}</button>
    </div>`;
}

/** The `.step-nav` centred readout for the Calibrate builder: "{group} · Step n of N ·
 * {step}". Mirrors {@link identProgressText}; the group prefix is kept (the pipeline
 * still reads as Configure / Run / Review), while n/N are the GLOBAL 1..13 position from
 * {@link activeStepLabel}, matching the `.step-film` rail badges. The single source both
 * the bottom-nav markup and the reveal-time chrome patch ({@link refreshBuildChrome})
 * read. */
function buildProgressText(label: { group: string; n: number; N: number; name: string }): string {
  return `${label.group} · Step ${label.n} of ${label.N} · ${label.name}`;
}

/** Clamp a Run stage index into 0..RUN_STAGE_COUNT-1 (shared by the toolbar + the
 * rail-click navigation). */
function clampStage(i: number): number {
  return Math.min(Math.max(0, Math.floor(i)), RUN_STAGE_COUNT - 1);
}

/** Run `mgr.build()` from Configure (the Create button or Next-from-Create). Resets
 * the Run/Configure positions for the fresh run, mirroring the old `#calBuild`
 * handler. The collecting->running structural transition needs a full render to
 * mount the StageView panel. */
function doBuild(mgr: CalibrationManager): void {
  if (!mgr.ready) return;
  state.calib.stageIndex = 0;
  state.calib.configStep = 0;
  state.calib.saved = null;
  mgr.build(); // emits running | error
  render();
}

/** Navigate the grouped rail to a step by id. `cfg-*` moves the Configure sub-step;
 * `run-N` enters the walkthrough at stage N (only when `done`); `review` returns to
 * the summary. Locked steps never reach here (the delegation excludes
 * `[aria-disabled]`). */
function goToBuildStep(id: string, mgr: CalibrationManager): void {
  if (id.startsWith('cfg-')) {
    const idx = (CONFIG_STEP_IDS as readonly string[]).indexOf(id);
    if (idx >= 0) state.calib.configStep = idx;
    render();
  } else if (id.startsWith('run-')) {
    if (mgr.phase.kind !== 'done') return; // Run locked during the reveal
    state.calib.stageIndex = clampStage(Number(id.slice(4)));
    if (mgr.reviewView !== 'walkthrough') mgr.setReviewView('walkthrough'); // emits -> render
    else render(); // already in the walkthrough; re-render to move the stage
  } else if (id === 'review') {
    if (mgr.reviewView !== 'summary') mgr.setReviewView('summary'); // emits -> render
    else render();
  }
}

/** Bottom toolbar Prev/Next. Within Configure it walks the four sub-steps (Next from
 * Create builds when ready); during `running` it is inert (engine owns position); on
 * `done` it walks the eight Run stages then the Review summary. Clamps at both ends
 * (no wrapping). */
function buildNavStep(mgr: CalibrationManager, dir: -1 | 1): void {
  const kind = mgr.phase.kind;
  if (kind === 'error' || kind === 'running') return;
  if (kind === 'collecting') {
    const cur = state.calib.configStep;
    if (dir === 1) {
      if (cur >= CONFIG_STEP_COUNT - 1) {
        doBuild(mgr); // Next from Create -> build (no-op when not ready)
        return;
      }
      // Sequential gating: advance only when the current step is complete.
      if (!configCompleteFor(mgr)[cur]) return;
      state.calib.configStep = cur + 1;
      render();
      return;
    }
    // Prev: always allowed (earlier steps are reachable); clamp at the first step.
    if (cur <= 0) return;
    state.calib.configStep = cur - 1;
    render();
    return;
  }
  // done: position 0..7 = Run stages, RUN_STAGE_COUNT = Review summary.
  const pos = mgr.reviewView === 'summary' ? RUN_STAGE_COUNT : clampStage(state.calib.stageIndex);
  const next = Math.min(Math.max(0, pos + dir), RUN_STAGE_COUNT);
  if (next === pos) return;
  if (next === RUN_STAGE_COUNT) {
    if (mgr.reviewView !== 'summary') mgr.setReviewView('summary');
    else render();
  } else {
    state.calib.stageIndex = next;
    if (mgr.reviewView !== 'walkthrough') mgr.setReviewView('walkthrough');
    else render();
  }
}

/** Muted empty-state body for Configure steps 2-4 before any source is loaded. */
function emptyConfigHint(): string {
  return `<div class="cfg-step"><p class="muted sm-empty">Load a source first.</p></div>`;
}

/** Configure step 1 -- Load sources: renders file-management rows only (filename +
 * Remove). The upload controls (file loader, sample picker, synthetic demo) stay
 * visible; the dropzone is the empty state, replaced by the file list once a source
 * exists. Identity assignment lives in the Declare identities step (step 2). */
function configLoadMarkup(mgr: CalibrationManager): string {
  const loadError = state.calib.loadError
    ? `<div class="disclaimer">${escapeHtml(state.calib.loadError)}</div>`
    : '';
  // The dropzone is the EMPTY state: shown only before the first source. Once a
  // source exists, the file list (filename + Remove) occupies that space instead.
  // Both carry `id="calDrop"` so the existing drag-and-drop handlers bind in either
  // state (drag-to-add keeps working over the populated list).
  const area = mgr.sources.length
    ? `<div id="calDrop" class="sm-droparea">${batchListMarkup(mgr, 'load')}</div>`
    : `<div id="calDrop" class="sm-dropzone">Drag &amp; drop spectrum files here</div>`;
  return `
    <div class="cfg-step">
      <p class="sm-objective">Add one or more known-source spectra to calibrate from.</p>
      <div class="sm-loader">
        <label class="btn">
          <input id="calFile" type="file" accept=".tka,.csv,.txt,.spe" multiple hidden />
          Load spectrum files
        </label>
        <select id="calSample" class="select" aria-label="Add a real demo source">
          <option value="">Real source...</option>
          ${SAMPLE_FILES.map((f) => `<option value="${f}">${f}</option>`).join('')}
        </select>
        <button id="calDemo" class="btn btn-ghost" type="button">Add synthetic demo</button>
      </div>
      ${loadError}
      ${area}
    </div>`;
}

/* The standalone `.inspector-mount` (Phase 5's provisional fixed mount below the
 * batch list on Load + Declare) is RETIRED (Declare-Identities Phase 3): the
 * evidence now lives INSIDE the active-source surface (`.di-evidence` in
 * declareIdentities.ts), mounted by `mountActiveSourceInspector`. */

/** Configure step 2 -- Declare identities (Phase 2): the spectrum navigator +
 * active-source assignment surface (`declareIdentities.ts`), with the readiness
 * gate hint while inputs are incomplete. The identity select inside the active
 * surface keeps the exact `.br-identity` + `data-row` markup, so the existing
 * change handler binds unchanged. Assignments are captured only -- Build still
 * runs the two-pass auto-matcher (the calibrateFromMatches switch is Phase 4). */
function configIdentityMarkup(mgr: CalibrationManager): string {
  if (!mgr.sources.length) return emptyConfigHint();
  const gate = mgr.ready
    ? ''
    : `<span class="sm-gate muted">${escapeHtml(mgr.gateMessage ?? '')}</span>`;
  return `
    <div class="cfg-step">
      <p class="sm-objective">Declare each source's identity, then assign a known energy to its detected peaks. These assignments are the calibration points.</p>
      ${declareIdentitiesMarkup(mgr, state.calib.assignSelectedPeak)}
      ${gate}
    </div>`;
}

/** Configure step 3 -- Select model: the 3-way Linear / Quadratic / Auto selector. */
function configModelMarkup(mgr: CalibrationManager): string {
  if (!mgr.sources.length) return emptyConfigHint();
  return `
    <div class="cfg-step">
      <p class="sm-objective">Choose how channel maps to energy.</p>
      <div class="sm-model">
        <span class="sm-model-label">Model</span>
        ${modelSelectorMarkup(mgr)}
        <span class="sm-model-hint muted">Auto picks linear or quadratic from the curvature.</span>
      </div>
    </div>`;
}

/** Configure step 4 -- Create calibration: a short inputs recap + the readiness-gated
 * Create button. Reuses `#calBuild` (the existing handler fires on the same id). */
function configCreateMarkup(mgr: CalibrationManager): string {
  if (!mgr.sources.length) return emptyConfigHint();
  const declared = mgr.sources.filter((s) => s.sourceId).length;
  const undeclared = mgr.sources.length - declared;
  let anchorLines = 0;
  for (const s of mgr.sources) {
    const entry = CALIBRATION_KIT.entries.find((e) => e.id === s.sourceId);
    if (entry) anchorLines += entry.lines.filter((l) => l.tier === 'anchor').length;
  }
  const fittedPeaks = mgr.sources.reduce((n, s) => n + s.fittedPeaks.length, 0);
  const modelLabel = mgr.model.charAt(0).toUpperCase() + mgr.model.slice(1);
  const gate = mgr.ready
    ? ''
    : `<span class="sm-gate muted">${escapeHtml(mgr.gateMessage ?? '')}</span>`;
  return `
    <div class="cfg-step">
      <p class="sm-objective">Review the inputs, then build the calibration.</p>
      <dl class="cfg-recap">
        <div><dt>Sources</dt><dd>${mgr.sources.length}</dd></div>
        <div><dt>Declared identities</dt><dd>${declared}${undeclared ? ` (${undeclared} undeclared)` : ''}</dd></div>
        <div><dt>Anchor lines</dt><dd>${anchorLines}</dd></div>
        <div><dt>Fitted peaks</dt><dd>${fittedPeaks}</dd></div>
        <div><dt>Model</dt><dd>${escapeHtml(modelLabel)}</dd></div>
      </dl>
      <div class="sm-build">
        <button id="calBuild" class="btn btn-primary" type="button" ${mgr.ready ? '' : 'disabled'}>
          Create calibration
        </button>
        ${gate}
      </div>
    </div>`;
}

/** Saved-calibrations panel -- the operator's view of every calibration persisted
 * on this device/account, with Activate / Delete. This is the whole Calibration
 * Manager surface body; both its empty and populated states offer the two entry
 * points into the Build flow. Fail-loud: a corrupt store surfaces as an error
 * banner over the last-good list rather than wiping it. */
function savedCalibrationsMarkup(): string {
  const library = getCalibrationLibrary();
  const error = library.error
    ? `<div class="disclaimer">${escapeHtml(library.error)}</div>`
    : '';
  const items = library.items;
  if (!items.length) return emptyLibraryMarkup(error);
  return populatedLibraryMarkup(library);
}

// --- Scenario 1: populated library (two-panel landing) ----------------------

/** rms below this (keV) reads as a "Good fit"; at/above it the detail flags
 * "Check fit" (amber). The C3 synthetic-generality bar was rms < 3 keV across the
 * full range, so that is the honest good/needs-a-look boundary here. */
const GOOD_FIT_MAX_RMS_KEV = 3.0;
/** Residual bar: the longest |residual| still leaves headroom (never 100% wide). */
const RESID_BAR_HEADROOM = 1.15;
/** Residual bar: a non-zero residual is always visibly wide (percent). */
const RESID_BAR_MIN_PCT = 4;
/** Residual bar denominator floor so an all-zero residual set never divides by 0. */
const RESID_BAR_EPS = 1e-9;

/** The used (kept) anchor points of a result -- the ones that entered the fit.
 * Mirrors `calibrateStages.usedPoints` (reads `result.linear.points`, the shared
 * matched set). */
function usedAnchorPoints(result: CalibrationResult): readonly CalibrationPoint[] {
  return result.linear.points.filter((p) => p.used);
}

/** `±{rms} keV`, or an em-dash when the record carries no rms (never `NaN`). */
function rmsLabel(cal: Calibration): string {
  return cal.rms != null && Number.isFinite(cal.rms) ? `±${cal.rms.toFixed(1)} keV` : '—';
}

/** Capitalised model label, e.g. "Linear" / "Quadratic". */
function modelLabel(cal: Calibration): string {
  return cal.model.charAt(0).toUpperCase() + cal.model.slice(1);
}

/** Long equation form for the detail card: `E = c0 + c1 · channel (+ c2 · channel²)`. */
function equationDisplay(cal: Calibration): string {
  const c = cal.coefficients;
  let s = `E = ${c[0].toFixed(3)} + ${c[1].toFixed(4)} · channel`;
  if (c.length > 2) s += ` + ${c[2].toExponential(2)} · channel²`;
  return s;
}

/** Short equation form for a card metrics row: `E = c0 + c1·ch (+ c2·ch²)`. */
function equationShort(cal: Calibration): string {
  const c = cal.coefficients;
  let s = `E = ${c[0].toFixed(2)} + ${c[1].toFixed(4)}·ch`;
  if (c.length > 2) s += ` + ${c[2].toExponential(1)}·ch²`;
  return s;
}

/** The lowercase haystack a library search matches against (name, sources, model,
 * locale date, ISO day). */
function libraryHaystack(r: StoredCalibration): string {
  const model = activeCalibration(r.result).model;
  return [
    r.name,
    r.sources.join(' '),
    model,
    new Date(r.created).toLocaleDateString(),
    r.created.slice(0, 10),
  ]
    .join(' ')
    .toLowerCase();
}

/** Pure selector: the NON-active rows to show in "Other saved equations", after
 * filter -> search -> sort. The active record is pinned separately and never
 * appears here. Exported for headless unit tests (Scope C). */
export function selectLibraryRows(
  items: readonly StoredCalibration[],
  activeId: string | null,
  view: LibraryView,
): StoredCalibration[] {
  const nonActive = items.filter((r) => r.id !== activeId);
  // filter
  let rows: StoredCalibration[];
  if (view.filter === 'active') {
    rows = []; // "Active only" hides the Other list (the active card is pinned).
  } else if (view.filter === 'linear' || view.filter === 'quadratic') {
    rows = nonActive.filter((r) => activeCalibration(r.result).model === view.filter);
  } else {
    rows = [...nonActive];
  }
  // search (case-insensitive substring)
  const q = view.query.trim().toLowerCase();
  if (q) rows = rows.filter((r) => libraryHaystack(r).includes(q));
  // sort (`items` is already newest-first from the store)
  if (view.sort === 'oldest') {
    rows.reverse();
  } else if (view.sort === 'residual') {
    const rms = (r: StoredCalibration): number => {
      const v = activeCalibration(r.result).rms;
      return v != null && Number.isFinite(v) ? v : Infinity; // undefined sorts last
    };
    rows.sort((a, b) => rms(a) - rms(b)); // stable (ES2019+)
  }
  return rows;
}

/** One saved-calibration card. Active -> mint, "In use" badge, metrics row + the
 * four actions; inactive -> the copy region itself is the "View details" trigger,
 * with Set active / Delete in the action row. Every action carries the record id. */
function calLibCardMarkup(
  record: StoredCalibration,
  isActive: boolean,
  isSelected = false,
): string {
  const result = record.result;
  const cal = activeCalibration(result);
  const n = usedAnchorPoints(result).length;
  const createdTime = new Date(record.created).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  const meta = `Created ${escapeHtml(createdTime)} · ${modelLabel(cal)} · ${n} anchor lines`;
  const id = escapeHtml(record.id);
  const name = escapeHtml(record.name);
  // Whole-card selection: a transparent cover button (carrying .cal-act-view) is the
  // single click+keyboard target over the card; only .cal-card-actions sits above it.
  const cover = `<button class="cal-card-cover cal-act-view" type="button" data-id="${id}"
        aria-label="View details for ${name}"${isSelected ? ' aria-current="true"' : ''}></button>`;
  if (isActive) {
    return `
      <div class="cal-card cal-card--active">
        ${cover}
        <div class="cal-card-top">
          <div class="cal-card-copy">
            <span class="cal-card-name">${name}</span>
            <span class="cal-card-meta muted">${meta}</span>
          </div>
          <span class="cal-badge">In use</span>
        </div>
        <div class="cal-card-metrics">
          <span class="cal-card-eq">${escapeHtml(equationShort(cal))}</span>
          <span class="cal-card-rms">${rmsLabel(cal)}</span>
        </div>
        <div class="cal-card-actions">
          <button class="btn btn-primary cal-act-identify" type="button" data-id="${id}">Open in Identify Mode</button>
          <button class="btn btn-ghost cal-act-export" type="button" data-id="${id}">Export</button>
          <button class="btn btn-ghost cal-act-dup" type="button" data-id="${id}">Duplicate</button>
          <button class="btn btn-ghost cal-act-delete" type="button" data-id="${id}">Delete</button>
        </div>
      </div>`;
  }
  return `
    <div class="cal-card cal-card--inactive${isSelected ? ' cal-card--selected' : ''}">
      ${cover}
      <div class="cal-card-top">
        <div class="cal-card-copy">
          <span class="cal-card-name">${name}</span>
          <span class="cal-card-meta muted">${meta}</span>
        </div>
        <span class="cal-card-rms muted">${rmsLabel(cal)}</span>
      </div>
      <div class="cal-card-actions">
        <button class="btn btn-ghost cal-act-setactive" type="button" data-id="${id}">Set active</button>
        <button class="btn btn-ghost cal-act-delete" type="button" data-id="${id}">Delete</button>
      </div>
    </div>`;
}

/** Right detail panel for one record: header, equation card + fit pill, the
 * residual-by-anchor mini-chart, the anchor-lines table, and the two actions. All
 * numbers are derived from the record's own `CalibrationResult` (Rule 12). */
function detailPanelMarkup(record: StoredCalibration, isActiveDetail: boolean): string {
  const result = record.result;
  const cal = activeCalibration(result);
  const eyebrow = isActiveDetail ? 'ACTIVE CALIBRATION' : 'SELECTED CALIBRATION';
  const title = isActiveDetail ? 'Active calibration details' : 'Review before activation';
  const desc = isActiveDetail
    ? 'Shown by default when the page loads and no other saved equation is selected.'
    : 'A saved equation should show its sources, anchor lines, residuals, and validation notes before it becomes active.';
  const id = escapeHtml(record.id);
  // Primary action: the active record opens Identify; a reviewed (non-active) record
  // is promoted with "Set active" (Scenario 2).
  const primaryAction = isActiveDetail
    ? `<button id="calLibDetailIdentify" class="btn btn-primary" type="button" data-id="${id}">Open in Identify Mode</button>`
    : `<button id="calLibDetailSetActive" class="btn btn-primary" type="button" data-id="${id}">Set active</button>`;
  const good = cal.rms != null && Number.isFinite(cal.rms) && cal.rms <= GOOD_FIT_MAX_RMS_KEV;
  const fitPill = good
    ? '<span class="cal-fit-pill is-good">Good fit</span>'
    : '<span class="cal-fit-pill is-check">Check fit</span>';
  const meanResid =
    cal.rms != null && Number.isFinite(cal.rms)
      ? `Mean residual ±${cal.rms.toFixed(1)} keV`
      : 'Mean residual —';

  // The DISPLAYED model's own point set (DEBT-21): residual bars and the anchor
  // table must describe the equation shown above them. The card meta count keeps
  // usedAnchorPoints (the shared linear matched set, mirroring calibrateStages).
  const points = cal.points.filter((p) => p.used);
  const resids = points.map((p) => p.energyKeV - applyCalibrationToChannel(cal, p.channel));
  const barMax = Math.max(RESID_BAR_EPS, ...resids.map((r) => Math.abs(r))) * RESID_BAR_HEADROOM;
  const residRows = points
    .map((p, i) => {
      const ar = Math.abs(resids[i]);
      const pct = Math.min(100, Math.max(RESID_BAR_MIN_PCT, (ar / barMax) * 100));
      return `<div class="cal-resid-row">
        <span class="cal-resid-label">${escapeHtml(p.sourceId ?? p.sourceLabel)}</span>
        <span class="cal-resid-track"><span class="cal-resid-bar" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="cal-resid-val">${ar.toFixed(1)}</span>
      </div>`;
    })
    .join('');
  const anchorRows = points
    .map(
      (p) => `<div class="cal-anchor-row">
        <span>${escapeHtml(p.sourceId ?? p.sourceLabel)}</span>
        <span>${p.energyKeV.toFixed(1)}</span>
        <span>${p.channel.toFixed(0)}</span>
      </div>`,
    )
    .join('');
  return `
    <aside class="cal-detail-panel">
      <div class="cal-detail-head">
        <span class="cal-eyebrow">${eyebrow}</span>
        <h2 class="cal-panel-title">${title}</h2>
        <p class="cal-panel-sub muted">${desc}</p>
      </div>
      <div class="cal-eq-card">
        <span class="cal-eq-label muted">Equation</span>
        <span class="cal-eq-str">${escapeHtml(equationDisplay(cal))}</span>
        <div class="cal-eq-quality">
          ${fitPill}
          <span class="cal-eq-resid muted">${meanResid}</span>
        </div>
      </div>
      <div class="cal-resid">
        <span class="cal-resid-title">Residual by anchor line</span>
        ${residRows || '<span class="muted cal-empty-line">No anchor lines on this record.</span>'}
      </div>
      <div class="cal-anchor-table">
        <div class="cal-anchor-head"><span>Source</span><span>Energy</span><span>Channel</span></div>
        ${anchorRows}
      </div>
      <div class="cal-detail-actions">
        ${primaryAction}
        <button id="calLibDetailExport" class="btn btn-ghost" type="button" data-id="${id}">Export</button>
      </div>
    </aside>`;
}

/** `<option>` with `selected` set when it is the current value. */
function selectOption(value: string, label: string, current: string): string {
  return `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`;
}

/** The populated two-panel landing (Scenario 1): left saved-calibrations panel
 * (count + toolbar + pinned active card + filtered Other list), right detail panel
 * (the selected record, else the active, else the first). */
function populatedLibraryMarkup(library: CalibrationLibrary): string {
  const items = library.items;
  const activeId = library.activeId;
  const view = state.calib.library;
  const error = library.error ? `<div class="disclaimer">${escapeHtml(library.error)}</div>` : '';

  const activeRecord = items.find((r) => r.id === activeId) ?? null;
  let detail: StoredCalibration | null = null;
  if (view.selectedId) detail = items.find((r) => r.id === view.selectedId) ?? null;
  if (!detail) detail = activeRecord ?? items[0] ?? null;
  const otherRows = selectLibraryRows(items, activeId, view);

  const activeSection = activeRecord
    ? calLibCardMarkup(activeRecord, true)
    : `<div class="cal-card cal-note-card"><span class="muted">No active calibration — set one to use Identify Mode.</span></div>`;
  // Inline "set another active first" prompt (Scenario 2). Derived from live state so
  // it self-hides if the operator instead deletes others down to one, or re-points.
  const blockActiveDelete =
    view.pendingActiveDeleteId != null &&
    view.pendingActiveDeleteId === activeId &&
    items.length > 1;
  const activeDeleteNote = blockActiveDelete
    ? `<div class="cal-active-delete-note" role="status">
         <span>To delete the active calibration, make another calibration active first
         (use “Set active” below), then delete it.</span>
         <button id="calActiveDeleteCancel" class="btn-link" type="button">Cancel</button>
       </div>`
    : '';
  const otherSection = otherRows.length
    ? otherRows.map((r) => calLibCardMarkup(r, false, r.id === view.selectedId)).join('')
    : '<p class="muted cal-empty-line">No matching calibrations.</p>';
  const detailSection = detail
    ? detailPanelMarkup(detail, detail.id === activeId)
    : '<aside class="cal-detail-panel"><p class="muted cal-empty-line">Select a calibration to preview.</p></aside>';

  return `
    <section class="cal-library">
      ${error}
      <div class="cal-workspace">
        <div class="cal-saved-panel">
          <div class="cal-saved-titlerow">
            <h2 class="cal-panel-title">Saved calibrations</h2>
            <span class="cal-count-pill">${items.length} saved</span>
          </div>
          <div class="cal-toolbar">
            <input id="calLibSearch" class="cal-search" type="text" placeholder="Search by source, model, or date…" value="${escapeHtml(view.query)}" aria-label="Search saved calibrations" />
            <select id="calLibFilter" class="cal-select" aria-label="Filter by model">
              ${selectOption('all', 'All models', view.filter)}${selectOption('linear', 'Linear', view.filter)}${selectOption('quadratic', 'Quadratic', view.filter)}${selectOption('active', 'Active only', view.filter)}
            </select>
            <select id="calLibSort" class="cal-select" aria-label="Sort order">
              ${selectOption('newest', 'Newest', view.sort)}${selectOption('oldest', 'Oldest', view.sort)}${selectOption('residual', 'Lowest residual', view.sort)}
            </select>
          </div>
          <div class="cal-section-label"><span class="cal-section-name">Active calibration</span><span class="muted">Currently used by Identify Mode</span></div>
          ${activeSection}
          ${activeDeleteNote}
          <div class="cal-section-label"><span class="cal-section-name cal-section-name--muted">Other saved equations</span><span class="muted">Scroll here when the list grows</span></div>
          <div class="cal-other-list">${otherSection}</div>
        </div>
        ${detailSection}
      </div>
    </section>`;
}

/** Scenario 3 empty state -- the two-panel onboarding workspace shown when no
 * calibration is saved: a left "Saved calibrations" panel with a centred empty
 * card (two entry actions) and a right read-only "Calibration workflow" guide.
 * `error` is the already-escaped fail-loud store banner from the caller. */
function emptyLibraryMarkup(error: string): string {
  return `
    <section class="cal-library">
      ${error}
      <div class="cal-workspace">
        <div class="cal-saved-panel">
          <div class="cal-saved-head">
            <h2 class="cal-panel-title">Saved calibrations</h2>
            <p class="cal-panel-sub muted">Create your first calibration to generate an energy calibration equation. Saved calibrations will appear here.</p>
          </div>
          <div class="cal-empty-card">
            <h3 class="cal-empty-title">No saved calibrations</h3>
            <p class="cal-empty-copy muted">Create a calibration from known-source spectra before using Identify Mode with real spectrum files.</p>
            <div class="cal-empty-actions">
              <button id="calLibDemo" class="btn btn-ghost" type="button">Add synthetic demo</button>
              <button id="calLibNew" class="btn btn-primary" type="button">New calibration</button>
            </div>
          </div>
        </div>
        <aside class="cal-workflow-panel">
          <div class="cal-workflow-head">
            <span class="cal-eyebrow">Calibration workflow</span>
            <h2 class="cal-panel-title">Calibration workflow</h2>
            <p class="cal-panel-sub muted">Once you create a calibration, Nuclid will guide you through three steps.</p>
          </div>
          <div class="cal-workflow-intro">
            <p class="cal-intro-kicker">Before Identify Mode can use real spectra</p>
            <p class="cal-intro-body">Build one saved energy calibration equation from known-source anchor peaks.</p>
          </div>
          <ol class="cal-steps">
            <li class="cal-step"><span class="cal-step-num">1</span><div class="cal-step-copy"><span class="cal-step-title">Load source spectrum</span><span class="cal-step-sub muted">Import a known-source spectrum file.</span></div></li>
            <li class="cal-step"><span class="cal-step-num">2</span><div class="cal-step-copy"><span class="cal-step-title">Match anchor peaks</span><span class="cal-step-sub muted">Pair channels with known gamma energies.</span></div></li>
            <li class="cal-step"><span class="cal-step-num">3</span><div class="cal-step-copy"><span class="cal-step-title">Fit and save equation</span><span class="cal-step-sub muted">Generate the calibration and store it here.</span></div></li>
          </ol>
        </aside>
      </div>
    </section>`;
}


/** The batch list, scoped by Configure step: `'load'` rows manage the dataset
 * (filename + Remove); `'identity'` rows assign identities (filename + identity +
 * peaks + QC). Default `'identity'` for safety; both call sites pass it explicitly. */
function batchListMarkup(mgr: CalibrationManager, mode: 'load' | 'identity' = 'identity'): string {
  if (!mgr.sources.length) {
    return `<p class="muted sm-empty">No sources yet. Add one or more known spectra above.</p>`;
  }
  return `<ul class="batch-list">${mgr.sources.map((s) => batchRowMarkup(s, mode)).join('')}</ul>`;
}

/** One batch row, by mode. `'load'`: filename + Remove only (dataset management).
 * `'identity'`: filename + the editable identity select (Rule 12, prefilled from the
 * filename suggestion) + the passive four-state status (PPI Phase 2, read from
 * `deriveSpectrumStatus` -- never re-derived, Principle 9) + a QC expand (no Remove).
 * Class names, `data-row`, ids, and ARIA on whichever controls are present are
 * unchanged, so the existing handlers bind without modification.
 * Exported for tests only (same seam as `selectLibraryRows`). */
export function batchRowMarkup(s: ManagedSource, mode: 'load' | 'identity' = 'identity'): string {
  if (mode === 'load') {
    return `
    <li class="batch-row batch-row--load" data-row="${s.rowId}">
      <span class="br-file" title="${escapeHtml(s.fileName)}">${escapeHtml(s.fileName)}</span>
      <button class="btn btn-ghost br-remove" type="button" data-row="${s.rowId}">Remove</button>
    </li>`;
  }
  const opts = CALIBRATION_KIT.entries
    .map(
      (e) =>
        `<option value="${e.id}" ${s.sourceId === e.id ? 'selected' : ''}>${escapeHtml(e.displayName)} (${e.id})</option>`,
    )
    .join('');
  const expanded = state.calib.expandedRowId === s.rowId;
  const qc = expanded
    ? `<div class="br-qc">
         <div class="br-qc-head">
           <button class="btn btn-ghost br-qc-reset" type="button" ${state.calib.qcView ? '' : 'disabled'}>Reset view</button>
         </div>
         <canvas id="calQc" class="br-chart"></canvas>
         <div class="br-qc-chip" hidden></div>
       </div>`
    : '';
  // Peak Pipeline Inspector (Phase 1): an additive, default-collapsed disclosure
  // built live from the committed PipelineTrace contract -- independent of the QC
  // chart above. A user who never expands sees only the one-line summary.
  const trace = buildPipelineTrace(s.report);
  // PPI Phase 2: the card's passive status, read once from the Phase-1 signal
  // contract (single source of truth -- state, label AND any displayed peak
  // count come from here, never re-derived; `s.fittedPeaks` stays engine/gate-only).
  // PPI Phase 5 cutover: cards are STATUS-ONLY (Principle 8) -- the per-card
  // inspect button and per-row workspace mount are gone; the single entry point
  // lives in the Build toolbar and mounts at the fixed `.inspector-mount`.
  const status = deriveSpectrumStatus(s.report);
  return `
    <li class="batch-row batch-row--identity" data-row="${s.rowId}">
      <span class="br-file" title="${escapeHtml(s.fileName)}">${escapeHtml(s.fileName)}</span>
      <select class="select br-identity" data-row="${s.rowId}" aria-label="Declared identity">
        <option value="" ${s.sourceId ? '' : 'selected'}>Declare identity...</option>
        ${opts}
      </select>
      <span class="br-peaks br-status br-status--${status.state}"
        aria-label="${escapeHtml(`Status: ${status.label} (${status.state})`)}">${escapeHtml(status.label)}</span>
      <button class="btn btn-ghost br-expand" type="button" data-row="${s.rowId}"
        aria-pressed="${expanded}">${expanded ? 'Hide' : 'QC'}</button>
      <p class="br-summary muted">${trace.detected.all.length} local maxima &rarr; ${status.peakCount} peaks</p>
      ${qc}
    </li>`;
}

/* The Peak Pipeline Inspector's stage list, legend, candidate-fate, and panel
 * markup moved verbatim to `inspectorWorkspace.ts` (Phase 3: the container-
 * agnostic workspace owns markup + draw + handlers + state shape). */

/** The 3-way Linear / Quadratic / Auto model selector (default Auto), reusing the
 * shared `.segmented` / `.seg` component (DR-4). */
function modelSelectorMarkup(mgr: CalibrationManager): string {
  const opts: { id: ModelChoice; label: string }[] = [
    { id: 'linear', label: 'Linear' },
    { id: 'quadratic', label: 'Quadratic' },
    { id: 'auto', label: 'Auto' },
  ];
  return `
    <div class="model-seg segmented" role="group" aria-label="Calibration model">
      ${opts
        .map(
          (o) =>
            `<button class="seg ${mgr.model === o.id ? 'active' : ''}" type="button"
              data-cal-model="${o.id}" aria-pressed="${mgr.model === o.id}">${o.label}</button>`,
        )
        .join('')}
    </div>`;
}

/** Stage B -- the Execution Stepper (running | done). The stage-view shell is
 * mounted into `#calibStageRoot` by {@link mountCalibStages}; while running the
 * `.stepper-running` class locks the rail/nav (the engine owns position). The
 * global amber disclaimer (RISK-01) is shown once here; per-stage caveats live
 * inside the stages. On `done`: the model flip, New batch, and the Save panel. */
function stepperMarkup(mgr: CalibrationManager): string {
  const done = mgr.phase.kind === 'done';
  const running = mgr.phase.kind === 'running';
  const hasQuad = mgr.result?.quadratic != null;
  const controls = done
    ? `<div class="model-switch segmented" role="group" aria-label="Calibration model">
        <button class="seg ${mgr.viewModel === 'linear' ? 'active' : ''}" type="button" data-flip="linear"
          aria-pressed="${mgr.viewModel === 'linear'}">Linear</button>
        <button class="seg ${mgr.viewModel === 'quadratic' ? 'active' : ''}" type="button" data-flip="quadratic"
          aria-pressed="${mgr.viewModel === 'quadratic'}" ${hasQuad ? '' : 'disabled'}>Quadratic</button>
      </div>
      <button id="calBackToReview" class="btn btn-primary" type="button">&larr; Back to review</button>
      <button id="calNewBatch" class="btn" type="button">New batch</button>`
    : `<span class="stepper-status muted">Running calibration...</span>`;
  return `
    <section class="exec-stepper">
      <div class="disclaimer">Unvalidated calibration -- for demonstration only.</div>
      <div class="stepper-head">
        <h2 class="page-h2">Calibration walkthrough</h2>
        <div class="stepper-controls">${controls}</div>
      </div>
      <div id="calibStageRoot" class="card${running ? ' stepper-running' : ''}"></div>
    </section>`;
}

/** The Save & activate panel (shown on `done`): an editable name + Save, a route
 * back to the Calibration Manager (always available so the operator can return
 * whether or not a save has happened), and -- once saved -- a confirmation and an
 * offer to jump to Identify (gated behind the successful save). */
function savePanelMarkup(): string {
  const saved = state.calib.saved;
  const confirm = saved
    ? `<p class="saved-ok">Saved "${escapeHtml(saved.name)}" and set active.</p>
       <button id="calToIdentify" class="btn" type="button">Go to Identify</button>`
    : '';
  return `
    <div class="save-panel">
      <input id="calName" class="select cal-name" type="text" value="${escapeHtml(defaultCalName())}"
        aria-label="Calibration name" />
      <button id="calSave" class="btn btn-primary" type="button">Save calibration</button>
      <button id="calToManager" class="btn" type="button">Back to Saved Calibrations</button>
      ${confirm}
    </div>`;
}

// --- Review summary (the dedicated `done` surface) --------------------------

/** Below this anchor-tier count the fit rests on too few strong lines to be
 * trustworthy -> a caveat. Mirrors the engine's MIN_ANCHOR_LINES hard gate: at the
 * gate (2) it builds, but fewer than that as KEPT anchors is worth flagging. */
const LOW_ANCHOR_COUNT = 2;
/** A calibrated span narrower than this (keV) is a caveat: the kit reaches
 * ~60-1400 keV, so a sub-200 keV fitted range leaves most of the spectrum as
 * extrapolation (named threshold, not a magic number). */
const NARROW_VALID_RANGE_KEV = 200;

/** Capitalise a calibration model name for display, e.g. `linear` -> `Linear`. */
function modelTitle(cal: Calibration): string {
  return cal.model.charAt(0).toUpperCase() + cal.model.slice(1);
}

/** `lo–hi keV` for a valid range, or an em-dash when absent (never `NaN keV`). */
function rangeLabel(cal: Calibration): string {
  const r = cal.validRange;
  return r ? `${r[0].toFixed(0)}–${r[1].toFixed(0)} keV` : '—';
}

/** `{v} keV` to 2 dp, or em-dash when the metric is absent/non-finite. */
function keV2(v: number | undefined): string {
  return v != null && Number.isFinite(v) ? `${v.toFixed(2)} keV` : '—';
}

/** Stage B (Review) -- the dedicated at-a-glance summary the operator reads to
 * confirm the result before saving. A static decision surface (NOT the auto-
 * advancing walkthrough): result header, one hero plot, fit quality, the full
 * points table (kept/rejected), an inputs recap, the caveats panel, and the model
 * toggle + Save controls. The 8-stage walkthrough stays reachable via the explicit
 * "View walkthrough" link. All numbers derive from the in-memory `mgr.result`
 * (Rule 12); nothing is recomputed here. */
function reviewSummaryMarkup(mgr: CalibrationManager): string {
  const result = mgr.result;
  if (!result) {
    // Defensive: `done` implies a built result; never fabricate one.
    return `<section class="exec-stepper"><div class="disclaimer">No calibration result to review.</div></section>`;
  }
  const cal = displayedCal(result, mgr.viewModel);
  const points = cal.points;
  const kept = points.filter((p) => p.used);
  const dropped = points.filter((p) => !p.used);
  const anchorsKept = kept.filter((p) => p.tier === 'anchor').length;
  const resid = (p: CalibrationPoint): number => p.energyKeV - applyCalibrationToChannel(cal, p.channel);

  // 1. Result header.
  const header = `
    <div class="review-head">
      <div class="review-head-main">
        <span class="review-eyebrow">Review</span>
        <h2 class="review-model">${escapeHtml(modelTitle(cal))} calibration</h2>
        <span class="review-eq">${escapeHtml(equationString(cal))}</span>
      </div>
      <dl class="review-headline">
        <div><dt>Valid range</dt><dd>${rangeLabel(cal)}</dd></div>
        <div><dt>RMS</dt><dd>${keV2(cal.rms)}</dd></div>
        <div><dt>Worst residual</dt><dd>${keV2(cal.maxAbsResidual)}</dd></div>
      </dl>
    </div>`;

  // 2. Hero plot -- mounted into this node by mountReviewHero (own canvas).
  const hero = `<div id="calibReviewHero" class="review-hero card"></div>`;

  // 3. Fit quality at a glance.
  const decision = result.selectionFellBack
    ? `Quadratic requested but too few points (&lt;4) — fell back to <strong>linear</strong>.`
    : `Selected <strong>${escapeHtml(result.selected)}</strong> (curvature ${result.curvatureSignificance.toFixed(1)}σ).`;
  const quality = `
    <div class="review-quality card">
      <h3 class="review-section-title">Fit quality</h3>
      <dl class="review-quality-grid">
        <div><dt>RMS</dt><dd>${keV2(cal.rms)}</dd></div>
        <div><dt>R²</dt><dd>${cal.rSquared.toFixed(5)}</dd></div>
        <div><dt>Points used</dt><dd>${usedPoints(result).length} / ${cal.points.length}</dd></div>
      </dl>
      <p class="review-decision muted">${decision}</p>
    </div>`;

  // 4. Points table -- every matched line, kept (teal) or rejected (amber).
  const rows = points
    .map((p) => {
      const cls = p.used ? 'review-pt review-pt--kept' : 'review-pt review-pt--dropped';
      const status = p.used ? 'Kept' : 'Rejected';
      const note = p.note ? `<span class="review-pt-note muted">${escapeHtml(p.note)}</span>` : '';
      return `<tr class="${cls}">
        <td>${p.channel.toFixed(1)}</td>
        <td>${p.energyKeV.toFixed(1)}</td>
        <td>${escapeHtml(p.sourceId ?? p.sourceLabel)}</td>
        <td>${escapeHtml(p.tier ?? '—')}</td>
        <td class="review-pt-resid">${resid(p).toFixed(2)}</td>
        <td>${status}${note}</td>
      </tr>`;
    })
    .join('');
  const table = `
    <div class="review-points card">
      <h3 class="review-section-title">Points (${kept.length} kept · ${dropped.length} rejected)</h3>
      <table class="review-table">
        <thead><tr>
          <th>Channel</th><th>Energy (keV)</th><th>Source</th><th>Tier</th>
          <th>Residual (keV)</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // 5. Inputs recap -- which source identities + anchor/secondary line counts.
  const bySource = new Map<string, { anchor: number; secondary: number }>();
  for (const p of points) {
    const id = p.sourceId ?? p.sourceLabel;
    const e = bySource.get(id) ?? { anchor: 0, secondary: 0 };
    if (p.tier === 'anchor') e.anchor += 1;
    else if (p.tier === 'secondary') e.secondary += 1;
    bySource.set(id, e);
  }
  const recapRows = [...bySource.entries()]
    .map(
      ([id, c]) =>
        `<li><span class="review-recap-id">${escapeHtml(id)}</span><span class="muted">${c.anchor} anchor · ${c.secondary} secondary</span></li>`,
    )
    .join('');
  const recap = `
    <div class="review-recap card">
      <h3 class="review-section-title">Inputs</h3>
      <ul class="review-recap-list">${recapRows}</ul>
    </div>`;

  // 6. Caveats / flags -- the scattered per-stage warnings gathered in one place.
  const flags: string[] = [];
  if (dropped.length) {
    const reasons = [...new Set(dropped.map((p) => p.note).filter(Boolean))].join('; ');
    flags.push(
      `${dropped.length} point(s) dropped from the fit${reasons ? ` (${escapeHtml(reasons)})` : ''}.`,
    );
  }
  if (anchorsKept < LOW_ANCHOR_COUNT) {
    flags.push(`Only ${anchorsKept} anchor line(s) kept — fewer than ${LOW_ANCHOR_COUNT} is weak evidence.`);
  }
  const r = cal.validRange;
  if (r && r[1] - r[0] < NARROW_VALID_RANGE_KEV) {
    flags.push(
      `Narrow valid range (${(r[1] - r[0]).toFixed(0)} keV) — most of the spectrum is extrapolation.`,
    );
  }
  if (result.selectionFellBack) {
    flags.push('Quadratic was requested but unavailable (<4 points); using linear.');
  }
  const flagItems = flags.map((f) => `<li class="flag-caveat">${f}</li>`).join('');
  const caveats = `
    <div class="review-caveats card">
      <h3 class="review-section-title">Caveats</h3>
      <ul class="review-caveat-list">${flagItems}</ul>
      <p class="flag-caveat review-disclaimer">Unvalidated calibration — for demonstration only.</p>
    </div>`;

  // 7. Model toggle + Save controls. 8. View walkthrough link.
  const hasQuad = result.quadratic != null;
  const controls = `
    <div class="review-controls">
      <div class="model-switch segmented" role="group" aria-label="Calibration model">
        <button class="seg ${mgr.viewModel === 'linear' ? 'active' : ''}" type="button" data-flip="linear"
          aria-pressed="${mgr.viewModel === 'linear'}">Linear</button>
        <button class="seg ${mgr.viewModel === 'quadratic' ? 'active' : ''}" type="button" data-flip="quadratic"
          aria-pressed="${mgr.viewModel === 'quadratic'}" ${hasQuad ? '' : 'disabled'}>Quadratic</button>
      </div>
      <button id="calViewWalkthrough" class="btn" type="button">View walkthrough →</button>
      <button id="calNewBatch" class="btn" type="button">New batch</button>
    </div>
    ${savePanelMarkup()}`;

  return `
    <section class="review-summary">
      ${header}
      ${hero}
      <div class="review-grid">
        ${quality}
        ${recap}
      </div>
      ${table}
      ${caveats}
      ${controls}
    </section>`;
}

/** The engine ValidationError surface (under-anchored batch): the honest message
 * plus two escape routes so the operator is never trapped -- back to Stage 1 (batch
 * preserved) and out to the Calibration Manager (batch discarded, via the shared
 * `#calBuilderCancel` control). */
function stepperErrorMarkup(message: string): string {
  return `
    <section class="exec-stepper">
      <div class="disclaimer">${escapeHtml(message)}</div>
      <div class="stepper-controls">
        <button id="calBackToSources" class="btn" type="button">Back to sources</button>
        <button id="calBuilderCancel" class="btn" type="button">&larr; Saved calibrations</button>
      </div>
    </section>`;
}

// --- A1d: identify walkthrough markup --------------------------------------

const CAVEAT_LABEL: Record<string, string> = {
  [CAVEAT_SINGLE_LINE]: 'Top match rests on a single line -- weaker evidence than a multi-line fingerprint.',
  [CAVEAT_MISSING_STRONG]: 'Top match is missing one or more of its strong (expected) lines.',
  [CAVEAT_ARTIFACT_PEAK]:
    'Top match relies on a peak flagged as a detector artifact (511 keV / escape).',
};

const VERDICT_CLASS: Record<string, string> = {
  STRONG: 'strong',
  TENTATIVE: 'tentative',
  WEAK: 'weak',
};

/** The Identify result card (verdict + stats + caveats + ranked candidates), reused
 * by `identifyReviewMarkup` as the Review summary's core. Reads the live mirror on
 * `state.ident` (synced from the manager). */
function identifyResultMarkup(result: IdentificationResult, summary: IdentificationSummary): string {
  const id = state.ident;
  const top = result.ranked[0] ?? null;
  const confident = top != null && top.verdict !== 'WEAK';

  const disclaimer = `<div class="disclaimer">Unvalidated calibration "${escapeHtml(id.calName)}" applied --
    for demonstration only.</div>`;

  if (!confident) {
    // Honest no-confident-ID (includes GAP-04 / out-of-library / noise inputs).
    return `
      <div class="result-card no-match">
        ${disclaimer}
        <p class="rc-noid">No confident identification.</p>
        <p class="muted">${
          top
            ? `Best candidate ${escapeHtml(top.nuclide.displayName)} scored ${top.score.toFixed(2)} (WEAK) -- below the confidence bar.`
            : 'Nothing in the library scored above the matching floor for these energies.'
        }</p>
        ${rankedListMarkup(result, id.overlayId)}
      </div>`;
  }

  const photopeak = strongestMatchedPeak(top);
  const stats = photopeak
    ? `<dt>Photopeak</dt><dd>${photopeak.energyKeV.toFixed(1)} keV</dd>
       <dt>FWHM</dt><dd>${photopeak.fwhmKeV.toFixed(2)} keV</dd>
       <dt>Net area</dt><dd>${Math.round(photopeak.peak.netArea)} counts</dd>`
    : '';
  const caveats = summary.caveats.length
    ? `<ul class="caveats">${summary.caveats
        .map((c) => `<li class="flag-caveat">${escapeHtml(CAVEAT_LABEL[c] ?? c)}</li>`)
        .join('')}</ul>`
    : '';

  return `
    <div class="result-card ident-result">
      ${disclaimer}
      <div class="rc-head">
        <span class="rc-name">${escapeHtml(top.nuclide.displayName)}</span>
        <span class="chip">identified</span>
        <span class="confidence ${VERDICT_CLASS[top.verdict]}">${top.verdict}</span>
      </div>
      <dl class="meta rc-stats">
        <dt>Score</dt><dd>${top.score.toFixed(3)}</dd>
        <dt>Completeness</dt><dd>${(top.completeness * 100).toFixed(0)} %</dd>
        <dt>Coverage</dt><dd>${(top.coverage * 100).toFixed(0)} %</dd>
        ${stats}
      </dl>
      ${caveats}
      ${rankedListMarkup(result, id.overlayId)}
    </div>`;
}

/** The strongest (highest-intensity) matched line's measured peak -- the
 * "photopeak" whose energy/FWHM/net-area the result card reports. */
function strongestMatchedPeak(iso: IdentificationResult['ranked'][number]): EnergisedPeak | null {
  let best: EnergisedPeak | null = null;
  let bestI = -Infinity;
  for (const m of iso.matchedLines) {
    if (m.line.intensity > bestI) {
      bestI = m.line.intensity;
      best = m.measured;
    }
  }
  return best;
}

/** The ranked candidates with score + verdict, and a per-row "overlay" toggle so
 * the operator can choose which isotope's lines are drawn (default = top). */
function rankedListMarkup(result: IdentificationResult, overlayId: string | null): string {
  if (!result.ranked.length) return '';
  const rows = result.ranked
    .map((m, i) => {
      const active = (overlayId ?? result.ranked[0].nuclide.id) === m.nuclide.id;
      return `<li class="rank-row ${active ? 'rank-active' : ''}">
        <span class="rank-i">${i + 1}</span>
        <button class="rank-name btn-link" type="button" data-overlay="${escapeHtml(m.nuclide.id)}"
          aria-pressed="${active}" title="Overlay this isotope's lines">${escapeHtml(m.nuclide.displayName)}</button>
        <span class="rank-score">${m.score.toFixed(2)}</span>
        <span class="confidence ${VERDICT_CLASS[m.verdict]}">${m.verdict}</span>
      </li>`;
    })
    .join('');
  return `
    <h3 class="ranked-h">Ranked candidates</h3>
    <ul class="rank-list">${rows}</ul>
    <p class="ranked-note muted">Click a candidate to overlay its matched lines on the plot.</p>`;
}

/** A Peak-Finder-style left rail for the Quantification placeholder. It reuses the `.step-film`
 * chrome verbatim (no new CSS) but is NOT model-driven: the real rail
 * ({@link peakFinderStepperRailMarkup}) is bound to a `PeakFinderStepModel`, and fabricating a
 * pipeline model for a page with no engine would be dishonest. Instead the planned quantification
 * inputs render as inert `locked` rows (a fully-locked stepper reads as "under construction"), and
 * the `.step-film-actions` footer carries the single "Close Workspace" action (`#quantClose` ->
 * landing, wired in {@link attachShellHandlers}). */
function quantRailMarkup(content: PfBoundaryContent): string {
  const lock =
    `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  const rows = content.requirements
    .map(
      (r) => `<li class="step-film-item locked" aria-disabled="true">
        <span class="step-film-num" aria-hidden="true">${lock}</span>
        <span class="step-film-label">${escapeHtml(r)}</span>
        <span class="step-film-status" aria-hidden="true">${lock}</span>
      </li>`,
    )
    .join('');
  return `<ol class="step-film" aria-label="Quantification (planned)">
      <li class="step-film-group">Quantification</li>
      ${rows}
      <li class="step-film-actions">
        <button id="quantClose" class="btn" type="button">Close Workspace</button>
      </li>
    </ol>`;
}

/** Quantification -- a placeholder page for the last analysis stage. The engine is not
 * built yet (D-4), so the page is an explicit "under construction" notice that reuses the
 * boundary-teaching copy to explain what the stage will do and what it needs.
 *
 * It adopts Peak Finder's DOM: the `.step-app` flex-shell (own `.step-topbar` + `.dev-banner`,
 * body.mode-peak-finder in render() suppresses the shared app header), a `.step-body` two-column
 * layout with the {@link quantRailMarkup} left rail (planned steps locked + Close Workspace), and a
 * single scrolling `.step-main` whose under-construction banner is centered. Nav + `#home` are
 * wired in {@link attachShellHandlers} (the quantification-scoped block). */
function quantificationBody(): string {
  const content = PF_BOUNDARY_CONTENT.quantification;
  const nav: View[] = ['peak-finder', 'calibrate', 'identify', 'resources', 'project-status'];
  return `
    <div class="step-app">
      <div class="step-topbar">
        <button class="brand" id="home" type="button" aria-label="Nuclid home">
          <svg class="brand-logo" viewBox="0 0 300 72" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Nuclid">
            <title>Nuclid</title>
            <g transform="translate(8,10)">
              <rect width="52" height="52" rx="12" fill="#0F6E56"/>
              <line x1="9" y1="37.5" x2="43" y2="37.5" stroke="#7FCFB8" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
              <path d="M10 38 C19.5 38 22.3 13.8 26 13.8 C29.7 13.8 32.5 38 42 38" fill="none" stroke="#FBFAF6" stroke-width="3.7" stroke-linecap="round" stroke-linejoin="round"/>
            </g>
            <text x="76" y="47" font-family="Inter,'Helvetica Neue',Arial,sans-serif" font-size="36" font-weight="600" letter-spacing="-0.5" fill="#2C2C2A">Nucl<tspan fill="#0F6E56">id</tspan></text>
          </svg>
        </button>
        <nav class="toolbar-nav" aria-label="Platform navigation">
          ${nav
            .map((v) => `<button class="nav-btn" type="button" data-nav="${v}">${VIEW_LABEL[v]}</button>`)
            .join('')}
        </nav>
      </div>
      <div class="dev-banner" role="status">under development - numbers are not yet validated</div>
      <div class="step-body">
        ${quantRailMarkup(content)}
        <section class="step-main">
          <div class="uc-center">
            <div class="uc-card card">
              <p class="uc-badge"><span class="uc-dot" aria-hidden="true"></span>Under construction</p>
              <h1 class="uc-title">Quantification</h1>
              <p>${escapeHtml(content.purpose)}</p>
              <p class="page-note">${escapeHtml(content.transition)}</p>
              <p class="page-note">${escapeHtml(content.whyLocked)}</p>
            </div>
          </div>
        </section>
      </div>
    </div>`;
}

function resourcesBody(): string {
  return `
    ${backBar()}
    <h1 class="page-title">Resources</h1>
    <div class="page card">
      <p>Nuclid is an educational, browser-only gamma-spectroscopy tool. It carries a raw spectrum through
        the full analysis pipeline -- condition, detect, fit, validate, calibrate, identify -- and shows
        every step rather than hiding it behind a black box.</p>
      <h2 class="page-h2">Pipeline stages</h2>
      <ul class="page-list">
        <li><b>Condition</b> -- SNIP background estimate + Savitzky-Golay smoothing (for detection only).</li>
        <li><b>Detect</b> -- find_peaks with prominence/width, then width-ratio + significance classification.</li>
        <li><b>Fit</b> -- Gaussian + linear background, sub-channel centroid with uncertainty.</li>
        <li><b>Validate</b> -- a quality gate that flags weak/broad/poor fits rather than dropping them.</li>
        <li><b>Calibrate</b> -- a channel-to-energy equation from declared known sources.</li>
        <li><b>Identify</b> -- whole-isotope fingerprint scoring against a nuclide library.</li>
      </ul>
      <p class="page-note">The numbers are not yet validated -- this build is under active development.</p>
    </div>`;
}

function projectStatusBody(): string {
  const rows = ROADMAP.map(
    (m) => `
    <li class="road-row">
      <span class="road-dot road-${m.status}" aria-hidden="true"></span>
      <span class="road-id">${m.id}</span>
      <span class="road-name">${escapeHtml(m.name)}</span>
      <span class="road-status road-${m.status}">${STATUS_LABEL[m.status]}</span>
    </li>`,
  ).join('');
  return `
    ${backBar()}
    <h1 class="page-title">Project Status</h1>
    <div class="page card">
      <ul class="roadmap">${rows}</ul>
      <div class="road-legend">
        <span class="key"><span class="road-dot road-done"></span>Done</span>
        <span class="key"><span class="road-dot road-now"></span>In progress</span>
        <span class="key"><span class="road-dot road-next"></span>Next</span>
        <span class="key"><span class="road-dot road-later"></span>Later</span>
      </div>
    </div>`;
}

function helpDialog(): string {
  const lines = GRAPH_HELP.map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  return `
    <div class="modal-overlay" id="helpOverlay">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div class="modal-head">
          <h2 id="helpTitle" class="modal-title">Graph help</h2>
          <button class="btn modal-close" id="helpClose" type="button" aria-label="Close help">Close</button>
        </div>
        <ul class="help-list">${lines}</ul>
      </div>
    </div>`;
}

// --- handlers --------------------------------------------------------------

function attachShellHandlers(): void {
  rootEl.querySelector<HTMLButtonElement>('#home')?.addEventListener('click', () => navigate('landing'));
  rootEl.querySelectorAll<HTMLButtonElement>('.app-header [data-nav], .landing [data-nav]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.nav as View)),
  );
  // Quantification adopts the `.step-*` shell but has no mode manager to attach its own
  // topbar wiring (Peak Finder / Identify / Calibrate / Batch each wire `.step-topbar
  // [data-nav]` in their own handlers). Scope this to that view so the step-topbar nav is
  // wired exactly once and no other step-shell's topbar is double-bound.
  if (state.view === 'quantification') {
    rootEl
      .querySelectorAll<HTMLButtonElement>('.step-topbar [data-nav]')
      .forEach((b) => b.addEventListener('click', () => navigate(b.dataset.nav as View)));
    // Rail footer "Close Workspace": no workspace/manager to clear (the page is a placeholder),
    // so this just returns to the landing view -- mirrors #pfCloseWorkspace's leave step.
    rootEl.querySelector<HTMLButtonElement>('#quantClose')?.addEventListener('click', () => navigate('landing'));
  }
  rootEl.querySelector<HTMLButtonElement>('#back')?.addEventListener('click', back);
  // DEBT-31: the graph-help dialog trigger (visible on every view; charts live in both
  // Calibrate and Identify). Close paths (backdrop / Close button / Escape) stay as-is.
  rootEl.querySelector<HTMLButtonElement>('#helpTrigger')?.addEventListener('click', () => {
    state.helpOpen = true;
    render();
  });
}

// --- Identify mode: handlers ------------------------------------------------

/** Parse a loaded unknown into `state.report`, push it to the manager, and default
 * the calibration selection. Fail-loud: a parse error surfaces on the cfg-spectrum
 * step (never silently swallowed). */
function loadIdentSpectrum(text: string, fileName: string): void {
  runPipeline(text, fileName);
  const mgr = ensureIdentifyManager();
  if (state.report) {
    state.ident.loadError = null;
    resetIdentView(); // a new unknown starts at the full view (C3)
    mgr.setSpectrum(state.report);
    ensureDefaultIdentCalibration(mgr);
  } else {
    state.ident.loadError = state.error;
  }
  render();
}

/** Default the calibration to the active saved one (else the first) when none is
 * chosen yet -- mirrors the reference defaulting to the active calibration. */
function ensureDefaultIdentCalibration(mgr: IdentifyManager): void {
  if (mgr.calibration) return;
  const lib = getCalibrationLibrary();
  const items = lib.items;
  if (!items.length) return;
  const rec = items.find((r) => r.id === lib.activeId) ?? items[0];
  mgr.setCalibration({ id: rec.id, cal: activeCalibration(rec.result), name: rec.name });
  state.ident.calChoiceId = rec.id;
}

/** Trigger a client-side download of a text payload (export buttons). */
function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** (Re)bind the rail action-footer buttons. Extracted so both the initial attach AND
 * the reveal-time rail patch (refreshIdentifyChrome, which replaces `.step-film`
 * wholesale) keep them live. "Load new spectrum" is the reset (was the in-panel Review
 * button, now consolidated to the footer to match Peak Finder); "Close workspace"
 * returns to the landing view. Mirrors {@link wirePfRailActions}. */
function wireIdentRailActions(mgr: IdentifyManager): void {
  const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel);
  q<HTMLButtonElement>('#identNew')?.addEventListener('click', () => {
    state.ident.stageIndex = 0;
    state.ident.configStep = 0;
    state.ident.loadError = null;
    state.report = null;
    mgr.reset();
  });
  q<HTMLButtonElement>('#identHome')?.addEventListener('click', () => navigate('landing'));
}

function attachIdentifyHandlers(): void {
  const mgr = ensureIdentifyManager();
  const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel);

  // Configure 1 -- spectrum loader.
  q<HTMLInputElement>('#identFile')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => loadIdentSpectrum(text, file.name));
  });
  q<HTMLSelectElement>('#identSample')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (!name) return;
    void loadSample(name).then(() => {
      if (state.report) {
        state.ident.loadError = null;
        resetIdentView(); // a new unknown starts at the full view (C3)
        mgr.setSpectrum(state.report);
        ensureDefaultIdentCalibration(mgr);
      } else {
        state.ident.loadError = state.error;
      }
      render();
    });
  });
  q<HTMLButtonElement>('#identDemo')?.addEventListener('click', () =>
    loadIdentSpectrum(syntheticTka(), 'synthetic-demo.tka'),
  );
  const drop = q<HTMLDivElement>('#identDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dropzone-over');
    });
    drop.addEventListener('dragleave', (e) => {
      if (e.target === drop) drop.classList.remove('dropzone-over');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dropzone-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) void file.text().then((text) => loadIdentSpectrum(text, file.name));
    });
  }

  // Configure 2 -- calibration selector.
  q<HTMLSelectElement>('#identCalSelect')?.addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    // The built-in default (GAP-06) is a transient choice, not a store record --
    // resolve it directly and never persist it.
    if (id === DEFAULT_IDENTIFY_CALIBRATION_ID) {
      state.ident.calChoiceId = id;
      mgr.setCalibration({
        id: DEFAULT_IDENTIFY_CALIBRATION_ID,
        cal: DEFAULT_IDENTIFY_CALIBRATION,
        name: DEFAULT_IDENTIFY_CALIBRATION_NAME,
      });
      return;
    }
    const rec = getCalibrationLibrary().items.find((r) => r.id === id);
    if (!rec) return;
    state.ident.calChoiceId = id;
    mgr.setCalibration({ id: rec.id, cal: activeCalibration(rec.result), name: rec.name });
  });
  q<HTMLButtonElement>('#identToCalibrate')?.addEventListener('click', () => navigate('calibrate'));
  // Preview Reset view: back to the full spectrum (J4). Direct redraw (not a full
  // render), matching the binding's dblclick reset path.
  q<HTMLButtonElement>('.ident-reset')?.addEventListener('click', () => {
    state.ident.identView = null;
    drawIdentPreview();
    syncIdentResetButton();
  });

  // Configure 3 -- run.
  q<HTMLButtonElement>('#identify')?.addEventListener('click', () => doIdentify(mgr));

  // Top-bar nav (`.step-topbar` right cluster): route to the sibling views. The shared
  // app-header is suppressed in this mode, so its nav wiring in attachShellHandlers finds
  // nothing -- these buttons carry the routing here (mirrors the Peak Finder handler).
  rootEl.querySelectorAll<HTMLButtonElement>('.step-topbar [data-nav]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.nav as View)),
  );

  // Grouped stepper -- rail step clicks (locked/inert rows excluded) + Prev/Next toolbar.
  rootEl.querySelectorAll<HTMLElement>('.step-film [data-step]:not([aria-disabled])').forEach((el) => {
    const go = (): void => goToIdentifyStep(el.dataset.step ?? '', mgr);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    });
  });
  q<HTMLButtonElement>('#identPrev')?.addEventListener('click', () => identifyNavStep(mgr, -1));
  q<HTMLButtonElement>('#identNext')?.addEventListener('click', () => identifyNavStep(mgr, 1));

  // Rail action footer + top-bar brand. The footer buttons are bound here AND re-bound
  // after the reveal-time rail patch (see refreshIdentifyChrome). `#identBrandHome` (the
  // top-bar logo) is a distinct id from the footer's `#identHome` (Close workspace);
  // both route to the landing view.
  wireIdentRailActions(mgr);
  q<HTMLButtonElement>('#identBrandHome')?.addEventListener('click', () => navigate('landing'));

  // Run / Review -- post-run controls.
  q<HTMLButtonElement>('#identViewWalkthrough')?.addEventListener('click', () =>
    mgr.setReviewView('walkthrough'),
  );
  q<HTMLButtonElement>('#identBackToReview')?.addEventListener('click', () =>
    mgr.setReviewView('summary'),
  );
  q<HTMLButtonElement>('#identBackToConfig')?.addEventListener('click', () => mgr.backToCollecting());
  q<HTMLButtonElement>('#identExportJson')?.addEventListener('click', () => {
    if (mgr.result) downloadText(exportIdentificationJson(mgr.result), 'identification.json', 'application/json');
  });
  q<HTMLButtonElement>('#identExportCsv')?.addEventListener('click', () => {
    if (mgr.result && mgr.energised)
      downloadText(exportIdentificationCsv(mgr.result, mgr.energised), 'identification.csv', 'text/csv');
  });

  // Ranked-isotope overlay selection (Review + walkthrough share the rows).
  rootEl.querySelectorAll<HTMLButtonElement>('[data-overlay]').forEach((b) =>
    b.addEventListener('click', () => mgr.setOverlay(b.dataset.overlay ?? null)),
  );
}

function attachHelpHandlers(): void {
  const overlay = rootEl.querySelector<HTMLDivElement>('#helpOverlay');
  const close = rootEl.querySelector<HTMLButtonElement>('#helpClose');
  close?.addEventListener('click', () => {
    state.helpOpen = false;
    render();
  });
  overlay?.addEventListener('mousedown', (e) => {
    if (e.target === overlay) {
      state.helpOpen = false;
      render();
    }
  });
  close?.focus();
  overlay?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = overlay.querySelectorAll<HTMLElement>(
      'button, [href], [tabindex]:not([tabindex="-1"])',
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

// --- Calibrate actions (manager-driven; the engine is called by the manager) ---

/** Parse a spectrum file's text into a report and add it as a batch row. A parse
 * fault is shown in the Source Manager (fail-loud); it never adds a bad row. */
function addCalibFile(text: string, fileName: string): void {
  const mgr = ensureManager();
  try {
    // Peak source = the batch Peak Finder engine (`runPeakFinder`), the SAME headless core
    // the Peak Finder mode and the batch queue run -- so a Calibrate source's detected peaks
    // are byte-identical to those modes (was `analyze()` -- the C2/orchestrator path). The
    // resulting report feeds `addParsedSource` exactly as the batch hand-off already does.
    const spectrum = parseSpectrum({ text, fileName });
    const { report } = runPeakFinder(spectrum, DEFAULT_PEAK_FINDER_CONFIG);
    state.calib.loadError = null;
    mgr.addParsedSource(report); // emits -> render
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Unexpected error: ${(err as Error).message}`;
    render();
  }
}

/** Load a bundled real source into the batch (Source Manager picker). */
async function loadCalibSample(name: string): Promise<void> {
  try {
    const url = `${import.meta.env.BASE_URL}sample-data/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new ParseError(`Failed to load sample "${name}": HTTP ${res.status}.`);
    addCalibFile(await res.text(), name);
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Unexpected error: ${(err as Error).message}`;
    render();
  }
}

/** Read every dropped/selected file and add each as a batch row. */
function addCalibFiles(files: FileList): void {
  void Promise.all(Array.from(files, (f) => f.text().then((t) => addCalibFile(t, f.name))));
}

/** Enter the Build flow from the Manager with a clean slate. Flips `mode` to
 * 'builder' FIRST so any manager-notify re-render triggered by `mgr.reset()` (or a
 * subsequent source add) lands on the builder Stage 1, not the Manager. The caller
 * renders (New calibration) or adds a source which renders (Add synthetic demo). */
function enterBuilderFresh(mgr: CalibrationManager): void {
  state.calib.mode = 'builder';
  state.calib.loadError = null;
  state.calib.saved = null;
  state.calib.stageIndex = 0;
  state.calib.configStep = 0;
  state.calib.modelChosen = false;
  state.calib.expandedRowId = null;
  state.calib.inspector = emptyInspectorState();
  mgr.reset();
}

/** Wire the Source Manager + Execution Stepper controls for the current surface. */
/** Bind the `.step-film` rail's interactive step rows + its `.step-film-actions` footer.
 * Called on mount (from {@link attachCalibrateHandlers}) AND after the reveal-time rail
 * patch ({@link refreshBuildChrome}), which replaces the rail's `outerHTML` and so drops
 * its listeners. Mirrors `wireIdentRailActions` / `wirePfRailActions`. Locked/inert rows
 * are excluded by the delegation selector. */
function wireBuildRailActions(mgr: CalibrationManager): void {
  rootEl.querySelectorAll<HTMLElement>('.step-film [data-step]:not([aria-disabled])').forEach((el) => {
    const go = (): void => goToBuildStep(el.dataset.step ?? '', mgr);
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        go();
      }
    });
  });
  // Footer "Saved calibrations": discard the in-progress batch and return to the library
  // (the review/done path lands there too -- the saved calibration is already persisted).
  rootEl.querySelector<HTMLButtonElement>('#calBuilderCancel')?.addEventListener('click', () => {
    state.calib.mode = 'manager';
    mgr.stopReveal();
    mgr.reset();
    state.calib.saved = null;
    state.calib.stageIndex = 0;
    state.calib.configStep = 0;
    state.calib.modelChosen = false;
    state.calib.expandedRowId = null;
    state.calib.inspector = emptyInspectorState();
    state.calib.loadError = null;
    render();
  });
}

function attachCalibrateHandlers(): void {
  const mgr = ensureManager();
  const q = <T extends HTMLElement>(sel: string) => rootEl.querySelector<T>(sel);

  // Source Manager -- batch loader.
  q<HTMLInputElement>('#calFile')?.addEventListener('change', (e) => {
    const files = (e.target as HTMLInputElement).files;
    if (files?.length) addCalibFiles(files);
  });
  q<HTMLSelectElement>('#calSample')?.addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    if (name) void loadCalibSample(name);
  });
  q<HTMLButtonElement>('#calDemo')?.addEventListener('click', () =>
    addCalibFile(syntheticTka(), 'synthetic-demo.tka'),
  );
  // Manager entry actions (empty + populated library) -- enter the Build flow.
  // "New calibration" opens a fresh Stage 1; "Add synthetic demo" opens Stage 1 with
  // the synthetic source already in the batch. Both flip mode to 'builder' BEFORE any
  // manager-notify re-render so the surface lands on the builder, not the Manager.
  q<HTMLButtonElement>('#calLibNew')?.addEventListener('click', () => {
    enterBuilderFresh(mgr);
    render();
  });
  q<HTMLButtonElement>('#calLibDemo')?.addEventListener('click', () => {
    enterBuilderFresh(mgr); // mode='builder' first, then mgr.reset()
    addCalibFile(syntheticTka(), 'synthetic-demo.tka');
  });
  const drop = q<HTMLDivElement>('#calDrop');
  if (drop) {
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('dropzone-over');
    });
    drop.addEventListener('dragleave', (e) => {
      if (e.target === drop) drop.classList.remove('dropzone-over');
    });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dropzone-over');
      const files = e.dataTransfer?.files;
      if (files?.length) addCalibFiles(files);
    });
  }

  // Source Manager -- batch rows (identity edit, QC expand, remove).
  rootEl.querySelectorAll<HTMLSelectElement>('.br-identity').forEach((sel) =>
    sel.addEventListener('change', () => mgr.setIdentity(sel.dataset.row ?? '', sel.value)),
  );
  // Declare Identities (Phase 2) -- navigator cursor + per-peak assignment capture.
  // The manager emits on every change, so the subscription re-renders the view;
  // no explicit render() here (same pattern as the .br-identity binding above).
  rootEl.querySelectorAll<HTMLButtonElement>('.di-nav-btn').forEach((b) =>
    b.addEventListener('click', () => mgr.setActiveRow(b.dataset.row ?? '')),
  );
  rootEl.querySelectorAll<HTMLSelectElement>('.di-assign').forEach((sel) =>
    sel.addEventListener('change', () => {
      const row = sel.dataset.row ?? '';
      const peak = sel.dataset.peak ?? '';
      if (sel.value === '') mgr.clearPeak(row, peak);
      else if (sel.value === EXCLUDE_OPTION_VALUE) mgr.excludePeak(row, peak);
      else mgr.assignPeak(row, peak, Number(sel.value));
    }),
  );
  // Assign-energies: source pager (prev/next between sources) + peak-card selection (the
  // card side of the graph <-> card link). Switching source clears the selected peak (it
  // belonged to the old source). `setActiveRow` emits -> the subscription re-renders.
  {
    const srcs = mgr.sources;
    const activeIdx = srcs.findIndex((s) => s.rowId === mgr.activeRowId);
    const cur = activeIdx < 0 ? 0 : activeIdx;
    const goSource = (i: number): void => {
      if (!srcs[i]) return;
      state.calib.assignSelectedPeak = null;
      mgr.setActiveRow(srcs[i].rowId);
    };
    q<HTMLButtonElement>('#calSrcPrev')?.addEventListener('click', () => goSource(cur - 1));
    q<HTMLButtonElement>('#calSrcNext')?.addEventListener('click', () => goSource(cur + 1));
  }
  rootEl.querySelectorAll<HTMLElement>('.di-pcard').forEach((card) =>
    card.addEventListener('click', (e) => {
      // Let the energy dropdown work normally -- only a click on the card body selects.
      if ((e.target as HTMLElement).closest('select')) return;
      const peak = card.dataset.peak ?? '';
      if (peak && peak !== state.calib.assignSelectedPeak) {
        state.calib.assignSelectedPeak = peak;
        render();
      }
    }),
  );
  rootEl.querySelectorAll<HTMLButtonElement>('.br-expand').forEach((b) =>
    b.addEventListener('click', () => {
      const row = b.dataset.row ?? '';
      state.calib.expandedRowId = state.calib.expandedRowId === row ? null : row;
      // Every expand/collapse/switch starts on the full view (Batch C: qcView resets
      // on row change) and drops the stale geometry.
      state.calib.qcView = null;
      state.calib.qcGeometry = null;
      render();
    }),
  );
  // QC-chart Reset view: back to the full spectrum (J4). Redraws directly -- no full
  // render -- so it matches the binding's dblclick reset path.
  q<HTMLButtonElement>('.br-qc-reset')?.addEventListener('click', () => {
    state.calib.qcView = null;
    drawRowQC();
    syncQcResetButton();
  });
  // The `#calInspect` toggle is retired (Phase 3): the inspector is embedded in
  // the active-source surface and mounted unconditionally for the active source.
  // Inspector stage rail / click-to-inspect / Reset view: wired by the workspace
  // itself on its own root -- see mountActiveSourceInspector.
  rootEl.querySelectorAll<HTMLButtonElement>('.br-remove').forEach((b) =>
    b.addEventListener('click', () => {
      if (state.calib.expandedRowId === b.dataset.row) {
        state.calib.expandedRowId = null;
        state.calib.qcView = null;
        state.calib.qcGeometry = null;
      }
      // Removal advance happens exactly ONCE, in the manager's activeRowId
      // cursor (Phase 2, next-else-previous) -- the single source of truth. The
      // embedded inspector follows on the next mount via the host re-bind in
      // mountActiveSourceInspector (the former advanceSubjectOnRemoval call is
      // gone with the standalone destination).
      mgr.removeSource(b.dataset.row ?? '');
    }),
  );

  // Source Manager -- model selector + Build.
  rootEl.querySelectorAll<HTMLButtonElement>('.seg[data-cal-model]').forEach((seg) =>
    seg.addEventListener('click', () => {
      state.calib.modelChosen = true; // an explicit pick completes the Select-model step
      mgr.setModel(seg.dataset.calModel as ModelChoice);
    }),
  );
  q<HTMLButtonElement>('#calBuild')?.addEventListener('click', () => doBuild(mgr));

  // Top-bar nav (`.step-topbar` right cluster): route to the sibling views. The shared
  // app-header is suppressed in the builder shell (isStepShell), so its nav wiring finds
  // nothing -- these carry the routing here (mirrors the Peak Finder / Identify handler).
  // `#calBrandHome` (the top-bar logo) routes to landing. Harmless no-ops on the Manager
  // surface (those ids are absent there).
  rootEl.querySelectorAll<HTMLButtonElement>('.step-topbar [data-nav]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.dataset.nav as View)),
  );
  q<HTMLButtonElement>('#calBrandHome')?.addEventListener('click', () => navigate('landing'));

  // Grouped stepper -- `.step-film` rail step rows + footer (locked/inert rows excluded),
  // bound here AND re-bound after the reveal-time rail patch (refreshBuildChrome), plus the
  // minimal Prev/Next toolbar. All route through the shared navigation helpers.
  wireBuildRailActions(mgr);
  q<HTMLButtonElement>('#buildPrev')?.addEventListener('click', () => buildNavStep(mgr, -1));
  q<HTMLButtonElement>('#buildNext')?.addEventListener('click', () => buildNavStep(mgr, 1));

  // Execution Stepper -- post-run controls.
  rootEl.querySelectorAll<HTMLButtonElement>('.seg[data-flip]').forEach((seg) =>
    seg.addEventListener('click', () => {
      if (seg.hasAttribute('disabled')) return;
      mgr.setViewModel(seg.dataset.flip as 'linear' | 'quadratic');
    }),
  );
  q<HTMLButtonElement>('#calNewBatch')?.addEventListener('click', () => {
    state.calib.expandedRowId = null;
    state.calib.inspector = emptyInspectorState();
    state.calib.loadError = null;
    state.calib.saved = null;
    state.calib.stageIndex = 0;
    state.calib.configStep = 0;
    state.calib.modelChosen = false;
    mgr.reset();
  });
  q<HTMLButtonElement>('#calBackToSources')?.addEventListener('click', () => mgr.backToCollecting());
  // Review surface split: summary <-> the full 8-stage walkthrough (UI-only; the
  // engine phase stays `done`). Both re-render via the manager subscription.
  q<HTMLButtonElement>('#calViewWalkthrough')?.addEventListener('click', () => mgr.setReviewView('walkthrough'));
  q<HTMLButtonElement>('#calBackToReview')?.addEventListener('click', () => mgr.setReviewView('summary'));
  q<HTMLButtonElement>('#calSave')?.addEventListener('click', saveCalibration);
  q<HTMLButtonElement>('#calToIdentify')?.addEventListener('click', () => navigate('identify'));

  // Builder -> Manager routes. The rail-footer Cancel (`#calBuilderCancel`, "Saved
  // calibrations") is bound in wireBuildRailActions (it lives in the `.step-film-actions`
  // footer now, and must survive the reveal-time rail re-render). `#calToManager` is the
  // Review-surface return after a build -- the saved calibration is already persisted +
  // active, so the Manager shows it.
  q<HTMLButtonElement>('#calToManager')?.addEventListener('click', () => {
    state.calib.mode = 'manager';
    mgr.stopReveal();
    mgr.reset();
    state.calib.saved = null;
    state.calib.stageIndex = 0;
    state.calib.configStep = 0;
    state.calib.modelChosen = false;
    // 4c lifecycle triggers 2+3: this is a batch clear (mgr.reset) AND builder ->
    // Manager -- the inspector session ends (was missing pre-4c).
    state.calib.inspector = emptyInspectorState();
    render();
  });

  // Saved-calibrations library (Scenario 1) -- toolbar + per-card/detail actions.
  // The library is the single source of truth; activate/delete/duplicate emit and
  // the init subscriber re-renders. View-state lives on state.calib.library.
  const libView = state.calib.library;
  const searchEl = q<HTMLInputElement>('#calLibSearch');
  searchEl?.addEventListener('input', () => {
    libView.query = searchEl.value;
    libView.focusSearch = true; // restored below after the re-render
    render();
  });
  q<HTMLSelectElement>('#calLibFilter')?.addEventListener('change', (e) => {
    libView.filter = (e.target as HTMLSelectElement).value as LibraryFilter;
    render();
  });
  q<HTMLSelectElement>('#calLibSort')?.addEventListener('change', (e) => {
    libView.sort = (e.target as HTMLSelectElement).value as LibrarySort;
    render();
  });
  rootEl.querySelectorAll<HTMLButtonElement>('.cal-act-view').forEach((b) =>
    b.addEventListener('click', () => {
      libView.selectedId = b.dataset.id ?? null;
      render();
    }),
  );
  rootEl.querySelectorAll<HTMLButtonElement>('.cal-act-setactive').forEach((b) =>
    b.addEventListener('click', () => activateSaved(b.dataset.id ?? '')),
  );
  rootEl.querySelectorAll<HTMLButtonElement>('.cal-act-delete').forEach((b) =>
    b.addEventListener('click', () => requestDelete(b.dataset.id ?? '')),
  );
  // Cancel the "set another active first" prompt (Scenario 2) -- no deletion.
  q<HTMLButtonElement>('#calActiveDeleteCancel')?.addEventListener('click', () => {
    state.calib.library.pendingActiveDeleteId = null;
    render();
  });
  rootEl
    .querySelectorAll<HTMLButtonElement>('.cal-act-identify, #calLibDetailIdentify')
    .forEach((b) =>
      b.addEventListener('click', () => {
        activateSaved(b.dataset.id ?? '');
        navigate('identify');
      }),
    );
  // Review panel (Scenario 2): promote the reviewed record. Clearing selectedId lets
  // the panel fall back to the now-active record -> it re-renders in the active state.
  q<HTMLButtonElement>('#calLibDetailSetActive')?.addEventListener('click', () => {
    const b = q<HTMLButtonElement>('#calLibDetailSetActive');
    libView.selectedId = null;
    activateSaved(b?.dataset.id ?? ''); // emits -> re-render via the library subscriber
  });
  rootEl.querySelectorAll<HTMLButtonElement>('.cal-act-dup').forEach((b) =>
    b.addEventListener('click', () => duplicateSaved(b.dataset.id ?? '')),
  );
  rootEl
    .querySelectorAll<HTMLButtonElement>('.cal-act-export, #calLibDetailExport')
    .forEach((b) => b.addEventListener('click', () => exportSaved(b.dataset.id ?? '')));

  // Keep the search box focused across the input-triggered re-render (caret at end).
  if (libView.focusSearch) {
    const el = q<HTMLInputElement>('#calLibSearch');
    if (el) {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
    libView.focusSearch = false;
  }
}

/** Activate a saved calibration (library.activate emits -> re-render). Fail-loud on
 * a store fault: the message shows on the Source Manager. */
function activateSaved(id: string): void {
  // Re-pointing active dismisses any pending active-delete prompt: the former active
  // is now an ordinary inactive card and is deleted via its own Delete button.
  state.calib.library.pendingActiveDeleteId = null;
  try {
    getCalibrationLibrary().activate(id);
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Activate failed: ${(err as Error).message}`;
    render();
  }
}

/** Delete a saved calibration, preserving the active invariant. Deleting the
 * active one while others exist is blocked: the UI asks the operator to make
 * another active first (Scenario 2). The active-as-only-record case deletes
 * straight to an empty library (Scenario 1). */
function requestDelete(id: string): void {
  const library = getCalibrationLibrary();
  const blocked = id === library.activeId && library.items.length > 1;
  if (blocked) {
    state.calib.library.pendingActiveDeleteId = id; // show the inline prompt
    render();
    return;
  }
  if (state.calib.library.selectedId === id) state.calib.library.selectedId = null;
  state.calib.library.pendingActiveDeleteId = null; // clear any prompt
  deleteSaved(id);
}

/** Delete a saved calibration (library.remove emits -> re-render; removing the
 * active one clears active in the store). Fail-loud on a store fault. */
function deleteSaved(id: string): void {
  try {
    getCalibrationLibrary().remove(id);
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Delete failed: ${(err as Error).message}`;
    render();
  }
}

/** Duplicate a saved calibration as a new "… (copy)" record (library.duplicate
 * emits -> re-render). The active pointer is unchanged (store.save only sets active
 * when none is). Fail-loud on a store fault. */
function duplicateSaved(id: string): void {
  try {
    getCalibrationLibrary().duplicate(id);
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Duplicate failed: ${(err as Error).message}`;
    render();
  }
}

/** A filename-safe slug of a calibration name (lowercase, non-alphanumerics -> '-',
 * collapsed/trimmed); falls back to 'calibration' when a name slugs to empty. */
function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'calibration'
  );
}

/** Export one saved calibration as a downloaded JSON file (the operator's own data;
 * no network). Loads the record from the store, fails loud if it is gone, and
 * triggers a `*.nuclid-calibration.json` download via a temporary object URL. */
function exportSaved(id: string): void {
  try {
    const rec = calibrationStore.load(id);
    if (!rec) throw new NuclidError(`Cannot export unknown calibration id "${id}".`);
    const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugifyName(rec.name)}.nuclid-calibration.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Export failed: ${(err as Error).message}`;
    render();
  }
}

/** Save the built calibration by name + set it active (manager). Fail-loud on a
 * store fault: the message is shown back on the Source Manager. */
function saveCalibration(): void {
  const mgr = state.calib.manager;
  if (!mgr) return;
  const name = rootEl.querySelector<HTMLInputElement>('#calName')?.value.trim() || defaultCalName();
  try {
    state.calib.saved = mgr.save(name);
    // The library re-reads the store (incl. the active pointer mgr.save just set)
    // and emits -> the Calibrate subscriber re-renders, so the panel shows the new
    // active record. The emit IS the render -- no explicit render() here (no double).
    getCalibrationLibrary().refresh();
  } catch (err) {
    state.calib.loadError =
      err instanceof NuclidError ? err.message : `Save failed: ${(err as Error).message}`;
    mgr.backToCollecting(); // emits -> Source Manager with the error
  }
}

/** Mount the appropriate Identify sub-view after a render: the stage walkthrough
 * (running | walkthrough), or the cfg-spectrum preview chart (collecting, when a
 * spectrum is loaded and that step is active). The Review summary is static markup. */
function mountIdentify(): void {
  const mgr = state.ident.manager;
  if (!mgr) return;
  const phase = mgr.phase;
  if (phase.kind === 'running' || (phase.kind === 'done' && mgr.reviewView === 'walkthrough')) {
    mountIdentifyStages(mgr);
  } else if (phase.kind === 'collecting' || phase.kind === 'error') {
    drawIdentPreview(); // only paints when #identPreview is present (cfg-spectrum step)
    mountIdentInteraction();
  }
}

/** Wire the reusable binding onto the Identify cfg-spectrum preview (C3, J3). Same
 * shape as {@link mountQcInteraction}: `setView` redraws the preview directly (not a
 * full render). The window resets when a new spectrum loads ({@link resetIdentView}).
 * No-op when the preview is absent. The C1 binding needed zero change to serve this. */
function mountIdentInteraction(): void {
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#identPreview');
  if (!canvas) return;
  identInteraction = mountChartInteraction(canvas, {
    getGeometry: () => state.ident.identGeometry,
    getView: () => state.ident.identView,
    setView: (view) => {
      state.ident.identView = view;
      drawIdentPreview();
      syncIdentResetButton();
    },
    onCursor: (info) => updateIdentChip(info),
  });
}

/** Enable the preview Reset-view button only when the chart is zoomed/panned. */
function syncIdentResetButton(): void {
  const btn = rootEl.querySelector<HTMLButtonElement>('.ident-reset');
  if (btn) btn.disabled = state.ident.identView === null;
}

/** Reset the Identify preview's zoom window + geometry (C3): called wherever a new
 * spectrum enters `state.ident`, so each loaded unknown starts at the full view. */
function resetIdentView(): void {
  state.ident.identView = null;
  state.ident.identGeometry = null;
}

/** Position + fill the preview cursor chip from a hover readout; hide on leave. Reads
 * counts from the loaded report's raw spectrum. Pure DOM overlay -- no redraw per move. */
function updateIdentChip(info: { channel: number; xCss: number; yCss: number } | null): void {
  const chip = rootEl.querySelector<HTMLElement>('.ident-chip');
  if (!chip) return;
  if (!info) {
    chip.hidden = true;
    return;
  }
  const counts = state.ident.manager?.report?.spectrum.counts ?? state.report?.spectrum.counts;
  const c = counts && info.channel >= 0 && info.channel < counts.length ? counts[info.channel] : 0;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#identPreview');
  chip.textContent = `ch ${info.channel} · ${c} counts`;
  chip.style.left = `${(canvas?.offsetLeft ?? 0) + info.xCss}px`;
  chip.style.top = `${(canvas?.offsetTop ?? 0) + info.yCss}px`;
  chip.hidden = false;
}

/** Mount the staged Identify walkthrough into `#identStageRoot`. Display-only: it
 * reads the finished result + energised peaks + counts and narrates them across the
 * seven stages; it never re-runs `identify()`. While running, the rail/nav are
 * locked (`.stepper-running`) and the engine drives the visible stage via the reveal.
 * The grouped flow owns the rail + bottom toolbar, so StageView renders only its
 * canvas + explanation here (chrome:{rail:false, nav:false}). */
function mountIdentifyStages(mgr: IdentifyManager): void {
  const root = rootEl.querySelector<HTMLElement>('#identStageRoot');
  const result = mgr.result;
  const summary = mgr.summary;
  const energised = mgr.energised;
  const cal = mgr.cal;
  if (!root || !result || !summary || !energised || !cal || !mgr.report) return;
  const input: IdentifyStagesInput = {
    result,
    summary,
    energised,
    counts: mgr.report.spectrum.counts,
    cal,
    calName: mgr.calName,
    overlayId: mgr.overlayId,
  };
  stageViewHandle = createStageView({
    root,
    stages: buildIdentifyStages(input),
    ready: true,
    notReadyHint: '',
    initialStage: state.ident.stageIndex,
    chrome: { rail: false, nav: false },
    onStageChange: (i) => {
      state.ident.stageIndex = i;
    },
  });
  if (mgr.phase.kind === 'running') stageViewHandle.showStage(mgr.phase.stageIndex);
}

/** Draw the loaded unknown's spectrum into the cfg-spectrum preview canvas (channel
 * axis, detected peaks marked). Reuses the shared spectrum chart; no-op when the
 * preview canvas is absent (any non-cfg-spectrum step). Mirrors `drawRowQC`. */
function drawIdentPreview(): void {
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#identPreview');
  const report = state.ident.manager?.report ?? state.report;
  if (!canvas || !report) return;
  const ACCENT = '#0F6E56';
  // Zoomed (J3): pass the X window plus a count-axis auto-fit to the visible slice; full
  // view (identView === null) passes no `view`, so the idle preview is byte-identical to
  // pre-C3. Capture the geometry for the interaction binding (mirrors the QC/inspector).
  const identView = state.ident.identView;
  const view = identView
    ? { ...identView, ...fitYToWindow([report.spectrum.counts], identView) }
    : undefined;
  state.ident.identGeometry =
    drawSpectrum(
      canvas,
      [{ values: report.spectrum.counts, color: ACCENT, label: 'counts', width: 1.5, fill: true }],
      report.detectedCandidates.map((c) => ({ channel: c.channel, label: '', color: ACCENT })),
      { logY: state.logY, xLabel: 'Channel', yLabel: 'counts', overlays: [], ...(view ? { view } : {}) },
    ) ?? null;
}

/** Mount the appropriate Calibrate sub-view after a render: the stage walkthrough
 * (running | done) or the per-file QC chart (collecting, when a row is expanded). */
function mountCalibrate(): void {
  const mgr = state.calib.manager;
  if (!mgr) return;
  if (mgr.phase.kind === 'done' && mgr.reviewView === 'summary') mountReviewHero(mgr);
  else if (mgr.phase.kind === 'running' || mgr.phase.kind === 'done') mountCalibStages(mgr);
  else {
    // Both guard on their own row/subject id, so calling both is safe whether one,
    // both, or neither disclosure is open. `mountAssignGraph` guards on its own
    // `#calAssignChart` canvas, so it is a no-op unless the Assign-energies step is shown.
    drawRowQC();
    mountQcInteraction();
    mountActiveSourceInspector();
    mountAssignGraph();
  }
}

/** Draw the Assign-energies spectrum graph for the active (pager-selected) source and wire
 * the graph -> card link. The source's raw counts are drawn with `drawSpectrum`; each
 * detected peak is a coloured marker at its centroid -- teal (assigned) / blue (the
 * selected peak) / gray (unassigned). A canvas click hit-tests against the peak centroids
 * (`nearestChannelIndex`) and selects that peak (mirrors the card click), so selecting on
 * the graph and in the cards stay in sync. No-op unless `#calAssignChart` is present. */
function mountAssignGraph(): void {
  const mgr = state.calib.manager;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#calAssignChart');
  if (!mgr || !canvas) return;
  const active = mgr.sources.find((s) => s.rowId === mgr.activeRowId) ?? mgr.sources[0];
  if (!active) return;
  const ASSIGNED = '#1D9E75';
  const SELECTED = '#378ADD';
  const UNASSIGNED = '#888780';
  const markers = active.fittedPeaks.map((p, i) => {
    const a = active.assignments[i];
    const color =
      a?.state === 'assigned'
        ? ASSIGNED
        : a?.peakId === state.calib.assignSelectedPeak
          ? SELECTED
          : UNASSIGNED;
    return { channel: Math.round(p.centroidChannel), label: '', color };
  });
  const geo = drawSpectrum(
    canvas,
    [{ values: active.counts, color: '#0F6E56', label: 'counts', width: 1.5, fill: true }],
    markers,
    { logY: state.logY, xLabel: 'Channel', yLabel: 'counts', overlays: [] },
  );
  if (!geo) return;
  const channels = active.fittedPeaks.map((p) => Math.round(p.centroidChannel));
  // Single assigned handler (replaced each mount -> never leaks): click near a peak marker
  // selects that peak. Tolerance 10px so closely-spaced peaks stay individually selectable.
  canvas.onclick = (e: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const idx = nearestChannelIndex(geo, e.clientX - rect.left, channels, 10);
    if (idx == null) return;
    const peakId = active.assignments[idx]?.peakId ?? null;
    if (peakId && peakId !== state.calib.assignSelectedPeak) {
      state.calib.assignSelectedPeak = peakId;
      render();
    }
  };
}

/** Mount the Peak Pipeline Inspector INSIDE the active-source surface
 * (Declare-Identities Phase 3): the read-only evidence embedded at
 * `.di-evidence`, bound to the navigator's ACTIVE source as the workspace's
 * single subject -- the navigator is the spectrum switcher now, so the
 * workspace's own multi-subject selector/selection-step machinery is inert
 * here. Status derived ONCE via the Phase-1 contract (Principle 9), trace lazy.
 *
 * Host re-bind: when the active source differs from the bound subject (first
 * bind, navigator switch, or removal -- the manager's activeRowId cursor is the
 * single source of truth), the existing switch semantics apply: stage persists,
 * candidate resets, view reprojects onto the new channel span. A FRESH session
 * (subjectId null) lands on the peaks-overlaid Validated stage for tier-0
 * ambient context; the rail steps back through earlier stages on demand.
 * `onChange` = full render (subject/stage/candidate changes alter the markup). */
function mountActiveSourceInspector(): void {
  const insp = state.calib.inspector;
  const mgr = state.calib.manager;
  const root = rootEl.querySelector<HTMLElement>('.di-evidence');
  if (!root || !mgr) return;
  const active =
    mgr.sources.find((s) => s.rowId === mgr.activeRowId) ?? mgr.sources[0];
  if (!active || !isInspectable(active.report)) return;
  if (insp.subjectId !== active.rowId) {
    if (insp.subjectId === null) insp.stageIndex = INSPECTOR_STAGES.length - 1; // Validated
    insp.subjectId = active.rowId;
    insp.selectedCandidate = null;
    insp.geometry = null;
    insp.view = reprojectView(insp.view, active.channelCount);
  }
  inspectorWorkspace = mountInspectorWorkspace({
    root,
    subjects: [
      {
        id: active.rowId,
        label: active.fileName,
        status: deriveSpectrumStatus(active.report),
        channelCount: active.channelCount,
        getTrace: () => buildPipelineTrace(active.report),
      },
    ],
    state: insp,
    logY: state.logY,
    onChange: render,
  });
}

/** Wire the reusable zoom/pan/cursor binding onto the expanded QC canvas (Batch C
 * C1). Re-mounted after every render that produces `#calQc` (a fresh node per
 * render); `setView` redraws the QC chart directly -- not a full render -- so the
 * gesture stays smooth. No-op when no row is expanded. */
function mountQcInteraction(): void {
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#calQc');
  if (!canvas) return;
  qcInteraction = mountChartInteraction(canvas, {
    getGeometry: () => state.calib.qcGeometry,
    getView: () => state.calib.qcView,
    setView: (view) => {
      state.calib.qcView = view;
      drawRowQC();
      syncQcResetButton();
    },
    onCursor: (info) => updateQcChip(info),
  });
}

/** Enable the Reset-view button only when the QC chart is zoomed/panned. */
function syncQcResetButton(): void {
  const btn = rootEl.querySelector<HTMLButtonElement>('.br-qc-reset');
  if (btn) btn.disabled = state.calib.qcView === null;
}

/** Position + fill the QC cursor chip from a hover readout; hide it on leave. Pure
 * DOM overlay -- no canvas redraw per mousemove. The chip lives inside `.br-qc`
 * (the positioned ancestor), so its coordinates are the canvas offset plus the
 * pointer's canvas-relative CSS position. */
function updateQcChip(info: { channel: number; xCss: number; yCss: number } | null): void {
  const chip = rootEl.querySelector<HTMLElement>('.br-qc-chip');
  if (!chip) return;
  if (!info) {
    chip.hidden = true;
    return;
  }
  const rowId = state.calib.expandedRowId;
  const row = rowId ? state.calib.manager?.sources.find((s) => s.rowId === rowId) : undefined;
  const counts =
    row && info.channel >= 0 && info.channel < row.counts.length ? row.counts[info.channel] : 0;
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#calQc');
  chip.textContent = `ch ${info.channel} · ${counts} counts`;
  chip.style.left = `${(canvas?.offsetLeft ?? 0) + info.xCss}px`;
  chip.style.top = `${(canvas?.offsetTop ?? 0) + info.yCss}px`;
  chip.hidden = false;
}

/* The inspector's interaction binding, reset-button sync, chip series, and cursor
 * chip moved verbatim into `inspectorWorkspace.ts` (Phase 3): the workspace wires
 * them on its own root, scoped -- no global `#inspectorChart` lookups remain. */

/** Mount the staged Calibrate walkthrough into `#calibStageRoot`. Display-only: it
 * reads the built result (+ trace) and the batch spectra and narrates them across
 * eight stages; it never re-runs the fit. While running, the rail/nav are locked
 * (`.stepper-running`) and the engine drives the visible stage via the reveal. */
function mountCalibStages(mgr: CalibrationManager): void {
  const root = rootEl.querySelector<HTMLElement>('#calibStageRoot');
  const result = mgr.result;
  if (!root || !result) return;
  const sources: CalibrateStageSource[] = mgr.sources.map((s) => ({
    sourceId: s.sourceId,
    counts: s.counts,
    fittedPeaks: s.fittedPeaks,
  }));
  const stages = buildCalibrateStages({
    result,
    viewModel: mgr.viewModel,
    sources,
    kit: CALIBRATION_KIT,
  });
  stageViewHandle = createStageView({
    root,
    stages,
    ready: true,
    notReadyHint: '',
    initialStage: state.calib.stageIndex,
    // The grouped Build flow owns the rail + bottom toolbar; StageView renders only
    // its canvas + explanation here (DR-D chrome flags).
    chrome: { rail: false, nav: false },
    onStageChange: (i) => {
      state.calib.stageIndex = i;
    },
  });
  // While running, show the engine's current stage (the timed reveal drives it).
  if (mgr.phase.kind === 'running') stageViewHandle.showStage(mgr.phase.stageIndex);
}

/** Mount the Review summary's hero plot (the final Energy-vs-Channel curve) into
 * its own `#calibReviewHero` node. Reuses the Stage-8 drawing exactly: it mounts a
 * single-stage StageView over the final stage so the plot goes through the shared
 * `drawFinalEquationPlot` (no plotting math duplicated). The rail/explanation/nav
 * chrome is hidden by the `.review-hero` CSS modifier -- one plot, not eight. The
 * stage index is NOT threaded back (omitting `onStageChange`) so the hero never
 * clobbers the walkthrough's persisted position. */
function mountReviewHero(mgr: CalibrationManager): void {
  const root = rootEl.querySelector<HTMLElement>('#calibReviewHero');
  const result = mgr.result;
  if (!root || !result) return;
  const sources: CalibrateStageSource[] = mgr.sources.map((s) => ({
    sourceId: s.sourceId,
    counts: s.counts,
    fittedPeaks: s.fittedPeaks,
  }));
  const stages = buildCalibrateStages({ result, viewModel: mgr.viewModel, sources, kit: CALIBRATION_KIT });
  const finalStage = stages[stages.length - 1];
  root.classList.add('review-hero'); // ensure the chrome-hiding modifier survives createStageView
  stageViewHandle = createStageView({
    root,
    stages: [finalStage],
    ready: true,
    notReadyHint: '',
    initialStage: 0,
  });
}

/** Draw the expanded batch row's spectrum for per-file QC (channel axis, detected
 * peaks marked). Reuses the shared spectrum chart; redrawn on render / resize. */
function drawRowQC(): void {
  const rowId = state.calib.expandedRowId;
  const mgr = state.calib.manager;
  if (!rowId || !mgr) return;
  const row = mgr.sources.find((s) => s.rowId === rowId);
  const canvas = rootEl.querySelector<HTMLCanvasElement>('#calQc');
  if (!row || !canvas) return;
  const ACCENT = '#0F6E56';
  // Zoomed: pass the X window plus a count-axis auto-fit to the visible slice. Full
  // view (qcView === null) passes no `view`, so the idle chart is byte-identical to
  // pre-C1. Capture the geometry for the interaction binding (mirrors the inspector).
  const qcView = state.calib.qcView;
  const view = qcView ? { ...qcView, ...fitYToWindow([row.counts], qcView) } : undefined;
  state.calib.qcGeometry =
    drawSpectrum(
      canvas,
      [{ values: row.counts, color: ACCENT, label: 'counts', width: 1.5, fill: true }],
      row.fittedPeaks.map((p) => ({ channel: Math.round(p.centroidChannel), label: '', color: ACCENT })),
      { logY: state.logY, xLabel: 'Channel', yLabel: 'counts', overlays: [], ...(view ? { view } : {}) },
    ) ?? null;
}

/* `drawInspectorChart` moved verbatim into `inspectorWorkspace.ts` (Phase 3),
 * parameterized as (canvas, trace, state, logY) -- the manager lookup is gone
 * (coupling point 1) and the canvas is workspace-root-scoped (coupling point 3). */

function defaultCalName(): string {
  const day = new Date().toISOString().slice(0, 10);
  const ids = (state.calib.manager?.sources ?? [])
    .map((s) => s.sourceId)
    .filter(Boolean)
    .join('+');
  return ids ? `${day} ${ids}` : day;
}

// --- pipeline (engine untouched) -------------------------------------------

function runPipeline(text: string, fileName: string): void {
  try {
    state.report = analyze({ text, fileName });
    state.error = null;
  } catch (err) {
    state.report = null;
    state.error =
      err instanceof NuclidError ? err.message : `Unexpected error: ${(err as Error).message}`;
  }
  state.overlays = { baseline: false, smoothed: false };
  state.chartView = null; // DR-9: a new spectrum resets zoom/pan to the full range.
  // A new unknown invalidates any prior identification: the Identify manager's
  // `setSpectrum` clears its live result (DEBT-12). runPipeline stays pure here so it
  // never wipes the persistent manager held on `state.ident`.
}

async function loadSample(name: string): Promise<void> {
  try {
    const url = `${import.meta.env.BASE_URL}sample-data/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new ParseError(`Failed to load sample "${name}": HTTP ${res.status}.`);
    runPipeline(await res.text(), name);
  } catch (err) {
    state.report = null;
    state.error =
      err instanceof NuclidError ? err.message : `Unexpected error: ${(err as Error).message}`;
    state.overlays = { baseline: false, smoothed: false };
  }
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&quot;';
    }
  });
}
