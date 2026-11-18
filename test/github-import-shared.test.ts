import { expect, test } from "bun:test";
import {
  cardOfIssue,
  DEFAULT_GITHUB_IMPORT,
  type GithubImportConfig,
  type GithubIssue,
  issueNumbersOf,
  matchesFilters,
  normalizeGithubImport,
  parseGithubImport,
  searchQuery,
} from "../src/shared/githubImport.ts";

const issue = (over: Partial<GithubIssue> = {}): GithubIssue => ({
  number: 12,
  title: "Fix it",
  body: "details",
  url: "https://github.com/acme/app/issues/12",
  labels: [{ name: "bug" }, { name: "inference" }],
  assignees: [{ login: "alice" }],
  author: { login: "bob" },
  milestone: { title: "v1" },
  ...over,
});
const cfg = (over: Partial<GithubImportConfig> = {}): GithubImportConfig => ({ ...DEFAULT_GITHUB_IMPORT, ...over });

test("github-import-enabled-needs-a-filter", () => {
  expect(() => parseGithubImport({ enabled: true })).toThrow("at least one filter");
  expect(parseGithubImport({ enabled: true, labels: ["bug"] }).enabled).toBe(true);
  expect(parseGithubImport({ enabled: false }).enabled).toBe(false);
});

test("github-import-parse-validates-fields", () => {
  expect(() => parseGithubImport({ repo: "not a repo" })).toThrow("owner/name");
  expect(() => parseGithubImport({ intervalMinutes: 0 })).toThrow("intervalMinutes");
  expect(() => parseGithubImport({ maxPerRun: 1000 })).toThrow("maxPerRun");
  expect(() => parseGithubImport({ labels: [3] })).toThrow("labels");
  const c = parseGithubImport({ labels: " bug, bug ,p0,", assignees: ["@me"], asDraft: false }, [4]);
  expect(c.labels).toEqual(["bug", "p0"]);
  expect(c.assignees).toEqual(["@me"]);
  expect(c.asDraft).toBe(false);
  expect(c.imported).toEqual([4]);
  expect(parseGithubImport({}).asDraft).toBe(true);
});

test("github-import-normalize-is-lenient", () => {
  expect(normalizeGithubImport(undefined)).toBeUndefined();
  const broken = normalizeGithubImport({ enabled: true, imported: [1, "x", -2, 3] });
  expect(broken?.enabled).toBe(false);
  expect(broken?.imported).toEqual([1, 3]);
  expect(normalizeGithubImport({ enabled: true, labels: ["bug"], repo: 5 })?.repo).toBe("");
});

test("github-import-filters-any-within-all-across", () => {
  expect(matchesFilters(issue(), cfg({ labels: ["p0", "bug"] }))).toBe(true);
  expect(matchesFilters(issue(), cfg({ labels: ["p0"] }))).toBe(false);
  expect(matchesFilters(issue(), cfg({ labels: ["BUG"], assignees: ["alice"] }))).toBe(true);
  expect(matchesFilters(issue(), cfg({ labels: ["bug"], assignees: ["carol"] }))).toBe(false);
  expect(matchesFilters(issue(), cfg({ labels: ["bug"], excludeLabels: ["inference"] }))).toBe(false);
  expect(matchesFilters(issue(), cfg({ authors: ["bob"] }))).toBe(true);
  expect(matchesFilters(issue({ author: null }), cfg({ authors: ["bob"] }))).toBe(false);
  expect(matchesFilters(issue(), cfg({ milestone: "V1" }))).toBe(true);
  expect(matchesFilters(issue({ milestone: null }), cfg({ milestone: "v1" }))).toBe(false);
});

test("github-import-me-stands-for-the-gh-user", () => {
  expect(matchesFilters(issue(), cfg({ assignees: ["@me"] }), "alice")).toBe(true);
  expect(matchesFilters(issue(), cfg({ assignees: ["@me"] }), "carol")).toBe(false);
  expect(matchesFilters(issue(), cfg({ assignees: ["@me"] }), "")).toBe(false);
});

test("github-import-search-query", () => {
  const q = searchQuery(
    cfg({ labels: ["bug", "good first"], excludeLabels: ["wontfix"], assignees: ["alice"], milestone: "v1", search: "no:project" }),
  );
  expect(q).toBe('label:bug,"good first" -label:wontfix assignee:alice milestone:v1 no:project');
  expect(searchQuery(cfg({ assignees: ["a", "b"] }))).toBe("");
});

test("github-import-issue-numbers-of-a-card", () => {
  expect(issueNumbersOf({ title: "#320 The canary", description: "" }, "acme/app")).toEqual([320]);
  expect(issueNumbersOf({ title: "Fix", description: "see https://github.com/acme/app/issues/7" }, "acme/app")).toEqual([7]);
  expect(issueNumbersOf({ title: "Fix", description: "https://github.com/other/app/issues/7" }, "acme/app")).toEqual([]);
  expect(issueNumbersOf({ title: "Fix #9", description: "" }, "acme/app")).toEqual([]);
});

test("github-import-card-of-an-issue", () => {
  expect(cardOfIssue(issue())).toEqual({ title: "#12 Fix it", description: "Issue: https://github.com/acme/app/issues/12\n\ndetails\n" });
});
