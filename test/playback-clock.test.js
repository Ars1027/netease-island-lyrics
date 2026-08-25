const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTO_LYRIC_LEAD_MS,
  PlaybackClock,
} = require('../src/renderer/playback-clock');

function media(overrides = {}) {
  return {
    trackKey: 'cloudmusic|song',
    position: 10,
    duration: 200,
    playbackStatus: 4,
    observedAt: 50_000,
    lastUpdatedTime: 0,
    positionPrecisionMs: 1000,
    ...overrides,
  };
}

test('lyrics use a hidden 350ms lead while preserving user offset semantics', () => {
  let monotonic = 1000;
  const clock = new PlaybackClock({
    monotonicNow: () => monotonic,
    wallNow: () => 50_000,
  });
  clock.anchor(media(), monotonic, 50_000);

  assert.equal(AUTO_LYRIC_LEAD_MS, 350);
  assert.equal(clock.lyricMs(monotonic, 0), clock.playbackMs(monotonic) + 350);
  assert.equal(clock.lyricMs(monotonic, 500), clock.playbackMs(monotonic) - 150);
});

test('timeline lastUpdatedTime restores sub-second playback precision', () => {
  const clock = new PlaybackClock({ monotonicNow: () => 1000, wallNow: () => 50_400 });
  clock.anchor(media({ lastUpdatedTime: 50_000 }), 1000, 50_400);
  assert.equal(clock.playbackMs(1000), 10_400);
});

test('integer-second polling does not pull a smoothly projected clock backwards', () => {
  let monotonic = 0;
  let wall = 10_000;
  const clock = new PlaybackClock({ monotonicNow: () => monotonic, wallNow: () => wall });
  clock.anchor(media({ observedAt: wall }), monotonic, wall);
  monotonic = 650;
  wall += 650;
  clock.anchor(media({ position: 10, observedAt: wall }), monotonic, wall);
  assert.ok(clock.playbackMs(monotonic) >= 10_600);
});

test('large timeline changes are treated as seeks immediately', () => {
  let monotonic = 0;
  const clock = new PlaybackClock({ monotonicNow: () => monotonic, wallNow: () => 20_000 });
  clock.anchor(media(), monotonic, 20_000);
  monotonic = 250;
  const result = clock.anchor(media({ position: 42, observedAt: 20_250 }), monotonic, 20_250);
  assert.equal(result.seeked, true);
  assert.ok(clock.playbackMs(monotonic) >= 42_000);
});

test('pause freezes the clock and resume continues interpolation', () => {
  let monotonic = 0;
  let wall = 30_000;
  const clock = new PlaybackClock({ monotonicNow: () => monotonic, wallNow: () => wall });
  clock.anchor(media({ observedAt: wall }), monotonic, wall);
  monotonic = 500;
  wall += 500;
  clock.anchor(media({ position: 10, playbackStatus: 5, observedAt: wall }), monotonic, wall);
  const pausedAt = clock.playbackMs(monotonic);
  monotonic += 2000;
  assert.equal(clock.playbackMs(monotonic), pausedAt);
  clock.anchor(media({ position: 12, observedAt: wall + 2000 }), monotonic, wall + 2000);
  monotonic += 300;
  assert.ok(clock.playbackMs(monotonic) > pausedAt);
});
