/**
 * Stage 5b -- Apply calibration (I1, M3 Identify): map an unknown spectrum's
 * validated fitted peaks from channel space into energy (keV) using a saved
 * calibration. This is the bridge from "peaks in channel space" to "energies I2
 * can fingerprint" (PORTING_PLAN §3 Identify; M3_KICKOFF §4 I1).
 *
 * Two entry points:
 *
 *   - {@link applyCalibration}(peaks, cal) -- PURE. Takes the calibration
 *     explicitly (testable, no I/O). For each peak it computes:
 *       * energyKeV     = cal(centroidChannel)            (Horner, reuses C3 helper)
 *       * energyErrorKeV ≈ |dE/dch| · centroidError       (slope-propagated 1-σ)
 *       * fwhmKeV        = |dE/dch| · fwhmChannels         (for I2 adaptive tol)
 *       * inValidRange   = energy ∈ cal.validRange         (flagged, never dropped)
 *
 *   - {@link applyActiveCalibration}(peaks, store) -- FAIL-LOUD convenience.
 *     Loads the active saved calibration (C4) and applies its SELECTED equation.
 *     Throws {@link ValidationError} when no calibration is active: Identify
 *     cannot run without one and must never fabricate energies (Rule 12,
 *     RISK-01/04). Identity comes only from energies + the library, never a
 *     filename.
 *
 * Uncertainty propagation (first-order). E = Σ c_k·ch^k, so dE/dch = Σ k·c_k·ch^(k-1)
 * (for linear: c1; for quadratic: c1 + 2·c2·ch). A 1-σ centroid error δch maps to
 * an energy error |dE/dch|·δch to first order; the FWHM transforms the same way
 * (the linearisation is exact for a linear calibration and excellent for the small
 * curvature of a quadratic over a peak width). The calibration-PARAMETER
 * contribution (coefficient covariance, available as `cal.covariance`) is
 * DEFERRED -- see {@link CALIBRATION_PARAM_ERROR_DEFERRED}; this term is the
 * centroid-error contribution only.
 *
 * Element-agnostic / general (RISK-02): an N-peak list, any {@link Calibration}
 * of any polynomial degree (the slope is computed from the coefficient array, not
 * special-cased to linear/quadratic). Nothing is isotope-shaped.
 */
import type { Calibration, EnergisedPeak, FittedPeak } from '../domain/types';
import { ValidationError } from '../domain/errors';
import { activeCalibration, applyCalibrationToChannel } from './calibrate';
import { calibrationStore, type CalibrationStore } from '../data/calibrationStore';

/**
 * The calibration-parameter (coefficient covariance) contribution to σ_E is
 * deferred for I1. The reported {@link EnergisedPeak.energyErrorKeV} is the
 * centroid-error term |dE/dch|·centroidError ONLY. Folding in the covariance term
 * (σ_E² += [∂E/∂c]·cov·[∂E/∂c]ᵀ, with ∂E/∂c_k = ch^k) is a later refinement; it
 * is small near the calibrated lines and does not change which energies I2 scores.
 */
export const CALIBRATION_PARAM_ERROR_DEFERRED = true as const;

/**
 * Derivative of an ASCENDING-power polynomial, returned in ascending order.
 * For `coeffs = [c0, c1, c2, ...]` (E = c0 + c1·ch + c2·ch² + ...) the derivative
 * is `[c1, 2·c2, 3·c3, ...]` (dE/dch = c1 + 2·c2·ch + ...). A constant (length ≤ 1)
 * has a zero derivative -> `[]`, evaluated as 0.
 */
function derivativeCoefficients(coeffs: readonly number[]): number[] {
  const d: number[] = [];
  for (let k = 1; k < coeffs.length; k++) d.push(k * coeffs[k]);
  return d;
}

/** Evaluate an ASCENDING-power polynomial at x (Horner). Empty -> 0. */
function evalAscending(coeffs: readonly number[], x: number): number {
  let e = 0;
  for (let k = coeffs.length - 1; k >= 0; k--) e = e * x + coeffs[k];
  return e;
}

/** Calibration slope dE/dch (keV per channel) at a channel, for any degree. */
export function calibrationSlopeAtChannel(cal: Calibration, channel: number): number {
  return evalAscending(derivativeCoefficients(cal.coefficients), channel);
}

/** Is `energyKeV` inside the calibration's trusted span? `true` when the
 * calibration declares no range (nothing to flag against). Bounds inclusive. */
function withinValidRange(energyKeV: number, range: Calibration['validRange']): boolean {
  if (!range) return true;
  return energyKeV >= range[0] && energyKeV <= range[1];
}

/**
 * Apply a calibration to validated fitted peaks. Pure: the calibration is passed
 * explicitly. Returns one {@link EnergisedPeak} per input peak, in order. An empty
 * peak list yields `[]`. Peaks whose energy falls outside `cal.validRange` are
 * returned flagged (`inValidRange:false`), never dropped (RISK-04).
 */
export function applyCalibration(
  peaks: readonly FittedPeak[],
  cal: Calibration,
): EnergisedPeak[] {
  return peaks.map((peak) => {
    const energyKeV = applyCalibrationToChannel(cal, peak.centroidChannel);
    const slope = calibrationSlopeAtChannel(cal, peak.centroidChannel);
    const absSlope = Math.abs(slope);
    return {
      peak,
      energyKeV,
      energyErrorKeV: absSlope * peak.centroidError,
      fwhmKeV: absSlope * peak.fwhmChannels,
      inValidRange: withinValidRange(energyKeV, cal.validRange),
    };
  });
}

/**
 * Load the active saved calibration (C4) and apply its SELECTED equation to the
 * given validated peaks. Fail-loud: throws {@link ValidationError} when no
 * calibration is active -- Identify must not fabricate energies (Rule 12,
 * RISK-01/04). The store is injectable for tests; defaults to the browser-backed
 * {@link calibrationStore}.
 */
export function applyActiveCalibration(
  peaks: readonly FittedPeak[],
  store: CalibrationStore = calibrationStore,
): EnergisedPeak[] {
  const record = store.getActive();
  if (record === null) {
    throw new ValidationError(
      'applyActiveCalibration: no active calibration. Identify requires a saved, ' +
        'active calibration (Calibrate mode) before energies can be assigned; it ' +
        'will not fabricate energies from an uncalibrated spectrum.',
    );
  }
  return applyCalibration(peaks, activeCalibration(record.result));
}
