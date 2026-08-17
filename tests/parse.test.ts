import { describe, it, expect } from 'vitest';
import { parseSpectrum, nuclideHintFromName } from '../src/io/parse';
import { deadTimeFraction } from '../src/domain/types';
import { ParseError } from '../src/domain/errors';

describe('parseSpectrum - single column (TKA)', () => {
  it('reads the live/real time header then counts', () => {
    const text = ['1800', '1872', '0', '5', '10', '3'].join('\n');
    const s = parseSpectrum(text, { fileName: '137Cs-4cm.TKA' });
    expect(s.metadata.format).toBe('tka');
    expect(s.metadata.liveTimeSec).toBe(1800);
    expect(s.metadata.realTimeSec).toBe(1872);
    expect(s.counts).toEqual([0, 5, 10, 3]);
    expect(s.metadata.channelCount).toBe(4);
    expect(s.metadata.statedNuclideHint).toBe('Cs-137');
  });

  it('computes the dead-time fraction', () => {
    const s = parseSpectrum(['1800', '1872', '1', '2', '3'].join('\n'));
    const dt = deadTimeFraction(s.metadata);
    expect(dt).not.toBeNull();
    expect(dt!).toBeCloseTo(1 - 1800 / 1872, 6);
  });

  it('fails loud on non-numeric data', () => {
    expect(() => parseSpectrum('hello\nworld\nfoo')).toThrow(ParseError);
  });

  it('fails loud when live time exceeds real time', () => {
    expect(() => parseSpectrum(['2000', '1800', '1', '2', '3'].join('\n'))).toThrow(ParseError);
  });

  it('fails loud on an empty file', () => {
    expect(() => parseSpectrum('   \n  \n')).toThrow(ParseError);
  });
});

describe('parseSpectrum - delimited (CSV)', () => {
  it('reads channel,count rows and skips the header', () => {
    const text = ['channel,count', '0,0', '1,4', '2,9', '3,2'].join('\n');
    const s = parseSpectrum(text, { fileName: 'x.csv' });
    expect(s.metadata.format).toBe('csv');
    expect(s.counts).toEqual([0, 4, 9, 2]);
  });
});

describe('parseSpectrum - provenance header scan (Load-stage metadata)', () => {
  it('leaves detector/sampleName/measurementDate null for a plain TKA file', () => {
    const s = parseSpectrum(['1800', '1872', '0', '5', '10', '3'].join('\n'), {
      fileName: 'plain.TKA',
    });
    expect(s.metadata.detector).toBeNull();
    expect(s.metadata.sampleName).toBeNull();
    expect(s.metadata.measurementDate).toBeNull();
    // The numeric header still owns live/real -- the scan does not disturb it.
    expect(s.metadata.liveTimeSec).toBe(1800);
    expect(s.metadata.realTimeSec).toBe(1872);
  });

  it('extracts detector / sample / date from a header, ISO-normalising the date', () => {
    const text = [
      '$SPEC_ID: Rock Sample A',
      '$DATE_MEA: 2024-03-15 14:30:00',
      'Detector: HPGe-1',
      'channel,count',
      '0,10',
      '1,25',
      '2,12',
    ].join('\n');
    const s = parseSpectrum(text, { fileName: 'rock.csv' });
    expect(s.metadata.format).toBe('csv');
    expect(s.counts).toEqual([10, 25, 12]);
    expect(s.metadata.detector).toBe('HPGe-1');
    expect(s.metadata.sampleName).toBe('Rock Sample A');
    expect(s.metadata.measurementDate).toBe(new Date('2024-03-15 14:30:00').toISOString());
  });

  it('keeps an unparseable date as the raw trimmed string', () => {
    const text = ['Date = last Tuesday', 'channel,count', '0,1', '1,2'].join('\n');
    const s = parseSpectrum(text, { fileName: 'x.csv' });
    expect(s.metadata.measurementDate).toBe('last Tuesday');
  });
});

describe('parseSpectrum - fileSizeBytes threading', () => {
  it('records the size when provided and null when omitted', () => {
    const text = ['1800', '1872', '1', '2', '3'].join('\n');
    expect(parseSpectrum(text, { fileSizeBytes: 4096 }).metadata.fileSizeBytes).toBe(4096);
    expect(parseSpectrum(text).metadata.fileSizeBytes).toBeNull();
  });
});

describe('nuclideHintFromName', () => {
  it('parses 137Cs -> Cs-137', () => {
    expect(nuclideHintFromName('137Cs-4cm-1800s-no1.TKA')).toBe('Cs-137');
  });
  it('returns null when no nuclide token is present', () => {
    expect(nuclideHintFromName('unknown-sample.TKA')).toBeNull();
  });
});
