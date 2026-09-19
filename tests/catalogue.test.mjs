/**
 * The student's own course list: adding, amending, removing, and the checks
 * that stop a list from becoming unusable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROFILE, ABSOLUTE_MAX_SITTINGS,
  newCourseId, normaliseCode, normaliseText, maxAttemptsForYear,
  coursesOf, indexCourses, validateDraft, addCourse, updateCourse, removeCourse,
  semesterKeys, departmentsOf, ordinal, FAILING_GRADES,
  MAX_CODE_CHARS, codeCharacters, nameProblem,
} from '../src/catalogue.js';
import { emptyState, setGrade, setAttempt, summarise, attemptsOf } from '../src/gpa-engine.js';

const base = () => ({ ...emptyState(), profile: { ...DEFAULT_PROFILE }, courses: [] });

/**
 * Replace globalThis.crypto for the duration of a callback. It is a getter-only
 * property, so it has to be redefined rather than assigned.
 */
function withCrypto(replacement, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: replacement, configurable: true, writable: true });
  try { return fn(); } finally { Object.defineProperty(globalThis, 'crypto', original); }
}

const draft = (over = {}) => ({
  code: 'MEE 313', title: 'Mechanical Engineering Design I',
  department: 'Mechanical Engineering', units: 3, year: 3, semester: 1, ...over,
});

/* ----------------------------------------------------------- normalising */

test('course codes are stored in one shape', () => {
  for (const input of ['mee 313', '  MEE   313 ', 'Mee 313']) {
    assert.equal(normaliseCode(input), 'MEE 313');
  }
  assert.equal(normaliseCode(null), '');
  assert.equal(normaliseText('  two   words  '), 'two words');
});

test('every course gets its own permanent id', () => {
  const ids = new Set(Array.from({ length: 500 }, newCourseId));
  assert.equal(ids.size, 500, 'ids do not collide');
  for (const id of ids) assert.match(id, /^c_[a-z0-9]+$/i);
});

test('ids stay unique without crypto.randomUUID, and without crypto at all', async () => {
  // randomUUID exists only in a secure context, so it is missing over plain
  // http, from a file:// copy, and on older mobile browsers. getRandomValues
  // has no such restriction. Both fallbacks have to hold on their own, and
  // neither is reached in a normal test run — so they are forced here.
  const real = globalThis.crypto;

  // 1. No randomUUID, but getRandomValues present (an http:// page).
  const viaBytes = withCrypto({ getRandomValues: real.getRandomValues.bind(real) },
    () => Array.from({ length: 500 }, newCourseId));
  assert.equal(new Set(viaBytes).size, 500, 'the getRandomValues fallback must not collide');
  for (const id of viaBytes) assert.match(id, /^c_[0-9a-f]{12}$/);

  // 2. No crypto at all (a very old browser).
  const viaClock = withCrypto(undefined, () => Array.from({ length: 500 }, newCourseId));
  assert.equal(new Set(viaClock).size, 500,
    'ids generated in the same millisecond must still differ');
  for (const id of viaClock) assert.match(id, /^c_[a-z0-9]+$/i);

  // 3. And the three sources do not produce ids that clash with each other.
  const mixed = new Set([...viaBytes, ...viaClock, ...Array.from({ length: 500 }, newCourseId)]);
  assert.equal(mixed.size, 1500);
});

test('courses added in one burst all survive a save and reload', async () => {
  // The collision this guards against was silent: the storage layer
  // de-duplicates by id, so a second course sharing an id simply disappeared.
  const { ResultsRepository, MemoryBackend } = await import('../src/storage.js');

  // Force the weakest id source, as a very old browser would.
  const state = withCrypto(undefined, () => {
    let s = base();
    for (let i = 1; i <= 30; i++) {
      s = addCourse(s, draft({ code: `TST ${100 + i}`, year: (i % 4) + 1 })).state;
    }
    return s;
  });
  assert.equal(new Set(state.courses.map((c) => c.id)).size, 30, 'thirty distinct ids');

  const repo = new ResultsRepository({ backend: new MemoryBackend() });
  await repo.save(state);
  const loaded = await repo.load();
  assert.equal(loaded.state.courses.length, 30, 'and thirty courses come back');
});

/* --------------------------------------------------------------- adding */

test('a valid course is added and comes back resolved', () => {
  const { state, result } = addCourse(base(), draft());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(state.courses.length, 1);

  const [c] = coursesOf(state);
  assert.equal(c.code, 'MEE 313');
  assert.equal(c.units, 3);
  assert.equal(c.year, 3);
  assert.equal(c.semester, 1);
  assert.ok(c.id);
  assert.ok(c.createdAt);
  assert.deepEqual(c.failingGrades, FAILING_GRADES);
});

test('a course is rejected without a code or a usable unit load', () => {
  for (const [over, expected] of [
    [{ code: '' }, /course code is required/i],
    [{ code: '   ' }, /course code is required/i],
    [{ units: '' }, /unit load is required/i],
    [{ units: 0 }, /at least 1/i],
    [{ units: -2 }, /at least 1/i],
    [{ units: 2.5 }, /whole number/i],
    [{ units: 99 }, /above 30/i],
    [{ year: 0 }, /which year/i],
    [{ year: 99 }, /which year/i],
    [{ semester: 3 }, /first or second/i],
  ]) {
    const { state, result } = addCourse(base(), draft(over));
    assert.equal(result.ok, false, JSON.stringify(over));
    assert.match(result.errors.join(' '), expected);
    assert.equal(state.courses.length, 0, 'nothing is added on failure');
  }
});

test('an unusual code or a missing title warns but is accepted', () => {
  const odd = addCourse(base(), draft({ code: 'X1' }));
  assert.equal(odd.result.ok, true);
  assert.match(odd.result.warnings.join(' '), /does not look like a usual course code/i);
  assert.equal(coursesOf(odd.state)[0].code, 'X1', 'kept exactly as typed');

  const untitled = addCourse(base(), draft({ title: '' }));
  assert.equal(untitled.result.ok, true);
  assert.match(untitled.result.warnings.join(' '), /no course title/i);
});

test('a course with no department falls back to the profile department', () => {
  const start = { ...base(), profile: { ...DEFAULT_PROFILE, department: 'Civil Engineering' } };
  const { state } = addCourse(start, draft({ department: '' }));
  assert.equal(coursesOf(state)[0].department, 'Civil Engineering');
});

test('the same course twice in one semester is refused, pointing at repeats', () => {
  const { state } = addCourse(base(), draft());
  const again = addCourse(state, draft({ title: 'typed again' }));
  assert.equal(again.result.ok, false);
  assert.match(again.result.errors.join(' '), /already in your list/i);
  assert.match(again.result.errors.join(' '), /I repeated a course/i);
  assert.equal(again.state.courses.length, 1, 'no duplicate is created');
});

test('the same code in a different semester is allowed, with a warning', () => {
  const { state } = addCourse(base(), draft());
  const other = addCourse(state, draft({ semester: 2 }));
  assert.equal(other.result.ok, true);
  assert.match(other.result.warnings.join(' '), /also appears in year 3, semester 1/i);
  assert.equal(other.state.courses.length, 2);
});

test('adding many courses keeps every one of them', () => {
  let state = base();
  for (let i = 1; i <= 40; i++) {
    const r = addCourse(state, draft({ code: `TST ${100 + i}`, year: (i % 4) + 1, semester: (i % 2) + 1 }));
    assert.equal(r.result.ok, true, `course ${i}`);
    state = r.state;
  }
  assert.equal(coursesOf(state).length, 40);
  assert.equal(new Set(coursesOf(state).map((c) => c.id)).size, 40, 'all ids distinct');
});

/* -------------------------------------------------------------- amending */

test('amending a course keeps its id, and therefore its grades', () => {
  const { state: s0 } = addCourse(base(), draft());
  const id = s0.courses[0].id;

  const c0 = coursesOf(s0)[0];
  let s1 = setGrade(s0, id, 'F');
  s1 = setAttempt(s1, c0, 1, 'B');
  assert.equal(summarise(coursesOf(s1), s1).units, 6);

  const { state: s2, result } = updateCourse(s1, id, draft({ title: 'Corrected title', units: 4 }));
  assert.equal(result.ok, true);
  assert.equal(s2.courses[0].id, id, 'the id survives');
  assert.deepEqual(attemptsOf(coursesOf(s2)[0], s2), ['F', 'B'], 'and so do the sittings');
  assert.equal(coursesOf(s2)[0].title, 'Corrected title');
  assert.equal(summarise(coursesOf(s2), s2).units, 8, 'the new unit load applies to both sittings');
});

test('amending a course into a clash is refused', () => {
  let { state } = addCourse(base(), draft());
  state = addCourse(state, draft({ code: 'MEE 315' })).state;
  const second = state.courses[1].id;
  const { state: after, result } = updateCourse(state, second, draft({ code: 'MEE 313' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /already in your list/i);
  assert.equal(coursesOf(after)[1].code, 'MEE 315', 'unchanged');
});

test('amending a course that is gone fails cleanly', () => {
  const { result } = updateCourse(base(), 'c_nope', draft());
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /no longer in your list/i);
});

/* -------------------------------------------------------------- removing */

test('removing a course removes its grades and sittings with it', () => {
  const { state: s0 } = addCourse(base(), draft());
  const id = s0.courses[0].id;
  let s1 = setGrade(s0, id, 'F');
  s1 = setAttempt(s1, coursesOf(s1)[0], 1, 'B');
  assert.equal(summarise(coursesOf(s1), s1).units, 6);

  const s2 = removeCourse(s1, id);
  assert.equal(s2.courses.length, 0);
  assert.deepEqual(s2.grades, {}, 'no orphan grade is left counting');
  assert.deepEqual(s2.repeats, {});
  assert.equal(summarise(coursesOf(s2), s2).gpaText, '—');
});

test('removing one course leaves the others untouched', () => {
  let state = base();
  for (const code of ['AAA 101', 'BBB 102', 'CCC 103']) state = addCourse(state, draft({ code })).state;
  const ids = state.courses.map((c) => c.id);
  state = setGrade(state, ids[0], 'A');
  state = setGrade(state, ids[2], 'B');

  const after = removeCourse(state, ids[1]);
  assert.deepEqual(coursesOf(after).map((c) => c.code), ['AAA 101', 'CCC 103']);
  assert.deepEqual(Object.keys(after.grades).sort(), [ids[0], ids[2]].sort());
});

/* ------------------------------------------------------- the allowance */

test('the sitting allowance follows the student\'s own programme length', () => {
  const mee = { maxYears: 8 };                 // five-year programme, eight allowed
  assert.deepEqual([1, 2, 3, 4, 5].map((y) => maxAttemptsForYear(y, mee)), [8, 7, 6, 5, 4]);

  const fourYear = { maxYears: 7 };            // the default
  assert.deepEqual([1, 2, 3, 4].map((y) => maxAttemptsForYear(y, fourYear)), [7, 6, 5, 4]);

  const six = { maxYears: 9 };
  assert.deepEqual([1, 6].map((y) => maxAttemptsForYear(y, six)), [9, 4]);
});

test('an unset or nonsensical maximum falls back to a ceiling, never to infinity', () => {
  for (const profile of [{}, { maxYears: 0 }, { maxYears: -4 }, { maxYears: 'many' }, null]) {
    assert.equal(maxAttemptsForYear(1, profile), ABSOLUTE_MAX_SITTINGS, JSON.stringify(profile));
  }
  assert.equal(maxAttemptsForYear(1, { maxYears: 99 }), ABSOLUTE_MAX_SITTINGS, 'and it is capped');
  assert.equal(maxAttemptsForYear(9, { maxYears: 8 }), 1, 'never below one sitting');
});

test('the allowance reaches the course records the engine sees', () => {
  const state = { ...base(), profile: { ...DEFAULT_PROFILE, minYears: 5, maxYears: 8 } };
  const withCourses = addCourse(addCourse(state, draft({ year: 1 })).state, draft({ code: 'MEE 511', year: 5 })).state;
  const [first, fifth] = coursesOf(withCourses);
  assert.equal(first.maxAttempts, 8);
  assert.equal(fifth.maxAttempts, 4);
});

/* ------------------------------------------------------------- grouping */

test('courses are ordered by year, then semester, then code', () => {
  let state = base();
  for (const d of [
    draft({ code: 'ZZZ 401', year: 4, semester: 1 }),
    draft({ code: 'AAA 102', year: 1, semester: 2 }),
    draft({ code: 'BBB 101', year: 1, semester: 1 }),
    draft({ code: 'AAA 101', year: 1, semester: 1 }),
  ]) state = addCourse(state, d).state;

  assert.deepEqual(coursesOf(state).map((c) => c.code), ['AAA 101', 'BBB 101', 'AAA 102', 'ZZZ 401']);
  assert.deepEqual(semesterKeys(coursesOf(state)).map((k) => k.key), ['y1s1', 'y1s2', 'y4s1']);
});

test('departments are listed once each, in order', () => {
  let state = base();
  for (const d of [
    draft({ code: 'MEE 313', department: 'Mechanical Engineering' }),
    draft({ code: 'MTH 207', department: 'Mathematics' }),
    draft({ code: 'MEE 315', department: 'Mechanical Engineering' }),
    draft({ code: 'GST 111', department: 'General Studies' }),
  ]) state = addCourse(state, d).state;
  assert.deepEqual(departmentsOf(coursesOf(state)),
    ['General Studies', 'Mathematics', 'Mechanical Engineering']);
});

test('indexCourses gives lookup by id', () => {
  const { state } = addCourse(base(), draft());
  const idx = indexCourses(coursesOf(state));
  assert.equal(idx.get(state.courses[0].id).code, 'MEE 313');
});

test('year names read properly', () => {
  assert.equal(ordinal(1), 'First');
  assert.equal(ordinal(5), 'Fifth');
  assert.equal(ordinal(11), 'Year 11');
});

/* ------------------------------------------- a whole student, end to end */

test('a student builds a list and grades it incrementally', () => {
  let state = { ...base(), profile: { department: 'Physics', programme: 'B.Sc. Physics', minYears: 4, maxYears: 7 } };
  for (const d of [
    draft({ code: 'PHY 101', title: 'General Physics I', department: 'Physics', units: 3, year: 1, semester: 1 }),
    draft({ code: 'MTH 111', title: 'Elementary Mathematics I', department: 'Mathematics', units: 3, year: 1, semester: 1 }),
    draft({ code: 'GST 111', title: 'Use of English', department: 'General Studies', units: 2, year: 1, semester: 1 }),
  ]) state = addCourse(state, d).state;

  const list = coursesOf(state);
  assert.equal(list.length, 3);

  // Monday: one result.
  const phy = list.find((c) => c.code === 'PHY 101');
  state = setGrade(state, phy.id, 'A');
  assert.equal(summarise(coursesOf(state), state).gpaText, '5.00');

  // Wednesday: a second, failed and later passed.
  const mth = list.find((c) => c.code === 'MTH 111');
  state = setGrade(state, mth.id, 'F');
  assert.equal(summarise(coursesOf(state), state).gpaText, '2.50', '15 points over 6 units');
  state = setAttempt(state, mth, 1, 'C');
  const r = summarise(coursesOf(state), state);
  assert.equal(r.units, 9, 'both sittings of MTH 111 count');
  assert.equal(r.points, 24);
  assert.equal(r.gpaText, '2.67');

  // The third course is still dormant.
  assert.equal(r.gradedCourses, 2);
});

/* --------------------------------------------------------------------------
   Course codes are short and alphanumeric; names are written in words.
   -------------------------------------------------------------------------- */

test('a course code may not exceed eight letters and numbers', () => {
  for (const code of ['MEE 313', 'MEE313', 'AB 123456', 'ABCD 1234', 'A 1']) {
    assert.equal(addCourse(base(), draft({ code })).result.ok, true, `${code} should be accepted`);
  }
  for (const code of ['ABCDE 1234', 'MEE 31345678', 'ABCDEFGHI']) {
    const { result } = addCourse(base(), draft({ code }));
    assert.equal(result.ok, false, `${code} should be refused`);
    assert.match(result.errors.join(' '), /may not exceed 8 letters and numbers/i);
  }
  assert.equal(codeCharacters('MEE 313'), 'MEE313', 'spacing does not count towards the limit');
  assert.equal(MAX_CODE_CHARS, 8);
});

test('a course code takes letters, numbers and spaces only', () => {
  for (const code of ['MEE-313', 'MEE/313', 'MEE 313!', 'MEE_313', 'MEE.313']) {
    const { result } = addCourse(base(), draft({ code }));
    assert.equal(result.ok, false, code);
    assert.match(result.errors.join(' '), /only letters, numbers and spaces/i);
  }
});

test('a course title may not contain numbers', () => {
  for (const title of ['Design 1', 'Physics 101', 'Maths 2']) {
    const { result } = addCourse(base(), draft({ title }));
    assert.equal(result.ok, false, title);
    assert.match(result.errors.join(' '), /course title cannot contain numbers/i);
  }
});

test('a department name may not contain numbers', () => {
  for (const department of ['Mech 2 Eng', 'Department 5', 'Physics 1']) {
    const { result } = addCourse(base(), draft({ department }));
    assert.equal(result.ok, false, department);
    assert.match(result.errors.join(' '), /department name cannot contain numbers/i);
  }
});

test('real titles and departments with punctuation are still accepted', () => {
  for (const title of [
    'Mechanical Engineering Design I', 'CAD/CAM Laboratory',
    'Logic, Philosophy and Human Existence', 'B.Eng. Project',
    "Use of English", 'Strength of Materials (Advanced)', 'Heat & Mass Transfer',
  ]) {
    assert.equal(addCourse(base(), draft({ title })).result.ok, true, title);
  }
  for (const department of ['Mechanical Engineering', 'General Studies', 'Pure & Industrial Chemistry']) {
    assert.equal(addCourse(base(), draft({ department })).result.ok, true, department);
  }
});

test('an empty title or department is still allowed', () => {
  assert.equal(nameProblem('', 'A course title'), null);
  assert.equal(addCourse(base(), draft({ title: '', department: '' })).result.ok, true);
});

test('a name cannot be punctuation alone', () => {
  for (const title of ['---', '...', '/']) {
    assert.match(nameProblem(title, 'A course title') ?? '', /written in words/i, title);
  }
});

test('the rules apply when amending a course too, not just when adding one', () => {
  const { state } = addCourse(base(), draft());
  const id = state.courses[0].id;
  assert.equal(updateCourse(state, id, draft({ code: 'ABCDEFGHI' })).result.ok, false);
  assert.equal(updateCourse(state, id, draft({ title: 'Design 2' })).result.ok, false);
  assert.equal(updateCourse(state, id, draft({ department: 'Dept 9' })).result.ok, false);
  assert.equal(updateCourse(state, id, draft({ title: 'Design II' })).result.ok, true);
});

test('a course may be recorded against any year up to the tenth', () => {
  for (let year = 1; year <= 10; year++) {
    const { result } = addCourse(base(), draft({ code: `TST ${100 + year}`, year }));
    assert.equal(result.ok, true, `year ${year}`);
  }
  for (const year of [0, 11, -1]) {
    assert.equal(addCourse(base(), draft({ year })).result.ok, false, `year ${year}`);
  }
});

test('an eighth-year course is grouped and counted like any other', () => {
  let state = { ...base(), profile: { ...DEFAULT_PROFILE, minYears: 5, maxYears: 8 } };
  state = addCourse(state, draft({ code: 'AAA 101', units: 2, year: 1, semester: 1 })).state;
  state = addCourse(state, draft({ code: 'ZZZ 801', units: 3, year: 8, semester: 1 })).state;

  const list = coursesOf(state);
  assert.deepEqual(list.map((c) => c.year), [1, 8], 'ordered by year');
  assert.deepEqual(semesterKeys(list).map((k) => k.key), ['y1s1', 'y8s1']);
  assert.equal(ordinal(8), 'Eighth');

  // A year-8 course in an 8-year maximum has one sitting and no repeats.
  assert.equal(list[1].maxAttempts, 1);

  const graded = setGrade(state, list[1].id, 'A');
  assert.equal(summarise(coursesOf(graded), graded).units, 3);
  assert.equal(summarise(coursesOf(graded), graded).points, 15);
});
