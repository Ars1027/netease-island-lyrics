const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalize,
  validatePng,
  MascotStore,
} = require('../src/services/mascot-store');
function fake(width, height, bitmap) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => bitmap,
    crop: ({ x, y, width: w, height: h }) => {
      const b = Buffer.alloc(w * h * 4);
      for (let row = 0; row < h; row++)
        bitmap.copy(
          b,
          row * w * 4,
          ((row + y) * width + x) * 4,
          ((row + y) * width + x + w) * 4,
        );
      return fake(w, h, b);
    },
    resize: ({ width: w, height: h }) => {
      const b = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const source =
            (Math.floor((y * height) / h) * width +
              Math.floor((x * width) / w)) *
            4;
          bitmap.copy(b, (y * w + x) * 4, source, source + 4);
        }
      return fake(w, h, b);
    },
  };
}
test('normalization crops transparent perimeter and centers bottom without stretching', () => {
  const bitmap = Buffer.alloc(8 * 8 * 4);
  for (let y = 2; y < 6; y++)
    for (let x = 3; x < 5; x++) bitmap[(y * 8 + x) * 4 + 3] = 255;
  let output;
  const result = normalize(fake(8, 8, bitmap), {
    createFromBitmap: (b, size) => {
      output = { b, size };
      return { toDataURL: () => 'data:image/png;base64,test' };
    },
  });
  assert.deepEqual(output.size, { width: 96, height: 58 });
  assert.equal(result.shape.length, 58);
  assert.deepEqual(result.shape[0], { x: 33, y: 0, width: 29, height: 1 });
  assert.equal(result.image, 'data:image/png;base64,test');
});
test('normalization rejects empty and opaque images', () => {
  assert.throws(() => normalize(fake(1, 1, Buffer.alloc(4)), {}));
  assert.throws(() => normalize(fake(1, 1, Buffer.from([1, 2, 3, 255])), {}));
});
test('PNG validation rejects signatures and animation chunks', () => {
  assert.throws(() => validatePng(Buffer.from('not png')));
  assert.throws(() => validatePng(fixturePng({ animation: 'acTL' })));
  assert.throws(() => validatePng(fixturePng({ animation: 'fcTL' })));
});
test('builtins cannot be removed and unknown IDs do not resolve', () => {
  const store = new MascotStore({
    userDataPath: __dirname,
    assetsPath: __dirname,
    nativeImage: {
      createFromPath: () => {
        throw Error('missing');
      },
    },
  });
  assert.equal(store.list().length, 4);
  assert.equal(store.get('../escape'), null);
  assert.throws(() => store.remove('../escape'));
  assert.throws(() => store.remove('hotaru'));
  assert.deepEqual(store.getShape('none'), []);
});

test('custom names persist and image cache invalidates when file changes', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-cache-'));
  const id = 'custom-' + 'a'.repeat(32);
  const directory = path.join(root, 'mascots');
  fs.mkdirSync(directory);
  const file = path.join(directory, `${id}.png`);
  fs.writeFileSync(file, 'first');
  fs.writeFileSync(
    path.join(directory, `${id}.json`),
    JSON.stringify({ name: 'My character' }),
  );
  let decodes = 0;
  const bitmap = Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]);
  const nativeImage = {
    createFromPath: () => {
      decodes++;
      return fake(2, 1, bitmap);
    },
    createFromBitmap: () => ({ toDataURL: () => 'data:image/png;base64,test' }),
  };
  try {
    const store = new MascotStore({
      userDataPath: root,
      assetsPath: root,
      nativeImage,
    });
    assert.equal(store.get(id).name, 'My character');
    store.get(id);
    assert.equal(decodes, 1);
    fs.writeFileSync(file, 'changed size');
    store.get(id);
    assert.equal(decodes, 2);
    assert.equal(
      new MascotStore({
        userDataPath: root,
        assetsPath: root,
        nativeImage,
      }).get(id).name,
      'My character',
    );
    fs.rmSync(file);
    assert.equal(store.get(id), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function chunk(type, data = Buffer.alloc(0)) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  return result;
}

// The nativeImage fake handles decoding; these fixtures exercise container validation.
function fixturePng({ width = 2, height = 1, animation } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    ...(animation ? [chunk(animation)] : []),
    chunk('IDAT', Buffer.from([1])),
    chunk('IEND'),
  ]);
}

test('PNG validation enforces dimensions, static format, completeness and size', () => {
  assert.doesNotThrow(() => validatePng(fixturePng()));
  assert.throws(() => validatePng(fixturePng({ width: 4097 })));
  assert.throws(() => validatePng(fixturePng({ height: 4097 })));
  for (const animation of ['acTL', 'fcTL', 'fdAT']) {
    assert.throws(() => validatePng(fixturePng({ animation })));
  }
  assert.throws(() => validatePng(fixturePng().subarray(0, -3)));
  assert.throws(() =>
    validatePng(Buffer.concat([fixturePng(), Buffer.alloc(10 * 1024 * 1024)])),
  );
});

test('imports retain original data and names after source removal and restart', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-import-'));
  const source = path.join(root, 'Personal character.png');
  const data = fixturePng();
  const nativeImage = {
    createFromBuffer: () => fake(2, 1, Buffer.from([0, 0, 0, 0, 0, 0, 0, 255])),
    createFromPath: (file) => {
      assert.deepEqual(fs.readFileSync(file), data);
      return fake(2, 1, Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]));
    },
    createFromBitmap: () => ({ toDataURL: () => 'data:image/png;base64,test' }),
  };
  try {
    fs.writeFileSync(source, data);
    const options = { userDataPath: root, assetsPath: root, nativeImage };
    const imported = new MascotStore(options).importFile(source);
    fs.rmSync(source);
    const restored = new MascotStore(options).get(imported.id);
    assert.equal(restored.name, 'Personal character');
    assert.equal(restored.image, imported.image);
    assert.deepEqual(
      fs.readFileSync(path.join(root, 'mascots', `${imported.id}.png`)),
      data,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed validation, decode and metadata persistence leave no imported files', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-failure-'));
  const source = path.join(root, 'source.png');
  const directory = path.join(root, 'mascots');
  fs.mkdirSync(directory);
  const nativeImage = {
    createFromBuffer: () => ({ isEmpty: () => true }),
    createFromBitmap: () => ({ toDataURL: () => 'data:image/png;base64,test' }),
  };
  const store = new MascotStore({
    userDataPath: root,
    assetsPath: root,
    nativeImage,
  });
  const write = fs.writeFileSync;
  try {
    fs.writeFileSync(source, 'damaged');
    assert.throws(() => store.importFile(source));
    assert.deepEqual(fs.readdirSync(directory), []);
    fs.writeFileSync(source, fixturePng());
    assert.throws(() => store.importFile(source));
    assert.deepEqual(fs.readdirSync(directory), []);
    nativeImage.createFromBuffer = () =>
      fake(2, 1, Buffer.from([0, 0, 0, 0, 0, 0, 0, 255]));
    fs.writeFileSync = (file, ...args) => {
      if (String(file).endsWith('.json'))
        throw Error('metadata persistence failed');
      return write(file, ...args);
    };
    assert.throws(
      () => store.importFile(source),
      /metadata persistence failed/,
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.writeFileSync = write;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

