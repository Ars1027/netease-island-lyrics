const test = require('node:test');
const assert = require('node:assert/strict');
const { nextLyricBoundaryDelay } = require('../src/renderer/lyric-scheduler');

const lines = [{ timeMs: 1000 }, { timeMs: 2500 }, { timeMs: 4000 }];

test('scheduler targets the next exact lyric boundary without a frame loop', () => {
  assert.equal(nextLyricBoundaryDelay({
    lines,
    positionMs: 1200,
    playing: true,
    hidden: false,
  }), 1302);
});

test('scheduler waits for the first cue and caps unusually distant cues', () => {
  assert.equal(nextLyricBoundaryDelay({
    lines,
    positionMs: 200,
    playing: true,
    hidden: false,
  }), 802);
  assert.equal(nextLyricBoundaryDelay({
    lines: [{ timeMs: 90_000 }],
    positionMs: 0,
    playing: true,
    hidden: false,
  }), 60_000);
});

test('scheduler stops while paused, hidden, or after the final cue', () => {
  assert.equal(nextLyricBoundaryDelay({ lines, positionMs: 1200, playing: false, hidden: false }), null);
  assert.equal(nextLyricBoundaryDelay({ lines, positionMs: 1200, playing: true, hidden: true }), null);
  assert.equal(nextLyricBoundaryDelay({ lines, positionMs: 5000, playing: true, hidden: false }), null);
});
