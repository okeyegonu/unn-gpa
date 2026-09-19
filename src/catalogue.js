/**
 * catalogue.js — the student's own list of courses.
 *
 * In the Mechanical Engineering calculator the course list was a fixed data file.
 * Here the student owns it: they enter the department, title, code and unit load
 * of every course they offer. This module holds that list, validates additions
 * to it, and resolves the properties the GPA engine needs — so the engine never
 * has to know where a course came from.
 */

/**
 * A course keeps the id it was created with for life. Deriving the id from the
 * course code would break the moment a student corrected a typo in the code,
 * taking their grades with it.
 *
 * Three sources, in order of preference. `crypto.randomUUID` exists only in a
 * secure context, so it is absent over plain http (a phone opening the LAN
 * address in a lab), from a file:// copy, and on older mobile browsers.
 * `crypto.getRandomValues` has no such restriction and covers almost everything
 * else. The last resort combines the clock with a counter, so that two courses
 * added in the same millisecond still differ — ids that collide would be worse
 * than useless, because the storage layer de-duplicates by id and the second
 * course would vanish.
 */
let idSequence = 0;

export function newCourseId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `c_${uuid.replace(/-/g, '').slice(0, 12)}`;

  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(6));
  if (bytes) {
    return `c_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  }

  idSequence = (idSequence + 1) % 1_000_000;
  const clock = Date.now().toString(36);
  const seq = idSequence.toString(36).padStart(4, '0');
  const noise = Math.random().toString(36).slice(2, 8);
  return `c_${clock}${seq}${noise}`;
}

/** Course codes are compared and stored in one shape: "MEE 313". */
export function normaliseCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Free text is trimmed and collapsed, never silently dropped. */
export function normaliseText(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

export const DEFAULT_PROFILE = Object.freeze({
  department: '',
  programme: '',
  minYears: 4,
  maxYears: 7,
});

/** A course code may carry at most this many letters and digits. */
export const MAX_CODE_CHARS = 8;

/** The letters and digits of a code, with spacing and punctuation removed. */
export function codeCharacters(code) {
  return normaliseCode(code).replace(/[^A-Z0-9]/g, '');
}

/**
 * A department or course name is written in words. Digits are refused outright;
 * ordinary punctuation is allowed, because real titles carry it — "CAD/CAM
 * Laboratory", "Logic, Philosophy and Human Existence", "B.Eng. Project".
 */
const NAME_PUNCTUATION = /^[A-Za-z][A-Za-z \-'’.,()\/&]*$/;

export function nameProblem(text, label) {
  const value = normaliseText(text);
  if (!value) return null;
  if (/\d/.test(value)) return `${label} cannot contain numbers.`;
  if (!NAME_PUNCTUATION.test(value)) {
    return `${label} should be written in words. Letters, spaces and ordinary punctuation only.`;
  }
  return null;
}

/** The hard ceiling on sittings when a student has not set a maximum. */
export const ABSOLUTE_MAX_SITTINGS = 12;

/**
 * How many sittings a course of the given year allows.
 *
 * A course first taken in year x may be repeated in each remaining year up to
 * the programme maximum, so it allows (max - x) repeats and (max - x + 1)
 * sittings. With no maximum set, a generous ceiling applies instead of an
 * unbounded list of grade boxes.
 */
export function maxAttemptsForYear(year, profile) {
  const max = Number(profile?.maxYears);
  if (!Number.isFinite(max) || max <= 0) return ABSOLUTE_MAX_SITTINGS;
  if (!Number.isFinite(Number(year))) return 1;
  return Math.min(ABSOLUTE_MAX_SITTINGS, Math.max(1, Math.round(max) - Math.round(year) + 1));
}

/**
 * The course list as the engine and the interface want it: sorted, with the
 * properties resolved that depend on the student's profile.
 */
export function coursesOf(state) {
  const profile = { ...DEFAULT_PROFILE, ...(state?.profile ?? {}) };
  const list = Array.isArray(state?.courses) ? state.courses : [];
  return list
    .map((c) => ({
      ...c,
      code: normaliseCode(c.code),
      title: normaliseText(c.title),
      department: normaliseText(c.department) || normaliseText(profile.department),
      units: Number(c.units),
      year: Number(c.year),
      semester: Number(c.semester),
      maxAttempts: maxAttemptsForYear(c.year, profile),
      failingGrades: FAILING_GRADES,
    }))
    .sort((a, b) =>
      a.year - b.year ||
      a.semester - b.semester ||
      a.code.localeCompare(b.code) ||
      String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** Only F requires a re-sit; E is a pass. This is the UNN-wide rule. */
export const FAILING_GRADES = Object.freeze(['F']);

/** Map of id -> course. */
export function indexCourses(courses) {
  const m = new Map();
  for (const c of courses) m.set(c.id, c);
  return m;
}

/**
 * Check a course a student is about to add or amend.
 * Returns { ok, errors, warnings, course } — `course` is the cleaned record.
 */
export function validateDraft(draft, state, editingId = null) {
  const errors = [];
  const warnings = [];

  const code = normaliseCode(draft.code);
  const title = normaliseText(draft.title);
  const department = normaliseText(draft.department);
  // An empty box means "not given", not zero: Number('') is 0, which would
  // otherwise be reported as a unit load that is merely too small.
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const units = blank(draft.units) ? NaN : Number(draft.units);
  const year = blank(draft.year) ? NaN : Number(draft.year);
  const semester = blank(draft.semester) ? NaN : Number(draft.semester);

  if (!code) {
    errors.push('A course code is required.');
  } else if (!/^[A-Z0-9 ]+$/.test(code)) {
    errors.push('A course code may contain only letters, numbers and spaces.');
  } else if (codeCharacters(code).length > MAX_CODE_CHARS) {
    errors.push(
      `A course code may not exceed ${MAX_CODE_CHARS} letters and numbers. ` +
      `"${code}" has ${codeCharacters(code).length}.`,
    );
  } else if (!/^[A-Z]{2,5} ?\d{1,4}[A-Z]?$/.test(code)) {
    warnings.push(`"${code}" does not look like a usual course code, such as MEE 313. It has been kept as typed.`);
  }

  const titleProblem = nameProblem(title, 'A course title');
  if (titleProblem) errors.push(titleProblem);

  const departmentProblem = nameProblem(department, 'A department name');
  if (departmentProblem) errors.push(departmentProblem);

  if (!Number.isFinite(units)) errors.push('A unit load is required.');
  else if (!Number.isInteger(units)) errors.push('The unit load must be a whole number.');
  else if (units < 1) errors.push('The unit load must be at least 1.');
  else if (units > 30) errors.push('A unit load above 30 is almost certainly a mistake.');

  if (!Number.isInteger(year) || year < 1 || year > 10) errors.push('Choose which year of study this course belongs to.');
  if (![1, 2].includes(semester)) errors.push('Choose first or second semester.');

  if (!title) warnings.push('No course title was given. The course will show its code only.');

  // The same course twice in one semester is almost always an attempt to record
  // a resit. Repeat sittings are how that is done.
  const clash = (state?.courses ?? []).find(
    (c) => c.id !== editingId &&
      normaliseCode(c.code) === code &&
      Number(c.year) === year &&
      Number(c.semester) === semester,
  );
  if (clash) {
    errors.push(
      `${code} is already in your list for year ${year}, semester ${semester}. ` +
      `If you sat it more than once, do not add it again — tick "I repeated a course" and add a sitting to the one already there.`,
    );
  }

  const elsewhere = (state?.courses ?? []).find(
    (c) => c.id !== editingId && normaliseCode(c.code) === code && !clash,
  );
  if (elsewhere) {
    warnings.push(`${code} also appears in year ${elsewhere.year}, semester ${elsewhere.semester}. Both will count.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    course: { code, title, department, units, year, semester },
  };
}

/** Add a validated course. Returns { state, result }; state is unchanged on failure. */
export function addCourse(state, draft) {
  const result = validateDraft(draft, state);
  if (!result.ok) return { state, result };
  const course = {
    id: newCourseId(),
    ...result.course,
    createdAt: new Date().toISOString(),
  };
  return { state: { ...state, courses: [...(state.courses ?? []), course] }, result: { ...result, course } };
}

/** Amend a course in place, keeping its id and therefore its grades. */
export function updateCourse(state, id, draft) {
  const existing = (state.courses ?? []).find((c) => c.id === id);
  if (!existing) return { state, result: { ok: false, errors: ['That course is no longer in your list.'], warnings: [] } };
  const result = validateDraft(draft, state, id);
  if (!result.ok) return { state, result };
  const courses = (state.courses ?? []).map((c) => (c.id === id ? { ...c, ...result.course } : c));
  return { state: { ...state, courses }, result };
}

/**
 * Remove a course, and with it every sitting recorded against it. Leaving the
 * grades behind would keep them in the GPA with nothing on screen to explain it.
 */
export function removeCourse(state, id) {
  const courses = (state.courses ?? []).filter((c) => c.id !== id);
  const grades = { ...(state.grades ?? {}) };
  const repeats = { ...(state.repeats ?? {}) };
  delete grades[id];
  delete repeats[id];
  return { ...state, courses, grades, repeats };
}

/** The years and semesters actually present, in order, for grouped display. */
export function semesterKeys(courses) {
  const seen = new Map();
  for (const c of courses) {
    const key = `y${c.year}s${c.semester}`;
    if (!seen.has(key)) seen.set(key, { year: c.year, semester: c.semester, key });
  }
  return [...seen.values()].sort((a, b) => a.year - b.year || a.semester - b.semester);
}

/** The departments present, for filtering. */
export function departmentsOf(courses) {
  const set = new Set();
  for (const c of courses) if (c.department) set.add(c.department);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export const ordinal = (n) =>
  ({ 1: 'First', 2: 'Second', 3: 'Third', 4: 'Fourth', 5: 'Fifth', 6: 'Sixth', 7: 'Seventh', 8: 'Eighth', 9: 'Ninth', 10: 'Tenth' })[n]
  ?? `Year ${n}`;
