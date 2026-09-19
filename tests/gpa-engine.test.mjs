/**
 * The calculation rules, which are the same across the University.
 *
 *     A = 5  B = 4  C = 3  D = 2  E = 1  F = 0
 *     course point = units x grade point
 *     GPA = SUM(units x grade point) / SUM(units), over sat courses only
 *
 * A blank is not a zero. An F is not a blank. Every sitting counts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, setGrade, setAttempt, addAttempt, clearAll,
  summarise, summariseRows, evaluateCourse, attemptsOf, canonicaliseState,
  semesterSummaries, yearSummaries, departmentSummaries, formatGpa, roundGpa,
} from '../src/gpa-engine.js';
import { GRADE_POINTS, coursePoint, gradeMatrixForUnits, isValidGrade, normaliseGrade } from '../src/grading.js';

/** A course as the catalogue resolves it. */
const C = (id, units, opts = {}) => ({
  id, code: id, title: id, units,
  department: opts.department ?? 'Test',
  year: opts.year ?? 1, semester: opts.semester ?? 1,
  maxAttempts: opts.maxAttempts ?? 8,
  failingGrades: ['F'],
});

const c1 = C('c1', 2);
const c2 = C('c2', 3);

/* ------------------------------------------------------ the core rules */

test('a single 2-unit course graded A', () => {
  const r = summarise([c1, c2], setGrade(emptyState(), 'c1', 'A'));
  assert.equal(r.points, 10);
  assert.equal(r.units, 2);
  assert.equal(r.gpaText, '5.00');
});

test('2-unit A plus 3-unit B', () => {
  let s = setGrade(emptyState(), 'c1', 'A');
  s = setGrade(s, 'c2', 'B');
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 22);
  assert.equal(r.units, 5);
  assert.equal(r.gpaText, '4.40');
});

test('an unentered course contributes nothing at all', () => {
  const r = summarise([c1, c2], setGrade(emptyState(), 'c1', 'A'));
  assert.equal(r.units, 2, 'the unentered course must not enter the denominator');
  assert.equal(r.points, 10);
  assert.equal(r.gpaText, '5.00');
});

test('F is active and keeps its units in the denominator', () => {
  let s = setGrade(emptyState(), 'c1', 'A');
  s = setGrade(s, 'c2', 'F');
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 10);
  assert.equal(r.units, 5);
  assert.equal(r.gpaText, '2.00');
});

test('F and "not entered" are genuinely different states', () => {
  const failed = summarise([c1, c2], setGrade(setGrade(emptyState(), 'c1', 'A'), 'c2', 'F'));
  const blank = summarise([c1, c2], setGrade(emptyState(), 'c1', 'A'));
  assert.equal(failed.points, blank.points);
  assert.notEqual(failed.units, blank.units);
});

test('correcting a grade replaces it; exactly one record survives', () => {
  let s = setGrade(emptyState(), 'c1', 'B');
  s = setGrade(s, 'c1', 'A');
  assert.deepEqual(Object.keys(s.grades), ['c1']);
  assert.equal(summarise([c1], s).gpaText, '5.00');
});

test('returning a grade to the dash removes it from the calculation', () => {
  let s = setGrade(emptyState(), 'c1', 'A');
  s = setGrade(s, 'c2', 'B');
  s = setGrade(s, 'c2', '');
  const r = summarise([c1, c2], s);
  assert.equal(r.gradedCourses, 1);
  assert.equal(r.units, 2);
  assert.equal(r.gpaText, '5.00');
});

test('the grade scale is the University-wide A=5 .. F=0', () => {
  assert.deepEqual(GRADE_POINTS, { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 });
  for (const units of [1, 2, 3, 4, 6, 10]) {
    for (const [g, gp] of Object.entries(GRADE_POINTS)) {
      assert.equal(coursePoint(units, g), units * gp);
    }
  }
  assert.deepEqual(gradeMatrixForUnits(3).slice(1).map((r) => [r.grade, r.coursePoint]),
    [['A', 15], ['B', 12], ['C', 9], ['D', 6], ['E', 3], ['F', 0]]);
});

test('invalid grades and blanks never enter the calculation', () => {
  for (const bad of ['G', 'Z', '5', 'AA', 'pass']) {
    assert.equal(isValidGrade(bad), false);
    assert.equal(Object.keys(setGrade(emptyState(), 'c1', bad).grades).length, 0);
  }
  for (const blank of ['', ' ', '-', '—', null, undefined]) {
    assert.equal(Object.keys(setGrade(setGrade(emptyState(), 'c1', 'A'), 'c1', blank).grades).length, 0);
  }
  assert.equal(normaliseGrade('a'), 'A', 'lower case is accepted');
});

test('no results yields no GPA rather than a division by zero', () => {
  const r = summarise([c1, c2], emptyState());
  assert.equal(r.gpa, null);
  assert.equal(r.gpaText, '—');
});

test('an all-F student has a GPA of 0.00, not "no GPA"', () => {
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setGrade(s, 'c2', 'F');
  const r = summarise([c1, c2], s);
  assert.equal(r.units, 5);
  assert.equal(r.gpaText, '0.00');
});

test('a course with no usable unit load stays out of the calculation', () => {
  for (const units of [0, -3, NaN, null, undefined]) {
    const broken = C('bad', units);
    const s = setGrade(emptyState(), 'bad', 'A');
    assert.equal(evaluateCourse(broken, s).active, false, `units ${units}`);
    assert.equal(summarise([broken], s).units, 0);
  }
});

/* ------------------------------------- year, semester and department are labels */

const across = [
  C('a', 2, { year: 1, semester: 1, department: 'Mathematics' }),
  C('b', 3, { year: 2, semester: 2, department: 'Mechanical Engineering' }),
  C('c', 4, { year: 4, semester: 1, department: 'Mechanical Engineering' }),
  C('d', 6, { year: 5, semester: 2, department: 'General Studies' }),
];

test('grades from unrelated years, semesters and departments simply combine', () => {
  let s = setGrade(emptyState(), 'a', 'A');       // 10 over 2
  s = setGrade(s, 'b', 'B');                      // 12 over 3
  s = setGrade(s, 'c', 'C');                      // 12 over 4
  const r = summarise(across, s);
  assert.equal(r.units, 9);
  assert.equal(r.points, 34);
  assert.equal(r.gpaText, '3.78');
});

test('the order in which grades arrive never changes the result', () => {
  const entries = [['a', 'A'], ['b', 'B'], ['c', 'C']];
  const fwd = entries.reduce((s, [id, g]) => setGrade(s, id, g), emptyState());
  const rev = [...entries].reverse().reduce((s, [id, g]) => setGrade(s, id, g), emptyState());
  assert.deepEqual(summarise(across, fwd), summarise(across, rev));
});

test('semester, year and department summaries partition the same active set', () => {
  let s = setGrade(emptyState(), 'a', 'A');
  s = setGrade(s, 'b', 'B');
  s = setGrade(s, 'c', 'C');
  const total = summarise(across, s);

  assert.equal(semesterSummaries(across, s).get('y1s1').gpaText, '5.00');
  assert.equal(yearSummaries(across, s).get('y2').gpaText, '4.00');
  const depts = departmentSummaries(across, s);
  assert.equal(depts.get('Mathematics').units, 2);
  assert.equal(depts.get('Mechanical Engineering').units, 7);
  assert.equal(depts.get('General Studies').gradedCourses, 0);

  for (const buckets of [semesterSummaries(across, s), yearSummaries(across, s), departmentSummaries(across, s)]) {
    assert.equal([...buckets.values()].reduce((x, v) => x + v.units, 0), total.units);
    assert.equal([...buckets.values()].reduce((x, v) => x + v.points, 0), total.points);
  }
});

test('the decision to count a course never reads year, semester or department', () => {
  for (const fn of [evaluateCourse, summariseRows]) {
    const body = fn.toString().replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const token of ['year', 'semester', 'department', 'order']) {
      assert.ok(!new RegExp(`\\b${token}`, 'i').test(body), `${fn.name} must not reference "${token}"`);
    }
  }
});

/* ----------------------------------------------------- repeat sittings */

test('a course failed once then passed counts BOTH sittings', () => {
  const c = C('r', 3);
  let s = setGrade(emptyState(), 'r', 'F');
  s = setAttempt(s, c, 1, 'B');
  const r = summarise([c], s);
  assert.equal(r.units, 6);
  assert.equal(r.points, 12);
  assert.equal(r.gpaText, '2.00', 'a B earned on the second attempt is worth 2.00');
});

test('each further failure degrades the GPA again', () => {
  const c = C('r', 3);
  const run = (...grades) => {
    let s = setGrade(emptyState(), 'r', grades[0]);
    grades.slice(1).forEach((g, i) => { s = setAttempt(s, c, i + 1, g); });
    return summarise([c], s).gpaText;
  };
  assert.equal(run('A'), '5.00');
  assert.equal(run('F', 'A'), '2.50');
  assert.equal(run('F', 'F', 'A'), '1.67');
  assert.equal(run('F', 'F', 'F', 'A'), '1.25');
});

test('a repeat behaves exactly like an extra course of the same size', () => {
  const repeated = C('r', 3);
  let a = setGrade(emptyState(), 'r', 'F');
  a = setAttempt(a, repeated, 1, 'B');
  const two = [C('x', 3), C('y', 3)];
  let b = setGrade(emptyState(), 'x', 'F');
  b = setGrade(b, 'y', 'B');
  assert.equal(summarise([repeated], a).units, summarise(two, b).units);
  assert.equal(summarise([repeated], a).points, summarise(two, b).points);
});

test('a passed course cannot be taken again; E is a pass', () => {
  for (const pass of ['A', 'B', 'C', 'D', 'E']) {
    const c = C('r', 3);
    const ev = evaluateCourse(c, setGrade(emptyState(), 'r', pass));
    assert.equal(ev.passed, true, `${pass} is a pass`);
    assert.equal(ev.canAddAttempt, false);
  }
  assert.equal(evaluateCourse(C('r', 3), setGrade(emptyState(), 'r', 'F')).canAddAttempt, true);
});

test('the sequence stops at the first pass, whatever else is recorded', () => {
  const c = C('r', 3);
  const s = { ...emptyState(), grades: { r: 'F' }, repeats: { r: ['C', 'A', 'B'] } };
  assert.deepEqual(attemptsOf(c, s), ['F', 'C']);
  assert.equal(summarise([c], s).units, 6);
});

test('the sitting allowance is enforced', () => {
  const four = C('r', 3, { maxAttempts: 4 });
  let s = setGrade(emptyState(), 'r', 'F');
  for (let i = 1; i < 12; i++) s = setAttempt(s, four, i, 'F');
  assert.equal(evaluateCourse(four, s).attemptCount, 4);
  assert.equal(evaluateCourse(four, s).canAddAttempt, false, 'the allowance is spent');
  assert.equal(summarise([four], s).units, 12);
});

test('correcting an earlier sitting to a pass drops the sittings after it', () => {
  const c = C('r', 3);
  let s = setGrade(emptyState(), 'r', 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'F');
  s = setAttempt(s, c, 1, 'C');
  assert.deepEqual(attemptsOf(c, s), ['F', 'C']);
  assert.deepEqual(s.repeats, { r: ['C'] }, 'and they are not left in storage');
});

test('clearing the first sitting clears the whole course', () => {
  const c = C('r', 3);
  let s = setGrade(emptyState(), 'r', 'F');
  s = setAttempt(s, c, 1, 'B');
  s = setGrade(s, 'r', '', c);
  assert.deepEqual(attemptsOf(c, s), []);
  assert.deepEqual(s.repeats, {});
});

/* ------------------------------------------------- idempotency of the record */

test('re-recording the same sitting never appends another copy', () => {
  const c = C('r', 3);
  let s = setGrade(emptyState(), 'r', 'F');
  for (let i = 0; i < 25; i++) s = setAttempt(s, c, 1, 'F');
  assert.deepEqual(s.repeats, { r: ['F'] }, 'one F, not twenty-five');
});

test('a blank is never stored as a sitting', () => {
  const c = C('r', 3);
  let s = setGrade(emptyState(), 'r', 'F');
  for (let i = 0; i < 6; i++) s = addAttempt(s, c, '');
  assert.deepEqual(s.repeats ?? {}, {});
});

test('the same history always serialises to the same bytes', () => {
  const c = C('r', 3);
  let a = setGrade(emptyState(), 'r', 'F');
  a = setAttempt(a, c, 1, 'F');
  a = setAttempt(a, c, 2, 'B');

  let b = setGrade(emptyState(), 'r', 'F');
  b = setAttempt(b, c, 1, 'C');
  b = setAttempt(b, c, 1, 'F');
  b = setAttempt(b, c, 2, 'A');
  b = setAttempt(b, c, 2, 'B');

  const shape = (x) => JSON.stringify({ grades: x.grades, repeats: x.repeats });
  assert.equal(shape(a), shape(b));
  assert.equal(shape(a), '{"grades":{"r":"F"},"repeats":{"r":["F","B"]}}');
});

test('canonicaliseState repairs a record that was never canonical', () => {
  const c = C('r', 3, { maxAttempts: 4 });
  const messy = { ...emptyState(), grades: { r: 'F' }, repeats: { r: ['', 'F', null, 'Z', 'B', 'F', 'A'] } };
  const clean = canonicaliseState([c], messy);
  assert.deepEqual(clean.repeats, { r: ['F', 'B'] });
  assert.deepEqual(canonicaliseState([c], clean), clean, 'and it is a fixed point');
});

test('canonicaliseState leaves grades for courses it does not know alone', () => {
  const c = C('r', 3);
  const mixed = { ...emptyState(), grades: { r: 'A', stranger: 'B' }, repeats: { stranger: ['C'] } };
  const clean = canonicaliseState([c], mixed);
  assert.equal(clean.grades.stranger, 'B', 'not silently discarded');
  assert.deepEqual(clean.repeats.stranger, ['C']);
});

test('state transitions never mutate the previous state', () => {
  const c = C('r', 3);
  const s0 = setGrade(emptyState(), 'r', 'F');
  const snapshot = JSON.stringify(s0);
  const s1 = setAttempt(s0, c, 1, 'B');
  const s2 = clearAll(s1);
  assert.equal(JSON.stringify(s0), snapshot);
  assert.equal(evaluateCourse(c, s1).attemptCount, 2);
  assert.equal(Object.keys(s2.grades).length, 0);
});

/* ----------------------------------------------------------- precision */

test('reporting precision changes the text, never the number', () => {
  let s = setGrade(emptyState(), 'a', 'A');
  s = setGrade(s, 'b', 'B');
  s = setGrade(s, 'c', 'C');
  const two = summarise(across, s, { decimals: 2 });
  const five = summarise(across, s, { decimals: 5 });
  assert.equal(two.gpa, five.gpa);
  assert.equal(two.gpaText, '3.78');
  assert.equal(five.gpaText, '3.77778');
  assert.equal(two.classification, five.classification, 'and cannot reclassify anybody');
});

test('GPA is reported to two decimal places by default', () => {
  assert.equal(formatGpa(22 / 5), '4.40');
  assert.equal(formatGpa(34 / 9), '3.78');
  assert.equal(formatGpa(null), '—');
  assert.equal(roundGpa(4.4), 4.4);
});
