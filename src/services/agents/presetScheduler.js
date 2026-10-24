const fs = require("node:fs");
const debugLogger = require("../../helpers/debugLogger");

function createPresetScheduler({
  presetStore,
  projectStore,
  manager,
  resolver,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = debugLogger,
}) {
  let timer = null;
  let stopped = false;
  let ticking = false;

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const preset of presetStore.read().presets) {
        if (stopped) break;
        if (!preset.schedule?.enabled || preset.nextRunAt == null || preset.nextRunAt > now())
          continue;
        const warn = (reason) =>
          logger.warn("Scheduled agent preset skipped", { presetId: preset.id, reason });
        const project = projectStore.read().projects.find((item) => item.name === preset.project);
        if (!project || !fs.existsSync(project.folder)) {
          warn("project_missing");
          continue;
        }
        if (project.mode === "write" || preset.mode === "write") {
          warn("schedule_requires_read_only");
          continue;
        }
        if (
          manager
            .list()
            .some(
              (job) =>
                job.scheduledFrom === preset.id &&
                ["pending", "queued", "running"].includes(job.status)
            )
        ) {
          warn("schedule_already_running");
          continue;
        }
        try {
          const auth = await resolver.authStatus(preset.harness);
          if (stopped) break;
          if (auth.state !== "authenticated") {
            warn("not_authenticated");
            continue;
          }
          const current = presetStore.read().presets.find((item) => item.id === preset.id);
          if (!current?.schedule?.enabled || current.nextRunAt == null || current.nextRunAt > now())
            continue;
          await manager.startScheduled(current);
          presetStore.recordRun(preset.id, now());
        } catch (error) {
          warn(error.message || "start_failed");
        }
      }
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer || stopped) return;
    timer = setIntervalImpl(() => {
      void tick();
    }, 60_000);
    timer.unref?.();
    void tick();
  }
  function stop() {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }
  return { start, stop, tick };
}

module.exports = { createPresetScheduler };
