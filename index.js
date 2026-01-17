const { app, Menu, Tray, nativeImage } = require('electron')
const { join } = require('path')

// Disable sandbox for macOS development (required for Electron 40+)
app.commandLine.appendSwitch('no-sandbox')

let tray = null

// SINGLETON LOCK - Ensure only one instance runs
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  // Another instance is already running, quit immediately
  console.log('Another instance is already running. Quitting...')
  app.quit()
} else {
  // Handle second instance attempt
  app.on('second-instance', (event, argv) => {
    // Check for deep link URL in command line args
    const url = argv.find(arg => arg.startsWith('sigmaauth://') || arg.startsWith('tokenpass://'))
    if (url) {
      handleDeepLink(url)
    }

    // Focus the existing window/tray if available
    console.log('Second instance attempted - focusing existing instance')
  })

  // Handle deep link (for OAuth callbacks)
  function handleDeepLink(url) {
    try {
      const parsed = new URL(url)
      console.log('Deep link received:', url)

      if (parsed.pathname === '/callback' || parsed.pathname === '//callback') {
        const code = parsed.searchParams.get('code')
        const state = parsed.searchParams.get('state')
        console.log('OAuth callback received:', { code: code ? 'present' : 'missing', state })

        // TODO: Forward to the web server or handle locally
        // For now, just log that we received the callback
      }
    } catch (err) {
      console.error('Failed to parse deep link:', err)
    }
  }

  // Register protocol handler for deep links
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('sigmaauth', process.execPath, [process.argv[1]])
      app.setAsDefaultProtocolClient('tokenpass', process.execPath, [process.argv[1]])
    }
  } else {
    app.setAsDefaultProtocolClient('sigmaauth')
    app.setAsDefaultProtocolClient('tokenpass')
  }

  // Handle protocol URL on macOS
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

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
        type: 'separator'
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
}
