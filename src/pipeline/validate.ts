/**
 * Stage 5 -- Validate: the peak-quality gate between `fit` and `calibrate`/
 * `identify`. Given fitted peaks, it judges which are trustworthy real lines and
 * which are noise/artifacts, and -- per RISK-04 -- FLAGS each with its reason
 * rather than silently dropping it. Identify (M3) scores all fitted peaks for the
 * isotope fingerprint, so the junk (weak peaks, broad Compton shelves, degenerate
 * fits) must be gated out first.
 *
 * Two gates, both reusing already-trusted signals:
 *
 *  1. Classification gate (reference-grounded, C1 reuse -- NOT re-derived). C1's
 *     `classify_candidate` (reference-verified) already encodes the reference's
 *     significance/width rules on each {@link DetectedPeak}, carried onto the
 *     {@link FittedPeak} as `classification` (DEBT-09):
 *       - `'weak'`  <=> significance < {@link MIN_SIGNIFICANCE} (4.0)  -> invalid
 *       - `'broad'` <=> widthRatio   > 2 (continuum/backscatter)       -> invalid
 *       - only `'line'` proceeds.
 *     We gate on `classification` directly so there is a single source of truth and
 *     no chance of disagreeing with C1's verdict.
 *
 *  2. Fit-quality gate (the FittedPeak's own fields). A `'line'` can still be a bad
 *     fit: reject a non-finite / non-positive / absurdly wide FWHM, a non-finite /
 *     non-positive / huge `centroidError` (an unlocalisable centroid), or a non-
 *     finite `chiSquare`.
 *
 * On chi-square: `FittedPeak.chiSquare` is the TOTAL weighted SSR over the fit
 * window, not a reduced chi-square -- its magnitude scales with peak amplitude and
 * window width, so an absolute magnitude cut would be isotope/detector-shaped
 * (RISK-02). The reference applies no reduced-chi-square acceptance beyond
 * `curve_fit` convergence, which C2's fit guard already enforces. We therefore gate
 * chi-square for FINITENESS only, not magnitude.
 *
 * A peak is `valid` iff it clears BOTH gates; `flags` lists every failed reason
 * (so a broad over-wide fit reports both `'broad'` and `'wide-fwhm'`).
 *
 * Element-agnostic (RISK-02): nothing here is isotope-shaped. Every threshold is a
 * named, documented, overridable constant.
 */
import type { FittedPeak, ValidatedPeak } from '../domain/types';

// --- classification gate (reference-grounded; reused verbatim from C1) -------
/** The C1 significance floor below which a peak is `'weak'`. Documented here for
 * provenance; the gate reuses C1's `classification` (which already applies it),
 * so this is NOT re-thresholded against the carried `significance`. */
export const MIN_SIGNIFICANCE = 4.0;

// --- fit-quality gate (sane backstops; overridable via ValidateOptions) ------
/**
 * Absurd-FWHM backstop (channels). The classification gate (widthRatio) is the
 * primary width discriminator; this only catches a `'line'` whose fit blew up. The
 * widest genuine line across the 7 real fixtures is ~63 ch, so 200 ch cleanly
 * separates a real (even high-energy, wide) line from a degenerate fit. NOTE: an
 * absolute channel bound is spectrum-length-aware only through this default -- for
 * a much longer spectrum, raise it via {@link ValidateOptions.maxFwhmChannels}. */
export const MAX_FWHM_CHANNELS = 200;
/**
 * Huge-centroid-error backstop (channels). A centroid whose 1-sigma is this large
 * is effectively unlocalised (a flat/degenerate fit). The widest genuine fixture
 * line has centroidError ~1.06 ch, so 5.0 ch is a comfortable separation. */
export const MAX_CENTROID_ERROR_CHANNELS = 5.0;

/** Flag tokens (machine-readable rejection reasons). */
export const FLAG_WEAK = 'weak';
export const FLAG_BROAD = 'broad';
export const FLAG_WIDE_FWHM = 'wide-fwhm';
export const FLAG_INVALID_FWHM = 'invalid-fwhm';
export const FLAG_LARGE_CENTROID_ERROR = 'large-centroid-error';
export const FLAG_INVALID_CENTROID_ERROR = 'invalid-centroid-error';
export const FLAG_POOR_FIT = 'poor-fit';

/** Tunable thresholds for {@link validate}; omitted fields use the named defaults. */
export interface ValidateOptions {
  /** Absurd-FWHM bound (channels). Default {@link MAX_FWHM_CHANNELS}. */
  readonly maxFwhmChannels?: number;
  /** Huge-centroid-error bound (channels). Default {@link MAX_CENTROID_ERROR_CHANNELS}. */
  readonly maxCentroidErrorChannels?: number;
}

/**
 * Validate every fitted peak. Returns one {@link ValidatedPeak} per input, in the
 * same order, each carrying its `valid` verdict and the `flags` that explain a
 * rejection. Nothing is dropped (RISK-04).
 */
export function validate(
  peaks: readonly FittedPeak[],
  options: ValidateOptions = {},
): ValidatedPeak[] {
  const maxFwhm = options.maxFwhmChannels ?? MAX_FWHM_CHANNELS;
  const maxCentroidError = options.maxCentroidErrorChannels ?? MAX_CENTROID_ERROR_CHANNELS;

  return peaks.map((peak) => {
    const flags: string[] = [];

    // 1. Classification gate (C1 verdict; only a 'line' proceeds).
    if (peak.classification === 'weak') flags.push(FLAG_WEAK);
    if (peak.classification === 'broad') flags.push(FLAG_BROAD);

    // 2. Fit-quality gate (the FittedPeak's own fields).
    if (!Number.isFinite(peak.fwhmChannels) || peak.fwhmChannels <= 0) {
      flags.push(FLAG_INVALID_FWHM);
    } else if (peak.fwhmChannels > maxFwhm) {
      flags.push(FLAG_WIDE_FWHM);
    }

    if (!Number.isFinite(peak.centroidError) || peak.centroidError <= 0) {
      flags.push(FLAG_INVALID_CENTROID_ERROR);
    } else if (peak.centroidError > maxCentroidError) {
      flags.push(FLAG_LARGE_CENTROID_ERROR);
    }

    // chi-square: finiteness only (see module note -- no magnitude cut). `null`
    // means "not computed", which is not itself a failure.
    if (peak.chiSquare !== null && !Number.isFinite(peak.chiSquare)) {
      flags.push(FLAG_POOR_FIT);
    }

    return { peak, valid: flags.length === 0, flags };
  });
}

/** The valid subset of a {@link validate} result, as plain {@link FittedPeak}s --
 * what calibrate/identify consume. */
export function validPeaks(validated: readonly ValidatedPeak[]): FittedPeak[] {
  return validated.filter((v) => v.valid).map((v) => v.peak);
}
