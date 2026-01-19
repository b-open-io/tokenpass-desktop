import { type ChildProcess, exec, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  dialog,
  Menu,
  type MenuItem,
  Notification,
  nativeImage,
  shell,
  Tray,
} from "electron";
import Store from "electron-store";
import { autoUpdater } from "electron-updater";

// Debug logging to file
const logFile = join(process.env.HOME || "/tmp", "tokenpass-debug.log");
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try {
    appendFileSync(logFile, line);
  } catch (e) {
    console.error("Log write failed:", e);
  }
}

// Log immediately on startup
log("=== TokenPass starting ===");
log(`HOME: ${process.env.HOME}`);
log(`Log file: ${logFile}`);

// Store schema for type safety
interface StoreSchema {
  useBetaChannel: boolean;
}

const store = new Store<StoreSchema>({
  defaults: {
    useBetaChannel: false,
  },
});

// Disable sandbox for macOS development (required for Electron 40+)
app.commandLine.appendSwitch("no-sandbox");

// Set app name explicitly for notifications and system dialogs
if (process.platform === "darwin") {
  app.setName("TokenPass");
}

let tray: Tray | null = null;
let serverProcess: ChildProcess | null = null;
let serverStatus: "starting" | "running" | "error" = "starting";
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
const SERVER_PORT = 21000;
const HEALTH_CHECK_INTERVAL = 5000; // 5 seconds
const MAX_START_RETRIES = 3;
let startRetries = 0;

// SINGLETON LOCK - Ensure only one instance runs
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  console.log("Another instance is already running. Quitting...");
  app.quit();
} else {
  // Handle deep link (for OAuth callbacks)
  function handleDeepLink(url: string): void {
    try {
      const parsed = new URL(url);
      console.log("Deep link received:", url);

      if (parsed.pathname === "/callback" || parsed.pathname === "//callback") {
        const code = parsed.searchParams.get("code");
        const state = parsed.searchParams.get("state");
        console.log("OAuth callback received:", {
          code: code ? "present" : "missing",
          state,
        });

        // TODO: Forward to the web server or handle locally
      }
    } catch (err) {
      console.error("Failed to parse deep link:", err);
    }
  }

  // Handle second instance attempt
  app.on("second-instance", (_event, argv) => {
    // Check for deep link URL in command line args
    const url = argv.find(
      (arg) => arg.startsWith("sigmaauth://") || arg.startsWith("tokenpass://"),
    );
    if (url) {
      handleDeepLink(url);
    }

    // Focus the existing window/tray if available
    console.log("Second instance attempted - focusing existing instance");
  });

  // Register protocol handler for deep links
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("sigmaauth", process.execPath, [
        process.argv[1],
      ]);
      app.setAsDefaultProtocolClient("tokenpass", process.execPath, [
        process.argv[1],
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient("sigmaauth");
    app.setAsDefaultProtocolClient("tokenpass");
  }

  // Handle protocol URL on macOS
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  const DASHBOARD_URL = `http://localhost:${SERVER_PORT}`;

  // Update tray tooltip to show server status
  function updateTrayStatus(): void {
    if (!tray) return;

    const statusText: Record<typeof serverStatus, string> = {
      starting: "TokenPass - Starting server...",
      running: "TokenPass - Server running",
      error: "TokenPass - Server error (click to retry)",
    };

    tray.setToolTip(statusText[serverStatus]);
    log(`Server status: ${serverStatus}`);
  }

  // Check if server is healthy by making an HTTP request
  async function checkServerHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(`http://localhost:${SERVER_PORT}`, {
        method: "HEAD",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return response.ok || response.status === 304;
    } catch {
      return false;
    }
  }

  // Start health check polling
  function startHealthCheck(): void {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
    }

    healthCheckInterval = setInterval(async () => {
      const isHealthy = await checkServerHealth();

      if (isHealthy && serverStatus !== "running") {
        serverStatus = "running";
        updateTrayStatus();
        log("Server is now running");
      } else if (!isHealthy && serverStatus === "running") {
        serverStatus = "error";
        updateTrayStatus();
        log("Server stopped responding");

        // Try to restart the server
        if (startRetries < MAX_START_RETRIES) {
          log(`Attempting to restart server (retry ${startRetries + 1}/${MAX_START_RETRIES})`);
          startServer();
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  // Open dashboard, reusing existing Chrome tab if possible (macOS only)
  function openDashboard(): void {
    if (process.platform !== "darwin") {
      shell.openExternal(DASHBOARD_URL);
      return;
    }

    // AppleScript to find and focus existing Chrome tab, or open new one
    const script = `
      tell application "System Events"
        set chromeRunning to (name of processes) contains "Google Chrome"
      end tell
      if chromeRunning then
        tell application "Google Chrome"
          set found to false
          repeat with w in windows
            set tabIndex to 0
            repeat with t in tabs of w
              set tabIndex to tabIndex + 1
              if URL of t starts with "${DASHBOARD_URL}" then
                set active tab index of w to tabIndex
                set index of w to 1
                activate
                set found to true
                exit repeat
              end if
            end repeat
            if found then exit repeat
          end repeat
          if not found then
            open location "${DASHBOARD_URL}"
            activate
          end if
        end tell
      else
        open location "${DASHBOARD_URL}"
      end if
    `;

    exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, (err) => {
      if (err) {
        console.log("AppleScript failed, using fallback:", err.message);
        shell.openExternal(DASHBOARD_URL);
      }
    });
  }

  function createTray(): void {
    try {
      const iconPath = app.isPackaged
        ? join(process.resourcesPath, "extraResources", "icon.png")
        : join(__dirname, "..", "extraResources", "icon.png");
      log(`Icon path: ${iconPath}`);

      const icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        log(`ERROR: Icon is empty! Check path: ${iconPath}`);
        return;
      }

      // Resize for macOS menu bar (16x16 or 18x18)
      const resizedIcon = icon.resize({ width: 18, height: 18 });
      tray = new Tray(resizedIcon);
      log("Tray created successfully");

      const contextMenu = Menu.buildFromTemplate([
        {
          label: "Dashboard",
          click: () => {
            openDashboard();
          },
        },
        {
          label: "Restart Server",
          click: () => {
            log("Manual server restart requested");
            startRetries = 0; // Reset retry count for manual restart
            startServer();
          },
        },
        { type: "separator" },
        {
          label: "Launch at Login",
          type: "checkbox",
          checked: app.getLoginItemSettings().openAtLogin,
          click: (menuItem: MenuItem) => {
            const settings: Electron.Settings = {
              openAtLogin: menuItem.checked,
            };
            // macOS-only: start hidden (tray only, no dock icon)
            if (process.platform === "darwin") {
              settings.openAsHidden = true;
            }
            app.setLoginItemSettings(settings);
          },
        },
        {
          label: "Beta Updates",
          type: "checkbox",
          checked: store.get("useBetaChannel"),
          click: (menuItem: MenuItem) => {
            store.set("useBetaChannel", menuItem.checked);
            autoUpdater.allowPrerelease = menuItem.checked;
            console.log(
              "Update channel changed to:",
              menuItem.checked ? "beta" : "stable",
            );
            // Check for updates with new channel setting
            autoUpdater.checkForUpdates().catch((err: Error) => {
              console.log("Update check failed:", err.message);
            });
          },
        },
        {
          label: "Check for Updates",
          click: () => {
            autoUpdater.checkForUpdates().catch(() => {
              dialog.showMessageBox({
                type: "info",
                title: "Update Check",
                message: "You are running the latest version.",
              });
            });
          },
        },
        {
          type: "separator",
        },
        {
          label: "Exit",
          click: () => {
            app.quit();
          },
        },
      ]);

      if (process.platform === "win32" && tray) {
        tray.on("click", () => {
          tray?.popUpContextMenu(contextMenu);
        });
      }

      tray.setToolTip("TokenPass");
      tray.setContextMenu(contextMenu);
      console.log("Tray setup complete");
    } catch (err) {
      console.error("Error creating tray:", err);
    }
  }

  function startServer(): void {
    // Kill existing server process if any
    if (serverProcess) {
      log("Killing existing server process");
      serverProcess.kill();
      serverProcess = null;
    }

    serverStatus = "starting";
    updateTrayStatus();
    startRetries++;

    // Use bundled standalone server
    const serverDir = app.isPackaged
      ? join(process.resourcesPath, "server", "web")
      : join(__dirname, "..", "server", "web");

    log(`Starting server from: ${serverDir}`);

    serverProcess = spawn("node", ["server.js"], {
      cwd: serverDir,
      env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: "0.0.0.0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString().trim();
      log(`[server] ${output}`);

      // Detect when Next.js reports it's ready
      if (output.includes("Ready") || output.includes("started")) {
        serverStatus = "running";
        updateTrayStatus();
        startRetries = 0; // Reset retries on successful start
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      log(`[server:err] ${data.toString().trim()}`);
    });

    serverProcess.on("error", (err: Error) => {
      log(`Failed to start server: ${err.message}`);
      serverStatus = "error";
      updateTrayStatus();

      // Show notification about server error
      if (Notification.isSupported()) {
        new Notification({
          title: "TokenPass Server Error",
          body: `Failed to start server: ${err.message}`,
        }).show();
      }
    });

    serverProcess.on("close", (code: number | null) => {
      log(`Server exited with code ${code}`);
      serverProcess = null;

      if (code !== 0 && code !== null) {
        serverStatus = "error";
        updateTrayStatus();

        // Auto-retry if we haven't exceeded max retries
        if (startRetries < MAX_START_RETRIES) {
          log(`Server crashed, retrying in 2 seconds (${startRetries}/${MAX_START_RETRIES})`);
          setTimeout(() => startServer(), 2000);
        } else {
          log("Max retries exceeded, server will not restart automatically");
          if (Notification.isSupported()) {
            new Notification({
              title: "TokenPass Server Failed",
              body: "Server failed to start after multiple attempts. Right-click tray icon to retry.",
            }).show();
          }
        }
      }
    });
  }

  async function init(): Promise<void> {
    log("Initializing TokenPass...");
    createTray();
    startServer();
    startHealthCheck();

    // Wait for server to be ready before opening browser
    const maxWaitTime = 15000; // 15 seconds max
    const checkInterval = 500;
    let waited = 0;

    const waitForServer = setInterval(async () => {
      waited += checkInterval;

      if (serverStatus === "running" || (await checkServerHealth())) {
        clearInterval(waitForServer);
        serverStatus = "running";
        updateTrayStatus();
        openDashboard();
        log("Opened browser after server ready");
        return;
      }

      if (waited >= maxWaitTime) {
        clearInterval(waitForServer);
        log("Server did not become ready in time, opening dashboard anyway");
        openDashboard();
      }
    }, checkInterval);
  }

  // Auto-updater configuration
  autoUpdater.autoDownload = false; // Don't auto-download, prompt user first
  autoUpdater.autoInstallOnAppQuit = true;

  // Beta channel support - users can opt-in to prereleases
  const useBetaChannel = store.get("useBetaChannel");
  autoUpdater.allowPrerelease = useBetaChannel;
  console.log("Update channel:", useBetaChannel ? "beta" : "stable");

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("Update available:", info.version);

    // Show notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: "Update Available",
        body: `TokenPass ${info.version} is available. Click to download.`,
        silent: false,
      });

      notification.on("click", () => {
        autoUpdater.downloadUpdate();
      });

      notification.show();
    }

    // Also show dialog
    dialog
      .showMessageBox({
        type: "info",
        title: "Update Available",
        message: `TokenPass ${info.version} is available.`,
        detail: "Would you like to download and install it now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("No updates available");
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("Update downloaded:", info.version);

    dialog
      .showMessageBox({
        type: "info",
        title: "Update Ready",
        message: `TokenPass ${info.version} has been downloaded.`,
        detail: "Restart now to install the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err.message);
  });

  app.whenReady().then(() => {
    log("App ready");
    init();

    // Check for updates after a short delay (let the app initialize first)
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: Error) => {
        console.log("Update check failed:", err.message);
      });
    }, 5000);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", () => {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
    }
    if (serverProcess) {
      log("Stopping server...");
      serverProcess.kill();
    }
  });

  if (app.dock) {
    app.dock.hide();
  }
}
