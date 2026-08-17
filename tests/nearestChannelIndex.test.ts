import { describe, it, expect } from 'vitest';
import { nearestChannelIndex, type ChartGeometry } from '../src/viz/spectrumChart';

/**
 * Unit battery for the forgiving click hit-test (Phase 4b). With this geometry the
 * channel->pixel map is `x = 10 + ch` (left 10, width 100, xMin 0, xMax 100), so
 * ch=10 -> x=20, ch=50 -> x=60, ch=90 -> x=100.
 */
const GEO: ChartGeometry = {
  left: 10,
  top: 0,
  width: 100,
  height: 50,
  n: 101,
  maxY: 1,
  logY: false,
  xMin: 0,
  xMax: 100,
  yMin: 0,
  yMax: 1,
};
const CHANNELS = [10, 50, 90];

describe('nearestChannelIndex', () => {
  it('selects the nearest channel when within tolerance', () => {
    // ch=50 -> x=60; click at 62 -> |Δ|=2 <= 6 -> index 1.
    expect(nearestChannelIndex(GEO, 62, CHANNELS)).toBe(1);
    // ch=10 -> x=20; click at 18 -> |Δ|=2 -> index 0.
    expect(nearestChannelIndex(GEO, 18, CHANNELS)).toBe(0);
  });

  it('returns null when the nearest is beyond the tolerance', () => {
    // click at 40 -> nearest is 20 px away (ch=10 or ch=50) > 6 -> null.
    expect(nearestChannelIndex(GEO, 40, CHANNELS)).toBeNull();
  });

  it('returns null for an empty channel list', () => {
    expect(nearestChannelIndex(GEO, 60, [])).toBeNull();
  });

  it('respects a custom tolerance', () => {
    // ch=50 -> x=60; click at 68 -> |Δ|=8.
    expect(nearestChannelIndex(GEO, 68, CHANNELS, 10)).toBe(1); // 8 <= 10
    expect(nearestChannelIndex(GEO, 68, CHANNELS, 5)).toBeNull(); // 8 > 5
  });

  it('returns null for a degenerate geometry (zero span or width)', () => {
    expect(nearestChannelIndex({ ...GEO, xMin: 5, xMax: 5 }, 60, CHANNELS)).toBeNull();
    expect(nearestChannelIndex({ ...GEO, width: 0 }, 60, CHANNELS)).toBeNull();
  });
});
