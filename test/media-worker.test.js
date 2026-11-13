const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function session(title = 'Song', thumbnail = null) {
  return {
    sourceAppId: 'cloudmusic.exe',
    media: { title, artist: 'Artist', thumbnail },
    playback: { playbackStatus: 4 },
    timeline: { position: 10, duration: 180 },
  };
}

function harness({ failStartup = false } = {}) {
  const port = new EventEmitter();
  const messages = [];
  const timeouts = new Map();
  const intervals = new Map();
  const timer = (collection, fn, delay) => {
    const handle = { unref() {} };
    collection.set(handle, { fn, delay });
    return handle;
  };
  let instance;
  let directQueries = 0;
  class Monitor extends EventEmitter {
    constructor() {
      super();
      if (failStartup) throw new Error('startup failed');
      instance = this;
      this.sessions = [session()];
    }
    static getMediaSessions() {
      directQueries += 1;
      throw new Error('Unexpected direct media query');
    }
    destroy() { this.destroyed = true; }
  }
  port.postMessage = (message) => messages.push(message);
  port.close = () => { port.closed = true; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/media-worker.js'), 'utf8'), {
    require(name) {
      if (name === 'node:worker_threads') return { parentPort: port, workerData: {} };
      if (name === '@coooookies/windows-smtc-monitor') return { SMTCMonitor: Monitor };
      return require('../src/services/media-session');
    },
    setTimeout: (fn, delay) => timer(timeouts, fn, delay),
    clearTimeout: (handle) => timeouts.delete(handle),
    setInterval: (fn, delay) => timer(intervals, fn, delay),
    clearInterval: (handle) => intervals.delete(handle),
  });
  const flush = () => {
    const pending = [...timeouts.values()];
    timeouts.clear();
    pending.forEach(({ fn }) => fn());
  };
  return {
    port, messages, timeouts, intervals,
    get monitor() { return instance; },
    get directQueries() { return directQueries; },
    set failStartup(value) { failStartup = value; },
    flush,
    latest() { return messages.filter((message) => message.type === 'media-state').at(-1)?.payload; },
  };
}

test('media events deliver delayed covers without periodic or delayed re-queries', () => {
  const h = harness();
  const jpeg = Buffer.from([0xff, 0xd8, 1]);
  assert.equal(h.latest().artwork, null);
  assert.equal(h.timeouts.size, 0);
  h.monitor.sessions = [session('Next song')];
  h.monitor.emit('session-media-changed', 'cloudmusic.exe');
  h.flush();
  assert.equal(h.latest().title, 'Next song');
  assert.equal(h.latest().artwork, null);
  assert.equal(h.timeouts.size, 0);
  h.monitor.sessions[0].media.thumbnail = jpeg;
  h.monitor.emit('session-media-changed', 'cloudmusic.exe');
  h.flush();
  assert.match(h.latest().artwork, /^data:image\/jpeg/);
  h.monitor.sessions[0].timeline = { position: 11, duration: 180 };
  h.monitor.emit('session-timeline-changed', 'cloudmusic.exe');
  h.flush();
  assert.equal(h.latest().title, 'Next song');
  assert.equal(h.latest().position, 11);
  assert.equal(Object.hasOwn(h.latest(), 'artwork'), false);
  assert.equal(h.directQueries, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  h.port.emit('message', { type: 'stop' });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.monitor.destroyed, true);
  assert.equal(h.port.closed, true);
});

test('session removal, reconnection and settings changes remain event driven', () => {
  const h = harness();
  h.monitor.sessions = [];
  h.monitor.emit('session-removed', 'cloudmusic.exe');
  h.flush();
  assert.equal(h.latest(), null);
  h.monitor.sessions = [session('Reconnected', Buffer.from([0xff, 0xd8, 1]))];
  h.monitor.emit('session-added', 'cloudmusic.exe');
  h.flush();
  assert.equal(h.latest().title, 'Reconnected');
  assert.match(h.latest().artwork, /^data:image\/jpeg/);
  h.port.emit('message', { type: 'settings', acceptAnyMedia: false });
  h.flush();
  assert.match(h.latest().artwork, /^data:image\/jpeg/);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.directQueries, 0);
  // Stopping while a publication is queued cancels the pending callback.
  h.monitor.emit('session-timeline-changed', 'cloudmusic.exe');
  h.port.emit('message', { type: 'stop' });
  h.port.emit('message', { type: 'stop' });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test('startup failures retry without a polling timer and stop cancels retries', () => {
  const h = harness({ failStartup: true });
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 1);
  h.failStartup = false;
  h.flush();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.latest().title, 'Song');
  h.port.emit('message', { type: 'stop' });
  const stopped = harness({ failStartup: true });
  stopped.port.emit('message', { type: 'stop' });
  stopped.flush();
  assert.equal(stopped.intervals.size, 0);
});
