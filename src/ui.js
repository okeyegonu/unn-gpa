/**
 * ui.js — presentation only.
 *
 * This module knows about the DOM. It does not know how a GPA is computed
 * (gpa-engine.js), what the grade scale is (grading.js), where results are kept
 * (storage.js), or what a course is (catalogue.js).
 */

import { GRADES } from './grading.js';
import {
  DEFAULT_PROFILE, coursesOf, indexCourses, semesterKeys, departmentsOf,
  addCourse, updateCourse, removeCourse, maxAttemptsForYear, ordinal, nameProblem,
} from './catalogue.js';
import {
  emptyState, setGrade, setAttempt, clearAll,
  evaluateCourse, summarise, semesterSummaries, yearSummaries, departmentSummaries,
  formatGpa, canonicaliseState, attemptsOf,
} from './gpa-engine.js';
import { ResultsRepository, PreferencesStore } from './storage.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  profileMeta: $('#profile-meta'),
  profileToggle: $('#btn-profile-toggle'),
  profileBody: $('#profile-body'),
  profileDepartment: $('#profile-department'),
  profileProgramme: $('#profile-programme'),
  profileMinYears: $('#profile-min-years'),
  profileMaxYears: $('#profile-max-years'),
  profileAllowance: $('#profile-allowance'),
  profileMessages: $('#profile-messages'),

  addHeading: $('#add-heading'),
  addForm: $('#add-form'),
  btnAdd: $('#btn-add'),
  btnCancelEdit: $('#btn-cancel-edit'),
  addHint: $('#add-hint'),
  formMessages: $('#form-messages'),
  fCode: $('#f-code'),
  fTitle: $('#f-title'),
  fDepartment: $('#f-department'),
  fUnits: $('#f-units'),
  fYear: $('#f-year'),
  fSemester: $('#f-semester'),
  departments: $('#departments'),

  toolbar: $('#toolbar'),
  filterText: $('#filter-text'),
  filterDepartment: $('#filter-department'),
  filterEntered: $('#filter-entered'),
  togglePrecision: $('#toggle-precision'),
  toggleRepeats: $('#toggle-repeats'),

  emptyState: $('#empty-state'),
  root: $('#courses-root'),

  gpa: $('#stat-gpa'),
  klass: $('#stat-class'),
  courses: $('#stat-courses'),
  attemptsNote: $('#stat-attempts'),
  units: $('#stat-units'),
  points: $('#stat-points'),
  saveState: $('#save-state'),

  totalsPanel: $('#totals-panel'),
  yearTotals: $('#year-totals').tBodies[0],
  deptHeading: $('#dept-heading'),
  deptScroll: $('#dept-scroll'),
  deptTotals: $('#dept-totals').tBodies[0],
  cumCourses: $('#cum-courses'),
  cumUnits: $('#cum-units'),
  cumPoints: $('#cum-points'),
  cumGpa: $('#cum-gpa'),

  colophon: $('#colophon'),
  btnExport: $('#btn-export'),
  btnImport: $('#btn-import'),
  btnReset: $('#btn-reset'),
  fileImport: $('#file-import'),
};

const PRECISION = { normal: 2, full: 5 };

let state = null;       // { profile, courses, grades, repeats }
let courses = [];       // resolved, sorted course records
let byId = new Map();
let repo = null;
let prefs = null;
let editingId = null;   // the course currently being amended, if any

/* ------------------------------------------------------------------ boot */

async function boot() {
  repo = new ResultsRepository();
  prefs = new PreferencesStore();

  const loaded = await repo.load();
  state = { ...emptyState(), profile: { ...DEFAULT_PROFILE }, courses: [], ...loaded.state };
  resolveCourses();
  state = canonicaliseState(courses, state);

  fillYearOptions();
  syncProfileInputs();
  wireControls();
  render();

  els.saveState.textContent = loaded.found
    ? `Loaded your saved work${loaded.savedAt ? ` (saved ${formatWhen(loaded.savedAt)})` : ''}`
    : 'Nothing entered yet';
  els.colophon.innerHTML =
    'Grades are <strong>A = 5, B = 4, C = 3, D = 2, E = 1, F = 0</strong>, the scale used across the ' +
    'University of Nigeria, Nsukka. Your courses and results are stored only in this browser and are ' +
    'never transmitted anywhere. Use <em>Export results</em> to keep a backup or move to another device.';
}

function resolveCourses() {
  courses = coursesOf(state);
  byId = indexCourses(courses);
}

/* --------------------------------------------------------------- profile */

function profile() {
  return { ...DEFAULT_PROFILE, ...(state.profile ?? {}) };
}

function fillYearOptions() {
  const years = Math.max(4, Math.min(10, profile().minYears || 4));
  const current = els.fYear.value;
  els.fYear.innerHTML = '';
  for (let y = 1; y <= years; y++) {
    els.fYear.append(new Option(`${ordinal(y)} year`, String(y)));
  }
  if (current && Number(current) <= years) els.fYear.value = current;
}

function syncProfileInputs() {
  const p = profile();
  els.profileDepartment.value = p.department;
  els.profileProgramme.value = p.programme;
  els.profileMinYears.value = String(p.minYears);
  els.profileMaxYears.value = String(p.maxYears);
  describeAllowance();
}

function describeAllowance() {
  const p = profile();
  const first = maxAttemptsForYear(1, p);
  const last = maxAttemptsForYear(p.minYears, p);
  els.profileAllowance.textContent =
    `With ${p.minYears} years to graduate and ${p.maxYears} allowed, a course is repeated only after an F: ` +
    `a first-year course may be sat up to ${first} times and a final-year course up to ${last}. ` +
    `Once you pass a course it is closed.`;
}

async function onProfileChange() {
  // The department is written in words here for the same reason it is on a
  // course: it labels courses that do not carry one of their own.
  const problem = nameProblem(els.profileDepartment.value, 'A department name');
  els.profileMessages.hidden = !problem;
  els.profileMessages.innerHTML = problem ? `<p class="msg error">${escapeHtml(problem)}</p>` : '';
  if (problem) {
    els.profileDepartment.value = profile().department;   // keep the last good value
    return;
  }

  const p = {
    department: els.profileDepartment.value,
    programme: els.profileProgramme.value,
    minYears: Number(els.profileMinYears.value) || DEFAULT_PROFILE.minYears,
    maxYears: Number(els.profileMaxYears.value) || DEFAULT_PROFILE.maxYears,
  };
  if (p.maxYears < p.minYears) p.maxYears = p.minYears;
  state = { ...state, profile: p };
  resolveCourses();
  // A shorter allowance can make sittings impossible; tidy rather than leave
  // the record disagreeing with what the rules now permit.
  state = canonicaliseState(courses, state);
  await persist();
  fillYearOptions();
  describeAllowance();
  render();
}

/* ------------------------------------------------------- adding a course */

function readDraft() {
  return {
    code: els.fCode.value,
    title: els.fTitle.value,
    department: els.fDepartment.value || profile().department,
    units: Number(els.fUnits.value),
    year: Number(els.fYear.value),
    semester: Number(els.fSemester.value),
  };
}

function clearForm() {
  els.fCode.value = '';
  els.fTitle.value = '';
  els.fUnits.value = '';
  // department, year and semester are deliberately left as they were: a student
  // entering a semester's courses is usually entering several in a row.
}

function showMessages(result) {
  const parts = [];
  for (const e of result.errors ?? []) parts.push(`<p class="msg error">${escapeHtml(e)}</p>`);
  for (const w of result.warnings ?? []) parts.push(`<p class="msg warn">${escapeHtml(w)}</p>`);
  els.formMessages.innerHTML = parts.join('');
  els.formMessages.hidden = parts.length === 0;
}

async function onSubmit(event) {
  event.preventDefault();
  const draft = readDraft();

  if (editingId) {
    const { state: next, result } = updateCourse(state, editingId, draft);
    showMessages(result);
    if (!result.ok) return;
    state = next;
    stopEditing();
  } else {
    const { state: next, result } = addCourse(state, draft);
    showMessages(result);
    if (!result.ok) return;
    state = next;
    clearForm();
    els.fCode.focus();
  }

  resolveCourses();
  await persist();
  render();
}

function startEditing(id) {
  const c = byId.get(id);
  if (!c) return;
  editingId = id;
  els.fCode.value = c.code;
  els.fTitle.value = c.title;
  els.fDepartment.value = c.department;
  els.fUnits.value = String(c.units);
  els.fYear.value = String(c.year);
  els.fSemester.value = String(c.semester);
  els.addHeading.textContent = `Edit ${c.code}`;
  els.btnAdd.textContent = 'Save changes';
  els.btnCancelEdit.hidden = false;
  els.addHint.textContent = 'Your grades for this course are kept.';
  els.formMessages.hidden = true;
  els.fCode.scrollIntoView({ block: 'center' });
  els.fCode.focus();
}

function stopEditing() {
  editingId = null;
  clearForm();
  els.addHeading.textContent = 'Add a course';
  els.btnAdd.textContent = 'Add course';
  els.btnCancelEdit.hidden = true;
  els.addHint.textContent = 'Add them one at a time, or all at once — whichever suits you.';
  els.formMessages.hidden = true;
}

async function onDelete(id) {
  const c = byId.get(id);
  if (!c) return;
  const sittings = attemptsOf(c, state).length;
  const warning = sittings > 0
    ? `\n\n${sittings} recorded ${sittings === 1 ? 'grade' : 'sittings'} will be deleted with it.`
    : '';
  if (!confirm(`Remove ${c.code}${c.title ? ` — ${c.title}` : ''} from your list?${warning}`)) return;
  if (editingId === id) stopEditing();
  state = removeCourse(state, id);
  resolveCourses();
  await persist();
  render();
}

/* ---------------------------------------------------------------- events */

async function onAttemptChange(course, index, value) {
  state = setAttempt(state, course, index, value);
  await persist();
  render();
}

async function persist() {
  try {
    await repo.save(state);
    els.saveState.textContent = `Saved ${formatWhen(new Date().toISOString())}`;
  } catch (err) {
    els.saveState.textContent = `Could not save: ${err.message}`;
  }
}

function wireControls() {
  els.profileToggle.addEventListener('click', () => {
    const open = els.profileBody.hidden;
    els.profileBody.hidden = !open;
    els.profileToggle.setAttribute('aria-expanded', String(open));
    els.profileToggle.textContent = open ? 'Done' : 'Edit';
  });
  for (const el of [els.profileDepartment, els.profileProgramme, els.profileMinYears, els.profileMaxYears]) {
    el.addEventListener('change', onProfileChange);
  }

  els.addForm.addEventListener('submit', onSubmit);
  els.btnCancelEdit.addEventListener('click', stopEditing);

  els.filterText.addEventListener('input', applyFilter);
  els.filterDepartment.addEventListener('change', applyFilter);
  els.filterEntered.addEventListener('change', applyFilter);

  els.togglePrecision.checked = prefs.get('fullPrecision', false) === true;
  els.togglePrecision.addEventListener('change', () => {
    prefs.set('fullPrecision', els.togglePrecision.checked);
    render();
  });

  els.toggleRepeats.checked = prefs.get('showRepeats', false) === true;
  els.toggleRepeats.title =
    'Show a grade box for every sitting of a course. Each sitting counts separately: its units go into ' +
    'the total again and its points are added again, so repeating a course lowers the GPA.';
  els.toggleRepeats.addEventListener('change', () => {
    prefs.set('showRepeats', els.toggleRepeats.checked);
    render();
  });

  els.btnExport.addEventListener('click', onExport);
  els.btnImport.addEventListener('click', () => els.fileImport.click());
  els.fileImport.addEventListener('change', onImport);
  els.btnReset.addEventListener('click', onReset);
}

async function onExport() {
  const payload = await repo.exportPayload(state, {
    summary: publicSummary(),
    course_records: courseRecords(),
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `unn-gpa-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function onImport() {
  const file = els.fileImport.files?.[0];
  els.fileImport.value = '';
  if (!file) return;
  try {
    const parsed = repo.parseImport(JSON.parse(await file.text()));
    if (!confirm(
      `Import ${parsed.courseCount} course(s) and ${parsed.gradeCount} grade(s)?\n\n` +
      'This replaces everything currently in this browser.')) return;
    state = parsed.state;
    resolveCourses();
    state = canonicaliseState(courses, state);
    stopEditing();
    await persist();
    syncProfileInputs();
    fillYearOptions();
    render();
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
}

async function onReset() {
  const n = state.courses?.length ?? 0;
  if (n === 0) { alert('There is nothing to reset.'); return; }
  if (!confirm(`Delete all ${n} course(s) and every grade you have entered? This cannot be undone.`)) return;
  if (!confirm('Please confirm once more: erase everything?')) return;
  state = { ...clearAll(state), courses: [] };
  await repo.clear();
  resolveCourses();
  stopEditing();
  render();
  els.saveState.textContent = 'Everything cleared';
}

/* -------------------------------------------------------------- rendering */

function repeatsVisible() {
  if (els.toggleRepeats.checked) return true;
  const r = state.repeats ?? {};
  return Object.keys(r).some((id) => Array.isArray(r[id]) && r[id].length > 0);
}

function reportOpts() {
  return { decimals: els.togglePrecision.checked ? PRECISION.full : PRECISION.normal };
}

/** Rebuild the whole list. The list is small and entirely student-owned, so a
 *  full rebuild is simpler than patching, and focus is restored afterwards. */
function render() {
  const hasCourses = courses.length > 0;
  els.emptyState.hidden = hasCourses;
  els.toolbar.hidden = !hasCourses;
  els.totalsPanel.hidden = !hasCourses;

  const p = profile();
  els.profileMeta.textContent = [p.programme, p.department].filter(Boolean).join(' · ')
    || 'Set your department and programme below';

  els.departments.innerHTML = '';
  for (const d of departmentsOf(courses)) els.departments.append(new Option(d));

  const chosenDept = els.filterDepartment.value;
  els.filterDepartment.innerHTML = '<option value="">All departments</option>';
  for (const d of departmentsOf(courses)) els.filterDepartment.append(new Option(d, d));
  if (chosenDept) els.filterDepartment.value = chosenDept;

  renderList();
  renderSummaries();
  applyFilter();
}

function renderList() {
  const active = document.activeElement;
  const activeId = active?.closest?.('tr[data-id]')?.dataset.id ?? null;
  const activeIndex = activeId ? [...(active.closest('tr').querySelectorAll('select.grade'))].indexOf(active) : -1;

  els.root.innerHTML = '';
  const showRepeats = repeatsVisible();

  for (const key of semesterKeys(courses)) {
    const here = courses.filter((c) => c.year === key.year && c.semester === key.semester);
    if (here.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'semester';
    section.dataset.key = key.key;

    const header = document.createElement('header');
    const h3 = document.createElement('h3');
    h3.textContent = `${ordinal(key.year)} year · ${key.semester === 1 ? 'First' : 'Second'} semester`;
    const strip = document.createElement('div');
    strip.className = 'sem-summary';
    strip.dataset.key = key.key;
    header.append(h3, strip);
    section.append(header);

    const table = document.createElement('table');
    table.className = 'courses';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Course</th><th class="col-title">Title</th>' +
      '<th class="num">Units</th><th>Grade</th>' +
      '<th class="num">Grade&nbsp;pt</th><th class="num">Course&nbsp;pt</th><th></th>' +
      '</tr></thead><tbody></tbody>';
    const tbody = table.tBodies[0];
    for (const c of here) tbody.append(buildRow(c, showRepeats));
    section.append(table);
    els.root.append(section);
  }

  if (activeId && activeIndex >= 0) {
    const sel = document.querySelectorAll(`tr[data-id="${CSS.escape(activeId)}"] select.grade`)[activeIndex];
    sel?.focus();
  }
}

function buildRow(course, showRepeats) {
  const ev = evaluateCourse(course, state);
  const tr = document.createElement('tr');
  tr.dataset.id = course.id;
  tr.classList.toggle('active', ev.active);
  tr.classList.toggle('repeated', ev.repeatCount > 0);
  tr.classList.toggle('exhausted', !ev.passed && ev.attemptCount > 0 && ev.attemptCount >= ev.maxAttempts);

  const tdCode = document.createElement('td');
  tdCode.className = 'c-code';
  tdCode.textContent = course.code;
  if (course.department) {
    const d = document.createElement('div');
    d.className = 'dept';
    d.textContent = course.department;
    tdCode.append(d);
  }

  const tdTitle = document.createElement('td');
  tdTitle.className = 'c-title';
  if (course.title) tdTitle.textContent = course.title;
  else tdTitle.innerHTML = '<span class="unknown">No title given</span>';

  const tdUnits = document.createElement('td');
  tdUnits.className = 'num cell-units';
  tdUnits.dataset.label = 'Units';
  tdUnits.innerHTML = ev.attemptCount > 1
    ? `${ev.units}<span class="sub">${ev.baseUnits} × ${ev.attemptCount}</span>`
    : String(course.units);

  const tdGrade = document.createElement('td');
  tdGrade.className = 'cell-grade';
  const stack = document.createElement('div');
  stack.className = 'attempt-stack';
  const wanted = showRepeats ? Math.max(1, ev.attemptCount + (ev.canAddAttempt ? 1 : 0)) : 1;
  stack.classList.toggle('multi', wanted > 1);
  if (wanted > 1) {
    stack.title = ev.passed
      ? `Passed at sitting ${ev.attemptCount}. A passed course cannot be taken again.`
      : `Every sitting counts separately. This course allows up to ${ev.maxAttempts} sittings.`;
  }
  for (let i = 0; i < wanted; i++) {
    const g = ev.attempts[i]?.grade ?? '';
    const sel = document.createElement('select');
    sel.className = 'grade' + (g ? ' set' : '');
    sel.dataset.grade = g;
    sel.setAttribute('aria-label',
      wanted > 1 ? `${course.code}, sitting ${i + 1} of up to ${ev.maxAttempts}` : `Grade for ${course.code}`);
    sel.append(new Option('—', ''));
    for (const gr of GRADES) sel.append(new Option(gr, gr));
    sel.value = g;
    sel.addEventListener('change', () => onAttemptChange(course, i, sel.value));
    const wrap = document.createElement('span');
    wrap.className = 'attempt' + (wanted > 1 ? ' numbered' : '') + (!g && wanted > 1 ? ' pending' : '');
    wrap.dataset.sitting = String(i + 1);
    wrap.append(sel);
    stack.append(wrap);
  }
  tdGrade.append(stack);

  const tdGp = document.createElement('td');
  tdGp.className = 'num cell-gp';
  tdGp.dataset.label = 'Grade pt';
  const gps = ev.attempts.map((a) => a.gradePoint);
  tdGp.innerHTML = gps.length === 0 ? '<span class="dash">—</span>' : gps.join(' · ');

  const tdPt = document.createElement('td');
  tdPt.className = 'num cell-pt';
  tdPt.dataset.label = 'Course pt';
  tdPt.innerHTML = ev.coursePoint === null ? '<span class="dash">—</span>' : String(ev.coursePoint);

  const tdActions = document.createElement('td');
  tdActions.className = 'cell-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'row-action';
  edit.textContent = 'Edit';
  edit.setAttribute('aria-label', `Edit ${course.code}`);
  edit.addEventListener('click', () => startEditing(course.id));
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'row-action danger';
  del.textContent = 'Remove';
  del.setAttribute('aria-label', `Remove ${course.code}`);
  del.addEventListener('click', () => onDelete(course.id));
  tdActions.append(edit, del);

  tr.append(tdCode, tdTitle, tdUnits, tdGrade, tdGp, tdPt, tdActions);
  return tr;
}

function renderSummaries() {
  const opts = reportOpts();

  const sems = semesterSummaries(courses, state, opts);
  for (const strip of document.querySelectorAll('.sem-summary')) {
    const s = sems.get(strip.dataset.key);
    strip.innerHTML = !s || s.gradedCourses === 0
      ? '<span class="dash">no results entered</span>'
      : `${s.gradedCourses} graded · ${s.units} units · ${s.points} points · Semester GPA <b>${s.gpaText}</b>`;
  }

  const years = yearSummaries(courses, state, opts);
  els.yearTotals.innerHTML = '';
  const presentYears = [...new Set(courses.map((c) => c.year))].sort((a, b) => a - b);
  for (const y of presentYears) {
    const s = years.get(`y${y}`);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<th>${escapeHtml(ordinal(y))} year</th>` +
      `<td class="num">${s.gradedCourses}</td>` +
      `<td class="num">${s.units}</td>` +
      `<td class="num">${s.points}</td>` +
      `<td class="num">${s.gradedCourses ? s.gpaText : '<span class="dash">—</span>'}</td>`;
    els.yearTotals.append(tr);
  }

  const depts = departmentSummaries(courses, state, opts);
  const deptNames = [...depts.keys()].filter((k) => k !== '(no department)').sort();
  const showDept = deptNames.length > 1;
  els.deptHeading.hidden = !showDept;
  els.deptScroll.hidden = !showDept;
  els.deptTotals.innerHTML = '';
  if (showDept) {
    for (const name of deptNames) {
      const s = depts.get(name);
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<th>${escapeHtml(name)}</th>` +
        `<td class="num">${s.gradedCourses}</td>` +
        `<td class="num">${s.units}</td>` +
        `<td class="num">${s.points}</td>` +
        `<td class="num">${s.gradedCourses ? s.gpaText : '<span class="dash">—</span>'}</td>`;
      els.deptTotals.append(tr);
    }
  }

  const total = summarise(courses, state, opts);
  els.gpa.textContent = total.gpaText;
  els.klass.textContent = total.gradedCourses ? (total.classification ?? '') : 'no results entered yet';
  els.courses.textContent = String(total.gradedCourses);
  els.attemptsNote.textContent = total.repeats > 0
    ? `${total.attempts} sittings · ${total.repeats} repeat${total.repeats > 1 ? 's' : ''}`
    : '';
  els.units.textContent = String(total.units);
  els.points.textContent = String(total.points);
  els.cumCourses.textContent = String(total.gradedCourses);
  els.cumUnits.textContent = String(total.units);
  els.cumPoints.textContent = String(total.points);
  els.cumGpa.textContent = total.gpaText;
}

function applyFilter() {
  const q = els.filterText.value.trim().toLowerCase();
  const dept = els.filterDepartment.value;
  const onlyEntered = els.filterEntered.checked;

  for (const tr of document.querySelectorAll('tr[data-id]')) {
    const c = byId.get(tr.dataset.id);
    if (!c) continue;
    const hay = `${c.code} ${c.title} ${c.department}`.toLowerCase();
    const matches = (!q || hay.includes(q))
      && (!dept || c.department === dept)
      && (!onlyEntered || Boolean(state.grades?.[c.id]));
    tr.classList.toggle('hidden', !matches);
  }

  // A semester with nothing left to show is hidden entirely.
  for (const section of document.querySelectorAll('.semester')) {
    const anyVisible = [...section.querySelectorAll('tr[data-id]')].some((tr) => !tr.classList.contains('hidden'));
    section.hidden = !anyVisible;
  }
}

function publicSummary() {
  const t = summarise(courses, state);
  return {
    graded_courses: t.gradedCourses,
    sittings: t.attempts,
    units: t.units,
    quality_points: t.points,
    gpa: formatGpa(t.gpa, PRECISION.normal),
    gpa_full_precision: formatGpa(t.gpa, PRECISION.full),
  };
}

/** One record per course sat, listing every sitting in order. */
function courseRecords() {
  const out = [];
  for (const course of courses) {
    const sittings = attemptsOf(course, state);
    if (sittings.length === 0) continue;
    const ev = evaluateCourse(course, state);
    out.push({
      course_id: course.id,
      code: course.code,
      title: course.title,
      department: course.department,
      year: course.year,
      semester: course.semester,
      units: ev.baseUnits,
      sittings,
      sittings_allowed: ev.maxAttempts,
      passed: ev.passed,
      units_counted: ev.units,
      quality_points: ev.coursePoint,
    });
  }
  return out;
}

/* --------------------------------------------------------------- helpers */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function formatWhen(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

boot();
