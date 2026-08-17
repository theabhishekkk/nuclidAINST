/**
 * Declare Identities (Phase 2) -- the spectrum navigator + active-source
 * assignment surface for the Configure step `cfg-identity`.
 *
 * Navigator: the NON-LINEAR cursor over the batch -- any source, any time, no
 * sequence gate. Each item shows the filename, the passive detection status
 * chip (read once from `deriveSpectrumStatus` -- never re-derived, Principle 9)
 * and the review-status indicator from {@link deriveReviewStatus} (non-gating).
 *
 * Active surface: the Rule-12 identity `<select>` (the exact `.br-identity` +
 * `data-row` markup, so the existing app.ts change handler binds unchanged),
 * one assignment row per fitted peak with the BOUNDED pick list (the declared
 * source's kit lines, or Exclude), and the expected-line checklist
 * (supporting context only -- never a gate).
 *
 * Phase 2 boundary: assignment state is CAPTURED ONLY. Build still runs the
 * two-pass `calibrate()` auto-matcher; the switch to `calibrateFromMatches`
 * is Phase 4. The inspector mount and its header entry are Phase 3's.
 */
import type { CalibrationManager, ManagedSource } from './calibrationManager';
import { deriveReviewStatus, type ReviewStatus } from './calibrationManager';
import { deriveSpectrumStatus, isInspectable } from '../pipeline/spectrumStatus';
import { CALIBRATION_KIT } from '../data/calibrationKit';
import type { CalibrationLine } from '../domain/types';

/** Sentinel `<option>` value for the per-peak Exclude choice. `''` is Unassigned;
 * any other value is the assigned line's `energyKeV`. app.ts routes on these. */
export const EXCLUDE_OPTION_VALUE = '__exclude__';

/** Review-status indicator copy (non-gating; purely informational). */
const REVIEW_LABEL: Record<ReviewStatus, string> = {
  untouched: 'Not reviewed',
  'in-progress': 'In progress',
  reviewed: 'Reviewed',
};

/** The whole Assign-energies body: a FOCUSED per-source view (2026-07-07 pager redesign --
 * replaces the consolidated all-sources table). One source is on screen at a time, stepped
 * through with a prev/next pager (`#calSrcPrev` / `#calSrcNext`, driven by the manager's
 * `activeRowId` cursor). The layout is graph-on-top: a full-width spectrum graph
 * (`#calAssignChart`, drawn by app.ts `mountAssignGraph`) with the source's detected peaks
 * marked, above a row of peak cards -- one per detected peak, each with its channel,
 * significance, and the bounded energy `<select class="di-assign">`. Graph and cards are
 * LINKED: `selectedPeakId` highlights the peak on both (click either to select). The
 * `.br-identity` / `.di-assign` markup + `data-row` / `data-peak` attrs are unchanged, so
 * the existing delegated handlers bind without change. Peaks come from `runPeakFinder`; the
 * assigned energies ARE the calibration points `calibrateFromMatches` fits from. The old
 * `navigatorItemMarkup` / `activeSourceMarkup` stay exported (their own tests + reuse). */
export function declareIdentitiesMarkup(
  mgr: CalibrationManager,
  selectedPeakId: string | null = null,
): string {
  if (!mgr.sources.length) return '<p class="di-hint muted">Load sources first.</p>';
  const sources = mgr.sources;
  const active = sources.find((s) => s.rowId === mgr.activeRowId) ?? sources[0];
  const idx = sources.indexOf(active);
  const assigned = sources.reduce(
    (n, s) => n + s.assignments.filter((a) => a.state === 'assigned').length,
    0,
  );
  return `
    <div class="di-assign-view">
      ${pagerMarkup(idx, sources.length)}
      ${sourceHeadMarkup(active)}
      <div class="di-graph"><canvas id="calAssignChart" class="di-graph-canvas"></canvas></div>
      <div class="di-legend" aria-hidden="true">
        <span><span class="di-key" style="background:#1D9E75"></span>Assigned</span>
        <span><span class="di-key" style="background:#378ADD"></span>Selected</span>
        <span><span class="di-key di-key--o"></span>Unassigned</span>
      </div>
      ${peakCardsMarkup(active, selectedPeakId)}
      <p class="di-total muted">${assigned} peak${assigned === 1 ? '' : 's'} assigned across ${sources.length} source${sources.length === 1 ? '' : 's'}.</p>
    </div>`;
}

/** The prev/next source pager: just the arrows + a "source N of M" counter. The source's
 * identity is shown in the header below, so it is not repeated here. Buttons disable at the ends. */
function pagerMarkup(idx: number, count: number): string {
  const prevDisabled = idx <= 0 ? 'disabled' : '';
  const nextDisabled = idx >= count - 1 ? 'disabled' : '';
  return `
    <div class="di-pager">
      <button class="di-pager-btn" id="calSrcPrev" type="button" ${prevDisabled} aria-label="Previous source">&#8249;</button>
      <span class="di-pager-count muted">Source ${idx + 1} of ${count}</span>
      <button class="di-pager-btn" id="calSrcNext" type="button" ${nextDisabled} aria-label="Next source">&#8250;</button>
    </div>`;
}

/** The active source's header: filename + passive detection chip + Rule-12 identity select
 * (bounds the per-peak energy pick list). */
function sourceHeadMarkup(s: ManagedSource): string {
  const status = deriveSpectrumStatus(s.report);
  const opts = CALIBRATION_KIT.entries
    .map(
      (e) =>
        `<option value="${e.id}" ${s.sourceId === e.id ? 'selected' : ''}>${escapeHtml(e.displayName)} (${e.id})</option>`,
    )
    .join('');
  return `
    <div class="di-src-head">
      <span class="br-file" title="${escapeHtml(s.fileName)}">${escapeHtml(s.fileName)}</span>
      <span class="br-status br-status--${status.state}"
        aria-label="${escapeHtml(`Status: ${status.label} (${status.state})`)}">${escapeHtml(status.label)}</span>
      <select class="select br-identity" data-row="${s.rowId}" aria-label="Declared identity for ${escapeHtml(s.fileName)}">
        <option value="" ${s.sourceId ? '' : 'selected'}>Declare identity...</option>
        ${opts}
      </select>
    </div>`;
}

/** The active source's detected-peak cards, laid out left-to-right beneath the graph. The
 * empty (no peaks) and undeclared (no identity yet) states render a single muted hint. Each
 * card carries `data-row` + `data-peak` (card-click selection) and the bounded `.di-assign`
 * energy select. `di-pcard--sel` marks the linked-selected peak; `di-pcard--{state}` its
 * assignment state (assigned / excluded / unassigned) for the status dot. */
function peakCardsMarkup(s: ManagedSource, selectedPeakId: string | null): string {
  if (!s.assignments.length) {
    return '<p class="di-hint muted">No valid detected peaks in this spectrum.</p>';
  }
  const entry = CALIBRATION_KIT.entries.find((e) => e.id === s.sourceId) ?? null;
  if (!entry) {
    return `<p class="di-hint muted">Declare the source above to assign energies to its ${s.assignments.length} detected peak${s.assignments.length === 1 ? '' : 's'}.</p>`;
  }
  const lines = entry.lines;
  const cards = s.assignments
    .map((a, i) => {
      const peak = s.fittedPeaks[i];
      const sig = peak ? peak.significance.toFixed(1) : '';
      const isSel = a.peakId === selectedPeakId;
      const dotState = a.state === 'assigned' ? 'assigned' : isSel ? 'sel' : a.state;
      const lineOpts = lines
        .map(
          (l) =>
            `<option value="${l.energyKeV}" ${
              a.state === 'assigned' && a.energyKeV === l.energyKeV ? 'selected' : ''
            }>${l.energyKeV} keV (${l.tier.charAt(0).toUpperCase() + l.tier.slice(1)})</option>`,
        )
        .join('');
      return `
      <div class="di-pcard di-pcard--${a.state}${isSel ? ' di-pcard--sel' : ''}" data-row="${s.rowId}" data-peak="${a.peakId}">
        <div class="di-pcard-ch"><span class="di-dot di-dot--${dotState}"></span>Ch ${a.centroidChannel.toFixed(1)}</div>
        <div class="di-pcard-sig muted">Significance: ${sig}</div>
        <select class="select di-assign" data-row="${s.rowId}" data-peak="${a.peakId}"
          aria-label="Energy for the peak at channel ${a.centroidChannel.toFixed(1)}">
          <option value="" ${a.state === 'unassigned' ? 'selected' : ''}>Unassigned</option>
          ${lineOpts}
          <option value="${EXCLUDE_OPTION_VALUE}" ${a.state === 'excluded' ? 'selected' : ''}>Exclude</option>
        </select>
      </div>`;
    })
    .join('');
  return `<div class="di-pcards">${cards}</div>`;
}

/** One navigator item: filename + passive detection chip + review status.
 * Exported for tests (same seam as `batchRowMarkup`). */
export function navigatorItemMarkup(s: ManagedSource, active: boolean): string {
  const status = deriveSpectrumStatus(s.report);
  const review = deriveReviewStatus(s.assignments);
  return `
    <li class="di-nav-item${active ? ' di-nav-item--active' : ''}" data-row="${s.rowId}">
      <button class="di-nav-btn" type="button" data-row="${s.rowId}" aria-pressed="${active}">
        <span class="br-file" title="${escapeHtml(s.fileName)}">${escapeHtml(s.fileName)}</span>
        <span class="br-status br-status--${status.state}"
          aria-label="${escapeHtml(`Status: ${status.label} (${status.state})`)}">${escapeHtml(status.label)}</span>
        <span class="di-review di-review--${review}">${REVIEW_LABEL[review]}</span>
      </button>
    </li>`;
}

/** The active source: identity select + embedded evidence + per-peak assignment
 * list + expected-line checklist. With no declared identity there is no bounded
 * pick list yet, so a hint renders instead. Exported for tests.
 *
 * `.di-evidence` (Phase 3) is the inline mount root for the read-only Peak
 * Pipeline Inspector, bound by app.ts to THIS source as its single subject --
 * tier-0 ambient context (peaks-overlaid Validated stage by default) with the
 * stage rail as tier-2 progressive disclosure. Rendered only when the source
 * has inspectable evidence. */
export function activeSourceMarkup(s: ManagedSource): string {
  const opts = CALIBRATION_KIT.entries
    .map(
      (e) =>
        `<option value="${e.id}" ${s.sourceId === e.id ? 'selected' : ''}>${escapeHtml(e.displayName)} (${e.id})</option>`,
    )
    .join('');
  const entry = CALIBRATION_KIT.entries.find((e) => e.id === s.sourceId) ?? null;
  const body = entry
    ? `${peakListMarkup(s, entry.lines)}
       ${checklistMarkup(s, entry.lines)}`
    : '<p class="di-hint muted">Declare the source above to assign peaks.</p>';
  return `
    <div class="di-active" data-row="${s.rowId}">
      <div class="di-active-head">
        <span class="br-file" title="${escapeHtml(s.fileName)}">${escapeHtml(s.fileName)}</span>
        <select class="select br-identity" data-row="${s.rowId}" aria-label="Declared identity">
          <option value="" ${s.sourceId ? '' : 'selected'}>Declare identity...</option>
          ${opts}
        </select>
      </div>
      ${isInspectable(s.report) ? '<div class="di-evidence"></div>' : ''}
      ${body}
    </div>`;
}

/** One assignment row per fitted peak: centroid (1 dp), a confidence read
 * (C1/C2 significance), and the bounded assignment select. The `.di-assign`
 * select carries `data-row` + `data-peak` for the delegated app.ts handler. */
function peakListMarkup(s: ManagedSource, lines: readonly CalibrationLine[]): string {
  if (!s.assignments.length) {
    return '<p class="di-hint muted">No valid fitted peaks to assign in this spectrum.</p>';
  }
  const rows = s.assignments
    .map((a, i) => {
      const peak = s.fittedPeaks[i];
      const confidence = peak ? `significance ${peak.significance.toFixed(1)}` : '';
      const lineOpts = lines
        .map(
          (l) =>
            `<option value="${l.energyKeV}" ${
              a.state === 'assigned' && a.energyKeV === l.energyKeV ? 'selected' : ''
            }>${l.energyKeV} keV (${l.tier.charAt(0).toUpperCase() + l.tier.slice(1)})</option>`,
        )
        .join('');
      return `
      <li class="di-peak" data-peak="${a.peakId}">
        <span class="di-peak-ch">ch ${a.centroidChannel.toFixed(1)}</span>
        <span class="di-peak-sig muted">${confidence}</span>
        <select class="select di-assign" data-row="${s.rowId}" data-peak="${a.peakId}"
          aria-label="Assignment for the peak at channel ${a.centroidChannel.toFixed(1)}">
          <option value="" ${a.state === 'unassigned' ? 'selected' : ''}>Unassigned</option>
          ${lineOpts}
          <option value="${EXCLUDE_OPTION_VALUE}" ${a.state === 'excluded' ? 'selected' : ''}>Exclude</option>
        </select>
      </li>`;
    })
    .join('');
  return `<ul class="di-peaks" aria-label="Peak assignments">${rows}</ul>`;
}

/** Expected-line checklist: every kit line of the declared source, marked
 * matched / unmatched (matched = some assignment carries that energy). A line
 * assigned to more than one peak is flagged as a conflict (visual only;
 * enforcement, if any, is Phase 4 validation). NON-GATING by design. */
function checklistMarkup(s: ManagedSource, lines: readonly CalibrationLine[]): string {
  const items = lines
    .map((l) => {
      const matches = s.assignments.filter(
        (a) => a.state === 'assigned' && a.energyKeV === l.energyKeV,
      ).length;
      const cls =
        matches === 0 ? 'di-line--unmatched' : matches > 1 ? 'di-line--conflict' : 'di-line--matched';
      const mark = matches === 0 ? '&#9675;' : '&#10003;'; // ○ / ✓
      const conflict =
        matches > 1 ? ` <span class="di-line-note">assigned to ${matches} peaks</span>` : '';
      return `<li class="di-line ${cls}"><span class="di-line-mark" aria-hidden="true">${mark}</span> ${l.energyKeV} keV (${l.tier})${conflict}</li>`;
    })
    .join('');
  return `
    <div class="di-checklist-wrap">
      <p class="di-checklist-title muted">Expected lines</p>
      <ul class="di-checklist">${items}</ul>
    </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
