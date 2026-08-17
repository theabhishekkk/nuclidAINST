/**
 * Calibration kit -- the known sources we calibrate *from* (Calibrate, C3/M2).
 *
 * Ported verbatim from the reference `ISOTOPE_LINES` (`isotope_lines.py`). These
 * energies are calibration-grade and each line carries the metadata the two-pass
 * fit needs:
 *   - `tier`: `anchor` (strong, isolated -> seeds the fit) vs `secondary`.
 *   - `reliable`: `false` marks a weak/buried line that is prunable from the fit.
 *
 * Kept separate from the *identify* library (`gamma_library.csv`, loaded by
 * `src/io/loadGammaLibrary.ts`): identify says "what an unknown could be";
 * the kit says "what we trust to calibrate". Data-driven (RISK-02): a new
 * calibration source is a new entry here, not new code.
 *
 * 7 isotopes, 20 lines. Note GAP-04: Am-241 and Ba-133 are in the kit (we can
 * calibrate from them) but are absent from the identify CSV, so they cannot yet
 * be *identified* -- intentional, the operator's call.
 */
import type { CalibrationKit } from '../domain/types';

export const CALIBRATION_KIT: CalibrationKit = {
  entries: [
    {
      id: 'Am-241',
      displayName: 'Americium-241',
      lines: [{ energyKeV: 59.541, tier: 'anchor', intensity: 0.36, reliable: true }],
    },
    {
      id: 'Co-57',
      displayName: 'Cobalt-57',
      lines: [
        { energyKeV: 122.061, tier: 'anchor', intensity: 0.86, reliable: true },
        { energyKeV: 136.474, tier: 'secondary', intensity: 0.11, reliable: true },
      ],
    },
    {
      id: 'Ba-133',
      displayName: 'Barium-133',
      lines: [
        { energyKeV: 80.998, tier: 'secondary', intensity: 0.34, reliable: true },
        { energyKeV: 276.398, tier: 'secondary', intensity: 0.072, reliable: true },
        { energyKeV: 302.853, tier: 'secondary', intensity: 0.18, reliable: true },
        { energyKeV: 356.013, tier: 'secondary', intensity: 0.62, reliable: true },
        { energyKeV: 383.851, tier: 'secondary', intensity: 0.089, reliable: true },
      ],
    },
    {
      id: 'Cs-137',
      displayName: 'Caesium-137',
      lines: [{ energyKeV: 661.657, tier: 'anchor', intensity: 0.85, reliable: true }],
    },
    {
      id: 'Mn-54',
      displayName: 'Manganese-54',
      lines: [{ energyKeV: 834.848, tier: 'anchor', intensity: 1.0, reliable: true }],
    },
    {
      id: 'Co-60',
      displayName: 'Cobalt-60',
      lines: [
        { energyKeV: 1173.228, tier: 'anchor', intensity: 1.0, reliable: true },
        { energyKeV: 1332.492, tier: 'anchor', intensity: 1.0, reliable: true },
      ],
    },
    {
      id: 'Eu-152',
      displayName: 'Europium-152',
      lines: [
        { energyKeV: 121.782, tier: 'secondary', intensity: 0.28, reliable: true },
        { energyKeV: 244.697, tier: 'secondary', intensity: 0.076, reliable: true },
        { energyKeV: 344.279, tier: 'secondary', intensity: 0.27, reliable: true },
        // High-energy Eu-152 lines: weak/buried -> not reliable for the fit.
        { energyKeV: 778.905, tier: 'secondary', intensity: 0.13, reliable: false },
        { energyKeV: 964.057, tier: 'secondary', intensity: 0.15, reliable: false },
        { energyKeV: 1085.837, tier: 'secondary', intensity: 0.1, reliable: false },
        { energyKeV: 1112.076, tier: 'secondary', intensity: 0.14, reliable: false },
        { energyKeV: 1408.013, tier: 'secondary', intensity: 0.21, reliable: false },
      ],
    },
  ],
};
