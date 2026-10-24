import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentJob } from "../../types/electron";
import { claudeModels, cursorModels, validateModel } from "../../services/agents/modelCatalog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SectionLabel, SettingsPanel, SettingsPanelRow } from "../ui/SettingsSection";
import { IntegrationsPane } from "./IntegrationsPane";
import { extractPlaceholders } from "../../services/agents/presetPlaceholders.mjs";
import { addLocalApproval, useLocalApprovalStore } from "../../stores/localApprovalStore";
import { LocalApprovalCard } from "../chat/LocalApprovalCard";
import {
  authStateKey,
  elapsedTime,
  failureDescription,
  guaranteeKey,
  jobStatus,
  queuePosition,
  stallTextKey,
} from "./agentJobsPresentation";

type Project = Awaited<ReturnType<typeof window.agentJobs.projectsList>>["projects"][number];
type Harness = Project["defaultHarness"];
type Preset = Awaited<ReturnType<typeof window.agentJobs.presetsList>>["presets"][number];
const suggestions = [
  { key: "reviewPr", writeOnly: false },
  { key: "triageBug", writeOnly: false },
  { key: "designDoc", writeOnly: true },
] as const;
const emptyProject: Project = {
  name: "",
  folder: "",
  defaultHarness: "claude",
  mode: "read-only",
  model: null,
  trustWorkspace: false,
};
const models = claudeModels();
const listedModels = [...models.aliases, ...models.fullNames];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function AgentsPane({ title }: { title: string }) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetDraft, setPresetDraft] = useState<Preset | null>(null);
  const [runningPreset, setRunningPreset] = useState<Preset | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [resolvedPrompt, setResolvedPrompt] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [fanOutApproval, setFanOutApproval] = useState<{
    id: string;
    presetName: string;
    targets: Array<{ number: number; title: string }>;
    total: number;
  } | null>(null);
  const approvalEntries = useLocalApprovalStore((state) => state.entries);
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
  const [modelProbe, setModelProbe] = useState<Awaited<
    ReturnType<typeof window.agentJobs.listModels>
  > | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [now, setNow] = useState(Date.now());
  function probeDetails(harness: Harness) {
    const result = probe[harness];
    if (!debugEnabled || !result?.debug) return null;
    const details = JSON.stringify(
      {
        test: result.debug.test,
        auth: result.debug.auth,
        ...(harness === "cursor-agent" ? { modelProbe } : {}),
      },
      null,
      2
    );
    return (
      <details className="mt-1 text-xs text-muted-foreground">
        <summary>{t("agentJobs.pane.details")}</summary>
        <pre className="whitespace-pre-wrap break-all">{details}</pre>
        <Button size="sm" variant="ghost" onClick={() => copyText(details)}>
          {t("agentJobs.pane.copyDetails")}
        </Button>
      </details>
    );
  }
  function authLabel(harness: Harness) {
    const auth = probe[harness]?.auth;
    if (!auth) return null;
    const subscription = debugEnabled ? probe[harness]?.debug?.auth?.subscriptionType : null;
    const label =
      auth.state === "authenticated" && auth.method === "claude.ai" && subscription === "max"
        ? t("agentJobs.pane.auth.claudeMax")
        : t(authStateKey(auth.state, auth.method, harness), { method: auth.method });
    return auth.state === "unknown" && auth.detail ? `${label} · ${auth.detail}` : label;
  }

  useEffect(() => {
    let live = true;
    void window.electronAPI
      .getDebugState()
      .then((state) => {
        if (live) setDebugEnabled(state.enabled);
      })
      .catch(() => {
        if (live) setDebugEnabled(false);
      });
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
    void window.agentJobs
      .presetsList()
      .then((value) => {
        if (live) setPresets(value.presets);
      })
      .catch((cause) => {
        if (live) setError(errorText(cause));
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
    setError("");
    try {
      const debugState = await window.electronAPI.getDebugState().catch(() => ({ enabled: false }));
      setDebugEnabled(debugState.enabled);
      const result = await window.agentJobs.testHarness(harness);
      setProbe((current) => ({ ...current, [harness]: result }));
      if (harness === "cursor-agent") {
        setModelProbe(
          await window.agentJobs.listModels().catch(() => ({ ok: false, reason: "command failed" }))
        );
      }
    } catch (cause) {
      setProbe((current) => ({ ...current, [harness]: undefined }));
      setError(errorText(cause));
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

  function startPreset(preset: Preset) {
    setRunningPreset(preset);
    setValues({});
    setResolvedPrompt(preset.prompt);
    setError("");
  }
  async function savePreset() {
    if (!presetDraft) return;
    setPresetBusy(true);
    setError("");
    try {
      await window.agentJobs.presetsSave({ ...presetDraft, name: presetDraft.name.trim() });
      setPresets((await window.agentJobs.presetsList()).presets);
      setPresetDraft(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPresetBusy(false);
    }
  }
  async function removePreset(id: string) {
    setPresetBusy(true);
    setError("");
    try {
      await window.agentJobs.presetsRemove(id);
      setPresets((await window.agentJobs.presetsList()).presets);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPresetBusy(false);
    }
  }
  async function runPreset() {
    if (!runningPreset) return;
    setPresetBusy(true);
    setError("");
    try {
      const names = extractPlaceholders(runningPreset.prompt);
      for (const name of names.filter((name) => !(runningPreset.fanOut && name === "pr")))
        if (!values[name]?.trim()) throw new Error(t("agentJobs.presets.missingValue", { name }));
      if (runningPreset.fanOut) {
        const result = await window.agentJobs.fanOutEnumerate(runningPreset.id, values);
        if ("reason" in result) throw new Error(t(`agentJobs.presets.${result.reason}`));
        setFanOutApproval({
          id: result.fanOutId,
          presetName: runningPreset.name,
          targets: result.targets,
          total: result.total,
        });
        setRunningPreset(null);
        return;
      }
      const job = await window.agentJobs.prepare({
        project: runningPreset.project,
        task: resolvedPrompt,
        harness: runningPreset.harness,
        mode: runningPreset.mode,
        ...(runningPreset.model ? { model: runningPreset.model } : {}),
      });
      const context = {
        messageId: `preset-${job.jobId}`,
        toolCallId: "pane",
        signal: new AbortController().signal,
        onApprovalRequested: () => {},
        onHoldDelivery: () => {},
        claimTurnSlot: () => true,
        releaseTurnSlot: () => {},
      };
      const action = job.prompt.replace(/\s+/g, " ").slice(0, 120);
      addLocalApproval(
        context,
        job,
        `harness ${job.harness} on repo ${job.project.name} with model ${job.model || "default"} for action ${action}`
      );
      setRunningPreset(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPresetBusy(false);
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
  async function openTerminal(jobId: string) {
    try {
      await window.agentJobs.openTerminal({ jobId });
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  async function discard(jobId: string) {
    try {
      await window.agentJobs.discard(jobId);
    } catch (cause) {
      setError(errorText(cause));
    }
  }
  function copyCommands(job: AgentJob) {
    if (!job.branch || !job.worktreePath) return;
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    copyText(
      `git -C ${quote(job.worktreePath)} checkout ${quote(job.branch)}\n` +
        `git -C ${quote(job.worktreePath)} status\n` +
        `# After reviewing and committing in the worktree, apply the commit to your main checkout:\n` +
        `git -C ${quote(job.project.folder)} cherry-pick ${quote(job.branch)}`
    );
  }
  function copyText(value: string) {
    void navigator.clipboard.writeText(value);
  }

  const inputClass =
    "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary";
  function modelLabel(model: string | null, harness: Harness) {
    if (!model) return t("agentJobs.pane.defaultModel");
    if (harness !== "claude") return model;
    const alias = models.aliases.find((item) => item.id === model);
    if (alias)
      return `${alias.label.split(" (")[0]} (${t("agentJobs.pane.aliasLatest")}) · ${model}`;
    if (!validateModel(harness, model).ok) return model;
    const fullName = models.fullNames.find((item) => item.id === model);
    return fullName
      ? `${fullName.label} (${t("agentJobs.pane.pinned")}) · ${model}`
      : `${model} (${t("agentJobs.pane.pinned")})`;
  }
  function modelWarning(harness: Harness, model: string | null) {
    return model && !validateModel(harness, model).ok
      ? t("agentJobs.pane.invalidClaudeModel")
      : null;
  }
  function modeLabel(mode: string) {
    return t(mode === "read-only" ? "agentJobs.pane.readOnly" : `agentJobs.mode.${mode}`);
  }
  const runningPlaceholders = runningPreset
    ? extractPlaceholders(runningPreset.prompt).filter(
        (name) => !(runningPreset.fanOut && name === "pr")
      )
    : [];
  const missingPlaceholder = runningPlaceholders.find((name) => !values[name]?.trim());
  const fanOutTimes = new Map<string, number>();
  for (const job of jobs)
    if (job.fanOutId)
      fanOutTimes.set(job.fanOutId, Math.max(fanOutTimes.get(job.fanOutId) || 0, job.createdAt));
  const sortedJobs = [...jobs].sort((a, b) => {
    const aTime = a.fanOutId ? fanOutTimes.get(a.fanOutId)! : a.createdAt;
    const bTime = b.fanOutId ? fanOutTimes.get(b.fanOutId)! : b.createdAt;
    if (aTime !== bTime) return bTime - aTime;
    if (a.fanOutId && a.fanOutId === b.fanOutId) return (a.fanOutIndex || 0) - (b.fanOutIndex || 0);
    return (a.fanOutId || a.jobId).localeCompare(b.fanOutId || b.jobId);
  });
  return (
    <IntegrationsPane title={title} description={t("agentJobs.pane.description")}>
      {error && (
        <p
          role="alert"
          className="sticky top-0 z-20 rounded-md border border-destructive bg-background p-2 text-xs text-destructive"
        >
          {t("agentJobs.pane.actionError")}: {error}
        </p>
      )}
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
                    {project.defaultHarness} ·{" "}
                    {project.mode !== "write" && `${modeLabel(project.mode)} · `}
                    {t(guaranteeKey(project.defaultHarness, project.mode))} ·{" "}
                    {modelLabel(project.model, project.defaultHarness)}
                  </p>
                  {modelWarning(project.defaultHarness, project.model) && (
                    <p role="alert" className="mt-1 text-xs text-destructive">
                      {modelWarning(project.defaultHarness, project.model)}
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setDraft({ ...project });
                      setEditingName(project.name);
                      setCustomModel(
                        Boolean(
                          project.model && !listedModels.some((model) => model.id === project.model)
                        )
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
                  {probe[project.defaultHarness]?.error === null
                    ? `${probe[project.defaultHarness]?.path} · ${probe[project.defaultHarness]?.version}`
                    : probe[project.defaultHarness]?.error}{" "}
                  ·{" "}
                  <span
                    className={
                      probe[project.defaultHarness]?.auth.state === "not_authenticated"
                        ? "text-destructive"
                        : ""
                    }
                  >
                    {authLabel(project.defaultHarness)}
                  </span>
                </p>
              )}
              {project.defaultHarness === "cursor-agent" &&
                modelProbe?.reason === "workspace_untrusted" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("agentJobs.pane.cursorWorkspaceUntrusted", { folder: project.folder })}
                  </p>
                )}
              {probeDetails(project.defaultHarness)}
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
                      setDraft({
                        ...draft,
                        defaultHarness: harness,
                        mode: harness === "claude" ? "read-only" : "plan",
                        model: null,
                        trustWorkspace: harness === "cursor-agent" ? draft.trustWorkspace : false,
                      });
                      setCustomModel(false);
                      void testHarness(harness);
                    }}
                  >
                    <option value="claude">Claude</option>
                    <option value="cursor-agent">Cursor</option>
                  </select>
                  {draft.defaultHarness === "cursor-agent" && (
                    <span className="block text-muted-foreground">
                      {t("agentJobs.pane.cursorWriteUnavailable")}
                    </span>
                  )}
                </label>
                {draft.defaultHarness === "cursor-agent" && (
                  <label className="space-y-1 text-xs">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={Boolean(draft.trustWorkspace)}
                        onChange={(e) => setDraft({ ...draft, trustWorkspace: e.target.checked })}
                      />
                      {t("agentJobs.pane.trustWorkspace")}
                    </span>
                    <span className="block text-muted-foreground">
                      {t("agentJobs.pane.trustWorkspaceDescription")}
                    </span>
                  </label>
                )}
                <label className="space-y-1 text-xs">
                  {t("agentJobs.pane.mode")}
                  <select
                    className={inputClass}
                    value={draft.mode}
                    onChange={(e) =>
                      setDraft({ ...draft, mode: e.target.value as Project["mode"] })
                    }
                  >
                    {draft.defaultHarness === "claude" ? (
                      <>
                        <option value="read-only">{t("agentJobs.pane.readOnly")}</option>
                        <option value="write">{t("agentJobs.guarantee.write")}</option>
                      </>
                    ) : (
                      <>
                        <option value="plan">{t("agentJobs.mode.plan")}</option>
                        <option value="ask">{t("agentJobs.mode.ask")}</option>
                      </>
                    )}
                  </select>
                </label>
                <div className="space-y-1 text-xs">
                  <label htmlFor="agent-project-model">{t("agentJobs.pane.model")}</label>
                  {draft.defaultHarness === "claude" && (
                    <select
                      id="agent-project-model"
                      className={inputClass}
                      value={customModel ? "__other__" : draft.model || ""}
                      onChange={(e) => {
                        setCustomModel(e.target.value === "__other__");
                        setDraft({
                          ...draft,
                          model:
                            e.target.value === "__other__" ? draft.model : e.target.value || null,
                        });
                      }}
                    >
                      <option value="">{t("agentJobs.pane.defaultModel")}</option>
                      <optgroup label={t("agentJobs.pane.aliasesRecommended")}>
                        {models.aliases.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label.split(" (")[0]} ({t("agentJobs.pane.aliasLatest")}) ·{" "}
                            {model.id}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label={t("agentJobs.pane.fullNamesPinned")}>
                        {models.fullNames.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label} · {model.id}
                          </option>
                        ))}
                      </optgroup>
                      <option value="__other__">{t("agentJobs.pane.otherModel")}</option>
                    </select>
                  )}
                  {draft.defaultHarness === "cursor-agent" &&
                    cursorModels(modelProbe?.models).length > 0 && (
                      <select
                        className={inputClass}
                        value={draft.model || ""}
                        onChange={(e) => setDraft({ ...draft, model: e.target.value || null })}
                      >
                        <option value="">{t("agentJobs.pane.defaultModel")}</option>
                        {cursorModels(modelProbe?.models).map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                    )}
                  {draft.defaultHarness === "cursor-agent" && modelProbe?.ok === false && (
                    <p className="text-xs text-muted-foreground">
                      {modelProbe?.reason === "workspace_untrusted"
                        ? t("agentJobs.pane.cursorWorkspaceUntrusted", { folder: draft.folder })
                        : t("agentJobs.pane.cursorModelFallback")}
                    </p>
                  )}
                  {(customModel || draft.defaultHarness === "cursor-agent") && (
                    <div className="space-y-1">
                      {draft.defaultHarness === "claude" && (
                        <label htmlFor="agent-project-custom-model">
                          {t("agentJobs.pane.fullModelName")}
                        </label>
                      )}
                      <input
                        id={
                          draft.defaultHarness === "cursor-agent"
                            ? "agent-project-model"
                            : "agent-project-custom-model"
                        }
                        className={inputClass}
                        dir="ltr"
                        value={draft.model || ""}
                        placeholder={t("agentJobs.pane.optional")}
                        aria-label={t("agentJobs.pane.fullModelName")}
                        aria-invalid={Boolean(modelWarning(draft.defaultHarness, draft.model))}
                        aria-describedby={
                          modelWarning(draft.defaultHarness, draft.model)
                            ? "agent-model-warning"
                            : undefined
                        }
                        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                      />
                    </div>
                  )}
                  {modelWarning(draft.defaultHarness, draft.model) && (
                    <p id="agent-model-warning" role="alert" className="text-xs text-destructive">
                      {modelWarning(draft.defaultHarness, draft.model)}
                    </p>
                  )}
                </div>
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
                {probe[draft.defaultHarness] && (
                  <span
                    className={
                      probe[draft.defaultHarness]?.auth.state === "not_authenticated"
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {authLabel(draft.defaultHarness)}
                  </span>
                )}
              </div>
              {probe[draft.defaultHarness] && (
                <p role="status" className="break-all text-xs text-muted-foreground">
                  {probe[draft.defaultHarness]?.error === null
                    ? `${probe[draft.defaultHarness]?.path} · ${probe[draft.defaultHarness]?.version}`
                    : probe[draft.defaultHarness]?.error}
                </p>
              )}
              {probeDetails(draft.defaultHarness)}
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
      <section className="space-y-2" aria-label={t("agentJobs.presets.title")}>
        <div className="flex items-center justify-between gap-3">
          <SectionLabel>{t("agentJobs.presets.title")}</SectionLabel>
          <Button
            size="sm"
            variant="outline"
            disabled={!projects.length || presetBusy}
            onClick={() => {
              const project = projects[0];
              setPresetDraft({
                id: crypto.randomUUID(),
                name: "",
                project: project.name,
                harness: project.defaultHarness,
                model: project.model,
                mode: project.mode,
                prompt: "",
                description: "",
              });
            }}
          >
            {t("agentJobs.presets.add")}
          </Button>
        </div>
        <SettingsPanel>
          {presets.length === 0 && (
            <SettingsPanelRow>
              <p className="text-xs text-muted-foreground">{t("agentJobs.presets.empty")}</p>
            </SettingsPanelRow>
          )}
          {presets.map((preset) => (
            <SettingsPanelRow key={preset.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">{preset.name}</h3>
                  {preset.description && (
                    <p className="text-xs text-muted-foreground">{preset.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {preset.project} · {preset.harness} ·{" "}
                    {t(guaranteeKey(preset.harness, preset.mode))}
                  </p>
                  {preset.fanOut && (
                    <p className="text-xs text-muted-foreground">
                      {t("agentJobs.presets.openPullRequests")}
                    </p>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" disabled={presetBusy} onClick={() => startPreset(preset)}>
                    {t("agentJobs.presets.run")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPresetDraft({ ...preset })}>
                    {t("agentJobs.pane.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={presetBusy}
                    onClick={() => void removePreset(preset.id)}
                  >
                    {t("agentJobs.pane.remove")}
                  </Button>
                </div>
              </div>
            </SettingsPanelRow>
          ))}
        </SettingsPanel>
        {presetDraft && (
          <SettingsPanel>
            <SettingsPanelRow className="space-y-3">
              <h3 className="text-xs font-semibold">{t("agentJobs.presets.edit")}</h3>
              <label className="block space-y-1 text-xs">
                {t("agentJobs.pane.name")}
                <input
                  dir="auto"
                  className={inputClass}
                  value={presetDraft.name}
                  maxLength={80}
                  onChange={(e) => setPresetDraft({ ...presetDraft, name: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                {t("agentJobs.presets.description")}
                <input
                  dir="auto"
                  className={inputClass}
                  value={presetDraft.description}
                  maxLength={500}
                  onChange={(e) => setPresetDraft({ ...presetDraft, description: e.target.value })}
                />
              </label>
              <label className="block space-y-1 text-xs">
                {t("agentJobs.pane.projects")}
                <select
                  className={inputClass}
                  value={presetDraft.project}
                  onChange={(e) => {
                    const project = projects.find((item) => item.name === e.target.value)!;
                    setPresetDraft({
                      ...presetDraft,
                      project: project.name,
                      harness: project.defaultHarness,
                      mode: project.mode,
                      model: project.model,
                    });
                  }}
                >
                  {projects.map((project) => (
                    <option key={project.name} value={project.name}>
                      {project.name} · {t(guaranteeKey(project.defaultHarness, project.mode))}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1 text-xs">
                {t("agentJobs.pane.model")}
                <input
                  dir="ltr"
                  className={inputClass}
                  value={presetDraft.model || ""}
                  placeholder={t("agentJobs.pane.defaultModel")}
                  onChange={(e) =>
                    setPresetDraft({ ...presetDraft, model: e.target.value || null })
                  }
                />
              </label>
              <label className="block space-y-1 text-xs">
                {t("agentJobs.card.prompt")}
                <textarea
                  dir="auto"
                  className={`${inputClass} min-h-28`}
                  value={presetDraft.prompt}
                  onChange={(e) => setPresetDraft({ ...presetDraft, prompt: e.target.value })}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                {t("agentJobs.presets.placeholderHint")}
              </p>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={Boolean(presetDraft.fanOut)}
                  onChange={(e) =>
                    setPresetDraft({
                      ...presetDraft,
                      fanOut: e.target.checked ? "open-pull-requests" : undefined,
                    })
                  }
                />
                {t("agentJobs.presets.openPullRequests")}
              </label>
              <div className="space-y-1">
                <p className="text-xs font-medium">{t("agentJobs.presets.suggestions")}</p>
                {suggestions
                  .filter((item) =>
                    item.writeOnly ? presetDraft.mode === "write" : presetDraft.mode !== "write"
                  )
                  .map((item) => (
                    <Button
                      key={item.key}
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setPresetDraft({
                          ...presetDraft,
                          name: t(`agentJobs.presets.${item.key}`),
                          description: "",
                          prompt: t(`agentJobs.presets.${item.key}Prompt`),
                        })
                      }
                    >
                      {t(`agentJobs.presets.${item.key}`)}
                    </Button>
                  ))}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={presetBusy || !presetDraft.name.trim() || !presetDraft.prompt.trim()}
                  onClick={() => void savePreset()}
                >
                  {t("agentJobs.pane.save")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPresetDraft(null)}>
                  {t("agentJobs.card.cancel")}
                </Button>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        )}
        {runningPreset && (
          <SettingsPanel>
            <SettingsPanelRow className="space-y-3">
              <h3 className="text-sm font-medium">{runningPreset.name}</h3>
              <p className="text-xs text-muted-foreground">
                {runningPreset.project} ·{" "}
                {t(guaranteeKey(runningPreset.harness, runningPreset.mode))}
              </p>
              {runningPlaceholders.map((name) => (
                <label key={name} className="block space-y-1 text-xs">
                  {name}
                  <input
                    dir="auto"
                    className={inputClass}
                    aria-label={name}
                    value={values[name] || ""}
                    onChange={(e) => {
                      const next = { ...values, [name]: e.target.value };
                      setValues(next);
                      setResolvedPrompt(
                        runningPreset.prompt.replace(
                          /{{([a-zA-Z][a-zA-Z0-9_]*)}}/g,
                          (match, key) => next[key]?.trim() || match
                        )
                      );
                    }}
                  />
                </label>
              ))}
              <label className="block space-y-1 text-xs">
                {t("agentJobs.card.prompt")}
                <textarea
                  dir="auto"
                  className={`${inputClass} min-h-28`}
                  value={resolvedPrompt}
                  readOnly={Boolean(runningPreset.fanOut)}
                  onChange={(e) => setResolvedPrompt(e.target.value)}
                />
              </label>
              {missingPlaceholder && (
                <p role="status" className="text-xs text-muted-foreground">
                  {t("agentJobs.presets.missingValue", { name: missingPlaceholder })}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={presetBusy || !resolvedPrompt.trim() || Boolean(missingPlaceholder)}
                  onClick={() => void runPreset()}
                >
                  {t("agentJobs.presets.run")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRunningPreset(null)}>
                  {t("agentJobs.card.cancel")}
                </Button>
              </div>
            </SettingsPanelRow>
          </SettingsPanel>
        )}
        {Object.values(approvalEntries)
          .filter((entry) => entry.messageId.startsWith("preset-"))
          .map((entry) => (
            <LocalApprovalCard key={entry.key} entry={entry} />
          ))}
        {fanOutApproval && (
          <SettingsPanel>
            <SettingsPanelRow className="space-y-3">
              <h3 className="text-sm font-semibold">
                {t("agentJobs.presets.fanOutApproval", { name: fanOutApproval.presetName })}
              </h3>
              {fanOutApproval.total > 5 && (
                <p className="text-xs text-muted-foreground">
                  {t("agentJobs.presets.showingFive", { total: fanOutApproval.total })}
                </p>
              )}
              <ul
                className="list-disc pl-5 text-xs"
                aria-label={t("agentJobs.presets.openPullRequests")}
              >
                {fanOutApproval.targets.map((target) => (
                  <li key={target.number}>
                    #{target.number} — {target.title}
                  </li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={presetBusy || fanOutApproval.targets.length === 0}
                  onClick={() => {
                    void (async () => {
                      setPresetBusy(true);
                      setError("");
                      try {
                        await window.agentJobs.fanOutApprove(fanOutApproval.id);
                        setFanOutApproval(null);
                      } catch (cause) {
                        setError(errorText(cause));
                      } finally {
                        setPresetBusy(false);
                      }
                    })();
                  }}
                >
                  {t("agentJobs.card.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={presetBusy}
                  onClick={() => {
                    void window.agentJobs.fanOutCancel(fanOutApproval.id);
                    setFanOutApproval(null);
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
          {sortedJobs.map((job) => {
            const status = jobStatus(job.status, job.stalled);
            const elapsed = elapsedTime(job.startedAt, job.endedAt, now);
            const position = queuePosition(job.position);
            return (
              <SettingsPanelRow key={job.jobId} className="space-y-2">
                {job.fanOutId &&
                  sortedJobs.find((item) => item.fanOutId === job.fanOutId)?.jobId ===
                    job.jobId && (
                    <h3 className="text-xs font-semibold">
                      {job.fanOutPresetName} ·{" "}
                      {t("agentJobs.presets.groupCount", {
                        count: sortedJobs.filter((item) => item.fanOutId === job.fanOutId).length,
                        total: job.fanOutTotal,
                      })}
                    </h3>
                  )}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-medium">{job.project.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {job.harness} ·{" "}
                      {job.mode !== "write" && `${modeLabel(job.mode || "read-only")} · `}
                      {t(guaranteeKey(job.harness, job.mode))} ·{" "}
                      {job.model || t("agentJobs.pane.defaultModel")}
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
                {job.authWarning && job.harness === "claude" && (
                  <p className="text-xs text-warning">{t("agentJobs.pane.authSoftWarning")}</p>
                )}
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
                  <p role="alert" className="text-xs text-destructive whitespace-pre-line">
                    {failureDescription(
                      job.reason,
                      job.lastError,
                      t,
                      job.harness,
                      job.mode === "write" ? job : undefined
                    )}
                  </p>
                )}
                {job.status === "cancelled" && job.mode === "write" && job.worktreeCreated && (
                  <p className="text-xs text-muted-foreground whitespace-pre-line">
                    {failureDescription("cancelled", job.lastError, t, job.harness, job)}
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
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!job.sessionId}
                  title={!job.sessionId ? t("agentJobs.pane.noSession") : undefined}
                  onClick={() => void openTerminal(job.jobId)}
                >
                  {t("agentJobs.pane.openTerminal")}
                </Button>
                {job.mode === "write" &&
                  job.worktreeCreated &&
                  job.worktreePath &&
                  !job.discardedAt && (
                    <div className="space-y-1 text-xs break-all">
                      <p>
                        {t("agentJobs.card.branch")}: {job.branch}
                      </p>
                      <p>
                        {t("agentJobs.pane.worktreePath")}: {job.worktreePath}
                      </p>
                      {job.status === "done" && (
                        <pre className="whitespace-pre-wrap">{job.diffStat}</pre>
                      )}
                      {!(["pending", "queued", "running"] as string[]).includes(job.status) && (
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" onClick={() => copyCommands(job)}>
                            {t("agentJobs.pane.copyCommands")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void discard(job.jobId)}
                          >
                            {t("agentJobs.pane.discard")}
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
              </SettingsPanelRow>
            );
          })}
        </SettingsPanel>
      </section>
    </IntegrationsPane>
  );
}
