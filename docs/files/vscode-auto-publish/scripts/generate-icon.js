const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const width = 256;
const height = 256;

// Buffer for raw scanlines: each line has 1 filter byte (0) + 256 * 4 RGBA bytes
const scanlines = Buffer.alloc(height * (1 + width * 4));

function setPixel(x, y, r, g, b, a) {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const offset = y * (1 + width * 4) + 1 + x * 4;
  scanlines[offset] = r;
  scanlines[offset + 1] = g;
  scanlines[offset + 2] = b;
  scanlines[offset + 3] = a;
}

// Distance to rounded rectangle
function roundedRectDist(x, y, rx, ry, rw, rh, radius) {
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const dx = Math.abs(x - cx) - (rw / 2 - radius);
  const dy = Math.abs(y - cy) - (rh / 2 - radius);
  if (dx <= 0 && dy <= 0) return 0;
  if (dx > 0 && dy <= 0) return dx;
  if (dx <= 0 && dy > 0) return dy;
  return Math.sqrt(dx * dx + dy * dy);
}

// Draw the icon
const iconRadius = 48;
const iconMargin = 16;
const iconW = width - 2 * iconMargin;
const iconH = height - 2 * iconMargin;

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const d = roundedRectDist(x, y, iconMargin, iconMargin, iconW, iconH, iconRadius);
    if (d > iconRadius) {
      setPixel(x, y, 0, 0, 0, 0); // transparent outside rounded rect
      continue;
    }
    
    // Smooth anti-aliased edge
    let edgeAlpha = 1.0;
    if (d > iconRadius - 1.5) {
      edgeAlpha = Math.max(0, Math.min(1, (iconRadius - d) / 1.5));
    }

    // Gradient background: Deep Blue (#1e40af) to Vibrant Cyan-Blue (#0284c7)
    const t = (y - iconMargin) / iconH;
    let r = Math.round(18 + t * (2 - 18));
    let g = Math.round(64 + t * (132 - 64));
    let b = Math.round(180 + t * (210 - 180));

    // Subtle inner border highlight
    if (d > iconRadius - 4 && d <= iconRadius) {
      r = Math.min(255, r + 40);
      g = Math.min(255, g + 40);
      b = Math.min(255, b + 50);
    }

    setPixel(x, y, r, g, b, Math.round(255 * edgeAlpha));
  }
}

// Draw code brackets < / > or tray and arrow pointing up
function drawRect(rx, ry, rw, rh, cr, cg, cb, ca) {
  for (let y = Math.floor(ry); y <= Math.ceil(ry + rh); y++) {
    for (let x = Math.floor(rx); x <= Math.ceil(rx + rw); x++) {
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) {
        setPixel(x, y, cr, cg, cb, ca);
      }
    }
  }
}

function drawTriangle(x1, y1, x2, y2, x3, y3, cr, cg, cb, ca) {
  const minX = Math.floor(Math.min(x1, x2, x3));
  const maxX = Math.ceil(Math.max(x1, x2, x3));
  const minY = Math.floor(Math.min(y1, y2, y3));
  const maxY = Math.ceil(Math.max(y1, y2, y3));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
      const d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3);
      const d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      if (!(hasNeg && hasPos)) {
        setPixel(x, y, cr, cg, cb, ca);
      }
    }
  }
}

// Shadow for icon foreground
drawTriangle(128, 56 + 4, 76, 114 + 4, 180, 114 + 4, 10, 25, 70, 120);
drawRect(115, 106 + 4, 26, 46, 10, 25, 70, 120);
drawRect(58, 178 + 4, 140, 18, 10, 25, 70, 120);
drawRect(58, 142 + 4, 18, 48, 10, 25, 70, 120);
drawRect(180, 142 + 4, 18, 48, 10, 25, 70, 120);

// Crisp white symbols
// Upward Arrow Head
drawTriangle(128, 56, 76, 114, 180, 114, 255, 255, 255, 255);
// Arrow shaft
drawRect(115, 106, 26, 46, 255, 255, 255, 255);
// Base tray (bracket / repository tray)
drawRect(58, 178, 140, 18, 255, 255, 255, 255);
drawRect(58, 142, 18, 48, 255, 255, 255, 255);
drawRect(180, 142, 18, 48, 255, 255, 255, 255);

// Little green dot indicator in bottom-right tray area
for (let y = 175; y <= 199; y++) {
  for (let x = 175; x <= 199; x++) {
    const dist = Math.sqrt((x - 187) * (x - 187) + (y - 187) * (y - 187));
    if (dist <= 8) {
      setPixel(x, y, 34, 197, 94, 255); // emerald green dot
    }
  }
}

// Build PNG
function makePng(width, height, rawScanlines) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    const crc = crc32(Buffer.concat([typeBuf, data]));
    crcBuf.writeInt32BE(crc, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bit
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // IDAT
  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  const idatChunk = makeChunk("IDAT", compressed);

  // IEND
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) c = 0xedb88320 ^ (c >>> 1);
    else c = c >>> 1;
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

const imagesDir = path.join(__dirname, "..", "images");
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}
const pngBuffer = makePng(width, height, scanlines);
fs.writeFileSync(path.join(imagesDir, "icon.png"), pngBuffer);
console.log("Icon written to", path.join(imagesDir, "icon.png"), "size:", pngBuffer.length);
