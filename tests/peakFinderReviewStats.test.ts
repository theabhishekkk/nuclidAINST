import { describe, it, expect } from 'vitest';

import {
  remarkForPeak,
  acceptedPeakCount,
  canProceedToCalibration,
  MIN_CALIBRATION_PEAKS,
  derivePeakStatistics,
  deriveSpectrumStatistics,
  derivePeakQuality,
  deriveReviewPeakRows,
  buildProcessingReport,
  buildPeaksCsv,
  buildPeakList,
  buildPeaksJson,
  type ReviewStatPair,
} from '../src/ui/peakFinderReviewStats';
import {
  FLAG_BROAD,
  FLAG_POOR_FIT,
  FLAG_WEAK,
  FLAG_LARGE_CENTROID_ERROR,
} from '../src/pipeline/validate';
import type { FittedPeak, ValidatedPeak } from '../src/domain/types';

/**
 * peakFinderReviewStats is the PURE derivation behind the FINAL REVIEW page. Like its sibling
 * peakFinderValidationStats, it reads ONLY plain data (a ValidatedPeak list + raw/background
 * arrays + a live-time), never the engine or a report, so these tests construct verdicts directly
 * and prove the report figures without running the pipeline (Principle 9).
 */

const NA = '—';

function fitted(overrides: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 100.4,
    centroidError: 0.12,
    amplitude: 500,
    fwhmChannels: 4.7,
    netArea: 2500,
    chiSquare: 1.8,
    energyKeV: null,
    classification: 'line',
    significance: 42,
    detectedChannel: 100,
    status: 'kept',
    ...overrides,
  };
}

function verdict(
  valid: boolean,
  flags: readonly string[],
  peak: Partial<FittedPeak> = {},
): ValidatedPeak {
  return { peak: fitted(peak), valid, flags };
}

function valueOf(pairs: readonly ReviewStatPair[], label: string): string | undefined {
  return pairs.find((p) => p.label === label)?.value;
}

describe('remarkForPeak', () => {
  it('gives the pass phrase for an accepted peak', () => {
    expect(remarkForPeak(true, [])).toBe('Passed all validation checks');
  });
  it('maps each flag token to its plain-language reason', () => {
    expect(remarkForPeak(false, [FLAG_BROAD])).toBe('Broad peak');
    expect(remarkForPeak(false, [FLAG_WEAK])).toBe('Low significance');
    expect(remarkForPeak(false, [FLAG_POOR_FIT])).toBe('Invalid χ²');
    expect(remarkForPeak(false, [FLAG_LARGE_CENTROID_ERROR])).toBe('Excessive centroid error');
  });
  it('joins multiple flags and falls back for a flagged-but-tokenless peak', () => {
    expect(remarkForPeak(false, [FLAG_BROAD, FLAG_POOR_FIT])).toBe('Broad peak · Invalid χ²');
    expect(remarkForPeak(false, [])).toBe('Review recommended');
  });
});

describe('calibration gate', () => {
  it('counts accepted (valid) peaks', () => {
    const v = [verdict(true, []), verdict(false, [FLAG_BROAD]), verdict(true, [])];
    expect(acceptedPeakCount(v)).toBe(2);
  });
  it('needs at least two accepted peaks', () => {
    expect(MIN_CALIBRATION_PEAKS).toBe(2);
    expect(canProceedToCalibration([verdict(true, [])])).toBe(false);
    expect(canProceedToCalibration([verdict(true, []), verdict(true, [])])).toBe(true);
    // a flagged peak does not count toward the gate
    expect(canProceedToCalibration([verdict(true, []), verdict(false, [FLAG_BROAD])])).toBe(false);
  });
});

describe('derivePeakStatistics', () => {
  const validated = [
    verdict(true, [], { detectedChannel: 50, amplitude: 100, netArea: 800, fwhmChannels: 4 }),
    verdict(true, [], { detectedChannel: 120, amplitude: 900, netArea: 5000, fwhmChannels: 6 }),
    verdict(false, [FLAG_BROAD], { detectedChannel: 200, amplitude: 300, netArea: 1500 }),
  ];
  const stats = derivePeakStatistics({ validated, survivors: 4 });

  it('reports detected = survivors, validated = accepted, and their difference as rejected', () => {
    expect(valueOf(stats, 'Total Detected Peaks')).toBe('4');
    expect(valueOf(stats, 'Validated Peaks')).toBe('2');
    expect(valueOf(stats, 'Rejected Peaks')).toBe('2');
    expect(valueOf(stats, 'Acceptance Rate')).toBe('50%');
  });
  it('picks strongest/weakest accepted by amplitude and aggregates area + FWHM', () => {
    expect(valueOf(stats, 'Strongest Peak')).toBe('ch 120');
    expect(valueOf(stats, 'Weakest Peak')).toBe('ch 50');
    expect(valueOf(stats, 'Largest Net Area')).toBe('5,000');
    expect(valueOf(stats, 'Average FWHM')).toBe('5.00 ch');
  });
  it('shows — for the per-peak figures when nothing is accepted', () => {
    const none = derivePeakStatistics({ validated: [verdict(false, [FLAG_BROAD])], survivors: 1 });
    expect(valueOf(none, 'Acceptance Rate')).toBe('0%');
    expect(valueOf(none, 'Strongest Peak')).toBe(NA);
    expect(valueOf(none, 'Average FWHM')).toBe(NA);
  });
});

describe('deriveSpectrumStatistics', () => {
  const stats = deriveSpectrumStatistics({
    raw: [0, 10, 1000, 5, 0],
    background: [1, 2, 3, 4, 5],
    liveTimeSec: 1800,
  });
  it('sums/measures the raw counts and the continuum mean', () => {
    expect(valueOf(stats, 'Total Counts')).toBe('1,015');
    expect(valueOf(stats, 'Number of Channels')).toBe('5');
    expect(valueOf(stats, 'Maximum Counts')).toBe('1,000');
    expect(valueOf(stats, 'Dynamic Range')).toBe('200 : 1'); // 1000 / min-nonzero (5)
    expect(valueOf(stats, 'Average Background')).toBe('3');
    expect(valueOf(stats, 'Acquisition Time')).toBe('1,800 s');
  });
  it('shows — for absent background and live-time', () => {
    const s = deriveSpectrumStatistics({ raw: [1, 2], background: null, liveTimeSec: null });
    expect(valueOf(s, 'Average Background')).toBe(NA);
    expect(valueOf(s, 'Acquisition Time')).toBe(NA);
  });
});

describe('derivePeakQuality', () => {
  it('tallies Line/Broad/Weak in fixed order over every validated peak', () => {
    const q = derivePeakQuality([
      verdict(true, [], { classification: 'line' }),
      verdict(true, [], { classification: 'line' }),
      verdict(false, [FLAG_BROAD], { classification: 'broad' }),
      verdict(false, [FLAG_WEAK], { classification: 'weak' }),
    ]);
    expect(q.map((r) => r.classification)).toEqual(['Line', 'Broad', 'Weak']);
    expect(q.map((r) => r.count)).toEqual([2, 1, 1]);
  });
});

describe('deriveReviewPeakRows', () => {
  const rows = deriveReviewPeakRows([
    verdict(false, [FLAG_BROAD], { detectedChannel: 200, netArea: 1500, chiSquare: null }),
    verdict(true, [], { detectedChannel: 60, netArea: 3200, fwhmChannels: 4.71, chiSquare: 12.3 }),
  ]);
  it('assigns stable IDs by ascending channel, independent of input order', () => {
    expect(rows.map((r) => r.channel)).toEqual([60, 200]);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });
  it('formats values verbatim and carries the status + remark', () => {
    const first = rows[0];
    expect(first.status).toBe('Accepted');
    expect(first.kind).toBe('pass');
    expect(first.fwhm).toBe('4.7');
    expect(first.netArea).toBe('3,200');
    expect(first.chi).toBe('12.3');
    expect(first.remark).toBe('Passed all validation checks');
    const second = rows[1];
    expect(second.status).toBe('Flagged');
    expect(second.kind).toBe('drop');
    expect(second.chi).toBe(NA); // null chi -> dash
    expect(second.remark).toBe('Broad peak');
  });
});

describe('buildProcessingReport', () => {
  it('states readiness when at least two peaks are accepted', () => {
    const r = buildProcessingReport([
      verdict(true, []),
      verdict(true, []),
      verdict(false, [FLAG_BROAD]),
    ]);
    expect(r).toContain('2 of 3 measured peaks');
    expect(r).toContain('ready for downstream energy calibration');
  });
  it('says the workflow ends here below the calibration threshold', () => {
    const r = buildProcessingReport([verdict(true, []), verdict(false, [FLAG_BROAD])]);
    expect(r).toContain('workflow ends here');
  });
  it('handles the no-peaks case', () => {
    expect(buildProcessingReport([])).toContain('no peaks satisfied');
  });
});

describe('export builders', () => {
  const validated = [
    verdict(true, [], { detectedChannel: 60, netArea: 3200, fwhmChannels: 4.7, chiSquare: 12.3 }),
    verdict(false, [FLAG_BROAD], { detectedChannel: 200, netArea: 1500, chiSquare: null }),
  ];
  const rows = deriveReviewPeakRows(validated);

  it('emits a CSV with the seven-column header and one row per peak', () => {
    const csv = buildPeaksCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('Peak ID,Channel,FWHM (ch),Net Area,Chi-Square,Status,Remarks');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('1,60,4.7,"3,200",12.3,Accepted,Passed all validation checks');
  });
  it('emits a peak list of accepted channels only', () => {
    expect(buildPeakList(rows)).toBe('60');
  });
  it('emits structured JSON with the schema tag and every peak', () => {
    const parsed = JSON.parse(buildPeaksJson(rows));
    expect(parsed.schema).toBe('nuclid.peak-finder.review/1');
    expect(parsed.peaks).toHaveLength(2);
    expect(parsed.peaks[0]).toMatchObject({ id: 1, channel: 60, status: 'Accepted' });
  });
});
