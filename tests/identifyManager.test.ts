import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createIdentifyManager } from '../src/ui/identifyManager';
import { analyze } from '../src/pipeline/orchestrator';
import { syntheticTka } from '../src/data/synthetic';
import { applyCalibration } from '../src/pipeline/applyCalibration';
import { applyCalibrationToChannel } from '../src/pipeline/calibrate';
import { identify } from '../src/pipeline/identify';
import { validate, validPeaks } from '../src/pipeline/validate';
import type { Calibration, NuclideLibrary } from '../src/domain/types';

/**
 * The IdentifyManager is a UI orchestrator + a pure pass-through to the engine. These
 * tests prove (1) `build()` produces a result equal to calling the engine chain
 * directly on the same inputs, (2) the gate/ready progression, (3) collection edits
 * invalidate a finished run, and (4) `setParams` only invalidates on a real change.
 * The engine itself is covered by the (untouched) identify golden suite.
 */

const CAL: Calibration = { model: 'linear', coefficients: [0, 0.3], points: [], rSquared: 1 };
const LIBRARY: NuclideLibrary = {
  entries: [
    { id: 'Cs-137', displayName: 'Cs-137', halfLifeSec: null, lines: [{ energyKeV: 661.7, intensity: 0.85 }] },
    {
      id: 'Co-60',
      displayName: 'Co-60',
      halfLifeSec: null,
      lines: [
        { energyKeV: 1173.2, intensity: 1.0 },
        { energyKeV: 1332.5, intensity: 1.0 },
      ],
    },
  ],
};

function report() {
  return analyze({ text: syntheticTka(), fileName: 'synthetic-demo.tka' });
}

function forceReducedMotion(value: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: value });
}

beforeEach(() => forceReducedMotion(true)); // build() jumps straight to `done`
afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

describe('IdentifyManager -- gate', () => {
  it('is not ready until a spectrum, a calibration, and a library are all present', () => {
    const mgr = createIdentifyManager();
    expect(mgr.ready).toBe(false);
    expect(mgr.gateMessage).toMatch(/spectrum/i);
    mgr.setSpectrum(report());
    expect(mgr.gateMessage).toMatch(/library/i);
    mgr.setParams({ library: LIBRARY });
    expect(mgr.gateMessage).toMatch(/calibration/i);
    mgr.setCalibration({ id: 't', cal: CAL, name: 'Test' });
    expect(mgr.ready).toBe(true);
    expect(mgr.gateMessage).toBeNull();
  });
});

describe('IdentifyManager -- build() is a pure pass-through', () => {
  it('matches a direct engine call on the same inputs and lands on `done`', () => {
    const rep = report();
    const mgr = createIdentifyManager();
    mgr.setSpectrum(rep);
    mgr.setParams({ library: LIBRARY });
    mgr.setCalibration({ id: 't', cal: CAL, name: 'Test' });
    mgr.build();

    expect(mgr.phase.kind).toBe('done'); // reduced motion -> instant reveal
    // The reference engine chain, computed independently here.
    const fitted = validPeaks(rep.validatedPeaks ?? validate(rep.peaks));
    const energised = applyCalibration(fitted, CAL);
    const last = rep.spectrum.counts.length - 1;
    const direct = identify(energised, LIBRARY, {
      energyRange: [applyCalibrationToChannel(CAL, 0), applyCalibrationToChannel(CAL, last)],
    });
    expect(mgr.result).toEqual(direct);
    expect(mgr.cal).toBe(CAL);
    expect(mgr.calName).toBe('Test');
    expect(mgr.energised).toEqual(energised);
  });

  it('fails loud (error phase) when no calibration is selected', () => {
    const mgr = createIdentifyManager();
    mgr.setSpectrum(report());
    mgr.setParams({ library: LIBRARY });
    mgr.build();
    expect(mgr.phase.kind).toBe('error');
    expect(mgr.result).toBeNull();
  });
});

describe('IdentifyManager -- invalidation & lifecycle', () => {
  it('a collection edit invalidates a finished run (back to collecting, result cleared)', () => {
    const mgr = createIdentifyManager();
    mgr.setSpectrum(report());
    mgr.setParams({ library: LIBRARY });
    mgr.setCalibration({ id: 't', cal: CAL, name: 'Test' });
    mgr.build();
    expect(mgr.phase.kind).toBe('done');
    mgr.setSpectrum(report()); // a new unknown invalidates the run
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.result).toBeNull();
  });

  it('setParams with an unchanged value does not invalidate the run', () => {
    const mgr = createIdentifyManager();
    mgr.setSpectrum(report());
    mgr.setParams({ library: LIBRARY });
    mgr.setCalibration({ id: 't', cal: CAL, name: 'Test' });
    mgr.build();
    expect(mgr.phase.kind).toBe('done');
    mgr.setParams({ library: LIBRARY }); // same reference -> no-op
    expect(mgr.phase.kind).toBe('done');
    expect(mgr.result).not.toBeNull();
  });

  it('reset clears the spectrum + run but keeps the chosen calibration (new unknown, same cal)', () => {
    const mgr = createIdentifyManager();
    mgr.setSpectrum(report());
    mgr.setParams({ library: LIBRARY });
    mgr.setCalibration({ id: 't', cal: CAL, name: 'Test' });
    mgr.build();
    mgr.reset();
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.report).toBeNull();
    expect(mgr.result).toBeNull();
    expect(mgr.calibration).not.toBeNull(); // the selected calibration persists
  });
});
