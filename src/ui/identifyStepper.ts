/**
 * identifyStepper -- the grouped vertical stepper for the Identify flow. Sibling of
 * `peakFinderStepper.ts` (itself a mirror of `buildStepper.ts`, the reference
 * interaction model for this product family); only the group counts and copy differ
 * for the Identify task.
 *
 * Pure presentation + derivation: it turns the run phase (+ the UI-only Configure
 * sub-step and Review-view selectors) into one ordered, grouped, lockable step
 * model and the markup for the left rail + the active-step card. It owns NO engine,
 * NO store, and NO DOM events -- the handlers (rail clicks, Prev/Next) stay in
 * app.ts and drive the {@link IdentifyManager}. This module is the single source of
 * truth for which step is active and which are done / upcoming / locked.
 *
 * The Identify flow is three GROUPS -- Configure (3 sub-steps: load spectrum, select
 * calibration, identify), Run (the 7 display stages), Review (1 summary). Run + Review
 * stay locked until a result exists (`hasResult`), and during the reveal the Run steps
 * ahead of the cursor stay locked (the reveal owns position).
 *
 * // Operator decision 2026-07-04 ("v4 Identify Mode will use the same DOM as v4 Peak
 * // Finder ... match Peak Finder fully"): the RAIL is Peak Finder's `.step-film`
 * // film-strip rendered FULLY EXPANDED (all 11 steps visible at once) with continuous
 * // global 1..11 numbering and the three-state lock -> unlock -> check status glyph.
 * // This adopts the enhancements that `peakFinderStepper.ts` still marks "do NOT
 * // propagate to identifyStepper.ts" -- those notes pre-date this decision and are
 * // superseded for Identify (a DEBT tracks reconciling them). The markup is MIRRORED,
 * // not imported (the three-way build/identify/peak-finder duplication is the
 * // registered PARK-11 pattern; consolidation is a separate future item).
 *
 * It reuses the `.step-*` / `.step-film*` CSS classes verbatim (Reference-model
 * principle) so the existing Peak Finder rail styles it with no new rules. The
 * exported names are `Identify*`-prefixed (local to this file) so app.ts can import
 * this AND the other steppers without collision (Isolation principle: Calibrate and
 * Peak Finder stay untouched).
 */
import type { IdentifyRunPhase } from './identifyManager';
import { IDENTIFY_STAGE_LABELS } from './identifyStages';

/** The three top-level groups, in flow order. */
export type IdentifyGroup = 'configure' | 'run' | 'review';

/** A step's derived status. `upcoming` = navigable but not yet reached (Configure
 * only); `locked` = padlocked, not clickable (Run/Review before their gate, or Run
 * stages ahead of the reveal cursor). */
export type IdentifyStepStatus = 'done' | 'active' | 'upcoming' | 'locked';

export interface IdentifyStep {
  readonly group: IdentifyGroup;
  /** Stable id, e.g. 'cfg-spectrum' | 'cfg-calibration' | 'cfg-identify'
   *  | 'run-0'..'run-6' | 'review'. Used for rail data-attrs + panel routing. */
  readonly id: string;
  readonly label: string;
  /** Eyebrow/subtitle for the active-step card. */
  readonly subtitle?: string;
  readonly status: IdentifyStepStatus;
}

export interface IdentifyStepModel {
  readonly steps: readonly IdentifyStep[];
  /** Index into `steps` of the active step (derived from phase + configStep). */
  readonly activeIndex: number;
  /** Active group, for the collapse logic. */
  readonly activeGroup: IdentifyGroup;
}

export interface DeriveIdentifyStepsInput {
  readonly phase: IdentifyRunPhase;
  /** mgr.ready -- gates the Identify step / Run group (used by the toolbar, not the
   *  rail status: Configure steps are never padlocked). */
  readonly ready: boolean;
  /** mgr.result != null -- unlocks the Run + Review groups. */
  readonly hasResult: boolean;
  /** 0..2 within Configure (UI-only sub-step position). */
  readonly configStep: number;
  /** 0..6 within Run (the walkthrough position when `done`). */
  readonly stageIndex: number;
  readonly reviewView: 'summary' | 'walkthrough';
  /** Cumulative completion of the 3 Configure steps (spectrum, calibration, run-gate).
   *  Drives intra-group sequential locking: step i is reachable only when every earlier
   *  step is complete. MUST be monotonic (configComplete[i] implies configComplete[i-1]);
   *  the caller builds it cumulatively. */
  readonly configComplete: readonly boolean[];
}

// --- static step metadata ---------------------------------------------------

interface StepMeta {
  readonly group: IdentifyGroup;
  readonly id: string;
  readonly label: string;
  readonly subtitle?: string;
}

/** The Configure sub-steps (ids/labels/subtitles fixed by the hand-off). A single
 * meta array so the count derives from `.length` -- adding the deferred
 * "Library + parameters" step later is one more entry, no structural change
 * (hand-off §C extensibility requirement). */
const CONFIGURE_STEP_META: readonly StepMeta[] = [
  {
    group: 'configure',
    id: 'cfg-spectrum',
    label: 'Load spectrum',
    subtitle: 'Add the unknown to identify.',
  },
  {
    group: 'configure',
    id: 'cfg-calibration',
    label: 'Select calibration',
    subtitle: 'Choose the equation that sets the energy axis.',
  },
  {
    group: 'configure',
    id: 'cfg-identify',
    label: 'Identify',
    subtitle: 'Confirm inputs and run.',
  },
];

/** Shared subtitle for every Run stage (the per-stage detail lives on the canvas). */
const RUN_STEP_SUBTITLE = 'Walk the identification one stage at a time.';

const REVIEW_STEP_META: StepMeta = {
  group: 'review',
  id: 'review',
  label: 'Summary',
  subtitle: 'Read the verdict, then export.',
};

/** Run sub-steps, derived from the seven Identify stage labels. */
const RUN_STEP_META: readonly StepMeta[] = IDENTIFY_STAGE_LABELS.map((label, k) => ({
  group: 'run' as const,
  id: `run-${k}`,
  label,
  subtitle: RUN_STEP_SUBTITLE,
}));

const CONFIGURE_STEP_COUNT = CONFIGURE_STEP_META.length; // 3
const RUN_STEP_COUNT = RUN_STEP_META.length; // 7

/** Group order + display labels for the rail (the three top-level rows). */
const GROUP_ORDER: readonly IdentifyGroup[] = ['configure', 'run', 'review'];
const GROUP_LABEL: Record<IdentifyGroup, string> = {
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
 *
 * // Rev 5 (2026-07-04, matching Peak Finder): a step's `status` reflects workflow
 * // EXECUTION only -- never the focus selectors (`reviewView`/`stageIndex`). Configure
 * // steps are sequentially gated (unchanged); Run + Review are locked until `hasResult`;
 * // during the reveal the Run stages ahead of the cursor are locked (locked -> active ->
 * // done as the cursor passes). Once `done`, the shape is FIXED regardless of focus: all
 * // seven Run stages stay `done`, and Review is a permanent review surface that is always
 * // `active` (never `done`). Focus is carried SEPARATELY by `activeIndex`/`activeGroup`
 * // (below), which still read `reviewView`/`stageIndex`; the rail highlights `activeIndex`
 * // while the glyph reads `status`, so navigating the walkthrough never flips a Run
 * // stage's icon. Configure remains the exception (its status IS its position). */
export function deriveIdentifySteps(input: DeriveIdentifyStepsInput): IdentifyStepModel {
  const { phase, hasResult, configStep, stageIndex, reviewView, configComplete } = input;
  const kind = phase.kind;
  const walkStage = clamp(stageIndex, RUN_STEP_COUNT - 1);
  // The engine's reveal cursor (running only); otherwise unused.
  const runCursor = phase.kind === 'running' ? clamp(phase.stageIndex, RUN_STEP_COUNT - 1) : 0;

  // Sequential intra-Configure gating: a step is reachable only when every earlier
  // step is complete. `leadingComplete` is the count of leading complete steps =
  // the first incomplete index; that first-incomplete step is reachable (and can be
  // active), everything past it is locked.
  let leadingComplete = 0;
  while (leadingComplete < CONFIGURE_STEP_COUNT && configComplete[leadingComplete]) leadingComplete++;
  const reachableMax = Math.min(leadingComplete, CONFIGURE_STEP_COUNT - 1);
  const cfgActive = clamp(configStep, reachableMax);

  const configStatus = (i: number): IdentifyStepStatus => {
    if (kind === 'collecting' || kind === 'error') {
      if (i > reachableMax) return 'locked'; // a previous step is not yet complete
      if (i === cfgActive) return 'active';
      // Steps before the last show a done check once complete; the Identify gate (the
      // last step) is never "done" pre-run -- it completes by running, which leaves
      // `collecting`.
      if (i < CONFIGURE_STEP_COUNT - 1 && configComplete[i]) return 'done';
      return 'upcoming';
    }
    return 'done'; // running | done -> Configure is behind the cursor
  };

  const runStatus = (k: number): IdentifyStepStatus => {
    if (!hasResult) return 'locked';
    if (kind === 'running') {
      if (k < runCursor) return 'done';
      if (k === runCursor) return 'active';
      return 'locked'; // reveal owns position -- cannot jump ahead
    }
    // Rev 5: once the reveal has passed a stage it stays `done` for the whole session --
    // focus (the walkthrough position, `stageIndex`) never flips it back to active. The
    // walkthrough moves `activeIndex` alone (below), highlighting a `done` row.
    return 'done';
  };

  const reviewStatus = (): IdentifyStepStatus => {
    if (!hasResult || kind === 'running') return 'locked';
    // Rev 5: Summary is a permanent review surface -- always `active` (the open-lock
    // glyph), never `done`, independent of whether it is the focused step.
    return 'active';
  };

  const steps: IdentifyStep[] = [
    ...CONFIGURE_STEP_META.map((m, i) => ({ ...m, status: configStatus(i) })),
    ...RUN_STEP_META.map((m, k) => ({ ...m, status: runStatus(k) })),
    { ...REVIEW_STEP_META, status: reviewStatus() },
  ];

  let activeGroup: IdentifyGroup;
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

// Trailing three-state glyphs for the `.step-film-status` slot -- all inline
// currentColor SVGs (same grammar) so each tints with its row's state colour:
// locked -> closed padlock; active -> OPEN padlock (unlocked/available); done -> check.
// Copied verbatim from peakFinderStepper.ts (mirror, not import -- PARK-11); Identify
// gains the `active`/UNLOCK state the old collapse rail lacked (2026-07-04 decision).
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
function stepsOf(model: IdentifyStepModel, group: IdentifyGroup): readonly IdentifyStep[] {
  return model.steps.filter((s) => s.group === group);
}

/** The trailing three-state glyph for the status slot (aria-hidden; the state is
 * already conveyed by aria-current / aria-disabled on the row): done -> check,
 * active -> open padlock, locked -> closed padlock, upcoming -> '' (number only).
 * // Divergence (PARK-11 family): Identify rows now KEEP the global number and add a
 * // lock/unlock/check glyph, matching Peak Finder (2026-07-04). `upcoming` is the
 * // Identify-only Configure state Peak Finder lacks -- it shows the number, no glyph. */
function statusGlyph(status: IdentifyStepStatus): string {
  if (status === 'done') return DONE_ICON;
  if (status === 'active') return UNLOCK_ICON;
  if (status === 'locked') return LOCK_ICON;
  return ''; // upcoming (Configure-only): number badge, no glyph
}

/** One expanded `.step-film-item`. Locked rows are inert (aria-disabled, not
 * focusable); every other status (incl. `upcoming`) is focusable. Each row shows its
 * global number badge AND a trailing `.step-film-status` glyph.
 *
 * // Rev 5 (2026-07-04): STATUS and FOCUS are decoupled. The status class
 * // (`active`/`locked`/`done`; nothing for `upcoming`) + the glyph come from
 * // `step.status` (execution state) ONLY -- this is the ONLY thing that sets the icon,
 * // so a focused `done` stage keeps its check and Summary keeps its unlock. The focus
 * // highlight (`.current` + `aria-current`) comes from `isCurrent` (this step ===
 * // `model.activeIndex`), set by navigation. A row can be `.done.current` (completed +
 * // focused) or `.active.current` (Summary focused).
 * `globalNumber` is the step's continuous 1-based position across the whole pipeline
 * (Configure 1-3 · Run 4-10 · Review 11). */
function stepItemMarkup(step: IdentifyStep, globalNumber: number, isCurrent: boolean): string {
  const statusClass =
    step.status === 'active'
      ? ' active'
      : step.status === 'locked'
        ? ' locked'
        : step.status === 'done'
          ? ' done'
          : ''; // upcoming: no status class (number only)
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
 * followed by ALL its sub-steps, expanded (no collapse, no representative row).
 *
 * // Full-expand divergence (2026-07-04, matching Peak Finder): every group renders
 * // fully -- all 3 Configure steps / all 7 Run stages / Review -- so the scientist sees
 * // the whole pipeline up front (locked rows carry a padlock and stay inert). The
 * // per-step status set by deriveIdentifySteps already makes locked rows non-focusable
 * // (stepItemMarkup), so exposing them all needs no handler change. The badge is the
 * // step's continuous position in the WHOLE pipeline (Configure 1-3 · Run 4-10 ·
 * // Review 11), never a per-group 1..n -- matching Peak Finder's global rail badges. */
function groupMarkup(model: IdentifyStepModel, group: IdentifyGroup): string {
  const steps = stepsOf(model, group);
  const name = GROUP_LABEL[group];
  const eyebrow = `<li class="step-film-group">${escapeHtml(name)}</li>`;
  return (
    eyebrow +
    steps
      .map((s) => {
        const gi = model.steps.indexOf(s);
        // Rev 5: `isCurrent` (focus) is independent of `s.status` (execution).
        return stepItemMarkup(s, gi + 1, gi === model.activeIndex);
      })
      .join('')
  );
}

/** The full left rail: the `.step-film` strip carrying every group expanded, plus a
 * bottom `.step-film-actions` footer (pinned via `margin-top:auto`). The footer renders
 * in EVERY phase so the user is never trapped: "Close workspace" (`#identHome`, back to
 * landing) is always shown, and "Load new spectrum" (the reset, `#identNew`) shows ONLY
 * when a run/result exists (`opts.hasRun`) -- hidden on the empty Load step and on
 * `error`. Mirrors `peakFinderStepperRailMarkup`. */
export function identifyStepperRailMarkup(
  model: IdentifyStepModel,
  opts: { hasRun: boolean },
): string {
  const groups = GROUP_ORDER.map((g) => groupMarkup(model, g)).join('');
  const loadNew = opts.hasRun
    ? `<button id="identNew" class="btn" type="button">Load new spectrum</button>`
    : '';
  const actions = `<li class="step-film-actions">
      ${loadNew}
      <button id="identHome" class="btn" type="button">Close workspace</button>
    </li>`;
  return `<ol class="step-film" id="identRail" aria-label="Identify steps">${groups}${actions}</ol>`;
}

/** The active step's display label parts -- the single source the active-step card
 * AND the bottom toolbar both read. Returns `null` when there is no active step.
 *
 * // 2026-07-04 (R2, matching Peak Finder): n/N are the GLOBAL continuous position
 * // (Step 1..11 across the whole pipeline: Configure 1-3 · Run 4-10 · Review 11), never
 * // restarting per group -- so the card eyebrow and toolbar agree with the rail's global
 * // badges. Mirrors `peakFinderActiveStepLabel`. `group` is kept as the toolbar prefix. */
export function identifyActiveStepLabel(
  model: IdentifyStepModel,
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

/** The active-step card header: eyebrow "STEP n OF N" + the step title + subtitle. */
export function identifyActiveStepCardMarkup(model: IdentifyStepModel): string {
  const active = model.steps[model.activeIndex];
  const label = identifyActiveStepLabel(model);
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
