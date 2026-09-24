import { app, BrowserWindow } from "electron"
import { fileURLToPath } from "node:url"

await app.whenReady()

const window = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  },
})

await window.loadFile(fileURLToPath(new URL("../web/dist/index.html", import.meta.url)))

app.on("window-all-closed", () => app.quit())
