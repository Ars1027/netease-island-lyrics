const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const styles = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'utf8');
const preload = fs.readFileSync(path.join(projectRoot, 'src', 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');

function ruleFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('compact shape hover fades the whole island stage to 35 percent', () => {
  const baseRule = ruleFor('.island-stage');
  assert.match(baseRule, /opacity:\s*1\s*;/);
  assert.match(baseRule, /transition:\s*opacity\s+220ms\s+cubic-bezier\(\.22,\s*\.61,\s*\.36,\s*1\)\s*;/);
  assert.match(baseRule, /will-change:\s*opacity\s*;/);

  const hoverRule = ruleFor('body[data-visual-mode="compact"].is-hovering-island:not(.is-dragging) .island-stage');
  assert.match(hoverRule, /opacity:\s*0\.35\s*;/);
  assert.match(hoverRule, /transition-duration:\s*150ms\s*;/);
});

test('dragging restores full opacity without changing hit testing', () => {
  const dragRule = ruleFor('body.is-dragging .island-stage');
  assert.match(dragRule, /opacity:\s*1\s*;/);
  assert.match(dragRule, /transition-duration:\s*90ms\s*;/);
  assert.doesNotMatch(dragRule, /pointer-events|app-region/);
  assert.match(
    renderer,
    /state\.isDragging\s*=\s*Boolean\(dragging\);\s*elements\.body\.classList\.toggle\('is-dragging',\s*state\.isDragging\);/,
  );
});

test('hover transparency is limited to compact non-dragging mode', () => {
  assert.doesNotMatch(styles, /\.island-stage:hover/);
  assert.doesNotMatch(styles, /data-visual-mode="(?:idle|expanded)"[^\{]*is-hovering-island/);
  assert.match(
    renderer,
    /api\.onHoverState\?\.\(\(hovering\)\s*=>\s*\{\s*elements\.body\.classList\.toggle\('is-hovering-island',\s*Boolean\(hovering\)\);/,
  );
  assert.match(preload, /onHoverState:\s*\(callback\)\s*=>\s*subscribe\('window:hover-state',\s*callback\)/);
  assert.match(main, /screen\.getCursorScreenPoint\(\)[\s\S]*?activeWindowShape/);
  assert.match(main, /send\('window:hover-state',\s*Boolean\(windowHoverMonitor\?\.hovered\)\)/);
  assert.match(styles, /body\s*\{[^}]*-webkit-app-region:\s*drag\s*;/s);

  const reducedMotionRule = ruleFor('*, *::before, *::after');
  assert.match(reducedMotionRule, /transition-duration:\s*1ms\s*!important\s*;/);
});
