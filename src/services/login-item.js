const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WATCHER_DIRECTORY_NAME = 'Watcher';
const WATCHER_FILE_NAME = 'NeteaseIslandWatcher.exe';
const WATCHER_STATE_FILE_NAME = 'state.json';
// Native registration transactions include bounded mutex waits, graceful
// process shutdown and rollback/restart paths. Never kill the helper mid-undo.
const COMMAND_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 6_500;

function startupCommand(watcherPath) {
  const safePath = String(watcherPath || '').replaceAll('"', '');
  return `"${safePath}"`;
}

function resolveWatcherPaths(localAppData) {
  const root = path.resolve(String(localAppData || ''), 'Netease Island Lyrics', WATCHER_DIRECTORY_NAME);
  return {
    root,
    executable: path.join(root, WATCHER_FILE_NAME),
    stateFile: path.join(root, WATCHER_STATE_FILE_NAME),
  };
}

function fileHash(filePath, fsImpl = fs) {
  const hash = crypto.createHash('sha256');
  hash.update(fsImpl.readFileSync(filePath));
  return hash.digest('hex');
}

function filesMatch(left, right, fsImpl = fs) {
  try {
    const leftStat = fsImpl.statSync(left);
    const rightStat = fsImpl.statSync(right);
    return leftStat.size === rightStat.size && fileHash(left, fsImpl) === fileHash(right, fsImpl);
  } catch {
    return false;
  }
}

function runWatcherCommand(
  executablePath,
  arguments_,
  spawnSyncImpl = spawnSync,
  timeout = COMMAND_TIMEOUT_MS,
) {
  const result = spawnSyncImpl(executablePath, arguments_, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  const stderr = String(result.stderr || '').trim();
  const stdout = String(result.stdout || '').trim();
  return {
    ok: result.status === 0,
    status: result.status,
    error: result.error || (result.status === 0
      ? null
      : new Error(stderr || stdout || `监听器命令退出码：${result.status ?? '未知'}`)),
    stderr,
    stdout,
  };
}

function watcherIsRunning(executablePath, spawnSyncImpl = spawnSync, fsImpl = fs) {
  if (!executablePath || !fsImpl.existsSync(executablePath)) return false;
  return runWatcherCommand(executablePath, ['--status'], spawnSyncImpl, 3000).ok;
}

function stopWatcher(executablePath, spawnSyncImpl = spawnSync, fsImpl = fs) {
  if (!executablePath || !fsImpl.existsSync(executablePath)) return { ok: true, missing: true };
  return runWatcherCommand(executablePath, ['--stop'], spawnSyncImpl, STOP_TIMEOUT_MS);
}

function replaceWatcherExecutable(sourcePath, destinationPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  if (!fsImpl.existsSync(sourcePath)) throw new Error('内置联动监听器缺失');
  fsImpl.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const destinationExisted = fsImpl.existsSync(destinationPath);
  const wasRunning = destinationExisted
    && watcherIsRunning(destinationPath, spawnSyncImpl, fsImpl);
  if (filesMatch(sourcePath, destinationPath, fsImpl)) {
    return {
      updated: false,
      backupPath: null,
      destinationExisted,
      wasRunning,
    };
  }

  const stopResult = stopWatcher(destinationPath, spawnSyncImpl, fsImpl);
  if (!stopResult.ok) throw stopResult.error || new Error('旧版联动监听器未能停止');

  const temporaryPath = `${destinationPath}.new`;
  const backupPath = `${destinationPath}.old`;
  try {
    fsImpl.rmSync(temporaryPath, { force: true });
    fsImpl.rmSync(backupPath, { force: true });
    fsImpl.copyFileSync(sourcePath, temporaryPath);
    if (destinationExisted) fsImpl.renameSync(destinationPath, backupPath);
    fsImpl.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    try {
      fsImpl.rmSync(temporaryPath, { force: true });
      if (!fsImpl.existsSync(destinationPath) && fsImpl.existsSync(backupPath)) {
        fsImpl.renameSync(backupPath, destinationPath);
      }
    } catch {}
    error.watcherWasRunning = wasRunning;
    throw error;
  }

  return {
    updated: true,
    backupPath,
    destinationExisted,
    wasRunning,
  };
}

function commitWatcherReplacement(replacement, fsImpl = fs) {
  if (!replacement?.backupPath) return true;
  try {
    fsImpl.rmSync(replacement.backupPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function rollbackWatcherReplacement(replacement, destinationPath, fsImpl = fs) {
  if (!replacement?.updated) return;
  fsImpl.rmSync(destinationPath, { force: true });
  if (replacement.destinationExisted && replacement.backupPath
      && fsImpl.existsSync(replacement.backupPath)) {
    fsImpl.renameSync(replacement.backupPath, destinationPath);
  }
}

function launchWatcher(executablePath, spawnImpl = spawn) {
  const child = spawnImpl(executablePath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once?.('error', () => {});
  child.unref?.();
  return child;
}

function waitForWatcherReady(executablePath, spawnSyncImpl = spawnSync, fsImpl = fs) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (watcherIsRunning(executablePath, spawnSyncImpl, fsImpl)) return true;
  }
  return false;
}

function restorePreviousWatcher(replacement, executablePath, options = {}) {
  if (!replacement?.wasRunning) return true;
  try {
    launchWatcher(executablePath, options.spawnImpl || spawn);
    return waitForWatcherReady(
      executablePath,
      options.spawnSyncImpl || spawnSync,
      options.fsImpl || fs,
    );
  } catch {
    return false;
  }
}

function enableWatcherIntegration({
  sourcePath,
  localAppData,
  targetPath,
  version,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fsImpl = fs,
} = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const target = path.resolve(String(targetPath || ''));
  if (!targetPath || !fsImpl.existsSync(target)) {
    return { ok: false, error: new Error('当前 portable 路径无效') };
  }

  const paths = resolveWatcherPaths(localAppData);
  let replacement = null;
  try {
    replacement = replaceWatcherExecutable(sourcePath, paths.executable, { fsImpl, spawnSyncImpl });
    const configureResult = runWatcherCommand(
      paths.executable,
      ['--configure', target, String(version || '')],
      spawnSyncImpl,
    );
    if (!configureResult.ok) throw configureResult.error;
    commitWatcherReplacement(replacement, fsImpl);
    return { ok: true, paths, targetPath: target, configureResult };
  } catch (error) {
    if (!replacement && error.watcherWasRunning) {
      replacement = { updated: false, wasRunning: true };
    }
    let rollbackError = null;
    try {
      rollbackWatcherReplacement(replacement, paths.executable, fsImpl);
    } catch (caught) {
      rollbackError = caught;
    }
    const previousRestored = rollbackError
      ? false
      : restorePreviousWatcher(replacement, paths.executable, { spawnImpl, spawnSyncImpl, fsImpl });
    const detail = rollbackError
      ? `；旧监听器文件恢复失败：${rollbackError.message}`
      : (!previousRestored ? '；旧监听器进程恢复失败' : '');
    return { ok: false, error: new Error(`${error.message}${detail}`), paths };
  }
}

function cleanupWatcherFiles(localAppData, fsImpl = fs) {
  const paths = resolveWatcherPaths(localAppData);
  const localRoot = path.resolve(String(localAppData || ''));
  const relative = path.relative(localRoot, paths.root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  try {
    fsImpl.rmSync(paths.root, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function disableWatcherIntegration({
  sourcePath,
  localAppData,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  fsImpl = fs,
} = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true };
  const paths = resolveWatcherPaths(localAppData);
  let replacement = null;
  try {
    replacement = replaceWatcherExecutable(sourcePath, paths.executable, { fsImpl, spawnSyncImpl });
    const unregisterResult = runWatcherCommand(
      paths.executable,
      ['--unregister'],
      spawnSyncImpl,
    );
    if (!unregisterResult.ok) throw unregisterResult.error;
    commitWatcherReplacement(replacement, fsImpl);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    return {
      ok: true,
      paths,
      unregisterResult,
      filesRemoved: cleanupWatcherFiles(localAppData, fsImpl),
    };
  } catch (error) {
    if (!replacement && error.watcherWasRunning) {
      replacement = { updated: false, wasRunning: true };
    }
    let rollbackError = null;
    try {
      rollbackWatcherReplacement(replacement, paths.executable, fsImpl);
    } catch (caught) {
      rollbackError = caught;
    }
    const previousRestored = rollbackError
      ? false
      : restorePreviousWatcher(replacement, paths.executable, { spawnImpl, spawnSyncImpl, fsImpl });
    const detail = rollbackError
      ? `；旧监听器文件恢复失败：${rollbackError.message}`
      : (!previousRestored ? '；旧监听器进程恢复失败' : '');
    return { ok: false, error: new Error(`${error.message}${detail}`), paths };
  }
}

module.exports = {
  WATCHER_FILE_NAME,
  WATCHER_STATE_FILE_NAME,
  cleanupWatcherFiles,
  disableWatcherIntegration,
  enableWatcherIntegration,
  filesMatch,
  resolveWatcherPaths,
  runWatcherCommand,
  startupCommand,
  watcherIsRunning,
};
