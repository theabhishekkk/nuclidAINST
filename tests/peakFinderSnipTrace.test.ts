import { describe, it, expect } from 'vitest';

import {
  estimateBackground,
  estimateBackgroundTraced,
  invLls,
  SNIP_DEFAULT_ITERATIONS,
} from '../src/pipeline/condition';
import { load } from '../src/pipeline/load';
import { syntheticTka } from '../src/data/synthetic';

/**
 * estimateBackgroundTraced is the ADDITIVE traced SNIP run behind the SNIP Peak Clipping education
 * page. These tests lock the DoD parity gate: the trace must be built from exactly the same clip
 * the committed background came from, so a captured snapshot's inverse == estimateBackground at that
 * pass count -- the page can never show an intermediate state SNIP did not actually produce. The
 * `estimateBackground` numerics themselves are locked separately by the reference-parity fixtures;
 * here we only prove the trace agrees with them.
 */

const clamp = (a: readonly number[]): number[] => a.map((x) => (x > 0 ? x : 0));
const realCounts = (): readonly number[] =>
  load({ text: syntheticTka(), fileName: 'synthetic-demo.tka' }).counts;

describe('estimateBackgroundTraced (SNIP trace parity)', () => {
  const counts = realCounts();
  const N = SNIP_DEFAULT_ITERATIONS;
  const trace = estimateBackgroundTraced(counts, N, [1, 5, 10, 20, N]);

  it('captures the requested checkpoints ascending, deduped, ending at iterations', () => {
    expect(trace.checkpoints).toEqual([1, 5, 10, 20, N]);
    expect(trace.snapshotsLls).toHaveLength(trace.checkpoints.length);
    expect(trace.iterations).toBe(N);
    expect(trace.windowInitial).toBe(1);
    expect(trace.windowFinal).toBe(N);
  });

  it('clamps, dedupes, and always ends at iterations for messy checkpoint input', () => {
    // Out of order, a duplicate, one > iterations (dropped), one < 1 (dropped), iterations absent.
    const t = estimateBackgroundTraced(counts, N, [20, 5, 5, 999, 0, 10]);
    expect(t.checkpoints).toEqual([5, 10, 20, N]);
    expect(t.snapshotsLls).toHaveLength(4);
  });

  it("final snapshot's inverse (clamped) equals estimateBackground(counts, iterations) — DoD 2a", () => {
    const fromTrace = clamp(trace.snapshotsLls[trace.snapshotsLls.length - 1].map(invLls));
    const committed = estimateBackground(counts, N);
    expect(fromTrace).toEqual(committed);
  });

  it("every snapshot's inverse (clamped) equals estimateBackground at that checkpoint — DoD 2b", () => {
    trace.checkpoints.forEach((cp, k) => {
      const fromTrace = clamp(trace.snapshotsLls[k].map(invLls));
      expect(fromTrace).toEqual(estimateBackground(counts, cp));
    });
  });

  it('changeSeries has one entry per pass and is non-negative — DoD 2c', () => {
    expect(trace.changeSeries).toHaveLength(N);
    expect(trace.changeSeries.every((c) => c >= 0)).toBe(true);
  });

  it('leaves estimateBackground byte-identical (the traced run is a separate clip)', () => {
    // Running the trace does not perturb a subsequent estimateBackground call.
    const a = estimateBackground(counts, N);
    estimateBackgroundTraced(counts, N, [1, 5, 10, 20, N]);
    const b = estimateBackground(counts, N);
    expect(a).toEqual(b);
  });
});
