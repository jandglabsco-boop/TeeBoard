// Generates TeeBoard's app icons with no dependencies.
//
// A PNG is just zlib-deflated scanlines with a few chunks around them, so we
// rasterise the mark by hand rather than pulling in a canvas library — this
// has to run on any machine that can run node, including a CI box with no
// native toolchain.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const BG = [0x08, 0x11, 0x0c];      // --ink-900
const WHITE = [0xff, 0xff, 0xff];
const GREEN = [0x4c, 0xcb, 0x78];   // --grass-400

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Signed area test — lets us fill the pennant triangle without a graphics lib.
const inTriangle = (px, py, [ax, ay], [bx, by], [cx, cy]) => {
  const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = d(px, py, ax, ay, bx, by);
  const d2 = d(px, py, bx, by, cx, cy);
  const d3 = d(px, py, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

function render(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 3);
  // Maskable icons get cropped to a circle by the launcher, so the mark is
  // drawn smaller to stay inside the safe zone.
  const scale = (maskable ? 0.62 : 0.8) * size / 100;
  const off = (size - 100 * scale) / 2;
  const X = (u) => off + u * scale;
  const Y = (v) => off + v * scale;

  const pole = { x0: X(32), x1: X(38.5), y0: Y(20), y1: Y(80) };
  const tri = [[X(38), Y(24)], [X(74), Y(34)], [X(38), Y(44)]];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = BG;
      // green: a thin arc under the flag, approximated by a parabola
      const gx = (x - X(50)) / (X(82) - X(50));
      const gy = Y(84) - (1 - gx * gx) * (Y(84) - Y(76));
      if (Math.abs(gx) <= 1 && Math.abs(y - gy) <= 2.6 * scale) c = GREEN;
      if (inTriangle(x, y, ...tri)) c = GREEN;
      if (x >= pole.x0 && x <= pole.x1 && y >= pole.y0 && y <= pole.y1) c = WHITE;

      const i = (y * size + x) * 3;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
    }
  }

  // Prepend the per-scanline filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    px.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("icons", { recursive: true });
const out = [
  ["icons/icon-192.png", 192, {}],
  ["icons/icon-512.png", 512, {}],
  ["icons/icon-maskable-512.png", 512, { maskable: true }],
  ["icons/apple-touch-icon.png", 180, {}],
  ["icons/icon-1024.png", 1024, {}],   // source for native app icons
];
for (const [file, size, opts] of out) {
  const buf = render(size, opts);
  writeFileSync(file, buf);
  console.log(`${file}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)}kB`);
}
