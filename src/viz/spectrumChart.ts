/**
 * Dependency-free canvas spectrum plot: channel (x) vs counts (y), with optional
 * log-Y, overlay series (e.g. background/smoothed), vertical peak markers, and the
 * A1d matched-line overlay. High-DPI aware.
 *
 * DR-9 (instrument-grade axes): ticks, labels, and gridlines are ONE system,
 * computed for the currently VISIBLE range (the `view` window, so they recompute
 * through zoom/pan). Linear axes (the X channel/energy axis, and the Y count axis
 * in Linear mode) use N equal divisions that always include the exact visible
 * min/max -- never dropped to force round numbers. The Y axis in Log mode uses
 * decade ticks (1, 10, 100, ...). Every major tick draws BOTH a label AND a
 * gridline, on both axes (one in, all in). See FRONTEND_RULEBOOK DR-9.
 *
 * The plot draws a visible WINDOW of the data (DESIGN.md S4 zoom/pan): callers pass
 * `options.view` ({xMin,xMax} in channel space, {yMin,yMax} in count space); it
 * defaults to the full data range. All data->pixel mapping (curve, markers,
 * overlay) and the returned {@link ChartGeometry} honour the view, so the cursor
 * chip and markers stay correct under the transform. The VIEW changes here; the
 * underlying counts/peaks/energies never do (DR-9 is rendering + interaction only).
 *
 * Lab Notebook styling (DESIGN.md S4): teal counts curve on white with a faint
 * area fill, quiet `--grid` gridlines, `--faint` Inter ticks, a `--muted` axis
 * title, and dashed-accent photopeak markers with a hollow ring and a serif label.
 * Palette is the DESIGN.md S4 hex set as named constants (mirrors the :root tokens).
 */

export interface ChartSeries {
  readonly values: readonly number[];
  readonly color: string;
  readonly label: string;
  readonly width: number;
  /** Fill the area under the curve (DESIGN.md S4 -- only the raw counts curve). */
  readonly fill?: boolean;
  /** Dash pattern for overlay series (baseline/smoothed); solid when omitted. */
  readonly dash?: readonly number[];
  /** Draw as step-after: hold each y across the channel's bin, riser at the next
   * channel -- the honest histogram shape for binned counts. Straight segments when
   * omitted/false. */
  readonly step?: boolean;
  /** Per-channel baseline the fill drops to, instead of the plot bottom: the fill
   * becomes the band between `values` (top) and `fillTo` (bottom) -- e.g. a fitted
   * peak filled to its continuum (the net-peak area). Implies filling even without
   * `fill`. Traced honoring `step`. Length must match `values`. */
  readonly fillTo?: readonly number[];
  /** Explicit fill style; defaults to the faint accent fill. */
  readonly fillColor?: string;
}

export interface ChartMarker {
  readonly channel: number;
  readonly label: string;
  readonly color: string;
}

/**
 * A1d matched-line overlay marker (DESIGN.md S4 photopeak-marker spec). One per
 * identified library line, positioned at the matched measured peak's `channel`
 * (so it sits on the actual spectrum peak; the x axis already reads keV via
 * `xTickFormat`). Display-only: it carries no analysis and changes no tick math.
 */
export interface ChartOverlay {
  /** Channel of the matched measured peak (x position on the data axis). */
  readonly channel: number;
  /** Serif label, e.g. "Cs-137 . 661.7 keV". */
  readonly label: string;
  /** Library line intensity in [0,1] -- stronger lines get a taller marker. */
  readonly intensity: number;
  /** A detector-artifact (511/escape) matched peak -- drawn distinctly (amber). */
  readonly isArtifact: boolean;
}

/**
 * The visible data window (DESIGN.md S4 zoom/pan). `xMin`/`xMax` are channel-space
 * bounds; `yMin`/`yMax` are count-space (data-unit) bounds, transformed internally
 * for log mode. Omit `options.view` for the full data range.
 */
export interface ChartView {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export interface DrawOptions {
  readonly logY?: boolean;
  readonly xLabel?: string;
  readonly yLabel?: string;
  /** Optional formatter for x tick labels (e.g. channel -> energy keV after a
   * calibration is applied). Relabels the SAME endpoint-anchored ticks; it does
   * not change the tick positions or any computation (DR-9). */
  readonly xTickFormat?: (channel: number) => string;
  /** A1d matched-line overlay (drawn on top of the series). Additive; empty when
   * no identification is active. */
  readonly overlays?: readonly ChartOverlay[];
  /** Visible window (DESIGN.md S4 zoom/pan). Defaults to the full data range. */
  readonly view?: ChartView;
  /** Faint position "rug": short vertical ticks rising from the bottom axis, drawn
   * UNDER the series (e.g. every candidate local-maximum channel). The caller passes
   * a low-alpha `color` for faintness; unlike {@link ChartMarker} there is no ring
   * or label. `height` defaults to ~6 px. Omitted => nothing drawn. */
  readonly ticks?: readonly { readonly channel: number; readonly color: string; readonly height?: number }[];
  /** Vertical channel-space bands filled UNDER the series (e.g. a peak's measurement
   * integration window). Each spans the full plot height from `xOf(x0)` to `xOf(x1)`
   * (clamped to the plot); `color` defaults to a recessive gray. Drawn after the rug,
   * before the series fill. Omitted => nothing drawn. */
  readonly shadedRegions?: readonly { readonly x0: number; readonly x1: number; readonly color?: string }[];
}

/** Plot geometry returned by {@link drawSpectrum} so callers can map a pointer
 * position back to data coordinates (the cursor chip; zoom/pan math). Pure layout
 * data -- it carries no analysis result. The `xMin..yMax` fields are the VISIBLE
 * window actually drawn (DR-9: the view, not the full data range). */
export interface ChartGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Number of channels in the full series (NOT the visible span). */
  readonly n: number;
  /** Full-data transformed max (kept for compatibility). */
  readonly maxY: number;
  readonly logY: boolean;
  /** Visible channel range actually drawn. */
  readonly xMin: number;
  readonly xMax: number;
  /** Visible count (data-unit) range actually drawn. */
  readonly yMin: number;
  readonly yMax: number;
}

/**
 * Nearest channel to a CSS-pixel x, for a forgiving click hit-test (pure; no DOM).
 * Maps each `channels[i]` to its pixel x via `geo`
 * (`x = geo.left + ((ch - geo.xMin) / (geo.xMax - geo.xMin)) * geo.width`) and returns
 * the index with the smallest |Δpx| to `xCss`, iff that distance <= `tolPx` (default
 * 6), else `null`. Distance is in pixels, so the tolerance is zoom-independent. Returns
 * `null` for empty `channels` or a degenerate geometry.
 */
export function nearestChannelIndex(
  geo: ChartGeometry,
  xCss: number,
  channels: readonly number[],
  tolPx: number = 6,
): number | null {
  const span = geo.xMax - geo.xMin;
  if (channels.length === 0 || !(span > 0) || !(geo.width > 0)) return null;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < channels.length; i++) {
    const x = geo.left + ((channels[i] - geo.xMin) / span) * geo.width;
    const d = Math.abs(x - xCss);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best >= 0 && bestDist <= tolPx ? best : null;
}

/**
 * DR-8: graph interaction guidance has ONE home -- the "?" Help dialog renders
 * from this single constant. Any new graph gesture MUST add its line here in the
 * same change. Lines describe only interactions that exist today.
 */
export const GRAPH_HELP: readonly string[] = [
  'Log scale: the count (Y) axis is drawn on a log scale, so faint peaks stay visible next to tall ones.',
  'Cursor readout: hover over any spectrum chart to read the channel and counts at the pointer.',
  'Zoom: scroll the mouse wheel over any spectrum chart to zoom the channel axis around the pointer (counts rescale to fit).',
  'Pan: press and drag a zoomed spectrum chart to move the window; it never leaves the data range.',
  'Reset view: the Reset view button -- or double-click -- returns to the full spectrum.',
  'Load by drag-and-drop: drop a spectrum file (.TKA / .CSV) onto the load area to add it.',
];

const PAD = { left: 60, right: 14, top: 14, bottom: 34 };

/** DR-9: equal divisions on a linear axis. */
const X_DIVISIONS = 6;
const Y_DIVISIONS = 5;

// DESIGN.md S4 palette (mirrors the :root tokens; named so the canvas is flat/light).
const COL = {
  axis: '#D8D3C6', // --border-strong (x/y baseline)
  grid: '#EFEBE0', // --grid (quiet gridlines, both axes)
  tick: '#9A988F', // --faint (tick labels)
  title: '#6B6A63', // --muted (axis title)
  accent: '#0F6E56', // --accent (curve, marker)
  accentFill: 'rgba(15, 110, 86, 0.10)', // --accent-fill (area under curve)
  surface: '#FFFFFF', // --surface (hollow ring fill)
  label: '#2C2C2A', // --text (marker label)
  warn: '#7A5B12', // --warn-text (artifact-flagged overlay line/label)
};
const TICK_FONT = '9.5px "Inter", sans-serif';
const TITLE_FONT = '9.5px "Inter", sans-serif';
const MARKER_LABEL_FONT = '12px "Source Serif 4", Georgia, serif';

/** DR-9 linear ticks: N equal divisions including the exact min and max. The
 * interval is uniform; intermediate values may be non-round (never dropped to
 * force round numbers). */
function linearTicks(min: number, max: number, divisions: number): number[] {
  const out: number[] = [];
  const span = max - min;
  for (let i = 0; i <= divisions; i++) out.push(min + (span * i) / divisions);
  return out;
}

/** DR-9 log ticks: decade values (1, 10, 100, ...) up to the visible max, kept
 * only if at/above the visible min. Mirrors the standard log grid. */
function decadeTicks(minV: number, maxV: number): number[] {
  const out: number[] = [];
  const hi = Math.max(1, maxV);
  for (let p = 0; Math.pow(10, p) <= hi * (1 + 1e-9); p++) {
    const v = Math.pow(10, p);
    if (v >= Math.max(0, minV) - 1e-9) out.push(v);
  }
  return out;
}

/** Compact count label: 1.2M / 34k / 250. Decade values render exactly. */
function fmtCount(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return Math.round(v).toString();
}

export function drawSpectrum(
  canvas: HTMLCanvasElement,
  series: readonly ChartSeries[],
  markers: readonly ChartMarker[] = [],
  options: DrawOptions = {},
): ChartGeometry | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 380;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.font = TICK_FONT;

  const n = Math.max(1, ...series.map((s) => s.values.length));
  const logY = options.logY ?? false;
  const tform = (v: number) => (logY ? Math.log10(Math.max(0, v) + 1) : v);

  // Full-data count max (data units), for the default view and the geometry.
  let dataMax = 0;
  for (const s of series) for (const v of s.values) dataMax = Math.max(dataMax, v);
  if (dataMax <= 0) dataMax = 1;

  // Visible window (DESIGN.md S4): default to the full data range.
  const view = options.view ?? { xMin: 0, xMax: n - 1, yMin: 0, yMax: dataMax };
  const xMin = view.xMin;
  const xMax = view.xMax;
  const yMin = view.yMin;
  const yMax = view.yMax;

  const plotW = cssW - PAD.left - PAD.right;
  const plotH = cssH - PAD.top - PAD.bottom;
  const xSpan = xMax - xMin || 1;
  const tyMin = tform(yMin);
  const tyMax = tform(yMax);
  const ySpan = tyMax - tyMin || 1;
  const xOf = (ch: number) => PAD.left + ((ch - xMin) / xSpan) * plotW;
  const yOf = (v: number) => PAD.top + plotH - ((tform(v) - tyMin) / ySpan) * plotH;

  // --- DR-9 tick + gridline system (computed for the VISIBLE range) ----------
  // Vertical gridlines + x labels: linear, endpoint-anchored, every tick labelled.
  const xTickVals = linearTicks(xMin, xMax, X_DIVISIONS);
  ctx.lineWidth = 1;
  for (const xv of xTickVals) {
    const x = xOf(xv);
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    const label = options.xTickFormat ? options.xTickFormat(xv) : Math.round(xv).toString();
    const w = ctx.measureText(label).width;
    ctx.fillStyle = COL.tick;
    ctx.fillText(label, Math.min(Math.max(x - w / 2, 2), cssW - w - 2), cssH - PAD.bottom + 16);
  }

  // Horizontal gridlines + y labels: linear endpoint-anchored, or decade in log.
  const yTickVals = logY ? decadeTicks(yMin, yMax) : linearTicks(yMin, yMax, Y_DIVISIONS);
  for (const yv of yTickVals) {
    const y = yOf(yv);
    if (y < PAD.top - 0.5 || y > PAD.top + plotH + 0.5) continue; // outside the view
    ctx.strokeStyle = COL.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(cssW - PAD.right, y);
    ctx.stroke();
    ctx.fillStyle = COL.tick;
    ctx.fillText(fmtCount(yv), 6, y + 3);
  }

  // Axis baselines (x along the bottom, y along the left) in border-strong.
  ctx.strokeStyle = COL.axis;
  ctx.beginPath();
  ctx.moveTo(PAD.left, PAD.top);
  ctx.lineTo(PAD.left, PAD.top + plotH);
  ctx.lineTo(cssW - PAD.right, PAD.top + plotH);
  ctx.stroke();

  // --- series + markers + overlay, clipped to the plot area (so a zoomed view
  // never spills over the axes / labels) ------------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD.left, PAD.top, plotW, plotH);
  ctx.clip();

  // Faint candidate-position rug: short ticks rising from the bottom axis, drawn
  // UNDER the series (a low-alpha marker of every considered position).
  if (options.ticks && options.ticks.length) {
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    const base = PAD.top + plotH;
    for (const t of options.ticks) {
      const x = xOf(t.channel);
      ctx.strokeStyle = t.color;
      ctx.beginPath();
      ctx.moveTo(x, base);
      ctx.lineTo(x, base - (t.height ?? 6));
      ctx.stroke();
    }
  }

  // Shaded regions: vertical channel-space bands UNDER the series (e.g. a peak's
  // measurement window). Clamped to the plot bounds.
  if (options.shadedRegions && options.shadedRegions.length) {
    ctx.setLineDash([]);
    const top = PAD.top;
    const loX = PAD.left;
    const hiX = PAD.left + plotW;
    for (const r of options.shadedRegions) {
      const a = Math.max(loX, Math.min(hiX, xOf(Math.min(r.x0, r.x1))));
      const b = Math.max(loX, Math.min(hiX, xOf(Math.max(r.x0, r.x1))));
      ctx.fillStyle = r.color ?? 'rgba(107, 106, 99, 0.10)';
      ctx.fillRect(a, top, b - a, plotH);
    }
  }

  // Series (raw counts curve gets the teal stroke + faint area fill).
  for (const s of series) {
    if (s.fill || s.fillTo) {
      ctx.fillStyle = s.fillColor ?? COL.accentFill;
      ctx.beginPath();
      const nn = s.values.length;
      if (s.fillTo) {
        // Band between `values` (top edge) and `fillTo` (baseline), e.g. a fitted
        // peak filled down to its continuum. Both edges honor step-after.
        const b = s.fillTo;
        // Top edge along `values`, left -> right.
        if (s.step) {
          if (nn > 0) ctx.moveTo(xOf(0), yOf(s.values[0]));
          for (let i = 0; i < nn - 1; i++) {
            ctx.lineTo(xOf(i + 1), yOf(s.values[i]));
            ctx.lineTo(xOf(i + 1), yOf(s.values[i + 1]));
          }
        } else {
          for (let i = 0; i < nn; i++) {
            if (i === 0) ctx.moveTo(xOf(0), yOf(s.values[0]));
            else ctx.lineTo(xOf(i), yOf(s.values[i]));
          }
        }
        // Baseline `fillTo`, right -> left (the reverse of a forward step edge).
        if (s.step) {
          if (nn > 0) ctx.lineTo(xOf(nn - 1), yOf(b[nn - 1]));
          for (let i = nn - 1; i >= 1; i--) {
            ctx.lineTo(xOf(i), yOf(b[i - 1]));
            ctx.lineTo(xOf(i - 1), yOf(b[i - 1]));
          }
        } else {
          for (let i = nn - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(b[i]));
        }
      } else {
        // Fill to the plot bottom (unchanged).
        ctx.moveTo(xOf(0), PAD.top + plotH);
        if (s.step) {
          if (nn > 0) ctx.lineTo(xOf(0), yOf(s.values[0]));
          for (let i = 0; i < nn - 1; i++) {
            ctx.lineTo(xOf(i + 1), yOf(s.values[i])); // flat across bin i
            ctx.lineTo(xOf(i + 1), yOf(s.values[i + 1])); // riser to bin i+1
          }
        } else {
          for (let i = 0; i < nn; i++) ctx.lineTo(xOf(i), yOf(s.values[i]));
        }
        ctx.lineTo(xOf(nn - 1), PAD.top + plotH);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.setLineDash(s.dash ? [...s.dash] : []);
    ctx.beginPath();
    if (s.step) {
      // step-after: hold each y flat across its bin, then a riser at the next channel.
      const n = s.values.length;
      if (n > 0) ctx.moveTo(xOf(0), yOf(s.values[0]));
      for (let i = 0; i < n - 1; i++) {
        ctx.lineTo(xOf(i + 1), yOf(s.values[i])); // flat across bin i
        ctx.lineTo(xOf(i + 1), yOf(s.values[i + 1])); // riser to bin i+1
      }
    } else {
      for (let i = 0; i < s.values.length; i++) {
        const x = xOf(i);
        const y = yOf(s.values[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Photopeak markers: dashed accent line + hollow ring at the peak top + serif label.
  const counts = series[0]?.values;
  for (const mk of markers) {
    const x = xOf(mk.channel);
    const color = mk.color || COL.accent;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Hollow ring (surface fill, accent stroke) at the peak top, when we know it.
    if (counts && mk.channel >= 0 && mk.channel < counts.length) {
      const ry = yOf(counts[mk.channel]);
      ctx.beginPath();
      ctx.arc(x, ry, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = COL.surface;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }

    ctx.font = MARKER_LABEL_FONT;
    ctx.fillStyle = COL.label;
    ctx.fillText(mk.label, x + 5, PAD.top + 10);
    ctx.font = TICK_FONT;
  }

  // A1d matched-line overlay: one dashed vertical per identified library line at
  // its matched measured peak, height scaled by line intensity, a hollow ring at
  // the top, and a serif isotope label. Artifact-flagged peaks draw in --warn-text
  // (amber) with a denser dash so they read as "less trustworthy". Stacked labels
  // alternate height to reduce overlap. Display-only -- no analysis, no tick math.
  options.overlays?.forEach((ov, i) => {
    const x = xOf(ov.channel);
    const color = ov.isArtifact ? COL.warn : COL.accent;
    const frac = Math.max(0.15, Math.min(1, ov.intensity)); // floor so weak lines stay visible
    const topY = PAD.top + plotH - frac * plotH; // taller line for a stronger library line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.setLineDash(ov.isArtifact ? [2, 2] : [5, 3]);
    ctx.beginPath();
    ctx.moveTo(x, topY);
    ctx.lineTo(x, PAD.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(x, topY, 3, 0, Math.PI * 2);
    ctx.fillStyle = COL.surface;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();

    ctx.font = MARKER_LABEL_FONT;
    ctx.fillStyle = ov.isArtifact ? COL.warn : COL.label;
    const labelY = topY - 4 - (i % 2) * 12; // alternate to ease crowding
    ctx.fillText(ov.label, x + 5, Math.max(PAD.top + 8, labelY));
    ctx.font = TICK_FONT;
  });

  ctx.restore(); // end plot-area clip

  // Axis titles (muted Inter).
  ctx.font = TITLE_FONT;
  ctx.fillStyle = COL.title;
  if (options.xLabel) ctx.fillText(options.xLabel, PAD.left + plotW / 2 - 18, cssH - 4);
  if (options.yLabel) {
    ctx.save();
    ctx.translate(12, PAD.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(options.yLabel, 0, 0);
    ctx.restore();
  }

  return {
    left: PAD.left,
    top: PAD.top,
    width: plotW,
    height: plotH,
    n,
    maxY: tform(dataMax),
    logY,
    xMin,
    xMax,
    yMin,
    yMax,
  };
}
