// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { mountBatchView, importTextFiles } from '../src/ui/batchView';
import { createBatchManager } from '../src/batch/batchManager';
import { syntheticTka } from '../src/data/synthetic';

/**
 * Phase 2/3 view: the batch DOM surface bound to a BatchManager, in happy-dom. The batch is a
 * Peak-Finder-style phase stepper (Import -> Review Queue -> Hand-off) with a Prev/Next footer,
 * so the queue + controls live on the Review Queue phase. These cover the empty/import phase,
 * navigating to the queue, import (good -> queued, bad -> quarantined failed), the Start control
 * driving the worker loop to settled, a row action via a delegated click, and the footer hand-off.
 */
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

function clickAction(container: HTMLElement, selector: string): void {
  const btn = container.querySelector(selector);
  expect(btn, `expected ${selector}`).not.toBeNull();
  btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Navigate the rail to a phase (0 Import · 1 Review Queue · 2 Hand-off). */
function goToPhase(container: HTMLElement, n: number): void {
  clickAction(container, `[data-action="phase"][data-phase="${n}"]`);
}

describe('batchView -- stepper shell + import', () => {
  it('starts on the Import phase with the add-files affordance and a Prev/Next footer', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    mountBatchView(container, mgr);

    expect(container.querySelector('.step-body')).not.toBeNull();
    expect(container.querySelector('.step-nav')).not.toBeNull(); // the footer
    expect(container.querySelector('[data-action="prev"]')).not.toBeNull();
    expect(container.querySelector('[data-action="next"]')).not.toBeNull();
    expect(container.querySelector('.batch-import')).not.toBeNull(); // Import panel
    expect(container.querySelector('.batch-row')).toBeNull(); // queue is on phase 1
  });

  it('shows queued rows on the Review Queue phase after import', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    mountBatchView(container, mgr);
    importTextFiles(mgr, [
      { name: 'a.tka', text: syntheticTka() },
      { name: 'b.tka', text: syntheticTka() },
    ]);
    goToPhase(container, 1);

    expect(container.querySelectorAll('.batch-row').length).toBe(2);
    expect(container.querySelectorAll('.batch-row--queued').length).toBe(2);
  });

  it('quarantines an unreadable file as a failed row (import never blocks)', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    mountBatchView(container, mgr);
    importTextFiles(mgr, [
      { name: 'good.tka', text: syntheticTka() },
      { name: 'bad.tka', text: 'abc' }, // non-numeric -> ParseError
    ]);
    goToPhase(container, 1);

    expect(container.querySelectorAll('.batch-row').length).toBe(2);
    const failed = container.querySelector('.batch-row--failed');
    expect(failed).not.toBeNull();
    expect(failed!.querySelector('.batch-row__error')!.textContent).not.toBe('');
    expect(container.querySelector('.batch-row--queued')).not.toBeNull();
  });
});

describe('batchView -- worker loop via the Start control', () => {
  it('Start drains the queue to settled with a live summary', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    mountBatchView(container, mgr);
    importTextFiles(mgr, [
      { name: 'a.tka', text: syntheticTka() },
      { name: 'b.tka', text: syntheticTka() },
    ]);
    goToPhase(container, 1);

    clickAction(container, '[data-action="start"]');
    vi.runAllTimers();

    expect(container.querySelectorAll('.batch-row--queued').length).toBe(0);
    const settled = container.querySelectorAll('.batch-row--done, .batch-row--warning');
    expect(settled.length).toBe(2);
    expect(container.textContent).toContain('2 of 2 ready');
  });
});

describe('batchView -- row actions survive re-render', () => {
  it('Exclude moves a settled row to excluded via a delegated click', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    mountBatchView(container, mgr);
    importTextFiles(mgr, [{ name: 'a.tka', text: syntheticTka() }]);
    goToPhase(container, 1);
    clickAction(container, '[data-action="start"]');
    vi.runAllTimers();

    clickAction(container, '[data-action="exclude"]');

    expect(container.querySelector('.batch-row--excluded')).not.toBeNull();
    expect(container.querySelector('[data-action="include"]')).not.toBeNull();
  });
});

describe('batchView -- Hand-off phase + footer', () => {
  it('Hand-off is reachable once settled; the footer Continue fires onContinue', () => {
    const mgr = createBatchManager();
    const container = makeContainer();
    let continued = 0;
    mountBatchView(container, mgr, { onContinue: () => continued++ });
    importTextFiles(mgr, [{ name: 'a.tka', text: syntheticTka() }]);
    goToPhase(container, 1);

    // before settling, the Hand-off rail row is locked (not clickable)
    expect(container.querySelector('.step-film-item.locked')).not.toBeNull();

    clickAction(container, '[data-action="start"]');
    vi.runAllTimers();

    // now Hand-off is reachable -> navigate there and press the footer's Continue (Next)
    goToPhase(container, 2);
    expect(container.textContent).toContain('Continue to Calibration');
    clickAction(container, '[data-action="next"]');
    expect(continued).toBe(1);
  });
});
