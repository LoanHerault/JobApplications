import { afterNextRender, Component, HostListener, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Subscription } from 'rxjs';

import { Api, AnalysisCriterion, AnalysisMeter, CvMatchJobResult } from './services/api';

type AnalysisListItem = { text: string; status: 'green' | 'yellow' | 'gray' | null };

type AnalysisSegment =
  | { type: 'heading'; text: string; level: 'title' | 'section' }
  | { type: 'meter'; color: 'green' | 'yellow' | null; percent: number | null }
  | { type: 'list'; items: AnalysisListItem[] }
  | { type: 'paragraph'; text: string };

const BULLET_PATTERN = /^[-•*]\s+(.*)$/;
const NUMBERED_PATTERN = /^\d+[.)]\s+(.*)$/;
const COLON_HEADING_PATTERN = /^.{1,70}:$/;
const SHORT_QUESTION_PATTERN = /^.{1,45}\?$/;

// jobup.ch's own CV-match modal always groups criteria under fixed section labels (see the "Un
// bon départ" screenshots), regardless of what the AI-generated verdict/criteria text says — so
// they're recognized by name rather than guessed at structurally. Confirmed live: the wording
// isn't fixed after all — a "C'est très bien" (strong-match) verdict uses the bare "Connaissances,
// qualifications et compétences" heading, without the "importantes" suffix every prior sample had
// (jobIndex 35/44). Matched by prefix rather than an exact string for this reason; an exact match
// missing this heading silently broke BOTH the meter (only inserted once a section heading is
// detected) and the criteria list (every line falls through to a plain paragraph instead of a list
// item while `inSection` is false) — not two separate bugs, one shared root cause.
const KNOWN_SECTION_HEADING_PREFIXES = [
  'connaissances, qualifications et compétences',
  'autres demandes'
];

function isSectionHeading(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    KNOWN_SECTION_HEADING_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    COLON_HEADING_PATTERN.test(line) ||
    SHORT_QUESTION_PATTERN.test(line)
  );
}

// Past this point the modal is just jobup.ch's own boilerplate footer (which CV was used, the
// "Analysez un autre CV" link, the usefulness survey, the AI disclaimer, "Fermer") rather than
// analysis content — none of it should be styled as a heading or list item, so parsing stops the
// moment either fixed lead-in is seen.
const STOP_MARKERS = [
  "l'évaluation est basée sur le cv suivant",
  'avez-vous trouvé cela utile'
];

function isStopMarker(line: string): boolean {
  const normalized = line.toLowerCase();
  return STOP_MARKERS.some((marker) => normalized.startsWith(marker));
}

// A weaker/partial match can render a tabbed layout inside the analysis modal (see the root
// CLAUDE.md's "Résultat" tab gotcha) — the tab UI's own chrome ("Emplois recommandés (N)", the
// alternatives-widget section label, and "Résultat", the clicked tab's own label) stays in the
// modal's plain-text innerText read even after clicking through to this job's own tab, ahead of
// its real content. Neither is analysis content, so both are dropped rather than rendered as a
// stray paragraph above the meter/checklist.
const RECOMMENDED_JOBS_HEADING_PATTERN = /^emplois recommandés\s*\(\d+\)$/i;

function isTabChromeLine(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  return normalized === 'résultat' || RECOMMENDED_JOBS_HEADING_PATTERN.test(normalized);
}

// scripts/jobup-cv-match.js reads each criterion's real status (green/yellow/gray) straight from
// its icon's color class, separately from the plain-text analysis blob below — so a checklist
// line here is matched back to its criterion by text containment rather than trusting line order
// (a criterion with an explanation reads as two separate lines below — title, then explanation —
// while extractAnalysisStructure() captured them together as that criterion's one text block).
function findCriterionStatus(
  line: string,
  criteria: readonly AnalysisCriterion[]
): 'green' | 'yellow' | 'gray' | null {
  const normalized = line.trim();
  if (!normalized) {
    return null;
  }
  for (const criterion of criteria) {
    const text = criterion.text.trim();
    if (text === normalized || text.includes(normalized) || normalized.includes(text)) {
      return criterion.status;
    }
  }
  return null;
}

// The AI CV-match analysis comes back from the backend as one plain-text blob (see
// scripts/jobup-cv-match.js's readAnalysisAndClose(), which reads the whole modal's innerText) —
// this recovers its structure: the first line is jobup's bold verdict title ("Un bon départ"); a
// known section label (or a short ":"/"?"-terminated line) starts a new heading; every other line
// found after a heading is one checklist row, rendered as a list item (colored via `criteria`, see
// findCriterionStatus() above); lines before the first heading (the verdict's intro sentence) stay
// as their own paragraph. The overall-match meter (`meter`, read from the fill bar's own color/
// width, not text) is inserted once, right before the first section heading.
function parseAnalysis(
  raw: string,
  criteria: readonly AnalysisCriterion[],
  meter: AnalysisMeter | null
): AnalysisSegment[] {
  const segments: AnalysisSegment[] = [];
  let listItems: AnalysisListItem[] | null = null;
  let sawTitle = false;
  let inSection = false;
  let meterInserted = false;

  const flushList = () => {
    if (listItems && listItems.length > 0) {
      segments.push({ type: 'list', items: listItems });
    }
    listItems = null;
  };
  const pushListItem = (text: string) => {
    listItems ??= [];
    listItems.push({ text, status: findCriterionStatus(text, criteria) });
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (isStopMarker(line)) {
      break;
    }
    if (isTabChromeLine(line)) {
      continue;
    }

    const bulletMatch = line.match(BULLET_PATTERN) ?? line.match(NUMBERED_PATTERN);
    if (bulletMatch) {
      pushListItem(bulletMatch[1]);
      continue;
    }

    if (!sawTitle) {
      segments.push({ type: 'heading', text: line, level: 'title' });
      sawTitle = true;
      continue;
    }

    if (isSectionHeading(line)) {
      flushList();
      if (meter && !meterInserted) {
        segments.push({ type: 'meter', color: meter.color, percent: meter.percent });
        meterInserted = true;
      }
      segments.push({ type: 'heading', text: line, level: 'section' });
      inSection = true;
      continue;
    }

    if (inSection) {
      pushListItem(line);
      continue;
    }

    segments.push({ type: 'paragraph', text: line });
  }
  flushList();

  return segments;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  private readonly api = inject(Api);

  protected readonly title = signal('Job Applications');
  protected readonly backendStatus = signal<'checking' | 'connected' | 'unreachable'>('checking');
  protected readonly loginPending = signal(false);
  protected readonly loginResult = signal<string | null>(null);
  protected readonly jobupEmail = signal('');
  protected readonly jobupPassword = signal('');
  // Separate from the CV Analysis job filters' own `useJobsCh` signal below — this one only
  // affects the Login button's own attempt; the two toggles are independent since a login can be
  // tested against either site without affecting which site the next CV Analysis run searches,
  // and vice versa.
  protected readonly loginUseJobsCh = signal(false);
  protected readonly cvMatchPending = signal(false);
  protected readonly cvMatchResult = signal<string | null>(null);
  // One entry per job index actually analyzed (see routes/api.js's /cv-match doc comment) — replaces
  // the old single-job cvMatchAnalysis/cvMatchMeter/cvMatchCriteria/cvMatchJobUrl/
  // cvMatchApplicationUrl signals now that a request can cover a Start..End range analyzed in
  // parallel and shown all at once, rather than exactly one job.
  protected readonly cvMatchResults = signal<CvMatchJobResult[]>([]);
  protected readonly cvMatchTotalJobs = signal<number | null>(null);
  protected readonly cvMatchResultsUrl = signal<string | null>(null);
  protected readonly startJobIndex = signal(1);
  // Independent of startJobIndex — no auto-sync. Left at its own default (1) alongside
  // startJobIndex's default (1) gives the pre-range single-job behavior out of the box; the user
  // sets this explicitly to widen the range.
  protected readonly endJobIndex = signal(1);
  protected readonly searchTerm = signal('');
  protected readonly locationInput = signal('');
  protected readonly useJobsCh = signal(false);
  protected readonly useBasicSearch = signal(false);
  protected readonly cdiOnly = signal(false);
  protected readonly cddOnly = signal(false);
  protected readonly saveJob = signal(false);
  protected readonly easyApply = signal(false);
  protected readonly ignoreYellowMeter = signal(false);
  protected readonly jobFiltersExpanded = signal(false);
  // Every result starts expanded (absence from this set, not presence, means expanded) — tracking
  // which ones are *collapsed* rather than which are expanded means a freshly-arrived result never
  // needs to be added to anything to default to expanded.
  private readonly collapsedJobIndexes = signal<ReadonlySet<number>>(new Set());

  protected isAnalysisExpanded(jobIndex: number): boolean {
    return !this.collapsedJobIndexes().has(jobIndex);
  }

  protected onToggleAnalysis(jobIndex: number): void {
    this.collapsedJobIndexes.update((collapsed) => {
      const next = new Set(collapsed);
      if (next.has(jobIndex)) {
        next.delete(jobIndex);
      } else {
        next.add(jobIndex);
      }
      return next;
    });
  }

  // Called per result from the template (not a single cached computed() — there are now several
  // independent analyses at once, one per job in cvMatchResults()) — a plain function call is fine
  // here since results don't change after being set, so there's nothing to memoize against.
  protected segmentsFor(result: CvMatchJobResult): AnalysisSegment[] {
    return result.analysis ? parseAnalysis(result.analysis, result.criteria, result.meter) : [];
  }

  // Tracked so onStopClick() can unsubscribe from the in-flight cvMatch() request — the backend
  // POST /api/cv-match call stays open for the whole analysis (it awaits the child process), so
  // stopping it server-side still leaves this subscription's next/error callback to fire once that
  // now-killed process's response eventually arrives. Unsubscribing cancels the underlying
  // HttpClient request (this app uses provideHttpClient(withFetch()), which cancels the fetch on
  // unsubscribe) so that stale response can never overwrite the state reset below it.
  private cvMatchSubscription: Subscription | null = null;

  constructor() {
    // Deferred to the browser only: at build time `ng build` prerenders this route with no
    // backend running, so an HTTP call made directly in the constructor breaks the build.
    afterNextRender(() => {
      this.api.getHealth().subscribe({
        next: () => this.backendStatus.set('connected'),
        error: () => this.backendStatus.set('unreachable')
      });
    });
  }

  protected onJobupEmailInput(event: Event): void {
    this.jobupEmail.set((event.target as HTMLInputElement).value);
  }

  protected onJobupPasswordInput(event: Event): void {
    this.jobupPassword.set((event.target as HTMLInputElement).value);
  }

  protected onLoginUseJobsChChange(event: Event): void {
    this.loginUseJobsCh.set((event.target as HTMLInputElement).checked);
  }

  // Bound to the login <form>'s native (submit) event (see app.html) rather than (ngSubmit) — this
  // app doesn't use Angular's FormsModule anywhere else, so a plain 'submit' listener is used
  // instead, with preventDefault() here to stop an actual page reload/navigation. The form's
  // type="email"/required attributes are native HTML5 "built-in validators": the browser blocks the
  // 'submit' event entirely (and shows its own validation UI) whenever a field is empty or not a
  // well-formed email, so this never even runs in that case — no custom validation logic needed.
  protected onLoginSubmit(event: Event): void {
    event.preventDefault();
    this.onLoginClick();
  }

  protected onLoginClick(): void {
    this.loginPending.set(true);
    this.loginResult.set(null);
    this.api
      .login({ email: this.jobupEmail(), password: this.jobupPassword(), useJobsCh: this.loginUseJobsCh() })
      .subscribe({
        next: (response) => {
          this.loginResult.set(response.message);
          // Receiving any well-formed HTTP response at all — success, a specific known failure
          // reason, or even the generic "Login failed !" (which can mean the backend hit a
          // genuinely unexpected internal error, not that it's unreachable) — proves the backend
          // itself is up and reachable; only a real network-level failure (the error callback
          // below) means otherwise. See the same reasoning on onCvMatchClick()'s next callback.
          this.backendStatus.set('connected');
          this.loginPending.set(false);
        },
        error: () => {
          this.loginResult.set('Login failed !');
          this.backendStatus.set('unreachable');
          this.loginPending.set(false);
        }
      });
  }

  protected onStartJobIndexInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.startJobIndex.set(Number.isFinite(value) ? value : 0);
  }

  protected onEndJobIndexInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.endJobIndex.set(Number.isFinite(value) ? value : 0);
  }

  protected onSearchTermInput(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
  }

  protected onLocationInput(event: Event): void {
    this.locationInput.set((event.target as HTMLInputElement).value);
  }

  protected onUseJobsChChange(event: Event): void {
    this.useJobsCh.set((event.target as HTMLInputElement).checked);
  }

  protected onUseBasicSearchChange(event: Event): void {
    this.useBasicSearch.set((event.target as HTMLInputElement).checked);
  }

  protected onCdiOnlyChange(event: Event): void {
    this.cdiOnly.set((event.target as HTMLInputElement).checked);
  }

  protected onCddOnlyChange(event: Event): void {
    this.cddOnly.set((event.target as HTMLInputElement).checked);
  }

  protected onSaveJobChange(event: Event): void {
    this.saveJob.set((event.target as HTMLInputElement).checked);
    this.resetIgnoreYellowMeterIfMoot();
  }

  protected onEasyApplyChange(event: Event): void {
    this.easyApply.set((event.target as HTMLInputElement).checked);
    this.resetIgnoreYellowMeterIfMoot();
  }

  // "Ignore jobs with a yellow meter" has no effect once both actions it would gate are unchecked
  // (see its [disabled] binding in app.html) — uncheck it too at that point, rather than leaving a
  // checked-but-disabled, now-meaningless checkbox behind.
  private resetIgnoreYellowMeterIfMoot(): void {
    if (!this.saveJob() && !this.easyApply()) {
      this.ignoreYellowMeter.set(false);
    }
  }

  protected onIgnoreYellowMeterChange(event: Event): void {
    this.ignoreYellowMeter.set((event.target as HTMLInputElement).checked);
  }

  protected onToggleJobFilters(): void {
    this.jobFiltersExpanded.update((expanded) => !expanded);
  }

  // Closes the "Job filters" dropdown on any click outside it — deliberately independent of
  // cvMatchPending()/the toggle button's [disabled] state, so a panel left open when a run starts
  // can still be dismissed by clicking away, even though the button itself won't respond to clicks
  // while disabled.
  @HostListener('document:click', ['$event'])
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.jobFiltersExpanded()) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && !target.closest('.job-filters-dropdown')) {
      this.jobFiltersExpanded.set(false);
    }
  }

  // Shared by onCvMatchClick() (starting a run, pending: true) and onStopClick() (abandoning one,
  // pending: false) — both put the CV-match section back to the same "nothing to show yet" shape,
  // just with a different pending state.
  private resetCvMatchState(pending: boolean): void {
    this.cvMatchPending.set(pending);
    this.cvMatchResult.set(null);
    this.cvMatchResults.set([]);
    this.cvMatchTotalJobs.set(null);
    this.cvMatchResultsUrl.set(null);
    this.collapsedJobIndexes.set(new Set());
  }

  protected onCvMatchClick(): void {
    this.resetCvMatchState(true);
    const trimmedSearchTerm = this.searchTerm().trim();
    const locations = this.locationInput()
      .split(',')
      .map((location) => location.trim())
      .filter((location) => location.length > 0);
    this.cvMatchSubscription = this.api
      .cvMatch({
        startJobIndex: this.startJobIndex(),
        endJobIndex: this.endJobIndex(),
        useBasicSearch: this.useBasicSearch(),
        cdiOnly: this.cdiOnly(),
        cddOnly: this.cddOnly(),
        searchTerm: trimmedSearchTerm,
        locations,
        saveJob: this.saveJob(),
        easyApply: this.easyApply(),
        ignoreYellowMeter: this.ignoreYellowMeter(),
        useJobsCh: this.useJobsCh()
      })
      .subscribe({
        next: (response) => {
          this.cvMatchSubscription = null;
          // A non-null errorMessage is a specific, expected, request-level failure (e.g. jobup.ch
          // reporting 0 matching jobs for the given search term/locations, or an invalid index
          // range) meant to be shown as-is instead of the generic fallback. Individual per-job
          // failures within a successful request are shown inline per result instead (see
          // app.html) — this top-level message only reflects the request as a whole.
          const resultMessage = response.success
            ? 'Analysis succeeded !'
            : (response.errorMessage ?? 'Analysis failed !');
          this.cvMatchResult.set(resultMessage);
          this.cvMatchResults.set(response.results);
          // Shown regardless of success — knowing the total match count (and the results page it
          // came from) is still useful context even when the requested index range came back
          // invalid/out of range, or the search itself found nothing.
          this.cvMatchTotalJobs.set(response.totalJobsCount);
          this.cvMatchResultsUrl.set(response.resultsUrl);
          // Receiving any well-formed HTTP response at all proves the backend itself is up and
          // reachable — see onLoginClick()'s matching comment for the full reasoning.
          this.backendStatus.set('connected');
          this.cvMatchPending.set(false);
        },
        error: () => {
          this.cvMatchSubscription = null;
          this.cvMatchResult.set('Analysis failed !');
          this.cvMatchResults.set([]);
          this.cvMatchTotalJobs.set(null);
          this.cvMatchResultsUrl.set(null);
          this.backendStatus.set('unreachable');
          this.cvMatchPending.set(false);
        }
      });
  }

  // "Stop analysis": cancels this component's own wait for the in-flight POST /api/cv-match (via
  // unsubscribe — see cvMatchSubscription's comment) so its eventual response can't overwrite the
  // reset below, tells the backend to actually kill the still-running child process/browser (fire-
  // and-forget — the UI doesn't wait on this, it's already reset by the time it resolves), and puts
  // the CV-match section back exactly as it was before the run started.
  protected onStopClick(): void {
    if (!this.cvMatchPending()) {
      return;
    }
    this.cvMatchSubscription?.unsubscribe();
    this.cvMatchSubscription = null;
    this.api.stopCvMatch().subscribe({ next: () => {}, error: () => {} });
    this.resetCvMatchState(false);
  }

}
