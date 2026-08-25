const { parentPort, workerData } = require('node:worker_threads');
const {
  MediaSessionProjector,
  markTimelineObserved,
  selectSession,
} = require('./media-session');

const PLAYING_EVENT_INTERVAL_MS = 250;
const PAUSED_EVENT_INTERVAL_MS = 750;
const MONITOR_RETRY_MS = 30_000;
const MONITOR_EVENTS = Object.freeze([
  'session-media-changed',
  'session-timeline-changed',
  'session-playback-changed',
  'session-added',
  'session-removed',
  'current-session-changed',
]);

let acceptAnyMedia = Boolean(workerData?.acceptAnyMedia);
let monitor = null;
let publishTimer = null;
let retryTimer = null;
let lastPublishedAt = 0;
let previousEmpty = false;
let stopped = false;
const projector = new MediaSessionProjector();

function postError(error) {
  parentPort.postMessage({
    type: 'source-error',
    payload: error instanceof Error ? error.message : String(error),
  });
}

function currentSession() {
  return selectSession(monitor?.sessions || [], acceptAnyMedia);
}

function publish() {
  clearTimeout(publishTimer);
  publishTimer = null;
  if (stopped || !monitor) return;

  try {
    const session = currentSession();
    if (!session) {
      projector.reset();
      if (!previousEmpty) {
        parentPort.postMessage({ type: 'media-state', payload: null });
        previousEmpty = true;
      }
      lastPublishedAt = Date.now();
      return;
    }

    previousEmpty = false;
    lastPublishedAt = Date.now();
    parentPort.postMessage({ type: 'media-state', payload: projector.normalize(session) });
  } catch (error) {
    postError(error);
  }
}

function schedulePublish(immediate = false) {
  if (stopped || !monitor) return;
  const session = currentSession();
  const minimumInterval = session?.playback?.playbackStatus === 4
    ? PLAYING_EVENT_INTERVAL_MS
    : PAUSED_EVENT_INTERVAL_MS;
  const elapsed = Date.now() - lastPublishedAt;
  const delay = immediate ? 0 : Math.max(0, minimumInterval - elapsed);

  if (publishTimer) {
    if (!immediate) return;
    clearTimeout(publishTimer);
  }
  publishTimer = setTimeout(publish, delay);
  publishTimer.unref?.();
}

function destroyMonitor() {
  clearTimeout(publishTimer);
  publishTimer = null;
  if (!monitor) return;
  for (const eventName of MONITOR_EVENTS) monitor.removeAllListeners(eventName);
  monitor.destroy();
  monitor = null;
}

function startMonitor() {
  if (stopped) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  destroyMonitor();
  try {
    const { SMTCMonitor } = require('@coooookies/windows-smtc-monitor');
    monitor = new SMTCMonitor();
    for (const eventName of MONITOR_EVENTS) {
      monitor.on(eventName, (sourceAppId) => {
        if (eventName === 'session-timeline-changed') {
          markTimelineObserved(monitor.sessions, sourceAppId);
        }
        schedulePublish(eventName !== 'session-timeline-changed');
      });
    }
    publish();
  } catch (error) {
    postError(error);
    retryTimer = setTimeout(startMonitor, MONITOR_RETRY_MS);
    retryTimer.unref?.();
  }
}

function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(retryTimer);
  retryTimer = null;
  destroyMonitor();
  parentPort.close();
}

parentPort.on('message', (message) => {
  if (message?.type === 'settings') {
    acceptAnyMedia = Boolean(message.acceptAnyMedia);
    previousEmpty = false;
    projector.reset();
    schedulePublish(true);
  }
  if (message?.type === 'stop') stop();
});

startMonitor();
