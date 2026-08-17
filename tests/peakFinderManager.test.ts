import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createPeakFinderManager,
  SG_DEFAULT_WINDOW,
  SG_DEFAULT_POLYORDER,
} from '../src/ui/peakFinderManager';
import { estimateContinuum, condition, lls } from '../src/pipeline/condition';
import { savitzkyGolay } from '../src/signal';
import { syntheticTka } from '../src/data/synthetic';
import { peakFinderReviewAdjustMarkup } from '../src/ui/app';

/**
 * The PeakFinderManager is a UI orchestrator over the engine. Since the 2026-07-05 free-nav
 * restructure the execution phase is `collecting | held | error`, and navigation is carried
 * SEPARATELY by `focus` / `reached` (flat indices) with a focus-only `goToStep`.
 * `load()` parses + HOLDS the spectrum (`held`, focus on Load Spectrum); the forward Continue
 * milestones (continueToSmoothing -> continueToContinuum -> runDetection) each advance
 * `reached` and focus the new frontier. `done` is simply `held` with a report present. These
 * tests prove:
 * (1) load() holds the raw with focus/reached at Load Spectrum and NO auto-run,
 * (2) runDetection() runs the engine once and settles `held` (report present) with focus on
 *     Review -- instantly, with no stepping animation (removed 2026-07-07),
 * (3) SG: always applied on the SG page, the RAW never mutated, clamp + advisory,
 * (4) an unparseable file fails loud on `error`, and
 * (5) reset / backToCollecting drop the held spectrum + reset focus/reached, and
 * (6) free navigation: `reached` never retreats, `goToStep` is focus-only + lock-respecting.
 */

const REVIEW_ID = 'review';

function forceReducedMotion(value: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: value });
}

/** Load + advance to the Savitzky-Golay page (where the raw-SG controls live). */
function toSmoothing(mgr: ReturnType<typeof createPeakFinderManager>): void {
  mgr.load(syntheticTka(), 'synthetic-demo.tka');
  mgr.continueToSmoothing();
}

/** Load + advance to Estimate Continuum (Load -> Savitzky-Golay -> Continuum). */
function toContinuum(mgr: ReturnType<typeof createPeakFinderManager>): void {
  toSmoothing(mgr);
  mgr.continueToContinuum();
}

/** The full flow to done (reduced-motion instant reveal): Load -> Continuum -> Detection. */
function runToDone(mgr: ReturnType<typeof createPeakFinderManager>): void {
  toContinuum(mgr);
  mgr.runDetection();
}

afterEach(() => {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  vi.useRealTimers();
});

describe('PeakFinderManager -- load() parses + holds (no auto-run)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('a successful load lands `held` at Load Spectrum with the raw held and no run yet', () => {
    const mgr = createPeakFinderManager();
    expect(mgr.phase.kind).toBe('collecting');
    mgr.load(syntheticTka(), 'synthetic-demo.tka');
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focus).toBe(0);
    expect(mgr.focusId).toBe('load-spectrum');
    expect(mgr.reached).toBe(0); // nothing past Load Spectrum reached until Continue
    expect(mgr.rawSpectrum).not.toBeNull();
    expect(mgr.selectedInput).toBe(mgr.rawSpectrum);
    expect(mgr.smoothedSpectrum).toBeNull();
    // Default input is SG-smoothed (2026-07-07); the smoothed series is computed on the SG page,
    // so `selectedInput` above still falls back to raw until then.
    expect(mgr.continuumInput).toBe('smoothed');
    expect(mgr.sgWindow).toBe(SG_DEFAULT_WINDOW);
    expect(mgr.sgPolyorder).toBe(SG_DEFAULT_POLYORDER);
    expect(mgr.report).toBeNull();
    expect(mgr.pipelineTrace).toBeNull();
  });

  it('runDetection() analyses the selected input and settles `held` (done) with every artifact', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr);
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull();
    expect(mgr.stageTrace).not.toBeNull();
    expect(mgr.pipelineTrace).not.toBeNull();
    expect(mgr.status).not.toBeNull();
    expect(mgr.focusId).toBe(REVIEW_ID); // the reveal lands on Review
    expect(mgr.reached).toBe(16); // every step unlocked
    expect(mgr.pipelineTrace!.raw).toEqual(mgr.report!.spectrum.counts);
    expect(mgr.status!.peakCount).toBeGreaterThan(0);
  });

  it('continueToContinuum() before a spectrum is held is a no-op', () => {
    const mgr = createPeakFinderManager();
    mgr.continueToContinuum();
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.report).toBeNull();
  });

  it('fails loud (error phase, artifacts cleared) on an unparseable file', () => {
    const mgr = createPeakFinderManager();
    mgr.load('not\na\nspectrum', 'garbage.tka');
    expect(mgr.phase.kind).toBe('error');
    if (mgr.phase.kind === 'error') expect(mgr.phase.message.length).toBeGreaterThan(0);
    expect(mgr.rawSpectrum).toBeNull();
    expect(mgr.report).toBeNull();
    expect(mgr.reached).toBe(0);
  });
});

describe('PeakFinderManager -- Load-stage Savitzky-Golay (R3/R4/R1)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('SG is always applied on the SG page; the RAW is never mutated', () => {
    const mgr = createPeakFinderManager();
    const beforeRaw = createPeakFinderManager();
    beforeRaw.load(syntheticTka(), 'synthetic-demo.tka');
    const rawBefore = [...beforeRaw.rawSpectrum!.counts];

    toSmoothing(mgr);
    expect(mgr.focusId).toBe('load-sg');
    expect(mgr.reached).toBe(1);
    const rawRef = mgr.rawSpectrum!;
    expect(mgr.sgError).toBeNull();
    expect(mgr.smoothedSpectrum).not.toBeNull();
    expect(mgr.smoothedSpectrum).not.toBe(mgr.rawSpectrum);
    expect(mgr.smoothedSpectrum!.counts).not.toEqual(rawRef.counts);
    // Default input is SG-smoothed, so once the smoothed series exists `selectedInput` is it.
    expect(mgr.selectedInput).toBe(mgr.smoothedSpectrum);
    expect(mgr.availableInputs().map((i) => i.id)).toEqual(['raw', 'smoothed']);
    expect(rawRef.counts).toEqual(rawBefore);
  });

  it('setContinuumInput chooses the working spectrum on the SG page (SD-1)', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    // SG-smoothed is the default (2026-07-07); switching to raw and back is the input choice.
    expect(mgr.continuumInput).toBe('smoothed');
    expect(mgr.selectedInput).toBe(mgr.smoothedSpectrum);
    mgr.setContinuumInput('raw');
    expect(mgr.continuumInput).toBe('raw');
    expect(mgr.selectedInput).toBe(mgr.rawSpectrum);
    mgr.setContinuumInput('smoothed');
    expect(mgr.selectedInput).toBe(mgr.smoothedSpectrum);
  });

  it('manual entry cannot produce an invalid param -- the clamp supersedes the fail-loud path', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.setSgParams({ window: 8, polyorder: 3 }); // clamps to 7
    expect(mgr.sgWindow).toBe(7);
    expect(mgr.sgError).toBeNull();
    mgr.continueToContinuum();
    mgr.runDetection();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull();
  });

  it('resetSgDefaults restores the recommended window / polyorder', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.setSgParams({ window: 15, polyorder: 4 });
    expect(mgr.sgWindow).toBe(15);
    mgr.resetSgDefaults();
    expect(mgr.sgWindow).toBe(SG_DEFAULT_WINDOW);
    expect(mgr.sgPolyorder).toBe(SG_DEFAULT_POLYORDER);
  });
});

describe('PeakFinderManager -- SG guardrails: clamp + non-blocking advisory (O1 §6b)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  function held() {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    return mgr;
  }

  it('clamps an over-large window down to 15 (odd) with the HIGH advisory', () => {
    const mgr = held();
    mgr.setSgParams({ window: 51, polyorder: 3 });
    expect(mgr.sgWindow).toBe(15);
    expect(mgr.sgAdvisory).toMatch(/heavy/i);
    expect(mgr.sgError).toBeNull();
  });

  it('clamps a below-floor window up to 5 with the LOW advisory', () => {
    const mgr = held();
    mgr.setSgParams({ window: 3, polyorder: 3 });
    expect(mgr.sgWindow).toBe(5);
    expect(mgr.sgAdvisory).toMatch(/light/i);
  });

  it('coerces an even in-band window to the nearest odd, no advisory (no-warn band)', () => {
    const mgr = held();
    mgr.setSgParams({ window: 8, polyorder: 3 });
    expect(mgr.sgWindow).toBe(7);
    expect(mgr.sgAdvisory).toBeNull();
  });

  it('clamps polyorder to [2, 4]', () => {
    const mgr = held();
    mgr.setSgParams({ window: 9, polyorder: 9 });
    expect(mgr.sgPolyorder).toBe(4);
    mgr.setSgParams({ window: 9, polyorder: 0 });
    expect(mgr.sgPolyorder).toBe(2);
  });

  it('advisory is null at the default params (no-warn band)', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    expect(mgr.sgAdvisory).toBeNull();
  });

  it('an advisory never sets sgError and never blocks the run', () => {
    const mgr = held();
    mgr.setSgParams({ window: 15, polyorder: 3 });
    expect(mgr.sgAdvisory).toMatch(/heavy/i);
    expect(mgr.sgError).toBeNull();
    mgr.continueToContinuum();
    mgr.runDetection();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull();
  });

  it('resetSgDefaults clears the advisory', () => {
    const mgr = held();
    mgr.setSgParams({ window: 15, polyorder: 3 });
    expect(mgr.sgAdvisory).not.toBeNull();
    mgr.resetSgDefaults();
    expect(mgr.sgAdvisory).toBeNull();
    expect(mgr.sgWindow).toBe(SG_DEFAULT_WINDOW);
  });
});

describe('PeakFinderManager -- runDetection settles instantly (no stepping animation)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('runDetection() emits ONCE and lands on `held` with focus on Review -- no per-stage ticks', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    const seen: string[] = [];
    mgr.subscribe(() => seen.push(mgr.phase.kind));
    mgr.runDetection();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focusId).toBe(REVIEW_ID);
    expect(mgr.report).not.toBeNull();
    // No timer advances the phase further -- a single settle emit, no stepping.
    vi.advanceTimersByTime(8000);
    expect(seen).toEqual(['held']);
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focusId).toBe(REVIEW_ID);
  });

  it('goToStep freely focuses any run step once detection is done (no reveal lock)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.runDetection();
    mgr.goToStep('run-5'); // every step is reached -> focus moves freely
    expect(mgr.focusId).toBe('run-5');
    mgr.goToStep('run-0');
    expect(mgr.focusId).toBe('run-0');
  });
});

describe('PeakFinderManager -- lifecycle', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('reset drops the held spectrum + run and returns to collecting (focus/reached 0)', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr);
    expect(mgr.phase.kind).toBe('held');
    mgr.reset();
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.rawSpectrum).toBeNull();
    expect(mgr.smoothedSpectrum).toBeNull();
    expect(mgr.selectedInput).toBeNull();
    expect(mgr.report).toBeNull();
    expect(mgr.focus).toBe(0);
    expect(mgr.reached).toBe(0);
  });

  it('backToCollecting drops the held spectrum + SG state', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.backToCollecting();
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.rawSpectrum).toBeNull();
    expect(mgr.smoothedSpectrum).toBeNull();
    expect(mgr.continuumInput).toBe('smoothed'); // reset restores the SG-smoothed default
    expect(mgr.reached).toBe(0);
  });
});

describe('PeakFinderManager -- free navigation (reached latch + focus)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('goToStep is focus-only and never retreats `reached` (free backward nav while done)', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr); // reached 11, focus Review
    let notified = 0;
    mgr.subscribe(() => notified++);
    mgr.goToStep('load-spectrum');
    expect(mgr.focusId).toBe('load-spectrum');
    expect(mgr.reached).toBe(16); // unchanged -- nothing re-locks
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull(); // the run is untouched by navigation
    expect(notified).toBe(1);
    mgr.goToStep('run-3');
    expect(mgr.focusId).toBe('run-3');
  });

  it('goToStep to a not-yet-reached (locked) step is a no-op', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr); // reached 1 (load-sg)
    mgr.goToStep('cont-working'); // index 2 > reached -> locked
    expect(mgr.focusId).toBe('load-sg');
    mgr.goToStep('review');
    expect(mgr.focusId).toBe('load-sg');
  });

  it('reached advances monotonically through the forward milestones', () => {
    const mgr = createPeakFinderManager();
    mgr.load(syntheticTka(), 'synthetic-demo.tka');
    expect(mgr.reached).toBe(0);
    mgr.continueToSmoothing();
    expect(mgr.reached).toBe(1);
    mgr.continueToContinuum();
    expect(mgr.reached).toBe(7); // all six continuum pages unlocked at once
    mgr.runDetection();
    expect(mgr.reached).toBe(16);
  });
});

describe('PeakFinderManager -- Estimate Continuum stage (SD3: input registry + split run)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('continueToContinuum() estimates the continuum for the SG-smoothed default; focus lands on the net-SG gate', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.phase.kind).toBe('held');
    // Load-done lands focus directly on the net-SG gate (cont-sg).
    expect(mgr.focusId).toBe('cont-sg');
    expect(mgr.reached).toBe(7);
    expect(mgr.backgroundSpectrum).not.toBeNull();
    expect(mgr.netSpectrum).not.toBeNull();
    expect(mgr.backgroundSpectrum!.length).toBe(mgr.rawSpectrum!.counts.length);
    // Default input is SG-smoothed, so the continuum is estimated from the smoothed series.
    expect(mgr.selectedInput).toBe(mgr.smoothedSpectrum);
    const { background, net } = estimateContinuum(mgr.selectedInput!);
    expect([...mgr.backgroundSpectrum!]).toEqual(background);
    expect([...mgr.netSpectrum!]).toEqual(net);
    expect(mgr.report).toBeNull();
  });

  it('choosing smoothed then estimating uses the smoothed input (registry, SD-1)', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.setContinuumInput('smoothed');
    mgr.continueToContinuum();
    expect(mgr.selectedInput).toBe(mgr.smoothedSpectrum);
    const { background: smBg } = estimateContinuum(mgr.smoothedSpectrum!);
    expect([...mgr.backgroundSpectrum!]).toEqual(smBg);
    const { background: rawBg } = estimateContinuum(mgr.rawSpectrum!);
    expect([...mgr.backgroundSpectrum!]).not.toEqual(rawBg);
  });

  it('setContinuumInput after detection has run re-runs it live (no reveal replay)', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr); // SG-smoothed input by default, phase held, focus Review
    mgr.setContinuumInput('raw'); // switch off the default -> live re-run
    expect(mgr.continuumInput).toBe('raw');
    expect(mgr.selectedInput).toBe(mgr.rawSpectrum);
    expect(mgr.phase.kind).toBe('held'); // NOT 'revealing' -- non-animated re-run
    expect(mgr.focusId).toBe('review'); // focus unchanged by the live recompute
    // Detection consumed the raw input's net.
    expect(mgr.pipelineTrace!.conditioned!.netCounts).toEqual([...mgr.netSpectrum!]);
  });

  it('runDetection() consumes the selected input net and settles done', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.runDetection();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.report).not.toBeNull();
    expect(mgr.pipelineTrace).not.toBeNull();
    expect(mgr.pipelineTrace!.conditioned!.netCounts).toEqual([...mgr.netSpectrum!]);
  });

  it('goToStep back to the SG page keeps the held spectrum + continuum computed', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.goToStep('load-sg');
    expect(mgr.focusId).toBe('load-sg');
    expect(mgr.rawSpectrum).not.toBeNull();
    expect(mgr.backgroundSpectrum).not.toBeNull(); // continuum is NOT un-computed by nav
  });

  it('continueToContinuum computes the continuum immediately (no animated reveal)', () => {
    forceReducedMotion(false); // even without reduced motion there is no sub-step animation now
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.continueToContinuum();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.backgroundSpectrum).not.toBeNull();
    expect(mgr.netSpectrum).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(mgr.phase.kind).toBe('held'); // no timer advanced it anywhere
  });
});

describe('PeakFinderManager -- error auto-recovery countdown (Rev 4)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('exposes a 5s countdown on error and auto-returns to collecting when it elapses', () => {
    const mgr = createPeakFinderManager();
    mgr.load('not\na\nspectrum', 'garbage.tka');
    expect(mgr.phase.kind).toBe('error');
    expect(mgr.errorCountdown).toBe(5);
    vi.advanceTimersByTime(1000);
    expect(mgr.errorCountdown).toBe(4);
    vi.advanceTimersByTime(3000);
    expect(mgr.errorCountdown).toBe(1);
    expect(mgr.phase.kind).toBe('error');
    vi.advanceTimersByTime(1000);
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.errorCountdown).toBeNull();
  });

  it('a fresh load() cancels any pending error countdown (lands held)', () => {
    const mgr = createPeakFinderManager();
    mgr.load('not\na\nspectrum', 'garbage.tka');
    expect(mgr.errorCountdown).toBe(5);
    mgr.load(syntheticTka(), 'synthetic-demo.tka');
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.errorCountdown).toBeNull();
    vi.advanceTimersByTime(20000);
    expect(mgr.phase.kind).toBe('held');
  });
});

describe('PeakFinderManager -- net SG (#3, mandatory Net / Smoothed-Net choice)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('defaults to Smoothed-Net + SG-smoothed input with recommended params; fully stacked lineage + combined advisory', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.netInput).toBe('smoothed-net'); // Smoothed-Net is the default (2026-07-07)
    expect(mgr.detectionSgWindow).toBe(SG_DEFAULT_WINDOW);
    expect(mgr.detectionSgPolyorder).toBe(SG_DEFAULT_POLYORDER);
    // Both the smoothed input AND smoothed-net are on by default -> the fully stacked lineage,
    // and the combined SG window (9+9-1=17) trips the heavy-smoothing advisory.
    expect(mgr.detectionProvenance).toBe(
      `Raw → SG(w=${SG_DEFAULT_WINDOW}) → SNIP net → SG(w=${SG_DEFAULT_WINDOW})`,
    );
    expect(mgr.detectionSgAdvisory).not.toBeNull();
    expect(mgr.smoothedNetSpectrum).not.toBeNull(); // #3: always computed, previewable
  });

  it('Smoothed-Net on the raw input is a single net-SG stage in the lineage, no combined advisory', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.setContinuumInput('raw'); // raw input -> only the detection SG contributes
    expect(mgr.netInput).toBe('smoothed-net'); // still the default
    expect(mgr.detectionProvenance).toBe(`Raw → SNIP net → SG(w=${SG_DEFAULT_WINDOW})`);
    expect(mgr.detectionSgAdvisory).toBeNull();
  });

  it('smoothed input + Smoothed-Net shows the full stacked lineage + a combined advisory', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr);
    mgr.setContinuumInput('smoothed');
    mgr.continueToContinuum();
    mgr.setNetInput('smoothed-net');
    expect(mgr.detectionProvenance).toBe(
      `Raw → SG(w=${SG_DEFAULT_WINDOW}) → SNIP net → SG(w=${SG_DEFAULT_WINDOW})`,
    );
    expect(mgr.detectionSgAdvisory).not.toBeNull();
  });

  it('clamps net-SG params to the sensible band (window 5..15 odd, poly 2..4)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.setDetectionSgParams({ window: 99, polyorder: 9 });
    expect(mgr.detectionSgWindow).toBe(15);
    expect(mgr.detectionSgPolyorder).toBe(4);
    mgr.resetDetectionSgDefaults();
    expect(mgr.detectionSgWindow).toBe(SG_DEFAULT_WINDOW);
    expect(mgr.detectionSgPolyorder).toBe(SG_DEFAULT_POLYORDER);
  });

  it('setNetInput is a no-op before the continuum is computed', () => {
    const mgr = createPeakFinderManager();
    mgr.setNetInput('net'); // collecting -- no continuum; cannot move off the Smoothed-Net default
    expect(mgr.netInput).toBe('smoothed-net');
    toSmoothing(mgr);
    mgr.setNetInput('net'); // SG page, continuum not yet computed
    expect(mgr.netInput).toBe('smoothed-net');
  });

  it('both net choices complete a run; Smoothed-Net is the default path', () => {
    const def = createPeakFinderManager();
    runToDone(def); // Smoothed-Net default
    expect(def.phase.kind).toBe('held');
    expect(def.report).not.toBeNull();

    const alt = createPeakFinderManager();
    toContinuum(alt);
    alt.setNetInput('net'); // the non-default path
    alt.runDetection();
    expect(alt.phase.kind).toBe('held');
    expect(alt.report).not.toBeNull();
    expect(alt.pipelineTrace).not.toBeNull();
  });

  it('a fresh load resets the net choice to Smoothed-Net + recommended defaults', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.setNetInput('net'); // move OFF the default
    mgr.setDetectionSgParams({ window: 13, polyorder: 4 });
    mgr.load(syntheticTka(), 'synthetic-demo.tka');
    expect(mgr.netInput).toBe('smoothed-net'); // reset restores the Smoothed-Net default
    expect(mgr.detectionSgWindow).toBe(SG_DEFAULT_WINDOW);
    expect(mgr.detectionSgPolyorder).toBe(SG_DEFAULT_POLYORDER);
  });
});

describe('PeakFinderManager -- continuum sub-page derived series (slice 2)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('llsInput / llsBackground are the LLS-domain reconstructions (no SNIP re-run)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    const input = mgr.selectedInput!;
    const background = mgr.backgroundSpectrum!;
    expect([...mgr.llsInput!]).toEqual(input.counts.map(lls));
    expect([...mgr.llsBackground!]).toEqual(background.map(lls));
  });

  it('workingNet equals the clipped net when the choice is Net (= netSpectrum)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.setNetInput('net'); // off the Smoothed-Net default onto the plain net
    expect(mgr.netInput).toBe('net');
    expect([...mgr.workingNet!]).toEqual([...mgr.netSpectrum!]);
  });

  it('workingNet equals what detection consumes when the choice is Smoothed-Net (condition savgol parity)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    mgr.setNetInput('smoothed-net');
    mgr.setDetectionSgParams({ window: 11, polyorder: 3 });
    const input = mgr.selectedInput!;
    // The preview MUST equal condition()'s savgol branch: SG the un-clipped net, then clip.
    const conditioned = condition(input, {
      smoothing: 'savgol',
      savgolWindow: 11,
      savgolPolyorder: 3,
    });
    expect([...mgr.workingNet!]).toEqual(conditioned.smoothed);
    // ...and equals the hand-rolled reference too (savgol(input - background), then clip).
    const background = mgr.backgroundSpectrum!;
    const expected = savitzkyGolay(
      input.counts.map((c, i) => c - background[i]),
      11,
      3,
    ).map((v) => (v > 0 ? v : 0));
    expect([...mgr.workingNet!]).toEqual(expected);
  });
});

describe('PeakFinderManager -- live-recompute cascade (slice 3)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('editing the net SG after a run re-runs detection in place, never replaying the reveal', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr); // Smoothed-Net default
    const before = mgr.pipelineTrace!;
    mgr.setDetectionSgParams({ window: 13, polyorder: 3 }); // re-tunes the net SG -> live re-run
    expect(mgr.phase.kind).toBe('held'); // NOT 'revealing'
    expect(mgr.focusId).toBe('review'); // focus untouched
    expect(mgr.reached).toBe(16); // reached untouched
    expect(mgr.report).not.toBeNull();
    // The detection consumed the freshly re-smoothed working net (its conditioned series changed).
    expect(mgr.pipelineTrace).not.toBe(before);
    expect(mgr.pipelineTrace!.conditioned!.smoothed).toEqual([...mgr.workingNet!]);
  });

  it('editing the Load SG after a run re-runs detection only when the smoothed input feeds it', () => {
    // Raw input selected -> a Load-SG edit does NOT touch the raw-input detection.
    const rawMgr = createPeakFinderManager();
    toContinuum(rawMgr);
    rawMgr.setContinuumInput('raw'); // off the SG-smoothed default onto the raw input
    rawMgr.runDetection();
    const rawTrace = rawMgr.pipelineTrace!;
    rawMgr.goToStep('load-sg');
    rawMgr.setSgParams({ window: 13, polyorder: 3 });
    expect(rawMgr.pipelineTrace).toBe(rawTrace); // unchanged -- smoothed input not selected

    // Smoothed input selected -> a Load-SG edit recomputes the continuum AND re-runs detection.
    const smMgr = createPeakFinderManager();
    toSmoothing(smMgr);
    smMgr.setContinuumInput('smoothed');
    smMgr.continueToContinuum();
    smMgr.runDetection();
    const smTrace = smMgr.pipelineTrace!;
    smMgr.goToStep('load-sg');
    smMgr.setSgParams({ window: 13, polyorder: 3 });
    expect(smMgr.pipelineTrace).not.toBe(smTrace); // re-ran
    // The re-run consumed the freshly-smoothed input's net.
    expect(smMgr.pipelineTrace!.conditioned!.netCounts).toEqual([...smMgr.netSpectrum!]);
  });

  it('a live re-run before detection is a no-op (nothing to refresh)', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr); // continuum computed, detection not run
    mgr.setNetInput('smoothed-net');
    expect(mgr.report).toBeNull(); // no detection to re-run
    expect(mgr.workingNet).not.toBeNull(); // ...but the preview still refreshed
  });
});

describe('PeakFinderManager -- performPeakFitting() runs the whole pipeline to Review', () => {
  // "Perform Peak Fitting" (2026-07-08): the single forward action shared by both SG stages
  // runs continuum + detection in one shot and lands on the Review output page.
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('from the raw-SG stage (load-sg): computes continuum + detection and lands on Review, held', () => {
    const mgr = createPeakFinderManager();
    toSmoothing(mgr); // focus on load-sg; no continuum/detection yet
    expect(mgr.focusId).toBe('load-sg');
    expect(mgr.report).toBeNull();
    mgr.performPeakFitting();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focusId).toBe(REVIEW_ID);
    expect(mgr.reached).toBe(mgr.focus); // Review is the frontier
    expect(mgr.report).not.toBeNull();
    expect(mgr.pipelineTrace).not.toBeNull();
  });

  it('from the net-SG stage (cont-sg) also lands on Review with a report', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr); // focus on cont-sg
    expect(mgr.focusId).toBe('cont-sg');
    mgr.performPeakFitting();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focusId).toBe(REVIEW_ID);
    expect(mgr.report).not.toBeNull();
  });

  it('is a no-op before a spectrum is held', () => {
    const mgr = createPeakFinderManager();
    mgr.performPeakFitting();
    expect(mgr.phase.kind).toBe('collecting');
    expect(mgr.report).toBeNull();
  });
});

describe('PeakFinderManager -- Continue lands instantly (no walkthrough animation)', () => {
  // The continuum walkthrough + detect reveal stepping animations were removed 2026-07-07.
  // continueToContinuum lands directly on the net-SG gate (`cont-sg`); runDetection lands on
  // Review. Nothing schedules a timer, so no tick ever moves focus.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('Load-done lands on the net-SG gate immediately, with every continuum page unlocked', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.focusId).toBe('cont-sg');
    // Every continuum page is reachable (the user can navigate back freely).
    mgr.goToStep('cont-working');
    expect(mgr.focusId).toBe('cont-working');
  });

  it('no timer is scheduled by Continue -- advancing the clock never moves focus', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.focusId).toBe('cont-sg');
    vi.advanceTimersByTime(9000);
    expect(mgr.focusId).toBe('cont-sg'); // no stray auto-advance
  });

  it('resolving the gate (runDetection) lands on Review, held', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.focusId).toBe('cont-sg');
    mgr.runDetection();
    expect(mgr.phase.kind).toBe('held');
    expect(mgr.focusId).toBe('review');
  });

  it('reset / backToCollecting / a fresh load leave no leaked timer', () => {
    const mgr = createPeakFinderManager();
    toContinuum(mgr);
    expect(mgr.focusId).toBe('cont-sg');
    mgr.reset();
    vi.advanceTimersByTime(9000);
    expect(mgr.focusId).toBe('load-spectrum');
    expect(mgr.phase.kind).toBe('collecting');

    const mgr2 = createPeakFinderManager();
    toContinuum(mgr2);
    mgr2.backToCollecting();
    vi.advanceTimersByTime(9000);
    expect(mgr2.phase.kind).toBe('collecting');

    const mgr3 = createPeakFinderManager();
    toContinuum(mgr3);
    mgr3.load(syntheticTka(), 'x.tka');
    vi.advanceTimersByTime(9000);
    expect(mgr3.focusId).toBe('load-spectrum'); // fresh load, no stray advance
  });
});

describe('Review-page Adjust-smoothing panel (peakFinderReviewAdjustMarkup)', () => {
  beforeEach(() => {
    forceReducedMotion(true);
    vi.useFakeTimers();
  });

  it('reflects the SG-smoothed defaults as the active toggles after a run', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr);
    const html = peakFinderReviewAdjustMarkup(mgr);
    expect(html).toContain('Not satisfied with the results?');
    // Defaults: the smoothed input + smoothed-net are the pressed choices; raw + plain net are not.
    expect(html).toContain('data-input="smoothed" aria-pressed="true"');
    expect(html).toContain('data-input="raw" aria-pressed="false"');
    expect(html).toContain('data-net-input="smoothed-net" aria-pressed="true"');
    expect(html).toContain('data-net-input="net" aria-pressed="false"');
  });

  it('tracks a live input switch (raw becomes the pressed choice)', () => {
    const mgr = createPeakFinderManager();
    runToDone(mgr);
    mgr.setContinuumInput('raw');
    mgr.setNetInput('net');
    const html = peakFinderReviewAdjustMarkup(mgr);
    expect(html).toContain('data-input="raw" aria-pressed="true"');
    expect(html).toContain('data-input="smoothed" aria-pressed="false"');
    expect(html).toContain('data-net-input="net" aria-pressed="true"');
    expect(html).toContain('data-net-input="smoothed-net" aria-pressed="false"');
  });
});
