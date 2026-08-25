'use strict';

/*
 * Endpoint fields and lyric variants were informed by jitwxs/163MusicLyrics:
 * https://github.com/jitwxs/163MusicLyrics (Apache License 2.0).
 * This module uses NetEase's unencrypted public /api endpoints and contains no
 * copied encryption or application code from that project.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseLyricsPayload } = require('./lyrics-parser');

const DEFAULT_BASE_URL = 'https://music.163.com';
const SEARCH_PATH = '/api/search/get/web';
const LYRIC_PATH = '/api/song/lyric';
const CACHE_VERSION = 1;
const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class NeteaseApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NeteaseApiError';
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    if (details.cause) this.cause = details.cause;
  }
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(number)));
}

function displayText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201B]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .trim();
}

function comparableText(value) {
  return displayText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function tokenizedText(value) {
  return displayText(value)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function stripCommonQualifier(value) {
  const qualifier = /(live|remaster(?:ed)?|version|edit|mix|acoustic|instrumental|karaoke|mono|stereo|现场|伴奏|翻唱|重制|版)/iu;
  return displayText(value)
    .replace(/[\(（\[【][^\)）\]】]*[\)）\]】]/gu, (match) => (qualifier.test(match) ? ' ' : match))
    .replace(/\s+-\s+[^-]+$/u, (match) => (qualifier.test(match) ? ' ' : match))
    .trim();
}

function diceCoefficient(left, right) {
  const leftChars = [...left];
  const rightChars = [...right];
  if (leftChars.length < 2 || rightChars.length < 2) return left === right ? 1 : 0;

  const pairs = new Map();
  for (let index = 0; index < leftChars.length - 1; index += 1) {
    const pair = `${leftChars[index]}\u0000${leftChars[index + 1]}`;
    pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }

  let overlap = 0;
  for (let index = 0; index < rightChars.length - 1; index += 1) {
    const pair = `${rightChars[index]}\u0000${rightChars[index + 1]}`;
    const count = pairs.get(pair) || 0;
    if (count > 0) {
      overlap += 1;
      pairs.set(pair, count - 1);
    }
  }

  return (2 * overlap) / ((leftChars.length - 1) + (rightChars.length - 1));
}

function tokenSimilarity(leftValue, rightValue) {
  const left = new Set(tokenizedText(leftValue));
  const right = new Set(tokenizedText(rightValue));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / new Set([...left, ...right]).size;
}

/** Unicode-aware similarity in the inclusive range 0..1. */
function textSimilarity(leftValue, rightValue) {
  const left = comparableText(leftValue);
  const right = comparableText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;

  const shorterLength = Math.min([...left].length, [...right].length);
  const longerLength = Math.max([...left].length, [...right].length);
  const containment = left.includes(right) || right.includes(left)
    ? 0.82 + 0.14 * (shorterLength / longerLength)
    : 0;
  const characterScore = diceCoefficient(left, right);
  const wordScore = tokenSimilarity(leftValue, rightValue);

  return Math.min(1, Math.max(containment, characterScore, wordScore * 0.96));
}

function titleSimilarity(queryTitle, candidateTitle) {
  const full = textSimilarity(queryTitle, candidateTitle);
  const queryBase = stripCommonQualifier(queryTitle);
  const candidateBase = stripCommonQualifier(candidateTitle);
  const base = textSimilarity(queryBase, candidateBase) * 0.93;
  return Math.max(full, base);
}

function durationSimilarity(queryDurationMs, candidateDurationMs) {
  if (!Number.isFinite(queryDurationMs) || queryDurationMs <= 0) return null;
  if (!Number.isFinite(candidateDurationMs) || candidateDurationMs <= 0) return 0;
  const differenceMs = Math.abs(queryDurationMs - candidateDurationMs);
  if (differenceMs <= 1500) return 1;
  return Math.exp(-(differenceMs - 1500) / 12000);
}

function normalizeArtistList(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
    .map(displayText)
    .filter(Boolean);
}

/** Normalize both old (`artists/album/duration`) and new (`ar/al/dt`) API shapes. */
function normalizeSong(song = {}) {
  const artists = normalizeArtistList(song.artists || song.ar);
  const albumValue = song.album || song.al;
  const album = typeof albumValue === 'string' ? albumValue : displayText(albumValue?.name);
  const aliases = [song.aliases, song.alias, song.alia, song.transNames]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .map(displayText)
    .filter(Boolean);
  const durationMs = Number(song.durationMs ?? song.duration ?? song.dt);
  const coverUrl = song.coverUrl || albumValue?.picUrl || albumValue?.blurPicUrl || null;

  return {
    id: song.id == null ? null : String(song.id),
    title: displayText(song.name ?? song.title),
    artists,
    artist: artists.join(' / '),
    album,
    durationMs: Number.isFinite(durationMs) ? durationMs : null,
    aliases,
    coverUrl,
    raw: song.raw || song,
  };
}

function normalizeTrackQuery(query = {}) {
  const title = displayText(query.title ?? query.name);
  const artistValue = Array.isArray(query.artist ?? query.artists)
    ? (query.artist ?? query.artists).join(' / ')
    : (query.artist ?? query.artists);
  const artist = displayText(artistValue);
  const durationValue = query.durationMs ?? query.duration;
  const durationMs = Number(durationValue);

  return {
    title,
    artist,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
  };
}

function normalizeSecondsTrackQuery(query = {}) {
  const seconds = Number(query.duration);
  const explicitMilliseconds = Number(query.durationMs);
  return {
    ...query,
    durationMs: Number.isFinite(explicitMilliseconds) && explicitMilliseconds > 0
      ? explicitMilliseconds
      : (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null),
  };
}

function trackCacheKey(query = {}) {
  const normalized = normalizeTrackQuery(query);
  return JSON.stringify({
    title: comparableText(normalized.title),
    artist: comparableText(normalized.artist),
    album: comparableText(query.album),
    durationMs: normalized.durationMs ? Math.round(normalized.durationMs / 1000) * 1000 : null,
  });
}

/** Return a score plus individual signals, useful for diagnostics and tests. */
function scoreSongMatch(inputSong, inputQuery) {
  const song = normalizeSong(inputSong);
  const query = normalizeTrackQuery(inputQuery);
  const titleCandidates = [song.title, ...song.aliases];
  const titleScore = titleCandidates.reduce(
    (best, title) => Math.max(best, titleSimilarity(query.title, title)),
    0,
  );

  let artistScore = null;
  if (query.artist) {
    artistScore = [song.artist, ...song.artists].reduce(
      (best, artist) => Math.max(best, textSimilarity(query.artist, artist)),
      0,
    );
  }
  const durationScore = durationSimilarity(query.durationMs, song.durationMs);

  const signals = [
    [titleScore, 0.58],
    [artistScore, 0.27],
    [durationScore, 0.15],
  ].filter(([score]) => score !== null);
  const weightTotal = signals.reduce((total, [, weight]) => total + weight, 0);
  const score = weightTotal > 0
    ? signals.reduce((total, [value, weight]) => total + value * weight, 0) / weightTotal
    : 0;

  return {
    score,
    titleScore,
    artistScore,
    durationScore,
    durationDifferenceMs: query.durationMs && song.durationMs
      ? Math.abs(query.durationMs - song.durationMs)
      : null,
  };
}

function scoreSongCandidate(song, query) {
  return scoreSongMatch(song, query).score;
}

function createRequestContext(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutTriggered = false;
  let timer = null;

  const abortFromExternal = () => controller.abort(externalSignal.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timeoutTriggered = true;
      controller.abort(new Error('Request timed out'));
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => timeoutTriggered,
    cleanup() {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}

function apiLyricPart(value) {
  if (typeof value === 'string') return { lyric: value, version: null };
  return {
    lyric: typeof value?.lyric === 'string' ? value.lyric : '',
    version: Number.isFinite(Number(value?.version)) ? Number(value.version) : null,
  };
}

class NeteaseService {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new TypeError('NeteaseService requires global fetch (Node 18+) or an injected fetch function');
    }

    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
    // Public search ordering can contain many covers; a wider pool lets local
    // title/artist/duration scoring recover the original recording reliably.
    this.searchLimit = clampInteger(options.searchLimit, 1, 100, 100);
    this.minScore = Number.isFinite(options.minScore) ? options.minScore : 0.48;
    this.cacheEnabled = options.cache !== false;
    this.cacheDir = options.cacheDir ? path.resolve(String(options.cacheDir)) : null;
    this.cacheTtlMs = Number.isFinite(options.cacheTtlMs)
      ? Math.max(0, options.cacheTtlMs)
      : DEFAULT_CACHE_TTL_MS;
    this.memoryCacheMax = clampInteger(options.memoryCacheMax, 1, 1000, 100);
    this.memoryCache = new Map();
    this.inflightTracks = new Map();
    this.headers = {
      Accept: 'application/json, text/plain, */*',
      Referer: `${DEFAULT_BASE_URL}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NeteaseIslandLyrics/0.1',
      ...options.headers,
    };
  }

  async requestJson(path, parameters, options = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(parameters || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const context = createRequestContext(options.signal, options.timeoutMs ?? this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'GET',
        headers: this.headers,
        signal: context.signal,
      });

      if (response?.ok === false) {
        throw new NeteaseApiError(`NetEase request failed with HTTP ${response.status}`, {
          status: response.status,
        });
      }

      let data;
      try {
        data = await response.json();
      } catch (cause) {
        throw new NeteaseApiError('NetEase returned an invalid JSON response', { cause });
      }

      const code = Number(data?.code);
      if (Number.isFinite(code) && code !== 200) {
        throw new NeteaseApiError(`NetEase API returned code ${code}`, { code });
      }
      return data;
    } catch (error) {
      if (error instanceof NeteaseApiError) throw error;
      if (context.didTimeout()) {
        throw new NeteaseApiError(`NetEase request timed out after ${options.timeoutMs ?? this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new NeteaseApiError('NetEase request failed', { cause: error });
    } finally {
      context.cleanup();
    }
  }

  /** Search and rank candidates using title, artist and durationMs. */
  async searchSongs(inputQuery, options = {}) {
    const query = normalizeTrackQuery(inputQuery);
    if (!query.title) throw new TypeError('searchSongs requires a non-empty title');

    const limit = clampInteger(options.limit, 1, 100, this.searchLimit);
    const keyword = [query.title, query.artist].filter(Boolean).join(' ');
    const data = await this.requestJson(SEARCH_PATH, {
      s: keyword,
      type: 1,
      offset: 0,
      total: true,
      limit,
      csrf_token: '',
    }, options);
    const rawSongs = data?.result?.songs || data?.songs || [];

    return rawSongs
      .map(normalizeSong)
      .filter((song) => song.id && song.title)
      .map((song) => {
        const match = scoreSongMatch(song, query);
        return {
          ...song,
          score: Number(match.score.toFixed(6)),
          scoreBreakdown: {
            title: match.titleScore,
            artist: match.artistScore,
            duration: match.durationScore,
            durationDifferenceMs: match.durationDifferenceMs,
          },
        };
      })
      .sort((left, right) => (
        right.score - left.score
        || (left.scoreBreakdown.durationDifferenceMs ?? Infinity)
          - (right.scoreBreakdown.durationDifferenceMs ?? Infinity)
      ));
  }

  /** Return the best credible candidate, or null when search results are too weak. */
  async findBestSong(query, options = {}) {
    const candidates = await this.searchSongs(query, options);
    const best = candidates[0];
    if (!best) return null;

    const normalizedQuery = normalizeTrackQuery(query);
    const minScore = Number.isFinite(options.minScore) ? options.minScore : this.minScore;
    const minTitleScore = Number.isFinite(options.minTitleScore) ? options.minTitleScore : 0.45;
    const minArtistScore = Number.isFinite(options.minArtistScore) ? options.minArtistScore : 0.55;
    if (best.score < minScore || best.scoreBreakdown.title < minTitleScore) return null;
    if (normalizedQuery.artist && best.scoreBreakdown.artist < minArtistScore) return null;
    return best;
  }

  /** Fetch all lyric variants exposed by the public lyric endpoint. */
  async getLyrics(songId, options = {}) {
    const id = String(songId ?? '').trim();
    if (!/^\d+$/u.test(id)) throw new TypeError('getLyrics requires a numeric NetEase song id');

    const data = await this.requestJson(LYRIC_PATH, {
      id,
      os: 'pc',
      lv: -1,
      kv: -1,
      tv: -1,
      rv: -1,
      yv: -1,
      ytv: -1,
      yrv: -1,
      csrf_token: '',
    }, options);

    const lrc = apiLyricPart(data.lrc);
    const tlyric = apiLyricPart(data.tlyric);
    const romalrc = apiLyricPart(data.romalrc);
    const yrc = apiLyricPart(data.yrc);
    const ytlrc = apiLyricPart(data.ytlrc);
    const yromalrc = apiLyricPart(data.yromalrc);

    return {
      songId: id,
      lrc: lrc.lyric,
      tlyric: tlyric.lyric,
      romalrc: romalrc.lyric,
      yrc: yrc.lyric,
      ytlrc: ytlrc.lyric,
      yromalrc: yromalrc.lyric,
      versions: {
        lrc: lrc.version,
        tlyric: tlyric.version,
        romalrc: romalrc.version,
        yrc: yrc.version,
        ytlrc: ytlrc.version,
        yromalrc: yromalrc.version,
      },
      instrumental: Boolean(data.sfy),
      noLyrics: Boolean(data.nolyric),
      uncollected: Boolean(data.uncollected),
      raw: data,
    };
  }

  /** Search, choose, fetch and parse in one operation. */
  async resolveLyrics(query, options = {}) {
    const song = await this.findBestSong(query, options);
    if (!song) return null;
    const rawLyrics = await this.getLyrics(song.id, options);
    const lyrics = parseLyricsPayload(rawLyrics, options.parserOptions || {});
    return { song, rawLyrics, lyrics };
  }

  _cacheFile(cacheKey) {
    if (!this.cacheDir) return null;
    const digest = createHash('sha256').update(cacheKey).digest('hex');
    return path.join(this.cacheDir, `${digest}.json`);
  }

  _isFresh(entry) {
    return Boolean(
      entry
      && Number.isFinite(entry.cachedAt)
      && Date.now() - entry.cachedAt <= this.cacheTtlMs
      && Array.isArray(entry.data?.lines),
    );
  }

  _remember(cacheKey, entry) {
    this.memoryCache.delete(cacheKey);
    this.memoryCache.set(cacheKey, entry);
    while (this.memoryCache.size > this.memoryCacheMax) {
      this.memoryCache.delete(this.memoryCache.keys().next().value);
    }
  }

  async _readTrackCache(cacheKey) {
    if (!this.cacheEnabled || this.cacheTtlMs === 0) return null;

    const memoryEntry = this.memoryCache.get(cacheKey);
    if (this._isFresh(memoryEntry)) {
      this._remember(cacheKey, memoryEntry);
      return memoryEntry.data;
    }
    if (memoryEntry) this.memoryCache.delete(cacheKey);

    const cacheFile = this._cacheFile(cacheKey);
    if (!cacheFile) return null;
    try {
      const entry = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (entry.version !== CACHE_VERSION || !this._isFresh(entry)) return null;
      this._remember(cacheKey, entry);
      return entry.data;
    } catch {
      // A missing, stale, or partially written cache must never block lyrics.
      return null;
    }
  }

  async _writeTrackCache(cacheKey, data) {
    if (!this.cacheEnabled || this.cacheTtlMs === 0 || !Array.isArray(data?.lines)) return;
    const entry = { version: CACHE_VERSION, cachedAt: Date.now(), data };
    this._remember(cacheKey, entry);

    const cacheFile = this._cacheFile(cacheKey);
    if (!cacheFile) return;
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify(entry), 'utf8');
    } catch {
      // Disk caching is an optimization; the in-memory result remains usable.
    }
  }

  /**
   * Compatibility entry point used by the desktop media monitor.
   * `track.duration` is seconds; `track.durationMs` remains available for callers
   * that already have milliseconds. Parsed lines are mirrored at the top level.
   */
  async getLyricsForTrack(track, options = {}) {
    const query = normalizeSecondsTrackQuery(track);
    if (!displayText(query.title)) throw new TypeError('getLyricsForTrack requires a non-empty title');
    const cacheKey = trackCacheKey(query);

    if (!options.forceRefresh) {
      const cached = await this._readTrackCache(cacheKey);
      if (cached) return cached;
      const inflight = this.inflightTracks.get(cacheKey);
      if (inflight) return inflight;
    }

    const operation = (async () => {
      const resolved = await this.resolveLyrics(query, options);
      const result = resolved
        ? {
          song: resolved.song,
          lines: resolved.lyrics.lines,
          lyrics: resolved.lyrics,
          rawLyrics: resolved.rawLyrics,
          sourceFormat: resolved.lyrics.sourceFormat,
          hasWordTiming: resolved.lyrics.hasWordTiming,
          instrumental: resolved.lyrics.instrumental,
          noLyrics: resolved.lyrics.noLyrics,
        }
        : {
          song: null,
          lines: [],
          lyrics: null,
          rawLyrics: null,
          sourceFormat: null,
          hasWordTiming: false,
          instrumental: false,
          noLyrics: true,
        };
      if (resolved) await this._writeTrackCache(cacheKey, result);
      return result;
    })();

    if (!options.forceRefresh) this.inflightTracks.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inflightTracks.get(cacheKey) === operation) this.inflightTracks.delete(cacheKey);
    }
  }
}

function createNeteaseService(options) {
  return new NeteaseService(options);
}

const NetEaseService = NeteaseService;

module.exports = {
  DEFAULT_BASE_URL,
  LYRIC_PATH,
  NeteaseApiError,
  NetEaseService,
  NeteaseService,
  SEARCH_PATH,
  createNeteaseService,
  durationSimilarity,
  normalizeSong,
  normalizeSecondsTrackQuery,
  normalizeTrackQuery,
  scoreSongCandidate,
  scoreSongMatch,
  textSimilarity,
};
