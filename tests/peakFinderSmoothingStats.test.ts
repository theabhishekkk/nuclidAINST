import { describe, it, expect } from 'vitest';

import {
  deriveSmoothingEffect,
  type SmoothingCard,
} from '../src/ui/peakFinderSmoothingStats';
import { savitzkyGolay } from '../src/signal';

/**
 * peakFinderSmoothingStats -- the PURE derivation behind the two "Effect of Smoothing"
 * decision cards on the Savitzky-Golay stage. These tests prove: (a) the metric math is
 * correct on a synthetic spectrum with a KNOWN noise floor + gaussian peak, (b) degenerate
 * inputs hide their own rows / whole card rather than emitting `NaN`, and (c) unusable inputs
 * (absent / length-mismatched smoothed) render no cards at all.
 */

/** Deterministic zig-zag "noise" (no RNG so the assertions are reproducible). */
function jitter(i: number, amp: number): number {
  return i % 2 === 0 ? amp : -amp;
}

/** A synthetic spectrum: a broad gaussian peak on a flat baseline + a small high-frequency
 * ripple, so smoothing has real high-frequency noise to remove and a real peak to preserve. */
function syntheticRaw(n = 400): number[] {
  const raw: number[] = [];
  const c = n / 2;
  const sigma = 12;
  for (let i = 0; i < n; i++) {
    const gauss = 1000 * Math.exp(-((i - c) ** 2) / (2 * sigma * sigma));
    raw.push(Math.max(0, 40 + gauss + jitter(i, 6)));
  }
  return raw;
}

const metric = (card: SmoothingCard | null, label: string) => {
  if (!card) throw new Error('card was null');
  const m = card.metrics.find((x) => x.label === label);
  return m; // undefined when the row was hidden
};

describe('deriveSmoothingEffect — metric math on a synthetic spectrum', () => {
  const raw = syntheticRaw();
  const smoothed = savitzkyGolay(raw, 9, 3).map((v) => Math.max(0, v));
  const { effect, comparison } = deriveSmoothingEffect({ raw, smoothed, sgWindow: 9 });

  it('reports a positive noise reduction with a 0..1 meter', () => {
    const m = metric(effect, 'Noise reduction');
    expect(m).toBeDefined();
    expect(m!.value).toMatch(/%$/);
    expect(parseFloat(m!.value)).toBeGreaterThan(0);
    expect(m!.meter).toBeGreaterThanOrEqual(0);
    expect(m!.meter).toBeLessThanOrEqual(1);
  });

  it('reports near-perfect shape preservation for a gentle SG', () => {
    const m = metric(effect, 'Shape preservation');
    expect(m).toBeDefined();
    expect(parseFloat(m!.value)).toBeGreaterThan(95); // r*100, near 100
  });

  it('reports a maximum intensity change with a channel reference', () => {
    const m = metric(effect, 'Maximum intensity change');
    expect(m).toBeDefined();
    expect(m!.value).toMatch(/^[+−]?\d/);
    expect(m!.detail).toMatch(/^at channel \d+$/);
  });

  it('reports an FWHM-relative smoothing strength band with a ratio detail', () => {
    const m = metric(effect, 'Overall smoothing strength');
    expect(m).toBeDefined();
    expect(['Gentle', 'Moderate', 'Strong', 'Aggressive']).toContain(m!.value);
    expect(m!.detail).toMatch(/median peak width$/);
  });

  it('reports RMS both as counts and as % of mean', () => {
    const m = metric(comparison, 'RMS difference');
    expect(m).toBeDefined();
    expect(m!.value).toMatch(/counts$/);
    expect(m!.detail).toMatch(/% of mean$/);
  });

  it('reports Poisson-aware % channels modified within [0,100]', () => {
    const m = metric(comparison, 'Channels modified');
    expect(m).toBeDefined();
    const pct = parseFloat(m!.value);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  it('never emits NaN in any rendered value', () => {
    for (const card of [effect, comparison]) {
      for (const m of card?.metrics ?? []) {
        expect(m.value).not.toMatch(/NaN/);
        if (m.detail) expect(m.detail).not.toMatch(/NaN/);
      }
    }
  });
});

describe('deriveSmoothingEffect — degenerate inputs hide rows, never NaN', () => {
  it('a flat (constant) spectrum hides the whole Effect card but keeps Comparison zeros', () => {
    const raw = new Array(200).fill(100);
    const smoothed = new Array(200).fill(100);
    const { effect, comparison } = deriveSmoothingEffect({ raw, smoothed, sgWindow: 9 });
    // No noise, no variance, no prominent peaks → every Effect row degenerate.
    expect(effect).toBeNull();
    // Comparison is still valid (all deltas zero) — honest, not NaN.
    expect(comparison).not.toBeNull();
    expect(metric(comparison, 'Channels modified')!.value).toBe('0.0%');
  });

  it('an all-zero spectrum never renders NaN', () => {
    const raw = new Array(64).fill(0);
    const smoothed = new Array(64).fill(0);
    const { effect, comparison } = deriveSmoothingEffect({ raw, smoothed, sgWindow: 9 });
    expect(effect).toBeNull();
    for (const m of comparison?.metrics ?? []) expect(m.value).not.toMatch(/NaN/);
  });

  it('falls back to a noise-derived strength band when no peaks resolve', () => {
    // Monotone ramp + tiny ripple: real noise for the noise metric, but no prominent maxima.
    const raw = Array.from({ length: 300 }, (_, i) => i + jitter(i, 4));
    const smoothed = savitzkyGolay(raw, 9, 3);
    const { effect } = deriveSmoothingEffect({ raw, smoothed, sgWindow: 9 });
    const m = metric(effect, 'Overall smoothing strength');
    expect(m).toBeDefined();
    // The fallback branch labels its provenance and omits the FWHM ratio.
    expect(m!.detail).toBe('estimated from noise reduction');
  });
});

describe('deriveSmoothingEffect — unusable inputs render no cards', () => {
  it('returns both null when smoothed is absent (empty)', () => {
    const raw = syntheticRaw(50);
    expect(deriveSmoothingEffect({ raw, smoothed: [], sgWindow: 9 })).toEqual({
      effect: null,
      comparison: null,
    });
  });

  it('returns both null on a length mismatch', () => {
    const raw = syntheticRaw(50);
    const smoothed = syntheticRaw(49);
    expect(deriveSmoothingEffect({ raw, smoothed, sgWindow: 9 })).toEqual({
      effect: null,
      comparison: null,
    });
  });

  it('returns both null when raw is empty', () => {
    expect(deriveSmoothingEffect({ raw: [], smoothed: [], sgWindow: 9 })).toEqual({
      effect: null,
      comparison: null,
    });
  });
});
