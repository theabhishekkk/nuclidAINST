import { describe, it, expect } from 'vitest';

import { spectrumOverview, peakFinderLoadMarkup } from '../src/ui/app';
import { createPeakFinderManager } from '../src/ui/peakFinderManager';

/**
 * The Load-stage "What did I upload?" redesign (HANDOFF 2026-07-05): the held Load
 * body renders four info cards below the (untouched) raw chart, from pre-processing
 * facts only. These tests cover the pure overview math, the file-size plumbing, and
 * the markup's conditional cards + the hard no-analysis-vocabulary constraint.
 */

// A CSV with no time header and no provenance keys: every acquisition field is null.
const BARE_CSV = ['channel,count', '0,4', '1,9', '2,2', '3,0'].join('\n');
// A header-bearing CSV: detector / sample / date present (still no live/real times).
const RICH_CSV = [
  '$SPEC_ID: Rock Sample A',
  '$DATE_MEA: 2024-03-15 14:30:00',
  'Detector: HPGe-1',
  'channel,count',
  '0,10',
  '1,25',
  '2,12',
].join('\n');

describe('spectrumOverview (Load-stage Spectrum Overview math)', () => {
  it('computes total / max / argmax / mean / nonZero in one pass', () => {
    const o = spectrumOverview([0, 5, 10, 3, 0]);
    expect(o.total).toBe(18);
    expect(o.max).toBe(10);
    expect(o.argmax).toBe(2);
    expect(o.mean).toBeCloseTo(3.6, 10);
    expect(o.nonZero).toBe(3);
    expect(o.channelCount).toBe(5);
  });
});

describe('mgr.load fileSizeBytes threading', () => {
  it('records the size into the held metadata, or null when omitted', () => {
    const withSize = createPeakFinderManager();
    withSize.load(BARE_CSV, 'bare.csv', 4096);
    expect(withSize.rawSpectrum?.metadata.fileSizeBytes).toBe(4096);

    const noSize = createPeakFinderManager();
    noSize.load(BARE_CSV, 'bare.csv');
    expect(noSize.rawSpectrum?.metadata.fileSizeBytes).toBeNull();
  });
});

describe('peakFinderLoadMarkup - held info region', () => {
  it('renders the always-present card titles', () => {
    const mgr = createPeakFinderManager();
    mgr.load(BARE_CSV, 'bare.csv');
    const html = peakFinderLoadMarkup(mgr);
    expect(html).toContain('Spectrum Overview');
    expect(html).toContain('File Information');
    expect(html).toContain('Data Quality');
    // The chart block is left in place, untouched.
    expect(html).toContain('id="pfLoadChart"');
  });

  it('omits the Acquisition card and File Size row when their data is null', () => {
    const mgr = createPeakFinderManager();
    mgr.load(BARE_CSV, 'bare.csv'); // no times, no provenance, no size
    const html = peakFinderLoadMarkup(mgr);
    expect(html).not.toContain('Acquisition Information');
    expect(html).not.toContain('File Size');
  });

  it('renders the Acquisition card and File Size row when data is present', () => {
    const mgr = createPeakFinderManager();
    mgr.load(RICH_CSV, 'rock.csv', 8192);
    const html = peakFinderLoadMarkup(mgr);
    expect(html).toContain('Acquisition Information');
    expect(html).toContain('Detector');
    expect(html).toContain('Sample Name');
    expect(html).toContain('Measurement Date');
    expect(html).toContain('File Size');
  });

  it('contains no later-stage analysis vocabulary (pre-processing only)', () => {
    const mgr = createPeakFinderManager();
    mgr.load(RICH_CSV, 'rock.csv', 8192);
    const html = peakFinderLoadMarkup(mgr).toLowerCase();
    for (const forbidden of [
      'savitzky',
      'smooth',
      'continuum',
      'snip',
      'background',
      'net',
      'peak',
      'fwhm',
      'significance',
      'calibrat',
      'identif',
      'quantif',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});
