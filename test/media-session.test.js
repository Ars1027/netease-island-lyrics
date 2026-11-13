const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MediaSessionProjector,
  isNetEaseSession,
  markTimelineObserved,
  selectSession,
  thumbnailToDataUrl,
} = require('../src/services/media-session');

function session(patch = {}) {
  return {
    sourceAppId: 'cloudmusic.exe',
    media: { title: 'Song', artist: 'Artist', albumTitle: 'Album', thumbnail: null },
    playback: { playbackStatus: 4 },
    timeline: { position: 12, duration: 180 },
    lastUpdatedTime: 100,
    ...patch,
  };
}

test('recognizes common NetEase SMTC source names case-insensitively', () => {
  assert.equal(isNetEaseSession(session({ sourceAppId: 'CloudMusic.exe' })), true);
  assert.equal(isNetEaseSession(session({ sourceAppId: 'orpheus-player' })), true);
  assert.equal(isNetEaseSession(session({ sourceAppId: 'spotify.exe' })), false);
});

test('prefers a playing NetEase session and ignores unrelated media by default', () => {
  const paused = session({ playback: { playbackStatus: 5 }, lastUpdatedTime: 200 });
  const playing = session({ media: { title: 'Playing' }, lastUpdatedTime: 100 });
  const unrelated = session({ sourceAppId: 'browser.exe', lastUpdatedTime: 300 });
  assert.equal(selectSession([paused, playing, unrelated]).media.title, 'Playing');
  assert.equal(selectSession([unrelated]), null);
  assert.equal(selectSession([unrelated], true), unrelated);
});

test('sends artwork only once for the same track', () => {
  const projector = new MediaSessionProjector();
  const withCover = session({ media: { title: 'Song', artist: 'Artist', thumbnail: Buffer.from([0xff, 0xd8, 0xff]) } });
  const first = projector.normalize(withCover);
  const second = projector.normalize({ ...withCover, timeline: { position: 13, duration: 180 } });
  assert.match(first.artwork, /^data:image\/jpeg;base64,/);
  assert.equal(Object.hasOwn(second, 'artwork'), false);
});

test('thumbnail conversion rejects unknown formats', () => {
  assert.equal(thumbnailToDataUrl(Buffer.from('not-an-image')), null);
});

test('delayed and replaced same-track covers arrive without repeated image payloads', () => {
  const projector = new MediaSessionProjector();
  const current = session();
  assert.equal(projector.normalize(current).artwork, null);
  current.media.thumbnail = Buffer.from([0xff, 0xd8, 1]);
  const firstCover = projector.normalize(current).artwork;
  assert.match(firstCover, /^data:image\/jpeg;base64,/);
  assert.equal(Object.hasOwn(projector.normalize(current), 'artwork'), false);
  // Covers can be updated in the same Buffer as well as in a new Buffer.
  current.media.thumbnail[2] = 2;
  assert.notEqual(projector.normalize(current).artwork, firstCover);
  current.media.thumbnail = null;
  assert.equal(Object.hasOwn(projector.normalize(current), 'artwork'), false);
  current.media.title = 'Next song';
  assert.equal(projector.normalize(current).artwork, null);
});

test('reset re-emits the cover when a session reconnects', () => {
  const projector = new MediaSessionProjector();
  const current = session();
  current.media.thumbnail = Buffer.from([0xff, 0xd8, 1]);
  const artwork = projector.normalize(current).artwork;
  projector.reset();
  assert.equal(projector.normalize(current).artwork, artwork);
});

test('timeline events refresh the transport timestamp without another full native query', () => {
  const current = session({ lastUpdatedTime: 100 });
  assert.equal(markTimelineObserved([current], 'cloudmusic.exe', 12_345), true);
  assert.equal(current.lastUpdatedTime, 12_345);
  assert.equal(markTimelineObserved([current], 'missing.exe', 20_000), false);
});
