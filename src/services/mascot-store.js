const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const BUILTINS = [
  ["none", "无角色", null],
  ["hotaru", "水无月萤", "island-mascot.png"],
  ["yuki-school", "水上由岐（校服）", "mascots/yuki-school.png"],
  ["yuki-black", "水上由岐（黑裙）", "mascots/yuki-black.png"],
];
const CUSTOM = /^custom-[a-f0-9]{32}$/;
function validatePng(data) {
  if (
    data.length > 10 * 1024 * 1024 ||
    !data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw Error("请选择不超过10MiB的PNG图片");
  let offset = 8,
    header = false,
    end = false,
    pixels = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset),
      type = data.toString("ascii", offset + 4, offset + 8);
    if (offset + 12 + length > data.length) throw Error("PNG数据不完整");
    if (!header) {
      if (type !== "IHDR" || length !== 13) throw Error("无效PNG头");
      const w = data.readUInt32BE(offset + 8),
        h = data.readUInt32BE(offset + 12);
      if (!w || !h || w > 4096 || h > 4096)
        throw Error("PNG最长边不能超过4096");
      header = true;
    }
    if (type === "acTL" || type === "fcTL" || type === "fdAT")
      throw Error("仅支持静态PNG");
    if (type === "IDAT") pixels = true;
    offset += length + 12;
    if (type === "IEND") {
      if (length !== 0) throw Error("无效PNG结尾");
      end = true;
      break;
    }
  }
  if (!end || !pixels || offset !== data.length) throw Error("PNG数据不完整");
}
function normalize(image, nativeImage) {
  if (image.isEmpty()) throw Error("无法解码PNG");
  const { width, height } = image.getSize(),
    bitmap = image.toBitmap();
  let left = width,
    top = height,
    right = -1,
    bottom = -1,
    transparent = false;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const a = bitmap[(y * width + x) * 4 + 3];
      if (a < 255) transparent = true;
      if (a) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  if (right < 0 || !transparent) throw Error("PNG需要包含可见角色和透明背景");
  const w = right - left + 1,
    h = bottom - top + 1,
    scale = Math.min(96 / w, 58 / h);
  const rw = Math.max(1, Math.round(w * scale)),
    rh = Math.max(1, Math.round(h * scale));
  const resized = image
    .crop({ x: left, y: top, width: w, height: h })
    .resize({ width: rw, height: rh })
    .toBitmap();
  const canvas = Buffer.alloc(96 * 58 * 4),
    ox = Math.floor((96 - rw) / 2),
    oy = 58 - rh;
  for (let y = 0; y < rh; y++)
    resized.copy(
      canvas,
      ((y + oy) * 96 + ox) * 4,
      y * rw * 4,
      (y + 1) * rw * 4,
    );
  const shape = [];
  for (let y = 0; y < 58; y++) {
    let start = -1;
    for (let x = 0; x <= 96; x++) {
      const visible = x < 96 && canvas[(y * 96 + x) * 4 + 3] > 0;
      if (visible && start < 0) start = x;
      if (!visible && start >= 0) {
        shape.push({ x: start, y, width: x - start, height: 1 });
        start = -1;
      }
    }
  }
  return {
    image: nativeImage
      .createFromBitmap(canvas, { width: 96, height: 58 })
      .toDataURL(),
    shape,
  };
}
class MascotStore {
  constructor({ userDataPath, assetsPath, nativeImage }) {
    this.directory = path.join(userDataPath, "mascots");
    this.assetsPath = assetsPath;
    this.nativeImage = nativeImage;
    this.cache = new Map();
  }

  list() {
    const cards = BUILTINS.map(([id]) => this.get(id));
    if (!fs.existsSync(this.directory)) return cards;
    for (const file of fs.readdirSync(this.directory)) {
      const id = file.replace(/\.png$/, "");
      if (!CUSTOM.test(id) || file !== `${id}.png`) continue;
      const card = this.get(id);
      if (card) cards.push(card);
    }
    return cards;
  }

  get(id) {
    const builtin = BUILTINS.find(([key]) => key === id);
    if (!builtin && !CUSTOM.test(id)) return null;
    const file = builtin
      ? builtin[2] && path.join(this.assetsPath, builtin[2])
      : path.join(this.directory, `${id}.png`);
    let stamp = "builtin";
    try {
      if (!builtin) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) return null;
        stamp = `${stat.mtimeMs}:${stat.size}`;
      }
      const cached = this.cache.get(id);
      if (cached?.stamp === stamp) return structuredClone(cached.card);
      let name = builtin ? builtin[1] : "自定义角色";
      if (!builtin) {
        try {
          const metadata = JSON.parse(
            fs.readFileSync(path.join(this.directory, `${id}.json`), "utf8"),
          );
          if (typeof metadata.name === "string") name = metadata.name;
        } catch {}
      }
      const normalized = file
        ? normalize(this.nativeImage.createFromPath(file), this.nativeImage)
        : { image: null, shape: [] };
      const card = { id, name, builtin: Boolean(builtin), ...normalized };
      this.cache.set(id, { stamp, card });
      return structuredClone(card);
    } catch {
      this.cache.delete(id);
      return builtin
        ? { id, name: builtin[1], builtin: true, image: null, shape: [] }
        : null;
    }
  }

  getShape(id) {
    return this.get(id)?.shape || [];
  }

  importFile(filePath) {
    if (fs.statSync(filePath).size > 10 * 1024 * 1024)
      throw Error("PNG不能超过10MiB");
    const data = fs.readFileSync(filePath);
    validatePng(data);
    const normalized = normalize(
      this.nativeImage.createFromBuffer(data),
      this.nativeImage,
    );
    const id = `custom-${crypto.randomBytes(16).toString("hex")}`;
    const name = path.basename(filePath, path.extname(filePath));
    fs.mkdirSync(this.directory, { recursive: true });
    const imagePath = path.join(this.directory, `${id}.png`);
    fs.writeFileSync(imagePath, data, { flag: "wx" });
    try {
      fs.writeFileSync(
        path.join(this.directory, `${id}.json`),
        JSON.stringify({ name }),
        { flag: "wx" },
      );
    } catch (error) {
      fs.rmSync(imagePath, { force: true });
      throw error;
    }
    const stat = fs.statSync(imagePath);
    const card = { id, name, builtin: false, ...normalized };
    this.cache.set(id, { stamp: `${stat.mtimeMs}:${stat.size}`, card });
    return structuredClone(card);
  }

  remove(id) {
    if (!CUSTOM.test(id)) throw Error("只能删除自定义角色");
    fs.rmSync(path.join(this.directory, `${id}.png`), { force: true });
    fs.rmSync(path.join(this.directory, `${id}.json`), { force: true });
    this.cache.delete(id);
    return true;
  }
}
module.exports = { MascotStore, validatePng, normalize };
