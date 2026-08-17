/**
 * StageView -- the shared "stage-by-stage" walkthrough shell (WP-B), a faithful
 * port of the reference `walkthrough.py` StageView into Nuclid's vocabulary.
 *
 * Mode-agnostic by construction: it owns the DR-5 Stages rail (labels, current
 * highlight, click-to-jump), one drawing canvas, an explanation panel, Prev/Next
 * buttons, and arrow-key (left/right) navigation -- nothing calibrate-specific.
 * A mode supplies its own `StageDef[]` (label + render + explain); Identify mode
 * can reuse this same shell later (out of scope now, but nothing is hard-coded to
 * "calibrate"). Display-only: a stage's `render` draws an already-computed result,
 * it never runs analysis.
 *
 * Architecture note (browser): the app re-renders by replacing `innerHTML`, so a
 * handle is short-lived -- created fresh against the new DOM each app render and
 * `destroy()`-ed before the next (so the document-level arrow-key listener never
 * leaks). The current stage index lives in app state and is threaded back in via
 * `initialStage` / `onStageChange`, so navigating does NOT trigger a full app
 * re-render -- the handle mutates only its own sub-DOM (rail highlight, canvas,
 * explanation, nav label). `ready` mirrors Python's `is_ready()`: when false the
 * canvas shows `notReadyHint` instead of calling a stage's render/explain, while
 * the rail still lists every step.
 *
 * RISK-01 (DESIGN.md S5): the global amber disclaimer is shown ONCE by the caller
 * above this view; per-stage `explain().caveat` is the only amber inside a stage,
 * shown only where a real caveat exists. A clean stage shows no "all clear" line.
 */

// --- public, mode-agnostic contract (HAND-OFF interface) --------------------

export interface StageExplain {
  /** Neutral explanation prose (grey note). */
  readonly text: string;
  /** A real assumption/limitation for this stage -> amber (RISK-01). Omit when none. */
  readonly caveat?: string;
}

export interface StageRenderCtx {
  /** The target canvas for this stage (already cleared + DPR-scaled). */
  readonly canvas: HTMLCanvasElement;
  /** Lightweight inline chart helper for the (non-spectrum) stage plots. */
  readonly plot: StagePlot;
}

export interface StageDef {
  readonly label: string;
  render(ctx: StageRenderCtx): void;
  explain(): StageExplain;
}

export interface StageViewHandle {
  showStage(i: number): void;
  setStages(stages: readonly StageDef[]): void;
  refresh(): void;
  /** Unbind the arrow-key listener on unmount (called before the next app render). */
  destroy(): void;
}

export interface CreateStageViewOptions {
  /** The container the shell builds its sub-DOM into (rebuilt each app render). */
  readonly root: HTMLElement;
  /** The stages (labels always shown in the rail; render/explain used when ready). */
  readonly stages: readonly StageDef[];
  /** Shown on the canvas + explanation when `ready` is false (Python not_ready_hint). */
  readonly notReadyHint: string;
  /** Whether stage data exists; false -> show the hint, not a stage render. Default true. */
  readonly ready?: boolean;
  /** Stage to open on mount (persisted in app state across re-renders). Default 0. */
  readonly initialStage?: number;
  /** Called whenever the visible stage changes, so the app can persist the index. */
  readonly onStageChange?: (index: number) => void;
  /** Called when the user navigates while not ready (optional hook; e.g. focus load). */
  readonly onRequireData?: () => void;
  /** Which built-in chrome to render. Defaults true/true so existing callers and
   *  tests are unaffected. The grouped Build flow passes both false and drives
   *  navigation from the unified rail + bottom toolbar via the returned handle. */
  readonly chrome?: { readonly rail?: boolean; readonly nav?: boolean };
}

// --- StagePlot: a small private 2D charting helper for the stage plots -------
// Canvas primitives in DATA coordinates over an endpoint-anchored linear frame
// (DR-9). Kept inside the UI layer; the only public surface is the `StagePlot`
// type a stage receives via `ctx.plot`.

export interface StagePoint {
  readonly x: number;
  readonly y: number;
}

interface LineOpts {
  readonly color?: string;
  readonly width?: number;
  readonly dash?: readonly number[];
}
interface VLineOpts extends LineOpts {
  /** Restrict the vertical extent to [yBottom, yTop] in data units (default full). */
  readonly yTop?: number;
  readonly yBottom?: number;
}
interface PointOpts {
  readonly color?: string;
  readonly radius?: number;
  readonly shape?: 'circle' | 'cross';
}
interface LabelOpts {
  readonly color?: string;
  readonly dx?: number;
  readonly dy?: number;
  readonly align?: CanvasTextAlign;
  readonly serif?: boolean;
}
interface Tick {
  readonly value: number;
  readonly label: string;
}
interface FrameSpec {
  /** Pixel sub-region of the canvas (CSS px). Defaults to the whole canvas. */
  readonly rect?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly xLabel?: string;
  readonly yLabel?: string;
  readonly title?: string;
  /** Explicit ticks (categorical axes); else N endpoint-anchored linear ticks. */
  readonly xTicks?: readonly Tick[];
  readonly yTicks?: readonly Tick[];
  readonly xTickFormat?: (v: number) => string;
  readonly yTickFormat?: (v: number) => string;
}

export interface StagePlot {
  /** Clear the whole canvas (call once before a stage draws its frame(s)). */
  clear(): void;
  /** Establish a cartesian frame + draw its axes/ticks/gridlines (DR-9). */
  frame(spec: FrameSpec): void;
  line(points: readonly StagePoint[], opts?: LineOpts): void;
  points(points: readonly StagePoint[], opts?: PointOpts): void;
  errorBarsX(points: readonly (StagePoint & { ex: number })[], opts?: { color?: string }): void;
  vline(x: number, opts?: VLineOpts): void;
  hline(y: number, opts?: LineOpts): void;
  vspan(x0: number, x1: number, opts?: { color?: string }): void;
  hspan(y0: number, y1: number, opts?: { color?: string }): void;
  segment(x0: number, y0: number, x1: number, y1: number, opts?: LineOpts): void;
  label(x: number, y: number, text: string, opts?: LabelOpts): void;
}

/** Stage palette -- mirrors the DESIGN.md S2 :root tokens as named hex so the
 * canvas stays flat/light (same pattern as `viz/spectrumChart.ts` COL). One
 * accent: teal = signal/kept; amber (`--warn-text`) = rejected/dropped only;
 * grey (`--faint`) = predicted/inert. No per-isotope hues (DESIGN.md S1). */
export const STAGE_COLORS = {
  surface: '#FFFFFF', // --surface
  axis: '#D8D3C6', // --border-strong
  grid: '#EFEBE0', // --grid
  tick: '#9A988F', // --faint
  title: '#6B6A63', // --muted
  text: '#2C2C2A', // --text
  accent: '#0F6E56', // --accent (kept points/curve)
  accentFill: 'rgba(15, 110, 86, 0.10)', // --accent-fill (band/area)
  warn: '#7A5B12', // --warn-text (rejected/dropped)
  warnFill: 'rgba(122, 91, 18, 0.10)', // tight-window wash (amber, low alpha)
  faint: '#9A988F', // --faint (predicted, inert)
} as const;

const TICK_FONT = '9.5px "Inter", sans-serif';
const TITLE_FONT = '9.5px "Inter", sans-serif';
const SERIF_FONT = '11px "Source Serif 4", Georgia, serif';
const PAD = { left: 50, right: 14, top: 10, bottom: 30, title: 16 };
const X_DIVISIONS = 6;
const Y_DIVISIONS = 5;

/** DR-9 linear ticks: N equal divisions including the exact min and max. */
function linearTicks(min: number, max: number, divisions: number): number[] {
  const out: number[] = [];
  const span = max - min;
  for (let i = 0; i <= divisions; i++) out.push(min + (span * i) / divisions);
  return out;
}

class CanvasStagePlot implements StagePlot {
  private readonly ctx: CanvasRenderingContext2D;
  private cssW = 0;
  private cssH = 0;
  // Current frame mapping (set by frame()).
  private plotLeft = 0;
  private plotTop = 0;
  private plotW = 1;
  private plotH = 1;
  private xMin = 0;
  private xMax = 1;
  private yMin = 0;
  private yMax = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('StagePlot: 2D context unavailable.');
    this.ctx = ctx;
  }

  /** Resize the backing store to the CSS box (high-DPI) and clear. */
  clear(): void {
    const dpr = window.devicePixelRatio || 1;
    this.cssW = this.canvas.clientWidth || 800;
    this.cssH = this.canvas.clientHeight || 440;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.ctx.font = TICK_FONT;
  }

  /** Centered grey hint (the not-ready state, mirrors Python's centered text). */
  hint(text: string): void {
    const { ctx } = this;
    ctx.font = TITLE_FONT;
    ctx.fillStyle = STAGE_COLORS.tick;
    ctx.textAlign = 'center';
    ctx.fillText(text, this.cssW / 2, this.cssH / 2);
    ctx.textAlign = 'left';
  }

  frame(spec: FrameSpec): void {
    const { ctx } = this;
    const rect = spec.rect ?? { x: 0, y: 0, w: this.cssW, h: this.cssH };
    const padTop = PAD.top + (spec.title ? PAD.title : 0);
    this.plotLeft = rect.x + PAD.left;
    this.plotTop = rect.y + padTop;
    this.plotW = Math.max(1, rect.w - PAD.left - PAD.right);
    this.plotH = Math.max(1, rect.h - padTop - PAD.bottom);
    this.xMin = spec.xMin;
    this.xMax = spec.xMax === spec.xMin ? spec.xMin + 1 : spec.xMax;
    this.yMin = spec.yMin;
    this.yMax = spec.yMax === spec.yMin ? spec.yMin + 1 : spec.yMax;

    // Title (muted) at the top-left of the region.
    if (spec.title) {
      ctx.font = TITLE_FONT;
      ctx.fillStyle = STAGE_COLORS.title;
      ctx.fillText(spec.title, this.plotLeft, rect.y + 11);
    }

    ctx.font = TICK_FONT;
    // Vertical gridlines + x labels (DR-9: every tick has both).
    const xTicks: Tick[] =
      spec.xTicks?.slice() ??
      linearTicks(this.xMin, this.xMax, X_DIVISIONS).map((v) => ({
        value: v,
        label: spec.xTickFormat ? spec.xTickFormat(v) : this.fmtNum(v),
      }));
    ctx.lineWidth = 1;
    for (const t of xTicks) {
      const x = this.xOf(t.value);
      ctx.strokeStyle = STAGE_COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(x, this.plotTop);
      ctx.lineTo(x, this.plotTop + this.plotH);
      ctx.stroke();
      const w = ctx.measureText(t.label).width;
      ctx.fillStyle = STAGE_COLORS.tick;
      ctx.fillText(
        t.label,
        Math.min(Math.max(x - w / 2, rect.x + 2), rect.x + rect.w - w - 2),
        this.plotTop + this.plotH + 14,
      );
    }
    // Horizontal gridlines + y labels.
    const yTicks: Tick[] =
      spec.yTicks?.slice() ??
      linearTicks(this.yMin, this.yMax, Y_DIVISIONS).map((v) => ({
        value: v,
        label: spec.yTickFormat ? spec.yTickFormat(v) : this.fmtNum(v),
      }));
    for (const t of yTicks) {
      const y = this.yOf(t.value);
      if (y < this.plotTop - 0.5 || y > this.plotTop + this.plotH + 0.5) continue;
      ctx.strokeStyle = STAGE_COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(this.plotLeft, y);
      ctx.lineTo(this.plotLeft + this.plotW, y);
      ctx.stroke();
      ctx.fillStyle = STAGE_COLORS.tick;
      ctx.fillText(t.label, rect.x + 4, y + 3);
    }

    // Axis baselines (x bottom, y left).
    ctx.strokeStyle = STAGE_COLORS.axis;
    ctx.beginPath();
    ctx.moveTo(this.plotLeft, this.plotTop);
    ctx.lineTo(this.plotLeft, this.plotTop + this.plotH);
    ctx.lineTo(this.plotLeft + this.plotW, this.plotTop + this.plotH);
    ctx.stroke();

    // Axis titles (muted Inter).
    ctx.font = TITLE_FONT;
    ctx.fillStyle = STAGE_COLORS.title;
    if (spec.xLabel) {
      const w = ctx.measureText(spec.xLabel).width;
      ctx.fillText(spec.xLabel, this.plotLeft + this.plotW / 2 - w / 2, rect.y + rect.h - 2);
    }
    if (spec.yLabel) {
      ctx.save();
      ctx.translate(rect.x + 10, this.plotTop + this.plotH / 2);
      ctx.rotate(-Math.PI / 2);
      const w = ctx.measureText(spec.yLabel).width;
      ctx.fillText(spec.yLabel, -w / 2, 0);
      ctx.restore();
    }
    ctx.font = TICK_FONT;
  }

  line(points: readonly StagePoint[], opts: LineOpts = {}): void {
    if (!points.length) return;
    this.clipped(() => {
      const { ctx } = this;
      ctx.strokeStyle = opts.color ?? STAGE_COLORS.accent;
      ctx.lineWidth = opts.width ?? 1.4;
      ctx.setLineDash(opts.dash ? [...opts.dash] : []);
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = this.xOf(p.x);
        const y = this.yOf(p.y);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  points(points: readonly StagePoint[], opts: PointOpts = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      const r = opts.radius ?? 3.2;
      const color = opts.color ?? STAGE_COLORS.accent;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.6;
      for (const p of points) {
        const x = this.xOf(p.x);
        const y = this.yOf(p.y);
        if (opts.shape === 'cross') {
          ctx.beginPath();
          ctx.moveTo(x - r, y - r);
          ctx.lineTo(x + r, y + r);
          ctx.moveTo(x + r, y - r);
          ctx.lineTo(x - r, y + r);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }

  errorBarsX(points: readonly (StagePoint & { ex: number })[], opts: { color?: string } = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.strokeStyle = opts.color ?? STAGE_COLORS.accent;
      ctx.lineWidth = 1;
      const cap = 3;
      for (const p of points) {
        const y = this.yOf(p.y);
        const xl = this.xOf(p.x - p.ex);
        const xr = this.xOf(p.x + p.ex);
        ctx.beginPath();
        ctx.moveTo(xl, y);
        ctx.lineTo(xr, y);
        ctx.moveTo(xl, y - cap);
        ctx.lineTo(xl, y + cap);
        ctx.moveTo(xr, y - cap);
        ctx.lineTo(xr, y + cap);
        ctx.stroke();
      }
    });
  }

  vline(x: number, opts: VLineOpts = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.strokeStyle = opts.color ?? STAGE_COLORS.accent;
      ctx.lineWidth = opts.width ?? 1.2;
      ctx.setLineDash(opts.dash ? [...opts.dash] : []);
      const px = this.xOf(x);
      const yTop = opts.yTop != null ? this.yOf(opts.yTop) : this.plotTop;
      const yBot = opts.yBottom != null ? this.yOf(opts.yBottom) : this.plotTop + this.plotH;
      ctx.beginPath();
      ctx.moveTo(px, yTop);
      ctx.lineTo(px, yBot);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  hline(y: number, opts: LineOpts = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.strokeStyle = opts.color ?? STAGE_COLORS.axis;
      ctx.lineWidth = opts.width ?? 1;
      ctx.setLineDash(opts.dash ? [...opts.dash] : []);
      const py = this.yOf(y);
      ctx.beginPath();
      ctx.moveTo(this.plotLeft, py);
      ctx.lineTo(this.plotLeft + this.plotW, py);
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  vspan(x0: number, x1: number, opts: { color?: string } = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.fillStyle = opts.color ?? STAGE_COLORS.warnFill;
      const xa = this.xOf(x0);
      const xb = this.xOf(x1);
      ctx.fillRect(Math.min(xa, xb), this.plotTop, Math.abs(xb - xa), this.plotH);
    });
  }

  hspan(y0: number, y1: number, opts: { color?: string } = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.fillStyle = opts.color ?? STAGE_COLORS.accentFill;
      const ya = this.yOf(y0);
      const yb = this.yOf(y1);
      ctx.fillRect(this.plotLeft, Math.min(ya, yb), this.plotW, Math.abs(yb - ya));
    });
  }

  segment(x0: number, y0: number, x1: number, y1: number, opts: LineOpts = {}): void {
    this.clipped(() => {
      const { ctx } = this;
      ctx.strokeStyle = opts.color ?? STAGE_COLORS.accent;
      ctx.lineWidth = opts.width ?? 1.4;
      ctx.setLineDash(opts.dash ? [...opts.dash] : []);
      ctx.beginPath();
      ctx.moveTo(this.xOf(x0), this.yOf(y0));
      ctx.lineTo(this.xOf(x1), this.yOf(y1));
      ctx.stroke();
      ctx.setLineDash([]);
    });
  }

  label(x: number, y: number, text: string, opts: LabelOpts = {}): void {
    const { ctx } = this;
    ctx.font = opts.serif ? SERIF_FONT : TICK_FONT;
    ctx.fillStyle = opts.color ?? STAGE_COLORS.text;
    ctx.textAlign = opts.align ?? 'left';
    ctx.fillText(text, this.xOf(x) + (opts.dx ?? 0), this.yOf(y) + (opts.dy ?? 0));
    ctx.textAlign = 'left';
    ctx.font = TICK_FONT;
  }

  // --- internals ------------------------------------------------------------
  private xOf(v: number): number {
    return this.plotLeft + ((v - this.xMin) / (this.xMax - this.xMin)) * this.plotW;
  }
  private yOf(v: number): number {
    return this.plotTop + this.plotH - ((v - this.yMin) / (this.yMax - this.yMin)) * this.plotH;
  }
  private fmtNum(v: number): string {
    const a = Math.abs(v);
    if (a !== 0 && a < 0.01) return v.toExponential(1);
    if (a >= 1000) return Math.round(v).toString();
    if (a >= 1) return v.toFixed(a >= 100 ? 0 : 1);
    return v.toFixed(3);
  }
  private clipped(draw: () => void): void {
    const { ctx } = this;
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.plotLeft, this.plotTop, this.plotW, this.plotH);
    ctx.clip();
    draw();
    ctx.restore();
  }
}

// --- the shell --------------------------------------------------------------

const ROOT_CLASS = 'stage-view';

/** Build the stage-view shell into `root` and return a handle. Idempotent per
 * app render: the caller destroys the previous handle before creating a new one. */
export function createStageView(options: CreateStageViewOptions): StageViewHandle {
  const { root, notReadyHint } = options;
  let stages: readonly StageDef[] = options.stages;
  const ready = options.ready ?? true;
  // Additive chrome flags: omitted -> both rendered (no change for current callers).
  const showRail = options.chrome?.rail ?? true;
  const showNav = options.chrome?.nav ?? true;
  let index = clampIndex(options.initialStage ?? 0, stages.length);

  // Build the sub-DOM once (rail | [canvas + explanation] / nav). The rail and nav
  // are suppressed when embedded in the grouped Build flow (chrome:{rail/nav:false});
  // the canvas, explanation, and arrow-key navigation always stay.
  root.classList.add(ROOT_CLASS);
  root.innerHTML = `
    ${showRail ? '<ol class="stage-rail" role="listbox" aria-label="Stages"></ol>' : ''}
    <div class="stage-main">
      <canvas class="stage-canvas"></canvas>
      <div class="stage-explain">
        <p class="stage-text"></p>
        <p class="stage-caveat flag-caveat" hidden></p>
      </div>
      ${
        showNav
          ? `<div class="stage-nav">
        <button class="btn stage-prev" type="button">&larr; Prev</button>
        <button class="btn stage-next" type="button">Next &rarr;</button>
        <span class="stage-pos muted"></span>
      </div>`
          : ''
      }
    </div>`;

  const railEl = root.querySelector<HTMLOListElement>('.stage-rail');
  const canvas = root.querySelector<HTMLCanvasElement>('.stage-canvas')!;
  const textEl = root.querySelector<HTMLParagraphElement>('.stage-text')!;
  const caveatEl = root.querySelector<HTMLParagraphElement>('.stage-caveat')!;
  const posEl = root.querySelector<HTMLSpanElement>('.stage-pos');
  const prevBtn = root.querySelector<HTMLButtonElement>('.stage-prev');
  const nextBtn = root.querySelector<HTMLButtonElement>('.stage-next');
  const plot = new CanvasStagePlot(canvas);

  function buildRail(): void {
    if (!railEl) return; // rail chrome suppressed (grouped Build flow)
    railEl.innerHTML = stages
      .map(
        (s, i) =>
          `<li class="stage-step ${i === index ? 'active' : ''}" role="option"
             aria-selected="${i === index}" data-stage="${i}" tabindex="0">${escapeHtml(s.label)}</li>`,
      )
      .join('');
    railEl.querySelectorAll<HTMLLIElement>('.stage-step').forEach((li) => {
      const go = (): void => showStage(Number(li.dataset.stage));
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    });
  }

  function showStage(i: number): void {
    if (!stages.length) return;
    index = clampIndex(i, stages.length);
    // Rail highlight.
    railEl?.querySelectorAll<HTMLLIElement>('.stage-step').forEach((li) => {
      const on = Number(li.dataset.stage) === index;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', String(on));
    });
    const stage = stages[index];
    if (posEl) posEl.textContent = `Stage ${index + 1} / ${stages.length}`;

    plot.clear();
    if (!ready) {
      plot.hint(notReadyHint);
      textEl.textContent = notReadyHint;
      caveatEl.hidden = true;
    } else {
      stage.render({ canvas, plot });
      const ex = stage.explain();
      textEl.textContent = ex.text;
      if (ex.caveat) {
        caveatEl.textContent = ex.caveat;
        caveatEl.hidden = false;
      } else {
        caveatEl.hidden = true;
      }
    }
    options.onStageChange?.(index);
  }

  function step(delta: number): void {
    if (!ready) {
      options.onRequireData?.();
      return;
    }
    if (stages.length) showStage((index + delta + stages.length) % stages.length);
  }

  prevBtn?.addEventListener('click', () => step(-1));
  nextBtn?.addEventListener('click', () => step(1));

  // Arrow-key navigation, scoped to while this view is mounted + not typing.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (!root.isConnected) return;
    // While the execution reveal is running the engine owns the visible stage:
    // .stepper-running locks the rail/nav via pointer-events, and this guard
    // extends the same lock to the document-level arrow keys (DEBT-18).
    if (root.closest('.stepper-running')) return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  };
  document.addEventListener('keydown', onKey);

  buildRail();
  showStage(index);

  return {
    showStage,
    setStages(next: readonly StageDef[]): void {
      stages = next;
      index = clampIndex(index, stages.length);
      buildRail();
      showStage(index);
    },
    refresh(): void {
      showStage(index);
    },
    destroy(): void {
      document.removeEventListener('keydown', onKey);
    },
  };
}

function clampIndex(i: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(i)), length - 1);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
