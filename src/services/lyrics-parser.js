'use strict';

/*
 * Lyric format handling was informed by jitwxs/163MusicLyrics, especially its
 * NetEase verbatim-lyric conversion. That project is licensed under Apache-2.0:
 * https://github.com/jitwxs/163MusicLyrics
 * This JavaScript implementation is original and keeps the upstream attribution.
 */

const LRC_TIMESTAMP_SOURCE = String.raw`\[(?:(\d{1,3}):)?(\d{1,4}):(\d{1,2})(?:[\.:](\d{1,3}))?\]`;
const METADATA_RE = /^\[([a-z][\w-]*):([^\]]*)\]\s*$/iu;
const YRC_LINE_RE = /^\[(-?\d+),(\d+)(?:,\d+)?\](.*)$/u;
const YRC_WORD_SOURCE = String.raw`\((-?\d+),(\d+),(-?\d+)\)`;

function lyricText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.lyric === 'string') return value.lyric;
  return '';
}

function splitLines(value) {
  return lyricText(value)
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n');
}

function fractionToMs(fraction = '') {
  if (!fraction) return 0;
  return Number(fraction.padEnd(3, '0').slice(0, 3));
}

/** Convert a RegExp match from LRC_TIMESTAMP_SOURCE to milliseconds. */
function timestampMatchToMs(match) {
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const milliseconds = fractionToMs(match[4]);
  return (((hours * 60 + minutes) * 60) + seconds) * 1000 + milliseconds;
}

/** Parse a timestamp such as "[03:15.42]" or "[1:03:15.420]". */
function parseTimestamp(value) {
  const re = new RegExp(`^${LRC_TIMESTAMP_SOURCE}$`, 'u');
  const match = re.exec(String(value || '').trim());
  return match ? timestampMatchToMs(match) : null;
}

function readMetadata(lines) {
  const metadata = Object.create(null);
  let offsetMs = 0;

  for (const rawLine of lines) {
    const match = METADATA_RE.exec(rawLine.trim());
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim();
    metadata[key] = value;

    if (key === 'offset' && /^[-+]?\d+$/u.test(value)) {
      offsetMs = Number(value);
    }
  }

  return { metadata, offsetMs };
}

function adjustTime(timeMs, offsetMs, options) {
  const adjusted = timeMs + (options.applyOffset === false ? 0 : offsetMs);
  return options.clampToZero === false ? adjusted : Math.max(0, adjusted);
}

function sortAndFinalize(lines, lastLineDurationMs = null) {
  lines.sort((left, right) => left.timeMs - right.timeMs || left._order - right._order);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!Number.isFinite(line.durationMs)) {
      let nextIndex = index + 1;
      while (nextIndex < lines.length && lines[nextIndex].timeMs <= line.timeMs) {
        nextIndex += 1;
      }

      if (nextIndex < lines.length) {
        line.endTimeMs = lines[nextIndex].timeMs;
        line.durationMs = line.endTimeMs - line.timeMs;
      } else if (Number.isFinite(lastLineDurationMs) && lastLineDurationMs >= 0) {
        line.durationMs = lastLineDurationMs;
        line.endTimeMs = line.timeMs + lastLineDurationMs;
      } else {
        line.durationMs = null;
        line.endTimeMs = null;
      }
    } else {
      line.endTimeMs = line.timeMs + line.durationMs;
    }

    delete line._order;
  }

  return lines;
}

/**
 * Parse ordinary LRC. Multiple timestamps on one line are expanded into
 * independent timeline entries, while a global [offset] is applied to all.
 */
function parseLrc(input, options = {}) {
  const rawLines = splitLines(input);
  const { metadata, offsetMs } = readMetadata(rawLines);
  const lines = [];
  const seen = new Set();
  let order = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || METADATA_RE.test(line)) continue;

    const timestampRe = new RegExp(LRC_TIMESTAMP_SOURCE, 'gu');
    const matches = [...line.matchAll(timestampRe)];
    if (matches.length === 0) continue;

    const text = line.replace(new RegExp(LRC_TIMESTAMP_SOURCE, 'gu'), '').trim();
    if (!text && options.keepEmpty !== true) continue;

    for (const match of matches) {
      const timeMs = adjustTime(timestampMatchToMs(match), offsetMs, options);
      const dedupeKey = `${timeMs}\u0000${text}`;
      if (options.dedupe !== false && seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      lines.push({ timeMs, text, _order: order });
      order += 1;
    }
  }

  sortAndFinalize(lines, options.lastLineDurationMs);
  return { kind: 'lrc', metadata, offsetMs, lines };
}

function parseYrcWords(body, lineStartMs, lineDurationMs, offsetMs, options) {
  const markerRe = new RegExp(YRC_WORD_SOURCE, 'gu');
  const matches = [...body.matchAll(markerRe)];
  if (matches.length === 0) return [];

  const rawWords = [];
  const prefix = body.slice(0, matches[0].index);
  if (prefix) {
    rawWords.push({ rawTimeMs: lineStartMs, durationMs: 0, text: prefix, synthetic: true });
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const textStart = match.index + match[0].length;
    const textEnd = index + 1 < matches.length ? matches[index + 1].index : body.length;
    rawWords.push({
      rawTimeMs: Number(match[1]),
      durationMs: Number(match[2]),
      text: body.slice(textStart, textEnd),
      synthetic: false,
    });
  }

  const timedWords = rawWords.filter((word) => !word.synthetic);
  const firstTimedWord = timedWords[0];
  const allFitInsideLine = timedWords.every(
    (word) => word.rawTimeMs >= 0 && word.rawTimeMs <= lineDurationMs + 1000,
  );
  const autoRelative = Boolean(
    firstTimedWord
      && lineStartMs > 0
      && firstTimedWord.rawTimeMs < lineStartMs - 250
      && allFitInsideLine,
  );
  const relative = options.wordTimeMode === 'relative'
    || (options.wordTimeMode !== 'absolute' && autoRelative);

  return rawWords.map((word) => {
    const rawTimeMs = word.synthetic
      ? lineStartMs
      : word.rawTimeMs + (relative ? lineStartMs : 0);
    const timeMs = adjustTime(rawTimeMs, offsetMs, options);
    return {
      timeMs,
      durationMs: word.durationMs,
      endTimeMs: timeMs + word.durationMs,
      text: word.text,
    };
  });
}

/** Parse NetEase YRC word-timed lyrics without losing per-word timing. */
function parseYrc(input, options = {}) {
  const rawLines = splitLines(input);
  const { metadata, offsetMs } = readMetadata(rawLines);
  const lines = [];
  let order = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line || METADATA_RE.test(line)) continue;

    const match = YRC_LINE_RE.exec(line);
    if (!match) continue;

    const rawStartMs = Number(match[1]);
    const durationMs = Number(match[2]);
    const body = match[3];
    const words = parseYrcWords(body, rawStartMs, durationMs, offsetMs, options);
    const text = (words.length ? words.map((word) => word.text).join('') : body).trim();
    if (!text && options.keepEmpty !== true) continue;

    lines.push({
      timeMs: adjustTime(rawStartMs, offsetMs, options),
      durationMs,
      text,
      words,
      _order: order,
    });
    order += 1;
  }

  sortAndFinalize(lines);
  return { kind: 'yrc', metadata, offsetMs, lines };
}

function extractLines(track) {
  if (Array.isArray(track)) return track;
  if (track && Array.isArray(track.lines)) return track.lines;
  return [];
}

/**
 * Estimate a constant timing shift between two tracks. NetEase YRC and tlyric
 * can describe the same lines with a stable several-hundred-millisecond offset.
 */
function estimateTrackOffset(baseTrack, extraTrack, options = {}) {
  const baseLines = extractLines(baseTrack);
  const extraLines = extractLines(extraTrack);
  const minimumLength = Math.min(baseLines.length, extraLines.length);
  if (minimumLength < 3) return 0;

  const maxOffsetMs = Number.isFinite(options.maxAutoOffsetMs)
    ? Math.max(0, options.maxAutoOffsetMs)
    : 2000;
  const bucketMs = Number.isFinite(options.offsetBucketMs)
    ? Math.max(1, options.offsetBucketMs)
    : 10;
  const buckets = new Map();

  for (const baseLine of baseLines) {
    for (const extraLine of extraLines) {
      const difference = baseLine.timeMs - extraLine.timeMs;
      if (Math.abs(difference) > maxOffsetMs) continue;
      const bucket = Math.round(difference / bucketMs);
      const entry = buckets.get(bucket) || { count: 0, total: 0 };
      entry.count += 1;
      entry.total += difference;
      buckets.set(bucket, entry);
    }
  }

  let best = null;
  for (const entry of buckets.values()) {
    const average = entry.total / entry.count;
    if (!best
      || entry.count > best.count
      || (entry.count === best.count && Math.abs(average) < Math.abs(best.average))) {
      best = { ...entry, average };
    }
  }

  const minimumMatches = Math.max(3, Math.ceil(minimumLength * 0.25));
  return best && best.count >= minimumMatches ? Math.round(best.average) : 0;
}

/** Attach one timed track to base lines, matching each source line at most once. */
function mergeTrack(baseLines, extraTrack, fieldName, options = {}) {
  const toleranceMs = Number.isFinite(options.toleranceMs) ? Math.max(0, options.toleranceMs) : 120;
  const extras = extractLines(extraTrack);
  const trackOffsetMs = Number.isFinite(options.trackOffsetMs)
    ? options.trackOffsetMs
    : (options.autoAlign === false ? 0 : estimateTrackOffset(baseLines, extras, options));
  const used = new Set();

  return extractLines(baseLines).map((baseLine) => {
    let bestIndex = -1;
    let bestDelta = Infinity;

    for (let index = 0; index < extras.length; index += 1) {
      if (used.has(index)) continue;
      const delta = Math.abs(extras[index].timeMs + trackOffsetMs - baseLine.timeMs);
      if (delta <= toleranceMs && delta < bestDelta) {
        bestIndex = index;
        bestDelta = delta;
        if (delta === 0) break;
      }
    }

    const merged = { ...baseLine };
    if (bestIndex >= 0) {
      used.add(bestIndex);
      merged[fieldName] = extras[bestIndex].text;
    }
    return merged;
  });
}

/**
 * Merge translation and romanization into an original parsed track.
 * `tracks` accepts `{ translation, romanization }`, each an array or parse result.
 */
function mergeLyrics(original, tracks = {}, options = {}) {
  let lines = extractLines(original).map((line) => ({ ...line }));
  if (tracks.translation) {
    lines = mergeTrack(lines, tracks.translation, 'translation', options);
  }
  if (tracks.romanization) {
    lines = mergeTrack(lines, tracks.romanization, 'romanization', options);
  }

  return Array.isArray(original) ? lines : { ...original, lines };
}

/** Parse and merge the lrc/tlyric/romalrc/yrc fields returned by NetEase. */
function parseLyricsPayload(payload = {}, options = {}) {
  const lrc = parseLrc(payload.lrc, options);
  const tlyric = parseLrc(payload.tlyric || payload.translation, options);
  const romalrc = parseLrc(payload.romalrc || payload.romanization, options);
  const yrc = parseYrc(payload.yrc, options);
  const preferYrc = options.preferYrc !== false;
  const original = preferYrc && yrc.lines.length > 0 ? yrc : lrc;
  // YRC line starts commonly trail the corresponding ordinary translation by
  // several hundred milliseconds. LRC-to-LRC merging keeps the tighter default.
  const mergeOptions = Number.isFinite(options.toleranceMs)
    ? options
    : { ...options, toleranceMs: original.kind === 'yrc' ? 850 : 120 };
  const merged = mergeLyrics(
    original,
    { translation: tlyric, romanization: romalrc },
    mergeOptions,
  );

  return {
    kind: 'lyrics',
    sourceFormat: original.kind,
    metadata: merged.metadata,
    offsetMs: merged.offsetMs,
    lines: merged.lines,
    hasWordTiming: merged.lines.some((line) => Array.isArray(line.words) && line.words.length > 0),
    instrumental: Boolean(payload.sfy || payload.instrumental),
    noLyrics: Boolean(payload.nolyric || payload.uncollected || merged.lines.length === 0),
    tracks: { lrc, tlyric, romalrc, yrc },
  };
}

/** Return the active line index for a playback position, or -1 before line one. */
function findActiveLineIndex(track, playbackTimeMs, options = {}) {
  const lines = extractLines(track);
  const target = Number(playbackTimeMs) + (Number(options.leadMs) || 0);
  if (lines.length === 0 || !Number.isFinite(target) || target < lines[0].timeMs) return -1;

  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle].timeMs <= target) low = middle + 1;
    else high = middle - 1;
  }
  return high;
}

function findActiveLine(track, playbackTimeMs, options = {}) {
  const lines = extractLines(track);
  const index = findActiveLineIndex(lines, playbackTimeMs, options);
  return index >= 0 ? lines[index] : null;
}

module.exports = {
  estimateTrackOffset,
  findActiveLine,
  findActiveLineIndex,
  mergeLyrics,
  mergeTrack,
  parseLrc,
  parseLyricsPayload,
  parseTimestamp,
  parseYrc,
};
