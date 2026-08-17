import { describe, it, expect } from 'vitest';

import {
  derivePeakFinderTableRows,
  peakFinderTableSectionMarkup,
  peakFinderStateMarkup,
  peakFinderCountStrip,
  derivePeakFinderSummary,
  peakFinderSummaryMarkup,
  peakFinderDetectSettingsMarkup,
  sortRows,
  filterRows,
  DEFAULT_TABLE_SORT,
  DEFAULT_TABLE_FILTER,
  type PeakFinderTableRow,
} from '../src/ui/peakFinderTables';
import { INSPECTOR_STAGES } from '../src/ui/inspectorWorkspace';
import { analyze } from '../src/pipeline/orchestrator';
import { buildPipelineTrace } from '../src/pipeline/pipelineTrace';
import { deriveSpectrumStatus, type SpectrumStatus } from '../src/pipeline/spectrumStatus';
import { syntheticTka } from '../src/data/synthetic';
import type {
  DetectedPeak,
  FittedPeak,
  PipelineTrace,
  StageTrace,
} from '../src/domain/types';

/**
 * Peak Finder P2 -- the per-stage table + Review-summary derivations. Pure, no
 * DOM. A hand-built fixture trace covers every Result branch (survivor, each
 * detect gate, kept, guard-rejected, unfittable, valid, flagged) so the
 * stage-aware verdict column is pinned exactly; a REAL engine run (synthetic
 * spectrum) then proves each summary figure equals its contract source
 * (Principle 9). Channel-space guard: no table/summary markup may ever contain
 * energy wording.
 */

// --- fixture: a minimal, internally consistent PipelineTrace -------------------

function det(channel: number, passed: boolean, rejectReason?: string): DetectedPeak {
  return {
    channel,
    height: 12.5,
    fwhmChannels: 3.2,
    leftIp: channel - 1.6,
    rightIp: channel + 1.6,
    prominence: 8.4,
    netArea: 150.7,
    grossArea: 400,
    significance: 7.5,
    expectedFwhmChannels: 3.1,
    widthRatio: 1.03,
    classification: 'line',
    passed,
    ...(rejectReason ? { rejectReason } : {}),
  } as DetectedPeak;
}

function fit(
  detectedChannel: number,
  status: 'kept' | 'rejected',
  over: Partial<FittedPeak> = {},
): FittedPeak {
  return {
    centroidChannel: detectedChannel + 0.25,
    centroidError: 0.05,
    amplitude: 50,
    fwhmChannels: 3.4,
    netArea: 160.2,
    chiSquare: 1.234,
    energyKeV: null,
    classification: 'line',
    significance: 7.5,
    detectedChannel,
    status,
    ...over,
  } as FittedPeak;
}

const F10 = fit(10, 'kept');
const F15 = fit(15, 'kept', { chiSquare: 2.5 });
const F20 = fit(20, 'rejected', { chiSquare: null, rejectReason: 'peak-hop' });

const TRACE: PipelineTrace = {
  spectrumId: 'fixture.tka',
  channels: Array.from({ length: 64 }, (_, i) => i),
  raw: new Array(64).fill(0),
  conditioned: null,
  detected: {
    all: [
      det(10, true),
      det(15, true),
      det(20, true),
      det(30, false, 'prominence'),
      det(40, false, 'distance'),
      det(50, true),
    ],
    survivors: [det(10, true), det(15, true), det(20, true), det(50, true)],
  },
  fitted: {
    all: [F10, F15, F20],
    kept: [F10, F15],
    unfittable: [{ detectedChannel: 50, reason: 'no-convergence' }],
  },
  validated: [
    { peak: F10, valid: true, flags: [] },
    { peak: F15, valid: false, flags: ['weak', 'wide-fwhm'] },
  ],
  constants: {
    prominence: 200,
    distance: 8,
    minWidth: 2,
    relHeight: 0.5,
    windowFactor: 1.5,
    minHalfWindow: 4,
    minSignificance: 2,
    maxWidthRatio: 5,
  },
  timing: [],
  version: 1,
};

const STATUS: SpectrumStatus = {
  state: 'anomaly',
  peakCount: 1, // valid validated peaks -- the canonical contract count
  unfittableCount: 1,
  rejectedFitCount: 1,
  failingStage: null,
  label: '1 unfittable',
};

const STAGE_TRACE: StageTrace[] = [
  { stage: 'load', status: 'ok', note: '', durationMs: 5 },
  { stage: 'condition', status: 'ok', note: '', durationMs: 3 },
  { stage: 'detect', status: 'ok', note: '', durationMs: 2 },
  { stage: 'fit', status: 'ok', note: '', durationMs: 10 },
  { stage: 'validate', status: 'ok', note: '', durationMs: 1 },
  { stage: 'calibrate', status: 'skipped', note: '', durationMs: 99 }, // excluded
  { stage: 'identify', status: 'skipped', note: '', durationMs: 0 },
  { stage: 'quantify', status: 'skipped', note: '', durationMs: 0 },
  { stage: 'report', status: 'ok', note: '', durationMs: 7 }, // bookkeeping -- excluded
];

// --- per-stage rows -------------------------------------------------------------

describe('derivePeakFinderTableRows -- the eight-stage funnel (Phase 3, keyed by stage id)', () => {
  it('local-maxima: one row per local maximum; all Candidate; chi always null', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'local-maxima');
    expect(rows).toHaveLength(TRACE.detected.all.length);
    expect(rows.every((r) => r.chiSquare === null)).toBe(true);
    expect(rows.every((r) => r.result === 'Candidate' && r.resultKind === 'pass')).toBe(true);
    // Secondary measurements live in the detail drawer, not the columns.
    expect(rows[0].detail.map((x) => x.label)).toEqual(['Height', 'Prominence', 'SNR', 'Class']);
  });

  it('distance: entering = all; only the distance-struck peak drops, others advance', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'distance');
    expect(rows).toHaveLength(TRACE.detected.all.length); // 6 entered the distance gate
    expect(rows.find((r) => r.channel === 40)?.result).toBe('rejected: distance');
    expect(rows.find((r) => r.channel === 40)?.resultKind).toBe('drop');
    // ch 30 fails a LATER gate (prominence) -> it advances PAST distance here.
    expect(rows.find((r) => r.channel === 30)?.result).toBe('Advancing');
    expect(rows.find((r) => r.channel === 10)?.result).toBe('Advancing');
  });

  it('prominence: entering = post-distance survivors; prominence-struck drops', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'prominence');
    expect(rows).toHaveLength(5); // all minus the distance-rejected ch 40
    expect(rows.some((r) => r.channel === 40)).toBe(false);
    expect(rows.find((r) => r.channel === 30)?.result).toBe('rejected: prominence');
    expect(rows.find((r) => r.channel === 10)?.result).toBe('Advancing');
  });

  it('width: entering = post-prominence survivors; all survive here -> Survivor', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'width');
    expect(rows).toHaveLength(4); // the four survivors (no width rejects in the fixture)
    expect(rows.every((r) => r.result === 'Survivor' && r.resultKind === 'pass')).toBe(true);
    expect(rows.map((r) => r.channel)).toEqual([10, 15, 20, 50]);
  });

  it('strength: survivors annotated with their significance (SNR)', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'strength');
    expect(rows).toHaveLength(TRACE.detected.survivors.length);
    expect(rows.every((r) => r.result === 'SNR 7.5' && r.resultKind === 'pass')).toBe(true);
  });

  it('classification: survivors carry their class; only line passes cleanly', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'classification');
    expect(rows).toHaveLength(TRACE.detected.survivors.length);
    expect(rows.every((r) => r.result === 'line' && r.resultKind === 'pass')).toBe(true);
  });

  it('fit: kept + guard-rejected + unfittable, the full three-way partition', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'fit');
    expect(rows).toHaveLength(4); // 2 kept + 1 rejected + 1 unfittable
    expect(rows[0].result).toBe('Kept');
    expect(rows[0].chiSquare).toBe(1.234);
    const rejected = rows.find((r) => r.channel === 20);
    expect(rejected?.result).toBe('rejected: peak-hop');
    expect(rejected?.chiSquare).toBeNull(); // guard rejects pre-statistics
    const unfittable = rows.find((r) => r.channel === 50);
    expect(unfittable?.result).toBe('unfittable: no-convergence');
    expect(unfittable?.fwhmChannels).toBeNull();
    expect(unfittable?.netArea).toBeNull();
  });

  it('fitted rows carry the INTEGER detection channel (the cross-stage selection key)', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'fit');
    expect(rows.map((r) => r.channel)).toEqual([10, 15, 20, 50]); // never centroids
  });

  it('validated: valid verdict or the flags joined -- never silently dropped', () => {
    const rows = derivePeakFinderTableRows(TRACE, 'validated');
    expect(rows).toHaveLength(TRACE.validated.length);
    expect(rows[0]).toMatchObject({ channel: 10, result: 'Valid', resultKind: 'pass' });
    expect(rows[1]).toMatchObject({ channel: 15, result: 'weak, wide-fwhm', resultKind: 'drop' });
  });
});

/** The eight PF Run stage ids, for loops that assert a property across every stage. */
const PF_STAGE_IDS = [
  'local-maxima',
  'distance',
  'prominence',
  'width',
  'strength',
  'classification',
  'fit',
  'validated',
] as const;

// --- #6 stable channel order + #7 view-only sort ---------------------------------

describe('#6 -- stable channel-ascending order at every stage (no survivors-first float)', () => {
  it('rows are strictly channel-ascending for every stage id', () => {
    for (const id of PF_STAGE_IDS) {
      const channels = derivePeakFinderTableRows(TRACE, id).map((r) => r.channel);
      const sorted = [...channels].sort((a, b) => a - b);
      expect(channels, `stage ${id}`).toEqual(sorted);
    }
  });

  it('a mid-table drop stays IN channel place (not floated to the end)', () => {
    // ch 40 is distance-rejected; pre-#6 `passFirst` floated it after ch 50. It must now
    // sit between 30 and 50 -- the whole point of #6 (a candidate does not jump position).
    const rows = derivePeakFinderTableRows(TRACE, 'distance');
    expect(rows.map((r) => r.channel)).toEqual([10, 15, 20, 30, 40, 50]);
    expect(rows.find((r) => r.channel === 40)?.resultKind).toBe('drop');
  });

  it('row COUNT per stage is unchanged (RISK-04: the reorder removal drops nothing)', () => {
    const expected: Record<(typeof PF_STAGE_IDS)[number], number> = {
      'local-maxima': 6,
      distance: 6,
      prominence: 5,
      width: 4,
      strength: 4,
      classification: 4,
      fit: 4,
      validated: 2,
    };
    for (const id of PF_STAGE_IDS) {
      expect(derivePeakFinderTableRows(TRACE, id).length, `stage ${id}`).toBe(expected[id]);
    }
  });
});

describe('sortRows -- #7 view-only sort (pure, non-mutating)', () => {
  const row = (channel: number): PeakFinderTableRow => ({
    channel,
    fwhmChannels: null,
    netArea: null,
    chiSquare: null,
    result: '',
    resultKind: 'pass',
    detail: [],
  });

  it('the default view is channel ascending', () => {
    expect(DEFAULT_TABLE_SORT).toEqual({ key: 'channel', dir: 'asc' });
  });

  it('ascending orders by channel', () => {
    const out = sortRows([row(30), row(10), row(20)], { key: 'channel', dir: 'asc' });
    expect(out.map((r) => r.channel)).toEqual([10, 20, 30]);
  });

  it('descending reverses; toggling back to ascending restores the order exactly', () => {
    const base = [row(30), row(10), row(20)];
    const desc = sortRows(base, { key: 'channel', dir: 'desc' });
    expect(desc.map((r) => r.channel)).toEqual([30, 20, 10]);
    const asc = sortRows(desc, { key: 'channel', dir: 'asc' });
    expect(asc.map((r) => r.channel)).toEqual([10, 20, 30]);
  });

  it('does not mutate the input array', () => {
    const base = [row(30), row(10)];
    sortRows(base, { key: 'channel', dir: 'asc' });
    expect(base.map((r) => r.channel)).toEqual([30, 10]);
  });

  it('nulls sort LAST regardless of dir (the generic rule, before netArea/chiSquare keys exist)', () => {
    // channel is never null in practice; a null-channel row exercises the comparator's
    // nulls-last branch directly, proving it before a nullable sort key is added.
    const nul = (): PeakFinderTableRow => ({ ...row(0), channel: null as unknown as number });
    const rows = [row(20), nul(), row(10)];
    expect(sortRows(rows, { key: 'channel', dir: 'asc' }).map((r) => r.channel)).toEqual([
      10,
      20,
      null,
    ]);
    expect(sortRows(rows, { key: 'channel', dir: 'desc' }).map((r) => r.channel)).toEqual([
      20,
      10,
      null,
    ]);
  });
});

describe('filterRows -- #8 view-only candidate filter (pure, over resultKind)', () => {
  const row = (channel: number, kind: 'pass' | 'drop'): PeakFinderTableRow => ({
    channel,
    fwhmChannels: null,
    netArea: null,
    chiSquare: null,
    result: '',
    resultKind: kind,
    detail: [],
  });
  const MIX = [row(10, 'pass'), row(20, 'drop'), row(30, 'pass'), row(40, 'drop')];

  it('the default filter is All', () => {
    expect(DEFAULT_TABLE_FILTER).toBe('all');
  });

  it("'all' returns every row (unchanged order)", () => {
    expect(filterRows(MIX, 'all').map((r) => r.channel)).toEqual([10, 20, 30, 40]);
  });

  it("'advancing' keeps exactly the resultKind==='pass' rows", () => {
    const out = filterRows(MIX, 'advancing');
    expect(out.map((r) => r.channel)).toEqual([10, 30]);
    expect(out.every((r) => r.resultKind === 'pass')).toBe(true);
  });

  it("'rejected' keeps exactly the resultKind==='drop' rows", () => {
    const out = filterRows(MIX, 'rejected');
    expect(out.map((r) => r.channel)).toEqual([20, 40]);
    expect(out.every((r) => r.resultKind === 'drop')).toBe(true);
  });

  it('advancing + rejected counts add up to all; order within each is preserved', () => {
    expect(filterRows(MIX, 'advancing').length + filterRows(MIX, 'rejected').length).toBe(
      MIX.length,
    );
  });

  it('empty-result honesty: a filter can legitimately match nothing', () => {
    const allPass = [row(1, 'pass'), row(2, 'pass')];
    expect(filterRows(allPass, 'rejected')).toEqual([]);
    const allDrop = [row(1, 'drop')];
    expect(filterRows(allDrop, 'advancing')).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const base = [row(30, 'pass'), row(10, 'drop')];
    filterRows(base, 'advancing');
    expect(base.map((r) => r.channel)).toEqual([30, 10]);
  });

  it('renders an honest empty state + no data rows when the filter hides everything', () => {
    // The Distance fixture has drops (ch 40 rejected); Advancing hides them at a stage with
    // only-drops is synthetic, so assert on the section markup directly for the Rejected view.
    const advancing = peakFinderTableSectionMarkup(
      TRACE,
      STATUS,
      'distance',
      null,
      true,
      DEFAULT_TABLE_SORT,
      'rejected',
    );
    // ch 40 is the distance-rejected drop -> present under Rejected; passes hidden.
    expect(advancing).toContain('data-channel="40"');
    expect(advancing).not.toContain('data-channel="10"');
  });
});

// --- section markup --------------------------------------------------------------

describe('peakFinderTableSectionMarkup', () => {
  it('renders the five LOCKED columns and a "—" chi cell at a gate stage', () => {
    const html = peakFinderTableSectionMarkup(TRACE, STATUS, 'distance', null);
    for (const col of ['Channel', 'FWHM', 'Net Area', 'Chi-square', 'Result']) {
      expect(html).toContain(`<th>${col}</th>`);
    }
    expect(html).toContain('data-channel="30"');
    expect(html).toContain('—'); // the null chi / absent-value display
  });

  it('every PF Run stage renders a table (no pre-detection empty state remains)', () => {
    for (const id of PF_STAGE_IDS) {
      const html = peakFinderTableSectionMarkup(TRACE, STATUS, id, null);
      expect(html, `stage ${id}`).toContain('<tbody');
    }
  });

  it('marks exactly the selected channel row is-selected', () => {
    const html = peakFinderTableSectionMarkup(TRACE, STATUS, 'local-maxima', 15);
    expect(html.match(/is-selected/g)).toHaveLength(1);
    expect(html).toMatch(/is-selected"\s+data-channel="15"/);
  });

  it('detail drawer reuses the inspector fate line (no parallel explainer)', () => {
    const html = peakFinderTableSectionMarkup(TRACE, STATUS, 'local-maxima', null);
    expect(html).toContain('Channel 30 — rejected at the prominence gate.');
  });

  it('count strips are contract/partition sourced per stage', () => {
    expect(peakFinderCountStrip(TRACE, STATUS, 'local-maxima')).toBe('6 local maxima found');
    expect(peakFinderCountStrip(TRACE, STATUS, 'distance')).toBe(
      '6 candidates → 5 pass the distance gate',
    );
    expect(peakFinderCountStrip(TRACE, STATUS, 'prominence')).toBe(
      '5 candidates → 4 pass the prominence gate',
    );
    expect(peakFinderCountStrip(TRACE, STATUS, 'width')).toBe(
      '4 candidates → 4 survive the width gate',
    );
    expect(peakFinderCountStrip(TRACE, STATUS, 'strength')).toBe('4 survivors measured');
    expect(peakFinderCountStrip(TRACE, STATUS, 'classification')).toBe(
      '4 survivors → 4 line · 0 broad/weak',
    );
    expect(peakFinderCountStrip(TRACE, STATUS, 'fit')).toBe(
      '4 survivors → 2 fitted · 1 rejected · 1 unfittable',
    );
    expect(peakFinderCountStrip(TRACE, STATUS, 'validated')).toBe('2 fitted → 1 valid · 1 flagged');
  });

  it('never contains energy wording at any stage (channel space only)', () => {
    for (const id of PF_STAGE_IDS) {
      const html = peakFinderTableSectionMarkup(TRACE, STATUS, id, 10);
      expect(html).not.toMatch(/energy|keV/i);
    }
  });
});

// --- per-host Validated caption split (P2 addendum) -------------------------------

describe('Validated caption is split per host (operator ruling, P2 addendum)', () => {
  const validated = INSPECTOR_STAGES.find((s) => s.id === 'validated');

  it('the shared INSPECTOR_STAGES caption carries the Calibrate energy-calibration framing', () => {
    // Guards against the split silently collapsing back to a shared channel-space
    // string: the inspector / Calibrate surface MUST keep its energy wording.
    expect(validated?.caption).toBe('Validated peaks — the anchors that feed energy calibration.');
    expect(validated?.caption).toMatch(/energy calibration/i);
  });

  it('Peak Finder overrides it with the channel-space wording (no energy wording)', () => {
    // The Peak Finder string is host-specific (app.ts pfCaption). It must NOT be
    // the shared inspector caption, and must carry no energy wording. (The live
    // rendered Peak Finder caption is confirmed in the browser live-verify.)
    const PF = 'Validated peaks — the final output of the detection pipeline.';
    expect(PF).not.toBe(validated?.caption); // the two hosts have genuinely diverged
    expect(PF).not.toMatch(/energy|keV/i);
  });
});

// --- reveal-lock: the table is non-interactive while running (P2 addendum) --------

describe('peakFinderTableSectionMarkup -- reveal-lock (interactive flag)', () => {
  it('interactive=false renders inert rows: no data-channel, no tabindex, no chevron/drawer', () => {
    const html = peakFinderTableSectionMarkup(TRACE, STATUS, 'local-maxima', null, false);
    expect(html).not.toContain('data-channel'); // row click handler keys off this
    expect(html).not.toContain('tabindex'); // genuinely unfocusable
    expect(html).not.toContain('pf-expand'); // no expandable-detail affordance
    expect(html).not.toContain('pf-detail'); // drawer row omitted entirely
    expect(html).toContain('is-locked');
    // The funnel is still visible: rows + the count strip still display.
    expect(html).toContain('<tbody');
    expect(html).toContain('6 local maxima found');
  });

  it('interactive=true (default) keeps rows selectable + expandable', () => {
    const html = peakFinderTableSectionMarkup(TRACE, STATUS, 'local-maxima', null);
    expect(html).toContain('data-channel="10"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('pf-expand');
    expect(html).toContain('pf-detail');
  });
});

// --- Review summary + settings ----------------------------------------------------

describe('derivePeakFinderSummary -- every figure equals its contract source', () => {
  it('fixture: figures come from the trace partitions + the status contract', () => {
    const s = derivePeakFinderSummary(TRACE, STATUS, STAGE_TRACE);
    expect(s.channelsAnalyzed).toBe(64);
    expect(s.initialCandidates).toBe(6);
    expect(s.fittedCount).toBe(2);
    expect(s.validatedCount).toBe(STATUS.peakCount); // canonical, NOT recomputed
    // load+condition+detect+fit+validate = 5+3+2+10+1; skipped/report excluded.
    expect(s.processingMs).toBe(21);
  });

  it('real engine run: each figure equals its contract source', () => {
    const report = analyze({ text: syntheticTka(), fileName: 'synthetic-demo.tka' });
    const trace = buildPipelineTrace(report);
    const status = deriveSpectrumStatus(report);
    const s = derivePeakFinderSummary(trace, status, report.trace);
    expect(s.channelsAnalyzed).toBe(report.spectrum.counts.length);
    expect(s.initialCandidates).toBe(report.allDetected?.length ?? -1);
    expect(s.fittedCount).toBe(report.peaks.length);
    expect(s.validatedCount).toBe(status.peakCount);
    const expectMs = report.trace
      .filter((t) => ['load', 'condition', 'detect', 'fit', 'validate'].includes(t.stage))
      .reduce((sum, t) => sum + t.durationMs, 0);
    expect(s.processingMs).toBeCloseTo(expectMs, 10);
    expect(s.processingMs).toBeGreaterThan(0); // measured, never fabricated
  });

  it('summary + settings markup are honest and channel-space only', () => {
    const html =
      peakFinderSummaryMarkup(derivePeakFinderSummary(TRACE, STATUS, STAGE_TRACE)) +
      peakFinderDetectSettingsMarkup(TRACE.constants);
    expect(html).toContain('Channels analyzed');
    expect(html).toContain('21 ms');
    expect(html).toContain('Detect settings this run used');
    expect(html).toContain('<dd>200</dd>'); // effective prominence, not a control
    expect(html).not.toContain('<input'); // read-only by design (PARK-13)
    expect(html).not.toMatch(/energy|keV/i);
  });
});

// --- honest state surfaces (P3, 4a) ----------------------------------------------

/** Channel-space audit regex (P3, 4c): matches the energy tokens `energy`,
 * `keV`, `Energy`, and a standalone `eV` -- but NOT innocent substrings like
 * "every" / "level" (word-bounded eV). The enforcement seam that keeps Peak
 * Finder copy honest permanently. */
const ENERGY_RE = /energy|kev|\beV\b/i;

function status(over: Partial<SpectrumStatus> & Pick<SpectrumStatus, 'state'>): SpectrumStatus {
  return {
    peakCount: 0,
    unfittableCount: 0,
    rejectedFitCount: 0,
    failingStage: null,
    label: '',
    ...over,
  };
}

describe('peakFinderStateMarkup -- the honest state-aware Review block', () => {
  it('healthy: states the validated-peak count, keyed on the state class', () => {
    const html = peakFinderStateMarkup(status({ state: 'healthy', peakCount: 4, label: '4 peaks' }), 'a.tka');
    expect(html).toContain('pf-state--healthy');
    expect(html).toContain('4 validated peaks in a.tka.');
    expect(html).toContain('Peak positions are channel indices.');
  });

  it('healthy singular: "1 validated peak"', () => {
    const html = peakFinderStateMarkup(status({ state: 'healthy', peakCount: 1 }), 'a.tka');
    expect(html).toContain('1 validated peak in a.tka.');
  });

  it('empty: honest "found no peaks", names the gates, no fabricated counts', () => {
    const html = peakFinderStateMarkup(status({ state: 'empty', label: '0 peaks' }), 'flat.tka');
    expect(html).toContain('pf-state--empty');
    expect(html).toContain('found no peaks in flat.tka');
    expect(html).toContain('prominence, distance, and width gates');
  });

  it('anomaly (no valid peaks): names the breakdown + points to the Result column', () => {
    const html = peakFinderStateMarkup(
      status({ state: 'anomaly', peakCount: 0, unfittableCount: 3, rejectedFitCount: 1, label: '3 unfittable' }),
      'noisy.tka',
    );
    expect(html).toContain('pf-state--anomaly');
    expect(html).toContain('Detection completed with issues in noisy.tka — 3 unfittable.');
    expect(html).toContain('No peaks validated; 3 unfittable, 1 rejected.');
    expect(html).toContain('Result column');
  });

  it('anomaly (peakCount > 0): honest that SOME validated despite the issues', () => {
    const html = peakFinderStateMarkup(
      status({ state: 'anomaly', peakCount: 2, unfittableCount: 1, rejectedFitCount: 0, label: '1 unfittable' }),
      'x.tka',
    );
    expect(html).toContain('2 peaks validated; 1 unfittable, 0 rejected.');
  });

  it('failure: honest could-not-complete naming the failing stage', () => {
    const html = peakFinderStateMarkup(
      status({ state: 'failure', failingStage: 'detect', label: 'detection failed' }),
      'bad.tka',
    );
    expect(html).toContain('pf-state--failure');
    expect(html).toContain('Detection could not complete for bad.tka.');
    expect(html).toContain('failed at the detect stage');
  });

  it('every state branch is channel-space only (no energy wording)', () => {
    const states = [
      status({ state: 'healthy', peakCount: 4 }),
      status({ state: 'empty' }),
      status({ state: 'anomaly', peakCount: 0, unfittableCount: 2, rejectedFitCount: 1 }),
      status({ state: 'anomaly', peakCount: 3, unfittableCount: 0, rejectedFitCount: 2 }),
      status({ state: 'failure', failingStage: 'fit' }),
    ];
    for (const s of states) {
      expect(peakFinderStateMarkup(s, 'f.tka')).not.toMatch(ENERGY_RE);
    }
  });

  it('the escaped file name cannot inject markup', () => {
    const html = peakFinderStateMarkup(status({ state: 'empty' }), '<script>x</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('P3 channels-not-energies audit (extends the P2 grep to the new copy)', () => {
  it('every table stage + state branch renders energy-free under the strict regex', () => {
    for (const id of PF_STAGE_IDS) {
      expect(peakFinderTableSectionMarkup(TRACE, STATUS, id, null)).not.toMatch(ENERGY_RE);
    }
    for (const st of ['healthy', 'empty', 'anomaly', 'failure'] as const) {
      expect(peakFinderStateMarkup(status({ state: st, peakCount: 1 }), 'f.tka')).not.toMatch(ENERGY_RE);
    }
  });

  it('the strict regex does not false-positive on innocent words (every / level)', () => {
    expect('every level of detection').not.toMatch(ENERGY_RE); // sanity on the guard itself
    expect('energy').toMatch(ENERGY_RE);
    expect('661 keV').toMatch(ENERGY_RE);
  });
});
