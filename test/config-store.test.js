const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ConfigStore,
  DEFAULT_SETTINGS,
  migrateSettings,
  sanitizeSettings,
} = require('../src/services/config-store');

test('version 4 defaults enable watcher-based NetEase linkage and fullscreen topmost', () => {
  assert.equal(DEFAULT_SETTINGS.settingsVersion, 4);
  assert.equal(DEFAULT_SETTINGS.launchAtLogin, true);
  assert.equal(DEFAULT_SETTINGS.autoShowWithNetease, true);
  assert.equal(DEFAULT_SETTINGS.topmostMode, 'fullscreen');
  assert.equal(DEFAULT_SETTINGS.lyricOffsetMs, 0);
});

test('version 1 settings migrate once and reset obsolete manual sync compensation', () => {
  const migrated = migrateSettings({
    mode: 'expanded',
    launchAtLogin: false,
    lyricOffsetMs: -1400,
  });
  assert.equal(migrated.settingsVersion, 4);
  assert.equal(migrated.mode, 'expanded');
  assert.equal(migrated.launchAtLogin, true);
  assert.equal(migrated.autoShowWithNetease, true);
  assert.equal(migrated.topmostMode, 'fullscreen');
  assert.equal(migrated.lyricOffsetMs, 0);
});

test('version 4 explicit user choices are preserved and sanitized', () => {
  const settings = sanitizeSettings({
    settingsVersion: 4,
    launchAtLogin: false,
    autoShowWithNetease: false,
    topmostMode: 'off',
    lyricOffsetMs: 8000,
  });
  assert.equal(settings.launchAtLogin, false);
  assert.equal(settings.autoShowWithNetease, false);
  assert.equal(settings.topmostMode, 'off');
  assert.equal(settings.lyricOffsetMs, 5000);
});

test('version 3 upgrade preserves the existing watcher choice and lyric offset', () => {
  const settings = migrateSettings({
    settingsVersion: 3,
    launchAtLogin: false,
    autoShowWithNetease: false,
    lyricOffsetMs: -1300,
    showRomanization: true,
  });
  assert.equal(settings.settingsVersion, 4);
  assert.equal(settings.launchAtLogin, false);
  assert.equal(settings.autoShowWithNetease, false);
  assert.equal(settings.lyricOffsetMs, -1300);
  assert.equal(settings.showRomanization, true);
});

test('version 2 position migrates as the island anchor without shifting', () => {
  const settings = migrateSettings({
    settingsVersion: 2,
    position: { x: 720, y: 24 },
    mode: 'compact',
  });
  assert.equal(settings.settingsVersion, 4);
  assert.deepEqual(settings.position, { x: 720, y: 24 });
});

test('strict settings updates roll memory back when persistence fails', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'island-settings-strict-'));
  const store = new ConfigStore(temporaryRoot);
  const before = store.get();
  fs.rmSync(store.filePath, { force: true });
  fs.mkdirSync(store.filePath);
  try {
    assert.throws(() => store.updateStrict({ autoShowWithNetease: false }));
    assert.deepEqual(store.get(), before);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
