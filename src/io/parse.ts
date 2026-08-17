/**
 * Fail-loud spectrum parser (the trust foundation, RISK-04).
 *
 * Supports two real-world encodings seen in the sample data:
 *   - Single-column ("TKA"): one number per line. Convention used by the lab's
 *     MCA exports is `[liveTimeSec, realTimeSec, count0, count1, ...]`.
 *   - Delimited ("CSV"): `channel,count` rows, optional header.
 *
 * A misaligned or non-numeric file must throw, never silently produce a
 * plausible-but-wrong spectrum.
 */
import type { Spectrum, SpectrumFormat, SpectrumMetadata } from '../domain/types';
import { ParseError } from '../domain/errors';

export interface ParseOptions {
  readonly fileName?: string;
  /** Force a format; otherwise inferred from content. */
  readonly format?: SpectrumFormat;
  /** Single-column header lines to read as [liveTime, realTime, ...]. Default 2. */
  readonly headerLines?: number;
  /** Size of the source file in bytes, captured at upload. */
  readonly fileSizeBytes?: number;
}

/**
 * Provenance fields recovered by the lightweight key-value header scan. SPE/IAEA
 * text exports and many lab text files carry these; plain TKA/CSV do not, so every
 * field stays null there. Times are filled ONLY when the numeric parse can't (the
 * numeric TKA header remains authoritative -- see `parseSingleColumn`).
 */
interface HeaderMeta {
  readonly detector: string | null;
  readonly sampleName: string | null;
  readonly measurementDate: string | null;
  readonly liveTimeSec: number | null;
  readonly realTimeSec: number | null;
}

// Case-insensitive header keys we recognise. Conservative by design: only lines
// shaped `KEY <:|=> VALUE` whose KEY is one of these are read; everything else is
// ignored so the numeric parser is unaffected.
const DETECTOR_KEYS = ['detector', '$det_id', 'det id', 'detector type'];
const SAMPLE_KEYS = ['sample', 'sample name', '$spec_id', 'sample id', 'title', 'description'];
const DATE_KEYS = ['date', '$date_mea', 'measurement date', 'acquired', 'start time'];

/** ISO-8601 when Date.parse succeeds, else the raw trimmed string (a truthful raw
 * value beats a wrong reformat). */
function normaliseDate(value: string): string {
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/**
 * Scan raw (pre-filter) file lines for provenance metadata. Runs for every format
 * before the numeric parse. Only recognised `KEY<sep>VALUE` lines are read; the
 * first value for each field wins. SPE `$MEAS_TIM:` carries `live real` on its own
 * value or the following line.
 */
function scanHeaderMeta(rawLines: readonly string[]): HeaderMeta {
  let detector: string | null = null;
  let sampleName: string | null = null;
  let measurementDate: string | null = null;
  let liveTimeSec: number | null = null;
  let realTimeSec: number | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const m = /^([$A-Za-z][\w $-]*?)\s*[:=]\s*(.*)$/.exec(rawLines[i].trim());
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === '$meas_tim' || key === 'meas_tim') {
      const raw = value || (i + 1 < rawLines.length ? rawLines[i + 1].trim() : '');
      const [lv, rl] = raw.split(/\s+/).map((p) => Number(p));
      if (Number.isFinite(lv) && Number.isFinite(rl)) {
        if (liveTimeSec == null) liveTimeSec = lv;
        if (realTimeSec == null) realTimeSec = rl;
      }
      continue;
    }
    if (value.length === 0) continue;
    if (detector == null && DETECTOR_KEYS.includes(key)) detector = value;
    else if (sampleName == null && SAMPLE_KEYS.includes(key)) sampleName = value;
    else if (measurementDate == null && DATE_KEYS.includes(key)) {
      measurementDate = normaliseDate(value);
    }
  }
  return { detector, sampleName, measurementDate, liveTimeSec, realTimeSec };
}

/** Pull an untrusted nuclide hint like "137Cs" -> "Cs-137" from a file name. */
export function nuclideHintFromName(fileName: string): string | null {
  const base = fileName.replace(/^.*[\\/]/, '');
  const m = /(\d{1,3})[ _-]?([A-Za-z]{1,2})\b/.exec(base);
  if (!m) return null;
  const mass = m[1];
  const sym = m[2][0].toUpperCase() + m[2].slice(1).toLowerCase();
  return `${sym}-${mass}`;
}

function toNumber(token: string, lineNo: number): number {
  const n = Number(token.trim());
  if (!Number.isFinite(n)) {
    throw new ParseError(`Line ${lineNo}: "${token}" is not a finite number.`);
  }
  return n;
}

function assertCounts(counts: readonly number[]): void {
  if (counts.length === 0) throw new ParseError('No channel data found.');
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (!Number.isFinite(c) || c < 0) {
      throw new ParseError(`Channel ${i}: count ${c} is not a non-negative number.`);
    }
  }
}

function looksDelimited(lines: readonly string[]): boolean {
  return lines.some((l) => l.includes(',') || l.includes('\t'));
}

/** Provenance carried from `parseSpectrum` into each branch: the header scan plus
 * the upload file size, so both encodings populate the new metadata identically. */
interface ParseContext {
  readonly header: HeaderMeta;
  readonly fileSizeBytes: number | null;
}

function parseDelimited(
  lines: readonly string[],
  fileName: string,
  ctx: ParseContext,
): Spectrum {
  const byChannel = new Map<number, number>();
  let maxChannel = -1;
  lines.forEach((line) => {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    if (parts.length < 2) return;
    const ch = Number(parts[0]);
    const ct = Number(parts[1]);
    if (!Number.isInteger(ch) || !Number.isFinite(ct)) return; // header / stray row
    byChannel.set(ch, ct);
    if (ch > maxChannel) maxChannel = ch;
  });
  if (maxChannel < 0) throw new ParseError('No "channel,count" rows found.');
  const counts = new Array<number>(maxChannel + 1).fill(0);
  for (const [ch, ct] of byChannel) counts[ch] = ct;
  assertCounts(counts);
  // CSV has no numeric time header, so any live/real can only come from the scan.
  return makeSpectrum(counts, {
    fileName,
    format: 'csv',
    liveTimeSec: ctx.header.liveTimeSec,
    realTimeSec: ctx.header.realTimeSec,
    statedNuclideHint: nuclideHintFromName(fileName),
    fileSizeBytes: ctx.fileSizeBytes,
    detector: ctx.header.detector,
    sampleName: ctx.header.sampleName,
    measurementDate: ctx.header.measurementDate,
  });
}

function parseSingleColumn(
  lines: readonly string[],
  fileName: string,
  headerLines: number,
  ctx: ParseContext,
): Spectrum {
  const nums = lines.map((l, i) => toNumber(l, i + 1));
  if (nums.length <= headerLines) {
    throw new ParseError(`File has ${nums.length} values; need more than ${headerLines}.`);
  }
  // The numeric TKA header is authoritative; the scanned times only fill a gap.
  const liveTimeSec = (headerLines >= 1 ? nums[0] : null) ?? ctx.header.liveTimeSec;
  const realTimeSec = (headerLines >= 2 ? nums[1] : null) ?? ctx.header.realTimeSec;
  const counts = nums.slice(headerLines);
  assertCounts(counts);
  if (liveTimeSec != null && realTimeSec != null && liveTimeSec > realTimeSec) {
    throw new ParseError(
      `Live time (${liveTimeSec}s) exceeds real time (${realTimeSec}s) -- header misread?`,
    );
  }
  return makeSpectrum(counts, {
    fileName,
    format: 'tka',
    liveTimeSec,
    realTimeSec,
    statedNuclideHint: nuclideHintFromName(fileName),
    fileSizeBytes: ctx.fileSizeBytes,
    detector: ctx.header.detector,
    sampleName: ctx.header.sampleName,
    measurementDate: ctx.header.measurementDate,
  });
}

/** The four provenance fields default to null so callers that lack them (only tests
 * do today) stay concise while every real parse threads them explicitly. */
type SpectrumMetaInput = Omit<
  SpectrumMetadata,
  'channelCount' | 'fileSizeBytes' | 'detector' | 'sampleName' | 'measurementDate'
> &
  Partial<Pick<SpectrumMetadata, 'fileSizeBytes' | 'detector' | 'sampleName' | 'measurementDate'>>;

function makeSpectrum(counts: readonly number[], meta: SpectrumMetaInput): Spectrum {
  return {
    counts,
    metadata: {
      ...meta,
      channelCount: counts.length,
      fileSizeBytes: meta.fileSizeBytes ?? null,
      detector: meta.detector ?? null,
      sampleName: meta.sampleName ?? null,
      measurementDate: meta.measurementDate ?? null,
    },
  };
}

/** Parse raw file text into a trusted Spectrum, or throw ParseError. */
export function parseSpectrum(text: string, options: ParseOptions = {}): Spectrum {
  const fileName = options.fileName ?? 'spectrum';
  const headerLines = options.headerLines ?? 2;
  // Scan the RAW split (before the #-comment / blank filter) so `$`-prefixed header
  // lines are visible to the provenance scan without reaching the numeric parser.
  const rawLines = text.split(/\r?\n/);
  const ctx: ParseContext = {
    header: scanHeaderMeta(rawLines),
    fileSizeBytes: options.fileSizeBytes ?? null,
  };
  const lines = rawLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) throw new ParseError('File is empty.');

  const delimited = options.format === 'csv' || (options.format == null && looksDelimited(lines));
  return delimited
    ? parseDelimited(lines, fileName, ctx)
    : parseSingleColumn(lines, fileName, headerLines, ctx);
}
