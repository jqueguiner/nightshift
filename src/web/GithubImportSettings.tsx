import { useEffect, useState } from "react";
import {
  DEFAULT_GITHUB_IMPORT,
  type GithubImportConfig,
  type GithubImportRun,
  MAX_ACTIVE_PR_HOURS,
  MAX_IMPORT_INTERVAL_MINUTES,
  MAX_IMPORT_MAX_PER_RUN,
  MIN_IMPORT_INTERVAL_MINUTES,
} from "../shared/githubImport.ts";
import { api } from "./api.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { t, useT } from "./i18n/index.ts";
import { notifyError } from "./notify.ts";
import { Row, Section } from "./SettingsModal.tsx";

/** The form's text fields: lists are edited as comma-separated text. */
interface Draft {
  enabled: boolean;
  repo: string;
  labels: string;
  excludeLabels: string;
  assignees: string;
  authors: string;
  milestone: string;
  search: string;
  intervalMinutes: string;
  maxPerRun: string;
  activePrHours: string;
  asDraft: boolean;
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function draftOf(c: GithubImportConfig): Draft {
  return {
    enabled: c.enabled,
    repo: c.repo,
    labels: c.labels.join(", "),
    excludeLabels: c.excludeLabels.join(", "),
    assignees: c.assignees.join(", "),
    authors: c.authors.join(", "),
    milestone: c.milestone,
    search: c.search,
    intervalMinutes: String(c.intervalMinutes),
    maxPerRun: String(c.maxPerRun),
    activePrHours: String(c.activePrHours),
    asDraft: c.asDraft,
  };
}

/** The configuration the form sends (the server validates it again and keeps the imported numbers). */
export function configOf(d: Draft): Partial<GithubImportConfig> {
  return {
    enabled: d.enabled,
    repo: d.repo.trim(),
    labels: list(d.labels),
    excludeLabels: list(d.excludeLabels),
    assignees: list(d.assignees),
    authors: list(d.authors),
    milestone: d.milestone.trim(),
    search: d.search.trim(),
    intervalMinutes: Number(d.intervalMinutes),
    maxPerRun: Number(d.maxPerRun),
    activePrHours: Number(d.activePrHours),
    asDraft: d.asDraft,
  };
}

export function describeRun(run: GithubImportRun): string {
  const at = new Date(run.at).toLocaleTimeString();
  if (run.error) return t("settings.githubImport.runError", { at, error: run.error });
  return t("settings.githubImport.runDone", {
    at,
    created: String(run.created.length),
    known: String(run.known),
    deferred: String(run.deferred),
    inProgress: String(run.inProgress ?? 0),
  });
}

/** "GitHub import" of the open project: its own load, save and "Import now", apart from the global settings. */
export function GithubImportSettings({ project }: { project: string }) {
  useT();
  const [draft, setDraft] = useState<Draft>(draftOf(DEFAULT_GITHUB_IMPORT));
  const [lastRun, setLastRun] = useState<GithubImportRun | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .githubImport(project)
      .then((s) => {
        if (!live) return;
        setDraft(draftOf(s.config ?? DEFAULT_GITHUB_IMPORT));
        setLastRun(s.lastRun);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [project]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const text = (key: Exclude<keyof Draft, "enabled" | "asDraft">, id: string, placeholder = "") => (
    <Input id={id} value={draft[key]} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
  );

  const act = async (fn: () => Promise<{ config: GithubImportConfig | null; lastRun: GithubImportRun | null }>) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s.config) setDraft(draftOf(s.config));
      setLastRun(s.lastRun);
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const save = () => act(() => api.saveGithubImport(project, configOf(draft)));
  const runNow = () => act(async () => (await api.saveGithubImport(project, configOf(draft)), api.runGithubImport(project)));

  return (
    <Section title={t("settings.githubImport.title")} description={t("settings.githubImport.description")}>
      <Row id="gi-enabled" label={t("settings.githubImport.enabled.label")} help={t("settings.githubImport.enabled.help")}>
        <Switch id="gi-enabled" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v)} />
      </Row>
      <Row id="gi-repo" label={t("settings.githubImport.repo.label")} help={t("settings.githubImport.repo.help")}>
        {text("repo", "gi-repo", "owner/name")}
      </Row>
      <Row id="gi-labels" label={t("settings.githubImport.labels.label")} help={t("settings.githubImport.labels.help")}>
        {text("labels", "gi-labels", "bug, inference")}
      </Row>
      <Row id="gi-exclude" label={t("settings.githubImport.excludeLabels.label")} help={t("settings.githubImport.excludeLabels.help")}>
        {text("excludeLabels", "gi-exclude", "wontfix")}
      </Row>
      <Row id="gi-assignees" label={t("settings.githubImport.assignees.label")} help={t("settings.githubImport.assignees.help")}>
        {text("assignees", "gi-assignees", "@me")}
      </Row>
      <Row id="gi-authors" label={t("settings.githubImport.authors.label")} help={t("settings.githubImport.authors.help")}>
        {text("authors", "gi-authors")}
      </Row>
      <Row id="gi-milestone" label={t("settings.githubImport.milestone.label")} help={t("settings.githubImport.milestone.help")}>
        {text("milestone", "gi-milestone")}
      </Row>
      <Row id="gi-search" label={t("settings.githubImport.search.label")} help={t("settings.githubImport.search.help")}>
        {text("search", "gi-search", "no:assignee created:>2026-11-01")}
      </Row>
      <Row
        id="gi-interval"
        label={t("settings.githubImport.interval.label")}
        help={t("settings.githubImport.interval.help", {
          min: String(MIN_IMPORT_INTERVAL_MINUTES),
          max: String(MAX_IMPORT_INTERVAL_MINUTES),
        })}
      >
        {text("intervalMinutes", "gi-interval")}
      </Row>
      <Row
        id="gi-max"
        label={t("settings.githubImport.maxPerRun.label")}
        help={t("settings.githubImport.maxPerRun.help", { max: String(MAX_IMPORT_MAX_PER_RUN) })}
      >
        {text("maxPerRun", "gi-max")}
      </Row>
      <Row
        id="gi-active-pr"
        label={t("settings.githubImport.activePrHours.label")}
        help={t("settings.githubImport.activePrHours.help", { max: String(MAX_ACTIVE_PR_HOURS) })}
      >
        {text("activePrHours", "gi-active-pr")}
      </Row>
      <Row id="gi-draft" label={t("settings.githubImport.asDraft.label")} help={t("settings.githubImport.asDraft.help")}>
        <Switch id="gi-draft" checked={draft.asDraft} onCheckedChange={(v) => set("asDraft", v)} />
      </Row>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Button size="sm" onClick={save} disabled={busy}>
          {t("settings.githubImport.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={runNow} disabled={busy}>
          {t("settings.githubImport.runNow")}
        </Button>
        {lastRun && <span className="github-import-last text-xs text-muted-foreground">{describeRun(lastRun)}</span>}
      </div>
    </Section>
  );
}
