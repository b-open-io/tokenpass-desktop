const { app, Menu, Tray, nativeImage, shell } = require('electron')
const { join } = require('path')
const { spawn, exec } = require('child_process')

// Disable sandbox for macOS development (required for Electron 40+)
app.commandLine.appendSwitch('no-sandbox')

let tray = null
let serverProcess = null

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

  const DASHBOARD_URL = 'http://localhost:21000'

  // Open dashboard, reusing existing Chrome tab if possible (macOS only)
  function openDashboard() {
    if (process.platform !== 'darwin') {
      shell.openExternal(DASHBOARD_URL)
      return
    }

    // AppleScript to find and focus existing Chrome tab, or open new one
    const script = `
      tell application "System Events"
        set chromeRunning to (name of processes) contains "Google Chrome"
      end tell
      if chromeRunning then
        tell application "Google Chrome"
          set found to false
          repeat with w in windows
            set tabIndex to 0
            repeat with t in tabs of w
              set tabIndex to tabIndex + 1
              if URL of t starts with "${DASHBOARD_URL}" then
                set active tab index of w to tabIndex
                set index of w to 1
                activate
                set found to true
                exit repeat
              end if
            end repeat
            if found then exit repeat
          end repeat
          if not found then
            open location "${DASHBOARD_URL}"
            activate
          end if
        end tell
      else
        open location "${DASHBOARD_URL}"
      end if
    `

    exec(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, (err) => {
      if (err) {
        console.log('AppleScript failed, using fallback:', err.message)
        shell.openExternal(DASHBOARD_URL)
      }
    })
  }

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
        click: () => {
          openDashboard()
        }
      }, {
        label: 'Launch at Login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (menuItem) => {
          const settings = { openAtLogin: menuItem.checked }
          // macOS-only: start hidden (tray only, no dock icon)
          if (process.platform === 'darwin') {
            settings.openAsHidden = true
          }
          app.setLoginItemSettings(settings)
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

  const startServer = () => {
    // Use bundled standalone server
    const serverDir = app.isPackaged
      ? join(process.resourcesPath, 'server', 'web')
      : join(__dirname, 'server', 'web')

    console.log('Starting server from:', serverDir)

    serverProcess = spawn('node', ['server.js'], {
      cwd: serverDir,
      env: { ...process.env, PORT: '21000', HOSTNAME: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    serverProcess.stdout.on('data', (data) => {
      console.log(`[server] ${data.toString().trim()}`)
    })

    serverProcess.stderr.on('data', (data) => {
      console.error(`[server] ${data.toString().trim()}`)
    })

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err)
    })

    serverProcess.on('close', (code) => {
      console.log(`Server exited with code ${code}`)
      serverProcess = null
    })
  }

  const init = async () => {
    console.log('Initializing TokenPass...')
    startServer()
    createTray()

    // Wait for server to start before opening browser
    setTimeout(() => {
      openDashboard()
      console.log('Opened browser')
    }, 2000)
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

  app.on('will-quit', () => {
    if (serverProcess) {
      console.log('Stopping server...')
      serverProcess.kill()
    }
  })

  if (app.dock) {
    app.dock.hide()
  }
}
