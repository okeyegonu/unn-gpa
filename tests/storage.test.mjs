/**
 * Persistence and idempotency.
 *
 * A "browser reload" is simulated by throwing away the repository object and
 * building a fresh one over the same backend, exactly as a page reload throws
 * away the JavaScript heap but not localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ResultsRepository, MemoryBackend, PreferencesStore, STORAGE_KEY, PREFS_KEY } from '../src/storage.js';
import { emptyState, setGrade, setAttempt, summarise } from '../src/gpa-engine.js';
import { DEFAULT_PROFILE, addCourse, coursesOf, removeCourse } from '../src/catalogue.js';

const reload = (backend) => new ResultsRepository({ backend });
const base = () => ({ ...emptyState(), profile: { ...DEFAULT_PROFILE }, courses: [] });

const draft = (over = {}) => ({
  code: 'MEE 313', title: 'Design I', department: 'Mechanical Engineering',
  units: 3, year: 3, semester: 1, ...over,
});

/** Build a small, realistic student state. */
function studentState() {
  let s = { ...base(), profile: { department: 'Mechanical Engineering', programme: 'B.Eng.', minYears: 5, maxYears: 8 } };
  for (const d of [
    draft({ code: 'MEE 313', units: 3, year: 3, semester: 1 }),
    draft({ code: 'MTH 207', units: 2, year: 2, semester: 1, department: 'Mathematics' }),
    draft({ code: 'GST 111', units: 2, year: 1, semester: 1, department: 'General Studies' }),
  ]) s = addCourse(s, d).state;
  return s;
}

test('the full enter / reload / modify / reload / add / reload sequence', async () => {
  const backend = new MemoryBackend();
  let repo = reload(backend);

  let state = studentState();
  const list = coursesOf(state);
  const [gst, mth, mee] = [list[0], list[1], list[2]];
  state = setGrade(state, gst.id, 'A');
  state = setGrade(state, mth.id, 'B');
  state = setGrade(state, mee.id, 'C');
  await repo.save(state);

  repo = reload(backend);
  let loaded = await repo.load();
  assert.equal(loaded.found, true);
  assert.equal(loaded.state.courses.length, 3, 'the course list comes back');
  assert.equal(Object.keys(loaded.state.grades).length, 3);
  assert.equal(loaded.state.profile.maxYears, 8, 'and so does the profile');

  state = setGrade(loaded.state, mth.id, 'A');
  await repo.save(state);

  repo = reload(backend);
  loaded = await repo.load();
  assert.equal(loaded.state.grades[mth.id], 'A', 'the change replaced the old value');
  assert.equal(Object.keys(loaded.state.grades).length, 3, 'still three, not four');

  // 2xA=10, 2xA=10, 3xC=9  ->  29 over 7
  const r = summarise(coursesOf(loaded.state), loaded.state);
  assert.equal(r.units, 7);
  assert.equal(r.points, 29);
  assert.equal(r.gpaText, '4.14');
});

test('repeated saves are idempotent — nothing accumulates', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  let state = studentState();
  const [first] = coursesOf(state);
  state = setGrade(state, first.id, 'F');
  state = setAttempt(state, first, 1, 'B');

  for (let i = 0; i < 30; i++) await repo.save(state);

  const rec = JSON.parse(backend.getItem(STORAGE_KEY));
  assert.equal(rec.courses.length, 3, 'three courses, not ninety');
  assert.equal(Object.keys(rec.grades).length, 1);
  assert.deepEqual(rec.repeats, { [first.id]: ['B'] });

  const before = JSON.parse(backend.getItem(STORAGE_KEY));
  await repo.save(state);
  const after = JSON.parse(backend.getItem(STORAGE_KEY));
  delete before.saved_at; delete after.saved_at;
  assert.deepEqual(after, before, 'only the timestamp may differ');
});

test('a save / reload / save cycle is a fixed point', async () => {
  const backend = new MemoryBackend();
  let state = studentState();
  state = setGrade(state, coursesOf(state)[0].id, 'A');
  await reload(backend).save(state);

  const shapes = new Set();
  for (let i = 0; i < 5; i++) {
    const repo = reload(backend);
    const loaded = await repo.load();
    await repo.save(loaded.state);
    const rec = JSON.parse(backend.getItem(STORAGE_KEY));
    delete rec.saved_at;
    shapes.add(JSON.stringify(rec));
  }
  assert.equal(shapes.size, 1, 'the record never drifts across load/save rounds');
});

test('a course keeps its grades across a reload, and removing it takes them', async () => {
  const backend = new MemoryBackend();
  let state = studentState();
  const [first] = coursesOf(state);
  state = setGrade(state, first.id, 'F');
  state = setAttempt(state, first, 1, 'C');
  await reload(backend).save(state);

  let loaded = await reload(backend).load();
  assert.deepEqual(loaded.state.repeats[first.id], ['C']);

  const after = removeCourse(loaded.state, first.id);
  await reload(backend).save(after);
  loaded = await reload(backend).load();
  assert.equal(loaded.state.courses.length, 2);
  assert.equal(loaded.state.grades[first.id], undefined);
  assert.equal(loaded.state.repeats[first.id], undefined);
});

test('corrupt or foreign storage degrades to an empty state', async () => {
  for (const junk of ['', 'not json', '[]', 'null', '{"courses":"nope"}', '{"unexpected":1}']) {
    const loaded = await reload(new MemoryBackend({ [STORAGE_KEY]: junk })).load();
    assert.deepEqual(loaded.state.courses, [], `junk: ${junk}`);
    assert.deepEqual(loaded.state.grades, {});
  }
});

test('a course without an id or a usable unit load is discarded on load', async () => {
  const hostile = {
    schema_version: 1,
    courses: [
      { id: 'c_ok', code: 'AAA 101', units: 3, year: 1, semester: 1 },
      { code: 'NO ID', units: 3 },                       // no id
      { id: 'c_bad', code: 'BAD 101', units: 0 },        // no usable unit load
      { id: 'c_bad2', code: 'BAD 102', units: 'three' },
      { id: 'c_ok', code: 'DUPLICATE ID', units: 2 },    // a second course with one id
      'not an object',
    ],
    grades: { c_ok: 'A', c_bad: 'B' },
    repeats: {},
  };
  const loaded = await reload(new MemoryBackend({ [STORAGE_KEY]: JSON.stringify(hostile) })).load();
  assert.equal(loaded.state.courses.length, 1);
  assert.equal(loaded.state.courses[0].code, 'AAA 101');
  assert.equal(loaded.state.grades.c_ok, 'A');
});

test('blank and non-string sittings never reach the stored record', async () => {
  const backend = new MemoryBackend();
  await reload(backend).save({
    profile: DEFAULT_PROFILE,
    courses: [{ id: 'c1', code: 'AAA 101', units: 3, year: 1, semester: 1 }],
    grades: { c1: 'F', c2: '' },
    repeats: { c1: ['', '   ', 'F', null, 7, 'B'] },
  });
  const rec = JSON.parse(backend.getItem(STORAGE_KEY));
  assert.deepEqual(rec.repeats, { c1: ['F', 'B'] });
  assert.deepEqual(rec.grades, { c1: 'F' }, 'an empty grade is not a grade');
});

test('the profile is repaired rather than trusted', async () => {
  const backend = new MemoryBackend({ [STORAGE_KEY]: JSON.stringify({
    profile: { department: 42, minYears: 'four', maxYears: -3 }, courses: [], grades: {}, repeats: {},
  }) });
  const loaded = await reload(backend).load();
  assert.equal(loaded.state.profile.department, '42');
  assert.equal(loaded.state.profile.minYears, 4, 'falls back to the default');
  assert.equal(loaded.state.profile.maxYears, 7);
});

/* ------------------------------------------------------ export / import */

test('an export carries the course list as well as the results', async () => {
  const repo = reload(new MemoryBackend());
  let state = studentState();
  const [first] = coursesOf(state);
  state = setGrade(state, first.id, 'F');
  state = setAttempt(state, first, 1, 'B');

  const payload = await repo.exportPayload(state);
  assert.equal(payload.format, 'unn-gpa-calculator-export');
  assert.equal(payload.institution, 'University of Nigeria, Nsukka');
  assert.ok(payload.exported_at);
  assert.equal(payload.courses.length, 3);
  assert.deepEqual(payload.repeats, { [first.id]: ['B'] });

  const round = repo.parseImport(JSON.parse(JSON.stringify(payload)));
  assert.equal(round.courseCount, 3);
  assert.equal(round.gradeCount, 1);
  assert.deepEqual(round.state.repeats, payload.repeats);
  // The first course in sorted order is GST 111, 2 units, sat twice.
  assert.equal(summarise(coursesOf(round.state), round.state).units, 4);
  assert.equal(summarise(coursesOf(round.state), round.state).points, 8);
});

test('importing the same file twice gives the same state, not twice as much', async () => {
  const repo = reload(new MemoryBackend());
  let state = studentState();
  state = setGrade(state, coursesOf(state)[0].id, 'A');
  const payload = JSON.parse(JSON.stringify(await repo.exportPayload(state)));

  const once = repo.parseImport(payload).state;
  const twice = repo.parseImport(JSON.parse(JSON.stringify(payload))).state;
  assert.equal(once.courses.length, 3);
  assert.deepEqual(twice.courses, once.courses);
  assert.deepEqual(twice.grades, once.grades);
});

test('an import drops grades for courses the file does not contain', () => {
  const repo = reload(new MemoryBackend());
  const round = repo.parseImport({
    format: 'unn-gpa-calculator-export',
    courses: [{ id: 'c_a', code: 'AAA 101', units: 3, year: 1, semester: 1 }],
    grades: { c_a: 'A', c_ghost: 'B' },
    repeats: { c_ghost: ['F'] },
  });
  assert.deepEqual(round.state.grades, { c_a: 'A' }, 'no grade counts without a course to explain it');
  assert.deepEqual(round.state.repeats, {});
});

test('import rejects a file that is not an export of this calculator', () => {
  const repo = reload(new MemoryBackend());
  assert.throws(() => repo.parseImport({ hello: 'world' }), /not an export/);
  assert.throws(() => repo.parseImport(null), /JSON object/);
  assert.throws(() => repo.parseImport({ format: 'unn-gpa-calculator-export' }), /course list/);
  // An export from the Mechanical Engineering calculator is a different format.
  assert.throws(() => repo.parseImport({ format: 'unn-mee-gpa-calculator-export', grades: {} }), /not an export/);
});

test('clearing removes everything', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  await repo.save(setGrade(studentState(), 'x', 'A'));
  await repo.clear();
  const loaded = await repo.load();
  assert.equal(loaded.found, false);
  assert.deepEqual(loaded.state.courses, []);
});

/* ------------------------------------------------------- preferences */

test('display preferences persist and stay out of the record', async () => {
  const backend = new MemoryBackend();
  new PreferencesStore({ backend }).set('fullPrecision', true);
  assert.equal(new PreferencesStore({ backend }).get('fullPrecision'), true);

  const repo = reload(backend);
  await repo.save(studentState());
  const rec = JSON.parse(backend.getItem(STORAGE_KEY));
  assert.ok(!('fullPrecision' in rec));
  const payload = await repo.exportPayload(studentState());
  assert.ok(!('fullPrecision' in payload), 'an export carries results, not screen settings');
});

test('preferences degrade quietly when storage is unusable', () => {
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const prefs = new PreferencesStore({ backend: hostile });
  assert.deepEqual(prefs.read(), {});
  assert.doesNotThrow(() => prefs.set('fullPrecision', true));
  assert.doesNotThrow(() => prefs.clear());
});

test('corrupt preference data is ignored rather than fatal', () => {
  for (const junk of ['not json', '[]', 'null', '"a string"', '']) {
    assert.deepEqual(new PreferencesStore({ backend: new MemoryBackend({ [PREFS_KEY]: junk }) }).read(), {});
  }
});
