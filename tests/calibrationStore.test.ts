import { describe, it, expect } from 'vitest';

import {
  createCalibrationStore,
  CALIBRATION_STORE_KEY,
  type StorageBackend,
} from '../src/data/calibrationStore';
import { ValidationError } from '../src/domain/errors';
import type { CalibrationResult } from '../src/domain/types';

/**
 * C4 calibration-store tests -- exercised entirely through an in-memory fake
 * backend (no browser/localStorage needed). Covers:
 *   1. Round-trip: save -> load/list returns a record deep-equal to the input
 *      CalibrationResult (both equations, selected, policy, covariance, points).
 *   2. Active pointer: save-sets-active-iff-none; setActive/getActive; remove
 *      repoints/clears active; multiple coexist; ids unique.
 *   3. Fail-loud (RISK-04): corrupt string throws and does NOT wipe; empty store
 *      reads as {active:null,calibrations:[]}; unknown-id ops throw.
 *   4. Persistence survives a fresh store instance over the same backend (reload).
 */

// --- in-memory fake backend -------------------------------------------------
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

// --- a full, JSON-safe CalibrationResult fixture (both equations populated) --
function makeResult(seed = 0): CalibrationResult {
  const c0 = -5.4 + seed;
  return {
    linear: {
      model: 'linear',
      coefficients: [c0, 1.108],
      points: [
        {
          channel: 59.2,
          energyKeV: 59.541,
          sourceLabel: 'Am-241 59.5 keV',
          centroidError: 0.03,
          sourceId: 'Am-241',
          tier: 'anchor',
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
          tier: 'anchor',
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
      validRange: [59.541, 1332.492],
    },
    quadratic: {
      model: 'quadratic',
      coefficients: [c0 - 0.1, 1.1, 3.65e-5],
      points: [
        {
          channel: 59.2,
          energyKeV: 59.541,
          sourceLabel: 'Am-241 59.5 keV',
          centroidError: 0.03,
          used: true,
        },
        {
          channel: 596.3,
          energyKeV: 661.657,
          sourceLabel: 'Cs-137 661 keV',
          centroidError: 0.04,
          used: true,
        },
        {
          channel: 1203.4,
          energyKeV: 1332.492,
          sourceLabel: 'Co-60 1332 keV',
          centroidError: 0.05,
          used: true,
        },
      ],
      rSquared: 0.99995,
      covariance: [
        [0.05, -1e-5, 1e-9],
        [-1e-5, 3e-7, -2e-10],
        [1e-9, -2e-10, 5e-13],
      ],
      rms: 0.21,
      maxAbsResidual: 0.4,
      validRange: [59.541, 1332.492],
    },
    selected: 'quadratic',
    policy: 'auto',
    selectionFellBack: false,
    curvatureSignificance: 5.2,
  };
}

describe('calibrationStore (C4 persistence)', () => {
  it('round-trips a CalibrationResult verbatim through save -> load/list', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);
    const result = makeResult();

    const saved = store.save({ name: 'Lab run A', sources: ['Am-241', 'Co-60'], result });

    expect(saved.id).toBeTruthy();
    expect(saved.name).toBe('Lab run A');
    expect(saved.created).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO-8601
    expect(saved.sources).toEqual(['Am-241', 'Co-60']);

    const loaded = store.load(saved.id);
    expect(loaded).not.toBeNull();
    // deep-equal: both equations, selected, policy, covariance, points all survive.
    expect(loaded).toEqual(saved);
    expect(loaded?.result).toEqual(result);

    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(saved);
  });

  it('save sets active iff none is active; later saves keep the operator choice', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);

    expect(store.getActive()).toBeNull();

    const first = store.save({ name: 'first', sources: [], result: makeResult(0) });
    expect(store.getActive()?.id).toBe(first.id); // first save becomes active

    const second = store.save({ name: 'second', sources: [], result: makeResult(1) });
    expect(store.getActive()?.id).toBe(first.id); // unchanged -- not stolen
    expect(second.id).not.toBe(first.id); // ids unique
  });

  it('lists newest-first and lets multiple calibrations coexist', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);
    const a = store.save({ name: 'a', sources: [], result: makeResult(0) });
    const b = store.save({ name: 'b', sources: [], result: makeResult(1) });
    const c = store.save({ name: 'c', sources: [], result: makeResult(2) });

    const ids = store.list().map((r) => r.id);
    expect(ids).toEqual([c.id, b.id, a.id]); // newest-first
    expect(new Set(ids).size).toBe(3); // all unique
  });

  it('setActive / getActive flip the pointer (metadata only)', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);
    const a = store.save({ name: 'a', sources: [], result: makeResult(0) });
    const b = store.save({ name: 'b', sources: [], result: makeResult(1) });

    store.setActive(b.id);
    expect(store.getActive()?.id).toBe(b.id);

    store.setActive(null);
    expect(store.getActive()).toBeNull();

    store.setActive(a.id);
    expect(store.getActive()?.id).toBe(a.id);
  });

  it('remove deletes and clears active when the removed record was active', () => {
    const backend = new MemoryBackend();
    const store = createCalibrationStore(backend);
    const a = store.save({ name: 'a', sources: [], result: makeResult(0) }); // active
    const b = store.save({ name: 'b', sources: [], result: makeResult(1) });

    // removing a non-active record leaves active intact.
    store.remove(b.id);
    expect(store.load(b.id)).toBeNull();
    expect(store.getActive()?.id).toBe(a.id);

    // removing the active record clears active (no silent repoint).
    store.remove(a.id);
    expect(store.load(a.id)).toBeNull();
    expect(store.getActive()).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('reads an empty store as {active:null,calibrations:[]}', () => {
    const store = createCalibrationStore(new MemoryBackend());
    expect(store.list()).toEqual([]);
    expect(store.getActive()).toBeNull();
    expect(store.load('nope')).toBeNull();
  });

  it('fails loud on unknown-id setActive / remove', () => {
    const store = createCalibrationStore(new MemoryBackend());
    store.save({ name: 'a', sources: [], result: makeResult(0) });
    expect(() => store.setActive('does-not-exist')).toThrow(ValidationError);
    expect(() => store.remove('does-not-exist')).toThrow(ValidationError);
  });

  it('fails loud on a corrupt store and does NOT wipe it (RISK-04)', () => {
    const backend = new MemoryBackend();
    backend.setItem(CALIBRATION_STORE_KEY, '{ this is not json');
    const store = createCalibrationStore(backend);

    expect(() => store.list()).toThrow(ValidationError);
    // the corrupt payload is preserved, not auto-reset.
    expect(backend.getItem(CALIBRATION_STORE_KEY)).toBe('{ this is not json');
  });

  it('fails loud on a structurally wrong store (valid JSON, bad shape)', () => {
    const backend = new MemoryBackend();
    backend.setItem(CALIBRATION_STORE_KEY, JSON.stringify({ active: null, calibrations: 'oops' }));
    expect(() => createCalibrationStore(backend).list()).toThrow(ValidationError);

    const backend2 = new MemoryBackend();
    backend2.setItem(
      CALIBRATION_STORE_KEY,
      JSON.stringify({ active: null, calibrations: [{ id: 'x', name: 'y', created: 'z', sources: [] }] }),
    );
    // record missing result.linear / selected -> throws.
    expect(() => createCalibrationStore(backend2).list()).toThrow(ValidationError);
  });

  it('persists across a fresh store instance over the same backend (reload)', () => {
    const backend = new MemoryBackend();
    const store1 = createCalibrationStore(backend);
    const saved = store1.save({ name: 'persist', sources: ['Cs-137'], result: makeResult(3) });
    store1.setActive(saved.id);

    // simulate a page reload: brand-new store object, same backing storage.
    const store2 = createCalibrationStore(backend);
    const reloaded = store2.load(saved.id);
    expect(reloaded).toEqual(saved);
    expect(store2.getActive()?.id).toBe(saved.id);
    expect(store2.list()).toHaveLength(1);
  });

  it('honors a custom key without colliding with the default', () => {
    const backend = new MemoryBackend();
    const def = createCalibrationStore(backend);
    const alt = createCalibrationStore(backend, 'nuclid.calibrations.alt');

    def.save({ name: 'in-default', sources: [], result: makeResult(0) });
    expect(alt.list()).toHaveLength(0); // isolated by key
    expect(def.list()).toHaveLength(1);
  });
});
