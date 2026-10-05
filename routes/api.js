var express = require('express');
var path = require('path');
var fs = require('fs');
var dotenv = require('dotenv');
var execFile = require('child_process').execFile;
var router = express.Router();

// process.cwd() rather than __dirname: `npm run build` (see build.js at the repo root) bundles
// this file's code together with app.js (and the other routes/*.js files) into a single output
// file whose __dirname, at runtime, is wherever that bundled file physically lands — not this
// source file's original `routes/` directory. This file's own paths assumed exactly one level of
// nesting under the repo root (`path.join(__dirname, '..', ...)`), which silently breaks once
// merged into a bundle that isn't nested that same one level deep (e.g. a flattened, root-level
// bundle file would resolve '..' one level too far, looking for scripts/ and .env *outside* the
// deployed dist/ folder entirely). process.cwd() has no such dependency on how deeply nested the
// bundled file ends up — it works identically for the unbundled source (`npm start`, always run
// from the repo root — see CLAUDE.md) and the bundled dist/ output (expected to be started from
// its own root the same way).
var APP_ROOT = process.cwd();
var ENV_PATH = path.join(APP_ROOT, '.env');

// execFile timeout for the one-time login + search step (scripts/jobup-search.js).
var SEARCH_SCRIPT_TIMEOUT_MS = 180000;

// Reads the CURRENT credentials straight from the .env file on disk — not from this process's own
// `process.env`, which dotenv only populated once, at server startup, via app.js's
// `require('dotenv').config()`. scripts/jobup-login.js rewrites that file in place on a successful
// login (see its own comment), and every POST /cv-match spawns a brand-new jobup-search.js child
// process, so re-reading the file fresh on every request here is what lets a freshly-entered login
// take effect immediately, with no backend restart needed. Falls back to this process's own
// process.env (what dotenv loaded at startup) if the file is missing or unreadable.
//
// `useJobsCh` picks which pair is read — JOBSCH_EMAIL/JOBSCH_PASSWORD or JOBUP_EMAIL/JOBUP_PASSWORD
// (the original, default pair) — matching whichever site this request's own "Use www.jobs.ch"
// checkbox selected, and returns it under that same key name so the spawned child's env override
// (see runSearchScript() below) hands scripts/jobup-search.js exactly the variable name its own
// CLI block reads for that site.
function readCurrentJobupCredentials(useJobsCh) {
  var emailVar = useJobsCh ? 'JOBSCH_EMAIL' : 'JOBUP_EMAIL';
  var passwordVar = useJobsCh ? 'JOBSCH_PASSWORD' : 'JOBUP_PASSWORD';
  var result = {};
  try {
    var parsed = dotenv.parse(fs.readFileSync(ENV_PATH, 'utf8'));
    result[emailVar] = parsed[emailVar] || process.env[emailVar];
    result[passwordVar] = parsed[passwordVar] || process.env[passwordVar];
  } catch (err) {
    result[emailVar] = process.env[emailVar];
    result[passwordVar] = process.env[passwordVar];
  }
  return result;
}

// Tracks every child process (the one-time jobup-search.js run, plus each parallel
// jobup-cv-match.js worker) spawned for the single currently-in-flight /cv-match request (this
// app's UI only ever lets one analysis run at a time — the CV Analysis button disables while
// pending — so one slot is enough) so POST /cv-match/stop has something to kill. `{ processes,
// stoppedByUser }` while a request is in flight, `null` otherwise — `processes` is a Set so
// members can be added/removed as each child starts/exits without needing to track array indices.
// `stoppedByUser` is checked between worker batches (see runWorkersInBatches()) so a stop mid-range
// doesn't keep launching more workers, and distinguishes an explicit user-requested stop from
// execFile's own `timeout` option killing a run that simply took too long — both look identical to
// Node (the process was killed) but only the former should be reported to the frontend as
// "Analysis stopped by user." instead of the generic failure the timeout case already produces.
var runningCvMatch = null;

// On Windows, taskkill's /T (tree) /F (force) flags are the only reliable way to take down both
// a spawned node process AND anything IT spawned (e.g. the Playwright-launched Chromium browser)
// — Windows has no POSIX process-group signal for child_process to target directly.
//
// Confirmed live (an earlier version of this function called child.kill() first, before taskkill,
// specifically to mark the ChildProcess as killed for detection purposes): that raced against
// taskkill and defeated it. child.kill() terminates the node process almost immediately (Windows
// TerminateProcess), and by the time the async taskkill call actually reached the OS, that PID no
// longer existed for taskkill to find at all (`Erreur : le processus "<pid>" est introuvable`) —
// which meant /T never got a chance to walk its still-alive-at-that-point child tree, so the
// browser subprocess was silently left orphaned even though the analysis appeared to stop cleanly.
// The `err.killed`-marking purpose child.kill() originally served here was made obsolete anyway
// once `stoppedByUser` (set in the /cv-match/stop handler) became the actual signal callers use to
// detect a user-requested stop — so it's dropped entirely here rather than reordered, and taskkill
// alone (while the process tree is still alive) does the real killing. Confirmed live (follow-up
// run): with this ordering, taskkill succeeds silently (no error logged) and a live process
// inspection immediately afterward showed the stopped run's PID fully gone with no orphaned
// browser process left under it.
function killProcessTree(child) {
  if (!child || child.pid == null) {
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], function(killErr) {
      if (killErr) {
        console.error('[jobup-cv-match] taskkill for pid ' + child.pid + ' (stop cleanup):', killErr.message);
      }
    });
  } else {
    child.kill('SIGTERM');
  }
}

// Spawns `command` with `args`/`options` via execFile, tracking the child in `current.processes`
// for the duration of the call (added synchronously right after execFile returns the ChildProcess,
// removed once its callback fires) so POST /cv-match/stop can find and kill it while it's running.
// Wraps the callback-based execFile API in a Promise so callers can simply `await` it — needed
// here (unlike the old single-script /cv-match handler) because this file now has to run one
// script, then several more afterward, in a specific order.
function spawnScript(current, command, args, options) {
  return new Promise(function(resolve) {
    var child = execFile(command, args, options, function(err, stdout, stderr) {
      current.processes.delete(child);
      resolve({ stdout: stdout, stderr: stderr, err: err });
    });
    current.processes.add(child);
  });
}

// Runs scripts/jobup-search.js once — the one-time login + job-search step, shared across every
// job index in the requested range (see the root CLAUDE.md's "jobup.ch CV-match automation"
// section for the full split). Parses its stdout JSON the same defensive way every other script
// invocation in this file does: default to a "nothing happened" shape if parsing fails.
async function runSearchScript(current, useBasicSearch, searchTerm, locations, useJobsCh) {
  var scriptPath = path.join(APP_ROOT, 'scripts', 'jobup-search.js');
  var spawned = await spawnScript(
    current,
    'node',
    [scriptPath, String(useBasicSearch), searchTerm, JSON.stringify(locations), String(useJobsCh)],
    {
      // Raised from 90s: confirmed live, the sub-nav-tab fallback path (25s + 15s + 10s CTA waits
      // before even reaching the tab, then mode detection, the profile-button re-check, and the
      // direct-URL navigation) plus login can legitimately exceed 90s, which killed the script
      // with empty stdout and surfaced only as an opaque "could not parse script output".
      timeout: SEARCH_SCRIPT_TIMEOUT_MS,
      env: Object.assign({}, process.env, readCurrentJobupCredentials(useJobsCh))
    }
  );
  if (spawned.stderr) {
    console.error('[jobup-search]', spawned.stderr.trim());
  }

  var result = { success: false, errorMessage: null, totalJobsCount: null, resultsUrl: null, storageStatePath: null };
  if (spawned.err && spawned.err.killed && !current.stoppedByUser) {
    console.error('[jobup-search] search script timed out after ' + (SEARCH_SCRIPT_TIMEOUT_MS / 1000) + 's and was killed.');
    result.errorMessage = 'The job search took too long and was stopped';
    return result;
  }
  try {
    var parsed = JSON.parse(spawned.stdout.trim());
    result.success = !!parsed.success;
    result.errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
    result.totalJobsCount = typeof parsed.totalJobsCount === 'number' ? parsed.totalJobsCount : null;
    result.resultsUrl = typeof parsed.resultsUrl === 'string' ? parsed.resultsUrl : null;
    result.storageStatePath = typeof parsed.storageStatePath === 'string' ? parsed.storageStatePath : null;
  } catch (parseErr) {
    if (!current.stoppedByUser) {
      console.error('[jobup-search] could not parse script output:', spawned.stdout);
    }
  }
  return result;
}

// Runs scripts/jobup-cv-match.js once for a single job index — this is the per-job worker, spawned
// once per index in the requested range and run several at a time (see runWorkersInBatches()).
// Doesn't need JOBUP_EMAIL/JOBUP_PASSWORD at all (no `env` override passed): the worker never logs
// in itself, it loads the `storageState` runSearchScript() already saved.
async function runWorkerScript(current, resultsUrl, storageStatePath, jobIndex, saveJob, easyApply, ignoreYellowMeter) {
  var scriptPath = path.join(APP_ROOT, 'scripts', 'jobup-cv-match.js');
  var spawned = await spawnScript(
    current,
    'node',
    [
      scriptPath,
      resultsUrl,
      storageStatePath,
      String(jobIndex),
      String(saveJob),
      String(easyApply),
      String(ignoreYellowMeter)
    ],
    { timeout: 300000 }
  );
  if (spawned.stderr) {
    console.error('[jobup-cv-match]', spawned.stderr.trim());
  }

  var result = {
    jobIndex: jobIndex,
    success: false,
    analysis: null,
    meter: null,
    criteria: [],
    jobUrl: null,
    errorMessage: null,
    applicationUrl: null
  };
  try {
    var parsed = JSON.parse(spawned.stdout.trim());
    result.success = !!parsed.success;
    result.analysis = parsed.analysis || null;
    result.meter = parsed.meter || null;
    result.criteria = Array.isArray(parsed.criteria) ? parsed.criteria : [];
    result.jobUrl = parsed.jobUrl || null;
    result.errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
    result.applicationUrl = typeof parsed.applicationUrl === 'string' ? parsed.applicationUrl : null;
  } catch (parseErr) {
    if (!current.stoppedByUser) {
      console.error('[jobup-cv-match] could not parse script output for jobIndex ' + jobIndex + ':', spawned.stdout);
    }
  }
  return result;
}

// Runs one jobup-cv-match.js worker per entry in `indexes`, `batchSize` at a time (`Promise.all`
// per batch, batches run sequentially) — the user chose a capped batch size over full, unbounded
// parallelism specifically because jobup.ch has documented CAPTCHA/rate-limit sensitivity to
// bursts of automated activity (see CLAUDE.md), which firing every worker at once for a wide
// index range would risk. Checks `current.stoppedByUser` before starting each new batch so a stop
// mid-range doesn't keep launching more workers than are already in flight.
async function runWorkersInBatches(current, indexes, resultsUrl, storageStatePath, saveJob, easyApply, ignoreYellowMeter, batchSize) {
  var results = [];
  for (var i = 0; i < indexes.length; i += batchSize) {
    if (current.stoppedByUser) {
      break;
    }
    var batch = indexes.slice(i, i + batchSize);
    var batchResults = await Promise.all(
      batch.map(function(jobIndex) {
        return runWorkerScript(current, resultsUrl, storageStatePath, jobIndex, saveJob, easyApply, ignoreYellowMeter);
      })
    );
    results = results.concat(batchResults);
  }
  return results;
}

// Best-effort delete of the temp storageState file runSearchScript() created — never needed again
// once every worker that might use it has finished (or the request bailed out before spawning any).
function deleteStorageState(storageStatePath) {
  if (!storageStatePath) {
    return;
  }
  fs.unlink(storageStatePath, function(unlinkErr) {
    if (unlinkErr) {
      console.error('[jobup-cv-match] failed to delete temp session file ' + storageStatePath + ':', unlinkErr.message);
    }
  });
}

// The /cv-match handler below now runs for however long the search + every worker batch takes —
// noticeably longer than the old single-script flow, and long enough that the client (the
// frontend's onStopClick(), which unsubscribes from this same HTTP request — see
// frontend/CLAUDE.md) can easily have disconnected before this async function finally reaches a
// `res.json(...)` call. Writing to an already-aborted connection doesn't need to be fatal, so every
// response below goes through this instead of a bare `res.json(...)` — the same
// `res.headersSent`/`res.writableEnded` guard the pre-split single-process version of this handler
// already used for the exact same reason.
function sendJsonIfStillConnected(res, body) {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.json(body);
}

var OUT_OF_RANGE_ERROR_MESSAGE = 'Job index must not be greater than the number of jobs found on that page';

/* GET backend health status, used by the Angular frontend to verify connectivity. */
router.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'express-backend', timestamp: new Date().toISOString() });
});

/*
 * POST triggers the jobup.ch (or, with `useJobsCh`, jobs.ch) login automation as a background
 * process (see scripts/jobup-login.js), waits for it to finish, and reports the outcome as a
 * display string. Takes `email`/`password` in the body, from the frontend's Email/Password inputs
 * next to the Login button (native `type="email"`/`required` HTML validators on those fields keep
 * an empty or malformed value from ever reaching this endpoint in the first place), plus
 * `useJobsCh` from the "Use www.jobs.ch" checkbox next to that same button — passed to the script
 * via its spawned environment, overriding whatever this server process's own JOBUP_EMAIL/
 * JOBUP_PASSWORD (or JOBSCH_EMAIL/JOBSCH_PASSWORD, matching `useJobsCh`) currently are, so each
 * attempt uses exactly what the user just typed rather than a stale value.
 * On success, scripts/jobup-login.js itself rewrites the .env file with these same credentials,
 * under that same site-matching variable name (see its own comment for how) so subsequent
 * POST /cv-match runs pick them up too, via readCurrentJobupCredentials() above — no server restart
 * needed; on failure, .env is left completely untouched.
 * `message` is `'Login succeeded !'` on success, else the script's own `errorMessage` when it's a
 * specific, known failure (a `LoginValidationError` subclass in scripts/jobup-login.js —
 * currently `'Invalid login credentials'`, when jobup.ch itself rejected the email/password, or
 * `'Invalid email format'`, when Auth0's own client-side validator rejected the typed email) — or
 * the generic `'Login failed !'` for anything else (a genuinely unexpected error, or the email/
 * password missing from the request body).
 */
router.post('/login', function(req, res) {
  var scriptPath = path.join(APP_ROOT, 'scripts', 'jobup-login.js');
  var email = (req.body && typeof req.body.email === 'string') ? req.body.email.trim() : '';
  var password = (req.body && typeof req.body.password === 'string') ? req.body.password : '';
  var useJobsCh = !!(req.body && req.body.useJobsCh);

  if (!email || !password) {
    return res.json({ success: false, message: 'Login failed !' });
  }

  var emailVar = useJobsCh ? 'JOBSCH_EMAIL' : 'JOBUP_EMAIL';
  var passwordVar = useJobsCh ? 'JOBSCH_PASSWORD' : 'JOBUP_PASSWORD';
  var envOverride = {};
  envOverride[emailVar] = email;
  envOverride[passwordVar] = password;

  execFile(
    'node',
    [scriptPath, String(useJobsCh)],
    {
      timeout: 60000,
      env: Object.assign({}, process.env, envOverride)
    },
    function(err, stdout, stderr) {
      if (stderr) {
        console.error('[jobup-login]', stderr.trim());
      }

      var success = false;
      var errorMessage = null;
      try {
        var parsed = JSON.parse(stdout.trim());
        success = !!parsed.success;
        errorMessage = typeof parsed.errorMessage === 'string' ? parsed.errorMessage : null;
      } catch (parseErr) {
        console.error('[jobup-login] could not parse script output:', stdout);
      }

      res.json({ success: success, message: success ? 'Login succeeded !' : (errorMessage || 'Login failed !') });
    }
  );
});

/*
 * POST triggers the jobup.ch job-search + CV-match automation for a *range* of job indexes
 * (`startJobIndex`..`endJobIndex`, both 1-based and inclusive). Logs in and runs the search only
 * once (scripts/jobup-search.js), then runs scripts/jobup-cv-match.js once per job index in the
 * range, in parallel batches of 5 (see runWorkersInBatches()) — each worker loads the one-time
 * login's saved session via a temp `storageState` file rather than logging in again itself. See
 * the root CLAUDE.md's "jobup.ch CV-match automation" section for the full split and its
 * unverified pieces.
 *
 * Also takes `useBasicSearch`, `searchTerm`, `locations`, `saveJob`, `easyApply`,
 * `ignoreYellowMeter` exactly as the single-job endpoint used to (see git history / CLAUDE.md for
 * their individual meanings — unchanged by this split), plus `useJobsCh`: drives www.jobs.ch
 * instead of www.jobup.ch for this request's search + every one of its workers (see the frontend's
 * "Use www.jobs.ch" checkbox and CLAUDE.md's "jobup.ch CV-match automation" section).
 *
 * Responds with `{ success, errorMessage, totalJobsCount, resultsUrl, results }`:
 * - `totalJobsCount`/`resultsUrl` come from the one-time search and are included whenever the
 *   search itself actually ran, even on a failure below it (an invalid index range, or jobup.ch
 *   itself reporting 0 matching jobs) — knowing the search's own outcome is still useful context.
 * - `errorMessage` is a specific, expected, request-level failure — the search's own
 *   `LoginValidationError`/0-results message, `'The Start and End job indexes must be a strictly
 *   positive integer'` (either isn't a strictly positive integer), `'The End job index must not be
 *   lower than the Start job index'`, or `'Start job index must not be greater than the number of
 *   jobs'` (checked against the search's own `totalJobsCount` when known, else falls back to
 *   `startJobIndex`'s own worker result — see that check's own comment below for why both exist)
 *   — or `null` when `success` is true.
 * - `results` is one entry per job index actually analyzed — `{ jobIndex, success, analysis,
 *   meter, criteria, jobUrl, errorMessage, applicationUrl }` each, same shape the single-job
 *   endpoint used to return at the top level. Empty whenever `success` is false. An index *other*
 *   than `startJobIndex` that turns out to be beyond the number of jobs on its own target page is
 *   silently omitted from this array rather than reported as an error (only `startJobIndex`'s own
 *   out-of-range case is a hard, request-level failure).
 */
router.post('/cv-match', async function(req, res) {
  var useBasicSearch = !!(req.body && req.body.useBasicSearch);
  var searchTerm = (req.body && typeof req.body.searchTerm === 'string')
    ? req.body.searchTerm.trim().slice(0, 255)
    : '';
  var locations = (req.body && Array.isArray(req.body.locations))
    ? req.body.locations
        .filter(function(location) { return typeof location === 'string' && location.trim(); })
        .map(function(location) { return location.trim().slice(0, 255); })
    : [];
  var saveJob = !!(req.body && req.body.saveJob);
  var easyApply = !!(req.body && req.body.easyApply);
  var ignoreYellowMeter = !!(req.body && req.body.ignoreYellowMeter);
  var useJobsCh = !!(req.body && req.body.useJobsCh);
  var startJobIndex = Number(req.body && req.body.startJobIndex);
  var endJobIndex = Number(req.body && req.body.endJobIndex);

  var current = { processes: new Set(), stoppedByUser: false };
  runningCvMatch = current;

  try {
    var searchResult = await runSearchScript(current, useBasicSearch, searchTerm, locations, useJobsCh);

    if (!searchResult.success) {
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: searchResult.errorMessage,
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    // Narrow race: stop was requested in the brief window between the search finishing and any
    // worker starting. runWorkersInBatches() below covers every later point (between batches).
    if (current.stoppedByUser) {
      deleteStorageState(searchResult.storageStatePath);
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: 'Analysis stopped by user.',
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    var indexesAreValid =
      Number.isInteger(startJobIndex) && startJobIndex >= 1 &&
      Number.isInteger(endJobIndex) && endJobIndex >= 1;
    if (!indexesAreValid) {
      deleteStorageState(searchResult.storageStatePath);
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: 'The Start and End job indexes must be a strictly positive integer',
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    if (endJobIndex < startJobIndex) {
      deleteStorageState(searchResult.storageStatePath);
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: 'The End job index must not be lower than the Start job index',
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    // Confirmed live: startJobIndex=50/endJobIndex=51 against a totalJobsCount of 29 (a
    // multi-page result set — targetPage = ceil(50/20) = 3, but only 2 real pages existed)
    // returned a real, WRONG job instead of the expected out-of-range error. jobup.ch didn't
    // throw or render an empty page for the out-of-range `?page=3` request — it silently served
    // some other, valid page instead, so the worker's own "does this page have enough jobs" check
    // (previously assumed authoritative over totalJobsCount — see the worker's own pagination
    // comment) passed against *that* page and returned one of its real jobs. So a worker's own
    // page-navigation outcome can't be trusted alone once jobIndex's targetPage already exceeds
    // the real number of pages. totalJobsCount's only confirmed inaccuracy is UNDER-counting a
    // single-page (≤JOBS_PER_PAGE) result set (see scripts/jobup-search.js's own comment) — that
    // doesn't apply once startJobIndex needs pagination (targetPage > 1) at all, so it's trusted
    // as a hard cap here specifically to catch this case before ever spawning a worker for it.
    if (searchResult.totalJobsCount != null && startJobIndex > searchResult.totalJobsCount) {
      deleteStorageState(searchResult.storageStatePath);
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: 'Start job index must not be greater than the number of jobs',
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    // startJobIndex is always included below regardless of this clamp — when totalJobsCount is
    // null (parse failure) the check above can't run, so the worker's own real, per-page check is
    // the fallback authority for "out of range" in that case. The clamp exists purely so a
    // wildly-oversized endJobIndex doesn't spawn far more workers than could possibly find a real
    // job, each just to independently discover the same "out of range" result.
    var clampedEnd = searchResult.totalJobsCount != null
      ? Math.min(endJobIndex, searchResult.totalJobsCount)
      : endJobIndex;
    var finalEnd = Math.max(clampedEnd, startJobIndex);

    var indexesToRun = [];
    for (var i = startJobIndex; i <= finalEnd; i++) {
      indexesToRun.push(i);
    }

    var jobResults = await runWorkersInBatches(
      current,
      indexesToRun,
      searchResult.resultsUrl,
      searchResult.storageStatePath,
      saveJob,
      easyApply,
      ignoreYellowMeter,
      5
    );

    deleteStorageState(searchResult.storageStatePath);

    var startResult = jobResults.filter(function(r) { return r.jobIndex === startJobIndex; })[0];
    if (startResult && startResult.errorMessage === OUT_OF_RANGE_ERROR_MESSAGE) {
      return sendJsonIfStillConnected(res, {
        success: false,
        errorMessage: 'Start job index must not be greater than the number of jobs',
        totalJobsCount: searchResult.totalJobsCount,
        resultsUrl: searchResult.resultsUrl,
        results: []
      });
    }

    var filteredResults = jobResults.filter(function(r) { return r.errorMessage !== OUT_OF_RANGE_ERROR_MESSAGE; });

    sendJsonIfStillConnected(res, {
      success: true,
      errorMessage: null,
      totalJobsCount: searchResult.totalJobsCount,
      resultsUrl: searchResult.resultsUrl,
      results: filteredResults
    });
  } finally {
    if (runningCvMatch === current) {
      runningCvMatch = null;
    }
  }
});

/*
 * POST stops the currently-running /cv-match request (see runningCvMatch above), if any — used by
 * the frontend's "Stop analysis" button, which is only enabled while an analysis is pending. Kills
 * every child process currently tracked for that request (the search process, and/or whichever
 * worker(s) are in the current batch — on Windows, each via its whole process tree via taskkill, so
 * a Playwright-launched browser doesn't get left running orphaned — see killProcessTree()'s
 * comment) and marks `stoppedByUser` so runWorkersInBatches() doesn't start any further batches.
 * The already-in-flight POST /cv-match request itself still eventually responds (once every
 * already-spawned child has actually exited) — but the frontend has already unsubscribed from
 * that request by the time it calls this endpoint, so in practice that response is only ever
 * meaningful for logging and isn't relied on to update the UI.
 */
router.post('/cv-match/stop', function(req, res) {
  if (!runningCvMatch) {
    console.error('[jobup-cv-match] stop requested but no analysis is currently running.');
    return res.json({ stopped: false });
  }

  var current = runningCvMatch;
  current.stoppedByUser = true;
  console.error(
    '[jobup-cv-match] stop requested by user; killing ' + current.processes.size + ' running process(es).'
  );
  current.processes.forEach(function(child) {
    killProcessTree(child);
  });
  runningCvMatch = null;
  res.json({ stopped: true });
});

/*
 * POST receives the CV match analysis data produced by scripts/jobup-cv-match.js and stores it —
 * `meter`/`criteria` are optional (only sent alongside a real analysis run) and, like `analysis`,
 * aren't persisted anywhere yet beyond this log line.
 */
router.post('/cv-analysis', function(req, res) {
  var analysis = req.body && req.body.analysis;

  if (typeof analysis !== 'string' || !analysis.trim()) {
    return res.status(400).json({ message: 'analysis text is required' });
  }

  console.log('[cv-analysis]', new Date().toISOString(), analysis);
  if (req.body && (req.body.meter || req.body.criteria)) {
    console.log('[cv-analysis] meter:', JSON.stringify(req.body.meter), 'criteria:', JSON.stringify(req.body.criteria));
  }

  res.json({ received: true });
});

module.exports = router;
