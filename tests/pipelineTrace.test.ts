import { describe, it, expect, vi } from 'vitest';
import { analyze } from '../src/pipeline/orchestrator';
import { buildPipelineTrace } from '../src/pipeline/pipelineTrace';
import { detect } from '../src/pipeline/detect';
import { fitTraced } from '../src/pipeline/fit';
import {
  PROMINENCE,
  DISTANCE,
  MIN_WIDTH,
  REL_HEIGHT,
  WINDOW_FACTOR,
  MIN_HALF_WINDOW,
  MIN_SIGNIFICANCE,
  MAX_WIDTH_RATIO,
} from '../src/pipeline/detect';
import type {
  AnalysisReport,
  ConditionedSpectrum,
  DetectRejectReason,
  FitRejectReason,
  FitFailureReason,
  Spectrum,
} from '../src/domain/types';

import Am241 from './fixtures/reference/Am-241.json';
import Ba133 from './fixtures/reference/Ba-133.json';
import Cs137 from './fixtures/reference/Cs-137.json';
import Co60 from './fixtures/reference/Co-60.json';

/**
 * Peak Pipeline Inspector -- Phase 0 validation harness.
 *
 * Drives the FULL real pipeline (`analyze`) on real captured fixture counts (the
 * same spectra the detect/fit parity suites pin to the reference), then projects a
 * {@link PipelineTrace} and asserts the Phase-0 DoD invariants:
 *   - the survivor / kept sets are byte-identical to the engine's outputs (parity);
 *   - every rejected candidate / fit is tagged with a reason and retained;
 *   - the trace is internally consistent and every Appendix-B stage is present.
 *
 * `analyze` parses a TKA string, so we re-serialise each fixture's `counts` to TKA
 * and feed it through the exact production path (load -> condition -> detect -> fit
 * -> validate -> report).
 */

interface Fixture {
  source: string;
  counts: number[];
  peaks: number[];
}
const FIXTURES = [Am241, Ba133, Cs137, Co60] as unknown as Fixture[];

/** Real fixture counts as a TKA string (two header lines + one count per line). */
function tkaOf(f: Fixture): string {
  return [1800, 1835, ...f.counts].join('\n');
}

const DET_REASONS: readonly DetectRejectReason[] = ['prominence', 'distance', 'width'];
const FIT_REASONS: readonly FitRejectReason[] = ['peak-hop', 'edge'];
const FIT_FAILURE_REASONS: readonly FitFailureReason[] = [
  'too-few-points',
  'no-convergence',
  'non-physical',
  'degenerate',
  'error',
];

/** Build a ConditionedSpectrum from a fixture's committed reference arrays (mirrors
 * detect.test / fit.test) so we can drive detect + fitTraced directly. */
function conditionedFromFixture(f: {
  counts: number[];
  snip_background: number[];
  net_smoothed: number[];
  source: string;
}): ConditionedSpectrum {
  const counts = f.counts;
  const background = f.snip_background;
  const netCounts = counts.map((c, i) => Math.max(0, c - background[i]));
  const spectrum: Spectrum = {
    counts,
    metadata: {
      fileName: `${f.source}.TKA`,
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
  return { source: spectrum, background, netCounts, smoothed: f.net_smoothed };
}

describe('buildPipelineTrace -- contract invariants on real fixtures', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: trace is schema-valid, consistent, and parity-preserving`, () => {
      const report = analyze({ text: tkaOf(f), fileName: `${f.source}.TKA` });
      const trace = buildPipelineTrace(report);

      // --- versioned + provenance ------------------------------------------
      expect(trace.version).toBe(1);
      expect(trace.spectrumId).toBe(`${f.source}.TKA`);

      // --- channel/raw/conditioned alignment (Appendix B: raw + conditioned)
      expect(trace.raw).toBe(report.spectrum.counts);
      expect(trace.channels.length).toBe(trace.raw.length);
      expect(trace.channels[0]).toBe(0);
      expect(trace.channels[trace.channels.length - 1]).toBe(trace.raw.length - 1);
      expect(trace.conditioned).not.toBeNull();
      const cond = trace.conditioned!;
      expect(cond.background.length).toBe(trace.raw.length);
      expect(cond.netCounts.length).toBe(trace.raw.length);
      expect(cond.smoothed.length).toBe(trace.raw.length);
      // channels.length === raw.length === smoothed.length (conditioned present).
      expect(trace.channels.length).toBe(cond.smoothed.length);

      // --- detection stage --------------------------------------------------
      const { all: detAll, survivors } = trace.detected;
      // Parity: survivors ARE the report's detectedCandidates (same reference),
      // and the survivor channels equal the reference fixture peaks exactly.
      expect(survivors).toBe(report.detectedCandidates);
      expect(survivors.map((p) => p.channel)).toEqual(f.peaks);

      const detRejected = detAll.filter((p) => p.passed === false);
      // survivors + rejected == all (a candidate is exactly one of the two).
      expect(survivors.length + detRejected.length).toBe(detAll.length);
      // Real spectra carry many noise maxima -> the retention path is exercised.
      expect(detRejected.length).toBeGreaterThan(0);
      for (const p of survivors) {
        expect(p.passed).toBe(true);
        expect(p.rejectReason).toBeUndefined();
      }
      for (const p of detRejected) {
        expect(p.passed).toBe(false);
        expect(DET_REASONS).toContain(p.rejectReason);
      }
      // every survivor is in `all` by reference identity (all ⊇ survivors).
      for (const s of survivors) expect(detAll).toContain(s);
      // `all` is ascending by channel (local-maxima order preserved).
      for (let i = 1; i < detAll.length; i++) {
        expect(detAll[i].channel).toBeGreaterThan(detAll[i - 1].channel);
      }

      // --- fit stage --------------------------------------------------------
      const { all: fitAll, kept } = trace.fitted;
      expect(kept).toBe(report.peaks);
      // kept ⊆ all, each with status 'kept'.
      for (const k of kept) {
        expect(k.status).toBe('kept');
        expect(fitAll).toContain(k);
      }
      const fitRejected = fitAll.filter((p) => p.status === 'rejected');
      expect(kept.length + fitRejected.length).toBe(fitAll.length);
      for (const r of fitRejected) {
        expect(FIT_REASONS).toContain(r.rejectReason);
        expect(r.chiSquare).toBeNull(); // guard rejects before the stats are computed
        expect(Number.isFinite(r.centroidChannel)).toBe(true);
      }

      // --- GAP-07: three-way partition (kept ∪ rejected-with-line ∪ unfittable) ---
      const unfittable = trace.fitted.unfittable;
      // Every survivor lands in exactly one bucket: |all| + |unfittable| == |survivors|.
      expect(fitAll.length + unfittable.length).toBe(survivors.length);
      for (const u of unfittable) expect(FIT_FAILURE_REASONS).toContain(u.reason);
      // No survivor is double-bucketed: unfittable channels are disjoint from the
      // fitted (all) channels, and together they cover every survivor channel.
      const fittedChans = new Set(fitAll.map((p) => p.detectedChannel));
      for (const u of unfittable) expect(fittedChans.has(u.detectedChannel)).toBe(false);
      const bucketed = new Set<number>([
        ...fittedChans,
        ...unfittable.map((u) => u.detectedChannel),
      ]);
      for (const sv of survivors) expect(bucketed.has(sv.channel)).toBe(true);

      // --- validate stage: every verdict references a kept fit --------------
      const validated = trace.validated;
      expect(validated).toBe(report.validatedPeaks ?? []);
      for (const v of validated) expect(kept).toContain(v.peak);

      // --- constants snapshot (stage labels) --------------------------------
      expect(trace.constants).toEqual({
        prominence: PROMINENCE,
        distance: DISTANCE,
        minWidth: MIN_WIDTH,
        relHeight: REL_HEIGHT,
        windowFactor: WINDOW_FACTOR,
        minHalfWindow: MIN_HALF_WINDOW,
        minSignificance: MIN_SIGNIFICANCE,
        maxWidthRatio: MAX_WIDTH_RATIO,
      });

      // --- timing (Appendix B: every stage represented) ---------------------
      expect(trace.timing).toBe(report.trace);
      const stages = trace.timing.map((t) => t.stage);
      for (const s of ['load', 'condition', 'detect', 'fit', 'validate', 'report']) {
        expect(stages).toContain(s);
      }
    });
  }
});

describe('buildPipelineTrace -- lazy retention + a representative fit rejection', () => {
  it('Cs-137 retains an edge/peak-hop fit rejection (the reference ch117 hop)', () => {
    const report = analyze({ text: tkaOf(Cs137 as unknown as Fixture), fileName: 'Cs-137.TKA' });
    const trace = buildPipelineTrace(report);
    const rejected = trace.fitted.all.filter((p) => p.status === 'rejected');
    // The known Cs-137 hop (detected ch117, fit slides off the line) is retained,
    // not silently dropped.
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => FIT_REASONS.includes(r.rejectReason!))).toBe(true);

    // Eyeball sample of the emitted contract (compact; large arrays summarised).
    const sample = {
      spectrumId: trace.spectrumId,
      version: trace.version,
      channels: trace.channels.length,
      detected: { all: trace.detected.all.length, survivors: trace.detected.survivors.length },
      fitted: { all: trace.fitted.all.length, kept: trace.fitted.kept.length },
      fitRejections: rejected.map((r) => ({
        detectedChannel: r.detectedChannel,
        centroidChannel: Number(r.centroidChannel.toFixed(3)),
        rejectReason: r.rejectReason,
      })),
    };
    // eslint-disable-next-line no-console
    console.log('PipelineTrace sample (Cs-137):', JSON.stringify(sample, null, 2));
  });

  it('falls back to survivors/kept when a report lacks the retained sets', () => {
    const report = analyze({ text: tkaOf(Cs137 as unknown as Fixture), fileName: 'Cs-137.TKA' });
    // Simulate a legacy report with no additive retention (keys absent, not
    // `undefined`, to respect exactOptionalPropertyTypes).
    const stripped: Record<string, unknown> = { ...report };
    delete stripped.allDetected;
    delete stripped.allFitted;
    const trace = buildPipelineTrace(stripped as unknown as AnalysisReport);
    expect(trace.detected.all).toBe(report.detectedCandidates);
    expect(trace.fitted.all).toBe(report.peaks);
    expect(trace.detected.survivors).toBe(report.detectedCandidates);
  });
});

describe('GAP-07 -- unfittable survivors are actually captured (not just the empty invariant)', () => {
  it('at least one real fixture yields a non-empty unfittable set', () => {
    const found: { source: string; reasons: FitFailureReason[] }[] = [];
    for (const f of FIXTURES) {
      const trace = buildPipelineTrace(analyze({ text: tkaOf(f), fileName: `${f.source}.TKA` }));
      if (trace.fitted.unfittable.length) {
        found.push({ source: f.source, reasons: trace.fitted.unfittable.map((u) => u.reason) });
      }
    }
    // eslint-disable-next-line no-console
    console.log('GAP-07 unfittable captured:', JSON.stringify(found));
    // The three-way partition is proven above; here we prove the third bucket is
    // exercised on real data (a survivor that fits to no usable line).
    expect(found.length).toBeGreaterThan(0);
  });
});

describe('fitTraced -- per-survivor exception resilience (GAP-07, narrowly scoped)', () => {
  it('a fitPeak throw is caught, logged, bucketed unfittable(error); the run continues', () => {
    const f = Ba133 as unknown as {
      counts: number[];
      snip_background: number[];
      net_smoothed: number[];
      source: string;
    };
    const conditioned = conditionedFromFixture({ ...f, source: 'Ba-133' });
    const survivors = detect(conditioned);
    expect(survivors.length).toBeGreaterThan(0);

    // A candidate with NaN FWHM makes fitPeak throw (new Array(NaN) -> RangeError),
    // i.e. an injected per-survivor failure at the fit unit of work.
    const BOOM = 987654;
    const boom = { ...survivors[0], channel: BOOM, fwhmChannels: NaN };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = fitTraced(conditioned, [...survivors, boom]);

    // Surfaced as unfittable('error'), never silently hidden; logged loudly.
    expect(result.unfittable.some((u) => u.detectedChannel === BOOM && u.reason === 'error')).toBe(
      true,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    // The run continued: every input survivor is still partitioned (all ∪ unfittable),
    // and the real survivors produced the SAME kept fits as the clean run (parity).
    expect(result.all.length + result.unfittable.length).toBe(survivors.length + 1);
    const clean = fitTraced(conditioned, survivors);
    expect(result.kept.length).toBe(clean.kept.length);
    expect(result.all.length).toBe(clean.all.length);
  });
});

describe('buildPipelineTrace -- effective detect settings reach the trace constants (DEBT-27)', () => {
  it('a custom detect option is threaded into the trace constants, not the module default', () => {
    const report = analyze(
      { text: tkaOf(Cs137 as unknown as Fixture), fileName: 'Cs-137.TKA' },
      { detect: { prominence: 5 } },
    );
    const trace = buildPipelineTrace(report);
    // The overridden gate reflects THIS run's value, not PROMINENCE (200).
    expect(trace.constants.prominence).toBe(5);
    expect(trace.constants.prominence).not.toBe(PROMINENCE);
    // Non-overridden gates still report their module defaults.
    expect(trace.constants.distance).toBe(DISTANCE);
    expect(trace.constants.minWidth).toBe(MIN_WIDTH);
    expect(trace.constants.relHeight).toBe(REL_HEIGHT);
    // The measurement constants are never overridable by DetectOptions.
    expect(trace.constants.windowFactor).toBe(WINDOW_FACTOR);
    expect(trace.constants.minHalfWindow).toBe(MIN_HALF_WINDOW);
    expect(trace.constants.minSignificance).toBe(MIN_SIGNIFICANCE);
    expect(trace.constants.maxWidthRatio).toBe(MAX_WIDTH_RATIO);
  });

  it('a default run reports the module-default gates', () => {
    const report = analyze({ text: tkaOf(Cs137 as unknown as Fixture), fileName: 'Cs-137.TKA' });
    const trace = buildPipelineTrace(report);
    expect(trace.constants.prominence).toBe(PROMINENCE);
    expect(trace.constants.distance).toBe(DISTANCE);
    expect(trace.constants.minWidth).toBe(MIN_WIDTH);
    expect(trace.constants.relHeight).toBe(REL_HEIGHT);
  });
});
