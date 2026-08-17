import { describe, it, expect } from 'vitest';

import {
  deriveValidationStats,
  type ValStatPair,
  type ValChecklistItem,
  type ValReportRow,
} from '../src/ui/peakFinderValidationStats';
import {
  FLAG_BROAD,
  FLAG_LARGE_CENTROID_ERROR,
  FLAG_POOR_FIT,
  FLAG_WEAK,
  FLAG_WIDE_FWHM,
} from '../src/pipeline/validate';
import type { FittedPeak, ValidatedPeak } from '../src/domain/types';

/**
 * peakFinderValidationStats is the PURE derivation behind the "Validate Peaks" (`validated` /
 * `run-7`) stage. It reads ONLY plain data (a ValidatedPeak list + the selected verdict + the
 * upstream survivor/fitted counts), never the engine or a report -- so these tests construct
 * verdicts directly and prove the flag roll-up + honest statistics without ever running
 * `validate()`. A passing test therefore also proves the file cannot perturb the reference-parity
 * fixtures (Principle 9).
 */

const NA = '—';

function fitted(overrides: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 100.4,
    centroidError: 0.12,
    amplitude: 500,
    fwhmChannels: 4.71,
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

function valueOf(pairs: readonly ValStatPair[], label: string): string | undefined {
  return pairs.find((p) => p.label === label)?.value;
}
function ruleOf(items: readonly ValChecklistItem[], rule: string): ValChecklistItem | undefined {
  return items.find((i) => i.rule === rule);
}
function checkOf(rows: readonly ValReportRow[], check: string): ValReportRow | undefined {
  return rows.find((r) => r.check === check);
}

describe('deriveValidationStats -- empty state (no selection)', () => {
  const stats = deriveValidationStats({ validated: [], selected: null, survivors: 0, fitted: 0 });

  it('reports no selection and placeholder summary', () => {
    expect(stats.hasSelection).toBe(false);
    expect(stats.statusText).toBe(NA);
    expect(stats.decisionText).toBe(NA);
    expect(valueOf(stats.metrics, 'Classification')).toBe(NA);
  });

  it('acceptance rate is the placeholder when there are no peaks', () => {
    expect(valueOf(stats.statistics, 'Acceptance Rate')).toBe(NA);
    expect(valueOf(stats.statistics, 'Total Peaks')).toBe('0');
  });
});

describe('deriveValidationStats -- an accepted peak', () => {
  const accepted = verdict(true, []);
  const stats = deriveValidationStats({
    validated: [accepted],
    selected: accepted,
    survivors: 3,
    fitted: 1,
  });

  it('summary reads PASSED / Accepted with the all-clear reason', () => {
    expect(stats.statusText).toBe('PASSED');
    expect(stats.decisionText).toBe('Accepted');
    expect(stats.reasonText).toBe('All validation checks passed.');
    expect(stats.selectedValid).toBe(true);
  });

  it('every checklist rule passes with no fail detail', () => {
    expect(stats.checklist).toHaveLength(4);
    expect(stats.checklist.every((c) => c.passed)).toBe(true);
    expect(stats.checklist.every((c) => c.detail === '')).toBe(true);
  });

  it('metrics are read verbatim off the fitted peak', () => {
    expect(valueOf(stats.metrics, 'Classification')).toBe('Line');
    expect(valueOf(stats.metrics, 'FWHM')).toBe('4.71 ch');
    expect(valueOf(stats.metrics, 'Centroid Error')).toBe('± 0.12 ch (1σ)');
    expect(valueOf(stats.metrics, 'χ²')).toBe('1.8');
  });

  it('report explains each passing check', () => {
    expect(checkOf(stats.report, 'Classification')?.explanation).toBe('Classified as Line');
    expect(checkOf(stats.report, 'χ²')?.explanation).toBe('Fit numerically valid');
  });
});

describe('deriveValidationStats -- a flagged peak (broad + large centroid error)', () => {
  const flagged = verdict(false, [FLAG_BROAD, FLAG_LARGE_CENTROID_ERROR], {
    classification: 'broad',
    centroidError: 6.2,
  });
  const stats = deriveValidationStats({
    validated: [flagged],
    selected: flagged,
    survivors: 3,
    fitted: 1,
  });

  it('summary reads FLAGGED / Rejected and joins every reason', () => {
    expect(stats.statusText).toBe('FLAGGED');
    expect(stats.decisionText).toBe('Rejected');
    expect(stats.reasonText).toBe('Broad peak · Large centroid error');
  });

  it('the two failing rules fail with details; the other two pass', () => {
    expect(ruleOf(stats.checklist, 'Classification = Line')).toMatchObject({
      passed: false,
      detail: 'Broad',
    });
    expect(ruleOf(stats.checklist, 'Centroid Error Acceptable')).toMatchObject({
      passed: false,
      detail: 'Too large',
    });
    expect(ruleOf(stats.checklist, 'FWHM Acceptable')?.passed).toBe(true);
    expect(ruleOf(stats.checklist, 'χ² Numerically Valid')?.passed).toBe(true);
  });

  it('report surfaces the plain-language failure explanations', () => {
    expect(checkOf(stats.report, 'Classification')?.explanation).toBe('Classified as Broad');
    expect(checkOf(stats.report, 'Centroid Error')?.explanation).toBe('Exceeds the uncertainty limit');
  });
});

describe('deriveValidationStats -- statistics + honest funnel (D-2)', () => {
  const validated: ValidatedPeak[] = [
    verdict(true, []),
    verdict(true, []),
    verdict(false, [FLAG_WEAK], { classification: 'weak' }),
    verdict(false, [FLAG_WIDE_FWHM], { fwhmChannels: 260 }),
    verdict(false, [FLAG_POOR_FIT], { chiSquare: Number.POSITIVE_INFINITY }),
  ];
  const stats = deriveValidationStats({ validated, selected: null, survivors: 8, fitted: 5 });

  it('counts total / accepted / flagged and the acceptance rate', () => {
    expect(valueOf(stats.statistics, 'Total Peaks')).toBe('5');
    expect(valueOf(stats.statistics, 'Accepted')).toBe('2');
    expect(valueOf(stats.statistics, 'Flagged')).toBe('3');
    expect(valueOf(stats.statistics, 'Acceptance Rate')).toBe('40%');
  });

  it('the funnel shows the upstream drop-off (survivors -> fitted -> validated -> accepted)', () => {
    expect(stats.funnel).toBe('8 survivors → 5 fitted → 5 validated → 2 accepted');
  });
});

describe('deriveValidationStats -- χ² is finiteness-only (D-1)', () => {
  it('a null χ² is NOT a failure and shows the placeholder metric', () => {
    const v = verdict(true, [], { chiSquare: null });
    const stats = deriveValidationStats({ validated: [v], selected: v, survivors: 1, fitted: 1 });
    expect(ruleOf(stats.checklist, 'χ² Numerically Valid')?.passed).toBe(true);
    expect(valueOf(stats.metrics, 'χ²')).toBe(NA);
  });

  it('a non-finite χ² fails only the χ² rule via the poor-fit flag', () => {
    const v = verdict(false, [FLAG_POOR_FIT], { chiSquare: Number.NaN });
    const stats = deriveValidationStats({ validated: [v], selected: v, survivors: 1, fitted: 1 });
    expect(ruleOf(stats.checklist, 'χ² Numerically Valid')).toMatchObject({
      passed: false,
      detail: 'Non-finite',
    });
    expect(checkOf(stats.report, 'χ²')?.explanation).toBe('Non-finite — numerically invalid fit');
  });
});
