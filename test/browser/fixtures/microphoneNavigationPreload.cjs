const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("claimMicrophone", () =>
  ipcRenderer.sendSync("navigation-contender-acquire")
);
