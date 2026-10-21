#!/usr/bin/env node

/**
 * Standalone script (spawned as a child process by routes/api.js), run once per requested job
 * index — in parallel, batched (see routes/api.js) — that picks the jobIndex-th job on an
 * already-known jobup.ch results page, reads (or runs, if not already run before) the AI
 * CV-match analysis for it, and reports the analysis text.
 *
 * This used to also handle login and the job search itself; that's now scripts/jobup-search.js,
 * run once per POST /api/cv-match request before any of these per-job workers are spawned — see
 * its own header comment and CLAUDE.md's "jobup.ch CV-match automation" section for the full
 * split and why. This file picks up exactly where that one left off: an already-resolved results
 * URL (with any search term/location filtering already applied) and a saved Playwright
 * `storageState` file (cookies + localStorage) so this worker's own fresh browser starts already
 * logged in, without repeating the login UI flow.
 *
 * Reads `resultsUrl`, `storageStatePath`, and the 1-based job index to select from
 * `process.argv[2..4]`, and the save/apply job filters from `process.argv[5..7]`
 * (`[resultsUrl, storageStatePath, jobIndex, saveJob, easyApply, ignoreYellowMeter]`). If the
 * index is not a positive integer (errorMessage: "Job index must be a positive integer") or
 * exceeds the number of jobs actually found on its target page (errorMessage: "Job index must
 * not be greater than the number of jobs found on that page"), returns success: false without
 * attempting an analysis. jobup.ch paginates results at JOBS_PER_PAGE (20) per page, so an index
 * beyond the first page navigates there first — see the pagination gotcha in this file's own
 * comments below for how, and its one still-unverified piece. Once the analysis text is
 * available, POSTs it as { analysis, meter, criteria } to `${BACKEND_URL}/api/cv-analysis`
 * (BACKEND_URL defaults to http://localhost:3000) before dismissing the result dialog. `meter`
 * ({ color: 'green'|'yellow'| null, percent: number|null }) and `criteria`
 * ([{ text: string, status: 'green'|'yellow'|'gray' }]) are read straight from the DOM (icon/fill
 * color, not text) via extractAnalysisStructure() — see its comment for how, since none of that
 * survives a plain innerText() read. Prints a single JSON line to stdout:
 * {"jobIndex": number, "success": true|false, "analysis": string|null, "meter": object|null,
 * "criteria": array, "jobUrl": string|null, "errorMessage": string|null,
 * "applicationUrl": string|null}. `jobUrl` is the selected job's own detail-page URL
 * (https://www.jobup.ch/fr/emplois/detail/...), read from the job link's `href` before clicking
 * it — jobup.ch renders the job detail in place rather than navigating there, so the browser's own
 * URL after the click is still the search results page, not the job. `errorMessage` is non-null
 * only for the two specific, expected failures above, meant to be shown to the user as-is (or, for
 * the "not greater than" one specifically, used by routes/api.js to decide whether an
 * out-of-range job index should fail the whole request — the Start of the range — or just be
 * silently dropped from the results — every other index in the range); `null` on every other path,
 * including genuinely unexpected errors.
 *
 * If the analysis's meter is present at all (green *or* yellow — only its absence, the "Vos
 * talents correspondent mieux à d'autres opportunités" heading, skips this outright),
 * prepareJobApplicationDraft() saves the job ("Sauvegarder") when `saveJob` is true and, when
 * `easyApply` is true and "Candidature simplifiée"/"Continuer ma candidature" is available on the
 * job page, opens it — in a new tab, handled via the same BrowserContext.waitForEvent('page'), no
 * separate script/browser needed — and prepares (never submits) a draft application there:
 * generates a cover letter via "Générer" if the field is required and empty, attaches
 * REQUIRED_DOCUMENT_NAMES from the profile if not already present, answers every yes/no question
 * "Oui", then clicks "Sauvegarder" on the application itself. `ignoreYellowMeter`, when true,
 * additionally skips both actions entirely for a yellow meter (only green then qualifies); when
 * false (the default), both green and yellow are treated the same. `saveJob`/`easyApply` gate
 * their two actions independently — either, both, or neither can be enabled. `applicationUrl` is
 * that opened draft application page's own URL (e.g.
 * https://www.jobup.ch/fr/application/create/<uuid>/), captured right after the new tab loads, so
 * the caller can link straight back to the in-progress draft — `null` whenever no draft page was
 * ever opened (easyApply off, no meter, no applicable button, an error, etc.), same convention as
 * `jobUrl`. None of this — nor the meter/criteria extraction it depends on — has been verified
 * against the live site (no jobup.ch session was available in this environment); a failure here is
 * logged and swallowed rather than failing the run, since the analysis itself already succeeded by
 * that point. Diagnostic output goes to stderr so stdout stays parseable.
 */

const { chromium } = require('playwright');
const { dismissCookieConsent } = require('./jobup-login');
const { JOBS_PER_PAGE, dedupeByHref, waitForJobResults } = require('./jobup-shared');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

// Set right after chromium.launch() succeeds, cleared once browser.close() has run — lets the
// SIGTERM/SIGINT handlers below close the browser on the way out instead of leaving it orphaned
// when routes/api.js's POST /cv-match/stop kills this process early (see killProcessTree() there).
// This is a best-effort backstop, not the primary cleanup mechanism: on Windows, Node's signal
// support for SIGTERM is unreliable (per Node's own docs, unlike POSIX platforms) — that's exactly
// why the stop endpoint also runs `taskkill /T /F` unconditionally, which guarantees the whole
// process tree (this process and anything it spawned) is gone even if this handler never fires.
let activeBrowser = null;

async function closeActiveBrowserAndExit(signal) {
  console.error('received ' + signal + '; closing the browser before exiting.');
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
  }
  process.exit(1);
}
process.on('SIGTERM', () => { closeActiveBrowserAndExit('SIGTERM'); });
process.on('SIGINT', () => { closeActiveBrowserAndExit('SIGINT'); });

// The three profile documents attached to a draft application whenever prepareJobApplicationDraft()
// runs (see its comment) — skipped individually if already present as a link on the application
// page. Exact filenames as they appear in the jobup.ch profile's document picker.
const REQUIRED_DOCUMENT_NAMES = [
  'Certificat de travail L HERAULT 2026.04.pdf',
  'Diplôme Bachelor 2020.pdf',
  'LR-ITADV.pdf'
];

async function sendAnalysisToBackend(analysis, meter, criteria) {
  const response = await fetch(BACKEND_URL + '/api/cv-analysis', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ analysis, meter, criteria }),
  });

  if (!response.ok) {
    throw new Error('Backend responded with ' + response.status + ' while posting CV analysis');
  }
}

// Reads the analysis modal's per-criterion status icons and overall match meter, none of which
// survive a plain .innerText() read (they're conveyed only by icon/fill color, not text). Derived
// from a user-supplied live DOM dump of the modal rather than a run of this script itself (no
// jobup.ch session was available to verify it end-to-end the usual way — see the file header) —
// if these ever stop matching, re-derive them the documented way: dump `.icon--iconSize_sm` class
// values and "bg_yellow"/"bg_green" candidate classes via the criteria.length === 0 / meter === null
// diagnostics in readAnalysisAndClose() below, or a fresh live DOM dump.
//
// Status icons: each criterion row has one `<span class="c_green.400 ... icon icon--iconSize_sm">`
// (met), `c_yellow.300` (partially met) or `c_gray.700` (not met) wrapping a decorative
// (aria-hidden, textless) SVG — so the icon's own parent element's innerText is exactly that row's
// title (plus its explanation line, if jobup's AI gave one), with no icon noise mixed in.
//
// Meter: one colored fill div (originally seen nested in a "bg_gray.200" gray track div) whose own
// class gives both the overall-match color ("bg_green..." / "bg_yellow...") and its width as a
// Panda-CSS fraction token (e.g. "w_1/3") or arbitrary-value token (e.g. "w_[45%]") — found by
// searching the fill's own class directly (see the comment on the search below for why, having
// first shipped a version that went via the track and silently failed live).
async function extractAnalysisStructure(analysisDialog) {
  return analysisDialog.evaluate((root) => {
    function classifyStatus(cls) {
      if (!cls) return null;
      if (cls.includes('c_green')) return 'green';
      if (cls.includes('c_yellow')) return 'yellow';
      if (cls.includes('c_gray')) return 'gray';
      return null;
    }

    function parseWidthPercent(cls) {
      const fraction = cls.match(/w_(\d+)\/(\d+)/);
      if (fraction) {
        return Math.round((Number(fraction[1]) / Number(fraction[2])) * 100);
      }
      const arbitrary = cls.match(/w_\[(\d+(?:\.\d+)?)%?\]/);
      if (arbitrary) {
        return Math.round(Number(arbitrary[1]));
      }
      return null;
    }

    // Searches directly for the *fill* div (its own class carries both the color and the width),
    // rather than first locating a "bg_gray.200" track ancestor — the modal can contain other
    // bg_gray.200-classed elements for unrelated purposes, and querySelector() would silently
    // grab the wrong one (yielding a false-negative null meter) if one of those happens to sit
    // earlier in the DOM. A "bg_green.../bg_yellow..." element that also carries a parseable width
    // token is specific enough to the meter fill to not need the track as a scoping step at all.
    let meter = null;
    for (const candidate of root.querySelectorAll('[class*="bg_yellow"], [class*="bg_green"]')) {
      const cls = candidate.getAttribute('class') || '';
      const percent = parseWidthPercent(cls);
      if (percent === null) continue;
      const color = cls.includes('bg_green') ? 'green' : cls.includes('bg_yellow') ? 'yellow' : null;
      meter = { color, percent };
      break;
    }

    const criteria = [];
    for (const icon of root.querySelectorAll('.icon--iconSize_sm')) {
      const status = classifyStatus(icon.getAttribute('class') || '');
      if (!status) continue;
      let row = icon.parentElement;
      let text = row ? row.innerText.trim() : '';
      let hops = 0;
      while (row && !text && hops < 3) {
        row = row.parentElement;
        text = row ? row.innerText.trim() : '';
        hops++;
      }
      if (text) {
        criteria.push({ text, status });
      }
    }

    return { meter, criteria };
  });
}

// Reads the analysis dialog's text, posts it to the backend, and dismisses it via "Fermer".
// Shared by both the "already analyzed" and "run a new analysis" paths below. Confirmed live: a
// plain `getByRole('dialog')` is ambiguous (Playwright strict-mode violation) — the "estimation in
// progress" placeholder (`data-cy="jobfit-pending-modal"`) and the actual result
// (`data-cy="jobfit-analysis-modal"`) both stay mounted as `<dialog>` elements at once, so this
// targets the result modal by its `data-cy` specifically.
async function readAnalysisAndClose(page, waitTimeout) {
  const analysisDialog = page.locator('[data-cy="jobfit-analysis-modal"]');
  const closeButton = analysisDialog.getByRole('button', { name: /fermer/i });
  await closeButton.waitFor({ state: 'visible', timeout: waitTimeout });

  // Confirmed live (user-reported, jobIndex 6): a weaker match can render a tabbed layout instead
  // of going straight to this job's own checklist — a "Résultat" tab (`data-cy="tab-results"`,
  // `role="tab"`) alongside other tabs (e.g. an "Emplois recommandés" alternatives widget). The
  // read below must reflect this job's own Résultat tab, not whichever tab the modal happens to
  // land on by default — click it first if present (idempotent if it's already the active tab).
  // Unverified live in isolation (built directly from the user's own report + DOM snippet, not a
  // full round trip of this exact fix) — dump the dialog's tab-area markup if this ever mismatches.
  const resultsTab = analysisDialog.locator('[data-cy="tab-results"]:visible');
  if ((await resultsTab.count()) > 0) {
    try {
      await resultsTab.first().click();
      await page.waitForTimeout(300);
    } catch (tabClickErr) {
      console.error('found a "Résultat" tab but failed to click it: ' + tabClickErr.message);
    }
  }

  const analysis = (await analysisDialog.innerText()).trim();
  const { meter, criteria } = await extractAnalysisStructure(analysisDialog);

  if (criteria.length === 0) {
    const iconClasses = await analysisDialog
      .locator('.icon--iconSize_sm')
      .evaluateAll((els) => els.slice(0, 10).map((el) => el.getAttribute('class')));
    console.error(
      'extractAnalysisStructure() found 0 criteria; status-icon classes seen:',
      JSON.stringify(iconClasses)
    );
  }
  if (!meter) {
    const meterCandidateClasses = await analysisDialog
      .locator('[class*="bg_yellow"], [class*="bg_green"], [class*="bg_gray.200"]')
      .evaluateAll((els) => els.slice(0, 10).map((el) => el.getAttribute('class')));
    console.error(
      'extractAnalysisStructure() found no meter; candidate classes seen:',
      JSON.stringify(meterCandidateClasses)
    );
  }

  await sendAnalysisToBackend(analysis, meter, criteria);

  await closeButton.click();

  return { analysis, meter, criteria };
}

// If the cover-letter field is present, required (an errorMain-colored "*" span somewhere near its
// label), and still empty, clicks "Générer" to have jobup.ch generate one. Left untouched if it's
// not required or already has content. None of this has been verified live (see the header comment
// and prepareJobApplicationDraft()'s comment) — the required-marker class
// (`c_colorPalette.errorMain`) and label text come from a user-supplied live DOM snippet, but the
// walk from label to marker/textarea is a best-effort guess at the surrounding structure. Every
// `.first()` below is scoped `.and(applicationPage.locator(':visible'))` — confirmed live elsewhere
// on this page (the job-page "Sauvegarder" button) that jobup.ch duplicates markup (even a whole
// duplicated `id`) for responsive mobile/desktop layouts and hides one copy via an ancestor, which
// `.first()` alone can't tell apart from the real, on-screen one.
async function generateCoverLetterIfNeeded(applicationPage) {
  const visible = applicationPage.locator(':visible');
  const label = applicationPage
    .getByText('Écrivez votre lettre de motivation ici', { exact: false })
    .and(visible)
    .first();
  const labelVisible = await label.isVisible({ timeout: 10000 }).catch(() => false);
  if (!labelVisible) {
    console.error('cover-letter label not found on the application page; skipping.');
    return;
  }

  // Walk up from the label a few levels looking for both the required-marker span and the actual
  // text field, since the exact DOM depth between them isn't known — stop as soon as either is
  // found, or after a handful of hops. Confirmed live this over-matched at 6 hops: a cover letter
  // that visibly has no asterisk still got treated as required, because by the 5th/6th hop the
  // container had grown large enough to also contain some *other*, unrelated field's own required
  // marker elsewhere on the form. Cut down to 2 hops — a real miss (field genuinely required but
  // the marker sits further away structurally) is the safer failure mode here than generating an
  // unwanted cover letter, and the diagnostic dump below shows exactly what was found if this
  // still needs recalibrating.
  let container = label;
  let isRequired = false;
  let hasExistingText = false;
  let matchedMarkerHtml = null;
  let fieldLocator = null;
  for (let hops = 0; hops < 2; hops++) {
    container = container.locator('xpath=..');
    const markers = container.locator('[class~="c_colorPalette.errorMain"]').and(visible);
    isRequired = (await markers.count()) > 0;
    if (isRequired && !matchedMarkerHtml) {
      matchedMarkerHtml = await markers.first().evaluate((el) => el.outerHTML).catch(() => null);
    }
    const field = container.locator('textarea, [contenteditable="true"]').and(visible).first();
    if (await field.isVisible().catch(() => false)) {
      fieldLocator = field;
      const value =
        (await field.inputValue().catch(() => null)) ?? (await field.textContent().catch(() => ''));
      hasExistingText = !!(value && value.trim());
    }
    if (isRequired || hasExistingText) {
      break;
    }
  }

  if (!isRequired) {
    // Not required — but if it already has content (e.g. left over from an earlier, possibly
    // over-eager run — see the false-positive-required gotcha this same function used to have),
    // clear it too, so an optional cover letter is only ever present when actually meant to be.
    if (hasExistingText && fieldLocator) {
      await clearCoverLetterField(fieldLocator);
    } else {
      console.error('cover-letter field is not marked required; leaving it as-is.');
    }
    return;
  }
  console.error(
    'cover-letter field detected as required; marker found:',
    matchedMarkerHtml
  );
  if (hasExistingText) {
    console.error('cover letter already has content; not regenerating.');
    return;
  }

  // The 2-hop walk above can stop at the required marker before reaching the field itself, so look
  // a little further for the field alone — needed to tell when generation has finished. Widening
  // this is safe in a way widening the marker search wasn't: it only reads the field, it never
  // decides whether to generate.
  if (!fieldLocator) {
    for (let hops = 2; hops < 5 && !fieldLocator; hops++) {
      container = container.locator('xpath=..');
      const field = container.locator('textarea, [contenteditable="true"]').and(visible).first();
      if (await field.isVisible().catch(() => false)) {
        fieldLocator = field;
      }
    }
  }

  const generateButton = applicationPage.getByRole('button', { name: /générer/i }).and(visible);
  if (await generateButton.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await generateButton.first().click();
    console.error('clicked "Générer" for the cover letter.');
    // Not awaited here: generation runs while the documents/questions are handled, and
    // fillApplicationDraft() waits for it via waitForCoverLetterText() right before saving.
    return { fieldLocator };
  }
  console.error('cover-letter field is required but no "Générer" button was found.');
  return null;
}

function readCoverLetterText(fieldLocator) {
  return fieldLocator
    .evaluate((el) => (el.tagName === 'TEXTAREA' ? el.value : el.textContent) || '')
    .catch(() => '');
}

// Confirmed live on jobs.ch: a draft saved a few seconds after clicking "Générer" (the old flat 5s
// wait, plus however long the documents took) came back with an empty cover letter — generation
// hadn't finished, so the save didn't include it. Polls the field until it holds text that has
// stopped changing for STABLE_MS (generation may stream text in progressively), up to TIMEOUT_MS.
// Returns whether a stable, non-empty letter was seen; never throws.
async function waitForCoverLetterText(applicationPage, fieldLocator) {
  const TIMEOUT_MS = 90000;
  const STABLE_MS = 3000;
  const POLL_MS = 500;
  if (!fieldLocator) {
    console.error(
      'cover-letter field element not found, so generation completion cannot be checked; ' +
        `waiting a flat ${STABLE_MS * 5}ms instead.`
    );
    await applicationPage.waitForTimeout(STABLE_MS * 5);
    return false;
  }
  const start = Date.now();
  let lastText = '';
  let lastChange = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const text = (await readCoverLetterText(fieldLocator)).trim();
    if (text !== lastText) {
      lastText = text;
      lastChange = Date.now();
    } else if (text && Date.now() - lastChange >= STABLE_MS) {
      console.error(
        `cover letter generated (${text.length} chars, ${Math.round((Date.now() - start) / 1000)}s after the check started).`
      );
      return true;
    }
    await applicationPage.waitForTimeout(POLL_MS);
  }
  console.error(
    `cover letter still ${lastText ? 'changing' : 'empty'} after ${TIMEOUT_MS / 1000}s; saving the draft anyway.`
  );
  return false;
}

// Empties a cover-letter field found to hold leftover content when the field turned out to be
// optional. `<textarea>` supports .fill(''); a contenteditable div does not, so it's cleared via
// direct DOM manipulation plus a dispatched 'input' event (the framework listens for that event,
// not a value/property mutation, to notice the change — the same reasoning as elsewhere in this
// script where a UI event, not a raw property write, is what the page actually reacts to).
async function clearCoverLetterField(fieldLocator) {
  const tagName = await fieldLocator.evaluate((el) => el.tagName).catch(() => null);
  try {
    if (tagName === 'TEXTAREA') {
      await fieldLocator.fill('');
    } else {
      await fieldLocator.evaluate((el) => {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    console.error('cover-letter field was optional but had leftover content; cleared it.');
  } catch (err) {
    console.error('failed to clear leftover cover-letter content:', err.message);
  }
}

// Confirmed live (two real matches, one genuine and one false positive): a genuinely attached
// document's filename renders as a real `<a href="https://media.jobs.ch/...">` download link, while
// a still-open "Sélectionner depuis le profil" picker's file options render as plain, href-less
// `<span class="c_link...">` elements sharing the same link-styled classes — text-alone matching
// can't tell them apart, but the presence of a real `href` on an `<a>` ancestor can. Walks up to 4
// hops from the matched text looking for that anchor.
async function isRealAttachedDocumentLink(locator) {
  return locator
    .first()
    .evaluate((el) => {
      let node = el;
      for (let hop = 0; hop < 4 && node; hop++) {
        if (node.tagName === 'A' && node.getAttribute('href')) {
          return true;
        }
        node = node.parentElement;
      }
      return false;
    })
    .catch(() => false);
}

// Attaches each of REQUIRED_DOCUMENT_NAMES via "Ajouter d'autres documents" → "Sélectionner depuis
// le profil" → the matching filename → "Ajouter", skipping any filename already present as a link
// on the page. Repeats the whole click sequence per file, per the user's spec. Unverified live —
// the "Sélectionner depuis le profil" text/class comes from a user-supplied snippet, everything
// else (button labels) is a best guess pending a real run's diagnostics.
async function attachMissingDocuments(applicationPage) {
  const visible = applicationPage.locator(':visible');
  for (const fileName of REQUIRED_DOCUMENT_NAMES) {
    const textMatchLocator = applicationPage.getByText(fileName, { exact: true }).and(visible);
    const textMatched = await textMatchLocator.first().isVisible().catch(() => false);
    const alreadyAttached = textMatched && (await isRealAttachedDocumentLink(textMatchLocator));
    if (alreadyAttached) {
      const matchedHtml = await textMatchLocator
        .first()
        .evaluate((el) => (el.closest('[class]') || el).outerHTML.slice(0, 300))
        .catch(() => null);
      console.error(
        '"' + fileName + '" matched as already attached (real document link); skipping. ' +
          'Matched element context:',
        matchedHtml
      );
      continue;
    }
    if (textMatched) {
      // Confirmed live: text matched somewhere on the page (e.g. a leftover, still-open
      // "Sélectionner depuis le profil" picker option) but it isn't a real attached-document link —
      // don't skip; proceed to attach it for real. Dumped for visibility since this previously
      // caused a silent false "already attached" skip.
      const matchedTag = await textMatchLocator.first().evaluate((el) => el.tagName).catch(() => null);
      console.error(
        '"' + fileName + '" text matched (tag: ' + matchedTag + ') but is not a real ' +
          'attached-document link; proceeding to attach it.'
      );
    }

    const addDocsButton = applicationPage.getByRole('button', { name: /ajouter d.autres documents/i }).and(visible);
    if (!(await addDocsButton.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error(
        '"Ajouter d\'autres documents" button not found; cannot attach "' + fileName + '".'
      );
      continue;
    }
    await addDocsButton.first().click();

    const selectFromProfile = applicationPage.getByText('Sélectionner depuis le profil', { exact: true }).and(visible);
    if (!(await selectFromProfile.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error('"Sélectionner depuis le profil" not found for "' + fileName + '".');
      continue;
    }
    await selectFromProfile.first().click();

    const fileOption = applicationPage.getByText(fileName, { exact: true }).and(visible);
    if (!(await fileOption.first().isVisible({ timeout: 10000 }).catch(() => false))) {
      console.error('file option "' + fileName + '" not found in the profile picker.');
      continue;
    }
    await fileOption.first().click();

    // Left anchored (unlike the job-page "Sauvegarder" fix above) rather than relaxed to
    // /ajouter/i: "Ajouter d'autres documents" (a different, already-clicked button) is plausibly
    // still visible in the same panel at this point, and an unanchored match risks .first()
    // grabbing *that* one instead of this confirm button — a worse bug than the one it'd fix. If
    // this exact-match ever turns out to miss the same way "Sauvegarder" did (an aria-label
    // overriding "Ajouter"), the diagnostics below say exactly what's there instead of guessing.
    const confirmAddButton = applicationPage.getByRole('button', { name: /^ajouter$/i }).and(visible);
    if (await confirmAddButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
      await confirmAddButton.first().click();
      console.error('attached "' + fileName + '".');
      // Confirmed live (root cause of the false "already attached" positives above, now resolved
      // with the href-based check): the picker's actual file-list panel can stay open after
      // "Ajouter" even once `selectFromProfile` (the *menu-item label* that opened it, not the
      // panel itself) reports hidden — waiting on that label alone isn't a reliable close signal, it
      // was just closing itself as a one-off menu entry. Kept as an informational wait, but backed
      // up with an unconditional Escape keypress right after, a generic and low-risk way to force-
      // close any lingering picker/modal regardless of its concrete DOM structure.
      await selectFromProfile
        .first()
        .waitFor({ state: 'hidden', timeout: 5000 })
        .catch(() =>
          console.error(
            '"Sélectionner depuis le profil" picker label did not report hidden within ' +
              '5s after attaching "' + fileName + '".'
          )
        );
      await applicationPage.keyboard.press('Escape').catch(() => {});
    } else {
      const buttonInfo = await applicationPage.getByRole('button').evaluateAll((els) =>
        els.slice(0, 30).map((el) => ({
          text: el.textContent?.trim().slice(0, 60),
          ariaLabel: el.getAttribute('aria-label')
        }))
      );
      console.error(
        '"Ajouter" confirm button not found for "' + fileName + '". Visible buttons:',
        JSON.stringify(buttonInfo)
      );
    }
  }
}

// Best-effort read of a toggle-like element's selected state via aria-pressed/aria-checked/
// aria-selected, checked on the element itself and up to 2 ancestors (jobup.ch's actual
// selected-state convention for these Yes/No options is unconfirmed live — this mirrors the
// aria-pressed pattern already confirmed for the job-page bookmark button elsewhere in this
// script). Returns true/false when a definite answer is found, or null when unknown.
async function isOptionSelected(locator) {
  return locator
    .evaluate((el) => {
      let node = el;
      for (let hop = 0; hop < 3 && node; hop++) {
        if (node.getAttribute) {
          for (const attr of ['aria-pressed', 'aria-checked', 'aria-selected']) {
            const value = node.getAttribute(attr);
            if (value === 'true') return true;
            if (value === 'false') return false;
          }
        }
        node = node.parentElement;
      }
      return null;
    })
    .catch(() => null);
}

// Clicks every "Oui" option found on the page (one per required yes/no question) — always "Oui",
// per the user's explicit spec, regardless of what each question actually asks. Re-reads the count
// fresh (rather than snapshotting elements up front) since clicking one option can shift the DOM.
// Guards against re-clicking an "Oui" already detected as selected (which would risk toggling it
// back off), and makes a best-effort attempt to deselect a same-question "Non" first if one is
// found selected nearby. That "Non"-deselection part is speculative — unverified against jobup.ch's
// real markup for these questions (no live DOM evidence yet for a "Non" counterpart's structure or
// its container), so it's scoped to the option's own near ancestors only and never allowed to block
// selecting "Oui" if it can't cleanly find or click one.
async function answerYesNoQuestions(applicationPage) {
  const visible = applicationPage.locator(':visible');
  const ouiOptions = applicationPage.getByText('Oui', { exact: true }).and(visible);
  const count = await ouiOptions.count();
  console.error('found ' + count + ' "Oui" option(s) to select.');
  for (let i = 0; i < count; i++) {
    const ouiOption = ouiOptions.nth(i);
    try {
      const ouiSelected = await isOptionSelected(ouiOption);
      if (ouiSelected === true) {
        console.error('"Oui" option #' + (i + 1) + ' already selected; skipping.');
        continue;
      }

      let container = ouiOption;
      for (let hop = 0; hop < 2; hop++) {
        container = container.locator('xpath=..');
        const nonOption = container.getByText('Non', { exact: true }).and(visible).first();
        if (await nonOption.isVisible({ timeout: 1000 }).catch(() => false)) {
          const nonSelected = await isOptionSelected(nonOption);
          if (nonSelected === true) {
            try {
              await nonOption.click();
              console.error(
                'deselected "Non" for question #' + (i + 1) + ' before selecting "Oui".'
              );
            } catch (err) {
              console.error(
                'could not deselect "Non" for question #' + (i + 1) + ':',
                err.message
              );
            }
          }
          break;
        }
      }

      await ouiOption.click();
    } catch (err) {
      console.error('could not click "Oui" option #' + (i + 1) + ':', err.message);
    }
  }
}

// Runs the whole draft-preparation sequence on the "Candidature simplifiée"/"Continuer ma
// candidature" tab: generate the cover letter if needed, attach the three standard documents if
// missing, answer every yes/no question "Oui", then "Sauvegarder" — never the final submit button.
async function fillApplicationDraft(applicationPage) {
  const coverLetterGeneration = await generateCoverLetterIfNeeded(applicationPage);
  await attachMissingDocuments(applicationPage);
  await answerYesNoQuestions(applicationPage);
  if (coverLetterGeneration) {
    await waitForCoverLetterText(applicationPage, coverLetterGeneration.fieldLocator);
  }

  // Unanchored (not /^sauvegarder$/i): confirmed live on the job page's own "Sauvegarder" button
  // that jobup.ch gives these an `aria-label` overriding the visible text (e.g. "Sauvegarder
  // l'emploi"), which an anchored exact-match regex misses entirely — this button may carry a
  // similarly enriched label, not yet confirmed live either way.
  const saveButton = applicationPage
    .getByRole('button', { name: /sauvegarder/i })
    .and(applicationPage.locator(':visible'));
  if (await saveButton.first().isVisible({ timeout: 10000 }).catch(() => false)) {
    // The job-page "Sauvegarder" click turned out to need its confirmation checked via the actual
    // network response rather than any DOM attribute (see prepareJobApplicationDraft()'s comment —
    // aria-pressed on the element that was actually clicked didn't reliably reflect a real,
    // server-confirmed save). This save-draft button's real endpoint isn't known yet, so rather than
    // guess one, every POST/PUT response seen during and shortly after the click is captured and
    // logged — the same evidence-gathering approach that identified the bookmark endpoint — so the
    // real one can be targeted precisely once a live run shows it.
    const capturedRequests = [];
    const onResponse = (res) => {
      const method = res.request().method();
      if (method === 'POST' || method === 'PUT') {
        capturedRequests.push(method + ' ' + res.status() + ' ' + res.url());
      }
    };
    applicationPage.on('response', onResponse);
    await saveButton.first().click();
    await applicationPage.waitForTimeout(2000);
    applicationPage.off('response', onResponse);
    console.error(
      'clicked "Sauvegarder" to save the application draft (not submitted). ' +
        'POST/PUT requests observed:',
      JSON.stringify(capturedRequests)
    );
  } else {
    console.error('"Sauvegarder" button not found on the application page; draft may not be saved.');
  }
}

// When the CV-match meter is green (a strong match), this saves the job and, if "Candidature
// simplifiée"/"Continuer ma candidature" is available, opens it (in a new tab — the same
// BrowserContext.waitForEvent('page') mechanism works fine for this within the same script/browser,
// no separate automation needed) and prepares (but never submits) a draft application there via
// fillApplicationDraft(). Never throws — a failure here shouldn't invalidate an already-successful
// CV-match analysis, so every step is defensive and just logs on failure. None of this has been
// verified against the live site (no jobup.ch session was available in this environment) — if a
// selector here doesn't match, re-derive it the documented way: dump the live DOM/ariaSnapshot
// rather than guessing again.
// Returns the opened application draft page's URL (e.g.
// https://www.jobup.ch/fr/application/create/<uuid>/) when a draft was actually prepared there, so
// the caller can surface a link straight back to it — or null on every path where no draft page was
// ever opened (easyApply off, no applicable button, an error, etc.).
async function prepareJobApplicationDraft(page, meterColor, { saveJob, easyApply, ignoreYellowMeter }) {
  try {
    // Called whenever a meter is present at all (green or yellow) — see the caller for why a
    // missing meter ("Vos talents correspondent mieux à d'autres opportunités") skips this
    // function entirely. This first check handles the one remaining meter-based exclusion: yellow
    // specifically, only when the user has opted into treating it as not-good-enough.
    if (ignoreYellowMeter && meterColor === 'yellow') {
      console.error(
        'meter is yellow and "ignore yellow meter" is checked; not saving or applying.'
      );
      return null;
    }

    // Confirmed live (user-supplied DOM snippet): this button's accessible name is actually
    // "Sauvegarder l'emploi", not "Sauvegarder" — it carries an `aria-label` that overrides its
    // visible text entirely for accessibility purposes, so the previous anchored
    // `getByRole('button', { name: /^sauvegarder$/i })` matched nothing (that regex requires the
    // *whole* accessible name to equal "Sauvegarder", not just contain it). Targeted here by its
    // stable `id`/`data-cy` first instead, per this file's usual "prefer data-cy" convention, with
    // an unanchored name regex as a last-resort fallback. It's also a toggle
    // (`aria-pressed="false"`/`"true"`, `data-cy="bookmark-button-unchecked"` when off) — guarded
    // so a job that's already saved from a previous run doesn't get un-saved by clicking it again.
    //
    // Confirmed live (second round): `#vacancy-bookmark-cta-info` matches *two* elements with the
    // same id — jobup.ch's usual habit of duplicating markup for responsive mobile/desktop layouts
    // (seen elsewhere in this file for job cards/the filter bar), just with a literally duplicated
    // id this time rather than a duplicated class. One instance resolves to a 0×0 box (its own
    // computed style still says `display:flex`/`visibility:visible` — it's an *ancestor* that's
    // actually hidden) even though the *element itself* isn't marked hidden, so `.first()` on the
    // unfiltered locator silently grabbed that one and `isVisible()` correctly reported false. Every
    // candidate below is now scoped to `:visible` so only the real, on-screen instance matches.
    //
    // Confirmed live (third round): jobup.ch also has a *second*, unrelated bookmark control for
    // this exact job — a compact icon-only button (`id="vacancy-bookmark-icon-<jobId>"`,
    // `data-cy="bookmark-icon-unchecked"`, no visible text) that carries the *same*
    // `aria-label="Sauvegarder l'emploi"` as the intended `#vacancy-bookmark-cta-info` CTA. The
    // previous version combined both candidates with `.or()` — a union, not a priority order — so
    // `.first()` picked whichever of the two happened to come first in DOM order, non-deterministically
    // landing on the icon variant instead. Its click DID reach jobup.ch's server (confirmed live: the
    // resulting `POST /api/v1/user/bookmark/job` returned 200) — the save genuinely worked — but its
    // own `aria-pressed` apparently isn't kept in sync reactively, which is exactly why the previous
    // aria-pressed-polling confirmation kept reporting failure on an actual success. Fixed two ways:
    // (1) candidates are now tried in strict priority order (first visible one wins, not a union), so
    // the specific, confirmed-correct `#vacancy-bookmark-cta-info` is used whenever it's present at
    // all, and (2) success is confirmed via the actual `POST .../bookmark/job` response status — the
    // real, server-side ground truth — rather than trusting any particular button's DOM attribute.
    if (!saveJob) {
      console.error('"Save job" is unchecked; not clicking "Sauvegarder".');
    } else {
      let saveButton = null;
      for (const candidate of [
        page.locator('#vacancy-bookmark-cta-info:visible'),
        page.locator('[data-cy="bookmark-button-unchecked"]:visible, [data-cy="bookmark-button-checked"]:visible'),
        page.getByRole('button', { name: /sauvegarder/i }).and(page.locator(':visible'))
      ]) {
        if (await candidate.first().isVisible({ timeout: 5000 }).catch(() => false)) {
          saveButton = candidate.first();
          break;
        }
      }

      if (saveButton) {
        const alreadySaved = (await saveButton.getAttribute('aria-pressed').catch(() => null)) === 'true';
        if (alreadySaved) {
          console.error('job is already saved (aria-pressed="true"); not toggling it off.');
        } else {
          const [bookmarkResponse] = await Promise.all([
            page
              .waitForResponse(
                (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/user/bookmark/job'),
                { timeout: 8000 }
              )
              .catch(() => null),
            saveButton.click()
          ]);

          if (bookmarkResponse && bookmarkResponse.ok()) {
            console.error(
              'clicked "Sauvegarder" (save job) — confirmed via POST ' +
                '/api/v1/user/bookmark/job returning ' + bookmarkResponse.status() + '.'
            );
            // Small buffer past the confirmed response so any client-side state update it triggers has
            // time to settle before this run moves on.
            await page.waitForTimeout(500);
          } else {
            console.error(
              'clicked "Sauvegarder" but no successful POST to /api/v1/user/bookmark/job ' +
                'was observed within 8s' +
                (bookmarkResponse ? ' (got status ' + bookmarkResponse.status() + ')' : '') +
                ' — the save may not have registered.'
            );
          }
        }
      } else {
        console.error('"Sauvegarder" button not found/visible on the job page; skipping.');
      }
    }

    if (!easyApply) {
      console.error('"Easy apply" is unchecked; not preparing an application draft.');
      return null;
    }

    const applyButton = page
      .getByRole('button', { name: /candidature simplifiée|continuer ma candidature/i })
      .and(page.locator(':visible'));
    const applyButtonVisible = await applyButton.first().isVisible({ timeout: 10000 }).catch(() => false);
    if (!applyButtonVisible) {
      // Confirmed live: a job posted via an external/agency application flow (e.g. a staffing
      // agency) has no "Candidature simplifiée"/"Continuer ma candidature" button at all — its only
      // apply control is `[data-cy="apply-button-external"]` ("Postuler"), which redirects off
      // jobup.ch entirely. That's an expected, unsupported case (there's no on-site draft to
      // prepare), distinct from a genuinely missing/renamed button — logged differently so it's not
      // mistaken for a bug.
      const isExternalApply = await page
        .locator('[data-cy="apply-button-external"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (isExternalApply) {
        console.error(
          'this job only offers an external application ("Postuler", ' +
            'data-cy="apply-button-external") — no on-site "Candidature simplifiée" flow to prepare a draft in.'
        );
      } else {
        console.error(
          'no "Candidature simplifiée"/"Continuer ma candidature" button found; ' +
            'skipping application draft.'
        );
      }
      return null;
    }

    const [applicationPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 20000 }),
      applyButton.first().click()
    ]);
    await applicationPage.waitForLoadState('domcontentloaded');
    const applicationUrl = applicationPage.url();
    console.error('opened the application page in a new tab:', applicationUrl);

    try {
      await fillApplicationDraft(applicationPage);
    } finally {
      await applicationPage.close();
    }
    return applicationUrl;
  } catch (err) {
    console.error('error while preparing the application draft (analysis result is unaffected):', err);
    return null;
  }
}

// Selects the inPageIndex-th (1-based) job offer on the current results page, in the order the
// job cards actually appear on screen. Confirmed live on the direct-CTA search UI: no
// `role="article"` elements and no `a[href*="/emploi/"]` links exist, but each job card has
// `data-cy="job-link"`. But confirmed live too: some results-page variants use `role="article"`
// cards instead (zero `data-cy="job-link"` there) — which pattern is actually in play on *this*
// page is decided fresh each time this runs, not assumed from any earlier page.
//
// Locator/DOM order (what `.count()`/`.nth()` follow) isn't guaranteed to match a job's actual
// top-to-bottom position on the page — jobup.ch has no known position/index attribute to read this
// from directly, and its list could in principle virtualize or otherwise reorder cards in the DOM
// independent of visual layout — so this sorts the matched elements by their real on-screen
// position (bounding box) instead of trusting `.nth()`.
async function measureJobs(page, dataCyJobLinks, articleJobLinks, targetPage) {
  const dataCyElements = await dataCyJobLinks.all();
  const jobElements = dataCyElements.length > 0 ? dataCyElements : await articleJobLinks.all();
  const jobsWithPosition = await Promise.all(
    jobElements.map(async (el) => ({ el, box: await el.boundingBox(), href: await el.getAttribute('href') }))
  );
  const { deduped, duplicateHrefs } = dedupeByHref(
    jobsWithPosition
      .filter((j) => j.box !== null)
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  );
  if (duplicateHrefs.length > 0) {
    console.error(
      'found ' + duplicateHrefs.length + ' duplicate job-link element(s) on page ' +
        targetPage + ' (same href, different position — likely a promotional/recommended widget ' +
        'reusing the same data-cy) — deduped:',
      JSON.stringify(duplicateHrefs)
    );
  }
  return {
    usedArticleFallback: dataCyElements.length === 0,
    dropped: jobsWithPosition.filter((j) => j.box === null),
    sorted: deduped,
  };
}

async function runCvMatchJob(resultsUrl, storageStatePath, jobIndex, saveJob, easyApply, ignoreYellowMeter) {
  const browser = await chromium.launch();
  activeBrowser = browser;
  let page;
  try {
    // Loads the cookies/localStorage scripts/jobup-search.js saved after logging in, so this
    // worker's own fresh browser starts already authenticated — no login UI interaction here at
    // all. Unverified live (see jobup-search.js's matching comment on the save side) — if a worker
    // ends up on the login page instead of the results page below, that's the first thing to dump
    // diagnostics for.
    const context = await browser.newContext({
      storageState: storageStatePath,
      viewport: { width: 1440, height: 900 }
    });
    page = await context.newPage();

    await page.goto(resultsUrl);
    // Defensive no-op if consent was already dismissed as part of the saved session (it should
    // have been, jobup-search.js dismisses it before ever logging in) — cheap enough to always run
    // rather than assume.
    await dismissCookieConsent(page);

    const dataCyJobLinks = page.locator('[data-cy="job-link"]:visible');
    const articleJobLinks = page.getByRole('article');
    const anyJobResult = dataCyJobLinks.or(articleJobLinks);

    await waitForJobResults(page, anyJobResult, '1');

    if (!Number.isInteger(jobIndex) || jobIndex < 1) {
      // routes/api.js validates Start/End before spawning any worker, so this shouldn't normally
      // be reachable — guarded anyway since runCvMatchJob() could in principle be called directly.
      return {
        jobIndex,
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        errorMessage: 'Job index must be a positive integer',
        applicationUrl: null
      };
    }

    // jobup.ch paginates results at JOBS_PER_PAGE (20) per page. jobIndex 1-20 is on page 1
    // (where we already are); anything beyond that requires paging forward to reach it.
    // `inPageIndex` is that job's 1-based position *within* its page —
    // `((jobIndex - 1) % JOBS_PER_PAGE) + 1` rather than the simpler `jobIndex % JOBS_PER_PAGE`,
    // since the latter gives 0 (invalid) for exact multiples of JOBS_PER_PAGE (e.g. jobIndex 40
    // should be position 20 on page 2, not position 0).
    const targetPage = Math.ceil(jobIndex / JOBS_PER_PAGE);
    const inPageIndex = ((jobIndex - 1) % JOBS_PER_PAGE) + 1;

    if (targetPage > 1) {
      // Confirmed live (pre-split): `page.goto()` with a `page=N` query param worked fine on the
      // basic-search recovery path, but reliably threw ERR_TOO_MANY_REDIRECTS on the direct-CTA
      // path — attributed to that path's *accumulated SPA session/routing state* from having
      // clicked through several steps on the same live page. This worker always starts from a
      // single, fresh `page.goto(resultsUrl)` (never a re-navigation of an already-live SPA
      // session), so that specific failure mode may simply not reproduce here even for what was
      // originally a direct-CTA search — **unverified live, not assumed**: URL-based pagination is
      // tried unconditionally first, and only falls back to clicking "next page" repeatedly (the
      // pre-split direct-CTA behavior) if that navigation itself throws. If a real run shows the
      // fallback firing (or, worse, silently landing on the wrong page instead of throwing), dump
      // diagnostics from that run rather than guessing further.
      let paginatedViaUrl = false;
      try {
        const pagedUrl = new URL(resultsUrl);
        pagedUrl.searchParams.set('page', String(targetPage));
        await page.goto(pagedUrl.toString());
        await waitForJobResults(page, anyJobResult, targetPage + ' (via page= param)');
        paginatedViaUrl = true;
      } catch (urlPaginationErr) {
        console.error(
          'URL-based pagination to page ' + targetPage + ' failed (' + urlPaginationErr.message + '); ' +
            'falling back to clicking "next page" repeatedly from page 1.'
        );
      }

      if (!paginatedViaUrl) {
        await page.goto(resultsUrl);
        await waitForJobResults(page, anyJobResult, '1 (retry after failed URL pagination)');

        for (let currentPage = 1; currentPage < targetPage; currentPage++) {
          const nextPageControl = page
            .getByRole('link', { name: /suivant|next/i })
            .or(page.getByRole('button', { name: /suivant|next/i }));

          try {
            await nextPageControl.first().waitFor({ state: 'visible', timeout: 10000 });
          } catch (waitErr) {
            const paginationCandidates = await page
              .locator('[data-cy*="pag" i], nav, [aria-label*="pagination" i], [role="navigation"]')
              .evaluateAll((els) =>
                els.slice(0, 10).map((el) => ({
                  tag: el.tagName,
                  dataCy: el.getAttribute('data-cy'),
                  ariaLabel: el.getAttribute('aria-label'),
                  text: el.textContent?.trim().slice(0, 150),
                }))
              );
            console.error(
              'could not find a "next page" control going from page ' + currentPage +
                ' to ' + targetPage + '. Pagination-area candidates:',
              JSON.stringify(paginationCandidates)
            );
            throw waitErr;
          }

          await nextPageControl.first().click();
          await waitForJobResults(page, anyJobResult, String(currentPage + 1));
        }
      }
    }

    let measured = await measureJobs(page, dataCyJobLinks, articleJobLinks, targetPage);

    // Confirmed live: right after paginating, every matched job element can briefly resolve with a
    // null boundingBox() at once — hrefs already present, elements already matched by the locator,
    // just still mid-render/settling — which previously got misread as "0 jobs on this page" (an
    // out-of-range jobIndex) rather than the transient state it actually was. Retry the measurement
    // a few times before trusting a fully-dropped result.
    for (let attempt = 0; measured.sorted.length === 0 && measured.dropped.length > 0 && attempt < 3; attempt++) {
      console.error(
        'all ' + measured.dropped.length + ' matched job element(s) on page ' + targetPage +
          ' had no bounding box (likely still rendering) — retrying measurement (attempt ' + (attempt + 1) + ').'
      );
      await page.waitForTimeout(750);
      measured = await measureJobs(page, dataCyJobLinks, articleJobLinks, targetPage);
    }

    if (measured.usedArticleFallback) {
      console.error(
        'no [data-cy="job-link"] elements on page ' + targetPage +
          '; using role="article" for job selection instead.'
      );
    }

    const { dropped, sorted } = measured;

    // Logged unconditionally (not just on error) so a *wrong* selection — not just a missing one —
    // can be diagnosed from the resulting order and each element's href/coordinates, e.g. an
    // off-screen duplicate (a hidden mobile/desktop responsive twin, per the filter-bar gotcha)
    // still passing the `:visible` check and skewing the sort.
    console.error(
      'job order on page ' + targetPage + ':',
      JSON.stringify(sorted.map((j, i) => ({ position: i + 1, href: j.href, x: j.box.x, y: j.box.y }))),
      dropped.length ? 'dropped (no bounding box, href): ' + JSON.stringify(dropped.map((j) => j.href)) : ''
    );

    const orderedJobs = sorted.map((j) => j.el);

    const jobCount = orderedJobs.length;
    if (inPageIndex > jobCount) {
      console.error(
        'jobIndex ' + jobIndex + ' (page ' + targetPage + ', position ' + inPageIndex +
          ') is out of range for ' + jobCount + ' job(s) found on that page.'
      );
      return {
        jobIndex,
        success: false,
        analysis: null,
        meter: null,
        criteria: [],
        jobUrl: null,
        errorMessage: 'Job index must not be greater than the number of jobs found on that page',
        applicationUrl: null
      };
    }

    const selectedJob = orderedJobs[inPageIndex - 1];

    // Read the job's real detail URL (https://www.jobup.ch/fr/emplois/detail/...) from the link's
    // own `href` before clicking — jobup.ch renders the job detail in place rather than navigating
    // (it just adds a `?jobid=...` query param to the *current*, listing URL), so `page.url()`
    // after the click is the search page, not the job. `[data-cy="job-link"]` is the `<a>` itself
    // on the confirmed-good path, but fall back to a nested `a[href]` in case the `role="article"`
    // fallback locator ever matches instead.
    let jobHref = await selectedJob.getAttribute('href');
    if (!jobHref) {
      jobHref = await selectedJob.locator('a[href]').first().getAttribute('href').catch(() => null);
    }
    // Resolved against resultsUrl's own origin rather than a hardcoded jobup.ch one — this worker
    // is domain-agnostic by construction (see the "Use www.jobs.ch" checkbox/routes/api.js's own
    // comment): whichever site produced resultsUrl is also where a relative jobHref belongs.
    const jobUrl = jobHref ? new URL(jobHref, new URL(resultsUrl).origin).toString() : null;

    await selectedJob.click();

    // The CV-match entry point, renamed on both jobup.ch and jobs.ch (confirmed by the user,
    // 2026-10-21, with screenshots and outerHTML; the dialogs behind them are unchanged):
    //   - "Voir mon match"  -> "Voir si je corresponds à ce poste" / "Comparez votre CV aux
    //     exigences du poste": `<button data-cy="jobfit-teaser-cta">` — starts a NEW analysis
    //     (then "Continuer" to confirm, as before).
    //   - "Voir l'analyse"  -> "Mon match" + a `data-cy="jobfit-teaser-label"` verdict pill ("Match
    //     faible"/"Match modéré"/...) + "Voir vos atouts et nos conseils":
    //     `<button data-cy="jobfit-teaser-analysed-<verdict>">` (seen: -poor, -moderate) — opens
    //     the EXISTING analysis.
    // Both are matched by data-cy since neither accessible name is stable (the new wording is long,
    // and "Mon match" carries a per-job verdict pill). The old "Voir l'analyse"/"Voir mon match"
    // buttons are no longer matched at all — if one ever reappears (e.g. a gradual rollout), the
    // "found neither" diagnostic below will show it. `:visible`-scoped — jobup.ch duplicates
    // markup for responsive layouts, and an unscoped `.first()` can resolve to a hidden copy and
    // wait out its timeout on it.
    const existingAnalysisButton = page.locator('[data-cy^="jobfit-teaser-analysed"]:visible');
    const newAnalysisButton = page.locator('[data-cy="jobfit-teaser-cta"]:visible');
    const continueButton = page
      .getByRole('button', { name: 'Continuer', exact: true })
      .and(page.locator(':visible'));

    const which = await Promise.race([
      existingAnalysisButton.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'existing'),
      newAnalysisButton.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => 'new'),
    ]).catch(() => null);

    let analysis;
    let meter;
    let criteria;
    if (which === 'existing') {
      console.error(
        'opening the existing CV match ("Mon match", data-cy="' +
          (await existingAnalysisButton.first().getAttribute('data-cy')) +
          '").'
      );
      await existingAnalysisButton.first().click();
      ({ analysis, meter, criteria } = await readAnalysisAndClose(page, 20000));
    } else if (which === 'new') {
      // Gotcha, confirmed live (2026-10-21, "devops"/Genève jobIndex 1–10): the detail pane shows
      // "Voir si je corresponds à ce poste" FIRST even for an already-analyzed job, and only swaps
      // it for "Mon match" once the job's match status has loaded — so winning the race above
      // doesn't prove the job is new. Observed in that run: some already-analyzed jobs were clicked
      // before the swap (the click then opened the existing analysis modal directly, no
      // "Continuer"), and two were swapped between the race and the click (a click bound to
      // `jobfit-teaser-cta` alone then waited out 30s on an element that no longer existed). So
      // click whichever of the two buttons is visible at click time, then race "Continuer" (new
      // analysis) against the analysis modal opening directly (existing analysis).
      const eitherButton = existingAnalysisButton.or(newAnalysisButton);
      const clickedDataCy = await eitherButton.first().getAttribute('data-cy', { timeout: 10000 });
      await eitherButton.first().click({ timeout: 10000 });
      const afterClick = await Promise.race([
        continueButton.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => 'continue'),
        page
          .locator('[data-cy="jobfit-analysis-modal"]:visible')
          .first()
          .waitFor({ state: 'visible', timeout: 15000 })
          .then(() => 'modal'),
      ]).catch(() => null);
      console.error(
        'clicked the CV-match button (data-cy="' +
          clickedDataCy +
          '"): ' +
          (afterClick === 'continue'
            ? 'new analysis, clicking "Continuer".'
            : afterClick === 'modal'
              ? 'the existing analysis opened directly (job already analyzed).'
              : 'neither "Continuer" nor the analysis modal appeared within 15s; waiting for the result anyway.')
      );
      if (afterClick === 'continue') {
        await continueButton.first().click();
      }
      // The AI analysis can take a while to run; wait generously for "Fermer" to appear, since
      // that signals the result is ready to read (handled inside readAnalysisAndClose()).
      // Confirmed live: a batch of 5 workers hitting jobs.ch's AI analysis concurrently can push
      // some jobs' generation past 60s even though the exact same code/selector succeeds for
      // others in the same run (jobIndex 1 succeeded; 2, 5, 8, 9, 10 all timed out here in one
      // 1..50 run) — not a broken selector, contention under concurrent load. Bumped 60s -> 90s as
      // a mitigation, and this specific timeout is now caught and reported with its own
      // errorMessage (previously fell through to the generic top-level catch, which dumped the
      // raw Playwright TimeoutError to stderr and returned errorMessage: null, i.e. just "Analysis
      // failed !" in the UI with no way to tell this apart from a genuine break without reading
      // backend logs). Unconfirmed whether 90s is actually enough under worse contention, or
      // whether this happens against jobup.ch too (no evidence of it there so far) — if it recurs,
      // that's the next thing to look at (e.g. a lower batch size specifically for this step, or a
      // retry).
      try {
        ({ analysis, meter, criteria } = await readAnalysisAndClose(page, 90000));
      } catch (analysisWaitErr) {
        if (analysisWaitErr.name === 'TimeoutError') {
          console.error(
            'timed out waiting for the AI analysis to finish generating for jobIndex ' + jobIndex + '.'
          );
          return {
            jobIndex,
            success: false,
            analysis: null,
            meter: null,
            criteria: [],
            jobUrl,
            errorMessage: 'AI analysis took too long to generate for this job',
            applicationUrl: null
          };
        }
        throw analysisWaitErr;
      }
    } else {
      const matchCandidates = await page.locator('[data-cy]').evaluateAll((els) => {
        const seen = new Set();
        for (const el of els) {
          const v = el.getAttribute('data-cy');
          if (v && /match|analys|cv|jobfit|teaser/i.test(v)) seen.add(v);
        }
        return [...seen];
      });
      // Every element mentioning "match" (any tag, not just buttons — the first 30 buttons on the
      // page are all header/search chrome, so the job detail pane's controls never showed up here),
      // with its tag, role and data-cy, so a renamed/re-tagged CV-match control is identifiable.
      const buttonTexts = await page.locator('button, a, [role="button"], [data-cy]').evaluateAll((els) =>
        els
          .filter((el) => /match/i.test(el.textContent || '') && el.getBoundingClientRect().width > 0)
          .slice(0, 15)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            dataCy: el.getAttribute('data-cy'),
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
          }))
      );
      console.error(
        'found neither "Mon match" nor "Voir si je corresponds à ce poste". Current URL:',
        page.url(),
        'Candidate data-cy values:',
        JSON.stringify(matchCandidates),
        'Visible elements mentioning "match":',
        JSON.stringify(buttonTexts)
      );
      // Dump the jobfit teaser(s) themselves — visibility plus truncated outerHTML — so a future
      // rename of the CV-match buttons shows up directly in the logs (this is how the 2026-10-21
      // "Voir si je corresponds à ce poste"/"Mon match" rename was identified).
      const jobfitTeasers = await page.locator('[data-cy^="jobfit-teaser"]').evaluateAll((els) =>
        els.slice(0, 5).map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            dataCy: el.getAttribute('data-cy'),
            visible: rect.width > 0 && rect.height > 0,
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
            outerHTML: el.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '<svg/>').slice(0, 1500)
          };
        })
      );
      console.error('jobfit teaser elements:', JSON.stringify(jobfitTeasers));
      throw new Error('Could not find either the "already analyzed" or "new analysis" button');
    }

    // A meter of either color (green or yellow) triggers saving/applying — only its *absence*
    // (the "Vos talents correspondent mieux à d'autres opportunités" heading, no meter rendered at
    // all) skips this outright; a yellow meter specifically is further gated by ignoreYellowMeter
    // inside prepareJobApplicationDraft(), and saveJob/easyApply gate the two actions independently.
    let applicationUrl = null;
    if (meter) {
      applicationUrl = await prepareJobApplicationDraft(page, meter.color, { saveJob, easyApply, ignoreYellowMeter });
    } else {
      console.error(
        'no meter present (e.g. "Vos talents correspondent mieux à d\'autres ' +
          'opportunités"); not saving or applying.'
      );
    }

    return { jobIndex, success: true, analysis, meter, criteria, jobUrl, errorMessage: null, applicationUrl };
  } finally {
    await browser.close();
    activeBrowser = null;
  }
}

module.exports = { runCvMatchJob };

// Only run as a standalone CLI when invoked directly (`node scripts/jobup-cv-match.js`) — this is
// how routes/api.js spawns it, as a child process, once per job index in the requested range.
if (require.main === module) {
  (async () => {
    const resultsUrl = process.argv[2];
    const storageStatePath = process.argv[3];
    const jobIndex = process.argv[4] !== undefined ? Number(process.argv[4]) : NaN;
    const saveJob = process.argv[5] === 'true' || process.argv[5] === '1';
    const easyApply = process.argv[6] === 'true' || process.argv[6] === '1';
    const ignoreYellowMeter = process.argv[7] === 'true' || process.argv[7] === '1';

    if (!resultsUrl || !storageStatePath) {
      console.error('resultsUrl and storageStatePath arguments are required.');
      process.stdout.write(
        JSON.stringify({
          jobIndex,
          success: false,
          analysis: null,
          meter: null,
          criteria: [],
          jobUrl: null,
          errorMessage: null,
          applicationUrl: null
        })
      );
      return;
    }

    try {
      const result = await runCvMatchJob(resultsUrl, storageStatePath, jobIndex, saveJob, easyApply, ignoreYellowMeter);
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      console.error(err);
      process.stdout.write(
        JSON.stringify({
          jobIndex,
          success: false,
          analysis: null,
          meter: null,
          criteria: [],
          jobUrl: null,
          errorMessage: null,
          applicationUrl: null
        })
      );
    }
  })();
}
