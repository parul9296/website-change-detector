// Highlighted screenshot diff (changed pixels drawn in red)
const fs = require('fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

function crop(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(img, out, 0, 0, w, h, 0, 0);
  return out;
}

function diffImage(aPath, bPath, outPath) {
  const a = PNG.sync.read(fs.readFileSync(aPath));
  const b = PNG.sync.read(fs.readFileSync(bPath));
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  const changed = pixelmatch(crop(a, w, h).data, crop(b, w, h).data, out.data, w, h,
    { threshold: 0.1, alpha: 0.35, diffColor: [230, 30, 30] });
  fs.writeFileSync(outPath, PNG.sync.write(out));
  return { changed, total: w * h };
}

module.exports = { diffImage };
