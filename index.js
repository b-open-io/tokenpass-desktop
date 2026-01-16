import { app, Menu, Tray, nativeImage } from 'electron'
import open from 'open'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

let tray = null

const createTray = () => {
  const iconPath = process.resourcesPath
    ? join(process.resourcesPath, 'extraResources', 'icon.png')
    : join(__dirname, 'extraResources', 'icon.png')

  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([{
    label: 'Dashboard',
    click: () => {
      open('http://localhost:21000')
    }
  }, {
    label: 'Exit',
    click: () => {
      app.quit()
    }
  }])

  if (process.platform === 'win32') {
    tray.on('click', () => {
      tray.popUpContextMenu(contextMenu)
    })
  }

  tray.setToolTip('TokenPass')
  tray.setContextMenu(contextMenu)
}

const init = async () => {
  createTray()
  await open('http://localhost:21000')
}

app.whenReady().then(() => {
  init()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

if (app.dock) {
  app.dock.hide()
}
