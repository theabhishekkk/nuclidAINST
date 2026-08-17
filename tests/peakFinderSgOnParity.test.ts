import { describe, it, expect } from 'vitest';

import { condition } from '../src/pipeline/condition';
import { detect } from '../src/pipeline/detect';
import { savitzkyGolay } from '../src/signal';
import type { Spectrum } from '../src/domain/types';

import Am241 from './fixtures/reference/sg_on/Am-241.json';
import Ba133 from './fixtures/reference/sg_on/Ba-133.json';
import Co57 from './fixtures/reference/sg_on/Co-57.json';
import Co60 from './fixtures/reference/sg_on/Co-60.json';
import Cs137 from './fixtures/reference/sg_on/Cs-137.json';
import Eu152 from './fixtures/reference/sg_on/Eu-152.json';
import Mn54 from './fixtures/reference/sg_on/Mn-54.json';

/**
 * SG-ON Peak Finder detection parity (DEBT-36 / O4). Pins the SG-ON path at the default
 * window 9 / polyorder 3 against an INDEPENDENT reference
 * (`capture_reference_detection_sg_on.py`, scipy/numpy via `Calibration Mode.py`'s
 * `snip_background` + scipy find_peaks/peak_widths) -- NOT captured TS output, so this is
 * a true golden test, not a tautology.
 *
 * The TS path reproduced here mirrors the manager's `run()` exactly:
 *   working    = clip(savitzkyGolay(rawCounts, 9, 3))        // Load-stage SG
 *   condition(working, { smoothing: 'none' })                 // no double-smooth (R4)
 *     -> background == snip_background(working), netCounts == net (detection series)
 *   detect(conditioned).channels == peaks
 *
 * Consumes ONLY the new sg_on/* fixtures; the existing detection/parity tests + their
 * fixtures are untouched.
 */

interface SgOnFixture {
  source: string;
  counts: number[];
  working_counts: number[];
  snip_background: number[];
  net: number[];
  peaks: number[];
  params: { savgol_window: number; savgol_polyorder: number };
}

const FIXTURES: SgOnFixture[] = [Am241, Ba133, Co57, Co60, Cs137, Eu152, Mn54];

/** The Load-stage working spectrum: clip-non-neg Savitzky-Golay of the raw counts,
 * exactly as `PeakFinderManager._recomputeWorking` builds it. */
function workingOf(f: SgOnFixture): Spectrum {
  const counts = savitzkyGolay(f.counts, f.params.savgol_window, f.params.savgol_polyorder).map(
    (v) => (v > 0 ? v : 0),
  );
  return {
    counts,
    metadata: {
      fileName: `${f.source}.TKA`,
      format: 'tka',
      liveTimeSec: null,
      realTimeSec: null,
      channelCount: counts.length,
      statedNuclideHint: null,
      fileSizeBytes: null,
      detector: null,
      sampleName: null,
      measurementDate: null,
    },
  };
}

const TOL = 1e-6; // matches the existing detection-parity tolerance

describe('Peak Finder SG-ON path -- TS savgol reproduces the reference working series', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: clip(savitzkyGolay(raw, 9, 3)) == working_counts`, () => {
      const working = workingOf(f);
      let worst = 0;
      for (let i = 0; i < f.working_counts.length; i++) {
        worst = Math.max(worst, Math.abs(working.counts[i] - f.working_counts[i]));
      }
      expect(worst, `${f.source} working worst |err| ${worst.toExponential(3)}`).toBeLessThanOrEqual(
        TOL,
      );
    });
  }
});

describe('Peak Finder SG-ON path -- condition({smoothing:none}) reproduces background + net', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: SNIP background and net (detection series) match`, () => {
      const cond = condition(workingOf(f), { smoothing: 'none' });
      let worstBg = 0;
      let worstNet = 0;
      for (let i = 0; i < f.counts.length; i++) {
        worstBg = Math.max(worstBg, Math.abs(cond.background[i] - f.snip_background[i]));
        worstNet = Math.max(worstNet, Math.abs(cond.netCounts[i] - f.net[i]));
      }
      // smoothing:'none' => the detection series IS netCounts (no second SG pass).
      expect(cond.smoothed).toEqual(cond.netCounts);
      expect(worstBg, `${f.source} background worst |err| ${worstBg.toExponential(3)}`).toBeLessThanOrEqual(TOL);
      expect(worstNet, `${f.source} net worst |err| ${worstNet.toExponential(3)}`).toBeLessThanOrEqual(TOL);
    });
  }
});

describe('Peak Finder SG-ON path -- detect() reproduces the fixture peaks', () => {
  for (const f of FIXTURES) {
    it(`${f.source}: condition({smoothing:none})->detect() channels equal fixture peaks`, () => {
      const peaks = detect(condition(workingOf(f), { smoothing: 'none' }));
      expect(peaks.map((p) => p.channel)).toEqual(f.peaks);
    });
  }
});
