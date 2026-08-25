const path = require('node:path');
const { execFile } = require('node:child_process');

const DEFAULT_POLL_INTERVAL_MS = 2000;
const RUNNING_POLL_INTERVAL_MS = 5000;
const TASKLIST_TIMEOUT_MS = 5000;

function tasklistHasNetEase(stdout) {
  return /(?:^|["\s])cloudmusic\.exe(?:["\s,]|$)/im.test(String(stdout || ''));
}

function queryNetEaseProcess(execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
    execFileImpl(executable, [
      '/FI',
      'IMAGENAME eq cloudmusic.exe',
      '/FO',
      'CSV',
      '/NH',
    ], {
      encoding: 'utf8',
      timeout: TASKLIST_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(tasklistHasNetEase(stdout));
    });
  });
}

class NetEaseProcessWatcher {
  constructor({
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    onChange = () => {},
    onError = () => {},
    execFileImpl = execFile,
  } = {}) {
    this.intervalMs = Math.max(500, Number(intervalMs) || DEFAULT_POLL_INTERVAL_MS);
    this.onChange = onChange;
    this.onError = onError;
    this.execFile = execFileImpl;
    this.running = false;
    this.lastState = null;
    this.timer = null;
    this.child = null;
    this.generation = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.generation += 1;
    this.#check(this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.child) {
      this.child.process?.kill();
      this.child = null;
    }
    this.lastState = null;
  }

  #schedule(generation) {
    if (!this.running || generation !== this.generation) return;
    clearTimeout(this.timer);
    const delay = this.lastState ? Math.max(this.intervalMs, RUNNING_POLL_INTERVAL_MS) : this.intervalMs;
    this.timer = setTimeout(() => this.#check(generation), delay);
    this.timer.unref?.();
  }

  #check(generation = this.generation) {
    if (!this.running || generation !== this.generation || this.child) return;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const executable = path.join(systemRoot, 'System32', 'tasklist.exe');
    const request = { generation, process: null };
    this.child = request;
    request.process = this.execFile(executable, [
      '/FI',
      'IMAGENAME eq cloudmusic.exe',
      '/FO',
      'CSV',
      '/NH',
    ], {
      encoding: 'utf8',
      timeout: TASKLIST_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      if (!this.running || this.child !== request || generation !== this.generation) return;
      this.child = null;
      if (error) {
        this.onError(error);
      } else {
        const nextState = tasklistHasNetEase(stdout);
        if (nextState !== this.lastState) {
          this.lastState = nextState;
          this.onChange(nextState);
        }
      }
      this.#schedule(generation);
    });
  }
}

module.exports = {
  DEFAULT_POLL_INTERVAL_MS,
  NetEaseProcessWatcher,
  queryNetEaseProcess,
  RUNNING_POLL_INTERVAL_MS,
  tasklistHasNetEase,
};
