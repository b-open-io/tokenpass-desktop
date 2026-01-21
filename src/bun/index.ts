import { BrowserWindow, Tray, Updater } from "electrobun/bun";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// Constants
const SERVER_PORT = 21000;
const DASHBOARD_URL = `http://localhost:${SERVER_PORT}`;
const APP_DATA_DIR = join(homedir(), ".tokenpass");
const SETTINGS_FILE = join(APP_DATA_DIR, "settings.json");
const PID_FILE = join(APP_DATA_DIR, "tokenpass.pid");
const LOG_FILE = join(APP_DATA_DIR, "tokenpass.log");
const MAX_START_RETRIES = 3;

// Ensure app data directory exists
if (!existsSync(APP_DATA_DIR)) {
  mkdirSync(APP_DATA_DIR, { recursive: true });
}

// Settings interface
interface Settings {
  useBetaChannel: boolean;
  launchAtLogin: boolean;
}

const defaultSettings: Settings = {
  useBetaChannel: false,
  launchAtLogin: false,
};

function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      return { ...defaultSettings, ...JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) };
    }
  } catch {
    // Use defaults
  }
  return defaultSettings;
}

function saveSettings(settings: Settings): void {
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

// Logging
function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  console.log(msg);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Ignore
  }
}

log("=== TokenPass (Electrobun) starting ===");

// Singleton lock
function acquireSingletonLock(): boolean {
  try {
    if (existsSync(PID_FILE)) {
      const existingPid = readFileSync(PID_FILE, "utf8").trim();
      try {
        process.kill(Number.parseInt(existingPid), 0);
        log(`Another instance already running (PID: ${existingPid})`);
        return false;
      } catch {
        log("Removing stale PID file");
      }
    }
    writeFileSync(PID_FILE, String(process.pid));
    return true;
  } catch (err) {
    log(`Failed to acquire singleton lock: ${err}`);
    return false;
  }
}

function releaseSingletonLock(): void {
  try {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  } catch {
    // Ignore
  }
}

if (!acquireSingletonLock()) {
  log("Exiting - another instance is already running");
  process.exit(0);
}

// Server state
let serverStatus: "starting" | "running" | "error" = "starting";
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let startRetries = 0;

// Dashboard window
let dashboardWindow: BrowserWindow<unknown> | null = null;

// Determine server directory based on whether we're running in electrobun or directly via bun
// Direct bun: import.meta.dir is src/bun, process.argv[1] contains "src/bun/index.ts"
// Electrobun: import.meta.dir is inside app bundle's Resources/app/bun
const isElectrobun = import.meta.dir.includes(".app/Contents/Resources") ||
  process.execPath.includes(".app/Contents/MacOS");
const isPackaged = isElectrobun;

// In electrobun mode: server is at Resources/app/server/web
// In direct bun mode: server is at ./server/web
const serverDir = isElectrobun
  ? resolve(import.meta.dir, "../server/web")
  : resolve(import.meta.dir, "../../server/web");

log(`isPackaged: ${isPackaged}`);
log(`serverDir: ${serverDir}`);

// Health check
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

// Open dashboard in native window
function openDashboard(): void {
  log("Opening dashboard...");

  // If window already exists, just focus it
  if (dashboardWindow) {
    try {
      dashboardWindow.focus();
      log("Focused existing dashboard window");
      return;
    } catch {
      // Window may have been closed, create a new one
      dashboardWindow = null;
    }
  }

  // Create new dashboard window
  dashboardWindow = new BrowserWindow({
    title: "TokenPass",
    url: DASHBOARD_URL,
    frame: {
      x: 100,
      y: 100,
      width: 1200,
      height: 800,
    },
    renderer: "cef", // Use CEF for better compatibility
    titleBarStyle: "default",
  });

  // Handle window close
  dashboardWindow.on("close", () => {
    log("Dashboard window closed");
    dashboardWindow = null;
  });

  log("Created dashboard window");
}

// Notifications (platform-specific)
function showNotification(title: string, body: string): void {
  if (process.platform === "darwin") {
    Bun.spawn(["osascript", "-e", `display notification "${body}" with title "${title}"`]);
  } else if (process.platform === "win32") {
    const ps = `
      [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
      $template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02
      $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)
      $text = $xml.GetElementsByTagName("text")
      $text[0].AppendChild($xml.CreateTextNode("${title}"))
      $text[1].AppendChild($xml.CreateTextNode("${body}"))
      $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
      [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("TokenPass").Show($toast)
    `;
    Bun.spawn(["powershell", "-Command", ps]);
  } else {
    Bun.spawn(["notify-send", title, body]);
  }
}

// Start the Next.js standalone server
function startServer(): void {
  // Kill existing server process if any
  if (serverProc) {
    log("Killing existing server process");
    serverProc.kill();
    serverProc = null;
  }

  serverStatus = "starting";
  updateTrayMenu();
  startRetries++;

  log(`Starting server from: ${serverDir}`);

  // Check if server directory exists
  if (!existsSync(serverDir)) {
    log(`ERROR: Server directory not found: ${serverDir}`);
    serverStatus = "error";
    updateTrayMenu();
    showNotification("TokenPass Error", "Server directory not found");
    return;
  }

  const serverJsPath = join(serverDir, "server.js");
  if (!existsSync(serverJsPath)) {
    log(`ERROR: server.js not found: ${serverJsPath}`);
    serverStatus = "error";
    updateTrayMenu();
    showNotification("TokenPass Error", "server.js not found");
    return;
  }

  // Use node to run the Next.js standalone server
  serverProc = Bun.spawn(["node", "server.js"], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      HOSTNAME: "0.0.0.0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stdout for ready detection
  const stdoutReader = serverProc.stdout.getReader();
  (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n").filter(Boolean)) {
        log(`[server] ${line}`);
        if (line.includes("Ready") || line.includes("started")) {
          serverStatus = "running";
          startRetries = 0;
          updateTrayMenu();
          // Wait for server to fully initialize before opening dashboard
          setTimeout(async () => {
            // Verify server is responding before opening
            const healthy = await checkServerHealth();
            if (healthy) {
              openDashboard();
            } else {
              log("Server not ready yet, retrying in 1s...");
              setTimeout(() => openDashboard(), 1000);
            }
          }, 500);
        }
      }
    }
  })();

  // Read stderr
  const stderrReader = serverProc.stderr.getReader();
  (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await stderrReader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n").filter(Boolean)) {
        log(`[server:err] ${line}`);
      }
    }
  })();

  // Handle process exit
  serverProc.exited.then((code) => {
    log(`Server exited with code ${code}`);
    serverProc = null;

    if (code !== 0) {
      serverStatus = "error";
      updateTrayMenu();

      // Auto-retry if we haven't exceeded max retries
      if (startRetries < MAX_START_RETRIES) {
        log(`Server crashed, retrying in 2 seconds (${startRetries}/${MAX_START_RETRIES})`);
        setTimeout(() => startServer(), 2000);
      } else {
        log("Max retries exceeded, server will not restart automatically");
        showNotification(
          "TokenPass Server Failed",
          "Server failed to start after multiple attempts. Right-click tray icon to retry."
        );
      }
    }
  });
}

// Launch at login (platform-specific)
async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (process.platform === "darwin") {
    // In electrobun mode, find the .app bundle
    // execPath is at .app/Contents/MacOS/bun, so go up 3 levels
    const appPath = isElectrobun
      ? resolve(process.execPath, "../../../") // .app bundle path
      : process.execPath;

    const script = enabled
      ? `tell application "System Events" to make login item at end with properties {path:"${appPath}", hidden:true}`
      : `tell application "System Events" to delete login item "TokenPass"`;

    try {
      await Bun.spawn(["osascript", "-e", script]).exited;
      log(`Launch at login ${enabled ? "enabled" : "disabled"}`);
    } catch (err) {
      log(`Failed to set launch at login: ${err}`);
    }
  } else if (process.platform === "win32") {
    const appPath = process.execPath;
    const cmd = enabled
      ? `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v TokenPass /d "${appPath}" /f`
      : `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v TokenPass /f`;
    await Bun.spawn(["cmd", "/c", cmd]).exited;
  } else {
    // Linux: .desktop file in ~/.config/autostart/
    const desktopPath = join(homedir(), ".config/autostart/tokenpass.desktop");
    if (enabled) {
      const content = `[Desktop Entry]
Type=Application
Name=TokenPass
Exec=${process.execPath}
Hidden=false
X-GNOME-Autostart-enabled=true`;
      mkdirSync(join(homedir(), ".config/autostart"), { recursive: true });
      writeFileSync(desktopPath, content);
    } else {
      try {
        unlinkSync(desktopPath);
      } catch {
        // Ignore
      }
    }
  }
}

// Handle deep links (check command line args)
function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    log(`Deep link received: ${url}`);

    if (parsed.pathname === "/callback" || parsed.pathname === "//callback") {
      const code = parsed.searchParams.get("code");
      const state = parsed.searchParams.get("state");
      log(`OAuth callback: code=${code ? "present" : "missing"}, state=${state}`);
      // TODO: Forward to web server or handle locally
    }
  } catch (err) {
    log(`Failed to parse deep link: ${err}`);
  }
}

// Check for deep link in command line args
const deepLinkUrl = process.argv.find(
  (arg) => arg.startsWith("sigmaauth://") || arg.startsWith("tokenpass://")
);
if (deepLinkUrl) {
  handleDeepLink(deepLinkUrl);
}

// Tray - icon only, no text
const tray = new Tray({
  title: "",
  image: "views://assets/icon.png",
  template: true,
  width: 18,
  height: 18,
});

function updateTrayMenu(): void {
  const statusLabel = {
    starting: "Starting...",
    running: "Running",
    error: "Error (click Restart)",
  }[serverStatus];

  tray.setMenu([
    { type: "normal", label: "Dashboard", action: "dashboard", enabled: serverStatus === "running" },
    { type: "normal", label: "Restart Server", action: "restart" },
    { type: "divider" },
    { type: "normal", label: "Launch at Login", action: "toggle-launch-at-login", checked: settings.launchAtLogin },
    { type: "normal", label: "Beta Updates", action: "toggle-beta", checked: settings.useBetaChannel },
    { type: "normal", label: "Check for Updates", action: "check-updates" },
    { type: "divider" },
    { type: "normal", label: `Status: ${statusLabel}`, enabled: false },
    { type: "divider" },
    { type: "normal", label: "Exit", action: "exit" },
  ]);
}

tray.on("tray-clicked", async (e) => {
  const { action } = e.data as { id: number; action: string };

  if (action === "") {
    updateTrayMenu();
    return;
  }

  log(`Tray action: ${action}`);

  switch (action) {
    case "dashboard":
      openDashboard();
      break;
    case "restart":
      startRetries = 0; // Reset retry count for manual restart
      startServer();
      break;
    case "toggle-launch-at-login":
      settings.launchAtLogin = !settings.launchAtLogin;
      saveSettings(settings);
      await setLaunchAtLogin(settings.launchAtLogin);
      updateTrayMenu();
      break;
    case "toggle-beta":
      settings.useBetaChannel = !settings.useBetaChannel;
      saveSettings(settings);
      updateTrayMenu();
      checkForUpdates();
      break;
    case "check-updates":
      checkForUpdates();
      break;
    case "exit":
      cleanup();
      process.exit(0);
      break;
  }
});

async function checkForUpdates(): Promise<void> {
  try {
    log("Checking for updates...");
    const updateInfo = await Updater.checkForUpdate();

    if (updateInfo.updateAvailable) {
      log(`Update available: ${updateInfo.version}`);
      showNotification("Update Available", `TokenPass ${updateInfo.version} is available`);

      // Download update
      await Updater.downloadUpdate();

      // Check if ready to install
      const info = Updater.updateInfo();
      if (info?.updateReady) {
        showNotification("Update Ready", "TokenPass will update on next restart");
        // User can manually restart or we could prompt
      }
    } else if (updateInfo.error) {
      log(`Update check error: ${updateInfo.error}`);
    } else {
      log("No updates available");
    }
  } catch (err) {
    log(`Update check failed: ${err}`);
  }
}

function cleanup(): void {
  log("Cleaning up...");
  if (serverProc) {
    log("Stopping server...");
    serverProc.kill();
    serverProc = null;
  }
  releaseSingletonLock();
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Initialize
updateTrayMenu();
startServer();

// Health check polling
setInterval(async () => {
  if (serverStatus === "running") {
    const healthy = await checkServerHealth();
    if (!healthy) {
      log("Server stopped responding");
      serverStatus = "error";
      updateTrayMenu();

      // Try to restart the server
      if (startRetries < MAX_START_RETRIES) {
        log(`Attempting to restart server (retry ${startRetries + 1}/${MAX_START_RETRIES})`);
        startServer();
      }
    }
  }
}, 5000);

// Check for updates after startup
setTimeout(() => checkForUpdates(), 5000);

log("TokenPass (Electrobun) initialized");
