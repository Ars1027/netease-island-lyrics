const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = Object.freeze({
  settingsVersion: 4,
  mode: 'compact',
  clickThrough: false,
  showTranslation: true,
  showRomanization: false,
  lyricOffsetMs: 0,
  launchAtLogin: true,
  autoShowWithNetease: true,
  topmostMode: 'fullscreen',
  acceptAnyMedia: false,
  opacity: 0.94,
  position: null,
});

const ALLOWED_MODES = new Set(['compact', 'expanded']);
const ALLOWED_TOPMOST_MODES = new Set(['fullscreen', 'off']);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeSettings(input = {}) {
  const output = { ...DEFAULT_SETTINGS };

  output.settingsVersion = 4;
  if (ALLOWED_MODES.has(input.mode)) output.mode = input.mode;
  if (typeof input.clickThrough === 'boolean') output.clickThrough = input.clickThrough;
  if (typeof input.showTranslation === 'boolean') output.showTranslation = input.showTranslation;
  if (typeof input.showRomanization === 'boolean') output.showRomanization = input.showRomanization;
  if (typeof input.launchAtLogin === 'boolean') output.launchAtLogin = input.launchAtLogin;
  if (typeof input.autoShowWithNetease === 'boolean') output.autoShowWithNetease = input.autoShowWithNetease;
  if (ALLOWED_TOPMOST_MODES.has(input.topmostMode)) output.topmostMode = input.topmostMode;
  if (typeof input.acceptAnyMedia === 'boolean') output.acceptAnyMedia = input.acceptAnyMedia;

  if (Number.isFinite(input.lyricOffsetMs)) {
    output.lyricOffsetMs = Math.round(clamp(input.lyricOffsetMs, -5000, 5000));
  }

  if (Number.isFinite(input.opacity)) {
    output.opacity = Math.round(clamp(input.opacity, 0.65, 1) * 100) / 100;
  }

  if (
    input.position
    && Number.isFinite(input.position.x)
    && Number.isFinite(input.position.y)
  ) {
    output.position = {
      x: Math.round(input.position.x),
      y: Math.round(input.position.y),
    };
  }

  return output;
}

function migrateSettings(input = {}) {
  const version = Number(input.settingsVersion || 0);
  if (version >= 3) return sanitizeSettings(input);

  if (version >= 2) {
    return sanitizeSettings({
      ...input,
      settingsVersion: 4,
    });
  }

  return sanitizeSettings({
    ...input,
    settingsVersion: 4,
    launchAtLogin: true,
    autoShowWithNetease: true,
    topmostMode: 'fullscreen',
    lyricOffsetMs: 0,
  });
}

class ConfigStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'settings.json');
    this.settings = this.#read();
    this.#write();
  }

  #read() {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      return migrateSettings(JSON.parse(content));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  get() {
    return structuredClone(this.settings);
  }

  update(patch) {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    this.#write();
    return this.get();
  }

  updateStrict(patch) {
    const previous = this.settings;
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    try {
      this.#write({ throwOnError: true });
    } catch (error) {
      this.settings = previous;
      throw error;
    }
    return this.get();
  }

  #write({ throwOnError = false } = {}) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (throwOnError) throw error;
      console.warn('Unable to save settings:', error.message);
    }
  }
}

module.exports = {
  ConfigStore,
  DEFAULT_SETTINGS,
  sanitizeSettings,
  migrateSettings,
};
