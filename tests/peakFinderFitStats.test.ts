import { describe, it, expect } from 'vitest';

import {
  deriveFitStats,
  type FitStatsInput,
  type FitStatPair,
} from '../src/ui/peakFinderFitStats';
import { FWHM_PER_SIGMA } from '../src/pipeline/fit';
import type { FittedPeak, UnfittableSurvivor } from '../src/domain/types';

/**
 * peakFinderFitStats is the PURE derivation behind the "Peak Fitting" (`fit` / `run-6`) stage.
 * It reads ONLY plain data (a selected FittedPeak / UnfittableSurvivor / null + the background
 * and counts arrays), never the engine or a report -- so these tests construct records directly
 * and prove the display transforms (measurements read verbatim, residual `raw − model` + RMS)
 * without ever running the fit. A passing test therefore also proves the file cannot perturb the
 * reference-parity fixtures (Principle 9).
 */

/** The placeholder the derivation emits for an absent value (em dash). */
const NA = '—';

function fitted(overrides: Partial<FittedPeak> = {}): FittedPeak {
  return {
    centroidChannel: 100.4,
    centroidError: 0.12,
    amplitude: 500,
    fwhmChannels: 4.7096, // ~ 2 sigma
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

function unfittable(overrides: Partial<UnfittableSurvivor> = {}): UnfittableSurvivor {
  return { detectedChannel: 250, reason: 'no-convergence', ...overrides };
}

/** A flat background + a raw spectrum that is EXACTLY background + the peak's Gaussian, so the
 * residual is identically zero over the window. */
function matchedInput(peak: FittedPeak, bgLevel = 10): FitStatsInput {
  const n = 512;
  const sigma = peak.fwhmChannels / FWHM_PER_SIGMA;
  const background = new Array<number>(n).fill(bgLevel);
  const counts = new Array<number>(n);
  for (let ch = 0; ch < n; ch++) {
    const z = sigma > 0 ? (ch - peak.centroidChannel) / sigma : 0;
    counts[ch] = bgLevel + (sigma > 0 ? peak.amplitude * Math.exp(-0.5 * z * z) : 0);
  }
  return { selected: peak, background, counts };
}

function valueOf(pairs: readonly FitStatPair[], label: string): string | undefined {
  return pairs.find((p) => p.label === label)?.value;
}

describe('deriveFitStats -- empty state (no selection)', () => {
  const stats = deriveFitStats({ selected: null, background: [], counts: [] });

  it('reports no selection and no fit', () => {
    expect(stats.hasSelection).toBe(false);
    expect(stats.isFitted).toBe(false);
  });

  it('every measurement / quality value is the placeholder', () => {
    for (const p of stats.measurements) expect(p.value).toBe(NA);
    for (const p of stats.quality) expect(p.value).toBe(NA);
    expect(valueOf(stats.summary, 'Fit Status')).toBe(NA);
  });

  it('has no shape and no decomposition', () => {
    expect(stats.shape).toBeNull();
    expect(stats.decomposition).toBeNull();
  });
});

describe('deriveFitStats -- unfittable survivor selected', () => {
  const stats = deriveFitStats({ selected: unfittable(), background: [], counts: [] });

  it('has a selection but is not a fitted peak', () => {
    expect(stats.hasSelection).toBe(true);
    expect(stats.isFitted).toBe(false);
  });

  it('surfaces the channel and the (humanised) failure reason in the summary', () => {
    expect(valueOf(stats.summary, 'Selected Peak')).toBe('Channel 250');
    expect(valueOf(stats.summary, 'Fit Status')).toBe('Unfittable (no convergence)');
    expect(valueOf(stats.summary, 'Optimizer Status')).toBe('Did not converge');
  });

  it('shows no measurements (never fabricated) and no chart data', () => {
    for (const p of stats.measurements) expect(p.value).toBe(NA);
    expect(valueOf(stats.quality, 'χ²')).toBe(NA);
    expect(valueOf(stats.quality, 'Residual RMS')).toBe(NA);
    expect(stats.shape).toBeNull();
    expect(stats.decomposition).toBeNull();
  });
});

describe('deriveFitStats -- a single kept peak (happy path)', () => {
  const peak = fitted();
  const stats = deriveFitStats(matchedInput(peak));

  it('is a fitted selection with a successful/converged summary', () => {
    expect(stats.isFitted).toBe(true);
    expect(valueOf(stats.summary, 'Selected Peak')).toBe('Channel 100');
    expect(valueOf(stats.summary, 'Fit Status')).toBe('Successful');
    expect(valueOf(stats.summary, 'Optimizer Status')).toBe('Converged');
    expect(valueOf(stats.summary, 'Status')).toBe('Ready');
  });

  it('reads the authoritative measurements verbatim (uncertainty first-class)', () => {
    expect(valueOf(stats.measurements, 'Centroid')).toBe('100.40 ch');
    expect(valueOf(stats.measurements, 'Centroid Uncertainty')).toBe('± 0.12 ch (1σ)');
    expect(valueOf(stats.measurements, 'Net Area')).toBe('2,500 counts');
    expect(valueOf(stats.measurements, 'FWHM')).toBe('4.71 ch');
    expect(valueOf(stats.measurements, 'Peak Height')).toBe('500');
  });

  it('exposes the Gaussian shape with σ = FWHM / 2.3548', () => {
    expect(stats.shape).not.toBeNull();
    expect(stats.shape!.sigma).toBeCloseTo(peak.fwhmChannels / FWHM_PER_SIGMA, 10);
  });
});

describe('deriveFitStats -- χ² is null', () => {
  it('shows the χ² placeholder rather than a fabricated number', () => {
    const stats = deriveFitStats(matchedInput(fitted({ chiSquare: null })));
    expect(valueOf(stats.quality, 'χ²')).toBe(NA);
  });
});

describe('deriveFitStats -- residual RMS on a perfectly-matched window', () => {
  it('is exactly zero when raw = background + the fitted Gaussian', () => {
    const stats = deriveFitStats(matchedInput(fitted()));
    expect(stats.decomposition).not.toBeNull();
    expect(stats.decomposition!.residualRms).toBeCloseTo(0, 8);
    expect(valueOf(stats.quality, 'Residual RMS')).toBe('0');
    // every residual sample is ~0
    for (const r of stats.decomposition!.residual) expect(Math.abs(r)).toBeLessThan(1e-6);
  });
});

describe('deriveFitStats -- decomposition window + series', () => {
  const peak = fitted();
  const stats = deriveFitStats(matchedInput(peak));
  const d = stats.decomposition!;

  it('spans centroid ± a symmetric margin and all series share the x-axis', () => {
    expect(d.lo).toBeLessThan(d.hi);
    const len = d.hi - d.lo + 1;
    expect(d.channels.length).toBe(len);
    expect(d.raw.length).toBe(len);
    expect(d.background.length).toBe(len);
    expect(d.gaussian.length).toBe(len);
    expect(d.combined.length).toBe(len);
    expect(d.residual.length).toBe(len);
  });

  it('combined = gaussian + background per channel', () => {
    for (let i = 0; i < d.channels.length; i++) {
      expect(d.combined[i]).toBeCloseTo(d.gaussian[i] + d.background[i], 10);
    }
  });

  it('the Gaussian peaks at the centroid channel', () => {
    const peakIdx = d.gaussian.indexOf(Math.max(...d.gaussian));
    expect(d.channels[peakIdx]).toBe(Math.round(peak.centroidChannel));
  });
});

describe('deriveFitStats -- a rejected fit (converged shape, no covariance stats)', () => {
  const peak = fitted({
    status: 'rejected',
    rejectReason: 'peak-hop',
    chiSquare: null,
    centroidError: Number.NaN,
  });
  const stats = deriveFitStats(matchedInput(peak));

  it('summary reads Rejected / Did not converge / Needs review', () => {
    expect(valueOf(stats.summary, 'Fit Status')).toBe('Rejected');
    expect(valueOf(stats.summary, 'Optimizer Status')).toBe('Did not converge');
    expect(valueOf(stats.summary, 'Status')).toBe('Needs review');
  });

  it('still shows the shape measurements but omits the non-finite uncertainty', () => {
    expect(valueOf(stats.measurements, 'Centroid')).toBe('100.40 ch');
    expect(valueOf(stats.measurements, 'Centroid Uncertainty')).toBe(NA);
    expect(valueOf(stats.quality, 'χ²')).toBe(NA);
  });

  it('optimization reports Failed', () => {
    expect(valueOf(stats.optimization, 'Optimization')).toBe('Failed');
  });
});

describe('deriveFitStats -- non-physical width guards the chart', () => {
  it('returns no decomposition when σ ≤ 0 (fwhm 0) but still yields the cards', () => {
    const stats = deriveFitStats(matchedInput(fitted({ fwhmChannels: 0 })));
    expect(stats.isFitted).toBe(true);
    expect(stats.decomposition).toBeNull();
    expect(valueOf(stats.quality, 'Residual RMS')).toBe(NA);
  });
});
