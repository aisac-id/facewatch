// FaceWatch — video sources. Everything is drawn into one shared source canvas
// so the detector always reads plain pixels (no CORS taint: CCTV streams are
// fetched as bytes with the extension's host permission, then decoded locally).
//
//  · demo     — built-in CCTV-style feed of an AI-generated sample face
//  · webcam   — getUserMedia
//  · mjpeg    — multipart MJPEG stream (most IP cams: http://cam/video.cgi)
//  · snapshot — JPEG snapshot URL polled on an interval (http://cam/jpg)

export class SourceManager {
  constructor(canvas, onStatus) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onStatus = onStatus;
    this.mode = "none";
    this.fps = 0;
    this._frames = 0;
    this._fpsAt = performance.now();
    this._abort = null;
    this._video = null;
    this._stream = null;
    this._demoImg = null;
    this._snapTimer = null;
    this._lastBitmap = null;
  }

  get width() { return this.canvas.width; }
  get height() { return this.canvas.height; }

  stop() {
    if (this._abort) { this._abort.abort(); this._abort = null; }
    if (this._snapTimer) { clearTimeout(this._snapTimer); this._snapTimer = null; }
    if (this._stream) { this._stream.getTracks().forEach((t) => t.stop()); this._stream = null; }
    if (this._video) { this._video.srcObject = null; this._video = null; }
    if (this._lastBitmap) { this._lastBitmap.close(); this._lastBitmap = null; }
    this.mode = "none";
    this.fps = 0;
  }

  _countFrame() {
    this._frames++;
    const now = performance.now();
    if (now - this._fpsAt > 1000) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsAt));
      this._frames = 0;
      this._fpsAt = now;
    }
  }

  /* ── demo feed ── */
  async useDemo() {
    this.stop();
    if (!this._demoImg) {
      this._demoImg = await loadImage("assets/sample-face.jpg");
    }
    this.canvas.width = 960;
    this.canvas.height = 540;
    this.mode = "demo";
    this.onStatus("live");
  }

  /* ── webcam ── */
  async useWebcam(deviceId) {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 }, height: { ideal: 720 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }),
      },
      audio: false,
    });
    this._stream = stream;
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true;
    v.srcObject = stream;
    await v.play();
    await new Promise((res) => {
      if (v.videoWidth) return res();
      v.onloadedmetadata = () => res();
    });
    this._video = v;
    this.canvas.width = v.videoWidth || 1280;
    this.canvas.height = v.videoHeight || 720;
    this.mode = "webcam";
    this.onStatus("live");
  }

  async listCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === "videoinput");
    } catch { return []; }
  }

  /* ── MJPEG stream ── */
  async useMjpeg(url, auth) {
    this.stop();
    const abort = new AbortController();
    this._abort = abort;
    this.onStatus("connecting");
    const res = await fetch(url, { headers: authHeader(auth), signal: abort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from camera`);
    if (!res.body) throw new Error("Camera returned no stream body");
    this.mode = "mjpeg";
    this.onStatus("live");
    this._pumpMjpeg(res.body.getReader(), abort);
  }

  async _pumpMjpeg(reader, abort) {
    let buf = new Uint8Array(0);
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buf = concatBytes(buf, value);
        // pull every complete JPEG (SOI FFD8 … EOI FFD9) out of the byte stream
        for (;;) {
          const start = findBytes(buf, [0xff, 0xd8], 0);
          if (start < 0) { buf = buf.slice(-2); break; }
          const end = findBytes(buf, [0xff, 0xd9], start + 2);
          if (end < 0) { if (start > 0) buf = buf.slice(start); break; }
          const jpg = buf.slice(start, end + 2);
          buf = buf.slice(end + 2);
          await this._pushJpeg(jpg);
        }
        if (buf.length > 8_000_000) buf = buf.slice(-1_000_000); // runaway guard
      }
      if (!abort.signal.aborted) this.onStatus("ended");
    } catch (e) {
      if (!abort.signal.aborted) this.onStatus("error: " + e.message);
    }
  }

  /* ── snapshot polling ── */
  async useSnapshot(url, auth, intervalMs = 1000) {
    this.stop();
    const abort = new AbortController();
    this._abort = abort;
    this.onStatus("connecting");
    const grab = async () => {
      if (abort.signal.aborted) return;
      try {
        const res = await fetch(url, { headers: authHeader(auth), signal: abort.signal, cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        await this._pushJpeg(bytes);
        this.onStatus("live");
      } catch (e) {
        if (abort.signal.aborted) return;
        this.onStatus("error: " + e.message);
      }
      if (!abort.signal.aborted) this._snapTimer = setTimeout(grab, intervalMs);
    };
    this.mode = "snapshot";
    await grab();
  }

  async _pushJpeg(bytes) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (this.canvas.width !== bmp.width || this.canvas.height !== bmp.height) {
        this.canvas.width = bmp.width;
        this.canvas.height = bmp.height;
      }
      this.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      this._countFrame();
    } catch { /* skip corrupt frame */ }
  }

  /* ── per-rAF tick: keep the source canvas fresh for push-less sources ── */
  tick(t) {
    if (this.mode === "webcam" && this._video && this._video.readyState >= 2) {
      this.ctx.drawImage(this._video, 0, 0, this.canvas.width, this.canvas.height);
      this._countFrame();
    } else if (this.mode === "demo" && this._demoImg) {
      this._drawDemo(t);
      this._countFrame();
    }
  }

  _drawDemo(t) {
    const c = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const img = this._demoImg;
    // slow ken-burns pan/zoom so the feed feels alive
    const zoom = 1.12 + Math.sin(t * 0.21) * 0.07;
    const panX = Math.sin(t * 0.13) * w * 0.045;
    const panY = Math.cos(t * 0.17) * h * 0.035;
    const scale = Math.max(w / img.width, h / img.height) * zoom;
    const dw = img.width * scale, dh = img.height * scale;
    c.fillStyle = "#000";
    c.fillRect(0, 0, w, h);
    c.drawImage(img, (w - dw) / 2 + panX, (h - dh) / 2 + panY, dw, dh);
    // CCTV flavour: vignette + flicker + scan noise
    const vg = c.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(2,8,14,0.55)");
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);
    c.fillStyle = `rgba(120,255,190,${0.02 + Math.sin(t * 7.3) * 0.012})`;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      c.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
      c.fillRect(Math.random() * w, Math.random() * h, 2, 1);
    }
  }
}

function authHeader(auth) {
  if (auth && auth.user) {
    return { Authorization: "Basic " + btoa(`${auth.user}:${auth.pass || ""}`) };
  }
  return {};
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Failed to load " + src));
    img.src = src;
  });
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function findBytes(hay, needle, from) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}