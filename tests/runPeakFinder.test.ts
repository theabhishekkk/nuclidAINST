import { describe, it, expect, afterEach } from 'vitest';

import {
  createPeakFinderManager,
  SG_DEFAULT_WINDOW,
  SG_DEFAULT_POLYORDER,
} from '../src/ui/peakFinderManager';
import {
  runPeakFinder,
  runPeakFinderTraced,
  resolveSelectedInput,
} from '../src/pipeline/runPeakFinder';
import {
  DEFAULT_PEAK_FINDER_CONFIG,
  type PeakFinderConfig,
} from '../src/pipeline/peakFinderConfig';
import { deriveSpectrumStatus } from '../src/pipeline/spectrumStatus';
import { savitzkyGolay } from '../src/signal';
import { syntheticTka } from '../src/data/synthetic';
import { load } from '../src/pipeline/load';
import { PF_STEP_IDS } from '../src/ui/peakFinderStepper';

/**
 * Phase 0 parity: the headless `runPeakFinder(raw, config)` is the extraction of the manager's
 * private detection choreography, and the manager now DELEGATES to it. These tests prove the
 * extraction is faithful -- the manager's scientific result equals `runPeakFinder`'s across the
 * config permutations (default; smoothed input + smoothed-net) -- and that the default config
 * matches the manager's fresh-load state so the two can never drift.
 *
 * Reports carry per-stage `durationMs` (wall-clock, non-deterministic), so parity is asserted on
 * the SCIENTIFIC payload -- fitted peaks, validated peaks, and the status contract -- not on the
 * timing trace.
 */
function forceReducedMotion(value: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: value });
}

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

/** Drive a manager to `done` (reduced-motion instant reveal) under the given knob mutations. */
function managerRun(mutate?: (mgr: ReturnType<typeof createPeakFinderManager>) => void) {
  forceReducedMotion(true);
  const mgr = createPeakFinderManager();
  mgr.load(syntheticTka(), 'synthetic-demo.tka');
  mgr.continueToSmoothing();
  mutate?.(mgr); // e.g. setContinuumInput('smoothed') before the continuum is estimated
  mgr.continueToContinuum();
  return mgr;
}

describe('runPeakFinder -- default config matches the manager fresh-load state', () => {
  it('DEFAULT_PEAK_FINDER_CONFIG mirrors the manager SG defaults + smoothed input/net choices', () => {
    expect(DEFAULT_PEAK_FINDER_CONFIG.preprocessing.sg.window).toBe(SG_DEFAULT_WINDOW);
    expect(DEFAULT_PEAK_FINDER_CONFIG.preprocessing.sg.polyorder).toBe(SG_DEFAULT_POLYORDER);
    expect(DEFAULT_PEAK_FINDER_CONFIG.continuum.input).toBe('smoothed');
    expect(DEFAULT_PEAK_FINDER_CONFIG.detection.netInput).toBe('smoothed-net');
    expect(DEFAULT_PEAK_FINDER_CONFIG.detection.sg.window).toBe(SG_DEFAULT_WINDOW);
    expect(DEFAULT_PEAK_FINDER_CONFIG.detection.sg.polyorder).toBe(SG_DEFAULT_POLYORDER);
  });
});

describe('runPeakFinder -- byte-identical to the manager (default config)', () => {
  it('the manager report equals runPeakFinder(raw, DEFAULT) on the scientific payload', () => {
    const mgr = managerRun();
    mgr.runDetection();
    const raw = mgr.rawSpectrum!;
    const { report } = runPeakFinder(raw, DEFAULT_PEAK_FINDER_CONFIG);

    expect(report.peaks).toEqual(mgr.report!.peaks);
    expect(report.validatedPeaks).toEqual(mgr.report!.validatedPeaks);
    expect(deriveSpectrumStatus(report)).toEqual(mgr.status);
  });

  it('runPeakFinderTraced additionally reproduces the status + report payload', () => {
    const mgr = managerRun();
    mgr.runDetection();
    const traced = runPeakFinderTraced(mgr.rawSpectrum!, DEFAULT_PEAK_FINDER_CONFIG);
    expect(traced.status).toEqual(mgr.status);
    expect(traced.report.peaks).toEqual(mgr.report!.peaks);
    expect(traced.report.validatedPeaks).toEqual(mgr.report!.validatedPeaks);
    // pipelineTrace is intentionally NOT compared: it embeds per-stage durationMs (wall-clock),
    // so it differs run-to-run even for identical science. The status + peaks are the contract.
    expect(traced.pipelineTrace).not.toBeNull();
  });
});

describe('runPeakFinder -- byte-identical to the manager (smoothed input + smoothed-net)', () => {
  it('matches when the smoothed spectrum feeds detection and the net is SG-smoothed', () => {
    const mgr = managerRun((m) => m.setContinuumInput('smoothed'));
    mgr.setNetInput('smoothed-net'); // valid once the continuum is computed
    mgr.runDetection();

    const config: PeakFinderConfig = {
      preprocessing: { sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER } },
      continuum: { input: 'smoothed' },
      detection: {
        netInput: 'smoothed-net',
        sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER },
      },
    };
    const { report } = runPeakFinder(mgr.rawSpectrum!, config);

    expect(report.peaks).toEqual(mgr.report!.peaks);
    expect(report.validatedPeaks).toEqual(mgr.report!.validatedPeaks);
    expect(deriveSpectrumStatus(report)).toEqual(mgr.status);
  });
});

describe('PeakFinderManager.hydrate -- drill-in from a config', () => {
  it('produces the same report as runPeakFinder and lands done with every step reached', () => {
    forceReducedMotion(true);
    const raw = load({ text: syntheticTka(), fileName: 'drill.tka' });
    const mgr = createPeakFinderManager();
    mgr.hydrate(raw, DEFAULT_PEAK_FINDER_CONFIG);

    const { report } = runPeakFinder(raw, DEFAULT_PEAK_FINDER_CONFIG);
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull();
    expect(mgr.report!.peaks).toEqual(report.peaks);
    expect(mgr.report!.validatedPeaks).toEqual(report.validatedPeaks);
    expect(mgr.reached).toBe(PF_STEP_IDS.length - 1); // Review reached -> every step unlocked
  });

  it('currentConfig() round-trips the hydrated config (drill-in override capture)', () => {
    forceReducedMotion(true);
    const raw = load({ text: syntheticTka(), fileName: 'drill.tka' });
    const config: PeakFinderConfig = {
      preprocessing: { sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER } },
      continuum: { input: 'smoothed' },
      detection: {
        netInput: 'smoothed-net',
        sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER },
      },
    };
    const mgr = createPeakFinderManager();
    mgr.hydrate(raw, config);
    expect(mgr.currentConfig()).toEqual(config);
  });

  it('honours a smoothed-input / smoothed-net config on drill-in', () => {
    forceReducedMotion(true);
    const raw = load({ text: syntheticTka(), fileName: 'drill.tka' });
    const config: PeakFinderConfig = {
      preprocessing: { sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER } },
      continuum: { input: 'smoothed' },
      detection: {
        netInput: 'smoothed-net',
        sg: { window: SG_DEFAULT_WINDOW, polyorder: SG_DEFAULT_POLYORDER },
      },
    };
    const mgr = createPeakFinderManager();
    mgr.hydrate(raw, config);
    const { report } = runPeakFinder(raw, config);
    expect(mgr.report!.peaks).toEqual(report.peaks);
    expect(mgr.report!.validatedPeaks).toEqual(report.validatedPeaks);
  });
});

describe('resolveSelectedInput -- input resolution matches the manager getter', () => {
  it('returns the raw spectrum for the raw input', () => {
    const mgr = managerRun();
    const raw = mgr.rawSpectrum!;
    // DEFAULT is now the smoothed input, so pin the raw choice explicitly to test raw resolution.
    const rawConfig = { ...DEFAULT_PEAK_FINDER_CONFIG, continuum: { input: 'raw' as const } };
    expect(resolveSelectedInput(raw, rawConfig)).toBe(raw);
  });

  it('returns the clip-non-negative SG smoothing of the raw for the smoothed input', () => {
    const mgr = managerRun();
    const raw = mgr.rawSpectrum!;
    const resolved = resolveSelectedInput(raw, {
      ...DEFAULT_PEAK_FINDER_CONFIG,
      continuum: { input: 'smoothed' },
    });
    const expected = savitzkyGolay(raw.counts, SG_DEFAULT_WINDOW, SG_DEFAULT_POLYORDER).map((v) =>
      v > 0 ? v : 0,
    );
    expect(resolved.counts).toEqual(expected);
    expect(resolved.metadata).toBe(raw.metadata);
  });
});
