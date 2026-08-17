import { describe, it, expect } from 'vitest';

import {
  deriveBuildSteps,
  activeStepCardMarkup,
  type BuildStep,
  type BuildStepStatus,
  type DeriveBuildStepsInput,
} from '../src/ui/buildStepper';

/**
 * Pure derivation of the grouped Build stepper's step model. No DOM: this exercises
 * `deriveBuildSteps` only -- the single source of truth the rail, panel routing, and
 * Prev/Next toolbar all read. The flow is 13 steps: Configure (4) + Run (8) + Review
 * (1). The rules under test mirror the hand-off:
 *   - Configure now gates SEQUENTIALLY: step i is reachable only when every earlier
 *     step is complete (cumulative `configComplete`); the rest are padlocked.
 *   - The Create step (last Configure) is never reported `done` pre-build.
 *   - Run + Review are locked until a result exists (`hasResult`).
 *   - During the reveal, Run stages ahead of the engine's cursor stay locked.
 *   - `done` makes Review active (summary) or one Run stage active (walkthrough),
 *     and marks all Configure `done` regardless of `configComplete`.
 */

const TOTAL_STEPS = 13;
const CONFIG_COUNT = 4;
const RUN_COUNT = 8;

function input(overrides: Partial<DeriveBuildStepsInput> = {}): DeriveBuildStepsInput {
  return {
    phase: { kind: 'collecting' },
    ready: true,
    hasResult: false,
    configStep: 0,
    stageIndex: 0,
    reviewView: 'summary',
    configComplete: [false, false, false, false],
    ...overrides,
  };
}

function byId(steps: readonly BuildStep[], id: string): BuildStep {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`step ${id} not found`);
  return s;
}

function statuses(steps: readonly BuildStep[], group: BuildStep['group']): BuildStepStatus[] {
  return steps.filter((s) => s.group === group).map((s) => s.status);
}

describe('deriveBuildSteps -- sequential Configure gating', () => {
  it('collecting, nothing loaded: cfg-load active; identity/model/create locked; Run+Review locked', () => {
    const model = deriveBuildSteps(input({ configComplete: [false, false, false, false] }));
    expect(model.steps).toHaveLength(TOTAL_STEPS);
    expect(model.activeGroup).toBe('configure');
    expect(model.activeIndex).toBe(0);
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'locked', 'locked', 'locked']);
    expect(statuses(model.steps, 'run')).toEqual(Array<BuildStepStatus>(RUN_COUNT).fill('locked'));
    expect(byId(model.steps, 'review').status).toBe('locked');
  });

  it('load complete: Declare identities unlocks (upcoming); Model + Create still locked', () => {
    const model = deriveBuildSteps(input({ configComplete: [true, false, false, false], configStep: 0 }));
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'upcoming', 'locked', 'locked']);
    // Advancing to the now-reachable identity step makes it active.
    const atIdentity = deriveBuildSteps(input({ configComplete: [true, false, false, false], configStep: 1 }));
    expect(statuses(atIdentity.steps, 'configure')).toEqual(['done', 'active', 'locked', 'locked']);
    expect(atIdentity.activeIndex).toBe(1);
  });

  it('load + identity complete: Select model unlocks; Create still locked', () => {
    const model = deriveBuildSteps(input({ configComplete: [true, true, false, false], configStep: 2 }));
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'done', 'active', 'locked']);
  });

  it('load + identity + model complete: Create unlocks and is never reported done', () => {
    const model = deriveBuildSteps(input({ configComplete: [true, true, true, false], configStep: 3 }));
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'done', 'done', 'active']);
    expect(byId(model.steps, 'cfg-create').status).not.toBe('done');
  });

  it('all complete: all four Configure reachable; Create active (never done)', () => {
    const model = deriveBuildSteps(input({ configComplete: [true, true, true, true], configStep: 3 }));
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'done', 'done', 'active']);
    expect(byId(model.steps, 'cfg-create').status).toBe('active');
    // No Configure step is locked once everything is complete.
    expect(statuses(model.steps, 'configure')).not.toContain('locked');
  });

  it('clamps the active index back to the reachable max when configStep runs ahead', () => {
    const model = deriveBuildSteps(input({ configComplete: [true, false, false, false], configStep: 3 }));
    expect(model.activeIndex).toBe(1); // reachable max = first incomplete index = 1
    expect(byId(model.steps, 'cfg-identity').status).toBe('active');
    expect(byId(model.steps, 'cfg-model').status).toBe('locked');
  });

  it('non-cumulative input still locks everything after the first incomplete step', () => {
    // Documents the monotonic contract: the derivation keys off the first incomplete
    // index, so a stray later `true` ([F,F,T,F]) does not unlock step 2.
    const model = deriveBuildSteps(input({ configComplete: [false, false, true, false] }));
    expect(statuses(model.steps, 'configure')).toEqual(['active', 'locked', 'locked', 'locked']);
  });

  it('error: same sequential gating, active group Configure', () => {
    const model = deriveBuildSteps(
      input({ phase: { kind: 'error', message: 'x' }, configComplete: [true, false, false, false], configStep: 1 }),
    );
    expect(model.activeGroup).toBe('configure');
    expect(statuses(model.steps, 'configure')).toEqual(['done', 'active', 'locked', 'locked']);
    expect(statuses(model.steps, 'run')).toEqual(Array<BuildStepStatus>(RUN_COUNT).fill('locked'));
    expect(byId(model.steps, 'review').status).toBe('locked');
  });
});

describe('deriveBuildSteps -- group gating (unchanged by sequential Configure)', () => {
  it('running { stageIndex: k }: Configure all done; run-<=k done/active; run->k locked; Review locked', () => {
    const k = 3;
    const model = deriveBuildSteps(
      input({ phase: { kind: 'running', stageIndex: k }, hasResult: true, configComplete: [false, false, false, false] }),
    );
    expect(model.activeGroup).toBe('run');
    expect(model.activeIndex).toBe(CONFIG_COUNT + k);
    // Configure is all `done` during the run regardless of configComplete.
    expect(statuses(model.steps, 'configure')).toEqual(Array<BuildStepStatus>(CONFIG_COUNT).fill('done'));
    for (let i = 0; i < RUN_COUNT; i++) {
      const expected: BuildStepStatus = i < k ? 'done' : i === k ? 'active' : 'locked';
      expect(byId(model.steps, `run-${i}`).status).toBe(expected);
    }
    expect(byId(model.steps, 'review').status).toBe('locked');
  });

  it('done + summary: all Configure + Run done, Review active', () => {
    const model = deriveBuildSteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' }));
    expect(model.activeGroup).toBe('review');
    expect(model.activeIndex).toBe(CONFIG_COUNT + RUN_COUNT);
    expect(statuses(model.steps, 'configure')).toEqual(Array<BuildStepStatus>(CONFIG_COUNT).fill('done'));
    expect(statuses(model.steps, 'run')).toEqual(Array<BuildStepStatus>(RUN_COUNT).fill('done'));
    expect(byId(model.steps, 'review').status).toBe('active');
  });

  it('done + walkthrough: run-{stageIndex} active, Review done & navigable', () => {
    const stageIndex = 5;
    const model = deriveBuildSteps(
      input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex }),
    );
    expect(model.activeGroup).toBe('run');
    expect(model.activeIndex).toBe(CONFIG_COUNT + stageIndex);
    for (let i = 0; i < RUN_COUNT; i++) {
      expect(byId(model.steps, `run-${i}`).status).toBe(i === stageIndex ? 'active' : 'done');
    }
    expect(byId(model.steps, 'review').status).toBe('done');
  });

  it('Run lock is gated by hasResult, not by the Create completion flag', () => {
    const notReady = deriveBuildSteps(input({ configComplete: [true, true, true, false], configStep: 3, hasResult: false }));
    const ready = deriveBuildSteps(input({ configComplete: [true, true, true, true], configStep: 3, hasResult: false }));
    // The cfg-create rail status is `active` either way (its gate is the button, not
    // the rail); Run stays locked in both because there is no result yet.
    expect(byId(notReady.steps, 'cfg-create').status).toBe('active');
    expect(byId(ready.steps, 'cfg-create').status).toBe('active');
    expect(statuses(notReady.steps, 'run')).toEqual(Array<BuildStepStatus>(RUN_COUNT).fill('locked'));
    expect(statuses(ready.steps, 'run')).toEqual(Array<BuildStepStatus>(RUN_COUNT).fill('locked'));
  });

  it('exactly one step is active in every phase', () => {
    const models = [
      deriveBuildSteps(input()),
      deriveBuildSteps(input({ phase: { kind: 'error', message: 'x' } })),
      deriveBuildSteps(input({ phase: { kind: 'running', stageIndex: 0 }, hasResult: true })),
      deriveBuildSteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'summary' })),
      deriveBuildSteps(input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex: 2 })),
    ];
    for (const m of models) {
      const active = m.steps.filter((s) => s.status === 'active');
      expect(active).toHaveLength(1);
      expect(m.steps[m.activeIndex].status).toBe('active');
    }
  });

  it('clamps an out-of-range stageIndex in the walkthrough', () => {
    const walk = deriveBuildSteps(
      input({ phase: { kind: 'done' }, hasResult: true, reviewView: 'walkthrough', stageIndex: 99 }),
    );
    expect(walk.activeIndex).toBe(CONFIG_COUNT + RUN_COUNT - 1);
  });
});

describe('activeStepCardMarkup -- header action slot (PPI entry relocation)', () => {
  // Declare step active: configStep 1, Load complete.
  const model = deriveBuildSteps(
    input({ configStep: 1, configComplete: [true, false, false, false] }),
  );

  it('default (no action): no headrow wrapper; byte-identical to the explicit empty arg', () => {
    const plain = activeStepCardMarkup(model);
    expect(plain).toBe(activeStepCardMarkup(model, ''));
    expect(plain).not.toContain('build-card-headrow');
    expect(plain).toContain('build-card-title');
    expect(plain).toContain('Assign Energies');
  });

  it('renders an injected action inside .build-card-headrow, right of the heading block', () => {
    const action = '<button id="calInspect">Inspect Peak Detection</button>';
    const html = activeStepCardMarkup(model, action);
    expect(html).toContain('build-card-headrow');
    // Heading block first, then the action -- right-aligned by the headrow flex.
    expect(html).toMatch(/build-card-heads[\s\S]*<\/div>\s*<button id="calInspect">/);
    // The heading content itself is unchanged.
    expect(html).toContain('Assign Energies');
    expect(html).toContain('build-card-eyebrow');
  });
});
