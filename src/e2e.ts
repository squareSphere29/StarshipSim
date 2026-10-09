// Headless end-to-end mission runs. Run with: npm run e2e (node src/e2e.ts)
//
// Four scenarios, one per flight shape the UI can produce. A full nominal
// mission, the booster engine-out divergence, the three burn outcomes at the
// apogee pause, and a render pass across the whole trajectory on stubbed
// canvases. Each check reports on its own so one failure does not hide the
// rest, same as the physics self-check.

import assert from 'node:assert/strict';
import { Sim, DT } from './sim.ts';
import { DEFAULT_CONFIG, type SimConfig } from './vehicle.ts';
import { Renderer } from './render.ts';

const NO_BURN = { held: false, retro: false };

const NOMINAL_EVENTS = [
  'LIFTOFF',
  'MAX-Q',
  'MECO',
  'HOT STAGING',
  'BOOSTBACK',
  'BOOSTBACK END',
  'LANDING BURN',
  'BOOSTER LANDED',
  'SECO',
  'APOGEE',
];

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

function runUntil(sim: Sim, pred: (s: Sim) => boolean, maxSteps = 800_000): void {
  let guard = 0;
  while (guard++ < maxSteps && !sim.ended && !pred(sim)) sim.step(NO_BURN);
}
function stepFor(sim: Sim, seconds: number, burn: { held: boolean; retro: boolean }): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n && !sim.ended; i++) sim.step(burn);
}
function holdUntil(
  sim: Sim,
  burn: { held: boolean; retro: boolean },
  pred: (s: Sim) => boolean,
  maxSteps = 400_000,
): void {
  let guard = 0;
  while (guard++ < maxSteps && !sim.ended && !pred(sim)) sim.step(burn);
}

// ---------------------------------------------------------------------------
// Scenario 1, full nominal mission.

const nominal = new Sim(DEFAULT_CONFIG);
nominal.jumpTo(6 * 3600);
const nominalOrder = nominal.events.map((e) => e.short).filter((s) => NOMINAL_EVENTS.includes(s));
const apoEvent = nominal.events.find((e) => e.short === 'APOGEE');
const nominalApoKm = apoEvent?.yKm ?? 0;

console.log('Starship sim end-to-end');
console.log('------------------------');
console.log(
  `S1 nominal   T+${nominal.t.toFixed(0)} s, ${nominalOrder.length}/${NOMINAL_EVENTS.length} events, ` +
    `apogee ${nominalApoKm.toFixed(0)} km, over ${nominal.missionOver}`,
);

check('nominal mission runs to completion', () => {
  assert.ok(nominal.missionOver, 'mission never completed');
  assert.ok(!nominal.crashed, 'mission ended in an impact');
  assert.ok(nominal.separated, 'the stack never separated');
});

check('nominal events come out in flight order', () => {
  assert.deepEqual(nominalOrder, NOMINAL_EVENTS);
});

check('booster boostback and landing burn end soft', () => {
  const soft = nominal.events.find((e) => e.short === 'BOOSTER LANDED');
  assert.ok(soft, 'no soft landing event');
  assert.ok(nominal.booster !== null && !nominal.booster.active, 'booster is still flying');
});

check('ship cuts off and coasts to its apogee pause', () => {
  assert.ok(nominal.secoDone, 'ship burn never ended');
  assert.ok(nominal.apogeePaused, 'no apogee pause');
  assert.ok(apoEvent, 'no apogee event');
  assert.ok(nominalApoKm > 250, `apogee ${nominalApoKm.toFixed(0)} km`);
});

// ---------------------------------------------------------------------------
// Scenario 2, booster engine-out divergence. Both configs are replayed to the
// nominal staging time so the divergence is measured at the same instant.

const ENGINE_OUTS = [0, 1, 2, 3, 4];
const sepT = nominal.events.find((e) => e.short === 'HOT STAGING')?.t ?? 0;
function stagingState(cfg: SimConfig): Sim {
  const s = new Sim(cfg);
  s.jumpTo(sepT + 0.1);
  assert.ok(s.separated, 'staging had not happened at the seek time');
  return s;
}
const nomSep = stagingState(DEFAULT_CONFIG);
const outSep = stagingState({ ...DEFAULT_CONFIG, boosterEngineOuts: ENGINE_OUTS });
const engineOut = new Sim({ ...DEFAULT_CONFIG, boosterEngineOuts: ENGINE_OUTS });
engineOut.jumpTo(6 * 3600);

console.log(
  `S2 engine-out staging alt ${nomSep.altKm.toFixed(1)} vs ${outSep.altKm.toFixed(1)} km, ` +
    `speed ${nomSep.speed.toFixed(0)} vs ${outSep.speed.toFixed(0)} m/s, over T+${engineOut.t.toFixed(0)} s`,
);

check('engine-out mission still reaches the end of the timeline', () => {
  assert.ok(engineOut.missionOver, 'mission never completed');
  assert.ok(!engineOut.crashed, 'mission ended in an impact');
  assert.ok(engineOut.secoDone, 'ship burn never ended');
  assert.ok(engineOut.events.some((e) => e.short === 'BOOSTER LANDED'), 'booster never landed');
});

check('dead booster engines stage the stack lower and slower', () => {
  assert.ok(
    nomSep.altKm - outSep.altKm > 5,
    `staging alt ${nomSep.altKm.toFixed(1)} vs ${outSep.altKm.toFixed(1)} km`,
  );
  assert.ok(
    nomSep.speed - outSep.speed > 50,
    `staging speed ${nomSep.speed.toFixed(0)} vs ${outSep.speed.toFixed(0)} m/s`,
  );
});

// ---------------------------------------------------------------------------
// Scenario 3, burn outcomes at the apogee pause.

const noBurn = new Sim(DEFAULT_CONFIG);
runUntil(noBurn, (s) => s.apogeePaused);
const pauseT = noBurn.t;
const apoAtPause = noBurn.apoKm;
stepFor(noBurn, 3600, NO_BURN);

const propOut = new Sim(DEFAULT_CONFIG);
runUntil(propOut, (s) => s.apogeePaused);
holdUntil(propOut, { held: true, retro: false }, (s) => s.ship !== null && s.ship.propS <= 0);

const deorbit = new Sim(DEFAULT_CONFIG);
runUntil(deorbit, (s) => s.apogeePaused);
holdUntil(deorbit, { held: true, retro: false }, (s) => s.periKm > 0);
const periCirc = deorbit.periKm;
stepFor(deorbit, 25, { held: true, retro: true });

console.log(
  `S3 apogee burns  no burn T+${noBurn.t.toFixed(0)} s splashdown, ` +
    `prop-out peri ${propOut.periKm.toFixed(0)} km, ` +
    `retro peri ${periCirc.toFixed(0)} to ${deorbit.periKm.toFixed(0)} km`,
);

check('no burn after apogee leaves the ship suborbital', () => {
  assert.ok(apoAtPause > 250, `apogee at the pause ${apoAtPause.toFixed(0)} km`);
  const splash = noBurn.events.find((e) => e.short === 'SHIP SPLASHDOWN');
  assert.ok(splash, 'ship never splashed down');
  assert.ok(splash!.t > pauseT, `splashdown at T+${splash!.t.toFixed(0)} s, before the pause`);
});

check('prograde burn to propellant exhaustion puts the ship in orbit', () => {
  assert.ok(propOut.ship !== null && propOut.ship.propS <= 0, 'propellant never ran out');
  assert.ok(propOut.periKm > 0, `perigee ${propOut.periKm.toFixed(0)} km`);
  assert.ok(!propOut.events.some((e) => e.short === 'SHIP SPLASHDOWN'), 'unexpected splashdown');
});

check('retrograde burn after circularization drops the perigee below zero', () => {
  assert.ok(periCirc > 0, `circular perigee ${periCirc.toFixed(0)} km`);
  assert.ok(
    deorbit.periKm < periCirc - 100,
    `perigee ${periCirc.toFixed(0)} to ${deorbit.periKm.toFixed(0)} km`,
  );
  assert.ok(deorbit.periKm < 0, `perigee after deorbit ${deorbit.periKm.toFixed(0)} km`);
});

// ---------------------------------------------------------------------------
// Scenario 4, render path smoke on stubbed canvases.

const ctxStub = new Proxy(
  {},
  {
    get: (_t, prop) =>
      prop === 'createLinearGradient' ? () => ({ addColorStop: () => {} }) : () => {},
  },
) as unknown as CanvasRenderingContext2D;
const canvasStub = () =>
  ({ getContext: () => ctxStub, width: 0, height: 0 }) as unknown as HTMLCanvasElement;

(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  innerWidth: 1600,
  innerHeight: 900,
};
const renderer = new Renderer(canvasStub(), canvasStub());

const RENDER_EVERY = 500;
const MIN_FRAMES = 12;
const drawn = new Sim(DEFAULT_CONFIG);
let frames = 0;
for (let i = 0; i < 400_000 && !drawn.missionOver; i += RENDER_EVERY) {
  for (let k = 0; k < RENDER_EVERY && !drawn.missionOver; k++) drawn.step(NO_BURN);
  renderer.draw(drawn, drawn.cfg);
  frames++;
}
const apogeeFrame = new Sim(DEFAULT_CONFIG);
runUntil(apogeeFrame, (s) => s.apogeePaused);
renderer.draw(apogeeFrame, apogeeFrame.cfg);
frames++;

console.log(
  `S4 render   ${frames} draws, every ${RENDER_EVERY} steps plus the apogee pause, no throw`,
);

check('renderer draws the whole mission without throwing', () => {
  assert.ok(frames >= MIN_FRAMES, `only ${frames} draws`);
  assert.ok(drawn.missionOver, 'render run never completed');
  assert.ok(apogeeFrame.apogeePaused, 'no apogee frame to draw');
  assert.ok(apogeeFrame.ship !== null, 'ship missing at the apogee frame');
});

console.log('------------------------');
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All checks passed.');
