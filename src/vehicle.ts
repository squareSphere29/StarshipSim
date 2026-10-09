// Vehicle specs and user-facing simulation configuration.
// Reference values: SpaceX Starship Flight 14 (28 Sep 2026), Block 3 / V3
// vehicle, Booster 21 + Ship 41, as published by SpaceX, Wikipedia,
// NASASpaceflight and Spaceflight Now.

export const BOOSTER_OUTER = 20; // fixed (non-gimbaling) engines
export const BOOSTER_INNER = 13; // gimbaling engines
export const BOOSTER_ENGINES = BOOSTER_OUTER + BOOSTER_INNER; // 33

export const RAPTOR3_SL_THRUST = 2.45e6; // N, sea-level Raptor 3
export const RAPTOR3_SL_ISP = 350; // s
export const RAPTOR3_VAC_THRUST = 2.70e6; // N, vacuum Raptor 3
export const RAPTOR3_VAC_ISP = 380; // s

export const SPEC = {
  boosterDry: 275_000, // kg
  boosterProp: 3_650_000, // kg
  // Calibrated to reproduce Flight 14's outcome: with the researched V3 dry
  // mass (~160 t, unofficial) plus 1,600-1,700 t propellant, the ship's main
  // burn cannot reach the published SECO state (~7,700 m/s at ~167 km) that
  // makes the 19 s insertion burn close the orbit. A 100 t dry mass (V1 was
  // ~85-100 t) closes the arithmetic and the mission.
  shipDry: 100_000, // kg
  shipProp: 1_700_000, // kg
};

export interface EngineSlot {
  index: number;
  group: 'booster-outer' | 'booster-inner' | 'ship-sl' | 'ship-vac';
  label: string;
}

export function boosterSlots(): EngineSlot[] {
  const slots: EngineSlot[] = [];
  for (let i = 0; i < BOOSTER_ENGINES; i++) {
    slots.push({
      index: i,
      group: i < BOOSTER_OUTER ? 'booster-outer' : 'booster-inner',
      label: `B${i + 1}`,
    });
  }
  return slots;
}

export function shipSlots(): EngineSlot[] {
  const slots: EngineSlot[] = [];
  for (let i = 0; i < 6; i++) {
    slots.push({
      index: i,
      group: i < 3 ? 'ship-sl' : 'ship-vac',
      label: i < 3 ? `SL${i + 1}` : `RVAC${i - 2}`,
    });
  }
  return slots;
}

export interface SimConfig {
  /** Angle above the horizon at pad exit, degrees. */
  launchPitchDeg: number;
  /** Booster main-burn duration, s. Sets MECO and therefore hot staging. */
  boostDurationS: number;
  /** Multiplier on both stages' propellant load. */
  propScale: number;
  /** Multiplier on both stages' dry mass. */
  dryScale: number;
  /** Visual only: vehicle glyph size. No physics effect. */
  lengthScale: number;
  /** Booster engine indices (0-32) killed at ignition. */
  boosterEngineOuts: number[];
  /** Ship engine indices (0-2 sea-level, 3-5 vacuum) killed at ignition. */
  shipEngineOuts: number[];
}

export const DEFAULT_CONFIG: SimConfig = {
  launchPitchDeg: 87,
  boostDurationS: 140,
  propScale: 1,
  dryScale: 1,
  lengthScale: 1,
  boosterEngineOuts: [],
  shipEngineOuts: [],
};
