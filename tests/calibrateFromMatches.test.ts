import { describe, it, expect } from 'vitest';

import {
  calibrateFromMatches,
  activeCalibration,
  applyCalibrationToChannel,
  MIN_FIT_POINTS,
  CURVATURE_SIGNIFICANCE_THRESHOLD,
} from '../src/pipeline/calibrate';
import { ValidationError } from '../src/domain/errors';
import type { PeakAssignment } from '../src/domain/types';

/**
 * Phase 1 -- `calibrateFromMatches` (human-match path) tests, N1-N7 of the
 * hand-off. The two-pass `calibrate()` parity tests (P1) live unchanged in
 * calibrate.test.ts / calibrateTrace.test.ts: the shared `selectAndFit`
 * extraction must leave them green.
 */

/** An assigned match at (channel, energyKeV); override any field via `over`. */
function assigned(
  channel: number,
  energyKeV: number,
  over: Partial<PeakAssignment> = {},
): PeakAssignment {
  return {
    peakId: `pk-${channel}`,
    centroidChannel: channel,
    centroidError: 0.05,
    state: 'assigned',
    energyKeV,
    sourceId: 'SYN',
    tier: 'anchor',
    reliable: true,
    ...over,
  };
}

// =============================================================================
// N1. Linear ground truth -> recovered coefficients; policy respected; no trace
// =============================================================================
describe('calibrateFromMatches -- linear ground truth (N1)', () => {
  // E = 10 + 0.5*ch  =>  ch = 2*E - 20.
  const chOf = (e: number) => 2 * e - 20;
  const matches = [100, 200, 300, 400, 500].map((e) => assigned(chOf(e), e));

  it("recovers the coefficients and respects defaultModel: 'linear'", () => {
    const result = calibrateFromMatches(matches, { defaultModel: 'linear' });
    expect(result.selected).toBe('linear');
    expect(result.policy).toBe('linear');
    expect(result.selectionFellBack).toBe(false);
    expect(result.linear.coefficients[0]).toBeCloseTo(10, 6);
    expect(result.linear.coefficients[1]).toBeCloseTo(0.5, 6);
    expect(result.linear.rms as number).toBeLessThan(1e-6);
    expect(activeCalibration(result)).toBe(result.linear);
  });

  it('carries no two-pass trace (documented: human-match path has none)', () => {
    const result = calibrateFromMatches(matches);
    expect(result.trace).toBeUndefined();
  });

  it('reports every assigned point used with an honest valid range', () => {
    const result = calibrateFromMatches(matches, { defaultModel: 'linear' });
    expect(result.linear.points).toHaveLength(matches.length);
    expect(result.linear.points.every((p) => p.used)).toBe(true);
    expect(result.linear.validRange).toEqual([100, 500]);
  });
});

// =============================================================================
// N2. Curved ground truth under 'auto' selects quadratic; 'linear' keeps the line
// =============================================================================
describe('calibrateFromMatches -- curved ground truth (N2)', () => {
  // E = -5 + 1.1*ch + 4e-5*ch^2 (NaI-like curvature), 6 exact points.
  const TRUE = { a: -5, b: 1.1, c: 4e-5 };
  const eOf = (ch: number) => TRUE.a + TRUE.b * ch + TRUE.c * ch * ch;
  const channels = [100, 300, 500, 700, 900, 1100];
  const matches = channels.map((ch) => assigned(ch, eOf(ch)));

  it("'auto' selects quadratic when the curvature is significant and recovers the truth", () => {
    const result = calibrateFromMatches(matches); // default 'auto'
    expect(result.curvatureSignificance).toBeGreaterThanOrEqual(
      CURVATURE_SIGNIFICANCE_THRESHOLD,
    );
    expect(result.selected).toBe('quadratic');
    const cal = activeCalibration(result);
    expect(cal.coefficients[0]).toBeCloseTo(TRUE.a, 4);
    expect(cal.coefficients[1]).toBeCloseTo(TRUE.b, 6);
    expect(cal.coefficients[2]).toBeCloseTo(TRUE.c, 9);
  });

  it("'linear' policy always keeps the line (quadratic still computed)", () => {
    const result = calibrateFromMatches(matches, { defaultModel: 'linear' });
    expect(result.selected).toBe('linear');
    expect(result.quadratic).not.toBeNull();
    expect(activeCalibration(result)).toBe(result.linear);
  });
});

// =============================================================================
// N3. 'quadratic' policy with exactly 3 points falls back (flagged)
// =============================================================================
describe("calibrateFromMatches -- 'quadratic' with 3 points falls back (N3)", () => {
  it('quadratic is null, selection falls back to linear with the flag set', () => {
    const matches = [100, 300, 500].map((ch) => assigned(ch, 10 + 0.5 * ch));
    const result = calibrateFromMatches(matches, { defaultModel: 'quadratic' });
    expect(result.quadratic).toBeNull();
    expect(result.selected).toBe('linear');
    expect(result.selectionFellBack).toBe(true);
    expect(activeCalibration(result)).toBe(result.linear);
  });
});

// =============================================================================
// N4. Global pooling: different sourceIds feed ONE equation
// =============================================================================
describe('calibrateFromMatches -- global pooling across sources (N4)', () => {
  it('all assigned matches enter one equation regardless of sourceId', () => {
    const chOf = (e: number) => 2 * e - 20;
    const matches = [
      assigned(chOf(59.5), 59.5, { sourceId: 'Am-241' }),
      assigned(chOf(661.7), 661.7, { sourceId: 'Cs-137' }),
      assigned(chOf(834.8), 834.8, { sourceId: 'Mn-54' }),
      assigned(chOf(1173.2), 1173.2, { sourceId: 'Co-60' }),
      assigned(chOf(1332.5), 1332.5, { sourceId: 'Co-60' }),
    ];
    const result = calibrateFromMatches(matches, { defaultModel: 'linear' });
    expect(result.linear.points).toHaveLength(matches.length); // one pooled set
    expect(result.linear.points.filter((p) => p.used)).toHaveLength(matches.length);
    expect(new Set(result.linear.points.map((p) => p.sourceId)).size).toBe(4);
    expect(result.linear.coefficients[0]).toBeCloseTo(10, 5);
    expect(result.linear.coefficients[1]).toBeCloseTo(0.5, 6);
    // Labels reuse the "<sourceId> <energy> keV" convention.
    expect(result.linear.points[0].sourceLabel).toBe('Am-241 59.5 keV');
  });
});

// =============================================================================
// N5. Advisory σ-clip: the outlier is flagged but RETAINED
// =============================================================================
describe('calibrateFromMatches -- advisory σ-clip retains the outlier (N5)', () => {
  // Same geometry as the calibrate() σ-clip prune test: 9 exact points on
  // E = 10 + 0.5*ch plus one unreliable outlier planted +10 ch (~5 keV residual)
  // -- the prune rule drops it there; the advisory rule must keep it here.
  const chOf = (e: number) => 2 * e - 20;
  const good = [60, 160, 260, 360, 460, 560, 660, 760].map((e) =>
    assigned(chOf(e), e, { centroidError: 0.01 }),
  );
  const goodSecondary = assigned(chOf(330), 330, { centroidError: 0.05, tier: 'secondary' });
  const outlier = assigned(chOf(430) + 10, 430, {
    centroidError: 0.05,
    tier: 'secondary',
    reliable: false,
  });
  const matches = [...good, goodSecondary, outlier];
  const result = calibrateFromMatches(matches, { defaultModel: 'linear' });

  it('keeps ALL assigned points in the fit (used count == assigned count)', () => {
    expect(result.linear.points.filter((p) => p.used)).toHaveLength(matches.length);
  });

  it('stamps an advisory note on the would-be-pruned point, leaving used: true', () => {
    const flagged = result.linear.points.find((p) => (p.note ?? '').startsWith('advisory:'));
    expect(flagged).toBeDefined();
    expect(flagged!.energyKeV).toBe(430);
    expect(flagged!.used).toBe(true);
    expect(flagged!.note).toMatch(/advisory: high residual \d+(\.\d+)? keV/);
  });

  it('no point is marked pruned on the human-match path', () => {
    expect(result.linear.points.some((p) => (p.note ?? '').includes('pruned'))).toBe(false);
  });

  it('the retained outlier genuinely enters the fit (rms reflects it)', () => {
    // 10 points, one ~5 keV off: the fit cannot be exact.
    expect(result.linear.rms as number).toBeGreaterThan(0.1);
  });
});

// =============================================================================
// N6. Fail-loud errors
// =============================================================================
describe('calibrateFromMatches -- fails loud (N6)', () => {
  it('throws when no assignments are supplied', () => {
    expect(() => calibrateFromMatches([])).toThrow(ValidationError);
    expect(() => calibrateFromMatches([])).toThrow(/no assigned matches/);
  });

  it("throws when nothing is in state 'assigned' (excluded/unassigned ignored)", () => {
    const matches: PeakAssignment[] = [
      { peakId: 'a', centroidChannel: 100, state: 'excluded' },
      { peakId: 'b', centroidChannel: 200, state: 'unassigned' },
    ];
    expect(() => calibrateFromMatches(matches)).toThrow(/no assigned matches/);
  });

  it('throws when an assigned match lacks a finite energyKeV', () => {
    const matches = [
      assigned(180, 100),
      assigned(380, 200),
      { peakId: 'no-energy', centroidChannel: 580, state: 'assigned' } as PeakAssignment,
    ];
    expect(() => calibrateFromMatches(matches)).toThrow(ValidationError);
    expect(() => calibrateFromMatches(matches)).toThrow(/no finite energyKeV/);
  });

  it(`throws on fewer than MIN_FIT_POINTS (${MIN_FIT_POINTS}) assigned points`, () => {
    const matches = [assigned(180, 100), assigned(380, 200)];
    expect(() => calibrateFromMatches(matches)).toThrow(ValidationError);
    expect(() => calibrateFromMatches(matches)).toThrow(/2 assigned point/);
  });

  it('excluded/unassigned entries do not count toward the minimum', () => {
    const matches = [
      assigned(180, 100),
      assigned(380, 200),
      assigned(580, 300, { state: 'excluded' }),
    ];
    expect(() => calibrateFromMatches(matches)).toThrow(/2 assigned point/);
  });

  it('throws on a degenerate (collinear-in-channel) system', () => {
    const matches = [assigned(200, 100), assigned(200, 200), assigned(200, 300)];
    expect(() => calibrateFromMatches(matches)).toThrow(ValidationError);
  });
});

// =============================================================================
// N7. Weighting: a tighter centroidError pulls the fit harder
// =============================================================================
describe('calibrateFromMatches -- centroid-error weighting (N7)', () => {
  // Two exact end anchors on E = ch, plus two conflicting points at ch = 200:
  // one at 210 keV, one at 190 keV. Whichever carries the SMALLER centroidError
  // (larger weight = 1/clip(err)) must win the tug of war at ch 200.
  const build = (errUp: number, errDown: number) =>
    calibrateFromMatches(
      [
        assigned(100, 100, { centroidError: 0.1 }),
        assigned(300, 300, { centroidError: 0.1 }),
        assigned(200, 210, { centroidError: errUp, peakId: 'up' }),
        assigned(200, 190, { centroidError: errDown, peakId: 'down' }),
      ],
      { defaultModel: 'linear' },
    );

  it('the small-error point dominates its equal-and-opposite large-error twin', () => {
    const pulledUp = applyCalibrationToChannel(build(0.05, 5.0).linear, 200);
    const pulledDown = applyCalibrationToChannel(build(5.0, 0.05).linear, 200);
    expect(pulledUp).toBeGreaterThan(200);
    expect(pulledDown).toBeLessThan(200);
    expect(pulledUp).toBeGreaterThan(pulledDown);
  });
});
