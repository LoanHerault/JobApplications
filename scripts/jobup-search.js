#!/usr/bin/env node

/**
 * Standalone script (spawned as a child process by routes/api.js), run exactly once per
 * POST /api/cv-match request, that logs into jobup.ch and runs the job search — everything
 * scripts/jobup-cv-match.js used to do itself before it was split into a one-time
 * login+search step (this file) and a per-job-index worker (jobup-cv-match.js, now spawned once
 * per requested job index and run in parallel — see routes/api.js and CLAUDE.md's "jobup.ch
 * CV-match automation" section for the full split and why).
 *
 * All of the search-entry-path/mode-detection/location-filtering logic below is relocated
 * unchanged from the pre-split jobup-cv-match.js — none of its confirmed-live behavior (or its
 * still-open limitations, like the direct-CTA path's unfiltered-by-location results) has changed,
 * only where it lives.
 *
 * Reads credentials from JOBUP_EMAIL / JOBUP_PASSWORD, whether to skip straight to the
 * "Recherche d'emploi" sub-nav tab / basic-search entry point instead of the profile-based CTA
 * from `process.argv[2]` (`'true'`/`'1'`; defaults to false, i.e. try the CTA first as usual and
 * only fall back to basic search if it's unavailable). `process.argv[3]` is a custom search term
 * (falls back to RECOVERY_SEARCH_TERM when empty — and is ignored entirely whenever "Rechercher
 * avec mon profil" ends up being used, since that CTA generates its own profile-derived term
 * server-side); `process.argv[4]` is a JSON-encoded array of custom locations (falls back to
 * `[LOCATION_SLUG]` when empty/absent), each appended as its own `location=` query param wherever
 * this file applies a location filter. `process.argv[5]` (`'true'`/`'1'`) picks www.jobs.ch instead
 * of www.jobup.ch as the site driven for the rest of this run — see BASE_URL/JOBS_PATH below; every
 * other selector/flow in this file and jobup-cv-match.js is assumed to carry over unchanged between
 * the two (unverified live — jobs.ch and jobup.ch are sister sites under the same company, but no
 * jobs.ch session was available in this environment to confirm its markup actually matches).
 *
 * On success, saves the authenticated browser context's `storageState` (cookies + localStorage)
 * to a temp JSON file so each per-job worker can load it into its own fresh browser and start
 * already logged in, without repeating the login UI flow — routes/api.js owns picking that path
 * and deleting the file once every worker has finished with it.
 *
 * Prints a single JSON line to stdout:
 * {"success": true|false, "errorMessage": string|null, "totalJobsCount": number|null,
 * "resultsUrl": string|null, "storageStatePath": string|null}. `errorMessage` is non-null only for
 * a specific, expected failure meant to be shown to the user as-is — a LoginValidationError
 * subclass (see scripts/jobup-login.js: `'Invalid login credentials'`/`'Invalid email format'`) or
 * jobup.ch reporting 0 matching jobs for the given search term/locations — and `null` on every
 * other path, including genuinely unexpected errors. `totalJobsCount`/`resultsUrl` are non-null
 * whenever the search itself actually ran, even on some failures (an EmptyResultsError still
 * reports `totalJobsCount: 0` and the results URL it found nothing on), matching the convention
 * routes/api.js/the frontend already expect from the pre-split script. `storageStatePath` is only
 * ever non-null on success — there's nothing for a worker to load otherwise. Diagnostic output
 * goes to stderr so stdout stays parseable.
 */

const { chromium } = require('playwright');
const { dismissCookieConsent, performLogin, LoginValidationError } = require('./jobup-login');
const { JOBS_PER_PAGE, dedupeByHref, EmptyResultsError, waitForJobResults } = require('./jobup-shared');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Set right after chromium.launch() succeeds, cleared once browser.close() has run — lets the
// SIGTERM/SIGINT handlers below close the browser on the way out instead of leaving it orphaned
// when routes/api.js's POST /cv-match/stop kills this process early. Best-effort backstop, not the
// primary cleanup mechanism — see scripts/jobup-cv-match.js's matching comment (Windows' unreliable
// SIGTERM support is exactly why routes/api.js's stop endpoint also runs `taskkill /T /F`
// unconditionally there).
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

// The "Aller à la recherche basique" recovery UI's search ends up with an empty `term` query
// param — confirmed live: it returned ~36000 jobs (location-filtered only) vs. ~2500-3000 on the
// direct CTA path, because that path's "Rechercher avec mon profil" auto-generates a
// profile-derived search term server-side that this recovery UI never receives. Filling in this
// fixed keyword compensates for that (a real profile-derived term isn't available to this script).
const RECOVERY_SEARCH_TERM = 'Développeur';

// The location applied via the `location=<slug>` query param (see the comment where it's used,
// below) — confirmed live as a real, working slug: `location=genève` returns genuinely
// Genève-filtered results (e.g. "10 Offres d'emploi Développeur à Genève").
const LOCATION_SLUG = 'Genève';

// Appends one `location=` query param per entry, as requested (multiple repeated `location=`
// params rather than one comma-joined value). Only a single `location=<slug>` value was ever
// confirmed live (see the location-filtering gotcha above/in CLAUDE.md) — this hasn't been
// re-verified with more than one location at once, so if jobup.ch turns out not to support
// multiple `location` params the same way, re-derive it live the usual way.
function appendLocations(url, locations) {
  for (const location of locations) {
    url.searchParams.append('location', location);
  }
}

async function runSearch(email, password, useBasicSearch, searchTerm, locations, useJobsCh) {
  const effectiveSearchTerm = searchTerm && searchTerm.trim() ? searchTerm.trim() : RECOVERY_SEARCH_TERM;
  const filteredLocations = (Array.isArray(locations) ? locations : [])
    .map((location) => String(location).trim())
    .filter((location) => location.length > 0);
  const effectiveLocations = filteredLocations.length > 0 ? filteredLocations : [LOCATION_SLUG];

  // jobs.ch's own jobs-listing path is "/fr/offres-emplois/", not jobup.ch's "/fr/emplois/" — every
  // other URL this file touches (pagination's `?page=N`, the location=/term= fallback query params,
  // etc.) is built by mutating *this* page's own already-loaded URL rather than a second hardcoded
  // literal, so switching these two is the only domain-specific thing needed here.
  const BASE_URL = useJobsCh ? 'https://www.jobs.ch' : 'https://www.jobup.ch';
  const JOBS_PATH = useJobsCh ? '/fr/offres-emplois/' : '/fr/emplois/';

  const browser = await chromium.launch();
  activeBrowser = browser;
  let page;
  try {
    // Explicit desktop-sized viewport rather than Playwright's default (1280x720 headless) — two
    // separate confirmed-live bugs now (the job-page "Sauvegarder" button's duplicated markup, see
    // CLAUDE.md) have come from jobup.ch rendering a different responsive layout than whatever this
    // script's headless browser happened to fall into, vs. what a live DOM dump taken from a normal
    // full-size browser window showed. A larger, fixed viewport keeps the desktop layout consistent
    // regardless of Playwright's own headless default, so this class of mismatch doesn't recur.
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(BASE_URL + '/fr/');

    await dismissCookieConsent(page);

    let loggedIn = false;
    try {
      loggedIn = await performLogin(page, email, password);
    } catch (err) {
      if (err instanceof LoginValidationError) {
        return { success: false, errorMessage: err.message, totalJobsCount: null, resultsUrl: null, storageStatePath: null };
      }
      throw err;
    }
    if (!loggedIn) {
      return { success: false, errorMessage: null, totalJobsCount: null, resultsUrl: null, storageStatePath: null };
    }

    await page.goto(BASE_URL + JOBS_PATH);

    // The accessible name "Rechercher avec mon profil" also matches a second, nested button
    // inside the "Ouvrir Recherche" search-bar dropdown (data-cy="search-with-profile-button-row"),
    // which made a plain role/name locator ambiguous (Playwright strict-mode violation) the first
    // time this was verified live, so the primary path targets the standalone page CTA by its
    // data-cy attribute. That CTA (and even a plain role/name match) has occasionally been observed
    // missing within the previous, shorter wait window even in the same account/session where it
    // worked moments before — most likely page-load timing jitter rather than a real UI change, so
    // it now gets a longer window before falling back. If it's genuinely absent (e.g. once the
    // account accumulates enough search/application history that jobup.ch permanently swaps
    // `/fr/emplois/` for a candidate-dashboard sub-nav — `data-cy="vacancy-search-sub-nav"`, tabs
    // "Recherche d'emploi" / "Recommandations d'emploi" / "Job Alerte" / "Emplois sauvegardés" /
    // "Candidatures" — with no "Rechercher avec mon profil" text anywhere), the sub-nav's "Recherche
    // d'emploi" tab is tried as a last resort. Confirmed live: that tab can land in either
    // "Intelligent search" mode (a free-text "Décris ton rôle idéal :" box) or "Basic search" mode
    // (the classic "Villes ou régions" filter UI) depending on persisted account/browser state —
    // the mode-detection right after the click below handles both.
    const searchWithProfileByDataCy = page.locator('[data-cy="search-with-profile-button-cta"]');
    const searchWithProfileByRole = page.getByRole('button', { name: /rechercher avec mon profil/i });
    const jobSearchTab = page.locator('[data-cy="vacancy-search-sub-nav"]').getByText(/recherche d'emploi/i).first();

    async function dumpSubNavAndThrow(waitErr, alsoTried) {
      const subNavContent = await page
        .locator('[data-cy="vacancy-search-sub-nav"]')
        .evaluateAll((els) => els.map((el) => el.innerText));
      console.error(
        'could not find' + (alsoTried ? ' ' + alsoTried + ', nor' : '') +
          ' "Recherche d\'emploi" in vacancy-search-sub-nav. Its content:',
        JSON.stringify(subNavContent)
      );
      throw waitErr;
    }

    let searchWithProfileButton;
    let searchWithProfilePath;
    if (useBasicSearch) {
      // "Use basic search" checked on the frontend: skip the profile-based CTA entirely and go
      // straight for the sub-nav's "Recherche d'emploi" tab, the same entry point the natural
      // fallback below uses — mainly useful for exercising/testing that path (and the "Aller à la
      // recherche basique" recovery it leads into) directly, without depending on account state.
      try {
        await jobSearchTab.waitFor({ state: 'visible', timeout: 15000 });
        searchWithProfileButton = jobSearchTab;
        searchWithProfilePath = 'subNavTab (forced by useBasicSearch)';
      } catch (waitErr) {
        await dumpSubNavAndThrow(waitErr);
      }
    } else {
      try {
        await searchWithProfileByDataCy.waitFor({ state: 'visible', timeout: 25000 });
        searchWithProfileButton = searchWithProfileByDataCy;
        searchWithProfilePath = 'cta';
      } catch {
        try {
          await searchWithProfileByRole.last().waitFor({ state: 'visible', timeout: 15000 });
          searchWithProfileButton = searchWithProfileByRole.last();
          searchWithProfilePath = 'role';
        } catch {
          try {
            await jobSearchTab.waitFor({ state: 'visible', timeout: 10000 });
            searchWithProfileButton = jobSearchTab;
            searchWithProfilePath = 'subNavTab';
            console.error('falling back to the "Recherche d\'emploi" sub-nav tab.');
          } catch (waitErr) {
            await dumpSubNavAndThrow(waitErr, '"Rechercher avec mon profil"');
          }
        }
      }
    }

    console.error('entered search flow via path:', searchWithProfilePath);
    await searchWithProfileButton.click();

    // Declared up front (not just plain values yet — Playwright locators are lazy, they don't
    // require the page to be in any particular state until actually awaited) so the recovery
    // branch below can use waitForJobResults() after a direct URL navigation, same as the
    // location-filtering step further down.
    const dataCyJobLinks = page.locator('[data-cy="job-link"]:visible');
    const articleJobLinks = page.getByRole('article');
    const anyJobResult = dataCyJobLinks.or(articleJobLinks);

    // jobup.ch's `/fr/emplois/` page can independently load in "Intelligent search" mode (the
    // AI free-text "Décris ton rôle idéal :" UI) or "Basic search" mode (the classic, filter-based
    // UI with "Villes ou régions" etc.) — confirmed live this isn't strictly tied to which entry
    // point above was used (e.g. the sub-nav tab can land directly in either one, apparently
    // depending on persisted account/browser state). Whichever mode you're *not* currently in
    // offers a link to switch to the other, and those two links are mutually exclusive — only one
    // is ever present — so their presence is used below to detect the current mode directly,
    // rather than assuming it from searchWithProfilePath.
    // Confirmed live via a user-supplied DOM dump: these aren't real <a>/<button> elements, just
    // a <span role="button" tabindex="0"> wrapping the label text in its own nested <span> (plus
    // an aria-hidden icon) — getByRole('button', ...) does match an explicit role="button" like
    // this, but a getByText fallback is added too in case role-matching is ever flaky for it.
    const goToIntelligentSearchLink = page
      .getByRole('link', { name: /aller à la recherche intelligente/i })
      .or(page.getByRole('button', { name: /aller à la recherche intelligente/i }))
      .or(page.getByText('Aller à la recherche intelligente', { exact: true }));
    const basicSearchLink = page
      .getByRole('link', { name: /aller à la recherche basique/i })
      .or(page.getByRole('button', { name: /aller à la recherche basique/i }))
      .or(page.getByText('Aller à la recherche basique', { exact: true }));

    // Clicks the given "go to X mode" link if present, otherwise assumes that mode's already
    // active. Returns whether a click happened. 10s default — this link has been observed slow to
    // render right after the sub-nav-tab click, same as other elements on this page (see the
    // "Rechercher avec mon profil" gotcha's longer waits).
    async function switchModeIfLinkPresent(link, timeout = 10000) {
      const present = await link
        .first()
        .waitFor({ state: 'visible', timeout })
        .then(() => true)
        .catch(() => false);
      if (present) {
        await link.first().click();
      }
      return present;
    }

    // Despite the name (kept for continuity with earlier logs/docs), this now just means "fill
    // RECOVERY_SEARCH_TERM into whatever term field is present" — it no longer implies Basic
    // search mode specifically, since the natural sub-nav-tab fallback below can set it while
    // staying in Intelligent search mode.
    let usedBasicSearchRecovery = false;
    // Set when the recovery branch below navigates directly via URL instead of filling a term
    // field and clicking "Recherche" through the UI — see why in that branch's comment.
    let skipSearchSubmit = false;

    if (useBasicSearch) {
      // "Use basic search" checked: go straight to Basic search mode (click "Aller à la
      // recherche basique" if needed, no-op if already there) and use RECOVERY_SEARCH_TERM —
      // this is the explicit request for the basic-search flow, no CTA detour.
      const switched = await switchModeIfLinkPresent(basicSearchLink, 10000);
      console.error(
        switched
          ? 'useBasicSearch: clicked "Aller à la recherche basique".'
          : 'useBasicSearch: already in Basic search mode (or the link was not ' +
              'found); proceeding directly.'
      );
      usedBasicSearchRecovery = true;
    } else if (searchWithProfilePath.startsWith('subNavTab')) {
      // Natural fallback (CTA/role unavailable on the initial page): the sub-nav tab can land on
      // whichever mode the account/browser currently defaults to, not necessarily Basic search
      // mode. Ensure Intelligent search mode first (no-op if already there) and look there for
      // "Rechercher avec mon profil" — reusing the profile-matched CTA flow gives a real
      // profile-derived search term instead of RECOVERY_SEARCH_TERM, so it's preferred here.
      // The two mode-switch links are mutually exclusive, so wait for *either* one rather than
      // waiting out the full timeout on "Aller à la recherche intelligente" when the page is
      // already in Intelligent search mode (confirmed live: that wasted 10s per run and pushed
      // the whole search past routes/api.js's execFile timeout, while the diagnostic below
      // showed "Aller à la recherche basique" visible — i.e. the expected, already-intelligent
      // state, not a selector problem).
      const eitherModeLinkVisible = await goToIntelligentSearchLink
        .or(basicSearchLink)
        .first()
        .waitFor({ state: 'visible', timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      const alreadyIntelligent = eitherModeLinkVisible && (await basicSearchLink.first().isVisible());
      const switchedToIntelligent =
        eitherModeLinkVisible && !alreadyIntelligent && (await switchModeIfLinkPresent(goToIntelligentSearchLink, 2000));
      console.error(
        switchedToIntelligent
          ? 'entered via the sub-nav tab; clicked "Aller à la recherche intelligente".'
          : alreadyIntelligent
            ? 'entered via the sub-nav tab, already in Intelligent search mode ' +
                '("Aller à la recherche basique" is visible).'
            : 'entered via the sub-nav tab; neither mode-switch link was found.'
      );
      if (!switchedToIntelligent && !alreadyIntelligent) {
        // Diagnostic only, not a failure path: dump what role="button"/role="link" elements
        // actually exist right now, to see why the "Aller à la recherche intelligente" locator
        // didn't match one even though a live DOM dump showed it present as a
        // <span role="button"> elsewhere.
        const candidates = await page
          .locator('[role="button"], [role="link"], a, button')
          .evaluateAll((els) =>
            els
              .filter((el) => el.textContent && /intelligente|basique/i.test(el.textContent))
              .map((el) => ({
                tag: el.tagName,
                role: el.getAttribute('role'),
                text: el.textContent.trim().slice(0, 80),
                visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
              }))
          );
        console.error(
          'mode-switch link not matched; elements mentioning intelligente/basique:',
          JSON.stringify(candidates)
        );
      }

      // Same ambiguous-accessible-name issue as searchWithProfileByRole above — this also matches
      // the hidden nested button inside the "Ouvrir Recherche" dropdown, so the standalone CTA
      // (data-cy first, role .last() as fallback) is targeted the same way, not .first().
      const profileButtonByDataCyInIntelligentMode = page.locator('[data-cy="search-with-profile-button-cta"]');
      const profileButtonByRoleInIntelligentMode = page.getByRole('button', { name: /rechercher avec mon profil/i });
      let profileButtonInIntelligentMode = null;
      if (
        await profileButtonByDataCyInIntelligentMode
          .waitFor({ state: 'visible', timeout: 10000 })
          .then(() => true)
          .catch(() => false)
      ) {
        profileButtonInIntelligentMode = profileButtonByDataCyInIntelligentMode;
      } else if (
        await profileButtonByRoleInIntelligentMode
          .last()
          .waitFor({ state: 'visible', timeout: 5000 })
          .then(() => true)
          .catch(() => false)
      ) {
        profileButtonInIntelligentMode = profileButtonByRoleInIntelligentMode.last();
      }
      const foundProfileButton = profileButtonInIntelligentMode !== null;

      if (foundProfileButton) {
        console.error(
          'entered via the sub-nav tab; found "Rechercher avec mon profil" in ' +
            'Intelligent search mode, using the same flow as the direct-CTA path from here.'
        );
        await profileButtonInIntelligentMode.click();
        searchWithProfilePath = 'cta (via subNavTab detour)';
      } else {
        // Confirmed live via a user-supplied screenshot: Intelligent search mode's own term/
        // location fields work fine with a manually-typed term (not just a profile-derived one),
        // and its results are broader than Basic search mode's for the same term/location — so
        // this deliberately stays in Intelligent search mode rather than switching to Basic search
        // mode (which an earlier version of this code did, needlessly narrowing the results).
        // But confirmed live, staying here and trying to fill a term field through the UI (the
        // way the old Basic-search recovery did) doesn't reliably work: the landing state right
        // after entering via the sub-nav tab can be the true free-text AI page (no matching
        // input/combobox/textbox at all, and no "Recherche" button either — not the term+location
        // dual-field layout the screenshot showed, which is what you get once a search has
        // actually been run). So skip UI interaction entirely here and navigate straight to the
        // results URL with `term`/`location` query params set, the same reliable mechanism
        // already used for location filtering and pagination elsewhere in this file.
        console.error(
          'entered via the sub-nav tab; "Rechercher avec mon profil" not available ' +
            'in Intelligent search mode either, navigating directly to the Intelligent-search results ' +
            'URL with the effective search term/locations instead of filling fields through the UI.'
        );
        const recoveryUrl = new URL(page.url());
        recoveryUrl.searchParams.set('term', effectiveSearchTerm);
        appendLocations(recoveryUrl, effectiveLocations);
        await page.goto(recoveryUrl.toString());
        await waitForJobResults(page, anyJobResult, '1 (recovery term+location via URL)');
        skipSearchSubmit = true;
      }
    }

    // On the basic-search recovery UI, fill in the effective search term so the search isn't
    // unfiltered by keyword. Confirmed live: this field has no placeholder/aria-label/name at all
    // — just `id="synonym-typeahead-text-field"`. Not fatal if it can't be found/filled — the run
    // still proceeds, just unfiltered by keyword. Skipped entirely when skipSearchSubmit is set —
    // the recovery branch above already navigated directly with the term (and location) as URL
    // query params instead.
    if (usedBasicSearchRecovery && !skipSearchSubmit) {
      const termField = page
        .locator('#synonym-typeahead-text-field')
        .or(page.getByPlaceholder(/poste|mot.?cl[ée]|m[ée]tier|fonction/i))
        .or(page.getByRole('combobox', { name: /poste|mot.?cl[ée]|m[ée]tier|fonction/i }))
        .or(page.getByRole('textbox', { name: /poste|mot.?cl[ée]|m[ée]tier|fonction/i }));

      try {
        await termField.first().waitFor({ state: 'visible', timeout: 8000 });
        await termField.first().fill(effectiveSearchTerm);
        // Filling a typeahead field like this one opens its own suggestions dropdown; Escape
        // dismisses it without picking a suggestion, keeping the typed term.
        await termField.first().press('Escape');
        console.error('filled the basic-search term field with "' + effectiveSearchTerm + '".');
      } catch {
        const fields = await page.locator('input, [role="combobox"], [role="searchbox"]').evaluateAll((els) =>
          els.map((el) => ({
            tag: el.tagName,
            id: el.id,
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            name: el.getAttribute('name'),
          }))
        );
        console.error(
          'could not find a term field on the basic-search UI to fill; proceeding ' +
            'unfiltered by keyword. Available inputs:',
          JSON.stringify(fields)
        );
      }
    }

    if (!skipSearchSubmit) {
      await page.getByRole('button', { name: /^recherche$/i }).click();
    }

    // Wait for page 1's results to actually render before reading the URL below — jobup.ch syncs
    // it (adding the real `term`) asynchronously after "Recherche"; reading it too early was
    // confirmed live to capture a stale/bare `term=` (see CLAUDE.md's pagination gotcha, which hit
    // the exact same issue for a different reason) and lock that in permanently once we navigate
    // again below. Skipped when skipSearchSubmit is set — the recovery branch above already waited
    // for results after its own direct navigation.
    if (!skipSearchSubmit) {
      await waitForJobResults(page, anyJobResult, '1');
    }

    // Applying "Utiliser ma localisation" by clicking through jobup.ch's own UI proved unreliable
    // on both search-entry paths — see CLAUDE.md's location-widget gotcha for the full history.
    // Confirmed live instead: `location=<slug>` is a real, server-recognized query param —
    // appending it to the results URL and navigating there returns genuinely filtered, exactly
    // accurate results on the basic-search recovery path specifically.
    //
    // This does NOT work on the direct-CTA path, though: confirmed live, re-navigating that same
    // page via `page.goto()` to add `location=...` reliably triggers ERR_TOO_MANY_REDIRECTS, even
    // with a drastically shortened `term` (ruling out URL length as the cause) — a genuine
    // CTA-session/page incompatibility with fresh navigation (matching the earlier `page=N`
    // pagination finding), not something fixable by adjusting the URL. **Known limitation**: use
    // `useBasicSearch` (the frontend's "Use basic search" checkbox) for a location-filtered
    // search; the direct-CTA path's results are profile/term-matched but not location-narrowed.
    if (searchWithProfilePath.startsWith('subNavTab')) {
      const locationUrl = new URL(page.url());
      if (!locationUrl.searchParams.get('location')) {
        appendLocations(locationUrl, effectiveLocations);
        await page.goto(locationUrl.toString());
        // Fresh navigation — wait for its results to render too, same reasoning as above.
        await waitForJobResults(page, anyJobResult, '1 (with location)');
      }
    } else {
      console.error(
        'direct-CTA path: skipping location filtering (known unresolved limitation ' +
          '— see CLAUDE.md); results below are not location-filtered.'
      );
    }

    // The total match count ("<N> offres d'emploi") appears as text near the top of the results
    // page and stays constant across pagination, so it's read once here. Not critical to the rest
    // of the flow — if it can't be found/parsed, this just logs and moves on with `null` rather
    // than failing the whole run over a supplementary piece of information.
    let totalJobsCount = null;
    try {
      const jobCountText = await page.getByText(/[\d'.,\s]+offres? d'emploi/i).first().textContent({ timeout: 10000 });
      const digits = (jobCountText.match(/[\d'.,\s]+(?=offres? d'emploi)/i) || [])[0];
      const parsed = digits ? Number(digits.replace(/\D/g, '')) : NaN;
      totalJobsCount = Number.isFinite(parsed) ? parsed : null;
    } catch {
      console.error('could not find/parse the "... offres d\'emploi" total job-count text.');
    }

    // Confirmed live: that "... offres d'emploi" text can be wrong on a small result set (seen:
    // parsed as 1 while 3 distinct job cards actually rendered on the page) — the text apparently
    // reflects a different count than what's actually rendered in this case. Whenever the parsed
    // total is small enough that every match fits on this one page (<= JOBS_PER_PAGE, so no
    // pagination is involved and every matching card is already in the DOM right here), the actual
    // rendered job cards are counted directly and trusted over that text instead.
    if (totalJobsCount !== null && totalJobsCount <= JOBS_PER_PAGE) {
      const dataCyElements = await dataCyJobLinks.all();
      const jobElements = dataCyElements.length > 0 ? dataCyElements : await articleJobLinks.all();
      const hrefs = await Promise.all(jobElements.map((el) => el.getAttribute('href')));
      const { deduped } = dedupeByHref(jobElements.map((el, i) => ({ href: hrefs[i] })));
      if (deduped.length !== totalJobsCount) {
        console.error(
          '"... offres d\'emploi" text said ' + totalJobsCount + ' but ' +
            deduped.length + ' distinct job card(s) are actually rendered on this page — using the ' +
            'DOM count instead.'
        );
        totalJobsCount = deduped.length;
      }
    }

    const resultsUrlLocationParam = (() => {
      try {
        return new URL(page.url()).searchParams.get('location');
      } catch {
        return null;
      }
    })();
    console.error(
      'totalJobsCount:', totalJobsCount,
      'search entry path:', searchWithProfilePath,
      'location param:', JSON.stringify(resultsUrlLocationParam),
      'results URL:', page.url()
    );

    const resultsUrl = page.url();

    // Saves cookies + localStorage so each per-job worker (scripts/jobup-cv-match.js) can load
    // this same authenticated session into its own fresh browser via
    // `browser.newContext({ storageState: storageStatePath })`, without repeating the login UI
    // flow. Captured at the very end (not right after login) so it also picks up whatever
    // additional state the search flow itself set. Confirmed live: parallel workers loading this
    // file land on the authenticated results page with no login-page fallback.
    const storageStatePath = path.join(os.tmpdir(), 'jobup-session-' + crypto.randomUUID() + '.json');
    await page.context().storageState({ path: storageStatePath });

    return {
      success: true,
      errorMessage: null,
      totalJobsCount,
      resultsUrl,
      storageStatePath
    };
  } catch (err) {
    if (err instanceof EmptyResultsError) {
      const message =
        "0 job found, search term : '" + effectiveSearchTerm +
        "', locations : '" + effectiveLocations.join(', ') + "'";
      console.error(message);
      return {
        success: false,
        errorMessage: message,
        totalJobsCount: 0,
        resultsUrl: page ? page.url() : null,
        storageStatePath: null
      };
    }
    throw err;
  } finally {
    await browser.close();
    activeBrowser = null;
  }
}

module.exports = { runSearch };

// Only run as a standalone CLI when invoked directly (`node scripts/jobup-search.js`) — this is
// how routes/api.js spawns it, as a child process, once per POST /api/cv-match request.
if (require.main === module) {
  (async () => {
    const useBasicSearch = process.argv[2] === 'true' || process.argv[2] === '1';
    const searchTerm = process.argv[3] || '';
    let locations = [];
    try {
      const parsedLocations = JSON.parse(process.argv[4] || '[]');
      locations = Array.isArray(parsedLocations) ? parsedLocations : [];
    } catch {
      locations = [];
    }
    const useJobsCh = process.argv[5] === 'true' || process.argv[5] === '1';
    // Same site-matching credential pair as scripts/jobup-login.js's own CLI block — routes/api.js
    // reads and overrides the matching pair fresh from .env on every request (see its own
    // readCurrentJobupCredentials()) so a login done through either checkbox is picked up here.
    const emailVar = useJobsCh ? 'JOBSCH_EMAIL' : 'JOBUP_EMAIL';
    const passwordVar = useJobsCh ? 'JOBSCH_PASSWORD' : 'JOBUP_PASSWORD';
    const email = process.env[emailVar];
    const password = process.env[passwordVar];

    if (!email || !password) {
      console.error(emailVar + ' and ' + passwordVar + ' environment variables are required.');
      process.stdout.write(
        JSON.stringify({ success: false, errorMessage: null, totalJobsCount: null, resultsUrl: null, storageStatePath: null })
      );
      return;
    }

    try {
      const result = await runSearch(email, password, useBasicSearch, searchTerm, locations, useJobsCh);
      process.stdout.write(JSON.stringify(result));
    } catch (err) {
      // Deliberately not a raw `console.error(err)` — see scripts/jobup-login.js's matching
      // comment for why (it dumps a multi-line error object as an opaque blob; this doesn't).
      // No '[jobup-search]' prefix either — routes/api.js prepends that once when it forwards
      // this script's stderr to the backend console.
      console.error('search automation failed unexpectedly: ' + err.name + ': ' + err.message);
      process.stdout.write(
        JSON.stringify({ success: false, errorMessage: null, totalJobsCount: null, resultsUrl: null, storageStatePath: null })
      );
    }
  })();
}
