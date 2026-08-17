// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  derivePeakFinderSteps,
  peakFinderStepperRailMarkup,
  PF_BOUNDARY_STAGES,
} from '../src/ui/peakFinderStepper';
import { pfBoundaryStatus } from '../src/ui/app';

/**
 * Workflow-boundary appendix (2026-07-07). Two pure surfaces:
 *  - the rail appendix (peakFinderStepperRailMarkup): a "Next: Calibration" divider + three
 *    locked-but-CLICKABLE `data-boundary` rows that are NOT `aria-disabled` (unlike the inert
 *    pipeline `locked` rows), always present, with `activeBoundary` moving the `.current` mark;
 *  - the boundary page current-status derivation (pfBoundaryStatus): report-absent vs
 *    report-present vs validated.
 * Both are channel-space-only view concerns -- no manager, no STEP_META coupling.
 */

// A model with nothing reached (fresh load: focus + reached on the first step).
const freshModel = derivePeakFinderSteps({ reached: 0, focus: 0 });

describe('peakFinderStepperRailMarkup -- workflow-boundary appendix', () => {
  it('always emits the divider and all three boundary rows, even before a spectrum loads', () => {
    const html = peakFinderStepperRailMarkup(freshModel, { hasSpectrum: false });
    expect(html).toContain('pf-rail-divider');
    expect(html).toContain('Next: Calibration');
    for (const stage of PF_BOUNDARY_STAGES) {
      expect(html).toContain(`data-boundary="${stage.id}"`);
      expect(html).toContain(stage.label);
    }
    // Exactly three boundary rows.
    expect(html.match(/data-boundary=/g)).toHaveLength(3);
  });

  it('renders boundary rows as clickable (role/tabindex), NOT aria-disabled', () => {
    const html = peakFinderStepperRailMarkup(freshModel, { hasSpectrum: true });
    // Isolate each boundary row and assert it is a keyboard-reachable button with no aria-disabled.
    for (const stage of PF_BOUNDARY_STAGES) {
      const row = new RegExp(
        `<li class="step-film-item pf-boundary[^"]*" data-boundary="${stage.id}"[^>]*>`,
      ).exec(html);
      expect(row, `row for ${stage.id}`).not.toBeNull();
      const tag = row![0];
      expect(tag).toContain('role="button"');
      expect(tag).toContain('tabindex="0"');
      expect(tag).not.toContain('aria-disabled');
    }
  });

  it('activeBoundary marks that row `.current` and suppresses pipeline `.current`', () => {
    const active = peakFinderStepperRailMarkup(freshModel, {
      hasSpectrum: true,
      activeBoundary: 'radionuclide-id',
    });
    // The chosen boundary row carries `.current`...
    expect(active).toMatch(
      /<li class="step-film-item pf-boundary current" data-boundary="radionuclide-id"/,
    );
    // ...and no pipeline step row (data-step) is `.current` while a boundary is active.
    expect(active).not.toMatch(/class="step-film-item[^"]*current[^"]*" data-step=/);
  });

  it('without activeBoundary, the focused pipeline step keeps `.current` and no boundary row does', () => {
    const normal = peakFinderStepperRailMarkup(freshModel, { hasSpectrum: true });
    // The focused pipeline step is `.current`.
    expect(normal).toMatch(/class="step-film-item[^"]*current[^"]*" data-step=/);
    // No boundary row is `.current`.
    expect(normal).not.toMatch(/pf-boundary current/);
  });

  it('reserves rail width for the boundary labels (sizer ghosts)', () => {
    const html = peakFinderStepperRailMarkup(freshModel, { hasSpectrum: false });
    const sizer = /<li class="pf-rail-sizer"[\s\S]*?<\/li>/.exec(html)?.[0] ?? '';
    for (const stage of PF_BOUNDARY_STAGES) {
      expect(sizer).toContain(stage.label);
    }
  });
});

describe('pfBoundaryStatus -- current-status derivation', () => {
  it('report absent: all three pipeline rows are Not started; calibration waits', () => {
    const rows = pfBoundaryStatus(false, false);
    expect(rows.map((r) => r.state)).toEqual(['todo', 'todo', 'todo', 'wait']);
    expect(rows[0].note).toBe('Not started');
    expect(rows[3].note).toBe('Waiting for Calibration Mode');
  });

  it('report present (no validated): detection + measurement done, validation not started', () => {
    const rows = pfBoundaryStatus(true, false);
    expect(rows.map((r) => r.state)).toEqual(['done', 'done', 'todo', 'wait']);
    expect(rows[0].note).toBe('Complete');
    expect(rows[2].note).toBe('Not started');
  });

  it('validated: the three pipeline rows are all done; calibration still waits', () => {
    const rows = pfBoundaryStatus(true, true);
    expect(rows.map((r) => r.state)).toEqual(['done', 'done', 'done', 'wait']);
    expect(rows[2].note).toBe('Complete');
    // Detector calibration never flips to done from channel-space state.
    expect(rows[3].state).toBe('wait');
  });
});
