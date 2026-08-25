const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HOVER_POLL_INTERVAL_MS,
  pointInWindowShape,
  shouldMonitorWindowHover,
  WindowHoverMonitor,
} = require('../src/services/window-hover-monitor');

test('window shape hit testing includes shaped content and excludes transparent space', () => {
  const bounds = { x: 100, y: 200, width: 80, height: 60 };
  const shape = [
    { x: 20, y: 0, width: 40, height: 10 },
    { x: 0, y: 10, width: 80, height: 50 },
  ];

  assert.equal(pointInWindowShape({ x: 120, y: 200 }, bounds, shape), true);
  assert.equal(pointInWindowShape({ x: 100, y: 210 }, bounds, shape), true);
  assert.equal(pointInWindowShape({ x: 110, y: 205 }, bounds, shape), false);
  assert.equal(pointInWindowShape({ x: 180, y: 220 }, bounds, shape), false);
  assert.equal(pointInWindowShape({ x: 140, y: 260 }, bounds, shape), false);
});

test('hover monitoring is active only for a visible stable compact window', () => {
  assert.equal(shouldMonitorWindowHover({ visible: true, visualMode: 'compact', animating: false }), true);
  assert.equal(shouldMonitorWindowHover({ visible: false, visualMode: 'compact', animating: false }), false);
  assert.equal(shouldMonitorWindowHover({ visible: true, visualMode: 'idle', animating: false }), false);
  assert.equal(shouldMonitorWindowHover({ visible: true, visualMode: 'expanded', animating: false }), false);
  assert.equal(shouldMonitorWindowHover({ visible: true, visualMode: 'compact', animating: true }), false);
});

test('hover monitor keeps one timer, emits only changes, and cannot revive after stop', () => {
  let nextHover = true;
  const scheduled = [];
  const cleared = [];
  const changes = [];
  const monitor = new WindowHoverMonitor({
    sampleHover: () => nextHover,
    onChange: (hovered) => changes.push(hovered),
    setTimeoutImpl(callback, delay) {
      const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      scheduled.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => cleared.push(handle),
  });

  monitor.start();
  monitor.start();
  assert.deepEqual(changes, [true]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, DEFAULT_HOVER_POLL_INTERVAL_MS);
  assert.equal(scheduled[0].unrefCalled, true);

  nextHover = false;
  scheduled[0].callback();
  assert.deepEqual(changes, [true, false]);
  assert.equal(scheduled.length, 2);

  nextHover = true;
  scheduled[1].callback();
  assert.deepEqual(changes, [true, false, true]);
  assert.equal(scheduled.length, 3);
  monitor.stop();
  assert.deepEqual(changes, [true, false, true, false]);
  assert.equal(cleared.at(-1), scheduled[2]);

  const scheduledBeforeStaleCallback = scheduled.length;
  scheduled[2].callback();
  assert.equal(scheduled.length, scheduledBeforeStaleCallback);
  assert.equal(monitor.running, false);
});
