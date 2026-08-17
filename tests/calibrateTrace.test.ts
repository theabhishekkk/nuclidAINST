import { describe, it, expect } from 'vitest';

import { calibrate, fitCalibration, type DeclaredSource } from '../src/pipeline/calibrate';
import { CALIBRATION_KIT } from '../src/data/calibrationKit';
import type { CalibrationPoint, FittedPeak } from '../src/domain/types';

import GT from './fixtures/reference/_calibrate_ground_truth.json';

/**
 * WP-A — calibration-trace exposure (additive). `calibrate()` now bundles the
 * intermediates it already computes — the pass-one preliminary scale, the per-
 * anchor gain profile, the resolution coefficient `ksig`, and one record per
 * secondary line attempted — on an optional `CalibrationTrace`. These assertions
 * pin only the trace; the numeric outputs are pinned (unchanged) by calibrate.test.ts.
 *
 * The 7-source kit fixtures are the reference parity sources: we rebuild each
 * source's `FittedPeak[]` from the committed reference centroids (same construction
 * as calibrate.test.ts) and run the real TS two-pass `calibrate`.
 */

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

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
interface GtFile {
  preliminary: { a0: number; b0: number };
  points_by_source: Record<string, GtPoint[]>;
}
const gt = GT as unknown as GtFile;

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

describe('calibrate -- trace exposes pass-one / gain / ksig / secondary windows (additive)', () => {
  const result = calibrate(refSources, CALIBRATION_KIT); // default 'auto'

  it('attaches a trace on the two-pass path', () => {
    expect(result.trace).toBeDefined();
  });

  it('preliminary.b0 is finite and positive (matches the reference preliminary scale)', () => {
    const trace = result.trace!;
    expect(Number.isFinite(trace.preliminary.b0)).toBe(true);
    expect(trace.preliminary.b0).toBeGreaterThan(0);
    expect(Number.isFinite(trace.preliminary.a0)).toBe(true);
    // Same numbers the reference produced (no recompute -- just surfaced).
    expect(trace.preliminary.a0).toBeCloseTo(gt.preliminary.a0, 9);
    expect(trace.preliminary.b0).toBeCloseTo(gt.preliminary.b0, 9);
  });

  it('ksig is a finite, positive resolution coefficient', () => {
    expect(Number.isFinite(result.trace!.ksig)).toBe(true);
    expect(result.trace!.ksig).toBeGreaterThan(0);
  });

  it('gainProfile[i].gain === energyKeV/channel for every anchor, sorted by energy', () => {
    const gp = result.trace!.gainProfile;
    expect(gp.length).toBeGreaterThan(0);
    for (const g of gp) {
      expect(g.gain).toBe(g.energyKeV / g.channel);
    }
    // ascending by energy
    for (let i = 1; i < gp.length; i++) {
      expect(gp[i].energyKeV).toBeGreaterThanOrEqual(gp[i - 1].energyKeV);
    }
    // one entry per anchor point that entered pass one
    const anchorCount = result.linear.points.filter((p) => p.tier === 'anchor').length;
    expect(gp).toHaveLength(anchorCount);
  });

  it('secondaryWindows[i].outcome agrees with the matching point used/note', () => {
    const sw = result.trace!.secondaryWindows;
    expect(sw.length).toBeGreaterThan(0);

    const pointFor = (sourceId: string, energyKeV: number): CalibrationPoint | undefined =>
      result.linear.points.find((p) => p.sourceId === sourceId && p.energyKeV === energyKeV);

    for (const w of sw) {
      const pt = pointFor(w.sourceId, w.energyKeV);
      expect(pt, `point for ${w.sourceId}@${w.energyKeV}`).toBeDefined();
      const note = pt!.note ?? '';
      switch (w.outcome) {
        case 'off-scale':
          expect(note).toBe('predicted off-scale');
          expect(w.matchedChannel).toBeNull();
          expect(Number.isNaN(w.halfWindow)).toBe(true);
          expect(Number.isNaN(w.muTol)).toBe(true);
          break;
        case 'no-peak':
          expect(note).toBe('no fitted peak in window');
          expect(w.matchedChannel).toBeNull();
          break;
        case 'hop-rejected':
          expect(note).toContain('peak-hop');
          expect(w.matchedChannel).not.toBeNull();
          break;
        case 'used':
          // Matched in pass two. The point either stays used, or was σ-clip-pruned
          // afterwards (used:false, note 'pruned ...') -- both mean pass-two matched.
          expect(pt!.used === true || note.includes('pruned')).toBe(true);
          expect(w.matchedChannel).not.toBeNull();
          expect(w.matchedChannel).toBe(pt!.channel);
          break;
      }
    }
  });

  it('every secondary point has exactly one trace window (one entry per line attempted)', () => {
    const sw = result.trace!.secondaryWindows;
    const secondaryPoints = result.linear.points.filter((p) => p.tier === 'secondary');
    expect(sw).toHaveLength(secondaryPoints.length);
  });

  it('captures the reference σ-clip case as a pass-two match (Eu-152 1408 keV)', () => {
    const w = result.trace!.secondaryWindows.find(
      (x) => x.sourceId === 'Eu-152' && Math.abs(x.energyKeV - 1408.013) < 0.5,
    );
    expect(w).toBeDefined();
    expect(w!.outcome).toBe('used'); // matched in pass two, pruned only later
    const pt = result.linear.points.find(
      (p) => p.sourceId === 'Eu-152' && Math.abs(p.energyKeV - 1408.013) < 0.5,
    );
    expect(pt!.used).toBe(false); // ...and σ-clip-pruned in the final point set
    expect(pt!.note).toContain('pruned');
  });
});

describe('fitCalibration -- the thin direct fit carries no trace', () => {
  it('returns a Calibration with no trace (no two-pass intermediates)', () => {
    const cal = fitCalibration(
      [
        { channel: 100, energyKeV: 60, sourceLabel: 'a' },
        { channel: 200, energyKeV: 120, sourceLabel: 'b' },
        { channel: 300, energyKeV: 180, sourceLabel: 'c' },
      ],
      1,
    );
    // fitCalibration returns a Calibration, which has no `trace` field at all.
    expect((cal as unknown as { trace?: unknown }).trace).toBeUndefined();
  });
});
