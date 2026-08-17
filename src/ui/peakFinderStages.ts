/**
 * peakFinderStages -- the Peak-Finder-OWNED Run stage list (Phase 3).
 *
 * The shared {@link INSPECTOR_STAGES} (inspectorWorkspace.ts) stays the coarse six
 * that Calibrate / Identify's consolidated inspector renders; Peak Finder gets its
 * OWN eight-stage breakdown here (operator ruling 2026-07-05), so the single
 * "Candidates" stage becomes six inspectable sub-stages while Fit + Validated stay
 * their own stages. NO backend change: every sub-stage is reconstructed from the
 * existing {@link PipelineTrace} (`detected.all` first-failing `rejectReason`).
 *
 * Home of the list (imported by the stepper, the manager's reveal length, the app's
 * caption + chart routing, and the tables) so the Run stage set is single-sourced.
 * Same `{ id, label, caption, source }` shape as INSPECTOR_STAGES, so the existing
 * derivations keep working. Chart + table routing keys on the string `id` (never a
 * numeric index shared with Calibrate), so the two hosts never couple.
 */
export interface PeakFinderStage {
  /** Stable id -- the chart + table routing key. */
  readonly id: string;
  readonly label: string;
  /** Caption copy; `pfCaption` substitutes the count / gate tokens below. */
  readonly caption: string;
  /** The real module this stage's work lives in (truthful provenance). */
  readonly source: string;
}

/**
 * The eight Peak Finder Run stages, in flow order. Tokens resolved at render time by
 * `pfCaption`: `{all}` (local maxima), `{afterDistance}`, `{afterProminence}`,
 * `{survivors}` (post-gate), and the effective gate constants `{distance}` /
 * `{prominence}` / `{minWidth}` (from `trace.constants`).
 */
export const PF_RUN_STAGES: readonly PeakFinderStage[] = [
  {
    id: 'local-maxima',
    label: 'Find Local Maxima',
    caption: 'Every strict local maximum on the detection series — {all} candidates before any gate.',
    source: 'signal/findPeaks.ts',
  },
  {
    id: 'distance',
    label: 'Distance Gate',
    caption:
      'Distance gate: peaks closer than {distance} channels are dropped (the taller wins). ' +
      '{afterDistance} remain.',
    source: 'signal/findPeaks.ts',
  },
  {
    id: 'prominence',
    label: 'Prominence Filter',
    caption:
      'Prominence gate: peaks rising less than {prominence} above their base are dropped. ' +
      '{afterProminence} remain.',
    source: 'signal/peakProminences.ts',
  },
  {
    id: 'width',
    label: 'Width Filter',
    caption:
      'Width gate: peaks narrower than {minWidth} channels at half-prominence are dropped. ' +
      '{survivors} survive all three gates.',
    source: 'signal/peakWidths.ts',
  },
  {
    id: 'strength',
    label: 'Estimate Peak Strength',
    caption:
      'Per-survivor strength estimate — net area from the working series you chose (net or ' +
      'smoothed-net); gross area stays the raw total counts, so significance = net / √gross ' +
      'is Poisson-correct. Heuristics for ranking and gating, not the final measurement.',
    source: 'pipeline/detect.ts',
  },
  {
    id: 'classification',
    label: 'Preliminary Classification',
    caption:
      'Preliminary class per survivor — line / broad / weak — deciding what proceeds to fitting.',
    source: 'pipeline/detect.ts',
  },
  {
    id: 'fit',
    label: 'Peak Fitting',
    caption:
      'A Gaussian is fitted to each survivor over the continuum; the shaded band is the ' +
      '±1.5·FWHM window the net area was summed over.',
    source: 'pipeline/fit.ts',
  },
  {
    id: 'validated',
    label: 'Validate Peaks',
    // Peak Finder is channel-space only -- no energy-calibration framing (that wording
    // lives on the shared INSPECTOR_STAGES validated caption for Calibrate's benefit).
    caption: 'Validated peaks — the final output of the detection pipeline.',
    source: 'pipeline/validate.ts',
  },
];

/** Clamp a Run stage index into 0..PF_RUN_STAGES.length-1 (defensive against stale state). */
export function clampPeakFinderStage(i: number): number {
  return Math.min(Math.max(0, Math.floor(i) || 0), PF_RUN_STAGES.length - 1);
}
