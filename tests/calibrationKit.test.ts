import { describe, it, expect } from 'vitest';
import { CALIBRATION_KIT } from '../src/data/calibrationKit';

const byId = new Map(CALIBRATION_KIT.entries.map((e) => [e.id, e]));
const allLines = CALIBRATION_KIT.entries.flatMap((e) => e.lines);

describe('CALIBRATION_KIT - shape', () => {
  it('has 7 isotopes', () => {
    expect(CALIBRATION_KIT.entries).toHaveLength(7);
    expect([...byId.keys()].sort()).toEqual([
      'Am-241',
      'Ba-133',
      'Co-57',
      'Co-60',
      'Cs-137',
      'Eu-152',
      'Mn-54',
    ]);
  });

  it('has 20 lines in total', () => {
    expect(allLines).toHaveLength(20);
  });

  it('every line has a valid tier, an intensity in (0,1], and a positive energy', () => {
    for (const l of allLines) {
      expect(['anchor', 'secondary']).toContain(l.tier);
      expect(l.energyKeV).toBeGreaterThan(0);
      expect(l.intensity).toBeGreaterThan(0);
      expect(l.intensity).toBeLessThanOrEqual(1);
      expect(typeof l.reliable).toBe('boolean');
    }
  });
});

describe('CALIBRATION_KIT - tier metadata', () => {
  it('Am-241, Cs-137 and Mn-54 each have a single anchor line', () => {
    for (const id of ['Am-241', 'Cs-137', 'Mn-54']) {
      const e = byId.get(id)!;
      expect(e.lines).toHaveLength(1);
      expect(e.lines[0].tier).toBe('anchor');
      expect(e.lines[0].reliable).toBe(true);
    }
  });

  it('Co-60 has two anchor lines', () => {
    const co = byId.get('Co-60')!;
    expect(co.lines).toHaveLength(2);
    expect(co.lines.every((l) => l.tier === 'anchor')).toBe(true);
  });

  it('Co-57 has an anchor (122 keV) and a secondary (136 keV)', () => {
    const co = byId.get('Co-57')!;
    expect(co.lines).toHaveLength(2);
    expect(co.lines[0]).toMatchObject({ energyKeV: 122.061, tier: 'anchor' });
    expect(co.lines[1]).toMatchObject({ energyKeV: 136.474, tier: 'secondary' });
  });

  it('there are exactly 6 anchor lines across the kit', () => {
    expect(allLines.filter((l) => l.tier === 'anchor')).toHaveLength(6);
  });
});

describe('CALIBRATION_KIT - reliability', () => {
  it("Eu-152 marks its 5 high-energy lines reliable=false, keeps 3 reliable", () => {
    const eu = byId.get('Eu-152')!;
    expect(eu.lines).toHaveLength(8);
    const unreliable = eu.lines.filter((l) => !l.reliable).map((l) => l.energyKeV);
    expect(unreliable).toEqual([778.905, 964.057, 1085.837, 1112.076, 1408.013]);
    expect(eu.lines.filter((l) => l.reliable)).toHaveLength(3);
  });

  it('the 5 unreliable lines are the only unreliable ones in the whole kit', () => {
    expect(allLines.filter((l) => !l.reliable)).toHaveLength(5);
  });
});
