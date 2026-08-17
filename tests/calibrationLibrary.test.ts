import { describe, it, expect } from 'vitest';

import {
  createCalibrationStore,
  CALIBRATION_STORE_KEY,
  type StorageBackend,
  type CalibrationStore,
} from '../src/data/calibrationStore';
import { createCalibrationLibrary } from '../src/ui/calibrationLibrary';
import type { CalibrationResult } from '../src/domain/types';

/**
 * CalibrationLibrary tests -- exercised through an in-memory store (no
 * localStorage), mirroring tests/calibrationStore.test.ts. Covers:
 *   1. Seed: the cache reflects the store on construction.
 *   2. save -> refresh(): the new (active) record surfaces to the cache.
 *   3. activate(): flips activeId + emits.
 *   4. remove(): updates the cache + emits; removing the active clears it.
 *   5. getActive() is LIVE: reflects a store.setActive made without refresh(),
 *      while the cached activeId stays stale until refresh().
 *   6. Fail-loud read: a corrupt store sets `error`, preserves the last-good
 *      snapshot (does not wipe), and a later clean read clears `error`.
 *   7. unsubscribe stops notifications.
 */

// --- in-memory fake backend (same shape as the store test) ------------------
class MemoryBackend implements StorageBackend {
  readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

// --- a minimal, JSON-safe CalibrationResult fixture -------------------------
function makeResult(seed = 0): CalibrationResult {
  const c0 = -5.4 + seed;
  const linear = {
    model: 'linear' as const,
    coefficients: [c0, 1.108],
    points: [
      {
        channel: 59.2,
        energyKeV: 59.541,
        sourceLabel: 'Am-241 59.5 keV',
        centroidError: 0.03,
        sourceId: 'Am-241',
        tier: 'anchor' as const,
        reliable: true,
        used: true,
        note: 'anchor',
      },
      {
        channel: 1203.4,
        energyKeV: 1332.492,
        sourceLabel: 'Co-60 1332 keV',
        centroidError: 0.05,
        sourceId: 'Co-60',
        tier: 'anchor' as const,
        reliable: true,
        used: true,
        note: 'anchor',
      },
    ],
    rSquared: 0.9998,
    covariance: [
      [0.04, -1e-5],
      [-1e-5, 2e-7],
    ],
    rms: 0.42,
    maxAbsResidual: 0.81,
    validRange: [59.541, 1332.492] as [number, number],
  };
  return {
    linear,
    quadratic: null,
    selected: 'linear',
    policy: 'linear',
    selectionFellBack: false,
    curvatureSignificance: 0,
  } as unknown as CalibrationResult;
}

/** A store seeded with `n` saved calibrations over a fresh in-memory backend. */
function seededStore(n: number): { store: CalibrationStore; backend: MemoryBackend } {
  const backend = new MemoryBackend();
  const store = createCalibrationStore(backend);
  for (let i = 0; i < n; i++) {
    store.save({ name: `cal-${i}`, sources: [`S-${i}`], result: makeResult(i) });
  }
  return { store, backend };
}

describe('calibrationLibrary (saved-calibrations coordinator)', () => {
  it('seeds the cache from the store on construction', () => {
    const { store } = seededStore(2);
    const lib = createCalibrationLibrary(store);

    expect(lib.items).toHaveLength(2);
    expect(lib.items.map((r) => r.name)).toEqual(['cal-1', 'cal-0']); // newest-first
    // first save became active.
    expect(lib.activeId).toBe(lib.items[1].id);
    expect(lib.error).toBeNull();
  });

  it('save -> refresh() surfaces the new active record to the cache', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);
    const lib = createCalibrationLibrary(store); // empty
    expect(lib.items).toHaveLength(0);
    expect(lib.activeId).toBeNull();

    let notified = 0;
    lib.subscribe(() => notified++);

    // app save handler does: store.save (+ setActive inside manager.save) then library.refresh()
    const rec = store.save({ name: 'fresh', sources: ['Cs-137'], result: makeResult(7) });
    store.setActive(rec.id); // mirrors CalibrationManager.save
    lib.refresh();

    expect(notified).toBe(1);
    expect(lib.items).toHaveLength(1);
    expect(lib.items[0].id).toBe(rec.id);
    expect(lib.activeId).toBe(rec.id);
  });

  it('activate() flips activeId and emits', () => {
    const { store } = seededStore(2);
    const lib = createCalibrationLibrary(store);
    const [newer, older] = lib.items; // newest-first; older is active (first saved)
    expect(lib.activeId).toBe(older.id);

    let notified = 0;
    lib.subscribe(() => notified++);

    lib.activate(newer.id);
    expect(lib.activeId).toBe(newer.id);
    expect(notified).toBe(1);

    lib.activate(null);
    expect(lib.activeId).toBeNull();
    expect(notified).toBe(2);
  });

  it('remove() updates the cache and emits; removing the active clears it', () => {
    const { store } = seededStore(2);
    const lib = createCalibrationLibrary(store);
    const [newer, older] = lib.items;
    expect(lib.activeId).toBe(older.id); // older is active

    let notified = 0;
    lib.subscribe(() => notified++);

    // remove the non-active one: list shrinks, active intact.
    lib.remove(newer.id);
    expect(lib.items.map((r) => r.id)).toEqual([older.id]);
    expect(lib.activeId).toBe(older.id);
    expect(notified).toBe(1);

    // remove the active one: cleared (store clears active, no silent repoint).
    lib.remove(older.id);
    expect(lib.items).toHaveLength(0);
    expect(lib.activeId).toBeNull();
    expect(notified).toBe(2);
  });

  it('getActive() is LIVE -- reflects a store change made without refresh()', () => {
    const { store } = seededStore(2);
    const lib = createCalibrationLibrary(store);
    const [newer, older] = lib.items;
    expect(lib.activeId).toBe(older.id);

    // flip the active pointer directly on the store, bypassing the library.
    store.setActive(newer.id);

    // cached snapshot is stale (no refresh called)...
    expect(lib.activeId).toBe(older.id);
    // ...but the live read reflects the store immediately.
    expect(lib.getActive()?.id).toBe(newer.id);
  });

  it('fail-loud read sets error, preserves the last-good snapshot, and clears on a clean read', () => {
    const { store, backend } = seededStore(1);
    const lib = createCalibrationLibrary(store);
    expect(lib.items).toHaveLength(1);
    const goodPayload = backend.getItem(CALIBRATION_STORE_KEY) as string;
    const lastGood = lib.items;

    // corrupt the backing payload, then refresh: store.list() throws.
    backend.setItem(CALIBRATION_STORE_KEY, '{ not json');
    lib.refresh();

    expect(lib.error).toBeTruthy();
    expect(lib.items).toBe(lastGood); // render-don't-wipe: same snapshot reference
    expect(lib.items).toHaveLength(1);
    // the corrupt payload was not auto-reset by the library.
    expect(backend.getItem(CALIBRATION_STORE_KEY)).toBe('{ not json');

    // restore a clean store and refresh: error clears.
    backend.setItem(CALIBRATION_STORE_KEY, goodPayload);
    lib.refresh();
    expect(lib.error).toBeNull();
    expect(lib.items).toHaveLength(1);
  });

  it('never throws on construction over a corrupt store (captures error)', () => {
    const backend = new MemoryBackend();
    backend.setItem(CALIBRATION_STORE_KEY, '{ not json');
    const store = createCalibrationStore(backend);

    const lib = createCalibrationLibrary(store);
    expect(lib.error).toBeTruthy();
    expect(lib.items).toEqual([]);
    expect(lib.activeId).toBeNull();
  });

  it('unsubscribe stops notifications', () => {
    const { store } = seededStore(2);
    const lib = createCalibrationLibrary(store);

    let notified = 0;
    const unsub = lib.subscribe(() => notified++);

    lib.activate(lib.items[0].id);
    expect(notified).toBe(1);

    unsub();
    lib.activate(null);
    expect(notified).toBe(1); // no further notifications
  });
});
