// DOM wiring: settings drawer (slide-away), telemetry HUD, event strip,
// burn controls, warp bar, keyboard shortcuts.

import { Sim } from './sim.ts';
import { boosterSlots, shipSlots, DEFAULT_CONFIG, BOOSTER_OUTER, type SimConfig } from './vehicle.ts';
import type { EventRec } from './sim.ts';

export interface UIState {
  paused: boolean;
  warp: number;
  burnHeld: boolean;
  retro: boolean;
}

export interface UIOpts {
  onLaunch: (cfg: SimConfig) => void;
  onSeek: (t: number) => void;
  onJump: () => void;
  onFit: () => void;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function fmtMET(t: number): string {
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600) % 24;
  const d = Math.floor(total / 86400);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  if (d > 0) return `T+ ${d}:${h.toString().padStart(2, '0')}:${mm}:${ss}`;
  if (h > 0) return `T+ ${h}:${mm}:${ss}`;
  return `T+ ${mm}:${ss}`;
}

export class UI {
  state: UIState = { paused: false, warp: 1, burnHeld: false, retro: false };
  sawApogeePause = false;

  private eventsLen = 0;
  private timeline: EventRec[] = [];
  private boosterFailed = new Set<number>();
  private shipFailed = new Set<number>();
  private opts: UIOpts;

  constructor(opts: UIOpts) {
    this.opts = opts;
    this.buildEngineGrids();
    this.bindDrawer();
    this.bindWarp();
    this.bindBurn();
    this.bindKeyboard();
  }

  // ---- engine grids ----------------------------------------------------------

  private buildEngineGrids(): void {
    // Top-down engine-bay layouts as flown, at SpaceX HUD proportions. Booster:
    // 20 large outer engines, 10 medium in the middle ring, 3 small in the
    // center. Ship: 3 large sea-level engines in an upward triangle interleaved
    // with 3 small vacuum engines in a downward triangle.
    const bGrid = $('boosterGrid');
    const bc = 65;
    for (const slot of boosterSlots()) {
      const btn = document.createElement('button');
      btn.className = 'engine';
      btn.title = slot.label;
      btn.dataset.index = String(slot.index);
      const i = slot.index;
      let dx: number;
      let dy: number;
      if (i < BOOSTER_OUTER) {
        const ang = (i / 20) * Math.PI * 2 - Math.PI / 2;
        dx = Math.cos(ang) * 53;
        dy = Math.sin(ang) * 53;
      } else if (i < BOOSTER_OUTER + 10) {
        const ang = ((i - BOOSTER_OUTER) / 10) * Math.PI * 2 - Math.PI / 2 + Math.PI / 10;
        dx = Math.cos(ang) * 34;
        dy = Math.sin(ang) * 34;
      } else {
        const ang = ((i - BOOSTER_OUTER - 10) / 3) * Math.PI * 2 - Math.PI / 2;
        dx = Math.cos(ang) * 10;
        dy = Math.sin(ang) * 10;
      }
      btn.style.left = `${bc + dx - 7.5}px`;
      btn.style.top = `${bc + dy - 7.5}px`;
      btn.addEventListener('click', () => {
        if (this.boosterFailed.has(i)) this.boosterFailed.delete(i);
        else this.boosterFailed.add(i);
        btn.classList.toggle('failed');
        $('boosterCount').textContent = `${33 - this.boosterFailed.size} healthy`;
      });
      bGrid.appendChild(btn);
    }
    const sGrid = $('shipGrid');
    const sc = 40;
    // Large sea-level engines sit upper-left, upper-right, and bottom-centre;
    // the small vacuum engines cluster in the middle at roughly 10, 7, and 5
    // o'clock positions.
    const slAngles = [(7 * Math.PI) / 6, (11 * Math.PI) / 6, Math.PI / 2];
    const vacAngles = [(13 * Math.PI) / 6, (5 * Math.PI) / 6, -Math.PI / 2];
    for (const slot of shipSlots()) {
      const btn = document.createElement('button');
      btn.className = 'engine';
      btn.title = slot.label;
      const i = slot.index;
      const sl = i < 3;
      const radius = sl ? 28 : 7;
      const half = sl ? 16 : 4;
      const ang = sl ? slAngles[i] : vacAngles[i - 3];
      btn.classList.add(sl ? 'sl' : 'vac');
      btn.style.left = `${sc + Math.cos(ang) * radius - half}px`;
      btn.style.top = `${sc + Math.sin(ang) * radius - half}px`;
      btn.addEventListener('click', () => {
        if (this.shipFailed.has(i)) this.shipFailed.delete(i);
        else this.shipFailed.add(i);
        btn.classList.toggle('failed');
        $('shipCount').textContent = `${6 - this.shipFailed.size} healthy`;
      });
      sGrid.appendChild(btn);
    }
  }

  private readConfig(): SimConfig {
    return {
      launchPitchDeg: parseFloat($<HTMLInputElement>('sPitch').value),
      boostDurationS: parseFloat($<HTMLInputElement>('sBoost').value),
      propScale: parseFloat($<HTMLInputElement>('sProp').value) / 100,
      dryScale: parseFloat($<HTMLInputElement>('sDry').value) / 100,
      lengthScale: parseFloat($<HTMLInputElement>('sLen').value) / 100,
      boosterEngineOuts: [...this.boosterFailed].sort((a, b) => a - b),
      shipEngineOuts: [...this.shipFailed].sort((a, b) => a - b),
    };
  }

  private setOutputs(): void {
    $('oPitch').textContent = `${$<HTMLInputElement>('sPitch').value}°`;
    $('oBoost').textContent = `${$<HTMLInputElement>('sBoost').value} s`;
    $('oProp').textContent = `${$<HTMLInputElement>('sProp').value}%`;
    $('oDry').textContent = `${$<HTMLInputElement>('sDry').value}%`;
    $('oLen').textContent = `${$<HTMLInputElement>('sLen').value}%`;
  }

  private bindDrawer(): void {
    for (const id of ['sPitch', 'sBoost', 'sProp', 'sDry', 'sLen']) {
      $(id).addEventListener('input', () => this.setOutputs());
    }
    $('gear').addEventListener('click', () => $('drawer').classList.toggle('open'));
    const launch = () => {
      this.opts.onLaunch(this.readConfig());
      $('drawer').classList.remove('open');
      // The engine panel stays open; it is a persistent data window.
    };
    $('launchBtn').addEventListener('click', launch);
    $('engLaunchBtn').addEventListener('click', launch);
    $('resetBtn').addEventListener('click', () => {
      const d = DEFAULT_CONFIG;
      $<HTMLInputElement>('sPitch').value = String(d.launchPitchDeg);
      $<HTMLInputElement>('sBoost').value = String(d.boostDurationS);
      $<HTMLInputElement>('sProp').value = String(d.propScale * 100);
      $<HTMLInputElement>('sDry').value = String(d.dryScale * 100);
      $<HTMLInputElement>('sLen').value = String(d.lengthScale * 100);
      this.clearEngines();
      this.setOutputs();
      this.opts.onLaunch(this.readConfig());
    });
    $('resetEngBtn').addEventListener('click', () => {
      this.clearEngines();
    });
    this.setOutputs();
  }

  private clearEngines(): void {
    this.boosterFailed.clear();
    this.shipFailed.clear();
    document.querySelectorAll('.engine.failed').forEach((el) => el.classList.remove('failed'));
    $('boosterCount').textContent = '33 healthy';
    $('shipCount').textContent = '6 healthy';
  }

  // ---- warp bar ----------------------------------------------------------------

  private bindWarp(): void {
    $('pauseBtn').addEventListener('click', () => this.togglePause());
    document.querySelectorAll<HTMLButtonElement>('.warpBtn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.state.warp = parseFloat(btn.dataset.warp ?? '1');
        document.querySelectorAll('.warpBtn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
    $('jumpBtn').addEventListener('click', () => this.opts.onJump());
    $('fitBtn').addEventListener('click', () => this.opts.onFit());
  }

  private togglePause(): void {
    this.state.paused = !this.state.paused;
    $('pauseBtn').textContent = this.state.paused ? '▶' : '⏸';
    $('pauseBtn').classList.toggle('active', this.state.paused);
  }

  // ---- burn controls -----------------------------------------------------------

  private bindBurn(): void {
    const hold = $('holdBurn');
    const start = (e: Event) => {
      e.preventDefault();
      const pe = e as PointerEvent;
      // Capture the pointer so a drifting mouse cannot cut the burn short.
      try {
        hold.setPointerCapture(pe.pointerId);
      } catch {
        // capture is best-effort; hold still works without it
      }
      // Starting a burn from the apogee pause resumes at 10x so the burn is
      // watchable and completes in a few seconds instead of a long hold.
      if (this.state.paused) {
        this.state.paused = false;
        this.state.warp = 10;
        document.querySelectorAll('.warpBtn').forEach((b) => b.classList.remove('active'));
        document
          .querySelector(`.warpBtn[data-warp="10"]`)
          ?.classList.add('active');
        $('pauseBtn').textContent = '⏸';
        $('pauseBtn').classList.remove('active');
      }
      this.state.burnHeld = true;
      hold.classList.add('held');
    };
    const end = () => {
      this.state.burnHeld = false;
      hold.classList.remove('held');
    };
    hold.addEventListener('pointerdown', start);
    hold.addEventListener('pointerup', end);
    hold.addEventListener('pointercancel', end);
    $('proBtn').addEventListener('click', () => {
      this.state.retro = false;
      $('proBtn').classList.add('active');
      $('retroBtn').classList.remove('active');
    });
    $('retroBtn').addEventListener('click', () => {
      this.state.retro = true;
      $('retroBtn').classList.add('active');
      $('proBtn').classList.remove('active');
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        this.state.burnHeld = true;
        $('holdBurn').classList.add('held');
      }
      if (e.code === 'KeyP') this.togglePause();
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.state.burnHeld = false;
        $('holdBurn').classList.remove('held');
      }
    });
  }

  // ---- timeline ---------------------------------------------------------------

  /**
   * Install the mission's full event timeline (from a deterministic shadow
   * run). Chips before simT are solid; later ones stay dimmed but clickable,
   * so the user can jump forward as well as back.
   */
  setTimeline(events: EventRec[], simT: number): void {
    this.timeline = events;
    this.renderTimeline(simT);
  }

  private renderTimeline(simT: number): void {
    const box = $('events');
    // Preserve the reader's scroll position across re-renders; only snap to
    // the end when they were already following the latest event.
    const atEnd = box.scrollLeft + box.clientWidth >= box.scrollWidth - 12;
    const prevLeft = box.scrollLeft;
    box.innerHTML = '';
    for (const e of this.timeline) {
      const chip = document.createElement('div');
      chip.className = `chip ${e.kind}`;
      if (e.t > simT + 0.01) chip.classList.add('future');
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = fmtMET(e.t).replace('T+ ', '');
      chip.appendChild(time);
      chip.appendChild(document.createTextNode(e.short));
      chip.title = 'Jump to this point';
      chip.addEventListener('click', () => this.opts.onSeek(e.t));
      box.appendChild(chip);
    }
    box.scrollLeft = atEnd ? box.scrollWidth : prevLeft;
  }

  update(sim: Sim): void {
    // apogee auto-pause (one shot)
    if (sim.apogeePaused && !this.sawApogeePause) {
      this.sawApogeePause = true;
      if (!this.state.paused) this.togglePause();
    }

    // telemetry
    $('met').textContent = fmtMET(sim.t);
    $('phase').textContent = sim.phaseLabel;
    $('vVel').textContent = `${(sim.speed * 3.6).toFixed(0)} km/h`;
    $('vAlt').textContent = `${sim.altKm.toFixed(1)} km`;
    $('vDr').textContent = `${sim.downrangeKm.toFixed(0)} km`;
    $('vMach').textContent = sim.mach.toFixed(2);
    $('vQ').textContent = `${sim.qKpa.toFixed(1)} kPa`;
    $('vG').textContent = sim.thrustG.toFixed(1);
    $('vOrbit').textContent =
      sim.secoDone && sim.ship ? `${sim.apoKm.toFixed(0)} × ${sim.periKm.toFixed(0)} km` : '—';
    $('vBE').textContent = sim.boosterEngines;
    $('vSE').textContent = sim.shipEngines;
    $('vBP').textContent = `${sim.boosterPropPct.toFixed(0)}%`;
    $('vSP').textContent = `${sim.shipPropPct.toFixed(0)}%`;
    $('barBP').style.width = `${sim.boosterPropPct}%`;
    $('barSP').style.width = `${sim.shipPropPct}%`;

    // event strip: light up chips as the live sim reaches them
    if (sim.events.length !== this.eventsLen) {
      this.eventsLen = sim.events.length;
      if (this.timeline.length > 0) this.renderTimeline(sim.t);
    }

    // burn panel
    const showBurn = sim.secoDone && !!sim.ship?.active;
    $('burnPanel').classList.toggle('show', showBurn);
    if (showBurn) {
      $('burnTitle').textContent = sim.apogeePaused
        ? 'APOGEE — BURN DECISION'
        : sim.shipThrusting
          ? 'BURNING'
          : 'SHIP COAST';
      $('burnPanel').classList.toggle('attention', sim.apogeePaused);
      $('bOrbit').textContent = `${sim.apoKm.toFixed(0)} × ${sim.periKm.toFixed(0)} km`;
      $('bVel').textContent = `${(sim.speed * 3.6).toFixed(0)} km/h`;
      $('bProp').textContent = `${sim.shipPropPct.toFixed(0)}%`;
      $('barBProp').style.width = `${sim.shipPropPct}%`;
    }
  }
}
