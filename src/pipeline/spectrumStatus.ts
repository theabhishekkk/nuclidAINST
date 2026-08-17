/**
 * Peak Pipeline Inspector -- Phase 1: the SIGNAL CONTRACT.
 *
 * A pure, read-only projection over an {@link AnalysisReport} that classifies one
 * analyzed spectrum into exactly one of four states -- healthy / anomaly / empty /
 * failure -- plus the counts and card label that go with it. This is the SINGLE
 * SOURCE OF TRUTH for the spectrum cards (Phase 2), the status-aware selector and
 * the inspector itself (Principle 9): nothing downstream may recompute status.
 *
 * State semantics (operator-ratified addendum, 2026-07-03): **anomaly** = the
 * pipeline found or produced peaks/candidates that did NOT become valid results
 * (unfittable survivors, guard-rejected fits, or kept fits that all failed the
 * validate gate); **empty** = genuinely nothing to work with (no survivors and no
 * kept fits). The contract distinguishes scientifically different outcomes, not
 * the current card wording.
 *
 * Doctrine mirrors `buildPipelineTrace` (`pipelineTrace.ts`): a pure projection
 * that introduces no new numeric computation (it only counts verdicts the engine
 * already stamped), mutates nothing, and carries zero cost on the `analyze()`
 * path -- only a consumer that asks pays. Backward-compatible by construction:
 * the additive report fields (`validatedPeaks`, `allFitted`, `unfittable`) are
 * treated as empty when absent, never assumed present.
 *
 * `peakCount` alignment (single source of truth): the batch card today renders
 * `ManagedSource.fittedPeaks.length`, and `fittedPeaks` is
 * `validPeaks(report.validatedPeaks ?? validate(report.peaks))` -- the VALID
 * validated peaks, not `report.peaks.length`. So that the Phase-2 card swap is
 * behavior-preserving, `peakCount` follows the card's semantics: the number of
 * `validatedPeaks` entries with `valid === true`. A legacy report that predates
 * the additive `validatedPeaks` field falls back to `report.peaks.length` (this
 * module imports domain types only -- re-running the validate gate here would
 * both create a pipeline import and violate the no-recompute rule). On such a
 * legacy report the fallback also makes the all-invalidated anomaly clause a
 * no-op (`peakCount === report.peaks.length`), so legacy behavior is unchanged.
 */
import type { AnalysisReport, StageName } from '../domain/types';

/** The four-state peak-detection status of one analyzed spectrum. */
export type SignalState = 'healthy' | 'anomaly' | 'empty' | 'failure';

/** Read-only status projection for one analyzed spectrum. Single source of
 *  truth for cards, selector, and inspector (Principle 9). */
export interface SpectrumStatus {
  readonly state: SignalState;
  /** Valid validated peaks -- the canonical card "peak count" (see module note). */
  readonly peakCount: number;
  /** Detection survivors that produced no usable fit (`report.unfittable`). */
  readonly unfittableCount: number;
  /** Fits rejected by the peak-hop / edge guard (`allFitted`, status `'rejected'`). */
  readonly rejectedFitCount: number;
  /** The stage that errored -- set iff `state === 'failure'`, else null. */
  readonly failingStage: StageName | null;
  /** Short, human-readable card label, e.g. "12 peaks", "3 unfittable",
   *  "0 valid peaks", "0 peaks", "detection failed". Derived here, never
   *  recomputed downstream. */
  readonly label: string;
}

/** The peak-evidence stages: an `'error'` in one of these is a peak-detection
 * failure. Errors in downstream stages (`calibrate` / `identify` / `quantify`)
 * are past the evidence the inspector shows, and a `load` error normally yields
 * no report at all ({@link isInspectable} handles that). */
type PeakStage = Extract<StageName, 'condition' | 'detect' | 'fit' | 'validate'>;

const FAILURE_LABEL: Readonly<Record<PeakStage, string>> = {
  condition: 'Conditioning failed',
  detect: 'Detection failed',
  fit: 'Fit failed',
  validate: 'Validation failed',
};

function isPeakStage(stage: StageName): stage is PeakStage {
  return stage === 'condition' || stage === 'detect' || stage === 'fit' || stage === 'validate';
}

/** True iff the spectrum has inspection evidence -- i.e. analysis has run.
 *  A report always carries raw counts + a stage trace, so any report is
 *  inspectable (even a failed one: "here is where it failed"). No report
 *  (not yet analyzed) is not inspectable. Drives Phase-5 entry availability. */
export function isInspectable(
  report: AnalysisReport | null | undefined,
): report is AnalysisReport {
  return report != null;
}

/** Pure projection: classify one analyzed spectrum. Precondition: `report != null`
 *  (call {@link isInspectable} first). No mutation, no new numeric computation;
 *  safe to call repeatedly with identical output. */
export function deriveSpectrumStatus(report: AnalysisReport): SpectrumStatus {
  // Card-aligned count: valid validated peaks; legacy fallback = kept fits.
  const peakCount = report.validatedPeaks
    ? report.validatedPeaks.reduce((n, v) => n + (v.valid ? 1 : 0), 0)
    : report.peaks.length;
  const keptFits = report.peaks.length;
  const survivors = report.detectedCandidates.length;
  const unfittableCount = report.unfittable?.length ?? 0;
  const rejectedFitCount = (report.allFitted ?? []).reduce(
    (n, f) => n + (f.status === 'rejected' ? 1 : 0),
    0,
  );
  const counts = { peakCount, unfittableCount, rejectedFitCount } as const;

  // 1. failure -- the first errored peak-evidence stage, in pipeline order.
  const errored = report.trace.find((t) => t.status === 'error' && isPeakStage(t.stage));
  if (errored && isPeakStage(errored.stage)) {
    return {
      state: 'failure',
      ...counts,
      failingStage: errored.stage,
      label: FAILURE_LABEL[errored.stage],
    };
  }

  // 2. empty -- genuinely nothing to work with: no survivors AND no kept fits.
  if (survivors === 0 && keptFits === 0) {
    return { state: 'empty', ...counts, failingStage: null, label: '0 peaks' };
  }

  // 3. anomaly -- peaks/candidates found or produced that did not become valid
  // results: unfittable survivors, guard-rejected fits, or kept fits that all
  // failed the validate gate. This is also where "survivors found, all
  // discarded" lands: there is something to explain, so it is NOT empty. May
  // coexist with peakCount > 0 -- anomaly still wins.
  if (unfittableCount > 0 || rejectedFitCount > 0 || (keptFits > 0 && peakCount === 0)) {
    const label =
      unfittableCount > 0
        ? `${unfittableCount} unfittable`
        : rejectedFitCount > 0
          ? `${rejectedFitCount} rejected`
          : '0 valid peaks';
    return { state: 'anomaly', ...counts, failingStage: null, label };
  }

  // 4. healthy -- valid peaks, nothing demanding attention.
  if (peakCount > 0) {
    return { state: 'healthy', ...counts, failingStage: null, label: `${peakCount} peaks` };
  }

  // 5. Defensive: provably unreachable given rules 1-4 and the survivor
  // partition (reaching here needs survivors > 0 with keptFits === 0 and no
  // unfittable/rejected fits -- a partition violation), but never misreport.
  return { state: 'empty', ...counts, failingStage: null, label: '0 peaks' };
}
