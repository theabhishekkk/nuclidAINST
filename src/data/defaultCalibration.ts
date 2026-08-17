import type { Calibration } from '../domain/types';

/** The reference tool's built-in fallback calibration (gamma_identify.py
 * DEFAULT_CALIBRATION): a LINEAR fit from the standard 7-source NaI kit,
 * 59-1332 keV. APPROXIMATE and detector-specific -- the UI must label it so
 * and it is only ever applied by explicit operator selection (Rule 12).
 * It is not a fit performed by this app: it carries no points and no
 * quality metrics (rSquared is NaN; displays must render "-", never NaN). */
export const DEFAULT_IDENTIFY_CALIBRATION: Calibration = {
  model: 'linear',
  coefficients: [-11.7675, 1.149763],
  points: [],
  rSquared: Number.NaN,
};

/** Provenance id for the built-in choice. Deliberately not a real store id -- it is
 * never persisted to the calibration store (a transient Identify-only selection). */
export const DEFAULT_IDENTIFY_CALIBRATION_ID = '__builtin-default__';

/** Operator-facing name; the UI pairs it with an "approximate" framing note. */
export const DEFAULT_IDENTIFY_CALIBRATION_NAME = 'Built-in default (approximate)';
