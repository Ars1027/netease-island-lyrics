'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  estimateTrackOffset,
  findActiveLine,
  findActiveLineIndex,
  mergeLyrics,
  parseLrc,
  parseLyricsPayload,
  parseTimestamp,
  parseYrc,
} = require('../src/services/lyrics-parser');

test('parseTimestamp supports common fractions and an optional hour', () => {
  assert.equal(parseTimestamp('[03:15.4]'), 195400);
  assert.equal(parseTimestamp('[03:15.42]'), 195420);
  assert.equal(parseTimestamp('[03:15.420]'), 195420);
  assert.equal(parseTimestamp('[1:03:15.420]'), 3795420);
  assert.equal(parseTimestamp('not a timestamp'), null);
});

test('parseLrc expands multiple timestamps, applies offset, and sorts the timeline', () => {
  const parsed = parseLrc(`
[ar:Example Artist]
[ti:Example Song]
[offset:250]
[00:02.50][00:04.500]Chorus
[00:01.000]First line
[00:01.000]First line
  `);

  assert.deepEqual({ ...parsed.metadata }, {
    ar: 'Example Artist',
    ti: 'Example Song',
    offset: '250',
  });
  assert.equal(parsed.offsetMs, 250);
  assert.deepEqual(parsed.lines.map(({ timeMs, text }) => ({ timeMs, text })), [
    { timeMs: 1250, text: 'First line' },
    { timeMs: 2750, text: 'Chorus' },
    { timeMs: 4750, text: 'Chorus' },
  ]);
  assert.equal(parsed.lines[0].endTimeMs, 2750);
  assert.equal(parsed.lines[0].durationMs, 1500);
  assert.equal(parsed.lines.at(-1).endTimeMs, null);
});

test('parseLrc can retain empty cue lines and negative adjusted time when requested', () => {
  const parsed = parseLrc('[offset:-500]\n[00:00.200]', {
    keepEmpty: true,
    clampToZero: false,
  });

  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].timeMs, -300);
  assert.equal(parsed.lines[0].text, '');
});

test('parseYrc preserves NetEase line and per-word timings', () => {
  const parsed = parseYrc([
    '[1000,900](1000,300,0)你(1300,600,0)好',
    '[2000,1000](2000,400,0)世(2400,600,0)界',
  ].join('\n'));

  assert.equal(parsed.kind, 'yrc');
  assert.equal(parsed.lines[0].text, '你好');
  assert.equal(parsed.lines[0].timeMs, 1000);
  assert.equal(parsed.lines[0].endTimeMs, 1900);
  assert.deepEqual(parsed.lines[0].words, [
    { timeMs: 1000, durationMs: 300, endTimeMs: 1300, text: '你' },
    { timeMs: 1300, durationMs: 600, endTimeMs: 1900, text: '好' },
  ]);
});

test('parseYrc auto-detects relative word timings when they fit inside the line', () => {
  const parsed = parseYrc('[5000,800](0,300,0)A(300,500,0)B');
  assert.deepEqual(parsed.lines[0].words.map((word) => word.timeMs), [5000, 5300]);
});

test('mergeLyrics matches translation and romanization within a small tolerance', () => {
  const original = parseLrc('[00:01.000]你好\n[00:02.000]世界');
  const translation = parseLrc('[00:01.075]Hello\n[00:02.000]World');
  const romanization = parseLrc('[00:01.000]ni hao\n[00:02.030]shi jie');
  const merged = mergeLyrics(original, { translation, romanization }, { toleranceMs: 80 });

  assert.deepEqual(merged.lines.map((line) => ({
    text: line.text,
    translation: line.translation,
    romanization: line.romanization,
  })), [
    { text: '你好', translation: 'Hello', romanization: 'ni hao' },
    { text: '世界', translation: 'World', romanization: 'shi jie' },
  ]);
});

test('mergeLyrics auto-aligns a stable offset between YRC and translated LRC', () => {
  const original = parseYrc([
    '[10550,1000](10550,1000,0)One',
    '[12550,1000](12550,1000,0)Two',
    '[15100,1000](15100,1000,0)Three',
    '[18350,1000](18350,1000,0)Four',
  ].join('\n'));
  const translation = parseLrc([
    '[00:10.000]一',
    '[00:12.000]二',
    '[00:14.550]三',
    '[00:17.800]四',
  ].join('\n'));

  assert.equal(estimateTrackOffset(original, translation), 550);
  const merged = mergeLyrics(original, { translation });
  assert.deepEqual(merged.lines.map((line) => line.translation), ['一', '二', '三', '四']);
});

test('parseLyricsPayload prefers YRC and merges ordinary translation tracks', () => {
  const parsed = parseLyricsPayload({
    lrc: { lyric: '[00:01.000]你好' },
    tlyric: { lyric: '[00:00.450]Hello' },
    romalrc: { lyric: '[00:00.500]ni hao' },
    yrc: { lyric: '[1000,800](1000,300,0)你(1300,500,0)好' },
  });

  assert.equal(parsed.sourceFormat, 'yrc');
  assert.equal(parsed.hasWordTiming, true);
  assert.equal(parsed.lines[0].translation, 'Hello');
  assert.equal(parsed.lines[0].romanization, 'ni hao');
  assert.equal(parsed.noLyrics, false);
  assert.equal(parsed.tracks.lrc.lines[0].text, '你好');
});

test('findActiveLine uses binary search and handles time before the first line', () => {
  const parsed = parseLrc('[00:01.000]One\n[00:02.000]Two\n[00:03.000]Three');
  assert.equal(findActiveLineIndex(parsed, 999), -1);
  assert.equal(findActiveLineIndex(parsed, 2500), 1);
  assert.equal(findActiveLine(parsed, 2500).text, 'Two');
  assert.equal(findActiveLine(parsed, 950, { leadMs: 100 }).text, 'One');
});
