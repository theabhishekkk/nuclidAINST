import { describe, it, expect } from 'vitest';

import {
  deriveIdentifySteps,
  identifyStepperRailMarkup,
  type IdentifyStep,
  type IdentifyStepStatus,
  type DeriveIdentifyStepsInput,
} from '../src/ui/identifyStepper';

/**
 * Pure derivation of the grouped Identify stepper's step model plus its film-strip rail
 * markup. The flow is 11 steps: Configure (3) + Run (7) + Review (1). Configure gates
 * SEQUENTIALLY; the last Configure step (the Identify gate) is never `done` pre-run;
 * Run + Review lock until a result exists; during the reveal Run stages ahead of the
 * cursor lock.
 *
 * // Rev 5 (2026-07-04, matching Peak Finder): a step's `status` is EXECUTION-only and
 * // decoupled from focus. Once the reveal passes a Run stage it stays `done` forever
 * // (the walkthrough no longer flips it to `active`); Review is a permanent surface that
 * // is always `active` (never `done`) once unlocked. Focus is carried by `activeIndex`
 * // alone -- so in the walkthrough a `done` Run row is the focused (`.current`) row while
 * // Review remains the sole `active` step.
 */

const TOTAL_STEPS = 11;
const CONFIG_COUNT = 3;
const RUN_COUNT = 7;

function input(overrides: Partial<DeriveIdentifyStepsInput> = {}): DeriveIdentifyStepsInput {
  return {
    phase: { kind: 'collecting' },
    ready: true,
    hasResult: false,
    configStep: 0,
    stageIndex: 0,
    reviewView: 'summary',
    configComplete: [false, false, false],
    ...overrides,
  };
}

function byId(steps: readonly IdentifyStep[], id: string): IdentifyStep {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} not found`);
  return s;
}

function statuses(steps: readonly IdentifyStep[], group: IdentifyStep['group']): IdentifyStepStatus[] {
  return steps.filter((s) => s.group === group).map((s) => s.status);
}

describe('deriveIdentifySteps -- sequential Configure gating', () => {
  it('collecting, nothing loaded: cfg-spectrum active; calibration/identify locked; Run+Review locked', () => {
    const model = deriveIdentifySteps(input({ configComplete: [false, false, false] }));
    expect(model.steps).toHaveLength(TOTAL_STEPS);
    expect(model.activeGroup).toBe('configure');
    expect(model.activeIndex).toBe(0);
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'locked', 'locked']);
    expect(statuses(model.steps, 'run')).toEqual(Array<IdentifyStepStatus>(RUN_COUNT).fill('locked'));
    expect(byId(model.steps, 'review').status).toBe('locked');
  });

  it('spectrum loaded: Select calibration unlocks (upcoming); Identify still locked', () => {
    const model = deriveIdentifySteps(input({ configComplete: [true, false, false], configStep: 0 }));
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'upcoming', 'locked']);
    const atCal = deriveIdentifySteps(input({ configComplete: [true, false, false], configStep: 1 }));
    expect(statuses(atCal.steps, 'configure')).toEqual(['done', 'active', 'locked']);
    expect(atCal.activeIndex).toBe(1);
  });

  it('spectrum + calibration complete: Identify unlocks and is never reported done', () => {
    const model = deriveIdentifySteps(input({ configComplete: [true, true, false], configStep: 2 }));
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'done', 'active']);
    expect(byId(model.steps, 'cfg-identify').status).not.toBe('done');
  });

  it('all complete: all three Configure reachable; Identify active (never done), none locked', () => {
    const model = deriveIdentifySteps(input({ configComplete: [true, true, true], configStep: 2 }));
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'done', 'active']);
    expect(byId(model.steps, 'cfg-identify').status).toBe('active');
    expect(statuses(model.steps, 'configure')).not.toContain('locked');
  });

  it('clamps the active index back to the reachable max when configStep runs ahead', () => {
    const model = deriveIdentifySteps(input({ configComplete: [true, false, false], configStep: 2 }));
    expect(model.activeIndex).toBe(1); // reachable max = first incomplete index = 1
    expect(byId(model.steps, 'cfg-calibration').status).toBe('active');
    expect(byId(model.steps, 'cfg-identify').status).toBe('locked');
  });

  it('non-cumulative input still locks everything after the first incomplete step', () => {
    const model = deriveIdentifySteps(input({ configComplete: [false, true, false] }));
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'locked', 'locked']);
  });

  it('error: same sequential gating, active group Configure', () => {
    const model = deriveIdentifySteps(
      input({ phase: { kind: 'error', message: 'x' }, configComplete: [true, false, false], configStep: 1 }),
    );
    expect(model.activeGroup).toBe('configure');
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'active', 'locked']);
    expect(statuses(model.steps, 'run')).toEqual(Array<IdentifyStepStatus>(RUN_COUNT).fill('locked'));
    expect(byId(model.steps, 'review').status).toBe('locked');
  });
});

describe('deriveIdentifySteps -- group gating', () => {
  it('running { stageIndex: k }: Configure all done; run-<=k done/active; run->k locked; Review locked', () => {
    const k = 3;
    const model = deriveIdentifySteps(
      input({ phase: { kind: 'running', stageIndex: k }, hasResult: true, configComplete: [false, false, false] }),
    );
    expect(model.activeGroup).toBe('run');
    expect(model.activeIndex).toBe(CONFIG_COUNT + k);
    expect(statuses(model.steps, 'configure')).toEqual(Array<IdentifyStepStatus>(CONFIG_COUNT).fill('done'));
    for (let i = 0; i < RUN_COUNT; i++) {
      const expected: IdentifyStepStatus = i < k ? 'done' : i === k ? 'active' : 'locked';
      expect(byId(model.steps, `run-${i}`).status).toBe(expected);
    }
    expect(byId(model.steps, 'review').status).toBe('locked');
  });

  it('done + summary: all Configure + Run done, Review active', () => {
    const model = deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' }));
    expect(model.activeGroup).toBe('review');
    expect(model.activeIndex).toBe(CONFIG_COUNT + RUN_COUNT);
    expect(statuses(model.steps, 'configure')).toEqual(Array<IdentifyStepStatus>(CONFIG_COUNT).fill('done'));
    expect(statuses(model.steps, 'run')).toEqual(Array<IdentifyStepStatus>(RUN_COUNT).fill('done'));
    expect(byId(model.steps, 'review').status).toBe('active');
  });

  it('done + walkthrough (Rev 5): focus moves to run-{stageIndex} but every Run stage stays done; Review stays active', () => {
    const stageIndex = 4;
    const model = deriveIdentifySteps(
      input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex }),
    );
    // Focus (activeIndex/activeGroup) still tracks the walkthrough position...
    expect(model.activeGroup).toBe('run');
    expect(model.activeIndex).toBe(CONFIG_COUNT + stageIndex);
    // ...but STATUS is execution-only: the focused Run stage does NOT flip to active.
    for (let i = 0; i < RUN_COUNT; i++) {
      expect(byId(model.steps, `run-${i}`).status).toBe('done');
    }
    // Review is a permanent surface -- always active, never done, even when not focused.
    expect(byId(model.steps, 'review').status).toBe('active');
  });

  it('Run lock is gated by hasResult, not by the Identify-gate completion flag', () => {
    const notReady = deriveIdentifySteps(input({ configComplete: [true, true, false], configStep: 2, hasResult: false }));
    const ready = deriveIdentifySteps(input({ configComplete: [true, true, true], configStep: 2, hasResult: false }));
    expect(byId(notReady.steps, 'cfg-identify').status).toBe('active');
    expect(byId(ready.steps, 'cfg-identify').status).toBe('active');
    expect(statuses(notReady.steps, 'run')).toEqual(Array<IdentifyStepStatus>(RUN_COUNT).fill('locked'));
    expect(statuses(ready.steps, 'run')).toEqual(Array<IdentifyStepStatus>(RUN_COUNT).fill('locked'));
  });

  it('exactly one step is active in every phase; focus (activeIndex) is decoupled from status (Rev 5)', () => {
    const models = [
      deriveIdentifySteps(input()),
      deriveIdentifySteps(input({ phase: { kind: 'error', message: 'x' } })),
      deriveIdentifySteps(input({ phase: { kind: 'running', stageIndex: 0 }, hasResult: true })),
      deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' })),
      deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex: 2 })),
    ];
    for (const m of models) {
      expect(m.steps.filter((s) => s.status === 'active')).toHaveLength(1);
    }
    // In every phase EXCEPT the walkthrough the focused step is the active one...
    for (const m of models.slice(0, 4)) {
      expect(m.steps[m.activeIndex].status).toBe('active');
    }
    // ...but in the walkthrough the focused Run stage is `done` (status is execution-only)
    // while Review is the sole active step -- proving focus/status are decoupled.
    const walk = models[4];
    expect(walk.steps[walk.activeIndex].status).toBe('done');
    expect(byId(walk.steps, 'review').status).toBe('active');
  });

  it('clamps an out-of-range stageIndex in the walkthrough', () => {
    const walk = deriveIdentifySteps(
      input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex: 99 }),
    );
    expect(walk.activeIndex).toBe(CONFIG_COUNT + RUN_COUNT - 1);
  });
});

describe('identifyStepperRailMarkup -- Peak Finder film-strip (2026-07-04)', () => {
  // Glyph signatures copied from the stepper's inline SVGs (mirror of peakFinderStepper).
  const LOCK_PATH = 'M7 11V7a5 5 0 0 1 10 0v4'; // closed padlock
  const UNLOCK_PATH = 'M7 11V7a5 5 0 0 1 9.9-1'; // open padlock
  const CHECK_PATH = 'M20 6 9 17l-5-5'; // done tick
  const items = (html: string): number => (html.match(/class="step-film-item/g) ?? []).length;

  it('renders all 11 steps expanded as one .step-film strip with continuous global 1..11 numbers', () => {
    const model = deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' }));
    const html = identifyStepperRailMarkup(model, { hasRun: true });
    expect(html).toContain('<ol class="step-film" id="identRail"');
    expect(items(html)).toBe(TOTAL_STEPS); // full-expand: no collapse, every step visible
    for (let n = 1; n <= TOTAL_STEPS; n++) {
      expect(html).toContain(`<span class="step-film-num">${n}</span>`);
    }
  });

  it('carries the three-state lock/unlock/check glyph off execution status (empty vs done)', () => {
    // Empty Configure: Run + Review locked -> closed padlocks present; no unlock yet.
    const empty = identifyStepperRailMarkup(
      deriveIdentifySteps(input({ configComplete: [false, false, false] })),
      { hasRun: false },
    );
    expect(empty).toContain(LOCK_PATH);
    // done + summary: every Run stage is a check and Review is the open padlock; no locks.
    const done = identifyStepperRailMarkup(
      deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' })),
      { hasRun: true },
    );
    expect(done).toContain(CHECK_PATH);
    expect(done).toContain(UNLOCK_PATH);
    expect(done).not.toContain(LOCK_PATH);
  });

  it('decouples focus (.current) from status: the walkthrough focuses a done Run row while Review stays active', () => {
    const model = deriveIdentifySteps(
      input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex: 2 }),
    );
    const html = identifyStepperRailMarkup(model, { hasRun: true });
    // run-2 (global badge 6) is completed AND focused -> `.done.current` with aria-current.
    expect(html).toContain('class="step-film-item done current" data-step="run-2" aria-current="step"');
    // Review is active but NOT the focused row -> `active`, no `current`, no aria-current.
    expect(html).toMatch(/class="step-film-item active" data-step="review" tabindex="0"/);
  });

  it('footer shows Close workspace always and Load new spectrum only when a run exists', () => {
    const before = identifyStepperRailMarkup(deriveIdentifySteps(input()), { hasRun: false });
    expect(before).toContain('id="identHome"');
    expect(before).not.toContain('id="identNew"');
    const after = identifyStepperRailMarkup(
      deriveIdentifySteps(input({ phase: { kind: 'done' }, hasResult: true })),
      { hasRun: true },
    );
    expect(after).toContain('id="identNew"');
    expect(after).toContain('id="identHome"');
  });
});
