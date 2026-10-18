/* KitchenEye — NetSync stub (v2 seam).
 *
 * v1 is single-phone: this module exists only so the multi-phone sync has a
 * clean place to land. Do not build on it yet.
 *
 * v2 plan: one phone taps "Host match" and shows a QR code; the other three
 * scan it and join over the court's WiFi via WebRTC data channels (no server).
 * Phones exchange tiny bounce reports — video never leaves the phone.
 *
 * Message shapes (all numbers, feet + seconds):
 *   { type: 'bounce', x: 12.5, y: 40.2, t: 1717349203.42 }
 *     x,y = court coords (ft, origin at corner, x 0..20, y 0..44),
 *     t   = sender's synced clock (seconds).
 *   { type: 'call', call: 'IN'|'OUT'|'TOO CLOSE', x, y, t, by: 'A' }
 *     broadcast by the judging phone after arbitration.
 *   { type: 'hello', phone: 'A', zone: 'north-left' }
 *     presence on join; zones: north-left, north-right, south-left, south-right.
 *
 * Arbitration rule (v2): duplicate bounces merge when |dt| < 0.25s and the
 * court positions agree within 1.5 ft. The phone nearest the bounce
 * (smallest homography reprojection error / closest camera) wins; its call
 * is broadcast to all screens.
 */
'use strict';

class NetSync {
  constructor() {
    this.connected = false;
    this.onBounce = null; // v2: (msg) => void
    this.onCall = null;   // v2: (msg) => void
  }

  /** v2: host a match, returns a join code / QR payload. */
  hostMatch() {
    throw new Error('NetSync is a v2 stub — 4-phone sync is not built yet.');
  }

  /** v2: join a match hosted by another phone. */
  joinMatch(_code) {
    throw new Error('NetSync is a v2 stub — 4-phone sync is not built yet.');
  }

  /**
   * v1: reports a local bounce. Today this just logs; in v2 it broadcasts
   * { type:'bounce', x, y, t } to the other phones.
   */
  sendBounce(x, y, t) {
    if (typeof console !== 'undefined') {
      console.log('[netsync-stub] bounce', { type: 'bounce', x, y, t });
    }
  }

  leave() {
    this.connected = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NetSync };
}
