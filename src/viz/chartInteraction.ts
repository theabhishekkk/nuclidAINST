/**
 * Chart-interaction view math -- the pure, DOM-free core the ONE reusable
 * spectrum-chart interaction layer is built on (DESIGN_CHART_INTERACTION.md S4-5,
 * PARK-12 / Batch C). This module is the `nearestChannelIndex`-style foundation:
 * no canvas, no DOM, no state -- just the channel-space window transforms and the
 * pixel->channel inversion. The DOM binding + first mount are C1 (this file is
 * imported by nothing until then).
 *
 * The design is "X-zoom + Y auto-fit": the operator drives the X (channel) window;
 * the Y (count) axis auto-fits to whatever is visible. `null` everywhere in this
 * module means "the full range" -- the same view drawSpectrum draws by default.
 *
 * Journeys served (DESIGN_CHART_INTERACTION.md S3):
 *   J1 wheel-zoom about the pointer + drag-pan + Reset  -> zoomXAboutChannel / panXByChannels
 *   J2 read exact channel/counts in a dense region       -> channelAtPixel (cursor readout)
 *   J3 judge a bump against noise on the Identify preview -> zoomXAboutChannel + fitYToWindow
 *   J4 "get me back" -- never strand                      -> clamp-shift-not-clip in every transform
 * fitYToWindow is the Y auto-fit that keeps peaks readable after any J1/J2/J3 X change.
 */
import type { ChartGeometry } from './spectrumChart';

/** Narrowest allowed zoom window (channels). Below this, further zoom-in is a no-op. */
export const MIN_ZOOM_SPAN_CHANNELS = 8;

/** A visible X (channel) window. `null` everywhere in this module means "full range". */
export interface XWindow {
  readonly xMin: number;
  readonly xMax: number;
}

/** The full window for `nChannels` samples, indexed `[0 .. nChannels - 1]` -- the
 * same range drawSpectrum uses when no view is given. */
function fullSpanOf(nChannels: number): number {
  return nChannels - 1;
}

/** Shift a candidate `[lo, hi]` window (shift, NOT clip) so it sits inside
 * `[0, fullSpan]`, preserving its span. Assumes `hi - lo <= fullSpan` (guaranteed by
 * the callers, which never build a sub-window wider than the full range). */
function shiftIntoRange(lo: number, hi: number, fullSpan: number): XWindow {
  let xMin = lo;
  let xMax = hi;
  if (xMin < 0) {
    xMax -= xMin;
    xMin = 0;
  }
  if (xMax > fullSpan) {
    xMin -= xMax - fullSpan;
    xMax = fullSpan;
  }
  return { xMin, xMax };
}

/** Reproject a view onto a target spectrum's channel domain `[0, nChannels-1]` when
 * switching subjects (Phase 4a, operator-ruled). Preserves the window when it fits
 * (same domain => unchanged, since it is already inside; partially outside => shift-
 * not-clip via {@link shiftIntoRange}, preserving span). Resets to full (`null`) only
 * when preserving is no longer meaningful -- the window is as wide as, or wider than,
 * the whole target domain. `null` in => `null` out (stay full). */
export function reprojectView(view: XWindow | null, nChannels: number): XWindow | null {
  if (!view) return null;
  const fullSpan = fullSpanOf(nChannels);
  const span = view.xMax - view.xMin;
  if (!(fullSpan > 0) || span >= fullSpan) return null; // not meaningful -> full view
  return shiftIntoRange(view.xMin, view.xMax, fullSpan); // preserve span, shift inside
}

/**
 * Zoom the window about `focusChannel`, keeping the focus at the same relative
 * position (J1 wheel-zoom about the pointer). `factor` multiplies the span
 * (<1 zooms in, >1 zooms out).
 * - zoom-in clamps at {@link MIN_ZOOM_SPAN_CHANNELS} (returns the min-span window,
 *   focus-anchored) -- so repeated zoom-in past the floor is a no-op;
 * - zoom-out that reaches/exceeds the full range returns `null` (= full view, J4);
 * - the result is always inside `[0, nChannels - 1]` (shift, not clip).
 * Returns `null` for a degenerate full range (`nChannels < 2`).
 */
export function zoomXAboutChannel(
  window: XWindow | null,
  nChannels: number,
  focusChannel: number,
  factor: number,
): XWindow | null {
  const fullSpan = fullSpanOf(nChannels);
  if (!(fullSpan > 0)) return null;

  const curMin = window ? window.xMin : 0;
  const curMax = window ? window.xMax : fullSpan;
  const curSpan = curMax - curMin;
  if (!(curSpan > 0)) return null;

  let newSpan = curSpan * factor;
  // Zoom-out to/past the full range collapses to the full view.
  if (newSpan >= fullSpan) return null;
  // Zoom-in floor: clamp the span, staying anchored on the focus.
  if (newSpan < MIN_ZOOM_SPAN_CHANNELS) newSpan = MIN_ZOOM_SPAN_CHANNELS;
  // A min-span that no longer fits the full range means we are effectively full.
  if (newSpan >= fullSpan) return null;

  // Keep `focus` at the same fractional position `t` within the window.
  const focus = Math.min(Math.max(focusChannel, curMin), curMax);
  const t = (focus - curMin) / curSpan;
  const lo = focus - t * newSpan;
  return shiftIntoRange(lo, lo + newSpan, fullSpan);
}

/** Shift the window by `dChannels`, clamped shift-not-clip inside `[0, nChannels - 1]`
 * (J1 drag-pan; J4 never strand). The span never changes; at an edge the window
 * stops flush rather than clipping. */
export function panXByChannels(window: XWindow, nChannels: number, dChannels: number): XWindow {
  const fullSpan = fullSpanOf(nChannels);
  return shiftIntoRange(window.xMin + dChannels, window.xMax + dChannels, fullSpan);
}

/**
 * Y bounds for the visible window -- the Y auto-fit that keeps peaks readable after
 * any X change (J1/J2/J3). Mirrors drawSpectrum's full-range default: `yMin` 0,
 * `yMax` = max over every series' values inside `[ceil(xMin) .. floor(xMax)]`
 * (the whole series when `window` is `null`), floored at 1. No headroom factor.
 * `yMin: 0` is log-safe because drawSpectrum transforms internally.
 */
export function fitYToWindow(
  series: readonly (readonly number[])[],
  window: XWindow | null,
): { yMin: 0; yMax: number } {
  let yMax = 0;
  for (const s of series) {
    const lo = window ? Math.max(0, Math.ceil(window.xMin)) : 0;
    const hi = window ? Math.min(s.length - 1, Math.floor(window.xMax)) : s.length - 1;
    for (let i = lo; i <= hi; i++) {
      if (s[i] > yMax) yMax = s[i];
    }
  }
  return { yMin: 0, yMax: yMax > 0 ? yMax : 1 };
}

/**
 * Invert the geometry's x mapping (J2/J3 cursor readout): CSS-pixel `xCss` -> the
 * nearest integer channel inside the visible window. Inverts drawSpectrum's forward
 * map `x = left + ((ch - xMin) / (xMax - xMin)) * width`. Returns `null` when the
 * pixel lies outside the plot rect horizontally (`xCss < left` or `xCss > left+width`)
 * or the geometry is degenerate (`width <= 0` or `xMax <= xMin`).
 */
export function channelAtPixel(geo: ChartGeometry, xCss: number): number | null {
  const span = geo.xMax - geo.xMin;
  if (!(geo.width > 0) || !(span > 0)) return null;
  if (xCss < geo.left || xCss > geo.left + geo.width) return null;
  const ch = geo.xMin + ((xCss - geo.left) / geo.width) * span;
  return Math.round(ch);
}

// --- the reusable DOM binding (C1) -----------------------------------------
// Pure composition over the C0 math above: it owns NO view state (the consumer
// does) and draws nothing. C1 mounts it on the Calibrate QC chart; C2 (inspector)
// and C3 (Identify preview) mount the SAME binding, so nothing here may be
// consumer-specific (DESIGN_CHART_INTERACTION.md: ONE reusable interaction layer).

/** How the binding reads/writes the consumer's chart. The consumer owns the view
 * (a channel-space {@link XWindow}, or null = full) and the redraw. */
export interface ChartInteractionCallbacks {
  /** Current geometry (from the last draw) -- null disables interaction until a draw. */
  readonly getGeometry: () => ChartGeometry | null;
  readonly getView: () => XWindow | null;
  /** Store the new window (null = full) and redraw. The binding never draws. */
  readonly setView: (view: XWindow | null) => void;
  /** Hover readout: channel + per-series counts at the pointer, or null when the
   * pointer leaves the plot. Optional -- a consumer may omit the cursor. */
  readonly onCursor?: (info: { channel: number; xCss: number; yCss: number } | null) => void;
}

/** A drag past this many pixels counts as a pan (not a click), so the pan and the
 * C2 click-to-inspect gesture coexist on one canvas: the binding suppresses the
 * click that ends a pan. */
const PAN_CLICK_THRESHOLD_PX = 4;

/** Wire wheel-zoom / drag-pan / hover-cursor / dblclick-reset onto `canvas`.
 * Pure composition over the C0 math; owns NO state (the consumer owns the view)
 * and draws nothing. Returns a destroy() that removes every listener. */
export function mountChartInteraction(
  canvas: HTMLCanvasElement,
  cb: ChartInteractionCallbacks,
): { destroy(): void } {
  let panning = false;
  let lastClientX = 0;
  let movedPx = 0;
  let suppressClick = false;

  // Wheel: focus-anchored x-zoom about the pointer; y auto-fits on the redraw.
  const onWheel = (e: WheelEvent): void => {
    const geo = cb.getGeometry();
    if (!geo) return;
    e.preventDefault();
    const xCss = e.clientX - canvas.getBoundingClientRect().left;
    const focus = channelAtPixel(geo, xCss);
    if (focus == null) return; // pointer outside the plot rect -> no-op
    const factor = e.deltaY > 0 ? 1.25 : 0.8;
    cb.setView(zoomXAboutChannel(cb.getView(), geo.n, focus, factor));
  };

  // Drag-pan (Pointer Events + capture). Only a zoomed view can pan (full = nothing
  // to move), so a press on the full view falls through to the hover/click paths.
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const geo = cb.getGeometry();
    if (!geo || !cb.getView()) return;
    panning = true;
    lastClientX = e.clientX;
    movedPx = 0;
    suppressClick = false;
    canvas.classList.add('panning');
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer to capture (best-effort; matches endPan's release) */
    }
  };

  const onPointerMove = (e: PointerEvent): void => {
    const geo = cb.getGeometry();
    if (!geo) return;
    const rect = canvas.getBoundingClientRect();
    if (panning) {
      const view = cb.getView();
      if (!view) return;
      const dxPx = e.clientX - lastClientX;
      lastClientX = e.clientX;
      movedPx += Math.abs(dxPx);
      if (movedPx > PAN_CLICK_THRESHOLD_PX) suppressClick = true;
      const span = view.xMax - view.xMin;
      cb.setView(panXByChannels(view, geo.n, (-dxPx * span) / geo.width));
      return; // no cursor readout while panning
    }
    if (cb.onCursor) {
      const xCss = e.clientX - rect.left;
      const ch = channelAtPixel(geo, xCss);
      cb.onCursor(ch == null ? null : { channel: ch, xCss, yCss: e.clientY - rect.top });
    }
  };

  const endPan = (e: PointerEvent): void => {
    if (!panning) return;
    panning = false;
    canvas.classList.remove('panning');
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released (e.g. cancel) */
    }
  };

  const onPointerLeave = (): void => {
    cb.onCursor?.(null);
  };

  const onDblClick = (): void => {
    cb.setView(null); // J4: get me back to the full view
  };

  // Swallow the click that ends a pan (capture phase, before the consumer's
  // click-to-inspect handler sees it); a stationary click passes straight through.
  const onClickCapture = (e: MouseEvent): void => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  };

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('dblclick', onDblClick);
  canvas.addEventListener('click', onClickCapture, true);

  return {
    destroy(): void {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endPan);
      canvas.removeEventListener('pointercancel', endPan);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('click', onClickCapture, true);
      canvas.classList.remove('panning');
    },
  };
}
