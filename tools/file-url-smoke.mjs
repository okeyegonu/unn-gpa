#!/usr/bin/env node
/**
 * Verifies the single-file build works when opened straight from disk
 * (file:// URL) with no server at all — which is how a student who receives
 * it over WhatsApp will open it.
 *
 * Also reports whether localStorage survives on the file:// origin, since that
 * determines whether entered grades persist in the offline copy.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = pathToFileURL(resolve(root, 'dist/unn-gpa-calculator.html')).href;
const DRIVER = process.argv[2] ?? 'http://localhost:4444';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Fill the add-course form and submit it, as a student would. */
async function addCourseVia(exec, c) {
  await exec(`
    document.getElementById('f-code').value = ${JSON.stringify(c.code)};
    document.getElementById('f-title').value = ${JSON.stringify(c.title ?? '')};
    document.getElementById('f-units').value = '${c.units}';
    document.getElementById('f-year').value = '${c.year}';
    document.getElementById('f-semester').value = '${c.semester}';
    document.getElementById('add-form').requestSubmit();
  `);
  await new Promise((r) => setTimeout(r, 250));
}

/** Grade the nth course row. */
async function gradeVia(exec, index, grade) {
  await exec(`
    var rows = document.querySelectorAll('tr[data-id]');
    var sel = rows[${index}].querySelector('select.grade');
    sel.value = '${grade}';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 250));
}

const call = async (m, p, b) => {
  const r = await fetch(DRIVER + p, {
    method: m, headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j.value;
};

console.log(`\nOpening the single-file build directly from disk\n  ${FILE}\n`);

const session = await call('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '390', '-height', '844'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });

try {
  await call('POST', `/session/${sid}/url`, { url: FILE });
  for (let i = 0; i < 100; i++) {
    if (await exec(`return document.getElementById('btn-add') && !document.getElementById('btn-add').disabled;`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  check('the page renders with no server and no network',
    (await exec(`return document.getElementById('btn-add') && !document.getElementById('btn-add').disabled;`)) === true);
  check('it starts with an empty course list',
    (await exec(`return document.getElementById('empty-state').hidden === false;`)) === true);
  check('the page made no external requests',
    (await exec(`return performance.getEntriesByType('resource').filter(function(r){return !r.name.startsWith('file:');}).length;`)) === 0);

  await addCourseVia(exec, { code: 'PHY 101', title: 'General Physics I', units: 2, year: 1, semester: 1 });
  await addCourseVia(exec, { code: 'MTH 111', title: 'Elementary Mathematics I', units: 3, year: 1, semester: 1 });
  await gradeVia(exec, 0, 'A');
  await gradeVia(exec, 1, 'B');
  const s = await exec(`return { gpa: document.getElementById('stat-gpa').textContent.trim(), units: document.getElementById('stat-units').textContent.trim() };`);
  // The list sorts by code, so MTH 111 (3 units) is the first row and takes the
  // A, and PHY 101 (2 units) takes the B: 15 + 8 = 23 over 5 units.
  check('courses added and graded offline calculate correctly (23 / 5 = 4.60)',
    s.gpa === '4.60' && s.units === '5', JSON.stringify(s));

  const storageWorks = await exec(`
    try { localStorage.setItem('__probe__', '1'); var v = localStorage.getItem('__probe__'); localStorage.removeItem('__probe__'); return v === '1'; }
    catch (e) { return 'blocked: ' + e.name; }
  `);
  check('localStorage is available on the file:// origin', storageWorks === true, String(storageWorks));

  if (storageWorks === true) {
    await call('POST', `/session/${sid}/url`, { url: 'about:blank' });
    await call('POST', `/session/${sid}/url`, { url: FILE });
    for (let i = 0; i < 100; i++) {
      if (await exec(`return document.querySelectorAll('tr[data-id]').length > 0;`)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = await exec(`return { gpa: document.getElementById('stat-gpa').textContent.trim(), courses: document.getElementById('stat-courses').textContent.trim(), rows: document.querySelectorAll('tr[data-id]').length };`);
    check('the course list and grades survive reopening the downloaded file',
      after.gpa === '4.60' && after.courses === '2' && after.rows === 2, JSON.stringify(after));
    await exec(`localStorage.clear();`);
  }
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'The offline single-file build works.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
