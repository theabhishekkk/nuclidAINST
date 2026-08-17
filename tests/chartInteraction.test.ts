import { describe, it, expect } from 'vitest';
import {
  MIN_ZOOM_SPAN_CHANNELS,
  zoomXAboutChannel,
  panXByChannels,
  fitYToWindow,
  channelAtPixel,
  reprojectView,
  type XWindow,
} from '../src/viz/chartInteraction';
import type { ChartGeometry } from '../src/viz/spectrumChart';

/**
 * C0 -- pure chart-interaction view math (DESIGN_CHART_INTERACTION.md S4-5). Node-only;
 * the DOM binding is exercised by C1's browser gate. Covers the four transforms:
 * X-zoom about a focus, clamped pan, Y auto-fit to the window, pixel->channel inversion.
 */

// A 101-channel spectrum: full range [0, 100], fullSpan 100.
const N = 101;
const span = (w: XWindow): number => w.xMax - w.xMin;

/** A synthetic geometry with the documented forward map x = 60 + ch * 4 (left 60,
 * width 400, visible [0, 100]). */
function geo(over: Partial<ChartGeometry> = {}): ChartGeometry {
  return {
    left: 60,
    top: 14,
    width: 400,
    height: 300,
    n: N,
    maxY: 1,
    logY: false,
    xMin: 0,
    xMax: 100,
    yMin: 0,
    yMax: 1,
    ...over,
  };
}

describe('zoomXAboutChannel', () => {
  it('keeps the focus channel at the same relative position (off-centre focus)', () => {
    const w = zoomXAboutChannel(null, N, 30, 0.5)!; // full -> half span about ch 30
    expect(w).not.toBeNull();
    expect(w.xMin).toBeCloseTo(15, 9);
    expect(w.xMax).toBeCloseTo(65, 9);
    expect(span(w)).toBeCloseTo(50, 9);
    // relative position of the focus is preserved: (30 - 15) / 50 == 0.3 == (30 - 0)/100.
    expect((30 - w.xMin) / span(w)).toBeCloseTo(0.3, 9);
  });

  it('zooming from null (full view) works', () => {
    const w = zoomXAboutChannel(null, N, 50, 0.5)!;
    expect(w.xMin).toBeCloseTo(25, 9);
    expect(w.xMax).toBeCloseTo(75, 9);
  });

  it('repeated zoom-in clamps at MIN_ZOOM_SPAN_CHANNELS, then is a no-op', () => {
    let w: XWindow | null = null;
    for (let i = 0; i < 20; i++) w = zoomXAboutChannel(w, N, 50, 0.5);
    expect(w).not.toBeNull();
    expect(span(w!)).toBeCloseTo(MIN_ZOOM_SPAN_CHANNELS, 9);
    // One more zoom-in returns the same min-span window (no-op).
    const again = zoomXAboutChannel(w, N, 50, 0.5)!;
    expect(span(again)).toBeCloseTo(MIN_ZOOM_SPAN_CHANNELS, 9);
    expect(again.xMin).toBeCloseTo(w!.xMin, 9);
    expect(again.xMax).toBeCloseTo(w!.xMax, 9);
  });

  it('a single zoom-in below the floor clamps the span to the minimum', () => {
    const start: XWindow = { xMin: 45, xMax: 55 }; // span 10
    const w = zoomXAboutChannel(start, N, 50, 0.5)!; // 10*0.5 = 5 < 8 -> clamp to 8
    expect(span(w)).toBeCloseTo(MIN_ZOOM_SPAN_CHANNELS, 9);
  });

  it('zoom-out that reaches/exceeds the full range returns null', () => {
    expect(zoomXAboutChannel({ xMin: 40, xMax: 60 }, N, 50, 10)).toBeNull(); // 20*10 -> 200 >= 100
    expect(zoomXAboutChannel({ xMin: 25, xMax: 75 }, N, 50, 2)).toBeNull(); // 50*2 = 100 >= 100
  });

  it('a focus near an edge yields a window shifted inside [0, n-1] with span preserved', () => {
    // Sub-window at the right edge, zoom OUT about its left end: the naive window would
    // overrun n-1, so it shifts flush (not clip) and keeps span 16.
    const w = zoomXAboutChannel({ xMin: 90, xMax: 98 }, N, 90, 2)!;
    expect(w.xMin).toBeCloseTo(84, 9);
    expect(w.xMax).toBeCloseTo(100, 9);
    expect(span(w)).toBeCloseTo(16, 9);
    expect(w.xMin).toBeGreaterThanOrEqual(0);
    expect(w.xMax).toBeLessThanOrEqual(N - 1);
  });

  it('returns null for a degenerate full range (n < 2)', () => {
    expect(zoomXAboutChannel(null, 1, 0, 0.5)).toBeNull();
  });
});

describe('panXByChannels', () => {
  it('shifts both bounds by dChannels in the interior', () => {
    const w = panXByChannels({ xMin: 20, xMax: 60 }, N, 10);
    expect(w).toEqual({ xMin: 30, xMax: 70 });
  });

  it('clamps flush at the right edge, span preserved (shift-not-clip)', () => {
    const w = panXByChannels({ xMin: 20, xMax: 60 }, N, 60); // naive [80,120] -> [60,100]
    expect(w).toEqual({ xMin: 60, xMax: 100 });
    expect(span(w)).toBe(40);
  });

  it('clamps flush at the left edge, span preserved (shift-not-clip)', () => {
    const w = panXByChannels({ xMin: 20, xMax: 60 }, N, -40); // naive [-20,20] -> [0,40]
    expect(w).toEqual({ xMin: 0, xMax: 40 });
    expect(span(w)).toBe(40);
  });
});

describe('fitYToWindow', () => {
  const series = [
    [0, 5, 10, 3],
    [0, 8, 2, 1],
  ];

  it('takes the max over every series within the window slice', () => {
    // window [1,2] -> indices 1..2 -> {5,10} and {8,2} -> 10.
    expect(fitYToWindow(series, { xMin: 1, xMax: 2 })).toEqual({ yMin: 0, yMax: 10 });
  });

  it('null window fits to the whole series', () => {
    expect(fitYToWindow(series, null)).toEqual({ yMin: 0, yMax: 10 });
  });

  it('floors yMax at 1 for an all-zero slice', () => {
    expect(fitYToWindow([[0, 0, 0, 0]], null)).toEqual({ yMin: 0, yMax: 1 });
  });

  it('slices fractional window bounds on ceil(xMin)..floor(xMax)', () => {
    // [1.2, 3.7] -> indices ceil(1.2)=2 .. floor(3.7)=3 -> {200,300}; excludes 100 and 400.
    expect(fitYToWindow([[0, 100, 200, 300, 400]], { xMin: 1.2, xMax: 3.7 })).toEqual({
      yMin: 0,
      yMax: 300,
    });
  });
});

describe('channelAtPixel', () => {
  it('inverts the forward map to the nearest integer channel (interior)', () => {
    expect(channelAtPixel(geo(), 260)).toBe(50); // 60 + 50*4
    expect(channelAtPixel(geo(), 263)).toBe(51); // 50.75 -> 51
  });

  it('is inclusive at both plot edges', () => {
    expect(channelAtPixel(geo(), 60)).toBe(0); // x == left
    expect(channelAtPixel(geo(), 460)).toBe(100); // x == left + width
  });

  it('returns null left of the plot rect', () => {
    expect(channelAtPixel(geo(), 59)).toBeNull();
  });

  it('returns null right of the plot rect', () => {
    expect(channelAtPixel(geo(), 461)).toBeNull();
  });

  it('returns null for degenerate geometry (width 0 or xMax <= xMin)', () => {
    expect(channelAtPixel(geo({ width: 0 }), 200)).toBeNull();
    expect(channelAtPixel(geo({ xMin: 50, xMax: 50 }), 200)).toBeNull();
  });
});

describe('reprojectView (Phase 4a subject-switch reprojection)', () => {
  it('null in -> null out (full view stays full)', () => {
    expect(reprojectView(null, 1024)).toBeNull();
  });

  it('same domain / window already inside -> returned unchanged (same values)', () => {
    const v: XWindow = { xMin: 100, xMax: 300 };
    expect(reprojectView(v, 1024)).toEqual({ xMin: 100, xMax: 300 });
    // Window inside a SMALLER domain is also preserved untouched.
    expect(reprojectView({ xMin: 5, xMax: 20 }, 32)).toEqual({ xMin: 5, xMax: 20 });
  });

  it('partially outside a smaller target -> shifted inside, span preserved, flush at the edge', () => {
    // Target domain [0, 31]; window [20, 40] (span 20) -> shift down to [11, 31].
    expect(reprojectView({ xMin: 20, xMax: 40 }, 32)).toEqual({ xMin: 11, xMax: 31 });
  });

  it('window as wide as / wider than the target domain -> null (reset to full)', () => {
    expect(reprojectView({ xMin: 0, xMax: 31 }, 32)).toBeNull(); // span == fullSpan
    expect(reprojectView({ xMin: 100, xMax: 900 }, 512)).toBeNull(); // wider
  });

  it('degenerate target (nChannels < 2) -> null', () => {
    expect(reprojectView({ xMin: 0, xMax: 4 }, 1)).toBeNull();
    expect(reprojectView({ xMin: 0, xMax: 4 }, 0)).toBeNull();
  });
});
