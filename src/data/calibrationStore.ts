/**
 * Calibration store -- browser persistence for calibrations (Persistence, C4/M2).
 *
 * The browser equivalent of the reference `calibration_store.py` over
 * `calibrations.json` (PORTING_PLAN §3 Persistence, §4 record). It persists the
 * whole {@link CalibrationResult} C3 produces (BOTH equations + `selected` +
 * `policy`) verbatim, wrapped with `name` / `sources` / `created` / a stable `id`,
 * under one versioned storage key holding `{ active, calibrations:[...] }`.
 *
 * Design choices (logged for C4):
 *   - **localStorage, not IndexedDB.** The data is a single small JSON blob with
 *     no query needs; localStorage is the synchronous, one-key analogue of
 *     `calibrations.json`. IndexedDB's async cursor model would add ceremony with
 *     no benefit and complicate the fail-loud read. (The backend is pluggable, so
 *     a future IndexedDB adapter is a drop-in if scale ever demands it.)
 *   - **Pluggable backend (RISK-04 / testability).** The store depends on the tiny
 *     {@link StorageBackend} interface, never on `localStorage` directly, so unit
 *     tests inject an in-memory fake and the default is guarded for non-browser
 *     contexts (import never throws; a missing backend fails loud only on use).
 *   - **Fail loud, never wipe (RISK-04).** A missing store reads as empty; a
 *     present-but-corrupt store THROWS {@link ValidationError} rather than silently
 *     resetting and destroying the operator's saved calibrations.
 *   - **save sets active iff none is active.** The first calibration becomes active
 *     automatically; later saves never steal the active pointer from the operator.
 *   - **remove clears active (no silent repoint).** Deleting the active calibration
 *     sets `active` to `null` rather than silently activating a different one the
 *     operator never chose.
 *
 * Switching the active calibration -- and the model within one ({@link
 * CalibrationResult.selected}) -- is a metadata flip, never a recompute (C3 already
 * settled both equations).
 */
import type { CalibrationResult } from '../domain/types';
import { ValidationError } from '../domain/errors';

/** Versioned storage key -- the single `calibrations.json` analogue. Bump the
 * `vN` suffix on any breaking change to the persisted shape. */
export const CALIBRATION_STORE_KEY = 'nuclid.calibrations.v1';

// ---------------------------------------------------------------------------
// Persisted shape + pluggable backend
// ---------------------------------------------------------------------------

/** One saved calibration: the C3 {@link CalibrationResult} verbatim, wrapped with
 * provenance and a stable id. */
export interface StoredCalibration {
  /** Stable unique id (e.g. `crypto.randomUUID()`). */
  readonly id: string;
  /** Operator-given name. */
  readonly name: string;
  /** ISO-8601 creation timestamp. */
  readonly created: string;
  /** Declared source ids the calibration was built from. */
  readonly sources: readonly string[];
  /** C3 output verbatim: both equations + selection + policy. */
  readonly result: CalibrationResult;
}

/** The persisted top-level shape (the `calibrations.json` equivalent). */
export interface CalibrationStoreData {
  /** Id of the active calibration, or `null` when none is active. */
  readonly active: string | null;
  /** All saved calibrations, newest-first. */
  readonly calibrations: readonly StoredCalibration[];
}

/** The minimal storage surface the store needs -- a `localStorage`-shaped trio.
 * Depend on this, not on `localStorage`, so the store is testable without a DOM. */
export interface StorageBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Input to {@link CalibrationStore.save}. */
export interface SaveInput {
  readonly name: string;
  readonly sources: readonly string[];
  readonly result: CalibrationResult;
}

/** The store surface. M4's Calibrate UI calls `save`/`list`/`remove`/`setActive`;
 * M3 Identify reads `getActive()` then `activeCalibration(record.result)`. */
export interface CalibrationStore {
  /** Persist a new calibration; assigns a stable `id` + ISO `created`. Sets it
   * active iff no calibration is currently active. Returns the stored record. */
  save(input: SaveInput): StoredCalibration;
  /** All saved calibrations, newest-first (a defensive copy). */
  list(): StoredCalibration[];
  /** The calibration with this id, or `null` if none. */
  load(id: string): StoredCalibration | null;
  /** Delete by id (fails loud on unknown id). If it was active, clears `active`. */
  remove(id: string): void;
  /** Point `active` at this id, or `null` to clear (fails loud on unknown id). */
  setActive(id: string | null): void;
  /** The active calibration, or `null` if none is active. */
  getActive(): StoredCalibration | null;
}

const EMPTY_STORE: CalibrationStoreData = { active: null, calibrations: [] };

// ---------------------------------------------------------------------------
// Default (browser) backend -- guarded so import never throws off-DOM
// ---------------------------------------------------------------------------

/** Resolve the browser `localStorage` as a {@link StorageBackend}, or fail loud.
 * Called lazily (per operation), never at import, so a non-browser context (SSR,
 * a unit test that forgot to inject a fake) only errors when the store is *used*. */
function resolveDefaultBackend(): StorageBackend {
  const ls = (globalThis as { localStorage?: StorageBackend }).localStorage;
  if (!ls) {
    throw new ValidationError(
      'No localStorage available: the calibration store needs a browser ' +
        'context, or an explicit StorageBackend (inject one in tests/SSR).',
    );
  }
  return ls;
}

// ---------------------------------------------------------------------------
// id + timestamp
// ---------------------------------------------------------------------------

/** A stable unique id: `crypto.randomUUID()` when present, else a time+random
 * fallback so the store still works in older runtimes. */
function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `cal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Fail-loud read + light shape validation (RISK-04)
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Validate one record's shape (the load-time invariant: an `id`, a `name`, a
 * `sources` array, and a `result.linear` with a `selected`). Throws on mismatch. */
function validateRecord(v: unknown, where: string): StoredCalibration {
  if (!isObject(v)) throw new ValidationError(`${where}: expected an object.`);
  if (typeof v.id !== 'string') throw new ValidationError(`${where}: missing string "id".`);
  if (typeof v.name !== 'string') throw new ValidationError(`${where}: missing string "name".`);
  if (typeof v.created !== 'string') throw new ValidationError(`${where}: missing string "created".`);
  if (!Array.isArray(v.sources)) throw new ValidationError(`${where}: "sources" must be an array.`);
  const result = v.result;
  if (!isObject(result)) throw new ValidationError(`${where}: missing "result" object.`);
  if (!isObject(result.linear)) {
    throw new ValidationError(`${where}: "result.linear" must be a calibration object.`);
  }
  if (result.selected !== 'linear' && result.selected !== 'quadratic') {
    throw new ValidationError(`${where}: "result.selected" must be "linear" or "quadratic".`);
  }
  return v as unknown as StoredCalibration;
}

/** Validate the persisted top-level shape. Throws on mismatch. */
function validateStoreData(v: unknown): CalibrationStoreData {
  if (!isObject(v)) throw new ValidationError('Calibration store: root is not an object.');
  if (v.active !== null && typeof v.active !== 'string') {
    throw new ValidationError('Calibration store: "active" must be a string or null.');
  }
  if (!Array.isArray(v.calibrations)) {
    throw new ValidationError('Calibration store: "calibrations" must be an array.');
  }
  const calibrations = v.calibrations.map((c, i) =>
    validateRecord(c, `Calibration store: calibrations[${i}]`),
  );
  return { active: v.active, calibrations };
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

/**
 * Create a calibration store over the given backend (defaults to browser
 * `localStorage`, resolved lazily). All reads fail loud on a corrupt store; all
 * writes are a single `setItem` of the whole blob (the atomic analogue for a
 * one-key store).
 */
export function createCalibrationStore(
  backend?: StorageBackend,
  key: string = CALIBRATION_STORE_KEY,
): CalibrationStore {
  const getBackend = (): StorageBackend => backend ?? resolveDefaultBackend();

  /** Read + validate. Missing -> empty store; present-but-corrupt -> throw. */
  function read(): CalibrationStoreData {
    const raw = getBackend().getItem(key);
    if (raw == null) return EMPTY_STORE;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new ValidationError(
        `Calibration store at "${key}" is corrupt (invalid JSON); refusing to ` +
          `auto-reset and destroy saved calibrations. Underlying: ${(e as Error).message}`,
      );
    }
    return validateStoreData(parsed);
  }

  /** Persist the whole blob in one write (atomic for a single-key store). */
  function write(data: CalibrationStoreData): void {
    getBackend().setItem(key, JSON.stringify(data));
  }

  return {
    save(input: SaveInput): StoredCalibration {
      const data = read();
      const record: StoredCalibration = {
        id: newId(),
        name: input.name,
        created: new Date().toISOString(),
        sources: [...input.sources],
        result: input.result,
      };
      // newest-first: prepend so the persisted array order is the list() order.
      const calibrations = [record, ...data.calibrations];
      // set active iff none is currently active; never steal the operator's choice.
      const active = data.active ?? record.id;
      write({ active, calibrations });
      return record;
    },

    list(): StoredCalibration[] {
      return [...read().calibrations];
    },

    load(id: string): StoredCalibration | null {
      return read().calibrations.find((c) => c.id === id) ?? null;
    },

    remove(id: string): void {
      const data = read();
      if (!data.calibrations.some((c) => c.id === id)) {
        throw new ValidationError(`Cannot remove unknown calibration id "${id}".`);
      }
      const calibrations = data.calibrations.filter((c) => c.id !== id);
      // removing the active one clears active (no silent repoint to another).
      const active = data.active === id ? null : data.active;
      write({ active, calibrations });
    },

    setActive(id: string | null): void {
      const data = read();
      if (id !== null && !data.calibrations.some((c) => c.id === id)) {
        throw new ValidationError(`Cannot set active to unknown calibration id "${id}".`);
      }
      write({ active: id, calibrations: data.calibrations });
    },

    getActive(): StoredCalibration | null {
      const data = read();
      if (data.active == null) return null;
      return data.calibrations.find((c) => c.id === data.active) ?? null;
    },
  };
}

/** Default browser-backed store for app wiring (M4). Construction never touches
 * storage, so importing this in a non-browser context is safe; the first
 * operation resolves `localStorage` (or fails loud if absent). */
export const calibrationStore: CalibrationStore = createCalibrationStore();
