# UNN GPA Calculator

A browser-based GPA calculator for students of the **University of Nigeria, Nsukka**,
in any department.

There is no fixed curriculum here: the student enters their own courses — the
department, the title, the code and the unit load — and then adds each grade as
the result is released. Its defining behaviour is the same as the Mechanical
Engineering calculator it grew out of:

> The GPA represents all and only the results the student has entered at the
> present moment.

Runs in Firefox and Chrome, on desktop and on phones.

---

## Launching it

```bash
cd ~/unn-gpa
./serve.sh
```

Then open **<http://localhost:8000/>**. `./serve.sh` also prints a
`http://192.168.x.x:8000/` address for phones on the same Wi-Fi. Any static
server does:

```bash
python3 -m http.server 8000                   # this computer only
python3 -m http.server 8000 --bind 0.0.0.0    # reachable from phones on the LAN
```

For a copy that opens straight from disk with no server at all:

```bash
npm run build     # -> dist/unn-gpa-calculator.html
```

One file, about 84 kB, no network access of any kind.

### Everything you can run

```bash
npm test              # 113 calculation, catalogue, statement and persistence tests
npm run build         # rebuild the single-file offline copy
npm run smoke         # end-to-end test in a real Firefox   (needs geckodriver)
npm run smoke:mobile  # the same at three phone viewports
npm run smoke:offline # test the single-file build opened from file://
npm run smoke:transcript   # end-to-end checks for the PDF statement
npm run mockup <url> <out.pdf>  # print a specimen statement to a real PDF
npm run smoke:idempotency  # check that no repetition makes the record grow
```

The `smoke` targets need `geckodriver --port 4444` running in another terminal
and, for the first two, the app being served.

---

## How the calculation works

```
A = 5    B = 4    C = 3    D = 2    E = 1    F = 0

course point = course units × grade point

              Σ (units × grade point)   over courses with a grade entered
      GPA  =  ───────────────────────
                     Σ (units)          over courses with a grade entered
```

That scale is the same across the whole University, which is why it is the one
thing in this calculator the student cannot change.

Four rules matter, and the tests pin all four:

- **A blank is not a zero.** A course with no grade contributes 0 units to the
  denominator and 0 points to the numerator. It is invisible to the calculation.
- **An F is not a blank.** It is an attempted course: 0 points, but its units
  stay in the denominator. `3 units A` plus `2 units F` is 15 ÷ 5 = **3.00**.
- **A repeated course counts once per sitting.** Failing a 3-unit course and
  passing it next time contributes 6 units and 12 points, so that pass is worth
  2.00 rather than 4.00. See *Repeat sittings* below.
- **Year, semester and department are labels, not rules.** They group the
  display and drive the per-semester, per-year and per-department panels. They
  never decide whether a course counts. A student may enter a first-year result,
  a third-year result and nothing else, and get a GPA over exactly those two.

---

## Entering courses

Each course needs a **code**, a **unit load**, and the **year and semester** it
was taken in. The **title** and **department** are optional but worth adding:
they make the list readable and drive the per-department summary.

The year box offers **eight years** whatever the programme length, since a
student who has spent longer than the minimum still has courses to record. A
programme longer than eight years extends the list rather than truncating it.

Courses can be added one at a time as a semester unfolds, or all at once. The
department, year and semester stay as they were between additions, because a
student entering a semester's courses is usually entering several in a row.

**What is checked.** A course list nobody can read is worse than no list at all,
so:

- a **course code** takes letters, numbers and spaces only, and at most
  **8 letters and numbers** — `MEE 313`, `MEE313` and `ABCD 1234` are fine,
  `ABCDE 1234` and `MEE-313` are not;
- a **course title** and a **department name** are written in words and may not
  contain numbers. Ordinary punctuation is allowed, because real titles carry
  it — `CAD/CAM Laboratory`, `Logic, Philosophy and Human Existence`,
  `B.Eng. Project`;
- a **unit load** is a whole number from 1 to 30;
- the **same course twice in one semester** is refused, with a pointer to repeat
  sittings, which is the right way to record a resit.

Anything questionable but legitimate — an unusual-looking code, a missing title
— is accepted with a note rather than blocked.

**Editing keeps grades.** A course carries a permanent id from the moment it is
created, so correcting its code, title or unit load never disturbs the grades
recorded against it. Correcting a unit load applies it to every sitting.
Removing a course removes its grades with it, since a grade with no course on
screen to explain it would sit in the GPA unaccountably.

---

## Repeat sittings

A course is repeated only after it is **failed**. Once it is passed it cannot be
taken again, so a sequence of sittings always ends at the first pass. **E is a
pass**; only F requires a re-sit.

Every sitting counts separately:

```
numerator   += units × gradePoint     for each sitting
denominator += units                  for each sitting
```

So a failed sitting puts its units into the denominator while adding nothing to
the numerator, and each further failure degrades the GPA again. A repeated
course behaves exactly as though another course of the same size had been added
to the programme — there is a test asserting that equivalence directly.

**The allowance.** A course first taken in year *x* may be repeated in each
remaining year up to the maximum the student sets, giving `(max − x)` repeats
and `(max − x + 1)` sittings. A five-year programme with eight years allowed
gives a first-year course 8 sittings and a final-year course 4; the default of
four years with seven allowed gives 7 and 4. With no maximum set, a ceiling of
12 applies rather than an unbounded list of grade boxes.

An **I repeated a course** checkbox in the toolbar turns on a grade box per
sitting. It is off by default and switches itself on for anyone who already has
repeats recorded, because hiding sittings that are counting towards the GPA
would make the figures impossible to explain.

**One record per course, and only one.** Exactly one stored form represents any
given record: a blank or invalid entry is not a sitting and is never stored, the
list stops at the allowance, and it stops at the first pass. Every write goes
through that canonical form, so re-recording a result — an `F` included — can
never append a second copy of it. Anything loaded or imported is canonicalised
on the way in, so an untidy record is repaired once rather than carried around.

---

## PDF statement of result

Alongside the JSON export — which is unchanged — an **Export as PDF** button
produces a sessional statement of result, laid out like the one the Department
of Mechanical Engineering issues.

The top **62.7 mm of the page is left blank** so the sheet can be printed on
pre-printed University letterhead. That figure is measured, not estimated: the
reference statement was rendered at 150 dpi, its letterhead's ink ends at
50.5 mm, and the "To:" line begins at 62.7 mm. Course rows are set at the
reference's 4.6 mm pitch, which is what lets a full session sit on one sheet.

The statement is produced through the browser's own print dialogue rather than
by a PDF library. Printing onto headed paper is the primary use, "Save as PDF"
is the same dialogue, and it keeps a 350 kB dependency out of an application
that also ships as one offline file. A preview shows the sheet first, with the
reserved band tinted so it is clearly meant to be empty.

**Your course codes and titles are printed exactly as you wrote them.** The
course list is yours, so nothing is re-cased or reworded on the way to the page.

**The form** collects the first, middle and surname — printed as
`SURNAME, Firstname Middlename` — a registration number validated as a
four-digit year, a slash and six or seven digits, the year of study, the gender
and the session, written `2023/2024` and never `2023/24`. The Head of Department
is entered too, since the office changes hands: a title, an optional second
title where the first is `Engr.`, up to three initials and a surname, printed as
`Prof. C. U. Anyanwu`.

**The year of study follows your own programme.** It reads `3/5` on a five-year
course and `2/7` on a seven-year one such as Medicine, and runs as far as the
maximum years you set — so a Medicine student with ten years allowed can reach
`10/7`. The denominator is always the length of the programme, never the year
reached.

**Courses are ticked, never assumed.** The picker lists only courses already
graded, grouped by semester and opening on the year being reported, everything
unticked.

**The figures.** The GPA is the session's; the **CGPA is cumulative**, covering
every result entered for that year and the years before it. A statement is
refused until every earlier year is complete, because a cumulative figure with
results missing is misleading; the block names each incomplete year and the
courses still missing.

The typed details are remembered for next time, with the display preferences,
never with the results and never in an export.

`npm run mockup <url> <out.pdf>` prints a specimen statement to a real PDF, for
checking the layout.

## Reporting precision

GPA figures show two decimal places. A **Show full precision** checkbox switches
every GPA on the page to five places instead.

This is display only: the GPA is always computed at full precision from integer
quality points and integer units, so more places reveal digits that were already
there. The degree classification always uses the two-decimal figure, whatever
the switch is set to, so it can never move a student between classes.

---

## Your saved work

Everything is kept in this browser's `localStorage` under a single key,
`unn-gpa-calculator`:

```json
{
  "schema_version": 1,
  "saved_at": "2026-09-19T...",
  "profile": { "department": "Physics", "programme": "B.Sc. Physics", "minYears": 4, "maxYears": 7 },
  "courses": [ { "id": "c_9f3a...", "code": "PHY 101", "title": "General Physics I",
                 "department": "Physics", "units": 3, "year": 1, "semester": 1, "createdAt": "..." } ],
  "grades":  { "c_9f3a...": "A" },
  "repeats": { "c_2b71...": ["F", "C"] }
}
```

Courses are an ordered list the student owns, but every one carries a permanent
id and is addressed by it. Grades and repeats are objects keyed by that id, so
every write is an upsert: saving repeatedly can never append a duplicate course,
grade or sitting. The tests assert that by saving the same state thirty times
and checking the record is unchanged, and by confirming a load/save cycle is a
fixed point.

**What repetition cannot do.** `npm run smoke:idempotency` drives a real browser
through every way a record might grow and checks that none of them does:
submitting the add-course form eight times in one burst adds one course;
re-recording the same grade, or the same failed sitting, changes nothing;
four reloads leave the stored record byte-identical; saving the same edit five
times adds no course and keeps the course's id, so its grades survive; and
importing the same file twice gives the same list rather than twice as much.
Removing a course and adding it back gives a genuinely new course with no grade
carried over from the old one.

Anything read back is repaired rather than trusted: a course with no id or no
usable unit load is discarded, a grade for a course that is not in the list is
dropped, and a profile with nonsense in it falls back to the defaults.

**Export / Import / Reset** are in the top-right. An export is a portable JSON
file carrying the profile, the full course list, every grade and every sitting,
plus a readable `course_records` block listing each course's sittings in order
with the units and quality points it contributed. That is how a student moves
their work to another browser, phone or laptop.

---

## Privacy

No name, registration number, email or password is asked for or stored. There is
no account, no analytics and no network call of any kind — `npm run smoke:offline`
asserts the page loads zero external resources. Nothing leaves the browser it was
typed into unless the student exports it deliberately.

---

## Project structure

```
unn-gpa/
├── index.html                      the page
├── serve.sh                        local server; prints the LAN address too
├── manifest.webmanifest, icon.svg  "Add to Home screen" on phones
│
├── src/
│   ├── grading.js                  the grade scale and the course-point rule
│   ├── catalogue.js                the student's own course list, and its checks
│   ├── gpa-engine.js               the GPA calculation — pure, no DOM, no storage
│   ├── transcript.js               the statement of result: formatting, rules, figures
│   ├── transcript-ui.js            the statement form, preview and printing
│   ├── storage.js                  persistence behind an async repository interface
│   ├── ui.js                       presentation only
│   └── styles.css                  desktop layout + phone card layout
│
├── tests/
│   ├── gpa-engine.test.mjs         the calculation rules
│   ├── catalogue.test.mjs          adding, amending, removing, validation
│   └── storage.test.mjs            persistence and idempotency
│
├── tools/
│   ├── build-single-file.mjs       the offline single-file build
│   ├── browser-smoke.mjs           end-to-end test in real Firefox
│   ├── transcript-smoke.mjs        end-to-end checks for the PDF statement
│   ├── mockup-statement.mjs        prints a specimen statement to a real PDF
│   ├── idempotency-smoke.mjs       checks that no repetition makes the record grow
│   ├── mobile-smoke.mjs            phone-viewport layout checks
│   └── file-url-smoke.mjs          offline-copy checks
│
└── dist/
    └── unn-gpa-calculator.html     generated: the whole thing in one file
```

The layers are separated so that the grading rules, the course list, the
calculation and the storage can each change without disturbing the others.
`src/ui.js` contains no arithmetic; `src/gpa-engine.js` contains no DOM and
cannot tell a first-year course from a final-year one.

---

## On phones

Verified at three viewports in Firefox — 375×667, 390×844 and 768×1024 — for
layout, tap targets, overflow and live recalculation, and on an insecure
`http://` LAN address and a `file://` copy, which is where mobile browsers
differ most from a desktop over HTTPS.

Two mobile-specific hazards are handled explicitly:

- **`crypto.randomUUID` exists only in a secure context.** It is absent over
  plain http (a phone opening the LAN address), from a `file://` copy, and on
  iOS Safari before 15.4. Course ids fall back to `crypto.getRandomValues`, and
  then to a clock-plus-counter, because ids that collided would be worse than
  useless: the storage layer de-duplicates by id, so a second course sharing one
  would silently vanish.
- **The Add course button is inert until the interface is wired.** On a slow
  connection the form markup arrives before the script does, and a tap in that
  window would otherwise submit the form natively and reload the page with
  nothing saved.


Below 760px each course becomes a card — code, department and title above, then
the unit load, grade point and course point labelled beneath, with the grade
selector on the right at a comfortable tap target and 16px text so mobile Safari
and Chrome do not zoom on focus. The running GPA stays pinned to the top while
scrolling. `npm run smoke:mobile` checks all of this at 375×667, 390×844 and
768×1024, including that nothing overflows the viewport.

---

## Relationship to the Mechanical Engineering calculator

This is the same engine, generalised. The Mechanical Engineering calculator ships
a fixed, validated curriculum of 103 courses taken from the departmental
documents, so its students never type a course code. This one asks every student
to enter their own courses, which makes it usable by any department at the cost
of putting the accuracy of the course list in the student's hands.

Mechanical Engineering students are better served by the dedicated calculator.
Everyone else should use this one.

The two keep their results separately — different storage keys, and an export
from one is refused by the other with a clear message rather than being
half-understood.
