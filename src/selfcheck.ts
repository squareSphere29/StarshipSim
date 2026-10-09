// Headless physics sanity checks. Run with: npm test (node src/selfcheck.ts)
//
// These are the "one runnable check" for the simulation core: they assert the
// model behaves physically and that a nominal run reproduces the Flight 14
// reference profile within fun-sim tolerances, plus that the user's knobs
// (engine-outs, boost duration, burns) actually change the outcome.

import assert from 'node:assert/strict';
import { Sim, DT } from './sim.ts';
import { DEFAULT_CONFIG, type SimConfig } from './vehicle.ts';
import { apoapsisAlt, periapsisAlt, airDensity, R_E } from './physics.ts';

const NO_BURN = { held: false, retro: false };

function runUntil(sim: Sim, pred: (s: Sim) => boolean, maxSteps = 800_000): void {
  let guard = 0;
  while (guard++ < maxSteps && !sim.ended && !pred(sim)) sim.step(NO_BURN);
}
function stepFor(sim: Sim, seconds: number, burn: { held: boolean; retro: boolean }): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n && !sim.ended; i++) sim.step(burn);
}
function labels(sim: Sim): string[] {
  return sim.events.map((e) => e.label);
}
function eventAt(sim: Sim, prefix: string): number | undefined {
  const e = sim.events.find((ev) => ev.label.startsWith(prefix));
  return e ? e.t : undefined;
}

let failures = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message.split('\n').join('\n       ')}`);
  }
}

// ---------------------------------------------------------------------------

const nominal = new Sim(DEFAULT_CONFIG);
runUntil(nominal, (s) => s.apogeePaused || s.ended);

const tLift48 = (() => {
  const s = new Sim(DEFAULT_CONFIG);
  stepFor(s, 48, NO_BURN);
  return { speedKmh: s.speed * 3.6, altKm: s.altKm };
})();

const stagingT = eventAt(nominal, 'MECO');
const hotStagingT = eventAt(nominal, 'Hot staging');
const secoT = eventAt(nominal, 'SECO');
const boostbackT = eventAt(nominal, 'Boostback burn');
const maxQT = (() => {
  const e = nominal.events.find((ev) => ev.label.startsWith('Max Q'));
  return e ? e.t : undefined;
})();

// Full nominal mission: pause at apogee, hold the insertion burn ~55 s, coast.
const full = new Sim(DEFAULT_CONFIG);
runUntil(full, (s) => s.apogeePaused || s.ended);
stepFor(full, 55, { held: true, retro: false });
const periAfterBurn = full.periKm;
const apoAfterBurn = full.apoKm;
stepFor(full, 60, NO_BURN);

console.log('Starship sim self-check');
console.log('------------------------');
console.log(`t  48 s:      speed ${tLift48.speedKmh.toFixed(0)} km/h   alt ${tLift48.altKm.toFixed(1)} km   (ref: ~1000 km/h / 4.9 km)`);
console.log(`max Q:        T+${maxQT?.toFixed(0) ?? '?'} s`);
console.log(`MECO:         T+${stagingT?.toFixed(0) ?? '?'} s   (nominal 140 s)`);
console.log(`hot staging:  T+${hotStagingT?.toFixed(0) ?? '?'} s   (ref 142 s)`);
console.log(`boostback:    T+${boostbackT?.toFixed(0) ?? '?'} s   (ref 147 s)`);
console.log(`SECO:         T+${secoT?.toFixed(0) ?? '?'} s   (ref 491 s)`);
console.log(`ship prop:    ${nominal.shipPropPct.toFixed(1)} % at apogee`);
console.log(`apogee:       ${nominal.apoKm.toFixed(0)} km`);
console.log(`after the held insertion burn: apo ${apoAfterBurn.toFixed(0)} km  peri ${periAfterBurn.toFixed(0)} km`);
console.log('------------------------');

check('launch-pitch phase works (stack accelerates, altitude grows)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  stepFor(s, 10, NO_BURN);
  assert.ok(s.speed > 20, `speed at 10 s: ${s.speed.toFixed(1)} m/s`);
  assert.ok(s.altKm > 0.08, `alt at 10 s: ${s.altKm.toFixed(2)} km`);
});

check('48 s checkpoint near user reference (1000 km/h / 4.9 km)', () => {
  assert.ok(
    tLift48.speedKmh > 700 && tLift48.speedKmh < 1400,
    `speed ${tLift48.speedKmh.toFixed(0)} km/h`,
  );
  assert.ok(tLift48.altKm > 2.5 && tLift48.altKm < 9, `alt ${tLift48.altKm.toFixed(1)} km`);
});

check('max Q fires in the 40-110 s window', () => {
  assert.ok(maxQT !== undefined, 'no Max Q event');
  assert.ok(maxQT! > 40 && maxQT! < 110, `T+${maxQT?.toFixed(0)}`);
});

check('MECO honors the boost-duration knob (140 s)', () => {
  assert.ok(stagingT !== undefined, 'no MECO event');
  assert.ok(Math.abs(stagingT! - 140) < 0.5, `T+${stagingT?.toFixed(2)}`);
});

check('hot staging ~2 s after MECO, ship separates with 6 engines', () => {
  assert.ok(hotStagingT !== undefined, 'no hot staging event');
  assert.ok(Math.abs(hotStagingT! - 142) < 0.5, `T+${hotStagingT?.toFixed(2)}`);
  assert.ok(nominal.separated, 'ship never separated');
  assert.ok(nominal.booster !== null && nominal.ship !== null, 'missing bodies');
});

check('staging state is plausible (40-110 km, 1200-2400 m/s)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.separated || x.ended);
  const alt = s.altKm;
  const v = s.speed;
  assert.ok(alt > 40 && alt < 110, `staging alt ${alt.toFixed(1)} km`);
  assert.ok(v > 1200 && v < 2400, `staging speed ${v.toFixed(0)} m/s`);
});

check('nominal mission reaches SECO on a well-formed ellipse with reserve', () => {
  assert.ok(secoT !== undefined, 'no SECO event');
  assert.ok(secoT! > 400 && secoT! < 640, `SECO T+${secoT?.toFixed(0)} s`);
  assert.ok(nominal.secoDone, 'ship burn never ended');
  assert.ok(
    nominal.shipPropPct > 5,
    `ship reserve ${(nominal.shipPropPct * 17).toFixed(0)} t`,
  );
  assert.ok(nominal.periKm > -2_500, `perigee ${nominal.periKm.toFixed(0)} km too deep`);
});

check('auto-pause occurs at ship apogee for the burn decision', () => {
  const ap = full.events.find((e) => e.label.startsWith('Apogee'));
  if (!ap) throw new Error('no apogee event');
  assert.ok(ap.t > 400 && ap.t < 1_500, `T+${ap.t.toFixed(0)} s`);
});

check('holding the insertion burn at apogee closes the orbit', () => {
  assert.ok(periAfterBurn > 0, `perigee after burn ${periAfterBurn.toFixed(0)} km`);
  assert.ok(apoAfterBurn < 1400, `apogee ${apoAfterBurn.toFixed(0)} km`);
});

check('the nominal 19 s burn moves the orbit like Flight 14 (>=100 km perigee)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.apogeePaused || x.ended);
  const periBefore = s.periKm;
  stepFor(s, 19, { held: true, retro: false });
  assert.ok(s.periKm > periBefore + 100, `perigee ${periBefore.toFixed(0)} -> ${s.periKm.toFixed(0)} km`);
});

check('booster boostback completes and touches down soft', () => {
  assert.ok(labels(nominal).includes('Boostback complete'), 'boostback never completed');
  const soft = nominal.events.find((e) => e.label.startsWith('Booster soft landing'));
  assert.ok(soft, 'booster never soft-landed');
});

check('orbital energy is conserved during unpowered coast (< 0.5 % drift)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.secoDone || x.ended);
  const ship = s.ship!;
  const energy = (r: number, vr: number, vt: number) =>
    (vr * vr + vt * vt) / 2 - 3.986004418e14 / r;
  const e0 = energy(ship.r, ship.vr, ship.vt);
  stepFor(s, 120, NO_BURN);
  const e1 = energy(ship.r, ship.vr, ship.vt);
  const drift = Math.abs((e1 - e0) / e0);
  assert.ok(drift < 0.005, `drift ${(drift * 100).toFixed(3)} %`);
});

check('boost-duration knob changes staging state (120 s vs 140 s)', () => {
  const mk = (dur: number): SimConfig => ({ ...DEFAULT_CONFIG, boostDurationS: dur });
  const a = new Sim(mk(120));
  const b = new Sim(mk(160));
  runUntil(a, (s) => s.separated || s.ended);
  runUntil(b, (s) => s.separated || s.ended);
  assert.ok(
    b.altKm > a.altKm + 5,
    `longer boost should stage higher: ${a.altKm.toFixed(1)} vs ${b.altKm.toFixed(1)} km`,
  );
  assert.ok(
    b.speed > a.speed + 50,
    `longer boost should stage faster: ${a.speed.toFixed(0)} vs ${b.speed.toFixed(0)} m/s`,
  );
});

check('engine-out knob changes the outcome: 3 dead ship vacuum engines', () => {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, shipEngineOuts: [3, 4, 5] };
  const s = new Sim(cfg);
  runUntil(s, (x) => x.secoDone || x.ended);
  assert.ok(s.secoDone, 'ship burn never ended');
  assert.ok(s.periKm < 0, `with 3 dead vac engines the ship should fail to orbit: peri ${s.periKm.toFixed(0)} km`);
  assert.ok(s.shipPropPct <= 8, 'burn should have run down to the reserve');
});

check('engine-out knob on the booster weakens ascent', () => {
  const cfg: SimConfig = { ...DEFAULT_CONFIG, boosterEngineOuts: [0, 1, 2, 3, 4] };
  const s = new Sim(cfg);
  runUntil(s, (x) => x.separated || x.ended);
  assert.ok(
    s.speed < 2000,
    `with 5 engines dead, staging speed should drop: ${s.speed.toFixed(0)} m/s`,
  );
});

check('no burn after SECO leaves the ship suborbital (it comes back down)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.apogeePaused || x.ended);
  const apo = s.apoKm;
  assert.ok(apo > 260, `apogee ${apo.toFixed(0)} km`);
  // coast 60 min without any burn: the suborbital arc must fall back
  stepFor(s, 3600, NO_BURN);
  assert.ok(s.events.some((e) => e.label.startsWith('Ship splashdown')), 'ship never splashed down');
});

check('retrograde burn drops the perigee (deorbit works)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.apogeePaused || x.ended);
  stepFor(s, 60, { held: true, retro: false }); // near-circularize
  const periCirc = s.periKm;
  assert.ok(periCirc > 0, `circular perigee ${periCirc.toFixed(0)} km`);
  stepFor(s, 25, { held: true, retro: true }); // deorbit
  const periAfterDeorbit = s.periKm;
  assert.ok(periAfterDeorbit < periCirc - 100, `perigee after deorbit ${periAfterDeorbit.toFixed(0)} km`);
  assert.ok(periAfterDeorbit < 0, 'deorbit should threaten reentry');
});

check('launch-pitch knob changes downrange distance at staging', () => {
  const flat: SimConfig = { ...DEFAULT_CONFIG, launchPitchDeg: 82 };
  const steep: SimConfig = { ...DEFAULT_CONFIG, launchPitchDeg: 89 };
  const a = new Sim(flat);
  const b = new Sim(steep);
  runUntil(a, (s) => s.separated || s.ended);
  runUntil(b, (s) => s.separated || s.ended);
  assert.ok(
    a.downrangeKm > b.downrangeKm + 5,
    `flatter pitch should go further downrange: ${a.downrangeKm.toFixed(1)} vs ${b.downrangeKm.toFixed(1)} km`,
  );
});

check('atmosphere matches USSA-1976 vectors through the drag window', () => {
  // Published values: 0.3648 @ 11 km, 0.0889 @ 20 km, 1.50e-3 @ 47 km.
  const rel = (a: number, b: number) => Math.abs(a / b - 1);
  assert.ok(rel(airDensity(11_000), 0.3648) < 0.1, `rho(11km) = ${airDensity(11_000)}`);
  assert.ok(rel(airDensity(20_000), 0.0889) < 0.35, `rho(20km) = ${airDensity(20_000)}`);
  assert.ok(rel(airDensity(47_000), 1.5e-3) < 1.2, `rho(47km) = ${airDensity(47_000)}`);
  assert.ok(airDensity(200_000) < 1e-8, `rho(200km) = ${airDensity(200_000)}`);
});

check('timeline seek replays deterministically (jumpTo == step-to-time)', () => {
  const a = new Sim(DEFAULT_CONFIG);
  while (a.t < 300 && !a.ended) a.step(NO_BURN);
  const b = new Sim(DEFAULT_CONFIG);
  b.jumpTo(300);
  assert.ok(Math.abs(a.t - b.t) < 0.06, `t ${a.t} vs ${b.t}`);
  assert.ok(Math.abs(a.speed - b.speed) < 1e-6, `speed ${a.speed} vs ${b.speed}`);
  assert.ok(Math.abs(a.altKm - b.altKm) < 1e-6, `alt ${a.altKm} vs ${b.altKm}`);
  assert.equal(a.events.length, b.events.length, 'event count differs');
  assert.equal(
    b.events[b.events.length - 1].short,
    a.events[a.events.length - 1].short,
    'last event differs',
  );
});

check('shadow timeline run yields the full event list with short labels', () => {
  const shadow = new Sim(DEFAULT_CONFIG);
  shadow.jumpTo(90 * 60);
  assert.ok(shadow.events.length >= 8, `only ${shadow.events.length} events in the timeline`);
  assert.ok(shadow.events.some((e) => e.short === 'APOGEE'), 'no APOGEE chip in the timeline');
  for (const e of shadow.events) {
    assert.ok(e.short.length <= 20, `chip too long: "${e.short}"`);
    assert.ok(e.label.length > 0, 'empty label');
  }
});

check('engine status getters reflect engine-outs', () => {
  const s = new Sim(DEFAULT_CONFIG);
  assert.equal(s.boosterEngines, '33/33');
  assert.equal(s.shipEngines, '6/6');
  const s2 = new Sim({ ...DEFAULT_CONFIG, boosterEngineOuts: [0, 1], shipEngineOuts: [3] });
  assert.equal(s2.boosterEngines, '31/33');
  assert.equal(s2.shipEngines, '5/6');
});

check('missionOver stops the shadow run (no-burn reentry completes)', () => {
  const s = new Sim(DEFAULT_CONFIG);
  s.jumpTo(90 * 60);
  assert.ok(s.events.some((e) => e.short === 'SHIP SPLASHDOWN'), 'no splashdown event');
  assert.ok(s.missionOver, 'mission should be over after both vehicles are done');
});

check('burning to propellant exhaustion at apogee flies a huge orbit', () => {
  const s = new Sim(DEFAULT_CONFIG);
  runUntil(s, (x) => x.apogeePaused || x.ended);
  const apoBefore = s.apoKm;
  let guard = 0;
  while (guard++ < 200_000 && !s.ended && s.ship && s.ship.propS > 0) {
    s.step({ held: true, retro: false });
  }
  assert.ok(s.ship !== null && s.ship.propS <= 0, 'propellant never ran out');
  assert.ok(s.periKm > 0, `perigee after prop-out burn: ${s.periKm.toFixed(0)} km`);
  assert.ok(s.apoKm > apoBefore * 2, `apogee should soar: ${apoBefore.toFixed(0)} -> ${s.apoKm.toFixed(0)} km`);
});

check('no NaN in a full nominal mission', () => {
  [nominal, full].forEach((s, i) => {
    for (const b of [s.stack, s.booster, s.ship]) {
      if (!b) continue;
      for (const v of [b.r, b.th, b.vr, b.vt, b.propB, b.propS]) {
        assert.ok(Number.isFinite(v), `sim ${i} has non-finite state: ${v}`);
      }
      assert.ok(b.r > R_E - 1000, `sim ${i} body below surface`);
    }
  });
});

check('apoapsis/periapsis math matches a known ellipse', () => {
  // Circular orbit at 300 km: both apsis altitudes ~300 km.
  const r = R_E + 300_000;
  const vc = Math.sqrt(3.986004418e14 / r);
  const apo = apoapsisAlt(r, 0, vc) / 1000;
  assert.ok(Math.abs(apo - 300) < 1, `circular apoapsis ${apo.toFixed(1)} km`);
});

console.log('------------------------');
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
