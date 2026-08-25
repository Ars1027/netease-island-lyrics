const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', path.join(__dirname, '..', '.icon-render-cache'));

app.whenReady().then(async () => {
  const assetDirectory = path.join(__dirname, '..', 'assets');
  const svgPath = path.join(assetDirectory, 'app-icon.svg');
  const pngPath = path.join(assetDirectory, 'app-icon.png');
  const icoPath = path.join(assetDirectory, 'app-icon.ico');
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
  });
  await window.loadFile(svgPath);
  window.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const captured = await window.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  const png = captured.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
  window.destroy();

  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);

  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, Buffer.concat([header, png]));
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
