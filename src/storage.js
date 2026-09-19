/**
 * storage.js — persistence, isolated behind a small async repository interface.
 *
 * The interface is intentionally async even though localStorage is synchronous,
 * so that a server-backed repository can be substituted later without touching
 * the GPA engine or the interface's call sites.
 *
 * Shape written to the backend (a single key, rewritten in place):
 *
 *   {
 *     schema_version: 1,
 *     saved_at: "2026-09-19T...",
 *     profile:  { department, programme, minYears, maxYears },
 *     courses:  [ { id, code, title, department, units, year, semester, createdAt } ],
 *     grades:   { "<courseId>": "A", ... },
 *     repeats:  { "<courseId>": ["F", "B"], ... }
 *   }
 *
 * Courses live in an array because they are an ordered list the student owns,
 * but every one carries a permanent id and is addressed by it. Grades and
 * repeats are objects keyed by that id, so every write is an upsert: repeating
 * a save can never append a duplicate grade or a second copy of a sitting.
 */

export const STORAGE_KEY = 'unn-gpa-calculator';
export const PREFS_KEY = 'unn-gpa-calculator:prefs';
export const SCHEMA_VERSION = 1;

/** In-memory backend with the Web Storage surface. Used by the tests. */
export class MemoryBackend {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  get length() { return this.map.size; }
}

/** Backend that degrades to memory when localStorage is unavailable. */
export function defaultBackend() {
  try {
    const probe = '__gpa_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return new MemoryBackend();
  }
}

/**
 * Copy the repeat-sittings map defensively. Each entry is the grades earned at
 * the second and later sittings of a course. Anything that is not a non-empty
 * string is dropped rather than trusted, so a hand-edited file cannot inject
 * odd values into the calculation.
 */
function cloneRepeats(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [id, list] of Object.entries(source)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter((g) => typeof g === 'string' && g.trim() !== '');
    if (clean.length > 0) out[id] = clean;
  }
  return out;
}

/** Copy the grade map, keeping only string values. */
function cloneGrades(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [id, g] of Object.entries(source)) {
    if (typeof g === 'string' && g.trim() !== '') out[id] = g;
  }
  return out;
}

/**
 * Copy the course list defensively, discarding anything without an id and a
 * usable unit load. A course the student can neither see nor grade is worse
 * than no course at all.
 */
function cloneCourses(source) {
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  const out = [];
  for (const c of source) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' ? c.id : null;
    if (!id || seen.has(id)) continue;          // no id, or a duplicate of one
    const units = Number(c.units);
    if (!Number.isFinite(units) || units <= 0) continue;
    seen.add(id);
    out.push({
      id,
      code: String(c.code ?? ''),
      title: String(c.title ?? ''),
      department: String(c.department ?? ''),
      units: Math.round(units),
      year: Number.isFinite(Number(c.year)) ? Math.round(Number(c.year)) : 1,
      semester: Number(c.semester) === 2 ? 2 : 1,
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : new Date(0).toISOString(),
    });
  }
  return out;
}

function cloneProfile(source) {
  const p = source && typeof source === 'object' ? source : {};
  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : fallback);
  return {
    department: String(p.department ?? ''),
    programme: String(p.programme ?? ''),
    minYears: num(p.minYears, 4),
    maxYears: num(p.maxYears, 7),
  };
}

function emptyRecord() {
  return { schema_version: SCHEMA_VERSION, saved_at: null, profile: cloneProfile(null), courses: [], grades: {}, repeats: {} };
}

export class ResultsRepository {
  constructor({ backend, key = STORAGE_KEY } = {}) {
    this.backend = backend ?? defaultBackend();
    this.key = key;
  }

  /** Read and repair the stored record. Never throws on corrupt data. */
  readRecord() {
    const raw = this.backend.getItem(this.key);
    if (!raw) return emptyRecord();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return emptyRecord(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyRecord();
    return {
      schema_version: Number(parsed.schema_version) || SCHEMA_VERSION,
      saved_at: typeof parsed.saved_at === 'string' ? parsed.saved_at : null,
      profile: cloneProfile(parsed.profile),
      courses: cloneCourses(parsed.courses),
      grades: cloneGrades(parsed.grades),
      repeats: cloneRepeats(parsed.repeats),
    };
  }

  /** Load the student's state. */
  async load() {
    const rec = this.readRecord();
    const found = Boolean(this.backend.getItem(this.key));
    return {
      found,
      savedAt: rec.saved_at,
      state: { profile: rec.profile, courses: rec.courses, grades: rec.grades, repeats: rec.repeats },
    };
  }

  /**
   * UPSERT the whole state. Idempotent: saving the same state twice leaves an
   * identical record apart from `saved_at`, and cannot duplicate a course, a
   * grade or a sitting.
   */
  async save(state) {
    const rec = {
      schema_version: SCHEMA_VERSION,
      saved_at: new Date().toISOString(),
      profile: cloneProfile(state?.profile),
      courses: cloneCourses(state?.courses),
      grades: cloneGrades(state?.grades),
      repeats: cloneRepeats(state?.repeats),
    };
    this.backend.setItem(this.key, JSON.stringify(rec));
    return rec;
  }

  /** Delete everything the student has entered. */
  async clear() {
    this.backend.removeItem(this.key);
  }

  /** Portable export payload: the course list as well as the results. */
  async exportPayload(state, extra = {}) {
    return {
      format: 'unn-gpa-calculator-export',
      format_version: 1,
      institution: 'University of Nigeria, Nsukka',
      exported_at: new Date().toISOString(),
      profile: cloneProfile(state?.profile),
      courses: cloneCourses(state?.courses),
      grades: cloneGrades(state?.grades),
      repeats: cloneRepeats(state?.repeats),
      ...extra,
    };
  }

  /**
   * Validate and convert an imported payload into a state object.
   * Throws on anything that is not recognisably an export of this calculator.
   */
  parseImport(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('The file does not contain a JSON object.');
    if (payload.format !== 'unn-gpa-calculator-export') {
      throw new Error('This file is not an export from the UNN GPA calculator.');
    }
    if (!Array.isArray(payload.courses)) throw new Error('The export contains no course list.');
    const courses = cloneCourses(payload.courses);
    const ids = new Set(courses.map((c) => c.id));
    const grades = {};
    for (const [id, g] of Object.entries(cloneGrades(payload.grades))) if (ids.has(id)) grades[id] = g;
    const repeats = {};
    for (const [id, list] of Object.entries(cloneRepeats(payload.repeats))) if (ids.has(id)) repeats[id] = list;
    return {
      state: { profile: cloneProfile(payload.profile), courses, grades, repeats },
      exportedAt: typeof payload.exported_at === 'string' ? payload.exported_at : null,
      courseCount: courses.length,
      gradeCount: Object.keys(grades).length,
    };
  }
}

/**
 * Display preferences — separate from results, on purpose. A preference is
 * about this viewer's screen, not their academic record, so it is never swept
 * into an export and losing it costs nothing.
 */
export class PreferencesStore {
  constructor({ backend, key = PREFS_KEY } = {}) {
    this.backend = backend ?? defaultBackend();
    this.key = key;
  }

  read() {
    try {
      const raw = this.backend.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  get(name, fallback = undefined) {
    const v = this.read()[name];
    return v === undefined ? fallback : v;
  }

  set(name, value) {
    try {
      const next = { ...this.read(), [name]: value };
      this.backend.setItem(this.key, JSON.stringify(next));
      return next;
    } catch {
      return this.read();
    }
  }

  clear() {
    try { this.backend.removeItem(this.key); } catch { /* nothing to do */ }
  }
}
