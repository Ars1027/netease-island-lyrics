(function exposeLyricScheduler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IslandLyricScheduler = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function findActiveLine(lines, positionMs) {
    let low = 0;
    let high = lines.length - 1;
    let answer = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (lines[middle].timeMs <= positionMs) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return answer;
  }

  function nextLyricBoundaryDelay({
    lines,
    positionMs,
    playing,
    hidden,
    maximumDelayMs = 60_000,
  }) {
    if (!playing || hidden || !Array.isArray(lines) || lines.length === 0) return null;
    const activeIndex = findActiveLine(lines, positionMs);
    const nextIndex = Math.max(0, activeIndex + 1);
    if (nextIndex >= lines.length) return null;
    return Math.max(8, Math.min(
      maximumDelayMs,
      Math.ceil(lines[nextIndex].timeMs - positionMs) + 2,
    ));
  }

  return Object.freeze({ findActiveLine, nextLyricBoundaryDelay });
}));
