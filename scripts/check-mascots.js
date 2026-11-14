// Run with electron scripts/check-mascots.js. Uses isolated settings and fake
// media events; it never changes the user's player, startup items or presets.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app, BrowserWindow, dialog, nativeImage } = require('electron');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'island-mascot-verify-'));
app.setPath('userData', directory);
const rootArgument = process.argv.find(arg => arg.startsWith('--app-root='));
const root = rootArgument ? path.resolve(rootArgument.slice('--app-root='.length)) : path.join(__dirname, '..');
const scenario = process.argv.find(arg => arg.startsWith('--scenario='))?.slice('--scenario='.length);
const artworkFixture = process.argv.find(arg => arg.startsWith('--artwork-fixture='))?.slice('--artwork-fixture='.length);
if (scenario) {
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
    settingsVersion: scenario === 'legacy' ? 4 : 5,
    ...(scenario === 'legacy' ? {} : { mascotId: scenario === 'missing' ? `custom-${'a'.repeat(32)}` : 'yuki-black' }),
    mode: scenario === 'restart' ? 'expanded' : 'compact',
    position: { x: 600, y: 200 }, positionWidth: scenario === 'restart' ? 584 : 484,
    autoShowWithNetease: false, launchAtLogin: false, topmostMode: 'off',
  }));
}
const mediaWorkers = [];
require('node:worker_threads').Worker = class extends EventEmitter {
  constructor() { super(); mediaWorkers.push(this); }
  postMessage(message) { if (message.type === 'stop') this.emit('exit', 0); }
  terminate() { return Promise.resolve(0); }
};
require(path.join(root, 'src/services/netease-service')).NetEaseService = class {
  async getLyricsForTrack() { return { lines: [], song: { id: 1 } }; }
};
const dialogResults = [];
dialog.showOpenDialog = async () => dialogResults.shift() || { canceled: true, filePaths: [] };
const errors = [];
require(path.join(root, 'src/main.js'));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

app.whenReady().then(async () => {
  try {
    let window;
    for (let attempt = 0; attempt < 100; attempt++) {
      window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoading()) break;
      await wait(50);
    }
    window.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') errors.push(details.message);
    });
    const run = code => window.webContents.executeJavaScript(code, true);
    let lastShape = [];
    const setShape = window.setShape.bind(window);
    window.setShape = shape => { lastShape = shape; setShape(shape); };
    const verifyStaticShape = (id, offset = 0) => {
      const { MascotStore } = require(path.join(root, 'src/services/mascot-store'));
      const store = new MascotStore({ userDataPath: directory, assetsPath: path.join(root, 'assets'), nativeImage });
      const expected = store.getShape(id).map(rect => ({ ...rect,
        x: rect.x + Math.round((window.getBounds().width - 96) / 2), y: rect.y + 5 + offset,
      })).filter(rect => rect.y < 63);
      assert.deepEqual(lastShape.filter(rect => rect.y < 63), expected, 'resting hit shape matches sprite alpha');
    };
    const click = async id => { await run(`document.getElementById(${JSON.stringify(id)}).click()`); await wait(300); };
    const snapshot = () => run(`({
      mode: document.body.dataset.visualMode,
      empty: document.body.classList.contains('is-empty-media'),
      title: document.querySelector('#expandedTitle').textContent,
      time: document.querySelector('#currentTime').textContent,
      panelOpen: !document.querySelector('#mascotPanel').hidden,
      height: Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--mascot-stage-height')),
      mascotHidden: document.querySelector('#mascot').hidden
    })`);
    await wait(600);
    if (scenario) {
      const catalog = await run('window.islandAPI.getMascots()');
      assert.equal(catalog.selectedId, scenario === 'legacy' ? 'hotaru' : scenario === 'missing' ? 'none' : 'yuki-black');
      assert.equal((await snapshot()).mode, scenario === 'restart' ? 'expanded' : 'idle');
      assert.equal(window.getBounds().y, 200);
      assert.equal(window.getBounds().x, scenario === 'restart' ? 600 : 690);
      console.log(JSON.stringify({ passed: true, scenario, packagedResources: Boolean(rootArgument) }));
      app.exit(0);
      return;
    }
    assert.equal((await snapshot()).mode, 'idle');
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'))).mascotId, 'none');
    await click('idleExpandButton');
    assert.equal((await snapshot()).mode, 'expanded');
    assert.equal((await snapshot()).time, '--:--');
    assert.equal((await snapshot()).title, '云岛歌词');
    await wait(2200);
    assert.equal((await snapshot()).mode, 'expanded');
    assert(window.isVisible());
    const screenshots = path.resolve('.cache/mascot-verification');
    fs.mkdirSync(screenshots, { recursive: true });
    const capture = async name => fs.writeFileSync(path.join(screenshots, name), (await window.capturePage()).toPNG());
    await capture('empty-expanded.png');
    await click('emptyMascotButton');
    assert((await snapshot()).panelOpen);
    const catalog = await run('window.islandAPI.getMascots()');
    assert.deepEqual(catalog.items.map(item => item.id), ['none', 'hotaru', 'yuki-school', 'yuki-black']);
    for (const item of catalog.items.slice(1)) assert(item.image?.startsWith('data:image/png;base64,'), item.name);
    await run(`window.islandAPI.selectMascot('yuki-school')`);
    await wait(300);
    await capture('character-panel.png');
    assert((await snapshot()).panelOpen);
    const media = { title: '验证歌曲', artist: '验证歌手', album: '测试', trackKey: 'verify-track',
      duration: 180, position: 10, playbackStatus: 4, observedAt: Date.now(), lastUpdatedTime: Date.now(), artwork: null };
    if (artworkFixture) {
      const cover = fs.readFileSync(artworkFixture);
      assert(cover.length > 1024 * 1024, 'regression fixture exceeds the old native limit');
      media.artwork = `data:image/png;base64,${cover.toString('base64')}`;
    }
    mediaWorkers.at(-1).emit('message', { type: 'media-state', payload: media });
    await wait(300);
    if (artworkFixture) {
      const sizes = await run(`Promise.all(['compactArtwork', 'expandedArtwork'].map(async id => {
        const image = document.getElementById(id); await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }))`);
      const size = nativeImage.createFromBuffer(fs.readFileSync(artworkFixture)).getSize();
      assert.deepEqual(sizes, [[size.width, size.height], [size.width, size.height]]);
    }
    assert((await snapshot()).panelOpen, 'media arrival must not close panel');
    await click('mascotCloseButton');
    assert.equal((await snapshot()).empty, false);
    // Move away from the top work-area edge before checking a stable anchor.
    window.setPosition(window.getBounds().x, 200);
    const expandedBounds = window.getBounds();
    await click('collapseButton');
    assert.equal((await snapshot()).mode, 'compact');
    assert.equal((await snapshot()).height, 63);
    assert.equal(window.getBounds().y + 63, expandedBounds.y);
    verifyStaticShape('yuki-school');
    mediaWorkers.at(-1).emit('message', { type: 'media-state', payload: { ...media, playbackStatus: 0 } });
    await wait(450);
    verifyStaticShape('yuki-school', 2);
    assert.equal((await snapshot()).title, '验证歌曲', 'pause retains the real song');
    mediaWorkers.at(-1).emit('message', { type: 'media-state', payload: media });
    await wait(450);
    verifyStaticShape('yuki-school');
    await capture('yuki-school-compact.png');
    const capsuleY = window.getBounds().y + 63;
    await run(`window.islandAPI.selectMascot('none')`);
    await wait(350);
    assert.equal(window.getBounds().y, capsuleY);
    assert(Math.abs(window.getBounds().height - 82) <= 1, 'window height allows one DIP of display-scale rounding');
    assert((await snapshot()).mascotHidden);
    await run(`window.islandAPI.selectMascot('yuki-black')`);
    await wait(350);
    await capture('yuki-black-compact.png');
    await click('expandButton');
    mediaWorkers.at(-1).emit('message', { type: 'media-state', payload: null });
    await wait(300);
    assert.equal((await snapshot()).mode, 'expanded');
    assert((await snapshot()).empty);
    await run('window.islandAPI.setClickThrough(true)');
    await run('window.islandAPI.setMascotPanel(true)');
    await wait(300);
    assert.equal(window.isFocusable(), true);
    await click('mascotCloseButton');
    assert.equal(window.isFocusable(), false, 'panel exit restores click-through');
    await run('window.islandAPI.setClickThrough(false)');
    await run('window.islandAPI.setMascotPanel(true)');
    await wait(100);
    const beforeImport = await run('window.islandAPI.getMascots()');
    assert.equal(await run('window.islandAPI.importMascot()'), null, 'cancel does not replace selection');
    assert.equal((await run('window.islandAPI.getMascots()')).selectedId, beforeImport.selectedId);
    const source = path.join(directory, '我的角色.png');
    fs.copyFileSync(path.join(root, 'assets/mascots/yuki-school.png'), source);
    dialogResults.push({ canceled: false, filePaths: [source] });
    const imported = await run('window.islandAPI.importMascot()');
    const customId = imported.selectedId;
    assert(customId.startsWith('custom-'));
    assert.equal(imported.items.find(item => item.id === customId).name, '我的角色');
    fs.unlinkSync(source);
    window.webContents.reload();
    await wait(700);
    assert.equal((await run('window.islandAPI.getMascots()')).selectedId, customId);
    await run(`window.islandAPI.removeMascot(${JSON.stringify(customId)})`);
    assert.equal((await run('window.islandAPI.getMascots()')).selectedId, 'none');
    assert(!fs.existsSync(path.join(directory, 'mascots', `${customId}.png`)));
    await run('window.islandAPI.setMascotPanel(false)');
    await click('emptyDemoButton');
    assert.equal((await snapshot()).empty, false);
    await click('demoButton');
    assert.equal((await snapshot()).empty, true);
    assert.equal((await snapshot()).mode, 'expanded');
    assert.deepEqual(errors, [], 'renderer console errors');
    console.log(JSON.stringify({ passed: true, screenshots, userData: directory, packagedResources: Boolean(rootArgument) }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error('Verification data:', directory);
    app.exit(1);
  }
});
