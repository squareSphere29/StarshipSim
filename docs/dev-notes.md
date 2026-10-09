# Starship Launch Simulator

A browser-based sandbox that simulates a SpaceX Starship / Super Heavy launch —
liftoff to orbital insertion — with a SpaceX-webcast-style HUD. Set up the
vehicle, watch the physics play out, then take over the ship in orbit and decide
what burns to make.

Reference flight: **Starship Flight 14 (28 Sep 2026)**, Booster 21 + Ship 41,
the first sustained-orbit Starship flight.

## Run it

```bash
npm install
npm run dev        # open the printed URL (http://localhost:5173)
```

```bash
npm test           # headless physics self-check (20 assertions)
npm run build      # production bundle in dist/
```

## What you control

**Pre-launch (⚙ Settings drawer, slides in from the left):**

| Control | Effect |
|---|---|
| **Launch pitch** | Angle above the horizon at pad exit. Held until 160 m/s, then the stack flies a zero-AoA gravity turn (γ̇ = −g·cosγ/v — the law that matches the real ascent). |
| **Boost duration** | Seconds of booster main burn. Directly sets MECO and hot-staging time, and therefore the altitude/velocity at which staging happens. |
| **Propellant load** | Scales both stages' propellant — thrust-to-weight, staging state, Δv budgets. |
| **Dry mass** | Scales both stages' dry mass. |
| **Length** | Visual only: vehicle glyph size. Point-mass physics is indifferent. |

**Engines (ENGINES panel, fixed on the right):** click any engine to fail it
at ignition. Patterns match the real vehicles. Booster: 20 outer fixed engines
in a ring, two inner rings of 6 gimbaling engines, plus 1 center engine. Ship:
3 large sea-level engines in a triangle with 3 small vacuum engines in the
center. Dead engines make no thrust and burn no propellant for the rest of the
flight.

**In flight:** pause, ×1/×10/×100 time warp, ⏭ jump to next event.

**After SECO the ship is yours:** the sim auto-pauses at apogee and shows the
burn panel. **Hold to burn** (button or Spacebar) with a prograde/retrograde
toggle, limited by remaining propellant. Circularize, raise to a higher orbit,
deorbit, or do nothing and watch the suborbital arc come back down. The orbit
readout (apoapsis × periapsis) updates live — physics decides the outcome;
there is no score.

## What is simulated

- Point-mass bodies in Earth-centered polar coordinates (planar downrange
  plane only), central gravity (inverse-square), two-segment exponential
  atmosphere anchored to USSA-1976 values, drag, mass-depleting thrust from
  discrete engine groups. Fixed-step RK4 at 50 ms, with sub-step render
  interpolation so vehicles move smoothly at 60 Hz.
- Full mission sequence: 33-engine ascent (with pad-clearance throttle-down),
  MECO, the 2-second staging overlap (28 engines cut, 5 retained at reduced
  throttle), hot staging, ship main burn, booster boostback (reverses downrange
  velocity), landing burn (closed-form suicide burn), ship coast to apogee,
  user-driven insertion/deorbit burns.
- Ship main burn guidance: explicit feedback that flies the flight-path angle
  from its staging value to near-level over the burn — a TWR ≈ 0.9 stage cannot
  fly a natural gravity turn to orbit, so the burn computes the required
  pitch-up bias from the live thrust-to-weight.
- Ship burn ends when the osculating perigee reaches −1,000 km or propellant
  hits the 120 t reserve kept for the insertion burn.

Nominal profile (from the self-check): max-q T+~94 s · MECO T+2:20 ·
hot staging T+2:22 · boostback T+2:27 (~47 s) · booster soft landing T+~6:30 ·
ship SECO T+~8:20 · apogee pause ~311 km.

## Not modeled (declared)

- Out-of-plane dynamics: the roll-to-azimuth program is invisible in a 2-DOF
  planar sim, so it is omitted. No inclination, attitude, or gimbal dynamics.
- Reentry heating and structural failure: drag decelerates, nothing breaks.
- Mid-flight engine failures: engine-outs are selected pre-launch and fail at
  ignition. Throttle control, abort modes: not in v1.

## Calibration note

Vehicle numbers follow published Flight 14 specs (33 × Raptor 3, 80.8 MN
booster thrust, 3,650 t booster propellant, 5,690 t stack, TWR ≈ 1.45). Two
ship values are calibrated so the nominal mission reproduces Flight 14's
outcome — the published SECO state (~7,700 m/s at ~167 km with perigee ≈ −90 km,
which is what makes the 19 s insertion burn close the orbit) is not reachable
with the researched ship dry mass and propellant together: **ship dry mass
100 t** (V1 was ~85–100 t; the researched V3 figure of ~160 t is unofficial)
and **ship propellant 1,700 t**. Both are single constants in
`src/vehicle.ts` if you want to experiment.

## Layout

```
index.html          markup + all CSS
src/physics.ts      constants, atmosphere, drag, orbital elements
src/vehicle.ts      vehicle specs, engine slots, SimConfig
src/sim.ts          the simulation: integrator, mission state machine, events
src/render.ts       canvas: Earth arc, trajectories, vehicle glyphs
src/ui.ts           HUD, event strip, settings drawer, burn controls
src/main.ts         animation loop
src/selfcheck.ts    headless assertions (npm test)
GLOSSARY.md         domain vocabulary
```
