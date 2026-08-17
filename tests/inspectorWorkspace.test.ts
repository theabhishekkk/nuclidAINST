// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  emptyInspectorState,
  inspectorPanelMarkup,
  inspectorLegend,
  describeCandidateFate,
  clampInspectorStage,
  mountInspectorWorkspace,
  advanceSubjectOnRemoval,
  type InspectorSubject,
  type InspectorWorkspaceState,
} from '../src/ui/inspectorWorkspace';
import type { SpectrumStatus } from '../src/pipeline/spectrumStatus';
import type { ChartGeometry } from '../src/viz/spectrumChart';
import type { DetectedPeak, FittedPeak, PipelineTrace } from '../src/domain/types';

/**
 * Peak Pipeline Inspector -- Phase 3 workspace decoupling + Phase 4a
 * multi-subject selector.
 *
 * Proves the workspace is container-agnostic (renders from subjects + an
 * InspectorWorkspaceState alone), root-scoped (two instances never collide),
 * accessor-driven (handlers mutate ONLY the injected state, signalling via
 * onChange), and Phase-2-parity-exact for the moved pure helpers. Phase 4a adds:
 * the status-aware recessed selector (contract label + state class per subject,
 * selected marked, disabled when single), the operator-ruled switch semantics
 * (stage persists / candidate resets / view reprojected), and lazy traces (only
 * the selected subject's getTrace runs). The final test asserts the
 * no-import-coupling constraint on the module source itself.
 */

// --- synthetic trace (engine-shaped; partition-consistent) ----------------------

function detectedPeak(over: Partial<DetectedPeak> = {}): DetectedPeak {
  return {
    channel: 30,
    height: 400,
    fwhmChannels: 6,
    leftIp: 27,
    rightIp: 33,
    prominence: 300,
    netArea: 3000,
    grossArea: 4000,
    significance: 20,
    expectedFwhmChannels: 6,
    widthRatio: 1,
    classification: 'line',
    passed: true,
    ...over,
  };
}

function fittedPeak(over: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 30.2,
    centroidError: 0.1,
    amplitude: 500,
    fwhmChannels: 6,
    netArea: 3000,
    chiSquare: 12,
    energyKeV: null,
    classification: 'line',
    significance: 20,
    detectedChannel: 30,
    status: 'kept',
    ...over,
  };
}

/** 4 local maxima: ch20 gate-rejected, ch30 kept fit, ch45 fit-rejected,
 * ch50 unfittable. 1 validated peak (the kept fit). */
function makeTrace(): PipelineTrace {
  const n = 64;
  const raw = Array.from({ length: n }, (_, i) => 10 + (i === 30 ? 100 : 0));
  const background = new Array<number>(n).fill(10);
  const netCounts = raw.map((v, i) => Math.max(0, v - background[i]));
  const kept = fittedPeak();
  const rejectedFit = fittedPeak({
    detectedChannel: 45,
    centroidChannel: 45.4,
    status: 'rejected',
    rejectReason: 'peak-hop',
    chiSquare: null,
  });
  const all: DetectedPeak[] = [
    detectedPeak({ channel: 20, passed: false, rejectReason: 'prominence' }),
    detectedPeak({ channel: 30 }),
    detectedPeak({ channel: 45 }),
    detectedPeak({ channel: 50 }),
  ];
  return {
    spectrumId: 'synthetic.TKA',
    channels: raw.map((_, i) => i),
    raw,
    conditioned: { background, netCounts, smoothed: netCounts },
    detected: { all, survivors: all.filter((d) => d.passed) },
    fitted: {
      all: [kept, rejectedFit],
      kept: [kept],
      unfittable: [{ detectedChannel: 50, reason: 'no-convergence' }],
    },
    validated: [{ peak: kept, valid: true, flags: [] }],
    constants: {
      prominence: 200,
      distance: 15,
      minWidth: 3,
      relHeight: 0.5,
      windowFactor: 1.5,
      minHalfWindow: 5,
      minSignificance: 4,
      maxWidthRatio: 4,
    },
    timing: [],
    version: 1,
  };
}

function statusOf(over: Partial<SpectrumStatus> = {}): SpectrumStatus {
  return {
    state: 'healthy',
    peakCount: 1,
    unfittableCount: 0,
    rejectedFitCount: 0,
    failingStage: null,
    label: '1 peaks',
    ...over,
  };
}

function subjectOf(trace: PipelineTrace, over: Partial<InspectorSubject> = {}): InspectorSubject {
  return {
    id: 'row-1',
    label: 'synthetic.TKA',
    status: statusOf(),
    channelCount: 64,
    getTrace: () => trace,
    ...over,
  };
}

function stateAt(over: Partial<InspectorWorkspaceState> = {}): InspectorWorkspaceState {
  return { ...emptyInspectorState(), subjectId: 'row-1', ...over };
}

/** A plausible draw geometry for hit-testing: 100px plot over channels 0..63. */
const GEO: ChartGeometry = {
  left: 0,
  top: 0,
  width: 100,
  height: 50,
  n: 64,
  maxY: 110,
  logY: false,
  xMin: 0,
  xMax: 63,
  yMin: 0,
  yMax: 110,
};

// --- 1 + 4: container-agnostic pure markup, Phase-2 parity pins -----------------

describe('inspectorPanelMarkup -- pure over (trace, state), Phase-2 parity', () => {
  const trace = makeTrace();

  it('renders the funnel, rail, canvas, and caption from the trace + state alone', () => {
    const html = inspectorPanelMarkup(trace, stateAt());
    // Funnel: 4 local maxima -> 3 survivors -> 1 fitted -> 1 validated.
    expect(html).toContain('<span class="insp-n">4</span><span class="insp-label">local maxima</span>');
    expect(html).toContain('<span class="insp-n">3</span><span class="insp-label">survivors</span>');
    expect(html).toContain('<span class="insp-n">1</span><span class="insp-label">fitted</span>');
    expect(html).toContain('<span class="insp-n">1</span><span class="insp-label">validated</span>');
    // Exact Phase-2 shell strings.
    expect(html).toContain('<h4 class="inspector-title">How were these found?</h4>');
    expect(html).toContain('<canvas id="inspectorChart" class="inspector-chart"></canvas>');
    expect(html).toContain('<div class="insp-chip" hidden></div>');
    // Stage 0 active, raw caption, reset disabled (no view), no legend/detail.
    expect(html).toMatch(/data-stage="0" role="button"\s+tabindex="0" aria-current="step"/);
    expect(html).toContain('Raw counts as uploaded — before any processing.');
    expect(html).toContain('<button class="btn btn-ghost insp-reset" type="button" disabled>Reset view</button>');
    expect(html).not.toContain('insp-legend');
    expect(html).not.toContain('insp-detail');
  });

  it('stage 3: token-substituted caption + the drop legend (exact strings)', () => {
    const html = inspectorPanelMarkup(trace, stateAt({ stageIndex: 3 }));
    expect(html).toContain('4 local maxima → 3 survivors after the prominence / distance / width gates.');
    expect(html).toContain(
      '3 survivors &middot; 1 dropped (1 prominence &middot; 0 distance &middot; 0 width)',
    );
  });

  it('stage 4 legend + enabled reset with a view (exact strings)', () => {
    const html = inspectorPanelMarkup(
      trace,
      stateAt({ stageIndex: 4, view: { xMin: 5, xMax: 20 } }),
    );
    expect(inspectorLegend(trace, 4)).toBe(
      '1 fitted &middot; 1 rejected (peak-hop/edge) &middot; 1 unfittable',
    );
    expect(html).toContain('<button class="btn btn-ghost insp-reset" type="button" >Reset view</button>');
  });

  it('candidate-fate detail covers all five fates (exact strings)', () => {
    expect(describeCandidateFate(trace, 20)).toBe('Channel 20 — rejected at the prominence gate.');
    expect(describeCandidateFate(trace, 30)).toBe('Channel 30 — survivor → kept (fitted peak).');
    expect(describeCandidateFate(trace, 45)).toBe('Channel 45 — survivor → fit rejected (peak-hop).');
    expect(describeCandidateFate(trace, 50)).toBe('Channel 50 — survivor → unfittable (no-convergence).');
    expect(describeCandidateFate(trace, 7)).toBe('Channel 7 — no candidate at this position.');
    const html = inspectorPanelMarkup(trace, stateAt({ selectedCandidate: 45 }));
    expect(html).toContain(
      '<div class="insp-detail">Channel 45 — survivor → fit rejected (peak-hop).</div>',
    );
  });

  it('clampInspectorStage clamps into 0..5', () => {
    expect(clampInspectorStage(-3)).toBe(0);
    expect(clampInspectorStage(99)).toBe(5);
    expect(clampInspectorStage(NaN)).toBe(0);
  });
});

// --- 2: scoped canvas -- two independent mounts never collide --------------------

describe('mountInspectorWorkspace -- root-scoped DOM', () => {
  it('resolves its canvas within its own root; two instances are independent', () => {
    const rootA = document.createElement('div');
    const rootB = document.createElement('div');
    document.body.append(rootA, rootB);
    mountInspectorWorkspace({
      root: rootA,
      subjects: [subjectOf(makeTrace())],
      state: stateAt(),
      logY: false,
      onChange: () => {},
    });
    const htmlA = rootA.innerHTML;
    mountInspectorWorkspace({
      root: rootB,
      subjects: [subjectOf(makeTrace())],
      state: stateAt({ stageIndex: 3 }),
      logY: false,
      onChange: () => {},
    });
    const canvasA = rootA.querySelector('.inspector-chart');
    const canvasB = rootB.querySelector('.inspector-chart');
    expect(canvasA).not.toBeNull();
    expect(canvasB).not.toBeNull();
    expect(canvasA).not.toBe(canvasB);
    // Independent state: A shows stage 0 active, B stage 3; mounting B left A intact.
    expect(rootA.innerHTML).toBe(htmlA);
    expect(rootA.querySelector('[data-stage="0"]')?.getAttribute('aria-current')).toBe('step');
    expect(rootB.querySelector('[data-stage="3"]')?.getAttribute('aria-current')).toBe('step');
    rootA.remove();
    rootB.remove();
  });
});

// --- 3: handlers mutate only the injected state, signalling via onChange --------

describe('mountInspectorWorkspace -- state via accessor', () => {
  function mounted(st: InspectorWorkspaceState) {
    const trace = makeTrace();
    const before = structuredClone(trace);
    const root = document.createElement('div');
    document.body.append(root);
    const onChange = vi.fn();
    const handle = mountInspectorWorkspace({
      root,
      subjects: [subjectOf(trace)],
      state: st,
      logY: false,
      onChange,
    });
    return { trace, before, root, onChange, handle };
  }

  it('stage-rail click writes stageIndex and calls onChange once', () => {
    const st = stateAt();
    const { trace, before, root, onChange } = mounted(st);
    (root.querySelector('[data-stage="2"]') as HTMLElement).click();
    expect(st.stageIndex).toBe(2);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(before); // read-only over the trace
    root.remove();
  });

  it('canvas click selects the nearest candidate via the stored geometry', () => {
    const st = stateAt();
    const { root, onChange } = mounted(st);
    st.geometry = GEO; // as a real draw would have left it
    const canvas = root.querySelector('.inspector-chart') as HTMLCanvasElement;
    // Channel 30 maps to x = 30/63*100 = 47.6px; click within the 6px tolerance.
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 48, bubbles: true }));
    expect(st.selectedCandidate).toBe(30);
    expect(onChange).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('reset-view nulls the window WITHOUT a host re-render (direct redraw parity)', () => {
    const st = stateAt({ view: { xMin: 5, xMax: 20 } });
    const { root, onChange } = mounted(st);
    const btn = root.querySelector('.insp-reset') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    expect(st.view).toBeNull();
    expect(btn.disabled).toBe(true); // synced in place
    expect(onChange).not.toHaveBeenCalled();
    root.remove();
  });

  it('keyboard (Enter/Space) steps the rail like a click', () => {
    const st = stateAt();
    const { root, onChange } = mounted(st);
    const el = root.querySelector('[data-stage="4"]') as HTMLElement;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(st.stageIndex).toBe(4);
    expect(onChange).toHaveBeenCalledTimes(1);
    root.remove();
  });
});

// --- 4a: status-aware selector + switch semantics + lazy traces ------------------

describe('mountInspectorWorkspace -- multi-subject selector (Phase 4a)', () => {
  function pair() {
    const traceA = makeTrace();
    const traceB = makeTrace();
    const getA = vi.fn(() => traceA);
    const getB = vi.fn(() => traceB);
    const a: InspectorSubject = {
      id: 'row-a',
      label: 'a.TKA',
      status: statusOf({ label: '2 peaks', peakCount: 2 }),
      channelCount: 64,
      getTrace: getA,
    };
    const b: InspectorSubject = {
      id: 'row-b',
      label: 'b.TKA',
      status: statusOf({ state: 'anomaly', label: '1 unfittable', unfittableCount: 1 }),
      channelCount: 32,
      getTrace: getB,
    };
    return { a, b, getA, getB };
  }

  function mountPair(st: InspectorWorkspaceState, subjects: readonly InspectorSubject[]) {
    const root = document.createElement('div');
    document.body.append(root);
    const onChange = vi.fn();
    mountInspectorWorkspace({ root, subjects, state: st, logY: false, onChange });
    return { root, onChange };
  }

  it('renders one entry per subject: contract label + state class, selected marked', () => {
    const { a, b } = pair();
    const st = stateAt({ subjectId: 'row-a' });
    const { root } = mountPair(st, [a, b]);
    const buttons = [...root.querySelectorAll('.insp-subject')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('a.TKA');
    expect(buttons[0].textContent).toContain('2 peaks');
    expect(buttons[0].querySelector('.br-status--healthy')).not.toBeNull();
    expect(buttons[0].classList.contains('is-selected')).toBe(true);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].textContent).toContain('b.TKA');
    expect(buttons[1].textContent).toContain('1 unfittable');
    expect(buttons[1].querySelector('.br-status--anomaly')).not.toBeNull();
    expect(buttons[1].classList.contains('is-selected')).toBe(false);
    expect(buttons.every((x) => !x.disabled)).toBe(true); // two subjects: switchable
    root.remove();
  });

  it('is present but disabled with exactly one subject (Principle 4)', () => {
    const trace = makeTrace();
    const st = stateAt();
    const { root } = mountPair(st, [subjectOf(trace)]);
    const btn = root.querySelector('.insp-subject') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(true);
    root.remove();
  });

  it('switch semantics: stage persists, candidate resets, view reprojected, onChange fires', () => {
    const { a, b } = pair();
    // Zoomed to [20, 40] (span 20) on a 64-channel subject; candidate selected; stage 3.
    const st = stateAt({
      subjectId: 'row-a',
      stageIndex: 3,
      selectedCandidate: 30,
      view: { xMin: 20, xMax: 40 },
      geometry: GEO,
    });
    const { root, onChange } = mountPair(st, [a, b]);
    (root.querySelector('.insp-subject[data-subject="row-b"]') as HTMLElement).click();
    expect(st.subjectId).toBe('row-b');
    expect(st.stageIndex).toBe(3); // stage persists
    expect(st.selectedCandidate).toBeNull(); // candidate was a channel in the OLD spectrum
    // Target domain [0, 31]: [20, 40] shifts (not clips) to [11, 31] -- span preserved.
    expect(st.view).toEqual({ xMin: 11, xMax: 31 });
    expect(st.geometry).toBeNull(); // stale; the redraw rebuilds it
    expect(onChange).toHaveBeenCalledTimes(1);
    root.remove();
  });

  it('same-domain switch preserves the zoom window unchanged', () => {
    const { a, b } = pair();
    const bSame: InspectorSubject = { ...b, channelCount: 64 };
    const st = stateAt({ subjectId: 'row-a', view: { xMin: 5, xMax: 20 } });
    const { root } = mountPair(st, [a, bSame]);
    (root.querySelector('.insp-subject[data-subject="row-b"]') as HTMLElement).click();
    expect(st.view).toEqual({ xMin: 5, xMax: 20 });
    root.remove();
  });

  it('clicking the already-selected subject is a no-op', () => {
    const { a, b } = pair();
    const st = stateAt({ subjectId: 'row-a', stageIndex: 2, view: { xMin: 5, xMax: 20 } });
    const { root, onChange } = mountPair(st, [a, b]);
    (root.querySelector('.insp-subject[data-subject="row-a"]') as HTMLElement).click();
    expect(st.subjectId).toBe('row-a');
    expect(st.stageIndex).toBe(2);
    expect(st.view).toEqual({ xMin: 5, xMax: 20 });
    expect(onChange).not.toHaveBeenCalled();
    root.remove();
  });

  it('lazy traces: only the SELECTED subject getTrace is invoked on render', () => {
    const { a, b, getA, getB } = pair();
    const st = stateAt({ subjectId: 'row-a' });
    const { root } = mountPair(st, [a, b]);
    expect(getA).toHaveBeenCalledTimes(1);
    expect(getB).not.toHaveBeenCalled();
    root.remove();
  });
});

// --- 4b: workspace-first entry resolution ----------------------------------------

describe('mountInspectorWorkspace -- entry resolution (Phase 4b)', () => {
  function pair4b() {
    const getA = vi.fn(() => makeTrace());
    const getB = vi.fn(() => makeTrace());
    const a: InspectorSubject = {
      id: 'row-a',
      label: 'a.TKA',
      status: statusOf({ label: '2 peaks', peakCount: 2 }),
      channelCount: 64,
      getTrace: getA,
    };
    const b: InspectorSubject = {
      id: 'row-b',
      label: 'b.TKA',
      status: statusOf({ state: 'anomaly', label: '1 unfittable', unfittableCount: 1 }),
      channelCount: 64,
      getTrace: getB,
    };
    return { a, b, getA, getB };
  }

  function mountFresh(st: InspectorWorkspaceState, subjects: readonly InspectorSubject[]) {
    const root = document.createElement('div');
    document.body.append(root);
    const onChange = vi.fn();
    const handle = mountInspectorWorkspace({ root, subjects, state: st, logY: false, onChange });
    return { root, onChange, handle };
  }

  it('auto-opens the sole subject when none is selected (set-then-render, no extra render)', () => {
    const st = emptyInspectorState(); // subjectId null
    const { root, onChange } = mountFresh(st, [subjectOf(makeTrace())]);
    expect(st.subjectId).toBe('row-1'); // set in the SAME mount pass
    expect(root.querySelector('.inspector-funnel')).not.toBeNull();
    expect(root.querySelector('.inspector-chart')).not.toBeNull();
    expect(root.querySelector('.insp-selector--prominent')).toBeNull();
    expect(onChange).not.toHaveBeenCalled(); // no forced host re-render
    root.remove();
  });

  it('shows the prominent selection step for >1 subjects and none selected; no trace built', () => {
    const { a, b, getA, getB } = pair4b();
    const st = emptyInspectorState();
    const { root } = mountFresh(st, [a, b]);
    const prominent = root.querySelector('.insp-selector--prominent');
    expect(prominent).not.toBeNull();
    expect(root.textContent).toContain('Select a spectrum to inspect');
    const buttons = [...root.querySelectorAll('.insp-subject')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].textContent).toContain('a.TKA');
    expect(buttons[0].querySelector('.br-status--healthy')).not.toBeNull();
    expect(buttons[1].textContent).toContain('1 unfittable');
    expect(buttons[1].querySelector('.br-status--anomaly')).not.toBeNull();
    expect(buttons.some((x) => x.classList.contains('is-selected'))).toBe(false);
    expect(buttons.some((x) => x.disabled)).toBe(false);
    // No inspection surface yet -- and, critically, no trace was built.
    expect(root.querySelector('.inspector-funnel')).toBeNull();
    expect(root.querySelector('.inspector-chart')).toBeNull();
    expect(getA).not.toHaveBeenCalled();
    expect(getB).not.toHaveBeenCalled();
    root.remove();
  });

  it('picking transitions: Raw stage, no candidate, full view; remount shows the recessed selector', () => {
    const { a, b } = pair4b();
    const st = emptyInspectorState();
    const { root, onChange } = mountFresh(st, [a, b]);
    (root.querySelector('.insp-subject[data-subject="row-b"]') as HTMLElement).click();
    expect(st.subjectId).toBe('row-b');
    expect(st.stageIndex).toBe(0); // opens on Raw (the seed persisted)
    expect(st.selectedCandidate).toBeNull();
    expect(st.view).toBeNull(); // reprojectView(null) stays full
    expect(onChange).toHaveBeenCalledTimes(1);
    // The host re-render remounts; now the inspection view with the RECESSED selector.
    const { root: root2 } = mountFresh(st, [a, b]);
    expect(root2.querySelector('.insp-selector--prominent')).toBeNull();
    expect(root2.querySelector('.inspector-funnel')).not.toBeNull();
    const picked = root2.querySelector('.insp-subject[data-subject="row-b"]') as HTMLButtonElement;
    expect(picked.classList.contains('is-selected')).toBe(true);
    root.remove();
    root2.remove();
  });

  it('zero subjects -> the DESIGNED empty state (4c), inert handle, no throw', () => {
    const st = emptyInspectorState();
    const { root, handle } = mountFresh(st, []);
    // Not a bare root any more: a labelled surface with one line of guidance.
    expect(root.querySelector('.inspector-empty')).not.toBeNull();
    expect(root.textContent).toContain('No inspectable spectra');
    expect(root.querySelector('.insp-empty-hint')).not.toBeNull();
    // Still no inspection surface and no selection step.
    expect(root.querySelector('.inspector-chart')).toBeNull();
    expect(root.querySelector('.insp-selector--prominent')).toBeNull();
    handle.redraw();
    handle.destroy();
    expect(st.subjectId).toBeNull();
    root.remove();
  });

  it('shared renderer: identical item markup in the prominent and recessed variants', () => {
    const { a, b } = pair4b();
    // Prominent (no selection yet): capture subject b's item.
    const stP = emptyInspectorState();
    const { root: rootP } = mountFresh(stP, [a, b]);
    const itemP = (rootP.querySelector('.insp-subject[data-subject="row-b"]') as HTMLElement).outerHTML;
    // Recessed (a selected): subject b is equally unselected + enabled.
    const stR = stateAt({ subjectId: 'row-a' });
    const { root: rootR } = mountFresh(stR, [a, b]);
    const itemR = (rootR.querySelector('.insp-subject[data-subject="row-b"]') as HTMLElement).outerHTML;
    expect(itemP).toBe(itemR); // one renderer, two prominences -- no divergence
    rootP.remove();
    rootR.remove();
  });
});

// --- 4c: removal auto-advance (pure host helper) ----------------------------------

describe('advanceSubjectOnRemoval (Phase 4c, frozen edge case A)', () => {
  const ordered = [
    { id: 'row-a', channelCount: 64 },
    { id: 'row-b', channelCount: 64 },
    { id: 'row-c', channelCount: 32 },
  ] as const;

  it('advances to the NEXT-by-index neighbor, preserving stage; view reprojected', () => {
    const st = stateAt({
      subjectId: 'row-b',
      stageIndex: 3,
      selectedCandidate: 30,
      view: { xMin: 20, xMax: 40 },
      geometry: GEO,
    });
    advanceSubjectOnRemoval(st, ordered, 'row-b');
    expect(st.subjectId).toBe('row-c');
    expect(st.stageIndex).toBe(3); // stage PRESERVED (comparison workspace)
    expect(st.selectedCandidate).toBeNull();
    expect(st.geometry).toBeNull();
    // row-c has a 32-channel domain: [20, 40] shifts (not clips) to [11, 31].
    expect(st.view).toEqual({ xMin: 11, xMax: 31 });
  });

  it('falls back to the PREVIOUS neighbor when the last item is removed', () => {
    const st = stateAt({ subjectId: 'row-c', stageIndex: 2, view: { xMin: 5, xMax: 20 } });
    advanceSubjectOnRemoval(st, ordered, 'row-c');
    expect(st.subjectId).toBe('row-b'); // no next -> previous
    expect(st.stageIndex).toBe(2);
    expect(st.view).toEqual({ xMin: 5, xMax: 20 }); // same-domain window preserved
  });

  it('removing the LAST remaining source -> subjectId null, view left as-is', () => {
    const st = stateAt({ subjectId: 'row-a', stageIndex: 4, view: { xMin: 5, xMax: 20 } });
    advanceSubjectOnRemoval(st, [{ id: 'row-a', channelCount: 64 }], 'row-a');
    expect(st.subjectId).toBeNull();
    expect(st.stageIndex).toBe(4);
    expect(st.selectedCandidate).toBeNull();
    expect(st.view).toEqual({ xMin: 5, xMax: 20 }); // untouched per the hand-off
  });

  it('removing a NON-inspected source is a no-op on the inspector state', () => {
    const st = stateAt({
      subjectId: 'row-a',
      stageIndex: 1,
      selectedCandidate: 30,
      view: { xMin: 5, xMax: 20 },
    });
    advanceSubjectOnRemoval(st, ordered, 'row-b');
    expect(st.subjectId).toBe('row-a');
    expect(st.stageIndex).toBe(1);
    expect(st.selectedCandidate).toBe(30);
    expect(st.view).toEqual({ xMin: 5, xMax: 20 });
  });
});

// --- 5: no import coupling -------------------------------------------------------

describe('inspectorWorkspace -- decoupling constraint on the module source', () => {
  it('imports no manager/app-state symbols (Principle 10)', () => {
    const src = readFileSync('src/ui/inspectorWorkspace.ts', 'utf8');
    // Assert on the IMPORT statements (the doc header may mention the names in
    // prose while stating this very constraint). Allowed deps: domain types +
    // chart primitives + pipeline constants + the Phase-1 status TYPE.
    const importLines = src
      .split(/\r?\n/)
      .filter((l) => /from '/.test(l))
      .join(';');
    expect(importLines).not.toContain('calibrationManager');
    expect(importLines).not.toContain('CalibViewState');
    expect(importLines).not.toContain("from './app'");
    // And no runtime reach into app state anywhere in the code:
    expect(src).not.toMatch(/\bstate\.calib\b/);
  });
});
