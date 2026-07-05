import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parse as parseEnv } from "dotenv";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const userDataDir = app.getPath("userData");
const configPath = path.join(userDataDir, "config.json");
const bookmakerNames = {};
const browserCollectorSlugs = ["bet365", "meridianbet"];
const packagedBrowserProfileDefaults = {
  BET365_CHROME_PROFILE_DIR: ".browser/bet365-profile",
  MERIDIANBET_CHROME_PROFILE_DIR: ".browser/meridianbet-cdp-profile"
};
const pendingRequestPollIntervalMs = 30_000;
const updateCheckIntervalMs = 30 * 60 * 1000;
const monitorShutdownTimeoutMs = 12_000;

let mainWindow = null;
let monitorProcess = null;
let status = "parado";
let monitorEnv = {};
let supabase = null;
let pendingRequests = [];
let bookmakerIssues = [];
const bookmakerFailureCounts = new Map();
const bookmakerLastErrorMessages = new Map();
const bookmakerFailedRuns = new Set();
let pollTimer = null;
let updateCheckTimer = null;
let updateCheckInFlight = false;
let logParseBuffer = "";
let isShuttingDown = false;
let allowWindowClose = false;
let updateInstallStarted = false;
let updateState = {
  status: "idle",
  message: ""
};

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function loadConfig() {
  return readJson(configPath, {});
}

async function saveConfig(config) {
  await writeJson(configPath, config);
}

async function loadMonitorEnv() {
  if (app.isPackaged) {
    return readJson(path.join(process.resourcesPath, "monitor-env.json"), {});
  }

  try {
    return parseEnv(await readFile(path.join(projectRoot, ".env"), "utf8"));
  } catch {
    return {};
  }
}

function createSupabaseClient(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}

function send(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

async function sendState() {
  const config = await loadConfig();
  const state = {
    status,
    appVersion: app.getVersion(),
    pendingRequests,
    bookmakerIssues,
    updateState
  };
  send("state", state);
  return state;
}

function setUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState
  };
  send("update-state", updateState);
  void sendState();
}

function appendUpdateLog(message) {
  setUpdateState({ message });
  appendLog(message);
}

async function checkForUpdates(reason = "manual") {
  if (!app.isPackaged) {
    setUpdateState({ status: "disabled", message: "Atualizações disponíveis apenas no app instalado." });
    return { ok: false, error: "Atualizações disponíveis apenas no app instalado." };
  }

  if (updateCheckInFlight) {
    return { ok: true, skipped: true };
  }

  if (["downloading", "installing"].includes(updateState.status)) {
    return { ok: true, skipped: true };
  }

  updateCheckInFlight = true;
  if (reason === "manual") {
    setUpdateState({ status: "checking", message: "Verificando atualizações..." });
  }

  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState({ status: "error", message: `Falha ao verificar atualização: ${message}` });
    appendLog(`Falha ao verificar atualização: ${message}`);
    return { ok: false, error: message };
  } finally {
    updateCheckInFlight = false;
  }
}

function bookmakerName(slug) {
  return bookmakerNames[slug] ?? slug;
}

function sendBookmakerIssues() {
  send("bookmaker-issues", bookmakerIssues);
  void sendState();
}

function upsertBookmakerIssue(slug, message) {
  if (!slug || slug === "sync") return;

  const now = new Date().toISOString();
  const existing = bookmakerIssues.find((item) => item.bookmakerSlug === slug);
  if (existing && existing.message === message) {
    existing.updatedAt = now;
  } else if (existing) {
    existing.message = message;
    existing.updatedAt = now;
  } else {
    bookmakerIssues.unshift({
      id: `collector-error:${slug}`,
      type: "collector-error",
      bookmakerSlug: slug,
      bookmakerName: bookmakerName(slug),
      message,
      updatedAt: now
    });
  }

  bookmakerIssues.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  sendBookmakerIssues();
}

function clearBookmakerIssue(slug) {
  bookmakerFailureCounts.delete(slug);
  bookmakerLastErrorMessages.delete(slug);
  bookmakerFailedRuns.delete(slug);
  const nextIssues = bookmakerIssues.filter((item) => item.bookmakerSlug !== slug);
  if (nextIssues.length === bookmakerIssues.length) return;

  bookmakerIssues = nextIssues;
  sendBookmakerIssues();
}

function recordBookmakerRun(slug, errors) {
  if (!slug || slug === "sync") return;

  if (errors <= 0) {
    clearBookmakerIssue(slug);
    return;
  }

  const failures = (bookmakerFailureCounts.get(slug) ?? 0) + 1;
  bookmakerFailureCounts.set(slug, failures);

  if (failures < 2) {
    const nextIssues = bookmakerIssues.filter((item) => item.bookmakerSlug !== slug);
    if (nextIssues.length !== bookmakerIssues.length) {
      bookmakerIssues = nextIssues;
      sendBookmakerIssues();
    }
    return;
  }

  upsertBookmakerIssue(
    slug,
    bookmakerLastErrorMessages.get(slug) ?? `A última coleta terminou com ${errors} erro${errors === 1 ? "" : "s"}. Confira os logs.`
  );
}

function recordBookmakerErrorMessage(slug, message) {
  if (!slug || slug === "sync" || !message) return;

  bookmakerLastErrorMessages.set(slug, message);
  if ((bookmakerFailureCounts.get(slug) ?? 0) >= 2) upsertBookmakerIssue(slug, message);
}

function inspectMonitorLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line) return;

  const bracketed = line.match(/^\[([a-z0-9-]+)]\s+(.+)$/i);
  if (!bracketed) return;

  const slug = bracketed[1];
  const messagePart = bracketed[2];
  const lowerMessage = messagePart.toLowerCase();
  if (/^coleta falhou\b/i.test(messagePart)) {
    bookmakerFailedRuns.add(slug);
    return;
  }

  const errorSeparator = messagePart.indexOf(":");
  if (errorSeparator > -1 && (lowerMessage.startsWith("erro:") || lowerMessage.includes("ltimo erro:"))) {
    recordBookmakerErrorMessage(slug, messagePart.slice(errorSeparator + 1).trim());
    return;
  }

  const runSummary = line.match(/^\[([a-z0-9-]+)]\s+.*?\|\s+(\d+)\s+erros?\./i);
  if (!runSummary) return;

  const summarySlug = runSummary[1];
  const errors = bookmakerFailedRuns.has(summarySlug) ? Math.max(1, Number(runSummary[2])) : Number(runSummary[2]);
  bookmakerFailedRuns.delete(summarySlug);
  recordBookmakerRun(summarySlug, errors);
}

function inspectMonitorOutput(rawText) {
  logParseBuffer += String(rawText ?? "");
  const lines = logParseBuffer.split(/\r?\n/);
  logParseBuffer = lines.pop() ?? "";

  for (const line of lines) inspectMonitorLine(line);
}

function appendLog(message) {
  const rawText = String(message ?? "");
  const text = rawText.trimEnd();
  if (!text) return;
  inspectMonitorOutput(rawText);
  send("log", text);
}

function resolveUserDataPath(configuredPath) {
  if (!configuredPath) return configuredPath;
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(userDataDir, configuredPath);
}

function packagedMonitorExtraEnv() {
  const extraEnv = {
    ELECTRON_RUN_AS_NODE: "1"
  };

  for (const [key, defaultPath] of Object.entries(packagedBrowserProfileDefaults)) {
    const configuredPath = typeof monitorEnv[key] === "string" && monitorEnv[key].trim() ? monitorEnv[key].trim() : defaultPath;
    extraEnv[key] = resolveUserDataPath(configuredPath);
  }

  return extraEnv;
}

function monitorRunConfig() {
  if (app.isPackaged) {
    const monitorDir = path.join(process.resourcesPath, "monitor");
    return {
      command: process.execPath,
      args: [path.join(monitorDir, "dist", "jobs", "sync-watch.js")],
      cwd: monitorDir,
      extraEnv: packagedMonitorExtraEnv()
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "sync:watch"],
    cwd: projectRoot,
    extraEnv: {}
  };
}

async function resetBrowserCollectionState() {
  if (!supabase || browserCollectorSlugs.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await supabase.from("bookmaker_collection_state").upsert(
    browserCollectorSlugs.map((bookmakerSlug) => ({
      bookmaker_slug: bookmakerSlug,
      status: "idle",
      lease_until: null,
      updated_at: now
    })),
    { onConflict: "bookmaker_slug" }
  );

  if (error) appendLog(`Não consegui limpar o estado das coletas de navegador: ${error.message}`);
}

async function startMonitor() {
  if (monitorProcess) return { ok: true };

  await resetBrowserCollectionState();

  const run = monitorRunConfig();
  const env = {
    ...process.env,
    ...monitorEnv,
    ...run.extraEnv
  };

  status = "iniciando";
  await sendState();
  appendLog("Iniciando monitor...");

  monitorProcess = spawn(run.command, run.args, {
    cwd: run.cwd,
    env,
    windowsHide: false,
    stdio: app.isPackaged ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"]
  });

  monitorProcess.stdout?.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  monitorProcess.stderr?.on("data", (chunk) => appendLog(chunk.toString("utf8")));
  monitorProcess.on("error", async (error) => {
    status = "erro";
    appendLog(`Erro ao iniciar: ${error.message}`);
    monitorProcess = null;
    await sendState();
  });
  monitorProcess.on("exit", async (code) => {
    if (logParseBuffer.trim()) {
      inspectMonitorLine(logParseBuffer);
      logParseBuffer = "";
    }

    status = code === 0 || code === null ? "parado" : "erro";
    appendLog(`Monitor encerrado${code === null ? "." : ` com código ${code}.`}`);
    monitorProcess = null;
    await resetBrowserCollectionState();
    await sendState();
  });

  status = "rodando";
  await sendState();
  return { ok: true };
}

async function stopMonitor() {
  appendLog("Parando monitor e fechando abas de coleta...");
  await stopMonitorProcess();
  return { ok: true };
}

async function killProcessTree(processToKill) {
  if (!processToKill?.pid) return;

  if (process.platform !== "win32") {
    processToKill.kill();
    return;
  }

  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(processToKill.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", resolve);
    killer.on("exit", resolve);
  });
}

async function stopMonitorForShutdown() {
  await stopMonitorProcess({ updateStateAfterStop: false });
}

function requestGracefulMonitorStop(processToStop) {
  if (typeof processToStop.send === "function" && processToStop.connected) {
    try {
      processToStop.send({ type: "shutdown" });
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform !== "win32") {
    processToStop.kill("SIGTERM");
    return true;
  }

  return false;
}

function canRequestGracefulMonitorStop(processToStop) {
  return (typeof processToStop.send === "function" && processToStop.connected) || process.platform !== "win32";
}

function waitForProcessExit(processToStop, timeoutMs) {
  if (processToStop.exitCode !== null || processToStop.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => cleanup(false), timeoutMs);
    const cleanup = (exited) => {
      clearTimeout(timer);
      processToStop.removeListener("exit", onExit);
      processToStop.removeListener("error", onError);
      resolve(exited);
    };
    const onExit = () => cleanup(true);
    const onError = () => cleanup(true);

    processToStop.once("exit", onExit);
    processToStop.once("error", onError);
  });
}

async function stopMonitorProcess({ updateStateAfterStop = true } = {}) {
  if (!monitorProcess) {
    status = "parado";
    await resetBrowserCollectionState();
    if (updateStateAfterStop) await sendState();
    return;
  }

  const processToStop = monitorProcess;
  monitorProcess = null;
  processToStop.stdout?.removeAllListeners("data");
  processToStop.stderr?.removeAllListeners("data");
  processToStop.removeAllListeners("exit");
  processToStop.removeAllListeners("error");

  const canStopGracefully = canRequestGracefulMonitorStop(processToStop);
  const gracefulRequested = canStopGracefully ? requestGracefulMonitorStop(processToStop) : false;
  const exited = gracefulRequested ? await waitForProcessExit(processToStop, monitorShutdownTimeoutMs) : false;
  if (!exited) await killProcessTree(processToStop);

  await resetBrowserCollectionState();
  status = "parado";
  if (updateStateAfterStop) await sendState();
}

async function rememberUpdateRestartPreference() {
  const config = await loadConfig();
  const shouldStartAfterUpdate = Boolean(monitorProcess) || status === "rodando" || status === "iniciando";
  await saveConfig({ ...config, startAfterUpdate: shouldStartAfterUpdate });
}

async function startMonitorAfterUpdateIfNeeded() {
  const config = await loadConfig();
  if (!config.startAfterUpdate) return;

  await saveConfig({ ...config, startAfterUpdate: false });
  appendLog("Atualização aplicada. Reiniciando monitor automaticamente...");
  const result = await startMonitor();
  if (!result?.ok) appendLog(result?.error ?? "Não consegui reiniciar o monitor após a atualização.");
}

async function installDownloadedUpdate() {
  if (updateInstallStarted) return;

  updateInstallStarted = true;
  setUpdateState({ status: "installing", message: "Atualização baixada. Reiniciando para instalar..." });

  await rememberUpdateRestartPreference().catch((error) => {
    appendLog(`Não consegui salvar a retomada automática após update: ${error.message}`);
  });

  await stopMonitorForShutdown().catch((error) => {
    appendLog(`Não consegui parar o monitor antes do update: ${error.message}`);
  });

  allowWindowClose = true;
  autoUpdater.quitAndInstall(false, true);
}

function setupAutoUpdater() {
  if (!app.isPackaged) {
    setUpdateState({ status: "disabled", message: "Atualizações disponíveis apenas no app instalado." });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({ status: "checking", message: "Verificando atualizações..." });
  });

  autoUpdater.on("update-available", (info) => {
    appendUpdateLog(`Atualização ${info.version ?? ""} encontrada. Baixando...`.trim());
    setUpdateState({ status: "downloading" });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdateState({ status: "idle", message: "" });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    setUpdateState({ status: "downloading", message: `Baixando atualização: ${percent}%` });
  });

  autoUpdater.on("update-downloaded", () => {
    void installDownloadedUpdate();
  });

  autoUpdater.on("error", (error) => {
    setUpdateState({ status: "error", message: `Falha ao atualizar: ${error.message}` });
    appendLog(`Falha ao verificar/baixar atualização: ${error.message}`);
  });

  setTimeout(() => {
    void checkForUpdates("startup");
  }, 4000);

  updateCheckTimer = setInterval(() => {
    void checkForUpdates("scheduled");
  }, updateCheckIntervalMs);
}

async function shutdownBeforeClose() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  await stopMonitorForShutdown().catch(() => undefined);
  await resetBrowserCollectionState().catch(() => undefined);
}

function normalizeRequest(row) {
  return {
    id: row.id,
    bookmakerSlug: row.bookmaker_slug,
    bookmakerName: bookmakerNames[row.bookmaker_slug] ?? row.bookmaker_slug,
    apiFootballLeagueId: Number(row.api_football_league_id),
    leagueName: row.league_name,
    leagueCountry: row.league_country,
    mode: row.mode,
    reason: row.reason,
    previousUrl: row.previous_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function refreshPendingRequests() {
  if (!supabase) return;

  const { data: bookmakers, error: bookmakerError } = await supabase.from("bookmakers").select("slug,name");
  if (!bookmakerError) {
    for (const row of bookmakers ?? []) {
      if (row.slug && row.name) bookmakerNames[row.slug] = row.name;
    }

    bookmakerIssues = bookmakerIssues.map((issue) => ({
      ...issue,
      bookmakerName: bookmakerName(issue.bookmakerSlug)
    }));
  }

  const { data, error } = await supabase
    .from("bookmaker_league_url_requests")
    .select("id,bookmaker_slug,api_football_league_id,league_name,league_country,mode,reason,previous_url,created_at,updated_at")
    .eq("status", "pending")
    .order("updated_at", { ascending: false });

  if (error) {
    appendLog(`Não consegui ler pendências de URL: ${error.message}`);
    return;
  }

  pendingRequests = (data ?? []).map(normalizeRequest);
  send("pending-requests", pendingRequests);
  await sendState();
}

async function saveCompetitionUrl({ requestId, url }) {
  if (!supabase) return { ok: false, error: "Supabase não configurado." };

  const sourceUrl = String(url ?? "").trim();
  try {
    const parsed = new URL(sourceUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL inválida");
  } catch {
    return { ok: false, error: "Cole uma URL válida da competição." };
  }

  const { data: request, error: requestError } = await supabase
    .from("bookmaker_league_url_requests")
    .select("id,bookmaker_slug,api_football_league_id,league_name,league_country,mode,reason,previous_url")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError) return { ok: false, error: requestError.message };
  if (!request) return { ok: false, error: "Pendência não encontrada." };

  const updatedAt = new Date().toISOString();
  const { error: linkError } = await supabase.from("bookmaker_league_links").upsert(
    {
      bookmaker_slug: request.bookmaker_slug,
      api_football_league_id: Number(request.api_football_league_id),
      league_name: request.league_name,
      league_country: request.league_country,
      source_url: sourceUrl,
      bookmaker_league_name: request.league_name,
      source: "manual",
      raw: {
        updatedBy: "servidor-monitor-odds",
        reason: request.reason,
        previousUrl: request.previous_url,
        requestId: request.id
      },
      updated_at: updatedAt
    },
    { onConflict: "bookmaker_slug,api_football_league_id" }
  );

  if (linkError) return { ok: false, error: linkError.message };

  const { error: resolveError } = await supabase
    .from("bookmaker_league_url_requests")
    .delete()
    .eq("id", request.id);

  if (resolveError) return { ok: false, error: resolveError.message };

  appendLog(`URL salva para ${bookmakerNames[request.bookmaker_slug] ?? request.bookmaker_slug}: ${request.league_name}.`);
  await refreshPendingRequests();
  return { ok: true };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 640,
    minHeight: 560,
    title: "Servidor Monitor Odds",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(currentDir, "index.html"));
  mainWindow.on("close", (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (isShuttingDown) return;

    isShuttingDown = true;
    void shutdownBeforeClose().finally(() => {
      allowWindowClose = true;
      mainWindow?.close();
    });
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  monitorEnv = await loadMonitorEnv();
  supabase = createSupabaseClient(monitorEnv);
  createWindow();
  setupAutoUpdater();
  await refreshPendingRequests();
  pollTimer = setInterval(refreshPendingRequests, pendingRequestPollIntervalMs);
  await startMonitorAfterUpdateIfNeeded();
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (monitorProcess) void killProcessTree(monitorProcess);
});

ipcMain.handle("start-monitor", startMonitor);
ipcMain.handle("stop-monitor", stopMonitor);
ipcMain.handle("get-state", sendState);
ipcMain.handle("check-updates", () => checkForUpdates("manual"));
ipcMain.handle("save-competition-url", (_event, payload) => saveCompetitionUrl(payload));
ipcMain.handle("open-user-data", () => userDataDir);

if (os.platform() !== "darwin") {
  app.on("window-all-closed", () => app.quit());
}
