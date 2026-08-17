/**
 * peakFinderReviewStats -- data-led derivations behind the Peak Finder "Detected Peaks" FINAL
 * REVIEW page (`review`, the last step). This page performs NO additional processing: it
 * consolidates the already-computed pipeline results into a single scientific report
 * (Principle 9). Every figure here is read verbatim off, or a pure roll-up of, the engine's
 * committed trace -- nothing re-runs detection, fitting, or validation, so the reference-parity
 * fixtures stay byte-identical.
 *
 * Sibling of {@link module:peakFinderValidationStats}: where that module reads the SELECTED
 * peak's validation verdict for the mid-pipeline Validate stage, this module rolls the WHOLE
 * validated set into the spectrum-level statistics, quality summary, per-peak table rows (with
 * a plain-language Remarks reason), the processing report, and the calibration-readiness gate.
 *
 * CHANNEL SPACE ONLY: `energyKeV` is calibration-only and is NEVER read here (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate). Inputs are PLAIN DATA -- never a
 * manager or a report -- so the derivations stay pure and unit-testable.
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
export interface ReviewStatPair {
  readonly label: string;
  readonly value: string;
}

/** One classification tally for the Peak Quality Summary. */
export interface ReviewQualityRow {
  readonly classification: string;
  readonly count: number;
}

/** One row of the Final Peak Table. `channel` is the integer detection channel and doubles as
 * the row key / chart-selection channel; `kind` drives the pass/flag row colour + the filter. */
export interface ReviewPeakRow {
  readonly id: number;
  readonly channel: number;
  readonly fwhm: string;
  readonly netArea: string;
  readonly chi: string;
  readonly status: 'Accepted' | 'Flagged';
  readonly kind: 'pass' | 'drop';
  readonly remark: string;
}

const NA = '—';

/** Capitalise a classification token for display (`broad` -> `Broad`). */
function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Locale-stable integer/decimal grouping. */
function fmt(v: number, maxFrac = 0): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

/** The plain-language Remarks phrase per validation flag token -- the scientific reason behind a
 * peak's final status, NOT a restatement of the status. Accepted peaks get the pass phrase; a
 * flagged peak joins the phrases for the specific rules it failed. */
const FLAG_REMARK: Readonly<Record<string, string>> = {
  [FLAG_WEAK]: 'Low significance',
  [FLAG_BROAD]: 'Broad peak',
  [FLAG_INVALID_FWHM]: 'Invalid FWHM',
  [FLAG_WIDE_FWHM]: 'FWHM too wide',
  [FLAG_INVALID_CENTROID_ERROR]: 'Invalid centroid error',
  [FLAG_LARGE_CENTROID_ERROR]: 'Excessive centroid error',
  [FLAG_POOR_FIT]: 'Invalid χ²',
};

/** The Remarks reason for one peak: the pass phrase when valid, else the joined failed-rule
 * phrases (falling back to the raw token for any unmapped flag, and to a generic phrase when a
 * peak is flagged with no tokens). */
export function remarkForPeak(valid: boolean, flags: readonly string[]): string {
  if (valid) return 'Passed all validation checks';
  if (flags.length === 0) return 'Review recommended';
  return flags.map((f) => FLAG_REMARK[f] ?? f).join(' · ');
}

/** Count of ACCEPTED (valid) validated peaks -- the canonical figure the calibration gate reads. */
export function acceptedPeakCount(validated: readonly ValidatedPeak[]): number {
  return validated.reduce((n, v) => n + (v.valid ? 1 : 0), 0);
}

/** Calibration-readiness gate: energy calibration needs at least TWO accepted peaks to fit a
 * channel->energy line; with fewer, the Peak Finder workflow ends here. */
export const MIN_CALIBRATION_PEAKS = 2;
export function canProceedToCalibration(validated: readonly ValidatedPeak[]): boolean {
  return acceptedPeakCount(validated) >= MIN_CALIBRATION_PEAKS;
}

/** Plain-data input for {@link derivePeakStatistics}. `survivors` is the count of detection
 * candidates that passed every gate (the honest "detected" figure -- NOT the raw local-maxima
 * count, which is thousands of noise ripples). */
export interface PeakStatisticsInput {
  readonly validated: readonly ValidatedPeak[];
  readonly survivors: number;
}

/**
 * Peak Statistics (§1): the immediate scientific summary of the detected + validated peaks.
 * "Total Detected" = survivors (gate-passing candidates); "Validated" = accepted; "Rejected" =
 * everything detected that did not end up accepted (unfittable + flagged), so Detected =
 * Validated + Rejected exactly. Strongest / Weakest are the highest / lowest amplitude ACCEPTED
 * peaks; Largest Net Area + Average FWHM aggregate the accepted set. `—` when nothing accepted.
 */
export function derivePeakStatistics(input: PeakStatisticsInput): readonly ReviewStatPair[] {
  const { validated, survivors } = input;
  const accepted = validated.filter((v) => v.valid).map((v) => v.peak);
  const acceptedCount = accepted.length;
  const detected = Math.max(survivors, validated.length);
  const rejected = Math.max(detected - acceptedCount, 0);
  const rate = detected > 0 ? `${Math.round((acceptedCount / detected) * 100)}%` : NA;

  let strongest = NA;
  let weakest = NA;
  let largestArea = NA;
  let avgFwhm = NA;
  if (acceptedCount > 0) {
    const byAmp = [...accepted].sort((a, b) => a.amplitude - b.amplitude);
    weakest = `ch ${Math.round(byAmp[0].detectedChannel)}`;
    strongest = `ch ${Math.round(byAmp[byAmp.length - 1].detectedChannel)}`;
    largestArea = fmt(Math.max(...accepted.map((p) => p.netArea)));
    const finiteFwhm = accepted.map((p) => p.fwhmChannels).filter((w) => Number.isFinite(w));
    if (finiteFwhm.length > 0)
      avgFwhm = `${(finiteFwhm.reduce((s, w) => s + w, 0) / finiteFwhm.length).toFixed(2)} ch`;
  }

  return [
    { label: 'Total Detected Peaks', value: fmt(detected) },
    { label: 'Validated Peaks', value: fmt(acceptedCount) },
    { label: 'Rejected Peaks', value: fmt(rejected) },
    { label: 'Acceptance Rate', value: rate },
    { label: 'Strongest Peak', value: strongest },
    { label: 'Weakest Peak', value: weakest },
    { label: 'Largest Net Area', value: largestArea },
    { label: 'Average FWHM', value: avgFwhm },
  ];
}

/** Plain-data input for {@link deriveSpectrumStatistics}. */
export interface SpectrumStatisticsInput {
  readonly raw: readonly number[];
  readonly background: readonly number[] | null;
  readonly liveTimeSec: number | null;
}

/**
 * Spectrum Statistics (§2): the character of the analysed spectrum, all read/summed off the raw
 * counts + the estimated continuum (no engine re-run). Dynamic range is max/min over the
 * non-empty channels (a spectrum spanning many decades has a large range). Average Background is
 * the mean of the estimated continuum; Acquisition Time comes from the parsed metadata live-time
 * (may be absent -> `—`).
 */
export function deriveSpectrumStatistics(
  input: SpectrumStatisticsInput,
): readonly ReviewStatPair[] {
  const { raw, background, liveTimeSec } = input;
  const n = raw.length;
  let total = 0;
  let max = 0;
  let minNonZero = Infinity;
  for (const v of raw) {
    total += v;
    if (v > max) max = v;
    if (v > 0 && v < minNonZero) minNonZero = v;
  }
  const dynamic =
    n === 0 || max === 0
      ? NA
      : `${fmt(Math.round(max / (Number.isFinite(minNonZero) ? minNonZero : 1)))} : 1`;
  const avgBg =
    background && background.length > 0
      ? fmt(background.reduce((s, v) => s + v, 0) / background.length)
      : NA;

  return [
    { label: 'Total Counts', value: fmt(total) },
    { label: 'Number of Channels', value: fmt(n) },
    { label: 'Maximum Counts', value: fmt(max) },
    { label: 'Dynamic Range', value: dynamic },
    { label: 'Average Background', value: avgBg },
    { label: 'Acquisition Time', value: liveTimeSec != null ? `${fmt(liveTimeSec, 1)} s` : NA },
  ];
}

/** Peak Quality Summary (§3): the classification tally over EVERY validated peak (Line / Broad /
 * Weak), in a fixed order so the table never reshuffles. */
export function derivePeakQuality(
  validated: readonly ValidatedPeak[],
): readonly ReviewQualityRow[] {
  const order = ['line', 'broad', 'weak'] as const;
  const counts = new Map<string, number>(order.map((c) => [c, 0]));
  for (const v of validated) {
    const c = v.peak.classification;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return order.map((c) => ({ classification: capitalise(c), count: counts.get(c) ?? 0 }));
}

/** Final Peak Table rows (§4): one row per validated peak, stable Peak IDs by ascending detected
 * channel (independent of any display sort), with a plain-language Remarks reason. Every value is
 * read verbatim off the `FittedPeak` -- no recompute. */
export function deriveReviewPeakRows(
  validated: readonly ValidatedPeak[],
): readonly ReviewPeakRow[] {
  const byChannel = [...validated].sort(
    (a, b) => a.peak.detectedChannel - b.peak.detectedChannel,
  );
  return byChannel.map((v, i) => {
    const p = v.peak;
    return {
      id: i + 1,
      channel: Math.round(p.detectedChannel),
      fwhm: Number.isFinite(p.fwhmChannels) ? p.fwhmChannels.toFixed(1) : NA,
      netArea: Number.isFinite(p.netArea) ? fmt(p.netArea) : NA,
      chi: p.chiSquare == null ? NA : fmt(p.chiSquare, 2),
      status: v.valid ? 'Accepted' : 'Flagged',
      kind: v.valid ? 'pass' : 'drop',
      remark: remarkForPeak(v.valid, v.flags),
    };
  });
}

/** Processing Report (§6): a concise plain-scientific-language summary of the completed run. */
export function buildProcessingReport(validated: readonly ValidatedPeak[]): string {
  const accepted = acceptedPeakCount(validated);
  const total = validated.length;
  if (total === 0) {
    return (
      'The spectrum was processed through continuum estimation, candidate detection, Gaussian ' +
      'fitting, and peak validation, but no peaks satisfied the validation criteria. There is ' +
      'nothing to hand off to energy calibration.'
    );
  }
  const acceptedWord = accepted === 1 ? 'peak' : 'peaks';
  const readiness =
    accepted >= MIN_CALIBRATION_PEAKS
      ? 'and are ready for downstream energy calibration.'
      : `; at least ${MIN_CALIBRATION_PEAKS} accepted peaks are required before energy calibration, so the workflow ends here.`;
  return (
    'The spectrum was successfully processed through continuum estimation, candidate detection, ' +
    `Gaussian fitting, and peak validation. ${fmt(accepted)} of ${fmt(total)} measured ` +
    `${acceptedWord} satisfied all validation criteria ${readiness}`
  );
}

// --- Export builders (§8) -----------------------------------------------------

/** RFC-4180 CSV cell: quote + escape when the value contains a comma, quote, or newline. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Peak Table CSV export (§8): the Final Peak Table, one row per validated peak. Values are the
 * SAME pre-formatted display strings the table shows, so the export matches the screen exactly. */
export function buildPeaksCsv(rows: readonly ReviewPeakRow[]): string {
  const header = ['Peak ID', 'Channel', 'FWHM (ch)', 'Net Area', 'Chi-Square', 'Status', 'Remarks'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [String(r.id), String(r.channel), r.fwhm, r.netArea, r.chi, r.status, r.remark]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\r\n');
}

/** Peak List export (§8): a plain, one-line-per-accepted-peak channel list -- the minimal
 * hand-off a downstream tool needs (accepted peaks only, ascending channel). */
export function buildPeakList(rows: readonly ReviewPeakRow[]): string {
  return rows
    .filter((r) => r.kind === 'pass')
    .map((r) => `${r.channel}`)
    .join('\n');
}

/** Analysis JSON export (§8): the structured Final Peak Table for machine hand-off. */
export function buildPeaksJson(rows: readonly ReviewPeakRow[]): string {
  return JSON.stringify(
    {
      schema: 'nuclid.peak-finder.review/1',
      peaks: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        fwhm: r.fwhm,
        netArea: r.netArea,
        chiSquare: r.chi,
        status: r.status,
        remark: r.remark,
      })),
    },
    null,
    2,
  );
}
