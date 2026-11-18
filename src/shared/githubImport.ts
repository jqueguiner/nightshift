/**
 * Automatic import of a project's GitHub issues into its Backlog: the per-project configuration stored in
 * `nightshift.json` (`githubImport`), its validation, and the filter every fetched issue goes through.
 *
 * Filters: within one field any value matches (labels `bug`, `p0` imports an issue carrying either); across
 * fields all must match (labels and assignees: both). `excludeLabels` drops an issue carrying any of them.
 * An enabled import needs at least one filter, so a repository's whole backlog is never pulled by mistake.
 */

/** Minutes between two automatic imports when unset, and the bounds the UI and the server accept. */
export const DEFAULT_IMPORT_INTERVAL_MINUTES = 10;
export const MIN_IMPORT_INTERVAL_MINUTES = 1;
export const MAX_IMPORT_INTERVAL_MINUTES = 24 * 60;
/** Cards created by one import at most: a broad filter fills the Backlog over several runs, not at once. */
export const DEFAULT_IMPORT_MAX_PER_RUN = 20;
export const MAX_IMPORT_MAX_PER_RUN = 100;
/** Issue numbers remembered as imported, newest kept: a card deleted by hand is not imported again. */
export const MAX_REMEMBERED_ISSUES = 5000;
/** Values one filter field accepts, and the length of one value. */
const MAX_FILTER_VALUES = 50;
const MAX_FILTER_VALUE_CHARS = 200;
/** Assignee meaning "whoever `gh` is logged in as". */
export const ME = "@me";

export interface GithubImportConfig {
  enabled: boolean;
  /** `owner/name`; empty: the repository of the project folder, as `gh` resolves it. */
  repo: string;
  /** Any of these labels. */
  labels: string[];
  /** None of these labels. */
  excludeLabels: string[];
  /** Assigned to any of these logins (`@me`: the `gh` user). */
  assignees: string[];
  /** Opened by any of these logins (`@me`: the `gh` user). */
  authors: string[];
  /** In this milestone (its title); empty: any. */
  milestone: string;
  /** Extra GitHub search qualifiers, e.g. `no:assignee created:>2026-11-01`. */
  search: string;
  intervalMinutes: number;
  maxPerRun: number;
  /** Imported cards are drafts: fast forward leaves them in Backlog until someone takes the draft off. */
  asDraft: boolean;
  /** Issue numbers imported already (newest last). */
  imported: number[];
}

export const DEFAULT_GITHUB_IMPORT: GithubImportConfig = {
  enabled: false,
  repo: "",
  labels: [],
  excludeLabels: [],
  assignees: [],
  authors: [],
  milestone: "",
  search: "",
  intervalMinutes: DEFAULT_IMPORT_INTERVAL_MINUTES,
  maxPerRun: DEFAULT_IMPORT_MAX_PER_RUN,
  asDraft: true,
  imported: [],
};

/** The fields of a fetched issue the filter reads (`gh issue list --json`). */
export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
  assignees: { login: string }[];
  author: { login: string } | null;
  milestone: { title: string } | null;
}

/** Result of the last import of a project, shown under the settings. */
export interface GithubImportRun {
  at: string;
  /** Issue numbers that became cards. */
  created: number[];
  /** Issues that matched but were on the board or imported before. */
  known: number;
  /** Issues that matched but did not fit in this run's cap: the next run takes them. */
  deferred: number;
  error?: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

function strings(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  const list = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(list)) throw new Error(`githubImport.${field} must be a list of strings`);
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== "string") throw new Error(`githubImport.${field} must be a list of strings`);
    const s = x.trim();
    if (!s) continue;
    if (s.length > MAX_FILTER_VALUE_CHARS) throw new Error(`githubImport.${field}: a value is too long`);
    if (!out.includes(s)) out.push(s);
  }
  if (out.length > MAX_FILTER_VALUES) throw new Error(`githubImport.${field}: at most ${MAX_FILTER_VALUES} values`);
  return out;
}

function text(v: unknown, field: string, max = MAX_FILTER_VALUE_CHARS): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`githubImport.${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new Error(`githubImport.${field} is too long`);
  return s;
}

function int(v: unknown, field: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max)
    throw new Error(`githubImport.${field} must be an integer from ${min} to ${max}`);
  return n;
}

/** Whether the configuration narrows the issues at all. */
export function hasFilter(c: Pick<GithubImportConfig, "labels" | "assignees" | "authors" | "milestone" | "search">): boolean {
  return c.labels.length > 0 || c.assignees.length > 0 || c.authors.length > 0 || c.milestone !== "" || c.search !== "";
}

/**
 * A strict configuration from user input (the settings form): throws with a message on any bad field,
 * and refuses an enabled import without a filter. `imported` is never taken from input: it is the server's.
 */
export function parseGithubImport(raw: unknown, imported: number[] = []): GithubImportConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("githubImport must be an object");
  const r = raw as Record<string, unknown>;
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error("githubImport.enabled must be a boolean");
  if (r.asDraft !== undefined && typeof r.asDraft !== "boolean") throw new Error("githubImport.asDraft must be a boolean");
  const repo = text(r.repo, "repo");
  if (repo && !REPO.test(repo)) throw new Error("githubImport.repo must be owner/name");
  const config: GithubImportConfig = {
    enabled: r.enabled === true,
    repo,
    labels: strings(r.labels, "labels"),
    excludeLabels: strings(r.excludeLabels, "excludeLabels"),
    assignees: strings(r.assignees, "assignees"),
    authors: strings(r.authors, "authors"),
    milestone: text(r.milestone, "milestone"),
    search: text(r.search, "search", 1000),
    intervalMinutes: int(
      r.intervalMinutes,
      "intervalMinutes",
      MIN_IMPORT_INTERVAL_MINUTES,
      MAX_IMPORT_INTERVAL_MINUTES,
      DEFAULT_IMPORT_INTERVAL_MINUTES,
    ),
    maxPerRun: int(r.maxPerRun, "maxPerRun", 1, MAX_IMPORT_MAX_PER_RUN, DEFAULT_IMPORT_MAX_PER_RUN),
    asDraft: r.asDraft !== false,
    imported,
  };
  if (config.enabled && !hasFilter(config))
    throw new Error("githubImport: choose at least one filter (labels, assignees, authors, milestone or search) before enabling it");
  return config;
}

/** The stored configuration, lenient: a field that does not parse falls back to its default, never a broken board. */
export function normalizeGithubImport(raw: unknown): GithubImportConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const imported = Array.isArray(r.imported)
    ? r.imported.filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(-MAX_REMEMBERED_ISSUES)
    : [];
  try {
    return parseGithubImport(raw, imported);
  } catch {
    try {
      return { ...parseGithubImport({ ...r, enabled: false }, imported) };
    } catch {
      return { ...DEFAULT_GITHUB_IMPORT, imported };
    }
  }
}

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

/** Whether `issue` passes the filters; `me` is the `gh` login that `@me` stands for. */
export function matchesFilters(issue: GithubIssue, c: GithubImportConfig, me = ""): boolean {
  const labels = lower(issue.labels.map((l) => l.name));
  const who = (xs: string[]) => lower(xs.map((x) => (x === ME ? me : x)).filter(Boolean));
  if (lower(c.excludeLabels).some((l) => labels.includes(l))) return false;
  if (c.labels.length > 0 && !lower(c.labels).some((l) => labels.includes(l))) return false;
  if (c.assignees.length > 0) {
    const assigned = lower(issue.assignees.map((a) => a.login));
    if (!who(c.assignees).some((a) => assigned.includes(a))) return false;
  }
  if (c.authors.length > 0) {
    const author = issue.author?.login.toLowerCase() ?? "";
    if (!who(c.authors).includes(author)) return false;
  }
  if (c.milestone && issue.milestone?.title.toLowerCase() !== c.milestone.toLowerCase()) return false;
  return true;
}

const quote = (s: string) => (/[\s",]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);

/**
 * GitHub search qualifiers that narrow the fetch to roughly the filtered set (`matchesFilters` stays the
 * judge): several labels in one `label:` qualifier are any-of, one assignee or author is passed as is.
 */
export function searchQuery(c: GithubImportConfig): string {
  const parts: string[] = [];
  if (c.labels.length > 0) parts.push(`label:${c.labels.map(quote).join(",")}`);
  for (const l of c.excludeLabels) parts.push(`-label:${quote(l)}`);
  if (c.assignees.length === 1) parts.push(`assignee:${quote(c.assignees[0] as string)}`);
  if (c.authors.length === 1) parts.push(`author:${quote(c.authors[0] as string)}`);
  if (c.milestone) parts.push(`milestone:${quote(c.milestone)}`);
  if (c.search) parts.push(c.search);
  return parts.join(" ");
}

/** The issue numbers a card names: its `#N` title prefix, and the issue URLs of `repo` in its text. */
export function issueNumbersOf(card: { title: string; description: string }, repo: string): number[] {
  const out: number[] = [];
  const prefix = /^#(\d+)\b/.exec(card.title.trim());
  if (prefix) out.push(Number(prefix[1]));
  if (repo) {
    const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const url = new RegExp(`github\\.com/${escaped}/issues/(\\d+)`, "gi");
    for (const m of `${card.title}\n${card.description}`.matchAll(url)) out.push(Number(m[1]));
  }
  return out;
}

/** The card an issue becomes: `#N title`, and its link, state and body as the description. */
export function cardOfIssue(issue: GithubIssue): { title: string; description: string } {
  return {
    title: `#${issue.number} ${issue.title}`.trim(),
    description: `Issue: ${issue.url}\n\n${(issue.body ?? "").trim()}\n`,
  };
}
