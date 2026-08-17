/**
 * peakFinderStepper -- the grouped vertical stepper for the Peak Finder flow.
 * Sibling of `identifyStepper.ts` (itself the mirror of `buildStepper.ts`, the
 * reference interaction model for this product family); only the group counts
 * and copy differ for the Peak Finder task. The three-way duplication is the
 * registered PARK-11 pattern (convergent UX now, shared code later).
 *
 * Pure presentation + derivation: it turns the free-navigation state (`reached` /
 * `focus` / `revealCursor`) into one ordered, grouped, lockable step model and the markup
 * for the left rail + the active-step card. It owns NO engine, NO store, and NO DOM
 * events -- the handlers stay in app.ts and drive the {@link PeakFinderManager}.
 *
 * The Peak Finder flow is five GROUPS (2026-07-05: #9 split the run stages) -- Load (2
 * sub-steps: Load Spectrum + the raw Savitzky-Golay stage), Estimate Continuum (six navigable
 * sub-pages over the SNIP slices), Detect Peaks (the first six pipeline stages), the "Unnamed"
 * finalize group (Fit + Validated), and Review (1). All eight run-stage labels come from
 * {@link PF_RUN_STAGES} -- the single source of truth for stage ids/labels/captions; the
 * detect/finalize split is a rail GROUPING only (flat `run-k` indices unchanged). The rail is
 * an accordion (#1): exactly one group -- the one owning focus -- is expanded at a time. Every
 * step at or before `reached` is UNLOCKED and directly clickable; steps
 * after it stay locked. During the detection reveal the detect steps ahead of the cursor
 * stay locked (the reveal owns position; first pass is linear per the approved default C).
 *
 * // Divergence: the Load group's two steps are ungated among themselves (no identities /
 * // model / library), so the sequential intra-Configure locking of the Calibrate/Identify
 * // steppers has no subject here and is deliberately absent.
 *
 * It reuses the `.build-*` CSS classes verbatim (Reference-model principle) so
 * the existing rail styles it with no new rules. Exported names are
 * `PeakFinder*`-prefixed so app.ts can import this AND the other steppers
 * without collision (Isolation principle).
 */
import { PF_RUN_STAGES } from './peakFinderStages';

/** The four top-level groups, in flow order (2026-07-05 restructure). The former
 * single-step `configure` + `smooth` groups merged into `load` (Load Spectrum + the raw
 * Savitzky-Golay stage); the former `run` group became `detect`. // Divergence (PARK-11
 * family): Peak Finder keeps its own group set -- do NOT propagate to buildStepper.ts /
 * identifyStepper.ts. */
export type PeakFinderGroup = 'load' | 'continuum' | 'detect' | 'finalize' | 'review';

/** A step's derived status. `upcoming` is part of the shared status vocabulary
 * but unused here (Peak Finder steps are done / active / locked only). */
export type PeakFinderStepStatus = 'done' | 'active' | 'upcoming' | 'locked';

export interface PeakFinderStep {
  readonly group: PeakFinderGroup;
  /** Stable id: 'load-spectrum' | 'load-sg' | 'cont-estimate' | 'run-0'..'run-7' |
   *  'review'. Used for rail data-attrs + panel routing. */
  readonly id: string;
  readonly label: string;
  /** Eyebrow/subtitle for the active-step card. */
  readonly subtitle?: string;
  /** The real module this step runs. Retained on the model for provenance; the stage head
   * no longer renders it (the mono `.step-stage-source` line was removed in V4 chrome). */
  readonly source?: string;
  readonly status: PeakFinderStepStatus;
}

export interface PeakFinderStepModel {
  readonly steps: readonly PeakFinderStep[];
  /** Index into `steps` of the FOCUSED step (the `.current` row). */
  readonly activeIndex: number;
  /** Group of the focused step, for the collapse logic. */
  readonly activeGroup: PeakFinderGroup;
}

/**
 * Free-navigation input (2026-07-05). Status and focus are two orthogonal notions:
 *  - `reached`: the monotone high-water flat index -- every step at or before it is
 *    UNLOCKED; everything after is locked. Advanced only by Continue actions, reset only
 *    by `reset()`; never pulled back by focus navigation.
 *  - `focus`: which unlocked step is on screen (the `.current` row). Never changes any
 *    step's lock / status / glyph.
 */
export interface DerivePeakFinderStepsInput {
  readonly reached: number;
  readonly focus: number;
}

// --- static step metadata ---------------------------------------------------

interface StepMeta {
  readonly group: PeakFinderGroup;
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
  readonly source?: string;
}

/** The two Load sub-steps (the former `configure` + `smooth` groups, merged 2026-07-05):
 * upload -> raw preview -> Continue, then the raw Savitzky-Golay stage. */
const LOAD_STEP_META: readonly StepMeta[] = [
  {
    group: 'load',
    id: 'load-spectrum',
    label: 'Load Spectrum',
    subtitle: 'Add a spectrum and preview it, then continue to smoothing.',
    // The Load step reads the file into counts per channel (io/parse.ts).
    source: 'io/parse.ts',
  },
  {
    group: 'load',
    id: 'load-sg',
    label: 'Savitzky–Golay (Raw)',
    subtitle: 'Optionally smooth the raw spectrum, then continue to the continuum.',
    // The Savitzky-Golay filter (signal/savgol.ts) applied to the raw counts.
    source: 'signal/savgol.ts',
  },
];

/** The Estimate Continuum group -- six navigable sub-pages, each visualising one slice of
 * the SNIP pipeline the engine already computes in one call (no re-run). The working copy is
 * the selected input; the two LLS pages reconstruct the log-log-sqrt domain SNIP clips in;
 * inverse-LLS shows the background over the input; Net is input − background; the last page
 * is the optional Savitzky-Golay on the net. */
const CONTINUUM_STEP_META: readonly StepMeta[] = [
  {
    group: 'continuum',
    id: 'cont-working',
    label: 'Create Working Copy',
    subtitle: 'The input spectrum the continuum estimation operates on.',
    source: 'pipeline/condition.ts',
  },
  {
    group: 'continuum',
    id: 'cont-lls',
    label: 'LLS Transform',
    subtitle: 'The working copy in the log-log-sqrt domain SNIP clips in.',
    source: 'pipeline/condition.ts',
  },
  {
    group: 'continuum',
    id: 'cont-snip',
    label: 'SNIP Peak Clipping',
    subtitle: 'The clipped continuum, shown in the LLS domain over the LLS input.',
    source: 'pipeline/condition.ts',
  },
  {
    group: 'continuum',
    id: 'cont-invlls',
    label: 'Inverse LLS Transform',
    subtitle: 'The background transformed back to counts, over the input.',
    source: 'pipeline/condition.ts',
  },
  {
    group: 'continuum',
    id: 'cont-net',
    label: 'Net Spectrum',
    subtitle: 'Net = input − background (clamped at zero) — the detection input.',
    source: 'pipeline/condition.ts',
  },
  {
    group: 'continuum',
    id: 'cont-sg',
    label: 'Savitzky–Golay (Net)',
    subtitle: 'Optionally smooth the net before detection; areas stay raw.',
    source: 'signal/savgol.ts',
  },
];

/** Shared subtitle for every Detect stage (the per-stage detail lives on the canvas). */
const RUN_STEP_SUBTITLE = 'Watch the detection pipeline evolve one stage at a time.';

/** The two run stages that live in the `finalize` ("Unnamed") group (#9, 2026-07-05): Fit
 * and Validated. Keyed by stage id, NOT a magic index, so the split survives PF_RUN_STAGES
 * reordering. The other six stay in `detect`. This is a rail-GROUPING change only -- the flat
 * `run-k` indices, RUN_OFFSET, and the reveal logic are untouched. */
const FINALIZE_STAGE_IDS = new Set(['fit', 'validated']);

/** Run sub-steps, derived from the eight PF-owned Run stage labels (single source of truth
 * {@link PF_RUN_STAGES} -- never duplicated here): the six detection sub-stages under `detect`,
 * plus Fit + Validated under the `finalize` ("Unnamed") group (#9). The group split is by
 * stage id ({@link FINALIZE_STAGE_IDS}); the flat `run-k` index is unchanged. */
const RUN_STEP_META: readonly StepMeta[] = PF_RUN_STAGES.map((stage, k) => ({
  group: (FINALIZE_STAGE_IDS.has(stage.id) ? 'finalize' : 'detect') as PeakFinderGroup,
  id: `run-${k}`,
  label: stage.label,
  subtitle: RUN_STEP_SUBTITLE,
  // Truthful per-stage module path (single source of truth: PF_RUN_STAGES).
  source: stage.source,
}));

const REVIEW_STEP_META: StepMeta = {
  group: 'review',
  id: 'review',
  label: 'Detected Peaks',
  subtitle: 'The validated peaks, with the full pipeline behind them.',
};

/** The full ordered step list (metadata), flat. The single source of truth for the flat
 * navigation indices the manager latches on (`reached` / `focus`) and for the rail order. */
const STEP_META: readonly StepMeta[] = [
  ...LOAD_STEP_META,
  ...CONTINUUM_STEP_META,
  ...RUN_STEP_META,
  REVIEW_STEP_META,
];

/** The ordered step ids -- the manager maps its `reached` / `focus` flat indices through
 * this (single source, so the id list never drifts from the rendered rail). */
export const PF_STEP_IDS: readonly string[] = STEP_META.map((m) => m.id);

/** Group order + display labels for the rail (the five top-level rows, #9). `finalize` sits
 * between `detect` and `review`, holding Fit + Validated; its label is the literal "Unnamed"
 * (D-9a, provisional -- rename when a name is chosen). */
const GROUP_ORDER: readonly PeakFinderGroup[] = [
  'load',
  'continuum',
  'detect',
  'finalize',
  'review',
];
const GROUP_LABEL: Record<PeakFinderGroup, string> = {
  load: 'Load',
  continuum: 'Estimate Continuum',
  detect: 'Detect Peaks',
  finalize: 'Finalize Peaks',
  review: 'Review',
};

// --- workflow boundary (PF-only presentational appendix) --------------------

// // Divergence (workflow boundary, PF-only): the stages BEYOND Peak Finder's responsibility.
// // These are NOT pipeline steps -- they never enter STEP_META / PF_STEP_IDS (which the manager's
// // flat indices + reveal are coupled to). They are a presentational rail appendix routed by a
// // view-local flag (app.ts state.pf.boundaryView), so the manager stays channel-space-only.
// // Do NOT propagate to buildStepper.ts / identifyStepper.ts (PARK-11 family).
export interface PeakFinderBoundaryStage {
  readonly id: 'energy-cal' | 'radionuclide-id' | 'quantification';
  readonly label: string;
}

/** The post-Validation gamma-spectroscopy stages, shown as locked-but-clickable teaching rows
 * below the pipeline (D-1/D-2, 2026-07-07). Ordered as they occur downstream of Peak Finder. */
export const PF_BOUNDARY_STAGES: readonly PeakFinderBoundaryStage[] = [
  { id: 'energy-cal', label: 'Energy Calibration' },
  { id: 'radionuclide-id', label: 'Radionuclide Identification' },
  { id: 'quantification', label: 'Quantification' },
];

// --- derivation -------------------------------------------------------------

function clamp(i: number, max: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(0, Math.floor(i)), max);
}

/**
 * Build the grouped step model from the free-navigation state (2026-07-05 restructure).
 *
 * Status is a pure function of `reached` (NEVER `focus`), so navigating the rail never
 * changes any step's icon:
 *  - locked: flat index > `reached`.
 *  - done: an unlocked step behind the frontier (index < `reached`).
 *  - active: the frontier step (index === `reached`). (The last-reached step being `active`
 *    gives Review the open-lock glyph once detection is done and Review is the frontier -- a
 *    permanent review surface, never `done`, since nothing lies beyond it.)
 * Focus (`activeIndex`) is carried separately; the rail highlights it via `.current`.
 */
export function derivePeakFinderSteps(input: DerivePeakFinderStepsInput): PeakFinderStepModel {
  const total = STEP_META.length;
  const reached = clamp(input.reached, total - 1);
  const focus = clamp(input.focus, total - 1);

  const statusAt = (i: number): PeakFinderStepStatus => {
    if (i > reached) return 'locked';
    if (i < reached) return 'done';
    return 'active'; // i === reached -- the frontier
  };

  const steps: PeakFinderStep[] = STEP_META.map((m, i) => ({ ...m, status: statusAt(i) }));
  return { steps, activeIndex: focus, activeGroup: STEP_META[focus].group };
}

// --- markup -----------------------------------------------------------------

// Trailing three-state glyphs for the `.step-film-status` slot -- all inline
// currentColor SVGs (same grammar) so each tints with its row's state colour:
// locked -> closed padlock; active -> OPEN padlock (unlocked/available); done -> check.
const LOCK_ICON =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const UNLOCK_ICON =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
const DONE_ICON =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ` +
  `stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="M20 6 9 17l-5-5"/></svg>`;
/** Trailing chevron for the boundary rows' status slot -- signals "opens a page" (same SVG
 * grammar as the state glyphs, currentColor so it tints with the muted row colour). */
const CHEVRON_ICON =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
  `<path d="m9 18 6-6-6-6"/></svg>`;

/** One boundary (locked-but-clickable) rail row. Unlike the pipeline `locked` rows -- which
 * are `aria-disabled` + inert -- these carry a NEW `data-boundary` attr, `role="button"`, and
 * `tabindex="0"`, so the app.ts `[data-boundary]` handler (§4c) opens their teaching page while
 * the not-yet-reached pipeline rows stay inert. The LOCK_ICON leads (in the number slot) and a
 * chevron trails; `.current` marks the row whose page is open (opts.activeBoundary). */
function boundaryItemMarkup(stage: PeakFinderBoundaryStage, isActive: boolean): string {
  const currentClass = isActive ? ' current' : '';
  return `<li class="step-film-item pf-boundary${currentClass}" data-boundary="${stage.id}" role="button" tabindex="0" aria-label="${escapeHtml(stage.label)} — locked; opens an explanation">
      <span class="step-film-num" aria-hidden="true">${LOCK_ICON}</span>
      <span class="step-film-label">${escapeHtml(stage.label)}</span>
      <span class="step-film-status" aria-hidden="true">${CHEVRON_ICON}</span>
    </li>`;
}

/** Steps of a single group, in order. */
function stepsOf(model: PeakFinderStepModel, group: PeakFinderGroup): readonly PeakFinderStep[] {
  return model.steps.filter((s) => s.group === group);
}

// // Divergence: v3's `.step-film-item` is a <button>; the grouped rail keeps the
// // step model's <li> + role/aria (produced unchanged by derivePeakFinderSteps)
// // so the locked-inert semantics and the app.ts keydown handler survive the
// // reskin. Only the class names + wrapper change.

/** The trailing three-state glyph for the status slot (aria-hidden; the state is
 * already conveyed by aria-current / aria-disabled on the row).
 * // Divergence (PARK-11 family): Peak Finder rows KEEP the number and add a
 * // lock/unlock/check state glyph -- Calibrate/Identify replace the number with a
 * // check and have no unlock state. PF-only enhancement; do NOT propagate to
 * // buildStepper.ts / identifyStepper.ts. */
function statusGlyph(status: PeakFinderStepStatus): string {
  if (status === 'done') return DONE_ICON;
  if (status === 'active') return UNLOCK_ICON;
  if (status === 'locked') return LOCK_ICON;
  return '';
}

/** One expanded `.step-film-item`. Locked rows are not focusable and carry
 * `aria-disabled`. Every row shows its number badge (`globalNumber`, never replaced
 * -- point 4) AND a trailing `.step-film-status` glyph.
 *
 * // Rev 5: STATUS and FOCUS are decoupled. The status class (`active`/`locked`/
 * // `done`) + the glyph come from `step.status` (execution state) -- this is the
 * // ONLY thing that sets the icon, so a focused `done` stage keeps its check and
 * // Review keeps its unlock. The focus highlight (`.current` + `aria-current`) comes
 * // from `isCurrent` (this step === `model.activeIndex`), set by navigation. A row
 * // can be `.done.current` (completed + focused) or `.active.current` (Review focused).
 * `globalNumber` is the step's continuous 1-based position across the whole pipeline
 * (Load 1-2 · Continuum 3-8 · Detect 9-14 · Unnamed 15-16 · Review 17) -- see the global-badge divergence on
 * `groupMarkup`. */
function stepItemMarkup(step: PeakFinderStep, globalNumber: number, isCurrent: boolean): string {
  const statusClass =
    step.status === 'active'
      ? ' active'
      : step.status === 'locked'
        ? ' locked'
        : step.status === 'done'
          ? ' done'
          : '';
  const currentClass = isCurrent ? ' current' : '';
  const attrs = [
    `class="step-film-item${statusClass}${currentClass}"`,
    `data-step="${step.id}"`,
    isCurrent ? 'aria-current="step"' : '',
    step.status === 'locked' ? 'aria-disabled="true"' : 'tabindex="0"',
  ]
    .filter(Boolean)
    .join(' ');
  return `<li ${attrs}>
      <span class="step-film-num">${globalNumber}</span>
      <span class="step-film-label">${escapeHtml(step.label)}</span>
      <span class="step-film-status" aria-hidden="true">${statusGlyph(step.status)}</span>
    </li>`;
}

/** One group's rows in the flat film-strip: a neutral `.step-film-group` eyebrow
 * followed by ALL its sub-steps, expanded. Returns a fragment of `<li>`s. Rendered ONLY for
 * the FOCUSED group now (the accordion, #1); every other group renders as a single
 * {@link collapsedGroupMarkup} header row.
 *
 * // PARK-11 full-expand RETIRED (#1, 2026-07-05): Peak Finder previously rendered the entire
 * // pipeline expanded at once (the Rev 2 full-expand divergence). That is superseded by the
 * // accordion -- exactly one group (the one owning focus) is expanded; the rest collapse. The
 * // Calibrate/Identify collapse-to-representative pattern is still theirs and still distinct;
 * // do NOT propagate this rail to buildStepper.ts / identifyStepper.ts (still PARK-11 family).
 * // Locked rows stay inert (aria-disabled, not focusable) via stepItemMarkup. */
function groupMarkup(
  model: PeakFinderStepModel,
  group: PeakFinderGroup,
  activeIndex: number = model.activeIndex,
): string {
  const steps = stepsOf(model, group);
  const name = GROUP_LABEL[group];
  // // Divergence: v3's flat film-strip has no groups; the eyebrow rows carry the
  // // v4 grouped IA (Configure / Run / Review) into the same film-strip idiom.
  const eyebrow = `<li class="step-film-group">${escapeHtml(name)}</li>`;
  // // Divergence (global badges): the badge is the step's continuous position in the
  // // whole pipeline (Load 1-2 · Continuum 3-8 · Detect 9-14 · Unnamed 15-16 · Review 17), NOT a per-group 1..n. This
  // // departs from Identify/Calibrate's per-group badges; justified because Peak
  // // Finder shows the entire pipeline as one continuous expanded list (the Rev 2
  // // full-expand divergence, PARK-11). Do NOT propagate to build/identify steppers.
  return (
    eyebrow +
    steps
      .map((s) => {
        const gi = model.steps.indexOf(s);
        // // Rev 5: `isCurrent` (focus) is independent of `s.status` (execution). When a boundary
        // // page is open, `activeIndex` is passed as -1 so no pipeline row shows `.current`.
        return stepItemMarkup(s, gi + 1, gi === activeIndex);
      })
      .join('')
  );
}

/** A single collapsed group header (#1 accordion): shown for every group that does NOT own
 * focus. One clickable `<li>` with the group label and a state glyph (the per-group
 * `done/total` count was dropped 2026-07-05). State is derived purely from the group's step
 * statuses (never focus):
 *  - not reached (every step locked) -> `locked` modifier, lock glyph, `aria-disabled` (inert,
 *    honours the unlock gate -- you cannot jump into a group you have not reached);
 *  - reached, some steps left -> `reached` modifier, unlock glyph, clickable (`data-group`);
 *  - all steps done -> `done` modifier, check glyph, still clickable (revisit).
 * Clicking a clickable header moves focus to the group's first step (app.ts handler), which
 * re-expands it -- expansion always derives from focus, so the focused group cannot be
 * collapsed (D-1b/D-9b by construction). */
function collapsedGroupMarkup(model: PeakFinderStepModel, group: PeakFinderGroup): string {
  const steps = stepsOf(model, group);
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done').length;
  const reached = steps.some((s) => s.status !== 'locked');
  const allDone = total > 0 && done === total;
  const state = !reached ? 'locked' : allDone ? 'done' : 'reached';
  const glyph = !reached ? LOCK_ICON : allDone ? DONE_ICON : UNLOCK_ICON;
  const name = GROUP_LABEL[group];
  const attrs = [
    `class="step-film-group step-film-group--collapsed ${state}"`,
    reached ? `data-group="${group}" role="button" tabindex="0"` : 'aria-disabled="true"',
  ].join(' ');
  return `<li ${attrs}>
      <span class="step-film-grouplabel">${escapeHtml(name)}</span>
      <span class="step-film-status" aria-hidden="true">${glyph}</span>
    </li>`;
}

/** The id of the first step in a group -- the target the accordion header nav moves focus to
 * (#1). `STEP_META` order is the flow order, so `.find` yields the earliest step. */
export function peakFinderFirstStepOfGroup(group: PeakFinderGroup): string | undefined {
  return STEP_META.find((m) => m.group === group)?.id;
}

/** An always-present, visually-hidden IN-FLOW sizer (#2, 2026-07-05): one ghost row for every
 * label that can EVER appear in the rail -- a step ghost (num badge + label + status) per
 * {@link STEP_META} entry and a group-header ghost (label + status) per {@link GROUP_ORDER}
 * value -- built from the same constants as the real rows so the reserved width tracks any
 * label change automatically. Because the sizer is in-flow, the rail's `width: max-content`
 * resolves to the widest ghost (the true GLOBAL maximum -- `Preliminary Classification`),
 * independent of which group the accordion has expanded; so the rail width is constant across
 * navigation and no visible row is ever wider than the reserved box. `.pf-rail-sizer` collapses
 * it to zero height, preserving only its inline (width) contribution; `aria-hidden` keeps the
 * duplicate labels out of the a11y tree. Any placeholder digit/glyph -- the box reserves width
 * from the row chrome + label, not the content of the badge or status slot. */
function railSizerMarkup(): string {
  const stepGhosts = STEP_META.map(
    (m) => `<div class="step-film-item">
        <span class="step-film-num">0</span>
        <span class="step-film-label">${escapeHtml(m.label)}</span>
        <span class="step-film-status" aria-hidden="true">${LOCK_ICON}</span>
      </div>`,
  ).join('');
  const groupGhosts = GROUP_ORDER.map(
    (g) => `<div class="step-film-group--collapsed">
        <span class="step-film-grouplabel">${escapeHtml(GROUP_LABEL[g])}</span>
        <span class="step-film-status" aria-hidden="true">${LOCK_ICON}</span>
      </div>`,
  ).join('');
  // The boundary rows can be the global-widest label ('Radionuclide Identification'); their
  // ghosts keep the constant-width rail wide enough to hold them (#2 covers every possible row).
  const boundaryGhosts = PF_BOUNDARY_STAGES.map(
    (s) => `<div class="step-film-item">
        <span class="step-film-num">0</span>
        <span class="step-film-label">${escapeHtml(s.label)}</span>
        <span class="step-film-status" aria-hidden="true">${LOCK_ICON}</span>
      </div>`,
  ).join('');
  return `<li class="pf-rail-sizer" aria-hidden="true">${stepGhosts}${groupGhosts}${boundaryGhosts}</li>`;
}

/** The full left rail: v3's `.step-film` strip carrying the three grouped rows with
 * every stage expanded, plus a bottom `.step-film-actions` footer (pinned via
 * `margin-top:auto`). The footer renders in EVERY phase so the user is never trapped:
 * "Close Workspace" (`#pfCloseWorkspace`, clears the workspace then returns to landing) is
 * always shown. When a spectrum is HELD (`opts.hasSpectrum`, i.e. preprocessing / continuum
 * / running / done) two file-management actions appear above it, top→bottom: "Load Another
 * File" (`#pfLoadAnother` label wrapping the hidden `#pfRailFile` input -- replaces the
 * current spectrum on select, §D) and "Clear Workspace" (`#pfClearSpectrum`, the
 * consolidated reset). Both are hidden on the empty Load step and on `error` (no held
 * spectrum). // Load-UX refinement (§D): the file loader lives in the rail, not the body,
 * once a spectrum is loaded; the empty state keeps its body dropdown + file button.
 * // Divergence: kept as an `<ol>` (v3 uses `<nav>`) so the grouped `<li>` items
 * // stay valid list semantics; `.step-film` styling is identical either way. */
export function peakFinderStepperRailMarkup(
  model: PeakFinderStepModel,
  opts: { hasSpectrum: boolean; activeBoundary?: PeakFinderBoundaryStage['id'] | null },
): string {
  // When a boundary teaching page is open, the on-screen surface is that page -- not a pipeline
  // step -- so no pipeline row shows `.current` (activeIndex -1 suppresses the focus highlight;
  // execution status glyphs are unchanged). The matching boundary row gets `.current` instead.
  const boundaryActive = opts.activeBoundary ?? null;
  const effectiveActive = boundaryActive ? -1 : model.activeIndex;
  // #1 accordion: exactly one group is expanded -- the one owning focus (`model.activeGroup`);
  // every other group collapses to a single header row. Expansion derives from focus, so the
  // focused group is always the open one (D-1b/D-9b) and needs no separate "expanded" state.
  const groups = GROUP_ORDER.map((g) =>
    g === model.activeGroup ? groupMarkup(model, g, effectiveActive) : collapsedGroupMarkup(model, g),
  ).join('');
  const fileActions = opts.hasSpectrum
    ? `<label class="btn pf-rail-load" id="pfLoadAnother">
        <input id="pfRailFile" type="file" accept=".tka,.csv,.txt,.spe" hidden />
        Load Another File
      </label>
      <button id="pfClearSpectrum" class="btn" type="button">Clear Workspace</button>`
    : '';
  const actions = `<li class="step-film-actions">
      ${fileActions}
      <button id="pfCloseWorkspace" class="btn" type="button">Close Workspace</button>
    </li>`;
  // The boundary appendix (D-1/D-2, always present): a divider then the three locked-but-clickable
  // downstream stages, between the pipeline groups and the footer. The divider is decorative
  // (aria-hidden); the boundary rows carry their own role/aria (see boundaryItemMarkup).
  const divider = `<li class="pf-rail-divider" aria-hidden="true"><span>Next: Calibration</span></li>`;
  const boundary = PF_BOUNDARY_STAGES.map((s) =>
    boundaryItemMarkup(s, s.id === boundaryActive),
  ).join('');
  // #2: the sizer leads the list so `width: max-content` reserves the global-widest label from
  // first render; its zero height leaves the bottom-pinned `.step-film-actions` footer untouched.
  const sizer = railSizerMarkup();
  return `<ol class="step-film" id="pfRail" aria-label="Peak Finder stages">${sizer}${groups}${divider}${boundary}${actions}</ol>`;
}

/** The active step's display label parts -- the single source the active-step card
 * AND the bottom toolbar both read. Returns `null` when there is no active step. */
export function peakFinderActiveStepLabel(
  model: PeakFinderStepModel,
): { group: string; n: number; N: number; name: string } | null {
  const active = model.steps[model.activeIndex];
  if (!active) return null;
  // // Divergence: n/N are the GLOBAL continuous position (Step 1..12 across the
  // // whole pipeline), never restarting per group -- matches the global rail badges.
  return {
    group: GROUP_LABEL[active.group],
    n: model.activeIndex + 1,
    N: model.steps.length,
    name: active.label,
  };
}

/** The active-step card. Reuses the Calibrate/Identify `.build-step-card` component
 * verbatim (Reference-model principle): `.build-card-eyebrow` "Step n of N" (global)
 * + serif `.build-card-title` + muted `.build-card-subtitle`. */
export function peakFinderActiveStepCardMarkup(model: PeakFinderStepModel): string {
  const active = model.steps[model.activeIndex];
  const label = peakFinderActiveStepLabel(model);
  if (!active || !label) return '';
  const subtitle = active.subtitle
    ? `<p class="build-card-subtitle">${escapeHtml(active.subtitle)}</p>`
    : '';
  return `<div class="build-step-card">
      <span class="build-card-eyebrow">Step ${label.n} of ${label.N}</span>
      <h2 class="build-card-title">${escapeHtml(active.label)}</h2>
      ${subtitle}
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
