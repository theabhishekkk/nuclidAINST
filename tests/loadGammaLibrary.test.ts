import { describe, it, expect } from 'vitest';
// `?raw` (typed via vite/client) loads the shipped CSV as text, so the test
// exercises the real operator file without needing node:fs types.
import REAL_CSV from '../public/sample-data/gamma_library.csv?raw';
import { parseGammaLibrary } from '../src/io/loadGammaLibrary';
import { ParseError } from '../src/domain/errors';

describe('parseGammaLibrary - the real gamma_library.csv', () => {
  const lib = parseGammaLibrary(REAL_CSV);

  it('groups into 8 isotopes', () => {
    expect(lib.entries).toHaveLength(8);
    expect(lib.entries.map((e) => e.id)).toEqual([
      'Cs-137',
      'Co-57',
      'Co-60',
      'Mn-54',
      'Na-22',
      'Eu-152',
      'Ba-133',
      'Am-241',
    ]);
  });

  it('carries 27 lines in total', () => {
    const total = lib.entries.reduce((n, e) => n + e.lines.length, 0);
    expect(total).toBe(27);
  });

  it('preserves per-isotope line counts (Co-57 has 3, Eu-152 has 13, Ba-133 has 4, Am-241 has 1)', () => {
    const byId = new Map(lib.entries.map((e) => [e.id, e]));
    expect(byId.get('Cs-137')!.lines).toHaveLength(1);
    expect(byId.get('Co-57')!.lines).toHaveLength(3);
    expect(byId.get('Co-60')!.lines).toHaveLength(2);
    expect(byId.get('Mn-54')!.lines).toHaveLength(1);
    expect(byId.get('Na-22')!.lines).toHaveLength(2);
    expect(byId.get('Eu-152')!.lines).toHaveLength(13);
    expect(byId.get('Ba-133')!.lines).toHaveLength(4);
    expect(byId.get('Am-241')!.lines).toHaveLength(1);
  });

  it('normalises intensity percent -> fraction (Cs-137 85.10% -> 0.851)', () => {
    const cs = lib.entries.find((e) => e.id === 'Cs-137')!;
    expect(cs.lines[0].energyKeV).toBeCloseTo(661.657, 3);
    expect(cs.lines[0].intensity).toBeCloseTo(0.851, 6);
  });

  it('does NOT clamp the Na-22 511 keV annihilation line (179.8% -> 1.798)', () => {
    const na = lib.entries.find((e) => e.id === 'Na-22')!;
    const ann = na.lines.find((l) => Math.abs(l.energyKeV - 511) < 0.5)!;
    expect(ann.intensity).toBeCloseTo(1.798, 6);
    expect(ann.intensity).toBeGreaterThan(1); // physically correct, exceeds [0,1]
  });

  it('sets halfLifeSec null (not present in the identify CSV)', () => {
    expect(lib.entries.every((e) => e.halfLifeSec === null)).toBe(true);
  });
});

describe('parseGammaLibrary - parsing rules', () => {
  it('skips # comment lines and the header', () => {
    const csv = ['# a comment', 'Nuclide,Energy_keV,Intensity_%', '# another', 'Cs137,661.657,85.10'].join(
      '\n',
    );
    const lib = parseGammaLibrary(csv);
    expect(lib.entries).toHaveLength(1);
    expect(lib.entries[0].id).toBe('Cs-137');
  });

  it('canonicalises the nuclide token (Co57 -> Co-57)', () => {
    const lib = parseGammaLibrary(['Nuclide,Energy_keV,Intensity_%', 'Co57,122.06,85.6'].join('\n'));
    expect(lib.entries[0].id).toBe('Co-57');
  });
});

describe('parseGammaLibrary - fails loud (RISK-04)', () => {
  const header = 'Nuclide,Energy_keV,Intensity_%';

  it('throws on a row with the wrong column count', () => {
    expect(() => parseGammaLibrary([header, 'Cs137,661.657'].join('\n'))).toThrow(ParseError);
  });

  it('throws on a non-numeric energy', () => {
    expect(() => parseGammaLibrary([header, 'Cs137,abc,85.10'].join('\n'))).toThrow(ParseError);
  });

  it('throws on a non-numeric intensity', () => {
    expect(() => parseGammaLibrary([header, 'Cs137,661.657,high'].join('\n'))).toThrow(ParseError);
  });

  it('throws on an unrecognizable nuclide token', () => {
    expect(() => parseGammaLibrary([header, '12345,661.657,85.10'].join('\n'))).toThrow(ParseError);
  });

  it('throws when there are no data rows at all', () => {
    expect(() => parseGammaLibrary([header].join('\n'))).toThrow(ParseError);
  });
});
