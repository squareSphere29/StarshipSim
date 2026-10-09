# Starship Launch Simulator

## Notes: This was created just for fun, nothing serious and not focused on accuracy.

A browser-based sandbox that simulates a SpaceX Starship / Super Heavy launch,
from liftoff to orbital insertion, with a SpaceX-webcast-style HUD. Set up the
vehicle, watch the physics play out, then take over the ship in orbit and decide
what burns to make.

Reference flight: **Starship Flight 14 (28 Sep 2026)**, the first sustained-orbit
Starship flight.

## Run it

```bash
npm install
npm run dev        # open the printed URL (usually http://localhost:5173)
```

```bash
npm test           # physics self-checks
npm run e2e        # end-to-end mission scenarios
npm run build      # production bundle in dist/
```

## What you control

**Before launch** (⚙ settings panel, top right):

| Control | Effect |
|---|---|
| Launch pitch | Angle above the horizon at pad exit. The stack holds it, then flies a gravity turn. |
| Boost duration | Seconds of booster main burn. Sets when hot staging happens, and therefore the altitude and velocity at which it happens. |
| Propellant load | Scales both stages' propellant. Changes thrust-to-weight, staging state, and Δv budgets. |
| Dry mass | Scales both stages' dry mass. |
| Length | Visual only. Changes the vehicle glyph size, not the physics. |

**Engines** (ENGINE SELECT panel, left): click any engine to fail it at ignition.
The layouts match the real vehicles. Booster: 20 outer, 10 middle ring, 3 centre.
Ship: 3 large sea-level engines with 3 small vacuum engines clustered between
them. Dead engines make no thrust and burn no propellant.

**In flight:** pause, ×1/×10/×100/×1000 time warp, jump to the next event, and a
clickable event timeline to jump back and forward through the mission.

**After SECO the ship is yours.** The sim pauses at apogee and shows the burn
panel. Hold to burn with a prograde/retrograde toggle, limited by remaining
propellant. Circularise, raise the orbit, deorbit, or do nothing and watch the
suborbital arc come back down. The orbit readout (apoapsis × periapsis) updates
live. Physics decides the outcome. There is no score.

## What is simulated

- Point-mass vehicles in Earth-centred polar coordinates (planar downrange
  plane), inverse-square gravity, exponential-atmosphere drag, and
  mass-depleting thrust from discrete engine groups. Fixed-step RK4 at 50 ms.
- Full mission sequence: 33-engine ascent, MECO, hot staging, the ship's main
  burn, booster boostback, landing burn, coast to apogee, then your insertion,
  raising, or deorbit burns.
- Engine-out failures change the outcome: fewer engines means a slower, lower
  staging state and a tighter propellant budget downstream.

A nominal run looks like this: max-q around T+90 s, MECO at T+2:20, hot staging
at T+2:22, boostback burn, booster soft landing around T+6:30, ship SECO around
T+8:20, then the apogee pause where you decide the burn.

## What is not simulated

- Out-of-plane dynamics. No roll program, inclination, attitude, or gimbal
  dynamics. The sim is a 2-DOF side view.
- Reentry heating or structural failure. Drag decelerates, nothing breaks.
- Mid-flight engine failures. Engine-outs are selected pre-launch and fail at
  ignition.

## Project layout

```
index.html          markup + all CSS
src/physics.ts      constants, atmosphere, orbital elements
src/vehicle.ts      vehicle specs, engine slots, configuration
src/sim.ts          the simulation: integrator, mission state machine, events
src/render.ts       canvas: Earth disc, trajectories, vehicle glyphs
src/ui.ts           HUD, event timeline, settings, engine and burn panels
src/main.ts         animation loop
src/selfcheck.ts    physics assertions (npm test)
src/e2e.ts          mission scenarios (npm run e2e)
docs/dev-notes.md   developer notes: calibration, model details, agent files
```

## Calibration note

Vehicle numbers follow published Flight 14 specs (33 × Raptor 3, 3,650 t of
booster propellant). Two ship values are calibrated so the nominal mission
reproduces the flight's outcome: **ship dry mass 100 t** and **ship propellant
1,700 t**. Both are single constants in `src/vehicle.ts` if you want to
experiment. The full reasoning lives in `docs/dev-notes.md`.
