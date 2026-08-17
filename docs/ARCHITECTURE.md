# Nuclid v4 -- Architecture

A deliberately small, layered re-architecture. The goal is that the *shape* of the
code makes the science trustworthy, not faith in any one isotope.

## Layers

```
domain/   Pure data contracts (types) + the error taxonomy. No logic, no DOM.
io/       parse.ts -- turns raw file text into a trusted Spectrum, or throws.
pipeline/ One pure function per stage. Each takes a general input and returns a
          general output. orchestrator.ts composes them and produces a trace.
data/     nuclides.ts (the library) and synthetic.ts (demo/test fixtures).
viz/+ui/  Presentation only. They read pipeline outputs; they never compute science.
```

Dependencies point inward: `ui -> pipeline -> io -> domain`. The domain layer
depends on nothing.

## Three rules that earn trust

1. **Element-agnostic by construction (RISK-02).** Every interface is general -- a
   peak *list*, an *N*-point calibration, an *N*-nuclide library. Adding a source is
   a *data* change (`data/nuclides.ts`), never a code change. Cs-137 is a fixture,
   not a baked-in answer.

2. **Fail loud, never fake (RISK-04).** `io/parse.ts` rejects a misaligned or
   non-numeric file instead of passing a plausible-but-wrong spectrum. Unbuilt
   stages throw `NotImplementedError` rather than returning a guess. The orchestrator
   marks such stages `skipped` with an explicit reason in the trace.

3. **One stage at a time, deep.** A stage is built, tested, and browser-checked
   before the next. The orchestrator lights up stages only as they become real, so
   the UI always reflects the honest state of the pipeline.

## Data contract (the spine)

A `Spectrum` is `counts[channel]` plus metadata (live/real time, channel count, an
**untrusted** nuclide hint from the file name). Everything downstream is derived:

```
Spectrum
  -> ConditionedSpectrum { background, netCounts, smoothed }
  -> PeakCandidate[]      (detect)
  -> FittedPeak[]         (fit; energyKeV filled only after calibrate)
  -> Calibration          (channel -> energy, from known anchors)
  -> PeakIdentification[] (energies matched to the library)
  -> ActivityEstimate[]   (needs an efficiency curve)
  -> AnalysisReport       (+ StageTrace[])
```

## The keystone ahead: GATE-C

Real **calibrate** and **quantify** need more than one known source: multi-point
calibration, an efficiency curve, and a multi-nuclide library. Bringing in a second
real source with *only added data* (no code reshaping) is the milestone that proves
the architecture generalizes. The `fitCalibration` / `identify` math is already in
place and unit-tested; what is gated is the multi-source *data*, by design.
