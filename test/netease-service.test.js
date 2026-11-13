'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  NeteaseApiError,
  NetEaseService,
  NeteaseService,
  normalizeSong,
  scoreSongCandidate,
  scoreSongMatch,
} = require('../src/services/netease-service');

function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    async json() { return payload; },
    ...overrides,
  };
}

test('NetEaseService compatibility export uses the same implementation', () => {
  assert.equal(NetEaseService, NeteaseService);
});

test('normalizeSong accepts both NetEase search response shapes', () => {
  assert.deepEqual(normalizeSong({
    id: 1,
    name: 'Song',
    ar: [{ name: 'Artist' }],
    al: { name: 'Album', picUrl: 'https://img/1.jpg' },
    dt: 123000,
    alia: ['Alias'],
  }), {
    id: '1',
    title: 'Song',
    artists: ['Artist'],
    artist: 'Artist',
    album: 'Album',
    durationMs: 123000,
    aliases: ['Alias'],
    coverUrl: 'https://img/1.jpg',
    raw: {
      id: 1,
      name: 'Song',
      ar: [{ name: 'Artist' }],
      al: { name: 'Album', picUrl: 'https://img/1.jpg' },
      dt: 123000,
      alia: ['Alias'],
    },
  });

  const oldShape = normalizeSong({
    id: 2,
    name: 'Old Song',
    artists: [{ name: 'Old Artist' }],
    album: { name: 'Old Album' },
    duration: 456000,
  });
  assert.equal(oldShape.artist, 'Old Artist');
  assert.equal(oldShape.durationMs, 456000);
});

test('song scoring rewards title, artist and duration agreement', () => {
  const query = { title: '晴天', artist: '周杰伦', durationMs: 269000 };
  const exact = { name: '晴天', ar: [{ name: '周杰伦' }], dt: 269400 };
  const wrongArtist = { name: '晴天', ar: [{ name: '其他歌手' }], dt: 269000 };
  const wrongDuration = { name: '晴天', ar: [{ name: '周杰伦' }], dt: 330000 };

  assert.ok(scoreSongCandidate(exact, query) > scoreSongCandidate(wrongArtist, query));
  assert.ok(scoreSongCandidate(exact, query) > scoreSongCandidate(wrongDuration, query));
  assert.equal(scoreSongMatch(exact, query).durationDifferenceMs, 400);
});

test('searchSongs calls the public API and ranks the best metadata match first', async () => {
  let captured;
  const fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      code: 200,
      result: {
        songs: [
          { id: 10, name: '晴天', artists: [{ name: '其他歌手' }], duration: 269000, album: { name: 'Wrong' } },
          { id: 20, name: '晴天', artists: [{ name: '周杰伦' }], duration: 269350, album: { name: '叶惠美' } },
          { id: 30, name: '晴天 (Live)', artists: [{ name: '周杰伦' }], duration: 310000, album: { name: 'Live' } },
        ],
      },
    });
  };
  const service = new NeteaseService({ fetch });
  const songs = await service.searchSongs({ title: '晴天', artist: '周杰伦', durationMs: 269000 });

  assert.equal(songs[0].id, '20');
  assert.equal(songs[0].scoreBreakdown.title, 1);
  assert.equal(captured.url.hostname, 'music.163.com');
  assert.equal(captured.url.pathname, '/api/search/get/web');
  assert.equal(captured.url.searchParams.get('s'), '晴天 周杰伦');
  assert.equal(captured.url.searchParams.get('type'), '1');
  assert.equal(captured.init.method, 'GET');
  assert.match(captured.init.headers.Referer, /music\.163\.com/u);
});

test('findBestSong rejects an exact title attributed to an unrelated artist', async () => {
  const service = new NeteaseService({
    fetch: async () => jsonResponse({
      code: 200,
      result: {
        songs: [{ id: 10, name: 'Same Title', ar: [{ name: 'Wrong Artist' }], dt: 180000 }],
      },
    }),
  });

  const result = await service.findBestSong({
    title: 'Same Title',
    artist: 'Right Artist',
    durationMs: 180000,
  });
  assert.equal(result, null);
});

test('getLyrics requests and normalizes all standard and word-timed variants', async () => {
  let requestedUrl;
  const service = new NeteaseService({
    fetch: async (url) => {
      requestedUrl = url;
      return jsonResponse({
        code: 200,
        lrc: { version: 1, lyric: '[00:01.000]原文' },
        tlyric: { version: 2, lyric: '[00:01.000]Translation' },
        romalrc: { version: 3, lyric: '[00:01.000]romanization' },
        yrc: { version: 4, lyric: '[1000,500](1000,500,0)原文' },
        ytlrc: { version: 5, lyric: '' },
        yromalrc: { version: 6, lyric: '' },
        sfy: false,
        nolyric: false,
      });
    },
  });

  const result = await service.getLyrics(12345);
  assert.equal(result.songId, '12345');
  assert.equal(result.lrc, '[00:01.000]原文');
  assert.equal(result.tlyric, '[00:01.000]Translation');
  assert.equal(result.romalrc, '[00:01.000]romanization');
  assert.match(result.yrc, /^\[1000,500\]/u);
  assert.deepEqual(result.versions, {
    lrc: 1,
    tlyric: 2,
    romalrc: 3,
    yrc: 4,
    ytlrc: 5,
    yromalrc: 6,
  });
  assert.equal(requestedUrl.pathname, '/api/song/lyric');
  for (const flag of ['lv', 'kv', 'tv', 'rv', 'yv', 'ytv', 'yrv']) {
    assert.equal(requestedUrl.searchParams.get(flag), '-1');
  }
});

test('resolveLyrics performs search, fetch and parsing without real network access', async () => {
  const paths = [];
  const service = new NeteaseService({
    fetch: async (url) => {
      paths.push(url.pathname);
      if (url.pathname.includes('search')) {
        return jsonResponse({
          code: 200,
          result: { songs: [{ id: 42, name: 'Song', ar: [{ name: 'Artist' }], dt: 123000 }] },
        });
      }
      return jsonResponse({
        code: 200,
        lrc: { lyric: '[00:01.000]Line' },
        tlyric: { lyric: '[00:01.000]译文' },
      });
    },
  });

  const result = await service.resolveLyrics({ title: 'Song', artist: 'Artist', durationMs: 123000 });
  assert.deepEqual(paths, ['/api/search/get/web', '/api/song/lyric', '/api/song/detail/']);
  assert.equal(result.song.id, '42');
  assert.equal(result.lyrics.lines[0].text, 'Line');
  assert.equal(result.lyrics.lines[0].translation, '译文');
});

test('getLyricsForTrack accepts duration in seconds, exposes lines, and reuses memory cache', async () => {
  let fetchCount = 0;
  const service = new NetEaseService({
    fetch: async (url) => {
      fetchCount += 1;
      if (url.pathname.includes('search')) {
        return jsonResponse({
          code: 200,
          result: {
            songs: [
              { id: 1, name: 'Song', ar: [{ name: 'Artist' }], dt: 123 },
              { id: 2, name: 'Song', ar: [{ name: 'Artist' }], dt: 123000 },
            ],
          },
        });
      }
      assert.equal(url.searchParams.get('id'), '2');
      return jsonResponse({ code: 200, lrc: { lyric: '[00:01.000]Line' } });
    },
  });

  const track = { title: 'Song', artist: 'Artist', album: 'Album', duration: 123 };
  const first = await service.getLyricsForTrack(track);
  const second = await service.getLyricsForTrack(track);

  assert.equal(first.song.id, '2');
  assert.equal(first.lines, first.lyrics.lines);
  assert.equal(first.lines[0].text, 'Line');
  assert.equal(second.lines[0].text, 'Line');
  assert.equal(fetchCount, 3);
});

test('getLyricsForTrack can reuse optional disk cache across service instances', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'netease-service-test-'));
  const track = { title: 'Cached Song', artist: 'Artist', duration: 60 };
  try {
    const writer = new NetEaseService({
      cacheDir,
      fetch: async (url) => (url.pathname.includes('search')
        ? jsonResponse({
          code: 200,
          result: { songs: [{ id: 7, name: 'Cached Song', ar: [{ name: 'Artist' }], dt: 60000 }] },
        })
        : jsonResponse({ code: 200, lrc: { lyric: '[00:00.500]Cached line' } })),
    });
    await writer.getLyricsForTrack(track);

    const reader = new NetEaseService({
      cacheDir,
      fetch: async () => { throw new Error('network should not be used'); },
    });
    const cached = await reader.getLyricsForTrack(track);
    assert.equal(cached.song.id, '7');
    assert.equal(cached.lines[0].text, 'Cached line');
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test('service wraps HTTP and API failures and validates ids', async () => {
  const httpService = new NeteaseService({
    fetch: async () => jsonResponse({}, { ok: false, status: 503 }),
  });
  await assert.rejects(
    httpService.searchSongs({ title: 'Song' }),
    (error) => error instanceof NeteaseApiError && error.status === 503,
  );

  const apiService = new NeteaseService({
    fetch: async () => jsonResponse({ code: 50000005 }),
  });
  await assert.rejects(
    apiService.searchSongs({ title: 'Song' }),
    (error) => error instanceof NeteaseApiError && error.code === 50000005,
  );

  await assert.rejects(() => apiService.getLyrics('12abc'), /numeric NetEase song id/u);
});

test('missing search artwork is resolved by exact song id, cached, and supports instrumental tracks', async () => {
  let details = 0;
  const service = new NeteaseService({
    fetch: async (url) => {
      if (url.pathname.includes('search')) return jsonResponse({
        code: 200, result: { songs: [{ id: 42, name: 'Song', ar: [{ name: 'Artist' }] }] },
      });
      if (url.pathname.includes('detail')) {
        details += 1;
        assert.equal(url.searchParams.get('ids'), '["42"]');
        return jsonResponse({ code: 200, songs: [
          { id: 99, al: { picUrl: 'https://wrong.jpg' } },
          { id: 42, al: { picUrl: 'http://p1.music.126.net/cover.jpg' } },
        ] });
      }
      return jsonResponse({ code: 200, nolyric: true });
    },
  });
  const track = { title: 'Song', artist: 'Artist' };
  const result = await service.getLyricsForTrack(track);
  assert.equal(result.song.coverUrl, 'https://p1.music.126.net/cover.jpg');
  assert.equal(result.lines.length, 0);
  assert.equal((await service.getLyricsForTrack(track)).song.coverUrl, result.song.coverUrl);
  assert.equal(details, 1);
});

test('artwork API failure does not discard lyrics and existing covers skip detail requests', async () => {
  for (const coverUrl of [null, 'https://p1.music.126.net/existing.jpg']) {
    let details = 0;
    const service = new NeteaseService({ fetch: async (url) => {
      if (url.pathname.includes('search')) return jsonResponse({
        code: 200, result: { songs: [{ id: 42, name: 'Song', coverUrl }] },
      });
      if (url.pathname.includes('detail')) { details += 1; throw new Error('offline'); }
      return jsonResponse({ code: 200, lrc: { lyric: '[00:01]Line' } });
    } });
    const result = await service.resolveLyrics({ title: 'Song' });
    assert.equal(result.lyrics.lines[0].text, 'Line');
    assert.equal(result.song.coverUrl, coverUrl);
    assert.equal(details, coverUrl ? 0 : 1);
  }
});
