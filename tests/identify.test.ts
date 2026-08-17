import { describe, it, expect } from 'vitest';

import {
  identify,
  FLAG_ANNIHILATION,
  FLAG_SINGLE_ESCAPE,
  FLAG_DOUBLE_ESCAPE,
} from '../src/pipeline/identify';
import { load } from '../src/pipeline/load';
import { condition } from '../src/pipeline/condition';
import { detect } from '../src/pipeline/detect';
import { fit } from '../src/pipeline/fit';
import { validate, validPeaks } from '../src/pipeline/validate';
import {
  calibrate,
  activeCalibration,
  applyCalibrationToChannel,
  type DeclaredSource,
} from '../src/pipeline/calibrate';
import { applyCalibration } from '../src/pipeline/applyCalibration';
import { createCalibrationStore, type StorageBackend } from '../src/data/calibrationStore';
import { NUCLIDE_LIBRARY } from '../src/data/nuclides';
import type { EnergisedPeak, FittedPeak, NuclideLibrary } from '../src/domain/types';

import GT from './fixtures/reference/_identify_ground_truth.json';
import SYNTHETIC from './fixtures/synthetic-calibration/synthetic_spectra.json';

/**
 * I2 identify tests.
 *  1. REFERENCE PARITY -- the TS `identify` reproduces the reference
 *     `gamma_identify` ranking/score/completeness/coverage/verdict on the
 *     captured `_identify_ground_truth.json` (IDENTICAL peaks + library + range).
 *  2. GENERALITY (GATE-C) -- calibrate (C3) -> store (C4) -> condition..detect..
 *     fit..validate..applyCalibration..identify on a held-out library source ->
 *     that isotope ranked #1 STRONG.
 *  3. UNIT -- clean fingerprint STRONG; partial/single-line not-STRONG; 511/escape
 *     flagged; ranking + top-2 gap; empty/no-match -> empty (fail-soft).
 */

// --- fixture typing ---------------------------------------------------------
interface GtPeak {
  channel: number;
  energy: number;
  fwhm_kev: number;
  area: number;
  significance: number;
  chi2: number | null;
  note: string;
  matched_to: string[];
}
interface GtScore {
  isotope: string;
  score: number;
  completeness: number;
  coverage: number;
  matched: [number, number][];
  missing_strong: number[];
  strongest_present: boolean;
  n_bonus: number;
}
interface GtSource {
  emin: number;
  emax: number;
  total_strength: number;
  peaks: GtPeak[];
  scores: GtScore[];
  verdict: string | null;
}
const gt = GT as unknown as {
  library: Record<string, [number, number][]>;
  sources: Record<string, GtSource>;
};

interface SyntheticSpectrum {
  liveTimeSec: number;
  realTimeSec: number;
  counts: number[];
}
const synthetic = SYNTHETIC as unknown as Record<string, SyntheticSpectrum>;

// --- helpers ----------------------------------------------------------------

function fittedFrom(overrides: Partial<FittedPeak>): FittedPeak {
  return {
    centroidChannel: 0,
    centroidError: 0.1,
    amplitude: 1000,
    fwhmChannels: 5,
    netArea: 5000,
    chiSquare: 1,
    energyKeV: null,
    classification: 'line',
    significance: 100,
    detectedChannel: 0,
    status: 'kept',
    ...overrides,
  };
}

/** An EnergisedPeak at a given energy with a chosen significance/FWHM. */
function energised(energyKeV: number, significance = 100, fwhmKeV = 5): EnergisedPeak {
  return {
    peak: fittedFrom({
      centroidChannel: energyKeV,
      significance,
      detectedChannel: Math.round(energyKeV),
    }),
    energyKeV,
    energyErrorKeV: 0.1,
    fwhmKeV,
    inValidRange: true,
  };
}

function peakFromFixture(p: GtPeak): EnergisedPeak {
  return {
    peak: fittedFrom({
      centroidChannel: p.channel,
      netArea: p.area,
      chiSquare: p.chi2,
      energyKeV: p.energy,
      significance: p.significance,
      detectedChannel: Math.round(p.channel),
    }),
    energyKeV: p.energy,
    energyErrorKeV: 0,
    fwhmKeV: p.fwhm_kev,
    inValidRange: true,
  };
}

function libraryFromFixture(): NuclideLibrary {
  return {
    entries: Object.entries(gt.library).map(([id, lines]) => ({
      id,
      displayName: id,
      halfLifeSec: null,
      lines: lines.map(([energyKeV, intensity]) => ({ energyKeV, intensity })),
    })),
  };
}

function memoryBackend(): StorageBackend {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

// --- 1. REFERENCE PARITY ----------------------------------------------------

describe('identify -- reference parity (gamma_identify)', () => {
  const lib = libraryFromFixture();
  const sourceIds = Object.keys(gt.sources);

  for (const id of sourceIds) {
    it(`reproduces the reference ranking for ${id}`, () => {
      const src = gt.sources[id];
      const peaks = src.peaks.map(peakFromFixture);
      const result = identify(peaks, lib, { energyRange: [src.emin, src.emax] });

      // Same isotopes, same order.
      expect(result.ranked.map((r) => r.nuclide.id)).toEqual(src.scores.map((s) => s.isotope));

      // Same score / completeness / coverage / matched count per isotope.
      result.ranked.forEach((r, i) => {
        const ref = src.scores[i];
        expect(r.score).toBeCloseTo(ref.score, 6);
        expect(r.completeness).toBeCloseTo(ref.completeness, 6);
        expect(r.coverage).toBeCloseTo(ref.coverage, 6);
        expect(r.matchedLines).toHaveLength(ref.matched.length);
      });

      // Verdict of the top candidate matches the reference conclusion.
      if (src.verdict) {
        expect(result.ranked[0]?.verdict).toBe(src.verdict.toUpperCase());
      } else {
        expect(result.ranked).toHaveLength(0);
      }

      // The fixture has no artifact notes; our peakFlags must match that.
      const refFlagged = src.peaks.filter((p) => p.note !== '').length;
      expect(result.peakFlags).toHaveLength(refFlagged);
    });
  }
});

// --- 2. GENERALITY (GATE-C keystone) ----------------------------------------

describe('identify -- generality: calibrate -> store -> identify a held-out source', () => {
  // Build all 7 declared sources from the synthetic spectra (the calibrate e2e set).
  const sources: DeclaredSource[] = Object.keys(synthetic).map((id) => {
    const s = synthetic[id];
    const text = [s.liveTimeSec, s.realTimeSec, ...s.counts].join('\n');
    const spectrum = load({ text, fileName: `${id}.TKA` });
    const cond = condition(spectrum);
    const fitted = fit(cond, detect(cond));
    return { sourceId: id, fittedPeaks: fitted, channelCount: spectrum.counts.length };
  });

  it('ranks Co-60 #1 with a STRONG verdict end-to-end', () => {
    // C3 calibrate (auto -> quadratic on the curved synthetic truth).
    const result = calibrate(sources);

    // C4 persist + activate.
    const store = createCalibrationStore(memoryBackend());
    const saved = store.save({ name: 'synthetic', sources: sources.map((s) => s.sourceId), result });
    expect(store.getActive()?.id).toBe(saved.id);
    const cal = activeCalibration(store.getActive()!.result);

    // Identify Co-60's spectrum as the unknown (identity derived only from
    // energies + library, Rule 12 -- the calibration only supplies the equation).
    const s = synthetic['Co-60'];
    const text = [s.liveTimeSec, s.realTimeSec, ...s.counts].join('\n');
    const spectrum = load({ text, fileName: 'unknown.TKA' });
    const cond = condition(spectrum);
    const energisedPeaks = applyCalibration(validPeaks(validate(fit(cond, detect(cond)))), cal);

    const nchan = spectrum.counts.length;
    const energyRange: [number, number] = [
      applyCalibrationToChannel(cal, 0),
      applyCalibrationToChannel(cal, nchan - 1),
    ];
    const id = identify(energisedPeaks, NUCLIDE_LIBRARY, { energyRange });

    expect(id.ranked[0]?.nuclide.id).toBe('Co-60');
    expect(id.ranked[0]?.verdict).toBe('STRONG');
  });
});

// --- 3. UNIT ----------------------------------------------------------------

describe('identify -- unit behaviour', () => {
  const range: [number, number] = [0, 2000];

  it('a clean full fingerprint scores STRONG', () => {
    // Co-60: both required lines present and dominant -> completeness 1, coverage 1.
    const peaks = [energised(1173.228, 500), energised(1332.492, 500)];
    const result = identify(peaks, NUCLIDE_LIBRARY, { energyRange: range });
    expect(result.ranked[0].nuclide.id).toBe('Co-60');
    expect(result.ranked[0].completeness).toBeCloseTo(1, 6);
    expect(result.ranked[0].coverage).toBeCloseTo(1, 6);
    expect(result.ranked[0].verdict).toBe('STRONG');
  });

  it('a partial multi-line match is NOT STRONG (no false positive)', () => {
    // Only one of Co-60's two required lines, plus a big unexplained peak ->
    // completeness 0.5 (< 0.6) -> cannot be STRONG.
    const peaks = [energised(1173.228, 100), energised(700.0, 900)];
    const result = identify(peaks, NUCLIDE_LIBRARY, { energyRange: range });
    const co60 = result.ranked.find((r) => r.nuclide.id === 'Co-60');
    expect(co60).toBeDefined();
    // one of two near-equal-intensity required lines matched -> ~0.5, below the
    // STRONG completeness floor (0.6).
    expect(co60!.completeness).toBeCloseTo(0.5, 2);
    expect(co60!.completeness).toBeLessThan(0.6);
    expect(co60!.verdict).not.toBe('STRONG');
  });

  it('flags 511 annihilation and single/double escape peaks', () => {
    // A strong 1332.5 keV line seeds escapes at 821.5 (-511) and 310.5 (-1022);
    // plus a peak at 511 keV.
    const peaks = [
      energised(1332.492, 500),
      energised(511.0, 50),
      energised(1332.492 - 511.0, 40),
      energised(1332.492 - 1022.0, 30),
    ];
    const result = identify(peaks, NUCLIDE_LIBRARY, { energyRange: range });
    const flagsByEnergy = new Map(
      result.peakFlags.map((pf) => [Math.round(pf.peak.energyKeV), pf.flags]),
    );
    expect(flagsByEnergy.get(511)).toContain(FLAG_ANNIHILATION);
    expect(flagsByEnergy.get(Math.round(1332.492 - 511.0))).toContain(FLAG_SINGLE_ESCAPE);
    expect(flagsByEnergy.get(Math.round(1332.492 - 1022.0))).toContain(FLAG_DOUBLE_ESCAPE);
  });

  it('ranks by score and applies the top-2 gap to the verdict', () => {
    // Co-60 (clean) should clearly out-rank a lone weak Cs-137-ish hit.
    const peaks = [energised(1173.228, 500), energised(1332.492, 500), energised(661.657, 5)];
    const result = identify(peaks, NUCLIDE_LIBRARY, { energyRange: range });
    expect(result.ranked[0].nuclide.id).toBe('Co-60');
    // descending by score
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i - 1].score).toBeGreaterThanOrEqual(result.ranked[i].score);
    }
    expect(result.ranked[0].verdict).toBe('STRONG');
  });

  it('empty peaks and no-match both yield an empty ranking (fail-soft)', () => {
    expect(identify([], NUCLIDE_LIBRARY, { energyRange: range }).ranked).toEqual([]);
    const noMatch = identify([energised(450.0)], NUCLIDE_LIBRARY, { energyRange: range });
    expect(noMatch.ranked).toEqual([]);
  });
});
