/**
 * Error taxonomy for Nuclid.
 *
 * Philosophy (carried from v3): "loud placeholders, not fakes" and a fail-loud
 * parser. A wrong/misaligned input must NOT pass as a plausible-but-wrong result,
 * and an unbuilt stage must fail loudly rather than return a fabricated answer.
 */

/** Base class so callers can `instanceof NuclidError` to separate domain faults
 * from unexpected runtime errors. */
export class NuclidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown by the fail-loud parser when input cannot be trusted as a spectrum. */
export class ParseError extends NuclidError {}

/** Thrown by a stage that is not yet implemented. Keeps the pipeline honest:
 * a stage either does the real work or refuses -- it never fabricates. */
export class NotImplementedError extends NuclidError {
  constructor(stage: string, detail = '') {
    super(
      `Stage "${stage}" is not implemented yet${detail ? `: ${detail}` : ''}. ` +
        `Nuclid refuses to fabricate a result for an unbuilt stage.`,
    );
  }
}

/** Thrown when a value violates a scientific/structural invariant. */
export class ValidationError extends NuclidError {}
