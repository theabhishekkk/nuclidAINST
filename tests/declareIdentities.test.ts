import { describe, it, expect } from 'vitest';

import {
  createCalibrationManager,
  deriveReviewStatus,
  type CalibrationManager,
} from '../src/ui/calibrationManager';
import {
  declareIdentitiesMarkup,
  navigatorItemMarkup,
  activeSourceMarkup,
  EXCLUDE_OPTION_VALUE,
} from '../src/ui/declareIdentities';
import { CALIBRATION_KIT } from '../src/data/calibrationKit';
import type {
  AnalysisReport,
  DetectedPeak,
  FittedPeak,
  PeakAssignment,
  Spectrum,
  StageTrace,
  ValidatedPeak,
} from '../src/domain/types';

/**
 * Declare Identities -- Phase 2: assignment capture on the manager + the
 * navigator / active-surface / checklist markup.
 *
 * Unit bar (hand-off DoD 6): assignments initialised on add; assign/exclude/
 * clear transitions incl. the kit tier/reliable lookup; setIdentity resets that
 * row; active-row default + removal auto-advance; deriveReviewStatus's three
 * states. Markup bar: one navigator item per source with review status; one
 * peak row per fitted peak with the active source's kit lines as options; the
 * checklist reflects assignments; `.br-identity` keeps its `data-row` seam.
 *
 * Engine-shaped factories mirror batchRowStatus.test.ts.
 */

// --- minimal engine-shaped factories -----------------------------------------

function spectrumOf(fileName = 'synthetic.TKA'): Spectrum {
  const counts = new Array<number>(64).fill(1);
  return {
    counts,
    metadata: {
      fileName,
      format: 'tka',
      liveTimeSec: null,
      realTimeSec: null,
      channelCount: counts.length,
      statedNuclideHint: null,
      fileSizeBytes: null,
      detector: null,
      sampleName: null,
      measurementDate: null,
    },
  };
}

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

function validVerdict(peak: FittedPeak, valid = true): ValidatedPeak {
  return { peak, valid, flags: valid ? [] : ['weak'] };
}

const OK_STAGES: readonly StageTrace[] = (
  ['load', 'condition', 'detect', 'fit', 'validate', 'report'] as const
).map((stage) => ({ stage, status: 'ok', note: '', durationMs: 0 }));

function healthyReport(n: number, fileName = 'synthetic.TKA'): AnalysisReport {
  const peaks = Array.from({ length: n }, (_, i) =>
    fittedPeak({ detectedChannel: 20 + i * 10, centroidChannel: 20.2 + i * 10 }),
  );
  return {
    spectrum: spectrumOf(fileName),
    conditioned: null,
    detectedCandidates: peaks.map((p) => detectedPeak({ channel: p.detectedChannel })),
    peaks,
    allFitted: peaks,
    unfittable: [],
    validatedPeaks: peaks.map((p) => validVerdict(p)),
    calibration: null,
    identifications: [],
    activities: [],
    trace: OK_STAGES,
  };
}

/** Fresh manager with `n` sources of 3 peaks each; returns manager + rowIds. */
function managerWith(n: number): { mgr: CalibrationManager; rows: string[] } {
  const mgr = createCalibrationManager();
  for (let k = 0; k < n; k++) mgr.addParsedSource(healthyReport(3, `s${k + 1}.TKA`));
  return { mgr, rows: mgr.sources.map((s) => s.rowId) };
}

const CO60 = CALIBRATION_KIT.entries.find((e) => e.id === 'Co-60')!;

// =============================================================================
// Part 1 -- manager assignment state
// =============================================================================
describe('manager -- assignments initialised on add', () => {
  it('one unassigned entry per fitted peak, peakId = rowId:index', () => {
    const { mgr, rows } = managerWith(1);
    const s = mgr.sources[0];
    expect(s.assignments).toHaveLength(s.fittedPeaks.length);
    s.assignments.forEach((a, i) => {
      expect(a.peakId).toBe(`${rows[0]}:${i}`);
      expect(a.state).toBe('unassigned');
      expect(a.centroidChannel).toBe(s.fittedPeaks[i].centroidChannel);
      expect(a.centroidError).toBe(s.fittedPeaks[i].centroidError);
      expect(a.energyKeV).toBeUndefined();
    });
  });
});

describe('manager -- assign / exclude / clear transitions', () => {
  it('assignPeak sets energy, sourceId, and the kit tier/reliable for that line', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    const line = CO60.lines[0];
    mgr.assignPeak(rows[0], `${rows[0]}:0`, line.energyKeV);
    const a = mgr.sources[0].assignments[0];
    expect(a.state).toBe('assigned');
    expect(a.energyKeV).toBe(line.energyKeV);
    expect(a.sourceId).toBe('Co-60');
    expect(a.tier).toBe(line.tier);
    expect(a.reliable).toBe(line.reliable);
  });

  it('excludePeak clears the line fields; clearPeak returns to unassigned', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    const peak = `${rows[0]}:1`;
    mgr.assignPeak(rows[0], peak, CO60.lines[0].energyKeV);
    mgr.excludePeak(rows[0], peak);
    let a = mgr.sources[0].assignments[1];
    expect(a.state).toBe('excluded');
    expect(a.energyKeV).toBeUndefined();
    expect(a.tier).toBeUndefined();
    expect(a.reliable).toBeUndefined();
    mgr.clearPeak(rows[0], peak);
    a = mgr.sources[0].assignments[1];
    expect(a.state).toBe('unassigned');
    expect(a.peakId).toBe(peak); // identity fields survive every transition
  });

  it('assignment edits do NOT invalidate the collecting phase (captured only)', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    const before = mgr.phase.kind;
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    expect(mgr.phase.kind).toBe(before);
  });
});

describe('manager -- setIdentity resets that row (old lines no longer apply)', () => {
  it('re-declaring wipes decisions back to unassigned, other rows untouched', () => {
    const { mgr, rows } = managerWith(2);
    mgr.setIdentity(rows[0], 'Co-60');
    mgr.setIdentity(rows[1], 'Co-60');
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    mgr.assignPeak(rows[1], `${rows[1]}:0`, CO60.lines[0].energyKeV);
    mgr.setIdentity(rows[0], 'Cs-137');
    expect(mgr.sources[0].assignments.every((a) => a.state === 'unassigned')).toBe(true);
    expect(mgr.sources[1].assignments[0].state).toBe('assigned'); // untouched
  });
});

describe('manager -- active-row cursor', () => {
  it('defaults to the first source on first add and sticks across later adds', () => {
    const { mgr, rows } = managerWith(3);
    expect(mgr.activeRowId).toBe(rows[0]);
  });

  it('setActiveRow selects only existing rows', () => {
    const { mgr, rows } = managerWith(2);
    mgr.setActiveRow(rows[1]);
    expect(mgr.activeRowId).toBe(rows[1]);
    mgr.setActiveRow('row-nope');
    expect(mgr.activeRowId).toBe(rows[1]);
  });

  it('removing the active row advances next-else-previous, null when none', () => {
    const { mgr, rows } = managerWith(3);
    mgr.setActiveRow(rows[1]);
    mgr.removeSource(rows[1]); // middle: next
    expect(mgr.activeRowId).toBe(rows[2]);
    mgr.removeSource(rows[2]); // last: previous
    expect(mgr.activeRowId).toBe(rows[0]);
    mgr.removeSource(rows[0]); // only one: none left
    expect(mgr.activeRowId).toBeNull();
  });

  it('removing a non-active row leaves the cursor alone; reset clears it', () => {
    const { mgr, rows } = managerWith(2);
    mgr.removeSource(rows[1]);
    expect(mgr.activeRowId).toBe(rows[0]);
    mgr.reset();
    expect(mgr.activeRowId).toBeNull();
  });
});

describe('deriveReviewStatus -- three states (non-gating)', () => {
  const a = (state: PeakAssignment['state'], i = 0): PeakAssignment => ({
    peakId: `r:${i}`,
    centroidChannel: 10 + i,
    state,
  });

  it('untouched when nothing is decided (and for the zero-peak case)', () => {
    expect(deriveReviewStatus([a('unassigned'), a('unassigned', 1)])).toBe('untouched');
    expect(deriveReviewStatus([])).toBe('untouched');
  });

  it('in-progress when some but not all are decided', () => {
    expect(deriveReviewStatus([a('assigned'), a('unassigned', 1)])).toBe('in-progress');
  });

  it('reviewed when every peak is assigned or excluded', () => {
    expect(deriveReviewStatus([a('assigned'), a('excluded', 1)])).toBe('reviewed');
  });
});

// =============================================================================
// Part 2 -- markup: navigator + active surface + checklist
// =============================================================================
describe('markup -- focused assign-energies pager view', () => {
  it('shows one source at a time behind a pager, with its status chip + identity select + graph', () => {
    const { mgr, rows } = managerWith(2);
    const html = declareIdentitiesMarkup(mgr);
    // Pager view (2026-07-07): one source on screen at a time, stepped via `#calSrcPrev` /
    // `#calSrcNext`, graph-on-top -- replaces the consolidated `.di-table`.
    expect(html).toContain('di-assign-view');
    expect(html).toContain('di-pager');
    expect(html).toContain('Source 1 of 2'); // the pager counter
    expect(html).toContain('calAssignChart'); // the full-width spectrum graph canvas
    // The active source (defaults to the first) is on screen; its chip + identity select render.
    expect(html).toContain(`data-row="${rows[0]}"`);
    expect(html).toContain('br-status--healthy'); // passive detection chip, unchanged
    expect(html).toContain('br-identity'); // Rule-12 identity select
    // Focused view: the inactive source is NOT rendered.
    expect(html).not.toContain(`data-row="${rows[1]}"`);
  });

  it('review indicator moves with assignment state', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    const item = navigatorItemMarkup(mgr.sources[0], true);
    expect(item).toContain('di-review--in-progress');
    mgr.assignPeak(rows[0], `${rows[0]}:1`, CO60.lines[1].energyKeV);
    mgr.excludePeak(rows[0], `${rows[0]}:2`);
    expect(navigatorItemMarkup(mgr.sources[0], true)).toContain('di-review--reviewed');
  });
});

describe('markup -- active-source surface', () => {
  it('keeps the .br-identity select with its data-row (existing handler seam)', () => {
    const { mgr, rows } = managerWith(1);
    const html = activeSourceMarkup(mgr.sources[0]);
    expect(html).toContain('br-identity');
    expect(html).toContain(`data-row="${rows[0]}"`);
  });

  it('with no declared identity: hint instead of a pick list', () => {
    const { mgr } = managerWith(1);
    const html = activeSourceMarkup(mgr.sources[0]); // sourceId '' (no suggestion)
    expect(html).toContain('Declare the source above to assign peaks');
    expect(html).not.toContain('di-assign');
  });

  it('declared: one peak row per fitted peak; options = kit lines + Exclude', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    const s = mgr.sources[0];
    const html = activeSourceMarkup(s);
    expect(html.match(/class="di-peak"/g)).toHaveLength(s.fittedPeaks.length);
    for (const l of CO60.lines) expect(html).toContain(`value="${l.energyKeV}"`);
    expect(html).toContain(`value="${EXCLUDE_OPTION_VALUE}"`);
    expect(html).toContain(`data-peak="${rows[0]}:0"`);
    expect(html).toContain(`ch ${s.fittedPeaks[0].centroidChannel.toFixed(1)}`);
  });

  it('reflects current state as selected options', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    mgr.excludePeak(rows[0], `${rows[0]}:1`);
    const html = activeSourceMarkup(mgr.sources[0]);
    expect(html).toMatch(
      new RegExp(`value="${CO60.lines[0].energyKeV}"\\s+selected`),
    );
    expect(html).toMatch(new RegExp(`value="${EXCLUDE_OPTION_VALUE}"\\s+selected`));
  });
});

describe('markup -- expected-line checklist (non-gating)', () => {
  it('marks a line matched once an assignment carries its energy', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    let html = activeSourceMarkup(mgr.sources[0]);
    expect(html.match(/di-line--unmatched/g)).toHaveLength(CO60.lines.length);
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    html = activeSourceMarkup(mgr.sources[0]);
    expect(html.match(/di-line--matched/g)).toHaveLength(1);
    expect(html.match(/di-line--unmatched/g)).toHaveLength(CO60.lines.length - 1);
  });

  it('flags a line assigned to two peaks as a conflict (visual only)', () => {
    const { mgr, rows } = managerWith(1);
    mgr.setIdentity(rows[0], 'Co-60');
    mgr.assignPeak(rows[0], `${rows[0]}:0`, CO60.lines[0].energyKeV);
    mgr.assignPeak(rows[0], `${rows[0]}:1`, CO60.lines[0].energyKeV);
    const html = activeSourceMarkup(mgr.sources[0]);
    expect(html).toContain('di-line--conflict');
    expect(html).toContain('assigned to 2 peaks');
  });
});
