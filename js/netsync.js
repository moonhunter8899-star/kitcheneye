/* KitchenEye v2 — multi-phone match sync over WebRTC data channels.
 *
 * Star topology: the phone that taps "Host a match" is the host; the other
 * phones join with a 6-character code and connect only to the host.
 * Exactly one external dependency: PeerJS via CDN (see index.html). If it
 * fails to load, NetSync.peerAvailable() is false and the app hides the
 * multi-phone UI — solo mode works untouched.
 *
 * Video never leaves the phones. Only tiny JSON messages travel:
 *   {t:'hello', name}            joiner -> host on connect
 *   {t:'bounce', x, y, at, size} joiner -> host per bounce (court ft, host clock)
 *   {t:'call', rec, by}          host -> all: the arbitrated call + full record
 *   {t:'who-won', team}         joiner -> host: 'us' | 'them'
 *   {t:'score', state}           host -> all: Score.state()
 *   {t:'start'}                  host -> all: begin judging
 *   {t:'ping', t0} / {t:'pong', t0, t1, t2}  clock sync (joiner <-> host)
 *   {t:'bye'}                    leaving the match
 *
 * Clock sync: the joiner runs 5 ping/pong rounds on connect. With
 * t0 = joiner send, t1 = host receive, t2 = host send, t3 = joiner receive,
 * offset = median(((t1 - t0) + (t2 - t3)) / 2); hostTime = local + offset.
 * The host just uses its own clock.
 *
 * Arbitration (app.js, host side): the first bounce report opens a 300 ms
 * collection window; pickWinner() then picks the report with the largest
 * ball `size` — the closest phone sees the biggest ball, hence the least
 * error. Ties break to the earliest timestamp.
 *
 * Never throws into UI code: async failures go to console.warn + the
 * per-call onErr handler.
 */
'use strict';

var PEER_PREFIX = 'ke-';
var JOIN_TIMEOUT_MS = 30000; // cellular + TURN can take a while; fail with a useful message after 30 s
var CODE_RE = /^[A-Z0-9]{6}$/;

// ICE: Google STUN plus a free TURN relay (Open Relay Project). TURN over
// 443/TCP gets through cellular carrier NATs and locked-down WiFi where
// direct peer-to-peer UDP fails. If the relay is unreachable, ICE simply
// falls back to the other candidates.
var PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    ],
  },
};

function makeCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion
  var s = '';
  var rnd;
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    rnd = crypto.getRandomValues(new Uint8Array(6));
  } else {
    rnd = [0, 1, 2, 3, 4, 5].map(function () { return Math.floor(Math.random() * 32); });
  }
  for (var i = 0; i < 6; i++) s += chars[rnd[i] % chars.length];
  return s;
}

/**
 * Pure: pick the winning bounce report.
 * reports: [{x, y, at, size, from}]. Largest size wins (nearest phone);
 * ties break to the earliest timestamp. Returns null for empty input.
 */
function pickWinner(reports) {
  if (!reports || !reports.length) return null;
  var best = reports[0];
  for (var i = 1; i < reports.length; i++) {
    var r = reports[i];
    var rs = Number.isFinite(r.size) ? r.size : 0;
    var bs = Number.isFinite(best.size) ? best.size : 0;
    if (rs > bs) {
      best = r;
    } else if (rs === bs) {
      var ra = Number.isFinite(r.at) ? r.at : Infinity;
      var ba = Number.isFinite(best.at) ? best.at : Infinity;
      if (ra < ba) best = r;
    }
  }
  return best;
}

class NetSync {
  constructor() {
    this.role = null;      // 'host' | 'joiner'
    this.peer = null;      // PeerJS Peer
    this.conn = null;      // joiner: the single DataConnection to the host
    this.peers = new Map();// host: peerId -> {conn, name}
    this.code = null;
    this.name = '';
    this.clockOffset = 0;  // joiner: hostTime = localTime + offset (seconds)
    this.onJoinCb = null;
    this.onLeaveCb = null;
    this.onMessageCb = null;  // joiner: incoming host message
    this.onHostMsgCb = null;  // host: (peerId, msg)
    this.onServerCb = null;   // cb(up) on signaling-server link state
    this.onVideoCb = null;    // host: (peerId, stream) a joiner's monitor feed arrived
    this.onVideoEndCb = null; // host: (peerId) a joiner's monitor feed ended
    this.mediaCall = null;    // joiner: the outgoing MediaConnection to the host
    this._pingCb = null;
  }

  static peerAvailable() {
    return typeof Peer !== 'undefined';
  }

  _err(onErr, e) {
    try { console.warn('[netsync]', (e && e.message) || e); } catch (_) {}
    if (onErr && !this._errSilenced) { try { onErr(e); } catch (_) {} }
  }

  // ---------------- host ----------------

  /** cb(up:boolean) — true when the server link is (re)established. */
  onServer(cb) { this.onServerCb = cb; }

  // ---------------- host ----------------

  /** Create a room. Resolves with the 6-char join code when the peer opens. */
  async hostRoom(onErr) {
    var self = this;
    return new Promise(function (resolve, reject) {
      if (!NetSync.peerAvailable()) {
        var e0 = new Error('PeerJS unavailable');
        self._err(onErr, e0); reject(e0); return;
      }
      self.role = 'host';
      self.code = makeCode();
      var peer;
      try {
        peer = new Peer(PEER_PREFIX + self.code, PEER_CONFIG);
      } catch (e) {
        self._err(onErr, e); reject(e); return;
      }
      self.peer = peer;
      peer.on('open', function () {
        resolve(self.code);
        if (self.onServerCb) { try { self.onServerCb(true); } catch (e2) {} }
      });
      peer.on('connection', function (conn) { self._hostAccept(conn); });
      peer.on('call', function (call) { self._hostAcceptCall(call); });
      peer.on('error', function (e) { self._err(onErr, e); });
      peer.on('disconnected', function () {
        if (self.onServerCb) { try { self.onServerCb(false); } catch (e2) {} }
        try { peer.reconnect(); } catch (e3) {} // re-registers the same room code
      });
    });
  }

  _hostAccept(conn) {
    var self = this;
    conn.on('open', function () {
      self.peers.set(conn.peer, { conn: conn, name: 'Phone', announced: false });
      conn.on('data', function (msg) { self._hostData(conn.peer, msg); });
      conn.on('close', function () { self._hostDrop(conn.peer); });
      conn.on('error', function () { self._hostDrop(conn.peer); });
      // Prompt the joiner to (re)send hello — its first hello may have
      // arrived before this data handler was attached.
      try { if (conn.open) conn.send({ t: 'welcome' }); } catch (e) {}
    });
  }

  /** Host: accept an incoming monitor-video call (receive-only, no local stream). */
  _hostAcceptCall(call) {
    var self = this;
    try { call.answer(); } catch (e) { return; } // no stream -> recvonly
    call.on('stream', function (stream) {
      if (self.onVideoCb) { try { self.onVideoCb(call.peer, stream); } catch (e2) {} }
    });
    var ended = function () {
      if (self.onVideoEndCb) { try { self.onVideoEndCb(call.peer); } catch (e2) {} }
    };
    call.on('close', ended);
    call.on('error', function () {});
  }

  /** cb(peerId, stream) — a joiner's monitor feed arrived. */
  onVideo(cb) { this.onVideoCb = cb; }
  /** cb(peerId) — a joiner's monitor feed ended. */
  onVideoEnd(cb) { this.onVideoEndCb = cb; }

  /**
   * Joiner: publish a (low-res) monitor stream to the host so the host can
   * see this phone's camera. Replaces the video track if a call is already up.
   */
  joinerCallHost(monitorStream) {
    if (this.role !== 'joiner' || !this.peer || this.peer.destroyed || !monitorStream) return;
    var self = this;
    try {
      var track = monitorStream.getVideoTracks()[0];
      if (this.mediaCall && this.mediaCall.open && track) {
        var pc = this.mediaCall.peerConnection;
        var sender = pc && pc.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
        if (sender) { sender.replaceTrack(track); return; }
      }
      try { if (this.mediaCall) this.mediaCall.close(); } catch (e) {}
      this.mediaCall = this.peer.call(PEER_PREFIX + this.code, monitorStream);
      if (this.mediaCall) {
        // Keep the monitor feed light: small thumbnail, few fps is plenty.
        this.mediaCall.on('stream', function () {});
        var iv = setInterval(function () {
          var pc2 = self.mediaCall && self.mediaCall.peerConnection;
          var s2 = pc2 && pc2.getSenders().find(function (s) { return s.track && s.track.kind === 'video'; });
          if (s2) {
            try {
              var par = s2.getParameters();
              par.encodings = [{ maxBitrate: 350000, maxFramerate: 10 }];
              s2.setParameters(par);
            } catch (e) {}
            clearInterval(iv);
          }
          if (!self.mediaCall || !self.mediaCall.open) clearInterval(iv);
        }, 1000);
      }
    } catch (e) {}
  }

  _hostData(peerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    var p = this.peers.get(peerId);
    if (msg.t === 'ping') {
      // Clock-sync reply: t1 = host receive, t2 = host send.
      var t1 = nowS();
      try {
        var t2 = nowS();
        if (p && p.conn.open) p.conn.send({ t: 'pong', t0: msg.t0, t1: t1, t2: t2 });
      } catch (e) {}
      return;
    }
    if (msg.t === 'hello') {
      if (p) p.name = String(msg.name || 'Phone').slice(0, 24);
      // Idempotent: the joiner may hello twice (on open + on welcome).
      if (p && !p.announced) {
        p.announced = true;
        if (this.onJoinCb) { try { this.onJoinCb(peerId, p.name); } catch (e) {} }
      }
      return;
    }
    if (this.onHostMsgCb) { try { this.onHostMsgCb(peerId, msg); } catch (e) {} }
  }

  _hostDrop(peerId) {
    var p = this.peers.get(peerId);
    this.peers.delete(peerId);
    if (this.onLeaveCb) { try { this.onLeaveCb(peerId, p && p.name); } catch (e) {} }
  }

  /** cb(peerId, name) per joiner that completes its hello. */
  onJoin(cb) { this.onJoinCb = cb; }
  /** cb(peerId, name) when a joiner leaves. */
  onLeave(cb) { this.onLeaveCb = cb; }
  /** cb(peerId, msg) for joiner messages (bounce, who-won, …). */
  onHostMessage(cb) { this.onHostMsgCb = cb; }

  eachPeer(fn) {
    this.peers.forEach(function (p, id) { try { fn(id, p); } catch (e) {} });
  }

  broadcast(msg) {
    this.eachPeer(function (id, p) {
      try { if (p.conn.open) p.conn.send(msg); } catch (e) {}
    });
  }

  // ---------------- joiner ----------------

  /**
   * Join a room. Resolves with the host DataConnection on open;
   * rejects after 15 s (or promptly on a bad code / dead server /
   * unknown room). IMPORTANT: peer.connect() must wait for the peer's
   * 'open' event — connecting earlier silently drops the WebRTC offer
   * (PeerJS Socket.send drops while the socket hasn't started).
   */
  async joinRoom(code, name, onErr) {
    var self = this;
    var clean = String(code || '').toUpperCase().trim();
    return new Promise(function (resolve, reject) {
      if (!NetSync.peerAvailable()) {
        var e0 = new Error('PeerJS unavailable');
        self._err(onErr, e0); reject(e0); return;
      }
      if (!CODE_RE.test(clean)) {
        var e1 = new Error('bad code');
        self._err(onErr, e1); reject(e1); return;
      }
      self.role = 'joiner';
      self.name = String(name || 'Phone').slice(0, 24) || 'Phone';
      self.code = clean;
      var peer;
      try {
        peer = new Peer(PEER_CONFIG);
      } catch (e) {
        self._err(onErr, e); reject(e); return;
      }
      self.peer = peer;
      var conn = null;
      var done = false;
      function fail(e) {
        if (done) return;
        done = true; clearTimeout(timer);
        self._err(onErr, e);
        try { if (conn) conn.close(); } catch (_) {}
        try { peer.destroy(); } catch (_) {}
        reject(e);
      }
      var timer = setTimeout(function () {
        fail(new Error('join timed out'));
      }, JOIN_TIMEOUT_MS);
      peer.on('open', function () {
        if (done) return;
        var c;
        try {
          c = peer.connect(PEER_PREFIX + clean, { reliable: true });
        } catch (e) { fail(e); return; }
        conn = c;
        self.conn = c;
        c.on('open', function () {
          if (done) return;
          done = true; clearTimeout(timer);
          self._errSilenced = true; // later hiccups have their own paths; don't rewrite the status
          c.on('data', function (msg) { self._joinerData(msg); });
          c.on('close', function () {
            if (self.onLeaveCb) { try { self.onLeaveCb(); } catch (e2) {} }
          });
          try { c.send({ t: 'hello', name: self.name }); } catch (e2) {}
          // Clock sync is best-effort: resolve either way so a flaky sync
          // never blocks joining the match.
          self._syncClock().then(
            function () { resolve(c); },
            function () { resolve(c); }
          );
        });
        c.on('error', function (e) { fail(e); });
      });
      peer.on('error', function (e) {
        // Before connect: server/network errors. After connect: a wrong
        // code surfaces here as 'peer-unavailable' — fail fast instead of
        // hanging until the 15 s timeout.
        if (!done && (!conn || !conn.open)) fail(e);
        else self._err(onErr, e);
      });
      peer.on('disconnected', function () { try { peer.reconnect(); } catch (e2) {} });
    });
  }

  _joinerData(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'pong' && this._pingCb) {
      try { this._pingCb(msg); } catch (e) {}
      return;
    }
    if (msg.t === 'welcome') {
      // Host is ready for our hello (its data handler may have missed the
      // one we sent on open). Harmless to send twice — the host dedups.
      try { this.send({ t: 'hello', name: this.name }); } catch (e) {}
      return;
    }
    if (this.onMessageCb) { try { this.onMessageCb(msg); } catch (e) {} }
  }

  /** cb(msg) for host messages (call, score, start, bye). */
  onMessage(cb) { this.onMessageCb = cb; }

  send(msg) {
    try {
      if (this.conn && this.conn.open) this.conn.send(msg);
    } catch (e) {
      try { console.warn('[netsync] send failed', e); } catch (_) {}
    }
  }

  /** 5 ping/pong rounds; offset = median(((t1-t0)+(t2-t3))/2). Seconds. */
  async _syncClock() {
    var offs = [];
    for (var i = 0; i < 5; i++) {
      try {
        var off = await this._onePing();
        if (Number.isFinite(off)) offs.push(off);
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 120); });
    }
    if (offs.length) {
      offs.sort(function (a, b) { return a - b; });
      this.clockOffset = offs[Math.floor(offs.length / 2)];
    }
    return this.clockOffset;
  }

  _onePing() {
    var self = this;
    return new Promise(function (resolve, reject) {
      var t0 = nowS();
      var timer = setTimeout(function () {
        cleanup();
        reject(new Error('ping timeout'));
      }, 3000);
      function onPong(msg) {
        if (msg && msg.t === 'pong' && msg.t0 === t0) {
          var t3 = nowS();
          cleanup();
          resolve(((msg.t1 - t0) + (msg.t2 - t3)) / 2);
        }
      }
      function cleanup() {
        clearTimeout(timer);
        if (self._pingCb === onPong) self._pingCb = null;
      }
      self._pingCb = onPong;
      try {
        self.send({ t: 'ping', t0: t0 });
      } catch (e) {
        cleanup(); reject(e);
      }
    });
  }

  /** Map a local timestamp to the host clock. Host: identity. */
  toHostTime(t) {
    return this.role === 'joiner' ? t + this.clockOffset : t;
  }

  close() {
    try {
      if (this.role === 'host') this.broadcast({ t: 'bye' });
      else if (this.conn) this.conn.send({ t: 'bye' });
    } catch (e) {}
    try { if (this.conn) this.conn.close(); } catch (e) {}
    try { if (this.mediaCall) this.mediaCall.close(); } catch (e) {}
    this.mediaCall = null;
    this.eachPeer(function (id, p) { try { p.conn.close(); } catch (e2) {} });
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peers.clear();
    this.conn = null;
    this.peer = null;
    this.role = null;
    this.code = null;
    this._pingCb = null;
    this._errSilenced = false;
    this.onServerCb = null;
    this.onVideoCb = null;
    this.onVideoEndCb = null;
  }
}

/** Monotonic seconds, shared by host + joiner clock math. */
function nowS() {
  if (typeof performance !== 'undefined' && performance.now) return performance.now() / 1000;
  return Date.now() / 1000;
}

// Export for browser (<script> globals) and node (tests).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NetSync, pickWinner };
}
