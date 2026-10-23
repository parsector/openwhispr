import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentJob } from "../../types/electron";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { IntegrationsPane } from "./IntegrationsPane";
import {
  authStateKey,
  elapsedTime,
  failureMessage,
  jobStatus,
  queuePosition,
  stallTextKey,
} from "./agentJobsPresentation";

type Project = Awaited<ReturnType<typeof window.agentJobs.projectsList>>["projects"][number];
type Harness = Project["defaultHarness"];
const emptyProject: Project = {
  name: "",
  folder: "",
  defaultHarness: "claude",
  mode: "read-only",
  model: null,
};
const claudeModels = ["sonnet", "opus", "haiku", "fable"];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AgentsPane({ title }: { title: string }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [jobsLoaded, setJobsLoaded] = useState(false);
  const [draft, setDraft] = useState<Project | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<
    Partial<Record<Harness, Awaited<ReturnType<typeof window.agentJobs.testHarness>>>>
  >({});
  const [probeBusy, setProbeBusy] = useState<Harness | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let live = true;
    void window.agentJobs
      .projectsList()
      .then((value) => {
        if (live) {
          setProjects(value.projects);
          setProjectsLoaded(true);
        }
      })
      .catch((cause) => {
        if (live) {
          setError(errorText(cause));
          setProjectsLoaded(true);
        }
      });
    const off = window.agentJobs.onUpdated((job) => {
      setJobs((current) => {
        const index = current.findIndex((item) => item.jobId === job.jobId);
        if (index < 0) return [job, ...current];
        const next = [...current];
        next[index] = job;
        return next;
      });
    });
    void window.agentJobs
      .list()
      .then((value) => {
        if (live) {
          setJobs((current) => {
            const byId = new Map(value.map((job) => [job.jobId, job]));
            current.forEach((job) => byId.set(job.jobId, job));
            return [...byId.values()];
          });
          setJobsLoaded(true);
        }
      })
      .catch((cause) => {
        if (live) {
          setError(errorText(cause));
          setJobsLoaded(true);
        }
      });
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      off();
      clearInterval(interval);
    };
  }, []);

  async function testHarness(harness: Harness) {
    setProbeBusy(harness);
    try {
      const result = await window.agentJobs.testHarness(harness);
      setProbe((current) => ({ ...current, [harness]: result }));
    } catch (cause) {
      setProbe((current) => ({
        ...current,
        [harness]: { ok: false, path: null, version: null, error: errorText(cause) },
      }));
    } finally {
      setProbeBusy(null);
    }
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      await window.agentJobs.projectsSave({
        ...draft,
        name: draft.name.trim(),
        model: draft.model?.trim() || null,
      });
      if (editingName && editingName !== draft.name.trim())
        await window.agentJobs.projectsRemove(editingName);
      setProjects((await window.agentJobs.projectsList()).projects);
      setDraft(null);
      setEditingName(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(name: string) {
    setBusy(true);
    setError("");
    try {
      const value = (await window.agentJobs.projectsRemove(name)) as { projects: Project[] };
      setProjects(value.projects);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder() {
    try {
      const value = await window.electronAPI.noteFilesPickFolder?.();
      if (value?.path)
        setDraft((current) => (current ? { ...current, folder: value.path! } : current));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function cancel(jobId: string) {
    try {
      await window.agentJobs.cancel(jobId);
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  const inputClass =
    "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary";
  return (
    <IntegrationsPane title={title} description={t("agentJobs.pane.description")}>
      <section className="space-y-2" aria-label={t("agentJobs.pane.projects")}>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>{t("agentJobs.pane.projects")}</SectionLabel>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraft({ ...emptyProject });
              setEditingName(null);
              setCustomModel(false);
              void testHarness("claude");
            }}
            disabled={busy}
          >
            {t("agentJobs.pane.addProject")}
          </Button>
        </div>
        <SettingsPanel>
          {!projectsLoaded && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            </SettingsPanelRow>
          )}
          {projectsLoaded && projects.length === 0 && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("agentJobs.pane.noProjects")}</p>
            </SettingsPanelRow>
          )}
          {projects.map((project) => (
            <SettingsPanelRow key={project.name}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium text-foreground">{project.name}</h3>
                  <p className="break-all text-xs text-muted-foreground" dir="auto">
                    {project.folder}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {project.defaultHarness} · {t("agentJobs.pane.readOnly")} ·{" "}
                    {project.model || t("agentJobs.pane.defaultModel")}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft({ ...project });
                      setEditingName(project.name);
                      setCustomModel(
                        Boolean(project.model && !claudeModels.includes(project.model))
                      );
                      void testHarness(project.defaultHarness);
                    }}
                  >
                    {t("agentJobs.pane.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(project.name)}
                  >
                    {t("agentJobs.pane.remove")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={probeBusy !== null}
                    onClick={() => void testHarness(project.defaultHarness)}
                  >
                    {t("agentJobs.pane.testHarness")}
                  </Button>
                </div>
              </div>
              {probe[project.defaultHarness] && (
                <p role="status" className="mt-1 break-all text-xs text-muted-foreground">
                  {probe[project.defaultHarness]?.ok
                    ? `${probe[project.defaultHarness]?.path} · ${probe[project.defaultHarness]?.version}`
                    : probe[project.defaultHarness]?.error}{" "}
                  · {t(authStateKey("unknown"))}
                </p>
              )}
            </SettingsPanelRow>
          ))}
        </SettingsPanel>
        {draft && (
          <SettingsPanel>
            <SettingsPanelRow className="space-y-3">
              <h3 className="text-xs font-semibold">
                {t(editingName ? "agentJobs.pane.editProject" : "agentJobs.pane.addProject")}
              </h3>
              <div className="grid gap-3 @min-[40rem]:grid-cols-2">
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.name")}
                  <input
                    className={inputClass}
                    dir="ltr"
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </label>
                <div className="space-y-1 text-xs">
                  <label htmlFor="agent-project-folder">{t("agentJobs.pane.folder")}</label>
                  <div className="flex gap-1">
                    <input
                      id="agent-project-folder"
                      className={inputClass}
                      dir="ltr"
                      value={draft.folder}
                      readOnly
                    />
                    <Button size="sm" variant="outline" onClick={() => void pickFolder()}>
                      {t("agentJobs.pane.browse")}
                    </Button>
                  </div>
                </div>
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.harness")}
                  <select
                    className={inputClass}
                    value={draft.defaultHarness}
                    onChange={(e) => {
                      const harness = e.target.value as Harness;
                      setDraft({ ...draft, defaultHarness: harness, model: null });
                      setCustomModel(false);
                      void testHarness(harness);
                    }}
                  >
                    <option value="claude">Claude</option>
                    <option value="cursor-agent">Cursor</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.mode")}
                  <select className={inputClass} value={draft.mode} disabled>
                    <option value="read-only">{t("agentJobs.pane.readOnly")}</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.model")}
                  <select
                    className={inputClass}
                    value={customModel ? "custom" : draft.model || ""}
                    onChange={(e) => {
                      setCustomModel(e.target.value === "custom");
                      setDraft({
                        ...draft,
                        model: e.target.value === "custom" ? null : e.target.value || null,
                      });
                    }}
                  >
                    <option value="">{t("agentJobs.pane.defaultModel")}</option>
                    {draft.defaultHarness === "claude" &&
                      claudeModels.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    <option value="custom">{t("agentJobs.pane.fullModelName")}</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.fullModelName")}
                  <input
                    className={inputClass}
                    dir="ltr"
                    value={draft.model || ""}
                    placeholder={t("agentJobs.pane.optional")}
                    onChange={(e) => {
                      setCustomModel(true);
                      setDraft({ ...draft, model: e.target.value });
                    }}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={probeBusy !== null}
                  onClick={() => void testHarness(draft.defaultHarness)}
                >
                  {t("agentJobs.pane.testHarness")}
                </Button>
                <span className="text-xs text-muted-foreground">{t(authStateKey("unknown"))}</span>
              </div>
              {probe[draft.defaultHarness] && (
                <p role="status" className="break-all text-xs text-muted-foreground">
                  {probe[draft.defaultHarness]?.ok
                    ? `${probe[draft.defaultHarness]?.path} · ${probe[draft.defaultHarness]?.version}`
                    : probe[draft.defaultHarness]?.error}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busy || !draft.name.trim() || !draft.folder}
                  onClick={() => void save()}
                >
                  {t("agentJobs.pane.save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDraft(null);
                    setEditingName(null);
                  }}
                >
                  {t("agentJobs.card.cancel")}
                </Button>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        )}
      </section>
      <section className="space-y-2" aria-label={t("agentJobs.pane.jobs")}>
        <SectionLabel>{t("agentJobs.pane.jobs")}</SectionLabel>
        <SettingsPanel>
          {!jobsLoaded && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            </SettingsPanelRow>
          )}
          {jobsLoaded && jobs.length === 0 && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("agentJobs.pane.noJobs")}</p>
            </SettingsPanelRow>
          )}
          {[...jobs]
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((job) => {
              const status = jobStatus(job.status, job.stalled);
              const elapsed = elapsedTime(job.startedAt, job.endedAt, now);
              const position = queuePosition(job.position);
              const failure = failureMessage(job.reason);
              return (
                <SettingsPanelRow key={job.jobId} className="space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-medium">{job.project.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {job.harness} · {job.model || t("agentJobs.pane.defaultModel")}
                        {elapsed && ` · ${elapsed}`}
                      </p>
                    </div>
                    <Badge
                      variant={
                        status.severity === "danger"
                          ? "destructive"
                          : status.severity === "neutral"
                            ? "secondary"
                            : status.severity
                      }
                    >
                      {t(
                        status.key === "stalled"
                          ? stallTextKey
                          : `agentJobs.pane.status.${status.key}`
                      )}
                    </Badge>
                  </div>
                  {position && (
                    <p className="text-xs text-muted-foreground">
                      {t("agentJobs.pane.queuePosition", { position })}
                    </p>
                  )}
                  {job.status === "running" && job.steps.length > 0 && (
                    <ol
                      className="max-h-44 overflow-y-auto space-y-1 text-xs text-muted-foreground"
                      aria-label={t("agentJobs.pane.progress")}
                    >
                      {job.steps
                        .slice(-20)
                        .reverse()
                        .map((step, index) => (
                          <li key={`${job.jobId}-${index}`} className="break-words">
                            {String(step.summary || step.kind)}
                          </li>
                        ))}
                    </ol>
                  )}
                  {job.status === "failed" && job.reason && (
                    <p role="alert" className="text-xs text-destructive">
                      {"key" in failure ? t(failure.key) : failure.text}
                    </p>
                  )}
                  {(["pending", "queued", "running"] as const).includes(
                    job.status as "pending" | "queued" | "running"
                  ) && (
                    <Button size="sm" variant="outline" onClick={() => void cancel(job.jobId)}>
                      {t("agentJobs.card.cancel")}
                    </Button>
                  )}
                  {job.status === "done" && job.noteId && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void window.electronAPI.agentOpenNote?.(job.noteId!)}
                    >
                      {t("agentJobs.pane.openNote")}
                    </Button>
                  )}
                </SettingsPanelRow>
              );
            })}
        </SettingsPanel>
      </section>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </IntegrationsPane>
  );
}
