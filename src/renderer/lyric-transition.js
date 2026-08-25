(function exposeLyricTransition(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IslandLyricTransition = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ROW_OFFSETS = Object.freeze([-2, -1, 0, 1, 2]);
  const ADJACENT_DURATION_MS = 220;
  const CROSSFADE_DURATION_MS = 140;
  const TRANSITION_EASING = 'cubic-bezier(.22,.61,.36,1)';

  function displaySubline(line, nextLine, settings = {}, fallbackText = '') {
    if (settings.showTranslation && line?.translation) {
      return { kind: 'translation', text: line.translation };
    }
    if (settings.showRomanization && line?.romanization) {
      return { kind: 'romanization', text: line.romanization };
    }
    if (nextLine?.text) return { kind: 'next', text: nextLine.text };
    return { kind: 'fallback', text: fallbackText };
  }

  function displaySecondary(line, settings = {}) {
    if (settings.showTranslation && line?.translation) {
      return { kind: 'translation', text: line.translation };
    }
    if (settings.showRomanization && line?.romanization) {
      return { kind: 'romanization', text: line.romanization };
    }
    return { kind: 'empty', text: '' };
  }

  function buildSnapshot({ lines = [], index = 0, settings = {}, fallbackText = '' } = {}) {
    const safeIndex = Math.max(0, Math.min(lines.length - 1, Number(index) || 0));
    const current = lines[safeIndex] || null;
    const next = lines[safeIndex + 1] || null;
    const subline = displaySubline(current, next, settings, fallbackText);
    const rows = ROW_OFFSETS.map((offset) => {
      const line = lines[safeIndex + offset] || null;
      const secondary = offset === 0 ? displaySecondary(line, settings) : { kind: 'empty', text: '' };
      return {
        offset,
        text: line?.text || '',
        secondaryKind: secondary.kind,
        secondaryText: secondary.text,
        empty: !line,
      };
    });

    return {
      index: safeIndex,
      mainText: current?.text || '…',
      sublineKind: subline.kind,
      sublineText: subline.text,
      rows,
    };
  }

  function sameRows(left, right) {
    if (!left || !right || left.rows.length !== right.rows.length) return false;
    return left.rows.every((row, index) => (
      row.text === right.rows[index].text
      && row.secondaryText === right.rows[index].secondaryText
      && row.secondaryKind === right.rows[index].secondaryKind
    ));
  }

  function getTransitionSpec(previous, next, reason = 'auto') {
    if (!previous || reason === 'initial' || reason === 'clear') {
      return { kind: 'instant', duration: 0, direction: 'none', easing: TRANSITION_EASING };
    }
    if (reason === 'hidden' || reason === 'dragging' || reason === 'reduced-motion') {
      return { kind: 'instant', duration: 0, direction: 'none', easing: TRANSITION_EASING };
    }
    if (previous.index === next.index) {
      if (previous.mainText === next.mainText
        && (previous.sublineText !== next.sublineText || !sameRows(previous, next))) {
        return {
          kind: 'secondary',
          duration: CROSSFADE_DURATION_MS,
          direction: 'none',
          easing: TRANSITION_EASING,
        };
      }
      return { kind: 'instant', duration: 0, direction: 'none', easing: TRANSITION_EASING };
    }

    const distance = next.index - previous.index;
    if (reason === 'track-change' || reason === 'seek' || Math.abs(distance) > 1) {
      return {
        kind: 'crossfade',
        duration: CROSSFADE_DURATION_MS,
        direction: distance < 0 ? 'backward' : 'forward',
        easing: TRANSITION_EASING,
      };
    }
    return {
      kind: 'adjacent',
      duration: ADJACENT_DURATION_MS,
      direction: distance < 0 ? 'backward' : 'forward',
      easing: TRANSITION_EASING,
    };
  }

  class TransitionController {
    constructor(adapter) {
      this.adapter = adapter;
      this.generation = 0;
      this.current = null;
      this.pending = null;
    }

    transitionTo(snapshot, reason = 'auto') {
      const generation = ++this.generation;
      if (this.pending) {
        this.adapter.settle?.(this.pending);
        this.current = this.pending;
        this.pending = null;
      }
      this.adapter.cancel?.();
      const spec = getTransitionSpec(this.current, snapshot, reason);
      if (spec.duration === 0) {
        this.adapter.commit(snapshot, spec);
        this.current = snapshot;
        return Promise.resolve({ committed: true, spec });
      }

      this.pending = snapshot;
      return Promise.resolve(this.adapter.transition(this.current, snapshot, spec))
        .then(() => {
          if (generation !== this.generation) return { committed: false, spec };
          this.adapter.commit(snapshot, spec);
          this.current = snapshot;
          this.pending = null;
          return { committed: true, spec };
        })
        .catch(() => ({ committed: false, spec }));
    }

    cancel({ settle = true } = {}) {
      this.generation += 1;
      this.adapter.cancel?.();
      if (settle && this.pending) {
        this.adapter.settle?.(this.pending);
        this.current = this.pending;
      }
      this.pending = null;
    }

    clear() {
      this.cancel({ settle: false });
      this.current = null;
      this.adapter.clear?.();
    }
  }

  return {
    ADJACENT_DURATION_MS,
    CROSSFADE_DURATION_MS,
    ROW_OFFSETS,
    TRANSITION_EASING,
    TransitionController,
    buildSnapshot,
    displaySubline,
    getTransitionSpec,
  };
}));
