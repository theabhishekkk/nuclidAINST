/**
 * Core domain types for the Nuclid gamma-spectroscopy pipeline.
 *
 * Design rule (RISK-02, element-agnostic by construction): every type is general.
 * No field is shaped to a specific isotope. A new source needs *data*, not a
 * rewrite. Cs-137 is a fixture, never a baked-in answer.
 *
 * A spectrum is a histogram: x = channel (or energy after calibration), y = counts.
 */

// ---------------------------------------------------------------------------
// Stage 1 -- Load
// ---------------------------------------------------------------------------

/** How a spectrum file was encoded. */
export type SpectrumFormat = 'tka' | 'csv';

/** Metadata recovered (or absent) from a spectrum file. Anything we cannot
 * trust from the file is marked optional and never assumed. */
export interface SpectrumMetadata {
  /** Original file name, kept for provenance. */
  readonly fileName: string;
  readonly format: SpectrumFormat;
  /** Detector live time in seconds (counting time, excludes dead time). */
  readonly liveTimeSec: number | null;
  /** Detector real (clock) time in seconds. */
  readonly realTimeSec: number | null;
  /** Number of channels (histogram bins). */
  readonly channelCount: number;
  /**
   * A nuclide *claimed* by the file name (e.g. "137Cs-..."), if any. This is an
   * UNTRUSTED hint shown for context only -- it is never fed into identification.
   */
  readonly statedNuclideHint: string | null;
  /** Size of the uploaded file in bytes, when known (null for programmatic input). */
  readonly fileSizeBytes: number | null;
  /** Detector name/model recovered from the file header, when present. */
  readonly detector: string | null;
  /** Sample / measurement label recovered from the file header, when present. */
  readonly sampleName: string | null;
  /**
   * Acquisition date/time from the file header: an ISO-8601 string when the raw
   * value was parseable, otherwise the raw trimmed header string. Null if absent.
   */
  readonly measurementDate: string | null;
}

/** A loaded spectrum: counts indexed by channel, plus metadata. */
export interface Spectrum {
  /** counts[c] = number of events recorded in channel c. Length = channelCount. */
  readonly counts: readonly number[];
  readonly metadata: SpectrumMetadata;
}

/** Dead-time fraction = 1 - live/real, in [0, 1). Null if times are unknown. */
export function deadTimeFraction(meta: SpectrumMetadata): number | null {
  if (meta.liveTimeSec == null || meta.realTimeSec == null) return null;
  if (meta.realTimeSec <= 0) return null;
  return 1 - meta.liveTimeSec / meta.realTimeSec;
}

// ---------------------------------------------------------------------------
// Stage 2 -- Condition (background + smoothing)
// ---------------------------------------------------------------------------

export interface ConditionedSpectrum {
  readonly source: Spectrum;
  /** Estimated background continuum per channel. */
  readonly background: readonly number[];
  /** source.counts - background, clamped at >= 0. */
  readonly netCounts: readonly number[];
  /** Net counts after smoothing -- used for detection only, never for areas. */
  readonly smoothed: readonly number[];
}

// ---------------------------------------------------------------------------
// Stage 3/4 -- Detect + Fit
// ---------------------------------------------------------------------------

/** A peak candidate located by a bare local-maximum scan (pre-fit). Kept as the
 * thin shape for raw maxima; detection now emits the richer {@link DetectedPeak}. */
export interface PeakCandidate {
  /** Channel of the local maximum. */
  readonly channel: number;
  /** Net counts at the candidate channel. */
  readonly height: number;
}

/**
 * Width-ratio / significance verdict for a detected peak, matching the reference
 * `classify_candidate` (`Calibration Mode.py`). The reference returns flag
 * strings; we carry the same three categories as identifiers:
 *   - `line`  <- "CANDIDATE LINE"                              (width ~ resolution, significant)
 *   - `broad` <- "broad - continuum/backscatter, NOT a line"  (width_ratio > 2)
 *   - `weak`  <- "weak - likely noise"                         (significance < 4)
 * The reference has NO "too narrow" category, so neither do we.
 */
export type PeakClass = 'line' | 'broad' | 'weak';

/**
 * The FIRST detection gate a local maximum failed, in the fixed scipy `find_peaks`
 * order distance -> prominence -> width (see {@link DetectedPeak.rejectReason}).
 * Present only on a rejected candidate; a survivor has none.
 */
export type DetectRejectReason = 'prominence' | 'distance' | 'width';

/**
 * Which fit guard rejected a Gaussian fit (see {@link FittedPeak.rejectReason}).
 * `'edge'` = the centroid left or pinned against its window; `'peak-hop'` = the
 * centroid drifted off the detected line onto a neighbour / Compton feature.
 */
export type FitRejectReason = 'peak-hop' | 'edge';

/**
 * Why a detection survivor produced NO usable Gaussian line at all -- distinct from
 * the peak-hop/edge rejected-with-line fits (those keep {@link FitRejectReason} and a
 * converged shape). `'too-few-points'` = window too small; `'no-convergence'` = the LM
 * did not converge; `'non-physical'` = non-positive amplitude / sigma at its bound;
 * `'degenerate'` = insufficient dof or a non-finite chi-square / centroid-error;
 * `'error'` = the per-survivor fit threw an exception that was caught inside the loop.
 */
export type FitFailureReason =
  | 'too-few-points'
  | 'no-convergence'
  | 'non-physical'
  | 'degenerate'
  | 'error';

/** A detection survivor that yielded no usable fit (the separate list -- NOT a
 * {@link FittedPeak}, which always carries a line). */
export interface UnfittableSurvivor {
  readonly detectedChannel: number;
  readonly reason: FitFailureReason;
}

/**
 * A peak located by detection (Stage 3), with everything the reference measures
 * about it. Richer than {@link PeakCandidate} because C2 (fit windows) and C3
 * (calibration anchors) need the width, sub-channel intersections and areas.
 *
 * RULE: `netArea`/`grossArea` come from the RAW counts and the (un-clipped)
 * net = counts - background, never the smoothed series. `height` is the only
 * field read off the smoothed detection series.
 */
export interface DetectedPeak {
  /** find_peaks index (plateau midpoint, floor). */
  readonly channel: number;
  /** Smoothed (savgol) height at the peak channel. */
  readonly height: number;
  /** FWHM in channels, from peak_widths @ rel_height 0.5. */
  readonly fwhmChannels: number;
  /** Sub-channel left half-maximum intersection. */
  readonly leftIp: number;
  /** Sub-channel right half-maximum intersection. */
  readonly rightIp: number;
  /** Topographic prominence of the peak in the smoothed series. */
  readonly prominence: number;
  /** Continuum-subtracted area over the peak window, from net counts. */
  readonly netArea: number;
  /** Raw area over the same window, from source counts. */
  readonly grossArea: number;
  /** netArea / sqrt(grossArea) -- the counting-statistics SNR. */
  readonly significance: number;
  /** Width a genuine line should have here, from the FWHM(ch) ~ k*sqrt(ch) model. */
  readonly expectedFwhmChannels: number;
  /** measured / expected FWHM (~1 for a real line). */
  readonly widthRatio: number;
  /** Verdict from {@link PeakClass}. */
  readonly classification: PeakClass;
  /**
   * Did this local maximum survive every detection gate? The post-gate survivors
   * (`passed === true`) are exactly {@link AnalysisReport.detectedCandidates}.
   * `detect` always stamps it and the inspector trace relies on it to bucket a
   * candidate as survivor vs rejected -- required so an untagged literal can no
   * longer silently bucket as a survivor (DEBT-28).
   */
  readonly passed: boolean;
  /** The FIRST gate this candidate failed -- present iff `passed === false`. */
  readonly rejectReason?: DetectRejectReason;
}

/** A fitted peak. Positions are in CHANNEL space until calibration runs.
 *
 * The trailing three fields are the C1 detection-quality signals carried through
 * the fit boundary (DEBT-09 resolved): the {@link ValidatedPeak} gate, calibrate's
 * anchor ranking and identify all need a fitted peak's classification/significance
 * without re-running detection. `fit` copies them verbatim from the originating
 * {@link DetectedPeak} -- pure provenance carry-through, no new fit math. */
export interface FittedPeak {
  /** Sub-channel centroid from the fit. */
  readonly centroidChannel: number;
  /**
   * 1-sigma uncertainty of {@link centroidChannel}, in channels, from the fit
   * covariance. Reported in the reference's `absolute_sigma=True` convention
   * (the Poisson variances are trusted, NOT rescaled by the fit's reduced chi-
   * square), so it matches `energy_calibration.fit_gaussian`'s `mu_err`. C3
   * calibration weights each anchor by `w = 1 / centroidError`.
   */
  readonly centroidError: number;
  readonly amplitude: number;
  /** Full width at half maximum, in channels. */
  readonly fwhmChannels: number;
  /** Net area under the peak (counts). */
  readonly netArea: number;
  /** Goodness of fit; lower is better. Null if not computed. */
  readonly chiSquare: number | null;
  /** Energy in keV -- populated only after calibration. */
  readonly energyKeV: number | null;
  /** Verdict carried from the originating {@link DetectedPeak} (C1, DEBT-09). */
  readonly classification: PeakClass;
  /** netArea/√grossArea from the originating {@link DetectedPeak} (C1). */
  readonly significance: number;
  /** Provenance: the integer {@link DetectedPeak.channel} this fit came from. */
  readonly detectedChannel: number;
  /**
   * Did this fit survive the peak-hop / edge guard? The kept fits (`status ===
   * 'kept'`) are exactly {@link AnalysisReport.peaks}. `fit` always stamps it and
   * the inspector trace relies on it to bucket a fit as kept vs rejected --
   * required so an untagged literal can no longer silently bucket as kept (DEBT-28).
   *
   * A `'rejected'` entry only appears in {@link AnalysisReport.allFitted}; it
   * carries the converged Gaussian shape (centroid/amplitude/FWHM/area) but
   * `chiSquare: null` and a non-finite {@link centroidError}, because the guard
   * rejects before the covariance-based statistics are computed.
   */
  readonly status: 'kept' | 'rejected';
  /** Which guard rejected this fit -- present iff `status === 'rejected'`. */
  readonly rejectReason?: FitRejectReason;
}

/**
 * Stage 5 -- Validate verdict for one fitted peak. A quality gate that keeps every
 * peak with its reason (RISK-04: flag, never silently drop). `valid` is true iff
 * the peak cleared both the classification gate (only a `'line'` proceeds) and the
 * fit-quality gate (finite, sane FWHM / centroid-error / chi-square). `flags` lists
 * every failed reason (e.g. `'weak'`, `'broad'`, `'wide-fwhm'`,
 * `'large-centroid-error'`, `'poor-fit'`); a valid peak has an empty `flags`. */
export interface ValidatedPeak {
  readonly peak: FittedPeak;
  readonly valid: boolean;
  readonly flags: readonly string[];
}

// ---------------------------------------------------------------------------
// Stage 5 -- Calibrate (channel -> energy)
// ---------------------------------------------------------------------------

/** One (channel, known-energy) anchor used to build a calibration.
 *
 * `channel`, `energyKeV` and `sourceLabel` are the original (pre-C3) shape and
 * stay required for backward compatibility. The remaining fields are the C3
 * additive provenance/weighting metadata (all optional so legacy callers and the
 * thin `fitCalibration` path are unaffected):
 *   - `centroidError`  the C2 1-σ centroid uncertainty; the weighted fit uses
 *                       `w = 1/centroidError`. Absent ⇒ the point is unweighted.
 *   - `sourceId`/`tier`/`reliable`  the operator-declared identity and the kit
 *                       line's role, kept on every matched point for the record.
 *   - `used`           did this point enter the final fit? `false` = unmatched,
 *                       peak-hopped, or σ-clip-pruned (see `note`).
 *   - `note`           human-readable provenance / drop reason.
 */
export interface CalibrationPoint {
  readonly channel: number;
  readonly energyKeV: number;
  /** Where this anchor came from, e.g. "Co-60 1173 keV". */
  readonly sourceLabel: string;
  /** 1-σ centroid uncertainty (channels) from C2; weight = 1/centroidError. */
  readonly centroidError?: number;
  /** Operator-declared kit identity this line came from, e.g. "Co-60". */
  readonly sourceId?: string;
  /** Calibration-kit tier of the line this point realises. */
  readonly tier?: LineTier;
  /** Kit `reliable` flag; an unreliable point is prunable by σ-clip. */
  readonly reliable?: boolean;
  /** Whether the point entered the final fit (false = unmatched/hopped/pruned). */
  readonly used?: boolean;
  /** Human-readable provenance or drop reason. */
  readonly note?: string;
}

/** The calibration record uses `'linear'|'quadratic'` (PORTING_PLAN §4); the
 * legacy `'polynomial'` is kept so the thin `fitCalibration(points, degree>2)`
 * path still types. The two-pass `calibrate` only ever emits `'linear'|'quadratic'`. */
export type CalibrationModel = 'linear' | 'quadratic' | 'polynomial';

/** A fitted channel->energy relationship. `coefficients` are ascending powers:
 * E = c[0] + c[1]*ch + c[2]*ch^2 + ...
 *
 * The metric/covariance/range fields are additive (optional): the two-pass C3
 * `calibrate` always populates them; persistence (C4) wraps this with `name`,
 * `sources` and `created`. */
export interface Calibration {
  readonly model: CalibrationModel;
  readonly coefficients: readonly number[];
  readonly points: readonly CalibrationPoint[];
  /** Coefficient of determination of the fit, in [0, 1]. */
  readonly rSquared: number;
  /** Coefficient covariance, in the SAME ascending-power order as `coefficients`
   * (covariance[k][k] is the variance of `coefficients[k]`). */
  readonly covariance?: readonly (readonly number[])[];
  /** RMS of the (unweighted) residuals, keV. */
  readonly rms?: number;
  /** Max |residual| over the (unweighted) residuals, keV. */
  readonly maxAbsResidual?: number;
  /** Calibrated energy span [minKeV, maxKeV] over the used points — do not trust
   * the equation far outside this range. */
  readonly validRange?: readonly [number, number];
}

/** Which equation `calibrate` marks active by default:
 * - `'linear'`    always the straight line.
 * - `'quadratic'` the quadratic when available (≥4 points), else fall back to linear.
 * - `'auto'`      the reference's curvature-significance choice (quadratic iff the
 *                 curvature term is ≥ 3σ from zero, and available), else linear.
 * The dev-phase default is `'auto'` so the active equation matches what the
 * reference Suite picks on the same data; the product default is an M4 decision. */
export type CalibrationModelPolicy = 'linear' | 'quadratic' | 'auto';

/** Intermediates the two-pass method produces en route to the equation, surfaced
 * for the staged walkthrough (display-only; never an input to any fit). Optional
 * so existing callers/serialisations are unaffected (additive — DESIGN.md §6). */
export interface CalibrationTrace {
  /** Pass-one preliminary scale E = a0 + b0·ch from the anchors. */
  readonly preliminary: { readonly a0: number; readonly b0: number };
  /** Per anchor line: rough gain = energyKeV / channel. Sorted by energyKeV.
   * Mirrors the reference `gain_profile` (Stage 2). */
  readonly gainProfile: readonly {
    readonly energyKeV: number;
    readonly channel: number;
    readonly gain: number; // keV per channel
  }[];
  /** Per pass-two (secondary) line: the prediction + window used to match it
   * (Stage 4). One entry per secondary line attempted. `outcome` restates the
   * pass-two matching branch taken; a `'used'` line may still be σ-clip-pruned
   * afterwards (its `result.linear.points` entry then reads `used:false`/`pruned`). */
  readonly secondaryWindows: readonly {
    readonly sourceId: string;
    readonly energyKeV: number;
    readonly predictedChannel: number;
    readonly halfWindow: number; // NaN when the off-scale branch skipped windowing
    readonly muTol: number;      // NaN when the off-scale branch skipped windowing
    readonly matchedChannel: number | null;
    readonly outcome: 'used' | 'hop-rejected' | 'off-scale' | 'no-peak';
  }[];
  /** σ(ch) ≈ ksig·√ch resolution coefficient used by pass two. */
  readonly ksig: number;
}

/** The full output of the two-pass `calibrate`: BOTH candidate equations (so the
 * M4 UI can offer a switch), the active selection, the policy that chose it, and
 * the curvature significance that drives `'auto'`. The `selected` field always
 * names an available candidate (a policy never selects an absent model). */
export interface CalibrationResult {
  /** The linear equation — always present once calibration succeeds. */
  readonly linear: Calibration;
  /** The quadratic equation — present only when ≥4 used points give an honest
   * covariance; `null` otherwise. */
  readonly quadratic: Calibration | null;
  /** The active equation: what {@link CalibrationResult.linear}/`.quadratic` to use. */
  readonly selected: 'linear' | 'quadratic';
  /** The requested policy ({@link CalibrationModelPolicy}). */
  readonly policy: CalibrationModelPolicy;
  /** `true` when the requested model was unavailable and the selection fell back
   * to linear (only reachable via the `'quadratic'` policy with <4 points). */
  readonly selectionFellBack: boolean;
  /** σ of the quadratic curvature term (0 when no quadratic was computed); drives
   * the `'auto'` choice and lets the UI explain why. */
  readonly curvatureSignificance: number;
  /** Display-only intermediates for the walkthrough; present when calibrate() runs
   * the two-pass path. Absent for `fitCalibration` direct fits. */
  readonly trace?: CalibrationTrace;
}

/**
 * Role of a calibration line in the two-pass fit (C3, M2).
 * - `anchor`: a strong, isolated line trusted to seed the channel->energy fit.
 * - `secondary`: a supporting line refined against / pruned by the anchors.
 */
export type LineTier = 'anchor' | 'secondary';

/**
 * A characteristic line of a *calibration-kit* source. Distinct from the identify
 * `GammaLine`: it carries the fit metadata (`tier`, `reliable`) the calibration
 * needs, and keeps the identify contract clean.
 */
export interface CalibrationLine {
  readonly energyKeV: number;
  readonly tier: LineTier;
  /** Rough relative emission probability (0-1), used for sizing/weighting only. */
  readonly intensity: number;
  /** `false` = weak or buried under a neighbour; prunable from the fit. */
  readonly reliable: boolean;
}

/** One known calibration source (a kit isotope) and its lines. */
export interface CalibrationKitEntry {
  readonly id: string;
  readonly displayName: string;
  readonly lines: readonly CalibrationLine[];
}

/** The set of known sources we calibrate *from* (the calibration kit). */
export interface CalibrationKit {
  readonly entries: readonly CalibrationKitEntry[];
}

/**
 * One scientist decision about a detected/fitted peak in Declare Identities.
 * MVP: manual assignment (Rule 12 -- identity is explicit human input).
 *
 * `calibrateFromMatches` consumes only `state === 'assigned'` entries (with a
 * finite `energyKeV`); `'excluded'`/`'unassigned'` entries are carried for UI
 * state and never enter a fit.
 */
export interface PeakAssignment {
  /** Stable id of the detected/fitted peak this decision is about (set by the
   * manager in Phase 2; opaque provenance to the Phase 1 engine). */
  readonly peakId: string;
  /** Fitted centroid (channels) from C2. */
  readonly centroidChannel: number;
  /** 1-σ centroid uncertainty (channels) from C2; forms the fit weight. Absent
   * ⇒ the point is unweighted (weight 1), matching {@link CalibrationPoint}. */
  readonly centroidError?: number;
  /** The scientist's decision. */
  readonly state: 'assigned' | 'excluded' | 'unassigned';
  /** Required iff `state === 'assigned'`: the energy line assigned to this peak. */
  readonly energyKeV?: number;
  /** Declared source id the assigned line came from (e.g. "Co-60"). */
  readonly sourceId?: string;
  /** Kit tier / reliability of the assigned line (carried for advisory σ-clip). */
  readonly tier?: LineTier;
  readonly reliable?: boolean;
}

// ---------------------------------------------------------------------------
// Stage 5b -- Apply calibration (channel centroids -> energies)
// ---------------------------------------------------------------------------

/**
 * One validated fitted peak after a calibration has been applied to it (I1, M3).
 * The bridge from "peaks in channel space" to "energies I2 can fingerprint": it
 * carries the mapped energy, a per-peak energy uncertainty propagated from the
 * fit's channel-centroid error, the peak's FWHM expressed in energy (for I2's
 * adaptive tolerance), and a valid-range flag.
 *
 * The originating {@link FittedPeak} is composed (not mutated) so every channel-
 * space field (centroid, error, area, classification, significance) travels with
 * its energy. Peaks outside {@link Calibration.validRange} are FLAGGED, never
 * dropped (RISK-04): an extrapolated energy is returned with `inValidRange:false`
 * so I2/I3 can weigh it accordingly.
 */
export interface EnergisedPeak {
  /** The validated fitted peak this energy was computed from (channel-space). */
  readonly peak: FittedPeak;
  /** Mapped energy E = cal(centroidChannel), keV. */
  readonly energyKeV: number;
  /**
   * 1-σ energy uncertainty, keV. Propagated from the fit's centroid error via the
   * calibration slope at this channel: σ_E ≈ |dE/dch| · centroidError. The
   * calibration-parameter (coefficient covariance) contribution is DEFERRED (see
   * {@link applyCalibration}); this is the centroid-error term only.
   */
  readonly energyErrorKeV: number;
  /** Peak FWHM expressed in energy: |dE/dch| · fwhmChannels, keV. */
  readonly fwhmKeV: number;
  /** `false` ⇔ {@link energyKeV} falls outside {@link Calibration.validRange}
   * (an extrapolated, less-trustworthy ID). `true` when in range, or when the
   * calibration declares no range. */
  readonly inValidRange: boolean;
}

// ---------------------------------------------------------------------------
// Stage 6 -- Identify (energies -> nuclide library)
// ---------------------------------------------------------------------------

/** A single characteristic gamma emission of a nuclide. */
export interface GammaLine {
  readonly energyKeV: number;
  /** Emission probability per decay (p_gamma), in [0, 1]. */
  readonly intensity: number;
}

/** One nuclide's signature. Data-driven: add an entry, not code. */
export interface NuclideEntry {
  /** Canonical id, e.g. "Cs-137". */
  readonly id: string;
  readonly displayName: string;
  /** Half-life in seconds, if known (used by quantification, not identification). */
  readonly halfLifeSec: number | null;
  readonly lines: readonly GammaLine[];
}

export interface NuclideLibrary {
  readonly entries: readonly NuclideEntry[];
}

/** A possible nuclide match for one measured energy. */
export interface MatchCandidate {
  readonly nuclide: NuclideEntry;
  readonly line: GammaLine;
  /** measured - library, in keV. */
  readonly deltaKeV: number;
  /** Confidence in [0, 1] from the tolerance window. */
  readonly confidence: number;
}

/** Identification result for one measured peak. */
export interface PeakIdentification {
  readonly measuredEnergyKeV: number;
  readonly candidates: readonly MatchCandidate[];
}

// --- I2 whole-isotope fingerprint identification ----------------------------
// Additive types for the fingerprint port of `gamma_identify.py`. The thin
// per-peak `PeakIdentification`/`MatchCandidate` above are RETAINED (the report
// and a future I3 overlay may still surface per-peak candidates); I2's `identify`
// returns the richer per-isotope {@link IdentificationResult}.

/** A whole-isotope identification confidence. Mirrors the reference
 * `print_identification` verdict (strong/tentative/weak), upper-cased. */
export type IdentificationVerdict = 'STRONG' | 'TENTATIVE' | 'WEAK';

/** One library line of an isotope that was matched to a measured peak. */
export interface MatchedLine {
  /** The library line that was matched. */
  readonly line: GammaLine;
  /** The measured peak that matched it. */
  readonly measured: EnergisedPeak;
  /** measured − library, keV. */
  readonly deltaKeV: number;
  /** The adaptive tolerance applied at this peak: max(tol, frac·fwhmKeV), keV. */
  readonly toleranceKeV: number;
}

/** Per-isotope fingerprint score (port of the reference `IsotopeScore`). */
export interface IsotopeMatch {
  readonly nuclide: NuclideEntry;
  /** Σ matched required-line intensity / Σ required-line intensity, in [0,1]. */
  readonly completeness: number;
  /** Σ matched-peak significance / total spectrum significance, in [0,1]. */
  readonly coverage: number;
  /** √(completeness × coverage). */
  readonly score: number;
  /** STRONG/TENTATIVE/WEAK per the reference thresholds + top-2 gap rule. */
  readonly verdict: IdentificationVerdict;
  /** The required lines that matched a measured peak. */
  readonly matchedLines: readonly MatchedLine[];
  /** Isotope-level flags, e.g. 'single-line', 'missing-strong-lines',
   * 'strongest-line-absent'. Informational; do not gate the score. */
  readonly flags: readonly string[];
}

/** A measured peak with any detector-artifact flags ('511-annihilation',
 * 'single-escape', 'double-escape'). Per the reference, artifact flagging is
 * informational and does NOT exclude the peak from matching/scoring. */
export interface PeakArtifactFlags {
  readonly peak: EnergisedPeak;
  readonly flags: readonly string[];
}

/** The full I2 identification: isotopes ranked best-first, plus per-peak
 * artifact flags. An empty `ranked` means nothing scored above the floor
 * (fail-soft — not an error). */
export interface IdentificationResult {
  readonly ranked: readonly IsotopeMatch[];
  readonly peakFlags: readonly PeakArtifactFlags[];
}

// --- I3 report / overlay / summary (presentation-data layer) ----------------
// Additive shapes the M4 UI consumes to render the identification. No rendering
// here — `buildOverlay`/`summarizeIdentification` (src/pipeline/identifyReport.ts)
// produce these from an {@link IdentificationResult}.

/** One library line of a chosen isotope, positioned for drawing over the
 * spectrum and linked to the measured peak that matched it (if any). */
export interface OverlayMarker {
  /** Library line energy, keV (where the marker is drawn on the energy axis). */
  readonly energyKeV: number;
  /** Library line intensity (emission probability), for sizing/labelling. */
  readonly intensity: number;
  /** The isotope this line belongs to. */
  readonly isotopeId: string;
  /** Channel of the matched measured peak, or null if the line is unmatched. */
  readonly measuredChannel: number | null;
  /** Energy of the matched measured peak, keV, or null if unmatched. */
  readonly measuredEnergyKeV: number | null;
  /** measured − library, keV, or null if unmatched. */
  readonly deltaKeV: number | null;
  /** True if the matched measured peak carries a detector-artifact flag
   * (511/escape) — the overlay can mark it as less trustworthy. */
  readonly isArtifact: boolean;
}

/** A concise "what is this?" summary of an identification, with trustworthiness
 * caveats surfaced for the I2 deviations (single-line / artifact-reliant top). */
export interface IdentificationSummary {
  /** The top-ranked isotope, or null when nothing matched. */
  readonly top: {
    readonly isotopeId: string;
    readonly displayName: string;
    readonly verdict: IdentificationVerdict;
    readonly score: number;
  } | null;
  /** How many ranked isotopes are STRONG. */
  readonly strongCount: number;
  /** How many ranked isotopes are TENTATIVE. */
  readonly tentativeCount: number;
  /** Trustworthiness caveats, e.g. 'top-match-single-line',
   * 'top-match-uses-artifact-peak', 'top-match-missing-strong-lines'. */
  readonly caveats: readonly string[];
}

// ---------------------------------------------------------------------------
// Stage 7/8 -- Quantify (activity)
// ---------------------------------------------------------------------------

export interface ActivityEstimate {
  readonly nuclideId: string;
  /** Activity in becquerel (Bq). */
  readonly activityBq: number;
  /** Inputs kept for transparency / reviewability. */
  readonly inputs: {
    readonly netArea: number;
    readonly efficiency: number;
    readonly emissionProbability: number;
    readonly liveTimeSec: number;
  };
}

// ---------------------------------------------------------------------------
// Stage 9 -- Report + pipeline tracing
// ---------------------------------------------------------------------------

/** The ordered stages of the pipeline. */
export type StageName =
  | 'load'
  | 'condition'
  | 'detect'
  | 'fit'
  | 'validate'
  | 'calibrate'
  | 'identify'
  | 'quantify'
  | 'report';

/** One step's outcome in a traced run -- the spine of the reviewer-facing view. */
export interface StageTrace {
  readonly stage: StageName;
  readonly status: 'ok' | 'skipped' | 'error';
  readonly note: string;
  readonly durationMs: number;
}

/** The end-to-end result. Any field may be null when its stage has not run. */
export interface AnalysisReport {
  readonly spectrum: Spectrum;
  readonly conditioned: ConditionedSpectrum | null;
  /** Detection output (pre-fit). Surfaced so the UI can show found peaks
   * even while `fit` and later stages are not yet implemented. */
  readonly detectedCandidates: readonly DetectedPeak[];
  readonly peaks: readonly FittedPeak[];
  readonly calibration: Calibration | null;
  readonly identifications: readonly PeakIdentification[];
  readonly activities: readonly ActivityEstimate[];
  readonly trace: readonly StageTrace[];
  /** Per-peak validate verdicts (Stage 5). Optional so the report assembler stays
   * unchanged; the orchestrator always populates it once `validate` has run. */
  readonly validatedPeaks?: readonly ValidatedPeak[];
  /** I2 whole-isotope fingerprint result (Stage 6). Optional and additive — the
   * per-peak {@link PeakIdentification} list is kept alongside it. */
  readonly identification?: IdentificationResult;
  /**
   * EVERY local maximum detection found, each tagged {@link DetectedPeak.passed}
   * / {@link DetectedPeak.rejectReason} — the retained rejected candidates the
   * inspector needs. The survivors here equal {@link detectedCandidates}.
   * Optional/additive: present once `detect` has run via the orchestrator.
   */
  readonly allDetected?: readonly DetectedPeak[];
  /**
   * Every Gaussian fit that produced a usable line, tagged
   * {@link FittedPeak.status}: the kept fits (equal to {@link peaks}) plus the
   * fits the peak-hop / edge guard rejected. Optional/additive.
   */
  readonly allFitted?: readonly FittedPeak[];
  /** Survivors that produced no usable fit at all (GAP-07). Optional/additive,
   * mirrors {@link allFitted}; the orchestrator sets it once `fit` has run. */
  readonly unfittable?: readonly UnfittableSurvivor[];
  /**
   * The EFFECTIVE detect gate settings this run used (module defaults merged with
   * any per-run `DetectOptions`). Optional/additive; the orchestrator sets it once
   * detect has run. {@link buildPipelineTrace} prefers it over the module defaults
   * so the inspector labels the gates this run actually applied (DEBT-27). Declared
   * structurally (not as `Required<DetectOptions>`) to keep this file free of a
   * runtime import cycle with `../pipeline/detect`.
   */
  readonly detectSettings?: {
    readonly prominence: number;
    readonly distance: number;
    readonly minWidth: number;
    readonly relHeight: number;
  };
}

// ---------------------------------------------------------------------------
// Peak Pipeline Inspector -- read-only projection over AnalysisReport
// ---------------------------------------------------------------------------

/**
 * `PipelineTrace` -- a stable, versioned, read-only PROJECTION over the data the
 * engine already produced in an {@link AnalysisReport}, shaped so a (future) UI
 * can render every stage of peak-finding as visual evidence.
 *
 * It introduces NO new numeric computation: every array references one already on
 * the report (or is a trivial index range). Build it lazily with
 * {@link buildPipelineTrace} when the inspector opens — nothing on the default
 * `analyze()` path constructs it, so production runs carry zero added cost.
 */
export interface PipelineTrace {
  /** Provenance id; derived from `spectrum.metadata.fileName`. */
  readonly spectrumId: string;
  /** Channel axis `[0 .. channelCount-1]`, aligned with {@link raw}. */
  readonly channels: readonly number[];
  /** Raw histogram counts (`spectrum.counts`). */
  readonly raw: readonly number[];
  /** Conditioned series, or `null` iff `report.conditioned === null`. */
  readonly conditioned: {
    readonly background: readonly number[];
    readonly netCounts: readonly number[];
    readonly smoothed: readonly number[];
  } | null;
  /** Detection stage: every local maximum, and the post-gate survivors. */
  readonly detected: {
    /** Every local maximum, tagged passed / rejectReason. */
    readonly all: readonly DetectedPeak[];
    /** `passed === true` (== {@link AnalysisReport.detectedCandidates}). */
    readonly survivors: readonly DetectedPeak[];
  };
  /** Fit stage: every attempted (usable) fit, and the kept fits. */
  readonly fitted: {
    /** Every fit that produced a line, tagged status / rejectReason. */
    readonly all: readonly FittedPeak[];
    /** `status === 'kept'` (== {@link AnalysisReport.peaks}). */
    readonly kept: readonly FittedPeak[];
    /** Survivors that produced no usable fit at all (GAP-07): the three-way
     * partition survivors = all (kept ∪ rejected-with-line) ∪ unfittable. */
    readonly unfittable: readonly UnfittableSurvivor[];
  };
  /** Validate-stage verdicts (`report.validatedPeaks ?? []`). */
  readonly validated: readonly ValidatedPeak[];
  /** The gate constants this run used, for stage labels: the four overridable
   * detect gates reflect the EFFECTIVE per-run settings (report.detectSettings,
   * DEBT-27); the measurement constants are the module values. */
  readonly constants: {
    readonly prominence: number;
    readonly distance: number;
    readonly minWidth: number;
    readonly relHeight: number;
    readonly windowFactor: number;
    readonly minHalfWindow: number;
    readonly minSignificance: number;
    readonly maxWidthRatio: number;
  };
  /** The existing timing/status trace, passed through unchanged. */
  readonly timing: readonly StageTrace[];
  /** Contract version; bump on a breaking change to this shape. */
  readonly version: 1;
}
