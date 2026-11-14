const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  dialog,
} = require('electron');
const { ConfigStore } = require('./services/config-store');
const { MascotStore } = require('./services/mascot-store');
const { ISLAND_SIZES, MASCOT_TOP, resolveVisualMode, stageHeight, windowSize, anchoredBounds } = require('./services/overlay-layout');
const {
  disableWatcherIntegration,
  enableWatcherIntegration,
  resolveWatcherPaths,
} = require('./services/login-item');
const { mediaForInitialization, updateMediaState } = require('./services/media-state');
const { NetEaseProcessWatcher, queryNetEaseProcess } = require('./services/netease-process-watcher');
const { NetEaseService } = require('./services/netease-service');
const {
  DEFAULT_HOVER_POLL_INTERVAL_MS,
  pointInWindowShape,
  shouldMonitorWindowHover,
  WindowHoverMonitor,
} = require('./services/window-hover-monitor');

app.setName('Netease Island Lyrics');
app.setAppUserModelId('com.codex.netease-island-lyrics');

const MASCOT_SIZE = Object.freeze({ width: 96, height: 58 });
const NATIVE_ANIMATION_FRAME_MS = 1000 / 120;
const AUTO_HIDE_DELAY_MS = 2000;
const MANAGED_EXIT_DELAY_MS = 2000;
const WATCHER_STATE_FALLBACK_MS = 30_000;
const WATCHER_STATE_DEGRADED_FALLBACK_MS = 2000;
const WATCHER_STATE_STALE_MS = 65_000;
const WATCHER_SOURCE_PATH = path.join(__dirname, '..', 'assets', 'NeteaseIslandWatcher.exe');

let mainWindow = null;
let tray = null;
let mediaWorker = null;
let neteaseProcessWatcher = null;
let demoTimer = null;
let configStore = null;
let lyricsService = null;
let latestMedia = null;
let latestLyrics = { status: 'idle', trackKey: null, data: null };
let latestArtwork = null;
let activeLyricsRequest = 0;
let visualMode = 'idle';
const screenshotRequested = process.argv.some((arg) => arg.startsWith('--screenshot='));
let demoEnabled = process.argv.includes('--demo')
  || (screenshotRequested && !process.argv.includes('--real'));
let isAnimatingBounds = false;
let animationGeneration = 0;
let positionSaveTimer = null;
let dragEndTimer = null;
let autoHideTimer = null;
let managedExitTimer = null;
let managedExitGeneration = 0;
let managedExitErrorReported = false;
let watcherStateReadTimer = null;
let watcherStateFallbackTimer = null;
let watcherStateFsWatcher = null;
let watcherStateWatchErrorReported = false;
let watcherStateMonitoringGeneration = 0;
let watcherStateObservationEpoch = 0;
let watcherStateFallbackInFlightGeneration = null;
let quitting = false;
let rendererReady = false;
let windowReady = false;
let pendingShow = false;
let pendingForegroundPortablePath = null;
let preferredPortablePath = process.env.PORTABLE_EXECUTABLE_FILE || null;
let foregroundLaunchPromoted = false;
let mascotStore = null;
let selectedMascot = null;
let windowStageHeight = 0;
let mascotPanelOpen = false;
let importingMascot = false;
let mascotAnimating = false;
let mascotRestOffset = 0;
let activeWindowShape = [];
let windowHoverMonitor = null;
const backgroundLaunch = process.argv.includes('--background');
const startedManagedByWatcher = process.argv.includes('--managed-by-watcher');
let managedByWatcher = startedManagedByWatcher;
let manualVisibilityOverride = !backgroundLaunch;
let manuallyHidden = false;
let neteaseProcessRunning = false;
const startupDiagnostics = [];

const rendererFilePath = path.join(__dirname, 'renderer', 'index.html');
const rendererUrl = pathToFileURL(rendererFilePath).href;

const hasSingleInstanceLock = app.requestSingleInstanceLock({
  portablePath: process.env.PORTABLE_EXECUTABLE_FILE || null,
  backgroundLaunch,
  managedByWatcher,
});
if (!hasSingleInstanceLock) app.quit();

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents) {
    mainWindow.webContents.send(channel, payload);
  }
}

function notify(message) {
  if (!message) return;
  if (rendererReady) send('ui:toast', message);
  else startupDiagnostics.push(message);
}

function isTrustedIpcEvent(event) {
  return event?.sender === mainWindow?.webContents
    && event.senderFrame?.url === rendererUrl;
}

function onTrustedIpc(channel, handler) {
  ipcMain.on(channel, (event, ...arguments_) => {
    if (!isTrustedIpcEvent(event)) return;
    handler(event, ...arguments_);
  });
}

function currentSettings() {
  return configStore.get();
}

function settingsState(settings = currentSettings()) {
  return {
    ...settings, visualMode, demoEnabled,
    clickThrough: mascotPanelOpen ? false : settings.clickThrough,
    mascotStageHeight: windowStageHeight,
    selectedMascot: selectedMascot && { id: selectedMascot.id, image: selectedMascot.image },
    mascotPanelOpen,
  };
}

function mascotState() {
  return { items: mascotStore.list().map(({ shape, ...card }) => card),
    selectedId: currentSettings().mascotId, panelOpen: mascotPanelOpen };
}

function broadcastMascots() {
  send('settings:state', settingsState());
  const payload = mascotState();
  send('mascots:state', payload);
  return payload;
}

function selectMascot(id) {
  const item = mascotStore.get(id);
  if (!item || (id !== 'none' && !item.image)) throw new Error('角色图片不存在或无法读取');
  configStore.updateStrict({ mascotId: id });
  selectedMascot = item;
  setVisualMode(visualMode, { force: true });
  return broadcastMascots();
}

function setMascotPanel(open) {
  mascotPanelOpen = Boolean(open);
  if (mascotPanelOpen) {
    setUserMode('expanded');
    showOverlay();
  }
  setClickThrough(currentSettings().clickThrough, { persist: false, notify: false });
  broadcastMascots();
}

function applyTopmost() {
  if (!mainWindow || mainWindow.isDestroyed() || !configStore) return;
  const enabled = currentSettings().topmostMode === 'fullscreen';
  if (enabled) {
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    mainWindow.setAlwaysOnTop(false);
  }
}

function showOverlay(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(autoHideTimer);
  if (options.manual) {
    manualVisibilityOverride = true;
    manuallyHidden = false;
  }
  if (!windowReady) {
    pendingShow = true;
    return;
  }
  mainWindow.showInactive();
  syncWindowHoverMonitoring();
  applyTopmost();
  buildTrayMenu();
}

function hideOverlay(options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mascotPanelOpen) setMascotPanel(false);
  clearTimeout(autoHideTimer);
  pendingShow = false;
  if (options.manual) {
    manualVisibilityOverride = false;
    manuallyHidden = true;
  }
  mainWindow.hide();
  syncWindowHoverMonitoring();
  buildTrayMenu();
}

function scheduleAutoHide() {
  clearTimeout(autoHideTimer);
  const settings = currentSettings();
  if (!settings.autoShowWithNetease || manualVisibilityOverride || settings.mode === 'expanded') return;
  autoHideTimer = setTimeout(() => hideOverlay(), AUTO_HIDE_DELAY_MS);
}

function clearManagedExit() {
  managedExitGeneration += 1;
  clearTimeout(managedExitTimer);
  managedExitTimer = null;
}

function scheduleManagedExit() {
  clearManagedExit();
  if (!managedByWatcher || demoEnabled || !currentSettings().autoShowWithNetease) return;
  const generation = managedExitGeneration;
  managedExitTimer = setTimeout(async () => {
    managedExitTimer = null;
    if (generation !== managedExitGeneration || !managedByWatcher
        || demoEnabled || !currentSettings().autoShowWithNetease) return;
    try {
      const running = await queryNetEaseProcess();
      if (generation !== managedExitGeneration || !managedByWatcher
          || demoEnabled || !currentSettings().autoShowWithNetease) return;
      if (running) {
        managedExitErrorReported = false;
        handleNetEaseProcessChange(true);
        return;
      }
      managedExitErrorReported = false;
      managedExitTimer = setTimeout(() => {
        managedExitTimer = null;
        if (generation !== managedExitGeneration || !managedByWatcher
            || foregroundLaunchPromoted || demoEnabled
            || !currentSettings().autoShowWithNetease) return;
        quitting = true;
        app.releaseSingleInstanceLock();
        app.quit();
      }, 50);
    } catch (error) {
      if (generation !== managedExitGeneration || !managedByWatcher) return;
      if (!managedExitErrorReported) {
        managedExitErrorReported = true;
        notify(`网易云退出确认失败，正在重试：${error.message}`);
      }
      scheduleManagedExit();
    }
  }, MANAGED_EXIT_DELAY_MS);
}

function handleNetEaseProcessChange(running) {
  neteaseProcessRunning = Boolean(running);
  if (!currentSettings().autoShowWithNetease || demoEnabled) return;

  if (neteaseProcessRunning) {
    clearManagedExit();
    if (!latestMedia) setVisualMode(resolveVisualMode(currentSettings().mode, false));
    if (!manuallyHidden) showOverlay();
    return;
  }
  if (managedByWatcher) {
    scheduleManagedExit();
    return;
  }
  if (!latestMedia) scheduleAutoHide();
}

function updateNetEaseProcessWatcher() {
  const enabled = currentSettings().autoShowWithNetease
    && !demoEnabled
    && !latestMedia
    && !managedByWatcher;
  if (!enabled) {
    neteaseProcessWatcher?.stop();
    neteaseProcessRunning = false;
    return;
  }
  if (!neteaseProcessWatcher) {
    let processWatcherErrorReported = false;
    neteaseProcessWatcher = new NetEaseProcessWatcher({
      onChange: handleNetEaseProcessChange,
      onError: (error) => {
        if (processWatcherErrorReported) return;
        processWatcherErrorReported = true;
        notify(`网易云进程检测暂不可用：${error.message}`);
      },
    });
  }
  neteaseProcessWatcher.start();
}

function localAppDataPath() {
  return process.env.LOCALAPPDATA || path.resolve(app.getPath('appData'), '..', 'Local');
}

function readWatcherState() {
  if (!managedByWatcher) return false;
  const { stateFile } = resolveWatcherPaths(localAppDataPath());
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (typeof state.cloudMusicRunning !== 'boolean') return false;
    const updatedAt = Date.parse(state.updatedAtUtc);
    const age = Date.now() - updatedAt;
    if (!Number.isFinite(updatedAt) || age > WATCHER_STATE_STALE_MS || age < -300_000) return false;
    const watcherPid = Number(state.watcherPid);
    if (!Number.isInteger(watcherPid) || watcherPid <= 0) return false;
    try {
      process.kill(watcherPid, 0);
    } catch (error) {
      if (error?.code !== 'EPERM') return false;
    }
    watcherStateObservationEpoch += 1;
    handleNetEaseProcessChange(state.cloudMusicRunning);
    return true;
  } catch {
    return false;
  }
}

function scheduleWatcherStateRead(generation = watcherStateMonitoringGeneration) {
  clearTimeout(watcherStateReadTimer);
  watcherStateReadTimer = setTimeout(() => {
    watcherStateReadTimer = null;
    if (generation !== watcherStateMonitoringGeneration) return;
    if (!readWatcherState()) checkNetEaseStateFallback(generation);
  }, 60);
}

async function checkNetEaseStateFallback(generation = watcherStateMonitoringGeneration) {
  if (watcherStateFallbackInFlightGeneration === generation || !managedByWatcher
      || generation !== watcherStateMonitoringGeneration) return;
  watcherStateFallbackInFlightGeneration = generation;
  const observationEpoch = watcherStateObservationEpoch;
  try {
    const running = await queryNetEaseProcess();
    if (managedByWatcher && generation === watcherStateMonitoringGeneration
        && observationEpoch === watcherStateObservationEpoch) {
      handleNetEaseProcessChange(running);
    }
  } catch {}
  if (watcherStateFallbackInFlightGeneration === generation) {
    watcherStateFallbackInFlightGeneration = null;
  }
}

function stopWatcherStateMonitoring() {
  watcherStateMonitoringGeneration += 1;
  clearTimeout(watcherStateReadTimer);
  watcherStateReadTimer = null;
  clearInterval(watcherStateFallbackTimer);
  watcherStateFallbackTimer = null;
  watcherStateFsWatcher?.close();
  watcherStateFsWatcher = null;
}

function startWatcherFallbackTimer(generation, intervalMs) {
  clearInterval(watcherStateFallbackTimer);
  watcherStateFallbackTimer = setInterval(async () => {
    if (generation !== watcherStateMonitoringGeneration) return;
    if (readWatcherState()) return;
    await checkNetEaseStateFallback(generation);
  }, intervalMs);
  watcherStateFallbackTimer.unref?.();
}

function startWatcherStateMonitoring() {
  if (!managedByWatcher) return;
  stopWatcherStateMonitoring();
  const generation = watcherStateMonitoringGeneration;
  const paths = resolveWatcherPaths(localAppDataPath());
  let watchActive = false;
  try {
    const fileWatcher = fs.watch(paths.root, (_eventType, fileName) => {
      if (generation !== watcherStateMonitoringGeneration) return;
      if (!fileName || String(fileName).toLowerCase() === 'state.json') {
        scheduleWatcherStateRead(generation);
      }
    });
    fileWatcher.on('error', (error) => {
      if (generation !== watcherStateMonitoringGeneration) return;
      if (watcherStateFsWatcher === fileWatcher) watcherStateFsWatcher = null;
      fileWatcher.close();
      if (!watcherStateWatchErrorReported) {
        watcherStateWatchErrorReported = true;
        notify(`联动状态监听中断，已继续使用低频检查：${error.message}`);
      }
      checkNetEaseStateFallback(generation);
      startWatcherFallbackTimer(generation, WATCHER_STATE_DEGRADED_FALLBACK_MS);
    });
    watcherStateFsWatcher = fileWatcher;
    watchActive = true;
  } catch (error) {
    notify(`联动状态监听失败，已启用低频检查：${error.message}`);
  }
  if (!readWatcherState()) checkNetEaseStateFallback(generation);
  startWatcherFallbackTimer(
    generation,
    watchActive ? WATCHER_STATE_FALLBACK_MS : WATCHER_STATE_DEGRADED_FALLBACK_MS,
  );
}

function getDisplayForBounds(bounds) {
  return screen.getDisplayMatching(bounds || mainWindow?.getBounds() || screen.getPrimaryDisplay().workArea);
}

function clampBounds(bounds) {
  const display = getDisplayForBounds(bounds);
  const area = display.workArea;
  const margin = 8;
  return {
    ...bounds,
    x: Math.min(area.x + area.width - bounds.width - margin, Math.max(area.x + margin, bounds.x)),
    y: Math.min(area.y + area.height - bounds.height - margin, Math.max(area.y + margin, bounds.y)),
  };
}

function defaultBounds(size) {
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: size.width,
    height: size.height,
    x: Math.round(area.x + (area.width - size.width) / 2),
    y: area.y + 16,
  };
}

function initialBounds() {
  const settings = currentSettings();
  visualMode = resolveVisualMode(settings.mode, false);
  windowStageHeight = stageHeight(visualMode, Boolean(selectedMascot?.image));
  const size = windowSize(visualMode, Boolean(selectedMascot?.image));
  if (!settings.position) return defaultBounds(size);
  return clampBounds({
    x: settings.position.x + Math.round(((settings.positionWidth || size.width) - size.width) / 2),
    y: settings.position.y - windowStageHeight,
    ...size,
  });
}

function targetBoundsForMode(mode) {
  const hasMascot = Boolean(selectedMascot?.image);
  const size = windowSize(mode, hasMascot);
  if (!mainWindow) return defaultBounds(size);
  return clampBounds(anchoredBounds(mainWindow.getBounds(), windowStageHeight, mode, hasMascot));
}

function roundedWindowShape(width, height, radius, offsetY = 0) {
  const safeRadius = Math.max(1, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  const rectangles = [];
  for (let y = 0; y < safeRadius; y += 1) {
    const distance = safeRadius - (y + 0.5);
    const inset = Math.max(0, Math.ceil(safeRadius - Math.sqrt((safeRadius ** 2) - (distance ** 2))));
    rectangles.push({ x: inset, y: offsetY + y, width: width - (inset * 2), height: 1 });
    rectangles.push({ x: inset, y: offsetY + height - y - 1, width: width - (inset * 2), height: 1 });
  }
  rectangles.push({
    x: 0,
    y: offsetY + safeRadius,
    width,
    height: Math.max(1, height - (safeRadius * 2)),
  });
  return rectangles;
}

function mascotWindowShape(windowWidth) {
  const offsetX = Math.round((windowWidth - MASCOT_SIZE.width) / 2);
  const offsets = mascotAnimating ? [-5, -4, -3, -2, -1, 0, 1, 2, 3] : [mascotRestOffset];
  return offsets.flatMap((offsetY) => (selectedMascot?.shape || [])
    .map((rectangle) => ({
      ...rectangle,
      x: rectangle.x + offsetX,
      y: rectangle.y + MASCOT_TOP + offsetY,
    })));
}

function applyWindowShape() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { width, height } = mainWindow.getBounds();
  const radius = visualMode === 'expanded' ? 30 : 34;
  const islandHeight = Math.max(1, height - windowStageHeight);
  const shape = roundedWindowShape(width, islandHeight, radius, windowStageHeight);
  if (visualMode === 'compact') shape.push(...mascotWindowShape(width));
  activeWindowShape = shape;
  if (typeof mainWindow.setShape === 'function') mainWindow.setShape(shape);
}

function syncWindowHoverMonitoring() {
  const enabled = shouldMonitorWindowHover({
    visible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    visualMode,
    animating: isAnimatingBounds,
  });
  if (enabled) windowHoverMonitor?.start();
  else windowHoverMonitor?.stop();
}

function animateBounds(target, duration = 190) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (duration <= 0) {
    animationGeneration += 1;
    isAnimatingBounds = false;
    mainWindow.setBounds(target, false);
    applyWindowShape();
    savePositionSoon();
    syncWindowHoverMonitoring();
    return;
  }
  const start = mainWindow.getBounds();
  const generation = ++animationGeneration;
  const startedAt = performance.now();
  isAnimatingBounds = true;
  syncWindowHoverMonitoring();

  function frame(now) {
    if (!mainWindow || mainWindow.isDestroyed() || generation !== animationGeneration) return;
    const rawProgress = Math.min(1, (now - startedAt) / duration);
    const progress = 1 - ((1 - rawProgress) ** 3);
    const next = {};
    for (const key of ['x', 'y', 'width', 'height']) {
      next[key] = Math.round(start[key] + ((target[key] - start[key]) * progress));
    }
    mainWindow.setBounds(next, false);

    if (rawProgress < 1) {
      const frameCostMs = performance.now() - now;
      setTimeout(
        () => frame(performance.now()),
        Math.max(0, NATIVE_ANIMATION_FRAME_MS - frameCostMs),
      );
    } else {
      isAnimatingBounds = false;
      applyWindowShape();
      savePositionSoon();
      syncWindowHoverMonitoring();
    }
  }

  frame(startedAt);
}

function setVisualMode(mode, options = {}) {
  const allowedMode = Object.hasOwn(ISLAND_SIZES, mode) ? mode : 'compact';
  if (visualMode === allowedMode && !options.force) return;
  const target = targetBoundsForMode(allowedMode);
  visualMode = allowedMode;
  mascotAnimating = false;
  mascotRestOffset = latestMedia && latestMedia.playbackStatus !== 4 ? 2 : 0;
  windowStageHeight = stageHeight(allowedMode, Boolean(selectedMascot?.image));
  animateBounds(target, options.instant ? 0 : 190);
  applyTopmost();
  send('settings:state', settingsState());
  syncWindowHoverMonitoring();
}

function savePositionSoon() {
  if (isAnimatingBounds || !mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(positionSaveTimer);
  positionSaveTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || isAnimatingBounds) return;
    const { x, y } = mainWindow.getBounds();
    configStore.update({
      position: { x, y: y + windowStageHeight },
      positionWidth: ISLAND_SIZES[visualMode].width,
    });
  }, 250);
}

function createIcon() {
  const iconPath = path.join(__dirname, '..', 'assets', 'app-icon.png');
  if (fs.existsSync(iconPath)) {
    const fileIcon = nativeImage.createFromPath(iconPath);
    if (!fileIcon.isEmpty()) return fileIcon.resize({ width: 32, height: 32 });
  }
  const fallbackPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const fallback = nativeImage.createFromDataURL(`data:image/png;base64,${fallbackPng}`);
  return fallback.resize({ width: 32, height: 32 });
}

function createWindow() {
  const bounds = initialBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: currentSettings().topmostMode === 'fullscreen',
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    movable: true,
    icon: createIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  windowHoverMonitor = new WindowHoverMonitor({
    intervalMs: DEFAULT_HOVER_POLL_INTERVAL_MS,
    sampleHover: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      return pointInWindowShape(
        screen.getCursorScreenPoint(),
        mainWindow.getBounds(),
        activeWindowShape,
      );
    },
    onChange: (hovered) => send('window:hover-state', hovered),
  });

  mainWindow.setBackgroundColor('#00000000');
  applyWindowShape();
  applyTopmost();
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(rendererFilePath);

  mainWindow.once('ready-to-show', () => {
    windowReady = true;
    setClickThrough(currentSettings().clickThrough, { persist: false });
    if (pendingShow || !backgroundLaunch || demoEnabled || screenshotRequested) showOverlay();
    pendingShow = false;
    handleScreenshotMode();
  });

  mainWindow.on('move', () => {
    savePositionSoon();
    if (isAnimatingBounds) return;
    send('window:drag-state', true);
    clearTimeout(dragEndTimer);
    dragEndTimer = setTimeout(() => send('window:drag-state', false), 120);
  });
  mainWindow.on('show', () => {
    applyTopmost();
    syncWindowHoverMonitoring();
  });
  mainWindow.on('hide', syncWindowHoverMonitoring);
  mainWindow.on('closed', () => {
    windowHoverMonitor?.stop();
    windowHoverMonitor = null;
    activeWindowShape = [];
  });
  mainWindow.on('focus', applyTopmost);
  mainWindow.on('blur', () => setTimeout(applyTopmost, 0));
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      hideOverlay({ manual: true });
    }
  });
}

function setAutoShowWithNetease(enabled) {
  const value = Boolean(enabled);
  const previous = currentSettings();
  let settings = previous;
  if (value) {
    const result = updateLoginItemSetting(true, pendingForegroundPortablePath || preferredPortablePath);
    if (!result.ok) {
      try {
        settings = configStore.updateStrict({ autoShowWithNetease: false, launchAtLogin: false });
      } catch {}
      notify(`随网易云自动启动启用失败：${result.error?.message || '未知错误'}`);
    } else {
      pendingForegroundPortablePath = null;
      try {
        settings = configStore.updateStrict({ autoShowWithNetease: true, launchAtLogin: true });
      } catch (error) {
        const rollback = updateLoginItemSetting(false);
        settings = currentSettings();
        notify(rollback.ok
          ? `联动设置无法保存，已回滚：${error.message}`
          : `联动设置无法保存，且回滚未完成：${rollback.error?.message || error.message}`);
      }
    }
  } else {
    const wasManagedByWatcher = managedByWatcher;
    try {
      settings = configStore.updateStrict({ autoShowWithNetease: false, launchAtLogin: false });
    } catch (error) {
      notify(`联动设置无法保存：${error.message}`);
      return currentSettings();
    }
    if (wasManagedByWatcher) {
      managedByWatcher = false;
      clearManagedExit();
      stopWatcherStateMonitoring();
    }
    const result = updateLoginItemSetting(false);
    if (!result.ok) {
      const repair = updateLoginItemSetting(true, preferredPortablePath);
      let settingsRestored = false;
      if (repair.ok) {
        try {
          settings = configStore.updateStrict({
            autoShowWithNetease: previous.autoShowWithNetease,
            launchAtLogin: previous.launchAtLogin,
          });
          settingsRestored = true;
        } catch {
          updateLoginItemSetting(false);
          settings = currentSettings();
        }
      }
      if (repair.ok && settingsRestored && wasManagedByWatcher) {
        managedByWatcher = true;
        startWatcherStateMonitoring();
      }
      notify(repair.ok
        ? '联动监听器未能移除，已恢复原设置'
        : '联动监听器未能完全移除或恢复，请重新运行后再试');
    }
  }
  updateNetEaseProcessWatcher();
  if (managedByWatcher) {
    if (settings.autoShowWithNetease) startWatcherStateMonitoring();
    else stopWatcherStateMonitoring();
  }
  if (settings.autoShowWithNetease && latestMedia && !manuallyHidden) showOverlay();
  if (settings.autoShowWithNetease && !latestMedia) scheduleAutoHide();
  send('settings:state', settingsState(settings));
  buildTrayMenu();
  return settings;
}

function setTopmostMode(enabled) {
  const settings = configStore.update({ topmostMode: enabled ? 'fullscreen' : 'off' });
  applyTopmost();
  send('settings:state', settingsState(settings));
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  const settings = currentSettings();
  const template = [
    {
      label: mainWindow?.isVisible() ? '隐藏歌词岛' : '显示歌词岛',
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) hideOverlay({ manual: true });
        else showOverlay({ manual: true });
      },
    },
    {
      label: settings.mode === 'expanded' ? '收起歌词' : '展开歌词',
      click: () => setUserMode(settings.mode === 'expanded' ? 'compact' : 'expanded'),
    },
    { label: '更换角色', click: () => setMascotPanel(true) },
    { type: 'separator' },
    {
      label: '随网易云自动启动',
      type: 'checkbox',
      checked: settings.autoShowWithNetease,
      click: (item) => setAutoShowWithNetease(item.checked),
    },
    {
      label: '强制置顶（包含全屏）',
      type: 'checkbox',
      checked: settings.topmostMode === 'fullscreen',
      click: (item) => setTopmostMode(item.checked),
    },
    {
      label: '鼠标穿透',
      type: 'checkbox',
      checked: settings.clickThrough,
      click: (item) => setClickThrough(item.checked),
    },
    {
      label: '演示模式',
      type: 'checkbox',
      checked: demoEnabled,
      click: () => toggleDemo(),
    },
    {
      label: '回到屏幕顶部',
      click: resetPosition,
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(createIcon());
  tray.setToolTip('云岛歌词 · 网易云音乐悬浮歌词');
  tray.on('double-click', () => {
    if (!mainWindow) return;
    showOverlay({ manual: true });
    setClickThrough(false);
  });
  buildTrayMenu();
}

function setUserMode(mode) {
  if (!['compact', 'expanded'].includes(mode)) return;
  configStore.update({ mode });
  if (mode !== 'expanded' && mascotPanelOpen) setMascotPanel(false);
  setVisualMode(resolveVisualMode(mode, Boolean(latestMedia)));
  if (mode === 'expanded') {
    clearTimeout(autoHideTimer);
    manuallyHidden = false;
    showOverlay();
  }
  else if (!latestMedia) scheduleAutoHide();
  send('settings:state', settingsState());
  buildTrayMenu();
}

function setClickThrough(enabled, options = {}) {
  const requested = Boolean(enabled);
  if (options.persist !== false) configStore.update({ clickThrough: requested });
  const value = mascotPanelOpen ? false : requested;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(value, { forward: true });
    mainWindow.setFocusable(!value);
  }
  send('settings:state', settingsState());
  if (value && options.notify !== false) {
    send('ui:toast', '已开启鼠标穿透 · Ctrl + Alt + L 解锁');
  }
  buildTrayMenu();
}

function resetPosition() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const target = defaultBounds(windowSize(visualMode, Boolean(selectedMascot?.image)));
  configStore.update({
    position: { x: target.x, y: target.y + windowStageHeight },
    positionWidth: ISLAND_SIZES[visualMode].width,
  });
  animateBounds(target);
  showOverlay({ manual: true });
}

function sendMedia(media) {
  if (!media) {
    latestMedia = null;
    latestArtwork = null;
    manuallyHidden = false;
    latestLyrics = { status: 'idle', trackKey: null, data: null };
    send('media:state', null);
    send('lyrics:state', latestLyrics);
    activeLyricsRequest += 1;
    setVisualMode(resolveVisualMode(currentSettings().mode, false));
    updateNetEaseProcessWatcher();
    scheduleAutoHide();
    return;
  }

  const sessionAppeared = !latestMedia;
  if (sessionAppeared) manuallyHidden = false;
  const update = updateMediaState(latestMedia, latestArtwork, media);
  latestArtwork = update.artwork;
  latestMedia = update.latestMedia;
  updateNetEaseProcessWatcher();
  send('media:state', update.rendererPayload);

  if (visualMode === 'idle') setVisualMode(currentSettings().mode);
  if (currentSettings().autoShowWithNetease && !manuallyHidden) showOverlay();
  if (update.trackChanged) loadLyrics(latestMedia);
}

async function loadLyrics(media) {
  const requestId = ++activeLyricsRequest;
  latestLyrics = { status: 'loading', trackKey: media.trackKey, data: null };
  send('lyrics:state', latestLyrics);

  try {
    const query = {
      title: media.title,
      artist: media.artist,
      album: media.album,
      duration: media.duration,
      durationMs: media.duration * 1000,
    };
    const resolved = typeof lyricsService.getLyricsForTrack === 'function'
      ? await lyricsService.getLyricsForTrack(query)
      : await lyricsService.resolveLyrics(query);
    const data = resolved && !Array.isArray(resolved.lines) && resolved.lyrics
      ? { ...resolved, ...resolved.lyrics, lyrics: resolved.lyrics }
      : resolved;
    if (requestId !== activeLyricsRequest || latestMedia?.trackKey !== media.trackKey) return;

    latestLyrics = {
      status: data?.lines?.length ? 'ready' : 'empty',
      trackKey: media.trackKey,
      data,
    };
  } catch (error) {
    if (requestId !== activeLyricsRequest || latestMedia?.trackKey !== media.trackKey) return;
    latestLyrics = {
      status: 'error',
      trackKey: media.trackKey,
      data: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  send('lyrics:state', latestLyrics);
}

function startMediaWorker() {
  stopMediaWorker();
  const settings = currentSettings();
  const worker = new Worker(path.join(__dirname, 'services', 'media-worker.js'), {
    workerData: { acceptAnyMedia: settings.acceptAnyMedia },
  });
  mediaWorker = worker;
  worker.on('message', (message) => {
    if (mediaWorker !== worker) return;
    if (message?.type === 'media-state') sendMedia(message.payload);
    if (message?.type === 'source-error') {
      notify(`媒体会话读取失败：${message.payload}`);
    }
  });
  worker.on('error', (error) => {
    if (mediaWorker === worker) notify(`媒体服务异常：${error.message}`);
  });
  worker.on('exit', () => {
    if (mediaWorker === worker) mediaWorker = null;
  });
}

function stopMediaWorker() {
  if (!mediaWorker) return;
  const worker = mediaWorker;
  mediaWorker = null;
  worker.postMessage({ type: 'stop' });
  const forceTerminationTimer = setTimeout(() => worker.terminate().catch(() => {}), 750);
  forceTerminationTimer.unref?.();
  worker.once('exit', () => clearTimeout(forceTerminationTimer));
}

function startDemo() {
  stopMediaWorker();
  updateNetEaseProcessWatcher();
  clearInterval(demoTimer);
  const startedAt = Date.now() - 96_000;
  const duration = 298.56;
  const trackKey = 'demo|怪你过份美丽|张国荣|299';
  const update = () => {
    const position = ((Date.now() - startedAt) / 1000) % duration;
    sendMedia({
      sourceAppId: 'cloudmusic.exe · DEMO',
      isNetEase: true,
      title: '怪你过份美丽',
      artist: '张国荣',
      album: 'Leslie Cheung Four Seasons',
      position,
      duration,
      playbackStatus: 4,
      observedAt: Date.now(),
      lastUpdatedTime: Date.now(),
      positionPrecisionMs: 1,
      trackKey,
      ...(latestMedia?.trackKey === trackKey ? {} : { artwork: null }),
    });
  };
  update();
  demoTimer = setInterval(update, 250);
}

function stopDemo() {
  clearInterval(demoTimer);
  demoTimer = null;
  sendMedia(null);
}

function toggleDemo() {
  demoEnabled = !demoEnabled;
  if (demoEnabled) startDemo();
  else {
    stopDemo();
    startMediaWorker();
    updateNetEaseProcessWatcher();
    if (managedByWatcher) {
      if (!readWatcherState()) checkNetEaseStateFallback(watcherStateMonitoringGeneration);
    }
  }
  send('settings:state', settingsState());
  buildTrayMenu();
}

function updateLoginItemSetting(enabled, targetPathOverride = null) {
  if (!app.isPackaged) return { ok: true, skipped: true };
  const localAppData = localAppDataPath();
  if (enabled) {
    const portableTargetPath = targetPathOverride || process.env.PORTABLE_EXECUTABLE_FILE;
    if (!portableTargetPath) {
      return { ok: false, error: new Error('无法确认当前 portable 文件路径，请手动运行 EXE 后启用') };
    }
    return enableWatcherIntegration({
      sourcePath: WATCHER_SOURCE_PATH,
      localAppData,
      targetPath: portableTargetPath,
      version: app.getVersion(),
    });
  }
  return disableWatcherIntegration({ sourcePath: WATCHER_SOURCE_PATH, localAppData });
}

function registerIpc() {
  function handleMascot(channel, handler) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedIpcEvent(event)) throw new Error('不可信的请求来源');
      try { return await handler(...args); }
      catch (error) { notify(error.message); throw error; }
    });
  }
  handleMascot('mascots:list', () => mascotState());
  handleMascot('mascots:select', (id) => selectMascot(id));
  handleMascot('mascots:import', async () => {
    if (importingMascot) return null;
    importingMascot = true;
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '导入透明 PNG 角色', filters: [{ name: '透明 PNG', extensions: ['png'] }],
        properties: ['openFile'],
      });
      if (result.canceled || !result.filePaths.length) return null;
      const item = mascotStore.importFile(result.filePaths[0]);
      try { return selectMascot(item.id); }
      catch (error) { mascotStore.remove(item.id); throw error; }
    } finally { importingMascot = false; }
  });
  handleMascot('mascots:remove', (id) => {
    const item = mascotStore.get(id);
    if (!item || item.builtin) throw new Error('只能删除自定义角色');
    const selected = currentSettings().mascotId === id;
    if (selected) configStore.updateStrict({ mascotId: 'none' });
    try { mascotStore.remove(id); }
    catch (error) {
      if (selected) configStore.updateStrict({ mascotId: id });
      throw error;
    }
    if (selected) {
      selectedMascot = mascotStore.get('none');
      setVisualMode(visualMode, { force: true });
    }
    return broadcastMascots();
  });
  onTrustedIpc('mascots:panel', (_event, open) => setMascotPanel(open));
  onTrustedIpc('mascots:motion', (_event, motion) => {
    mascotAnimating = Boolean(motion?.active) && visualMode === 'compact';
    mascotRestOffset = motion?.offset === 2 ? 2 : 0;
    if (!isAnimatingBounds) applyWindowShape();
  });
  onTrustedIpc('ui:ready', () => {
    rendererReady = true;
    send('app:init', {
      settings: settingsState(),
      mascots: mascotState(),
      visualMode,
      demoEnabled,
      media: mediaForInitialization(latestMedia, latestArtwork),
      lyrics: latestLyrics,
      shortcut: 'Ctrl + Alt + L',
    });
    send('window:hover-state', Boolean(windowHoverMonitor?.hovered));
    for (const [index, diagnostic] of startupDiagnostics.splice(0).entries()) {
      setTimeout(() => send('ui:toast', diagnostic), 120 + (index * 500));
    }
  });

  onTrustedIpc('window:set-mode', (_event, mode) => setUserMode(mode));
  onTrustedIpc('window:set-click-through', (_event, enabled) => setClickThrough(enabled));
  onTrustedIpc('window:hide', () => {
    hideOverlay({ manual: true });
  });
  onTrustedIpc('window:reset-position', resetPosition);
  onTrustedIpc('demo:toggle', toggleDemo);
  onTrustedIpc('settings:update', (_event, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return;
    const previous = currentSettings();
    const normalizedPatch = { ...patch };
    let requestedAutoShow = null;
    if (Object.hasOwn(normalizedPatch, 'autoShowWithNetease')) {
      requestedAutoShow = Boolean(normalizedPatch.autoShowWithNetease);
    } else if (Object.hasOwn(normalizedPatch, 'launchAtLogin')) {
      requestedAutoShow = Boolean(normalizedPatch.launchAtLogin);
    }
    delete normalizedPatch.mascotId;
    delete normalizedPatch.autoShowWithNetease;
    delete normalizedPatch.launchAtLogin;
    const settings = configStore.update(normalizedPatch);
    if (settings.clickThrough !== previous.clickThrough) setClickThrough(settings.clickThrough, { persist: false });
    if (settings.mode !== previous.mode) setUserMode(settings.mode);
    if (settings.acceptAnyMedia !== previous.acceptAnyMedia) {
      mediaWorker?.postMessage({ type: 'settings', acceptAnyMedia: settings.acceptAnyMedia });
    }
    if (settings.topmostMode !== previous.topmostMode) applyTopmost();
    if (requestedAutoShow !== null) {
      setAutoShowWithNetease(requestedAutoShow);
      return;
    }
    send('settings:state', settingsState(settings));
    buildTrayMenu();
  });
}

function registerShortcuts() {
  const registered = globalShortcut.register('CommandOrControl+Alt+L', () => {
    setClickThrough(!currentSettings().clickThrough);
    showOverlay({ manual: true });
  });
  if (!registered) notify('快捷键 Ctrl + Alt + L 注册失败');
}

function handleScreenshotMode() {
  const argument = process.argv.find((arg) => arg.startsWith('--screenshot='));
  if (!argument || !mainWindow) return;
  const outputPath = path.resolve(argument.slice('--screenshot='.length));
  const metricsArgument = process.argv.find((arg) => arg.startsWith('--metrics='));
  setUserMode(process.argv.includes('--compact') ? 'compact' : 'expanded');
  setTimeout(async () => {
    try {
      const image = await mainWindow.capturePage();
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, image.toPNG());
      if (metricsArgument) {
        const metricsPath = path.resolve(metricsArgument.slice('--metrics='.length));
        const metrics = await mainWindow.webContents.executeJavaScript(
          'window.__islandDiagnostics.measureFrameRate(1200)',
        );
        fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
        fs.writeFileSync(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
      }
      quitting = true;
      app.quit();
    } catch (error) {
      console.error(error);
      quitting = true;
      app.exit(1);
    }
  }, 4500);
}

function handleStateReportMode() {
  const argument = process.argv.find((arg) => arg.startsWith('--state-report='));
  if (!argument) return;
  const outputPath = path.resolve(argument.slice('--state-report='.length));
  setTimeout(() => {
    const settings = currentSettings();
    const report = {
      backgroundLaunch,
      windowVisible: Boolean(mainWindow?.isVisible()),
      hasMedia: Boolean(latestMedia),
      visualMode,
      alwaysOnTop: Boolean(mainWindow?.isAlwaysOnTop()),
      autoShowWithNetease: settings.autoShowWithNetease,
      topmostMode: settings.topmostMode,
      managedByWatcher,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    quitting = true;
    app.quit();
  }, 1500);
}

function handleTransitionReportMode() {
  const argument = process.argv.find((arg) => arg.startsWith('--transition-report='));
  if (!argument || !mainWindow) return;
  const outputPath = path.resolve(argument.slice('--transition-report='.length));
  setTimeout(async () => {
    try {
      const report = await mainWindow.webContents.executeJavaScript(
        'window.__islandDiagnostics.runTransitionProbe()',
      );
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      quitting = true;
      app.quit();
    } catch (error) {
      console.error(error);
      quitting = true;
      app.exit(1);
    }
  }, 3500);
}

app.on('second-instance', (_event, commandLine, _workingDirectory, additionalData = {}) => {
  if (commandLine.includes('--background') || commandLine.includes('--managed-by-watcher')) return;
  foregroundLaunchPromoted = true;
  if (managedByWatcher) {
    managedByWatcher = false;
    clearManagedExit();
    stopWatcherStateMonitoring();
  }
  const foregroundPortablePath = typeof additionalData?.portablePath === 'string'
    ? additionalData.portablePath
    : null;
  if (foregroundPortablePath) preferredPortablePath = foregroundPortablePath;
  if (configStore && currentSettings().autoShowWithNetease && foregroundPortablePath) {
    pendingForegroundPortablePath = foregroundPortablePath;
    const result = updateLoginItemSetting(true, foregroundPortablePath);
    if (!result.ok) notify(`联动目标更新失败：${result.error?.message || '未知错误'}`);
    else pendingForegroundPortablePath = null;
  } else if (foregroundPortablePath) {
    pendingForegroundPortablePath = foregroundPortablePath;
  }
  if (!mainWindow) {
    pendingShow = true;
    manualVisibilityOverride = true;
    return;
  }
  showOverlay({ manual: true });
  setClickThrough(false);
});

app.whenReady().then(() => {
  configStore = new ConfigStore(app.getPath('userData'));
  mascotStore = new MascotStore({
    userDataPath: app.getPath('userData'), assetsPath: path.join(__dirname, '..', 'assets'), nativeImage,
  });
  selectedMascot = mascotStore.get(currentSettings().mascotId);
  if (!selectedMascot || (selectedMascot.id !== 'none' && !selectedMascot.image)) {
    configStore.update({ mascotId: 'none' });
    selectedMascot = mascotStore.get('none');
    notify('所选角色图片缺失，已切换为无角色');
  }
  lyricsService = new NetEaseService({ cacheDir: path.join(app.getPath('userData'), 'lyrics-cache') });
  let managedCleanupFailed = false;
  let staleManagedExitRequested = false;
  if (startedManagedByWatcher && !foregroundLaunchPromoted
      && !currentSettings().autoShowWithNetease) {
    const cleanupResult = updateLoginItemSetting(false);
    if (cleanupResult.ok) {
      staleManagedExitRequested = true;
      managedByWatcher = false;
    } else {
      managedCleanupFailed = true;
      managedByWatcher = false;
      manualVisibilityOverride = true;
      pendingShow = true;
      notify(`失效联动未能移除：${cleanupResult.error?.message || '未知错误'}`);
    }
  }
  let legacyBackgroundOperationSucceeded = false;
  if (!managedByWatcher && currentSettings().autoShowWithNetease) {
    const result = updateLoginItemSetting(
      true,
      pendingForegroundPortablePath || preferredPortablePath,
    );
    if (result.ok) pendingForegroundPortablePath = null;
    legacyBackgroundOperationSucceeded = result.ok;
    if (!result.ok) {
      if (!backgroundLaunch) {
        try {
          configStore.updateStrict({ autoShowWithNetease: false, launchAtLogin: false });
        } catch {}
      }
      notify(`联动监听器安装失败：${result.error?.message || '未知错误'}`);
    }
  } else if (!managedByWatcher && !currentSettings().autoShowWithNetease
      && !managedCleanupFailed && !staleManagedExitRequested) {
    const cleanupResult = updateLoginItemSetting(false);
    legacyBackgroundOperationSucceeded = cleanupResult.ok;
    if (!cleanupResult.ok) {
      notify(`旧联动配置未能清理：${cleanupResult.error?.message || '未知错误'}`);
    }
  }
  // A pre-0.3.2 Run entry may still launch the portable directly with
  // --background. Once migrated, leave before the watcher's 500ms debounce so
  // any running NetEase session can be relaunched with managed ownership.
  const legacyHandoffRequested = backgroundLaunch && !startedManagedByWatcher
    && legacyBackgroundOperationSucceeded;
  registerIpc();
  createWindow();
  createTray();
  registerShortcuts();
  if (demoEnabled) startDemo();
  else startMediaWorker();
  updateNetEaseProcessWatcher();
  startWatcherStateMonitoring();
  handleStateReportMode();
  handleTransitionReportMode();
  if (legacyHandoffRequested) {
    setTimeout(() => {
      if (foregroundLaunchPromoted || quitting) return;
      quitting = true;
      app.releaseSingleInstanceLock();
      app.quit();
    }, 50).unref?.();
  }
  if (staleManagedExitRequested) {
    setTimeout(() => {
      if (foregroundLaunchPromoted || quitting) return;
      quitting = true;
      app.releaseSingleInstanceLock();
      app.quit();
    }, 50).unref?.();
  }

  screen.on('display-removed', () => {
    if (!mainWindow) return;
    animateBounds(clampBounds(mainWindow.getBounds()));
    applyTopmost();
  });
  screen.on('display-added', () => applyTopmost());
  screen.on('display-metrics-changed', () => {
    if (!mainWindow) return;
    const clamped = clampBounds(mainWindow.getBounds());
    animateBounds(clamped);
    applyTopmost();
  });
});

app.on('activate', () => showOverlay({ manual: true }));
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
  clearInterval(demoTimer);
  clearTimeout(autoHideTimer);
  clearTimeout(dragEndTimer);
  clearTimeout(positionSaveTimer);
  windowHoverMonitor?.stop();
  clearManagedExit();
  stopWatcherStateMonitoring();
  neteaseProcessWatcher?.stop();
  stopMediaWorker();
  globalShortcut.unregisterAll();
});
