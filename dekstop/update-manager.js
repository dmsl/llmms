const { autoUpdater } = require('electron-updater');
const { ipcMain, ipcRenderer } = require('electron');

class UpdateManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.updateAvailable = false;
  }

  initialize() {
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on('update-available', () => {
      this.updateAvailable = true;
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update:available');
      }
    });

    autoUpdater.on('update-downloaded', () => {
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update:downloaded');
      }
    });

    autoUpdater.on('error', (error) => {
      console.error('[UpdateManager] Error:', error);
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update:error', error.message);
      }
    });
  }

  quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  checkForUpdates() {
    return autoUpdater.checkForUpdates();
  }
}

function setupUpdateHandlers(updateManager) {
  ipcMain.handle('update:check', async () => {
    try {
      const result = await updateManager.checkForUpdates();
      return result?.updateInfo ? { available: true } : { available: false };
    } catch (error) {
      console.error('[UpdateManager] Check failed:', error);
      return { available: false, error: error.message };
    }
  });

  ipcMain.handle('update:install', () => {
    updateManager.quitAndInstall();
    return true;
  });
}

module.exports = { UpdateManager, setupUpdateHandlers };
