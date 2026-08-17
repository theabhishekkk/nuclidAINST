import { describe, it, expect } from 'vitest';

import {
  derivePeakFinderSteps,
  peakFinderStepperRailMarkup,
  peakFinderFirstStepOfGroup,
  PF_STEP_IDS,
  type PeakFinderStep,
  type PeakFinderStepStatus,
  type PeakFinderGroup,
  type DerivePeakFinderStepsInput,
} from '../src/ui/peakFinderStepper';

/**
 * Pure derivation of the grouped Peak Finder stepper's step model. No DOM: this exercises
 * `derivePeakFinderSteps` + the rail markup only -- the single source of truth the rail,
 * panel routing, and Prev/Next toolbar all read.
 *
 * The flow is FIVE groups / 17 steps (#9, 2026-07-05): Load (2) + Estimate Continuum (6) +
 * Detect Peaks (6: the first six PF_RUN_STAGES) + "Unnamed" finalize (2: Fit + Validated) +
 * Review (1). The detect/finalize split is a rail GROUPING only -- the flat `run-k` indices
 * (run-0..run-7) and RUN_OFFSET are UNCHANGED, so status stays a pure function of `reached`
 * (never `focus`). (The stepping reveal animation was removed 2026-07-07.)
 *
 * The rail is an accordion (#1): exactly one group -- the one owning `focus`
 * (`model.activeGroup`) -- is expanded; every other group collapses to a single header row.
 */

const TOTAL_STEPS = 17;
const LOAD_COUNT = 2;
const CONTINUUM_COUNT = 6;
/** Absolute index of the first Detect stage (Load + Continuum precede it). */
const RUN_OFFSET = LOAD_COUNT + CONTINUUM_COUNT; // 8
const RUN_COUNT = 8; // flat run steps run-0..run-7 (index space unchanged by the group split)
const DETECT_COUNT = 6; // run-0..run-5 under 'detect'
const FINALIZE_COUNT = 2; // run-6 (Fit), run-7 (Validated) under 'finalize'
const REVIEW_INDEX = TOTAL_STEPS - 1; // 16
/** The eight PF-owned Run stage labels, in flow order. */
const RUN_LABELS = [
  'Find Local Maxima',
  'Distance Gate',
  'Prominence Filter',
  'Width Filter',
  'Estimate Peak Strength',
  'Preliminary Classification',
  'Peak Fitting',
  'Validate Peaks',
];
const DETECT_LABELS = RUN_LABELS.slice(0, DETECT_COUNT);
const FINALIZE_LABELS = RUN_LABELS.slice(DETECT_COUNT); // ['Peak Fitting', 'Validate Peaks']

function input(overrides: Partial<DerivePeakFinderStepsInput> = {}): DerivePeakFinderStepsInput {
  return { reached: 0, focus: 0, ...overrides };
}

function byId(steps: readonly PeakFinderStep[], id: string): PeakFinderStep {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} not found`);
  return s;
}

function statuses(
  steps: readonly PeakFinderStep[],
  group: PeakFinderStep['group'],
): PeakFinderStepStatus[] {
  return steps.filter((s) => s.group === group).map((s) => s.status);
}

/** Count the EXPANDED group eyebrows in the rail markup (the accordion shows exactly one).
 * The expanded eyebrow is `class="step-film-group">`; the collapsed headers are
 * `step-film-group--collapsed`, so this counts only the expanded one. */
function expandedGroupCount(html: string): number {
  return (html.match(/class="step-film-group">/g) ?? []).length;
}

describe('PF_STEP_IDS -- the ordered flat step list (unchanged by the #9 group split)', () => {
  it('is the flat order: 2 load, 6 continuum, 8 run, 1 review', () => {
    expect(PF_STEP_IDS).toEqual([
      'load-spectrum',
      'load-sg',
      'cont-working',
      'cont-lls',
      'cont-snip',
      'cont-invlls',
      'cont-net',
      'cont-sg',
      'run-0',
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
      'run-6',
      'run-7',
      'review',
    ]);
  });
});

describe('#9 -- group membership (Fit + Validated moved to "Unnamed" finalize)', () => {
  it('run-0..run-5 are detect; run-6 (Fit) + run-7 (Validated) are finalize', () => {
    const model = derivePeakFinderSteps(input());
    for (let i = 0; i < DETECT_COUNT; i++) expect(byId(model.steps, `run-${i}`).group).toBe('detect');
    expect(byId(model.steps, 'run-6').group).toBe('finalize');
    expect(byId(model.steps, 'run-7').group).toBe('finalize');
    expect(model.steps.filter((s) => s.group === 'detect').map((s) => s.label)).toEqual(DETECT_LABELS);
    expect(model.steps.filter((s) => s.group === 'finalize').map((s) => s.label)).toEqual(
      FINALIZE_LABELS,
    );
  });

  it('peakFinderFirstStepOfGroup targets the first step of each group', () => {
    expect(peakFinderFirstStepOfGroup('detect')).toBe('run-0');
    expect(peakFinderFirstStepOfGroup('finalize')).toBe('run-6'); // Fit
    expect(peakFinderFirstStepOfGroup('load')).toBe('load-spectrum');
    expect(peakFinderFirstStepOfGroup('continuum')).toBe('cont-working');
    expect(peakFinderFirstStepOfGroup('review')).toBe('review');
  });
});

describe('derivePeakFinderSteps -- the frontier (reached) model', () => {
  it('collecting (reached 0, focus 0): load-spectrum active; everything after locked', () => {
    const model = derivePeakFinderSteps(input());
    expect(model.steps).toHaveLength(TOTAL_STEPS);
    expect(model.activeGroup).toBe('load');
    expect(model.activeIndex).toBe(0);
    expect(byId(model.steps, 'load-spectrum').status).toBe('active');
    expect(byId(model.steps, 'load-sg').status).toBe('locked');
    expect(statuses(model.steps, 'continuum')).toEqual(
      Array<PeakFinderStepStatus>(CONTINUUM_COUNT).fill('locked'),
    );
    expect(statuses(model.steps, 'detect')).toEqual(
      Array<PeakFinderStepStatus>(DETECT_COUNT).fill('locked'),
    );
    expect(statuses(model.steps, 'finalize')).toEqual(
      Array<PeakFinderStepStatus>(FINALIZE_COUNT).fill('locked'),
    );
    expect(byId(model.steps, 'review').status).toBe('locked');
  });

  it('continuum reached (reached 7, focus 2): all 6 continuum unlocked, run + Review locked', () => {
    const model = derivePeakFinderSteps(input({ reached: 7, focus: 2 }));
    expect(model.activeGroup).toBe('continuum');
    expect(statuses(model.steps, 'load')).toEqual(['done', 'done']);
    expect(statuses(model.steps, 'continuum')).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'active', // cont-sg (the frontier)
    ]);
    expect(statuses(model.steps, 'detect')).toEqual(
      Array<PeakFinderStepStatus>(DETECT_COUNT).fill('locked'),
    );
    expect(statuses(model.steps, 'finalize')).toEqual(
      Array<PeakFinderStepStatus>(FINALIZE_COUNT).fill('locked'),
    );
    expect(byId(model.steps, 'review').status).toBe('locked');
  });
});

describe('derivePeakFinderSteps -- the run steps once detection is done (reached-based)', () => {
  it('detection done (reached REVIEW_INDEX): every run step is done, Review active', () => {
    // No reveal cursor: status is purely reached-based. With reached at the last step, all
    // run-0..run-7 sit behind the frontier (done) and Review is the frontier (active).
    const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX }));
    for (let i = 0; i < RUN_COUNT; i++) {
      expect(byId(model.steps, `run-${i}`).status, `run-${i}`).toBe('done');
    }
    expect(byId(model.steps, 'review').status).toBe('active');
  });

  it('focus in a finalize step (run-6/run-7) => activeGroup is finalize (auto-open, #9 + D-9b)', () => {
    for (const k of [6, 7]) {
      const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: RUN_OFFSET + k }));
      expect(model.activeGroup, `run-${k}`).toBe('finalize');
    }
  });

  it('focus in a detect step (run-0..run-5) => activeGroup is detect', () => {
    for (let k = 0; k < DETECT_COUNT; k++) {
      const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: RUN_OFFSET + k }));
      expect(model.activeGroup, `run-${k}`).toBe('detect');
    }
  });
});

describe('derivePeakFinderSteps -- done + free navigation', () => {
  it('done (reached 16): Load+Continuum+Detect+Finalize done, Review active', () => {
    const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX }));
    expect(model.activeGroup).toBe('review');
    expect(statuses(model.steps, 'detect')).toEqual(
      Array<PeakFinderStepStatus>(DETECT_COUNT).fill('done'),
    );
    expect(statuses(model.steps, 'finalize')).toEqual(
      Array<PeakFinderStepStatus>(FINALIZE_COUNT).fill('done'),
    );
    expect(byId(model.steps, 'review').status).toBe('active');
  });

  it('status is a pure function of reached -- focusing any step never changes a status', () => {
    const canonical = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX }));
    for (let f = 0; f < TOTAL_STEPS; f++) {
      const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: f }));
      expect(model.steps.map((s) => s.status)).toEqual(canonical.steps.map((s) => s.status));
      expect(model.activeIndex).toBe(f);
    }
  });

  it('exactly one step is active in every non-reveal state (the frontier)', () => {
    for (const m of [
      derivePeakFinderSteps(input()),
      derivePeakFinderSteps(input({ reached: 1, focus: 1 })),
      derivePeakFinderSteps(input({ reached: 7, focus: 3 })),
      derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: 4 })),
    ]) {
      expect(m.steps.filter((s) => s.status === 'active')).toHaveLength(1);
    }
  });
});

describe('#1 accordion -- exactly one group expanded (the focus-owning group)', () => {
  const GROUPS: readonly PeakFinderGroup[] = ['load', 'continuum', 'detect', 'finalize', 'review'];
  const FOCUS_OF: Record<PeakFinderGroup, number> = {
    load: 0,
    continuum: 3, // cont-lls
    detect: RUN_OFFSET + 1, // run-1
    finalize: RUN_OFFSET + 6, // run-6 (Fit)
    review: REVIEW_INDEX,
  };

  it('for every focus, exactly one group is expanded and it is model.activeGroup', () => {
    for (const g of GROUPS) {
      const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: FOCUS_OF[g] }));
      const html = peakFinderStepperRailMarkup(model, { hasSpectrum: true });
      expect(model.activeGroup, `focus in ${g}`).toBe(g);
      expect(expandedGroupCount(html), `focus in ${g}: one expanded`).toBe(1);
      // The expanded group's steps carry data-step; a collapsed group is a data-group header.
      const collapsed = GROUPS.filter((x) => x !== g);
      for (const c of collapsed) {
        expect(html, `${c} collapsed while ${g} focused`).toContain(`data-group="${c}"`);
      }
      expect(html, `${g} expanded not a header`).not.toContain(`data-group="${g}"`);
    }
  });

  it('the finalize group expands to Fit + Validated when focused', () => {
    const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: RUN_OFFSET + 6 }));
    const html = peakFinderStepperRailMarkup(model, { hasSpectrum: true });
    expect(html).toContain('data-step="run-6"');
    expect(html).toContain('data-step="run-7"');
    for (const label of FINALIZE_LABELS) expect(html).toContain(label);
    // detect is collapsed to a header, so its inner steps are NOT expanded.
    expect(html).not.toContain('data-step="run-0"');
  });
});

describe('#1 accordion -- collapsed group headers: reached vs not-reached', () => {
  it('an unreached collapsed group is aria-disabled with no data-group (inert)', () => {
    // Focus on Load, only Load reached: continuum+ are NOT reached -> inert headers.
    const model = derivePeakFinderSteps(input({ reached: 1, focus: 0 }));
    const html = peakFinderStepperRailMarkup(model, { hasSpectrum: true });
    for (const g of ['continuum', 'detect', 'finalize', 'review']) {
      expect(html, `${g} unreached -> no data-group`).not.toContain(`data-group="${g}"`);
    }
    expect(html).toContain('step-film-group--collapsed');
    expect(html).toContain('aria-disabled="true"');
  });

  it('once reached, a collapsed group header is clickable (data-group + role=button), no count', () => {
    // Everything reached; focus on Review -> detect/finalize are reached collapsed headers.
    const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX }));
    const html = peakFinderStepperRailMarkup(model, { hasSpectrum: true });
    for (const g of ['load', 'continuum', 'detect', 'finalize']) {
      expect(html, `${g} reached -> data-group`).toContain(`data-group="${g}"`);
    }
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    // The per-group done/total count was dropped (2026-07-05) -- headers show label + glyph only.
    expect(html).not.toContain('step-film-groupcount');
  });
});

describe('peakFinderStepperRailMarkup -- badges + action footer', () => {
  const opts = (hasSpectrum = false) => ({ hasSpectrum });

  it('numbers the expanded (focused) group continuously across the whole pipeline', () => {
    // Focus on the finalize group -> its two steps show global badges 15 (Fit) + 16 (Validated).
    const model = derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: RUN_OFFSET + 6 }));
    const html = peakFinderStepperRailMarkup(model, opts(true));
    expect(html).toContain('<span class="step-film-num">15</span>'); // run-6 Fit
    expect(html).toContain('<span class="step-film-num">16</span>'); // run-7 Validated
    expect(html).not.toContain('<span class="step-film-num"><svg'); // number is never an icon
  });

  it('footer: Close Workspace always; file-management actions only when a spectrum is held', () => {
    const empty = peakFinderStepperRailMarkup(derivePeakFinderSteps(input()), opts(false));
    expect(empty).toContain('class="step-film-actions"');
    expect(empty).toContain('id="pfCloseWorkspace"');
    expect(empty).not.toContain('id="pfLoadAnother"');
    expect(empty).not.toContain('id="pfClearSpectrum"');

    const held = peakFinderStepperRailMarkup(
      derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX })),
      opts(true),
    );
    expect(held).toContain('id="pfLoadAnother"');
    expect(held).toContain('id="pfRailFile"');
    expect(held).toContain('Load Another File');
    expect(held).toContain('id="pfClearSpectrum"');
    expect(held).toContain('Clear Workspace');
    expect(held).toContain('id="pfCloseWorkspace"');
  });

  it('shows the three-state glyph (lock/unlock/check) on the expanded group, number never replaced', () => {
    const collecting = peakFinderStepperRailMarkup(derivePeakFinderSteps(input()), opts());
    expect(collecting).toContain('step-film-status');
    expect(collecting).toContain('M7 11V7a5 5 0 0 1 9.9-1'); // unlock glyph (active load-spectrum)

    const done = peakFinderStepperRailMarkup(
      derivePeakFinderSteps(input({ reached: REVIEW_INDEX, focus: REVIEW_INDEX })),
      opts(true),
    );
    expect(done).toContain('M20 6 9 17l-5-5'); // check glyph
    expect(done).not.toContain('<span class="step-film-num"><svg');
  });
});
