// Physics constants and helpers for the planar (downrange/altitude) model.
// Coordinates are Earth-centered polar: r = distance from Earth's center,
// theta = downrange arc angle. Altitude = r - R_E.

export const G0 = 9.80665; // standard gravity, m/s^2
export const MU = 3.986004418e14; // Earth gravitational parameter, m^3/s^2
export const R_E = 6.3781e6; // Earth radius (equatorial), m

// Drag: reference area for the 9 m diameter body, constant Cd (no Mach
// dependence; a transonic Cd spike would raise max-q into the real 30-32 kPa).
export const AREA = Math.PI * 4.5 * 4.5;
export const CD = 0.4;

// Atmosphere: two-segment exponential anchored to USSA-1976 values
// (ρ = 0.3648 @ 11 km, 0.0889 @ 20 km, 1.50e-3 @ 47 km). Drag only matters
// below ~60 km, where this sits within a few percent of the tables.
export const RHO0 = 1.225; // sea-level density, kg/m^3
export const H_LO = 8400; // scale height below 30 km, m
export const H_HI = 7100; // scale height from 30 to 86 km, m

export function airDensity(altM: number): number {
  if (altM <= 0) return RHO0;
  if (altM > 150_000) return 2.1e-9;
  if (altM <= 30_000) return RHO0 * Math.exp(-altM / H_LO);
  const rho30 = RHO0 * Math.exp(-30_000 / H_LO);
  return rho30 * Math.exp(-(altM - 30_000) / H_HI);
}

// Specific orbital elements of the osculating conic, used for the ship's
// SECO law and the orbit readout.
function conic(r: number, vr: number, vt: number): { energy: number; a: number; e: number } {
  const v2 = vr * vr + vt * vt;
  const energy = v2 / 2 - MU / r;
  if (energy >= 0) return { energy, a: Infinity, e: Infinity };
  const a = -MU / (2 * energy);
  const h = r * vt; // specific angular momentum (planar polar)
  const e2 = 1 + (2 * energy * h * h) / (MU * MU);
  return { energy, a, e: Math.sqrt(Math.max(0, e2)) };
}

// Apoapsis altitude above the surface, m. Infinity on escape trajectories.
export function apoapsisAlt(r: number, vr: number, vt: number): number {
  const { a, e } = conic(r, vr, vt);
  if (!Number.isFinite(a)) return Infinity;
  return a * (1 + e) - R_E;
}

// Periapsis altitude above the surface, m (negative for suborbital arcs).
export function periapsisAlt(r: number, vr: number, vt: number): number {
  const { a, e } = conic(r, vr, vt);
  if (!Number.isFinite(a)) return Infinity;
  return a * (1 - e) - R_E;
}
