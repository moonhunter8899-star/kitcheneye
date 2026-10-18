/* KitchenEye v1 — line-call logic (pure functions, no DOM).
 *
 * Court coordinate system: feet. Origin (0,0) at one corner.
 * x across the court (0..20), y along the court (0..44).
 * Net at y=22. Kitchen (NVZ) lines at y=15 and y=29.
 *
 * Ruling model (matches the human rule "no space clearly seen = can't call out"):
 *   - The ball is IN if its contact point touches a line.
 *   - Touching = within ball radius (1.5in) + line half-width (1in) = 2.5in.
 *   - The TOO CLOSE band (default 4in) around that boundary is the integrity
 *     feature: inside the band we refuse to guess and return TOO CLOSE.
 */
'use strict';

const COURT_W = 20; // ft
const COURT_L = 44; // ft
const IN_PER_FT = 12;

// Contact geometry, in feet.
const BALL_RADIUS_FT = 1.5 / IN_PER_FT;   // pickleball ~2.9in diameter
const LINE_HALF_WIDTH_FT = 1.0 / IN_PER_FT; // lines are 2in wide
const TOUCH_DIST_FT = BALL_RADIUS_FT + LINE_HALF_WIDTH_FT; // 2.5in

// Every painted line on the court, as segments with names.
const SEGMENTS = [
  { name: 'North baseline', x1: 0, y1: 0, x2: COURT_W, y2: 0, boundary: true },
  { name: 'South baseline', x1: 0, y1: COURT_L, x2: COURT_W, y2: COURT_L, boundary: true },
  { name: 'West sideline', x1: 0, y1: 0, x2: 0, y2: COURT_L, boundary: true },
  { name: 'East sideline', x1: COURT_W, y1: 0, x2: COURT_W, y2: COURT_L, boundary: true },
  { name: 'North kitchen line', x1: 0, y1: 15, x2: COURT_W, y2: 15, boundary: false },
  { name: 'South kitchen line', x1: 0, y1: 29, x2: COURT_W, y2: 29, boundary: false },
  { name: 'North centerline', x1: 10, y1: 0, x2: 10, y2: 15, boundary: false },
  { name: 'South centerline', x1: 10, y1: 29, x2: 10, y2: COURT_L, boundary: false },
];

/** Distance from point (px,py) to segment (x1,y1)-(x2,y2). All in feet. */
function distPointToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t)); // clamp to the segment
  }
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Nearest segment to (x,y). Returns {distFt, segment}. */
function nearestSegment(x, y, segments) {
  let best = null;
  let bestD = Infinity;
  for (const s of segments) {
    const d = distPointToSegment(x, y, s.x1, s.y1, s.x2, s.y2);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return { distFt: bestD, segment: best };
}

function insideCourt(x, y) {
  return x >= 0 && x <= COURT_W && y >= 0 && y <= COURT_L;
}

/**
 * Judge a bounce at court coords (x, y) in feet.
 * marginIn: too-close band half-width in inches (default 4).
 * Returns { call: 'IN'|'OUT'|'TOO CLOSE', distIn, line, inside }.
 */
function judge(x, y, marginIn) {
  const marginFt = (typeof marginIn === 'number' ? marginIn : 4) / IN_PER_FT;
  const boundary = SEGMENTS.filter(s => s.boundary);
  const near = nearestSegment(x, y, boundary);
  const inside = insideCourt(x, y);

  // Inside the uncertainty band around the touch boundary: refuse to guess.
  if (Math.abs(near.distFt - TOUCH_DIST_FT) <= marginFt) {
    return { call: 'TOO CLOSE', distIn: near.distFt * IN_PER_FT, line: near.segment.name, inside };
  }
  if (near.distFt <= TOUCH_DIST_FT) {
    return { call: 'IN', distIn: near.distFt * IN_PER_FT, line: near.segment.name, inside }; // touching paint
  }
  return {
    call: inside ? 'IN' : 'OUT',
    distIn: near.distFt * IN_PER_FT,
    line: near.segment.name,
    inside,
  };
}

// Export for browser (<script> globals) and node (tests).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { COURT_W, COURT_L, SEGMENTS, distPointToSegment, nearestSegment, insideCourt, judge, TOUCH_DIST_FT };
}
