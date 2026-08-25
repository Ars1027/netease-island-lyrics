const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  disableWatcherIntegration,
  enableWatcherIntegration,
  resolveWatcherPaths,
  startupCommand,
} = require('../src/services/login-item');

function commandResult(status, stderr = '') {
  return { status, stdout: '', stderr };
}

test('startup command points only at the persistent watcher', () => {
  assert.equal(
    startupCommand('C:\\Users\\Me\\AppData\\Local\\Netease Island Lyrics\\Watcher\\NeteaseIslandWatcher.exe'),
    '"C:\\Users\\Me\\AppData\\Local\\Netease Island Lyrics\\Watcher\\NeteaseIslandWatcher.exe"',
  );
});

test('watcher paths stay below LocalAppData', () => {
  const paths = resolveWatcherPaths('C:\\Users\\Me\\AppData\\Local');
  assert.match(paths.executable, /Netease Island Lyrics[\\/]Watcher[\\/]NeteaseIslandWatcher\.exe$/);
  assert.match(paths.stateFile, /[\\/]state\.json$/);
});

test('enable installs the watcher and delegates registration atomically to native code', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-watcher-enable-'));
  const sourcePath = path.join(temporaryRoot, 'embedded.exe');
  const targetPath = path.join(temporaryRoot, 'NeteaseIslandLyrics portable.exe');
  fs.writeFileSync(sourcePath, 'watcher-binary');
  fs.writeFileSync(targetPath, 'portable-binary');
  const commands = [];
  const result = enableWatcherIntegration({
    sourcePath,
    localAppData: temporaryRoot,
    targetPath,
    version: '0.3.2',
    spawnSyncImpl(executable, arguments_) {
      commands.push({ executable, arguments_ });
      return commandResult(0);
    },
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(result.paths.executable, 'utf8'), 'watcher-binary');
    assert.deepEqual(commands.at(-1).arguments_, [
      '--configure',
      path.resolve(targetPath),
      '0.3.2',
    ]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('a failed native configure restores the previous watcher executable', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-watcher-rollback-'));
  const sourcePath = path.join(temporaryRoot, 'embedded.exe');
  const targetPath = path.join(temporaryRoot, 'portable.exe');
  const paths = resolveWatcherPaths(temporaryRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(sourcePath, 'new-watcher');
  fs.writeFileSync(paths.executable, 'old-watcher');
  fs.writeFileSync(targetPath, 'portable');
  const result = enableWatcherIntegration({
    sourcePath,
    localAppData: temporaryRoot,
    targetPath,
    version: '0.3.2',
    spawnSyncImpl(_executable, arguments_) {
      if (arguments_[0] === '--status') return commandResult(1);
      if (arguments_[0] === '--stop') return commandResult(0);
      if (arguments_[0] === '--configure') return commandResult(5, 'registration failed');
      return commandResult(0);
    },
  });
  try {
    assert.equal(result.ok, false);
    assert.match(result.error.message, /registration failed/);
    assert.equal(fs.readFileSync(paths.executable, 'utf8'), 'old-watcher');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('a running previous watcher is relaunched after configure rollback', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-watcher-restart-'));
  const sourcePath = path.join(temporaryRoot, 'embedded.exe');
  const targetPath = path.join(temporaryRoot, 'portable.exe');
  const paths = resolveWatcherPaths(temporaryRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(sourcePath, 'new-watcher');
  fs.writeFileSync(paths.executable, 'old-watcher');
  fs.writeFileSync(targetPath, 'portable');
  let statusCalls = 0;
  let relaunched = null;
  const result = enableWatcherIntegration({
    sourcePath,
    localAppData: temporaryRoot,
    targetPath,
    version: '0.3.2',
    spawnSyncImpl(_executable, arguments_) {
      if (arguments_[0] === '--status') {
        statusCalls += 1;
        return commandResult(statusCalls === 1 || statusCalls >= 2 ? 0 : 1);
      }
      if (arguments_[0] === '--stop') return commandResult(0);
      if (arguments_[0] === '--configure') return commandResult(6, 'start failed');
      return commandResult(0);
    },
    spawnImpl(executable) {
      relaunched = executable;
      return { once() {}, unref() {} };
    },
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(relaunched, paths.executable);
    assert.equal(fs.readFileSync(paths.executable, 'utf8'), 'old-watcher');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('successful native unregister removes stopped watcher files', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-watcher-disable-'));
  const sourcePath = path.join(temporaryRoot, 'embedded.exe');
  fs.writeFileSync(sourcePath, 'watcher');
  const commands = [];
  const result = disableWatcherIntegration({
    sourcePath,
    localAppData: temporaryRoot,
    spawnSyncImpl(executable, arguments_) {
      commands.push({ executable, arguments_ });
      return commandResult(0);
    },
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.filesRemoved, true);
    assert.deepEqual(commands.at(-1).arguments_, ['--unregister']);
    assert.equal(fs.existsSync(result.paths.root), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('failed native unregister leaves the watcher available for recovery', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-watcher-disable-fail-'));
  const sourcePath = path.join(temporaryRoot, 'embedded.exe');
  fs.writeFileSync(sourcePath, 'watcher');
  const paths = resolveWatcherPaths(temporaryRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.executable, 'watcher');
  const result = disableWatcherIntegration({
    sourcePath,
    localAppData: temporaryRoot,
    spawnSyncImpl(_executable, arguments_) {
      if (arguments_[0] === '--unregister') return commandResult(5, 'registry rollback completed');
      return commandResult(0);
    },
    spawnImpl() {
      return { once() {}, unref() {} };
    },
  });
  try {
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(paths.executable), true);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
