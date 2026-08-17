import { describe, it, expect } from 'vitest';
import { detect } from '../src/pipeline/detect';
import {
  fit,
  fitPeak,
  FWHM_PER_SIGMA,
  MAX_CENTROID_DRIFT_FWHM,
} from '../src/pipeline/fit';
import type { ConditionedSpectrum, Spectrum } from '../src/domain/types';

import Am241 from './fixtures/reference/Am-241.json';
import Ba133 from './fixtures/reference/Ba-133.json';
import Co57 from './fixtures/reference/Co-57.json';
import Co60 from './fixtures/reference/Co-60.json';
import Cs137 from './fixtures/reference/Cs-137.json';
import Eu152 from './fixtures/reference/Eu-152.json';
import Mn54 from './fixtures/reference/Mn-54.json';
import FitTruth from './fixtures/reference/_fit_ground_truth.json';

/**
 * C2 fit tests, verified against the reference `energy_calibration.fit_gaussian`
 * (Gaussian + linear background, Poisson weights, absolute_sigma=True; scipy
 * 1.18.0 / numpy 2.5.0) via the committed `_fit_ground_truth.json`.
 *
 * Parity strategy. The reference's anchor-path `fit_gaussian`, run on EVERY
 * detected peak (it was designed only for strong 'line' anchors), produces
 * garbage on broad/weak peaks -- it slides the centroid to the window edge or
 * hops onto a distant strong line. Our fit GUARDS against that (RISK-01). So we
 * assert parity where the fit is well-posed -- strong, isolated 'line' peaks --
 * and assert the GUARD elsewhere:
 *
 *   1. Dichotomy (no fudge factor): for every window-isolated 'line' peak the
 *      reference accepted with an interior centroid, our fit must EITHER reject it
 *      OR accept it with a centroid that matches the reference. It may never
 *      accept a divergent confident centroid.
 *   2. Magnitudes: across all 'line' fits both solvers agree on (centroid within
 *      AGREE_GATE), the centroid/FWHM/area/chi2/centroid-error match within the
 *      stated tolerances, with broad per-source coverage.
 *   3. Guard: the known reference hops (Cs-137 ch117 -> mu=58, Co-60 ch202 ->
 *      mu=812, the curve_fit non-convergences) are refused, never surfaced.
 *
 * Tolerances (max observed on the isolated line set, with margin):
 *   centroid <= 2e-2 ch | FWHM <= 0.1 ch | amplitude 1.2e-2 rel | area 1.2e-2 rel
 *   chi2 5e-3 rel | centroidError 2e-2 rel (+5e-4 abs).
 */

interface DetFixture {
  source: string;
  counts: number[];
  snip_background: number[];
  net_smoothed: number[];
  peaks: number[];
}
const DET: Record<string, DetFixture> = {
  'Am-241': Am241 as unknown as DetFixture,
  'Ba-133': Ba133 as unknown as DetFixture,
  'Co-57': Co57 as unknown as DetFixture,
  'Co-60': Co60 as unknown as DetFixture,
  'Cs-137': Cs137 as unknown as DetFixture,
  'Eu-152': Eu152 as unknown as DetFixture,
  'Mn-54': Mn54 as unknown as DetFixture,
};

interface FitPeakTruth {
  guess_channel: number;
  lo: number;
  hi: number;
  accepted: boolean;
  reject_reason: string | null;
  mu?: number;
  mu_err?: number;
  fwhm?: number;
  amp?: number;
  area?: number;
  chi2?: number;
}
interface FitTruthFile {
  sources: Record<string, { guess_channels: number[]; peaks: FitPeakTruth[] }>;
}
const TRUTH = (FitTruth as unknown as FitTruthFile).sources;

const SOURCES = ['Am-241', 'Ba-133', 'Co-57', 'Co-60', 'Cs-137', 'Eu-152', 'Mn-54'];

// --- tolerances -------------------------------------------------------------
const TOL_MU = 2e-2; // channels
const TOL_FWHM = 0.1; // channels
const TOL_AMP_REL = 1.2e-2;
const TOL_AREA_REL = 1.2e-2;
const TOL_CHI2_REL = 5e-3;
const TOL_MUERR_REL = 2e-2;
const TOL_MUERR_ABS = 5e-4;
/** Centroid gap below which the two solvers are deemed to agree on a peak. Far
 * below any real congested-peak divergence (those are >= 2 ch apart). */
const AGREE_GATE = 0.3;

function spectrumOf(counts: readonly number[], fileName: string): Spectrum {
  return {
    counts,
    metadata: {
      fileName,
      format: 'tka',
      liveTimeSec: null,
      realTimeSec: null,
      channelCount: counts.length,
      statedNuclideHint: null,
      fileSizeBytes: null,
      detector: null,
      sampleName: null,
      measurementDate: null,
    },
  };
}
function conditionedFromFixture(f: DetFixture): ConditionedSpectrum {
  const counts = f.counts;
  const background = f.snip_background;
  const netCounts = counts.map((c, i) => Math.max(0, c - background[i]));
  return { source: spectrumOf(counts, `${f.source}.TKA`), background, netCounts, smoothed: f.net_smoothed };
}

/** Reference centroid sits clear of both window edges (a real line, not a slide). */
function refInterior(p: FitPeakTruth): boolean {
  return p.accepted && p.mu !== undefined && p.mu - p.lo >= 1 + 1e-9 && p.hi - p.mu >= 1 + 1e-9;
}
/** No OTHER detected peak falls inside this peak's fit window (uncontaminated). */
function windowIsolated(guessChannels: readonly number[], idx: number, p: FitPeakTruth): boolean {
  return !guessChannels.some((g, j) => j !== idx && g > p.lo && g < p.hi);
}

describe('fit -- detect channels align with the fit fixture', () => {
  for (const name of SOURCES) {
    it(`${name}: detect() channels equal the fixture guess channels`, () => {
      const peaks = detect(conditionedFromFixture(DET[name]));
      expect(peaks.map((p) => p.channel)).toEqual(TRUTH[name].guess_channels);
    });
  }
});

describe('fit -- dichotomy on isolated line peaks (reject or match, never divergent)', () => {
  for (const name of SOURCES) {
    it(`${name}: every isolated 'line' fit is rejected or matches the reference centroid`, () => {
      const det = DET[name];
      const truth = TRUTH[name];
      const peaks = detect(conditionedFromFixture(det));
      for (let i = 0; i < peaks.length; i++) {
        const dp = peaks[i];
        const t = truth.peaks[i];
        if (dp.classification !== 'line' || !refInterior(t)) continue;
        if (!windowIsolated(truth.guess_channels, i, t)) continue;
        const o = fitPeak(det.counts, dp.channel, dp.fwhmChannels);
        if (o.accepted && o.peak) {
          // Accepting an isolated line is only allowed if it matches the reference.
          expect(
            Math.abs(o.peak.centroidChannel - (t.mu as number)),
            `${name} ch${dp.channel} accepted but centroid diverges`,
          ).toBeLessThanOrEqual(TOL_MU);
        }
        // else: rejected -- always allowed (a refusal is never a wrong centroid).
      }
    });
  }
});

describe('fit -- value parity on the agreed line set', () => {
  let totalMatched = 0;
  for (const name of SOURCES) {
    it(`${name}: agreed line fits match centroid/FWHM/area/chi2/centroidError`, () => {
      const det = DET[name];
      const truth = TRUTH[name];
      const peaks = detect(conditionedFromFixture(det));
      let matched = 0;
      for (let i = 0; i < peaks.length; i++) {
        const dp = peaks[i];
        const t = truth.peaks[i];
        if (dp.classification !== 'line' || !refInterior(t)) continue;
        const o = fitPeak(det.counts, dp.channel, dp.fwhmChannels);
        if (!o.accepted || !o.peak) continue;
        const isolated = windowIsolated(truth.guess_channels, i, t);
        const agree = Math.abs(o.peak.centroidChannel - (t.mu as number)) < AGREE_GATE;
        if (!isolated && !agree) continue; // congested + divergent -> not value-compared
        matched++;
        const p = o.peak;
        const tag = `${name} ch${dp.channel}`;
        expect(Math.abs(p.centroidChannel - (t.mu as number)), `${tag} mu`).toBeLessThanOrEqual(TOL_MU);
        expect(Math.abs(p.fwhmChannels - (t.fwhm as number)), `${tag} fwhm`).toBeLessThanOrEqual(TOL_FWHM);
        expect(Math.abs(p.amplitude - (t.amp as number)) / (t.amp as number), `${tag} amp`).toBeLessThanOrEqual(TOL_AMP_REL);
        expect(Math.abs(p.netArea - (t.area as number)) / (t.area as number), `${tag} area`).toBeLessThanOrEqual(TOL_AREA_REL);
        expect(Math.abs((p.chiSquare as number) - (t.chi2 as number)) / (t.chi2 as number), `${tag} chi2`).toBeLessThanOrEqual(TOL_CHI2_REL);
        const muErr = t.mu_err as number;
        expect(Math.abs(p.centroidError - muErr), `${tag} centroidError`).toBeLessThanOrEqual(TOL_MUERR_ABS + TOL_MUERR_REL * muErr);
        // Channel-space outputs only until calibration.
        expect(p.energyKeV).toBeNull();
        expect(Number.isFinite(p.centroidError) && p.centroidError > 0).toBe(true);
      }
      expect(matched, `${name} matched line count`).toBeGreaterThanOrEqual(1);
      totalMatched += matched;
    });
  }
  it('covers a broad set of lines across all sources', () => {
    expect(totalMatched).toBeGreaterThanOrEqual(20);
  });
});

describe('fit -- the peak-hopping guard refuses the reference hops', () => {
  const fitAt = (name: string, channel: number) => {
    const det = DET[name];
    const peaks = detect(conditionedFromFixture(det));
    const dp = peaks.find((p) => p.channel === channel)!;
    return fitPeak(det.counts, dp.channel, dp.fwhmChannels);
  };

  it('Cs-137 ch117 (reference slid centroid to the window edge, mu=58) is rejected', () => {
    const o = fitAt('Cs-137', 117);
    expect(o.accepted).toBe(false);
    expect(['centroid_drifted_off_peak', 'centroid_pinned_to_window_edge']).toContain(o.reason);
  });
  it('Co-60 ch202 (reference hopped onto a distant line, mu=812) is rejected', () => {
    const o = fitAt('Co-60', 202);
    expect(o.accepted).toBe(false);
  });
  it('a curve_fit non-convergence (Ba-133 ch49) is not surfaced as a confident line', () => {
    const o = fitAt('Ba-133', 49);
    expect(o.accepted).toBe(false);
  });
});

// --- synthetic units (closed-form ground truth, no reference needed) ----------

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Deterministic Gaussian + linear background as integer-ish counts. */
function syntheticCounts(opts: {
  n: number;
  amp: number;
  mu: number;
  sigma: number;
  slope?: number;
  intercept?: number;
}): number[] {
  const { n, amp, mu, sigma, slope = 0, intercept = 0 } = opts;
  const out = new Array<number>(n);
  for (let x = 0; x < n; x++) {
    const z = (x - mu) / sigma;
    out[x] = Math.max(0, Math.round(amp * Math.exp(-0.5 * z * z) + slope * x + intercept));
  }
  return out;
}

describe('fit -- synthetic Gaussian recovery and edge behaviour', () => {
  it('recovers a known Gaussian (centroid within error, FWHM/area within tolerance)', () => {
    const truthMu = 200.37;
    const sigma = 6;
    const amp = 4000;
    const counts = syntheticCounts({ n: 512, amp, mu: truthMu, sigma, intercept: 120 });
    const fwhmCh = FWHM_PER_SIGMA * sigma;
    const o = fitPeak(counts, 200, fwhmCh);
    expect(o.accepted).toBe(true);
    const p = o.peak!;
    expect(Math.abs(p.centroidChannel - truthMu)).toBeLessThan(0.1);
    // Recovered within a few of its own reported 1-sigma.
    expect(Math.abs(p.centroidChannel - truthMu)).toBeLessThan(5 * p.centroidError);
    expect(Math.abs(p.fwhmChannels - fwhmCh)).toBeLessThan(0.3);
    expect(Math.abs(p.netArea - amp * sigma * SQRT_2PI) / (amp * sigma * SQRT_2PI)).toBeLessThan(0.02);
    expect(p.centroidError).toBeGreaterThan(0);
    expect(Number.isFinite(p.chiSquare as number)).toBe(true);
  });

  it('a flat (peakless) window never yields a confident centroid', () => {
    // A flat window has no peak: amplitude collapses to ~0 and the centroid is
    // unlocalisable, so the fit must NOT report a small (confident) error. Either
    // it is refused, or its centroidError is enormous (zero calibration weight).
    // Hard significance gating is the validate stage's job, not fit's.
    for (const level of [0, 5, 500]) {
      const flat = new Array<number>(60).fill(level);
      const o = fitPeak(flat, 30, 6);
      if (o.accepted) {
        expect(o.peak!.centroidError, `flat@${level}`).toBeGreaterThan(1);
      } else {
        expect(o.peak).toBeNull();
      }
    }
  });

  it('handles a low-count peak without throwing or inventing a tiny error', () => {
    const counts = syntheticCounts({ n: 120, amp: 25, mu: 60, sigma: 4, intercept: 5 });
    const o = fitPeak(counts, 60, FWHM_PER_SIGMA * 4);
    // Either a coherent accept (finite, positive error) or an honest refusal.
    if (o.accepted) {
      expect(Number.isFinite(o.peak!.centroidError) && o.peak!.centroidError > 0).toBe(true);
      expect(Math.abs(o.peak!.centroidChannel - 60)).toBeLessThanOrEqual(MAX_CENTROID_DRIFT_FWHM * FWHM_PER_SIGMA * 4);
    } else {
      expect(o.peak).toBeNull();
      expect(o.reason).toBeTruthy();
    }
  });

  it('a window with too few points is refused', () => {
    const o = fitPeak([10, 12, 11, 13, 10], 2, 1); // n=5 < MIN_FIT_POINTS after flooring
    expect(o.accepted).toBe(false);
    expect(o.reason).toBe('too_few_points');
  });
});

describe('fit -- pipeline-facing behaviour', () => {
  it('fit() returns only accepted peaks, in detection order, channel-space only', () => {
    const det = DET['Cs-137'];
    const conditioned = conditionedFromFixture(det);
    const candidates = detect(conditioned);
    const fitted = fit(conditioned, candidates);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted.length).toBeLessThanOrEqual(candidates.length); // hops/broad dropped
    for (let i = 1; i < fitted.length; i++) {
      expect(fitted[i].centroidChannel).toBeGreaterThan(fitted[i - 1].centroidChannel);
    }
    for (const p of fitted) {
      expect(p.energyKeV).toBeNull();
      expect(Number.isFinite(p.centroidError) && p.centroidError > 0).toBe(true);
      expect(Number.isFinite(p.chiSquare as number)).toBe(true);
    }
  });

  it('fit() on no candidates returns an empty list (no throw)', () => {
    const conditioned = conditionedFromFixture(DET['Cs-137']);
    expect(fit(conditioned, [])).toEqual([]);
  });
});
