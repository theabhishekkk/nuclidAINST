// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { mountApp } from '../src/ui/app';

/**
 * Calibrate -- consolidated Assign-energies step (2026-07-07 redesign). The Configure
 * flow now runs the batch Peak Finder (`runPeakFinder`) on load and presents every
 * source's detected peaks in ONE consolidated table (`.di-table`, one `<tbody
 * class="di-group">` per source), where the scientist declares each source's identity
 * and assigns a known energy to each peak. Those assignments drive the fit
 * (`calibrateFromMatches`).
 *
 * This supersedes the earlier Declare-Identities Phase 3 journey (the per-source
 * `.di-nav` navigator + the embedded Peak Pipeline Inspector `.di-evidence`): that
 * navigator + embedded-inspector surface is retired here, along with the already-gone
 * `#calInspect` header entry and standalone `.inspector-mount`. Drives the REAL app
 * (`mountApp`) through the Build flow in happy-dom.
 */

let root: HTMLElement;
const q = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(sel)];
const btn = (t: string): HTMLButtonElement => {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent!.includes(t));
  if (!b) throw new Error(`button not found: ${t}`);
  return b as HTMLButtonElement;
};

beforeAll(() => {
  root = document.createElement('div');
  document.body.append(root);
  mountApp(root);
});

describe('Calibrate -- consolidated Assign-energies step (real app)', () => {
  it('the builder reaches a consolidated assign table; no navigator, no embedded inspector', () => {
    btn('Calibrate Mode').click();
    btn('New calibration').click();
    btn('Add synthetic demo').click();
    btn('Add synthetic demo').click();
    // Load step: no inspector entry, no fixed mount, no embedded evidence.
    expect(q('#calInspect')).toBeNull();
    expect(q('.inspector-mount')).toBeNull();
    expect(q('.di-evidence')).toBeNull();
    btn('Next').click(); // -> Assign energies (cfg-identity)
    // Pager view: one source on screen behind a prev/next pager, graph-on-top; the old
    // per-source navigator + embedded inspector + consolidated table are all retired.
    expect(q('.di-assign-view')).not.toBeNull();
    expect(q('.di-pager')).not.toBeNull();
    expect(q('#calAssignChart')).not.toBeNull();
    expect(q('.di-table')).toBeNull();
    expect(qa('.di-nav-item')).toHaveLength(0);
    expect(q('.di-active')).toBeNull();
    expect(q('.di-evidence')).toBeNull();
    expect(q('.inspector-panel')).toBeNull();
    expect(q('#calInspect')).toBeNull();
    // The active source shows its Rule-12 identity select (bounds the energy pick list).
    expect(q('.di-src-head .br-identity')).not.toBeNull();
  });

  it('declaring a source identity reveals its per-peak energy-assignment selects', () => {
    const idSel = q<HTMLSelectElement>('.di-src-head .br-identity');
    expect(idSel).not.toBeNull();
    // The pick list is bounded by the declared identity; pick the first real kit entry.
    const firstReal = [...idSel!.options].map((o) => o.value).find((v) => v !== '');
    expect(firstReal).toBeTruthy();
    idSel!.value = firstReal!;
    idSel!.dispatchEvent(new Event('change', { bubbles: true }));
    // The declared source's detected peaks now carry bounded energy selects.
    expect(qa('.di-assign').length).toBeGreaterThanOrEqual(1);
  });

  it('leaving Build resets the session: a fresh builder lands back on Load', () => {
    btn('Saved calibrations').click(); // builder -> Manager (reset trigger)
    btn('New calibration').click();
    // Fresh builder starts empty on Load -- no leftover assign view, no inspector.
    expect(q('.di-assign-view')).toBeNull();
    expect(q('.di-evidence')).toBeNull();
    expect(q('#calInspect')).toBeNull();
  });
});
