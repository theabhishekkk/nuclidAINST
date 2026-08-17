/**
 * Fail-loud loader for the operator's *identify* library (`gamma_library.csv`).
 *
 * This is the "what an unknown can be identified as" dataset (Identify, I2/M3) --
 * kept deliberately separate from the *calibration kit* (the "known sources we
 * calibrate from", see `src/data/calibrationKit.ts`).
 *
 * Trust posture mirrors `parse.ts` (RISK-04): a malformed row throws rather than
 * being silently dropped, so a corrupted reference file can never masquerade as a
 * smaller-but-plausible library.
 *
 * CSV shape (header + comma-delimited rows; `#` comment lines allowed):
 *
 *     Nuclide,Energy_keV,Intensity_%
 *     Cs137,661.657,85.10
 *
 * Conversions applied:
 *   - Nuclide token -> canonical `Sym-Mass` id (`Cs137` -> `Cs-137`), matching the
 *     rest of the domain (`nuclideHintFromName`, the calibration kit).
 *   - Intensity percent -> fraction (`/100`) to populate `GammaLine.intensity`
 *     (`p_gamma`). NOTE: the type documents `[0, 1]`, but annihilation lines such
 *     as Na-22's 511 keV legitimately exceed 100% per decay (179.8% -> 1.798).
 *     We do NOT clamp -- clamping would fabricate a wrong emission probability.
 *     We validate only finiteness and non-negativity. (See GAP note in F3.)
 */
import type { GammaLine, NuclideEntry, NuclideLibrary } from '../domain/types';
import { ParseError } from '../domain/errors';

/** Default in-app location of the identify library (served from `public/`). */
export const GAMMA_LIBRARY_URL = `${import.meta.env.BASE_URL}sample-data/gamma_library.csv`;

const EXPECTED_COLUMNS = 3;

/** `Cs137` / `cs-137` / `Co57` -> canonical `Cs-137` / `Co-57`. Throws if it is
 * not a recognizable `<symbol><mass>` token. */
function canonicalNuclideId(token: string, lineNo: number): string {
  const m = /^([A-Za-z]{1,2})-?(\d{1,3})$/.exec(token.trim());
  if (!m) {
    throw new ParseError(
      `Line ${lineNo}: "${token}" is not a recognizable nuclide id (expected like "Cs137").`,
    );
  }
  const sym = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return `${sym}-${m[2]}`;
}

function toFiniteNumber(token: string, field: string, lineNo: number): number {
  const n = Number(token.trim());
  if (token.trim() === '' || !Number.isFinite(n)) {
    throw new ParseError(`Line ${lineNo}: ${field} "${token}" is not a finite number.`);
  }
  return n;
}

/**
 * Parse identify-library CSV text into a typed `NuclideLibrary`.
 *
 * Pure and synchronous (the testable core). Skips `#` comments and the header
 * row, groups rows by nuclide, and preserves source order of both nuclides and
 * their lines. Any malformed row throws `ParseError`.
 */
export function parseGammaLibrary(csvText: string): NuclideLibrary {
  const rows = csvText.split(/\r?\n/);
  // Preserve first-seen order of nuclides while grouping their lines.
  const order: string[] = [];
  const byId = new Map<string, GammaLine[]>();
  let seenHeader = false;

  for (let i = 0; i < rows.length; i++) {
    const lineNo = i + 1;
    const raw = rows[i].trim();
    if (raw.length === 0 || raw.startsWith('#')) continue;

    // The first non-comment row is the header (`Nuclide,Energy_keV,Intensity_%`).
    if (!seenHeader) {
      seenHeader = true;
      continue;
    }

    const cols = raw.split(',').map((c) => c.trim());
    if (cols.length !== EXPECTED_COLUMNS) {
      throw new ParseError(
        `Line ${lineNo}: expected ${EXPECTED_COLUMNS} columns (Nuclide,Energy_keV,Intensity_%), got ${cols.length}.`,
      );
    }

    const id = canonicalNuclideId(cols[0], lineNo);
    const energyKeV = toFiniteNumber(cols[1], 'energy', lineNo);
    const intensityPct = toFiniteNumber(cols[2], 'intensity', lineNo);
    if (energyKeV <= 0) {
      throw new ParseError(`Line ${lineNo}: energy ${energyKeV} keV must be positive.`);
    }
    if (intensityPct < 0) {
      throw new ParseError(`Line ${lineNo}: intensity ${intensityPct}% must be non-negative.`);
    }

    const line: GammaLine = { energyKeV, intensity: intensityPct / 100 };
    let lines = byId.get(id);
    if (!lines) {
      lines = [];
      byId.set(id, lines);
      order.push(id);
    }
    lines.push(line);
  }

  if (order.length === 0) {
    throw new ParseError('No nuclide rows found in the gamma library.');
  }

  const entries: NuclideEntry[] = order.map((id) => ({
    id,
    // The CSV carries no full name; the canonical id is the honest display value.
    displayName: id,
    // Half-life is not in the identify CSV; it belongs to quantification, not ID.
    halfLifeSec: null,
    lines: byId.get(id)!,
  }));

  return { entries };
}

/**
 * Fetch and parse the identify library from `public/` in the running app.
 * Fails loud on a non-OK HTTP response or any malformed row.
 */
export async function loadGammaLibrary(url: string = GAMMA_LIBRARY_URL): Promise<NuclideLibrary> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new ParseError(`Failed to fetch gamma library from "${url}": HTTP ${res.status}.`);
  }
  return parseGammaLibrary(await res.text());
}
