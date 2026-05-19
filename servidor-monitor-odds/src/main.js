import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parse as parseEnv } from "dotenv";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const launcherRoot = path.resolve(currentDir, "..");
const projectRoot = path.resolve(launcherRoot, "..");
const userDataDir = app.getPath("userData");
const configPath = path.join(userDataDir, "config.json");
const bookmakerNames = {
  bet365: "Bet365",
  meridianbet: "MeridianBet"
};
const browserCollectorSlugs = ["bet365", "meridianbet"];
const collectionReleaseAliases = new Set(["chrome", "browser", "navegador"]);

let mainWindow = null;
let monitorProcess = null;
let status = "parado";
let monitorEnv = {};
let supabase = null;
let pendingRequests = [];
let bookmakerIssues = [];
let pollTimer = null;
let logParseBuffer = "";
let isShuttingDown = false;
let allowWindowClose = false;

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
    chromeExecutablePath: config.chromeExecutablePath ?? null,
    pendingRequests,
    bookmakerIssues
  };
  send("state", state);
  return state;
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
  const nextIssues = bookmakerIssues.filter((item) => item.bookmakerSlug !== slug);
  if (nextIssues.length === bookmakerIssues.length) return;

  bookmakerIssues = nextIssues;
  sendBookmakerIssues();
}

function inspectMonitorLine(rawLine) {
  const line = String(rawLine ?? "").trim();
  if (!line) return;

  const bracketed = line.match(/^\[([a-z0-9-]+)]\s+(.+)$/i);
  if (!bracketed) return;

  const slug = bracketed[1];
  const messagePart = bracketed[2];
  const lowerMessage = messagePart.toLowerCase();
  const errorSeparator = messagePart.indexOf(":");
  if (errorSeparator > -1 && (lowerMessage.startsWith("erro:") || lowerMessage.includes("ltimo erro:"))) {
    upsertBookmakerIssue(slug, messagePart.slice(errorSeparator + 1).trim());
    return;
  }

  const runSummary = line.match(/^\[([a-z0-9-]+)]\s+.*?\|\s+(\d+)\s+erros?\./i);
  if (!runSummary) return;

  const summarySlug = runSummary[1];
  const errors = Number(runSummary[2]);
  if (errors > 0) {
    upsertBookmakerIssue(summarySlug, `A ultima coleta terminou com ${errors} erro${errors === 1 ? "" : "s"}. Confira os logs.`);
  } else {
    clearBookmakerIssue(summarySlug);
  }
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

async function selectChromeExecutable() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Selecionar arquivo chrome.exe",
    properties: ["openFile"],
    filters: [{ name: "Chrome", extensions: ["exe"] }]
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const selectedPath = result.filePaths[0];
  const config = await loadConfig();
  await saveConfig({ ...config, chromeExecutablePath: selectedPath });
  await sendState();
  return selectedPath;
}

async function ensureChromeExecutable() {
  const config = await loadConfig();
  if (config.chromeExecutablePath && existsSync(config.chromeExecutablePath)) return config.chromeExecutablePath;
  return selectChromeExecutable();
}

function monitorRunConfig() {
  if (app.isPackaged) {
    const monitorDir = path.join(process.resourcesPath, "monitor");
    return {
      command: process.execPath,
      args: [path.join(monitorDir, "dist", "jobs", "sync-watch.js")],
      cwd: monitorDir,
      extraEnv: {
        ELECTRON_RUN_AS_NODE: "1"
      }
    };
  }

  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", "sync:watch"],
    cwd: projectRoot,
    extraEnv: {}
  };
}

async function startMonitor() {
  if (monitorProcess) return { ok: true };

  const chromeExecutablePath = await ensureChromeExecutable();
  if (!chromeExecutablePath) return { ok: false, error: "Selecione o arquivo chrome.exe para iniciar." };

  const run = monitorRunConfig();
  const env = {
    ...process.env,
    ...monitorEnv,
    ...run.extraEnv,
    BET365_CHROME_EXECUTABLE: chromeExecutablePath,
    MERIDIANBET_CHROME_EXECUTABLE: chromeExecutablePath
  };

  status = "iniciando";
  await sendState();
  appendLog("Iniciando monitor...");

  monitorProcess = spawn(run.command, run.args, {
    cwd: run.cwd,
    env,
    windowsHide: false
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
    appendLog(`Monitor encerrado${code === null ? "." : ` com codigo ${code}.`}`);
    monitorProcess = null;
    await sendState();
  });

  status = "rodando";
  await sendState();
  return { ok: true };
}

async function stopMonitor() {
  if (!monitorProcess) {
    status = "parado";
    await sendState();
    return { ok: true };
  }

  appendLog("Parando monitor...");
  monitorProcess.kill();
  monitorProcess = null;
  status = "parado";
  await sendState();
  return { ok: true };
}

async function releaseCollectionTargets(targets, { notify = true } = {}) {
  if (!supabase) return { ok: false, error: "Supabase nao configurado." };
  const now = new Date().toISOString();
  const { error: bookmakerError } = await supabase.from("bookmakers").upsert(
    targets.map((target) => ({ slug: target, name: bookmakerName(target) })),
    { onConflict: "slug" }
  );
  if (bookmakerError) return { ok: false, error: bookmakerError.message };

  const { data, error } = await supabase
    .from("bookmaker_collection_state")
    .upsert(
      targets.map((target) => ({
        bookmaker_slug: target,
        status: "idle",
        lease_until: null,
        last_error: null,
        updated_at: now
      })),
      { onConflict: "bookmaker_slug" }
    )
    .select("bookmaker_slug,status,lease_until,next_run_at,last_error");

  if (error) return { ok: false, error: error.message };

  const names = (data?.length ? data.map((row) => bookmakerName(row.bookmaker_slug)) : targets.map(bookmakerName)).join(" e ");
  const message = `${names}: coleta liberada.`;
  if (notify) {
    appendLog(message);
    for (const target of targets) clearBookmakerIssue(target);
    await sendState();
  }
  return { ok: true, message };
}

async function releaseCollection(bookmakerSlug) {
  const slug = String(bookmakerSlug ?? "").trim().toLowerCase();
  const targets = collectionReleaseAliases.has(slug) ? browserCollectorSlugs : [slug];
  if (!targets.every((target) => browserCollectorSlugs.includes(target))) {
    return { ok: false, error: "Coleta desconhecida para liberar." };
  }

  return releaseCollectionTargets(targets);
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
  if (!monitorProcess) {
    status = "parado";
    return;
  }

  const processToStop = monitorProcess;
  monitorProcess = null;
  processToStop.stdout?.removeAllListeners("data");
  processToStop.stderr?.removeAllListeners("data");
  processToStop.removeAllListeners("exit");
  processToStop.removeAllListeners("error");
  await killProcessTree(processToStop);
  status = "parado";
}

async function shutdownBeforeClose() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  await stopMonitorForShutdown().catch(() => undefined);
  await releaseCollectionTargets(browserCollectorSlugs, { notify: false }).catch(() => undefined);
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
    appendLog(`Nao consegui ler pendencias de URL: ${error.message}`);
    return;
  }

  pendingRequests = (data ?? []).map(normalizeRequest);
  send("pending-requests", pendingRequests);
  await sendState();
}

async function saveCompetitionUrl({ requestId, url }) {
  if (!supabase) return { ok: false, error: "Supabase nao configurado." };

  const sourceUrl = String(url ?? "").trim();
  try {
    const parsed = new URL(sourceUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL invalida");
  } catch {
    return { ok: false, error: "Cole uma URL valida da competicao." };
  }

  const { data: request, error: requestError } = await supabase
    .from("bookmaker_league_url_requests")
    .select("id,bookmaker_slug,api_football_league_id,league_name,league_country,mode,reason,previous_url")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError) return { ok: false, error: requestError.message };
  if (!request) return { ok: false, error: "Pendencia nao encontrada." };

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
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

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
  monitorEnv = await loadMonitorEnv();
  supabase = createSupabaseClient(monitorEnv);
  createWindow();
  await refreshPendingRequests();
  pollTimer = setInterval(refreshPendingRequests, 5000);
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (monitorProcess) void killProcessTree(monitorProcess);
});

ipcMain.handle("select-chrome", selectChromeExecutable);
ipcMain.handle("start-monitor", startMonitor);
ipcMain.handle("stop-monitor", stopMonitor);
ipcMain.handle("get-state", sendState);
ipcMain.handle("release-collection", (_event, bookmakerSlug) => releaseCollection(bookmakerSlug));
ipcMain.handle("save-competition-url", (_event, payload) => saveCompetitionUrl(payload));
ipcMain.handle("open-user-data", () => userDataDir);

if (os.platform() !== "darwin") {
  app.on("window-all-closed", () => app.quit());
}
