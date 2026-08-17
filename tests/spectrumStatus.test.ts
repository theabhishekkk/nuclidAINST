import { describe, it, expect } from 'vitest';
import { deriveSpectrumStatus, isInspectable } from '../src/pipeline/spectrumStatus';
import { analyze } from '../src/pipeline/orchestrator';
import { validPeaks } from '../src/pipeline/validate';
import type {
  AnalysisReport,
  DetectedPeak,
  FittedPeak,
  Spectrum,
  StageTrace,
  UnfittableSurvivor,
  ValidatedPeak,
} from '../src/domain/types';

import Cs137 from './fixtures/reference/Cs-137.json';

/**
 * Peak Pipeline Inspector -- Phase 1: the signal contract (incl. the ratified
 * 2026-07-03 addendum: all-invalidated kept fits are an anomaly, "0 valid
 * peaks"; empty is reserved for no-survivors-and-no-kept-fits).
 *
 * Unit-tests `deriveSpectrumStatus` / `isInspectable` against hand-built minimal
 * reports covering all four states, the empty-vs-anomaly boundary, the peakCount
 * card alignment (valid validated peaks), back-compat with legacy reports, and
 * purity; plus one real-pipeline grounding test (Cs-137 fixture) proving the
 * contract's peakCount equals the count the batch card renders today.
 */

// --- minimal report factories (synthetic; engine-shaped, not engine-produced) ---

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

function makeReport(over: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    spectrum: spectrumOf(),
    conditioned: null,
    detectedCandidates: [],
    peaks: [],
    calibration: null,
    identifications: [],
    activities: [],
    trace: OK_STAGES,
    ...over,
  };
}

/** A fully-consistent healthy report: N kept fits, all valid, N survivors. */
function healthyReport(n: number): AnalysisReport {
  const peaks = Array.from({ length: n }, (_, i) =>
    fittedPeak({ detectedChannel: 20 + i * 10, centroidChannel: 20.2 + i * 10 }),
  );
  return makeReport({
    detectedCandidates: peaks.map((p) => detectedPeak({ channel: p.detectedChannel })),
    peaks,
    allFitted: peaks,
    unfittable: [],
    validatedPeaks: peaks.map((p) => validVerdict(p)),
  });
}

// --- isInspectable ------------------------------------------------------------

describe('isInspectable', () => {
  it('is false for null / undefined (not yet analyzed)', () => {
    expect(isInspectable(null)).toBe(false);
    expect(isInspectable(undefined)).toBe(false);
  });

  it('is true for any report -- even an all-failed one (evidence of where it failed)', () => {
    expect(isInspectable(makeReport())).toBe(true);
    const failed = makeReport({
      trace: [{ stage: 'detect', status: 'error', note: 'boom', durationMs: 0 }],
    });
    expect(isInspectable(failed)).toBe(true);
  });
});

// --- deriveSpectrumStatus -- the four states -----------------------------------

describe('deriveSpectrumStatus -- healthy', () => {
  it('kept valid peaks, nothing rejected/unfittable, no error -> healthy "N peaks"', () => {
    const status = deriveSpectrumStatus(healthyReport(3));
    expect(status).toEqual({
      state: 'healthy',
      peakCount: 3,
      unfittableCount: 0,
      rejectedFitCount: 0,
      failingStage: null,
      label: '3 peaks',
    });
  });

  it('peakCount follows the card semantics: valid validated peaks, not kept fits', () => {
    const peaks = [
      fittedPeak(),
      fittedPeak({ detectedChannel: 40 }),
      fittedPeak({ detectedChannel: 50 }),
    ];
    const report = makeReport({
      detectedCandidates: peaks.map((p) => detectedPeak({ channel: p.detectedChannel })),
      peaks,
      allFitted: peaks,
      unfittable: [],
      // 3 kept fits, but only 2 pass the validate gate -- the card shows 2.
      validatedPeaks: [
        validVerdict(peaks[0]),
        validVerdict(peaks[1]),
        validVerdict(peaks[2], false),
      ],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.peakCount).toBe(2);
    expect(status.label).toBe('2 peaks');
    expect(status.state).toBe('healthy');
  });
});

describe('deriveSpectrumStatus -- anomaly', () => {
  it('unfittable survivors -> anomaly "K unfittable", even alongside kept peaks', () => {
    const base = healthyReport(2);
    const unfittable: readonly UnfittableSurvivor[] = [
      { detectedChannel: 55, reason: 'no-convergence' },
      { detectedChannel: 58, reason: 'degenerate' },
      { detectedChannel: 61, reason: 'too-few-points' },
    ];
    const report = makeReport({
      ...base,
      detectedCandidates: [
        ...base.detectedCandidates,
        ...unfittable.map((u) => detectedPeak({ channel: u.detectedChannel })),
      ],
      unfittable,
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('3 unfittable');
    expect(status.unfittableCount).toBe(3);
    expect(status.peakCount).toBe(2); // coexists with valid peaks
    expect(status.failingStage).toBeNull();
  });

  it('a rejected fit (unfittable empty) -> anomaly "K rejected"', () => {
    const kept = fittedPeak();
    const rejected = fittedPeak({
      detectedChannel: 45,
      status: 'rejected',
      rejectReason: 'peak-hop',
      chiSquare: null,
    });
    const report = makeReport({
      detectedCandidates: [detectedPeak(), detectedPeak({ channel: 45 })],
      peaks: [kept],
      allFitted: [kept, rejected],
      unfittable: [],
      validatedPeaks: [validVerdict(kept)],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('1 rejected');
    expect(status.rejectedFitCount).toBe(1);
  });

  it('label favors unfittable (the dominant signal) when both are present', () => {
    const base = healthyReport(1);
    const rejected = fittedPeak({
      detectedChannel: 45,
      status: 'rejected',
      rejectReason: 'edge',
      chiSquare: null,
    });
    const report = makeReport({
      ...base,
      allFitted: [...(base.allFitted ?? []), rejected],
      unfittable: [{ detectedChannel: 55, reason: 'error' }],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('1 unfittable');
    expect(status.rejectedFitCount).toBe(1);
    expect(status.unfittableCount).toBe(1);
  });

  it('flagged boundary: survivors found but ALL discarded -> anomaly, not empty', () => {
    const report = makeReport({
      detectedCandidates: [detectedPeak(), detectedPeak({ channel: 45 })],
      peaks: [],
      allFitted: [],
      unfittable: [
        { detectedChannel: 30, reason: 'no-convergence' },
        { detectedChannel: 45, reason: 'non-physical' },
      ],
      validatedPeaks: [],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('2 unfittable');
    expect(status.peakCount).toBe(0);
  });

  it('addendum: kept fits ALL invalidated by the validate gate -> anomaly "0 valid peaks"', () => {
    // Structure was found and fitted; none of it passed the quality gate. The
    // ratified 2026-07-03 addendum classifies this as anomaly, not empty.
    const weak = fittedPeak({ classification: 'weak' });
    const report = makeReport({
      detectedCandidates: [detectedPeak()],
      peaks: [weak],
      allFitted: [weak],
      unfittable: [],
      validatedPeaks: [validVerdict(weak, false)],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('0 valid peaks');
    expect(status.peakCount).toBe(0);
    expect(status.unfittableCount).toBe(0);
    expect(status.rejectedFitCount).toBe(0);
    expect(status.failingStage).toBeNull();
  });

  it('addendum: a dominant signal still outranks the "0 valid peaks" label', () => {
    // All-invalidated AND an unfittable survivor: the label favors unfittable.
    const weak = fittedPeak({ classification: 'weak' });
    const report = makeReport({
      detectedCandidates: [detectedPeak(), detectedPeak({ channel: 55 })],
      peaks: [weak],
      allFitted: [weak],
      unfittable: [{ detectedChannel: 55, reason: 'degenerate' }],
      validatedPeaks: [validVerdict(weak, false)],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('anomaly');
    expect(status.label).toBe('1 unfittable');
    expect(status.peakCount).toBe(0);
  });
});

describe('deriveSpectrumStatus -- empty', () => {
  it('no survivors and no kept fits, no error -> empty "0 peaks"', () => {
    const status = deriveSpectrumStatus(makeReport());
    expect(status).toEqual({
      state: 'empty',
      peakCount: 0,
      unfittableCount: 0,
      rejectedFitCount: 0,
      failingStage: null,
      label: '0 peaks',
    });
  });

  it('defensive rung: a partition-violating report still lands on empty, never misreports', () => {
    // Provably unreachable through the real survivor partition (survivors =
    // kept ∪ rejected-with-line ∪ unfittable): survivors exist but no fit
    // landed in ANY bucket. Constructible only synthetically; the guard pins
    // the fallback so a malformed report can never crash or mislabel.
    const report = makeReport({
      detectedCandidates: [detectedPeak()],
      peaks: [],
      allFitted: [],
      unfittable: [],
      validatedPeaks: [],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('empty');
    expect(status.label).toBe('0 peaks');
  });
});

describe('deriveSpectrumStatus -- failure', () => {
  it('an errored peak stage -> failure with that stage and its label', () => {
    const cases: readonly { stage: StageTrace['stage']; label: string }[] = [
      { stage: 'condition', label: 'Conditioning failed' },
      { stage: 'detect', label: 'Detection failed' },
      { stage: 'fit', label: 'Fit failed' },
      { stage: 'validate', label: 'Validation failed' },
    ];
    for (const c of cases) {
      const report = makeReport({
        trace: [
          { stage: 'load', status: 'ok', note: '', durationMs: 0 },
          { stage: c.stage, status: 'error', note: 'boom', durationMs: 0 },
        ],
      });
      const status = deriveSpectrumStatus(report);
      expect(status.state).toBe('failure');
      expect(status.failingStage).toBe(c.stage);
      expect(status.label).toBe(c.label);
    }
  });

  it('failure wins over everything else present on the report', () => {
    const base = healthyReport(2);
    const report = makeReport({
      ...base,
      trace: [
        { stage: 'load', status: 'ok', note: '', durationMs: 0 },
        { stage: 'condition', status: 'ok', note: '', durationMs: 0 },
        { stage: 'detect', status: 'ok', note: '', durationMs: 0 },
        { stage: 'fit', status: 'error', note: 'boom', durationMs: 0 },
      ],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('failure');
    expect(status.failingStage).toBe('fit');
    expect(status.label).toBe('Fit failed');
    // Counts are still derived (the inspector can still show partial evidence).
    expect(status.peakCount).toBe(2);
  });

  it('a downstream (identify/calibrate/quantify) error is NOT a failure', () => {
    const base = healthyReport(2);
    const report = makeReport({
      ...base,
      trace: [
        ...OK_STAGES,
        { stage: 'calibrate', status: 'error', note: 'boom', durationMs: 0 },
        { stage: 'identify', status: 'error', note: 'boom', durationMs: 0 },
      ],
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('healthy');
    expect(status.failingStage).toBeNull();
    expect(status.label).toBe('2 peaks');
  });
});

// --- back-compat + purity -------------------------------------------------------

describe('deriveSpectrumStatus -- back-compat (additive fields absent)', () => {
  it('a legacy report missing unfittable/allFitted/validatedPeaks never throws', () => {
    const peaks = [fittedPeak(), fittedPeak({ detectedChannel: 40 })];
    // Keys ABSENT (not undefined), respecting exactOptionalPropertyTypes.
    const report = makeReport({
      detectedCandidates: peaks.map((p) => detectedPeak({ channel: p.detectedChannel })),
      peaks,
    });
    const status = deriveSpectrumStatus(report);
    expect(status.state).toBe('healthy');
    // No validatedPeaks -> falls back to kept fits, the best available count.
    // The fallback also makes the all-invalidated anomaly clause a no-op
    // (peakCount === keptFits), so a legacy report can never trip it.
    expect(status.peakCount).toBe(2);
    expect(status.unfittableCount).toBe(0);
    expect(status.rejectedFitCount).toBe(0);
    expect(status.label).toBe('2 peaks');
  });
});

describe('deriveSpectrumStatus -- purity', () => {
  it('does not mutate the report and is idempotent', () => {
    const base = healthyReport(2);
    const report = makeReport({
      ...base,
      unfittable: [{ detectedChannel: 55, reason: 'degenerate' }],
    });
    const before = structuredClone(report);
    const first = deriveSpectrumStatus(report);
    const second = deriveSpectrumStatus(report);
    expect(report).toEqual(before); // deep-equal: untouched
    expect(second).toEqual(first); // identical output on repeat calls
  });
});

// --- real-pipeline grounding (card parity) --------------------------------------

interface Fixture {
  source: string;
  counts: number[];
  peaks: number[];
}

describe('deriveSpectrumStatus -- real fixture (Cs-137) card parity', () => {
  it('peakCount equals the count the batch card renders (valid validated peaks)', () => {
    const f = Cs137 as unknown as Fixture;
    const report = analyze({
      text: [1800, 1835, ...f.counts].join('\n'),
      fileName: 'Cs-137.TKA',
    });
    expect(isInspectable(report)).toBe(true);
    const status = deriveSpectrumStatus(report);

    // Card parity: ManagedSource.fittedPeaks = validPeaks(report.validatedPeaks).
    expect(report.validatedPeaks).toBeDefined();
    expect(status.peakCount).toBe(validPeaks(report.validatedPeaks!).length);

    // Cs-137 carries the known ch117 peak-hop rejection -> anomaly, not healthy.
    expect(status.rejectedFitCount).toBeGreaterThan(0);
    expect(status.state).toBe('anomaly');
    expect(status.failingStage).toBeNull();
  });
});
