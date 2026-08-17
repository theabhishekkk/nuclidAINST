import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Spectrum } from '../src/domain/types';
import { createBatchManager } from '../src/batch/batchManager';
import { DEFAULT_PEAK_FINDER_CONFIG } from '../src/pipeline/peakFinderConfig';
import { load } from '../src/pipeline/load';
import { syntheticTka } from '../src/data/synthetic';

/**
 * Phase 3 core: the stateful BatchManager worker loop. `start()` drains the `queued` entries one
 * at a time through the pure runner, yielding between files via a 0ms timer (fake-timed here).
 * These tests pin: the loop processes to settled + notifies subscribers, fail-loud isolation,
 * pause/resume holds the queue, retry re-queues, exclude removes from processing, and a
 * quarantined import lands `failed` without being processed.
 */
function goodSpectrum(fileName: string): Spectrum {
  return load({ text: syntheticTka(), fileName });
}

function tinySpectrum(fileName: string): Spectrum {
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

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('BatchManager -- worker loop', () => {
  it('drains the queue to settled and notifies subscribers', () => {
    const mgr = createBatchManager();
    let notifications = 0;
    mgr.subscribe(() => notifications++);

    mgr.addSpectrum(goodSpectrum('a.tka'));
    mgr.addSpectrum(goodSpectrum('b.tka'));
    mgr.addSpectrum(goodSpectrum('c.tka'));
    expect(mgr.phase).toBe('processing'); // queued entries present

    mgr.start();
    vi.runAllTimers();

    expect(mgr.phase).toBe('settled');
    const s = mgr.summary();
    expect(s.done + s.warning).toBe(3);
    expect(s.queued).toBe(0);
    expect(notifications).toBeGreaterThan(0);
  });

  it('isolates a faulting entry as failed and still processes the rest', () => {
    const mgr = createBatchManager();
    mgr.addSpectrum(goodSpectrum('a.tka'));
    const badId = mgr.addSpectrum(tinySpectrum('bad.tka'));
    mgr.setOverride(badId, { ...DEFAULT_PEAK_FINDER_CONFIG, continuum: { input: 'smoothed' } });
    mgr.addSpectrum(goodSpectrum('c.tka'));

    mgr.start();
    vi.runAllTimers();

    const bad = mgr.entries.find((e) => e.id === badId)!;
    expect(bad.status).toBe('failed');
    expect(bad.error).not.toBeNull();
    const s = mgr.summary();
    expect(s.failed).toBe(1);
    expect(s.done + s.warning).toBe(2);
    expect(mgr.phase).toBe('settled');
  });
});

describe('BatchManager -- pause / resume', () => {
  it('pause holds the remaining queue; resume drains it', () => {
    const mgr = createBatchManager();
    mgr.addSpectrum(goodSpectrum('a.tka'));
    mgr.addSpectrum(goodSpectrum('b.tka'));
    mgr.addSpectrum(goodSpectrum('c.tka'));

    mgr.start();
    vi.advanceTimersToNextTimer(); // process exactly one entry
    mgr.pause();
    vi.runAllTimers(); // a paused loop must NOT process further

    const afterPause = mgr.summary();
    expect(afterPause.done + afterPause.warning).toBe(1);
    expect(afterPause.queued).toBe(2);
    expect(mgr.phase).toBe('processing'); // still unsettled

    mgr.resume();
    vi.runAllTimers();
    expect(mgr.phase).toBe('settled');
    expect(mgr.summary().queued).toBe(0);
  });
});

describe('BatchManager -- row actions', () => {
  it('retry re-queues a failed entry and reprocesses it', () => {
    const mgr = createBatchManager();
    const badId = mgr.addSpectrum(tinySpectrum('bad.tka'));
    mgr.setOverride(badId, { ...DEFAULT_PEAK_FINDER_CONFIG, continuum: { input: 'smoothed' } });
    mgr.start();
    vi.runAllTimers();
    expect(mgr.entries[0].status).toBe('failed');

    // Switch to a fully SG-free override -- raw input AND plain net (the smoothed defaults both
    // over-smooth this pathologically tiny fixture and throw), then retry -> now processable.
    mgr.setOverride(badId, {
      ...DEFAULT_PEAK_FINDER_CONFIG,
      continuum: { input: 'raw' },
      detection: { ...DEFAULT_PEAK_FINDER_CONFIG.detection, netInput: 'net' },
    });
    vi.runAllTimers();
    expect(['done', 'warning']).toContain(mgr.entries[0].status);
  });

  it('exclude keeps an entry out of processing', () => {
    const mgr = createBatchManager();
    const id = mgr.addSpectrum(goodSpectrum('a.tka'));
    mgr.exclude(id);
    mgr.start();
    vi.runAllTimers();
    expect(mgr.entries[0].status).toBe('excluded');
    expect(mgr.entries[0].result).toBeNull();
    expect(mgr.phase).toBe('settled');
  });

  it('a quarantined import lands failed without being processed', () => {
    const mgr = createBatchManager();
    mgr.addImportFailure('corrupt.tka', 'unreadable');
    mgr.start();
    vi.runAllTimers();
    const entry = mgr.entries[0];
    expect(entry.status).toBe('failed');
    expect(entry.error?.message).toBe('unreadable');
    expect(entry.result).toBeNull();
  });
});
