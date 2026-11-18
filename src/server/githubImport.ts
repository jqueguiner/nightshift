/**
 * Imports a project's GitHub issues into its Backlog, by `gh` from the project folder, on the schedule and
 * with the filters of its `githubImport` settings (src/shared/githubImport.ts). Only the instance that runs
 * the project's agents imports: a `--no-agents` test instance never does.
 *
 * A run fetches the open issues the filters narrow to, keeps those `matchesFilters` accepts, skips every
 * issue a card already names (any column, Done included) or imported before (a card deleted by hand stays
 * deleted), and creates at most `maxPerRun` cards, oldest issue first. `gh` failing creates nothing.
 */

import {
  cardOfIssue,
  type GithubImportConfig,
  type GithubImportRun,
  type GithubIssue,
  issueNumbersOf,
  MAX_REMEMBERED_ISSUES,
  ME,
  matchesFilters,
  normalizeGithubImport,
  searchQuery,
} from "../shared/githubImport.ts";
import type { Card } from "../shared/types.ts";
import type { Project } from "./store.ts";

/** The `gh` binary; tests point it at a fake. */
const GH = () => process.env.NIGHTSHIFT_GH || "gh";
/** Issues one fetch lists at most: the filters narrow the search, this bounds a broad one. */
const FETCH_LIMIT = 300;
/** A `gh` call that hangs is killed after this. */
const GH_TIMEOUT_MS = 60_000;
/** How often the scheduler looks for a project whose import is due. */
const TICK_MS = 30_000;
const FIELDS = "number,title,body,url,labels,assignees,author,milestone";

export type CreateImportedCard = (p: Project, card: { title: string; description: string; draft: boolean }) => Card;

async function gh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn([GH(), ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  const timer = setTimeout(() => proc.kill(), GH_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${(err || out).trim().slice(0, 300) || `exit ${code}`}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function repoOf(c: GithubImportConfig, cwd: string): Promise<string> {
  if (c.repo) return c.repo;
  return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], cwd)).trim();
}

async function meOf(c: GithubImportConfig, cwd: string): Promise<string> {
  if (![...c.assignees, ...c.authors].includes(ME)) return "";
  return (await gh(["api", "user", "-q", ".login"], cwd)).trim();
}

/** The open issues of `repo` that the filters narrow the search to (`matchesFilters` judges them after). */
export async function fetchIssues(c: GithubImportConfig, repo: string, cwd: string): Promise<GithubIssue[]> {
  const args = ["issue", "list", "--repo", repo, "--state", "open", "--limit", String(FETCH_LIMIT), "--json", FIELDS];
  const query = searchQuery(c);
  if (query) args.push("--search", query);
  const raw = JSON.parse(await gh(args, cwd)) as unknown;
  if (!Array.isArray(raw)) throw new Error("gh issue list did not return a list");
  return raw.filter((i): i is GithubIssue => !!i && typeof i === "object" && Number.isInteger((i as GithubIssue).number));
}

/** One import of `p` now, whatever its schedule; never throws (the error is in the result). */
export async function runImport(p: Project, create: CreateImportedCard): Promise<GithubImportRun> {
  const at = new Date().toISOString();
  const c = normalizeGithubImport(p.board.githubImport);
  if (!c) return { at, created: [], known: 0, deferred: 0, error: "GitHub import is not configured" };
  try {
    const repo = await repoOf(c, p.path);
    const me = await meOf(c, p.path);
    const issues = (await fetchIssues(c, repo, p.path)).filter((i) => matchesFilters(i, c, me));
    const onBoard = new Set(p.board.cards.flatMap((card) => issueNumbersOf(card, repo)));
    const imported = new Set(c.imported);
    const fresh = issues.filter((i) => !onBoard.has(i.number) && !imported.has(i.number)).sort((a, b) => a.number - b.number);
    const taken = fresh.slice(0, c.maxPerRun);
    const created: number[] = [];
    for (const issue of taken) {
      create(p, { ...cardOfIssue(issue), draft: c.asDraft });
      created.push(issue.number);
    }
    if (created.length > 0) {
      p.mutate((board) => {
        const now = normalizeGithubImport(board.githubImport) ?? c;
        board.githubImport = { ...now, imported: [...now.imported, ...created].slice(-MAX_REMEMBERED_ISSUES) };
      });
    }
    return { at, created, known: issues.length - fresh.length, deferred: fresh.length - taken.length };
  } catch (e) {
    return { at, created: [], known: 0, deferred: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Runs each opened project's import when it is due; one run per project at a time. Kept on globalThis. */
export class GithubImportScheduler {
  private last = new Map<string, GithubImportRun>();
  private running = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private projects: () => Project[],
    private create: CreateImportedCard,
    private onRun: (p: Project, run: GithubImportRun) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  lastRun(p: Project): GithubImportRun | undefined {
    return this.last.get(p.path);
  }

  /** Imports `p` now (the settings' "Import now"), unless a run of it is already going. */
  async runNow(p: Project): Promise<GithubImportRun> {
    if (this.running.has(p.path))
      return { at: new Date().toISOString(), created: [], known: 0, deferred: 0, error: "an import is already running" };
    this.running.add(p.path);
    try {
      const run = await runImport(p, this.create);
      this.last.set(p.path, run);
      this.onRun(p, run);
      return run;
    } finally {
      this.running.delete(p.path);
    }
  }

  async tick(now = Date.now()): Promise<void> {
    for (const p of this.projects()) {
      const c = normalizeGithubImport(p.board.githubImport);
      if (!c?.enabled) continue;
      const prev = this.last.get(p.path);
      if (prev && now - Date.parse(prev.at) < c.intervalMinutes * 60_000) continue;
      await this.runNow(p);
    }
  }
}
