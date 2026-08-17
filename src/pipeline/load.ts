/** Stage 1 -- Load: parse a raw MCA file into a trusted Spectrum. */
import type { Spectrum, SpectrumFormat } from '../domain/types';
import { parseSpectrum, type ParseOptions } from '../io/parse';

export interface LoadInput {
  readonly text: string;
  readonly fileName: string;
  readonly format?: SpectrumFormat;
  readonly headerLines?: number;
  readonly fileSizeBytes?: number;
}

export function load(input: LoadInput): Spectrum {
  const opts: ParseOptions = {
    fileName: input.fileName,
    ...(input.format !== undefined ? { format: input.format } : {}),
    ...(input.headerLines !== undefined ? { headerLines: input.headerLines } : {}),
    ...(input.fileSizeBytes !== undefined ? { fileSizeBytes: input.fileSizeBytes } : {}),
  };
  return parseSpectrum(input.text, opts);
}
