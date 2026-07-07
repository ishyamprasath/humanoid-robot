// ============================================================
// People memory — IndexedDB on the robot itself. No cloud, no
// server: only a name, a few 128-number face fingerprints, and a
// short rolling list of remembered facts. Never photos.
//
// This module is the swap point for a future cloud DB (MongoDB
// etc.): keep the API, replace the guts.
// ============================================================

const DB_NAME = "nexabot";
const STORE = "people";
const MAX_DESCRIPTORS = 5;
const MAX_NOTES = 20;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export class PeopleStore {
  constructor() {
    this._db = null;
  }

  async _ensure() {
    if (!this._db) this._db = await openDb();
    return this._db;
  }

  /** All known people: [{id, name, descriptors, notes, createdAt, lastSeenAt}] */
  async loadAll() {
    const db = await this._ensure();
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async _byName(name) {
    const all = await this.loadAll();
    const needle = String(name).trim().toLowerCase();
    return all.find((p) => p.name.toLowerCase() === needle) || null;
  }

  /**
   * Save a new person or add a face descriptor to an existing one.
   * descriptor: Float32Array | number[]
   */
  async savePerson(name, descriptor) {
    const db = await this._ensure();
    const clean = String(name).trim();
    const vec = Array.from(descriptor);
    const existing = await this._byName(clean);
    const now = Date.now();
    const person = existing || {
      id: crypto.randomUUID(),
      name: clean,
      descriptors: [],
      notes: [],
      createdAt: now,
      lastSeenAt: now,
    };
    person.descriptors.push(vec);
    person.descriptors = person.descriptors.slice(-MAX_DESCRIPTORS);
    person.lastSeenAt = now;
    await tx(db, "readwrite", (s) => s.put(person));
    return person;
  }

  /** Append a face descriptor to a known person (auto-enrichment). */
  async addDescriptor(name, descriptor) {
    const person = await this._byName(name);
    if (!person || person.descriptors.length >= MAX_DESCRIPTORS) return null;
    return this.savePerson(name, descriptor);
  }

  /** Rolling per-person memory: newest last, capped. */
  async addNote(name, note) {
    const db = await this._ensure();
    const person = await this._byName(name);
    if (!person) return null;
    person.notes.push(String(note).trim());
    person.notes = person.notes.slice(-MAX_NOTES);
    person.lastSeenAt = Date.now();
    await tx(db, "readwrite", (s) => s.put(person));
    return person;
  }

  async touch(name) {
    const db = await this._ensure();
    const person = await this._byName(name);
    if (!person) return;
    person.lastSeenAt = Date.now();
    await tx(db, "readwrite", (s) => s.put(person));
  }

  async removeByName(name) {
    const db = await this._ensure();
    const person = await this._byName(name);
    if (!person) return false;
    await tx(db, "readwrite", (s) => s.delete(person.id));
    return true;
  }
}
