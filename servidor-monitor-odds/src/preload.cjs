const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("monitorOdds", {
  selectChrome: () => ipcRenderer.invoke("select-chrome"),
  startMonitor: () => ipcRenderer.invoke("start-monitor"),
  stopMonitor: () => ipcRenderer.invoke("stop-monitor"),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  getState: () => ipcRenderer.invoke("get-state"),
  saveCompetitionUrl: (payload) => ipcRenderer.invoke("save-competition-url", payload),
  onState: (callback) => ipcRenderer.on("state", (_event, value) => callback(value)),
  onLog: (callback) => ipcRenderer.on("log", (_event, value) => callback(value)),
  onUpdateState: (callback) => ipcRenderer.on("update-state", (_event, value) => callback(value)),
  onPendingRequests: (callback) => ipcRenderer.on("pending-requests", (_event, value) => callback(value)),
  onBookmakerIssues: (callback) => ipcRenderer.on("bookmaker-issues", (_event, value) => callback(value))
});
