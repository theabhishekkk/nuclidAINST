import { describe, it, expect } from 'vitest';

import type { Spectrum } from '../src/domain/types';
import {
  processEntry,
  makeBatchEntry,
  effectiveConfig,
  deriveWarnings,
  deriveMetrics,
  summarizeBatch,
  isSettled,
  batchPhase,
  FEW_PEAKS_THRESHOLD,
} from '../src/batch/batchRunner';
import type { BatchEntry, BatchEntryMetrics } from '../src/batch/batchTypes';
import { DEFAULT_PEAK_FINDER_CONFIG } from '../src/pipeline/peakFinderConfig';
import { deriveSpectrumStatus } from '../src/pipeline/spectrumStatus';
import { load } from '../src/pipeline/load';
import { syntheticTka } from '../src/data/synthetic';

/**
 * Phase 1: the pure batch runner. It processes each entry through the shared headless core
 * ({@link runPeakFinder}), so a batch result equals a drill-in result; a fault marks ONE entry
 * `failed` and never touches the rest. These tests pin: happy-path results, fail-loud isolation,
 * the Hybrid config rule, warning derivation (the provisional thresholds), and the aggregates.
 */
function goodSpectrum(fileName = 'demo.tka'): Spectrum {
  return load({ text: syntheticTka(), fileName });
}

/** A 3-channel spectrum: too short for the SG window (9), so a smoothed-input config throws. */
function tinySpectrum(fileName = 'tiny.tka'): Spectrum {
  return {
    counts: [10, 20, 30],
    metadata: {
      fileName,
      format: 'tka',
      liveTimeSec: null,
      realTimeSec: null,
      channelCount: 3,
      statedNuclideHint: null,
      fileSizeBytes: null,
      detector: null,
      sampleName: null,
      measurementDate: null,
    },
  };
}

const NEUTRAL_METRICS: BatchEntryMetrics = {
  validCount: 10,
  flaggedCount: 0,
  totalCounts: 5000,
  meanFwhmChannels: 10,
};

describe('processEntry -- happy path', () => {
  it('runs the shared core and settles a real spectrum to done/warning with a result', () => {
    const entry = makeBatchEntry('e1', goodSpectrum());
    const out = processEntry(entry, DEFAULT_PEAK_FINDER_CONFIG);

    expect(['done', 'warning']).toContain(out.status);
    expect(out.result).not.toBeNull();
    expect(out.error).toBeNull();
    // peakCount is the SpectrumStatus contract, not recomputed independently.
    expect(out.result!.peakCount).toBe(deriveSpectrumStatus(out.result!.report).peakCount);
  });
});

describe('processEntry -- fail-loud isolation', () => {
  it('marks a faulting entry failed and leaves its neighbours processed', () => {
    const bad = makeBatchEntry('bad', tinySpectrum());
    bad.configOverride = { ...DEFAULT_PEAK_FINDER_CONFIG, continuum: { input: 'smoothed' } };
    const entries: BatchEntry[] = [
      makeBatchEntry('a', goodSpectrum('a.tka')),
      bad,
      makeBatchEntry('b', goodSpectrum('b.tka')),
    ];

    const out = entries.map((e) => processEntry(e, DEFAULT_PEAK_FINDER_CONFIG));

    expect(out[1].status).toBe('failed');
    expect(out[1].error).not.toBeNull();
    expect(out[1].result).toBeNull();
    // the fault did not abort the batch -- both neighbours produced results
    expect(out[0].result).not.toBeNull();
    expect(out[2].result).not.toBeNull();
  });

  it('excluded and paused entries pass through untouched', () => {
    const excluded: BatchEntry = { ...makeBatchEntry('x', goodSpectrum()), status: 'excluded' };
    const paused: BatchEntry = { ...makeBatchEntry('p', goodSpectrum()), status: 'paused' };
    expect(processEntry(excluded, DEFAULT_PEAK_FINDER_CONFIG)).toBe(excluded);
    expect(processEntry(paused, DEFAULT_PEAK_FINDER_CONFIG)).toBe(paused);
  });
});

describe('effectiveConfig -- Hybrid inheritance', () => {
  it('an override wins; otherwise the batch default is inherited', () => {
    const base = makeBatchEntry('e', goodSpectrum());
    expect(effectiveConfig(base, DEFAULT_PEAK_FINDER_CONFIG)).toBe(DEFAULT_PEAK_FINDER_CONFIG);

    const override = { ...DEFAULT_PEAK_FINDER_CONFIG, continuum: { input: 'smoothed' as const } };
    const pinned: BatchEntry = { ...base, configOverride: override };
    expect(effectiveConfig(pinned, DEFAULT_PEAK_FINDER_CONFIG)).toBe(override);
  });
});

describe('deriveWarnings -- provisional thresholds (open Q4)', () => {
  it('0 peaks => no-peaks (never a failure)', () => {
    expect(deriveWarnings(0, NEUTRAL_METRICS)).toEqual(['no-peaks']);
  });
  it('below the few-peaks threshold => few-peaks', () => {
    expect(deriveWarnings(FEW_PEAKS_THRESHOLD - 1, NEUTRAL_METRICS)).toEqual(['few-peaks']);
  });
  it('low total counts => low-counts', () => {
    expect(deriveWarnings(10, { ...NEUTRAL_METRICS, totalCounts: 500 })).toEqual(['low-counts']);
  });
  it('wide mean FWHM => wide-fwhm', () => {
    expect(deriveWarnings(10, { ...NEUTRAL_METRICS, meanFwhmChannels: 80 })).toEqual(['wide-fwhm']);
  });
  it('a clean result has no warnings', () => {
    expect(deriveWarnings(10, NEUTRAL_METRICS)).toEqual([]);
  });
});

describe('deriveMetrics -- read off the report, no recompute', () => {
  it('sums total counts and counts valid/flagged validated peaks', () => {
    const report = processEntry(makeBatchEntry('e', goodSpectrum()), DEFAULT_PEAK_FINDER_CONFIG)
      .result!.report;
    const m = deriveMetrics(report);
    expect(m.totalCounts).toBe(report.spectrum.counts.reduce((a, b) => a + b, 0));
    expect(m.validCount + m.flaggedCount).toBe((report.validatedPeaks ?? []).length);
  });
});

describe('aggregates -- summarizeBatch / isSettled / batchPhase', () => {
  const withStatus = (id: string, status: BatchEntry['status'], peakCount = 0): BatchEntry => ({
    ...makeBatchEntry(id, tinySpectrum(`${id}.tka`)),
    status,
    result:
      status === 'done' || status === 'warning'
        ? { report: {} as never, peakCount, warnings: [], metrics: NEUTRAL_METRICS }
        : null,
  });

  it('summarizeBatch counts states and sums kept peaks', () => {
    const entries = [
      withStatus('a', 'done', 5),
      withStatus('b', 'warning', 3),
      withStatus('c', 'failed'),
      withStatus('d', 'excluded'),
      withStatus('e', 'queued'),
    ];
    const s = summarizeBatch(entries);
    expect(s.total).toBe(5);
    expect(s.done).toBe(1);
    expect(s.warning).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.excluded).toBe(1);
    expect(s.queued).toBe(1);
    expect(s.kept).toBe(2); // done + warning
    expect(s.totalPeaks).toBe(8); // 5 + 3
  });

  it('isSettled/batchPhase: unsettled while queued/running/paused, settled otherwise', () => {
    expect(isSettled([withStatus('a', 'done'), withStatus('b', 'queued')])).toBe(false);
    expect(isSettled([withStatus('a', 'done'), withStatus('b', 'failed')])).toBe(true);
    expect(batchPhase([])).toBe('importing');
    expect(batchPhase([withStatus('a', 'running')])).toBe('processing');
    expect(batchPhase([withStatus('a', 'done'), withStatus('b', 'excluded')])).toBe('settled');
  });
});
