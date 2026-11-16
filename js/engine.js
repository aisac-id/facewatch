// FaceWatch — recognition engine on face-api.js (TensorFlow.js).
// Detection: TinyFaceDetector · Alignment: 68 landmarks · Identity: 128-float
// descriptor per face. Matching = euclidean distance vs every enrolled sample;
// the person's best (minimum) distance wins; below threshold => known.

/* global faceapi */

let ready = false;

export async function initEngine(onStatus) {
  onStatus("loading");
  const uri = "vendor/weights";
  try {
    await faceapi.tf.setBackend("webgl");
  } catch {
    await faceapi.tf.setBackend("cpu");
  }
  await faceapi.tf.ready();
  await faceapi.nets.tinyFaceDetector.loadFromUri(uri);
  onStatus("models 1/3");
  await faceapi.nets.faceLandmark68Net.loadFromUri(uri);
  onStatus("models 2/3");
  await faceapi.nets.faceRecognitionNet.loadFromUri(uri);
  ready = true;
  onStatus("ready");
}

export const engineReady = () => ready;

export async function detect(canvas, { inputSize = 320, minConfidence = 0.4 } = {}) {
  if (!ready) return [];
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: minConfidence });
  return faceapi.detectAllFaces(canvas, opts).withFaceLandmarks().withFaceDescriptors();
}

// One face from a still image (for photo enrollment). Returns the best result or null.
export async function detectStill(imgEl, opts) {
  const all = await detect(imgEl, opts);
  if (!all.length) return null;
  return all.reduce((a, b) => (a.detection.box.area > b.detection.box.area ? a : b));
}

export function distance(a, b) {
  return faceapi.euclideanDistance(a, b);
}

// Best match across the whole database.
// Returns { person, dist } or { person: null, dist } (dist = best distance seen, or 1).
export function match(descriptor, persons, threshold) {
  let best = { person: null, dist: 1 };
  for (const p of persons) {
    let min = 1;
    for (const s of p.samples) {
      const d = faceapi.euclideanDistance(descriptor, s.descriptor);
      if (d < min) min = d;
    }
    if (min < best.dist) best = { person: p, dist: min };
  }
  return { ...best, known: best.person !== null && best.dist <= threshold };
}

// Crop a face (with padding) from a source canvas into a square thumbnail dataURL.
export function faceThumb(srcCanvas, box, size = 112) {
  const pad = box.width * 0.35;
  const sx = Math.max(0, box.x - pad);
  const sy = Math.max(0, box.y - pad);
  const sw = Math.min(srcCanvas.width - sx, box.width + pad * 2);
  const sh = Math.min(srcCanvas.height - sy, box.height + pad * 2);
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const ctx = c.getContext("2d");
  const side = Math.max(sw, sh);
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, (size - (sw / side) * size) / 2, (size - (sh / side) * size) / 2, (sw / side) * size, (sh / side) * size);
  return c.toDataURL("image/jpeg", 0.82);
}