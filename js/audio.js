// FaceWatch — zero-asset WebAudio synth. Every sound maps to a visible event.

let ctx = null;
let master = null;
let enabled = true;

export function setSound(on) {
  enabled = on;
  if (master) master.gain.value = on ? 0.15 : 0;
}
export const soundOn = () => enabled;

function ac() {
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = enabled ? 0.15 : 0;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone({ type = "sine", f = 440, f2 = null, t = 0.12, vol = 1, delay = 0 }) {
  if (!enabled) return;
  const c = ac();
  const o = c.createOscillator();
  const g = c.createGain();
  const t0 = c.currentTime + delay;
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + t);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + t);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + t + 0.05);
}

export const sfx = {
  ui: () => tone({ type: "triangle", f: 660, t: 0.06, vol: 0.5 }),
  ok: () => { tone({ f: 520, t: 0.09, vol: 0.7 }); tone({ f: 780, t: 0.12, vol: 0.7, delay: 0.08 }); },
  alert: () => {
    tone({ type: "sawtooth", f: 320, f2: 240, t: 0.16, vol: 0.8 });
    tone({ type: "sawtooth", f: 320, f2: 240, t: 0.16, vol: 0.8, delay: 0.2 });
  },
  enroll: () => { tone({ f: 440, f2: 880, t: 0.18, vol: 0.8 }); tone({ f: 1320, t: 0.1, vol: 0.5, delay: 0.16 }); },
  error: () => tone({ type: "square", f: 180, f2: 120, t: 0.2, vol: 0.6 }),
  shutter: () => tone({ type: "triangle", f: 1200, f2: 300, t: 0.08, vol: 0.7 }),
};