/**
 * The sessional statement of result: formatting, validation, the prerequisite
 * rule, and the figures that appear on the sheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LETTERHEAD_RESERVE_MM,
  formatFullName, formatShortName, nameProblems,
  normaliseRegNo, regNoProblem, REG_NO_PATTERN, REG_NO_MIN_DIGITS, REG_NO_MAX_DIGITS,
  formatSession, sessionProblem, parseSession,
  yearOfStudyOptions, formatYearOfStudy, combinedYearOfStudyOptions, parseYearOfStudy,
  GENDERS, genderProblem,
  prerequisiteCheck, buildTranscript, transcriptProblems,
} from '../src/transcript.js';
import { DEFAULT_PROFILE, addCourse, coursesOf } from '../src/catalogue.js';
import { emptyState, setGrade, setAttempt } from '../src/gpa-engine.js';

/** A small programme entered by a student, standing in for a curriculum. */
function programme() {
  let state = { ...emptyState(), profile: { ...DEFAULT_PROFILE, minYears: 5, maxYears: 8 }, courses: [] };
  const add = (code, title, units, year, semester) => {
    state = addCourse(state, { code, title, department: 'Physics', units, year, semester }).state;
  };
  // Year 1: 16 units across two semesters. Year 2: 16 more.
  add('PHY 101', 'General Physics I', 3, 1, 1);
  add('MTH 111', 'Elementary Mathematics I', 3, 1, 1);
  add('CHM 101', 'Basic Chemistry', 2, 1, 1);
  add('PHY 102', 'General Physics II', 3, 1, 2);
  add('MTH 112', 'Elementary Mathematics II', 3, 1, 2);
  add('GST 111', 'Use of English', 2, 1, 2);
  add('PHY 201', 'Thermal Physics', 3, 2, 1);
  add('PHY 203', 'Optics', 3, 2, 1);
  add('MTH 211', 'Linear Algebra', 2, 2, 1);
  add('PHY 202', 'Electromagnetism', 3, 2, 2);
  add('PHY 204', 'Modern Physics', 3, 2, 2);
  add('STA 211', 'Statistics', 2, 2, 2);
  return state;
}

const baseState = programme();
const courses = coursesOf(baseState);
const byId = new Map(courses.map((c) => [c.id, c]));
const blank = () => ({ ...baseState, grades: {}, repeats: {} });

/* -------------------------------------------------------------- the reserve */

test('the letterhead reserve is the measured 62.7 mm', () => {
  // Measured from the reference statement rendered at 150 dpi: the letterhead's
  // ink ends at 50.5 mm and the "To:" line begins at 62.7 mm.
  assert.equal(LETTERHEAD_RESERVE_MM, 62.7);
  assert.ok(LETTERHEAD_RESERVE_MM > 50.5, 'it must clear the printed letterhead');
});

/* -------------------------------------------------------------------- names */

test('the addressee reads SURNAME, Firstname Middlename', () => {
  assert.equal(
    formatFullName({ first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma Blessing',
  );
  assert.equal(formatFullName({ first: 'ifeoma', middle: 'blessing', surname: 'okechukwu' }),
    'OKECHUKWU, Ifeoma Blessing', 'however it was typed');
  assert.equal(formatFullName({ first: '  Ifeoma  ', middle: '', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma', 'a missing middle name leaves no stray spacing');
});

test('the details line reduces the middle name to an initial', () => {
  assert.equal(
    formatShortName({ first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma B.',
  );
  assert.equal(formatShortName({ first: 'Ifeoma', middle: '', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma');
});

test('compound and apostrophised names keep their capitals', () => {
  assert.equal(formatFullName({ first: "chidi-emeka", middle: "o'brien", surname: 'nwosu' }),
    "NWOSU, Chidi-Emeka O'Brien");
});

test('a name must be given, and cannot contain numbers', () => {
  assert.deepEqual(nameProblems({ first: 'Ifeoma', surname: 'Okechukwu' }), []);
  assert.match(nameProblems({ first: '', surname: 'Okechukwu' }).join(' '), /first name is required/i);
  assert.match(nameProblems({ first: 'Ifeoma', surname: '' }).join(' '), /surname is required/i);
  assert.match(nameProblems({ first: 'Ifeoma2', surname: 'Okechukwu' }).join(' '), /cannot contain numbers/i);
});

/* ------------------------------------------------------ registration number */

test('a registration number is a four-digit year, a slash and 2 to 9 digits', () => {
  assert.equal(REG_NO_MIN_DIGITS, 2);
  assert.equal(REG_NO_MAX_DIGITS, 9);

  // Today's numbers carry six or seven numerals; the range allows for growth.
  for (const good of ['2021/242857', '2019/1234567', '2024/000001', '2024/12', '2024/123456789']) {
    assert.equal(regNoProblem(good), null, good);
    assert.ok(REG_NO_PATTERN.test(good));
  }
  // Every serial length from two to nine is accepted.
  for (let n = REG_NO_MIN_DIGITS; n <= REG_NO_MAX_DIGITS; n++) {
    assert.equal(regNoProblem(`2024/${'1'.repeat(n)}`), null, `${n} digits`);
  }
  for (const bad of ['2024/1', '2024/1234567890', '21/242857', '20211/242857',
                     '2021-242857', '2021/abcdef', '2021/24285A', '242857', '']) {
    assert.ok(regNoProblem(bad), `${bad} should be refused`);
  }
});

test('spaces around a registration number are removed', () => {
  assert.equal(normaliseRegNo('  2021 / 242857 '), '2021/242857');
  assert.equal(regNoProblem('  2021/242857  '), null);
});

test('an impossible entry year is refused', () => {
  assert.match(regNoProblem('1850/242857'), /does not look like an entry year/i);
  assert.match(regNoProblem('2999/242857'), /does not look like an entry year/i);
});

/* ------------------------------------------------------------------ session */

test('a session is written in full years, never abbreviated', () => {
  assert.equal(formatSession(2023), '2023/2024');
  assert.equal(formatSession('2019'), '2019/2020');
  assert.notEqual(formatSession(2023), '2023/24');
  assert.equal(sessionProblem(2023), null);
});

test('a session that spans the century still reads in full', () => {
  assert.equal(formatSession(1999), '1999/2000');
  assert.equal(formatSession(2099), '2099/2100');
});

test('a nonsensical session is refused', () => {
  for (const bad of ['', null, 'abc', '1200', '2500', 'twenty']) {
    assert.ok(sessionProblem(bad), String(bad));
  }
});

test('the session is typed, and either shape is accepted', () => {
  // The opening year alone, or the session written out in full.
  assert.deepEqual(parseSession('2023'), { year: 2023, problem: null });
  assert.deepEqual(parseSession('2023/2024'), { year: 2023, problem: null });
  assert.deepEqual(parseSession('  2023 / 2024  '), { year: 2023, problem: null },
    'spacing is of no consequence');
  assert.equal(formatSession(parseSession('2023/2024').year), '2023/2024');
});

test('an abbreviated session is refused, and the full form suggested', () => {
  const r = parseSession('2023/24');
  assert.equal(r.year, null);
  assert.match(r.problem, /written in full years/i);
  assert.match(r.problem, /2023\/2024/, 'and it says what to write instead');
});

test('two years that are not consecutive are refused', () => {
  const r = parseSession('2023/2025');
  assert.equal(r.year, null);
  assert.match(r.problem, /consecutive/i);
  assert.match(r.problem, /2024/);
});

test('a session outside living memory is refused', () => {
  assert.match(parseSession('1850').problem, /opening year/i);
  assert.match(parseSession('2500/2501').problem, /opening year/i);
});

/* ------------------------------------------------------------ year of study */

test('the year of study denominator is the programme length, never the year', () => {
  const opts = yearOfStudyOptions(5);
  assert.equal(opts.length, 8, 'eight options, because eight years is the maximum');
  assert.deepEqual(opts.map((o) => o.label),
    ['1/5', '2/5', '3/5', '4/5', '5/5', '6/5', '7/5', '8/5']);
  assert.ok(!opts.some((o) => o.label === '4/4'), 'the reference statement\'s 4/4 is not reproduced');
  assert.equal(formatYearOfStudy(4, 5), '4/5');
});

test('a four-year programme reads 1/4 to 8/4', () => {
  assert.deepEqual(yearOfStudyOptions(4).map((o) => o.label),
    ['1/4', '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '8/4']);
  // 4/4 is correct here — it is only a blunder when the programme is longer.
  assert.equal(formatYearOfStudy(4, 4), '4/4');
});

/* ------------------------------------------------------------------ gender */

test('the field offers Male and Female, and is called Gender', () => {
  assert.deepEqual(GENDERS, ['Male', 'Female']);
  assert.equal(genderProblem('Female'), null);
  assert.match(genderProblem('female'), /Male or Female/);
  assert.match(genderProblem(''), /Male or Female/);
});

/* ------------------------------------------------------- the prerequisite */

/** Every course the student has listed for a year is required. */
const requiredFor = (year) => courses.filter((c) => c.year === year);

test('a first-year statement needs nothing earlier', () => {
  const r = prerequisiteCheck(1, blank(), requiredFor);
  assert.equal(r.ok, true);
  assert.equal(r.missingCount, 0);
});

test('a second-year statement is blocked until first year is complete', () => {
  const r = prerequisiteCheck(2, blank(), requiredFor);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingByYear.map((m) => m.year), [1]);
  assert.equal(r.missingCount, 6, 'the six first-year courses this student listed');
});

test('entering every earlier result unblocks it', () => {
  let s = blank();
  for (const c of [...requiredFor(1)]) s = setGrade(s, c.id, 'B');
  const r = prerequisiteCheck(2, s, requiredFor);
  assert.equal(r.ok, true, 'first year complete');

  const r3 = prerequisiteCheck(3, s, requiredFor);
  assert.equal(r3.ok, false, 'but the second year is still missing');
  assert.deepEqual(r3.missingByYear.map((m) => m.year), [2]);
});

test('the block names every year and course that is missing', () => {
  let s = blank();
  // First year complete but for one course; second year untouched.
  const year1 = requiredFor(1);
  for (const c of year1.slice(1)) s = setGrade(s, c.id, 'A');

  const r = prerequisiteCheck(3, s, requiredFor);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingByYear.map((m) => m.year), [1, 2]);
  assert.equal(r.missingByYear[0].courses.length, 1);
  assert.equal(r.missingByYear[0].courses[0].code, year1[0].code);
  assert.ok(r.missingByYear[1].courses.length > 0);
});

test('an F counts as a result entered, a blank does not', () => {
  let s = blank();
  for (const c of requiredFor(1)) s = setGrade(s, c.id, 'F');
  assert.equal(prerequisiteCheck(2, s, requiredFor).ok, true,
    'a failed course is still a result');
});

/* ------------------------------------------------------------- the figures */

test('the session GPA covers the session; the CGPA covers everything before it', () => {
  const y1 = requiredFor(1);
  const y2first = courses.filter((c) => c.year === 2 && c.semester === 1);
  const y2second = courses.filter((c) => c.year === 2 && c.semester === 2);

  let s = blank();
  for (const c of y1) s = setGrade(s, c.id, 'C');          // 3 points a unit
  for (const c of [...y2first, ...y2second]) s = setGrade(s, c.id, 'A');   // 5 a unit

  const t = buildTranscript({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: '2021/242857', gender: 'Female' },
    session: 2023, yearOfStudy: 2, programmeYears: 5,
    firstSemester: y2first, secondSemester: y2second,
    cumulativeCourses: [...y1, ...y2first, ...y2second],
    state: s,
  });

  assert.equal(t.gpa, '5.00', 'the session was all As');
  assert.ok(Number(t.cgpa) < 5 && Number(t.cgpa) > 3, `the CGPA is dragged down by first year: ${t.cgpa}`);
  assert.notEqual(t.gpa, t.cgpa, 'a cumulative figure is not the session figure');

  // 16 units of C (48 points) and 16 of A (80) -> 128 / 32
  assert.equal(t.cgpaUnits, 32);
  assert.equal(t.cgpaPoints, 128);
  assert.equal(t.cgpa, '4.00');
});

test('the statement carries every formatted field', () => {
  const y1s1 = courses.filter((c) => c.year === 1 && c.semester === 1);
  let s = blank();
  for (const c of y1s1) s = setGrade(s, c.id, 'A');

  const t = buildTranscript({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: ' 2021/242857 ', gender: 'Female' },
    session: 2023, yearOfStudy: 1, programmeYears: 5,
    firstSemester: y1s1, secondSemester: [],
    cumulativeCourses: y1s1, state: s,
  });

  assert.equal(t.addressee, 'OKECHUKWU, Ifeoma Blessing');
  assert.equal(t.name, 'OKECHUKWU, Ifeoma B.');
  assert.equal(t.regNo, '2021/242857');
  assert.equal(t.yearOfStudy, '1/5');
  assert.equal(t.gender, 'Female');
  assert.equal(t.session, '2023/2024');
  assert.equal(t.semesters[0].rows.length, y1s1.length);
  assert.equal(t.semesters[1].rows.length, 0);
  assert.equal(t.semesters[0].rows[0].title, t.semesters[0].rows[0].title.toUpperCase(),
    'titles are set in capitals, as on the reference');
});

test('a repeated course shows every sitting on the statement', () => {
  const mee313 = courses.find((c) => c.code === 'PHY 201');   // 3 units
  let s = setGrade(blank(), mee313.id, 'F');
  s = setAttempt(s, mee313, 1, 'B');

  const t = buildTranscript({
    student: { first: 'A', surname: 'B', regNo: '2021/242857', gender: 'Male' },
    session: 2023, yearOfStudy: 2, programmeYears: 5,
    firstSemester: [mee313], secondSemester: [],
    cumulativeCourses: [mee313], state: s,
  });
  assert.equal(t.semesters[0].rows[0].grade, 'F / B');
  assert.deepEqual(t.semesters[0].rows[0].sittings, ['F', 'B']);
  assert.equal(t.gpa, '2.00', 'both sittings count');
});

test('the year-of-study denominator follows the student\'s own programme', () => {
  assert.deepEqual(yearOfStudyOptions(4).map((o) => o.label).slice(0, 4), ['1/4', '2/4', '3/4', '4/4']);
  assert.deepEqual(yearOfStudyOptions(6).map((o) => o.label).slice(0, 4), ['1/6', '2/6', '3/6', '4/6']);
  assert.equal(yearOfStudyOptions(4).length, 8, 'always eight options');
});

test('everything wrong is reported at once, not one thing at a time', () => {
  const problems = transcriptProblems({
    student: { first: '', surname: '', regNo: 'nonsense', gender: '' }, session: 'x', yearOfStudy: 0,
    firstSemester: [], secondSemester: [],
  });
  for (const expected of [/first name/i, /surname/i, /registration number/i, /Male or Female/i,
    /session/i, /year of study/i, /at least one course/i]) {
    assert.ok(problems.some((p) => expected.test(p)), `expected a problem matching ${expected}`);
  }
});

test('a complete form reports no problems', () => {
  const y1s1 = courses.filter((c) => c.year === 1 && c.semester === 1);
  assert.deepEqual(transcriptProblems({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: '2021/242857', gender: 'Female' },
    session: 2023, yearOfStudy: 1,
    firstSemester: y1s1, secondSemester: [],
  }), []);
});

test('a student-written course title is printed exactly as they wrote it', () => {
  const phy = courses.find((c) => c.code === 'PHY 101');
  const s = setGrade(blank(), phy.id, 'A');
  const args = {
    student: { first: 'A', surname: 'B', regNo: '2021/242857', gender: 'Male' },
    session: 2023, yearOfStudy: 1, programmeYears: 4,
    firstSemester: [phy], secondSemester: [], cumulativeCourses: [phy], state: s,
  };

  // This calculator prints the student's own wording.
  const own = buildTranscript({ ...args, uppercaseTitles: false });
  assert.equal(own.semesters[0].rows[0].title, 'General Physics I');
  assert.equal(own.semesters[0].rows[0].code, 'PHY 101');

  // The departmental statement sets its titles in capitals.
  const departmental = buildTranscript({ ...args, uppercaseTitles: true });
  assert.equal(departmental.semesters[0].rows[0].title, 'GENERAL PHYSICS I');

  // The default is the departmental form, so the choice must be made explicitly.
  assert.equal(buildTranscript(args).semesters[0].rows[0].title, 'GENERAL PHYSICS I');
});

test('a long programme such as Medicine is not cut off at eight years', () => {
  // Seven years to graduate, ten allowed: the year of study runs to 10/7.
  const medicine = yearOfStudyOptions(7, 10).map((o) => o.label);
  assert.deepEqual(medicine,
    ['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7', '8/7', '9/7', '10/7']);
  assert.equal(formatYearOfStudy(9, 7), '9/7');

  // Six years with nine allowed, and four with seven, follow the same rule.
  assert.equal(yearOfStudyOptions(6, 9).length, 9);
  assert.equal(yearOfStudyOptions(4, 7).map((o) => o.label).join(','), '1/4,2/4,3/4,4/4,5/4,6/4,7/4');

  // And a five-year programme with eight allowed still reads exactly as the
  // Department's statement does.
  assert.deepEqual(yearOfStudyOptions(5, 8).map((o) => o.label),
    ['1/5', '2/5', '3/5', '4/5', '5/5', '6/5', '7/5', '8/5']);
});

/* --------------------------------------------------------------------------
   The university-wide dropdown carries every programme length at once.
   -------------------------------------------------------------------------- */

test('one dropdown covers 1/4 to 7/4, 1/5 to 8/5, 1/6 to 9/6 and 1/7 to 10/7', () => {
  const groups = combinedYearOfStudyOptions();
  assert.deepEqual(groups.map((g) => g.programmeYears), [4, 5, 6, 7]);
  assert.deepEqual(groups.map((g) => g.options.length), [7, 8, 9, 10]);

  const all = groups.flatMap((g) => g.options.map((o) => o.label));
  assert.equal(all.length, 34, 'thirty-four choices in all');
  for (const expected of ['1/4', '7/4', '1/5', '8/5', '1/6', '9/6', '1/7', '10/7']) {
    assert.ok(all.includes(expected), expected);
  }
  // A programme of n years allows n + 3 and no more.
  assert.ok(!all.includes('8/4'), 'a four-year programme stops at 7/4');
  assert.ok(!all.includes('9/5'), 'a five-year programme stops at 8/5');
  assert.ok(!all.includes('10/6'), 'a six-year programme stops at 9/6');
  assert.ok(!all.includes('11/7'), 'a seven-year programme stops at 10/7');
});

test('each choice carries its own denominator', () => {
  const groups = combinedYearOfStudyOptions();
  for (const g of groups) {
    for (const o of g.options) {
      assert.equal(o.value, `${o.year}/${o.programmeYears}`);
      assert.equal(o.programmeYears, g.programmeYears);
      assert.deepEqual(parseYearOfStudy(o.value), { year: o.year, programmeYears: o.programmeYears });
    }
  }
});

test('a choice reads back into the year and the programme length', () => {
  assert.deepEqual(parseYearOfStudy('2/7'), { year: 2, programmeYears: 7 });
  assert.deepEqual(parseYearOfStudy(' 10 / 7 '), { year: 10, programmeYears: 7 });
  for (const bad of ['', 'x', '3', '3/', '/5', '0/5', '3/0', null, undefined]) {
    assert.equal(parseYearOfStudy(bad), null, String(bad));
  }
});

test('the statement prints whatever denominator was chosen', () => {
  const phy = courses.find((c) => c.code === 'PHY 101');
  const s = setGrade(blank(), phy.id, 'A');
  const make = (value) => {
    const { year, programmeYears } = parseYearOfStudy(value);
    return buildTranscript({
      student: { first: 'A', surname: 'B', regNo: '2021/242857', gender: 'Male' },
      session: 2023, yearOfStudy: year, programmeYears,
      firstSemester: [phy], secondSemester: [], cumulativeCourses: [phy], state: s,
      uppercaseTitles: false,
    }).yearOfStudy;
  };
  assert.equal(make('3/4'), '3/4');
  assert.equal(make('3/5'), '3/5');
  assert.equal(make('9/6'), '9/6');
  assert.equal(make('10/7'), '10/7');
});

test('the sheet names no officer and carries no signature block', () => {
  const phy = courses.find((c) => c.code === 'PHY 101');
  const s = setGrade(blank(), phy.id, 'A');
  const t = buildTranscript({
    student: { first: 'A', middle: 'B', surname: 'C', regNo: '2021/242857', gender: 'Male' },
    session: 2023, yearOfStudy: 1, programmeYears: 4,
    firstSemester: [phy], secondSemester: [], cumulativeCourses: [phy], state: s,
  });
  // A working copy names nobody and carries no signature block at all.
  assert.equal(t.hod, undefined);
  const printed = JSON.stringify(t);
  assert.ok(!printed.includes('Eke'));
  assert.ok(!/Head of Department/i.test(printed),
    'the sheet does not mention the office either');
});
