import { describe, it, expect } from 'vitest';

import {
  calibrate,
  activeCalibration,
  fitCalibration,
  applyCalibrationToChannel,
  type DeclaredSource,
} from '../src/pipeline/calibrate';
import { load } from '../src/pipeline/load';
import { condition } from '../src/pipeline/condition';
import { detect } from '../src/pipeline/detect';
import { fit } from '../src/pipeline/fit';
import { validate, validPeaks } from '../src/pipeline/validate';
import { syntheticTka } from '../src/data/synthetic';
import { CALIBRATION_KIT } from '../src/data/calibrationKit';
import { ValidationError } from '../src/domain/errors';
import type { CalibrationKit, FittedPeak } from '../src/domain/types';

import GT from './fixtures/reference/_calibrate_ground_truth.json';
// The archive's V3 synthetic demo sources (make_demo_sources.py, seed 7),
// captured as counts so the test imports them without node:fs. Each carries the
// hidden quadratic E(ch) = -5.5 + 1.108*ch + 3.65e-5*ch².
import SYNTHETIC from './fixtures/synthetic-calibration/synthetic_spectra.json';

/**
 * C3 calibrate tests (dual-model amendment).
 *
 *  1. REFERENCE PARITY -- against the reference `energy_calibration.calibrate`
 *     (Gamma Spectroscopy Suite engine, scipy 1.18.0 / numpy 2.5.0) via the
 *     committed `_calibrate_ground_truth.json`. We reconstruct each source's
 *     `FittedPeak[]` from the reference's located centroids and run the TS
 *     `calibrate`, so the test exercises the TS survey + two-pass matching +
 *     σ-clip + selection given identical centroids. BOTH candidate equations are
 *     asserted independently (linear vs reference linear, quadratic vs reference
 *     quadratic) -- verification never depends on which model is `selected`.
 *  2. SELECTION POLICY -- `'auto'` reproduces the reference's curvature choice
 *     (quadratic on the real data); `'linear'` keeps the line with the quadratic
 *     still present; `'quadratic'` selects the curve, or falls back to linear with
 *     `selectionFellBack` when <4 points.
 *  3. SYNTHETIC END-TO-END -- the real condition->detect->fit->calibrate chain on
 *     the synthetic sources recovers the hidden quadratic under auto/quadratic
 *     (RISK-02), and returns the linear best-fit under `'linear'`.
 *  4. ANTI-HOP, σ-CLIP and FAIL-LOUD units on controlled synthetic inputs.
 */

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

interface SyntheticSpectrum {
  liveTimeSec: number;
  realTimeSec: number;
  counts: number[];
}
const synthetic = SYNTHETIC as unknown as Record<string, SyntheticSpectrum>;

// --- ground-truth typing ----------------------------------------------------
interface GtPoint {
  energy: number;
  tier: 'anchor' | 'secondary';
  reliable: boolean;
  channel: number | null;
  channel_err: number | null;
  sigma: number | null;
  amp: number | null;
  area: number | null;
  used: boolean;
  note: string;
}
interface GtBlock {
  coeffs: number[];
  cov: number[][];
  rms: number;
  max_abs: number;
  r2: number;
  curvature_significance: number;
}
interface GtFile {
  generated_with: string;
  preliminary: { a0: number; b0: number };
  points_by_source: Record<string, GtPoint[]>;
  linear: GtBlock;
  quadratic: GtBlock;
  chosen: string;
  valid_range: [number, number];
  n_used: number;
  dropped: { isotope: string; energy: number; note: string }[];
}
const gt = GT as unknown as GtFile;

function relClose(actual: number, expected: number, relTol: number, absTol = 0): void {
  const diff = Math.abs(actual - expected);
  const tol = absTol + relTol * Math.abs(expected);
  expect(diff, `|${actual} - ${expected}| = ${diff} > ${tol}`).toBeLessThanOrEqual(tol);
}

/** Build a FittedPeak at a channel with a NaI-like width and a chosen 1σ error. */
function peakAt(channel: number, centroidError: number, amplitude: number): FittedPeak {
  const fwhm = 1.7 * Math.sqrt(Math.max(channel, 1));
  const sigma = fwhm / FWHM_PER_SIGMA;
  return {
    centroidChannel: channel,
    centroidError,
    amplitude,
    fwhmChannels: fwhm,
    netArea: amplitude * sigma * Math.sqrt(2 * Math.PI),
    chiSquare: null,
    energyKeV: null,
    classification: 'line',
    significance: 100,
    detectedChannel: Math.round(channel),
    status: 'kept',
  };
}

// True linear law E = 10 + 0.5*ch  ⇒  ch = 2*E - 20.
const chOf = (e: number) => 2 * e - 20;

// Reconstruct FittedPeak[] per source from the reference's located centroids
// (every finite-error point: anchors, accepted secondaries, rejected hops).
const refSourceIds = Object.keys(gt.points_by_source);
const refSources: DeclaredSource[] = refSourceIds.map((id) => {
  const peaks: FittedPeak[] = gt.points_by_source[id]
    .filter((p) => p.channel != null && p.channel_err != null && Number.isFinite(p.channel_err))
    .map((p) => ({
      centroidChannel: p.channel as number,
      centroidError: p.channel_err as number,
      amplitude: p.amp as number,
      fwhmChannels: (p.sigma as number) * FWHM_PER_SIGMA,
      netArea: p.area as number,
      chiSquare: null,
      energyKeV: null,
      classification: 'line' as const,
      significance: 100,
      detectedChannel: Math.round(p.channel as number),
      status: 'kept' as const,
    }));
  return { sourceId: id, fittedPeaks: peaks };
});

// =============================================================================
// 1. Reference parity -- both candidates asserted independently
// =============================================================================
describe('calibrate -- reference parity (Gamma Spectroscopy Suite, scipy/numpy)', () => {
  const result = calibrate(refSources, CALIBRATION_KIT); // default 'auto'
  const refLinAsc = gt.linear.coeffs.slice().reverse();
  const refQuadAsc = gt.quadratic.coeffs.slice().reverse();

  it('default (auto) selects quadratic on the real data, matching the reference', () => {
    expect(gt.chosen).toBe('quadratic'); // fixture sanity
    expect(result.policy).toBe('auto');
    expect(result.selected).toBe('quadratic');
    expect(result.selectionFellBack).toBe(false);
    expect(result.quadratic).not.toBeNull();
    relClose(result.curvatureSignificance, gt.quadratic.curvature_significance, 1e-4);
  });

  it('LINEAR candidate matches the reference linear fit (independent of selection)', () => {
    const lin = result.linear;
    expect(lin.coefficients).toHaveLength(2);
    for (let k = 0; k < 2; k++) relClose(lin.coefficients[k], refLinAsc[k], 1e-6, 1e-12);
    relClose(lin.rms as number, gt.linear.rms, 1e-6);
    relClose(lin.maxAbsResidual as number, gt.linear.max_abs, 1e-6);
    relClose(lin.rSquared, gt.linear.r2, 1e-9);
  });

  it('QUADRATIC candidate matches the reference quadratic fit (independent of selection)', () => {
    const quad = result.quadratic!;
    expect(quad.coefficients).toHaveLength(3);
    for (let k = 0; k < 3; k++) relClose(quad.coefficients[k], refQuadAsc[k], 1e-6, 1e-12);
    relClose(quad.rms as number, gt.quadratic.rms, 1e-6);
    relClose(quad.maxAbsResidual as number, gt.quadratic.max_abs, 1e-6);
    relClose(quad.rSquared, gt.quadratic.r2, 1e-9);
    // covariance (highest-power first in the reference -> ascending here).
    const refCov = gt.quadratic.cov;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        relClose((quad.covariance as readonly (readonly number[])[])[i][j], refCov[2 - i][2 - j], 1e-5, 1e-18);
      }
    }
  });

  it('both candidates share the same valid range as the reference', () => {
    for (const cal of [result.linear, result.quadratic!]) {
      relClose((cal.validRange as readonly [number, number])[0], gt.valid_range[0], 0, 1e-9);
      relClose((cal.validRange as readonly [number, number])[1], gt.valid_range[1], 0, 1e-9);
    }
  });

  it('activeCalibration() returns the selected (quadratic) candidate', () => {
    expect(activeCalibration(result)).toBe(result.quadratic);
    expect(applyCalibrationToChannel(activeCalibration(result), 600)).toBeCloseTo(
      result.quadratic!.coefficients[0] +
        result.quadratic!.coefficients[1] * 600 +
        result.quadratic!.coefficients[2] * 600 * 600,
      6,
    );
  });

  it('reproduces the reference used / dropped point set exactly', () => {
    const key = (sid: string, e: number) => `${sid}@${e}`;
    const myUsed = result.linear.points
      .filter((p) => p.used)
      .map((p) => key(p.sourceId as string, p.energyKeV))
      .sort();
    const refUsed: string[] = [];
    for (const id of refSourceIds) {
      for (const p of gt.points_by_source[id]) if (p.used) refUsed.push(key(id, p.energy));
    }
    expect(myUsed).toEqual(refUsed.sort());
    expect(myUsed).toHaveLength(gt.n_used); // 16 on the real data
  });

  it('reproduces the reference σ-clip prune (Eu-152 1408 keV) and peak-hop rejections', () => {
    const pts = result.linear.points;
    const pruned = pts.filter((p) => (p.note ?? '').includes('pruned'));
    expect(pruned.map((p) => `${p.sourceId}@${p.energyKeV}`)).toContain('Eu-152@1408.013');

    const hops = pts
      .filter((p) => (p.note ?? '').includes('peak-hop'))
      .map((p) => `${p.sourceId}@${p.energyKeV}`)
      .sort();
    // Congested lines that hop onto a taller neighbour under the tight window
    // (DEBT-06: Co-57 136 next to 122; Ba-133 384 in the triplet; Eu-152 1086).
    expect(hops).toContain('Co-57@136.474');
    expect(hops).toContain('Ba-133@383.851');
    expect(hops).toContain('Eu-152@1085.837');
  });
});

// =============================================================================
// 2. Selection policy
// =============================================================================
describe('calibrate -- selectable default model policy', () => {
  it("'linear' selects the line but still computes the quadratic candidate", () => {
    const result = calibrate(refSources, CALIBRATION_KIT, { defaultModel: 'linear' });
    expect(result.selected).toBe('linear');
    expect(result.policy).toBe('linear');
    expect(result.selectionFellBack).toBe(false);
    expect(result.quadratic).not.toBeNull(); // both equations remain available
    expect(activeCalibration(result)).toBe(result.linear);
  });

  it("'quadratic' selects the curve when ≥4 points are available", () => {
    const result = calibrate(refSources, CALIBRATION_KIT, { defaultModel: 'quadratic' });
    expect(result.selected).toBe('quadratic');
    expect(result.selectionFellBack).toBe(false);
    expect(activeCalibration(result)).toBe(result.quadratic);
  });

  it("'quadratic' falls back to linear (flagged) when <4 points are available", () => {
    // Three anchors only -> quadratic unavailable (needs N>3 for covariance).
    const kit: CalibrationKit = {
      entries: [
        {
          id: 'A',
          displayName: 'A',
          lines: [
            { energyKeV: 100, tier: 'anchor', intensity: 1, reliable: true },
            { energyKeV: 200, tier: 'anchor', intensity: 1, reliable: true },
            { energyKeV: 300, tier: 'anchor', intensity: 1, reliable: true },
          ],
        },
      ],
    };
    const src: DeclaredSource = {
      sourceId: 'A',
      fittedPeaks: [peakAt(chOf(100), 0.01, 50000), peakAt(chOf(200), 0.01, 50000), peakAt(chOf(300), 0.01, 50000)],
    };
    const result = calibrate([src], kit, { defaultModel: 'quadratic' });
    expect(result.quadratic).toBeNull();
    expect(result.selected).toBe('linear');
    expect(result.selectionFellBack).toBe(true);
    expect(activeCalibration(result)).toBe(result.linear);
  });
});

// =============================================================================
// 3. Synthetic end-to-end (condition -> detect -> fit -> calibrate)
// =============================================================================
describe('calibrate -- synthetic end-to-end recovers the hidden quadratic truth', () => {
  // make_demo_sources.py: E(ch) = -5.5 + 1.108*ch + 3.65e-5*ch² (NaI resolution,
  // Compton shelf, Poisson noise, fixed seed -> committed deterministic counts).
  const TRUE = { a: -5.5, b: 1.108, c: 3.65e-5 };
  const trueE = (ch: number) => TRUE.a + TRUE.b * ch + TRUE.c * ch * ch;
  const ids = ['Am-241', 'Ba-133', 'Co-57', 'Cs-137', 'Eu-152', 'Mn-54', 'Co-60'];

  const sources: DeclaredSource[] = ids.map((id) => {
    const s = synthetic[id];
    // Rebuild the TKA text so the e2e runs through the real fail-loud parser.
    const text = [s.liveTimeSec, s.realTimeSec, ...s.counts].join('\n');
    const spectrum = load({ text, fileName: `${id}.TKA` });
    const cond = condition(spectrum);
    const fitted = fit(cond, detect(cond));
    return { sourceId: id, fittedPeaks: fitted, channelCount: spectrum.counts.length };
  });

  it('under auto, selects quadratic and recovers the true coefficients', () => {
    const result = calibrate(sources); // default 'auto'
    expect(result.selected).toBe('quadratic');
    const cal = activeCalibration(result);
    expect(cal.coefficients).toHaveLength(3);
    relClose(cal.coefficients[0], TRUE.a, 0, 2.0); // intercept, keV
    relClose(cal.coefficients[1], TRUE.b, 5e-3); // gain, keV/ch
    relClose(cal.coefficients[2], TRUE.c, 0.2, 5e-6); // curvature, keV/ch²
    for (const ch of [100, 300, 600, 900, 1100]) {
      expect(Math.abs(applyCalibrationToChannel(cal, ch) - trueE(ch)), `ch ${ch}`).toBeLessThan(1.5);
    }
    expect(cal.rms as number).toBeLessThan(3);
  });

  it("under 'quadratic' policy, recovers the same curved truth", () => {
    const result = calibrate(sources, CALIBRATION_KIT, { defaultModel: 'quadratic' });
    expect(result.selected).toBe('quadratic');
    relClose(activeCalibration(result).coefficients[2], TRUE.c, 0.2, 5e-6);
  });

  it("under 'linear' policy, returns the linear best-fit (worse rms, quadratic still present)", () => {
    const result = calibrate(sources, CALIBRATION_KIT, { defaultModel: 'linear' });
    expect(result.selected).toBe('linear');
    expect(result.quadratic).not.toBeNull();
    // The data is genuinely curved, so the line fits worse than the quadratic.
    expect(result.linear.rms as number).toBeGreaterThan(result.quadratic!.rms as number);
    expect(Number.isFinite(result.linear.rms as number)).toBe(true);
  });

  it('reports an honest valid range', () => {
    const [lo, hi] = activeCalibration(calibrate(sources)).validRange as readonly [number, number];
    expect(lo).toBeLessThanOrEqual(60); // Am-241 59.5 keV anchor
    expect(hi).toBeGreaterThanOrEqual(1300); // Co-60 1332 keV anchor
  });
});

// =============================================================================
// 4. Controlled units: σ-clip, anti-hop, fail-loud
// =============================================================================
describe('calibrate -- σ-clip prunes a planted unreliable outlier and refits', () => {
  const kit: CalibrationKit = {
    entries: [
      {
        id: 'SYN',
        displayName: 'Synthetic',
        lines: [
          // 8 anchors on the line (≥10 used points so 3σ clipping is unmasked).
          { energyKeV: 60, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 160, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 260, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 360, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 460, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 560, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 660, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 760, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 330, tier: 'secondary', intensity: 0.5, reliable: true }, // good
          { energyKeV: 430, tier: 'secondary', intensity: 0.5, reliable: false }, // outlier
        ],
      },
    ],
  };

  const anchorPeaks = [60, 160, 260, 360, 460, 560, 660, 760].map((e) => peakAt(chOf(e), 0.01, 50000));
  const goodSecondary = peakAt(chOf(330), 0.05, 5000); // exactly on the line
  const outlier = peakAt(chOf(430) + 10, 0.05, 5000); // +10 ch ⇒ ~5 keV residual
  const result = calibrate(
    [{ sourceId: 'SYN', fittedPeaks: [...anchorPeaks, goodSecondary, outlier] }],
    kit,
  );

  it('drops the unreliable outlier (430 keV) and keeps the 9 good points', () => {
    const pruned = result.linear.points.filter((p) => !p.used && (p.note ?? '').includes('pruned'));
    expect(pruned.map((p) => p.energyKeV)).toEqual([430]);
    expect(result.linear.points.filter((p) => p.used)).toHaveLength(9);
  });

  it('refits the LINEAR candidate to the true law after pruning (≥4 pts ⇒ quadratic present)', () => {
    expect(result.linear.coefficients[0]).toBeCloseTo(10, 6); // intercept
    expect(result.linear.coefficients[1]).toBeCloseTo(0.5, 6); // gain
    expect(result.linear.rms as number).toBeLessThan(1e-6);
    expect(result.quadratic).not.toBeNull();
  });
});

describe('calibrate -- the tight window rejects a peak-hop', () => {
  const kit: CalibrationKit = {
    entries: [
      {
        id: 'HOP',
        displayName: 'Hop test',
        lines: [
          { energyKeV: 100, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 500, tier: 'anchor', intensity: 1, reliable: true },
          { energyKeV: 900, tier: 'anchor', intensity: 1, reliable: true },
          // A secondary whose only nearby fitted peak sits far off-prediction.
          { energyKeV: 300, tier: 'secondary', intensity: 0.4, reliable: true },
        ],
      },
    ],
  };
  // Anchors exactly on E = 10 + 0.5*ch. The 300-keV secondary predicts ch=580;
  // the nearest fitted peak is planted 25 ch away (inside the wide ~30 ch window
  // but past 0.85*mu_tol ≈ 23.6) so it must be rejected as a hop, not matched.
  const anchors = [100, 500, 900].map((e) => peakAt(chOf(e), 0.01, 50000));
  const hopPeak = peakAt(chOf(300) + 25, 0.05, 4000);
  const result = calibrate([{ sourceId: 'HOP', fittedPeaks: [...anchors, hopPeak] }], kit);

  it('marks the secondary rejected (peak-hop) and excludes it from the fit', () => {
    const sec = result.linear.points.find((p) => p.energyKeV === 300);
    expect(sec).toBeDefined();
    expect(sec!.used).toBe(false);
    expect(sec!.note).toContain('peak-hop');
    // Only the 3 anchors survive (quadratic unavailable at 3 pts); fit stays exact.
    expect(result.linear.points.filter((p) => p.used)).toHaveLength(3);
    expect(result.quadratic).toBeNull();
    expect(result.linear.coefficients[0]).toBeCloseTo(10, 6);
    expect(result.linear.coefficients[1]).toBeCloseTo(0.5, 6);
  });
});

describe('calibrate -- fails loud, never fabricating an equation (RISK-01/04)', () => {
  const anchorKit = (n: number): CalibrationKit => ({
    entries: [
      {
        id: 'A',
        displayName: 'A',
        lines: Array.from({ length: n }, (_, i) => ({
          energyKeV: 100 + i * 100,
          tier: 'anchor' as const,
          intensity: 1,
          reliable: true,
        })),
      },
    ],
  });

  it('throws on no declared sources', () => {
    expect(() => calibrate([], CALIBRATION_KIT)).toThrow(ValidationError);
  });

  it('throws on a declared id absent from the kit', () => {
    expect(() =>
      calibrate([{ sourceId: 'NOPE', fittedPeaks: [peakAt(100, 0.01, 1000)] }], CALIBRATION_KIT),
    ).toThrow(ValidationError);
  });

  it('throws when fewer than two anchor lines are matched', () => {
    const kit = anchorKit(3);
    const src: DeclaredSource = { sourceId: 'A', fittedPeaks: [peakAt(chOf(100), 0.01, 50000)] };
    expect(() => calibrate([src], kit)).toThrow(/at least 2 anchor/);
  });

  it('throws when too few usable points remain for a covariance-bearing fit', () => {
    const kit = anchorKit(2); // two anchors -> passes the anchor gate but <3 points
    const src: DeclaredSource = {
      sourceId: 'A',
      fittedPeaks: [peakAt(chOf(100), 0.01, 50000), peakAt(chOf(200), 0.01, 50000)],
    };
    expect(() => calibrate([src], kit)).toThrow(/usable calibration point/);
  });

  it('fitCalibration refuses a singular (collinear-in-channel) system', () => {
    const pts = [
      { channel: 5, energyKeV: 1, sourceLabel: 'a' },
      { channel: 5, energyKeV: 2, sourceLabel: 'b' },
      { channel: 5, energyKeV: 3, sourceLabel: 'c' },
      { channel: 5, energyKeV: 4, sourceLabel: 'd' },
    ];
    expect(() => fitCalibration(pts, 1)).toThrow(ValidationError);
  });
});

describe('calibrate -- DEBT-16: anchor binds to the photopeak, not backscatter (real pipeline)', () => {
  // The bug GATE-CAL-BROWSER surfaced: on real NaI spectra a tall low-energy
  // BACKSCATTER feature out-peaks the photopeak, so the old amplitude-rank bound a
  // single-anchor source's line (Cs-137 661.7 keV) to the backscatter channel
  // (~30) instead of the photopeak (~590), collapsing the fit. This runs the REAL
  // pipeline (condition -> detect -> fit -> validate -> calibrate) on synthetic
  // spectra carrying a deliberate backscatter decoy, the case the reference-centroid
  // parity + clean synthetic e2e never exercised.
  const TRUE_GAIN = 661.657 / 590; // ~1.1214 keV/ch; places the Cs photopeak at ~590
  const chOf = (energyKeV: number): number => Math.round(energyKeV / TRUE_GAIN);

  function realSource(sourceId: string, peaks: { channel: number; amplitude: number; fwhmChannels: number }[]): DeclaredSource {
    const text = syntheticTka({ channels: 2048, peaks });
    const cond = condition(load({ text, fileName: `${sourceId}.TKA` }));
    const fittedPeaks = validPeaks(validate(fit(cond, detect(cond))));
    return { sourceId, fittedPeaks, channelCount: 2048 };
  }

  // Cs-137: a tall NARROW backscatter decoy (higher amplitude, smaller area) plus
  // the real 661.7 keV photopeak (lower amplitude, larger area). Amplitude-rank
  // picks the decoy (~30); net-area + line-class picks the photopeak (~590).
  const sources: DeclaredSource[] = [
    realSource('Cs-137', [
      { channel: 30, amplitude: 1600, fwhmChannels: 12 }, // backscatter decoy
      { channel: chOf(661.657), amplitude: 800, fwhmChannels: 34 }, // 661.7 photopeak
    ]),
    realSource('Mn-54', [{ channel: chOf(834.848), amplitude: 720, fwhmChannels: 38 }]),
    realSource('Co-60', [
      { channel: chOf(1173.228), amplitude: 660, fwhmChannels: 44 },
      { channel: chOf(1332.492), amplitude: 600, fwhmChannels: 46 },
    ]),
  ];

  it('binds the Cs-137 661.7 keV anchor to the photopeak (~590), not the backscatter (~30)', () => {
    const cal = activeCalibration(calibrate(sources));
    const csPoint = cal.points.find(
      (p) => p.sourceId === 'Cs-137' && Math.abs(p.energyKeV - 661.657) < 0.5,
    );
    expect(csPoint).toBeDefined();
    expect(csPoint!.used).toBe(true);
    expect(csPoint!.channel).toBeGreaterThan(520); // photopeak ~590, NOT backscatter ~30
    expect(csPoint!.channel).toBeLessThan(660);
  });

  it('produces a sane calibration -- the broken-fit signature (huge RMS / low R^2) is gone', () => {
    const cal = activeCalibration(calibrate(sources));
    expect(cal.rms as number).toBeLessThan(8); // not ~420 keV
    expect(cal.rSquared).toBeGreaterThan(0.999); // not ~0.1
    expect(cal.coefficients[1]).toBeGreaterThan(1.0); // recovers the true gain ~1.12 keV/ch
    expect(cal.coefficients[1]).toBeLessThan(1.25);
  });
});
