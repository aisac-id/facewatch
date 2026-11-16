// FaceWatch — face database in chrome.storage.local.
// A person = { id, name, note, createdAt, samples: [{ descriptor:[128 floats], thumb, addedAt }] }
// More samples (different angles / lighting) => more robust matching.

const DB_KEY = "facewatch-db-v1";

let cache = { persons: [] };
let loaded = false;

export async function loadDB() {
  if (loaded) return cache;
  const obj = await chrome.storage.local.get(DB_KEY);
  cache = obj[DB_KEY] || { persons: [] };
  loaded = true;
  return cache;
}

async function flush() {
  await chrome.storage.local.set({ [DB_KEY]: cache });
}

export const persons = () => cache.persons;
export const sampleCount = () => cache.persons.reduce((n, p) => n + p.samples.length, 0);
export const getPerson = (id) => cache.persons.find((p) => p.id === id);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function addPerson(name, note, sample) {
  const p = { id: uid(), name: name.trim(), note: (note || "").trim(), createdAt: Date.now(), samples: [sample] };
  cache.persons.push(p);
  await flush();
  return p;
}

export async function addSample(personId, sample) {
  const p = getPerson(personId);
  if (!p) return null;
  p.samples.push(sample);
  await flush();
  return p;
}

export async function removeSample(personId, idx) {
  const p = getPerson(personId);
  if (!p || p.samples.length <= 1) return null; // keep at least one sample
  p.samples.splice(idx, 1);
  await flush();
  return p;
}

export async function renamePerson(personId, name, note) {
  const p = getPerson(personId);
  if (!p) return null;
  p.name = name.trim() || p.name;
  p.note = (note || "").trim();
  await flush();
  return p;
}

export async function removePerson(personId) {
  const i = cache.persons.findIndex((p) => p.id === personId);
  if (i < 0) return null;
  const [p] = cache.persons.splice(i, 1);
  await flush();
  return { person: p, index: i };
}

export async function restorePerson(person, index) {
  cache.persons.splice(Math.min(index, cache.persons.length), 0, person);
  await flush();
}

export function exportJSON() {
  return JSON.stringify({
    app: "facewatch",
    version: 1,
    exportedAt: new Date().toISOString(),
    persons: cache.persons,
  }, null, 2);
}

export async function importJSON(text, { merge = true } = {}) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.persons;
  if (!Array.isArray(list)) throw new Error("Not a FaceWatch database file");
  const valid = list.filter((p) =>
    p && typeof p.name === "string" &&
    Array.isArray(p.samples) && p.samples.length &&
    p.samples.every((s) => Array.isArray(s.descriptor) && s.descriptor.length === 128)
  );
  if (!valid.length) throw new Error("No valid enrolled faces found in file");
  if (!merge) cache.persons = [];
  let added = 0;
  for (const p of valid) {
    const existing = cache.persons.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
    if (existing) {
      existing.samples.push(...p.samples);
    } else {
      cache.persons.push({ ...p, id: p.id || uid() });
    }
    added++;
  }
  await flush();
  return added;
}