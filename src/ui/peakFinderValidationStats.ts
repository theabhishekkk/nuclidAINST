/**
 * peakFinderValidationStats -- data-led derivations behind the "Validate Peaks" Run stage
 * (`validated` / `run-7`, the final Run stage, Finalize group).
 *
 * Sibling of {@link module:peakFinderFitStats}, but where the Peak Fitting page reads the fit of
 * the selected peak, this page reads the ALREADY-computed VALIDATION VERDICT of every fitted peak
 * -- the {@link ValidatedPeak} list the engine produced in `pipeline/validate.ts` and stored on
 * the trace (`trace.validated`). Pure presentation over already-computed data (Principle 9): NOTHING
 * re-runs validation -- there is no call into `validate.ts` here, so the committed reference-parity
 * fixtures stay byte-identical. `app.ts` calls this and only RENDERS the returned structures.
 *
 * HONESTY BOUNDARY (D-1): the four checklist rules are a ROLL-UP of the engine's seven flag tokens.
 * χ² is judged for FINITENESS ONLY -- `FittedPeak.chiSquare` is the total weighted SSR over the fit
 * window (not a reduced χ²), so there is deliberately NO goodness-of-fit magnitude cut (RISK-02).
 * The χ² rule is therefore labelled "Numerically Valid", never "acceptable". No value here is
 * recomputed or modified; the metrics are read verbatim off the selected `FittedPeak`.
 *
 * D-2: the statistics describe the fitted peaks that REACHED validation (`trace.validated`);
 * guard-rejected fits and unfittable survivors never get a `ValidatedPeak`, so the caller passes the
 * upstream `survivors` / `fitted` counts and this builds an honest funnel that shows the drop-off
 * rather than hiding it.
 *
 * CHANNEL SPACE ONLY: `energyKeV` is calibration-only and is NEVER read here (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate).
 *
 * Inputs are passed as PLAIN DATA -- never a manager or a report -- so the derivations stay pure and
 * unit-testable, and cannot perturb the engine or its fixtures.
 */

import type { ValidatedPeak } from '../domain/types';
import {
  FLAG_BROAD,
  FLAG_INVALID_CENTROID_ERROR,
  FLAG_INVALID_FWHM,
  FLAG_LARGE_CENTROID_ERROR,
  FLAG_POOR_FIT,
  FLAG_WEAK,
  FLAG_WIDE_FWHM,
} from '../pipeline/validate';

/** One label/value pair for a `.cfg-recap` stat card (value pre-formatted for display). */
export interface ValStatPair {
  readonly label: string;
  readonly value: string;
}

/** One row of the Validation Checklist (§2): a rolled-up rule + its pass/fail verdict + a short
 * fail detail ("Broad" / "Too wide" / ...), empty when the rule passed. */
export interface ValChecklistItem {
  readonly rule: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** One row of the Validation Report (§12): a check + status + a plain-language explanation. */
export interface ValReportRow {
  readonly check: string;
  readonly passed: boolean;
  readonly explanation: string;
}

/** Everything the "Validate Peaks" stage's cards need, derived PURELY from
 * {@link ValidationStatsInput}. Selection-dependent fields (summary / checklist / metrics /
 * decision / report) describe the SELECTED peak; the statistics + funnel are global. */
export interface ValidationStats {
  /** Is a peak selected (vs the empty-state placeholder)? */
  readonly hasSelection: boolean;
  /** The selected peak's overall verdict (`false` in the empty state). */
  readonly selectedValid: boolean;
  // --- Validation Summary (§1) ------------------------------------------------
  readonly statusText: string;
  readonly decisionText: string;
  readonly reasonText: string;
  // --- Validation Checklist (§2, centrepiece) ---------------------------------
  readonly checklist: readonly ValChecklistItem[];
  // --- Validation Metrics (§3) ------------------------------------------------
  readonly metrics: readonly ValStatPair[];
  // --- Validation Decision (§4) -----------------------------------------------
  readonly decisionReason: string;
  // --- Validation Statistics (§5) ---------------------------------------------
  readonly statistics: readonly ValStatPair[];
  readonly funnel: string;
  // --- Validation Report (§12) ------------------------------------------------
  readonly report: readonly ValReportRow[];
}

/** Plain-data input for {@link deriveValidationStats}. */
export interface ValidationStatsInput {
  /** Every fitted peak's validation verdict (`trace.validated`). */
  readonly validated: readonly ValidatedPeak[];
  /** The currently selected verdict, or `null` when nothing is selected. */
  readonly selected: ValidatedPeak | null;
  /** Detection survivors count (for the honest funnel, D-2). */
  readonly survivors: number;
  /** Kept-fit count (for the honest funnel, D-2). */
  readonly fitted: number;
}

const NA = '—';

/** Capitalise a classification token for display (`broad` -> `Broad`). */
function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** χ² verbatim: locale-stable, up to 2 fractional digits, thousands-grouped. */
function fmtChi(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Human phrase per flag token, for the Summary reason line (§1). */
const FLAG_PHRASE: Readonly<Record<string, string>> = {
  [FLAG_WEAK]: 'Weak peak',
  [FLAG_BROAD]: 'Broad peak',
  [FLAG_INVALID_FWHM]: 'Invalid FWHM',
  [FLAG_WIDE_FWHM]: 'FWHM too wide',
  [FLAG_INVALID_CENTROID_ERROR]: 'Invalid centroid error',
  [FLAG_LARGE_CENTROID_ERROR]: 'Large centroid error',
  [FLAG_POOR_FIT]: 'Non-finite χ²',
};

/**
 * Pure derivation for the "Validate Peaks" (`validated` / `run-7`) educational stage. Every returned
 * figure is either read verbatim off the selected verdict / peak or an honest roll-up of the
 * engine's flags -- no engine call, no fixture touch (Principle 9). See {@link ValidationStats}.
 */
export function deriveValidationStats(input: ValidationStatsInput): ValidationStats {
  const { validated, selected, survivors, fitted } = input;

  // --- global statistics (§5), always computed -------------------------------
  const total = validated.length;
  const accepted = validated.reduce((n, v) => n + (v.valid ? 1 : 0), 0);
  const flagged = total - accepted;
  const rate = total > 0 ? `${Math.round((accepted / total) * 100)}%` : NA;
  const statistics: ValStatPair[] = [
    { label: 'Total Peaks', value: total.toLocaleString('en-US') },
    { label: 'Accepted', value: accepted.toLocaleString('en-US') },
    { label: 'Flagged', value: flagged.toLocaleString('en-US') },
    { label: 'Acceptance Rate', value: rate },
  ];
  const funnel =
    `${survivors.toLocaleString('en-US')} survivors → ` +
    `${fitted.toLocaleString('en-US')} fitted → ` +
    `${total.toLocaleString('en-US')} validated → ` +
    `${accepted.toLocaleString('en-US')} accepted`;

  // --- empty state (no selection) --------------------------------------------
  const emptyChecklist: ValChecklistItem[] = [
    { rule: 'Classification = Line', passed: false, detail: NA },
    { rule: 'FWHM Acceptable', passed: false, detail: NA },
    { rule: 'Centroid Error Acceptable', passed: false, detail: NA },
    { rule: 'χ² Numerically Valid', passed: false, detail: NA },
  ];
  if (!selected) {
    return {
      hasSelection: false,
      selectedValid: false,
      statusText: NA,
      decisionText: NA,
      reasonText: 'Select a peak to see its validation.',
      checklist: emptyChecklist,
      metrics: [
        { label: 'Classification', value: NA },
        { label: 'FWHM', value: NA },
        { label: 'Centroid Error', value: NA },
        { label: 'χ²', value: NA },
      ],
      decisionReason: 'Select a peak in the chart or table to see why it was accepted or flagged.',
      statistics,
      funnel,
      report: [
        { check: 'Classification', passed: false, explanation: NA },
        { check: 'Peak Width', passed: false, explanation: NA },
        { check: 'Centroid Error', passed: false, explanation: NA },
        { check: 'χ²', passed: false, explanation: NA },
      ],
    };
  }

  // --- a selected verdict ----------------------------------------------------
  const peak = selected.peak;
  const flags = selected.flags;
  const has = (f: string): boolean => flags.includes(f);

  // Roll the seven flag tokens into the four checklist rules (§2 / §4 mapping).
  const classFail = has(FLAG_WEAK) || has(FLAG_BROAD);
  const fwhmFail = has(FLAG_INVALID_FWHM) || has(FLAG_WIDE_FWHM);
  const ceFail = has(FLAG_INVALID_CENTROID_ERROR) || has(FLAG_LARGE_CENTROID_ERROR);
  const chiFail = has(FLAG_POOR_FIT);

  const checklist: ValChecklistItem[] = [
    {
      rule: 'Classification = Line',
      passed: !classFail,
      detail: has(FLAG_BROAD) ? 'Broad' : has(FLAG_WEAK) ? 'Weak' : '',
    },
    {
      rule: 'FWHM Acceptable',
      passed: !fwhmFail,
      detail: has(FLAG_INVALID_FWHM) ? 'Invalid' : has(FLAG_WIDE_FWHM) ? 'Too wide' : '',
    },
    {
      rule: 'Centroid Error Acceptable',
      passed: !ceFail,
      detail: has(FLAG_INVALID_CENTROID_ERROR)
        ? 'Invalid'
        : has(FLAG_LARGE_CENTROID_ERROR)
          ? 'Too large'
          : '',
    },
    { rule: 'χ² Numerically Valid', passed: !chiFail, detail: chiFail ? 'Non-finite' : '' },
  ];

  const reasonText = selected.valid
    ? 'All validation checks passed.'
    : flags.map((f) => FLAG_PHRASE[f] ?? f).join(' · ');

  const metrics: ValStatPair[] = [
    { label: 'Classification', value: capitalise(peak.classification) },
    { label: 'FWHM', value: `${peak.fwhmChannels.toFixed(2)} ch` },
    {
      label: 'Centroid Error',
      value: Number.isFinite(peak.centroidError)
        ? `± ${peak.centroidError.toFixed(2)} ch (1σ)`
        : NA,
    },
    { label: 'χ²', value: peak.chiSquare === null ? NA : fmtChi(peak.chiSquare) },
  ];

  const decisionReason = selected.valid
    ? 'Peak satisfies all quality requirements and may be used for calibration and radionuclide identification.'
    : `Peak flagged — ${reasonText}. Not suitable for downstream analysis.`;

  const report: ValReportRow[] = [
    {
      check: 'Classification',
      passed: !classFail,
      explanation: classFail
        ? `Classified as ${capitalise(peak.classification)}`
        : 'Classified as Line',
    },
    {
      check: 'Peak Width',
      passed: !fwhmFail,
      explanation: has(FLAG_INVALID_FWHM)
        ? 'Invalid width'
        : has(FLAG_WIDE_FWHM)
          ? 'Wider than expected'
          : 'Within expected detector resolution',
    },
    {
      check: 'Centroid Error',
      passed: !ceFail,
      explanation: has(FLAG_INVALID_CENTROID_ERROR)
        ? 'Centroid could not be localised'
        : has(FLAG_LARGE_CENTROID_ERROR)
          ? 'Exceeds the uncertainty limit'
          : 'Meets uncertainty requirements',
    },
    {
      check: 'χ²',
      passed: !chiFail,
      explanation: chiFail ? 'Non-finite — numerically invalid fit' : 'Fit numerically valid',
    },
  ];

  return {
    hasSelection: true,
    selectedValid: selected.valid,
    statusText: selected.valid ? 'PASSED' : 'FLAGGED',
    decisionText: selected.valid ? 'Accepted' : 'Rejected',
    reasonText,
    checklist,
    metrics,
    decisionReason,
    statistics,
    funnel,
    report,
  };
}
