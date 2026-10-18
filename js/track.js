/* KitchenEye v1 — ball tracking.
 *
 * Approach (no ML model needed): pickleballs are optic yellow/green, very
 * distinct from blue/green court surfaces in HSV space.
 *   1. User taps the ball once -> sample a small patch, record HSV mean/range.
 *   2. Each frame (downscaled, pixel step 2 for speed): HSV-threshold, collect
 *      matching pixels, cluster into a ball candidate via density grid.
 *   3. Associate the candidate nearest to the constant-velocity prediction
 *      (gated). Drop the track if unseen for >10 frames.
 *   4. Bounce = sharp sign flip of image-plane vertical velocity (y grows
 *      downward, so vy flips + to -) with enough incoming speed AND a
 *      horizontal speed drop. The bounce pixel is linearly interpolated
 *      between the two frames: f = vy_before / (vy_before + |vy_after|),
 *      p = p0 + (p1 - p0) * f. Then mapped through the homography.
 */
'use strict';

const TRACK_W = 480;      // processing width (px)
const PX_STEP = 2;        // sample every 2nd pixel for speed
const LOST_MAX = 10;      // frames without sighting before track drops
const GATE_PX = 60;       // association gate around prediction (px, full-res)
const MIN_BLOB = 6;       // min sampled matching px to count as ball
const MAX_BLOB = 4000;    // max (rejects huge blobs: shirts, court patches)
const VY_MIN = 120;       // min incoming vertical speed for a bounce (px/s)
const BOUNCE_COOLDOWN_S = 0.4;

/**
 * Known ball colors (H 0-360, S/V 0-100, same scale as rgbToHsv).
 * Franklin X-40 optic yellow is the tournament-standard outdoor ball,
 * so it is the default — no tap needed.
 */
const BALL_PRESETS = {
  'franklin-x40': { label: 'Franklin X-40 · optic yellow', hMean: 68, hRange: 18, sMin: 45, vMin: 45 },
  'lifetime':     { label: 'Lifetime · orange',            hMean: 30, hRange: 15, sMin: 55, vMin: 45 },
  'neon-green':   { label: 'Neon green',                    hMean: 100, hRange: 20, sMin: 45, vMin: 40 },
  'orange':       { label: 'Orange',                        hMean: 32, hRange: 14, sMin: 55, vMin: 45 },
};

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : (d / mx) * 100, mx * 100]; // H 0-360, S/V 0-100
}

function hueDist(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

class BallTracker {
  constructor() {
    this.calibrated = false;
    this.hMean = 0; this.hRange = 14;
    this.sMin = 0; this.vMin = 0;
    this.reset();
  }

  reset() {
    this.px = 0; this.py = 0;       // last known full-res position
    this.vx = 0; this.vy = 0;       // px/s
    this.hasTrack = false;
    this.lost = 0;
    this.hist = [];                 // recent {x,y,t} for bounce detection
    this.lastBounceT = -10;
  }

  /**
   * Calibrate from a user tap: sample a 9x9 patch around (x,y) in the
   * *full-res* preview coords, mapped into the given ImageData.
   */
  calibrateFromTap(imgData, imgW, imgH, tapX, tapY) {
    const hs = [], ss = [], vs = [];
    const R = 4;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.round(tapX) + dx, y = Math.round(tapY) + dy;
        if (x < 0 || y < 0 || x >= imgW || y >= imgH) continue;
        const i = (y * imgW + x) * 4;
        const [h, s, v] = rgbToHsv(imgData.data[i], imgData.data[i + 1], imgData.data[i + 2]);
        hs.push(h); ss.push(s); vs.push(v);
      }
    }
    if (!hs.length) throw new Error('tap inside the preview');
    // Circular mean for hue.
    let sx = 0, sy = 0;
    for (const h of hs) { sx += Math.cos(h * Math.PI / 180); sy += Math.sin(h * Math.PI / 180); }
    this.hMean = Math.atan2(sy / hs.length, sx / hs.length) * 180 / Math.PI;
    if (this.hMean < 0) this.hMean += 360;
    this.hRange = 16;
    this.sMin = Math.max(25, Math.min(...ss) - 25);
    this.vMin = Math.max(25, Math.min(...vs) - 30);
    this.calibrated = true;
    this.reset();
  }

  /** Use a known ball color instead of a tap (default: Franklin X-40). */
  calibratePreset(name) {
    const p = BALL_PRESETS[name] || BALL_PRESETS['franklin-x40'];
    this.hMean = p.hMean; this.hRange = p.hRange;
    this.sMin = p.sMin; this.vMin = p.vMin;
    this.calibrated = true;
    this.reset();
  }

  matches(h, s, v) {
    return hueDist(h, this.hMean) <= this.hRange && s >= this.sMin && v >= this.vMin;
  }

  /**
   * Process one video frame. imgData is ImageData at (imgW x imgH).
   * Returns {x, y} full-res ball position, or null.
   */
  detect(imgData, imgW, imgH) {
    if (!this.calibrated) return null;
    const d = imgData.data;
    // Density grid: 24px cells accumulate matching-pixel counts + sums.
    const cell = 24;
    const gw = Math.ceil(imgW / cell), gh = Math.ceil(imgH / cell);
    const cnt = new Int32Array(gw * gh);
    const sumX = new Float64Array(gw * gh);
    const sumY = new Float64Array(gw * gh);
    let total = 0;
    for (let y = 0; y < imgH; y += PX_STEP) {
      for (let x = 0; x < imgW; x += PX_STEP) {
        const i = (y * imgW + x) * 4;
        const [h, s, v] = rgbToHsv(d[i], d[i + 1], d[i + 2]);
        if (!this.matches(h, s, v)) continue;
        const ci = ((y / cell) | 0) * gw + ((x / cell) | 0);
        cnt[ci]++; sumX[ci] += x; sumY[ci] += y;
        total++;
      }
    }
    if (total < MIN_BLOB || total > MAX_BLOB) return null;
    // Densest cell + its neighbors form the ball candidate.
    let bi = 0, bv = 0;
    for (let i = 0; i < cnt.length; i++) if (cnt[i] > bv) { bv = cnt[i]; bi = i; }
    const bx = bi % gw, by = (bi / gw) | 0;
    let cx = 0, cy = 0, cn = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const i = ny * gw + nx;
        cx += sumX[i]; cy += sumY[i]; cn += cnt[i];
      }
    }
    if (cn < MIN_BLOB) return null;
    return { x: cx / cn, y: cy / cn };
  }

  /**
   * Update with a new frame. nowS = timestamp in seconds.
   * Returns a bounce event {x, y, t} (full-res px) or null.
   */
  update(det, nowS) {
    if (det) {
      if (this.hasTrack) {
        // Gate against the constant-velocity prediction.
        const dt = Math.max(1e-3, nowS - this.lastT);
        const px = this.px + this.vx * dt, py = this.py + this.vy * dt;
        if (Math.hypot(det.x - px, det.y - py) > GATE_PX) {
          this.lost++;
          if (this.lost > LOST_MAX) { this.hasTrack = false; this.hist = []; }
          return null;
        }
        const nvx = (det.x - this.px) / dt, nvy = (det.y - this.py) / dt;
        const bounce = this.checkBounce(nvx, nvy, det, nowS);
        this.vx = nvx; this.vy = nvy;
        this.px = det.x; this.py = det.y;
        this.lost = 0;
        this.lastT = nowS;
        this.hist.push({ x: det.x, y: det.y, t: nowS });
        if (this.hist.length > 12) this.hist.shift();
        return bounce;
      }
      // Fresh acquisition.
      this.hasTrack = true; this.lost = 0;
      this.px = det.x; this.py = det.y; this.vx = 0; this.vy = 0;
      this.lastT = nowS;
      this.hist = [{ x: det.x, y: det.y, t: nowS }];
      return null;
    }
    this.lost++;
    if (this.lost > LOST_MAX) { this.hasTrack = false; this.hist = []; }
    return null;
  }

  checkBounce(nvx, nvy, det, nowS) {
    // Need a previous velocity: vy was + (moving down in image) and is now -.
    if (this.vy <= VY_MIN) return null;
    if (nvy >= -40) return null; // must clearly head back up
    if (nowS - this.lastBounceT < BOUNCE_COOLDOWN_S) return null;
    const hSpeedBefore = Math.hypot(this.vx, this.vy);
    const hSpeedAfter = Math.hypot(nvx, nvy);
    if (hSpeedBefore > 0 && hSpeedAfter / hSpeedBefore > 0.75) return null; // no energy loss: not a bounce
    this.lastBounceT = nowS;
    // Interpolate the contact pixel between the two frames.
    const f = this.vy / (this.vy + Math.abs(nvy));
    const prev = this.hist.length ? this.hist[this.hist.length - 1] : { x: this.px, y: this.py };
    return {
      x: prev.x + (det.x - prev.x) * f,
      y: prev.y + (det.y - prev.y) * f,
      t: nowS,
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BallTracker, rgbToHsv, hueDist, BALL_PRESETS };
}
