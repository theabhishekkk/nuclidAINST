/**
 * peakFinderTables -- the Peak Finder P2 table + Review-summary derivations.
 *
 * Pure presentation over already-computed engine artifacts: every row value is a
 * field on a {@link PipelineTrace} peak (or "--"), every count is a contract
 * field or a trace-partition length (Principle 9 -- nothing is recomputed here),
 * and the per-row narrative reuses the inspector's `describeCandidateFate`
 * (single source of truth; no parallel explainer).
 *
 * Column layout LOCKED (operator sign-off 2026-07-03): exactly five fixed
 * columns at every stage -- Channel / FWHM / Net Area / Chi-square / Result.
 * The Result column is stage-aware (survivor/kept/valid vs the failed gate,
 * guard, unfittable reason, or validate flags -- RISK-04: never silently drop).
 * The agreed secondary measurements (height, prominence, SNR, classification,
 * centroid) live in an expandable per-row detail drawer.
 * // Divergence: the reference model's review table (Calibrate) has no per-row
 * // detail drawer; the expander is the operator-locked way to keep five fixed
 * // columns while still exposing the secondary measurements.
 *
 * CHANNEL SPACE ONLY: no energy/keV field is ever read or displayed
 * (`FittedPeak.energyKeV` exists for Calibrate's benefit and is off-limits).
 */
import type {
  DetectedPeak,
  FittedPeak,
  PipelineTrace,
  StageName,
  StageTrace,
} from '../domain/types';
import type { SpectrumStatus } from '../pipeline/spectrumStatus';
import { describeCandidateFate } from './inspectorWorkspace';

/** One five-column table row (+ the expander payload). `channel` is ALWAYS the
 * integer detection channel (`DetectedPeak.channel` / `FittedPeak.detectedChannel`)
 * so a fitted row and its candidate row select the SAME chart marker across
 * stages (the row<->chart selection key). */
export interface PeakFinderTableRow {
  readonly channel: number;
  readonly fwhmChannels: number | null;
  readonly netArea: number | null;
  readonly chiSquare: number | null;
  /** Stage-aware verdict -- the funnel's whole point; always visible. */
  readonly result: string;
  /** 'pass' = survivor/kept/valid; 'drop' = any rejection/flag (styling only). */
  readonly resultKind: 'pass' | 'drop';
  /** Secondary measurements for the expandable drawer (label/value pairs). */
  readonly detail: readonly { readonly label: string; readonly value: string }[];
}

// --- row derivation ----------------------------------------------------------

/** A finite chi-square or null (rejected fits carry `chiSquare: null`; degenerate
 * values render "--"). */
function finiteOrNull(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

// --- view-only sort (#7) ------------------------------------------------------

/** The columns the operator can sort by. `'channel'` only for now; widen the union
 * (e.g. `| 'netArea' | 'chiSquare'`) + add a `SORT_ACCESSORS` entry to add more --
 * the nulls-last rule below already covers null-valued keys. */
export type PeakFinderTableSortKey = 'channel';

export interface PeakFinderTableSort {
  readonly key: PeakFinderTableSortKey;
  readonly dir: 'asc' | 'desc';
}

/** Default view: channel ascending (identical to #6's stable base order). */
export const DEFAULT_TABLE_SORT: PeakFinderTableSort = { key: 'channel', dir: 'asc' };

/** Row accessor per sort key. `channel` is never null; other keys (added later) may be. */
const SORT_ACCESSORS: Record<PeakFinderTableSortKey, (r: PeakFinderTableRow) => number | null> = {
  channel: (r) => r.channel,
};

/** View-only sort applied at render, AFTER {@link derivePeakFinderTableRows}. Never
 * mutates the derived rows nor changes WHICH rows are present -- pure reorder. Rows
 * whose sort value is `null` always sort AFTER non-null rows, regardless of `dir`
 * (harmless for `channel`; needed once netArea/chiSquare become keys). `desc` is the
 * reverse of the ascending comparator (Array.prototype.sort is stable in the target
 * runtime, so equal keys keep the #6 channel-ascending base order). */
export function sortRows(
  rows: readonly PeakFinderTableRow[],
  sort: PeakFinderTableSort,
): PeakFinderTableRow[] {
  const accessor = SORT_ACCESSORS[sort.key];
  const dirMul = sort.dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // nulls last, independent of dir
    if (bv === null) return -1;
    return (av - bv) * dirMul;
  });
}

// --- view-only filter (#8) ----------------------------------------------------

/** The database-view filter on a gate stage's candidate table: All / Advancing / Rejected.
 * Maps directly to the row's existing {@link PeakFinderTableRow.resultKind} -- no new
 * derivation. */
export type PeakFinderTableFilter = 'all' | 'advancing' | 'rejected';

/** Default view: all rows (identical to the pre-#8 output). */
export const DEFAULT_TABLE_FILTER: PeakFinderTableFilter = 'all';

/** View-only filter applied at render, BEFORE {@link sortRows} (so the sort orders only the
 * visible set). Hides rows from display only -- never reorders, never changes which rows the
 * engine produced. Pure predicate over `resultKind`: `advancing` = the `'pass'` rows
 * (survivor/advancing/kept/valid), `rejected` = the `'drop'` rows (any gate rejection / fail),
 * `all` = unchanged. No trace access, nothing recomputed. */
export function filterRows(
  rows: readonly PeakFinderTableRow[],
  filter: PeakFinderTableFilter,
): PeakFinderTableRow[] {
  if (filter === 'all') return [...rows];
  const want = filter === 'advancing' ? 'pass' : 'drop';
  return rows.filter((r) => r.resultKind === want);
}

/** The candidate detail drawer (shared by the gate / strength / classification rows). */
function candidateDetail(d: DetectedPeak): PeakFinderTableRow['detail'] {
  return [
    { label: 'Height', value: fmt1(d.height) },
    { label: 'Prominence', value: fmt1(d.prominence) },
    { label: 'SNR', value: fmt1(d.significance) },
    { label: 'Class', value: String(d.classification) },
  ];
}

/** A candidate row AT a gate stage (Phase 3). `gate === null` is the pre-gate
 * local-maxima stage (every candidate advances). Otherwise the row shows the peak
 * struck out iff its FIRST-failing gate is THIS one, else advancing/surviving. The
 * entering set is already narrowed to this gate's cumulative survivors by the caller. */
function gateRow(d: DetectedPeak, gate: DetectedPeak['rejectReason'] | null): PeakFinderTableRow {
  const struck = !d.passed && d.rejectReason === gate;
  const result =
    gate === null ? 'Candidate' : struck ? `rejected: ${gate}` : gate === 'width' ? 'Survivor' : 'Advancing';
  return {
    channel: d.channel,
    fwhmChannels: d.fwhmChannels,
    netArea: d.netArea,
    chiSquare: null, // no fit yet -- Chi-square is "--" at every detection sub-stage
    result,
    resultKind: struck ? 'drop' : 'pass',
    detail: candidateDetail(d),
  };
}

/** A survivor row at the Estimate Peak Strength stage: the significance (SNR) is the
 * headline verdict; net area is the strength estimate, now measured from the working series
 * detection ran on (net or smoothed-net, #4). Gross / the SNR denominator stay raw (D-4a);
 * the row displays the engine-computed `DetectedPeak.netArea`, so the working-series value
 * flows through with no row-value code change here. */
function strengthRow(d: DetectedPeak): PeakFinderTableRow {
  return {
    channel: d.channel,
    fwhmChannels: d.fwhmChannels,
    netArea: d.netArea,
    chiSquare: null,
    result: `SNR ${fmt1(d.significance)}`,
    resultKind: 'pass',
    detail: candidateDetail(d),
  };
}

/** A survivor row at the Preliminary Classification stage: the class is the verdict;
 * only `line` advances cleanly to fitting (broad / weak flagged as drop styling). */
function classificationRow(d: DetectedPeak): PeakFinderTableRow {
  return {
    channel: d.channel,
    fwhmChannels: d.fwhmChannels,
    netArea: d.netArea,
    chiSquare: null,
    result: String(d.classification),
    resultKind: d.classification === 'line' ? 'pass' : 'drop',
    detail: candidateDetail(d),
  };
}

function fittedRow(f: FittedPeak): PeakFinderTableRow {
  return {
    channel: f.detectedChannel,
    fwhmChannels: f.fwhmChannels,
    netArea: f.netArea,
    chiSquare: finiteOrNull(f.chiSquare),
    result: f.status === 'kept' ? 'Kept' : `rejected: ${f.rejectReason ?? 'guard'}`,
    resultKind: f.status === 'kept' ? 'pass' : 'drop',
    detail: [
      { label: 'Centroid', value: `ch ${f.centroidChannel.toFixed(2)}` },
      { label: 'SNR', value: fmt1(f.significance) },
      { label: 'Class', value: String(f.classification) },
    ],
  };
}

/** The cumulative per-gate entering sets, from the FIRST-failing `rejectReason` (fixed
 * order distance -> prominence -> width). `notDistance` entered the prominence gate;
 * `afterProminence` (survivors + width-rejected) entered the width gate. */
function gateSets(trace: PipelineTrace): { notDistance: DetectedPeak[]; afterProminence: DetectedPeak[] } {
  const all = trace.detected.all;
  return {
    notDistance: all.filter((d) => d.passed || d.rejectReason !== 'distance'),
    afterProminence: all.filter(
      (d) => d.passed || (d.rejectReason !== 'distance' && d.rejectReason !== 'prominence'),
    ),
  };
}

/** Rows for one Run stage, keyed by the PF stage id (Phase 3). Every PF Run stage is a
 * detection+ stage now (the pre-detection previews left the Run walkthrough), so there is
 * no empty pre-detection case. Row DATA is unchanged; only which subset shows and how each
 * row is annotated differs per stage. */
export function derivePeakFinderTableRows(
  trace: PipelineTrace,
  stageId: string,
): PeakFinderTableRow[] {
  const rows = deriveStageRows(trace, stageId);
  // #6: guarantee strictly channel-ascending at every stage -- not incidental on the
  // trace's production order. Replaces the old survivors-first `passFirst` reorder, so
  // an advancing/rejected candidate stays IN PLACE (resultKind still drives styling)
  // instead of jumping up/down the table as it advances. Same set of rows, only order.
  return [...rows].sort((a, b) => a.channel - b.channel);
}

/** The per-stage row set BEFORE the shared channel-ascending sort. Row DATA is
 * unchanged from the pre-#6 code; only the survivors-first reorder is gone. */
function deriveStageRows(trace: PipelineTrace, stageId: string): PeakFinderTableRow[] {
  const { notDistance, afterProminence } = gateSets(trace);
  switch (stageId) {
    case 'local-maxima':
      // Every local maximum -- all are candidates at this pre-gate stage.
      return trace.detected.all.map((d) => gateRow(d, null));
    case 'distance':
      return trace.detected.all.map((d) => gateRow(d, 'distance'));
    case 'prominence':
      return notDistance.map((d) => gateRow(d, 'prominence'));
    case 'width':
      return afterProminence.map((d) => gateRow(d, 'width'));
    case 'strength':
      return trace.detected.survivors.map(strengthRow);
    case 'classification':
      return trace.detected.survivors.map(classificationRow);
    case 'fit': {
      // Fit: kept + guard-rejected fits plus the unfittable survivors -- the full
      // three-way partition so the funnel math is visible (GAP-07 honesty). The outer
      // channel sort interleaves the unfittable rows into channel order.
      const fits = trace.fitted.all.map(fittedRow);
      const unfittable = trace.fitted.unfittable.map(
        (u): PeakFinderTableRow => ({
          channel: Math.round(u.detectedChannel),
          fwhmChannels: null,
          netArea: null,
          chiSquare: null,
          result: `unfittable: ${u.reason}`,
          resultKind: 'drop',
          detail: [],
        }),
      );
      return [...fits, ...unfittable];
    }
    case 'validated':
    default:
      // Validated (also the Review table): every validate verdict; a flagged peak lists
      // its flags, never silently dropped (RISK-04).
      return trace.validated.map((v) => ({
        ...fittedRow(v.peak),
        result: v.valid ? 'Valid' : v.flags.length ? v.flags.join(', ') : 'not valid',
        resultKind: v.valid ? 'pass' : ('drop' as const),
      }));
  }
}

// --- count strip (progressive funnel legibility) ------------------------------

/** One-line funnel strip above the stage table. Counts are contract fields
 * (`peakCount` / `rejectedFitCount` / `unfittableCount`) or trace-partition
 * lengths; the only arithmetic is the flagged remainder. */
export function peakFinderCountStrip(
  trace: PipelineTrace,
  status: SpectrumStatus,
  stageId: string,
): string {
  const { notDistance, afterProminence } = gateSets(trace);
  const all = trace.detected.all.length;
  const survivors = trace.detected.survivors.length;
  switch (stageId) {
    case 'local-maxima':
      return `${all} local ${all === 1 ? 'maximum' : 'maxima'} found`;
    case 'distance':
      return `${all} candidates → ${notDistance.length} pass the distance gate`;
    case 'prominence':
      return `${notDistance.length} candidates → ${afterProminence.length} pass the prominence gate`;
    case 'width':
      return `${afterProminence.length} candidates → ${survivors} survive the width gate`;
    case 'strength':
      return `${survivors} ${survivors === 1 ? 'survivor' : 'survivors'} measured`;
    case 'classification': {
      const line = trace.detected.survivors.filter((d) => d.classification === 'line').length;
      return `${survivors} survivors → ${line} line · ${survivors - line} broad/weak`;
    }
    case 'fit':
      return (
        `${survivors} survivors → ${trace.fitted.kept.length} fitted · ` +
        `${status.rejectedFitCount} rejected · ${status.unfittableCount} unfittable`
      );
    case 'validated': {
      const flagged = trace.validated.length - status.peakCount;
      return `${trace.fitted.kept.length} fitted → ${status.peakCount} valid · ${flagged} flagged`;
    }
    default:
      return '';
  }
}

// --- section markup -----------------------------------------------------------

const COLUMNS = ['Channel', 'FWHM', 'Net Area', 'Chi-square', 'Result'] as const;
const DASH = '—'; // "--" display for absent values

function fmt1(v: number): string {
  return v.toFixed(1);
}

function fmtCell(v: number | null, digits: number): string {
  return v == null ? DASH : v.toFixed(digits);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

/** The per-stage table section: heading + funnel strip + the five-column table
 * (or the honest pre-detection empty state). Selection is marked on the row whose
 * integer channel equals `selectedChannel` (the shared inspector selection key).
 * Each data row is followed by a hidden `.pf-detail` drawer row (chevron-toggled)
 * carrying the secondary measurements + the inspector's fate line. */
export function peakFinderTableSectionMarkup(
  trace: PipelineTrace,
  status: SpectrumStatus,
  stageId: string,
  selectedChannel: number | null,
  interactive = true,
  sort: PeakFinderTableSort = DEFAULT_TABLE_SORT,
  filter: PeakFinderTableFilter = DEFAULT_TABLE_FILTER,
): string {
  const head = `<h3 class="pf-table-title">Peak table</h3>`;
  // Phase 3: every PF Run stage is a detection+ stage with rows (the pre-detection
  // previews left the Run walkthrough), so there is no empty pre-detection branch.
  // Render order (#8 → #7): derive → filter (hide by resultKind) → sort the visible set.
  const rows = sortRows(filterRows(derivePeakFinderTableRows(trace, stageId), filter), sort);
  const strip = peakFinderCountStrip(trace, status, stageId);
  const thead = `<thead><tr>${COLUMNS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>`;
  // Honest empty state: a filter can legitimately hide every row (e.g. no rejected
  // candidates at this gate). Say so rather than showing a blank table.
  const empty =
    rows.length === 0
      ? `<tr class="pf-row-empty"><td colspan="${COLUMNS.length}" class="muted">${
          filter === 'rejected'
            ? 'No rejected candidates at this stage.'
            : filter === 'advancing'
              ? 'No advancing candidates at this stage.'
              : 'No candidates at this stage.'
        }</td></tr>`
      : '';
  const body = rows
    .map((r) => {
      const selected = selectedChannel != null && r.channel === selectedChannel;
      // Inert while running: no data-channel/tabindex (the row handler keys off
      // `.pf-row[data-channel]`, so it never wires), the leading cell is a plain
      // channel number (no chevron), and the detail drawer row is omitted.
      if (!interactive) {
        return `<tr class="pf-row pf-row--${r.resultKind} is-locked">
          <td>${r.channel}</td>
          <td>${fmtCell(r.fwhmChannels, 1)}</td>
          <td>${r.netArea == null ? DASH : Math.round(r.netArea).toLocaleString()}</td>
          <td>${fmtCell(r.chiSquare, 2)}</td>
          <td class="pf-result">${escapeHtml(r.result)}</td>
        </tr>`;
      }
      const items = r.detail
        .map(
          (d) =>
            `<span class="pf-detail-item"><span class="pf-detail-k">${escapeHtml(d.label)}</span> ${escapeHtml(d.value)}</span>`,
        )
        .join('');
      const fate = escapeHtml(describeCandidateFate(trace, r.channel));
      return `<tr class="pf-row pf-row--${r.resultKind}${selected ? ' is-selected' : ''}"
          data-channel="${r.channel}" tabindex="0">
          <td><button class="pf-expand" type="button" aria-expanded="false"
            aria-label="Toggle details for channel ${r.channel}">▸</button>${r.channel}</td>
          <td>${fmtCell(r.fwhmChannels, 1)}</td>
          <td>${r.netArea == null ? DASH : Math.round(r.netArea).toLocaleString()}</td>
          <td>${fmtCell(r.chiSquare, 2)}</td>
          <td class="pf-result">${escapeHtml(r.result)}</td>
        </tr>
        <tr class="pf-detail" hidden>
          <td colspan="${COLUMNS.length}">${items}<span class="pf-detail-fate muted">${fate}</span></td>
        </tr>`;
    })
    .join('');
  return `
    <div class="pf-table-section card">
      ${head}
      <p class="pf-count-strip muted">${strip}</p>
      <table class="review-table pf-table">
        ${thead}
        <tbody>${empty}${body}</tbody>
      </table>
    </div>`;
}

// --- honest state surface (P3, 4a) ---------------------------------------------

/** The honest, state-aware Review outcome block. Pure over the status contract
 * (Principle 9): every figure is a `status.*` field, never recomputed, and no
 * branch contains energy wording (Peak Finder is channel space only). The full
 * six-stage reveal always plays before this lands (operator ruling) -- so the
 * funnel + the tables' Result column have already shown the per-peak reasons;
 * this block gives the honest one-look framing over the top, it does not restate
 * every row.
 *
 * The four states come from {@link deriveSpectrumStatus}:
 *  - healthy: valid peaks were found.
 *  - empty:   the pipeline ran but nothing survived the gates.
 *  - anomaly: candidates / fits were found but hit problems (unfittable /
 *             guard-rejected / none-valid) -- the per-peak reasons are in the
 *             tables' Result column. May coexist with peakCount > 0.
 *  - failure: a peak-evidence stage errored (defensive -- see below).
 *
 * // Failure channels (reconciliation, not a merge): in practice a thrown engine
 * // fault reaches the UI through the manager's `error` phase
 * // (peakFinderErrorMarkup), because the orchestrator lets a stage throw rather
 * // than recording a failed-but-present report. This `failure` branch is the
 * // DEFENSIVE surface for a report that DID return but whose trace marks a
 * // peak-stage error -- kept honest and distinct from the throw path. */
export function peakFinderStateMarkup(status: SpectrumStatus, fileName: string): string {
  const file = escapeHtml(fileName);
  const tail = 'Peak positions are channel indices.';
  const seeResult = "See the Result column in the stage tables for each peak's reason.";
  let title: string;
  let detail: string;
  switch (status.state) {
    case 'healthy':
      title = `${status.peakCount} validated ${status.peakCount === 1 ? 'peak' : 'peaks'} in ${file}.`;
      detail = tail;
      break;
    case 'empty':
      title = `Detection ran through all six stages but found no peaks in ${file}.`;
      detail = `Nothing passed the prominence, distance, and width gates. ${tail}`;
      break;
    case 'anomaly':
      title = `Detection completed with issues in ${file} — ${escapeHtml(status.label)}.`;
      detail =
        (status.peakCount > 0
          ? `${status.peakCount} ${status.peakCount === 1 ? 'peak' : 'peaks'} validated; `
          : 'No peaks validated; ') +
        `${status.unfittableCount} unfittable, ${status.rejectedFitCount} rejected. ${seeResult}`;
      break;
    case 'failure':
    default:
      title = `Detection could not complete for ${file}.`;
      detail = status.failingStage
        ? `It failed at the ${escapeHtml(status.failingStage)} stage; later stages did not run.`
        : 'A detection stage did not complete.';
      break;
  }
  return `
    <div class="pf-state pf-state--${status.state}">
      <p class="pf-state-title">${title}</p>
      <p class="pf-state-detail muted">${detail}</p>
    </div>`;
}

// --- Review summary + detect settings ------------------------------------------

/** The five Review summary figures, all contract-derived (hand-off 4e). */
export interface PeakFinderSummary {
  readonly channelsAnalyzed: number;
  readonly initialCandidates: number;
  readonly fittedCount: number;
  /** `status.peakCount` -- the canonical valid-validated count; NOT recomputed. */
  readonly validatedCount: number;
  /** Measured milliseconds summed over the run's pipeline stages (see MEASURED). */
  readonly processingMs: number;
}

/** The stages whose measured `durationMs` make up "processing time": the five
 * stages the run actually executes (load -> condition -> detect -> fit ->
 * validate). The downstream stages (calibrate/identify/quantify) are recorded
 * `skipped` with 0 ms and the report stage is bookkeeping -- both excluded. */
const MEASURED_STAGES: readonly StageName[] = ['load', 'condition', 'detect', 'fit', 'validate'];

export function derivePeakFinderSummary(
  trace: PipelineTrace,
  status: SpectrumStatus,
  stageTrace: readonly StageTrace[],
): PeakFinderSummary {
  return {
    channelsAnalyzed: trace.channels.length,
    initialCandidates: trace.detected.all.length,
    fittedCount: trace.fitted.kept.length,
    validatedCount: status.peakCount,
    processingMs: stageTrace
      .filter((t) => MEASURED_STAGES.includes(t.stage))
      .reduce((sum, t) => sum + t.durationMs, 0),
  };
}

/** Compact summary panel (Review, on top). Reuses the `.cfg-recap` label/value
 * grid for visual consistency with the other modes' recap panels. */
export function peakFinderSummaryMarkup(s: PeakFinderSummary): string {
  const ms = s.processingMs < 10 ? s.processingMs.toFixed(1) : String(Math.round(s.processingMs));
  return `
    <dl class="cfg-recap pf-summary">
      <div><dt>Channels analyzed</dt><dd>${s.channelsAnalyzed.toLocaleString()}</dd></div>
      <div><dt>Initial candidates</dt><dd>${s.initialCandidates}</dd></div>
      <div><dt>Successfully fitted</dt><dd>${s.fittedCount}</dd></div>
      <div><dt>Final validated</dt><dd>${s.validatedCount}</dd></div>
      <div><dt>Processing time</dt><dd>${ms} ms</dd></div>
    </dl>`;
}

/** The effective detect settings block (Review, bottom): the gates THIS run used
 * (`trace.constants` carries the effective per-run settings, DEBT-27 -- never the
 * module defaults). Read-only by design: tunable controls are PARK-13. */
export function peakFinderDetectSettingsMarkup(constants: PipelineTrace['constants']): string {
  return `
    <div class="pf-settings card">
      <h3 class="pf-table-title">Detect settings this run used</h3>
      <dl class="cfg-recap">
        <div><dt>Prominence</dt><dd>${constants.prominence}</dd></div>
        <div><dt>Min distance</dt><dd>${constants.distance} ch</dd></div>
        <div><dt>Min width</dt><dd>${constants.minWidth} ch</dd></div>
        <div><dt>Rel height</dt><dd>${constants.relHeight}</dd></div>
      </dl>
    </div>`;
}
