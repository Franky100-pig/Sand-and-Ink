/* Sand and Ink — desktop shell (Electron)
 *
 * Loads the bundled offline web app (app/index.html) in a plain window.
 * No network access, no auto-update, nothing stored outside the window.
 */
const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    title: 'Sand and Ink',
    backgroundColor: '#efeae0',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,   // 不把用户输入交给系统拼写词典
    },
  })
  // 硬性限制：离线应用不接受外部导航 / 任意新窗口。
  // 唯一例外：导出失败时用新窗口打开 data:/blob: 图片，让用户自己另存为。
  win.webContents.setWindowOpenHandler(({ url }) => {
    return /^(data:image\/|blob:)/i.test(url) ? { action: 'allow' } : { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault()
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.loadFile(path.join(__dirname, 'app', 'index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => app.quit())
