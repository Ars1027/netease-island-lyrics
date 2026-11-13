const api = window.islandAPI;
const { PlaybackClock, AUTO_LYRIC_LEAD_MS } = window.IslandPlaybackClock;
const { nextLyricBoundaryDelay } = window.IslandLyricScheduler;
const {
  ROW_OFFSETS,
  TransitionController,
  buildSnapshot,
} = window.IslandLyricTransition;

const elements = {
  body: document.body,
  island: document.querySelector('#island'),
  mascot: document.querySelector('#mascot'),
  idleMessage: document.querySelector('#idleMessage'),
  idleDemoButton: document.querySelector('#idleDemoButton'),
  compactArtworkButton: document.querySelector('#compactArtworkButton'),
  compactArtwork: document.querySelector('#compactArtwork'),
  compactContent: document.querySelector('#compactContent'),
  compactTitle: document.querySelector('#compactTitle'),
  compactArtist: document.querySelector('#compactArtist'),
  compactLyricLayers: [...document.querySelectorAll('.compact-lyric-layer')],
  compactSublineLayers: [...document.querySelectorAll('.compact-subline-layer')],
  expandButton: document.querySelector('#expandButton'),
  expandedArtwork: document.querySelector('#expandedArtwork'),
  expandedTitle: document.querySelector('#expandedTitle'),
  expandedArtist: document.querySelector('#expandedArtist'),
  expandedAlbum: document.querySelector('#expandedAlbum'),
  playbackLabel: document.querySelector('#playbackLabel'),
  matchLabel: document.querySelector('#matchLabel'),
  demoBadge: document.querySelector('#demoBadge'),
  hideButton: document.querySelector('#hideButton'),
  collapseButton: document.querySelector('#collapseButton'),
  lyricsViewport: document.querySelector('#lyricsViewport'),
  lyricsStacks: [...document.querySelectorAll('.lyrics-stack')],
  placeholderTitle: document.querySelector('#placeholderTitle'),
  placeholderDetail: document.querySelector('#placeholderDetail'),
  currentTime: document.querySelector('#currentTime'),
  durationTime: document.querySelector('#durationTime'),
  timelineFill: document.querySelector('#timelineFill'),
  offsetMinus: document.querySelector('#offsetMinus'),
  offsetValue: document.querySelector('#offsetValue'),
  offsetPlus: document.querySelector('#offsetPlus'),
  translationButton: document.querySelector('#translationButton'),
  romanizationButton: document.querySelector('#romanizationButton'),
  demoButton: document.querySelector('#demoButton'),
  clickThroughButton: document.querySelector('#clickThroughButton'),
  toast: document.querySelector('#toast'),
};

const state = {
  settings: {
    mode: 'compact',
    clickThrough: false,
    showTranslation: true,
    showRomanization: false,
    lyricOffsetMs: 0,
    opacity: 0.94,
  },
  visualMode: 'idle',
  demoEnabled: false,
  media: null,
  artworkUrl: null,
  lyricsStatus: 'idle',
  lyricData: null,
  lines: [],
  playbackClock: new PlaybackClock(),
  lyricStackRows: [],
  transitionController: null,
  currentIndex: -1,
  lastRenderedSettingsKey: '',
  clockSeekPending: false,
  isDragging: false,
  toastTimer: null,
  lyricBoundaryTimer: null,
  mascotAnimation: null,
  coverAnimation: null,
};

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const rounded = Math.floor(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

function normalizeLine(line) {
  const rawWords = Array.isArray(line?.words) ? line.words : [];
  const words = rawWords.map((word) => ({
    text: String(word.text ?? word.content ?? ''),
    startMs: Number(word.startMs ?? word.timeMs ?? word.start ?? 0),
    durationMs: Number(word.durationMs ?? word.duration ?? 0),
  })).filter((word) => word.text);

  return {
    timeMs: Number(line?.timeMs ?? line?.timestampMs ?? line?.time ?? 0),
    text: String(line?.text ?? line?.content ?? '').trim(),
    translation: String(line?.translation ?? line?.translatedText ?? '').trim(),
    romanization: String(line?.romanization ?? line?.transliteration ?? '').trim(),
    words,
  };
}

function normalizeLyricData(data) {
  const rawLines = Array.isArray(data?.lines) ? data.lines : [];
  return rawLines
    .map(normalizeLine)
    .filter((line) => Number.isFinite(line.timeMs) && line.text)
    .sort((left, right) => left.timeMs - right.timeMs);
}

function setVisualMode(mode) {
  state.visualMode = mode || 'idle';
  elements.body.dataset.visualMode = state.visualMode;
  updateTimeline();
  scheduleLyricBoundary();
}

function setArtwork(url) {
  const normalizedUrl = url || null;
  if (normalizedUrl === state.artworkUrl) return false;
  state.artworkUrl = normalizedUrl;
  for (const [container, image] of [
    [elements.compactArtworkButton, elements.compactArtwork],
    [elements.expandedArtwork.parentElement, elements.expandedArtwork],
  ]) {
    if (normalizedUrl) {
      if (image.src !== normalizedUrl) image.src = normalizedUrl;
      container.classList.add('has-image');
    } else {
      image.removeAttribute('src');
      container.classList.remove('has-image');
    }
  }
  return true;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function animateCover(reason) {
  state.coverAnimation?.cancel();
  state.coverAnimation = null;
  if (
    state.visualMode !== 'compact'
    || document.hidden
    || prefersReducedMotion()
    || !elements.compactArtworkButton.classList.contains('has-image')
  ) return;

  const duration = reason === 'track' ? 680 : 420;
  const keyframes = reason === 'track'
    ? [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(360deg)' },
    ]
    : [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(28deg)', offset: 0.58 },
      { transform: 'rotate(0deg)' },
    ];
  state.coverAnimation = elements.compactArtworkButton.animate(keyframes, {
    duration,
    easing: 'cubic-bezier(.22,.61,.36,1)',
  });
}

function animateMascot(reason, isPlaying) {
  state.mascotAnimation?.cancel();
  state.mascotAnimation = null;
  elements.mascot.classList.toggle('is-paused', !isPlaying);
  if (state.visualMode !== 'compact' || document.hidden || prefersReducedMotion()) return;

  const keyframes = reason === 'track'
    ? [
      { transform: 'translate3d(0, 0, 0)' },
      { transform: 'translate3d(0, -5px, 0)', offset: 0.42 },
      { transform: 'translate3d(0, 1px, 0)', offset: 0.76 },
      { transform: 'translate3d(0, 0, 0)' },
    ]
    : (isPlaying
      ? [
        { transform: 'translate3d(0, 2px, 0)' },
        { transform: 'translate3d(0, -4px, 0)', offset: 0.56 },
        { transform: 'translate3d(0, 0, 0)' },
      ]
      : [
        { transform: 'translate3d(0, 0, 0)' },
        { transform: 'translate3d(0, 3px, 0)' },
        { transform: 'translate3d(0, 2px, 0)' },
      ]);
  state.mascotAnimation = elements.mascot.animate(keyframes, {
    duration: reason === 'track' ? 480 : 300,
    easing: 'cubic-bezier(.22,.61,.36,1)',
  });
}

function getSongArtwork(data) {
  return data?.song?.coverUrl
    || data?.song?.picUrl
    || data?.song?.artworkUrl
    || data?.song?.album?.picUrl
    || data?.song?.al?.picUrl
    || null;
}

function projectedPlaybackPositionMs(now = performance.now()) {
  return state.playbackClock.playbackMs(now);
}

function projectedLyricPositionMs(now = performance.now()) {
  return state.playbackClock.lyricMs(now, Number(state.settings.lyricOffsetMs || 0));
}

function anchorClock(media) {
  const result = state.playbackClock.anchor(media, performance.now(), Date.now());
  state.clockSeekPending ||= Boolean(result.seeked);
  return result;
}

function handleMedia(media) {
  if (!media) {
    clearTimeout(state.lyricBoundaryTimer);
    state.lyricBoundaryTimer = null;
    state.playbackClock.reset();
    state.media = null;
    setArtwork(null);
    state.lines = [];
    state.currentIndex = -1;
    clearLyricRows();
    showCompactMessage('正在连接网易云音乐…', '');
    elements.idleMessage.textContent = '等待网易云音乐';
    setVisualMode('idle');
    return;
  }

  const wasPlaying = state.media?.playbackStatus === 4;
  anchorClock(media);
  const trackChanged = media.trackKey !== state.media?.trackKey;
  const hasArtworkUpdate = Object.hasOwn(media, 'artwork');
  const artworkChanged = hasArtworkUpdate ? setArtwork(media.artwork) : false;
  const { artwork: _artwork, ...mediaMetadata } = media;
  state.media = mediaMetadata;

  if (trackChanged) {
    state.lyricData = null;
    state.lines = [];
    state.currentIndex = -1;
    state.lastRenderedSettingsKey = '';
    clearLyricRows();
    showCompactMessage('正在寻找歌词…', `${media.title} · ${media.artist}`);
    setPlaceholder('正在寻找歌词', '根据歌曲、歌手和时长自动匹配');
  }

  const isPlaying = media.playbackStatus === 4;
  elements.body.classList.toggle('is-playing', isPlaying);
  elements.compactTitle.textContent = media.title || '未知歌曲';
  elements.compactArtist.textContent = media.artist ? `· ${media.artist}` : '';
  elements.expandedTitle.textContent = media.title || '未知歌曲';
  elements.expandedArtist.textContent = media.artist || '未知歌手';
  elements.expandedAlbum.textContent = media.album || '';
  elements.playbackLabel.lastChild.textContent = isPlaying ? '正在播放' : '已暂停';
  elements.durationTime.textContent = formatTime(media.duration);
  if (hasArtworkUpdate && !media.artwork) {
    setArtwork(getSongArtwork(state.lyricData));
  }

  if (state.visualMode === 'idle') setVisualMode(state.settings.mode || 'compact');
  if (state.lines.length > 0) renderCurrentLine();
  updateTimeline();
  scheduleLyricBoundary();

  if (trackChanged) {
    animateMascot('track', isPlaying);
    if (artworkChanged) animateCover('track');
  } else if (!wasPlaying && isPlaying) {
    animateMascot('playback', true);
    animateCover('playback');
  } else if (wasPlaying && !isPlaying) {
    animateMascot('playback', false);
  }
}

function setPlaceholder(title, detail, isStatic = false) {
  elements.placeholderTitle.textContent = title;
  elements.placeholderDetail.textContent = detail;
  elements.lyricsViewport.classList.add('is-placeholder');
  elements.lyricsViewport.classList.toggle('is-static', isStatic);
}

function handleLyrics(payload) {
  state.lyricsStatus = payload?.status || 'idle';
  state.lyricData = payload?.data || null;
  state.lines = normalizeLyricData(payload?.data);
  state.currentIndex = -1;
  state.lastRenderedSettingsKey = '';

  if (state.lyricsStatus === 'loading') {
    clearLyricRows();
    showCompactMessage('正在寻找歌词…', '按歌曲、歌手和时长自动匹配');
    elements.matchLabel.textContent = '正在匹配网易云歌词';
    setPlaceholder('正在寻找歌词', '根据歌曲、歌手和时长自动匹配');
    return;
  }

  // Instrumental tracks can have artwork even when they have no lyric lines.
  const artworkChanged = setArtwork(state.artworkUrl || getSongArtwork(payload?.data));
  if (artworkChanged && state.media?.playbackStatus === 4) animateCover('track');

  if (state.lyricsStatus === 'ready' && state.lines.length > 0) {
    elements.matchLabel.textContent = payload.data?.song?.id
      ? `网易云歌词 · #${payload.data.song.id}`
      : '网易云歌词 · 已匹配';
    elements.lyricsViewport.classList.remove('is-placeholder', 'is-static');
    renderCurrentLine(true);
    scheduleLyricBoundary();
    return;
  }

  const isError = state.lyricsStatus === 'error';
  clearLyricRows();
  showCompactMessage(
    isError ? '歌词连接失败' : '这首歌暂时没有歌词',
    isError ? (payload?.message || '请检查网络后切换歌曲重试') : '歌曲信息仍会保持显示',
  );
  elements.matchLabel.textContent = isError ? '歌词服务暂不可用' : '纯音乐或暂无歌词';
  setPlaceholder(
    isError ? '歌词连接失败' : '暂无歌词',
    isError ? '歌曲信息与播放进度仍可正常显示' : '可能是纯音乐，或网易云暂未收录',
    true,
  );
}

function findCurrentLineIndex(positionMs) {
  let low = 0;
  let high = state.lines.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (state.lines[middle].timeMs <= positionMs) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function ensureLyricRows() {
  if (state.lyricStackRows.length > 0) return;
  state.lyricStackRows = elements.lyricsStacks.map((stack) => {
    const rows = [];
    for (const offset of ROW_OFFSETS) {
      const row = document.createElement('div');
      const mainLine = document.createElement('span');
      const secondarySlot = document.createElement('span');
      const secondaryLine = document.createElement('span');
      row.className = `lyric-row distance-${Math.abs(offset)}${offset === 0 ? ' current' : ''}`;
      row.dataset.offset = String(offset);
      mainLine.className = 'main-line';
      secondarySlot.className = 'secondary-slot';
      secondaryLine.className = 'secondary-line is-empty';
      secondarySlot.append(secondaryLine);
      row.append(mainLine, secondarySlot);
      stack.append(row);
      rows.push({ offset, row, mainLine, secondaryLine });
    }
    return rows;
  });
}

function setLayerActive(layers, activeIndex) {
  layers.forEach((layer, index) => {
    const active = index === activeIndex;
    layer.classList.toggle('is-active', active);
    layer.setAttribute('aria-hidden', String(!active));
    layer.getAnimations().forEach((animation) => animation.cancel());
    layer.style.removeProperty('opacity');
    layer.style.removeProperty('transform');
  });
}

function setStackActive(activeIndex) {
  elements.lyricsStacks.forEach((stack, index) => {
    const active = index === activeIndex;
    stack.classList.toggle('is-active', active);
    stack.setAttribute('aria-hidden', String(!active));
    stack.getAnimations().forEach((animation) => animation.cancel());
    stack.style.removeProperty('opacity');
    stack.style.removeProperty('transform');
  });
}

function fillStack(stackIndex, snapshot) {
  ensureLyricRows();
  const rows = state.lyricStackRows[stackIndex];
  rows.forEach((item, rowIndex) => {
    const data = snapshot.rows[rowIndex];
    item.row.className = `lyric-row distance-${Math.abs(item.offset)}${item.offset === 0 ? ' current' : ''}`;
    item.row.classList.toggle('is-empty', data.empty);
    item.mainLine.textContent = data.text;
    item.secondaryLine.textContent = data.secondaryText;
    item.secondaryLine.dataset.kind = data.secondaryKind;
    item.secondaryLine.classList.toggle('is-empty', !data.secondaryText);
  });
}

function createTransitionAdapter() {
  const view = {
    activeMain: 0,
    activeSubline: 0,
    activeStack: 0,
    animations: [],
    target: null,
  };

  function cancelAnimations() {
    for (const animation of view.animations.splice(0)) animation.cancel();
  }

  function activateTarget(target) {
    if (!target) return;
    view.activeMain = target.main;
    view.activeSubline = target.subline;
    view.activeStack = target.stack;
    setLayerActive(elements.compactLyricLayers, view.activeMain);
    setLayerActive(elements.compactSublineLayers, view.activeSubline);
    setStackActive(view.activeStack);
    view.target = null;
    window.__lyricTransitionState = {
      index: target.snapshot.index,
      activeLayers: 1,
      blankFrame: false,
      animationCount: 0,
    };
  }

  function writeSnapshot(snapshot, target) {
    elements.compactLyricLayers[target.main].textContent = snapshot.mainText;
    elements.compactSublineLayers[target.subline].textContent = snapshot.sublineText;
    elements.compactSublineLayers[target.subline].dataset.kind = snapshot.sublineKind;
    fillStack(target.stack, snapshot);
  }

  function animatePair(oldElement, newElement, spec, distance) {
    const animationOptions = {
      duration: spec.duration,
      easing: spec.easing,
      fill: 'both',
    };
    const oldAnimation = oldElement.animate([
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      { opacity: 0, transform: `translate3d(0, ${-distance}px, 0)` },
    ], animationOptions);
    const newAnimation = newElement.animate([
      { opacity: 0, transform: `translate3d(0, ${distance}px, 0)` },
      { opacity: 1, transform: 'translate3d(0, 0, 0)' },
    ], animationOptions);
    view.animations.push(oldAnimation, newAnimation);
  }

  return {
    cancel: cancelAnimations,
    clear() {
      cancelAnimations();
      view.target = null;
      view.activeMain = 0;
      view.activeSubline = 0;
      view.activeStack = 0;
      for (const layer of [...elements.compactLyricLayers, ...elements.compactSublineLayers]) {
        layer.textContent = '';
      }
      ensureLyricRows();
      for (const rows of state.lyricStackRows) {
        for (const item of rows) {
          item.row.classList.add('is-empty');
          item.mainLine.textContent = '';
          item.secondaryLine.textContent = '';
          item.secondaryLine.classList.add('is-empty');
        }
      }
      setLayerActive(elements.compactLyricLayers, 0);
      setLayerActive(elements.compactSublineLayers, 0);
      setStackActive(0);
    },
    settle(snapshot) {
      if (view.target?.snapshot === snapshot) activateTarget(view.target);
    },
    commit(snapshot) {
      if (view.target?.snapshot === snapshot) {
        activateTarget(view.target);
        return;
      }
      const target = {
        main: view.activeMain,
        subline: view.activeSubline,
        stack: view.activeStack,
        snapshot,
      };
      writeSnapshot(snapshot, target);
      activateTarget(target);
    },
    transition(_previous, snapshot, spec) {
      cancelAnimations();
      const nextMain = spec.kind === 'secondary' ? view.activeMain : 1 - view.activeMain;
      const nextSubline = 1 - view.activeSubline;
      const nextStack = 1 - view.activeStack;
      const target = {
        main: nextMain,
        subline: nextSubline,
        stack: nextStack,
        snapshot,
      };
      writeSnapshot(snapshot, target);
      view.target = target;

      const directionSign = spec.direction === 'backward' ? -1 : 1;
      const distance = spec.kind === 'adjacent' ? 8 * directionSign : 0;
      if (spec.kind !== 'secondary') {
        animatePair(
          elements.compactLyricLayers[view.activeMain],
          elements.compactLyricLayers[nextMain],
          spec,
          distance,
        );
      }
      animatePair(
        elements.compactSublineLayers[view.activeSubline],
        elements.compactSublineLayers[nextSubline],
        spec,
        spec.kind === 'adjacent' ? distance : 0,
      );
      animatePair(
        elements.lyricsStacks[view.activeStack],
        elements.lyricsStacks[nextStack],
        spec,
        distance,
      );
      window.__lyricTransitionState = {
        index: snapshot.index,
        activeLayers: 2,
        blankFrame: false,
        animationCount: view.animations.length,
      };
      return Promise.all(view.animations.map((animation) => animation.finished));
    },
  };
}

function clearLyricRows() {
  state.transitionController?.clear();
}

function showCompactMessage(mainText, sublineText) {
  state.transitionController?.clear();
  elements.compactLyricLayers[0].textContent = mainText;
  elements.compactSublineLayers[0].textContent = sublineText;
  setLayerActive(elements.compactLyricLayers, 0);
  setLayerActive(elements.compactSublineLayers, 0);
}

function settingsRenderKey() {
  return `${state.settings.showTranslation}|${state.settings.showRomanization}`;
}

function renderCurrentLine(force = false) {
  if (state.lines.length === 0) return;
  const position = projectedLyricPositionMs();
  const nextIndex = Math.max(0, findCurrentLineIndex(position));
  const renderKey = settingsRenderKey();
  if (!force && nextIndex === state.currentIndex && renderKey === state.lastRenderedSettingsKey) return;

  const previousIndex = state.currentIndex;
  state.currentIndex = nextIndex;
  state.lastRenderedSettingsKey = renderKey;
  const fallbackText = [state.media?.title, state.media?.artist].filter(Boolean).join(' · ');
  const snapshot = buildSnapshot({
    lines: state.lines,
    index: nextIndex,
    settings: state.settings,
    fallbackText,
  });
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let reason = 'auto';
  if (previousIndex < 0) reason = 'initial';
  else if (document.hidden) reason = 'hidden';
  else if (state.isDragging) reason = 'dragging';
  else if (reducedMotion) reason = 'reduced-motion';
  else if (state.clockSeekPending) reason = 'seek';
  state.clockSeekPending = false;
  state.transitionController.transitionTo(snapshot, reason);
}

function sampleTransitionFrame(elapsedMs) {
  function visibleTextOpacity(layers) {
    return layers.reduce((total, layer) => {
      if (!layer.textContent.trim()) return total;
      return total + Number.parseFloat(getComputedStyle(layer).opacity || '0');
    }, 0);
  }

  const compactMainOpacity = visibleTextOpacity(elements.compactLyricLayers);
  const compactSublineOpacity = visibleTextOpacity(elements.compactSublineLayers);
  const expandedOpacity = elements.lyricsStacks.reduce((total, stack, index) => {
    const current = state.lyricStackRows[index]?.find((row) => row.offset === 0);
    if (!current?.mainLine.textContent.trim()) return total;
    return total + Number.parseFloat(getComputedStyle(stack).opacity || '0');
  }, 0);
  return {
    elapsedMs,
    compactMainOpacity,
    compactSublineOpacity,
    expandedOpacity,
    blank: compactMainOpacity < 0.55 || expandedOpacity < 0.55,
  };
}

async function runTransitionProbe() {
  if (state.lines.length < 2 || state.currentIndex < 0) {
    return { ready: false, samples: [], blankFrame: null };
  }
  state.transitionController.cancel({ settle: true });
  const targetIndex = state.currentIndex < state.lines.length - 1
    ? state.currentIndex + 1
    : state.currentIndex - 1;
  const snapshot = buildSnapshot({
    lines: state.lines,
    index: targetIndex,
    settings: state.settings,
    fallbackText: [state.media?.title, state.media?.artist].filter(Boolean).join(' · '),
  });
  state.currentIndex = targetIndex;
  const transition = state.transitionController.transitionTo(snapshot, 'auto');
  const samples = [];
  let elapsed = 0;
  for (const targetElapsed of [0, 50, 110, 220]) {
    const waitMs = targetElapsed - elapsed;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    elapsed = targetElapsed;
    samples.push(sampleTransitionFrame(targetElapsed));
  }
  await transition;
  return {
    ready: true,
    samples,
    blankFrame: samples.some((sample) => sample.blank),
    finalState: window.__lyricTransitionState,
  };
}

function updateTimeline(now = performance.now()) {
  if (state.visualMode !== 'expanded') return;
  const positionSeconds = projectedPlaybackPositionMs(now) / 1000;
  const duration = Number(state.media?.duration || 0);
  elements.currentTime.textContent = formatTime(positionSeconds);
  elements.timelineFill.style.width = `${duration > 0 ? clamp(positionSeconds / duration, 0, 1) * 100 : 0}%`;
}

function scheduleLyricBoundary() {
  clearTimeout(state.lyricBoundaryTimer);
  state.lyricBoundaryTimer = null;
  if (document.hidden || !state.playbackClock.playing || state.lines.length === 0) return;

  const lyricPositionMs = projectedLyricPositionMs();
  const delay = nextLyricBoundaryDelay({
    lines: state.lines,
    positionMs: lyricPositionMs,
    playing: state.playbackClock.playing,
    hidden: document.hidden,
  });
  if (delay === null) return;
  state.lyricBoundaryTimer = setTimeout(() => {
    state.lyricBoundaryTimer = null;
    renderCurrentLine();
    scheduleLyricBoundary();
  }, delay);
}

function measureFrameRate(durationMs = 1200) {
  const safeDuration = clamp(Number(durationMs) || 1200, 250, 5000);
  return new Promise((resolve) => {
    const intervals = [];
    let startedAt = 0;
    let previousFrameAt = 0;
    function sample(now) {
      if (startedAt === 0) startedAt = now;
      if (previousFrameAt > 0) {
        const interval = now - previousFrameAt;
        if (interval > 0 && interval < 100) intervals.push(interval);
      }
      previousFrameAt = now;
      if (now - startedAt < safeDuration) {
        requestAnimationFrame(sample);
        return;
      }
      const sorted = [...intervals].sort((left, right) => left - right);
      const medianInterval = sorted[Math.floor(sorted.length / 2)] || 0;
      window.__islandMetrics = {
        medianFps: medianInterval > 0 ? Math.round((1000 / medianInterval) * 10) / 10 : 0,
        samples: intervals.length,
        autoLeadMs: AUTO_LYRIC_LEAD_MS,
      };
      resolve(window.__islandMetrics);
    }
    requestAnimationFrame(sample);
  });
}

window.__islandDiagnostics = Object.freeze({ measureFrameRate, runTransitionProbe });

function updateSettings(settings) {
  state.settings = { ...state.settings, ...settings };
  state.demoEnabled = Boolean(settings.demoEnabled ?? state.demoEnabled);
  if (settings.visualMode) setVisualMode(settings.visualMode);
  elements.body.classList.toggle('is-demo', state.demoEnabled);
  elements.island.style.setProperty('--island-opacity', String(state.settings.opacity || 0.94));
  elements.translationButton.setAttribute('aria-pressed', String(Boolean(state.settings.showTranslation)));
  elements.romanizationButton.setAttribute('aria-pressed', String(Boolean(state.settings.showRomanization)));
  elements.demoButton.setAttribute('aria-pressed', String(state.demoEnabled));

  const offsetSeconds = Number(state.settings.lyricOffsetMs || 0) / 1000;
  const sign = offsetSeconds > 0 ? '+' : '';
  elements.offsetValue.textContent = `歌词 ${sign}${offsetSeconds.toFixed(1)}s`;
  renderCurrentLine(true);
  scheduleLyricBoundary();
}

function showToast(message) {
  if (!message) return;
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2600);
}

function changeOffset(delta) {
  const lyricOffsetMs = clamp(Number(state.settings.lyricOffsetMs || 0) + delta, -5000, 5000);
  updateSettings({ lyricOffsetMs });
  api.updateSettings({ lyricOffsetMs });
}

function bindInteractions() {
  elements.expandButton.addEventListener('click', () => api.setMode('expanded'));
  elements.collapseButton.addEventListener('click', () => api.setMode('compact'));
  elements.hideButton.addEventListener('click', () => api.hide());
  elements.idleDemoButton.addEventListener('click', () => api.toggleDemo());
  elements.demoButton.addEventListener('click', () => api.toggleDemo());
  elements.translationButton.addEventListener('click', () => {
    const showTranslation = !state.settings.showTranslation;
    updateSettings({ showTranslation });
    api.updateSettings({ showTranslation });
  });
  elements.romanizationButton.addEventListener('click', () => {
    const showRomanization = !state.settings.showRomanization;
    updateSettings({ showRomanization });
    api.updateSettings({ showRomanization });
  });
  elements.offsetMinus.addEventListener('click', (event) => changeOffset(event.shiftKey ? -500 : -100));
  elements.offsetPlus.addEventListener('click', (event) => changeOffset(event.shiftKey ? 500 : 100));
  elements.offsetValue.addEventListener('click', () => {
    updateSettings({ lyricOffsetMs: 0 });
    api.updateSettings({ lyricOffsetMs: 0 });
  });
  elements.clickThroughButton.addEventListener('click', () => api.setClickThrough(true));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.visualMode === 'expanded') api.setMode('compact');
  });
}

function initialize() {
  ensureLyricRows();
  state.transitionController = new TransitionController(createTransitionAdapter());
  window.__islandMetrics = { medianFps: 0, samples: 0, autoLeadMs: AUTO_LYRIC_LEAD_MS };
  window.__lyricTransitionState = {
    index: -1,
    activeLayers: 1,
    blankFrame: false,
    animationCount: 0,
  };
  bindInteractions();
  api.onInit((payload) => {
    state.demoEnabled = Boolean(payload.demoEnabled);
    updateSettings({ ...payload.settings, visualMode: payload.visualMode, demoEnabled: payload.demoEnabled });
    handleMedia(payload.media);
    handleLyrics(payload.lyrics);
  });
  api.onMedia(handleMedia);
  api.onLyrics(handleLyrics);
  api.onSettings(updateSettings);
  api.onToast(showToast);
  api.onDragState?.((dragging) => {
    state.isDragging = Boolean(dragging);
    elements.body.classList.toggle('is-dragging', state.isDragging);
    if (!state.isDragging && state.lines.length > 0) {
      renderCurrentLine(true);
      scheduleLyricBoundary();
    }
  });
  api.onHoverState?.((hovering) => {
    elements.body.classList.toggle('is-hovering-island', Boolean(hovering));
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.lines.length > 0) renderCurrentLine(true);
    scheduleLyricBoundary();
  });
  api.ready();
}

initialize();
