/**
 * peakFinderDistanceStats -- data-led derivations behind the "Distance Gate" (`distance` /
 * run-1) educational stage, the FIRST filtering stage of the Detect-Peaks group.
 *
 * Sibling of {@link module:peakFinderDetectStats} (the run-0 "Find Local Maxima" recipe) and
 * {@link module:peakFinderValidationStats}. Same discipline (Principle 9): plain-data in, no
 * manager, no report, no engine call. Every figure is a count / ratio, or the RECONSTRUCTED
 * winner of a distance rejection -- nothing re-runs detection, so the committed reference-parity
 * fixtures stay byte-identical. `app.ts` calls this and only RENDERS the returned structures.
 *
 * WINNER RECONSTRUCTION (the one non-trivial derivation) is EXACT for real spectra. scipy's
 * `_select_by_peak_distance` (our `selectByPeakDistance`) iterates candidates TALLEST first;
 * each still-kept peak removes every not-yet-removed peak within `ceil(distance)` samples, and
 * ONLY kept peaks remove others. Therefore every distance-rejected candidate `k` was removed by
 * the FIRST kept peak, in descending-height order, whose +/-ceil(distance) window covers k --
 * which is exactly the TALLEST distance-gate survivor within `ceil(distance)` channels of k:
 *
 *     winner(k) = argmax_height { c in notDistance : |c.channel - k.channel| < ceil(distance) }
 *
 * where `notDistance` is the distance-gate survivor set (candidates NOT rejected by the distance
 * gate -- they may still fail a LATER gate) and priority is the detection-series `height` the
 * engine's distance gate itself ranked by (`selectByPeakDistance(maxima, heights, ...)`, with
 * `height = smoothed[channel]`). The window test is STRICT `< ceil(distance)` (scipy
 * `peaks[j] - peaks[k] < distance_`). Every distance-rejected candidate is guaranteed >= 1 such
 * winner (it was removed by one).
 *
 * Honesty caveat: exact where survivor heights are distinct (the engine documents that priority
 * ties "do not occur for the real spectra here"). If two in-window survivors ever tie on height,
 * this reconstruction picks the ASCENDING-channel one; the engine's `argsort` tie-break could
 * differ. Acceptable and documented -- the same class of bounded divergence noted in
 * `findPeaks.ts`, and guarded by the parity unit test.
 *
 * CHANNEL SPACE ONLY: no energy / keV field is ever read or displayed (Peak Finder is a
 * channel-space workflow; energies belong to Calibrate).
 */

/** One candidate reduced to the fields this stage reads off a {@link DetectedPeak}: its channel,
 * its detection-series `height` (what the distance gate ranked by), whether it passed all gates,
 * and whether the DISTANCE gate specifically struck it out. */
export interface DistanceCandidate {
  readonly channel: number;
  readonly height: number;
  /** `DetectedPeak.passed` -- survived every gate (distance + later). */
  readonly passed: boolean;
  /** Struck out by the distance gate specifically (`!passed && rejectReason === 'distance'`). */
  readonly rejectedByDistance: boolean;
}

/** Plain-data input for {@link deriveDistanceGateStats}. */
export interface DistanceGateStatsInput {
  /** `counts.length` -- the number of channels detection scanned (display only). */
  readonly channels: number;
  /** Every strict local maximum entering the distance gate (`trace.detected.all`), reduced to
   * {@link DistanceCandidate}. Order is not assumed; the derivation sorts where it needs to. */
  readonly candidates: readonly DistanceCandidate[];
  /** The minimum-separation constant this run used (`trace.constants.distance`). The enforced
   * window is `ceil(minDistance)` (scipy `distance_`). */
  readonly minDistance: number;
  /** The detection series label ("Net Spectrum" / "Savitzky-Golay Smoothed Net"), resolved by
   * the caller from the earlier SG/net choice. Shown verbatim. */
  readonly detectionSpectrumLabel: string;
}

/** One label/value pair for a `.cfg-recap` stat card (value pre-formatted for display). */
export interface DistanceStatPair {
  readonly label: string;
  readonly value: string;
}

/** Per-rejected-candidate comparison feeding the Candidate Comparison (§7) + Why Rejected? (§8)
 * cards and the table's Distance-to-Winner column. Keyed by the rejected candidate's channel. */
export interface RejectionComparison {
  readonly rejectedChannel: number;
  readonly rejectedHeight: number;
  readonly winnerChannel: number;
  readonly winnerHeight: number;
  /** `|rejected - winner|`, in channels -- always `< minAllowed` for a real distance rejection. */
  readonly separation: number;
  /** `ceil(minDistance)` -- the enforced minimum separation. */
  readonly minAllowed: number;
}

/** The before/after count figures for the §3 count bars (raw numbers, not formatted). */
export interface DistanceBeforeAfter {
  readonly entering: number;
  readonly leaving: number;
  readonly removed: number;
  /** `removed / entering * 100` (0 when `entering === 0`). */
  readonly reductionPct: number;
}

/** Everything the redesigned "Distance Gate" stage's cards + comparisons need, derived PURELY
 * from {@link DistanceGateStatsInput}. */
export interface DistanceGateStats {
  /** §1 Distance Gate Summary card. */
  readonly summary: readonly DistanceStatPair[];
  /** §2 Filter Impact card (Entering / Passing / Removed / Reduction). */
  readonly impact: readonly DistanceStatPair[];
  /** §3 Before-vs-After count bars (raw figures). */
  readonly beforeAfter: DistanceBeforeAfter;
  /** §9 Detection Statistics card (Accepted / Rejected / Accept % / Reject %). */
  readonly statistics: readonly DistanceStatPair[];
  /** §11 Processing Integrity recap. */
  readonly integrity: readonly DistanceStatPair[];
  /** §7/§8 lookup -- one entry per distance-rejected candidate, in channel order. */
  readonly comparisons: readonly RejectionComparison[];
}

/** Placeholder for a statistic that has no value. */
const NA = '—';

// --- display formatting (mirrors peakFinderDetectStats: en-US, locale-stable) --------------
/** Round to a whole count and group thousands (`en-US` pinned so the unit tests are stable). */
function fmtInt(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** Detection-series height, same rounding + grouping as a count. */
function fmtCount(v: number): string {
  return Math.round(v).toLocaleString('en-US');
}
/** A percentage to 1 dp, or the em-dash placeholder when it is not finite (guarded div-by-zero). */
function fmtPct(v: number): string {
  return Number.isFinite(v) ? `${v.toFixed(1)}%` : NA;
}

/**
 * Reconstruct the distance-gate winner that beat `rejected`: the TALLEST distance-gate survivor
 * whose channel is strictly within `minAllowed` (= ceil(distance)) of the rejected candidate.
 * Ties on height break to the ASCENDING-channel survivor (documented honesty caveat). Returns
 * `null` only when there is no in-window survivor (never happens for a genuine distance
 * rejection -- the caller guards, and the parity test proves existence on the real fixture).
 */
function findWinner(
  rejected: DistanceCandidate,
  survivors: readonly DistanceCandidate[],
  minAllowed: number,
): DistanceCandidate | null {
  let best: DistanceCandidate | null = null;
  for (const c of survivors) {
    if (Math.abs(c.channel - rejected.channel) >= minAllowed) continue;
    if (
      best === null ||
      c.height > best.height ||
      (c.height === best.height && c.channel < best.channel)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Pure derivation for the "Distance Gate" (`distance` / run-1) educational stage. Every returned
 * figure is a display transform of the passed-in candidate list + constant -- no engine call, no
 * fixture touch (Principle 9). See {@link DistanceGateStats} and the winner-reconstruction proof
 * in the module header.
 */
export function deriveDistanceGateStats(input: DistanceGateStatsInput): DistanceGateStats {
  const { channels, candidates, minDistance, detectionSpectrumLabel } = input;
  const minAllowed = Math.max(1, Math.ceil(minDistance));

  // The distance-gate survivor set (== gateSets().notDistance): candidates NOT struck by the
  // distance gate -- they may still fail a LATER gate, but they cleared distance.
  const survivors = candidates.filter((c) => !c.rejectedByDistance);
  const rejected = candidates
    .filter((c) => c.rejectedByDistance)
    .sort((a, b) => a.channel - b.channel);

  const entering = candidates.length;
  const leaving = survivors.length;
  const removed = rejected.length;
  const reductionPct = entering > 0 ? (removed / entering) * 100 : 0;
  const acceptPct = entering > 0 ? (leaving / entering) * 100 : NaN;
  const rejectPct = entering > 0 ? (removed / entering) * 100 : NaN;

  const summary: DistanceStatPair[] = [
    { label: 'Detection Spectrum', value: detectionSpectrumLabel },
    { label: 'Minimum Separation', value: `${fmtInt(minAllowed)} channels` },
    { label: 'Candidates Entering', value: fmtInt(entering) },
    { label: 'Status', value: 'Completed' },
  ];

  const impact: DistanceStatPair[] = [
    { label: 'Entering', value: fmtInt(entering) },
    { label: 'Passing Gate', value: fmtInt(leaving) },
    { label: 'Removed (Too Close)', value: fmtInt(removed) },
    { label: 'Reduction', value: entering > 0 ? fmtPct(reductionPct) : NA },
  ];

  const statistics: DistanceStatPair[] = [
    { label: 'Accepted', value: fmtInt(leaving) },
    { label: 'Rejected', value: fmtInt(removed) },
    { label: 'Accept Rate', value: fmtPct(acceptPct) },
    { label: 'Reject Rate', value: fmtPct(rejectPct) },
  ];

  const integrity: DistanceStatPair[] = [
    { label: 'Detection Spectrum', value: detectionSpectrumLabel },
    { label: 'Gate Applied', value: 'Minimum separation' },
    { label: 'Channels Scanned', value: channels > 0 ? fmtInt(channels) : NA },
    { label: 'Status', value: 'Completed' },
  ];

  // One comparison per distance-rejected candidate (channel order). The winner is guaranteed to
  // exist for a real rejection; the `?? rejected` fallbacks below are pure defence so a malformed
  // input can never throw (yields a self-referential comparison with separation 0).
  const comparisons: RejectionComparison[] = rejected.map((r) => {
    const w = findWinner(r, survivors, minAllowed);
    return {
      rejectedChannel: r.channel,
      rejectedHeight: r.height,
      winnerChannel: w ? w.channel : r.channel,
      winnerHeight: w ? w.height : r.height,
      separation: w ? Math.abs(w.channel - r.channel) : 0,
      minAllowed,
    };
  });

  return {
    summary,
    impact,
    beforeAfter: { entering, leaving, removed, reductionPct },
    statistics,
    integrity,
    comparisons,
  };
}

/**
 * Resolve the rejection comparison the §7/§8 cards describe from the shared integer-channel
 * selection. When `selectedChannel` is a distance-rejected candidate, its comparison is returned;
 * otherwise (nothing selected, or a survivor selected) the FIRST rejected candidate in channel
 * order is returned so the cards are populated on arrival. Returns `null` only when there is
 * genuinely nothing rejected by the distance gate (empty-state shape).
 */
export function resolveRejectionComparison(
  stats: DistanceGateStats,
  selectedChannel: number | null,
): RejectionComparison | null {
  if (stats.comparisons.length === 0) return null;
  if (selectedChannel != null) {
    const hit = stats.comparisons.find((c) => c.rejectedChannel === selectedChannel);
    if (hit) return hit;
  }
  return stats.comparisons[0];
}

/** Pre-format a winner/candidate height for the §8 prose + the table's Distance-to-Winner
 * context. Kept here so all Distance-Gate formatting stays locale-stable in one place. */
export function fmtDistanceHeight(v: number): string {
  return fmtCount(v);
}
