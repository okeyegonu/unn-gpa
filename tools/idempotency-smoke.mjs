#!/usr/bin/env node
/**
 * Idempotency checks, in a real Firefox.
 *
 * The question these answer: can any repeated action make the stored record
 * grow? Saving twice, submitting the form twice, re-recording the same grade,
 * editing a course over and over, reloading repeatedly, importing the same
 * file twice — none of them may add a second copy of anything.
 *
 * Prerequisites: geckodriver --port 4444, and the app served.
 * Run:  node tools/idempotency-smoke.mjs [appUrl] [driverUrl]
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const DRIVER = process.argv[3] ?? 'http://localhost:4444';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const call = async (m, p, b) => {
  const r = await fetch(DRIVER + p, {
    method: m, headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j.value;
};

const session = await call('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '1200', '-height', '1000'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = () => new Promise((r) => setTimeout(r, 250));

const waitFor = async (expr, label) => {
  for (let i = 0; i < 150; i++) {
    if (await exec(`return (${expr});`)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out waiting for: ${label}`);
};

/** The stored record, with the timestamp removed so two can be compared. */
const record = () => exec(`
  var r = JSON.parse(localStorage.getItem('unn-gpa-calculator') || '{}');
  delete r.saved_at;
  return JSON.stringify(r);
`);
const rowCount = () => exec(`return document.querySelectorAll('tr[data-id]').length;`);
const summary = () => exec(`return {
  gpa: document.getElementById('stat-gpa').textContent.trim(),
  units: document.getElementById('stat-units').textContent.trim(),
  points: document.getElementById('stat-points').textContent.trim()
};`);

const fillForm = (c) => exec(`
  document.getElementById('f-code').value = ${JSON.stringify(c.code)};
  document.getElementById('f-title').value = ${JSON.stringify(c.title ?? '')};
  document.getElementById('f-department').value = ${JSON.stringify(c.department ?? '')};
  document.getElementById('f-units').value = ${JSON.stringify(String(c.units))};
  document.getElementById('f-year').value = '${c.year}';
  document.getElementById('f-semester').value = '${c.semester}';
`);

async function addCourse(c) {
  await fillForm(c);
  await exec(`document.getElementById('add-form').requestSubmit();`);
  await settle();
}

const rowIdFor = (code) => exec(`
  var rows = Array.from(document.querySelectorAll('tr[data-id]'));
  var hit = rows.find(function (tr) { return tr.querySelector('.c-code').textContent.indexOf(${JSON.stringify(code)}) === 0; });
  return hit ? hit.dataset.id : null;
`);

const sit = async (id, index, grade) => {
  await exec(`
    var ss = document.querySelectorAll('tr[data-id="' + ${JSON.stringify(id)} + '"] select.grade');
    if (ss[${index}]) { ss[${index}].value = '${grade}'; ss[${index}].dispatchEvent(new Event('change', { bubbles: true })); }
  `);
  await settle();
};

try {
  console.log(`\nIdempotency — ${APP}\n`);
  await go(APP);
  await waitFor(`!!document.getElementById('add-form')`, 'the page');
  await exec(`localStorage.clear();`);
  await go(APP);
  await waitFor(`!!document.getElementById('add-form')`, 'a clean page');

  /* 1. Submitting the form twice in a row cannot add the course twice. */
  await addCourse({ code: 'PHY 101', title: 'General Physics I', department: 'Physics', units: 3, year: 1, semester: 1 });
  check('the course is added once', (await rowCount()) === 1);

  await addCourse({ code: 'PHY 101', title: 'General Physics I', department: 'Physics', units: 3, year: 1, semester: 1 });
  check('submitting the same course again is refused', (await rowCount()) === 1);

  /* 2. A burst of submits, fired without waiting between them. */
  await fillForm({ code: 'MTH 111', title: 'Elementary Mathematics I', department: 'Mathematics', units: 3, year: 1, semester: 1 });
  await exec(`
    var f = document.getElementById('add-form');
    for (var i = 0; i < 8; i++) f.requestSubmit();
  `);
  await settle();
  await settle();
  check('eight submits in one burst add exactly one course', (await rowCount()) === 2, `${await rowCount()} rows`);

  /* 3. Re-recording the same grade. */
  const phy = await rowIdFor('PHY 101');
  const mth = await rowIdFor('MTH 111');
  await sit(phy, 0, 'A');
  const afterOneGrade = await record();
  for (let i = 0; i < 8; i++) await sit(phy, 0, 'A');
  check('recording the same grade eight more times changes nothing',
    (await record()) === afterOneGrade);

  /* 4. Re-recording the same failed sitting. */
  await exec(`var t = document.getElementById('toggle-repeats'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  await sit(mth, 0, 'F');
  await sit(mth, 1, 'F');
  await sit(mth, 2, 'C');
  const afterSittings = await record();
  for (let i = 0; i < 6; i++) { await sit(mth, 1, 'F'); await sit(mth, 2, 'C'); }
  check('re-recording the same sittings six times changes nothing',
    (await record()) === afterSittings);
  check('and there are exactly the three sittings',
    (await exec(`return JSON.parse(localStorage.getItem('unn-gpa-calculator')).repeats['${mth}'].length;`)) === 2,
    'first sitting plus two repeats');

  /* 5. Reloading repeatedly must not drift. */
  const shapes = new Set([await record()]);
  for (let i = 0; i < 4; i++) {
    await go('about:blank');
    await go(APP);
    await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload');
    await settle();
    shapes.add(await record());
  }
  check('four reloads leave the record byte-identical', shapes.size === 1,
    `${shapes.size} distinct shapes`);
  check('and the course list is still two courses', (await rowCount()) === 2);

  /* 6. Editing a course over and over. */
  const before = await summary();
  for (let i = 0; i < 5; i++) {
    await exec(`document.querySelector('tr[data-id="${phy}"] button.row-action').click();`);
    await settle();
    await exec(`document.getElementById('add-form').requestSubmit();`);
    await settle();
  }
  check('saving the same edit five times adds no course', (await rowCount()) === 2);
  check('and leaves the figures untouched', JSON.stringify(await summary()) === JSON.stringify(before),
    `${JSON.stringify(before)} -> ${JSON.stringify(await summary())}`);
  check('the course keeps its id, and so its grades', (await rowIdFor('PHY 101')) === phy);

  /* 7. Exporting and re-importing, twice. */
  const payload = await exec(`
    var r = JSON.parse(localStorage.getItem('unn-gpa-calculator'));
    return JSON.stringify({ format: 'unn-gpa-calculator-export', format_version: 1,
      profile: r.profile, courses: r.courses, grades: r.grades, repeats: r.repeats });
  `);
  await exec(`window.confirm = function () { return true; };`);
  for (let i = 0; i < 2; i++) {
    await exec(`
      var payload = ${JSON.stringify(payload)};
      var file = new File([payload], 'x.json', { type: 'application/json' });
      var dt = new DataTransfer();
      dt.items.add(file);
      var input = document.getElementById('file-import');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await settle();
    await settle();
  }
  check('importing the same file twice gives two courses, not four', (await rowCount()) === 2,
    `${await rowCount()} rows`);
  check('and the same figures as before the import',
    JSON.stringify(await summary()) === JSON.stringify(before), JSON.stringify(await summary()));

  /* 8. A course removed and re-added is a new course, not a resurrected one. */
  await exec(`document.querySelectorAll('tr[data-id="${phy}"] button.row-action')[1].click();`);
  await settle();
  check('removing it leaves one course', (await rowCount()) === 1);
  await addCourse({ code: 'PHY 101', title: 'General Physics I', department: 'Physics', units: 3, year: 1, semester: 1 });
  check('re-adding it gives one row again', (await rowCount()) === 2);
  check('with no grade carried over from the removed one',
    (await exec(`
      var id = Array.from(document.querySelectorAll('tr[data-id]'))
        .find(function (tr) { return tr.querySelector('.c-code').textContent.indexOf('PHY 101') === 0; }).dataset.id;
      var r = JSON.parse(localStorage.getItem('unn-gpa-calculator'));
      return r.grades[id] === undefined && id !== '${phy}';
    `)) === true);

  await exec(`localStorage.clear();`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'Idempotent: nothing grows on repetition.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
