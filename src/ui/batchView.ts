/**
 * batchView -- the DOM surface for the Batch Peak Finder (Phase 2 Import + Phase 3 Queue view),
 * bound to a {@link BatchManager}. Extracted as a self-contained, testable module (the
 * `inspectorWorkspace` / `batchRowMarkup` precedent) so it can be unit-tested in happy-dom and
 * wired into `app.ts` as a thin mount step, rather than threaded blind through the monolith.
 *
 * Two regions (the design's Manager home): a default-config header + import affordance, and the
 * status-first queue. Rendering is innerHTML-replace on every manager notification; events are
 * delegated on the stable container so listeners survive re-render. Import validation
 * ({@link importTextFiles}) is separated from the browser File API so it is testable without it.
 *
 * NOTE: the Peak Finder FILE batch, distinct from the Calibrate "batch" of source cards.
 */
import type { BatchManager } from '../batch/batchManager';
import type { BatchEntry, BatchEntryStatus, BatchSummary } from '../batch/batchTypes';
import type { PeakFinderConfig } from '../pipeline/peakFinderConfig';
import { load } from '../pipeline/load';

/** Fixed status vocabulary (design §7): reuse the established glyph language. */
const STATUS_GLYPH: Record<BatchEntryStatus, string> = {
  queued: '○',
  running: '◐',
  done: '●',
  warning: '⚠',
  failed: '✕',
  paused: '‖',
  excluded: '⊘',
};

/** A parsed-but-unread file to import: name + text (+ optional byte size). Keeping this shape
 * (not a browser `File`) lets the import path be tested without the File API. */
export interface ImportTextFile {
  readonly name: string;
  readonly text: string;
  readonly size?: number;
}

/** Parse + validate each file, adding a `queued` entry for good files and quarantining bad ones
 * as `failed` (import never blocks on a bad file -- design Screen A). Pure over the manager. */
export function importTextFiles(mgr: BatchManager, files: readonly ImportTextFile[]): void {
  for (const f of files) {
    try {
      const spectrum = load({
        text: f.text,
        fileName: f.name,
        ...(f.size !== undefined ? { fileSizeBytes: f.size } : {}),
      });
      mgr.addSpectrum(spectrum);
    } catch (err) {
      mgr.addImportFailure(f.name, err instanceof Error ? err.message : String(err));
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The always-visible progress summary + aggregate bar (design §8.5). */
export function batchSummaryMarkup(s: BatchSummary): string {
  const settled = s.done + s.warning + s.failed + s.excluded;
  const pct = s.total ? Math.round((settled / s.total) * 100) : 0;
  return `
    <div class="batch-summary" data-role="summary">
      <div class="batch-summary__counts">
        ${s.done} done · ${s.warning} warning${s.warning === 1 ? '' : 's'} ·
        ${s.failed} failed · ${s.excluded} excluded · ${s.queued} queued
        <strong>· ${s.kept} of ${s.total} ready · ${s.totalPeaks} peaks</strong>
      </div>
      <div class="batch-summary__bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="batch-summary__fill" style="width:${pct}%"></div>
      </div>
    </div>`;
}

/** Per-file row actions, mapped to state transitions (design §8.7). Only the actions valid for
 * the entry's status are rendered. */
function rowActionsMarkup(entry: BatchEntry): string {
  const btn = (action: string, label: string): string =>
    `<button type="button" class="batch-row__action" data-action="${action}" data-id="${entry.id}">${label}</button>`;
  const actions: string[] = [];
  if (entry.status === 'failed') actions.push(btn('retry', 'Retry'), btn('remove', 'Remove'));
  else if (entry.status === 'excluded') actions.push(btn('include', 'Include'));
  else if (entry.status === 'done' || entry.status === 'warning')
    actions.push(btn('open', 'Open'), btn('exclude', 'Exclude'));
  return actions.join('');
}

/** One queue row -- status-first (the glyph is the loudest, leftmost element). */
export function batchQueueRowMarkup(entry: BatchEntry): string {
  const glyph = STATUS_GLYPH[entry.status];
  const peaks = entry.result ? `${entry.result.peakCount} peaks` : '';
  const warn = entry.result?.warnings.length ? entry.result.warnings.join(' · ') : '';
  const err = entry.error ? esc(entry.error.message) : '';
  const custom = entry.configOverride ? '<span class="batch-row__badge">custom settings</span>' : '';
  return `
    <li class="batch-row batch-row--${entry.status}" data-id="${entry.id}">
      <span class="batch-row__glyph" aria-hidden="true">${glyph}</span>
      <span class="batch-row__status">${entry.status}</span>
      <span class="batch-row__name">${esc(entry.fileName)}</span>
      <span class="batch-row__peaks">${peaks}</span>
      <span class="batch-row__warn">${esc(warn)}</span>
      <span class="batch-row__error">${err}</span>
      ${custom}
      <span class="batch-row__actions">${rowActionsMarkup(entry)}</span>
    </li>`;
}

/** A one-line read-only summary of the shared default config (config editing is a later step). */
function defaultConfigMarkup(config: PeakFinderConfig): string {
  const sg = `SG ${config.preprocessing.sg.window}/${config.preprocessing.sg.polyorder}`;
  return `<div class="batch-config" data-role="default-config">Default: ${sg} · input ${config.continuum.input} · net ${config.detection.netInput}</div>`;
}

/** Worker-loop controls -- Start / Pause / Resume / Retry-all, gated on the manager state. */
function controlsMarkup(mgr: BatchManager): string {
  const s = mgr.summary();
  const buttons: string[] = [];
  if (mgr.paused && s.queued > 0) {
    buttons.push(`<button type="button" class="batch-control" data-action="resume">Resume</button>`);
  } else if (!mgr.active && !mgr.paused && s.queued > 0) {
    buttons.push(`<button type="button" class="batch-control" data-action="start">Start batch</button>`);
  }
  // Pause is meaningful only while work is actually in flight; once the queue drains a still-
  // "active" loop is idle, so don't offer it.
  if (mgr.active && (s.queued > 0 || s.running > 0))
    buttons.push(`<button type="button" class="batch-control" data-action="pause">Pause</button>`);
  if (s.failed > 0) buttons.push(`<button type="button" class="batch-control" data-action="retry-all">Retry failed</button>`);
  // Hand-off to Calibration is the footer's Next on the Hand-off phase, not a control here.
  return `<div class="batch-controls">${buttons.join('')}</div>`;
}

// Rail state glyphs (same grammar as peakFinderStepper's: currentColor SVGs that tint per row).
const RAIL_DONE =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;
const RAIL_UNLOCK =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
const RAIL_LOCK =
  `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

type RailStatus = 'done' | 'active' | 'locked';
function railGlyph(status: RailStatus): string {
  return status === 'done' ? RAIL_DONE : status === 'active' ? RAIL_UNLOCK : RAIL_LOCK;
}

/** One phase row in the left rail (reuses the `.step-film-*` classes verbatim -- no new CSS).
 * A row carries `data-action` only when it is interactive AND unlocked. */
function railItem(
  num: number,
  label: string,
  status: RailStatus,
  opts: { current?: boolean; action?: string; phase?: number } = {},
): string {
  const cls = `step-film-item ${status}${opts.current ? ' current' : ''}`;
  const phaseAttr = opts.phase != null ? ` data-phase="${opts.phase}"` : '';
  const interactive =
    opts.action && status !== 'locked'
      ? ` data-action="${opts.action}"${phaseAttr} role="button" tabindex="0"`
      : status === 'locked'
        ? ' aria-disabled="true"'
        : '';
  return `<li class="${cls}"${interactive}>
      <span class="step-film-num">${num}</span>
      <span class="step-film-label">${label}</span>
      <span class="step-film-status" aria-hidden="true">${railGlyph(status)}</span>
    </li>`;
}

/** The three batch phases, in order -- the stepper the rail + footer navigate. */
const BATCH_PHASE_LABELS = ['Import', 'Review Queue', 'Hand-off'] as const;
const BATCH_PHASE_SUBTITLES = [
  'Add spectrum files — each is validated and queued.',
  'Process the queue; inspect or hand-tune any file, exclude what you do not want.',
  'Confirm the reviewed set, then hand it to Calibration.',
];

/** The furthest phase currently reachable: Hand-off (2) once the batch is settled with a kept
 * file, Review Queue (1) once files exist, else Import (0). Mirrors the Peak Finder `reached`
 * high-water: everything at or before it is unlocked. */
export function batchMaxPhase(mgr: BatchManager): number {
  const s = mgr.summary();
  if (mgr.phase === 'settled' && s.kept > 0) return 2;
  if (s.total > 0) return 1;
  return 0;
}

/** The batch workflow-phase rail: Import -> Review Queue -> Hand-off, plus a Close footer. Statuses
 * derive from the batch state (files imported? settled with kept files?), mirroring the reached/
 * locked semantics of the Peak Finder stepper. */
export function batchRailMarkup(mgr: BatchManager, phase: number): string {
  const max = batchMaxPhase(mgr);
  const item = (i: number): string => {
    const status: RailStatus = i > max ? 'locked' : i < phase ? 'done' : 'active';
    return railItem(i + 1, BATCH_PHASE_LABELS[i], status, {
      current: i === phase,
      action: 'phase',
      phase: i,
    });
  };
  return `
    <ol class="step-film" aria-label="Batch phases">
      <li class="step-film-group">Batch</li>
      ${item(0)}
      ${item(1)}
      ${item(2)}
      <li class="step-film-actions">
        <button class="btn" type="button" data-action="close">Close Workspace</button>
      </li>
    </ol>`;
}

/** Phase 0 -- Import: the shared-config line + the add-files/drop affordance. */
function batchImportPanelMarkup(mgr: BatchManager): string {
  const n = mgr.entries.length;
  return `
    <section class="batch" aria-label="Import">
      <header class="batch-head">
        ${defaultConfigMarkup(mgr.defaultConfig)}
        <div class="batch-import" data-role="dropzone">
          <label class="batch-import__label">Add files
            <input type="file" multiple data-role="import" class="batch-import__input" />
          </label>
          <span class="batch-import__hint">or drop spectrum files here</span>
        </div>
      </header>
      ${
        n
          ? `<p class="batch-import__count">${n} file${n === 1 ? '' : 's'} added — continue to the Review Queue to process them.</p>`
          : ''
      }
    </section>`;
}

/** Phase 1 -- Review Queue: the progress summary, worker controls, and the status-first queue. */
function batchQueuePanelMarkup(mgr: BatchManager): string {
  const rows = mgr.entries.map(batchQueueRowMarkup).join('');
  const empty = mgr.entries.length
    ? ''
    : '<li class="batch-empty">No spectra yet — go back to Import to add files.</li>';
  return `
    <section class="batch" aria-label="Review queue">
      ${batchSummaryMarkup(mgr.summary())}
      ${controlsMarkup(mgr)}
      <ul class="batch-queue" data-role="queue">${rows || empty}</ul>
    </section>`;
}

/** Phase 2 -- Hand-off: the verdict + the note about declaring identities in Calibrate (the
 * forward action is the footer's Continue button). */
function batchHandoffPanelMarkup(mgr: BatchManager): string {
  const s = mgr.summary();
  const extra = `${s.failed ? ` · ${s.failed} failed` : ''}${s.excluded ? ` · ${s.excluded} excluded` : ''}`;
  return `
    <section class="batch" aria-label="Hand-off">
      ${batchSummaryMarkup(s)}
      <div class="batch-verdict">
        <p class="batch-verdict__line"><strong>${s.kept} of ${s.total}</strong> files ready for calibration${extra}.</p>
        <p class="batch-import__hint">Press Continue to hand the reviewed set to Calibration — you will declare each source's identity there.</p>
      </div>
    </section>`;
}

function batchPhasePanelMarkup(mgr: BatchManager, phase: number): string {
  if (phase === 0) return batchImportPanelMarkup(mgr);
  if (phase === 2) return batchHandoffPanelMarkup(mgr);
  return batchQueuePanelMarkup(mgr);
}

/** The "Step n of N" card at the top of `.step-main` (reuses the `.build-step-card` component,
 * exactly like the Peak Finder / Calibrate / Identify steppers). */
function batchStepCardMarkup(phase: number): string {
  return `
    <div class="build-step-card">
      <span class="build-card-eyebrow">Step ${phase + 1} of ${BATCH_PHASE_LABELS.length}</span>
      <h2 class="build-card-title">${BATCH_PHASE_LABELS[phase]}</h2>
      <p class="build-card-subtitle">${BATCH_PHASE_SUBTITLES[phase]}</p>
    </div>`;
}

/** The bottom footer -- the Peak Finder `.step-nav` grammar verbatim (Prev / centred progress /
 * primary Next). On the last phase Next becomes "Continue to Calibration" and fires the hand-off;
 * it is disabled until the batch is settled with a kept file. */
function batchToolbarMarkup(mgr: BatchManager, phase: number): string {
  const max = batchMaxPhase(mgr);
  const isHandoff = phase === BATCH_PHASE_LABELS.length - 1;
  const canHandoff = mgr.phase === 'settled' && mgr.summary().kept > 0;
  const prevDisabled = phase <= 0;
  const nextDisabled = isHandoff ? !canHandoff : phase >= max;
  const nextLabel = isHandoff ? 'Continue to Calibration &rarr;' : 'Next &rarr;';
  const progress = `Step ${phase + 1} of ${BATCH_PHASE_LABELS.length} · ${BATCH_PHASE_LABELS[phase]}`;
  return `
    <div class="step-nav">
      <button class="step-prev" type="button" data-action="prev"${prevDisabled ? ' disabled' : ''}>&larr; Prev</button>
      <span class="step-progress">${progress}</span>
      <button class="step-next primary" type="button" data-action="next"${nextDisabled ? ' disabled' : ''}>${nextLabel}</button>
    </div>`;
}

/** The whole batch surface for a given phase: the `.step-body` (phase rail + scrolling
 * `.step-main` with the step-card + phase panel) and the bottom Prev/Next footer -- the exact
 * Peak Finder shell anatomy. `phase` is clamped to what the batch state allows. Rendered into the
 * shell's `#batchRoot` (a flex column; see app.ts `batchBody`). */
export function batchViewMarkup(mgr: BatchManager, phase: number): string {
  const p = Math.min(Math.max(0, phase), batchMaxPhase(mgr));
  return `
    <div class="step-body" style="flex:1;min-height:0">
      ${batchRailMarkup(mgr, p)}
      <section class="step-main">
        ${batchStepCardMarkup(p)}
        ${batchPhasePanelMarkup(mgr, p)}
      </section>
    </div>
    ${batchToolbarMarkup(mgr, p)}`;
}

/** A live mounted view. Call {@link BatchViewHandle.destroy} on unmount. */
export interface BatchViewHandle {
  destroy(): void;
}

/** Read a browser FileList into text and import it (the real drag-drop / file-input path). */
async function readAndImport(mgr: BatchManager, fileList: FileList | null): Promise<void> {
  if (!fileList || fileList.length === 0) return;
  const files: ImportTextFile[] = [];
  for (const file of Array.from(fileList)) {
    files.push({ name: file.name, text: await file.text(), size: file.size });
  }
  importTextFiles(mgr, files);
}

/**
 * Mount the batch view into `container`, bound to `mgr`. Re-renders on every manager
 * notification; events are delegated on the container so they survive re-render.
 */
export function mountBatchView(
  container: HTMLElement,
  mgr: BatchManager,
  opts: { onOpen?: (id: string) => void; onContinue?: () => void; onClose?: () => void } = {},
): BatchViewHandle {
  // The phase cursor (0 Import · 1 Review Queue · 2 Hand-off) -- the batch stepper's `focus`.
  // Starts on the Review Queue when files are already present, else on Import. Clamped on every
  // render to what the batch state allows (a retry can pull reachability back).
  let phase = mgr.entries.length ? 1 : 0;
  const render = (): void => {
    phase = Math.min(Math.max(0, phase), batchMaxPhase(mgr));
    // Append the `.step-body` + `.step-nav` footer as DIRECT children of the step-app (replacing
    // the prior pair), so the footer is a literal direct child of `.step-app` exactly like Peak
    // Finder -- not nested in a wrapper. The topbar + dev-banner (app-rendered) are left in place.
    container.querySelectorAll(':scope > .step-body, :scope > .step-nav').forEach((n) => n.remove());
    container.insertAdjacentHTML('beforeend', batchViewMarkup(mgr, phase));
  };

  const onClick = (e: Event): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    switch (action) {
      case 'start':
        mgr.start();
        break;
      case 'pause':
        mgr.pause();
        break;
      case 'resume':
        mgr.resume();
        break;
      case 'retry-all':
        mgr.retryAllFailed();
        break;
      case 'retry':
        if (id) mgr.retry(id);
        break;
      case 'exclude':
        if (id) mgr.exclude(id);
        break;
      case 'include':
        if (id) mgr.include(id);
        break;
      case 'remove':
        if (id) mgr.removeEntry(id);
        break;
      case 'open':
        if (id) opts.onOpen?.(id);
        break;
      case 'continue-cal':
        opts.onContinue?.();
        break;
      case 'close':
        opts.onClose?.();
        break;
      case 'phase': {
        const p = Number(target.dataset.phase);
        if (Number.isFinite(p) && p <= batchMaxPhase(mgr)) {
          phase = p;
          render();
        }
        break;
      }
      case 'prev':
        if (phase > 0) {
          phase -= 1;
          render();
        }
        break;
      case 'next':
        if (phase >= BATCH_PHASE_LABELS.length - 1) opts.onContinue?.();
        else if (phase < batchMaxPhase(mgr)) {
          phase += 1;
          render();
        }
        break;
    }
  };

  const onChange = (e: Event): void => {
    const input = e.target as HTMLInputElement;
    if (input.dataset.role !== 'import') return;
    void readAndImport(mgr, input.files).then(() => {
      input.value = ''; // allow re-adding the same file
    });
  };

  const onDragOver = (e: Event): void => {
    e.preventDefault();
  };
  const onDrop = (e: Event): void => {
    e.preventDefault();
    void readAndImport(mgr, (e as DragEvent).dataTransfer?.files ?? null);
  };

  const unsub = mgr.subscribe(render);
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('drop', onDrop);
  render();

  return {
    destroy(): void {
      // Unbind THIS view only; the manager + its worker loop persist (owned by the app, held
      // across renders) so background processing is decoupled from the view -- a re-render or a
      // navigate-away never halts an in-flight batch. The loop self-terminates on drain.
      unsub();
      container.removeEventListener('click', onClick);
      container.removeEventListener('change', onChange);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('drop', onDrop);
      container.querySelectorAll(':scope > .step-body, :scope > .step-nav').forEach((n) => n.remove());
    },
  };
}
