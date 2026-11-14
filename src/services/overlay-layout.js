const ISLAND_SIZES = Object.freeze({
  idle: { width: 304, height: 54 },
  compact: { width: 484, height: 82 },
  expanded: { width: 584, height: 360 },
});
const MASCOT_TOP = 5;
const MASCOT_STAGE_HEIGHT = 58 + MASCOT_TOP;

function resolveVisualMode(mode, hasMedia) {
  return mode === 'expanded' ? 'expanded' : (hasMedia ? 'compact' : 'idle');
}

function stageHeight(mode, hasMascot) {
  return mode === 'compact' && hasMascot ? MASCOT_STAGE_HEIGHT : 0;
}

function windowSize(mode, hasMascot) {
  const size = ISLAND_SIZES[mode] || ISLAND_SIZES.compact;
  return { ...size, height: size.height + stageHeight(mode, hasMascot) };
}

function anchoredBounds(bounds, previousStageHeight, mode, hasMascot) {
  const size = windowSize(mode, hasMascot);
  return {
    ...size,
    x: Math.round(bounds.x + (bounds.width - size.width) / 2),
    y: bounds.y + previousStageHeight - stageHeight(mode, hasMascot),
  };
}

module.exports = { ISLAND_SIZES, MASCOT_TOP, resolveVisualMode, stageHeight, windowSize, anchoredBounds };
