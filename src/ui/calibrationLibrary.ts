/**
 * CalibrationLibrary -- the app-scoped, subscribe-driven coordinator over the
 * existing {@link calibrationStore} (C4). It is the single source of truth for
 * "these are the operator's saved calibrations" and "which one is active": the
 * Calibrate Source Manager renders + mutates it (activate / delete), and Identify
 * reads the active calibration through it.
 *
 * Why a separate object from {@link CalibrationManager} (the run-scoped, per-mount
 * gather->execute->save orchestrator): lifecycle. The run manager is disposable
 * (it owns a reveal timer + `_invalidateRun` run logic); the saved list is
 * cross-session and app-wide, and Identify -- a different mount -- needs the active
 * pointer too. Keeping them separate preserves the Manager/Engine split and gives
 * one subscribe-driven cache instead of two views poking the store directly. The
 * store, `calibrationManager.ts`, and `src/pipeline/*` are all left untouched.
 *
 * Cache + fail-loud (RISK-04): `items`/`activeId` are last-good snapshots for
 * render; `refresh()` re-reads the store and, on a thrown store fault (corrupt
 * payload), captures the message in `error` and leaves the last-good snapshot in
 * place -- it renders the error, it never wipes. `getActive()` is deliberately a
 * LIVE `store.getActive()` (not the cached `activeId`) so a separate mount can
 * never read a stale active pointer.
 */
import {
  calibrationStore,
  type CalibrationStore,
  type StoredCalibration,
} from '../data/calibrationStore';
import { NuclidError, ValidationError } from '../domain/errors';

/** The library surface Calibrate (manage) and Identify (read active) depend on. */
export interface CalibrationLibrary {
  /** Newest-first snapshot of saved calibrations (last-good; for render). */
  readonly items: readonly StoredCalibration[];
  /** Cached active id (last-good; for render). The live truth is {@link getActive}. */
  readonly activeId: string | null;
  /** Last fail-loud read message, or `null` after a clean read. */
  readonly error: string | null;
  /** The active calibration via a LIVE `store.getActive()` (not the cache). May
   * throw on a corrupt store -- the Identify caller is fail-loud and handles it. */
  getActive(): StoredCalibration | null;
  /** `store.setActive(id)` then `refresh()` (which emits). Fail-loud on unknown id. */
  activate(id: string | null): void;
  /** `store.remove(id)` then `refresh()` (which emits). Fail-loud on unknown id. */
  remove(id: string): void;
  /** Duplicate a saved calibration as a new record (name + " (copy)"); refresh()+emit.
   * Does NOT change the active pointer (store.save sets active only iff none active).
   * Fail-loud on unknown id. */
  duplicate(id: string): void;
  /** Re-read the store; on success set the cache + clear `error`; on a store fault
   * capture `error` and keep the last-good snapshot. Always emits afterward. */
  refresh(): void;
  /** Subscribe to cache changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Engine/store fault -> honest message (mirrors the Identify caller's formatting). */
function errText(err: unknown): string {
  return err instanceof NuclidError
    ? err.message
    : `Calibration store error: ${(err as Error).message}`;
}

class CalibrationLibraryImpl implements CalibrationLibrary {
  private _items: readonly StoredCalibration[] = [];
  private _activeId: string | null = null;
  private _error: string | null = null;
  private readonly _listeners = new Set<() => void>();

  /** Seed the cache once. Construction must never throw: a corrupt store on first
   * read is captured into `error` (render-don't-wipe) like any later refresh. */
  constructor(private readonly store: CalibrationStore) {
    this.refresh();
  }

  get items(): readonly StoredCalibration[] {
    return this._items;
  }
  get activeId(): string | null {
    return this._activeId;
  }
  get error(): string | null {
    return this._error;
  }

  getActive(): StoredCalibration | null {
    return this.store.getActive(); // live -- never the cached pointer
  }

  activate(id: string | null): void {
    this.store.setActive(id); // fail-loud on unknown id (propagates)
    this.refresh();
  }

  remove(id: string): void {
    this.store.remove(id); // fail-loud on unknown id (propagates)
    this.refresh();
  }

  duplicate(id: string): void {
    const rec = this.store.load(id);
    if (!rec) throw new ValidationError(`Cannot duplicate unknown calibration id "${id}".`);
    // store.save assigns a fresh id + created, prepends newest-first, and sets active
    // only when none is active -- so duplicating never steals the operator's choice.
    this.store.save({ name: `${rec.name} (copy)`, sources: rec.sources, result: rec.result });
    this.refresh();
  }

  refresh(): void {
    try {
      const items = this.store.list();
      const active = this.store.getActive();
      this._items = items;
      this._activeId = active?.id ?? null;
      this._error = null;
    } catch (err) {
      // Render-don't-wipe: keep the last-good snapshot, surface the message.
      this._error = errText(err);
    }
    this._emit();
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _emit(): void {
    for (const listener of this._listeners) listener();
  }
}

/**
 * Create a library over the given store (defaults to the shared
 * {@link calibrationStore}). Tests inject `createCalibrationStore(inMemoryBackend)`
 * for full isolation with no localStorage (RISK-04 testability).
 */
export function createCalibrationLibrary(
  store: CalibrationStore = calibrationStore,
): CalibrationLibrary {
  return new CalibrationLibraryImpl(store);
}

/** The app-wide singleton over the default `calibrationStore`. Created lazily so
 * importing this module never touches storage (the default store is fail-loud only
 * on use). */
let singleton: CalibrationLibrary | null = null;
export function getCalibrationLibrary(): CalibrationLibrary {
  if (!singleton) singleton = createCalibrationLibrary();
  return singleton;
}
