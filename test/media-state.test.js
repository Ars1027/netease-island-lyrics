const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mediaForInitialization,
  updateMediaState,
} = require('../src/services/media-state');

function media(patch = {}) {
  return {
    trackKey: 'cloudmusic|song-a',
    title: 'Song A',
    position: 12,
    ...patch,
  };
}

test('ordinary timeline updates omit artwork and retain the cached value', () => {
  const previous = media({ position: 11 });
  const result = updateMediaState(previous, 'data:image/png;base64,large', media());
  assert.equal(result.artworkChanged, false);
  assert.equal(result.artwork, 'data:image/png;base64,large');
  assert.equal(Object.hasOwn(result.latestMedia, 'artwork'), false);
  assert.equal(Object.hasOwn(result.rendererPayload, 'artwork'), false);
});

test('track artwork is sent once and null explicitly clears it', () => {
  const changed = updateMediaState(
    media(),
    'old-art',
    media({ trackKey: 'cloudmusic|song-b', artwork: 'new-art' }),
  );
  assert.equal(changed.trackChanged, true);
  assert.equal(changed.rendererPayload.artwork, 'new-art');

  const cleared = updateMediaState(changed.latestMedia, changed.artwork, media({
    trackKey: 'cloudmusic|song-c',
    artwork: null,
  }));
  assert.equal(cleared.artwork, null);
  assert.equal(cleared.rendererPayload.artwork, null);
});

test('renderer initialization receives the cached artwork exactly once', () => {
  const initialized = mediaForInitialization(media(), 'cached-art');
  assert.equal(initialized.artwork, 'cached-art');
});

test('ten minutes of 250ms updates transmit a large artwork only once', () => {
  const artwork = `data:image/png;base64,${'x'.repeat(1_177_160)}`;
  let latestMedia = null;
  let latestArtwork = null;
  let artworkPayloads = 0;
  let transmittedBytes = 0;

  for (let index = 0; index < 2400; index += 1) {
    const incoming = media({
      position: index / 4,
      ...(index === 0 ? { artwork } : {}),
    });
    const update = updateMediaState(latestMedia, latestArtwork, incoming);
    latestMedia = update.latestMedia;
    latestArtwork = update.artwork;
    if (Object.hasOwn(update.rendererPayload, 'artwork')) artworkPayloads += 1;
    transmittedBytes += Buffer.byteLength(JSON.stringify(update.rendererPayload));
  }

  assert.equal(artworkPayloads, 1);
  assert.equal(latestArtwork, artwork);
  assert.ok(transmittedBytes < 2_000_000);
});
