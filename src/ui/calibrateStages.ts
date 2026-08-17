/**
 * calibrateStages -- the eight Calibrate-mode walkthrough stages (WP-B), a
 * faithful port of `reference/calibrate_mode.py`'s `_r_*` / `_e_*` pairs.
 *
 * Each stage is a pure, DISPLAY-ONLY view of an already-computed
 * `CalibrationResult` (+ its WP-A `trace`) and the declared source spectra passed
 * in. Nothing here runs analysis: it never calls `calibrate()` / `weightedPolyfit`,
 * and the stage-6/7 residuals are evaluated from the fit's `coefficients`
 * (Horner), never refit. Advancing a stage narrates the finished result -- exactly
 * the reference's "compute once, view eight ways" model.
 *
 * Palette discipline (DESIGN.md S1 one-accent): the reference colours each isotope;
 * Nuclid does NOT (that would break the one-accent rule). Isotopes are told apart
 * by label, and colour carries MEANING only: teal (`--accent`) = kept/signal,
 * amber (`--warn-text`) = rejected/dropped, grey (`--faint`) = predicted/inert.
 */
import type {
  Calibration,
  CalibrationKit,
  CalibrationResult,
  CalibrationPoint,
  FittedPeak,
} from '../domain/types';
import {
  STAGE_COLORS as C,
  type StageDef,
  type StagePlot,
  type StagePoint,
  type StageRenderCtx,
} from './stageView';

/** FWHM = k.sigma for a Gaussian (recover sigma from a fitted FWHM). */
const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

/** Reference `CalWalk.point` tolerance: a pass-two window's line matches a final
 * calibration point when their energies agree within this margin (keV). */
const ENERGY_MATCH_TOL_KEV = 0.5;

/** One declared source the stages can draw from: its id, raw counts, fitted peaks. */
export interface CalibrateStageSource {
  readonly sourceId: string;
  readonly counts: readonly number[];
  readonly fittedPeaks: readonly FittedPeak[];
}

/** Everything the eight stages read -- all already computed by the engine. */
export interface CalibrateStagesInput {
  /** The built result; its `trace` (WP-A) drives stages 2 & 4. */
  readonly result: CalibrationResult;
  /** Which candidate equation stages 6 & 8 highlight (the dual-model switch). */
  readonly viewModel: 'linear' | 'quadratic';
  /** The declared sources with their spectra + fitted peaks. */
  readonly sources: readonly CalibrateStageSource[];
  /** The calibration kit (Stage 1 kit lines). */
  readonly kit: CalibrationKit;
}

/** The eight stage labels (static; used to populate the rail before a build). */
export const CALIBRATE_STAGE_LABELS: readonly string[] = [
  '1. Identify the sources',
  '2. Rough survey & gain drift',
  '3. Gaussian centroid',
  '4. Two-pass tight windows',
  '5. Assemble & weight',
  '6. Linear vs quadratic',
  '7. Prune unreliable points',
  '8. Final equation & save',
];

/** Placeholder stages (labels only) for the not-ready state -- render/explain are
 * never invoked while `ready` is false, so they are inert. */
export function placeholderStages(): StageDef[] {
  return CALIBRATE_STAGE_LABELS.map((label) => ({
    label,
    render: () => {},
    explain: () => ({ text: '' }),
  }));
}

// --- small numeric helpers (display-only) -----------------------------------

/** Evaluate an ASCENDING-power polynomial at x (Horner) -- mirrors the engine's
 * `applyCalibrationToChannel`; used only to draw curves/residuals, never to fit. */
function evalPoly(coeffs: readonly number[], x: number): number {
  let e = 0;
  for (let k = coeffs.length - 1; k >= 0; k--) e = e * x + coeffs[k];
  return e;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function pad(min: number, max: number, frac = 0.05): readonly [number, number] {
  const span = max - min || Math.abs(max) || 1;
  return [min - span * frac, max + span * frac];
}

function linspace(a: number, b: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / (n - 1));
  return out;
}

/** The candidate equation the dual-model switch currently shows: quadratic when
 * selected AND available, else the always-present linear. Exported so the Review
 * summary (app.ts) resolves the displayed model identically to the stages. */
export function displayedCal(
  result: CalibrationResult,
  viewModel: 'linear' | 'quadratic',
): Calibration {
  return viewModel === 'quadratic' && result.quadratic ? result.quadratic : result.linear;
}

/** Human-readable equation string for a calibration, e.g.
 * `E = 1.234 + 0.56789*ch + 1.23e-7*ch^2 keV`. Exported for the Review header. */
export function equationString(cal: Calibration): string {
  const c = cal.coefficients;
  let s = `E = ${c[0].toFixed(3)} + ${c[1].toFixed(5)}*ch`;
  if (c.length > 2) s += ` + ${c[2].toExponential(2)}*ch^2`;
  return `${s} keV`;
}

/** The matched points that entered the final fit (the shared matched set lives on
 * `result.linear.points`). Exported so the Review summary counts used/total the
 * same way the stages do. */
export function usedPoints(result: CalibrationResult): CalibrationPoint[] {
  return result.linear.points.filter((p) => p.used);
}

/** The reference `anchor_demo_point`: a used anchor with a finite centroid error,
 * preferring the clean single-line sources, else the first available. */
function anchorDemoPoint(result: CalibrationResult): CalibrationPoint | null {
  const anchors = result.linear.points.filter(
    (p) => p.tier === 'anchor' && p.used && p.centroidError != null && Number.isFinite(p.centroidError),
  );
  if (!anchors.length) return null;
  for (const pref of ['Cs-137', 'Mn-54', 'Co-60']) {
    const m = anchors.find((p) => p.sourceId === pref);
    if (m) return m;
  }
  return anchors[0];
}

function sourceById(input: CalibrateStagesInput, id: string | undefined): CalibrateStageSource | null {
  if (!id) return null;
  return input.sources.find((s) => s.sourceId === id) ?? null;
}

/** Nearest fitted peak to a channel, for reconstructing a stage-3 Gaussian. */
function nearestPeak(source: CalibrateStageSource, channel: number): FittedPeak | null {
  let best: FittedPeak | null = null;
  let bd = Infinity;
  for (const pk of source.fittedPeaks) {
    const d = Math.abs(pk.centroidChannel - channel);
    if (d < bd) {
      bd = d;
      best = pk;
    }
  }
  return best;
}

/** The FINAL used state of the point a pass-two window realises -- so Stage 4
 * colours kept (teal) / rejected (amber) by the post-prune outcome (matching the
 * reference `_r_twopass` and Stage 7), not the pre-prune trace `outcome`. A line
 * matched in pass two but later sigma-clip-pruned reads `used:false` here. Returns
 * false when no point matches (defensive; every drawn window has a point). */
function finalUsedFor(result: CalibrationResult, sourceId: string, energyKeV: number): boolean {
  const pt = result.linear.points.find(
    (p) => p.sourceId === sourceId && Math.abs(p.energyKeV - energyKeV) < ENERGY_MATCH_TOL_KEV,
  );
  return pt?.used ?? false;
}

function centeredNote(ctx: StageRenderCtx, message: string): void {
  ctx.plot.frame({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
  ctx.plot.label(0.5, 0.5, message, { align: 'center', color: C.title });
}

// --- the eight stages -------------------------------------------------------

/** Build the eight Calibrate stages over the finished result. */
export function buildCalibrateStages(input: CalibrateStagesInput): StageDef[] {
  return [
    stageIdentify(input),
    stageSurvey(input),
    stageCentroid(input),
    stageTwoPass(input),
    stageAssemble(input),
    stageFits(input),
    stagePrune(input),
    stageFinal(input),
  ];
}

// Stage 1 -- the kit and its known gamma lines (thick = anchor). --------------
function stageIdentify(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[0],
    render(ctx) {
      const isos = input.sources.map((s) => s.sourceId);
      const rows = isos.map((id, i) => ({ id, row: i }));
      let maxE = 1480;
      for (const { id } of rows) {
        for (const L of kitLines(input, id)) maxE = Math.max(maxE, L.energyKeV);
      }
      ctx.plot.frame({
        xMin: 0,
        xMax: maxE * 1.02,
        yMin: -0.6,
        yMax: Math.max(0.4, isos.length - 0.4),
        xLabel: 'Energy (keV)',
        title: 'Stage 1 - kit lines across ~60-1400 keV (thick = anchor)',
        yTicks: rows.map((r) => ({ value: r.row, label: r.id })),
      });
      for (const { id, row } of rows) {
        for (const L of kitLines(input, id)) {
          const anchor = L.tier === 'anchor';
          ctx.plot.segment(L.energyKeV, row - 0.36, L.energyKeV, row + 0.36, {
            color: anchor ? C.accent : C.faint,
            width: anchor ? 2.6 : 1.1,
          });
        }
      }
    },
    explain() {
      const n = input.sources.reduce((s, src) => s + kitLines(input, src.sourceId).length, 0);
      return {
        text:
          `${input.sources.length} declared sources, ${n} catalogued lines. Each line's ` +
          'energy is known to a few eV -- far better than the detector -- so it is a fixed ' +
          'reference point. Thick teal = strong isolated ANCHORS (fit first); thin grey = ' +
          'weaker / congested SECONDARY lines (matched in the second pass).',
      };
    },
  };
}

// Stage 2 -- rough gain from the big peaks, and it DRIFTS. --------------------
function stageSurvey(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[1],
    render(ctx) {
      const gp = input.result.trace?.gainProfile ?? [];
      if (!gp.length) return centeredNote(ctx, 'no gain profile available');
      const es = gp.map((g) => g.energyKeV);
      const gains = gp.map((g) => g.gain);
      const [xLo, xHi] = pad(Math.min(...es), Math.max(...es));
      const [yLo, yHi] = pad(Math.min(...gains), Math.max(...gains), 0.15);
      ctx.plot.frame({
        xMin: xLo,
        xMax: xHi,
        yMin: yLo,
        yMax: yHi,
        xLabel: 'Energy (keV)',
        yLabel: 'gain (keV / channel)',
        title: 'Stage 2 - rough gain from the big peaks - and it drifts',
        yTickFormat: (v) => v.toFixed(3),
      });
      const pts: StagePoint[] = gp.map((g) => ({ x: g.energyKeV, y: g.gain }));
      ctx.plot.line(pts, { color: C.accent, width: 1.4 });
      ctx.plot.points(pts, { color: C.accent, radius: 3.2 });
      for (const g of gp) {
        ctx.plot.label(g.energyKeV, g.gain, g.gain.toFixed(3), {
          align: 'center',
          dy: -8,
          color: C.accent,
        });
      }
    },
    explain() {
      const t = input.result.trace;
      const gp = t?.gainProfile ?? [];
      if (!t || !gp.length) return { text: 'No gain profile available for this set.' };
      const glo = gp[0].gain;
      const ghi = gp[gp.length - 1].gain;
      return {
        text:
          'Divide each known energy by its channel for an approximate gain. The gain is NOT ' +
          `constant -- it creeps from ~${glo.toFixed(3)} low to ~${ghi.toFixed(3)} high, ` +
          'hinting the detector is slightly nonlinear. From the anchors the preliminary scale ' +
          `is E = ${t.preliminary.a0.toFixed(2)} + ${t.preliminary.b0.toFixed(4)}*ch.`,
      };
    },
  };
}

// Stage 3 -- Gaussian + linear-background centroid (reconstructed for display).
function stageCentroid(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[2],
    render(ctx) {
      const p = anchorDemoPoint(input.result);
      if (!p) return centeredNote(ctx, 'no anchor point available');
      const src = sourceById(input, p.sourceId);
      const peak = src ? nearestPeak(src, p.channel) : null;
      if (!src || !peak) return centeredNote(ctx, 'source spectrum unavailable for this anchor');
      const counts = src.counts;
      const sigma = peak.fwhmChannels / FWHM_PER_SIGMA || 1;
      const amp = peak.amplitude;
      const centre = p.channel;
      const W = Math.max(4 * sigma, 18);
      const lo = Math.max(Math.floor(centre - W), 0);
      const hi = Math.min(Math.ceil(centre + W), counts.length - 1);
      const xs: number[] = [];
      for (let ch = lo; ch <= hi; ch++) xs.push(ch);
      const bl = median(counts.slice(lo, lo + 3));
      const br = median(counts.slice(Math.max(hi - 2, lo), hi + 1));
      const bg = (ch: number): number => bl + ((br - bl) * (ch - lo)) / Math.max(hi - lo, 1);
      const model = (ch: number): number =>
        amp * Math.exp(-0.5 * ((ch - centre) / sigma) ** 2) + bg(ch);

      const raw: StagePoint[] = xs.map((ch) => ({ x: ch, y: counts[ch] }));
      let yMax = 0;
      for (const ch of xs) yMax = Math.max(yMax, counts[ch], model(ch));
      ctx.plot.frame({
        xMin: lo,
        xMax: hi,
        yMin: 0,
        yMax: yMax * 1.08 || 1,
        xLabel: 'Channel',
        yLabel: 'Counts',
        title: `Stage 3 - ${p.sourceId} ${p.energyKeV.toFixed(0)} keV: ch ${centre.toFixed(2)} +/- ${(p.centroidError ?? 0).toFixed(2)}`,
      });
      ctx.plot.line(raw, { color: C.text, width: 0.9 });
      ctx.plot.line(
        xs.map((ch) => ({ x: ch, y: bg(ch) })),
        { color: C.faint, width: 1, dash: [3, 3] },
      );
      ctx.plot.line(
        xs.map((ch) => ({ x: ch, y: model(ch) })),
        { color: C.accent, width: 1.8 },
      );
      ctx.plot.vline(centre, { color: C.accent, width: 1.4, dash: [4, 3] });
    },
    explain() {
      const p = anchorDemoPoint(input.result);
      const loc = p
        ? `${p.sourceId} ${p.energyKeV.toFixed(0)} keV -> channel ${p.channel.toFixed(2)} +/- ${(p.centroidError ?? 0).toFixed(2)}.`
        : '';
      return {
        text:
          "A peak's channel can't be the tallest bin (quantized, biased). Each line is fit with " +
          'a Gaussian + linear background: the centre is the centroid (to a fraction of a channel, ' +
          'with an uncertainty) and the linear term removes the sloping Compton continuum. The ' +
          "curve here is reconstructed from the engine's fitted amplitude/width for display. " +
          loc,
      };
    },
  };
}

// Stage 4 -- two-pass tight windows on a congested source. --------------------
function stageTwoPass(input: CalibrateStagesInput): StageDef {
  const congestedId = (): string | null => {
    const ids = new Set(input.sources.map((s) => s.sourceId));
    if (ids.has('Ba-133')) return 'Ba-133';
    if (ids.has('Eu-152')) return 'Eu-152';
    return null;
  };
  return {
    label: CALIBRATE_STAGE_LABELS[3],
    render(ctx) {
      const id = congestedId();
      if (!id) return centeredNote(ctx, 'no congested source (Ba-133 / Eu-152) loaded');
      const src = sourceById(input, id);
      const windows = (input.result.trace?.secondaryWindows ?? []).filter((w) => w.sourceId === id);
      if (!src || !windows.length) return centeredNote(ctx, `no pass-two windows for ${id}`);
      const counts = src.counts;
      const inRange = windows.filter(
        (w) => w.predictedChannel > 2 && w.predictedChannel < counts.length - 2,
      );
      if (!inRange.length) return centeredNote(ctx, `no in-range predictions for ${id}`);
      const preds = inRange.map((w) => w.predictedChannel);
      const lo = Math.max(Math.floor(Math.min(...preds) - 40), 0);
      const hi = Math.min(Math.ceil(Math.max(...preds) + 40), counts.length - 1);
      const xs: StagePoint[] = [];
      let yMax = 0;
      for (let ch = lo; ch <= hi; ch++) {
        xs.push({ x: ch, y: counts[ch] });
        yMax = Math.max(yMax, counts[ch]);
      }
      ctx.plot.frame({
        xMin: lo,
        xMax: hi,
        yMin: 0,
        yMax: yMax * 1.08 || 1,
        xLabel: 'Channel',
        yLabel: 'Counts',
        title: `Stage 4 - ${id}: predicted (grey), tight window (amber), kept (teal) / rejected (amber)`,
      });
      // Tight windows + predicted channels first (so fits draw on top).
      for (const w of inRange) {
        if (Number.isFinite(w.halfWindow)) {
          ctx.plot.vspan(w.predictedChannel - w.halfWindow, w.predictedChannel + w.halfWindow, {
            color: C.warnFill,
          });
        }
        ctx.plot.vline(w.predictedChannel, { color: C.faint, width: 0.9, dash: [3, 3] });
      }
      ctx.plot.line(xs, { color: C.text, width: 0.9 });
      for (const w of inRange) {
        if (w.matchedChannel == null) continue;
        // Colour by the FINAL point state (post sigma-clip), not the pass-two
        // trace `outcome`: a `'used'` line can still be pruned and is then rejected.
        const kept = finalUsedFor(input.result, w.sourceId, w.energyKeV);
        ctx.plot.vline(w.matchedChannel, { color: kept ? C.accent : C.warn, width: 1.6 });
      }
    },
    explain() {
      const rej = (input.result.trace?.secondaryWindows ?? []).filter(
        (w) => w.outcome === 'hop-rejected',
      );
      const s = rej.length
        ? rej.map((w) => `${w.sourceId} ${w.energyKeV.toFixed(0)}keV`).join(', ')
        : 'none on this set';
      return {
        text:
          'Wide windows let a fit HOP onto a taller neighbour in congested clusters (Ba-133, ' +
          'Eu-152). Fix: pass one fits the strong anchors -> a preliminary scale; pass two ' +
          'predicts each congested line (grey) and matches it only inside a TIGHT window (amber) ' +
          `so it cannot reach the neighbour. Rejected as peak-hops: ${s}.`,
      };
    },
  };
}

// Stage 5 -- (channel, energy) points with centroid error bars. ---------------
function stageAssemble(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[4],
    render(ctx) {
      const used = usedPoints(input.result);
      if (!used.length) return centeredNote(ctx, 'no used points');
      const chs = used.map((p) => p.channel);
      const es = used.map((p) => p.energyKeV);
      ctx.plot.frame({
        xMin: 0,
        xMax: Math.max(...chs) * 1.05,
        yMin: 0,
        yMax: Math.max(...es) * 1.05,
        xLabel: 'Channel',
        yLabel: 'Energy (keV)',
        title: 'Stage 5 - (channel, energy) points with centroid errors',
      });
      const pts = used.map((p) => ({
        x: p.channel,
        y: p.energyKeV,
        ex: Math.max(p.centroidError ?? 0.02, 0.02),
      }));
      ctx.plot.errorBarsX(pts, { color: C.accent });
      ctx.plot.points(pts, { color: C.accent, radius: 3 });
    },
    explain() {
      const errs = usedPoints(input.result)
        .map((p) => p.centroidError)
        .filter((e): e is number => e != null && Number.isFinite(e));
      const lo = errs.length ? Math.min(...errs) : 0;
      const hi = errs.length ? Math.max(...errs) : 0;
      return {
        text:
          'Each line is now a (channel, energy) pair with an uncertainty. Strong clean lines ' +
          `come back tight (+/-${lo.toFixed(2)} ch); weak ones loose (+/-${hi.toFixed(2)} ch). ` +
          'Those uncertainties become WEIGHTS (1 / error) so confident lines count more in the ' +
          'fit. The error bars are the weights, inverted.',
      };
    },
  };
}

// Stage 6 -- both fits + a residual panel (linear bowl vs flat quadratic). -----
function stageFits(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[5],
    render(ctx) {
      const r = input.result;
      const used = usedPoints(r)
        .filter((p) => Number.isFinite(p.channel))
        .sort((a, b) => a.channel - b.channel);
      if (!used.length) return centeredNote(ctx, 'no used points');
      const W = ctx.canvas.clientWidth || 800;
      const H = ctx.canvas.clientHeight || 440;
      const cmax = Math.max(...used.map((p) => p.channel)) * 1.05;
      const xs = linspace(0, cmax, 80);
      const lin = r.linear;
      const quad = r.quadratic;
      const selQuad = input.viewModel === 'quadratic' && quad != null;

      // Top panel -- both fits + the used points.
      const es = used.map((p) => p.energyKeV);
      ctx.plot.frame({
        rect: { x: 0, y: 0, w: W, h: H * 0.56 },
        xMin: 0,
        xMax: cmax,
        yMin: Math.min(0, ...es),
        yMax: Math.max(...es) * 1.05,
        xLabel: 'Channel',
        yLabel: 'Energy (keV)',
        title: `Stage 6 - both fits (selected: ${selQuad ? 'quadratic' : 'linear'})`,
      });
      if (quad) {
        ctx.plot.line(
          xs.map((x) => ({ x, y: evalPoly(quad.coefficients, x) })),
          { color: selQuad ? C.accent : C.faint, width: selQuad ? 1.8 : 1.2 },
        );
      }
      ctx.plot.line(
        xs.map((x) => ({ x, y: evalPoly(lin.coefficients, x) })),
        { color: selQuad ? C.faint : C.accent, width: selQuad ? 1.2 : 1.8, dash: selQuad ? [5, 3] : [] },
      );
      ctx.plot.points(
        used.map((p) => ({ x: p.channel, y: p.energyKeV })),
        { color: C.text, radius: 3 },
      );

      // Bottom panel -- residuals.
      const residLin = used.map((p) => ({ x: p.channel, y: p.energyKeV - evalPoly(lin.coefficients, p.channel) }));
      const residQuad = quad
        ? used.map((p) => ({ x: p.channel, y: p.energyKeV - evalPoly(quad.coefficients, p.channel) }))
        : [];
      const allR = [...residLin, ...residQuad].map((d) => d.y);
      const rAbs = Math.max(0.1, ...allR.map((v) => Math.abs(v)));
      ctx.plot.frame({
        rect: { x: 0, y: H * 0.56, w: W, h: H * 0.44 },
        xMin: 0,
        xMax: cmax,
        yMin: -rAbs * 1.2,
        yMax: rAbs * 1.2,
        xLabel: 'Channel',
        yLabel: 'Residual (keV)',
        title: 'Residuals: linear bowl vs flat quadratic',
      });
      ctx.plot.hline(0, { color: C.faint, width: 0.8 });
      ctx.plot.line(residLin, { color: selQuad ? C.faint : C.accent, width: 1, dash: [4, 3] });
      ctx.plot.points(residLin, { color: selQuad ? C.faint : C.accent, radius: 2.6 });
      if (residQuad.length) {
        ctx.plot.line(residQuad, { color: selQuad ? C.accent : C.faint, width: 1 });
        ctx.plot.points(residQuad, { color: selQuad ? C.accent : C.faint, radius: 2.6 });
      }
    },
    explain() {
      const r = input.result;
      const selQuad = input.viewModel === 'quadratic' && r.quadratic != null;
      const linRms = r.linear.rms;
      const quadRms = r.quadratic?.rms;
      const rmsLine =
        quadRms != null
          ? `Linear RMS ${linRms?.toFixed(2)} keV vs quadratic RMS ${quadRms.toFixed(2)} keV. `
          : `Linear RMS ${linRms?.toFixed(2)} keV (too few points for a quadratic). `;
      return {
        text:
          'Both fits score R-squared > 0.999, but R-squared is a poor judge over such a wide ' +
          'range. The residuals are the honest diagnostic: the linear fit shows a smooth BOWL ' +
          '(the detector curvature) that the quadratic flattens (curvature significance ' +
          `${r.curvatureSignificance.toFixed(1)}x its uncertainty). ${rmsLine}` +
          `The dual-model switch chooses which to keep -- currently: ${selQuad ? 'quadratic' : 'linear'}.`,
      };
    },
  };
}

// Stage 7 -- prune lines locatable only to +/-1 ch (quadratic residuals). ------
function stagePrune(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[6],
    render(ctx) {
      const r = input.result;
      const coeffs = (r.quadratic ?? r.linear).coefficients;
      const pts = r.linear.points.filter((p) => Number.isFinite(p.channel));
      if (!pts.length) return centeredNote(ctx, 'no points');
      const resid = (p: CalibrationPoint): number => p.energyKeV - evalPoly(coeffs, p.channel);
      const es = pts.map((p) => p.energyKeV);
      const rs = pts.map(resid);
      const rAbs = Math.max(0.5, ...rs.map((v) => Math.abs(v)));
      ctx.plot.frame({
        xMin: 0,
        xMax: Math.max(...es) * 1.05,
        yMin: -rAbs * 1.2,
        yMax: rAbs * 1.2,
        xLabel: 'Energy (keV)',
        yLabel: 'Quadratic residual (keV)',
        title: 'Stage 7 - prune lines locatable only to +/-1 ch (amber x = out)',
      });
      ctx.plot.hline(0, { color: C.faint, width: 0.8 });
      const kept = pts.filter((p) => p.used).map((p) => ({ x: p.energyKeV, y: resid(p) }));
      ctx.plot.points(kept, { color: C.accent, radius: 3 });
      for (const p of pts) {
        if (p.used) continue;
        ctx.plot.points([{ x: p.energyKeV, y: resid(p) }], { color: C.warn, radius: 4, shape: 'cross' });
        ctx.plot.label(p.energyKeV, resid(p), `${p.sourceId ?? ''} ${p.energyKeV.toFixed(0)}`, {
          align: 'center',
          dy: -8,
          color: C.warn,
        });
      }
    },
    explain() {
      const r = input.result;
      const dropped = r.linear.points.filter((p) => !p.used);
      const names = dropped.map((p) => {
        const note = (p.note ?? '').includes('hop')
          ? '(hop)'
          : (p.note ?? '').includes('pruned')
            ? '(pruned)'
            : '';
        return `${p.sourceId ?? ''} ${p.energyKeV.toFixed(0)}keV${note}`;
      });
      const s = names.length ? names.join('; ') : 'nothing needed dropping';
      const quadRms = r.quadratic?.rms;
      return {
        text:
          'Weak lines buried in Compton background have the worst centroid uncertainties and were ' +
          'never reliable anchors. Drop them and keep the solid lines -- not fudging, just not ' +
          `letting a +/-1 ch line outvote a +/-0.05 one. Excluded: ${s}.` +
          (quadRms != null ? ` Final quadratic RMS ${quadRms.toFixed(2)} keV.` : ''),
      };
    },
  };
}

/** Draw the final Energy-vs-Channel equation plot (the Stage-8 hero): the fitted
 * curve, the shaded valid range, and the used points. Shared by `stageFinal.render`
 * and the Review summary's hero canvas so the plotting math lives in exactly one
 * place. Display-only (Horner eval of the fit's coefficients; never refits). The
 * caller clears the canvas first (StageView.showStage / the Review hero mount). */
export function drawFinalEquationPlot(
  plot: StagePlot,
  result: CalibrationResult,
  viewModel: 'linear' | 'quadratic',
): void {
  const cal = displayedCal(result, viewModel);
  const used = usedPoints(result).filter((p) => Number.isFinite(p.channel));
  if (!used.length) {
    plot.frame({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
    plot.label(0.5, 0.5, 'no used points', { align: 'center', color: C.title });
    return;
  }
  const cmax = Math.max(...used.map((p) => p.channel)) * 1.05;
  const xs = linspace(0, cmax, 80);
  const es = used.map((p) => p.energyKeV);
  const curveYs = xs.map((x) => evalPoly(cal.coefficients, x));
  const yMax = Math.max(...es, ...curveYs) * 1.05;
  plot.frame({
    xMin: 0,
    xMax: cmax,
    yMin: Math.min(0, ...curveYs),
    yMax: yMax || 1,
    xLabel: 'Channel',
    yLabel: 'Energy (keV)',
    title: `Stage 8 - ${equationString(cal)}`,
  });
  const range = cal.validRange;
  if (range) plot.hspan(range[0], range[1], { color: C.accentFill });
  plot.line(
    xs.map((x, i) => ({ x, y: curveYs[i] })),
    { color: C.accent, width: 1.8 },
  );
  plot.points(
    used.map((p) => ({ x: p.channel, y: p.energyKeV })),
    { color: C.text, radius: 3 },
  );
}

// Stage 8 -- the chosen equation, its valid range, and where to save. ---------
function stageFinal(input: CalibrateStagesInput): StageDef {
  return {
    label: CALIBRATE_STAGE_LABELS[7],
    render(ctx) {
      drawFinalEquationPlot(ctx.plot, input.result, input.viewModel);
    },
    explain() {
      const r = input.result;
      const cal = displayedCal(r, input.viewModel);
      const range = cal.validRange;
      const lo = range ? range[0].toFixed(0) : '?';
      const hi = range ? range[1].toFixed(0) : '?';
      const n = usedPoints(r).length;
      return {
        text:
          `Selected model: ${cal.model}.  ${equationString(cal)}  RMS ${cal.rms?.toFixed(2)} keV, ` +
          `worst ${cal.maxAbsResidual?.toFixed(2)} keV, over ${n} lines. Use the "Save calibration" ` +
          'control to store this equation by name and make it active; Identify mode will then use it.',
        caveat:
          `Unvalidated calibration -- trust it only across the fitted ${lo}-${hi} keV range; ` +
          'do not rely on it below the lowest line or far above the highest.',
      };
    },
  };
}

// --- kit access -------------------------------------------------------------

function kitLines(
  input: CalibrateStagesInput,
  sourceId: string,
): CalibrationKit['entries'][number]['lines'] {
  const entry = input.kit.entries.find((e) => e.id === sourceId);
  return entry ? entry.lines : [];
}
