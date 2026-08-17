import { describe, it, expect } from 'vitest';

import {
  applyCalibration,
  applyActiveCalibration,
  calibrationSlopeAtChannel,
} from '../src/pipeline/applyCalibration';
import {
  createCalibrationStore,
  type StorageBackend,
} from '../src/data/calibrationStore';
import { ValidationError } from '../src/domain/errors';
import type { Calibration, CalibrationResult, FittedPeak } from '../src/domain/types';

/**
 * I1 -- apply calibration tests (engine only; M3 browser deferred to M4).
 *
 *  1. ENERGY MAP -- on a known calibration, energies reproduce hand-computed
 *     values, for both a LINEAR and a QUADRATIC selected equation. The quadratic
 *     uses the archive's synthetic law E(ch) = -5.5 + 1.108·ch + 3.65e-5·ch².
 *  2. UNCERTAINTY -- energyErrorKeV ≈ |dE/dch|·centroidError and
 *     fwhmKeV ≈ |dE/dch|·fwhmChannels, on a known slope (linear: c1; quadratic:
 *     c1 + 2·c2·ch).
 *  3. VALID-RANGE -- in-range -> inValidRange:true; out-of-range -> false but
 *     still RETURNED (flagged, never dropped, RISK-04).
 *  4. FAIL-LOUD -- applyActiveCalibration throws with no active calibration; the
 *     pure applyCalibration handles an empty peak list -> [].
 */

// --- factories --------------------------------------------------------------

function makePeak(overrides: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 100,
    centroidError: 0.1,
    amplitude: 1000,
    fwhmChannels: 5,
    netArea: 5000,
    chiSquare: 1,
    energyKeV: null,
    classification: 'line',
    significance: 10,
    detectedChannel: 100,
    status: 'kept',
    ...overrides,
  };
}

function makeCalibration(coefficients: number[], extra: Partial<Calibration> = {}): Calibration {
  return {
    model: coefficients.length > 2 ? 'quadratic' : 'linear',
    coefficients,
    points: [],
    rSquared: 1,
    ...extra,
  };
}

/** A linear calibration E = 2 + 0.5·ch (slope 0.5 keV/ch everywhere). */
const LINEAR = makeCalibration([2, 0.5]);

/** The synthetic quadratic law E(ch) = -5.5 + 1.108·ch + 3.65e-5·ch². */
const QUAD_C0 = -5.5;
const QUAD_C1 = 1.108;
const QUAD_C2 = 3.65e-5;
const QUADRATIC = makeCalibration([QUAD_C0, QUAD_C1, QUAD_C2], { validRange: [0, 1500] });

function quadEnergy(ch: number): number {
  return QUAD_C0 + QUAD_C1 * ch + QUAD_C2 * ch * ch;
}
function quadSlope(ch: number): number {
  return QUAD_C1 + 2 * QUAD_C2 * ch;
}

function memoryBackend(): StorageBackend {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v);
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

// --- 1. ENERGY MAP ----------------------------------------------------------

describe('applyCalibration -- energy map', () => {
  it('reproduces hand-computed energies for a LINEAR calibration', () => {
    const peaks = [makePeak({ centroidChannel: 100 }), makePeak({ centroidChannel: 300 })];
    const out = applyCalibration(peaks, LINEAR);
    expect(out).toHaveLength(2);
    expect(out[0].energyKeV).toBeCloseTo(52, 10); // 2 + 0.5*100
    expect(out[1].energyKeV).toBeCloseTo(152, 10); // 2 + 0.5*300
    // the originating peak is composed, not mutated
    expect(out[0].peak).toBe(peaks[0]);
    expect(out[0].peak.energyKeV).toBeNull();
  });

  it('reproduces hand-computed energies for a QUADRATIC calibration', () => {
    const channels = [500, 1000, 1200];
    const peaks = channels.map((c) => makePeak({ centroidChannel: c }));
    const out = applyCalibration(peaks, QUADRATIC);
    out.forEach((e, i) => {
      expect(e.energyKeV).toBeCloseTo(quadEnergy(channels[i]), 8);
    });
    // explicit spot value: ch=1000 -> -5.5 + 1108 + 36.5 = 1139.0
    expect(out[1].energyKeV).toBeCloseTo(1139.0, 8);
  });
});

// --- 2. UNCERTAINTY ---------------------------------------------------------

describe('applyCalibration -- uncertainty propagation', () => {
  it('energyErrorKeV = |dE/dch|*centroidError and fwhmKeV = |dE/dch|*fwhm (linear)', () => {
    const peak = makePeak({ centroidChannel: 100, centroidError: 0.2, fwhmChannels: 4 });
    const [e] = applyCalibration([peak], LINEAR);
    expect(calibrationSlopeAtChannel(LINEAR, 100)).toBeCloseTo(0.5, 12);
    expect(e.energyErrorKeV).toBeCloseTo(0.5 * 0.2, 12); // 0.10
    expect(e.fwhmKeV).toBeCloseTo(0.5 * 4, 12); // 2.0
  });

  it('uses the channel-dependent slope c1 + 2*c2*ch for a quadratic', () => {
    const ch = 1000;
    const peak = makePeak({ centroidChannel: ch, centroidError: 0.5, fwhmChannels: 6 });
    const [e] = applyCalibration([peak], QUADRATIC);
    const slope = quadSlope(ch); // 1.108 + 0.073 = 1.181
    expect(calibrationSlopeAtChannel(QUADRATIC, ch)).toBeCloseTo(slope, 12);
    expect(e.energyErrorKeV).toBeCloseTo(slope * 0.5, 10);
    expect(e.fwhmKeV).toBeCloseTo(slope * 6, 10);
  });
});

// --- 3. VALID-RANGE ---------------------------------------------------------

describe('applyCalibration -- valid-range flag', () => {
  const ranged = makeCalibration([2, 0.5], { validRange: [50, 150] });

  it('flags in-range true and out-of-range false, returning BOTH (never drops)', () => {
    const inRange = makePeak({ centroidChannel: 100 }); // E = 52  -> in [50,150]
    const tooLow = makePeak({ centroidChannel: 10 }); // E = 7   -> below 50
    const tooHigh = makePeak({ centroidChannel: 400 }); // E = 202 -> above 150
    const out = applyCalibration([inRange, tooLow, tooHigh], ranged);
    expect(out).toHaveLength(3); // flagged, not dropped
    expect(out[0].inValidRange).toBe(true);
    expect(out[1].inValidRange).toBe(false);
    expect(out[2].inValidRange).toBe(false);
    // the out-of-range energies are still computed honestly
    expect(out[1].energyKeV).toBeCloseTo(7, 10);
    expect(out[2].energyKeV).toBeCloseTo(202, 10);
  });

  it('treats a calibration with no validRange as always in-range', () => {
    const [e] = applyCalibration([makePeak({ centroidChannel: 9999 })], LINEAR);
    expect(e.inValidRange).toBe(true);
  });

  it('includes the range boundaries (inclusive)', () => {
    const lo = makePeak({ centroidChannel: 96 }); // E = 50 (== min)
    const hi = makePeak({ centroidChannel: 296 }); // E = 150 (== max)
    const out = applyCalibration([lo, hi], ranged);
    expect(out[0].inValidRange).toBe(true);
    expect(out[1].inValidRange).toBe(true);
  });
});

// --- 4. FAIL-LOUD + edge cases ----------------------------------------------

describe('applyCalibration -- empty input', () => {
  it('returns [] for an empty peak list', () => {
    expect(applyCalibration([], QUADRATIC)).toEqual([]);
  });
});

describe('applyActiveCalibration -- fail loud', () => {
  it('throws when no calibration is active', () => {
    const store = createCalibrationStore(memoryBackend());
    expect(() => applyActiveCalibration([makePeak()], store)).toThrow(ValidationError);
  });

  it('applies the SELECTED equation of the active calibration when one exists', () => {
    const store = createCalibrationStore(memoryBackend());
    // selected = quadratic; linear is deliberately a different line so a wrong
    // selection would give a wrong energy.
    const result: CalibrationResult = {
      linear: makeCalibration([0, 1]), // E = ch (wrong, must NOT be used)
      quadratic: QUADRATIC,
      selected: 'quadratic',
      policy: 'auto',
      selectionFellBack: false,
      curvatureSignificance: 9.5,
    };
    store.save({ name: 'unit', sources: ['Synthetic'], result }); // first save -> active

    const out = applyActiveCalibration([makePeak({ centroidChannel: 1000 })], store);
    expect(out[0].energyKeV).toBeCloseTo(quadEnergy(1000), 8); // 1139.0, not 1000
  });
});
