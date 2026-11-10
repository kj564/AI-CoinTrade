"use client";

/**
 * A gentle procedural "music bed" built with the Web Audio API.
 * Slow detuned pad + soft bell arpeggio through a low-pass filter.
 * No samples needed — fully synthesised, matches the warm storybook mood.
 */
export class MusicBed {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private nodes: AudioNode[] = [];
  private playing = false;
  private targetVolume = 0.0;

  setVolume(v: number) {
    this.targetVolume = v;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.3);
    }
  }

  async start() {
    if (this.playing) return;
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    await this.ctx.resume();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // low-pass to keep it soft
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1100;
    lp.Q.value = 0.6;
    lp.connect(this.master);

    // gentle pad: a major triad across two octaves, detuned saws
    const padFreqs = [196.0, 246.94, 293.66, 392.0]; // G3 B3 D4 G4
    for (const f of padFreqs) {
      const o1 = ctx.createOscillator();
      o1.type = "sawtooth";
      o1.frequency.value = f;
      o1.detune.value = -6;
      const o2 = ctx.createOscillator();
      o2.type = "sawtooth";
      o2.frequency.value = f;
      o2.detune.value = 7;
      const g = ctx.createGain();
      g.gain.value = 0.08;
      o1.connect(g);
      o2.connect(g);
      g.connect(lp);
      o1.start();
      o2.start();
      this.nodes.push(o1, o2, g);
    }

    // slow filter LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 350;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);
    lfo.start();
    this.nodes.push(lfo, lfoGain);

    // soft bell arpeggio (sine, slow)
    const bellFreqs = [587.33, 698.46, 880.0, 1046.5]; // D5 F5 A5 C6
    let step = 0;
    const bellTimer = setInterval(() => {
      if (!this.ctx || !this.master) return;
      const now = this.ctx.currentTime;
      const f = bellFreqs[step % bellFreqs.length];
      const o = this.ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
      o.connect(g);
      g.connect(this.master);
      o.start(now);
      o.stop(now + 1.7);
      step++;
    }, 2200);
    this.bellTimer = bellTimer;

    this.playing = true;
    this.setVolume(this.targetVolume);
  }

  private bellTimer: ReturnType<typeof setInterval> | null = null;

  stop() {
    if (!this.playing) return;
    if (this.bellTimer) {
      clearInterval(this.bellTimer);
      this.bellTimer = null;
    }
    try {
      for (const n of this.nodes) {
        if ("stop" in n && typeof (n as OscillatorNode).stop === "function") {
          (n as OscillatorNode).stop();
        }
        n.disconnect();
      }
      this.master?.disconnect();
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.nodes = [];
    this.master = null;
    this.ctx = null;
    this.playing = false;
  }

  isPlaying() {
    return this.playing;
  }
}
