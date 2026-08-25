const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');

const sessions = SMTCMonitor.getMediaSessions();
const summary = sessions.map((session) => ({
  sourceAppId: session.sourceAppId,
  title: session.media?.title,
  artist: session.media?.artist,
  albumTitle: session.media?.albumTitle,
  status: session.playback?.playbackStatus,
  position: session.timeline?.position,
  duration: session.timeline?.duration,
  hasThumbnail: Buffer.isBuffer(session.media?.thumbnail),
}));

console.log(JSON.stringify(summary, null, 2));
