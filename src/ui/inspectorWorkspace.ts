/**
 * Peak Pipeline Inspector -- Phase 3/4a/4b: the container-agnostic WORKSPACE.
 *
 * A self-contained inspector unit: markup, draw, handlers, and its own view-state
 * shape, parameterized over a set of {@link InspectorSubject}s plus an injected
 * {@link InspectorWorkspaceState} selecting one of them. It knows nothing about
 * how it is mounted or where its data comes from (Principle 10): no import of
 * calibrationManager, CalibViewState, or app state -- only domain types, the
 * chart primitives, and the Phase-1 status *type* (the host derives status; the
 * workspace never recomputes it, Principle 9). Read-only over its inputs
 * (Principle 11): it never mutates a trace or report; it writes only to the
 * injected state object.
 *
 * Phase 4a: multi-subject awareness -- a recessed, status-aware selector
 * switches spectra inside the workspace. Switch semantics (operator-ruled):
 * stage persists, the selected candidate resets, and the zoom/pan window is
 * REPROJECTED onto the target domain via {@link reprojectView}. Only the
 * SELECTED subject's trace is built (lazy `getTrace`).
 *
 * Phase 4b: workspace-first ENTRY resolution (Principles 2/3/4). Opening with no
 * (valid) subject resolves: zero subjects -> minimal empty root (the designed
 * empty state is 4c); exactly one -> auto-open it immediately (set-then-render
 * in the same mount pass); several -> a prominent SELECTION STEP -- the same
 * shared per-subject item list as the recessed selector, at higher prominence
 * (one control, two prominence levels; no second picker component). Picking
 * reuses the 4a switch semantics (from null: opens on Raw, full view, no
 * candidate). Not live-reachable until Phase 5's single entry point (the
 * per-card button always pre-selects); DOM-tested here.
 *
 * DOM scoping: the canvas is resolved WITHIN the mount root (`.inspector-chart`),
 * never via a global id, so two instances can never collide. The `id` attribute
 * on the canvas is kept purely for markup parity with Phase 2.
 */
import type { PipelineTrace } from '../domain/types';
import type { SpectrumStatus } from '../pipeline/spectrumStatus';
import {
  drawSpectrum,
  nearestChannelIndex,
  type ChartGeometry,
  type ChartMarker,
  type ChartSeries,
} from '../viz/spectrumChart';
import {
  mountChartInteraction,
  fitYToWindow,
  reprojectView,
  type XWindow,
} from '../viz/chartInteraction';
import { WINDOW_FACTOR, MIN_HALF_WINDOW } from '../pipeline/detect';

/** Workspace-owned view state -- the five former CalibViewState inspector fields,
 * grouped. The subject id identifies which spectrum is shown (Build passes the
 * batch rowId this phase); the rest mirror their previous semantics exactly:
 * `stageIndex` is the walkthrough position (reset to 0 on open; PERSISTS across
 * subject switches), `geometry` the last draw's hit-test geometry, `view` the
 * zoom/pan window that PERSISTS across stage changes (J2) and is reprojected on
 * subject switch (4a), `selectedCandidate` the click-selected candidate channel
 * (reset on subject switch). */
export interface InspectorWorkspaceState {
  // The Phase-5 host-only `open` visibility flag is GONE (Declare-Identities
  // Phase 3): the workspace is embedded in the active-source surface and always
  // present for the active source, so visibility is no longer host state.
  subjectId: string | null;
  stageIndex: number;
  geometry: ChartGeometry | null;
  view: XWindow | null;
  selectedCandidate: number | null;
}

/** A fresh workspace state (also the reset shape hosts assign). */
export function emptyInspectorState(): InspectorWorkspaceState {
  return {
    subjectId: null,
    stageIndex: 0,
    geometry: null,
    view: null,
    selectedCandidate: null,
  };
}

/** One inspectable spectrum, as the host presents it to the workspace (Phase 4a).
 * `status` is the Phase-1 contract output, derived ONCE by the host (single
 * source of truth) -- the workspace renders it, never recomputes it. `getTrace`
 * is lazy: the workspace invokes it only for the SELECTED subject. */
export interface InspectorSubject {
  readonly id: string;
  readonly label: string;
  readonly status: SpectrumStatus;
  readonly channelCount: number;
  readonly getTrace: () => PipelineTrace;
}

/** What {@link mountInspectorWorkspace} returns: `redraw` re-renders the chart in
 * place (host calls it on window resize, DEBT-32); `destroy` releases the chart
 * interaction binding before the host replaces the DOM. */
export interface InspectorWorkspaceHandle {
  redraw(): void;
  destroy(): void;
}

/** The Peak Pipeline Inspector's stage walkthrough (Phase 3b): the ordered stages
 * the canvas steps through, raw counts -> validated peaks. `caption` may contain
 * `{all}`/`{survivors}` tokens, substituted from the trace at render time. */
export const INSPECTOR_STAGES: readonly {
  readonly id: string;
  readonly label: string;
  readonly caption: string;
  /** The real module this stage runs (truthful, single source of truth; retained
   * as step provenance -- the Peak Finder stage head no longer renders it, the mono
   * `.step-stage-source` line was dropped in the V4 chrome alignment). Verified
   * against the actual pipeline: SNIP lives inline in `condition.ts` while the
   * Savitzky–Golay
   * and find-peaks algorithms are their own `signal/*` modules, so the paths
   * deliberately differ per stage rather than all pointing at a pipeline wrapper.
   * Additive for the inspector (Calibrate), which reads id/label/caption. */
  readonly source: string;
}[] = [
  {
    id: 'raw',
    label: 'Raw',
    caption: 'Raw counts as uploaded — before any processing.',
    source: 'io/parse.ts',
  },
  {
    id: 'background',
    label: 'Background',
    caption: 'SNIP continuum estimated (LLS, 45 iterations).',
    source: 'pipeline/condition.ts',
  },
  {
    id: 'smoothed',
    label: 'Smoothed',
    caption: 'Savitzky–Golay smoothing of the net signal — the detection input.',
    source: 'signal/savgol.ts',
  },
  {
    id: 'candidates',
    label: 'Candidates',
    caption: '{all} local maxima → {survivors} survivors after the prominence / distance / width gates.',
    source: 'signal/findPeaks.ts',
  },
  {
    id: 'fit',
    label: 'Fit',
    caption:
      'A Gaussian is fitted to each survivor over the continuum; the shaded band is the ±1.5·FWHM window the net area was summed over.',
    source: 'pipeline/fit.ts',
  },
  {
    id: 'validated',
    label: 'Validated',
    source: 'pipeline/validate.ts',
    // Host-specific copy (operator ruling 2026-07-03, P2 addendum): this Validated
    // caption is the CALIBRATE / inspector wording, with its energy-calibration
    // framing. Peak Finder — whose scope bans energy wording ("channel space
    // only") — is the ONE host that overrides this string, in `pfCaption()`
    // (app.ts). The other five captions stay shared / single-sourced.
    caption: 'Validated peaks — the anchors that feed energy calibration.',
  },
];

/** Clamp a stored stage index into the valid range (defensive against stale state). */
export function clampInspectorStage(i: number): number {
  return Math.max(0, Math.min(INSPECTOR_STAGES.length - 1, Math.trunc(i) || 0));
}

/** Minimal HTML escaper for subject labels (file names are user-controlled). */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The per-reason drop/failure counts legend for the current stage (Phase 4b);
 * empty for stages without one. */
export function inspectorLegend(trace: PipelineTrace, stageIdx: number): string {
  if (stageIdx === 3) {
    const dropped = trace.detected.all.filter((d) => d.passed === false);
    const byReason = (r: string): number => dropped.filter((d) => d.rejectReason === r).length;
    return `${trace.detected.survivors.length} survivors &middot; ${dropped.length} dropped (${byReason(
      'prominence',
    )} prominence &middot; ${byReason('distance')} distance &middot; ${byReason('width')} width)`;
  }
  if (stageIdx === 4) {
    const rejWithLine = trace.fitted.all.filter((p) => p.status === 'rejected').length;
    return `${trace.fitted.kept.length} fitted &middot; ${rejWithLine} rejected (peak-hop/edge) &middot; ${trace.fitted.unfittable.length} unfittable`;
  }
  return '';
}

/** One-line description of a candidate's full fate, for the click-to-inspect detail. */
export function describeCandidateFate(trace: PipelineTrace, channel: number): string {
  const cand = trace.detected.all.find((d) => d.channel === channel);
  if (!cand) return `Channel ${channel} — no candidate at this position.`;
  if (cand.passed === false) {
    return `Channel ${channel} — rejected at the ${cand.rejectReason} gate.`;
  }
  if (trace.fitted.kept.some((p) => p.detectedChannel === channel)) {
    return `Channel ${channel} — survivor → kept (fitted peak).`;
  }
  const rej = trace.fitted.all.find((p) => p.detectedChannel === channel && p.status === 'rejected');
  if (rej) return `Channel ${channel} — survivor → fit rejected (${rej.rejectReason}).`;
  const unf = trace.fitted.unfittable.find((u) => u.detectedChannel === channel);
  if (unf) return `Channel ${channel} — survivor → unfittable (${unf.reason}).`;
  return `Channel ${channel} — survivor (fate unresolved).`;
}

/** ONE per-subject item renderer, shared by the recessed selector and the 4b
 * prominent selection step (Principle 4: one control, two prominence levels --
 * same button, same `data-subject`, same status language everywhere). */
function subjectItemMarkup(s: InspectorSubject, selectedId: string | null, disabled: boolean): string {
  const sel = s.id === selectedId;
  return `<button class="insp-subject ${sel ? 'is-selected' : ''}" type="button"
          data-subject="${escapeHtml(s.id)}" aria-pressed="${sel}" ${disabled ? 'disabled' : ''}>
          <span class="insp-subject-label">${escapeHtml(s.label)}</span>
          <span class="insp-subject-status br-status br-status--${s.status.state}">${escapeHtml(s.status.label)}</span>
        </button>`;
}

/** The recessed, status-aware subject selector (Phase 4a, Principle 4): one quiet
 * row listing every subject with its passive four-state signal -- the same
 * `br-status--{state}` classes + contract label the Phase-2 cards render, so the
 * cards and the selector speak the same language. The selected subject is
 * marked; with exactly one subject the control is disabled but still present. */
function selectorMarkup(subjects: readonly InspectorSubject[], selectedId: string | null): string {
  if (!subjects.length) return '';
  const single = subjects.length === 1;
  const items = subjects.map((s) => subjectItemMarkup(s, selectedId, single)).join('');
  return `<div class="insp-selector" role="group" aria-label="Inspected spectrum">${items}</div>`;
}

/** The 4b SELECTION STEP: the prominent variant of the same selector, shown when
 * the workspace opens with no subject and more than one candidate. Same shared
 * items (nothing selected, nothing disabled), higher prominence + heading. */
function selectionStepMarkup(subjects: readonly InspectorSubject[]): string {
  const items = subjects.map((s) => subjectItemMarkup(s, null, false)).join('');
  return `
    <div class="inspector-panel">
      <p class="inspector-eyebrow build-card-eyebrow">Peak pipeline</p>
      <h4 class="inspector-title">Select a spectrum to inspect</h4>
      <div class="insp-selector insp-selector--prominent" role="group"
        aria-label="Select a spectrum to inspect">${items}</div>
    </div>`;
}

/** The workspace panel markup: subject selector + convergence funnel + stage rail
 * + chart + caption / legend / candidate detail. Pure over (trace, state,
 * subjects); the Phase-3 strings are unchanged (the 4a selector is additive). */
export function inspectorPanelMarkup(
  trace: PipelineTrace,
  st: InspectorWorkspaceState,
  subjects: readonly InspectorSubject[] = [],
): string {
  const step = (label: string, n: number): string =>
    `<span class="insp-step"><span class="insp-n">${n}</span><span class="insp-label">${label}</span></span>`;
  const arrow = '<span class="insp-arrow" aria-hidden="true">&rarr;</span>';
  const stageIdx = clampInspectorStage(st.stageIndex);
  const rail = INSPECTOR_STAGES.map((stg, i) => {
    const active = i === stageIdx;
    return `<li class="insp-stage build-step ${active ? 'is-active' : ''}" data-stage="${i}" role="button"
        tabindex="0" ${active ? 'aria-current="step"' : ''}>
        <span class="insp-stage-badge build-step-badge">${i + 1}</span>
        <span class="insp-stage-label build-step-label">${stg.label}</span>
      </li>`;
  }).join('');
  const caption = INSPECTOR_STAGES[stageIdx].caption
    .replace('{all}', String(trace.detected.all.length))
    .replace('{survivors}', String(trace.detected.survivors.length));
  const legend = inspectorLegend(trace, stageIdx);
  const selected = st.selectedCandidate;
  const detail =
    selected != null ? `<div class="insp-detail">${describeCandidateFate(trace, selected)}</div>` : '';
  return `
    <div class="inspector-panel">
      <p class="inspector-eyebrow build-card-eyebrow">Peak pipeline</p>
      <h4 class="inspector-title">How were these found?</h4>
      ${selectorMarkup(subjects, st.subjectId)}
      <div class="inspector-funnel" aria-label="Convergence funnel">
        ${step('local maxima', trace.detected.all.length)} ${arrow}
        ${step('survivors', trace.detected.survivors.length)} ${arrow}
        ${step('fitted', trace.fitted.kept.length)} ${arrow}
        ${step('validated', trace.validated.length)}
      </div>
      <ol class="insp-rail" aria-label="Pipeline stages">${rail}</ol>
      <div class="insp-chart-head">
        <button class="btn btn-ghost insp-reset" type="button" ${st.view ? '' : 'disabled'}>Reset view</button>
      </div>
      <div class="insp-chart-wrap">
        <canvas id="inspectorChart" class="inspector-chart"></canvas>
        <div class="insp-chip" hidden></div>
      </div>
      <p class="insp-caption muted">${caption}</p>
      ${legend ? `<p class="insp-legend muted">${legend}</p>` : ''}
      ${detail}
    </div>`;
}

/** The protagonist series the inspector chip reads counts from, per stage. Mirrors the
 * y-scale references {@link drawInspectorChart} builds: raw counts for the raw/background
 * stages (0-1) and the fit/validated stages (4-5, which draw raw as the ghost baseline
 * the reader traces against); the continuum-referenced smoothed display for the
 * smoothed/candidates stages (2-3, where smoothed is the detection input on show). */
function inspectorChipSeries(trace: PipelineTrace, stage: number): readonly number[] {
  const bg = trace.conditioned?.background ?? null;
  const sm = trace.conditioned?.smoothed ?? null;
  const smoothedDisp = sm && bg ? sm.map((v, ch) => v + bg[ch]) : trace.raw;
  return stage === 2 || stage === 3 ? smoothedDisp : trace.raw;
}

/** Draw the inspector's shared-canvas stage view -- a pure function of
 * (canvas, trace, state, logY); the only write is the fresh draw geometry onto
 * `st.geometry`. Body unchanged from the Phase-2 `drawInspectorChart` apart from
 * the deleted manager lookup (coupling point 1). EXPORTED since Peak Finder P1:
 * its stage panel renders the same six stages from the same trace, so this
 * drawer is the single source of truth for stage visuals across both hosts. */
export function drawInspectorChart(
  canvas: HTMLCanvasElement,
  trace: PipelineTrace,
  st: InspectorWorkspaceState,
  logY: boolean,
): void {
  // Adopted visual-language colors.
  const ACCENT = '#0F6E56'; // raw / peak markers / fit
  const MUTED = '#6B6A63'; // --muted; SNIP continuum (dashed)
  const INK = '#04342C'; // --accent-ink; smoothed detection signal
  const GHOST = '#C9C7BF'; // faint reference ("ghost") of the surrounding context
  const RUG = 'rgba(107, 106, 99, 0.35)'; // candidate-position tick rug
  const WARN = '#7A5B12'; // --warn-text; unfittable-survivor markers

  const raw = trace.raw;
  const n = raw.length;
  const background = trace.conditioned?.background ?? null;
  const smoothed = trace.conditioned?.smoothed ?? null;

  // Smoothed net re-referenced to the continuum so every stage shares ONE y-scale
  // (raw-counts space). Falls back to raw when there is no conditioned series (guard).
  const smoothedDisp: readonly number[] =
    smoothed && background ? smoothed.map((v, ch) => v + background[ch]) : raw;

  // Fitted model = background (or 0) + the kept Gaussians (Phase 2/3a computation).
  const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);
  const model = new Array<number>(n);
  for (let ch = 0; ch < n; ch++) model[ch] = background ? background[ch] : 0;
  for (const p of trace.fitted.kept) {
    const sigma = p.fwhmChannels / FWHM_PER_SIGMA;
    if (!(sigma > 0)) continue;
    for (let ch = 0; ch < n; ch++) {
      const z = (ch - p.centroidChannel) / sigma;
      model[ch] += p.amplitude * Math.exp(-0.5 * z * z);
    }
  }

  const rawStep = (color: string, width: number): ChartSeries => ({
    values: raw,
    color,
    label: 'counts',
    width,
    step: true,
  });
  const bgLine = (): ChartSeries[] =>
    background ? [{ values: background, color: MUTED, label: 'background', width: 1, dash: [4, 3] }] : [];
  const marks = (chs: readonly number[]): ChartMarker[] =>
    chs.map((c) => ({ channel: Math.round(c), label: '', color: ACCENT }));

  const stage = clampInspectorStage(st.stageIndex);
  let series: ChartSeries[] = [];
  let markers: ChartMarker[] = [];
  let ticks: { channel: number; color: string }[] | undefined;
  let shadedRegions: { x0: number; x1: number; color?: string }[] | undefined;

  switch (stage) {
    case 0: // raw
      series = [rawStep(ACCENT, 1.2)];
      break;
    case 1: // background
      series = [rawStep(ACCENT, 1.2), ...bgLine()];
      break;
    case 2: // smoothed (detection input), raw as the ghost reference
      series = [
        rawStep(GHOST, 1),
        { values: smoothedDisp, color: INK, label: 'smoothed', width: 1.2, step: true },
      ];
      break;
    case 3: // candidates: all local maxima as a faint rug, survivors emphasized
      series = [{ values: smoothedDisp, color: GHOST, label: 'smoothed', width: 1, step: true }];
      ticks = trace.detected.all.map((d) => ({ channel: d.channel, color: RUG }));
      markers = marks(trace.detected.survivors.map((d) => d.channel));
      break;
    case 4: // fit: Gaussians over the continuum, kept centroids marked
      series = [
        rawStep(GHOST, 1),
        ...bgLine(),
        {
          values: model,
          color: ACCENT,
          label: 'fit',
          width: 1.25,
          step: true,
          // Fill each fitted peak down to the continuum (the net-peak area) at ~0.6
          // accent, crisp stroke on top. No continuum -> no fill (stroke only).
          fillColor: 'rgba(15, 110, 86, 0.6)',
          ...(background ? { fillTo: background } : {}),
        },
      ];
      markers = marks(trace.fitted.kept.map((p) => p.centroidChannel));
      // Measurement overlay (recessive grays, under the Gaussians): the ±1.5·FWHM
      // integration window with the measured FWHM span (leftIp..rightIp) nested inside.
      shadedRegions = trace.detected.survivors.flatMap((p) => {
        const hw = Math.max(Math.round(WINDOW_FACTOR * p.fwhmChannels), MIN_HALF_WINDOW);
        return [
          { x0: p.channel - hw, x1: p.channel + hw, color: 'rgba(107, 106, 99, 0.08)' },
          { x0: p.leftIp, x1: p.rightIp, color: 'rgba(107, 106, 99, 0.16)' },
        ];
      });
      break;
    case 5: // validated: the channels that flow into energy assignment
      series = [rawStep(GHOST, 1)];
      markers = marks(trace.validated.map((v) => v.peak.centroidChannel));
      break;
  }

  // Unfittable survivors (GAP-07): amber markers with their failure reason on the
  // fit + validated stages, distinct from the teal kept/validated centroids.
  if (stage === 4 || stage === 5) {
    for (const u of trace.fitted.unfittable) {
      markers.push({ channel: Math.round(u.detectedChannel), label: u.reason, color: WARN });
    }
  }
  // Click-to-inspect selection: a single emphasized dark marker at the selected channel.
  const selected = st.selectedCandidate;
  if (selected != null) {
    markers.push({ channel: Math.round(selected), label: '', color: INK });
  }

  // Zoom/pan (C2, J2): when a window is set, pass it with a Y auto-fit to exactly the
  // series drawn on THIS stage, so each stage rescales its own visible protagonist while
  // the X window persists across stages. Full view passes no `view` -> idle draw is
  // byte-identical to pre-C2.
  const inspView = st.view;
  const view = inspView
    ? { ...inspView, ...fitYToWindow(series.map((s) => s.values), inspView) }
    : undefined;
  st.geometry =
    drawSpectrum(canvas, series, markers, {
      logY,
      xLabel: 'Channel',
      yLabel: 'counts',
      overlays: [],
      ...(ticks ? { ticks } : {}),
      ...(shadedRegions ? { shadedRegions } : {}),
      ...(view ? { view } : {}),
    }) ?? null;
}

/** Wire single-click subject picking on every `.insp-subject` item within `root`
 * -- shared verbatim by the recessed selector (4a switch) and the prominent
 * selection step (4b first pick). Operator-ruled semantics: stage PERSISTS,
 * candidate resets, the view is reprojected onto the target's channel domain
 * (from a null first-pick state this yields Raw / full view / no candidate),
 * geometry is stale (the redraw rebuilds it). Same-subject click is a no-op. */
/** Host-driven removal auto-advance (4c, frozen edge case A): when the INSPECTED
 * subject is being removed, advance to the next-by-index neighbor (else the
 * previous), PRESERVING the stage (comparison workspace); candidate + geometry
 * clear; the view is reprojected onto the neighbor's channel domain. No neighbor
 * -> `subjectId = null` (the designed empty state / selection step take over
 * once Phase 5 mounts the workspace unselected); the view is left as-is then.
 * Call BEFORE the source list mutates, with the still-ordered list. Removing a
 * non-inspected subject is a no-op. Pure over plain data -- no manager import. */
export function advanceSubjectOnRemoval(
  st: InspectorWorkspaceState,
  ordered: readonly { readonly id: string; readonly channelCount: number }[],
  removedId: string,
): void {
  if (st.subjectId !== removedId) return;
  const i = ordered.findIndex((s) => s.id === removedId);
  const neighbor = ordered[i + 1] ?? ordered[i - 1] ?? null;
  st.subjectId = neighbor?.id ?? null;
  st.selectedCandidate = null;
  st.geometry = null;
  if (neighbor) st.view = reprojectView(st.view, neighbor.channelCount);
}

function wireSubjectPicks(
  root: HTMLElement,
  subjects: readonly InspectorSubject[],
  st: InspectorWorkspaceState,
  onChange: () => void,
): void {
  root.querySelectorAll<HTMLButtonElement>('.insp-subject[data-subject]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.subject ?? '';
      if (id === st.subjectId) return; // already shown -- no-op
      const target = subjects.find((s) => s.id === id);
      if (!target) return;
      st.subjectId = target.id;
      st.selectedCandidate = null; // a channel within the OLD spectrum
      st.view = reprojectView(st.view, target.channelCount);
      st.geometry = null;
      onChange();
    }),
  );
}

/**
 * Mount/refresh the workspace into `root` for the given subjects + state.
 *
 * Entry resolution (4b) when no subject matches `state.subjectId`: zero
 * subjects -> minimal empty root (designed empty state is 4c); exactly one ->
 * auto-open it (frozen: "one spectrum, open it immediately"; set-then-render in
 * this same mount pass -- host state is immediately consistent, no forced extra
 * re-render); several -> the prominent selection step (shared items; picking
 * runs the 4a semantics and `onChange`s into the inspection view).
 *
 * Inspection view: renders the panel for the SELECTED subject (lazy `getTrace`
 * -- only that subject's trace is built), resolves its canvas WITHIN `root`
 * (scoped -- no global-id lookup), draws, and wires the subject selector, stage
 * rail, click-to-inspect, reset-view, and the shared zoom/pan/cursor binding
 * ({@link mountChartInteraction}, unchanged) against the injected state.
 * `onChange` asks the host to re-render (subject / stage / candidate changed --
 * markup differs); zoom/pan and reset redraw directly, not through the host, so
 * gestures stay smooth. `logY` is the host's display flag; a change re-renders
 * the host and remounts the workspace, so a plain value is current for the
 * mount's lifetime.
 */
export function mountInspectorWorkspace(opts: {
  root: HTMLElement;
  subjects: readonly InspectorSubject[];
  state: InspectorWorkspaceState;
  logY: boolean;
  onChange: () => void;
}): InspectorWorkspaceHandle {
  const { root, subjects, state: st, logY, onChange } = opts;
  const inert: InspectorWorkspaceHandle = { redraw: () => {}, destroy: () => {} };

  let subject = subjects.find((s) => s.id === st.subjectId);
  if (!subject) {
    // --- Entry resolution (4b): opened with no (valid) subject. -------------
    if (subjects.length === 0) {
      // Designed empty state (4c, frozen edge case B): a labelled surface, not a
      // bare root. Reuses the panel shell + muted classes (minimal; polish
      // deferred). Not live-reachable until Phase 5 mounts the workspace at a
      // fixed location -- Build's per-card mount vanishes with the last card.
      root.innerHTML = `
    <div class="inspector-panel inspector-empty">
      <p class="inspector-eyebrow build-card-eyebrow">Peak pipeline</p>
      <h4 class="inspector-title">No inspectable spectra</h4>
      <p class="insp-empty-hint muted">Load and analyze at least one spectrum, then open the inspector to see how its peaks were found.</p>
    </div>`;
      return inert;
    }
    if (subjects.length > 1) {
      // Selection step: the prominent variant of the one shared selector.
      root.innerHTML = selectionStepMarkup(subjects);
      wireSubjectPicks(root, subjects, st, onChange);
      return inert;
    }
    // Exactly one subject: auto-open it immediately (set-then-render).
    subject = subjects[0];
    st.subjectId = subject.id;
  }
  const trace = subject.getTrace();
  root.innerHTML = inspectorPanelMarkup(trace, st, subjects);
  const canvas = root.querySelector<HTMLCanvasElement>('.inspector-chart');

  const draw = (): void => {
    if (canvas) drawInspectorChart(canvas, trace, st, logY);
  };
  /** Enable the Reset-view button only when the chart is zoomed/panned. */
  const syncResetButton = (): void => {
    const btn = root.querySelector<HTMLButtonElement>('.insp-reset');
    if (btn) btn.disabled = st.view === null;
  };

  // Subject selector (4a): single interaction to switch -- shared pick wiring.
  wireSubjectPicks(root, subjects, st, onChange);

  // Stage rail: click (or Enter/Space) a frame to step the walkthrough.
  // Click-only navigation -- no document arrow-key listener (DEBT-18 conflict).
  const stepStage = (el: HTMLElement): void => {
    const i = Number(el.dataset.stage);
    if (!Number.isNaN(i)) {
      st.stageIndex = clampInspectorStage(i);
      onChange();
    }
  };
  root.querySelectorAll<HTMLElement>('.insp-stage[data-stage]').forEach((el) => {
    el.addEventListener('click', () => stepStage(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        stepStage(el);
      }
    });
  });

  // Click-to-inspect: pick the nearest candidate to the click and reveal its fate.
  // A click in the axis padding / empty space exceeds the pixel tolerance -> clears.
  canvas?.addEventListener('click', (e) => {
    const geo = st.geometry;
    if (!geo) return;
    const xCss = e.clientX - canvas.getBoundingClientRect().left;
    const channels = trace.detected.all.map((d) => d.channel);
    const idx = nearestChannelIndex(geo, xCss, channels);
    st.selectedCandidate = idx == null ? null : channels[idx];
    onChange();
  });

  // Reset view: back to the full spectrum (J4). Direct redraw (not a host
  // re-render) so it matches the binding's dblclick reset path.
  root.querySelector<HTMLButtonElement>('.insp-reset')?.addEventListener('click', () => {
    st.view = null;
    draw();
    syncResetButton();
  });

  // Cursor chip: position + fill from a hover readout; hide on leave. Counts come
  // from the closed-over trace (the former per-mousemove manager lookup + trace
  // rebuild is gone -- same values, no recompute). Pure DOM overlay, no redraw.
  const updateChip = (info: { channel: number; xCss: number; yCss: number } | null): void => {
    const chip = root.querySelector<HTMLElement>('.insp-chip');
    if (!chip) return;
    if (!info) {
      chip.hidden = true;
      return;
    }
    const series = inspectorChipSeries(trace, clampInspectorStage(st.stageIndex));
    let counts = 0;
    if (info.channel >= 0 && info.channel < series.length) counts = Math.round(series[info.channel]);
    chip.textContent = `ch ${info.channel} · ${counts} counts`;
    chip.style.left = `${(canvas?.offsetLeft ?? 0) + info.xCss}px`;
    chip.style.top = `${(canvas?.offsetTop ?? 0) + info.yCss}px`;
    chip.hidden = false;
  };

  draw();
  // The reusable zoom/pan/cursor binding (C2), called unchanged: `setView` redraws
  // the inspector directly (not a host render) so the gesture stays smooth. The
  // window PERSISTS across stage changes (J2) and is reprojected on subject switch.
  const interaction = canvas
    ? mountChartInteraction(canvas, {
        getGeometry: () => st.geometry,
        getView: () => st.view,
        setView: (view) => {
          st.view = view;
          draw();
          syncResetButton();
        },
        onCursor: (info) => updateChip(info),
      })
    : null;

  return {
    redraw: draw,
    destroy: () => {
      interaction?.destroy();
    },
  };
}
