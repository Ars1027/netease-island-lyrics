const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveVisualMode, windowSize, anchoredBounds, stageHeight } = require('../src/services/overlay-layout');

test('expanded view remains accessible without media; compact falls back to idle', () => {
  assert.equal(resolveVisualMode('expanded', false), 'expanded');
  assert.equal(resolveVisualMode('expanded', true), 'expanded');
  assert.equal(resolveVisualMode('compact', false), 'idle');
  assert.equal(resolveVisualMode('compact', true), 'compact');
});

test('only compact characters reserve headroom, including the five-pixel animation margin', () => {
  assert.deepEqual(windowSize('expanded', true), { width: 584, height: 360 });
  assert.deepEqual(windowSize('compact', false), { width: 484, height: 82 });
  assert.equal(stageHeight('compact', true), 63);
  assert.equal(stageHeight('idle', true), 0);
});

test('changing character headroom and view width preserves capsule center and top', () => {
  const original = { x: 500, y: 200, width: 484, height: 82 };
  const character = anchoredBounds(original, 0, 'compact', true);
  assert.equal(character.y + 63, original.y);
  const expanded = anchoredBounds(character, 63, 'expanded', true);
  assert.equal(expanded.y, original.y);
  assert.equal(expanded.x + expanded.width / 2, original.x + original.width / 2);
  assert.deepEqual(anchoredBounds(expanded, 0, 'compact', false), original);
});
