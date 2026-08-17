/**
 * Seed nuclide reference library.
 *
 * Data-driven and element-agnostic: a new source is added as an entry here, not
 * as code elsewhere. Energies (keV) and intensities (emission probability per
 * decay) are characteristic gamma lines from standard decay-data references.
 * Covers the seven real sample sources currently on hand.
 */
import type { NuclideLibrary } from '../domain/types';

export const NUCLIDE_LIBRARY: NuclideLibrary = {
  entries: [
    {
      id: 'Am-241',
      displayName: 'Americium-241',
      halfLifeSec: 1.365e10,
      lines: [{ energyKeV: 59.541, intensity: 0.359 }],
    },
    {
      id: 'Co-57',
      displayName: 'Cobalt-57',
      halfLifeSec: 2.349e7,
      lines: [
        { energyKeV: 122.061, intensity: 0.856 },
        { energyKeV: 136.474, intensity: 0.1068 },
      ],
    },
    {
      id: 'Ba-133',
      displayName: 'Barium-133',
      halfLifeSec: 3.314e8,
      lines: [
        { energyKeV: 80.998, intensity: 0.329 },
        { energyKeV: 302.851, intensity: 0.1833 },
        { energyKeV: 356.013, intensity: 0.621 },
        { energyKeV: 383.851, intensity: 0.0894 },
      ],
    },
    {
      id: 'Cs-137',
      displayName: 'Caesium-137',
      halfLifeSec: 9.521e8,
      lines: [{ energyKeV: 661.657, intensity: 0.851 }],
    },
    {
      id: 'Mn-54',
      displayName: 'Manganese-54',
      halfLifeSec: 2.696e7,
      lines: [{ energyKeV: 834.848, intensity: 0.99976 }],
    },
    {
      id: 'Co-60',
      displayName: 'Cobalt-60',
      halfLifeSec: 1.663e8,
      lines: [
        { energyKeV: 1173.228, intensity: 0.9985 },
        { energyKeV: 1332.492, intensity: 0.999826 },
      ],
    },
    {
      id: 'Eu-152',
      displayName: 'Europium-152',
      halfLifeSec: 4.272e8,
      lines: [
        { energyKeV: 121.782, intensity: 0.2858 },
        { energyKeV: 344.279, intensity: 0.2659 },
        { energyKeV: 778.905, intensity: 0.1297 },
        { energyKeV: 964.057, intensity: 0.145 },
        { energyKeV: 1112.069, intensity: 0.1367 },
        { energyKeV: 1408.013, intensity: 0.2085 },
      ],
    },
  ],
};
