/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */

import {
    app,
    BrowserWindow,
    ipcMain,
    screen,
    shell,
    Menu,
    Tray,
    nativeImage,
    IpcMainEvent,
    dialog,
    globalShortcut
} from 'electron';
import path from 'path';
import fs from 'fs';
import settings from 'electron-settings';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { exitTheApp, isDev } from './lib/utils';
import { openDevToolsByDefault, useCustomWindowXY } from './dxConfig';
import './ipc';
import { wpAssetPath, wpBinPath } from './ipcListeners/wp';
import { devPlayground } from './playground';
import { logMetadata } from './ipcListeners/log';
import { customEvent } from './lib/customEvent';
import { getTranslate } from '../localization';

let mainWindow: BrowserWindow | null = null;

const appLang = getTranslate('en');
const gotTheLock = app.requestSingleInstanceLock();
const appTitle = 'Oblivion Desktop' + (isDev() ? ' ᴅᴇᴠ' : '');

export const binAssetsPath = path.join(
    app.getAppPath().replace('/app.asar', '').replace('\\app.asar', ''),
    'assets',
    'bin'
);
export const regeditVbsDirPath = path.join(binAssetsPath, 'vbs');

autoUpdater.allowPrerelease = true;
autoUpdater.autoRunAppAfterInstall = true;

if (!gotTheLock) {
    log.info('did not create new instance since there was already one running.');
    app.exit(0);
} else {
    devPlayground();
    log.info('creating new od instance...');
    logMetadata();

    app.on('second-instance', () => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    // coping wp binary from assets dir to userData dir, so it can run without sudo/administrator privilege
    fs.copyFile(wpAssetPath, wpBinPath, (err) => {
        if (err) throw err;
        log.info('wp binary was copied to userData directory.');
    });

    if (!isDev()) {
        const sourceMapSupport = require('source-map-support');
        sourceMapSupport.install();
    }

    const resolveHtmlPath = (htmlFileName: string) => {
        if (isDev()) {
            const port = process.env.PORT || 1212;
            const url = new URL(`http://localhost:${port}`);
            url.pathname = htmlFileName;
            return url.href;
        }
        return `file://${path.resolve(__dirname, '../renderer/', htmlFileName)}`;
    };

    const isDebug = isDev() || process.env.DEBUG_PROD === 'true';

    if (isDebug && openDevToolsByDefault) {
        require('electron-debug')();
    }

    const installExtensions = async () => {
        const installer = require('electron-devtools-installer');
        const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
        const extensions = ['REACT_DEVELOPER_TOOLS'];

        return installer
            .default(
                extensions.map((name) => installer[name]),
                forceDownload
            )
            .catch(console.log);
    };

    const registerQuitShortcut = () => {
        const shortcut = process.platform === 'darwin' ? 'CommandOrControl+Q' : 'Ctrl+Q';
        globalShortcut.register(shortcut, async () => {
            await exitTheApp(mainWindow);
        });
    };

    const unregisterQuitShortcut = () => {
        const shortcut = process.platform === 'darwin' ? 'CommandOrControl+Q' : 'Ctrl+Q';
        globalShortcut.unregister(shortcut);
    };

    const createWindow = async () => {
        if (isDebug) {
            await installExtensions();
        }

        const RESOURCES_PATH = app.isPackaged
            ? path.join(process.resourcesPath, 'assets')
            : path.join(__dirname, '../../assets');

        const getAssetPath = (...paths: string[]): string => {
            return path.join(RESOURCES_PATH, ...paths);
        };

        const windowWidth = 400;
        const windowHeight = 650;

        const config: any = {
            title: appTitle,
            show: false,
            width: windowWidth,
            height: windowHeight,
            enableRemoteModule: true,
            autoHideMenuBar: true,
            transparent: false,
            center: true,
            frame: true,
            resizable: false,
            fullscreenable: false,
            icon: getAssetPath('oblivion.png'),
            webPreferences: {
                nativeWindowOpen: false,
                devTools: false,
                devToolsKeyCombination: false,
                preload: app.isPackaged
                    ? path.join(__dirname, 'preload.js')
                    : path.join(__dirname, '../../.erb/dll/preload.js')
            }
        };

        if (isDev()) {
            const primaryDisplay = screen.getPrimaryDisplay();
            const displayWidth = primaryDisplay.workAreaSize.width;
            const displayHeight = primaryDisplay.workAreaSize.height;
            if (useCustomWindowXY) {
                config.x = displayWidth - windowWidth - 60;
                config.y = displayHeight - windowHeight - 160;
            }
            config.webPreferences.devTools = true;
            config.webPreferences.devToolsKeyCombination = true;
        }

        function createMainWindow() {
            if (!mainWindow) {
                mainWindow = new BrowserWindow(config);

                mainWindow.loadURL(resolveHtmlPath('index.html'));

                mainWindow.on('ready-to-show', async () => {
                    if (!mainWindow) {
                        throw new Error('"mainWindow" is not defined');
                    }
                    /*if (process.env.START_MINIMIZED) {
                        mainWindow.minimize();
                    } else {
                        mainWindow.show();
                    }*/
                    mainWindow.show();
                });

                ipcMain.on('open-devtools', async () => {
                    // TODO add toggle
                    mainWindow?.webContents.openDevTools();
                    // mainWindow.webContents.closeDevTools();
                });

                mainWindow.on('close', async (e: any) => {
                    e.preventDefault();
                    if (isDev()) {
                        console.log(
                            'The od has been closed due to the modification of main.ts ...'
                        );
                        await exitTheApp(mainWindow);
                    } else {
                        mainWindow?.hide();
                    }
                });

                mainWindow.on('closed', async () => {
                    mainWindow = null;
                });

                mainWindow.on('minimize', async (e: any) => {
                    e.preventDefault();
                });

                mainWindow.on('focus', registerQuitShortcut);
                mainWindow.on('blur', unregisterQuitShortcut);

                const menuBuilder = new MenuBuilder(mainWindow);
                menuBuilder.buildMenu();

                // Open urls in the user's browser
                mainWindow.webContents.setWindowOpenHandler((e) => {
                    shell.openExternal(e.url);
                    return { action: 'deny' };
                });
            } else {
                mainWindow.show();
            }
        }

        createMainWindow();

        let appIcon: any = null;
        //let contextMenu: any = null;

        const trayIconChanger = (status: string) => {
            if (process.platform === 'darwin') {
                const nativeImageIcon = nativeImage.createFromPath(
                    getAssetPath(`img/status/${status}.png`)
                );
                return nativeImageIcon.resize({ width: 16, height: 16 });
            } else {
                return getAssetPath(`img/status/${status}.png`);
            }
        };

        let trayMenuEvent: IpcMainEvent;
        ipcMain.on('tray-menu', (event) => {
            trayMenuEvent = event;
        });

        const redirectTo = (value: string) => {
            if (!mainWindow) {
                createMainWindow();
            } else {
                mainWindow.show();
                if (value !== '') {
                    trayMenuEvent?.reply('tray-menu', {
                        key: 'changePage',
                        msg: value
                    });
                }
            }
        };

        const autoConnect = async () => {
            const checkAutoConnect = await settings.get('autoConnect');
            if (typeof checkAutoConnect === 'boolean' && checkAutoConnect) {
                try {
                    /*trayMenuEvent.reply('tray-menu', {
                        key: 'connectToggle',
                        msg: 'Connect Tray Click!'
                    });*/
                    ipcMain.on('tray-menu', (event) => {
                        event.reply('tray-menu', {
                            key: 'connect',
                            msg: 'Connect Tray Click!'
                        });
                    });
                } catch (err) {
                    console.log(err);
                }
            }
        };

        const trayMenuContext: any = (
            connectLabel: string,
            connectStatus: string,
            connectEnable: boolean
        ) => {
            return [
                {
                    label: appTitle,
                    type: 'normal',
                    click: () => {
                        redirectTo('/');
                    }
                },
                { label: '', type: 'separator' },
                {
                    id: 'connectToggle',
                    label: connectLabel,
                    type: 'normal',
                    enabled: connectEnable,
                    click: () => {
                        if (
                            connectStatus.startsWith('connected') ||
                            connectStatus === 'disconnected'
                        ) {
                            trayMenuEvent?.reply('tray-menu', {
                                key: connectStatus === 'disconnected' ? 'connect' : 'disconnect',
                                msg: 'Connect Tray Click!'
                            });
                        }
                        /*appIcon.setContextMenu(
                            Menu.buildFromTemplate(
                                trayMenuContext(
                                    connectStatus === 'connect'
                                        ? appLang.systemTray.connecting
                                        : appLang.systemTray.disconnecting,
                                    connectStatus,
                                    false
                                )
                            )
                        );*/
                        redirectTo('/');
                    }
                },
                {
                    label: appLang.systemTray.settings,
                    submenu: [
                        {
                            label: appLang.systemTray.settings_warp,
                            type: 'normal',
                            click: () => {
                                redirectTo('/settings');
                            }
                        },
                        {
                            label: appLang.systemTray.settings_network,
                            type: 'normal',
                            click: () => {
                                redirectTo('/network');
                            }
                        },
                        {
                            label: appLang.systemTray.settings_scanner,
                            type: 'normal',
                            click: () => {
                                redirectTo('/scanner');
                            }
                        },
                        {
                            label: appLang.systemTray.settings_app,
                            type: 'normal',
                            click: () => {
                                redirectTo('/options');
                            }
                        }
                    ]
                },
                { label: '', type: 'separator' },
                {
                    label: appLang.systemTray.about,
                    type: 'normal',
                    click: () => {
                        redirectTo('/about');
                    }
                },
                {
                    label: appLang.systemTray.log,
                    type: 'normal',
                    click: () => {
                        redirectTo('/debug');
                    }
                },
                { label: '', type: 'separator' },
                {
                    label: appLang.systemTray.exit,
                    type: 'normal',
                    click: async () => {
                        await exitTheApp(mainWindow);
                    }
                }
            ];
        };

        const connectionLabel = (status: string) => {
            let text = '';
            if (status.startsWith('connected')) {
                text = `✓ ${appLang.systemTray.connected}`;
            } else if (status === 'disconnected') {
                text = appLang.systemTray.connect;
            } else if (status === 'connecting') {
                text = appLang.systemTray.connecting;
            } else if (status === 'disconnecting') {
                text = appLang.systemTray.disconnecting;
            }
            return text;
        };

        const systemTrayMenu = (status: string) => {
            appIcon = new Tray(trayIconChanger(status));
            appIcon.on('click', async () => {
                redirectTo('');
            });
            appIcon.setToolTip(appTitle);
            appIcon.setContextMenu(
                Menu.buildFromTemplate(trayMenuContext(connectionLabel(status), status, true))
            );
        };

        app?.whenReady().then(() => {
            systemTrayMenu('disconnected');
            autoConnect();
            /*ipcMain.on('tray-icon', async (event, newStatus) => {
                appIcon.setImage(trayIconChanger(newStatus));
            });*/
            customEvent.on('tray-icon', (newStatus) => {
                if (newStatus.startsWith('connected') || newStatus === 'disconnected') {
                    appIcon.setImage(trayIconChanger(newStatus));
                }
                appIcon.setContextMenu(
                    Menu.buildFromTemplate(
                        trayMenuContext(
                            connectionLabel(newStatus),
                            newStatus,
                            !(newStatus === 'disconnecting' || newStatus === 'connecting')
                        )
                    )
                );
            });

            autoUpdater.checkForUpdatesAndNotify();
            autoUpdater.on('update-available', () => {
                dialog
                    .showMessageBox({
                        type: 'info',
                        title: 'Update Available',
                        message:
                            'A new version of the ' +
                            appTitle +
                            ' is available. Do you want to update now?',
                        buttons: ['Yes', 'No']
                    })
                    .then((result) => {
                        if (result.response === 0) {
                            autoUpdater.downloadUpdate();
                            if (mainWindow) {
                                mainWindow.setProgressBar(100);
                            }
                        }
                    });
            });

            autoUpdater.on('download-progress', (progressObj) => {
                let logMessage: any = 'Download speed: ' + progressObj.bytesPerSecond;
                logMessage = logMessage + ' - Downloaded ' + progressObj.percent + '%';
                logMessage =
                    logMessage + ' (' + progressObj.transferred + '/' + progressObj.total + ')';
                log.info(logMessage);
                if (mainWindow) {
                    mainWindow.setProgressBar(Math.round(progressObj.percent) / 100);
                }
            });

            autoUpdater.on('update-downloaded', () => {
                if (mainWindow) {
                    mainWindow.setProgressBar(1);
                }
                dialog
                    .showMessageBox({
                        type: 'info',
                        title: 'Update Ready',
                        message:
                            'A new version of the ' +
                            appTitle +
                            ' is ready. It will be installed after a restart. Do you want to restart now?',
                        buttons: ['Yes', 'Later']
                    })
                    .then((result) => {
                        if (result.response === 0) {
                            autoUpdater.quitAndInstall();
                        }
                    });
            });
        });

        // Remove this if your app does not use auto updates
        // eslint-disable-next-line
        // new AppUpdater();
        log.info('od is ready!');
    };

    const startAtLogin = async () => {
        if (process.env.NODE_ENV !== 'development') {
            const checkOpenAtLogin = await settings.get('openAtLogin');
            app.setLoginItemSettings({
                openAtLogin: typeof checkOpenAtLogin === 'boolean' ? checkOpenAtLogin : false
            });
        }
    };

    /**
     * Add event listeners...
     */

    app.on('window-all-closed', async () => {
        await startAtLogin();
        await exitTheApp(mainWindow);
        console.log('window-all-closed');
    });

    app.whenReady()
        .then(() => {
            createWindow();
            app.on('activate', () => {
                // On macOS, it's common to re-create a window in the app when the
                // dock icon is clicked and there are no other windows open.
                if (mainWindow === null) createWindow();
            });
        })
        .catch(console.log);
}
