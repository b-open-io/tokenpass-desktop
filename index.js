const { app, Menu, Tray, nativeImage } = require('electron')
const { join } = require('path')

// Disable sandbox for macOS development (required for Electron 40+)
app.commandLine.appendSwitch('no-sandbox')

let tray = null

const createTray = () => {
  try {
    const iconPath = join(__dirname, 'extraResources', 'icon.png')
    console.log('Icon path:', iconPath)

    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      console.error('Icon is empty! Check path:', iconPath)
      return
    }

    // Resize for macOS menu bar (16x16 or 18x18)
    const resizedIcon = icon.resize({ width: 18, height: 18 })
    tray = new Tray(resizedIcon)
    console.log('Tray created successfully')

    const contextMenu = Menu.buildFromTemplate([{
      label: 'Dashboard',
      click: async () => {
        const open = (await import('open')).default
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
    console.log('Tray setup complete')
  } catch (err) {
    console.error('Error creating tray:', err)
  }
}

const init = async () => {
  console.log('Initializing TokenPass...')
  createTray()
  try {
    const open = (await import('open')).default
    await open('http://localhost:21000')
    console.log('Opened browser')
  } catch (err) {
    console.error('Error opening browser:', err)
  }
}

app.whenReady().then(() => {
  console.log('App ready')
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
