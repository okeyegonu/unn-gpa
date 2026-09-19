#!/usr/bin/env node
/**
 * End-to-end test in a real Firefox, driven over WebDriver.
 *
 * Prerequisites:
 *   - geckodriver, running:  geckodriver --port 4444
 *   - the app being served:  ./serve.sh
 *
 * Run:  node tools/browser-smoke.mjs [appUrl] [driverUrl]
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const DRIVER = process.argv[3] ?? 'http://localhost:4444';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function call(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.value;
}

const session = await call('POST', '/session', {
  capabilities: {
    alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless', '-width', '1280', '-height', '1400'] },
    },
  },
});
const sid = session.sessionId;
const exec = (script, args = []) => call('POST', `/session/${sid}/execute/sync`, { script, args });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = () => new Promise((r) => setTimeout(r, 220));

const waitFor = async (expr, label, timeoutMs = 15000) => {
  const started = Date.now();
  for (;;) {
    if (await exec(`return (${expr});`)) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 120));
  }
};

const summary = () => exec(`return {
  gpa: document.getElementById('stat-gpa').textContent.trim(),
  courses: document.getElementById('stat-courses').textContent.trim(),
  units: document.getElementById('stat-units').textContent.trim(),
  points: document.getElementById('stat-points').textContent.trim(),
  note: document.getElementById('stat-attempts').textContent.trim()
};`);

const rowCount = () => exec(`return document.querySelectorAll('tr[data-id]').length;`);
const visibleRows = () => exec(`
  return Array.from(document.querySelectorAll('tr[data-id]'))
    .filter(function (tr) { return !tr.classList.contains('hidden') && tr.offsetParent !== null; }).length;
`);
const messages = () => exec(`
  var box = document.getElementById('form-messages');
  return { hidden: box.hidden, text: box.textContent.trim() };
`);

/** Fill the add-course form and submit it, exactly as a student would. */
async function addCourse(c) {
  await exec(`
    document.getElementById('f-code').value = ${JSON.stringify(c.code)};
    document.getElementById('f-title').value = ${JSON.stringify(c.title ?? '')};
    document.getElementById('f-department').value = ${JSON.stringify(c.department ?? '')};
    document.getElementById('f-units').value = ${JSON.stringify(String(c.units ?? ''))};
    document.getElementById('f-year').value = '${c.year ?? 1}';
    document.getElementById('f-semester').value = '${c.semester ?? 1}';
    document.getElementById('add-form').requestSubmit();
  `);
  await settle();
}

/** The row for a course code, by its visible text. */
const rowIdFor = (code) => exec(`
  var rows = Array.from(document.querySelectorAll('tr[data-id]'));
  var hit = rows.find(function (tr) { return tr.querySelector('.c-code').textContent.indexOf(${JSON.stringify(code)}) === 0; });
  return hit ? hit.dataset.id : null;
`);

const sit = async (id, index, grade) => {
  const ok = await exec(`
    var ss = document.querySelectorAll('tr[data-id="' + ${JSON.stringify(id)} + '"] select.grade');
    if (!ss[${index}]) return false;
    ss[${index}].value = '${grade}';
    ss[${index}].dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  if (!ok) throw new Error(`no grade box ${index} on ${id}`);
  await settle();
};

const setSwitch = async (id, on) => {
  await exec(`var t = document.getElementById('${id}'); t.checked = ${on}; t.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
};

try {
  console.log(`\nDriving ${APP} in headless Firefox\n`);
  await go(APP);
  await waitFor(`document.getElementById('btn-add') && !document.getElementById('btn-add').disabled`, 'the page to render');

  /* ---- an empty calculator ---- */
  const empty = await exec(`return {
    emptyShown: !document.getElementById('empty-state').hidden,
    toolbarHidden: document.getElementById('toolbar').hidden,
    totalsHidden: document.getElementById('totals-panel').hidden,
    gpa: document.getElementById('stat-gpa').textContent.trim()
  };`);
  check('a new student is shown how to start, with nothing else in the way',
    empty.emptyShown && empty.toolbarHidden && empty.totalsHidden && empty.gpa === '—',
    JSON.stringify(empty));

  /* ---- the programme profile ---- */
  await exec(`
    document.getElementById('profile-department').value = 'Physics';
    document.getElementById('profile-programme').value = 'B.Sc. Physics';
    document.getElementById('profile-min-years').value = '4';
    document.getElementById('profile-max-years').value = '7';
    document.getElementById('profile-max-years').dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await settle();
  check('the programme is recorded and described',
    (await exec(`return document.getElementById('profile-meta').textContent.trim();`)) === 'B.Sc. Physics · Physics');
  check('the repeat allowance is explained in plain words',
    (await exec(`return document.getElementById('profile-allowance').textContent;`)).includes('up to 7 times'));

  const years = await exec(`
    var y = document.getElementById('f-year');
    return { count: y.options.length, first: y.options[0].text, last: y.options[y.options.length - 1].text };
  `);
  check('the year box offers eight years, however long the programme is',
    years.count === 8 && years.first === 'First year' && years.last === 'Eighth year', JSON.stringify(years));

  /* ---- adding courses ---- */
  await addCourse({ code: 'PHY 101', title: 'General Physics I', department: 'Physics', units: 3, year: 1, semester: 1 });
  check('the first course appears and the tools come out', (await rowCount()) === 1 &&
    (await exec(`return document.getElementById('toolbar').hidden === false;`)) === true);

  await addCourse({ code: 'MTH 111', title: 'Elementary Mathematics I', department: 'Mathematics', units: 3, year: 1, semester: 1 });
  await addCourse({ code: 'GST 111', title: 'Use of English', department: 'General Studies', units: 2, year: 1, semester: 1 });
  await addCourse({ code: 'PHY 202', title: 'Thermal Physics', department: 'Physics', units: 2, year: 2, semester: 2 });
  check('four courses across two years', (await rowCount()) === 4);
  check('they are grouped into their own semesters',
    (await exec(`return document.querySelectorAll('.semester').length;`)) === 2);

  await addCourse({ code: 'PHY 801', title: 'Late Sitting', department: 'Physics', units: 2, year: 8, semester: 1 });
  check('a course can be recorded against the eighth year', (await rowCount()) === 5);
  check('and it is grouped under its own year',
    (await exec(`return Array.from(document.querySelectorAll('.semester h3')).map(function (h) { return h.textContent.trim(); }).join(' | ');`))
      .includes('Eighth year'));
  await exec(`window.confirm = function () { return true; };`);
  await exec(`
    var rows = Array.from(document.querySelectorAll('tr[data-id]'));
    var hit = rows.find(function (tr) { return tr.querySelector('.c-code').textContent.indexOf('PHY 801') === 0; });
    hit.querySelectorAll('button.row-action')[1].click();
  `);
  await settle();
  check('and removed again cleanly', (await rowCount()) === 4);

  /* ---- the checks that stop a broken list ---- */
  await addCourse({ code: 'PHY 101', title: 'typed twice', units: 3, year: 1, semester: 1 });
  let msg = await messages();
  check('the same course twice in a semester is refused, pointing at repeats',
    msg.hidden === false && /already in your list/i.test(msg.text) && /I repeated a course/i.test(msg.text),
    msg.text.slice(0, 80));
  check('and no duplicate row was created', (await rowCount()) === 4);

  // A missing or impossible unit load is stopped by the browser's own required
  // and min constraints, before the handler runs at all. The catalogue's own
  // checks sit behind those, for data arriving by import rather than by typing;
  // they are exercised directly in tests/catalogue.test.mjs.
  for (const units of ['', 0, -3]) {
    await addCourse({ code: 'BAD 101', title: 'bad units', units, year: 1, semester: 1 });
  }
  check('a course with no usable unit load cannot be added', (await rowCount()) === 4);
  check('and the form reports it as invalid rather than silently doing nothing',
    (await exec(`return document.getElementById('f-units').validity.valid === false;`)) === true);

  // Leave the form clean for the rest of the run.
  await exec(`document.getElementById('f-code').value = ''; document.getElementById('f-units').value = '';`);

  /* ---- grading, incrementally ---- */
  const phy101 = await rowIdFor('PHY 101');
  const mth111 = await rowIdFor('MTH 111');
  const gst111 = await rowIdFor('GST 111');
  const phy202 = await rowIdFor('PHY 202');

  await sit(phy101, 0, 'A');
  let s = await summary();
  check('one 3-unit A gives 15 points over 3 units, GPA 5.00',
    s.units === '3' && s.points === '15' && s.gpa === '5.00', JSON.stringify(s));

  await sit(phy202, 0, 'B');
  s = await summary();
  check('a result from another year simply joins it: 23 / 5 = 4.60',
    s.units === '5' && s.points === '23' && s.gpa === '4.60', JSON.stringify(s));

  await sit(gst111, 0, 'F');
  s = await summary();
  check('an F adds its units and no points: 23 / 7 = 3.29',
    s.units === '7' && s.points === '23' && s.gpa === '3.29', JSON.stringify(s));
  check('the ungraded course stays dormant', s.courses === '3');

  await sit(phy202, 0, '');
  s = await summary();
  // PHY 101 A (3 units, 15 points) and GST 111 F (2 units, 0 points) remain.
  check('clearing a grade removes it: 15 / 5 = 3.00',
    s.units === '5' && s.points === '15' && s.gpa === '3.00', JSON.stringify(s));
  await sit(phy202, 0, 'B');

  /* ---- repeat sittings ---- */
  await setSwitch('toggle-repeats', true);
  check('a passed course offers no resit', (await exec(`return document.querySelectorAll('tr[data-id="${phy101}"] select.grade').length;`)) === 1);
  check('a failed course does', (await exec(`return document.querySelectorAll('tr[data-id="${gst111}"] select.grade').length;`)) === 2);

  await sit(gst111, 1, 'C');
  s = await summary();
  check('both sittings of the failed course count: 29 / 9 = 3.22',
    s.units === '9' && s.points === '29' && s.gpa === '3.22', JSON.stringify(s));
  check('the sittings are reported', s.note === '4 sittings · 1 repeat', s.note);
  const gstRow = await exec(`var tr = document.querySelector('tr[data-id="${gst111}"]'); return {
    units: tr.querySelector('.cell-units').textContent.trim(),
    gp: tr.querySelector('.cell-gp').textContent.trim(),
    pt: tr.querySelector('.cell-pt').textContent.trim()
  };`);
  check('and shown on the row as 4 units from 2 × 2, grade points 0 · 3',
    gstRow.units.includes('4') && gstRow.units.includes('2 × 2') && gstRow.gp === '0 · 3' && gstRow.pt === '6',
    JSON.stringify(gstRow));

  /* ---- editing a course keeps its grades ---- */
  await exec(`document.querySelector('tr[data-id="${mth111}"] button.row-action').click();`);
  await settle();
  check('editing loads the course into the form',
    (await exec(`return document.getElementById('f-code').value;`)) === 'MTH 111');
  await exec(`
    document.getElementById('f-units').value = '4';
    document.getElementById('f-title').value = 'Elementary Mathematics I (corrected)';
    document.getElementById('add-form').requestSubmit();
  `);
  await settle();
  check('the correction is applied without adding a course', (await rowCount()) === 4);

  await sit(mth111, 0, 'F');
  await sit(mth111, 1, 'B');
  s = await summary();
  check('a corrected unit load applies to every sitting: 45 / 17 = 2.65',
    s.units === '17' && s.points === '45' && s.gpa === '2.65', JSON.stringify(s));

  /* ---- summaries ---- */
  const panels = await exec(`return {
    years: document.querySelectorAll('#year-totals tbody tr').length,
    depts: document.querySelectorAll('#dept-totals tbody tr').length,
    deptShown: document.getElementById('dept-scroll').hidden === false,
    cumGpa: document.getElementById('cum-gpa').textContent.trim()
  };`);
  check('the year and department panels both report', panels.years === 2 && panels.depts === 3 && panels.deptShown,
    JSON.stringify(panels));
  check('the cumulative figure matches the headline', panels.cumGpa === s.gpa);

  /* ---- filtering is display only ---- */
  await exec(`var f = document.getElementById('filter-text'); f.value = 'physics'; f.dispatchEvent(new Event('input', { bubbles: true }));`);
  await settle();
  check('searching narrows the list without touching the GPA',
    (await visibleRows()) === 2 && (await summary()).gpa === s.gpa, `${await visibleRows()} rows visible`);
  await exec(`var f = document.getElementById('filter-text'); f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true }));`);
  await settle();

  await exec(`var d = document.getElementById('filter-department'); d.value = 'Mathematics'; d.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  check('filtering by department works too', (await visibleRows()) === 1);
  await exec(`var d = document.getElementById('filter-department'); d.value = ''; d.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();

  /* ---- precision ---- */
  await setSwitch('toggle-precision', true);
  const prec = await summary();
  check('full precision shows five places without changing the figures',
    prec.gpa === (45 / 17).toFixed(5) && prec.units === '17' && prec.points === '45', JSON.stringify(prec));
  await setSwitch('toggle-precision', false);

  /* ---- persistence ---- */
  const before = await summary();
  await go('about:blank');
  await go(APP);
  await waitFor(`document.getElementById('btn-add') && !document.getElementById('btn-add').disabled`, 'reload');
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the saved course list');
  await settle();
  const after = await summary();
  check('the course list survives a reload', (await rowCount()) === 4);
  check('and every figure with it', JSON.stringify(after) === JSON.stringify(before),
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check('the programme is remembered',
    (await exec(`return document.getElementById('profile-meta').textContent.trim();`)) === 'B.Sc. Physics · Physics');

  const stored = await exec(`
    var rec = JSON.parse(localStorage.getItem('unn-gpa-calculator'));
    return { courses: rec.courses.length, grades: Object.keys(rec.grades).length,
             repeats: Object.keys(rec.repeats).length, dept: rec.profile.department };
  `);
  check('storage holds one record per course, with no duplicates',
    stored.courses === 4 && stored.grades === 4 && stored.repeats === 2 && stored.dept === 'Physics',
    JSON.stringify(stored));

  /* ---- re-recording the same grade must not grow anything ---- */
  const recBefore = await exec(`return JSON.stringify(JSON.parse(localStorage.getItem('unn-gpa-calculator')).repeats);`);
  for (let i = 0; i < 6; i++) await sit(gst111, 1, 'C');
  check('re-recording the same sitting six times changes nothing',
    (await exec(`return JSON.stringify(JSON.parse(localStorage.getItem('unn-gpa-calculator')).repeats);`)) === recBefore);

  /* ---- removing a course takes its grades ---- */
  await exec(`window.confirm = function () { return true; };`);
  await exec(`document.querySelectorAll('tr[data-id="${phy202}"] button.row-action')[1].click();`);
  await settle();
  check('removing a course removes its row', (await rowCount()) === 3);
  s = await summary();
  check('and its grade leaves the GPA with it: 37 / 15 = 2.47',
    s.units === '15' && s.points === '37' && s.gpa === '2.47', JSON.stringify(s));

  await exec(`localStorage.clear();`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} browser check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
