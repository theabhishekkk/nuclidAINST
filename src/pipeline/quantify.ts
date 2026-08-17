/** Stage 8 -- Quantify: activity A = N_net / (eff * p_gamma * t_live). */
import type { ActivityEstimate, FittedPeak, NuclideEntry } from '../domain/types';
import { NotImplementedError } from '../domain/errors';

/**
 * Planned: real activity once a measured efficiency curve exists. Until then this
 * refuses rather than emit a demo number (DEBT-02 -- the assumed-efficiency debt).
 */
export function quantify(
  _peak: FittedPeak,
  _nuclide: NuclideEntry,
  _efficiency: number,
  _liveTimeSec: number,
): ActivityEstimate {
  throw new NotImplementedError('quantify', 'needs a real efficiency curve (DEBT-02 / GATE-C)');
}
