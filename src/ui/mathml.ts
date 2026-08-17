/**
 * A minimal, dependency-free MathML builder — just enough to typeset the Peak Finder teaching
 * formulas as REAL mathematics (italic identifiers, true raised exponents, fraction bars, and
 * √ radicals with a vinculum) instead of monospace "code" or plain body text. Native MathML
 * renders in every modern browser, needs no library, and is CSP-safe / fully offline.
 *
 * The builders return MathML markup strings; compose them and wrap the whole expression in
 * {@link math}. Multiplication is expressed by juxtaposition (adjacent factors in an `<mrow>`,
 * e.g. `A e^…`); an explicit centre dot is used only where the source formula shows one
 * (`m·x`). Function names (exp, log, min, Counts, …) use an upright `<mi mathvariant="normal">`
 * so they never render as a product of italic letters.
 *
 * Every formula below is symbolic (no runtime values), so they are module-level constants — the
 * single source of truth for how each step's headline equation is drawn. See the Peak Finder
 * stage markup in `app.ts` for where each is mounted.
 */

const ESC = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Identifier / variable — italic (the MathML default for a single-char `<mi>`). */
export const mi = (v: string): string => `<mi>${ESC(v)}</mi>`;
/** Number literal. */
export const mn = (v: string | number): string => `<mn>${ESC(String(v))}</mn>`;
/** Operator (spacing is supplied by the renderer per the MathML operator dictionary). */
export const mo = (v: string): string => `<mo>${ESC(v)}</mo>`;
/** Upright running text inside an expression (e.g. a word-valued quantity). */
export const mtext = (v: string): string => `<mtext>${ESC(v)}</mtext>`;
/** Upright multi-letter function / quantity name (exp, log, Counts, channel, …). */
export const fn = (v: string): string => `<mi mathvariant="normal">${ESC(v)}</mi>`;
/** Group. */
export const row = (...xs: string[]): string => `<mrow>${xs.join('')}</mrow>`;
/** Superscript (base then exponent). */
export const sup = (base: string, exp: string): string => `<msup>${base}${exp}</msup>`;
/** Fraction with a real bar (numerator then denominator). */
export const frac = (num: string, den: string): string => `<mfrac>${num}${den}</mfrac>`;
/** Radical with a vinculum. */
export const sqrt = (...xs: string[]): string => `<msqrt>${xs.join('')}</msqrt>`;
/** Parenthesised group — stretchy `(` … `)` operators around the contents. */
export const paren = (...xs: string[]): string => `${mo('(')}${xs.join('')}${mo(')')}`;

/**
 * Wrap a composed expression in a `<math>` root. `display: 'block'` centres it as its own line
 * (the per-step equation cards); `display: 'inline'` sits it in a run of prose. The `.pf-math`
 * class carries the shared math typography (see style.css).
 */
export const math = (inner: string, display: 'block' | 'inline' = 'block'): string =>
  `<math display="${display}" class="pf-math${display === 'inline' ? ' pf-math--inline' : ''}">${inner}</math>`;

// --- The Peak Finder formulas, one per surface, in pipeline order --------------------------

/** Peak Fitting — the Gaussian-on-linear-background model `y(x) = A e^(−(x−μ)²/2σ²) + m·x + b`. */
export const FX_FIT_MODEL = math(
  row(
    mi('y'),
    paren(mi('x')),
    mo('='),
    mi('A'),
    sup(
      mi('e'),
      row(
        mo('−'),
        frac(
          sup(paren(row(mi('x'), mo('−'), mi('μ'))), mn(2)),
          row(mn(2), sup(mi('σ'), mn(2))),
        ),
      ),
    ),
    mo('+'),
    mi('m'),
    mo('·'),
    mi('x'),
    mo('+'),
    mi('b'),
  ),
);

/** Model Components — the Gaussian peak term `A e^(−½((x−μ)/σ)²)`. */
export const FX_GAUSSIAN = math(
  row(
    mi('A'),
    sup(
      mi('e'),
      row(
        mo('−'),
        frac(mn(1), mn(2)),
        sup(paren(frac(row(mi('x'), mo('−'), mi('μ')), mi('σ'))), mn(2)),
      ),
    ),
  ),
  'inline',
);

/** Model Components — the linear background `m·x + b`. */
export const FX_LINEAR_BG = math(
  row(mi('m'), mo('·'), mi('x'), mo('+'), mi('b')),
  'inline',
);

/** Model Components — the Poisson weight `1 / √max(counts, 1)`. */
export const FX_POISSON = math(
  frac(mn(1), sqrt(row(fn('max'), paren(row(mtext('counts'), mo(','), mn(1)))))),
  'inline',
);

/** Peak Fitting note — `FWHM = 2.3548·σ`. */
export const FX_FWHM = math(
  row(fn('FWHM'), mo('='), mn('2.3548'), mo('·'), mi('σ')),
  'inline',
);

/** Peak Fitting note — the analytic Gaussian area `A·σ·√(2π)`. */
export const FX_GAUSS_AREA = math(
  row(mi('A'), mo('·'), mi('σ'), mo('·'), sqrt(row(mn(2), mi('π')))),
  'inline',
);

/** LLS Transform — `LLS(y) = log(log(√(y+1)+1)+1)`. */
export const FX_LLS = math(
  row(
    fn('LLS'),
    paren(mi('y')),
    mo('='),
    fn('log'),
    paren(
      row(
        fn('log'),
        paren(row(sqrt(row(mi('y'), mo('+'), mn(1))), mo('+'), mn(1))),
        mo('+'),
        mn(1),
      ),
    ),
  ),
);

/** Inverse LLS Transform — `Inverse-LLS(v) = (exp(exp(v)−1)−1)² − 1`. */
export const FX_INV_LLS = math(
  row(
    fn('Inverse-LLS'),
    paren(mi('v')),
    mo('='),
    sup(
      paren(
        row(
          fn('exp'),
          paren(row(fn('exp'), paren(mi('v')), mo('−'), mn(1))),
          mo('−'),
          mn(1),
        ),
      ),
      mn(2),
    ),
    mo('−'),
    mn(1),
  ),
);

/** SNIP Peak Clipping — one iteration `v(i) ← min(v(i), (v(i−p)+v(i+p))/2)`. */
export const FX_SNIP = math(
  row(
    mi('v'),
    paren(mi('i')),
    mo('←'),
    fn('min'),
    paren(
      row(
        mi('v'),
        paren(mi('i')),
        mo(','),
        frac(
          row(
            mi('v'),
            paren(row(mi('i'), mo('−'), mi('p'))),
            mo('+'),
            mi('v'),
            paren(row(mi('i'), mo('+'), mi('p'))),
          ),
          mn(2),
        ),
      ),
    ),
  ),
);

/** Net Spectrum — `Net Spectrum = Raw Spectrum − Background Spectrum`. */
export const FX_NET = math(
  row(
    mtext('Net Spectrum'),
    mo('='),
    mtext('Raw Spectrum'),
    mo('−'),
    mtext('Background Spectrum'),
  ),
);

/** Find Local Maxima — `Counts(i) > Counts(i−1)  and  Counts(i) > Counts(i+1)`. */
export const FX_LOCAL_MAXIMA = math(
  row(
    fn('Counts'),
    paren(mi('i')),
    mo('>'),
    fn('Counts'),
    paren(row(mi('i'), mo('−'), mn(1))),
    mtext(' and '),
    fn('Counts'),
    paren(mi('i')),
    mo('>'),
    fn('Counts'),
    paren(row(mi('i'), mo('+'), mn(1))),
  ),
);

/** Distance Gate — `keep(i) iff |channel(i) − channel(j)| ≥ ⌈distance⌉ for every taller kept j`. */
export const FX_DISTANCE_GATE = math(
  row(
    fn('keep'),
    paren(mi('i')),
    mtext(' iff '),
    mo('|'),
    fn('channel'),
    paren(mi('i')),
    mo('−'),
    fn('channel'),
    paren(mi('j')),
    mo('|'),
    mo('≥'),
    mo('⌈'),
    mtext('distance'),
    mo('⌉'),
    mtext(' for every taller kept '),
    mi('j'),
  ),
);
