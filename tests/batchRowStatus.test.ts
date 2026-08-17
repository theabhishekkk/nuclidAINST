import { describe, it, expect } from 'vitest';
import { batchRowMarkup } from '../src/ui/app';
import { deriveSpectrumStatus } from '../src/pipeline/spectrumStatus';
import type { ManagedSource } from '../src/ui/calibrationManager';
import type {
  AnalysisReport,
  DetectedPeak,
  FittedPeak,
  Spectrum,
  StageTrace,
  ValidatedPeak,
} from '../src/domain/types';

/**
 * Peak Pipeline Inspector -- Phase 2: the card consumes the signal contract.
 *
 * Asserts the contract->card mapping on `batchRowMarkup` (identity mode): each
 * of the four states emits its `br-status--{state}` class and `status.label`
 * text; the displayed count preserves card parity with `s.fittedPeaks.length`;
 * the summary count reads `status.peakCount`; the `.br-inspect` button is
 * retained unchanged; and the status element is passive (a span -- no button,
 * no tabindex, no role, no handler attribute).
 *
 * Test seam: `batchRowMarkup` is exported for tests only, the same seam the
 * repo already uses for `selectLibraryRows` (calibrationLibraryView.test.ts).
 */

// --- minimal engine-shaped factories (mirrors spectrumStatus.test.ts) ----------

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

/** A ManagedSource as the manager builds it: fittedPeaks = valid validated peaks. */
function managedSource(report: AnalysisReport): ManagedSource {
  const fittedPeaks = (report.validatedPeaks ?? [])
    .filter((v) => v.valid)
    .map((v) => v.peak);
  return {
    rowId: 'row-1',
    fileName: report.spectrum.metadata.fileName,
    sourceId: '',
    suggestedId: '',
    fittedPeaks,
    // Phase 2: the manager initialises one unassigned decision per fitted peak.
    assignments: fittedPeaks.map((p, i) => ({
      peakId: `row-1:${i}`,
      centroidChannel: p.centroidChannel,
      centroidError: p.centroidError,
      state: 'unassigned' as const,
    })),
    counts: report.spectrum.counts,
    channelCount: report.spectrum.counts.length,
    report,
  };
}

/** The status span the identity row renders (class + inner text). */
function statusSpanOf(html: string): { classes: string; text: string; tag: string } {
  const m = html.match(
    /<span class="(br-peaks br-status br-status--[a-z]+)"[^>]*>([^<]*)<\/span>/,
  );
  expect(m, 'status span present').not.toBeNull();
  return { classes: m![1], text: m![2], tag: m![0] };
}

// --- 1. four states render correctly --------------------------------------------

describe('batchRowMarkup -- contract->card mapping (identity mode)', () => {
  it('healthy -> br-status--healthy with "N peaks"', () => {
    const html = batchRowMarkup(managedSource(healthyReport(2)));
    const span = statusSpanOf(html);
    expect(span.classes).toBe('br-peaks br-status br-status--healthy');
    expect(span.text).toBe('2 peaks');
  });

  it('anomaly (unfittable) -> br-status--anomaly with "K unfittable"', () => {
    const base = healthyReport(1);
    const report = makeReport({
      ...base,
      detectedCandidates: [...base.detectedCandidates, detectedPeak({ channel: 55 })],
      unfittable: [{ detectedChannel: 55, reason: 'no-convergence' }],
    });
    const span = statusSpanOf(batchRowMarkup(managedSource(report)));
    expect(span.classes).toContain('br-status--anomaly');
    expect(span.text).toBe('1 unfittable');
  });

  it('anomaly (all kept fits invalidated) -> "0 valid peaks"', () => {
    const weak = fittedPeak({ classification: 'weak' });
    const report = makeReport({
      detectedCandidates: [detectedPeak()],
      peaks: [weak],
      allFitted: [weak],
      unfittable: [],
      validatedPeaks: [validVerdict(weak, false)],
    });
    const span = statusSpanOf(batchRowMarkup(managedSource(report)));
    expect(span.classes).toContain('br-status--anomaly');
    expect(span.text).toBe('0 valid peaks');
  });

  it('empty -> br-status--empty with "0 peaks"', () => {
    const span = statusSpanOf(batchRowMarkup(managedSource(makeReport({ validatedPeaks: [] }))));
    expect(span.classes).toContain('br-status--empty');
    expect(span.text).toBe('0 peaks');
  });

  it('failure -> br-status--failure with "Detection failed"', () => {
    const report = makeReport({
      validatedPeaks: [],
      trace: [
        { stage: 'load', status: 'ok', note: '', durationMs: 0 },
        { stage: 'detect', status: 'error', note: 'boom', durationMs: 0 },
      ],
    });
    const span = statusSpanOf(batchRowMarkup(managedSource(report)));
    expect(span.classes).toContain('br-status--failure');
    expect(span.text).toBe('Detection failed');
  });
});

// --- 2. card parity + summary reads the contract ---------------------------------

describe('batchRowMarkup -- single source of truth', () => {
  it('displayed count preserves card parity with s.fittedPeaks.length', () => {
    const report = healthyReport(3);
    const s = managedSource(report);
    const html = batchRowMarkup(s);
    // Same number the pre-Phase-2 card showed (s.fittedPeaks.length), same as
    // the contract's peakCount -- no visible regression.
    expect(deriveSpectrumStatus(report).peakCount).toBe(s.fittedPeaks.length);
    expect(statusSpanOf(html).text).toBe(`${s.fittedPeaks.length} peaks`);
  });

  it('the .br-summary count reads status.peakCount, not a second source', () => {
    // 2 kept fits, only 1 valid: summary must show the contract's count (1).
    const peaks = [fittedPeak(), fittedPeak({ detectedChannel: 40 })];
    const report = makeReport({
      detectedCandidates: peaks.map((p) => detectedPeak({ channel: p.detectedChannel })),
      peaks,
      allFitted: peaks,
      unfittable: [],
      validatedPeaks: [validVerdict(peaks[0]), validVerdict(peaks[1], false)],
    });
    const html = batchRowMarkup(managedSource(report));
    expect(html).toContain('local maxima &rarr; 1 peaks');
  });
});

// --- 3. inspect button retained · 4. status is passive ---------------------------

describe('batchRowMarkup -- Phase 2 invariants', () => {
  it('Phase 5 cutover: cards are STATUS-ONLY -- no inspect button, no per-row mount', () => {
    const html = batchRowMarkup(managedSource(healthyReport(1)));
    expect(html).not.toContain('br-inspect');
    expect(html).not.toContain('How were these found?');
    expect(html).not.toContain('inspector-mount');
    // The card keeps exactly: filename, identity select, passive status, QC, summary.
    expect(html).toContain('br-file');
    expect(html).toContain('br-identity');
    expect(html).toContain('br-status');
    expect(html).toContain('br-expand');
    expect(html).toContain('br-summary');
  });

  it('the status element is passive: a span, no interactive attributes', () => {
    const html = batchRowMarkup(managedSource(healthyReport(1)));
    const span = statusSpanOf(html);
    expect(span.tag.startsWith('<span')).toBe(true);
    expect(span.tag).not.toContain('tabindex');
    expect(span.tag).not.toContain('role=');
    expect(span.tag).not.toContain('onclick');
    // No button carries the status classes.
    expect(html).not.toMatch(/<button[^>]*br-status/);
  });
});
