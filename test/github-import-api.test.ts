import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, removeTempDirs, startChildServer } from "./helpers.ts";

// A fake `gh`: `repo view`, `api user` and `issue list` answered from files the test writes.
const ghDir = mkdtempSync(join(tmpdir(), "fake-gh-"));
const ISSUES = join(ghDir, "issues.json");
const PRS = join(ghDir, "prs.json");
const CALLS = join(ghDir, "calls.log");
writeFileSync(PRS, "[]");
const FAIL = join(ghDir, "fail");
const GH = join(ghDir, "gh");
writeFileSync(
  GH,
  `#!/bin/sh
echo "$*" >> "${CALLS}"
if [ -f "${FAIL}" ]; then echo "gh: not logged in" >&2; exit 1; fi
case "$1 $2" in
  "repo view") echo "acme/app" ;;
  "api user") echo "alice" ;;
  "issue list") cat "${ISSUES}" ;;
  "pr list") cat "${PRS}" ;;
  *) echo "unexpected $*" >&2; exit 2 ;;
esac
`,
);
chmodSync(GH, 0o755);

const issue = (number: number, labels: string[], assignee = "alice") => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  labels: labels.map((name) => ({ name })),
  assignees: [{ login: assignee }],
  author: { login: "bob" },
  milestone: null,
});

let srv: ChildServer;
let idle: ChildServer;

beforeAll(async () => {
  srv = await startChildServer({ agents: true, env: { NIGHTSHIFT_GH: GH } });
  idle = await startChildServer({ agents: false, env: { NIGHTSHIFT_GH: GH } });
});
afterAll(async () => {
  await srv.stop();
  await idle.stop();
  removeTempDirs();
});

async function openProject(s: ChildServer): Promise<string> {
  const d = mkdtempSync(join(s.tmp, "proj-"));
  expect((await s.call("/api/projects/open", { body: { path: d } })).status).toBe(200);
  return d;
}
const snap = async (s: ChildServer, d: string) =>
  (await (await s.call(`/api/project?project=${encodeURIComponent(d)}`)).json()) as ProjectSnapshot;
const save = (s: ChildServer, d: string, config: unknown) => s.call("/api/github-import", { method: "PUT", body: { project: d, config } });
const run = async (s: ChildServer, d: string) => s.call("/api/github-import/run", { body: { project: d } });

test("github-import-refuses-an-enabled-import-without-filter", async () => {
  const d = await openProject(srv);
  const r = await save(srv, d, { enabled: true });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain("at least one filter");
});

test("github-import-creates-draft-cards-once-and-respects-the-cap", async () => {
  writeFileSync(
    ISSUES,
    JSON.stringify([issue(3, ["bug"]), issue(1, ["bug"]), issue(2, ["docs"]), issue(4, ["bug"], "carol"), issue(5, ["bug"])]),
  );
  const d = await openProject(srv);
  expect((await save(srv, d, { enabled: true, labels: ["bug"], assignees: ["@me"], maxPerRun: 2 })).status).toBe(200);

  const first = (await (await run(srv, d)).json()) as { lastRun: { created: number[]; deferred: number; known: number } };
  expect(first.lastRun.created).toEqual([1, 3]);
  expect(first.lastRun.deferred).toBe(1);
  let cards = (await snap(srv, d)).board.cards;
  const one = cards.find((c) => c.title === "#1 Issue 1");
  expect(one?.columnId).toBe("col_backlog");
  expect(one?.draft).toBe(true);
  expect(one?.description).toBe("Issue: https://github.com/acme/app/issues/1\n\nBody of 1\n");
  expect(one?.history[0]?.text).toBe("Imported in Backlog from GitHub");

  const second = (await (await run(srv, d)).json()) as { lastRun: { created: number[]; known: number } };
  expect(second.lastRun.created).toEqual([5]);
  expect(second.lastRun.known).toBe(2);

  // A card deleted by hand is not imported again.
  cards = (await snap(srv, d)).board.cards;
  const three = cards.find((c) => c.title.startsWith("#3 "));
  expect((await srv.call(`/api/cards/${three?.id}?project=${encodeURIComponent(d)}`, { method: "DELETE" })).status).toBe(200);
  const third = (await (await run(srv, d)).json()) as { lastRun: { created: number[] } };
  expect(third.lastRun.created).toEqual([]);
  expect((await snap(srv, d)).board.cards.map((c) => c.title).sort()).toEqual(["#1 Issue 1", "#5 Issue 5"]);

  // The search narrows the fetch; @me was resolved through gh.
  const calls = readFileSync(CALLS, "utf8");
  expect(calls).toContain("api user");
  expect(calls).toContain("--search label:bug");
});

test("github-import-skips-an-issue-already-on-the-board", async () => {
  writeFileSync(ISSUES, JSON.stringify([issue(8, ["bug"])]));
  const d = await openProject(srv);
  await srv.call("/api/cards", { body: { project: d, title: "Hand made", description: "https://github.com/acme/app/issues/8" } });
  await save(srv, d, { enabled: true, labels: ["bug"] });
  const out = (await (await run(srv, d)).json()) as { lastRun: { created: number[]; known: number } };
  expect(out.lastRun.created).toEqual([]);
  expect(out.lastRun.known).toBe(1);
});

test("github-import-gh-failure-creates-nothing", async () => {
  writeFileSync(ISSUES, JSON.stringify([issue(9, ["bug"])]));
  const d = await openProject(srv);
  await save(srv, d, { enabled: true, labels: ["bug"] });
  writeFileSync(FAIL, "");
  try {
    const out = (await (await run(srv, d)).json()) as { lastRun: { error?: string; created: number[] } };
    expect(out.lastRun.error).toContain("not logged in");
    expect((await snap(srv, d)).board.cards).toHaveLength(0);
  } finally {
    rmSync(FAIL, { force: true });
  }
});

test("github-import-config-is-stored-and-read-back", async () => {
  const d = await openProject(srv);
  await save(srv, d, { enabled: false, labels: "bug, p0", repo: "acme/app", intervalMinutes: 15 });
  const got = (await (await srv.call(`/api/github-import?project=${encodeURIComponent(d)}`)).json()) as {
    config: { labels: string[]; repo: string; intervalMinutes: number };
  };
  expect(got.config.labels).toEqual(["bug", "p0"]);
  expect(got.config.repo).toBe("acme/app");
  expect(got.config.intervalMinutes).toBe(15);
  const file = JSON.parse(readFileSync(join(d, "nightshift.json"), "utf8")) as { githubImport?: { labels: string[] } };
  expect(file.githubImport?.labels).toEqual(["bug", "p0"]);
});

test("github-import-never-runs-in-an-instance-without-agents", async () => {
  const d = await openProject(idle);
  await save(idle, d, { enabled: true, labels: ["bug"] });
  expect((await run(idle, d)).status).toBe(409);
});

const pr = (number: number, closes: number, hoursAgo: number) => ({
  number,
  url: `https://github.com/acme/app/pull/${number}`,
  headRefName: `fix/${closes}`,
  updatedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  closingIssuesReferences: [{ number: closes }],
});

test("github-import-leaves-out-an-issue-whose-open-pr-is-active-and-takes-over-an-abandoned-one", async () => {
  writeFileSync(ISSUES, JSON.stringify([issue(20, ["bug"]), issue(21, ["bug"]), issue(22, ["bug"])]));
  writeFileSync(PRS, JSON.stringify([pr(120, 20, 2), pr(121, 21, 10)]));
  try {
    const d = await openProject(srv);
    await save(srv, d, { enabled: true, labels: ["bug"], activePrHours: 6 });
    const out = (await (await run(srv, d)).json()) as { lastRun: { created: number[]; inProgress: number } };
    expect(out.lastRun.created).toEqual([21, 22]);
    expect(out.lastRun.inProgress).toBe(1);
    const cards = (await snap(srv, d)).board.cards;
    const taken = cards.find((c) => c.title === "#21 Issue 21");
    expect(taken?.description).toContain("Open PR #121 (branch `fix/21`)");
    expect(taken?.description).toContain("take over its branch, do not start a new one");
    expect(cards.find((c) => c.title === "#22 Issue 22")?.description).not.toContain("Open PR");

    // Once its PR is older than the window, the held issue comes in on a later run.
    await save(srv, d, { enabled: true, labels: ["bug"], activePrHours: 1 });
    const later = (await (await run(srv, d)).json()) as { lastRun: { created: number[]; inProgress: number } };
    expect(later.lastRun.created).toEqual([20]);
    expect(later.lastRun.inProgress).toBe(0);
  } finally {
    writeFileSync(PRS, "[]");
  }
});

test("github-import-active-pr-hours-zero-never-holds-an-issue-back", async () => {
  writeFileSync(ISSUES, JSON.stringify([issue(30, ["bug"])]));
  writeFileSync(PRS, JSON.stringify([pr(130, 30, 0)]));
  try {
    const d = await openProject(srv);
    await save(srv, d, { enabled: true, labels: ["bug"], activePrHours: 0 });
    const out = (await (await run(srv, d)).json()) as { lastRun: { created: number[] } };
    expect(out.lastRun.created).toEqual([30]);
    expect((await save(srv, d, { activePrHours: 73 })).status).toBe(400);
  } finally {
    writeFileSync(PRS, "[]");
  }
});
