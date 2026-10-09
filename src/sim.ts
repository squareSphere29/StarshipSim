// Mission simulation.
//
// Model: point-mass bodies in Earth-centered polar coordinates (r, theta) with
// central gravity, exponential-atmosphere drag, and mass-depleting thrust from
// discrete engine groups. Integrated with fixed-step RK4. This is 2-DOF: the
// downrange plane only; no attitude, inclination, or gimbal dynamics.
//
// Mission flow (nominal, Flight 14 reference):
//   liftoff (33 booster engines) -> MECO (28 cut, 5 remain at reduced
//   throttle) -> hot staging (+2 s, ship's 6 engines ignite, bodies split) ->
//   booster coasts, boostback burn (reverse downrange velocity), coast, landing
//   burn (soft touchdown) -> ship burns to a well-formed ellipse (SECO) ->
//   coast to apogee (auto-pause) -> user-driven burns (circularization,
//   raising, deorbit) from a single engine.

import {
  G0,
  MU,
  R_E,
  AREA,
  CD,
  airDensity,
  apoapsisAlt,
  periapsisAlt,
} from './physics.ts';
import {
  DEFAULT_CONFIG,
  SPEC,
  BOOSTER_OUTER,
  BOOSTER_ENGINES,
  RAPTOR3_SL_THRUST,
  RAPTOR3_SL_ISP,
  RAPTOR3_VAC_THRUST,
  RAPTOR3_VAC_ISP,
} from './vehicle.ts';
import type { SimConfig } from './vehicle.ts';

export const DT = 0.05; // physics step, s
export const SEPARATION_DELAY = 2; // s between MECO and hot staging
export const V_TURN = 160; // m/s; launch pitch held until this speed, then gravity turn
export const PITCH_BLEND_S = 2.5; // seconds to blend from the launch-pitch hold to the turn
export const ATT_TAU = 0.5; // seconds; low-pass on the displayed vehicle attitude
export const GAMMA_FLOOR = 10 * (Math.PI / 180); // pitch never scheduled below this
export const SHIP_PITCH_SCHED_S = 440; // ship burn: seconds to ramp staging attitude to near-level
export const SHIP_PITCH_FINAL_GAMMA = -3 * (Math.PI / 180); // SECO nearly level, slight nose-down
export const BOOSTBACK_START_DELAY = 5; // s after separation
export const BOOSTBACK_MAX_S = 90;
export const BOOSTBACK_ENGINES = 13; // inner, gimbaling set
export const BOOSTBACK_THROTTLE = 0.6;
export const OVERLAP_ENGINES = 5;
export const OVERLAP_THROTTLE = 0.6;
export const LANDING_ENGINES = 11;
export const LANDING_ALT = 30_000; // m; burn starts high enough to stop the fall
export const SHIP_TARGET_PERIGEE = -1_000_000; // m; main burn ends on a well-formed ellipse
export const SHIP_BURN_RESERVE = 120_000; // kg kept for the user's insertion burn
export const SAMPLE_INTERVAL = 0.25; // s between trajectory samples
export const SPEED_OF_SOUND = 300; // m/s, rough constant for the Mach display

export type EventKind = 'info' | 'good' | 'warn' | 'bad' | 'burn';
export interface EventRec {
  t: number;
  label: string;
  short: string;
  kind: EventKind;
  xKm?: number;
  yKm?: number;
}
export interface Sample {
  xKm: number;
  yKm: number;
}
export interface BurnInput {
  held: boolean;
  retro: boolean;
}

export interface Body {
  r: number;
  th: number;
  vr: number;
  vt: number;
  propB: number;
  propS: number;
  dryB: number;
  dryS: number;
  active: boolean;
  thrustN: number;
  /** Position at the start of the last physics step, for render interpolation. */
  pr: number;
  pth: number;
  /** Smoothed commanded attitude (radians above the horizon), for the glyph. */
  att: number;
}

interface Plan {
  pool: 'B' | 'S';
  count: number;
  thrustPer: number;
  isp: number;
}
type Vec = { r: number; t: number };
type Steer = (vr: number, vt: number) => Vec;
type ThrottleFn = (alt: number, speed: number, vr: number, mass: number) => number;

const unitV = (r: number, t: number): Vec => {
  const m = Math.hypot(r, t) || 1;
  return { r: r / m, t: t / m };
};

/** Low-pass a commanded attitude toward its target, shortest angular path. */
function smoothAtt(b: Body, target: number, dt: number): number {
  let d = target - b.att;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return b.att + d * Math.min(1, dt / ATT_TAU);
}
const gravityTurn: Steer = (vr, vt) => unitV(vr, vt);
const retrograde: Steer = (vr, vt) => {
  const u = unitV(vr, vt);
  return { r: -u.r, t: -u.t };
};
const verticalUp: Steer = () => ({ r: 1, t: 0 });
const holdFloor: Vec = { r: Math.sin(GAMMA_FLOOR), t: Math.cos(GAMMA_FLOOR) };
/** Boostback: burn straight back along the ground track (cancel downrange). */
const transverseBack: Steer = () => ({ r: 0, t: -1 });
/** User burns: horizontal thrust. Prograde along the ground track raises the
 *  far side of the orbit without steepening a falling trajectory. */
const transverse: Steer = () => ({ r: 0, t: 1 });

/** Ascent throttle: brief tower/pad-clearance throttle-down, then full. */
function ascentThrottle(alt: number): number {
  if (alt < 800) return 0.85; // just past tower clear; real vehicles recover speed fast
  return 1;
}
/** Landing burn: closed-form "suicide burn" that stops the fall at touchdown. */function landingThrottle(alt: number, mass: number, maxThrust: number, vr: number): number {
  if (maxThrust <= 0 || vr >= 0) return 0;
  const aReq = (vr * vr) / (2 * Math.max(50, alt)) + G0;
  return Math.min(1, Math.max(0, (aReq * mass) / maxThrust));
}

function groupAccel(
  r: number,
  vr: number,
  vt: number,
  propB: number,
  propS: number,
  dryB: number,
  dryS: number,
  plans: Plan[],
  dirR: number,
  dirT: number,
  throttle: number,
): { ar: number; at: number; flowB: number; flowS: number; thrust: number } {
  const mass = Math.max(1, dryB + dryS + propB + propS);
  let thrust = 0;
  let flowB = 0;
  let flowS = 0;
  for (const p of plans) {
    const f = p.thrustPer * p.count * throttle;
    thrust += f;
    const flow = f / (p.isp * G0);
    if (p.pool === 'B') flowB += flow;
    else flowS += flow;
  }
  const ar = (thrust * dirR) / mass - MU / (r * r) + (vt * vt) / r;
  const at = (thrust * dirT) / mass - (vr * vt) / r;
  const speed = Math.hypot(vr, vt);
  if (speed > 1e-6) {
    const rho = airDensity(r - R_E);
    if (rho > 0) {
      const ad = (0.5 * rho * speed * speed * CD * AREA) / mass;
      return {
        ar: ar - (ad * vr) / speed,
        at: at - (ad * vt) / speed,
        flowB,
        flowS,
        thrust,
      };
    }
  }
  return { ar, at, flowB, flowS, thrust };
}

/** One fixed-step RK4 integration of a body. Returns thrust for telemetry. */
function stepBody(b: Body, plansIn: Plan[], steer: Steer, throttle: ThrottleFn, dt: number): number {
  // Prop-limited thrust: an empty tank makes no thrust. Scaling is done once
  // per step from the step-start propellant (fine at dt = 50 ms).
  const plans = limitPlans(plansIn, b.propB, b.propS, dt);
  const f = (y: number[]): number[] => {
    const [r, , vr, vt, propB, propS] = y;
    const alt = r - R_E;
    const speed = Math.hypot(vr, vt);
    const mass = b.dryB + b.dryS + propB + propS;
    const thq = Math.min(1, Math.max(0, throttle(alt, speed, vr, mass)));
    const dir = steer(vr, vt);
    const a = groupAccel(r, vr, vt, propB, propS, b.dryB, b.dryS, plans, dir.r, dir.t, thq);
    return [vr, vt / r, a.ar, a.at, -a.flowB, -a.flowS];
  };
  const y0 = [b.r, b.th, b.vr, b.vt, b.propB, b.propS];
  const k1 = f(y0);
  const y1 = y0.map((v, i) => v + (dt / 2) * k1[i]);
  const k2 = f(y1);
  const y2 = y1.map((v, i) => v + (dt / 2) * k2[i]);
  const k3 = f(y2);
  const y3 = y2.map((v, i) => v + dt * k3[i]);
  const k4 = f(y3);
  const yf = y0.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  b.r = yf[0];
  b.th = yf[1];
  b.vr = yf[2];
  b.vt = yf[3];
  b.propB = Math.max(0, yf[4]);
  b.propS = Math.max(0, yf[5]);
  const dir = steer(b.vr, b.vt);
  const mass = b.dryB + b.dryS + b.propB + b.propS;
  const a = groupAccel(
    b.r,
    b.vr,
    b.vt,
    b.propB,
    b.propS,
    b.dryB,
    b.dryS,
    plans,
    dir.r,
    dir.t,
    Math.min(1, Math.max(0, throttle(b.r - R_E, Math.hypot(b.vr, b.vt), b.vr, mass))),
  );
  b.thrustN = a.thrust;
  return a.thrust;
}

/** Scale engine counts so a step's flow cannot exceed available propellant. */
function limitPlans(plans: Plan[], propB: number, propS: number, dt: number): Plan[] {
  let flowB = 0;
  let flowS = 0;
  for (const p of plans) {
    const f = (p.thrustPer * p.count) / (p.isp * G0);
    if (p.pool === 'B') flowB += f;
    else flowS += f;
  }
  if (flowB * dt <= propB && flowS * dt <= propS) return plans;
  const kB = flowB * dt > propB && flowB > 0 ? propB / (flowB * dt) : 1;
  const kS = flowS * dt > propS && flowS > 0 ? propS / (flowS * dt) : 1;
  return plans.map((p) =>
    p.pool === 'B' ? { ...p, count: p.count * kB } : { ...p, count: p.count * kS },
  );
}

export class Sim {
  t = 0;
  cfg: SimConfig;
  stack: Body | null;
  booster: Body | null = null;
  ship: Body | null = null;
  events: EventRec[] = [];
  stackPath: Sample[] = [];
  shipPath: Sample[] = [];
  boosterPath: Sample[] = [];

  separated = false;
  secoDone = false;
  apogeePaused = false;
  crashed = false;
  ended = false;

  private mecoDone = false;
  private sepT = 0;
  private shipBurning = false;
  private turnDone = false;
  private turnT = 0;
  private shipGamma0 = 0;
  private shipBeta = 0;
  private shipBurnStartT = 0;
  private boostbackStarted = false;
  private boostbackDone = false;
  private boostbackSt = 0;
  private landingStarted = false;
  private landed = false;
  private prevShipVr = 0;
  private qMax = 0;
  private qMaxT = 0;
  private maxQFired = false;
  private lastSample = -1;
  private acc = 0;
  private boosterOuts: Set<number>;
  private shipOuts: Set<number>;

  constructor(cfg: SimConfig = DEFAULT_CONFIG) {
    this.cfg = { ...cfg };
    this.boosterOuts = new Set(cfg.boosterEngineOuts);
    this.shipOuts = new Set(cfg.shipEngineOuts);
    const dryB = SPEC.boosterDry * cfg.dryScale;
    const propB = SPEC.boosterProp * cfg.propScale;
    const dryS = SPEC.shipDry * cfg.dryScale;
    const propS = SPEC.shipProp * cfg.propScale;
    this.stack = {
      r: R_E,
      th: 0,
      vr: 0,
      vt: 0,
      propB,
      propS,
      dryB,
      dryS,
      active: true,
      thrustN: 0,
      pr: R_E,
      pth: 0,
      att: Math.PI / 2,
    };
    this.push('LIFTOFF', 'Liftoff', 'info');
  }

  get boostEnd(): number {
    return this.cfg.boostDurationS;
  }

  // ---- engine health -------------------------------------------------------

  private healthyBoosterAll(): number {
    let n = 0;
    for (let i = 0; i < BOOSTER_ENGINES; i++) if (!this.boosterOuts.has(i)) n++;
    return n;
  }
  private healthyBoosterInner(): number {
    let n = 0;
    for (let i = BOOSTER_OUTER; i < BOOSTER_ENGINES; i++) if (!this.boosterOuts.has(i)) n++;
    return n;
  }
  private healthyShipSL(): number {
    let n = 0;
    for (let i = 0; i < 3; i++) if (!this.shipOuts.has(i)) n++;
    return n;
  }
  private healthyShipVac(): number {
    let n = 0;
    for (let i = 3; i < 6; i++) if (!this.shipOuts.has(i)) n++;
    return n;
  }
  /** One healthy ship engine for user burns; prefers sea-level. */
  private firstHealthyShip(): Plan | null {
    for (const i of [0, 1, 2]) {
      if (!this.shipOuts.has(i)) {
        return { pool: 'S', count: 1, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP };
      }
    }
    for (const i of [3, 4, 5]) {
      if (!this.shipOuts.has(i)) {
        return { pool: 'S', count: 1, thrustPer: RAPTOR3_VAC_THRUST, isp: RAPTOR3_VAC_ISP };
      }
    }
    return null;
  }

  // ---- events / sampling ---------------------------------------------------

  private push(short: string, label: string, kind: EventKind): void {
    const b = this.stack ?? this.ship ?? this.booster;
    this.events.push({
      t: this.t,
      label,
      short,
      kind,
      xKm: b ? (R_E * b.th) / 1000 : 0,
      yKm: b ? (b.r - R_E) / 1000 : 0,
    });
  }

  private trackQ(b: Body): void {
    const rho = airDensity(b.r - R_E);
    const q = 0.5 * rho * (b.vr * b.vr + b.vt * b.vt);
    if (q > this.qMax) {
      this.qMax = q;
      this.qMaxT = this.t;
    }
    if (
      !this.maxQFired &&
      this.qMax > 10_000 &&
      q < this.qMax * 0.85 &&
      this.t > this.qMaxT + 1
    ) {
      this.maxQFired = true;
      this.push('MAX-Q', `Max Q — ${(this.qMax / 1000).toFixed(1)} kPa`, 'warn');
    }
  }

  private maybeSample(): void {
    if (this.t - this.lastSample < SAMPLE_INTERVAL) return;
    this.lastSample = this.t;
    if (this.stack) {
      this.stackPath.push({ xKm: (R_E * this.stack.th) / 1000, yKm: (this.stack.r - R_E) / 1000 });
    }
    if (this.ship) {
      this.shipPath.push({ xKm: (R_E * this.ship.th) / 1000, yKm: (this.ship.r - R_E) / 1000 });
    }
    if (this.booster) {
      this.boosterPath.push({
        xKm: (R_E * this.booster.th) / 1000,
        yKm: (this.booster.r - R_E) / 1000,
      });
    }
  }

  private separate(): void {
    const s = this.stack;
    if (!s) return;
    this.booster = {
      r: s.r,
      th: s.th,
      vr: s.vr,
      vt: s.vt,
      propB: s.propB,
      propS: 0,
      dryB: s.dryB,
      dryS: 0,
      active: true,
      thrustN: 0,
      pr: s.r,
      pth: s.th,
      att: Math.atan2(s.vr, s.vt),
    };
    this.ship = {
      r: s.r,
      th: s.th,
      vr: s.vr,
      vt: s.vt,
      propB: 0,
      propS: s.propS,
      dryB: 0,
      dryS: s.dryS,
      active: true,
      thrustN: 0,
      pr: s.r,
      pth: s.th,
      att: Math.atan2(s.vr, s.vt),
    };
    this.stack = null;
    this.separated = true;
    this.sepT = this.t;
    this.shipBurning = true;
    this.shipGamma0 = Math.atan2(s.vr, s.vt);
    this.shipBurnStartT = this.t;
    this.push('HOT STAGING', 'Hot staging — ship engines ignite', 'info');
  }

  // ---- main step -----------------------------------------------------------

  step(burn: BurnInput): void {
    const dt = DT;

    // Snapshot positions for render interpolation (glyph is drawn at
    // prev + (cur - prev) * alpha, so it moves smoothly at 60 Hz while the
    // physics runs at 20 Hz).
    if (this.stack) {
      this.stack.pr = this.stack.r;
      this.stack.pth = this.stack.th;
    }
    if (this.booster) {
      this.booster.pr = this.booster.r;
      this.booster.pth = this.booster.th;
    }
    if (this.ship) {
      this.ship.pr = this.ship.r;
      this.ship.pth = this.ship.th;
    }

    // Attached stack: ascent, then MECO, then the 2-second staging overlap.
    if (this.stack && this.stack.active) {
      if (this.t >= this.boostEnd && !this.mecoDone) {
        this.mecoDone = true;
        this.push('MECO', 'MECO — 28 engines cut, 5 retained', 'warn');
      }
      if (this.mecoDone && this.t >= this.boostEnd + SEPARATION_DELAY) {
        this.separate();
      } else if (this.mecoDone) {
        const inner = Math.min(OVERLAP_ENGINES, this.healthyBoosterInner());
        const plans: Plan[] =
          inner > 0
            ? [{ pool: 'B', count: inner, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP }]
            : [];
        stepBody(this.stack, plans, gravityTurn, () => OVERLAP_THROTTLE, dt);
      } else {
        const n = this.healthyBoosterAll();
        const plans: Plan[] =
          n > 0
            ? [{ pool: 'B', count: n, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP }]
            : [];
        const speed = Math.hypot(this.stack.vr, this.stack.vt);
        const pitchRad = (this.cfg.launchPitchDeg * Math.PI) / 180;
        const hold = { r: Math.sin(pitchRad), t: Math.cos(pitchRad) };
        // Hold the launch pitch, then blend into the zero-AoA gravity turn over
        // PITCH_BLEND_S. A hard switch here is what made the vehicle snap.
        const gt = unitV(this.stack.vr, this.stack.vt);
        if (speed >= V_TURN && !this.turnDone) {
          this.turnDone = true;
          this.turnT = this.t;
        }
        const b = speed < V_TURN ? 0 : Math.min(1, (this.t - this.turnT) / PITCH_BLEND_S);
        const dir =
          b <= 0 ? hold : b >= 1 ? gt : unitV(hold.r * (1 - b) + gt.r * b, hold.t * (1 - b) + gt.t * b);
        const steer: Steer = () => dir;
        this.stack.att = smoothAtt(this.stack, Math.atan2(dir.r, dir.t), dt);
        stepBody(this.stack, plans, steer, (alt) => ascentThrottle(alt), dt);
      }
      if (this.stack) {
        this.trackQ(this.stack);
        if (this.stack.r - R_E <= 0 && this.t > 1) {
          this.ended = true;
          this.crashed = true;
          this.push('LIFTOFF ABORT', 'Vehicle impact — not enough thrust to leave the pad', 'bad');
          this.stack.active = false;
        }
      }
    }

    // Booster return: coast -> boostback (reverse downrange) -> coast ->
    // landing burn -> touchdown.
    const b = this.booster;
    if (b && b.active) {
      const alt = b.r - R_E;
      if (!this.boostbackDone) {
        if (!this.boostbackStarted && this.t >= this.sepT + BOOSTBACK_START_DELAY) {
          this.boostbackStarted = true;
          this.boostbackSt = this.t;
          this.push('BOOSTBACK', 'Boostback burn', 'burn');
        }
        if (this.boostbackStarted) {
          const n = Math.min(BOOSTBACK_ENGINES, this.healthyBoosterInner());
          const plans: Plan[] =
            n > 0
              ? [{ pool: 'B', count: n, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP }]
              : [];
          stepBody(b, plans, transverseBack, () => BOOSTBACK_THROTTLE, dt);
          b.att = smoothAtt(b, Math.PI, dt);
          if (b.vt <= 0 || this.t - this.boostbackSt > BOOSTBACK_MAX_S) {
            this.boostbackDone = true;
            this.push(
              b.vt <= 0 ? 'BOOSTBACK END' : 'BOOSTBACK TIMEOUT',
              b.vt <= 0 ? 'Boostback complete' : 'Boostback timed out — not enough engines',
              b.vt <= 0 ? 'good' : 'warn',
            );
          }
        } else {
          stepBody(b, [], gravityTurn, () => 0, dt);
          b.att = smoothAtt(b, Math.atan2(b.vr, b.vt), dt);
        }
      } else if (!this.landed) {
        if (!this.landingStarted && alt < LANDING_ALT && b.vr < -1) {
          this.landingStarted = true;
          this.push('LANDING BURN', 'Landing burn', 'burn');
        }
        if (this.landingStarted) {
          const n = Math.min(LANDING_ENGINES, this.healthyBoosterInner());
          const plans: Plan[] =
            n > 0
              ? [{ pool: 'B', count: n, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP }]
              : [];
          const maxThrust = n * RAPTOR3_SL_THRUST;
          stepBody(b, plans, verticalUp, (alt2, _sp, vr, mass) => landingThrottle(alt2, mass, maxThrust, vr), dt);
          b.att = smoothAtt(b, Math.PI / 2, dt);
        } else {
          stepBody(b, [], gravityTurn, () => 0, dt);
          b.att = smoothAtt(b, Math.atan2(b.vr, b.vt), dt);
        }
      }
      if (b.active && alt <= 0 && this.t > 1) {
        const sink = Math.abs(b.vr);
        b.active = false;
        b.vr = 0;
        b.vt = 0;
        b.thrustN = 0;
        this.landed = true;
        this.push(
          sink < 25 ? 'BOOSTER LANDED' : 'BOOSTER LOST',
          sink < 25
            ? `Booster soft landing — ${sink.toFixed(1)} m/s, ${this.downrangeBoosterKm.toFixed(0)} km downrange`
            : `Booster impact — ${sink.toFixed(0)} m/s at ${this.downrangeBoosterKm.toFixed(0)} km downrange`,
          sink < 25 ? 'good' : 'bad',
        );
      }
    }

    // Ship: burn to the perigee target, then coast (user-controlled burns).
    const s = this.ship;
    if (s && s.active) {
      if (this.shipBurning) {
        const sl = this.healthyShipSL();
        const vac = this.healthyShipVac();
        const plans: Plan[] = [];
        if (sl > 0) plans.push({ pool: 'S', count: sl, thrustPer: RAPTOR3_SL_THRUST, isp: RAPTOR3_SL_ISP });
        if (vac > 0) plans.push({ pool: 'S', count: vac, thrustPer: RAPTOR3_VAC_THRUST, isp: RAPTOR3_VAC_ISP });
        if (plans.length === 0) {
          this.shipBurning = false;
          this.secoDone = true;
          this.push('SHIP ENGINES DEAD', 'Ship engines dead — ballistic coast', 'bad');
        } else {
          // Ship steering: explicit feedback on flight-path angle. A TWR~0.9
          // vehicle cannot fly a natural gravity-turn arc to orbit, so the burn
          // computes the pitch-up bias that makes gamma follow a schedule from
          // the staging attitude to near-level over the burn, using the live
          // T/m.
          const v2 = s.vr * s.vr + s.vt * s.vt;
          const v = Math.sqrt(v2);
          const gamma = Math.atan2(s.vr, s.vt);
          const g = MU / (s.r * s.r);
          const thrust = sl * RAPTOR3_SL_THRUST + vac * RAPTOR3_VAC_THRUST;
          const acc = thrust / Math.max(1, s.dryS + s.propS);
          const natural = ((s.vt * s.vt) / s.r - g) * Math.cos(gamma) / v;
          // Position + rate feedback on the flight-path-angle schedule.
          const frac = Math.min(1, (this.t - this.shipBurnStartT) / SHIP_PITCH_SCHED_S);
          const gammaSched =
            this.shipGamma0 + (SHIP_PITCH_FINAL_GAMMA - this.shipGamma0) * frac;
          const desiredRate =
            (SHIP_PITCH_FINAL_GAMMA - this.shipGamma0) / SHIP_PITCH_SCHED_S +
            0.03 * (gammaSched - gamma);
          const sinBeta = Math.max(-0.5, Math.min(1, ((desiredRate - natural) * v) / acc));
          const betaTarget = Math.asin(sinBeta);
          this.shipBeta += (betaTarget - this.shipBeta) * Math.min(1, dt / 0.4);
          const beta = this.shipBeta;
          const u = unitV(s.vr, s.vt);
          const steer: Steer = () =>
            unitV(
              u.r * Math.cos(beta) + u.t * Math.sin(beta),
              u.t * Math.cos(beta) - u.r * Math.sin(beta),
            );
          stepBody(s, plans, steer, () => 1, dt);
          s.att = smoothAtt(s, gamma + beta, dt);
          const peri = periapsisAlt(s.r, s.vr, s.vt);
          const targetReached = peri >= SHIP_TARGET_PERIGEE;
          const reserveHit = s.propS <= SHIP_BURN_RESERVE;
          if (targetReached || reserveHit) {
            this.shipBurning = false;
            this.secoDone = true;
            if (targetReached) {
              this.push('SECO', 'SECO — ship engines cutoff', 'good');
            } else {
              this.push('SECO', 'SECO — burn reserve reached', 'warn');
            }
          }
        }
      } else {
        if (burn.held && s.propS > 0) {
          const p = this.firstHealthyShip();
          if (p) {
            stepBody(s, [p], burn.retro ? transverseBack : transverse, () => 1, dt);
            s.att = smoothAtt(s, burn.retro ? Math.PI : 0, dt);
          } else {
            stepBody(s, [], gravityTurn, () => 0, dt);
          }
        } else {
          stepBody(s, [], gravityTurn, () => 0, dt);
        }
        if (!this.apogeePaused && this.prevShipVr > 0 && s.vr <= 0) {
          this.apogeePaused = true;
          this.push('APOGEE', 'Apogee reached — burn decision point', 'info');
        }
        if (s.r - R_E <= 0 && this.t > 1) {
          s.active = false;
          s.vr = 0;
          s.vt = 0;
          this.push('SHIP SPLASHDOWN', 'Ship splashdown', 'bad');
        }
      }
      this.prevShipVr = s.vr;
    }

    this.t += dt;
    this.maybeSample();
  }

  // ---- driving -------------------------------------------------------------

  /** Advance by real elapsed seconds scaled by warp. */
  advance(realDt: number, warp: number, burn: BurnInput): void {
    if (this.ended) return;
    this.acc += Math.max(0, realDt) * warp;
    let steps = 0;
    while (this.acc >= DT && steps < 4000 && !this.ended) {
      this.step(burn);
      this.acc -= DT;
      steps++;
    }
    if (steps >= 4000) this.acc = 0; // drop backlog rather than spiral
  }

  /** Fast-forward until the next mission event or the apogee pause. */  jumpToNextEvent(): void {
    const n = this.events.length;
    const noBurn: BurnInput = { held: false, retro: false };
    let guard = 0;
    while (guard++ < 200_000 && !this.ended && !this.missionOver) {
      if (this.events.length > n || this.apogeePaused) break;
      this.step(noBurn);
    }
  }

  /**
   * Re-simulate the mission from T=0 to the given time (or to the end of the
   * mission when time is huge). The sim is deterministic, so this is an exact
   * replay: call it on a fresh Sim.
   */
  jumpTo(time: number): void {
    const noBurn: BurnInput = { held: false, retro: false };
    let guard = 0;
    while (this.t < time && !this.ended && !this.missionOver && guard++ < 600_000) {
      this.step(noBurn);
    }
  }

  /** No vehicle is still flying, so nothing is left to simulate. */
  get missionOver(): boolean {
    return (
      this.ended ||
      (this.separated && !this.ship?.active && !this.booster?.active)
    );
  }

  // ---- telemetry -----------------------------------------------------------

  /** Seconds since the vehicles separated (0 before staging). */
  get sepAge(): number {
    return this.separated ? this.t - this.sepT : 0;
  }

  /** Sub-step fraction for render interpolation, 0..1. */
  get alpha(): number {
    return Math.min(1, Math.max(0, this.acc / DT));
  }

  get primary(): Body | null {
    return this.stack ?? this.ship;
  }
  get speed(): number {
    const b = this.primary;
    return b ? Math.hypot(b.vr, b.vt) : 0;
  }
  get altKm(): number {
    const b = this.primary;
    return b ? (b.r - R_E) / 1000 : 0;
  }
  get downrangeKm(): number {
    const b = this.primary;
    return b ? (R_E * b.th) / 1000 : 0;
  }
  get downrangeBoosterKm(): number {
    const b = this.booster;
    return b ? (R_E * b.th) / 1000 : 0;
  }
  get mach(): number {
    return this.speed / SPEED_OF_SOUND;
  }
  get qKpa(): number {
    const b = this.primary;
    if (!b) return 0;
    return 0.5 * airDensity(b.r - R_E) * (b.vr * b.vr + b.vt * b.vt) * 1e-3;
  }
  get thrustG(): number {
    const b = this.primary;
    if (!b) return 0;
    const mass = b.dryB + b.dryS + b.propB + b.propS;
    return b.thrustN / mass / G0;
  }
  get shipPropPct(): number {
    const prop = this.ship ? this.ship.propS : this.stack ? this.stack.propS : 0;
    const total = SPEC.shipProp * this.cfg.propScale;
    return total > 0 ? (prop / total) * 100 : 0;
  }
  get boosterPropPct(): number {
    const prop = this.booster ? this.booster.propB : this.stack ? this.stack.propB : 0;
    const total = SPEC.boosterProp * this.cfg.propScale;
    return total > 0 ? (prop / total) * 100 : 0;
  }
  /** "healthy/total" engine counts, for the HUD. */
  get boosterEngines(): string {
    return `${this.healthyBoosterAll()}/${BOOSTER_ENGINES}`;
  }
  get shipEngines(): string {
    return `${this.healthyShipSL() + this.healthyShipVac()}/6`;
  }
  get apoKm(): number {
    if (!this.ship) return 0;
    return apoapsisAlt(this.ship.r, this.ship.vr, this.ship.vt) / 1000;
  }
  get periKm(): number {
    if (!this.ship) return 0;
    return periapsisAlt(this.ship.r, this.ship.vr, this.ship.vt) / 1000;
  }
  get shipThrusting(): boolean {
    const s = this.ship;
    if (!s) return this.stack ? this.stack.thrustN > 0 : false;
    return s.thrustN > 0;
  }
  get boosterThrusting(): boolean {
    return this.booster ? this.booster.thrustN > 0 : false;
  }
  get phaseLabel(): string {
    if (this.ended) return this.crashed ? 'MISSION ENDED — IMPACT' : 'MISSION ENDED';
    if (this.stack) {
      if (!this.mecoDone) return `ASCENT — ${this.healthyBoosterAll()} ENGINES`;
      return 'STAGING SEQUENCE';
    }
    if (this.shipBurning) return 'SHIP MAIN BURN';
    if (this.booster && !this.landed && this.booster.active) return 'BOOSTER RETURN';
    if (this.apogeePaused) return 'COAST — BURN DECISION';
    return 'SHIP IN COAST';
  }
}
