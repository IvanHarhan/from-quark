/** Simulation runs at a fixed step regardless of frame rate; rendering gets the leftover fraction. */
export const SIM_DT = 1 / 120;
const MAX_STEPS_PER_FRAME = 8;

export interface LoopHandlers {
  /** One fixed simulation step of SIM_DT game-seconds. */
  step(dt: number): void;
  /** Once per frame. realDt is wall-clock seconds; alpha is the fraction of a sim step not yet simulated. */
  frame(realDt: number, alpha: number): void;
}

export class FixedLoop {
  timeScale = 1;
  private acc = 0;
  private last = -1;

  constructor(private h: LoopHandlers) {}

  tick(nowMs: number) {
    const now = nowMs / 1000;
    const realDt = this.last < 0 ? 0 : Math.max(0, Math.min(now - this.last, 0.25));
    this.last = now;
    this.acc += realDt * this.timeScale;
    let steps = 0;
    while (this.acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      this.h.step(SIM_DT);
      this.acc -= SIM_DT;
      steps++;
    }
    // Drop the backlog instead of spiralling when the sim can't keep up.
    if (steps === MAX_STEPS_PER_FRAME) this.acc = 0;
    this.h.frame(realDt, this.acc / SIM_DT);
  }
}
