// Canvas renderer: Earth arc, the two vehicle trajectories with event markers,
// and vehicle glyphs (engine patterns matching the SpaceX HUD, nose on the
// smoothed attitude). Vehicles draw on a second canvas above the HUD panels.

import { Sim, type Sample } from './sim.ts';
import type { SimConfig } from './vehicle.ts';
import { BOOSTER_OUTER, BOOSTER_ENGINES } from './vehicle.ts';
import { R_E } from './physics.ts';

const R_E_KM = R_E / 1000;
const PAD = 60;
const PAD_Y_FRAC = 0.38; // pad's height on screen; the planet circle fills below it

interface Star {
  x: number;
  y: number;
  r: number;
  a: number;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private overlay: HTMLCanvasElement;
  /** Glyph context: the overlay canvas that sits above the HUD panels. */
  private gctx: CanvasRenderingContext2D;
  private stars: Star[] = [];
  private scale = 4; // px per km
  private snapped = false;
  private zoom = 1; // user zoom; 1 fits the whole trajectory
  private followMode = true; // centre on the vehicle; FIT suspends this
  private panX = 0; // camera pan in trajectory km
  private panY = 0;
  private w = 0;
  private h = 0;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.canvas = canvas;
    this.overlay = overlay;
    const ctx = canvas.getContext('2d');
    const gctx = overlay.getContext('2d');
    if (!ctx || !gctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    this.gctx = gctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    for (let i = 0; i < 160; i++) {
      this.stars.push({
        x: Math.random(),
        y: Math.random(),
        r: Math.random() * 1.2 + 0.2,
        a: Math.random() * 0.5 + 0.2,
      });
    }
  }

  private resize(): void {
    this.w = this.canvas.width = this.overlay.width = window.innerWidth;
    this.h = this.canvas.height = this.overlay.height = window.innerHeight;
  }

  /** Snap the view to the trajectory fit on the next draw (on (re)launch). */
  reset(): void {
    this.snapped = false;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.followMode = true;
  }

  /** Frame the whole trajectory without following (FIT button). */
  fitAll(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.followMode = false;
  }

  /** Multiply the user zoom. Wheel and buttons drive this. */
  zoomBy(factor: number): void {
    this.zoom = Math.min(2, Math.max(0.0005, this.zoom * factor));
  }

  /**
   * Screen position of a point given its downrange arc distance (km from the
   * pad along the surface) and altitude (km above the surface). Everything is
   * drawn in Earth-centred polar coordinates, so the planet is the disc and a
   * vehicle in motion travels around it instead of being unwrapped onto a
   * plane.
   */
  private project(xKm: number, yKm: number, cx: number, cy: number, scale: number): { x: number; y: number } {
    const phi = xKm / R_E_KM;
    const rad = R_E_KM + yKm;
    return {
      x: cx + rad * scale * Math.sin(phi),
      y: cy - rad * scale * Math.cos(phi),
    };
  }

  draw(sim: Sim, cfg: SimConfig): void {
    const ctx = this.ctx;
    const w = this.w;
    const h = this.h;

    // Interpolation between physics steps (glyphs move at 60 Hz, physics at 20).
    const alpha = sim.alpha;
    const gx = (b: { pth: number; th: number }) => b.pth + (b.th - b.pth) * alpha;
    const gr = (b: { pr: number; r: number }) => b.pr + (b.r - b.pr) * alpha;
    const gxKm = (b: { pth: number; th: number }) => (R_E * gx(b)) / 1000;
    const grKm = (b: { pr: number; r: number }) => (gr(b) - R_E) / 1000;

    // --- fit ---------------------------------------------------------------------
    // The planet is a circle whose top sits at the pad. The scale is bounded by
    // the circle's size on screen and by how high the trajectory climbs above
    // the pad. The camera then eases toward the active vehicle so the flight
    // is followed; the wheel zooms in from there and FIT returns to the whole
    // trajectory.
    let maxX = 5;
    let top = 5;
    for (const p of [...sim.stackPath, ...sim.shipPath, ...sim.boosterPath]) {
      if (p.xKm > maxX) maxX = p.xKm;
      if (p.yKm > top) top = p.yKm;
    }
    maxX *= 1.08;
    const fitScale = Math.min(
      (0.45 * h) / R_E_KM,
      (PAD_Y_FRAC * h - PAD) / Math.max(top, 1),
    );
    const target = fitScale / this.zoom;
    if (!this.snapped) {
      this.scale = target; // no easing on the first frame after a (re)launch
      this.snapped = true;
    } else {
      this.scale += (target - this.scale) * 0.08;
    }

    // The camera is centred on the active vehicle, not the pad. It eases toward
    // the vehicle's position so the flight is tracked from liftoff. FIT
    // suspends following to frame the whole trajectory; zooming resumes it.
    const focus = sim.primary;
    const fx = focus && this.followMode ? gxKm(focus) : 0;
    const fy = focus && this.followMode ? grKm(focus) : 0;
    if (!this.snapped) {
      this.panX = fx;
      this.panY = fy;
    } else {
      this.panX += (fx - this.panX) * 0.06;
      this.panY += (fy - this.panY) * 0.06;
    }

    // Project in world space, then shift by the camera in screen space. The
    // planet and the trajectory share one world, so the vehicle moves across a
    // fixed planet instead of dragging the ground along with it.
    const cx = w / 2;
    const padY = PAD_Y_FRAC * h;
    const planetCy = padY + R_E_KM * this.scale;
    const cam = this.project(this.panX, this.panY, cx, planetCy, this.scale);
    const ox = w / 2 - cam.x;
    const oy = h / 2 - cam.y;
    const P = (xKm: number, yKm: number) => {
      const p = this.project(xKm, yKm, cx, planetCy, this.scale);
      return { x: p.x + ox, y: p.y + oy };
    };

    // --- background -----------------------------------------------------------
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    for (const s of this.stars) {
      ctx.globalAlpha = s.a;
      ctx.fillStyle = '#cfd8e6';
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }
    ctx.globalAlpha = 1;

    // --- Earth -------------------------------------------------------------------
    // The planet is a circle in the side view. Its centre sits one radius below
    // the pad, so the pad is the top of the disc and the limb arcs away in both
    // directions. Filled with a vertical gradient and edged with the
    // atmospheric glow.
    const rr = R_E_KM * this.scale;

    ctx.beginPath();
    ctx.arc(cx + ox, planetCy + oy, rr, 0, Math.PI * 2);
    const grad = ctx.createLinearGradient(0, padY - 10 + oy, 0, planetCy + oy + rr);
    grad.addColorStop(0, '#2a4d78');
    grad.addColorStop(0.25, '#16293f');
    grad.addColorStop(1, '#070b13');
    ctx.fillStyle = grad;
    ctx.fill();

    // atmospheric limb: wide soft glow hugging the surface, then the edge
    ctx.lineWidth = 18;
    ctx.strokeStyle = 'rgba(80, 140, 255, 0.13)';
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(120, 175, 255, 0.4)';
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(195, 220, 255, 0.9)';
    ctx.stroke();

    // downrange ticks along the surface, only where the surface exists
    const tickStep = this.scale > 25 ? 25 : this.scale > 6 ? 100 : 500;
    const tickMax = (Math.PI / 2) * R_E_KM;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= tickMax; x += tickStep) {
      const p = P(x, 0);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y + 7);
    }
    ctx.stroke();

    // --- trajectories -----------------------------------------------------------
    const drawPath = (path: Sample[], color: string, width: number) => {
      if (path.length < 2) return;
      ctx.beginPath();
      const p0 = P(path[0].xKm, path[0].yKm);
      ctx.moveTo(p0.x, p0.y);
      for (const p of path) {
        const q = P(p.xKm, p.yKm);
        ctx.lineTo(q.x, q.y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    drawPath(sim.stackPath, 'rgba(232,236,243,0.5)', 1.5);
    drawPath(sim.shipPath, '#9fd3ff', 2);
    drawPath(sim.boosterPath, '#ff8a3c', 2);

    // --- event markers ------------------------------------------------------------
    for (const e of sim.events) {
      if (e.xKm === undefined || e.yKm === undefined) continue;
      const p = P(e.xKm, e.yKm);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fillStyle =
        e.kind === 'bad'
          ? '#ff5252'
          : e.kind === 'warn'
            ? '#ffb020'
            : e.kind === 'burn'
              ? '#ff7a1a'
              : '#e8ecf3';
      ctx.fill();
    }

    // --- vehicles (interpolated, nose on the smoothed attitude) ---------------
    // Glyphs draw on the overlay canvas so they stay visible above the HUD
    // panels no matter where the trajectory takes them.
    this.gctx.clearRect(0, 0, w, h);
    const glyphH = (base: number) => base * cfg.lengthScale;
    const at = (b: { pth: number; th: number; pr: number; r: number; att: number }) => {
      const p = P(gxKm(b), grKm(b));
      // Screen angle of the flight-path attitude at this position angle. The
      // local horizon at position angle phi points along screen angle phi, so a
      // flight-path angle gamma above it maps to phi - gamma.
      const phi = gxKm(b) / R_E_KM;
      return { x: p.x, y: p.y, psi: phi - b.att };
    };
    if (sim.stack) {
      const b = sim.stack;
      const p = at(b);
      this.withAttitude(p.x, p.y, p.psi, () =>
        this.drawStack(b.thrustN > 0, glyphH(64), glyphH(30), sim.t, cfg),
      );
    }
    if (sim.booster && sim.booster.active) {
      const b = sim.booster;
      const p = at(b);
      // Nudge the booster glyph outward along the radius so it reads as its own
      // vehicle during the staging overlap and the return flight.
      const sep = Math.min(1, sim.sepAge / 1.5) * (sim.ship?.active ? 1 : 0);
      if (sep > 0) {
        const phi = gxKm(b) / R_E_KM;
        p.x -= Math.cos(phi) * 18 * sep;
        p.y += Math.sin(phi) * 18 * sep;
      }
      this.withAttitude(p.x, p.y, p.psi, () =>
        this.drawBooster(b.thrustN > 0, glyphH(56), sim.t, cfg),
      );
    }
    if (sim.ship && sim.ship.active) {
      const s = sim.ship;
      const p = at(s);
      this.withAttitude(p.x, p.y, p.psi, () =>
        this.drawShip(s.thrustN > 0, glyphH(30), sim.t, cfg),
      );
    }
  }

  /** Draw a glyph rotated so its nose follows the given screen angle. */
  private withAttitude(px: number, py: number, psi: number, draw: () => void): void {
    const ctx = this.gctx;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(psi + Math.PI / 2);
    draw();
    ctx.restore();
  }

  private drawStack(
    thrusting: boolean,
    boosterH: number,
    shipH: number,
    t: number,
    cfg: SimConfig,
  ): void {
    const ctx = this.gctx;
    const totalH = boosterH + shipH;

    if (thrusting) this.flame(totalH * 0.5, t);

    ctx.fillStyle = '#c9d2de';
    ctx.fillRect(-9, -boosterH, 18, boosterH);
    ctx.fillStyle = '#eef2f8';
    ctx.fillRect(-8, -totalH, 16, shipH);
    ctx.beginPath();
    ctx.moveTo(-8, -totalH);
    ctx.lineTo(0, -totalH - 12);
    ctx.lineTo(8, -totalH);
    ctx.closePath();
    ctx.fill();
    this.engineDots(cfg.boosterEngineOuts, cfg.shipEngineOuts);
  }

  private drawBooster(thrusting: boolean, hh: number, t: number, cfg: SimConfig): void {
    const ctx = this.gctx;
    if (thrusting) this.flame(hh * 0.55, t);
    ctx.fillStyle = '#c9d2de';
    ctx.fillRect(-9, -hh, 18, hh);
    ctx.fillStyle = '#8b96a8';
    ctx.fillRect(-13, -hh * 0.88, 4, 10);
    ctx.fillRect(9, -hh * 0.88, 4, 10);
    this.engineDots(cfg.boosterEngineOuts, null);
  }

  private drawShip(thrusting: boolean, hh: number, t: number, cfg: SimConfig): void {
    const ctx = this.gctx;
    if (thrusting) this.flame(hh * 0.7, t);
    ctx.fillStyle = '#eef2f8';
    ctx.fillRect(-8, -hh, 16, hh);
    ctx.beginPath();
    ctx.moveTo(-8, -hh);
    ctx.lineTo(0, -hh - 12);
    ctx.lineTo(8, -hh);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#8b96a8';
    ctx.fillRect(-12, -8, 4, 8);
    ctx.fillRect(8, -8, 4, 8);
    this.engineDots(null, cfg.shipEngineOuts);
  }

  /**
   * Engine dots in the SpaceX HUD patterns, white fill, failed engines red.
   * Booster: 20 outer, 10 middle, 3 centre. Ship: 3 large sea-level engines
   * left, right, and bottom-centre with 3 small vacuum engines in the middle.
   */
  private engineDots(boosterOuts: number[] | null, shipOuts: number[] | null): void {
    const ctx = this.gctx;
    const HEALTHY = '#e8edf5';
    const FAILED = '#ff5252';
    if (boosterOuts) {
      const failed = new Set(boosterOuts);
      for (let i = 0; i < BOOSTER_ENGINES; i++) {
        let dx: number;
        let dy: number;
        if (i < BOOSTER_OUTER) {
          const ang = (i / 20) * Math.PI * 2 - Math.PI / 2;
          dx = Math.cos(ang) * 8.5;
          dy = Math.sin(ang) * 5;
        } else if (i < BOOSTER_OUTER + 10) {
          const ang = ((i - BOOSTER_OUTER) / 10) * Math.PI * 2 - Math.PI / 2 + Math.PI / 10;
          dx = Math.cos(ang) * 5.5;
          dy = Math.sin(ang) * 3.2;
        } else {
          const ang = ((i - BOOSTER_OUTER - 10) / 3) * Math.PI * 2 - Math.PI / 2;
          dx = Math.cos(ang) * 2.6;
          dy = Math.sin(ang) * 1.5;
        }
        ctx.beginPath();
        ctx.arc(dx, -1 + dy, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = failed.has(i) ? FAILED : HEALTHY;
        ctx.fill();
      }
    }
    if (shipOuts) {
      const failed = new Set(shipOuts);
      const slAngles = [(7 * Math.PI) / 6, (11 * Math.PI) / 6, Math.PI / 2];
      const vacAngles = [(7 * Math.PI) / 6, (5 * Math.PI) / 6, -Math.PI / 6];
      for (let i = 0; i < 6; i++) {
        const sl = i < 3;
        const ang = sl ? slAngles[i] : vacAngles[i - 3];
        const radius = sl ? 6.5 : 1.6;
        const dx = Math.cos(ang) * radius;
        const dy = Math.sin(ang) * radius * 0.6;
        ctx.beginPath();
        ctx.arc(dx, -1 + dy, sl ? 2.3 : 1.3, 0, Math.PI * 2);
        ctx.fillStyle = failed.has(i) ? FAILED : HEALTHY;
        ctx.fill();
      }
    }
  }

  /** Flame drawn in the glyph's local frame (grows in +y from the engines). */
  private flame(len: number, t: number): void {
    const ctx = this.gctx;
    const flick = 0.75 + 0.25 * Math.sin(t * 47) * Math.sin(t * 13.7);
    const l = len * flick;
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(5, 0);
    ctx.lineTo(0, l);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,140,40,0.85)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-2.5, 0);
    ctx.lineTo(2.5, 0);
    ctx.lineTo(0, l * 0.55);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,225,180,0.9)';
    ctx.fill();
  }
}
