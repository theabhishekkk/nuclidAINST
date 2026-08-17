import { describe, it, expect } from 'vitest';

import { load } from '../src/pipeline/load';
import { condition } from '../src/pipeline/condition';
import { detect, detectTraced } from '../src/pipeline/detect';
import { fitTraced } from '../src/pipeline/fit';
import { analyze, analyzeSpectrum } from '../src/pipeline/orchestrator';
import { savitzkyGolay } from '../src/signal';
import { syntheticTka } from '../src/data/synthetic';
import type { Spectrum } from '../src/domain/types';

/**
 * The revised Peak Finder Load stage adds three default-preserving engine seams
 * (HANDOFF 2026-07-04): `condition({smoothing:'none'})`, the `fitTraced` raw-source
 * thread (R1), and the pre-parsed `analyzeSpectrum` entry. These tests prove each
 * seam does what R1/R4 require AND that the DEFAULT (Calibrate/Identify) path is
 * untouched -- the check that the reference-parity fixtures stay green by
 * construction, without regenerating them.
 */

function loadDemo(): Spectrum {
  return load({ text: syntheticTka(), fileName: 'synthetic-demo.tka' });
}

describe('condition() smoothing option (R4)', () => {
  it("default 'savgol' still Savitzky-Golay smooths the net (reference path unchanged)", () => {
    const spec = loadDemo();
    const cond = condition(spec); // default options
    // The default detection series is clip-non-neg SG of the un-clipped net -- exactly
    // the reference `smooth_spectrum`. It must differ from the clipped net itself.
    const expected = savitzkyGolay(
      spec.counts.map((c, i) => c - cond.background[i]),
      9,
      3,
    ).map((v) => (v > 0 ? v : 0));
    expect(cond.smoothed).toEqual(expected);
    expect(cond.smoothed).not.toEqual(cond.netCounts);
  });

  it("'none' sets the detection series to the clipped net residual (no SG)", () => {
    const spec = loadDemo();
    const cond = condition(spec, { smoothing: 'none' });
    // R4: with smoothing off the detection input IS the (clipped) net residual.
    expect(cond.smoothed).toEqual(cond.netCounts);
    // Only the detection series changes -- background + net are identical to default.
    const dflt = condition(spec);
    expect(cond.background).toEqual(dflt.background);
    expect(cond.netCounts).toEqual(dflt.netCounts);
  });
});

describe('fitTraced raw-source thread (R1)', () => {
  it('omitting rawSource is byte-identical to passing conditioned.source (no-op default)', () => {
    const cond = condition(loadDemo());
    const cands = detect(cond);
    expect(cands.length).toBeGreaterThan(0);
    const base = fitTraced(cond, cands);
    const explicit = fitTraced(cond, cands, cond.source);
    expect(explicit.kept).toEqual(base.kept);
    expect(explicit.all).toEqual(base.all);
  });

  it('the fit sums areas over rawSource, not the conditioned/working series', () => {
    const cond = condition(loadDemo());
    const cands = detect(cond);
    const base = fitTraced(cond, cands);
    expect(base.kept.length).toBeGreaterThan(0);
    // A raw source with visibly larger counts must drive visibly larger fitted areas,
    // proving the fit reads rawSource.counts and never conditioned.source.counts.
    const scaled: Spectrum = {
      counts: cond.source.counts.map((c) => c * 2),
      metadata: cond.source.metadata,
    };
    const scaledFit = fitTraced(cond, cands, scaled);
    const b = base.kept[0];
    const s = scaledFit.kept.find((p) => p.detectedChannel === b.detectedChannel);
    expect(s).toBeDefined();
    // ~2x the amplitude/area (loose bound -- weighted LS, but unmistakably larger).
    expect(s!.netArea).toBeGreaterThan(b.netArea * 1.5);
  });
});

describe('detectTraced raw-source thread (Phase 1: strength heuristics pinned to raw)', () => {
  it('omitting rawSource is byte-identical to passing conditioned.source (no-op default)', () => {
    const cond = condition(loadDemo()); // default savgol path -- source IS raw here
    const base = detectTraced(cond);
    const explicit = detectTraced(cond, {}, cond.source);
    expect(explicit.all).toEqual(base.all);
    expect(explicit.survivors).toEqual(base.survivors);
  });

  it('net/gross area + significance are measured from rawSource, not the analysed input', () => {
    // Simulate the Peak Finder smoothed-input case: the analysed (working) spectrum
    // differs from the raw spectrum. Condition the working series (no double-smooth),
    // then detect once against the WORKING source (old behaviour) and once against the
    // RAW source (Phase 1). The strength numbers must track whichever counts were used.
    const raw = loadDemo();
    const working: Spectrum = {
      counts: raw.counts.map((c) => c * 0.5), // a visibly different analysed input
      metadata: raw.metadata,
    };
    const cond = condition(working, { smoothing: 'none' });

    const fromWorking = detectTraced(cond); // defaults to conditioned.source (working)
    const fromRaw = detectTraced(cond, {}, raw); // Phase 1: pinned to raw
    expect(fromRaw.all.length).toBe(fromWorking.all.length);
    expect(fromRaw.all.length).toBeGreaterThan(0);

    // Detection SERIES (channels, prominence, width) is the same -- it reads
    // conditioned.smoothed either way; only the raw-derived strength numbers move.
    expect(fromRaw.all.map((p) => p.channel)).toEqual(fromWorking.all.map((p) => p.channel));
    expect(fromRaw.all.map((p) => p.prominence)).toEqual(fromWorking.all.map((p) => p.prominence));

    // Raw counts are 2x the working counts, so raw-pinned gross area is larger.
    const wa = fromWorking.all[0];
    const ra = fromRaw.all[0];
    expect(ra.grossArea).toBeGreaterThan(wa.grossArea);
  });
});

describe('analyzeSpectrum pre-parsed entry (default path parity)', () => {
  it('analyzeSpectrum(spectrum) matches analyze({text,fileName}) for the same input', () => {
    const text = syntheticTka();
    const viaLoad = analyze({ text, fileName: 'synthetic-demo.tka' });
    const viaSpectrum = analyzeSpectrum(load({ text, fileName: 'synthetic-demo.tka' }));
    // Same peaks, same validated set -- the refactor is behaviour-preserving.
    expect(viaSpectrum.peaks).toEqual(viaLoad.peaks);
    expect(viaSpectrum.validatedPeaks).toEqual(viaLoad.validatedPeaks);
  });

  it('SG-OFF PF path == feeding raw through the new pipeline (internal consistency)', () => {
    // NOTE (honest test name, DoD 7.2): this is NOT equality to the OLD net-smoothed
    // detection. Today's default path net-smooths; the SG-OFF PF path does not. The
    // guarantee is that the Peak Finder's SG-OFF run equals feeding the raw spectrum
    // through the SAME new pipeline -- i.e. workingSpectrum === rawSpectrum makes the
    // run provably the raw-input path.
    const raw = loadDemo();
    const a = analyzeSpectrum(raw, { condition: { smoothing: 'none' }, rawSource: raw });
    const b = analyzeSpectrum(raw, { condition: { smoothing: 'none' }, rawSource: raw });
    expect(a.peaks).toEqual(b.peaks);
    // rawSource === the analysed spectrum here, so the fit is an exact no-op vs omitting it.
    const c = analyzeSpectrum(raw, { condition: { smoothing: 'none' } });
    expect(a.peaks).toEqual(c.peaks);
  });
});
