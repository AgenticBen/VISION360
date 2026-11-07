// QR codes for workflow links, with no dependencies. Byte mode, error
// correction level M (about 15% of the code can be damaged and it still
// scans), versions 1–10 (up to 213 bytes, plenty for a link). The layout
// follows ISO/IEC 18004; the structure mirrors Project Nayuki's reference
// encoder (MIT), rewritten here for this one use.
//
//   qrMatrix(text)        -> { size, version, mask, modules: boolean[][] }  (true = dark)
//   qrSvg(text, opts)     -> an SVG string with a 4-module quiet zone

// Level M, per version: [error-correction codewords per block, [blocks, data codewords]...]
const M_BLOCKS = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
  [26, [4, 43], [1, 44]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const FORMAT_M = 0; // level M's two format bits are 00

function dataCapacity(v) {
  return M_BLOCKS[v].slice(1).reduce((n, [blocks, data]) => n + blocks * data, 0);
}

// ---- GF(256) arithmetic and Reed–Solomon ------------------------------------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---- data codewords ---------------------------------------------------------
function encodeData(bytes) {
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (!version) throw new Error("Text too long for a QR code here (max 213 bytes).");
  const cap = dataCapacity(version) * 8;
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return { version, codewords };
}

function addErrorCorrection(version, data) {
  const [ecLen, ...groups] = M_BLOCKS[version];
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  let k = 0;
  for (const [count, len] of groups) {
    for (let b = 0; b < count; b++) {
      const dat = data.slice(k, k + len);
      k += len;
      blocks.push({ dat, ecc: rsRemainder(dat, divisor) });
    }
  }
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.dat.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.dat.length) out.push(b.dat[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ecc[i]);
  return out;
}

// ---- the grid ----------------------------------------------------------------
function buildGrid(version, codewords, mask) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };
  const bit = (v, i) => ((v >>> i) & 1) !== 0;

  // timing patterns
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  // finder patterns (with separators)
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment patterns
  const pos = ALIGN[version], n = pos.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // format bits (reserved now, written with the chosen mask below)
  const drawFormat = (m) => {
    const data = (FORMAT_M << 3) | m;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(bits, i));
    setFn(8, 7, bit(bits, 6));
    setFn(8, 8, bit(bits, 7));
    setFn(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bits, i));
    setFn(8, size - 8, true); // the always-dark module
  };
  drawFormat(0);
  // version information (version 7 and up)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      setFn(a, b, bit(bits, i));
      setFn(b, a, bit(bits, i));
    }
  }
  // data, in the zig-zag order
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < codewords.length * 8) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
  // mask
  const flip = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && flip(x, y)) modules[y][x] = !modules[y][x];
  drawFormat(mask);
  return { size, modules };
}

// Lower is better: long runs, 2×2 blocks, finder-like patterns, imbalance.
function penalty({ size, modules }) {
  let score = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]));
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    const s = line.map((d) => (d ? "1" : "0")).join("");
    for (const pat of ["10111010000", "00001011101"]) {
      let at = s.indexOf(pat);
      while (at !== -1) { score += 40; at = s.indexOf(pat, at + 1); }
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = modules[y][x];
    if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
  }
  const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

export function qrMatrix(text) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const { version, codewords } = encodeData(bytes);
  const all = addErrorCorrection(version, codewords);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const g = buildGrid(version, all, mask);
    const p = penalty(g);
    if (!best || p < best.p) best = { ...g, mask, p };
  }
  return { size: best.size, version, mask: best.mask, modules: best.modules };
}

export function qrSvg(text, { dark = "#051362", light = "#ffffff", px = 8, title = "" } = {}) {
  const { size, modules } = qrMatrix(text);
  const q = 4, full = size + q * 2;
  let d = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" width="${full * px}" height="${full * px}" shape-rendering="crispEdges" role="img" aria-label="${esc(title || "QR code")}">${title ? `<title>${esc(title)}</title>` : ""}<rect width="${full}" height="${full}" fill="${light}"/><path fill="${dark}" d="${d}"/></svg>`;
}
