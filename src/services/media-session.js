const NETEASE_SOURCE_HINTS = Object.freeze([
  'cloudmusic',
  'netease',
  'orpheus',
  '163music',
]);

function isNetEaseSession(session) {
  const source = String(session?.sourceAppId || '').toLowerCase();
  return NETEASE_SOURCE_HINTS.some((hint) => source.includes(hint));
}

function selectSession(sessions = [], acceptAnyMedia = false) {
  const candidates = sessions.filter((session) => session?.media?.title);
  const netEaseSessions = candidates.filter(isNetEaseSession);
  const pool = netEaseSessions.length > 0
    ? netEaseSessions
    : (acceptAnyMedia ? candidates : []);

  return pool.sort((left, right) => {
    const leftPlaying = left.playback?.playbackStatus === 4 ? 1 : 0;
    const rightPlaying = right.playback?.playbackStatus === 4 ? 1 : 0;
    if (leftPlaying !== rightPlaying) return rightPlaying - leftPlaying;
    return Number(right.lastUpdatedTime || 0) - Number(left.lastUpdatedTime || 0);
  })[0] || null;
}

function thumbnailToDataUrl(thumbnail) {
  if (!thumbnail) return null;

  const buffer = Buffer.isBuffer(thumbnail) ? thumbnail : Buffer.from(thumbnail);
  if (buffer.length === 0) return null;

  let mimeType = null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) mimeType = 'image/jpeg';
  else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mimeType = 'image/png';
  else if (buffer.subarray(0, 3).toString('ascii') === 'GIF') mimeType = 'image/gif';
  else if (buffer.subarray(0, 2).toString('ascii') === 'BM') mimeType = 'image/bmp';
  else if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
  if (!mimeType) return null;
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

function markTimelineObserved(sessions, sourceAppId, observedAt = Date.now()) {
  const session = sessions.find((candidate) => candidate?.sourceAppId === sourceAppId);
  if (!session) return false;
  session.lastUpdatedTime = Number(observedAt) || Date.now();
  return true;
}

class MediaSessionProjector {
  constructor() {
    this.previousTrackKey = '';
  }

  reset() {
    this.previousTrackKey = '';
  }

  normalize(session) {
    const title = String(session?.media?.title || '').trim();
    const artist = String(session?.media?.artist || session?.media?.albumArtist || '').trim();
    const album = String(session?.media?.albumTitle || '').trim();
    const duration = Number(session?.timeline?.duration || 0);
    const trackKey = [session?.sourceAppId, title, artist, Math.round(duration)].join('|');
    const trackChanged = trackKey !== this.previousTrackKey;
    this.previousTrackKey = trackKey;

    const position = Number(session?.timeline?.position || 0);
    const normalized = {
      sourceAppId: String(session?.sourceAppId || ''),
      isNetEase: isNetEaseSession(session),
      title,
      artist,
      album,
      position,
      duration,
      playbackStatus: Number(session?.playback?.playbackStatus ?? 0),
      observedAt: Date.now(),
      lastUpdatedTime: Number(session?.lastUpdatedTime || 0),
      positionPrecisionMs: Number.isInteger(position) ? 1000 : 1,
      trackKey,
    };
    if (trackChanged) normalized.artwork = thumbnailToDataUrl(session?.media?.thumbnail);
    return normalized;
  }
}

module.exports = {
  MediaSessionProjector,
  NETEASE_SOURCE_HINTS,
  isNetEaseSession,
  markTimelineObserved,
  selectSession,
  thumbnailToDataUrl,
};
