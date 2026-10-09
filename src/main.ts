// Entry point: wire the sim, renderer and UI into the animation loop.

import { Sim } from './sim.ts';
import { Renderer } from './render.ts';
import { UI } from './ui.ts';
import { DEFAULT_CONFIG, type SimConfig } from './vehicle.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const renderer = new Renderer(canvas, overlay);

let sim = new Sim(DEFAULT_CONFIG);

/** Deterministic shadow run gives the full mission timeline (past + future). */
function installTimeline(cfg: SimConfig, simT: number): void {
  const shadow = new Sim(cfg);
  shadow.jumpTo(90 * 60); // 90 min covers every event the mission can emit
  ui.setTimeline(shadow.events, simT);
}

const ui = new UI({
  onLaunch: (cfg: SimConfig) => {
    sim = new Sim(cfg);
    ui.sawApogeePause = false;
    installTimeline(cfg, 0);
    renderer.reset();
  },
  onSeek: (t: number) => {
    // Deterministic replay: rebuild the mission and fast-forward to the event.
    const cfg = sim.cfg;
    sim = new Sim(cfg);
    sim.jumpTo(t);
    ui.sawApogeePause = sim.apogeePaused;
    installTimeline(cfg, sim.t);
    renderer.reset();
  },
  onJump: () => {
    sim.jumpToNextEvent();
  },
  onFit: () => {
    renderer.fitAll();
  },
});

// Wheel over the canvas zooms the trajectory view. Scroll up to close in on
// the planet and the trajectory, scroll down to pull back to the full fit.
canvas.addEventListener(
  'wheel',
  (e: WheelEvent) => {
    e.preventDefault();
    renderer.zoomBy(e.deltaY < 0 ? 1 / 1.12 : 1.12);
  },
  { passive: false },
);

installTimeline(sim.cfg, 0);

let last = performance.now();
function frame(now: number): void {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  // The clock stops for good once both vehicles are done (splashdown, impact,
  // or a ship in orbit that will never come back down).
  if (!sim.missionOver && (!ui.state.paused || ui.state.burnHeld)) {
    sim.advance(dtReal, ui.state.warp, { held: ui.state.burnHeld, retro: ui.state.retro });
  }

  renderer.draw(sim, sim.cfg);
  ui.update(sim);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
