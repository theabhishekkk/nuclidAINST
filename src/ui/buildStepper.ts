/**
 * buildStepper -- the grouped vertical stepper for the Calibrate Build flow.
 *
 * Pure presentation + derivation: it turns the run phase (+ the UI-only Configure
 * sub-step and Review-view selectors) into one ordered, grouped, lockable step
 * model and the markup for the left rail + the active-step card. It owns NO engine,
 * NO store, and NO DOM events -- the handlers (rail clicks, Prev/Next) stay in
 * app.ts and drive the manager. This module is the single source of truth for which
 * step is active and which are done / upcoming / locked, so the rail, the panel
 * routing, and the bottom toolbar all agree.
 *
 * The Build flow is three GROUPS -- Configure (4 sub-steps), Run (the 8 engine
 * stages), Review (1 summary) -- presented as one continuous guided experience.
 * Only the active group is expanded in the rail; inactive groups collapse to a
 * header with a compact summary. Future groups/steps are padlocked until their
 * prerequisites are met: Run + Review stay locked until a result exists (`hasResult`),
 * and during the reveal the Run steps ahead of the engine's cursor stay locked
 * (the reveal owns position -- the operator cannot jump ahead).
 */
import type { RunPhase } from './calibrationManager';
import { CALIBRATE_STAGE_LABELS } from './calibrateStages';

/** The three top-level groups, in flow order. */
export type BuildGroup = 'configure' | 'run' | 'review';

/** A step's derived status. `upcoming` = navigable but not yet reached (Configure
 * only); `locked` = padlocked, not clickable (Run/Review before their gate, or Run
 * stages ahead of the reveal cursor). */
export type BuildStepStatus = 'done' | 'active' | 'upcoming' | 'locked';

export interface BuildStep {
  readonly group: BuildGroup;
  /** Stable id, e.g. 'cfg-load' | 'cfg-identity' | 'cfg-model' | 'cfg-create'
   *  | 'run-0'..'run-7' | 'review'. Used for rail data-attrs + panel routing. */
  readonly id: string;
  readonly label: string;
  /** Eyebrow/subtitle for the active-step card (v3 style). */
  readonly subtitle?: string;
  readonly status: BuildStepStatus;
}

export interface BuildStepModel {
  readonly steps: readonly BuildStep[];
  /** Index into `steps` of the active step (derived from phase + configStep). */
  readonly activeIndex: number;
  /** Active group, for the collapse logic. */
  readonly activeGroup: BuildGroup;
}

export interface DeriveBuildStepsInput {
  readonly phase: RunPhase;
  /** mgr.ready -- gates the Create step / Run group (used by the toolbar, not the
   *  rail status: Configure steps are never padlocked). */
  readonly ready: boolean;
  /** mgr.result != null -- unlocks the Run + Review groups. */
  readonly hasResult: boolean;
  /** 0..3 within Configure (UI-only sub-step position). */
  readonly configStep: number;
  /** 0..7 within Run (the walkthrough position when `done`). */
  readonly stageIndex: number;
  readonly reviewView: 'summary' | 'walkthrough';
  /** Cumulative completion of the 4 Configure steps (load, identity, model, create-gate).
   *  Drives intra-group sequential locking: step i is reachable only when every earlier
   *  step is complete. MUST be monotonic (configComplete[i] implies configComplete[i-1]);
   *  the caller builds it cumulatively. */
  readonly configComplete: readonly boolean[];
}

// --- static step metadata ---------------------------------------------------

interface StepMeta {
  readonly group: BuildGroup;
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
}

/** The four Configure sub-steps (ids/labels/subtitles fixed by the hand-off). */
const CONFIGURE_STEP_META: readonly StepMeta[] = [
  { group: 'configure', id: 'cfg-load', label: 'Load sources', subtitle: 'Add the spectra to calibrate from.' },
  { group: 'configure', id: 'cfg-identity', label: 'Assign Energies', subtitle: 'Match a known energy to each detected peak.' },
  { group: 'configure', id: 'cfg-model', label: 'Select model', subtitle: 'Linear, quadratic, or auto.' },
  { group: 'configure', id: 'cfg-create', label: 'Create calibration', subtitle: 'Review inputs and build.' },
];

/** Shared subtitle for every Run stage (the per-stage detail lives on the canvas). */
const RUN_STEP_SUBTITLE = 'Walk the engine’s reasoning one stage at a time.';

const REVIEW_STEP_META: StepMeta = {
  group: 'review',
  id: 'review',
  label: 'Summary',
  subtitle: 'Confirm the fit, then save the calibration.',
};

/** Run sub-steps, derived from the engine's eight stage labels. */
const RUN_STEP_META: readonly StepMeta[] = CALIBRATE_STAGE_LABELS.map((label, k) => ({
  group: 'run' as const,
  id: `run-${k}`,
  label,
  subtitle: RUN_STEP_SUBTITLE,
}));

const CONFIGURE_STEP_COUNT = CONFIGURE_STEP_META.length; // 4
const RUN_STEP_COUNT = RUN_STEP_META.length; // 8

/** Group order + display labels for the rail (the three top-level rows). */
const GROUP_ORDER: readonly BuildGroup[] = ['configure', 'run', 'review'];
const GROUP_LABEL: Record<BuildGroup, string> = {
  configure: 'Configure',
  run: 'Run',
  review: 'Review',
};

// --- derivation -------------------------------------------------------------

function clamp(i: number, max: number): number {
  if (!Number.isFinite(i)) return 0;
  return Math.min(Math.max(0, Math.floor(i)), max);
}

/** Build the unified step model from the run phase + the UI sub-step selectors.
 * Status rules (hand-off): Configure steps are sequentially gated -- a step is
 * `locked` until every earlier step is complete (see the `leadingComplete` /
 * `reachableMax` block below); Run + Review are locked until `hasResult`; during the
 * reveal the Run stages ahead of the cursor are locked; on `done` the walkthrough
 * makes one Run stage active and Review either active (summary) or done (walkthrough). */
export function deriveBuildSteps(input: DeriveBuildStepsInput): BuildStepModel {
  const { phase, hasResult, configStep, stageIndex, reviewView, configComplete } = input;
  const kind = phase.kind;
  const walkStage = clamp(stageIndex, RUN_STEP_COUNT - 1);
  // The engine's reveal cursor (running only); otherwise unused.
  const runCursor = phase.kind === 'running' ? clamp(phase.stageIndex, RUN_STEP_COUNT - 1) : 0;

  // Sequential intra-Configure gating: a step is reachable only when every earlier
  // step is complete. `leadingComplete` is the count of leading complete steps =
  // the first incomplete index; that first-incomplete step is reachable (and can be
  // active), everything past it is locked. The active position clamps to the highest
  // reachable index so it can never point at a locked step.
  let leadingComplete = 0;
  while (leadingComplete < CONFIGURE_STEP_COUNT && configComplete[leadingComplete]) leadingComplete++;
  const reachableMax = Math.min(leadingComplete, CONFIGURE_STEP_COUNT - 1);
  const cfgActive = clamp(configStep, reachableMax);

  const configStatus = (i: number): BuildStepStatus => {
    if (kind === 'collecting' || kind === 'error') {
      if (i > reachableMax) return 'locked'; // a previous step is not yet complete
      if (i === cfgActive) return 'active';
      // Steps 0..2 show a done check once complete; Create (the last step) is never
      // "done" pre-build -- it completes by building, which leaves `collecting`.
      if (i < CONFIGURE_STEP_COUNT - 1 && configComplete[i]) return 'done';
      return 'upcoming';
    }
    return 'done'; // running | done -> Configure is behind the cursor
  };

  const runStatus = (k: number): BuildStepStatus => {
    if (!hasResult) return 'locked';
    if (kind === 'running') {
      if (k < runCursor) return 'done';
      if (k === runCursor) return 'active';
      return 'locked'; // reveal owns position -- cannot jump ahead
    }
    // done: the walkthrough makes one stage active; all others are done.
    if (reviewView === 'walkthrough' && k === walkStage) return 'active';
    return 'done';
  };

  const reviewStatus = (): BuildStepStatus => {
    if (!hasResult || kind === 'running') return 'locked';
    return reviewView === 'summary' ? 'active' : 'done';
  };

  const steps: BuildStep[] = [
    ...CONFIGURE_STEP_META.map((m, i) => ({ ...m, status: configStatus(i) })),
    ...RUN_STEP_META.map((m, k) => ({ ...m, status: runStatus(k) })),
    { ...REVIEW_STEP_META, status: reviewStatus() },
  ];

  let activeGroup: BuildGroup;
  let activeIndex: number;
  if (kind === 'running') {
    activeGroup = 'run';
    activeIndex = CONFIGURE_STEP_COUNT + runCursor;
  } else if (kind === 'done') {
    if (reviewView === 'walkthrough') {
      activeGroup = 'run';
      activeIndex = CONFIGURE_STEP_COUNT + walkStage;
    } else {
      activeGroup = 'review';
      activeIndex = CONFIGURE_STEP_COUNT + RUN_STEP_COUNT; // the single Review step
    }
  } else {
    activeGroup = 'configure';
    activeIndex = cfgActive;
  }

  return { steps, activeIndex, activeGroup };
}

// --- markup -----------------------------------------------------------------

// Trailing three-state glyphs for the `.step-film-status` slot -- inline `currentColor`
// stroke SVGs (same grammar as identifyStepper / peakFinderStepper -- mirror, not import;
// the registered PARK-11 three-way duplication): locked -> closed padlock; active -> OPEN
// padlock (available); done -> check. Adopted 2026-07-07 when the Calibrate builder rail
// converged onto Peak Finder's `.step-*` film-strip DOM (operator directive -- the same
// migration HANDOFF_IDENTIFY_PF_DOM.md applied to Identify, now applied to Calibrate).
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

/** Steps of a single group, in order. */
function stepsOf(model: BuildStepModel, group: BuildGroup): readonly BuildStep[] {
  return model.steps.filter((s) => s.group === group);
}

/** The trailing three-state glyph for the `.step-film-status` slot (aria-hidden; the
 * state is already conveyed by aria-current / aria-disabled on the row): done -> check,
 * active -> open padlock, locked -> closed padlock, upcoming -> '' (number only). The
 * Configure-only `upcoming` state (Peak Finder lacks it) shows the number, no glyph. */
function statusGlyph(status: BuildStepStatus): string {
  if (status === 'done') return DONE_ICON;
  if (status === 'active') return UNLOCK_ICON;
  if (status === 'locked') return LOCK_ICON;
  return ''; // upcoming (Configure-only): number badge, no glyph
}

/** One expanded `.step-film-item`. Locked rows are inert (aria-disabled, not focusable);
 * every other status (incl. `upcoming`) is focusable. Each row shows its GLOBAL number
 * badge -- the step's continuous 1-based position across the whole pipeline (Configure
 * 1-4 · Run 5-12 · Review 13) -- plus a trailing `.step-film-status` glyph. `isCurrent`
 * (the `.current` focus highlight) is the focused step, tracked independently of the
 * status glyph so navigating never flips an icon (mirrors PF / Identify Rev 5). */
function stepItemMarkup(step: BuildStep, globalNumber: number, isCurrent: boolean): string {
  const statusClass =
    step.status === 'active'
      ? ' active'
      : step.status === 'locked'
        ? ' locked'
        : step.status === 'done'
          ? ' done'
          : ''; // upcoming: number only, no status class
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

/** One group's rows in the flat film-strip: a neutral `.step-film-group` eyebrow followed
 * by ALL its sub-steps, expanded (no collapse, no representative row) -- matching Peak
 * Finder / Identify. Every group renders fully so the scientist sees the whole pipeline
 * up front (locked rows carry a padlock and stay inert). The badge is each step's
 * continuous position in the WHOLE pipeline, never a per-group 1..n. */
function groupMarkup(model: BuildStepModel, group: BuildGroup): string {
  const steps = stepsOf(model, group);
  const name = GROUP_LABEL[group];
  const eyebrow = `<li class="step-film-group">${escapeHtml(name)}</li>`;
  return (
    eyebrow +
    steps
      .map((s) => {
        const gi = model.steps.indexOf(s);
        // Status (glyph) is execution state; `.current` (focus) is `gi === activeIndex`.
        return stepItemMarkup(s, gi + 1, gi === model.activeIndex);
      })
      .join('')
  );
}

/** The full left rail: the `.step-film` strip carrying every group expanded, plus a
 * bottom `.step-film-actions` footer (pinned via margin-top:auto) with the always-present
 * "Saved calibrations" exit (`#calBuilderCancel`) so the operator is never trapped --
 * mirrors `identifyStepperRailMarkup` / `peakFinderStepperRailMarkup`. Calibrate's footer
 * carries only this one exit (Peak Finder / Identify additionally offer a reset when a run
 * exists; the Calibrate builder's reset lives on its Review surface, so it is not
 * duplicated here). */
export function buildStepperRailMarkup(model: BuildStepModel): string {
  const groups = GROUP_ORDER.map((g) => groupMarkup(model, g)).join('');
  const actions = `<li class="step-film-actions">
      <button id="calBuilderCancel" class="btn" type="button">&larr; Saved calibrations</button>
    </li>`;
  return `<ol class="step-film" id="calRail" aria-label="Build calibration steps">${groups}${actions}</ol>`;
}

/** The active step's display label parts -- the single source the active-step card AND
 * the bottom `.step-nav` toolbar both read, so the card eyebrow ("Step n of N") and the
 * toolbar's progress readout always agree with each other AND with the rail's badges.
 * `n`/`N` are the GLOBAL continuous position across the whole pipeline (Step 1..13:
 * Configure 1-4 · Run 5-12 · Review 13), matching the `.step-film` rail's global numbers
 * (2026-07-07 Peak Finder DOM convergence -- mirrors `identifyActiveStepLabel`). `group`
 * is kept as the toolbar prefix. Returns `null` when there is no active step (error phase). */
export function activeStepLabel(
  model: BuildStepModel,
): { group: string; n: number; N: number; name: string } | null {
  const active = model.steps[model.activeIndex];
  if (!active) return null;
  return {
    group: GROUP_LABEL[active.group],
    n: model.activeIndex + 1,
    N: model.steps.length,
    name: active.label,
  };
}

/** The active-step card header (v3 look): eyebrow "STEP n OF N" within the active
 * group + the step title + its short subtitle. Rendered above the active step body.
 * `headerAction` (optional, PRE-BUILT HTML) renders right-aligned on the title row --
 * injected by the caller so this module stays a pure renderer (no mgr/state
 * access). With the default `''` the output is byte-identical to the action-less
 * form (no headrow wrapper), so existing callers are unaffected. */
export function activeStepCardMarkup(model: BuildStepModel, headerAction = ''): string {
  const active = model.steps[model.activeIndex];
  const label = activeStepLabel(model);
  if (!active || !label) return '';
  const subtitle = active.subtitle
    ? `<p class="build-card-subtitle">${escapeHtml(active.subtitle)}</p>`
    : '';
  const heads = `<span class="build-card-eyebrow">Step ${label.n} of ${label.N}</span>
      <h2 class="build-card-title">${escapeHtml(active.label)}</h2>
      ${subtitle}`;
  if (!headerAction) {
    return `<div class="build-step-card">
      ${heads}
    </div>`;
  }
  return `<div class="build-step-card">
      <div class="build-card-headrow">
        <div class="build-card-heads">${heads}</div>
        ${headerAction}
      </div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
