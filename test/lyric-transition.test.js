'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADJACENT_DURATION_MS,
  CROSSFADE_DURATION_MS,
  TransitionController,
  buildSnapshot,
  displaySubline,
  getTransitionSpec,
} = require('../src/renderer/lyric-transition');

const lines = [
  { text: '第一句', translation: 'First', romanization: 'di yi ju' },
  { text: '第二句', translation: '', romanization: '' },
  { text: '第三句', translation: 'Third', romanization: 'di san ju' },
];

test('compact subline follows translation, romanization, next-line and fallback priority', () => {
  assert.deepEqual(displaySubline(lines[0], lines[1], {
    showTranslation: true,
    showRomanization: true,
  }), { kind: 'translation', text: 'First' });
  assert.deepEqual(displaySubline(lines[0], lines[1], {
    showTranslation: false,
    showRomanization: true,
  }), { kind: 'romanization', text: 'di yi ju' });
  assert.deepEqual(displaySubline(lines[1], lines[2], {
    showTranslation: true,
    showRomanization: true,
  }), { kind: 'next', text: '第三句' });
  assert.deepEqual(displaySubline(lines[2], null, {
    showTranslation: false,
    showRomanization: false,
  }, '歌曲 · 歌手'), { kind: 'fallback', text: '歌曲 · 歌手' });
});

test('snapshot keeps five persistent rows and an empty reserved secondary slot', () => {
  const snapshot = buildSnapshot({
    lines,
    index: 1,
    settings: { showTranslation: true, showRomanization: true },
  });
  assert.equal(snapshot.rows.length, 5);
  assert.equal(snapshot.rows[2].text, '第二句');
  assert.equal(snapshot.rows[2].secondaryKind, 'empty');
  assert.equal(snapshot.rows[2].secondaryText, '');
  assert.equal(snapshot.sublineKind, 'next');
});

test('transition specs distinguish adjacent, seek and secondary-only changes', () => {
  const first = buildSnapshot({ lines, index: 0, settings: { showTranslation: true } });
  const second = buildSnapshot({ lines, index: 1, settings: { showTranslation: true } });
  const third = buildSnapshot({ lines, index: 2, settings: { showTranslation: true } });
  const noTranslation = buildSnapshot({ lines, index: 0, settings: { showTranslation: false } });

  assert.deepEqual(getTransitionSpec(first, second).kind, 'adjacent');
  assert.equal(getTransitionSpec(first, second).duration, ADJACENT_DURATION_MS);
  assert.equal(getTransitionSpec(first, third).kind, 'crossfade');
  assert.equal(getTransitionSpec(first, third).duration, CROSSFADE_DURATION_MS);
  assert.equal(getTransitionSpec(first, noTranslation).kind, 'secondary');
  assert.equal(getTransitionSpec(second, first).direction, 'backward');
});

test('controller settles a pending target before coalescing to the latest request', async () => {
  const commits = [];
  const settled = [];
  const deferred = [];
  const adapter = {
    commit(snapshot) { commits.push(snapshot.index); },
    settle(snapshot) { settled.push(snapshot.index); },
    cancel() {},
    transition() {
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      deferred.push(resolve);
      return promise;
    },
  };
  const controller = new TransitionController(adapter);
  const snapshots = [0, 1, 2].map((index) => buildSnapshot({ lines, index }));

  await controller.transitionTo(snapshots[0], 'initial');
  const stale = controller.transitionTo(snapshots[1]);
  const latest = controller.transitionTo(snapshots[2]);
  deferred[0]();
  deferred[1]();
  assert.equal((await stale).committed, false);
  assert.equal((await latest).committed, true);
  assert.deepEqual(settled, [1]);
  assert.deepEqual(commits, [0, 2]);
});
