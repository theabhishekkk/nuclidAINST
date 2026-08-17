/**
 * Deterministic synthetic spectrum generator -- for the in-app demo and tests.
 *
 * Clearly labeled as synthetic: it is NOT real data and must never stand in for a
 * measured source. It produces a one-value-per-line (TKA) string so it flows
 * through the exact same fail-loud parser as a real file.
 */

export interface SyntheticPeakSpec {
  readonly channel: number;
  /** Peak counts at the centre, above the continuum. */
  readonly amplitude: number;
  readonly fwhmChannels: number;
}

export interface SyntheticOptions {
  readonly channels?: number;
  readonly liveTimeSec?: number;
  readonly realTimeSec?: number;
  /** Continuum level near channel 0. */
  readonly background?: number;
  readonly peaks?: readonly SyntheticPeakSpec[];
}

const DEFAULT_PEAKS: readonly SyntheticPeakSpec[] = [
  { channel: 300, amplitude: 1400, fwhmChannels: 16 },
  { channel: 820, amplitude: 760, fwhmChannels: 24 },
];

const FWHM_TO_SIGMA = 1 / 2.354820045;

export function syntheticSpectrum(options: SyntheticOptions = {}): number[] {
  const channels = options.channels ?? 1024;
  const background = options.background ?? 80;
  const peaks = options.peaks ?? DEFAULT_PEAKS;
  const counts = new Array<number>(channels);
  for (let ch = 0; ch < channels; ch++) {
    let y = background * Math.exp(-ch / (channels * 1.5)) + 8;
    for (const p of peaks) {
      const sigma = p.fwhmChannels * FWHM_TO_SIGMA;
      const d = ch - p.channel;
      y += p.amplitude * Math.exp(-(d * d) / (2 * sigma * sigma));
    }
    // Mild deterministic ripple so it is not perfectly smooth.
    y += 3 * (1 + Math.sin(ch * 0.07));
    counts[ch] = Math.max(0, Math.round(y));
  }
  return counts;
}

export function syntheticTka(options: SyntheticOptions = {}): string {
  const live = options.liveTimeSec ?? 1800;
  const real = options.realTimeSec ?? 1873;
  return [live, real, ...syntheticSpectrum(options)].join('\n');
}
