/**
 * identifyStages -- the seven Identify-mode walkthrough stages, a faithful port of
 * `reference/python/identify_mode.py`'s `_r_*` / `_e_*` stage pairs (engine
 * `gamma_identify.py`).
 *
 * Each stage is a pure, DISPLAY-ONLY view of an already-computed
 * {@link IdentificationResult} (+ the {@link EnergisedPeak}[] it consumed and the
 * raw counts). Nothing here runs analysis: it never calls `identify()` /
 * `applyCalibration()`. Advancing a stage narrates the finished identification --
 * the reference's "run once, view seven ways" model (mirrors the Calibrate trio's
 * `calibrateStages.ts`, the reference interaction model for this product family).
 *
 * Palette discipline (DESIGN.md S1 one-accent): the Python reference colours peaks
 * per-isotope; Nuclid does NOT (that would break the one-accent rule, exactly as
 * `calibrateStages.ts` documents). Colour carries MEANING only: teal (`--accent`) =
 * matched/identified, amber (`--warn-text`) = unmatched, grey (`--faint`) =
 * detector-artifact / inert. Isotopes are told apart by label, never by hue.
 * (Divergence from the Python reference's per-isotope colours -- the established
 * Nuclid rule, same as Calibrate.)
 */
import type {
  Calibration,
  EnergisedPeak,
  IdentificationResult,
  IdentificationSummary,
} from '../domain/types';
import { applyCalibrationToChannel } from '../pipeline/calibrate';
import { STAGE_COLORS as C, type StageDef, type StagePoint, type StageRenderCtx } from './stageView';
import { equationString } from './calibrateStages';

/** FWHM = k.sigma for a Gaussian (recover sigma from a fitted FWHM in channels). */
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

/** The seven stage labels (static; used to populate the rail before a run). The
 * stepper derives its Run sub-steps from this array. */
export const IDENTIFY_STAGE_LABELS: readonly string[] = [
  '1. Spectrum & calibration',
  '2. Find photopeaks',
  '3. Refine centroids (χ²)',
  '4. Channel → energy',
  '5. Match to library',
  '6. Detector artifacts',
  '7. Identify',
];

/** Everything the seven stages read -- all already computed by the engine. */
export interface IdentifyStagesInput {
  /** The finished identification (ranked isotopes + per-peak artifact flags). */
  readonly result: IdentificationResult;
  /** The I3 summary (verdict + caveats), for the Stage 7 conclusion sentence. */
  readonly summary: IdentificationSummary;
  /** The energised peaks I2 scored (channel + energy + fwhm, by object identity). */
  readonly energised: readonly EnergisedPeak[];
  /** The unknown's raw spectrum counts (channel space). */
  readonly counts: readonly number[];
  /** The applied calibration (energy axis + equation string). */
  readonly cal: Calibration;
  /** The applied calibration's display name (provenance). */
  readonly calName: string;
  /** Which ranked isotope the Stage 5/7 highlight follows (null = top-ranked). */
  readonly overlayId: string | null;
}

/** Placeholder stages (labels only) for the not-ready state -- render/explain are
 * never invoked while `ready` is false, so they are inert (mirrors
 * `calibrateStages.placeholderStages`). */
export function placeholderStages(): StageDef[] {
  return IDENTIFY_STAGE_LABELS.map((label) => ({
    label,
    render: () => {},
    explain: () => ({ text: '' }),
  }));
}

// --- small display helpers --------------------------------------------------

/** The energy axis: cal(ch) for every channel index (display-only, never refits). */
function energyAxis(input: IdentifyStagesInput): number[] {
  const axis: number[] = new Array(input.counts.length);
  for (let ch = 0; ch < input.counts.length; ch++) {
    axis[ch] = applyCalibrationToChannel(input.cal, ch);
  }
  return axis;
}

/** Count at a (sub-channel) centroid, clamped to the spectrum bounds. */
function countAtChannel(counts: readonly number[], channel: number): number {
  const ci = Math.min(Math.max(Math.round(channel), 0), counts.length - 1);
  return counts[ci] ?? 0;
}

function maxCount(counts: readonly number[]): number {
  let m = 0;
  for (const v of counts) if (v > m) m = v;
  return m > 0 ? m : 1;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The set of measured peaks matched (by object identity) to ANY ranked isotope --
 * I2 threads the same {@link EnergisedPeak} objects through `matchedLines`. */
function matchedPeakSet(result: IdentificationResult): Set<EnergisedPeak> {
  const set = new Set<EnergisedPeak>();
  for (const iso of result.ranked) for (const m of iso.matchedLines) set.add(m.measured);
  return set;
}

/** The measured peaks matched to ONE chosen isotope (the Stage 7 highlight). */
function peaksMatchedToIsotope(result: IdentificationResult, isotopeId: string): Set<EnergisedPeak> {
  const set = new Set<EnergisedPeak>();
  const iso = result.ranked.find((m) => m.nuclide.id === isotopeId);
  if (iso) for (const m of iso.matchedLines) set.add(m.measured);
  return set;
}

/** Measured peaks carrying any detector-artifact flag (511/escape). */
function artifactPeakSet(result: IdentificationResult): Set<EnergisedPeak> {
  const set = new Set<EnergisedPeak>();
  for (const pf of result.peakFlags) if (pf.flags.length) set.add(pf.peak);
  return set;
}

/** The chosen highlight isotope id: the overlay selection, else the top-ranked. */
function highlightId(input: IdentifyStagesInput): string | null {
  return input.overlayId ?? input.result.ranked[0]?.nuclide.id ?? null;
}

/** The strongest measured peak by net area (the Stage-3 demo peak). */
function strongestPeak(energised: readonly EnergisedPeak[]): EnergisedPeak | null {
  let best: EnergisedPeak | null = null;
  let bestArea = -Infinity;
  for (const p of energised) {
    if (p.peak.netArea > bestArea) {
      bestArea = p.peak.netArea;
      best = p;
    }
  }
  return best;
}

/** Peaks in measured-energy order (the reference matches against energy-sorted
 * peaks; ordering the display the same way keeps labels left-to-right). */
function byEnergy(energised: readonly EnergisedPeak[]): EnergisedPeak[] {
  return [...energised].sort((a, b) => a.energyKeV - b.energyKeV);
}

function centeredNote(ctx: StageRenderCtx, message: string): void {
  ctx.plot.frame({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
  ctx.plot.label(0.5, 0.5, message, { align: 'center', color: C.title });
}

/** The reference `_peak_table`: # / ch / FWHM_keV / area / chi2, one row per peak. */
function peakTable(energised: readonly EnergisedPeak[]): string {
  if (!energised.length) return '(no peaks)';
  const rows = byEnergy(energised).map((p, i) => {
    const ch = p.peak.centroidChannel.toFixed(1);
    const fwhm = p.fwhmKeV.toFixed(1);
    const area = Math.round(p.peak.netArea).toString();
    const chi =
      p.peak.chiSquare != null && Number.isFinite(p.peak.chiSquare)
        ? p.peak.chiSquare.toFixed(2)
        : '-';
    return `${i + 1}. ch ${ch} · FWHM ${fwhm} keV · area ${area} · χ² ${chi}`;
  });
  return rows.join('\n');
}

// --- the seven stages -------------------------------------------------------

/** Build the seven Identify stages over the finished result. */
export function buildIdentifyStages(input: IdentifyStagesInput): StageDef[] {
  return [
    stageSpectrum(input),
    stageFind(input),
    stageRefine(input),
    stageEnergy(input),
    stageMatch(input),
    stageArtifacts(input),
    stageIdentify(input),
  ];
}

/** Draw the full unknown spectrum on the calibrated energy axis (shared by the
 * energy-space stages 1/4/5/6/7). Returns the energy axis for marker placement. */
function drawEnergySpectrum(
  ctx: StageRenderCtx,
  input: IdentifyStagesInput,
  title: string,
): number[] {
  const axis = energyAxis(input);
  const yMax = maxCount(input.counts) * 1.08;
  ctx.plot.frame({
    xMin: axis[0],
    xMax: axis[axis.length - 1],
    yMin: 0,
    yMax,
    xLabel: 'Energy (keV)',
    yLabel: 'Counts',
    title,
  });
  const pts: StagePoint[] = axis.map((x, i) => ({ x, y: input.counts[i] }));
  ctx.plot.line(pts, { color: C.text, width: 0.7 });
  return axis;
}

// Stage 1 -- the unknown on the calibrated energy axis. -----------------------
function stageSpectrum(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[0],
    render(ctx) {
      drawEnergySpectrum(ctx, input, 'Stage 1 - unknown spectrum on the calibrated energy axis');
    },
    explain() {
      const total = input.counts.reduce((s, v) => s + v, 0);
      return {
        text:
          `Unknown spectrum: ${input.counts.length} channels, ${Math.round(total).toLocaleString()} ` +
          `total counts. Calibration in use: "${input.calName}" -- ${equationString(input.cal)}. ` +
          'This equation maps every channel to an energy; the rest of the workflow finds peaks, ' +
          'measures them, and matches their energies to the library.',
      };
    },
  };
}

// Stage 2 -- photopeaks found, in CHANNEL space. ------------------------------
function stageFind(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[1],
    render(ctx) {
      const counts = input.counts;
      const yMax = maxCount(counts) * 1.08;
      ctx.plot.frame({
        xMin: 0,
        xMax: Math.max(1, counts.length - 1),
        yMin: 0,
        yMax,
        xLabel: 'Channel',
        yLabel: 'Counts',
        title: 'Stage 2 - photopeaks found (in channel space)',
      });
      ctx.plot.line(
        counts.map((y, ch) => ({ x: ch, y })),
        { color: C.text, width: 0.7 },
      );
      for (const p of byEnergy(input.energised)) {
        const ch = p.peak.centroidChannel;
        const y = countAtChannel(counts, ch);
        ctx.plot.vline(ch, { color: C.accent, width: 1, yBottom: 0, yTop: y });
        ctx.plot.points([{ x: ch, y }], { color: C.accent, radius: 3 });
      }
    },
    explain() {
      const chans =
        byEnergy(input.energised)
          .map((p) => p.peak.centroidChannel.toFixed(0))
          .join(', ') || '(none)';
      return {
        text:
          'The peak engine (SNIP continuum subtraction -> light smoothing -> find_peaks) locates ' +
          'the real photopeaks and drops broad continuum bumps.\n\n' +
          `${input.energised.length} photopeak(s) at channel(s): ${chans}.`,
      };
    },
  };
}

// Stage 3 -- Gaussian + linear-background centroid (reconstructed for display).
function stageRefine(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[2],
    render(ctx) {
      const p = strongestPeak(input.energised);
      if (!p) return centeredNote(ctx, 'no peaks');
      const counts = input.counts;
      const centre = p.peak.centroidChannel;
      const sigma = Math.max(p.peak.fwhmChannels / FWHM_PER_SIGMA, 1);
      const W = Math.max(4 * sigma, 16);
      const lo = Math.max(Math.floor(centre - W), 0);
      const hi = Math.min(Math.ceil(centre + W), counts.length - 1);
      const xs: number[] = [];
      for (let ch = lo; ch <= hi; ch++) xs.push(ch);
      const bl = median(counts.slice(lo, lo + 3));
      const br = median(counts.slice(Math.max(hi - 2, lo), hi + 1));
      const bg = (ch: number): number => bl + ((br - bl) * (ch - lo)) / Math.max(hi - lo, 1);
      const amp = Math.max(countAtChannel(counts, centre) - bg(centre), 1);
      const model = (ch: number): number =>
        amp * Math.exp(-0.5 * ((ch - centre) / sigma) ** 2) + bg(ch);

      let yMax = 0;
      for (const ch of xs) yMax = Math.max(yMax, counts[ch], model(ch));
      const chi =
        p.peak.chiSquare != null && Number.isFinite(p.peak.chiSquare)
          ? p.peak.chiSquare.toFixed(2)
          : '-';
      ctx.plot.frame({
        xMin: lo,
        xMax: hi,
        yMin: 0,
        yMax: yMax * 1.08 || 1,
        xLabel: 'Channel',
        yLabel: 'Counts',
        title: `Stage 3 - centroid ch ${centre.toFixed(1)}, FWHM ${p.fwhmKeV.toFixed(1)} keV, χ² ${chi}`,
      });
      ctx.plot.line(
        xs.map((ch) => ({ x: ch, y: counts[ch] })),
        { color: C.text, width: 0.9 },
      );
      ctx.plot.line(
        xs.map((ch) => ({ x: ch, y: bg(ch) })),
        { color: C.faint, width: 1, dash: [3, 3] },
      );
      ctx.plot.line(
        xs.map((ch) => ({ x: ch, y: model(ch) })),
        { color: C.accent, width: 1.8 },
      );
      ctx.plot.vline(centre, { color: C.accent, width: 1.2, dash: [4, 3] });
    },
    explain() {
      return {
        text:
          'Each photopeak is fit with a Gaussian + linear background. That gives a sub-channel ' +
          'centroid, the FWHM, the net area, and a reduced chi-square (χ² ~ 1 = a clean Gaussian ' +
          'peak; >> 1 = blended / skewed / poor fit). The curve shown is reconstructed from the ' +
          "engine's fitted width/area for the strongest peak.\n\nPeak characteristics:\n" +
          peakTable(input.energised),
      };
    },
  };
}

// Stage 4 -- each centroid mapped to energy via the calibration. --------------
function stageEnergy(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[3],
    render(ctx) {
      drawEnergySpectrum(ctx, input, 'Stage 4 - each centroid mapped to energy via the calibration');
      for (const p of byEnergy(input.energised)) {
        const y = countAtChannel(input.counts, p.peak.centroidChannel);
        ctx.plot.points([{ x: p.energyKeV, y }], { color: C.accent, radius: 3 });
        ctx.plot.label(p.energyKeV, y, p.energyKeV.toFixed(0), {
          align: 'center',
          dy: -8,
          color: C.accent,
        });
      }
    },
    explain() {
      const es =
        byEnergy(input.energised)
          .map((p) => p.energyKeV.toFixed(1))
          .join(', ') || '(none)';
      return {
        text:
          `Applying ${equationString(input.cal)} turns each centroid channel into an energy:\n\n` +
          `  ${es} keV.\n\nThese measured energies are what we compare against the known library ` +
          'lines next.',
      };
    },
  };
}

// Stage 5 -- peaks coloured by match state against the library. ----------------
function stageMatch(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[4],
    render(ctx) {
      drawEnergySpectrum(
        ctx,
        input,
        'Stage 5 - peaks matched to library lines (teal = matched, amber = unmatched)',
      );
      const matched = matchedPeakSet(input.result);
      const artifacts = artifactPeakSet(input.result);
      for (const p of byEnergy(input.energised)) {
        const y = countAtChannel(input.counts, p.peak.centroidChannel);
        // Colour carries MEANING (one-accent): grey = artifact, teal = matched,
        // amber = unmatched. Never per-isotope hues (DESIGN.md S1).
        const col = artifacts.has(p) ? C.faint : matched.has(p) ? C.accent : C.warn;
        ctx.plot.points([{ x: p.energyKeV, y }], { color: col, radius: 3 });
        const labels = libraryLabelsFor(input.result, p);
        ctx.plot.label(p.energyKeV, y, labels || p.energyKeV.toFixed(0), {
          align: 'center',
          dy: -8,
          color: col,
        });
      }
    },
    explain() {
      const matched = matchedPeakSet(input.result);
      const artifacts = artifactPeakSet(input.result);
      const matchedStr =
        byEnergy(input.energised)
          .filter((p) => matched.has(p))
          .map((p) => `${p.energyKeV.toFixed(1)}->${libraryLabelsFor(input.result, p)}`)
          .join('; ') || 'none';
      const unmatchedStr =
        byEnergy(input.energised)
          .filter((p) => !matched.has(p) && !artifacts.has(p))
          .map((p) => p.energyKeV.toFixed(1))
          .join(', ') || 'none';
      return {
        text:
          'Each measured energy is matched to known library lines within an adaptive tolerance ' +
          '(a few keV, widened by a fraction of the FWHM).\n\n' +
          `Matched: ${matchedStr}\nUnmatched: ${unmatchedStr === 'none' ? 'none' : `${unmatchedStr} keV`}\n\n` +
          'A single match is only a clue -- the verdict needs the whole fingerprint (Stage 7).',
      };
    },
  };
}

/** The library line labels a measured peak matched to, e.g. "Cs-137" (joined). */
function libraryLabelsFor(result: IdentificationResult, peak: EnergisedPeak): string {
  const ids: string[] = [];
  for (const iso of result.ranked) {
    if (iso.matchedLines.some((m) => m.measured === peak) && !ids.includes(iso.nuclide.id)) {
      ids.push(iso.nuclide.id);
    }
  }
  return ids.join(', ');
}

// Stage 6 -- detector artifacts (511 / escape) flagged. -----------------------
function stageArtifacts(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[5],
    render(ctx) {
      const flagged = input.result.peakFlags.filter((pf) => pf.flags.length);
      const any = flagged.length > 0;
      drawEnergySpectrum(
        ctx,
        input,
        `Stage 6 - detector artifacts flagged${any ? '' : ' (none on this spectrum)'}`,
      );
      for (const pf of flagged) {
        const p = pf.peak;
        const y = countAtChannel(input.counts, p.peak.centroidChannel);
        ctx.plot.points([{ x: p.energyKeV, y }], { color: C.faint, radius: 4 });
        ctx.plot.label(p.energyKeV, y, pf.flags[0], { align: 'center', dy: -9, color: C.faint });
      }
    },
    explain() {
      const flagged = input.result.peakFlags.filter((pf) => pf.flags.length);
      const list = flagged.length
        ? flagged
            .map((pf) => `${pf.peak.energyKeV.toFixed(1)} keV: ${pf.flags.join(', ')}`)
            .join('\n  ')
        : 'none.';
      return {
        text:
          'Not every peak is a source line. The 511 keV annihilation peak and single/double escape ' +
          'peaks (E-511, E-1022 below a strong high-energy line) are detector artifacts and must ' +
          'not be matched as gamma lines. They are flagged (not removed -- parity with the engine, ' +
          'which scores them as-is).\n\nFlagged here:\n  ' + list,
      };
    },
  };
}

// Stage 7 -- the identification: the chosen isotope's peaks highlighted. -------
function stageIdentify(input: IdentifyStagesInput): StageDef {
  return {
    label: IDENTIFY_STAGE_LABELS[6],
    render(ctx) {
      const top = input.result.ranked[0] ?? null;
      const title = top
        ? `Stage 7 - identification -> ${top.nuclide.displayName}`
        : 'Stage 7 - no match';
      drawEnergySpectrum(ctx, input, title);
      const chosenId = highlightId(input);
      const highlight = chosenId
        ? peaksMatchedToIsotope(input.result, chosenId)
        : new Set<EnergisedPeak>();
      for (const p of byEnergy(input.energised)) {
        const y = countAtChannel(input.counts, p.peak.centroidChannel);
        const on = highlight.has(p);
        ctx.plot.points([{ x: p.energyKeV, y }], {
          color: on ? C.accent : C.faint,
          radius: on ? 4 : 2.5,
        });
        if (on) {
          ctx.plot.label(p.energyKeV, y, libraryLabelsFor(input.result, p), {
            align: 'center',
            dy: -9,
            color: C.accent,
          });
        }
      }
    },
    explain() {
      const ranked = input.result.ranked;
      if (!ranked.length) {
        return {
          text:
            'No isotope matched. Check the calibration and tolerance, or load an unknown the ' +
            'library covers.',
          caveat: 'No confident identification for this spectrum.',
        };
      }
      const lines = ['Isotope ranking (score = √[completeness × coverage]):'];
      for (const s of ranked.slice(0, 5)) {
        lines.push(
          `  ${s.nuclide.id}  score ${s.score.toFixed(2)}  ` +
            `complete ${s.completeness.toFixed(2)}  coverage ${s.coverage.toFixed(2)}  ` +
            `lines ${s.matchedLines.length}`,
        );
      }
      const top = ranked[0];
      lines.push(
        `\nConclusion: ${top.verdict} match for ${top.nuclide.displayName} (score ${top.score.toFixed(2)}).`,
      );
      const caveat =
        top.verdict === 'WEAK'
          ? 'Top candidate is below the confidence bar (WEAK) -- treat as unconfirmed.'
          : input.summary.caveats.length
            ? 'The top match carries trustworthiness caveats (see the Review summary).'
            : undefined;
      return { text: lines.join('\n'), ...(caveat ? { caveat } : {}) };
    },
  };
}
