import { describe, it, expect } from 'vitest';

import { detect } from '../src/pipeline/detect';
import { fit } from '../src/pipeline/fit';
import {
  validate,
  validPeaks,
  MAX_FWHM_CHANNELS,
  MAX_CENTROID_ERROR_CHANNELS,
} from '../src/pipeline/validate';
import type { ConditionedSpectrum, FittedPeak, PeakClass, Spectrum } from '../src/domain/types';

import Am241 from './fixtures/reference/Am-241.json';
import Ba133 from './fixtures/reference/Ba-133.json';
import Co57 from './fixtures/reference/Co-57.json';
import Co60 from './fixtures/reference/Co-60.json';
import Cs137 from './fixtures/reference/Cs-137.json';
import Eu152 from './fixtures/reference/Eu-152.json';
import Mn54 from './fixtures/reference/Mn-54.json';

/**
 * Stage 5 validate tests.
 *
 *  1. UNIT GATE -- on hand-built FittedPeaks: weak/broad classification -> invalid;
 *     a clean 'line' -> valid; absurd FWHM / huge centroidError / non-finite chi2
 *     -> invalid with the right flag; nothing is dropped; every flag is listed.
 *  2. REAL SOURCES -- on the 7 fixtures, run detect -> fit -> validate. Every fit
 *     that survived with classification 'line' AND a sane fit validates `valid`;
 *     every 'broad'/'weak' survivor validates `invalid` with that flag. This
 *     cross-checks the gate against C1's already-reference-verified classification
 *     (no new reference capture needed -- the classification gate reuses C1's rules).
 */

// --- a clean, valid 'line' FittedPeak; override any field per test ------------
function peak(over: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 600,
    centroidError: 0.01,
    amplitude: 5000,
    fwhmChannels: 8,
    netArea: 40000,
    chiSquare: 1000,
    energyKeV: null,
    classification: 'line',
    significance: 200,
    detectedChannel: 600,
    status: 'kept',
    ...over,
  };
}

describe('validate -- unit gate behaviour', () => {
  it('passes a clean line with a good fit (valid, no flags)', () => {
    const [v] = validate([peak()]);
    expect(v.valid).toBe(true);
    expect(v.flags).toEqual([]);
  });

  it("rejects a 'weak' classification with the 'weak' flag", () => {
    const [v] = validate([peak({ classification: 'weak', significance: 2 })]);
    expect(v.valid).toBe(false);
    expect(v.flags).toContain('weak');
  });

  it("rejects a 'broad' classification with the 'broad' flag", () => {
    const [v] = validate([peak({ classification: 'broad' })]);
    expect(v.valid).toBe(false);
    expect(v.flags).toContain('broad');
  });

  it('rejects an absurdly wide FWHM with the wide-fwhm flag', () => {
    const [v] = validate([peak({ fwhmChannels: MAX_FWHM_CHANNELS + 1 })]);
    expect(v.valid).toBe(false);
    expect(v.flags).toContain('wide-fwhm');
  });

  it('rejects a non-finite / non-positive FWHM with the invalid-fwhm flag', () => {
    expect(validate([peak({ fwhmChannels: 0 })])[0].flags).toContain('invalid-fwhm');
    expect(validate([peak({ fwhmChannels: NaN })])[0].flags).toContain('invalid-fwhm');
  });

  it('rejects a huge centroidError with the large-centroid-error flag', () => {
    const [v] = validate([peak({ centroidError: MAX_CENTROID_ERROR_CHANNELS + 1 })]);
    expect(v.valid).toBe(false);
    expect(v.flags).toContain('large-centroid-error');
  });

  it('rejects a non-finite centroidError with the invalid-centroid-error flag', () => {
    expect(validate([peak({ centroidError: NaN })])[0].flags).toContain('invalid-centroid-error');
    expect(validate([peak({ centroidError: 0 })])[0].flags).toContain('invalid-centroid-error');
  });

  it('rejects a non-finite chi-square (poor-fit) but accepts null chi-square', () => {
    expect(validate([peak({ chiSquare: Infinity })])[0].flags).toContain('poor-fit');
    expect(validate([peak({ chiSquare: null })])[0].valid).toBe(true); // null = not computed, ok
  });

  it('lists EVERY failed reason (a broad over-wide fit reports both)', () => {
    const [v] = validate([peak({ classification: 'broad', fwhmChannels: MAX_FWHM_CHANNELS + 50 })]);
    expect(v.flags).toEqual(expect.arrayContaining(['broad', 'wide-fwhm']));
  });

  it('preserves every peak (no silent drop) and keeps input order', () => {
    const peaks = [
      peak({ detectedChannel: 1 }),
      peak({ classification: 'weak', detectedChannel: 2 }),
      peak({ detectedChannel: 3 }),
    ];
    const out = validate(peaks);
    expect(out).toHaveLength(3);
    expect(out.map((v) => v.peak.detectedChannel)).toEqual([1, 2, 3]);
    expect(validPeaks(out)).toHaveLength(2); // the weak one gated out
  });

  it('honours overridden thresholds', () => {
    const p = peak({ fwhmChannels: 120 });
    expect(validate([p])[0].valid).toBe(true); // 120 < default 200
    expect(validate([p], { maxFwhmChannels: 100 })[0].flags).toContain('wide-fwhm');
  });
});

// --- real sources: detect -> fit -> validate, cross-checked vs C1 classification
interface DetFixture { source: string; counts: number[]; snip_background: number[]; net_smoothed: number[]; }
const DET: Record<string, DetFixture> = {
  'Am-241': Am241 as unknown as DetFixture, 'Ba-133': Ba133 as unknown as DetFixture,
  'Co-57': Co57 as unknown as DetFixture, 'Co-60': Co60 as unknown as DetFixture,
  'Cs-137': Cs137 as unknown as DetFixture, 'Eu-152': Eu152 as unknown as DetFixture,
  'Mn-54': Mn54 as unknown as DetFixture,
};
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
  const netCounts = f.counts.map((c, i) => Math.max(0, c - f.snip_background[i]));
  return { source: spectrumOf(f.counts, `${f.source}.TKA`), background: f.snip_background, netCounts, smoothed: f.net_smoothed };
}

describe('validate -- real sources cross-checked against C1 classification', () => {
  for (const name of Object.keys(DET)) {
    it(`${name}: 'line' survivors validate valid; 'broad'/'weak' come back invalid`, () => {
      const cond = conditionedFromFixture(DET[name]);
      const peaks = fit(cond, detect(cond));
      const validated = validate(peaks);

      expect(validated).toHaveLength(peaks.length); // nothing dropped

      for (const v of validated) {
        const cls: PeakClass = v.peak.classification;
        if (cls === 'broad' || cls === 'weak') {
          expect(v.valid, `${name} ${cls}@${v.peak.detectedChannel} must be invalid`).toBe(false);
          expect(v.flags).toContain(cls);
        }
      }

      // The genuine photopeaks (the only fits that pass C1 'line' AND the C2 guard)
      // come through valid: every source recovers at least one valid line.
      const valid = validPeaks(validated);
      expect(valid.length, `${name}: at least one valid line`).toBeGreaterThan(0);
      for (const p of valid) expect(p.classification).toBe('line');
    });
  }

  it('Cs-137 recovers its 661.7 keV photopeak as a valid line', () => {
    const cond = conditionedFromFixture(DET['Cs-137']);
    const valid = validPeaks(validate(fit(cond, detect(cond))));
    // the strong narrow line near channel 590 (the 661.7 keV photopeak) survives.
    expect(valid.some((p) => Math.abs(p.detectedChannel - 590) <= 5)).toBe(true);
  });
});
