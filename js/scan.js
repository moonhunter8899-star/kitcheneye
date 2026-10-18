/* KitchenEye v1 — court auto-scan.
 *
 * Pipeline (runs once per court, not per frame):
 *   1. Grab a frame, downscale to ~480p, grayscale.
 *   2. Keep the brightest pixels (white court lines on darker surface).
 *   3. Hough transform: every bright pixel votes for (rho, theta) lines.
 *      A straight court line shows up as a peak in the accumulator.
 *   4. Split detected lines into two orientation groups (court sides vs.
 *      baselines, roughly perpendicular in the image).
 *   5. Try pairs from each group -> line intersections -> quadrilateral
 *      candidates. For each, compute the homography to court coordinates
 *      (Direct Linear Transform, 4 point pairs -> 8x8 linear solve) and
 *      score it by how many bright pixels land near the expected court
 *      lines (kitchen + centerlines break the symmetry, so the orientation
 *      resolves correctly). Keep the best.
 *   6. Overlay the winning quad on the preview for a human "looks right?".
 *
 * Manual fallback: the user taps the 4 corners in order
 *   near-left, near-right, far-right, far-left (from behind the baseline).
 * A mirror flip would still give correct IN/OUT distances; the order above
 * keeps the mini-court diagram matching reality.
 */
'use strict';

const SCAN_W = 480;          // detection width (px)
const BRIGHT_FRAC = 0.10;    // keep brightest 10% of pixels
const BRIGHT_MIN = 140;      // ...but never below this luminance
const HOUGH_THETA_STEP = 2;  // degrees
const HOUGH_RHO_STEP = 2;    // px
const SCORE_TOL_FT = 0.75;   // template-match tolerance
const SCORE_MIN = 0.25;      // accept quad only above this

/** Draw the current video frame into an offscreen canvas at SCAN_W wide. */
function grabFrame(video) {
  if (!video || !video.videoWidth) throw new Error('camera not ready');
  const w = SCAN_W;
  const h = Math.max(2, Math.round(SCAN_W * video.videoHeight / video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  return { canvas, ctx, w, h };
}

function grayscale(data, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    g[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return g;
}

/** Luminance threshold at the given bright-fraction percentile (histogram-based). */
function brightThreshold(g, frac) {
  const f = (typeof frac === 'number') ? frac : BRIGHT_FRAC;
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let need = Math.floor(g.length * f);
  let t = 255;
  for (; t > 0; t--) {
    need -= hist[t];
    if (need <= 0) break;
  }
  return Math.max(t, BRIGHT_MIN);
}

/**
 * "Yellow-ness" per pixel: high R and G, low B. Pickleball lines are often
 * painted yellow over a competing white line set (e.g. blended tennis
 * courts) — this pass isolates them when brightness alone is ambiguous.
 */
function yellowScore(data, w, h) {
  const y = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const yv = Math.min(data[i], data[i + 1]) - data[i + 2];
    y[j] = yv > 0 ? yv : 0;
  }
  return y;
}

/**
 * Hough transform on bright pixels.
 * Each pixel (x,y) votes for all lines rho = x*cos(t) + y*sin(t).
 * Returns top lines as [{rho, theta(rad), votes}], theta in [0, PI).
 */
function houghLines(g, w, h, thresh) {
  const nT = Math.floor(180 / HOUGH_THETA_STEP);
  const diag = Math.hypot(w, h);
  const nR = Math.floor((2 * diag) / HOUGH_RHO_STEP);
  const acc = new Int32Array(nT * nR);
  const cosT = new Float64Array(nT);
  const sinT = new Float64Array(nT);
  for (let i = 0; i < nT; i++) {
    const a = (i * HOUGH_THETA_STEP * Math.PI) / 180;
    cosT[i] = Math.cos(a);
    sinT[i] = Math.sin(a);
  }
  const off = diag / HOUGH_RHO_STEP;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y * w + x] < thresh) continue;
      for (let ti = 0; ti < nT; ti++) {
        const r = Math.round((x * cosT[ti] + y * sinT[ti]) / HOUGH_RHO_STEP + off);
        if (r >= 0 && r < nR) acc[ti * nR + r]++;
      }
    }
  }
  // Peak picking with non-max suppression.
  let maxV = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] > maxV) maxV = acc[i];
  const voteMin = Math.max(40, maxV * 0.35);
  const lines = [];
  const wT = 3, wR = 4; // suppression window (theta, rho)
  for (let ti = 0; ti < nT; ti++) {
    for (let ri = 0; ri < nR; ri++) {
      const v = acc[ti * nR + ri];
      if (v < voteMin) continue;
      let isMax = true;
      for (let dt = -wT; dt <= wT && isMax; dt++) {
        for (let dr = -wR; dr <= wR; dr++) {
          const nt = (ti + dt + nT) % nT; // theta wraps
          const nr = ri + dr;
          if (nr < 0 || nr >= nR) continue;
          if (acc[nt * nR + nr] > v) { isMax = false; break; }
        }
      }
      if (isMax) {
        lines.push({
          rho: (ri - off) * HOUGH_RHO_STEP,
          theta: (ti * HOUGH_THETA_STEP * Math.PI) / 180,
          votes: v,
        });
      }
    }
  }
  lines.sort((a, b) => b.votes - a.votes);
  return lines.slice(0, 16);
}

/** Intersection of two (rho, theta) lines -> {x, y} or null if parallel. */
function intersect(l1, l2) {
  const c1 = Math.cos(l1.theta), s1 = Math.sin(l1.theta);
  const c2 = Math.cos(l2.theta), s2 = Math.sin(l2.theta);
  const det = c1 * s2 - c2 * s1;
  if (Math.abs(det) < 1e-6) return null;
  return {
    x: (l1.rho * s2 - l2.rho * s1) / det,
    y: (c1 * l2.rho - c2 * l1.rho) / det,
  };
}

/** Split line thetas into two orientation groups at the largest circular gap. */
function splitOrientations(lines) {
  if (lines.length < 4) return null;
  const ts = lines.map(l => l.theta).sort((a, b) => a - b);
  let gapI = 0, gapMax = 0;
  for (let i = 0; i < ts.length; i++) {
    const a = ts[i];
    const b = ts[(i + 1) % ts.length] + (i === ts.length - 1 ? Math.PI : 0);
    const gap = b - a;
    if (gap > gapMax) { gapMax = gap; gapI = i; }
  }
  const gA = [], gB = [];
  for (const l of lines) {
    // group B = thetas just after the gap
    const t = l.theta;
    const start = ts[(gapI + 1) % ts.length];
    let rel = t - start;
    if (rel < 0) rel += Math.PI;
    (rel < gapMax ? gB : gA).push(l);
  }
  if (gA.length < 2 || gB.length < 2) return null;
  return [gA, gB];
}

function quadArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], r = q[(i + 1) % 4];
    a += p.x * r.y - r.x * p.y;
  }
  return Math.abs(a / 2);
}

/**
 * Homography via Direct Linear Transform.
 * Solves for the 3x3 H mapping src[i] -> dst[i] (4 pairs). Returns
 * row-major [h11,h12,h13,h21,h22,h23,h31,h32,h33] with h33 = 1.
 * Each pair contributes two rows:
 *   [x y 1 0 0 0 -Xx -Xy] h = X
 *   [0 0 0 x y 1 -Yx -Yy] h = Y
 * solved by Gaussian elimination with partial pivoting.
 */
function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { X, Y } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    }
    if (Math.abs(A[piv][c]) < 1e-12) throw new Error('degenerate homography');
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = new Array(9);
  for (let c = 0; c < n; c++) h[c] = A[c][n] / A[c][c];
  h[8] = 1;
  return h;
}

function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function distToSegs(x, y, segments) {
  let best = Infinity;
  for (const s of segments) {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((x - s.x1) * dx + (y - s.y1) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(x - (s.x1 + t * dx), y - (s.y1 + t * dy));
    if (d < best) best = d;
  }
  return best;
}

// 8 orientation assignments of quad corners -> court rect corners.
const COURT_RECT = [{ X: 0, Y: 0 }, { X: 20, Y: 0 }, { X: 20, Y: 44 }, { X: 0, Y: 44 }];
function assignments(quad) {
  const out = [];
  for (let rot = 0; rot < 4; rot++) {
    const r = [0, 1, 2, 3].map(i => quad[(i + rot) % 4]);
    out.push(r);
    out.push([r[0], r[3], r[2], r[1]]); // flipped
  }
  return out;
}

/**
 * Full auto-scan. Tries several "line-ness" passes — plain brightness at two
 * thresholds plus a yellow-line pass for blended courts — and keeps the best
 * template match. Returns { corners:[{x,y}x4] (detection-px), H, score, w, h }
 * or null when nothing convincing was found. minScore lets callers accept
 * weaker matches on retry (the human confirm step stays the safety net).
 */
function detectCourt(video, segments, minScore) {
  const { canvas, ctx, w, h } = grabFrame(video);
  const img = ctx.getImageData(0, 0, w, h);
  const gray = grayscale(img.data, w, h);
  const yellow = yellowScore(img.data, w, h);
  const passes = [
    { g: gray, frac: BRIGHT_FRAC },
    { g: gray, frac: 0.05 },
    { g: yellow, frac: 0.10 },
  ];
  let best = null;
  for (const p of passes) {
    const r = detectOn(p.g, w, h, segments, p.frac, minScore);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

/** One detection pass over a per-pixel line-ness array. */
function detectOn(g, w, h, segments, frac, minScore) {
  const thresh = brightThreshold(g, frac);
  const lines = houghLines(g, w, h, thresh);
  const groups = splitOrientations(lines);
  if (!groups) return null;
  const [gA, gB] = groups;
  const topA = gA.slice(0, 6), topB = gB.slice(0, 6);

  // Sample bright pixels once for template scoring.
  const samples = [];
  const stride = Math.max(1, Math.floor((w * h) / 2500));
  for (let i = 0; i < w * h; i += stride) {
    if (g[i] >= thresh) samples.push({ x: i % w, y: (i / w) | 0 });
  }
  if (samples.length < 50) return null;

  let best = null;
  const m = 40; // allow intersections slightly outside frame
  for (const a1 of topA) for (const a2 of topA) {
    if (a1 === a2) continue;
    for (const b1 of topB) for (const b2 of topB) {
      if (b1 === b2) continue;
      const p11 = intersect(a1, b1), p12 = intersect(a1, b2);
      const p22 = intersect(a2, b2), p21 = intersect(a2, b1);
      if (!p11 || !p12 || !p22 || !p21) continue;
      const quad = [p11, p12, p22, p21]; // cyclic order
      if (quad.some(p => p.x < -m || p.x > w + m || p.y < -m || p.y > h + m)) continue;
      if (quadArea(quad) < 0.04 * w * h) continue;
      for (const assign of assignments(quad)) {
        let H;
        try { H = homography(assign, COURT_RECT); } catch (e) { continue; }
        // Coarse pre-filter on a subset before the full scoring pass.
        let hits = 0;
        const step = 4;
        for (let si = 0; si < samples.length; si += step) {
          const s = samples[si];
          const [X, Y] = applyHomography(H, s.x, s.y);
          if (distToSegs(X, Y, segments) <= SCORE_TOL_FT) hits++;
        }
        const coarse = hits / Math.ceil(samples.length / step);
        if (best && coarse < best.score * 0.6) continue;
        hits = 0;
        for (const s of samples) {
          const [X, Y] = applyHomography(H, s.x, s.y);
          if (distToSegs(X, Y, segments) <= SCORE_TOL_FT) hits++;
        }
        const score = hits / samples.length;
        if (!best || score > best.score) best = { corners: assign, H, score, w, h };
      }
    }
  }
  if (!best || best.score < (typeof minScore === 'number' ? minScore : SCORE_MIN)) return null;
  return best;
}

/** Build homography from 4 manually tapped corners (order: near-left, near-right, far-right, far-left). */
function buildFromCorners(cornersPx) {
  if (!cornersPx || cornersPx.length !== 4) throw new Error('need 4 corners');
  const src = cornersPx.map(p => ({ x: p.x, y: p.y }));
  return homography(src, COURT_RECT);
}

// ---- persistence (per court name) ----
const LS_KEY = 'kitcheneye.courts.v1';
function loadAllCourts() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch (e) { return {}; }
}
function saveCourt(name, H, corners, detW, detH) {
  const all = loadAllCourts();
  all[name] = { H, corners, detW, detH, savedAt: Date.now() };
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (e) { /* storage full/blocked */ }
}
function loadCourt(name) {
  return loadAllCourts()[name] || null;
}
function listCourts() {
  return Object.keys(loadAllCourts());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { homography, applyHomography, intersect, splitOrientations, distToSegs, buildFromCorners, yellowScore, brightThreshold, detectOn, detectCourt, SCORE_MIN };
}
