const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const { readAutoUpdatesEnabled, writeAutoUpdatesEnabled } = require("./helpers/updatePreferences");
const { shouldSchedule, shouldCheck, delayFor } = require("./helpers/updateSchedule");
const { createUpdaterLog } = require("./helpers/updaterLog");

// electron-updater can only replace an AppImage on Linux; deb, rpm and tar.gz
// installs are updated by the package manager instead.
const isUpdaterSupported = process.platform !== "linux" || Boolean(process.env.APPIMAGE);

class UpdateManager {
  constructor() {
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.downloadProgress = 0;
    this.isQuittingForUpdate = false;
    this.handleBeforeQuitForUpdate = null;
    this.eventListeners = [];
    this.windowManager = null;
    this.updaterLog = createUpdaterLog(app.getPath("userData"));
    this.autoUpdatesEnabled = readAutoUpdatesEnabled(app.getPath("userData"));
    this.checkTimer = null;
    this.checkInFlight = false;
    this.backgroundCheck = false;
    this.stopped = false;

    this.setupAutoUpdater();
    this.scheduleCheck("startup");
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setupAutoUpdater() {
    if (process.env.NODE_ENV === "development") {
      return;
    }

    autoUpdater.setFeedURL({
      provider: "github",
      owner: "parsector",
      repo: "openwhispr",
      private: false,
    });
    this.updaterLog.write("INFO", "Feed: https://github.com/parsector/openwhispr/releases; provider=github");

    // Use arch-specific update channel on macOS to prevent arm64/x64
    // from downloading mismatched artifacts. Both builds publish to the
    // same GitHub release, so without this they race on latest-mac.yml.
    // Setting channel to e.g. 'latest-arm64' makes the updater look for
    // 'latest-arm64-mac.yml' instead of the shared 'latest-mac.yml'.
    if (process.platform === "darwin") {
      let nativeArch = process.arch;

      // Detect Rosetta: if an x64 build is running on Apple Silicon,
      // sysctl.proc_translated returns "1". This self-heals users who
      // got stuck on the x64 build from older releases.
      if (process.arch === "x64") {
        try {
          const { execSync } = require("child_process");
          const translated = execSync("sysctl -n sysctl.proc_translated", {
            encoding: "utf8",
            timeout: 3000,
          }).trim();
          if (translated === "1") {
            console.log("🔄 Rosetta detected — switching update channel to arm64");
            nativeArch = "arm64";
          }
        } catch {
          // sysctl.proc_translated doesn't exist on real Intel Macs — ignore
        }
      }

      autoUpdater.channel = nativeArch === "arm64" ? "latest-arm64" : "latest-x64";
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = this.updaterLog.logger;

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.updaterLog.write("INFO", "Checking for updates");
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updaterLog.write("INFO", `Update available: ${info?.version}; files: ${(info?.files || []).map((file) => file.url).join(", ")}`);
        this.updateAvailable = true;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-available", info);
        this._autoDownloadIfEnabled();
      },
      "update-not-available": (info) => {
        this.updaterLog.write("INFO", `No update available; latest: ${info?.version || "unknown"}`);
        this.updateAvailable = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
          this.lastUpdateInfo = null;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        this.updaterLog.write("ERROR", err?.stack || err?.message || String(err));
        if (this.backgroundCheck) return; // The scheduled check reports its own single log line.
        console.error("❌ Auto-updater error:", err);
        const handoffFailed = this.updateDownloaded && process.platform === "darwin" &&
          autoUpdater.squirrelDownloadedUpdate !== true;
        if (this.isDownloading || handoffFailed) this.updateDownloaded = false;
        this.isDownloading = false;
        this.notifyRenderers("update-error", {
          message: err?.message || String(err),
          updateDownloaded: this.updateDownloaded,
        });
      },
      "download-progress": (progressObj) => {
        const milestone = Math.floor(progressObj.percent / 10) * 10;
        if (milestone > this.downloadProgress) this.updaterLog.write("INFO", `Download progress: ${milestone}%`);
        this.downloadProgress = milestone;
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        this.updaterLog.write("INFO", `Update downloaded: ${info?.version || "unknown"}`);
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });

    // electron-updater and Squirrel.Mac emit this on Electron's native
    // autoUpdater (before any windows close), not on the electron-updater instance.
    this.handleBeforeQuitForUpdate = () => {
      this.isQuittingForUpdate = true;
      if (this.windowManager) {
        this.windowManager.isQuitting = true;
        this.windowManager.hotkeyManager.unregisterAll();
      }
    };
    require("electron").autoUpdater.on("before-quit-for-update", this.handleBeforeQuitForUpdate);
  }

  notifyRenderers(channel, data) {
    // Read window refs live from windowManager: cached refs go stale when the
    // control panel is created after boot (start minimized) or recreated.
    const { mainWindow, controlPanelWindow } = this.windowManager ?? {};
    for (const win of [mainWindow, controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  async checkForUpdates({ background = false } = {}) {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      if (!isUpdaterSupported) {
        return {
          updateAvailable: false,
          message: "Updates are installed through the system package manager",
        };
      }

      if (this.checkInFlight || (background && !this.shouldCheck())) {
        return { updateAvailable: false, message: "Update check skipped" };
      }

      this.checkInFlight = true;
      this.backgroundCheck = background;
      if (!background) console.log("🔍 Checking for updates...");
      let result;
      try {
        result = await autoUpdater.checkForUpdates();
      } finally {
        this.checkInFlight = false;
        this.backgroundCheck = false;
      }

      if (result?.isUpdateAvailable && result?.updateInfo) {
        this.updaterLog.write("INFO", `Check result: ${result.updateInfo.version} available`);
        console.log("📋 Update available:", result.updateInfo.version);
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          files: result.updateInfo.files,
          releaseNotes: result.updateInfo.releaseNotes,
        };
      } else {
        this.updaterLog.write("INFO", `Check result: no update; latest ${result?.updateInfo?.version || "unknown"}`);
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
        };
      }
    } catch (error) {
      this.updaterLog.write("ERROR", error?.stack || error?.message || String(error));
      if (background) {
        console.warn("Background update check failed:", error?.message || String(error));
        return { updateAvailable: false, message: "Background update check failed" };
      }
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async downloadUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (this.isDownloading) {
        return {
          success: true,
          status: "in-progress",
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          status: "downloaded",
          message: "Update already downloaded. Ready to install.",
        };
      }

      this.isDownloading = true;
      this.downloadProgress = 0;
      const files = this.lastUpdateInfo?.files || [];
      const arch = autoUpdater.channel === "latest-arm64" ? "arm64" : "x64";
      const chosen = files.find((file) => typeof file.url === "string" && file.url.endsWith("-mac.zip") && file.url.includes(arch)) || files.find((file) => typeof file.url === "string" && file.url.endsWith(".zip"));
      this.updaterLog.write("INFO", `Download start; chosen file: ${chosen?.url || "unknown"}`);
      this.notifyRenderers("update-download-started", { isDownloading: true });
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, status: "started", message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      this.updateDownloaded = false;
      this.updaterLog.write("ERROR", error?.stack || error?.message || String(error));
      this.notifyRenderers("update-error", {
        message: error?.message || String(error), updateDownloaded: false,
      });
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  async installUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDownloading: this.isDownloading,
        downloadProgress: this.downloadProgress,
        logPath: this.updaterLog.file,
        isDevelopment: process.env.NODE_ENV === "development",
        isSupported: isUpdaterSupported,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  setAutoUpdatesEnabled(enabled) {
    writeAutoUpdatesEnabled(app.getPath("userData"), enabled);
    const wasEnabled = this.autoUpdatesEnabled;
    this.autoUpdatesEnabled = enabled;
    if (enabled) this._autoDownloadIfEnabled();
    if (!enabled) this.clearCheckTimer();
    else if (!wasEnabled) this.scheduleCheck("enabled");
  }

  scheduleState() {
    return {
      enabled: this.autoUpdatesEnabled,
      packaged: app.isPackaged,
      supported: isUpdaterSupported,
      development: process.env.NODE_ENV === "development",
      stopped: this.stopped,
      inFlight: this.checkInFlight,
      downloaded: this.updateDownloaded,
    };
  }

  shouldCheck() {
    return shouldCheck(this.scheduleState());
  }

  clearCheckTimer() {
    if (this.checkTimer !== null) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  scheduleCheck(reason) {
    this.clearCheckTimer();
    if (!shouldSchedule(this.scheduleState())) return;
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      if (this.shouldCheck()) void this.checkForUpdates({ background: true });
      this.scheduleCheck("periodic");
    }, delayFor(reason));
  }

  // NSIS and AppImage install a downloaded update from their quit handler, which would
  // replace the executable a reset relaunch starts (an AppImage even moves to a new
  // file name).
  deferInstallOnQuit() {
    autoUpdater.autoInstallOnAppQuit = false;
  }

  // On macOS a finished download is handed to Squirrel.Mac, which installs it on any
  // quit from then on; MacUpdater records that hand-off in squirrelDownloadedUpdate.
  hasStagedUpdate() {
    return process.platform === "darwin" && autoUpdater.squirrelDownloadedUpdate === true;
  }

  _autoDownloadIfEnabled() {
    if (!this.autoUpdatesEnabled || !this.updateAvailable) return;
    // downloadUpdate() is a no-op while a download is in flight or complete;
    // failures surface through the shared "error" handler and the renderers.
    this.downloadUpdate().catch((error) => {
      this.updaterLog.write("ERROR", `Automatic download failed: ${error?.stack || error?.message || String(error)}`);
    });
  }

  cleanup() {
    this.stopped = true;
    this.clearCheckTimer();
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
    if (this.handleBeforeQuitForUpdate) {
      require("electron").autoUpdater.removeListener(
        "before-quit-for-update",
        this.handleBeforeQuitForUpdate
      );
      this.handleBeforeQuitForUpdate = null;
    }
  }
}

module.exports = UpdateManager;
