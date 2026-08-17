import { describe, it, expect } from 'vitest';
import { syntheticTka } from '../src/data/synthetic';
import { load } from '../src/pipeline/load';
import { condition } from '../src/pipeline/condition';
import { detect } from '../src/pipeline/detect';
import { fit } from '../src/pipeline/fit';
import { validate } from '../src/pipeline/validate';
import { fitCalibration, applyCalibrationToChannel } from '../src/pipeline/calibrate';
import { identify } from '../src/pipeline/identify';
import { analyze } from '../src/pipeline/orchestrator';
import { NUCLIDE_LIBRARY } from '../src/data/nuclides';
import { ValidationError } from '../src/domain/errors';
import type { EnergisedPeak } from '../src/domain/types';

describe('condition + detect', () => {
  it('finds the synthetic peaks near their true channels', () => {
    const text = syntheticTka({
      channels: 1024,
      peaks: [
        { channel: 300, amplitude: 1500, fwhmChannels: 16 },
        { channel: 820, amplitude: 900, fwhmChannels: 22 },
      ],
    });
    const peaks = detect(condition(load({ text, fileName: 'demo.tka' })));
    const channels = peaks.map((p) => p.channel);
    expect(channels.some((c) => Math.abs(c - 300) <= 5)).toBe(true);
    expect(channels.some((c) => Math.abs(c - 820) <= 5)).toBe(true);
  });
});

describe('calibrate', () => {
  it('recovers a known linear channel->energy line', () => {
    const points = [
      { channel: 100, energyKeV: 60, sourceLabel: 'a' },
      { channel: 500, energyKeV: 260, sourceLabel: 'b' },
      { channel: 1000, energyKeV: 510, sourceLabel: 'c' },
    ];
    const cal = fitCalibration(points, 1);
    expect(cal.coefficients[0]).toBeCloseTo(10, 3);
    expect(cal.coefficients[1]).toBeCloseTo(0.5, 5);
    expect(cal.rSquared).toBeCloseTo(1, 6);
    expect(applyCalibrationToChannel(cal, 700)).toBeCloseTo(360, 3);
  });

  it('rejects too few points', () => {
    expect(() => fitCalibration([{ channel: 1, energyKeV: 1, sourceLabel: 'x' }], 1)).toThrow(
      ValidationError,
    );
  });
});

describe('identify', () => {
  // Minimal EnergisedPeak at a given energy (only the fields identify reads).
  const peakAt = (energyKeV: number, significance = 100, fwhmKeV = 5): EnergisedPeak => ({
    peak: {
      centroidChannel: energyKeV,
      centroidError: 0.1,
      amplitude: 1000,
      fwhmChannels: 5,
      netArea: 5000,
      chiSquare: 1,
      energyKeV,
      classification: 'line',
      significance,
      detectedChannel: Math.round(energyKeV),
      status: 'kept',
    },
    energyKeV,
    energyErrorKeV: 0.1,
    fwhmKeV,
    inValidRange: true,
  });

  it('ranks a 661.7 keV peak as Cs-137 (fingerprint)', () => {
    const result = identify([peakAt(661.7)], NUCLIDE_LIBRARY, { energyRange: [0, 2000] });
    expect(result.ranked[0]?.nuclide.id).toBe('Cs-137');
  });
  it('returns an empty ranking when nothing matches (fail-soft)', () => {
    const result = identify([peakAt(500)], NUCLIDE_LIBRARY, { energyRange: [0, 2000] });
    expect(result.ranked).toHaveLength(0);
  });
});

describe('orchestrator trace', () => {
  it('runs load/condition/detect and skips unbuilt stages', () => {
    const report = analyze({ text: syntheticTka(), fileName: '137Cs-demo.tka' });
    const byStage = Object.fromEntries(report.trace.map((t) => [t.stage, t.status]));
    expect(byStage.load).toBe('ok');
    expect(byStage.condition).toBe('ok');
    expect(byStage.detect).toBe('ok');
    expect(byStage.fit).toBe('ok');
    expect(byStage.validate).toBe('ok');
    expect(byStage.calibrate).toBe('skipped');
    expect(byStage.quantify).toBe('skipped');
    expect(byStage.report).toBe('ok');
    expect(report.detectedCandidates.length).toBeGreaterThanOrEqual(2);
    expect(report.validatedPeaks).toBeDefined();
  });
});

describe('fit is built; later unbuilt stages still fail loud', () => {
  it('fit runs (no longer throws) and returns peaks for a synthetic source', () => {
    const cond = condition(load({ text: syntheticTka(), fileName: 'demo.tka' }));
    const peaks = detect(cond);
    const fitted = fit(cond, peaks);
    expect(Array.isArray(fitted)).toBe(true);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted[0].energyKeV).toBeNull(); // channel-space until calibration
    expect(fitted[0].centroidError).toBeGreaterThan(0);
  });

  it('validate runs (no longer throws) and returns a verdict per peak', () => {
    const cond = condition(load({ text: syntheticTka(), fileName: 'demo.tka' }));
    const peaks = fit(cond, detect(cond));
    const validated = validate(peaks);
    expect(validated).toHaveLength(peaks.length); // nothing dropped
    expect(validate([])).toEqual([]); // empty in, empty out (no throw)
  });
});
