# Nuclid v4

A **browser-only gamma-ray spectroscopy app** (TypeScript + Vite). It takes a raw
spectrum from a scintillation detector and walks it toward an identified
radionuclide -- showing every step a reviewer would check. Nothing is installed and
data never leaves the machine.

> **v4 is a clean re-architecture.** Same science and philosophy as v3, rebuilt as a
> small set of pure stage functions behind general, element-agnostic interfaces. It
> is **under active development**; downstream numbers are not yet validated.

**North Star:** from raw spectrum to identified nuclide -- every step shown.

## The pipeline

```
load -> condition -> detect -> fit -> validate -> calibrate -> identify -> quantify -> report
```

| Stage | Status in v4 | What it does |
|-------|--------------|--------------|
| load | built | Fail-loud parse of .TKA/.CSV into a trusted `Spectrum` |
| condition | built | SNIP background estimate + smoothing |
| detect | built | Local-maxima peak candidates above threshold |
| fit | stub (fails loud) | Gaussian fit -> centroid, FWHM, area, chi-square |
| validate | stub (fails loud) | Peak-quality gate |
| calibrate | math built, awaits anchors | Channel->energy least-squares fit |
| identify | math built, awaits energies | Match energies to the nuclide library |
| quantify | stub (fails loud) | Activity `A = N_net / (eff * p_gamma * t_live)` |
| report | built | Assemble a traced `AnalysisReport` |

Stubbed stages **throw** rather than fabricate a result -- see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the philosophy.

## Run it

```bash
npm install
npm run dev        # start the dev server
npm test           # run the unit tests (Vitest)
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```

Open the dev URL, then **Load synthetic demo** (no file needed) or drop in a real
`.TKA`/`.CSV` spectrum.

## Layout

```
src/
  domain/      types.ts, errors.ts   -- shared, element-agnostic contracts
  io/          parse.ts              -- fail-loud file parsing
  pipeline/    one file per stage + orchestrator.ts + index.ts
  data/        nuclides.ts (library), synthetic.ts (demo/test data)
  viz/         spectrumChart.ts      -- dependency-free canvas plot
  ui/          app.ts                -- minimal UI shell
tests/         parse.test.ts, pipeline.test.ts
```
