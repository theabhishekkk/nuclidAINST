/**
 * Stage 9 -- Identify report (I3): the presentation-DATA layer for the I2
 * fingerprint result. Pure, no rendering — M4's chart/UI consumes these shapes.
 *
 *   - {@link buildOverlay}            matched library lines as drawable markers
 *   - {@link summarizeIdentification} a concise "what is this?" + trustworthiness caveats
 *   - {@link exportIdentificationJson} the full result, round-trippable
 *   - {@link exportIdentificationCsv}  two practical tables (isotopes + peaks)
 *
 * Trustworthiness caveats surface the I2 deviations (see identify.ts): a top match
 * that is single-line (less robust) or relies on a detector-artifact-flagged peak
 * (511/escape) is flagged so a consumer sees the nuance — I3 surfaces them, it does
 * not re-litigate I2's scoring.
 */
import type {
  EnergisedPeak,
  IdentificationResult,
  IdentificationSummary,
  IsotopeMatch,
  OverlayMarker,
} from '../domain/types';
import { FLAG_MISSING_STRONG, FLAG_SINGLE_LINE } from './identify';

// --- caveat tokens (named, documented) --------------------------------------
/** Top match has a single required line — a single hit is weaker evidence. */
export const CAVEAT_SINGLE_LINE = 'top-match-single-line';
/** Top match relies on a peak flagged as a 511/escape detector artifact. */
export const CAVEAT_ARTIFACT_PEAK = 'top-match-uses-artifact-peak';
/** Top match is missing one or more of its strong (required) lines. */
export const CAVEAT_MISSING_STRONG = 'top-match-missing-strong-lines';

// --- CSV column orders (documented, stable) ---------------------------------
/** Ranked-isotope table columns. `matchedLines`/`totalLines` = matched required
 * lines over the isotope's full library line count. */
export const CSV_ISOTOPE_COLUMNS = [
  'rank',
  'isotope',
  'displayName',
  'score',
  'completeness',
  'coverage',
  'verdict',
  'matchedLines',
  'totalLines',
  'flags',
] as const;
/** Peak table columns. */
export const CSV_PEAK_COLUMNS = [
  'channel',
  'energyKeV',
  'energyErrorKeV',
  'fwhmKeV',
  'netArea',
  'significance',
  'classification',
  'inValidRange',
  'matchedIsotopes',
  'artifactFlags',
] as const;

// --- helpers ----------------------------------------------------------------

/** The set of measured peaks carrying any artifact flag (by object identity,
 * since I2 threads the same EnergisedPeak objects through matchedLines). */
function artifactPeakSet(result: IdentificationResult): Set<EnergisedPeak> {
  const set = new Set<EnergisedPeak>();
  for (const pf of result.peakFlags) if (pf.flags.length) set.add(pf.peak);
  return set;
}

/** Pick the isotope to overlay: the named one, else the top-ranked, else null. */
function pickIsotope(result: IdentificationResult, isotopeId?: string): IsotopeMatch | null {
  if (isotopeId != null) return result.ranked.find((m) => m.nuclide.id === isotopeId) ?? null;
  return result.ranked[0] ?? null;
}

// --- B. chart-overlay data --------------------------------------------------

/**
 * Drawable markers for one isotope's matched lines (default: the top match).
 * One marker per matched line, linked to the measured peak it matched. Returns
 * `[]` when the chosen isotope is absent or has no matched lines.
 */
export function buildOverlay(result: IdentificationResult, isotopeId?: string): OverlayMarker[] {
  const iso = pickIsotope(result, isotopeId);
  if (!iso) return [];
  const artifacts = artifactPeakSet(result);
  return iso.matchedLines.map((m) => ({
    energyKeV: m.line.energyKeV,
    intensity: m.line.intensity,
    isotopeId: iso.nuclide.id,
    measuredChannel: m.measured.peak.centroidChannel,
    measuredEnergyKeV: m.measured.energyKeV,
    deltaKeV: m.deltaKeV,
    isArtifact: artifacts.has(m.measured),
  }));
}

// --- D. summary -------------------------------------------------------------

/** A concise summary of the identification with trustworthiness caveats. */
export function summarizeIdentification(result: IdentificationResult): IdentificationSummary {
  const top = result.ranked[0] ?? null;
  const strongCount = result.ranked.filter((m) => m.verdict === 'STRONG').length;
  const tentativeCount = result.ranked.filter((m) => m.verdict === 'TENTATIVE').length;

  const caveats: string[] = [];
  if (top) {
    if (top.flags.includes(FLAG_SINGLE_LINE)) caveats.push(CAVEAT_SINGLE_LINE);
    if (top.flags.includes(FLAG_MISSING_STRONG)) caveats.push(CAVEAT_MISSING_STRONG);
    const artifacts = artifactPeakSet(result);
    if (top.matchedLines.some((m) => artifacts.has(m.measured))) caveats.push(CAVEAT_ARTIFACT_PEAK);
  }

  return {
    top: top
      ? {
          isotopeId: top.nuclide.id,
          displayName: top.nuclide.displayName,
          verdict: top.verdict,
          score: top.score,
        }
      : null,
    strongCount,
    tentativeCount,
    caveats,
  };
}

// --- C. export: JSON --------------------------------------------------------

/** The full identification as pretty JSON. Plain data ⇒ JSON.parse round-trips
 * it back to an equal structure. */
export function exportIdentificationJson(result: IdentificationResult): string {
  return JSON.stringify(result, null, 2);
}

// --- C. export: CSV ---------------------------------------------------------

/** Quote a CSV cell iff it contains a comma, quote, CR or LF; doubling quotes. */
function csvCell(value: string | number | boolean): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvRow(cells: readonly (string | number | boolean)[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * Two CSV tables in one string: a ranked-isotope table then a peak table,
 * separated by a blank line. Each section is preceded by a `# name` comment.
 * `matchedLines`/`totalLines` = matched required lines over the isotope's full
 * library line count. The peak table's `matchedIsotopes`/`artifactFlags` join
 * multiple values with `;`.
 */
export function exportIdentificationCsv(
  result: IdentificationResult,
  peaks: readonly EnergisedPeak[],
): string {
  // Map each measured peak -> the isotopes whose required lines it matched.
  const matchedBy = new Map<EnergisedPeak, string[]>();
  for (const iso of result.ranked) {
    for (const m of iso.matchedLines) {
      const list = matchedBy.get(m.measured) ?? [];
      if (!list.includes(iso.nuclide.id)) list.push(iso.nuclide.id);
      matchedBy.set(m.measured, list);
    }
  }
  const flagsBy = new Map<EnergisedPeak, readonly string[]>();
  for (const pf of result.peakFlags) flagsBy.set(pf.peak, pf.flags);

  const isotopeLines: string[] = ['# isotopes', csvRow(CSV_ISOTOPE_COLUMNS)];
  result.ranked.forEach((iso, i) => {
    isotopeLines.push(
      csvRow([
        i + 1,
        iso.nuclide.id,
        iso.nuclide.displayName,
        iso.score,
        iso.completeness,
        iso.coverage,
        iso.verdict,
        iso.matchedLines.length,
        iso.nuclide.lines.length,
        iso.flags.join(';'),
      ]),
    );
  });

  const peakLines: string[] = ['# peaks', csvRow(CSV_PEAK_COLUMNS)];
  for (const p of peaks) {
    peakLines.push(
      csvRow([
        p.peak.centroidChannel,
        p.energyKeV,
        p.energyErrorKeV,
        p.fwhmKeV,
        p.peak.netArea,
        p.peak.significance,
        p.peak.classification,
        p.inValidRange,
        (matchedBy.get(p) ?? []).join(';'),
        (flagsBy.get(p) ?? []).join(';'),
      ]),
    );
  }

  return [...isotopeLines, '', ...peakLines].join('\n') + '\n';
}
