import { describe, it, expect } from 'vitest';

import { createIdentifyManager } from '../src/ui/identifyManager';
import { analyze } from '../src/pipeline/orchestrator';
import { syntheticTka } from '../src/data/synthetic';
import { applyCalibrationToChannel } from '../src/pipeline/calibrate';
import {
  DEFAULT_IDENTIFY_CALIBRATION,
  DEFAULT_IDENTIFY_CALIBRATION_ID,
  DEFAULT_IDENTIFY_CALIBRATION_NAME,
} from '../src/data/defaultCalibration';
import type { NuclideLibrary } from '../src/domain/types';

/**
 * GAP-06 -- the built-in fallback calibration. Proves the constant matches the
 * reference `gamma_identify.py` DEFAULT_CALIBRATION, and that the IdentifyManager
 * accepts it as an ordinary calibration choice (so a fresh profile can run Identify
 * without first building a calibration). The engine itself is untouched.
 */

const LIBRARY: NuclideLibrary = {
  entries: [
    {
      id: 'Cs-137',
      displayName: 'Cs-137',
      halfLifeSec: null,
      lines: [{ energyKeV: 661.7, intensity: 0.85 }],
    },
  ],
};

describe('DEFAULT_IDENTIFY_CALIBRATION -- the built-in fallback (GAP-06)', () => {
  it('is the reference linear kit calibration, carrying no points and no honest metrics', () => {
    expect(DEFAULT_IDENTIFY_CALIBRATION.model).toBe('linear');
    expect(DEFAULT_IDENTIFY_CALIBRATION.coefficients).toEqual([-11.7675, 1.149763]);
    expect(DEFAULT_IDENTIFY_CALIBRATION.points).toEqual([]);
    // No fit was performed: rSquared is NaN so displays render "-", never a number.
    expect(Number.isNaN(DEFAULT_IDENTIFY_CALIBRATION.rSquared)).toBe(true);
  });

  it('maps channel 592 to ~668.9 keV (the reference DEFAULT_CALIBRATION law)', () => {
    expect(applyCalibrationToChannel(DEFAULT_IDENTIFY_CALIBRATION, 592)).toBeCloseTo(668.9, 1);
  });

  it('is accepted by IdentifyManager as a calibration choice -> ready with a spectrum + library', () => {
    const mgr = createIdentifyManager();
    mgr.setSpectrum(analyze({ text: syntheticTka(), fileName: 'synthetic-demo.tka' }));
    mgr.setParams({ library: LIBRARY });
    expect(mgr.ready).toBe(false); // no calibration selected yet
    mgr.setCalibration({
      id: DEFAULT_IDENTIFY_CALIBRATION_ID,
      cal: DEFAULT_IDENTIFY_CALIBRATION,
      name: DEFAULT_IDENTIFY_CALIBRATION_NAME,
    });
    expect(mgr.ready).toBe(true);
    expect(mgr.gateMessage).toBeNull();
    expect(mgr.calibration?.id).toBe(DEFAULT_IDENTIFY_CALIBRATION_ID);
    expect(mgr.calibration?.name).toBe(DEFAULT_IDENTIFY_CALIBRATION_NAME);
  });
});
