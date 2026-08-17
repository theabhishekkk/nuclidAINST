/**
 * Stage 6 -- Identify (I2): whole-isotope fingerprint identification.
 *
 * A faithful port of the reference `gamma_identify.py` (Gamma Spectroscopy Suite)
 * scoring core — steps 4–6 (match → score → artifact-flag → rank). Steps 1–3
 * (peak extraction → centroid refinement → channel→energy) are already done by
 * the v4 chain detect → fit → applyCalibration (I1), so I2 consumes the resulting
 * {@link EnergisedPeak}[] directly rather than a TKA path.
 *
 * The decisive evidence for an isotope is its whole fingerprint, not one hit:
 *   score = √(completeness × coverage)
 *   completeness = Σ(matched required-line intensity) / Σ(required-line intensity)
 *   coverage     = Σ(matched-peak significance)      / Σ(all-peak significance)
 * "required" = a line whose intensity ≥ {@link DEFAULT_REQUIRED_FRAC} × the
 * isotope's strongest in-range line; weaker lines are "bonus" (matched as extra
 * confirmation but excluded from completeness). Identity comes only from energies
 * + the library (Rule 12); general over N isotopes / N peaks (RISK-02).
 *
 * Adaptive tolerance (per measured peak): max({@link DEFAULT_ENERGY_TOLERANCE_KEV},
 * {@link DEFAULT_FRAC_FWHM} × peak.fwhmKeV) — wider for broad (high-energy) peaks.
 *
 * Artifact flags (511 keV annihilation, single/double escape) are ported from the
 * reference `tag_artifacts`. IMPORTANT (and a deliberate parity choice): the
 * reference only TAGS such peaks — it does NOT remove them from matching or
 * scoring. We do the same (flag-only). Excluding artifact peaks from scoring would
 * diverge from the reference and from `_identify_ground_truth.json`. The handoff's
 * "so an escape peak isn't counted as a real line" is therefore surfaced as a flag
 * for I3/UI to act on, not enforced here. See {@link ARTIFACTS_ARE_FLAG_ONLY}.
 *
 * Verdict (reference `print_identification`): STRONG iff the top isotope has
 * score > {@link STRONG_SCORE_THRESHOLD}, completeness ≥
 * {@link STRONG_COMPLETENESS_THRESHOLD}, and a clear top-2 gap
 * (best > {@link CLEAR_GAP_FACTOR} × runner-up, or runner-up <
 * {@link CLEAR_RUNNER_CEILING}); else TENTATIVE iff score >
 * {@link TENTATIVE_SCORE_THRESHOLD}; else WEAK. Only the rank-0 isotope is
 * eligible for STRONG (the reference concludes a single winner); lower-ranked
 * isotopes get TENTATIVE/WEAK by score. Note the reference allows a single-line
 * isotope (e.g. Cs-137) to be STRONG — multi-line is flagged ('single-line') but
 * never required.
 */
import type {
  EnergisedPeak,
  GammaLine,
  IdentificationResult,
  IdentificationVerdict,
  IsotopeMatch,
  MatchedLine,
  NuclideEntry,
  NuclideLibrary,
  PeakArtifactFlags,
} from '../domain/types';

// --- named thresholds, ported from gamma_identify.py ------------------------

/** Energy match floor, keV (reference `energy_tol=3.0`). */
export const DEFAULT_ENERGY_TOLERANCE_KEV = 3.0;
/** Fraction of a peak's FWHM(keV) that widens the match tolerance (reference
 * `frac_fwhm=0.20`); applied tol = max(floor, frac·fwhmKeV). */
export const DEFAULT_FRAC_FWHM = 0.2;
/** A line counts as "required" iff its intensity ≥ this × the isotope's strongest
 * in-range line (reference `required_frac=0.15`); weaker lines are bonus. */
export const DEFAULT_REQUIRED_FRAC = 0.15;
/** Isotopes scoring at or below this are dropped from the ranking (reference
 * `min_score=0.10`). */
export const DEFAULT_MIN_SCORE = 0.1;

/** STRONG requires score strictly above this (reference `> 0.55`). */
export const STRONG_SCORE_THRESHOLD = 0.55;
/** STRONG requires completeness at least this (reference `>= 0.6`). */
export const STRONG_COMPLETENESS_THRESHOLD = 0.6;
/** Above this (and not STRONG) ⇒ TENTATIVE; at/below ⇒ WEAK (reference `> 0.35`). */
export const TENTATIVE_SCORE_THRESHOLD = 0.35;
/** Top-2 "clear" gap: best must beat runner-up by this factor (reference `1.5`). */
export const CLEAR_GAP_FACTOR = 1.5;
/** ...OR the runner-up must be below this for the top to be "clear" (reference `0.35`). */
export const CLEAR_RUNNER_CEILING = 0.35;
/** strongest-present check half-width: max(energy_tol, this × strongest.energy)
 * (reference `0.2 * strongest.energy`). */
export const STRONGEST_PRESENT_FRAC = 0.2;

/** Artifact match half-width, keV (reference `tag_artifacts(tol=8.0)`). */
export const ARTIFACT_TOLERANCE_KEV = 8.0;
/** A peak must exceed this significance to seed escape peaks (reference `> 20`). */
export const ARTIFACT_STRONG_MIN_SIGNIFICANCE = 20;
/** ...and exceed this energy (keV) to seed escape peaks (reference `> 1100`). */
export const ARTIFACT_STRONG_MIN_ENERGY_KEV = 1100;
/** Electron rest mass, keV: the 511 annihilation line and single-escape offset. */
export const ANNIHILATION_ENERGY_KEV = 511.0;
/** Double-escape offset, keV (2 × 511). */
export const DOUBLE_ESCAPE_OFFSET_KEV = 1022.0;

/** Documents the parity choice: artifact flagging is informational only and does
 * not exclude a peak from matching/scoring (matches the reference). */
export const ARTIFACTS_ARE_FLAG_ONLY = true as const;

/** Per-peak artifact flag tokens. */
export const FLAG_ANNIHILATION = '511-annihilation';
export const FLAG_SINGLE_ESCAPE = 'single-escape';
export const FLAG_DOUBLE_ESCAPE = 'double-escape';
/** Per-isotope flag tokens. */
export const FLAG_SINGLE_LINE = 'single-line';
export const FLAG_MISSING_STRONG = 'missing-strong-lines';
export const FLAG_STRONGEST_ABSENT = 'strongest-line-absent';

export interface IdentifyOptions {
  /** Energy match floor, keV. Default {@link DEFAULT_ENERGY_TOLERANCE_KEV}. */
  readonly energyToleranceKeV?: number;
  /** FWHM fraction widening the tolerance. Default {@link DEFAULT_FRAC_FWHM}. */
  readonly fracFwhm?: number;
  /** Required-line intensity fraction. Default {@link DEFAULT_REQUIRED_FRAC}. */
  readonly requiredFrac?: number;
  /** Score floor for inclusion. Default {@link DEFAULT_MIN_SCORE}. */
  readonly minScore?: number;
  /** STRONG score threshold. Default {@link STRONG_SCORE_THRESHOLD}. */
  readonly strongScore?: number;
  /** STRONG completeness threshold. Default {@link STRONG_COMPLETENESS_THRESHOLD}. */
  readonly strongCompleteness?: number;
  /** TENTATIVE/WEAK boundary. Default {@link TENTATIVE_SCORE_THRESHOLD}. */
  readonly tentativeScore?: number;
  /** Artifact match half-width, keV. Default {@link ARTIFACT_TOLERANCE_KEV}. */
  readonly artifactToleranceKeV?: number;
  /**
   * The spectrum's energy span [emin, emax], keV — library lines outside it are
   * not "in range" (an isotope is not penalised for a line it could not observe).
   * Reference uses calib.energy over [0, nchan-1]. When omitted, derived from the
   * peak energy span (documented fallback; pass the calibrated span for fidelity).
   */
  readonly energyRange?: readonly [number, number];
}

// --- step 4: adaptive-tolerance matching ------------------------------------

/** Nearest measured peak to `lineEnergy` within its adaptive tolerance, else
 * null. Ported from `_match_tolerance`: tol = max(floor, frac·peak.fwhmKeV);
 * strictly-nearest (first peak wins exact ties given energy-ascending order). */
function matchTolerance(
  lineEnergy: number,
  peaks: readonly EnergisedPeak[],
  energyTol: number,
  fracFwhm: number,
): { peak: EnergisedPeak; deltaKeV: number; toleranceKeV: number } | null {
  let best: EnergisedPeak | null = null;
  let bestD = Infinity;
  let bestTol = 0;
  for (const p of peaks) {
    const tol = Math.max(energyTol, fracFwhm * p.fwhmKeV);
    const d = Math.abs(p.energyKeV - lineEnergy);
    if (d <= tol && d < bestD) {
      best = p;
      bestD = d;
      bestTol = tol;
    }
  }
  return best ? { peak: best, deltaKeV: best.energyKeV - lineEnergy, toleranceKeV: bestTol } : null;
}

// --- step 5: per-isotope scoring (port of score_isotope) --------------------

function scoreIsotope(
  nuclide: NuclideEntry,
  peaks: readonly EnergisedPeak[],
  emin: number,
  emax: number,
  totalStrength: number,
  energyTol: number,
  fracFwhm: number,
  requiredFrac: number,
): Omit<IsotopeMatch, 'verdict'> {
  const empty: Omit<IsotopeMatch, 'verdict'> = {
    nuclide,
    completeness: 0,
    coverage: 0,
    score: 0,
    matchedLines: [],
    flags: [],
  };

  const inRange = nuclide.lines.filter((l) => l.energyKeV >= emin && l.energyKeV <= emax);
  if (!inRange.length) return empty;

  const imax = Math.max(...inRange.map((l) => l.intensity));
  const required = inRange.filter((l) => l.intensity >= requiredFrac * imax);
  const weak = inRange.filter((l) => l.intensity < requiredFrac * imax);

  const matchedLines: MatchedLine[] = [];
  const missing: GammaLine[] = [];
  let matchedIntensity = 0;
  let explainedStrength = 0;
  for (const line of required) {
    const hit = matchTolerance(line.energyKeV, peaks, energyTol, fracFwhm);
    if (hit) {
      matchedLines.push({
        line,
        measured: hit.peak,
        deltaKeV: hit.deltaKeV,
        toleranceKeV: hit.toleranceKeV,
      });
      matchedIntensity += line.intensity;
      explainedStrength += hit.peak.peak.significance;
    } else {
      missing.push(line);
    }
  }

  // Bonus (weak) lines: the reference matches them too (marking the peak), but
  // they never enter completeness/coverage. We match for parity of side effects
  // only; the result is unused here.
  for (const line of weak) {
    matchTolerance(line.energyKeV, peaks, energyTol, fracFwhm);
  }

  const reqIntensity = required.reduce((s, l) => s + l.intensity, 0);
  const completeness = reqIntensity ? matchedIntensity / reqIntensity : 0;
  const coverage = totalStrength ? explainedStrength / totalStrength : 0;

  const strongest = inRange.reduce((a, b) => (b.intensity > a.intensity ? b : a));
  const strongestHalfWidth = Math.max(energyTol, STRONGEST_PRESENT_FRAC * strongest.energyKeV);
  const strongestPresent = matchedLines.some(
    (m) => Math.abs(strongest.energyKeV - m.measured.energyKeV) <= strongestHalfWidth,
  );

  const score = Math.sqrt(Math.max(completeness, 0) * Math.max(coverage, 0));

  const flags: string[] = [];
  if (required.length === 1) flags.push(FLAG_SINGLE_LINE);
  if (missing.length) flags.push(FLAG_MISSING_STRONG);
  if (!strongestPresent) flags.push(FLAG_STRONGEST_ABSENT);

  return { nuclide, completeness, coverage, score, matchedLines, flags };
}

// --- step 6: detector-artifact flags (port of tag_artifacts) ----------------

/** Per-peak artifact flags. Mirrors `tag_artifacts`: a peak near 511 keV is an
 * annihilation candidate; a peak near (strong − 511) / (strong − 1022) is a
 * single/double escape of that strong (>1100 keV, significant) line. */
function flagArtifacts(peaks: readonly EnergisedPeak[], artifactTol: number): PeakArtifactFlags[] {
  const strong = peaks.filter(
    (p) =>
      p.peak.significance > ARTIFACT_STRONG_MIN_SIGNIFICANCE &&
      p.energyKeV > ARTIFACT_STRONG_MIN_ENERGY_KEV,
  );
  return peaks
    .map((p) => {
      const flags: string[] = [];
      if (Math.abs(p.energyKeV - ANNIHILATION_ENERGY_KEV) <= artifactTol) {
        flags.push(FLAG_ANNIHILATION);
      }
      for (const s of strong) {
        if (Math.abs(p.energyKeV - (s.energyKeV - ANNIHILATION_ENERGY_KEV)) <= artifactTol) {
          flags.push(FLAG_SINGLE_ESCAPE);
        }
        if (Math.abs(p.energyKeV - (s.energyKeV - DOUBLE_ESCAPE_OFFSET_KEV)) <= artifactTol) {
          flags.push(FLAG_DOUBLE_ESCAPE);
        }
      }
      return { peak: p, flags };
    })
    .filter((pf) => pf.flags.length > 0);
}

// --- the public entry: match → score → rank → verdict -----------------------

/**
 * Identify the isotopes present in an unknown's energised peaks against the
 * library. Returns isotopes ranked best-first with a STRONG/TENTATIVE/WEAK
 * verdict, plus per-peak artifact flags. Empty/no-match ⇒ empty `ranked`
 * (fail-soft).
 */
export function identify(
  peaks: readonly EnergisedPeak[],
  library: NuclideLibrary,
  options: IdentifyOptions = {},
): IdentificationResult {
  const energyTol = options.energyToleranceKeV ?? DEFAULT_ENERGY_TOLERANCE_KEV;
  const fracFwhm = options.fracFwhm ?? DEFAULT_FRAC_FWHM;
  const requiredFrac = options.requiredFrac ?? DEFAULT_REQUIRED_FRAC;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const strongScore = options.strongScore ?? STRONG_SCORE_THRESHOLD;
  const strongCompleteness = options.strongCompleteness ?? STRONG_COMPLETENESS_THRESHOLD;
  const tentativeScore = options.tentativeScore ?? TENTATIVE_SCORE_THRESHOLD;
  const artifactTol = options.artifactToleranceKeV ?? ARTIFACT_TOLERANCE_KEV;

  // The reference matches against peaks sorted by energy (extract_peaks sorts);
  // sort here so tie-breaking is order-independent of the caller.
  const sorted = [...peaks].sort((a, b) => a.energyKeV - b.energyKeV);

  const peakFlags = flagArtifacts(sorted, artifactTol);

  const [emin, emax] = options.energyRange ?? deriveEnergyRange(sorted);
  const totalStrength = sorted.reduce((s, p) => s + p.peak.significance, 0) || 1.0;

  const scored = library.entries
    .map((nuclide) =>
      scoreIsotope(nuclide, sorted, emin, emax, totalStrength, energyTol, fracFwhm, requiredFrac),
    )
    .filter((m) => m.score > minScore)
    .sort((a, b) => b.score - a.score);

  // Verdict: only the clear top winner is eligible for STRONG (reference rule).
  const runnerScore = scored.length > 1 ? scored[1].score : 0;
  const ranked: IsotopeMatch[] = scored.map((m, i) => {
    let verdict: IdentificationVerdict;
    if (i === 0) {
      const clear = m.score > CLEAR_GAP_FACTOR * runnerScore || runnerScore < CLEAR_RUNNER_CEILING;
      if (m.score > strongScore && m.completeness >= strongCompleteness && clear) {
        verdict = 'STRONG';
      } else {
        verdict = m.score > tentativeScore ? 'TENTATIVE' : 'WEAK';
      }
    } else {
      verdict = m.score > tentativeScore ? 'TENTATIVE' : 'WEAK';
    }
    return { ...m, verdict };
  });

  return { ranked, peakFlags };
}

/** Fallback energy span when no calibrated range is supplied: the peak energy
 * min/max (an empty list ⇒ an empty range that admits no library line). */
function deriveEnergyRange(peaks: readonly EnergisedPeak[]): [number, number] {
  if (!peaks.length) return [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of peaks) {
    if (p.energyKeV < lo) lo = p.energyKeV;
    if (p.energyKeV > hi) hi = p.energyKeV;
  }
  return [lo, hi];
}
