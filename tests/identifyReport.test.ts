import { describe, it, expect } from 'vitest';

import {
  buildOverlay,
  summarizeIdentification,
  exportIdentificationJson,
  exportIdentificationCsv,
  CAVEAT_SINGLE_LINE,
  CAVEAT_ARTIFACT_PEAK,
  CAVEAT_MISSING_STRONG,
  CSV_ISOTOPE_COLUMNS,
  CSV_PEAK_COLUMNS,
} from '../src/pipeline/identifyReport';
import { assembleReport } from '../src/pipeline/report';
import {
  identify,
  FLAG_SINGLE_LINE,
  FLAG_MISSING_STRONG,
  FLAG_ANNIHILATION,
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
import { NUCLIDE_LIBRARY } from '../src/data/nuclides';
import type {
  EnergisedPeak,
  FittedPeak,
  IdentificationResult,
  IsotopeMatch,
  NuclideEntry,
  GammaLine,
  Spectrum,
} from '../src/domain/types';

import SYNTHETIC from './fixtures/synthetic-calibration/synthetic_spectra.json';

const synthetic = SYNTHETIC as unknown as Record<
  string,
  { liveTimeSec: number; realTimeSec: number; counts: number[] }
>;

// --- factories --------------------------------------------------------------

function energised(energyKeV: number, significance = 500, fwhmKeV = 5): EnergisedPeak {
  const peak: FittedPeak = {
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
  };
  return { peak, energyKeV, energyErrorKeV: 0.1, fwhmKeV, inValidRange: true };
}

function nuclide(id: string, displayName: string, lines: GammaLine[]): NuclideEntry {
  return { id, displayName, halfLifeSec: null, lines };
}

function match(
  nuc: NuclideEntry,
  matched: { line: GammaLine; measured: EnergisedPeak }[],
  over: Partial<IsotopeMatch> = {},
): IsotopeMatch {
  return {
    nuclide: nuc,
    completeness: 1,
    coverage: 1,
    score: 1,
    verdict: 'STRONG',
    matchedLines: matched.map((m) => ({
      line: m.line,
      measured: m.measured,
      deltaKeV: m.measured.energyKeV - m.line.energyKeV,
      toleranceKeV: 3,
    })),
    flags: [],
    ...over,
  };
}

// --- A. report carries it ---------------------------------------------------

describe('assembleReport -- carries the identification additively', () => {
  const spectrum = { counts: [0, 1, 2], metadata: {} as Spectrum['metadata'] } as Spectrum;
  const base = {
    spectrum,
    conditioned: null,
    detectedCandidates: [],
    peaks: [],
    calibration: null,
    identifications: [],
    activities: [],
    trace: [],
  };

  it('omits identification when not supplied (existing behaviour intact)', () => {
    const report = assembleReport(base);
    expect('identification' in report).toBe(false);
    expect(report.identifications).toEqual([]);
  });

  it('round-trips the identification when supplied', () => {
    const result: IdentificationResult = { ranked: [], peakFlags: [] };
    const report = assembleReport({ ...base, identification: result });
    expect(report.identification).toBe(result);
  });
});

// --- B. overlay -------------------------------------------------------------

describe('buildOverlay', () => {
  const co60 = nuclide('Co-60', 'Cobalt-60', [
    { energyKeV: 1173.228, intensity: 0.9985 },
    { energyKeV: 1332.492, intensity: 0.999826 },
  ]);
  const ba133 = nuclide('Ba-133', 'Barium-133', [{ energyKeV: 356.013, intensity: 0.621 }]);

  const pA = energised(1170.2, 1007.9);
  const pB = energised(1326.7, 965.4);
  const pBa = energised(355.0, 800);

  const result: IdentificationResult = {
    ranked: [
      match(co60, [
        { line: co60.lines[0], measured: pA },
        { line: co60.lines[1], measured: pB },
      ]),
      match(ba133, [{ line: ba133.lines[0], measured: pBa }], { verdict: 'TENTATIVE', score: 0.4 }),
    ],
    peakFlags: [{ peak: pB, flags: [FLAG_ANNIHILATION] }],
  };

  it('returns one marker per matched line of the top isotope, with measured linkage', () => {
    const markers = buildOverlay(result);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      energyKeV: 1173.228,
      intensity: 0.9985,
      isotopeId: 'Co-60',
      measuredChannel: pA.peak.centroidChannel,
      measuredEnergyKeV: 1170.2,
    });
    expect(markers[0].deltaKeV).toBeCloseTo(1170.2 - 1173.228, 6);
  });

  it('marks a matched artifact peak isArtifact:true', () => {
    const markers = buildOverlay(result);
    expect(markers[0].isArtifact).toBe(false); // pA not flagged
    expect(markers[1].isArtifact).toBe(true); // pB flagged 511
  });

  it('can overlay a non-top isotope by id', () => {
    const markers = buildOverlay(result, 'Ba-133');
    expect(markers).toHaveLength(1);
    expect(markers[0].isotopeId).toBe('Ba-133');
  });

  it('returns [] for an absent isotope or empty result', () => {
    expect(buildOverlay(result, 'Cs-137')).toEqual([]);
    expect(buildOverlay({ ranked: [], peakFlags: [] })).toEqual([]);
  });
});

// --- C. export --------------------------------------------------------------

describe('export', () => {
  const co60 = nuclide('Co-60', 'Cobalt-60', [
    { energyKeV: 1173.228, intensity: 0.9985 },
    { energyKeV: 1332.492, intensity: 0.999826 },
  ]);
  const comma = nuclide('X-1', 'Test, Inc', [{ energyKeV: 100, intensity: 1 }]);
  const pA = energised(1170.2, 1007.9);
  const pB = energised(1326.7, 965.4);
  const pX = energised(100.5, 50);
  const peaks = [pA, pB, pX];
  const result: IdentificationResult = {
    ranked: [
      match(co60, [
        { line: co60.lines[0], measured: pA },
        { line: co60.lines[1], measured: pB },
      ]),
      match(comma, [{ line: comma.lines[0], measured: pX }], {
        verdict: 'TENTATIVE',
        score: 0.4,
        flags: [FLAG_SINGLE_LINE],
      }),
    ],
    peakFlags: [{ peak: pB, flags: [FLAG_ANNIHILATION] }],
  };

  it('JSON round-trips to an equal structure', () => {
    const parsed = JSON.parse(exportIdentificationJson(result));
    expect(parsed).toEqual(result);
  });

  it('CSV has both tables with the documented columns', () => {
    const csv = exportIdentificationCsv(result, peaks);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('# isotopes');
    expect(lines[1]).toBe(CSV_ISOTOPE_COLUMNS.join(','));
    const peakHeaderIdx = lines.indexOf('# peaks');
    expect(peakHeaderIdx).toBeGreaterThan(0);
    expect(lines[peakHeaderIdx + 1]).toBe(CSV_PEAK_COLUMNS.join(','));
    // every isotope data row has the right column count (quoted commas don't inflate)
    const isoRows = lines.slice(2, peakHeaderIdx - 1); // -1 drops the blank separator
    isoRows
      .filter((r) => r)
      .forEach((r) => {
        expect(splitCsv(r)).toHaveLength(CSV_ISOTOPE_COLUMNS.length);
      });
  });

  it('quotes fields containing a comma', () => {
    const csv = exportIdentificationCsv(result, peaks);
    expect(csv).toContain('"Test, Inc"');
  });
});

/** Minimal RFC-4180 split for assertion (handles quoted commas). */
function splitCsv(row: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (q) {
      if (c === '"' && row[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// --- D. summary -------------------------------------------------------------

describe('summarizeIdentification', () => {
  const co60 = nuclide('Co-60', 'Cobalt-60', [
    { energyKeV: 1173.228, intensity: 0.9985 },
    { energyKeV: 1332.492, intensity: 0.999826 },
  ]);
  const cs137 = nuclide('Cs-137', 'Caesium-137', [{ energyKeV: 661.657, intensity: 0.851 }]);
  const pA = energised(1170.2);
  const pB = energised(1326.7);

  it('reports the top verdict/score and counts', () => {
    const result: IdentificationResult = {
      ranked: [
        match(co60, [
          { line: co60.lines[0], measured: pA },
          { line: co60.lines[1], measured: pB },
        ]),
        match(cs137, [{ line: cs137.lines[0], measured: energised(661.7) }], {
          verdict: 'TENTATIVE',
          score: 0.4,
          flags: [FLAG_SINGLE_LINE],
        }),
      ],
      peakFlags: [],
    };
    const s = summarizeIdentification(result);
    expect(s.top).toMatchObject({ isotopeId: 'Co-60', displayName: 'Cobalt-60', verdict: 'STRONG' });
    expect(s.strongCount).toBe(1);
    expect(s.tentativeCount).toBe(1);
    expect(s.caveats).toEqual([]); // top (Co-60) is multi-line, no missing, no artifact
  });

  it('fires the single-line caveat when the top match is single-line', () => {
    const result: IdentificationResult = {
      ranked: [
        match(cs137, [{ line: cs137.lines[0], measured: pA }], { flags: [FLAG_SINGLE_LINE] }),
      ],
      peakFlags: [],
    };
    expect(summarizeIdentification(result).caveats).toContain(CAVEAT_SINGLE_LINE);
  });

  it('fires the artifact caveat when the top match uses an artifact peak', () => {
    const result: IdentificationResult = {
      ranked: [
        match(co60, [
          { line: co60.lines[0], measured: pA },
          { line: co60.lines[1], measured: pB },
        ]),
      ],
      peakFlags: [{ peak: pB, flags: [FLAG_ANNIHILATION] }],
    };
    expect(summarizeIdentification(result).caveats).toContain(CAVEAT_ARTIFACT_PEAK);
  });

  it('fires the missing-strong caveat from the isotope flag', () => {
    const result: IdentificationResult = {
      ranked: [
        match(co60, [{ line: co60.lines[0], measured: pA }], { flags: [FLAG_MISSING_STRONG] }),
      ],
      peakFlags: [],
    };
    expect(summarizeIdentification(result).caveats).toContain(CAVEAT_MISSING_STRONG);
  });

  it('null top for an empty result', () => {
    expect(summarizeIdentification({ ranked: [], peakFlags: [] }).top).toBeNull();
  });
});

// --- C/generality: export verified on the real Co-60 chain ------------------

describe('export on the generality chain (Co-60 -> STRONG)', () => {
  it('JSON round-trips and CSV is well-formed for the real result', () => {
    const sources: DeclaredSource[] = Object.keys(synthetic).map((id) => {
      const s = synthetic[id];
      const text = [s.liveTimeSec, s.realTimeSec, ...s.counts].join('\n');
      const spectrum = load({ text, fileName: `${id}.TKA` });
      const cond = condition(spectrum);
      return {
        sourceId: id,
        fittedPeaks: fit(cond, detect(cond)),
        channelCount: spectrum.counts.length,
      };
    });
    const cal = activeCalibration(calibrate(sources));

    const s = synthetic['Co-60'];
    const spectrum = load({
      text: [s.liveTimeSec, s.realTimeSec, ...s.counts].join('\n'),
      fileName: 'unknown.TKA',
    });
    const cond = condition(spectrum);
    const energisedPeaks = applyCalibration(validPeaks(validate(fit(cond, detect(cond)))), cal);
    const energyRange: [number, number] = [
      applyCalibrationToChannel(cal, 0),
      applyCalibrationToChannel(cal, spectrum.counts.length - 1),
    ];
    const result = identify(energisedPeaks, NUCLIDE_LIBRARY, { energyRange });

    expect(result.ranked[0].nuclide.id).toBe('Co-60');
    expect(summarizeIdentification(result).top?.verdict).toBe('STRONG');
    expect(JSON.parse(exportIdentificationJson(result))).toEqual(result);

    const csv = exportIdentificationCsv(result, energisedPeaks);
    expect(csv).toContain('# isotopes');
    expect(csv).toContain('# peaks');
    expect(csv).toContain('Co-60');
    expect(buildOverlay(result).length).toBeGreaterThanOrEqual(2); // both Co-60 lines
  });
});
