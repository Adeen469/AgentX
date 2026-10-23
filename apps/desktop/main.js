const { app, BrowserWindow, dialog, shell } = require("electron");
const path = require("node:path");

const isPackaged = app.isPackaged;
const productionUrl = process.env.AGENTX_WEB_URL || "http://localhost:3000";

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  window.loadURL(productionUrl).catch((error) => {
    dialog.showErrorBox("AgentX could not start", `The application UI could not be loaded.\n\n${error.message}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    dialog.showErrorBox("AgentX stopped responding", `The renderer process exited (${details.reason}). Restart AgentX to continue.`);
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });
}

process.on("uncaughtException", (error) => {
  dialog.showErrorBox("AgentX encountered an error", error.message);
});

process.on("unhandledRejection", (error) => {
  dialog.showErrorBox("AgentX encountered an error", error instanceof Error ? error.message : String(error));
});

app.whenReady().then(() => {
  if (isPackaged && process.platform === "win32") {
    app.setAppUserModelId("com.agentx.desktop");
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
