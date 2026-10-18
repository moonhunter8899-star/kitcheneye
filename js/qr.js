'use strict';
/* KitchenEye — minimal QR encoder.
 * Byte mode, ECC level L, versions 1-5 (covers up to ~104 chars; the join
 * link is ~58). Fixed mask 0 (spec-legal). No dependencies, works offline.
 * Verified against the jsqr decoder (see /tmp/qrtest).
 *
 *   qrMatrix(text) -> { size, cells }   // cells[y*size+x] = 0|1
 *   qrDraw(canvas, text, px)            // draws with 4-module quiet zone
 */
(function () {
  // ---- Galois field GF(256), poly 0x11D ----
  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 512; i++) {
      EXP[i] = x;
      if (i < 255) LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
  })();
  function gfMul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // ---- Reed-Solomon ----
  function rsGen(ec) { // generator poly, leading coeff first (monic)
    let p = [1];
    for (let i = 0; i < ec; i++) {
      const q = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        q[j] ^= p[j];
        q[j + 1] ^= gfMul(p[j], EXP[i]);
      }
      p = q;
    }
    return p;
  }
  function rsRemainder(data, ec) {
    const gen = rsGen(ec);
    const buf = data.slice();
    for (let i = 0; i < ec; i++) buf.push(0);
    for (let i = 0; i < data.length; i++) {
      const c = buf[i];
      if (c !== 0) for (let j = 0; j <= ec; j++) buf[i + j] ^= gfMul(gen[j], c);
    }
    return buf.slice(data.length, data.length + ec);
  }

  // ---- version table (ECC level L, single block) ----
  // version: [dataCodewords, ecCodewords, [alignment centers]]
  const VERSIONS = {
    1: [19, 7, []],
    2: [34, 10, [6, 18]],
    3: [55, 15, [6, 22]],
    4: [80, 20, [6, 26]],
    5: [108, 26, [6, 30]],
  };

  function encodeData(bytes, dataCap) {
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    put(0b0100, 4);            // byte mode
    put(bytes.length, 8);      // char count (versions 1-9)
    for (const b of bytes) put(b, 8);
    const cap = dataCap * 8;
    const term = Math.min(4, cap - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      out.push(v);
    }
    for (let p = 0; out.length < dataCap; p++) out.push(p % 2 ? 0x11 : 0xEC);
    return out;
  }

  function formatBits(mask) { // ECC level L -> format value 01
    let data = (1 << 3) | mask, v = data << 10;
    const G = 0b10100110111;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= G << (i - 10);
    return ((data << 10) | (v & 0x3FF)) ^ 0x5412;
  }

  function qrMatrix(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 255) throw new Error('qr: only Latin-1 text supported');
      bytes.push(c);
    }
    let version = 0;
    for (let v = 1; v <= 5; v++) {
      if (bytes.length + 2 <= VERSIONS[v][0]) { version = v; break; }
    }
    if (!version) throw new Error('qr: text too long (max ~104 chars)');
    const [dataCap, ecCount, alignPos] = VERSIONS[version];
    const data = encodeData(bytes, dataCap);
    const ec = rsRemainder(data, ecCount);
    const codewords = data.concat(ec);

    const size = 17 + 4 * version;
    const mods = new Array(size * size).fill(-1);
    const func = new Array(size * size).fill(false);
    const at = (x, y) => y * size + x;
    function setF(x, y, dark) { mods[at(x, y)] = dark ? 1 : 0; func[at(x, y)] = true; }

    function finder(cx, cy) { // 7x7 centered at (cx,cy), plus separator ring
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ax = Math.abs(dx), ay = Math.abs(dy);
        if (ax <= 3 && ay <= 3) setF(x, y, Math.max(ax, ay) !== 2);
        else setF(x, y, false);
      }
    }
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    for (let i = 8; i < size - 8; i++) { // timing
      setF(i, 6, i % 2 === 0); setF(6, i, i % 2 === 0);
    }
    for (const ay of alignPos) for (const ax of alignPos) { // alignment
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    const fmt = formatBits(0); // fixed mask 0
    const bit = (i) => (fmt >>> i) & 1;
    for (let i = 0; i <= 5; i++) setF(8, i, bit(i));
    setF(8, 7, bit(6)); setF(8, 8, bit(7)); setF(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(i));
    setF(8, size - 8, true); // dark module: column 8, row 4V+9

    // data zigzag, mask 0: flip when (row+col) even
    const dataBits = [];
    for (const w of codewords) for (let i = 7; i >= 0; i--) dataBits.push((w >>> i) & 1);
    let di = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = upward ? size - 1 - v : v;
        if (func[at(x, y)]) continue;
        let dark = dataBits[di++] === 1;
        if ((y + x) % 2 === 0) dark = !dark;
        mods[at(x, y)] = dark ? 1 : 0;
      }
    }
    return { size, cells: mods, version };
  }

  function qrDraw(canvas, text, px) {
    const m = qrMatrix(text);
    const qz = 4, s = px || 6;
    canvas.width = canvas.height = (m.size + qz * 2) * s;
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#000';
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++)
      if (m.cells[y * m.size + x]) g.fillRect((x + qz) * s, (y + qz) * s, s, s);
    return m;
  }

  // browser globals
  if (typeof window !== 'undefined') { window.qrMatrix = qrMatrix; window.qrDraw = qrDraw; }
  if (typeof module !== 'undefined') module.exports = { qrMatrix, qrDraw };
})();
