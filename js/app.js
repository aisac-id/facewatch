// FaceWatch — orchestrates sources, the recognition engine, face tracks,
// the HUD overlay, the face database, alerts and the event log.

import { SourceManager } from "./sources.js";
import { initEngine, engineReady, detect, detectStill, match, faceThumb } from "./engine.js";
import * as db from "./db.js";
import { sfx, setSound } from "./audio.js";

const $ = (id) => document.getElementById(id);

/* ── tuning state (persisted) ──────────────────────────────── */

const TUNE_KEY = "facewatch-tuning-v1";
const DEFAULT_TUNE = {
  threshold: 0.5,
  interval: 250,
  minConf: 0.4,
  inputSize: 320,
  boxStyle: "brackets",
  labels: true,
  landmarks: true,
  mirror: false,
  alerts: true,
  sound: true,
};
const tune = { ...DEFAULT_TUNE };
let paused = false;

function persistTune() {
  clearTimeout(persistTune._t);
  persistTune._t = setTimeout(() => {
    chrome.storage.local.set({ [TUNE_KEY]: { ...tune } }).catch(() => {});
  }, 250);
}
async function restoreTune() {
  try {
    const obj = await chrome.storage.local.get(TUNE_KEY);
    Object.assign(tune, obj[TUNE_KEY] || {});
  } catch {}
}

/* ── toasts ────────────────────────────────────────────────── */

function toast(msg, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.err ? " err" : "");
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);
  if (opts.action) {
    const btn = document.createElement("button");
    btn.textContent = opts.action;
    btn.onclick = () => { opts.onAction?.(); kill(); };
    el.appendChild(btn);
  }
  $("toasts").appendChild(el);
  const kill = () => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  };
  setTimeout(kill, opts.timeout || 2800);
  return kill;
}

/* ── source & canvases ─────────────────────────────────────── */

const srcCanvas = document.createElement("canvas");
srcCanvas.width = 960; srcCanvas.height = 540;
const view = $("view"), hud = $("hud");
const viewCtx = view.getContext("2d");
const hudCtx = hud.getContext("2d");

const src = new SourceManager(srcCanvas, onSourceStatus);
let lastSourceKind = "demo";

function onSourceStatus(status) {
  const chip = $("srcChip");
  const label = { demo: "DEMO FEED", webcam: "WEBCAM", mjpeg: "CCTV STREAM", snapshot: "CCTV SNAPSHOT" }[src.mode] || "STANDBY";
  if (status === "live") {
    chip.className = "";
    $("srcChipText").textContent = `LIVE · ${label}`;
    $("srcStatus").textContent = src.mode === "mjpeg" || src.mode === "snapshot"
      ? `${label.toLowerCase()} · ${src.fps || "…"} fps`
      : `${label.toLowerCase()} · local`;
    $("srcGate").classList.add("hidden");
  } else if (status === "connecting") {
    chip.className = "warn";
    $("srcChipText").textContent = `CONNECTING · ${label}`;
    $("srcStatus").textContent = "connecting…";
  } else {
    chip.className = "err";
    $("srcChipText").textContent = status.toUpperCase();
    $("srcStatus").textContent = status;
    if (status.startsWith("error") || status === "ended") {
      showGate("Camera feed lost", `${status}. Check the URL, credentials and that the camera is reachable from this machine.`);
    }
  }
}

function showGate(title, msg) {
  $("gateTitle").textContent = title;
  $("gateMsg").textContent = msg;
  $("srcGate").classList.remove("hidden");
}

async function switchSource(kind, { silent = false } = {}) {
  lastSourceKind = kind;
  const isStream = kind === "mjpeg" || kind === "snapshot";
  $("deviceWrap").classList.toggle("hidden", kind !== "webcam");
  for (const id of ["urlWrap", "userWrap", "passWrap", "connectBtn"]) {
    $(id).classList.toggle("hidden", !isStream);
  }
  tracks.length = 0;
  renderMatches();
  try {
    if (kind === "demo") await src.useDemo();
    else if (kind === "webcam") {
      await src.useWebcam($("deviceSel").value || undefined);
      listCameras();
    } else {
      const url = $("urlInput").value.trim();
      if (!url) { showGate("No camera URL", "Enter your camera's MJPEG stream or snapshot URL, then press Connect."); return; }
      const auth = { user: $("authUser").value.trim(), pass: $("authPass").value };
      if (kind === "mjpeg") await src.useMjpeg(url, auth);
      else await src.useSnapshot(url, auth, Math.max(500, tune.interval));
    }
    if (!silent) toast(`Source → ${$("sourceSel").selectedOptions[0].textContent}`);
  } catch (e) {
    console.warn("source:", e.message);
    sfx.error();
    onSourceStatus("error: " + e.message);
    showGate("Source unavailable", e.message + (kind === "webcam" ? " — allow camera access, or use the demo feed." : ""));
  }
}

async function listCameras() {
  const cams = await src.listCameras();
  const sel = $("deviceSel");
  const cur = sel.value;
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = ""; def.textContent = "default";
  sel.appendChild(def);
  cams.forEach((d, i) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

/* ── face tracks ───────────────────────────────────────────── */

const tracks = [];
let nextTrackId = 1;
let scanning = false;
let lastUnknownAlert = 0;

function center(box) { return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }

function processResults(results) {
  const now = performance.now();
  const people = db.persons();
  const used = new Set();

  for (const r of results) {
    const box = r.detection.box;
    const c = center(box);
    // associate with the nearest recent track
    let best = null, bestD = Infinity;
    for (const tr of tracks) {
      if (used.has(tr.id)) continue;
      const tc = center(tr.box);
      const d = Math.hypot(tc.x - c.x, tc.y - c.y);
      const lim = Math.max(box.width, tr.box.width) * 0.75;
      if (d < lim && d < bestD) { best = tr; bestD = d; }
    }
    const m = match(r.descriptor, people, tune.threshold);
    const identity = m.known ? m.person.id : "unknown";
    const name = m.known ? m.person.name : "UNKNOWN";

    if (best) {
      best.box = { x: box.x, y: box.y, width: box.width, height: box.height };
      best.lastSeen = now;
      best.descriptor = r.descriptor;
      best.landmarks = r.landmarks;
      best.dist = m.dist;
      best.known = m.known;
      best.name = name;
      best.score = r.detection.score;
      if (best.identity !== identity) {
        best.identity = identity;
        logEvent(best);
      }
      used.add(best.id);
    } else {
      const tr = {
        id: nextTrackId++,
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        draw: { x: box.x, y: box.y, width: box.width, height: box.height },
        lastSeen: now,
        descriptor: r.descriptor,
        landmarks: r.landmarks,
        dist: m.dist, known: m.known, name, identity,
        score: r.detection.score,
      };
      tracks.push(tr);
      used.add(tr.id);
      logEvent(tr);
    }
  }
  // prune stale tracks
  for (let i = tracks.length - 1; i >= 0; i--) {
    if (now - tracks[i].lastSeen > 900) tracks.splice(i, 1);
  }
  renderMatches();
}

function logEvent(tr) {
  const thumb = faceThumb(srcCanvas, tr.box, 72);
  addLog({ at: Date.now(), name: tr.name, known: tr.known, dist: tr.dist, thumb });
  if (tr.known) {
    sfx.ok();
  } else if (tune.alerts) {
    const now = performance.now();
    if (now - lastUnknownAlert > 4000) {
      lastUnknownAlert = now;
      sfx.alert();
      const flash = $("alertFlash");
      flash.classList.remove("on");
      void flash.offsetWidth;
      flash.classList.add("on");
    }
  }
}

async function scanLoop() {
  if (!paused && engineReady() && src.mode !== "none" && !scanning && srcCanvas.width > 0) {
    scanning = true;
    try {
      const results = await detect(srcCanvas, { inputSize: tune.inputSize, minConfidence: tune.minConf });
      processResults(results);
    } catch (e) {
      console.warn("scan:", e.message);
    }
    scanning = false;
  }
  setTimeout(scanLoop, tune.interval);
}

/* ── HUD rendering ─────────────────────────────────────────── */

const GREEN = "#22ff88", RED = "#ff3b5c";

function drawHud() {
  const W = hud.width, H = hud.height;
  hudCtx.clearRect(0, 0, W, H);
  const mirror = tune.mirror;
  const mx = (x, w) => (mirror ? W - x - w : x);

  for (const tr of tracks) {
    // smooth box motion between scans
    for (const k of ["x", "y", "width", "height"]) {
      tr.draw[k] += (tr.box[k] - tr.draw[k]) * 0.35;
    }
    const { x, y, width: w, height: h } = tr.draw;
    const X = mx(x, w);
    const col = tr.known ? GREEN : RED;

    hudCtx.save();
    hudCtx.strokeStyle = col;
    hudCtx.fillStyle = col;
    if (tune.boxStyle === "brackets") {
      const L = Math.min(w, h) * 0.22;
      hudCtx.lineWidth = Math.max(2.5, w * 0.018);
      hudCtx.shadowColor = col;
      hudCtx.shadowBlur = 10;
      hudCtx.beginPath();
      hudCtx.moveTo(X, y + L); hudCtx.lineTo(X, y); hudCtx.lineTo(X + L, y);
      hudCtx.moveTo(X + w - L, y); hudCtx.lineTo(X + w, y); hudCtx.lineTo(X + w, y + L);
      hudCtx.moveTo(X + w, y + h - L); hudCtx.lineTo(X + w, y + h); hudCtx.lineTo(X + w - L, y + h);
      hudCtx.moveTo(X + L, y + h); hudCtx.lineTo(X, y + h); hudCtx.lineTo(X, y + h - L);
      hudCtx.stroke();
      hudCtx.shadowBlur = 0;
      hudCtx.globalAlpha = 0.22;
      hudCtx.lineWidth = 1;
      hudCtx.strokeRect(X, y, w, h);
      hudCtx.globalAlpha = 1;
    } else if (tune.boxStyle === "solid") {
      hudCtx.globalAlpha = 0.07;
      hudCtx.fillRect(X, y, w, h);
      hudCtx.globalAlpha = 1;
      hudCtx.lineWidth = Math.max(2, w * 0.014);
      hudCtx.shadowColor = col;
      hudCtx.shadowBlur = 8;
      hudCtx.strokeRect(X, y, w, h);
      hudCtx.shadowBlur = 0;
    } else {
      hudCtx.lineWidth = 1.5;
      hudCtx.globalAlpha = 0.9;
      hudCtx.strokeRect(X, y, w, h);
      hudCtx.globalAlpha = 1;
    }

    // landmark dots
    if (tune.landmarks && tr.landmarks) {
      hudCtx.globalAlpha = 0.55;
      for (const p of tr.landmarks.positions) {
        const px = mirror ? W - p.x : p.x;
        hudCtx.fillRect(px - 1, p.y - 1, 2.2, 2.2);
      }
      hudCtx.globalAlpha = 1;
    }

    // label chip
    if (tune.labels) {
      const pct = Math.round(Math.max(0, 1 - tr.dist) * 100);
      const text = tr.known ? `${tr.name} · ${pct}%` : `UNKNOWN · d${tr.dist.toFixed(2)}`;
      const fs = Math.max(13, Math.round(w * 0.085));
      hudCtx.font = `600 ${fs}px "Space Grotesk", system-ui, sans-serif`;
      const tw = hudCtx.measureText(text).width;
      const pad = fs * 0.55;
      const chipW = tw + pad * 2, chipH = fs + pad * 1.1;
      let cx = Math.min(Math.max(0, X), W - chipW);
      let cy = y - chipH - 6;
      if (cy < 0) cy = y + h + 6;
      hudCtx.fillStyle = "rgba(3,9,15,0.85)";
      hudCtx.strokeStyle = col;
      hudCtx.lineWidth = 1.5;
      hudCtx.beginPath();
      hudCtx.roundRect(cx, cy, chipW, chipH, 7);
      hudCtx.fill();
      hudCtx.stroke();
      hudCtx.fillStyle = col;
      hudCtx.textBaseline = "middle";
      hudCtx.fillText(text, cx + pad, cy + chipH / 2 + 1);
    }
    hudCtx.restore();
  }
}

/* ── live match list ───────────────────────────────────────── */

function renderMatches() {
  const list = $("matchList");
  list.innerHTML = "";
  $("matchEmpty").classList.toggle("hidden", tracks.length > 0);
  $("matchCount").textContent = `${tracks.length} in frame`;
  $("facesPill").textContent = `${tracks.length} face${tracks.length === 1 ? "" : "s"}`;
  const sorted = [...tracks].sort((a, b) => b.box.width - a.box.width);
  for (const tr of sorted) {
    const pct = Math.round(Math.max(0, 1 - tr.dist) * 100);
    const row = document.createElement("div");
    row.className = "match-row " + (tr.known ? "known" : "unknown");
    const dot = document.createElement("i");
    dot.className = "match-dot";
    const info = document.createElement("div");
    info.className = "match-info";
    const nm = document.createElement("div");
    nm.className = "match-name";
    nm.textContent = tr.name;
    const bar = document.createElement("div");
    bar.className = "match-bar";
    const fill = document.createElement("i");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    info.append(nm, bar);
    const nums = document.createElement("div");
    nums.className = "match-nums";
    const p = document.createElement("div");
    p.className = "match-pct";
    p.textContent = tr.known ? `${pct}%` : "—";
    const d = document.createElement("div");
    d.className = "match-dist";
    d.textContent = `d ${tr.dist.toFixed(2)}`;
    nums.append(p, d);
    row.append(dot, info, nums);
    list.appendChild(row);
  }
}

/* ── event log ─────────────────────────────────────────────── */

const logEntries = [];

function addLog(entry) {
  logEntries.unshift(entry);
  if (logEntries.length > 100) logEntries.pop();
  renderLog();
}

function renderLog() {
  const filter = $("logFilter").value;
  const list = $("logList");
  list.innerHTML = "";
  const shown = logEntries.filter((e) =>
    filter === "all" || (filter === "known" ? e.known : !e.known));
  $("logEmpty").classList.toggle("hidden", shown.length > 0);
  for (const e of shown.slice(0, 60)) {
    const row = document.createElement("div");
    row.className = "log-row " + (e.known ? "known" : "unknown");
    const img = document.createElement("img");
    img.src = e.thumb; img.alt = "";
    const info = document.createElement("div");
    info.className = "log-info";
    const nm = document.createElement("div");
    nm.className = "log-name";
    nm.textContent = e.known ? e.name : "UNKNOWN FACE";
    const tm = document.createElement("div");
    tm.className = "log-time";
    tm.textContent = new Date(e.at).toLocaleTimeString();
    info.append(nm, tm);
    const d = document.createElement("span");
    d.className = "log-dist";
    d.textContent = `d ${e.dist.toFixed(2)}`;
    row.append(img, info, d);
    list.appendChild(row);
  }
}

/* ── database UI ───────────────────────────────────────────── */

function renderDB() {
  const people = db.persons();
  $("dbCount").textContent = `${people.length} people · ${db.sampleCount()} samples`;
  $("dbPill").textContent = `db: ${people.length}·${db.sampleCount()}`;
  $("dbEmpty").classList.toggle("hidden", people.length > 0);
  const list = $("personList");
  list.innerHTML = "";
  for (const p of people) {
    const card = document.createElement("button");
    card.className = "person-card";
    const img = document.createElement("img");
    img.src = p.samples[0].thumb; img.alt = "";
    const info = document.createElement("div");
    info.className = "person-info";
    const nm = document.createElement("div");
    nm.className = "person-name";
    nm.textContent = p.name;
    const meta = document.createElement("div");
    meta.className = "person-meta";
    meta.textContent = `${p.samples.length} sample${p.samples.length === 1 ? "" : "s"}${p.note ? " · " + p.note : ""}`;
    info.append(nm, meta);
    const chev = document.createElement("span");
    chev.className = "chev"; chev.textContent = "›";
    card.append(img, info, chev);
    card.onclick = () => openPerson(p.id);
    list.appendChild(card);
  }
}

/* ── enrollment ────────────────────────────────────────────── */

let stagedSample = null;

function captureLargestFace() {
  if (!tracks.length) return null;
  const tr = [...tracks].sort((a, b) => b.box.width - a.box.width)[0];
  return {
    descriptor: Array.from(tr.descriptor),
    thumb: faceThumb(srcCanvas, tr.box),
    addedAt: Date.now(),
  };
}

function openEnroll() {
  if (!engineReady()) { toast("Engine still loading — one moment", { err: true }); sfx.error(); return; }
  stagedSample = captureLargestFace();
  if (!stagedSample) {
    toast("No face in frame — show a face to the camera first", { err: true });
    sfx.error();
    return;
  }
  $("enrollThumb").src = stagedSample.thumb;
  const sel = $("enrollTarget");
  sel.innerHTML = "";
  const nw = document.createElement("option");
  nw.value = ""; nw.textContent = "➕ New person";
  sel.appendChild(nw);
  for (const p of db.persons()) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = `↳ add sample to ${p.name}`;
    sel.appendChild(o);
  }
  $("enrollName").value = "";
  $("enrollNote").value = "";
  syncEnrollTarget();
  $("enrollModal").classList.remove("hidden");
  sfx.shutter();
  setTimeout(() => $("enrollName").focus(), 60);
}

function syncEnrollTarget() {
  const isNew = !$("enrollTarget").value;
  $("enrollNameWrap").classList.toggle("hidden", !isNew);
  $("enrollNoteWrap").classList.toggle("hidden", !isNew);
}

async function saveEnroll() {
  if (!stagedSample) return;
  const target = $("enrollTarget").value;
  if (target) {
    const p = await db.addSample(target, stagedSample);
    toast(`Sample added to ${p.name} (${p.samples.length} total)`);
  } else {
    const name = $("enrollName").value.trim();
    if (!name) { toast("Give this person a name first", { err: true }); $("enrollName").focus(); return; }
    const p = await db.addPerson(name, $("enrollNote").value, stagedSample);
    toast(`Enrolled ${p.name} ✓`);
  }
  stagedSample = null;
  $("enrollModal").classList.add("hidden");
  sfx.enroll();
  renderDB();
}

async function sampleFromPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const r = await detectStill(img, { inputSize: 416, minConfidence: 0.3 });
    if (!r) return null;
    // draw to a scratch canvas so faceThumb can crop it
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return {
      descriptor: Array.from(r.descriptor),
      thumb: faceThumb(c, r.detection.box),
      addedAt: Date.now(),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ── person modal ──────────────────────────────────────────── */

let openPersonId = null;

function openPerson(id) {
  const p = db.getPerson(id);
  if (!p) return;
  openPersonId = id;
  $("personTitle").textContent = p.name;
  $("pName").value = p.name;
  $("pNote").value = p.note || "";
  renderSamples();
  $("personModal").classList.remove("hidden");
  sfx.ui();
}

function renderSamples() {
  const p = db.getPerson(openPersonId);
  if (!p) return;
  $("pSampleCount").textContent = `${p.samples.length} enrolled`;
  const grid = $("pSamples");
  grid.innerHTML = "";
  p.samples.forEach((s, idx) => {
    const cell = document.createElement("div");
    cell.className = "sample-cell";
    cell.style.animationDelay = `${Math.min(idx * 0.04, 0.3)}s`;
    const img = document.createElement("img");
    img.src = s.thumb; img.alt = `sample ${idx + 1}`;
    const x = document.createElement("button");
    x.className = "x"; x.textContent = "✕";
    x.title = p.samples.length <= 1 ? "A person needs at least one sample" : "Remove this sample";
    if (p.samples.length <= 1) x.setAttribute("disabled", "");
    x.onclick = async () => {
      await db.removeSample(openPersonId, idx);
      renderSamples(); renderDB();
      sfx.ui();
    };
    cell.append(img, x);
    grid.appendChild(cell);
  });
}

/* ── export / import ───────────────────────────────────────── */

function exportDB() {
  if (!db.persons().length) { toast("Database is empty — enroll someone first", { err: true }); return; }
  const blob = new Blob([db.exportJSON()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `facewatch-db-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Database exported as JSON ⤓");
  sfx.ui();
}

async function importDB(file) {
  try {
    const added = await db.importJSON(await file.text());
    renderDB();
    toast(`Imported ${added} ${added === 1 ? "person" : "people"} ✓`);
    sfx.enroll();
  } catch (e) {
    toast("Import failed: " + e.message, { err: true });
    sfx.error();
  }
}

/* ── tuning UI ─────────────────────────────────────────────── */

function paintRange(input) {
  const min = +input.min, max = +input.max, v = +input.value;
  input.style.setProperty("--val", `${((v - min) / (max - min)) * 100}%`);
  const out = input.parentElement.querySelector("output");
  if (out) out.textContent = max <= 1 ? v.toFixed(2) : Math.round(v);
}

function setToggle(btn, on) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-checked", String(on));
}

function refreshTuneUI() {
  for (const id of ["threshold", "interval", "minConf"]) {
    $(id).value = tune[id];
    paintRange($(id));
  }
  $("inputSize").value = String(tune.inputSize);
  $("boxStyle").value = tune.boxStyle;
  setToggle($("labelsTgl"), tune.labels);
  setToggle($("landmarksTgl"), tune.landmarks);
  setToggle($("mirrorTgl"), tune.mirror);
  setToggle($("alertTgl"), tune.alerts);
  syncSound();
}

const SOUND_ON_PATH = "M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z";
const SOUND_OFF_PATH = "M3 9v6h4l5 5V4L7 9H3zm18.6 3 2.1-2.1-1.4-1.4-2.1 2.1-2.1-2.1-1.4 1.4 2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z";

function syncSound() {
  setSound(tune.sound);
  $("soundPath").setAttribute("d", tune.sound ? SOUND_ON_PATH : SOUND_OFF_PATH);
  $("soundBtn").classList.toggle("muted-state", !tune.sound);
  $("soundBtn").classList.toggle("active", tune.sound);
}

function setPaused(on) {
  paused = on;
  $("pauseVeil").classList.toggle("hidden", !on);
  $("stage").classList.toggle("paused", on);
  $("pauseBtn").classList.toggle("paused-state", on);
  $("pausePath").setAttribute("d", on ? "M8 5v14l11-7z" : "M7 4h4v16H7zM13 4h4v16h-4z");
  sfx.ui();
}

/* ── render loop ───────────────────────────────────────────── */

let lastFrame = performance.now();
let fpsEMA = 60;
let pillTimer = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const t = now / 1000;

  if (!paused) src.tick(t);

  // keep display canvases matched to the source
  if (view.width !== srcCanvas.width || view.height !== srcCanvas.height) {
    view.width = hud.width = srcCanvas.width;
    view.height = hud.height = srcCanvas.height;
    $("stage").style.aspectRatio = `${srcCanvas.width} / ${srcCanvas.height}`;
  }

  viewCtx.save();
  if (tune.mirror) {
    viewCtx.translate(view.width, 0);
    viewCtx.scale(-1, 1);
  }
  viewCtx.drawImage(srcCanvas, 0, 0);
  viewCtx.restore();

  drawHud();

  fpsEMA = fpsEMA * 0.92 + (1 / Math.max(dt, 0.001)) * 0.08;
  pillTimer += dt;
  if (pillTimer > 0.5) {
    pillTimer = 0;
    $("fpsPill").textContent = `${Math.round(Math.min(fpsEMA, 240))} fps`;
    if (src.mode === "mjpeg" || src.mode === "snapshot") {
      $("srcStatus").textContent = `${src.mode === "mjpeg" ? "cctv stream" : "cctv snapshot"} · ${src.fps} fps`;
    }
  }
  requestAnimationFrame(frame);
}

/* ── wiring ────────────────────────────────────────────────── */

function wire() {
  // source bar
  $("sourceSel").onchange = (e) => switchSource(e.target.value);
  $("connectBtn").onclick = () => switchSource($("sourceSel").value);
  $("urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") switchSource($("sourceSel").value); });
  $("deviceSel").onchange = () => { if (src.mode === "webcam") switchSource("webcam", { silent: true }); };
  $("gateRetry").onclick = () => switchSource(lastSourceKind, { silent: true });
  $("gateDemo").onclick = () => { $("sourceSel").value = "demo"; switchSource("demo"); };

  // tuning
  for (const id of ["threshold", "interval", "minConf"]) {
    $(id).oninput = () => {
      tune[id] = +$(id).value;
      paintRange($(id));
      persistTune();
      if (id === "threshold") {
        // re-evaluate current tracks immediately
        for (const tr of tracks) {
          const m = match(tr.descriptor, db.persons(), tune.threshold);
          tr.known = m.known; tr.dist = m.dist;
          tr.name = m.known ? m.person.name : "UNKNOWN";
          tr.identity = m.known ? m.person.id : "unknown";
        }
        renderMatches();
      }
    };
  }
  $("inputSize").onchange = (e) => { tune.inputSize = +e.target.value; persistTune(); sfx.ui(); };
  $("boxStyle").onchange = (e) => { tune.boxStyle = e.target.value; persistTune(); sfx.ui(); };
  for (const [id, key] of [["labelsTgl", "labels"], ["landmarksTgl", "landmarks"], ["mirrorTgl", "mirror"], ["alertTgl", "alerts"]]) {
    $(id).onclick = () => {
      tune[key] = !tune[key];
      setToggle($(id), tune[key]);
      persistTune();
      sfx.ui();
    };
  }
  $("resetTuneBtn").onclick = () => {
    Object.assign(tune, DEFAULT_TUNE);
    refreshTuneUI();
    persistTune();
    toast("Tuning reset to defaults");
    sfx.ui();
  };

  // database
  $("enrollBtn").onclick = openEnroll;
  $("exportBtn").onclick = exportDB;
  $("importBtn").onclick = () => $("importFile").click();
  $("importFile").onchange = async (e) => {
    if (e.target.files[0]) await importDB(e.target.files[0]);
    e.target.value = "";
  };

  // enroll modal
  $("enrollTarget").onchange = syncEnrollTarget;
  $("enrollSave").onclick = saveEnroll;
  $("enrollName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveEnroll(); });
  $("enrollPhotoBtn").onclick = () => $("enrollFile").click();
  $("enrollFile").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    toast("Reading photo…");
    const s = await sampleFromPhoto(file);
    if (s) {
      stagedSample = s;
      $("enrollThumb").src = s.thumb;
      toast("Face found in photo ✓");
      sfx.shutter();
    } else {
      toast("No face found in that photo", { err: true });
      sfx.error();
    }
  };

  // person modal
  $("pSave").onclick = async () => {
    const p = await db.renamePerson(openPersonId, $("pName").value, $("pNote").value);
    if (p) {
      $("personTitle").textContent = p.name;
      renderDB();
      toast("Saved ✓");
      sfx.ui();
    }
  };
  $("pAddCam").onclick = async () => {
    const s = captureLargestFace();
    if (!s) { toast("No face in frame right now", { err: true }); sfx.error(); return; }
    await db.addSample(openPersonId, s);
    renderSamples(); renderDB();
    toast("Sample added from camera ✓");
    sfx.enroll();
  };
  $("pUpload").onclick = () => $("pFiles").click();
  $("pFiles").onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (!files.length) return;
    toast(`Scanning ${files.length} photo${files.length === 1 ? "" : "s"}…`);
    let ok = 0;
    for (const f of files) {
      const s = await sampleFromPhoto(f);
      if (s) { await db.addSample(openPersonId, s); ok++; }
    }
    renderSamples(); renderDB();
    if (ok) { toast(`Added ${ok} sample${ok === 1 ? "" : "s"} ✓`); sfx.enroll(); }
    else { toast("No faces found in those photos", { err: true }); sfx.error(); }
  };
  $("pDelete").onclick = async () => {
    const removed = await db.removePerson(openPersonId);
    if (!removed) return;
    $("personModal").classList.add("hidden");
    renderDB();
    sfx.error();
    toast(`Deleted ${removed.person.name}`, {
      action: "Undo", timeout: 5000,
      onAction: async () => {
        await db.restorePerson(removed.person, removed.index);
        renderDB();
        toast("Restored ✓");
      },
    });
  };

  // log
  $("logFilter").onchange = renderLog;
  $("clearLogBtn").onclick = () => { logEntries.length = 0; renderLog(); sfx.ui(); };

  // top bar
  $("soundBtn").onclick = () => { tune.sound = !tune.sound; syncSound(); if (tune.sound) sfx.ui(); persistTune(); };
  $("pauseBtn").onclick = () => setPaused(!paused);
  $("helpBtn").onclick = () => $("helpModal").classList.remove("hidden");

  // modal close buttons + scrim click
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.onclick = () => $(btn.dataset.close).classList.add("hidden");
  });
  for (const id of ["enrollModal", "personModal", "helpModal"]) {
    $(id).addEventListener("click", (e) => { if (e.target === $(id)) $(id).classList.add("hidden"); });
  }

  // keyboard
  window.addEventListener("keydown", (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
      if (e.key === "Escape") document.activeElement.blur();
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (tag === "BUTTON") document.activeElement.blur();
      setPaused(!paused);
    }
    else if (e.key === "e" || e.key === "E") openEnroll();
    else if (e.key === "m" || e.key === "M") { tune.mirror = !tune.mirror; setToggle($("mirrorTgl"), tune.mirror); persistTune(); }
    else if (e.key === "s" || e.key === "S") { tune.sound = !tune.sound; syncSound(); persistTune(); }
    else if (e.key === "?") $("helpModal").classList.remove("hidden");
    else if (e.key === "Escape") {
      for (const id of ["enrollModal", "personModal", "helpModal"]) $(id).classList.add("hidden");
    }
  });

  // clock chip
  const tickClock = () => {
    $("clockChip").textContent = new Date().toLocaleTimeString("en-GB");
  };
  tickClock();
  setInterval(tickClock, 1000);

  navigator.mediaDevices?.addEventListener?.("devicechange", listCameras);
}

/* ── boot ──────────────────────────────────────────────────── */

async function boot() {
  await restoreTune();
  await db.loadDB();
  refreshTuneUI();
  renderDB();
  renderLog();
  wire();

  requestAnimationFrame(frame);
  await switchSource("demo", { silent: true });

  const pill = $("enginePill");
  try {
    await initEngine((status) => {
      if (status === "ready") {
        pill.className = "pill live";
        pill.innerHTML = '<i class="dot"></i>engine: ready';
      } else {
        pill.className = "pill warn";
        pill.innerHTML = `<i class="dot"></i>engine: ${status}`;
      }
    });
    toast("Recognition engine ready — enroll a face to begin");
    scanLoop();
  } catch (e) {
    console.error("engine:", e);
    pill.className = "pill err";
    pill.innerHTML = '<i class="dot"></i>engine: failed';
    showGate("Recognition engine failed", e.message + " — try reloading the page.");
  }
}

boot();