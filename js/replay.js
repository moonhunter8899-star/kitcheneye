/* KitchenEye — dispute replay (SVG builders + captions).
 *
 * Pure-ish: replayCaption(rec) and replaySVG(rec) need only the call record
 * and the SEGMENTS global from call.js. No DOM writes here; app.js injects
 * the returned strings into the replay screen.
 *
 * Record shape: { id, at, x, y, distIn, line, call, inside, marginIn }
 *   x, y in court feet; distIn = inches to the nearest boundary line.
 */
'use strict';

function replayDotColor(call) {
  if (call === 'IN') return '#39ff88';
  if (call === 'OUT') return '#ff5d5d';
  return '#ffd24d'; // TOO CLOSE
}

/** Plain-English caption for a call record. */
function replayCaption(rec) {
  const d = Number(rec.distIn).toFixed(1);
  const line = rec.line || 'the line';
  if (rec.call === 'OUT') return d + ' in past the ' + line + ' — OUT';
  if (rec.call === 'TOO CLOSE') return 'Too close to call — ' + d + ' in from the ' + line;
  // IN: touching paint (<= 2.5 in, mirrors call.js) vs comfortably inside.
  if (Number(rec.distIn) <= 2.5) return 'Touching the ' + line + ' — IN';
  return d + ' in inside the ' + line + ' — IN';
}

/**
 * Top-down SVG of the 20x44 court with the bounce plotted.
 * The judged line is highlighted in the call's color; crosshairs pin the dot.
 */
function replaySVG(rec) {
  const S = 10;             // px per ft
  const OX = 10, OY = 10;   // margins
  const W = 20 * S, H = 44 * S;
  const X = (x) => (OX + x * S).toFixed(1);
  const Y = (y) => (OY + y * S).toFixed(1);
  const color = replayDotColor(rec.call);
  const segs = (typeof SEGMENTS !== 'undefined' && Array.isArray(SEGMENTS)) ? SEGMENTS : [];

  let lines = '';
  for (const s of segs) {
    const hl = s.name === rec.line;
    lines += '<line x1="' + X(s.x1) + '" y1="' + Y(s.y1) +
             '" x2="' + X(s.x2) + '" y2="' + Y(s.y2) +
             '" stroke="' + (hl ? color : '#ffffff') +
             '" stroke-width="' + (hl ? 5 : (s.boundary ? 3 : 1.6)) +
             '" opacity="' + (hl ? 1 : 0.85) + '"/>';
  }

  const cx = X(rec.x), cy = Y(rec.y);
  const dot =
    '<circle cx="' + cx + '" cy="' + cy + '" r="14" fill="' + color + '" opacity="0.25"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="7" fill="' + color + '" stroke="#ffffff" stroke-width="2"/>' +
    '<line x1="' + (OX - 2) + '" y1="' + cy + '" x2="' + (OX + W + 2) + '" y2="' + cy +
    '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>' +
    '<line x1="' + cx + '" y1="' + (OY - 2) + '" x2="' + cx + '" y2="' + (OY + H + 2) +
    '" stroke="' + color + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.6"/>';

  return '<rect x="0" y="0" width="' + (W + 20) + '" height="' + (H + 20) + '" fill="#0d1b2a"/>' +
    '<rect x="' + OX + '" y="' + OY + '" width="' + W + '" height="' + H + '" fill="#1d3b2a"/>' +
    '<line x1="' + OX + '" y1="' + Y(22) + '" x2="' + (OX + W) + '" y2="' + Y(22) +
    '" stroke="#8a9bb0" stroke-width="3"/>' +
    lines + dot;
}

// Export for browser (<script> globals) and node (tests).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { replayDotColor, replayCaption, replaySVG };
}
