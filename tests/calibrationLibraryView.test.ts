import { describe, it, expect } from 'vitest';

import { createCalibrationStore, type StoredCalibration } from '../src/data/calibrationStore';
import { createCalibrationLibrary } from '../src/ui/calibrationLibrary';
import { selectLibraryRows, type LibraryView } from '../src/ui/app';
import type { CalibrationResult } from '../src/domain/types';

/**
 * Scenario-1 pure logic: `selectLibraryRows` (filter/search/sort of the non-active
 * "Other" rows) and `CalibrationLibrary.duplicate` (copy a saved calibration). Both
 * are headless -- no DOM. `selectLibraryRows` is imported from the app module (it has
 * no top-level DOM access, so it loads under Vitest's node environment).
 */

// --- in-memory backend (mirrors tests/calibrationLibrary.test.ts) -----------
class MemoryBackend {
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

function result(model: 'linear' | 'quadratic', rms: number | undefined): CalibrationResult {
  const cal = {
    model,
    coefficients: model === 'quadratic' ? [0, 1, 1e-6] : [0, 1],
    points: [
      {
        channel: 100,
        energyKeV: 100,
        sourceLabel: 'x',
        used: true,
        tier: 'anchor' as const,
      },
    ],
    rSquared: 0.999,
    rms,
  };
  return {
    linear: model === 'linear' ? cal : { ...cal, model: 'linear', coefficients: [0, 1] },
    quadratic: model === 'quadratic' ? cal : null,
    selected: model,
    policy: model,
    selectionFellBack: false,
    curvatureSignificance: 0,
  } as unknown as CalibrationResult;
}

function rec(over: {
  id: string;
  name: string;
  created: string;
  sources: string[];
  model: 'linear' | 'quadratic';
  rms?: number;
}): StoredCalibration {
  return {
    id: over.id,
    name: over.name,
    created: over.created,
    sources: over.sources,
    result: result(over.model, over.rms),
  };
}

// newest-first, like the store's list()
const A = rec({ id: 'a', name: 'Cobalt set', created: '2026-06-29T10:00:00.000Z', sources: ['Co-60'], model: 'linear', rms: 1.2 });
const B = rec({ id: 'b', name: 'Europium set', created: '2026-06-28T10:00:00.000Z', sources: ['Eu-152'], model: 'quadratic', rms: 0.5 });
const C = rec({ id: 'c', name: 'Americium set', created: '2026-06-27T10:00:00.000Z', sources: ['Am-241'], model: 'linear' /* rms undefined */ });
const ITEMS = [A, B, C];

const view = (over: Partial<LibraryView> = {}): LibraryView => ({
  query: '',
  sort: 'newest',
  filter: 'all',
  ...over,
});

const ids = (rows: StoredCalibration[]): string[] => rows.map((r) => r.id);

describe('selectLibraryRows (filter / search / sort of the Other list)', () => {
  it('excludes the active record and preserves newest-first by default', () => {
    expect(ids(selectLibraryRows(ITEMS, null, view()))).toEqual(['a', 'b', 'c']);
    expect(ids(selectLibraryRows(ITEMS, 'a', view()))).toEqual(['b', 'c']);
  });

  it('filters by model; "active" hides the Other list', () => {
    expect(ids(selectLibraryRows(ITEMS, null, view({ filter: 'linear' })))).toEqual(['a', 'c']);
    expect(ids(selectLibraryRows(ITEMS, null, view({ filter: 'quadratic' })))).toEqual(['b']);
    expect(selectLibraryRows(ITEMS, null, view({ filter: 'active' }))).toEqual([]);
  });

  it('searches name, source, and model case-insensitively', () => {
    expect(ids(selectLibraryRows(ITEMS, null, view({ query: 'eu' })))).toEqual(['b']); // Europium / Eu-152
    expect(ids(selectLibraryRows(ITEMS, null, view({ query: 'LINEAR' })))).toEqual(['a', 'c']); // model
    expect(ids(selectLibraryRows(ITEMS, null, view({ query: 'cobalt' })))).toEqual(['a']);
    expect(selectLibraryRows(ITEMS, null, view({ query: 'plutonium' }))).toEqual([]);
  });

  it('sorts oldest (reverse) and by lowest residual (undefined rms last)', () => {
    expect(ids(selectLibraryRows(ITEMS, null, view({ sort: 'oldest' })))).toEqual(['c', 'b', 'a']);
    expect(ids(selectLibraryRows(ITEMS, null, view({ sort: 'residual' })))).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const snapshot = [...ITEMS];
    selectLibraryRows(ITEMS, null, view({ sort: 'oldest' }));
    selectLibraryRows(ITEMS, null, view({ sort: 'residual' }));
    expect(ITEMS).toEqual(snapshot);
  });
});

describe('CalibrationLibrary.duplicate', () => {
  it('adds a "(copy)" record without stealing the active pointer when one is active', () => {
    const store = createCalibrationStore(new MemoryBackend());
    store.save({ name: 'first', sources: ['Co-60'], result: result('linear', 1.0) });
    store.save({ name: 'second', sources: ['Cs-137'], result: result('linear', 1.1) });
    const lib = createCalibrationLibrary(store);
    const active = lib.activeId; // the first save became active
    expect(active).toBeTruthy();

    let notified = 0;
    lib.subscribe(() => notified++);

    const target = lib.items.find((r) => r.id !== active) as StoredCalibration;
    lib.duplicate(target.id);

    expect(lib.items).toHaveLength(3);
    expect(lib.items.some((r) => r.name === `${target.name} (copy)`)).toBe(true);
    expect(lib.activeId).toBe(active); // unchanged
    expect(notified).toBe(1);
  });

  it('sets active when none is active', () => {
    const store = createCalibrationStore(new MemoryBackend());
    const saved = store.save({ name: 'solo', sources: ['Am-241'], result: result('linear', 0.9) });
    store.setActive(null); // clear active so the next save claims it
    const lib = createCalibrationLibrary(store);
    expect(lib.activeId).toBeNull();

    lib.duplicate(saved.id);

    expect(lib.items).toHaveLength(2);
    const copy = lib.items.find((r) => r.name === 'solo (copy)') as StoredCalibration;
    expect(copy).toBeTruthy();
    expect(lib.activeId).toBe(copy.id); // claimed active because none was set
  });

  it('throws on an unknown id', () => {
    const store = createCalibrationStore(new MemoryBackend());
    const lib = createCalibrationLibrary(store);
    expect(() => lib.duplicate('nope')).toThrow();
  });
});
