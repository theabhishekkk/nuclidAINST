/**
 * PeakFinderConfig -- the ONE serializable value that fully describes a Peak Finder run.
 *
 * Rationale (Batch Peak Finder, Phase 0): today the Peak Finder's knobs live as imperative
 * state scattered across {@link PeakFinderManager} (SG params, continuum input choice, net
 * choice, detection-SG params), assembled step by step as the operator clicks Continue. That
 * is fine for one interactive spectrum but impossible to (a) hand to a headless batch worker,
 * (b) persist, or (c) inherit-with-override across many files. This type lifts every knob into
 * a plain data value with NO behaviour -- the "config as data" foundation the batch layer and
 * {@link runPeakFinder} are built on.
 *
 * Invariant: `runPeakFinder(spectrum, config)` is a pure function of `(spectrum, config)`. The
 * interactive manager builds one of these from its live state and runs the SAME function, so an
 * interactively-inspected file and a batch-queued file produce byte-identical results by
 * construction -- not by discipline.
 *
 * Element-agnostic (RISK-02): no field is shaped to an isotope; a config is detector/knob data.
 */
import type { DetectOptions } from './detect';
import type { ValidateOptions } from './validate';

/** Which representation feeds SNIP continuum + detection. Mirrors the manager's
 * `SpectrumInputId`; kept as a local literal so this domain value never imports the UI layer. */
export type ContinuumInputId = 'raw' | 'smoothed';

/** Which net series detection consumes: the SNIP net directly, or the SG-smoothed net. */
export type NetInputId = 'net' | 'smoothed-net';

/** A Savitzky-Golay parameter pair (window must be odd; polyorder < window -- the engine
 * fail-loud checks enforce it, so this stays a plain value). */
export interface SgParams {
  readonly window: number;
  readonly polyorder: number;
}

/**
 * The complete Peak Finder pipeline configuration. Everything the choreography needs and
 * nothing the presentation layer owns (reveal pace, focus, timers stay in the manager).
 */
export interface PeakFinderConfig {
  readonly preprocessing: {
    /** Load-stage Savitzky-Golay params. The smoothed spectrum is always computable from
     * these; {@link PeakFinderConfig.continuum}.input decides whether it feeds downstream. */
    readonly sg: SgParams;
  };
  readonly continuum: {
    /** Raw, or the SG-smoothed raw, as the input the SNIP continuum + detection analyse. */
    readonly input: ContinuumInputId;
  };
  readonly detection: {
    /** The SNIP net, or the detection-SG-smoothed net, as the series detection consumes. */
    readonly netInput: NetInputId;
    /** Detection-stage Savitzky-Golay params -- applied iff `netInput === 'smoothed-net'`. */
    readonly sg: SgParams;
    /** Detection gate overrides; omit for the engine defaults (PARK-13: tunable controls parked). */
    readonly options?: DetectOptions;
  };
  /** Validation gate overrides; omit for the engine defaults. */
  readonly validate?: ValidateOptions;
}

/**
 * Recommended defaults -- the standing Peak Finder settings a fresh load starts from (open
 * question #3, resolved: the batch default seeds from these). MUST equal the manager's
 * fresh-load state (SG 9/3, SG-smoothed input, 'smoothed-net' choice); a parity test asserts the
 * two never drift. Window 9 / polyorder 3 is the confirmed SG sweet spot (O1,
 * FINDINGS_PEAK_FINDER_SG_DEFAULTS). The Savitzky-Golay smoothed input + smoothed-net are the
 * standing default (2026-07-07): SG is no longer a mandatory upfront decision -- the pipeline runs
 * smoothed by default and the operator re-tunes the choice from the Review page if unsatisfied.
 */
export const DEFAULT_PEAK_FINDER_CONFIG: PeakFinderConfig = {
  preprocessing: { sg: { window: 9, polyorder: 3 } },
  continuum: { input: 'smoothed' },
  detection: { netInput: 'smoothed-net', sg: { window: 9, polyorder: 3 } },
};
