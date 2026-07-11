const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");

const isDev = !app.isPackaged;
const appName = "NexaBot";

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 780,
    show: false,
    title: appName,
    icon: path.join(__dirname, "icon.png"),
    backgroundColor: "#050505",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    win.loadURL("http://127.0.0.1:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(__dirname, "..", "dist", "index.html");
    win.loadFile(indexPath);
  }

  ipcMain.handle("app:get-info", () => ({
    name: appName,
    version: app.getVersion(),
    isDev,
  }));

  ipcMain.handle("app:open-external", (_event, url) => {
    shell.openExternal(url);
    return true;
  });

  ipcMain.handle("app:show-error", (_event, message) => {
    dialog.showErrorBox(appName, message || "Unknown error");
    return true;
  });
}

app.whenReady().then(() => {
  app.setName(appName);
  app.setAppUserModelId(appName);
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
