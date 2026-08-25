(function exposePlaybackClock(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IslandPlaybackClock = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const AUTO_LYRIC_LEAD_MS = 350;
  const SEEK_THRESHOLD_MS = 1200;
  const SMALL_ERROR_BLEND = 0.16;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  class PlaybackClock {
    constructor(options = {}) {
      this.autoLeadMs = Number.isFinite(options.autoLeadMs)
        ? options.autoLeadMs
        : AUTO_LYRIC_LEAD_MS;
      this.seekThresholdMs = Number.isFinite(options.seekThresholdMs)
        ? options.seekThresholdMs
        : SEEK_THRESHOLD_MS;
      this.monotonicNow = options.monotonicNow || (() => performance.now());
      this.wallNow = options.wallNow || (() => Date.now());
      this.reset();
    }

    reset() {
      this.trackKey = null;
      this.positionMs = 0;
      this.anchoredAtMs = this.monotonicNow();
      this.playing = false;
      this.durationMs = 0;
    }

    playbackMs(nowMs = this.monotonicNow()) {
      const elapsed = this.playing ? Math.max(0, nowMs - this.anchoredAtMs) : 0;
      const maximum = this.durationMs > 0 ? this.durationMs : Number.MAX_SAFE_INTEGER;
      return clamp(this.positionMs + elapsed, 0, maximum);
    }

    lyricMs(nowMs = this.monotonicNow(), userOffsetMs = 0) {
      const maximum = this.durationMs > 0 ? this.durationMs : Number.MAX_SAFE_INTEGER;
      return clamp(
        this.playbackMs(nowMs) + this.autoLeadMs - Number(userOffsetMs || 0),
        0,
        maximum,
      );
    }

    anchor(media, receivedMonotonicMs = this.monotonicNow(), receivedWallMs = this.wallNow()) {
      const incomingBaseMs = Math.max(0, Number(media?.position || 0) * 1000);
      const durationMs = Math.max(0, Number(media?.duration || 0) * 1000);
      const playing = Number(media?.playbackStatus) === 4;
      const sameTrack = Boolean(media?.trackKey) && media.trackKey === this.trackKey;
      const predictedMs = this.playbackMs(receivedMonotonicMs);
      const lastUpdatedTime = Number(media?.lastUpdatedTime || 0);
      const observedAt = Number(media?.observedAt || 0);
      let transportAgeMs = 0;

      if (playing && lastUpdatedTime > 0) {
        const timelineAge = receivedWallMs - lastUpdatedTime;
        if (timelineAge >= 0 && timelineAge <= 30_000) transportAgeMs = timelineAge;
      } else if (playing && observedAt > 0) {
        transportAgeMs = clamp(receivedWallMs - observedAt, 0, 500);
      }

      let measuredMs = incomingBaseMs + transportAgeMs;
      const precisionMs = Math.max(1, Number(media?.positionPrecisionMs || 1));

      if (sameTrack && precisionMs >= 1000 && transportAgeMs === 0) {
        const lowerBound = incomingBaseMs - 120;
        const upperBound = incomingBaseMs + precisionMs + 120;
        if (predictedMs >= lowerBound && predictedMs <= upperBound) measuredMs = predictedMs;
      }

      let anchoredPositionMs = measuredMs;
      if (sameTrack) {
        const differenceMs = measuredMs - predictedMs;
        if (Math.abs(differenceMs) <= this.seekThresholdMs) {
          anchoredPositionMs = predictedMs + (differenceMs * SMALL_ERROR_BLEND);
        }
      }

      this.trackKey = media?.trackKey || null;
      this.positionMs = clamp(anchoredPositionMs, 0, durationMs || Number.MAX_SAFE_INTEGER);
      this.anchoredAtMs = receivedMonotonicMs;
      this.playing = playing;
      this.durationMs = durationMs;

      return {
        playbackMs: this.playbackMs(receivedMonotonicMs),
        lyricMs: this.lyricMs(receivedMonotonicMs, 0),
        seeked: sameTrack && Math.abs(measuredMs - predictedMs) > this.seekThresholdMs,
      };
    }
  }

  return {
    AUTO_LYRIC_LEAD_MS,
    PlaybackClock,
    SEEK_THRESHOLD_MS,
  };
}));
