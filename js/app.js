/* KitchenEye v1 — app state machine + wiring.
 *
 * Screens: home -> camera (scan) -> calibrate (tap ball) -> judge (live).
 * scan.js, track.js, call.js, netsync.js are plain <script> globals.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const S = {
    screen: 'home',
    stream: null,
    video: null,
    overlay: null, octx: null,
    proc: null, pctx: null,           // 480p processing canvas
    H: null,                          // homography: 480-px space -> court ft
    detScale: 1,                      // video px per 480-px (uniform)
    courtName: 'home-court',
    tracker: null,
    net: null,               // v2: NetSync session, or null in solo mode
    netRole: null,           // v2: 'host' | 'joiner'
    netPeers: [],            // v2 host: [{id, name}] of joined phones
    netDead: false,          // v2 joiner: host vanished mid-match
    camsLocked: false,       // v2 host: director confirmed all camera feeds
    hostCorner: null,        // v2 host: the zone this phone covers
    myCorner: null,          // v2 joiner: declared corner TL|TR|BL|BR (T|B in singles)
    takenCorners: [],        // v2 joiner: corners already claimed by other phones
    matchFormat: 'doubles',  // v2 host: 'singles' (2 phones) | 'doubles' (4 phones)
    arb: null,               // v2 host: bounce-arbitration window state
    pendingStart: false,     // v2 joiner: host started while we were scanning
    lastWhoWonAt: 0,         // v2 host: debounce cross-phone who-won taps
    armed: false,
    marginIn: 4,
    judging: false,
    lastCallAt: 0,
    audio: null,
    manualTaps: [],
    calls: [],              // dispute-replay records (persisted)
    replayId: null,
    ballPreset: 'franklin-x40',   // auto ball-color preset (tap refines it)
    score: null,            // Score instance (js/score.js)
    scorePrefs: { mode: 'doubles', target: 11, teamUs: 'Us', teamThem: 'Them', speech: false },
  };

  function showScreen(name) {
    S.screen = name;
    ['home', 'camera', 'calibrate', 'judge', 'replay', 'lobby', 'scanqr'].forEach(n => {
      const el = $('screen-' + n);
      if (el) el.classList.toggle('hidden', n !== name);
    });
    window.scrollTo(0, 0);
  }

  function err(msg) {
    const e = $('cam-error');
    if (e) { e.textContent = msg; e.classList.remove('hidden'); }
    const r = $('btn-retry-cam');
    if (r) r.classList.remove('hidden');
  }
  function clearErr() {
    const e = $('cam-error');
    if (e) e.classList.add('hidden');
    const r = $('btn-retry-cam');
    if (r) r.classList.add('hidden');
  }

  // ---------- audio ----------
  function beep(freq, dur, when) {
    try {
      if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
      const t = S.audio.currentTime + (when || 0);
      const o = S.audio.createOscillator();
      const g = S.audio.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(S.audio.destination);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) { /* audio unavailable: calls still show visually */ }
  }
  function callSound(call) {
    if (call === 'IN') beep(880, 0.18, 0);
    else if (call === 'OUT') beep(220, 0.35, 0);
    else { beep(660, 0.12, 0); beep(660, 0.12, 0.18); }
  }

  // ---------- camera ----------
  async function startCamera() {
    clearErr();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1280 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
      S.stream = stream;
      S.video.srcObject = stream;
      S.video.muted = true;
      S.video.playsInline = true;
      try { await S.video.play(); } catch (e) { /* checked below */ }
      if (S.video.paused) {
        err('The camera started but the preview did not. Tap Retry — and check no other app is using the camera.');
        return false;
      }
      sizeOverlay();
      if (S.netRole === 'host') renderLobby();
      return true;
    } catch (e) {
      console.warn('camera failed', e);
      err('Camera blocked. KitchenEye needs camera access to judge lines. ' +
          'Allow camera permission for this site (it runs over HTTPS, video never leaves your phone), then tap Retry. ' +
          (location.protocol !== 'https:' && location.hostname !== 'localhost'
            ? 'Note: camera requires HTTPS or localhost.' : ''));
      return false;
    }
  }

  function sizeOverlay() {
    const v = S.video;
    if (!v || !v.videoWidth) return;
    S.overlay.width = v.videoWidth;
    S.overlay.height = v.videoHeight;
    S.detScale = v.videoWidth / 480; // 480-space -> video px (uniform, same aspect)
    // processing canvas: 480 wide, same aspect as video
    S.proc.width = 480;
    S.proc.height = Math.round(480 * v.videoHeight / v.videoWidth);
  }

  const v2px = (p480) => ({ x: p480.x * S.detScale, y: p480.y * S.detScale });
  const px2v = (x, y) => ({ x: x / S.detScale, y: y / S.detScale }); // video px -> 480-space

  // The overlay canvas stays transparent: the live <video> shows through it
  // and we only paint markers (scan quad, manual tap dots) on top.
  function clearOverlay() {
    if (!S.overlay || !S.octx) return;
    S.octx.clearRect(0, 0, S.overlay.width, S.overlay.height);
  }

  // ---------- scan ----------
  // Fire one automatic scan shortly after the camera opens, so the user
  // just aims at the court. Skipped when a result/confirm is already up.
  function autoScanSoon() {
    clearTimeout(S.autoScanT);
    S.autoScanT = setTimeout(() => {
      if (S.screen !== 'camera' || S.tapping || S.pendingScan) return;
      if (!$('scan-confirm').classList.contains('hidden')) return;
      runScan();
    }, 2500);
  }

  async function runScan() {
    clearTimeout(S.autoScanT); // a scan is starting; cancel any pending auto-scan
    // Retry a few times (the phone may still be moving); loosen the bar on
    // later tries — the human "looks right?" confirm stays the safety net.
    let res = null, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      setStatus('scan-status', 'Scanning… hold the phone steady, court empty.' +
        (attempt > 1 ? ' (try ' + attempt + ' of 3)' : ''));
      try {
        await new Promise(r => setTimeout(r, 60)); // let the status paint
        res = detectCourt(S.video, SEGMENTS, attempt === 1 ? SCORE_MIN : 0.18);
      } catch (e) { lastErr = e; console.warn('scan failed', e); }
      if (!res && attempt < 3) await new Promise(r => setTimeout(r, 1200));
    }
    if (!res) {
      // Manual taps always work — drop straight in instead of asking.
      setStatus('scan-status', "Auto-scan couldn't lock onto these lines — tap the 4 corners on the live view below." +
        (lastErr ? ' (' + lastErr.message + ')' : ''));
      startManual();
      return;
    }
    S.pendingScan = res;
    clearOverlay(); // green quad is drawn over the LIVE video underneath
    const c = S.octx;
    c.strokeStyle = '#39ff88'; c.lineWidth = Math.max(3, S.overlay.width / 200);
    c.beginPath();
    res.corners.forEach((p, i) => {
      const q = v2px(p);
      if (i === 0) c.moveTo(q.x, q.y); else c.lineTo(q.x, q.y);
    });
    c.closePath(); c.stroke();
    res.corners.forEach(p => {
      const q = v2px(p);
      c.fillStyle = '#39ff88';
      c.beginPath(); c.arc(q.x, q.y, c.lineWidth * 2, 0, 7); c.fill();
    });
    setStatus('scan-status', 'Court found (match ' + Math.round(res.score * 100) + '%). Does the green box sit on the court lines?');
    $('scan-confirm').classList.remove('hidden');
  }

  function confirmScan() {
    const res = S.pendingScan;
    if (!res) return;
    S.H = res.H;
    persistCourt();
    $('scan-confirm').classList.add('hidden');
    // v2: tell the host where this phone stands (director wall), and make
    // sure the monitor feed is up.
    if (S.netRole === 'joiner' && S.net) {
      const p = cameraCourtPos();
      if (p) { try { S.net.send({ t: 'campos', x: +p.x.toFixed(1), y: +p.y.toFixed(1) }); } catch (e) {} }
    }
    if (S.netRole === 'host') renderLobby();
    // Cross-check: does the scan agree with the tapped corner/half?
    let cornerWarn = null;
    if (S.netRole === 'joiner' && S.myCorner) {
      const p = cameraCourtPos();
      let ok = true;
      if (p) {
        ok = S.myCorner.length === 1
          ? ((p.y < 22) === (S.myCorner === 'T'))
          : (cornerQuadrant(p) === S.myCorner);
      }
      if (!ok) {
        cornerWarn = 'Heads up: your scan disagrees with ' + CORNERS[S.myCorner].label +
          ' — if the court looks wrong, rescan.';
      }
    }
    proceedAfterScan(cornerWarn);
  }

  // Single routing point after any scan path (auto, manual taps, resume):
  // joiners go camera-only, everyone else to ball calibration.
  function proceedAfterScan(cornerWarn) {
    if (S.netRole === 'joiner') {
      // Join phones are done: position picked, court scanned. The host does
      // ball color, arming, and scoring — we just track and report.
      enterCameraOnly(cornerWarn);
      return;
    }
    enterCalibrate();
    if (cornerWarn) {
      const el = $('cal-status');
      if (el) el.textContent = cornerWarn + ' ' + el.textContent;
    }
  }

  function persistCourt() {
    try {
      const corners480 = S.manualCorners || (S.pendingScan && S.pendingScan.corners);
      saveCourt(S.courtName, S.H, corners480, 480, S.proc.height || 270);
    } catch (e) { console.warn('persist failed', e); }
  }

  // ---------- manual corner taps ----------
  function startManual() {
    clearTimeout(S.autoScanT); // user took over; no auto-scan
    S.manualTaps = [];
    clearOverlay();
    setStatus('scan-status', 'You see the court live — tap the 4 corners in order: near-left, near-right, far-right, far-left.');
    S.tapping = true;
  }

  function onOverlayTap(ev) {
    if (!S.tapping || S.screen !== 'camera') return;
    const r = S.overlay.getBoundingClientRect();
    const vx = (ev.clientX - r.left) / r.width * S.overlay.width;
    const vy = (ev.clientY - r.top) / r.height * S.overlay.height;
    const p = px2v(vx, vy);
    S.manualTaps.push(p);
    const c = S.octx;
    const q = v2px(p);
    c.fillStyle = '#ffd24d';
    c.beginPath(); c.arc(q.x, q.y, 10, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.font = 'bold 28px sans-serif';
    c.fillText(String(S.manualTaps.length), q.x - 9, q.y + 10);
    if (S.manualTaps.length === 4) {
      S.tapping = false;
      try {
        S.H = buildFromCorners(S.manualTaps);
        S.manualCorners = S.manualTaps.slice();
        S.pendingScan = null;
        setStatus('scan-status', 'Corners set. Tap "Start judging setup" to continue.');
        $('scan-done-manual').classList.remove('hidden');
      } catch (e) {
        setStatus('scan-status', 'Those corners do not form a valid quad — tap "Tap corners manually" and try again.');
        S.manualTaps = [];
      }
    }
  }

  // ---------- ball calibration ----------
  function presetLabel() {
    const p = (typeof BALL_PRESETS !== 'undefined') && BALL_PRESETS[S.ballPreset];
    return p ? p.label : 'custom color';
  }

  function enterCalibrate() {
    showScreen('calibrate');
    drawCalPreview();
    selectPreset(S.ballPreset || 'franklin-x40');
    const sj = $('btn-start-judge');
    if (sj) sj.textContent = (S.netRole === 'host' || S.netRole === 'joiner') ? 'Continue' : 'Start judging';
  }

  // Apply a known ball color; then check the live view for a ball so the
  // user gets confirmation without having to tap anything.
  function selectPreset(name) {
    S.ballPreset = name;
    S.tracker.calibratePreset(name);
    // v2: the host owns the ball color; joiner cameras follow silently.
    if (S.netRole === 'host' && S.net) {
      try { S.net.broadcast({ t: 'ball', preset: name }); } catch (e) {}
    }
    document.querySelectorAll('#preset-row .preset').forEach(b =>
      b.classList.toggle('active', b.dataset.preset === name));
    setStatus('cal-status', 'Ball color: ' + presetLabel() + '. Hold a ball in view — checking…');
    clearTimeout(S.verifyT);
    S.verifyT = setTimeout(verifyBall, 900);
  }

  function verifyBall() {
    if (S.screen !== 'calibrate') return;
    try {
      const v = S.video;
      if (!v || !v.videoWidth) return;
      S.proc.width = 480;
      S.proc.height = Math.round(480 * v.videoHeight / v.videoWidth);
      let found = 0;
      for (let k = 0; k < 3; k++) {
        S.pctx.drawImage(v, 0, 0, S.proc.width, S.proc.height);
        const img = S.pctx.getImageData(0, 0, S.proc.width, S.proc.height);
        if (S.tracker.detect(img, S.proc.width, S.proc.height)) found++;
      }
      if (found > 0) {
        setStatus('cal-status', 'Ball found (' + presetLabel() + ') — tap "Start judging".');
      } else {
        setStatus('cal-status', 'No ball in view yet — hold one up, or tap the ball in the picture to teach it.');
      }
    } catch (e) { /* leave the status as-is */ }
  }

  function drawCalPreview() {
    const v = S.video;
    if (!v || !v.videoWidth) return;
    S.proc.width = 480;
    S.proc.height = Math.round(480 * v.videoHeight / v.videoWidth);
    S.pctx.drawImage(v, 0, 0, S.proc.width, S.proc.height);
    const c = $('cal-canvas');
    c.width = S.proc.width; c.height = S.proc.height;
    c.getContext('2d').drawImage(S.proc, 0, 0);
  }

  function onCalTap(ev) {
    const c = $('cal-canvas');
    const r = c.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * c.width;
    const y = (ev.clientY - r.top) / r.height * c.height;
    try {
      const img = S.pctx.getImageData(0, 0, S.proc.width, S.proc.height);
      S.tracker.calibrateFromTap(img, S.proc.width, S.proc.height, x, y);
      // show what got sampled
      const g = c.getContext('2d');
      g.strokeStyle = '#39ff88'; g.lineWidth = 3;
      g.strokeRect(x - 8, y - 8, 16, 16);
      S.ballPreset = 'custom';
      document.querySelectorAll('#preset-row .preset').forEach(b => b.classList.remove('active'));
      setStatus('cal-status', 'Custom color learned from your tap. Tap "Start judging".');
    } catch (e) {
      setStatus('cal-status', 'Could not sample there — tap directly on the ball.');
    }
  }

  // ---------- judging ----------
  // Joiner done-state: a minimal tracking screen. The judge loop runs
  // (same screen name, so detection + reporting work), but all the
  // scoring/arming UI is hidden — the host runs the match.
  function enterCameraOnly(warn) {
    showScreen('judge');
    const sj = $('screen-judge');
    sj.classList.add('camera-only');
    sj.classList.remove('host-view');
    S.armed = false;
    hideWhoWon();
    try { S.tracker.calibratePreset(S.ballPreset || 'franklin-x40'); } catch (e) {}
    const label = (S.myCorner && CORNERS[S.myCorner]) ? CORNERS[S.myCorner].label : 'Camera';
    setStatus('judge-status', '\uD83D\uDCF7 ' + label + ' camera — tracking for the host. You\u2019re all set.' +
      (warn ? ' ' + warn : ''));
    $('btn-cam-rescan').classList.remove('hidden');
    drawMiniCourt(null);
    if (!S.judging) { S.judging = true; requestAnimationFrame(judgeLoop); }
  }

  function enterJudge() {
    showScreen('judge');
    $('screen-judge').classList.remove('camera-only');
    $('btn-cam-rescan').classList.add('hidden');
    // Host = the judge's chair: one big court picture with the ball trail
    // and landing spot (Hawk-Eye style). Its camera keeps tracking with the
    // video element hidden.
    $('screen-judge').classList.toggle('host-view', S.netRole === 'host');
    S.armed = false;
    hideWhoWon();
    updateArmUI();
    renderScoreboard();
    drawMiniCourt(null);
    // Live view on the judge screen: same stream, own video element, so the
    // user watches the ball get tracked (green ring + trail) in real time.
    try {
      const jv = $('judge-video');
      if (jv && S.stream) {
        if (jv.srcObject !== S.stream) jv.srcObject = S.stream;
        jv.play().catch(function () {});
      }
      sizeJudgeOverlay();
    } catch (e) {}
    setStatus('judge-status', 'Tap "Start point", then serve. The phone calls each bounce.');
    if (!S.judging) { S.judging = true; requestAnimationFrame(judgeLoop); }
  }

  function judgeLoop(ts) {
    if (S.screen !== 'judge') { S.judging = false; return; }
    S.judging = true;
    try {
      const v = S.video;
      if (v && v.videoWidth && v.readyState >= 2) {
        if (S.proc.width !== 480) sizeOverlay();
        const jo = $('judge-overlay');
        if (jo && (jo.width !== v.videoWidth || jo.height !== v.videoHeight)) sizeJudgeOverlay();
        S.pctx.drawImage(v, 0, 0, S.proc.width, S.proc.height);
        const img = S.pctx.getImageData(0, 0, S.proc.width, S.proc.height);
        const nowS = ts / 1000;
        const det = S.tracker.detect(img, S.proc.width, S.proc.height);
        const bounce = S.tracker.update(det, nowS);
        drawJudgeOverlay(det);
        if (bounce && S.armed) onBounce(bounce);
        // ball dead = track lost while armed -> stay armed, waiting on serve
      }
    } catch (e) { console.warn('judge frame failed', e); }
    requestAnimationFrame(judgeLoop);
  }

  function sizeJudgeOverlay() {
    const v = S.video, jo = $('judge-overlay');
    if (!v || !v.videoWidth || !jo) return;
    jo.width = v.videoWidth;
    jo.height = v.videoHeight;
    S.jctx = jo.getContext('2d');
  }

  function drawJudgeOverlay(det) {
    const c = S.jctx || S.octx, W = (S.jctx ? $('judge-overlay').width : S.overlay.width),
          Hh = (S.jctx ? $('judge-overlay').height : S.overlay.height);
    if (!c) return;
    c.clearRect(0, 0, W, Hh);
    if (det && S.tracker.hasTrack) {
      const q = v2px(det);
      c.strokeStyle = '#39ff88'; c.lineWidth = 3;
      c.beginPath(); c.arc(q.x, q.y, 22, 0, 7); c.stroke();
    }
    // trail
    c.fillStyle = 'rgba(57,255,136,0.5)';
    for (const p of S.tracker.hist.slice(-8)) {
      const q = v2px(p);
      c.beginPath(); c.arc(q.x, q.y, 5, 0, 7); c.fill();
    }
  }

  // Build the dispute-replay record for a judged bounce (shared solo + net).
  function buildCallRecord(cx, cy, res, trail) {
    return {
      id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      at: Date.now(),
      x: Math.round(cx * 100) / 100,
      y: Math.round(cy * 100) / 100,
      distIn: Math.round(res.distIn * 10) / 10,
      line: res.line,
      call: res.call,
      inside: res.inside,
      marginIn: S.marginIn,
      trail: trail || null,
    };
  }

  // Render a call everywhere it needs to go: banner, sound, history.
  function handleCall(rec) {
    const res = { call: rec.call, distIn: rec.distIn, line: rec.line, inside: rec.inside };
    showCall(res, rec.x, rec.y, rec.trail);
    callSound(rec.call);
    S.calls.unshift(rec);
    if (S.calls.length > 100) S.calls.length = 100;
    saveCalls();
    renderHistory();
    S.lastCallAt = performance.now();
  }

  function netActive() {
    return !!S.net && !S.netDead && (S.netRole === 'host' || S.netRole === 'joiner');
  }

  function onBounce(b) {
    let cx, cy;
    try {
      [cx, cy] = applyHomography(S.H, b.x, b.y);
    } catch (e) { return; }
    // Ignore bounces far from the court (another court, dead ball rolling).
    if (cx < -8 || cx > 28 || cy < -8 || cy > 52) return;
    if (S.netDead) return; // session died: never fall back to guessing locally
    const size = (b && Number.isFinite(b.size)) ? b.size : 0;
    const trail = courtTrail();
    if (netActive()) {
      // v2: report to the host; every phone renders calls only from {t:'call'}.
      const at = S.net.toHostTime(b.t);
      if (S.netRole === 'host') {
        hostCollectBounce({ x: cx, y: cy, at: at, size: size, from: 'host', trail: trail });
      } else {
        try { S.net.send({ t: 'bounce', x: cx, y: cy, at: at, size: size, trail: trail }); } catch (e) {}
      }
      return;
    }
    // Solo: judge and show locally, exactly as before.
    const res = judge(cx, cy, S.marginIn);
    handleCall(buildCallRecord(cx, cy, res, trail));
  }

  // ---- v2 host: bounce arbitration. First report opens a 300 ms window;
  // pickWinner() takes the largest ball (nearest phone = least error).
  function hostCollectBounce(report) {
    if (!S.arb) S.arb = { reports: [], timer: null, lastCallAt: 0, lastCallPos: null };
    const A = S.arb;
    A.reports.push(report);
    if (A.timer) return;
    A.timer = setTimeout(() => {
      A.timer = null;
      const reports = A.reports;
      A.reports = [];
      const win = pickWinner(reports);
      if (!win) return;
      const now = performance.now();
      if (now - A.lastCallAt < 600 && A.lastCallPos &&
          Math.hypot(win.x - A.lastCallPos.x, win.y - A.lastCallPos.y) < 1.5) {
        return; // same bounce arriving as a second window: duplicate
      }
      A.lastCallAt = now;
      A.lastCallPos = { x: win.x, y: win.y };
      const res = judge(win.x, win.y, S.marginIn);
      const rec = buildCallRecord(win.x, win.y, res, win.trail);
      try { S.net.broadcast({ t: 'call', rec: rec, by: 'host' }); } catch (e) {}
      handleCall(rec);
    }, 300);
  }

  function showCall(res, cx, cy, trail) {
    const banner = $('call-banner');
    banner.textContent = res.call;
    banner.className = 'banner show ' + res.call.toLowerCase().replace(' ', '-');
    $('call-detail').textContent =
      res.line + ' · ' + res.distIn.toFixed(1) + ' in from paint · at (' +
      cx.toFixed(1) + ', ' + cy.toFixed(1) + ') ft';
    drawMiniCourt({ x: cx, y: cy, call: res.call, trail: trail });
    clearTimeout(S.bannerT);
    S.bannerT = setTimeout(() => banner.classList.remove('show'), 3500);
  }

  function drawMiniCourt(bounce) {
    const svg = $('mini-court');
    if (!svg) return;
    const sx = 200 / 20, sy = 300 / 44; // fit 200x300 viewBox
    let dots = '';
    if (bounce) {
      const color = bounce.call === 'IN' ? '#39ff88' : bounce.call === 'OUT' ? '#ff5d5d' : '#ffd24d';
      // Ball trail, oldest -> newest, growing and brightening.
      if (bounce.trail && bounce.trail.length) {
        const n = bounce.trail.length;
        dots = bounce.trail.map((p, i) => {
          const o = (i + 1) / n;
          return '<circle cx="' + (p[0] * sx).toFixed(1) + '" cy="' + (p[1] * sy).toFixed(1) +
                 '" r="' + (3 + o * 4).toFixed(1) + '" fill="#39ff88" opacity="' + (0.2 + o * 0.6).toFixed(2) + '"/>';
        }).join('');
      }
      dots += '<circle class="landing-pulse" cx="' + (bounce.x * sx).toFixed(1) + '" cy="' + (bounce.y * sy).toFixed(1) +
             '" r="10" fill="' + color + '" stroke="#fff" stroke-width="2.5"/>';
    }
    svg.innerHTML =
      '<rect x="0" y="0" width="200" height="300" fill="#1d3b2a"/>' +
      '<text x="100" y="16" fill="#9fb3d9" font-size="11" text-anchor="middle">TOP</text>' +
      '<text x="100" y="292" fill="#9fb3d9" font-size="11" text-anchor="middle">BOTTOM</text>' +
      '<rect x="4" y="4" width="192" height="292" fill="none" stroke="#fff" stroke-width="3"/>' +
      '<line x1="4" y1="' + (15 * sy) + '" x2="196" y2="' + (15 * sy) + '" stroke="#fff" stroke-width="2"/>' +
      '<line x1="4" y1="' + (29 * sy) + '" x2="196" y2="' + (29 * sy) + '" stroke="#fff" stroke-width="2"/>' +
      '<line x1="100" y1="4" x2="100" y2="' + (15 * sy) + '" stroke="#fff" stroke-width="2"/>' +
      '<line x1="100" y1="' + (29 * sy) + '" x2="100" y2="296" stroke="#fff" stroke-width="2"/>' +
      '<line x1="4" y1="150" x2="196" y2="150" stroke="#888" stroke-width="3"/>' + dots;
  }

  // ---------- call history + dispute replay ----------
  const CALLS_KEY = 'kitcheneye.calls.v1';

  function saveCalls() {
    try { localStorage.setItem(CALLS_KEY, JSON.stringify(S.calls)); }
    catch (e) { /* storage blocked/full: history just won't persist */ }
  }

  function loadCalls() {
    try {
      const raw = localStorage.getItem(CALLS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      S.calls = Array.isArray(arr) ? arr.filter(r => r && typeof r.x === 'number') : [];
    } catch (e) { S.calls = []; }
  }

  function renderHistory() {
    const ul = $('call-history');
    if (!ul) return;
    ul.innerHTML = '';
    for (const rec of S.calls.slice(0, 30)) {
      const li = document.createElement('li');
      li.className = 'hist-' + rec.call.toLowerCase().replace(' ', '-');
      const b = document.createElement('button');
      b.className = 'hist-btn';
      b.type = 'button';
      b.textContent = new Date(rec.at).toLocaleTimeString() + ' — ' + rec.call + ' · ' +
        rec.line + ' · (' + rec.x.toFixed(1) + ', ' + rec.y.toFixed(1) + ' ft) · tap to replay';
      b.addEventListener('click', () => openReplay(rec.id));
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  function openReplay(id) {
    const rec = S.calls.find(r => r.id === id);
    if (!rec) return;
    S.replayId = id;
    const cap = $('replay-caption');
    cap.textContent = replayCaption(rec); // js/replay.js
    cap.className = 'replay-caption cap-' + rec.call.toLowerCase().replace(' ', '-');
    $('replay-court').innerHTML = replaySVG(rec);
    $('replay-time').textContent = new Date(rec.at).toLocaleString();
    showScreen('replay'); // judgeLoop pauses itself when screen !== 'judge'
  }

  function resumeJudge() {
    showScreen('judge');
    if (!S.judging) { S.judging = true; requestAnimationFrame(judgeLoop); }
  }

  // ---------- scorekeeper ----------
  const SCORE_KEY = 'kitcheneye.score.v1';
  const SCORE_PREFS_KEY = 'kitcheneye.scoreprefs.v1';

  function teamName(key) {
    const raw = key === 'us' ? S.scorePrefs.teamUs : S.scorePrefs.teamThem;
    const fb = key === 'us' ? 'Us' : 'Them';
    return (typeof raw === 'string' && raw.trim() ? raw.trim() : fb).slice(0, 24);
  }

  function newScore() {
    S.score = new Score({ mode: S.scorePrefs.mode, target: S.scorePrefs.target });
    saveScore();
    renderScoreboard();
  }

  function saveScore() {
    try {
      localStorage.setItem(SCORE_KEY, JSON.stringify(S.score.state()));
      localStorage.setItem(SCORE_PREFS_KEY, JSON.stringify(S.scorePrefs));
    } catch (e) { /* storage blocked: score just won't persist */ }
  }

  function loadScore() {
    try {
      const p = JSON.parse(localStorage.getItem(SCORE_PREFS_KEY) || 'null');
      if (p && typeof p === 'object') {
        if (p.mode === 'singles' || p.mode === 'doubles') S.scorePrefs.mode = p.mode;
        if (Number.isFinite(+p.target)) S.scorePrefs.target = Math.max(1, Math.min(30, Math.round(+p.target)));
        if (typeof p.teamUs === 'string' && p.teamUs.trim()) S.scorePrefs.teamUs = p.teamUs.slice(0, 24);
        if (typeof p.teamThem === 'string' && p.teamThem.trim()) S.scorePrefs.teamThem = p.teamThem.slice(0, 24);
        S.scorePrefs.speech = !!p.speech;
      }
    } catch (e) { /* keep defaults */ }
    try {
      const st = JSON.parse(localStorage.getItem(SCORE_KEY) || 'null');
      S.score = st ? Score.fromState(st) : null;
      if (!S.score || S.score.mode !== S.scorePrefs.mode || S.score.target !== S.scorePrefs.target) {
        S.score = new Score({ mode: S.scorePrefs.mode, target: S.scorePrefs.target });
      }
    } catch (e) {
      S.score = new Score({ mode: S.scorePrefs.mode, target: S.scorePrefs.target });
    }
  }

  function renderScoreboard() {
    const main = $('score-main'), sub = $('score-sub');
    if (!main || !sub || !S.score) return;
    main.textContent = S.score.scoreText();
    if (S.score.over) {
      sub.textContent = teamName(S.score.winner) + ' wins the game';
    } else {
      const side = S.score.servingSide() === 'even' ? 'right' : 'left';
      let line = teamName(S.score.serving) + ' serving · ' + side + ' court';
      if (S.score.mode === 'doubles') {
        line = teamName(S.score.serving) + ' serving · server ' + S.score.server + ' · ' + side + ' court';
      }
      sub.textContent = line;
    }
    const bu = $('btn-us-won'), bt = $('btn-them-won');
    if (bu) bu.textContent = teamName('us') + ' won';
    if (bt) bt.textContent = teamName('them') + ' won';
  }

  function speak(text) {
    if (!S.scorePrefs.speech) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      synth.speak(new SpeechSynthesisUtterance(text));
    } catch (e) { /* speech unavailable */ }
  }

  function showWhoWon() { $('who-won').classList.remove('hidden'); }
  function hideWhoWon() { $('who-won').classList.add('hidden'); }

  function recordPoint(teamKey) {
    if (!S.score || S.score.over) return;
    const ev = S.score.rallyWon(teamKey);
    saveScore();
    renderScoreboard();
    hideWhoWon();
    if (ev.type === 'game-over') {
      $('gameover-text').textContent = teamName(ev.winner) + ' wins the game — ' + ev.scoreText;
      $('game-over').classList.remove('hidden');
      setStatus('judge-status', 'Game over. Start a new game to play again.');
      speak('Game over. ' + teamName(ev.winner) + ' wins.');
    } else {
      const notes = {
        'point': teamName(ev.team) + ' scores.',
        'second-serve': 'Second serve.',
        'side-out': 'Side out — ' + teamName(ev.nowServing) + ' to serve.',
      };
      setStatus('judge-status', (notes[ev.type] || '') + ' Tap "Start point" for the next.');
      speak(ev.scoreText);
    }
    updateArmUI();
  }

  // ---- v2 multi-phone scoring ----
  // Joiners route their taps through the host; the host owns the Score.
  function whoWonTap(team) {
    if (S.netRole === 'joiner' && S.net && !S.netDead) {
      try { S.net.send({ t: 'who-won', team: team }); }
      catch (e) { setStatus('judge-status', "Couldn't reach the host."); return; }
      hideWhoWon();
      setStatus('judge-status', 'Sent to host…');
      updateArmUI();
      return;
    }
    recordPoint(team);
    if (S.netRole === 'host' && S.net) {
      try { S.net.broadcast({ t: 'score', state: S.score.state() }); } catch (e) {}
    }
  }

  // Host: a joiner reported a rally winner. Debounced so two phones tapping
  // the same point within a few seconds can't double-score it.
  function hostWhoWon(team) {
    if (team !== 'us' && team !== 'them') return;
    const now = performance.now();
    if (now - S.lastWhoWonAt < 3000) return;
    S.lastWhoWonAt = now;
    recordPoint(team);
    try { S.net.broadcast({ t: 'score', state: S.score.state() }); } catch (e) {}
  }

  function onHostMessage(peerId, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'bounce') {
      hostCollectBounce({
        x: +msg.x, y: +msg.y, at: +msg.at,
        size: Number.isFinite(+msg.size) ? +msg.size : 0,
        from: peerId,
      });
    } else if (msg.t === 'who-won') {
      hostWhoWon(msg.team);
    } else if (msg.t === 'corner') {
      const p = S.netPeers.find(x => x.id === peerId);
      if (p && CORNERS[msg.corner]) p.corner = msg.corner;
      S.camsLocked = false; // positions changed -> host re-confirms
      // Lock it: tell every joiner which zones are taken.
      broadcastTaken();
      renderLobby();
    } else if (msg.t === 'campos') {
      // Director wall: a phone reports where it stands (court feet).
      const p = S.netPeers.find(x => x.id === peerId);
      if (p && isFinite(+msg.x) && isFinite(+msg.y)) p.pos = { x: +msg.x, y: +msg.y };
      S.camsLocked = false; // positions changed -> host re-confirms
      renderLobby();
    }
  }

  // Joiner: messages from the host.
  function onNetMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'welcome' || msg.t === 'fmt') {
      // Match format (singles = halves, doubles = corners). Re-render the
      // position picker; a format change resets our pick.
      if (msg.format === 'singles' || msg.format === 'doubles') {
        if (S.matchFormat !== msg.format) { S.matchFormat = msg.format; S.myCorner = null; }
      }
      if (Array.isArray(msg.taken)) {
        S.takenCorners = msg.taken.filter(c => CORNERS[c]);
        // Our pick got taken while we were away? Release it.
        if (S.myCorner && S.takenCorners.includes(S.myCorner)) S.myCorner = null;
      }
      renderCornerPicker();
      return;
    }
    if (msg.t === 'taken') {
      S.takenCorners = Array.isArray(msg.corners) ? msg.corners.filter(c => CORNERS[c]) : [];
      renderCornerPicker();
      return;
    }
    if (msg.t === 'ball' && msg.preset) {
      // Host owns the ball color; we just follow.
      try { S.tracker.calibratePreset(msg.preset); S.ballPreset = msg.preset; } catch (e) {}
      return;
    }
    if (msg.t === 'arm') {
      // Host runs the point; we arm/disarm on command.
      S.armed = !!msg.armed;
      if (S.armed) { try { S.tracker.reset(); } catch (e) {} }
      hideWhoWon();
      return;
    }
    if (msg.t === 'call' && msg.rec) {
      handleCall(msg.rec);
    } else if (msg.t === 'score' && msg.state) {
      try {
        S.score = Score.fromState(msg.state);
      } catch (e) { console.warn('bad score state', e); return; }
      saveScore();
      renderScoreboard();
      hideWhoWon();
      if (S.score.over) {
        $('gameover-text').textContent = teamName(S.score.winner) + ' wins the game — ' + S.score.scoreText();
        $('game-over').classList.remove('hidden');
      } else {
        $('game-over').classList.add('hidden');
      }
      updateArmUI();
    } else if (msg.t === 'start') {
      if (S.screen === 'lobby') {
        enterJudge();
        setStatus('judge-status', 'Connected to host — tap "Start point", then serve.');
      } else if (S.screen === 'judge' && S.netRole === 'joiner') {
        setStatus('judge-status', '\uD83D\uDCF7 Match live — tracking for the host.');
      } else {
        S.pendingStart = true; // still scanning: start when we reach the lobby
      }
    } else if (msg.t === 'bye') {
      netHostGone();
    }
  }

  function netHostGone() {
    if (S.netRole !== 'joiner') return;
    netClose();
    S.netDead = true;
    S.armed = false;
    updateArmUI();
    setStatus('judge-status', 'Host left — match over.');
    const bh = $('btn-net-home');
    if (bh) bh.classList.remove('hidden');
  }

  function updateArmUI() {
    const b = $('btn-arm');
    if (!b) return;
    if (S.score && S.score.over) {
      b.textContent = 'Game over';
      b.classList.remove('armed');
      return;
    }
    b.textContent = S.armed ? 'Point live — tap when point ends' : 'Start point';
    b.classList.toggle('armed', S.armed);
  }

  function setStatus(id, msg) {
    const el = $(id);
    if (el) el.textContent = msg;
  }

  // ---------- v2 multi-phone lobby + session ----------
  function showLobby(view) {
    showScreen('lobby');
    ['choose', 'host', 'join', 'waiting'].forEach(v => {
      const el = $('lobby-' + v);
      if (el) el.classList.toggle('hidden', v !== view);
    });
    window.scrollTo(0, 0);
  }

  function setLobbyStatus(msg) { setStatus('lobby-status', msg); }
  function setJoinStatus(msg) { setStatus('lobby-join-status', msg); }

  function netClose() {
    S.netSeq = (S.netSeq || 0) + 1; // invalidates in-flight host/join attempts
    try { if (S.net) S.net.close(); } catch (e) {}
    S.net = null; S.netRole = null; S.netPeers = []; S.camsLocked = false; S.myCorner = null;
    closeQrScanner();
    if (S.arb && S.arb.timer) clearTimeout(S.arb.timer);
    S.arb = null; S.pendingStart = false;
  }

  function goHome() {
    S.armed = false;
    netClose();
    S.netDead = false;
    const bh = $('btn-net-home');
    if (bh) bh.classList.add('hidden');
    if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
    showScreen('home');
  }

  function renderLobbyPeers() {
    const ul = $('lobby-peers');
    if (ul) {
      ul.innerHTML = '';
      const rows = [{ name: 'This phone (host)' }].concat(S.netPeers.map(p => ({ name: p.name })));
      rows.forEach((r, i) => {
        const li = document.createElement('li');
        const b = document.createElement('span');
        b.className = 'num-badge';
        b.style.background = PHONE_COLORS[i % PHONE_COLORS.length];
        b.textContent = i + 1;
        li.appendChild(b);
        li.appendChild(document.createTextNode(' ' + r.name));
        ul.appendChild(li);
      });
    }
    const n = S.netPeers.length + 1;
    const want = expectedPhones();
    const scanned = S.netPeers.filter(p => p.corner || p.pos).length + (S.H ? 1 : 0);
    const lc = $('lobby-count');
    if (lc) lc.textContent = 'Phones: ' + n + ' of ' + want + ' · Scanned: ' + scanned + ' of ' + want +
      (S.matchFormat === 'singles' ? ' (singles)' : ' (doubles)');
    const sb = $('btn-lobby-start');
    if (sb) sb.textContent = '3 · Start match (' + n + ' phone' + (n === 1 ? '' : 's') + ')';
  }

  async function hostMatch() {
    showLobby('host'); // show the host view first so statuses are visible
    if (!NetSync.peerAvailable()) {
      setLobbyStatus('Multi-phone needs internet for the one-time handshake — the sync library could not load.');
      return;
    }
    S.netDead = false;
    setLobbyStatus('Creating room…');
    const net = new NetSync();
    const mySeq = S.netSeq || 0;
    try {
      const code = await net.hostRoom((e) =>
        setLobbyStatus('Connection problem: ' + (e && e.message ? e.message : e)));
      if (mySeq !== (S.netSeq || 0)) { try { net.close(); } catch (e) {} return; } // user cancelled meanwhile
      S.net = net; S.netRole = 'host'; S.netPeers = []; S.camsLocked = false;
    net.matchFormat = S.matchFormat;
    net.getTaken = takenList;
    setFormat(S.matchFormat); // refresh the format buttons for the fresh lobby
      $('lobby-code').textContent = code;
      // QR join link: point another phone's camera at it and it opens this
      // app straight into the room. Zero dependencies — drawn on-device.
      try {
        const qc = $('lobby-qr');
        if (qc && typeof qrDraw === 'function') {
          let base = location.href.split('?')[0].split('#')[0];
          if (base.endsWith('index.html')) base = base.slice(0, -10);
          qrDraw(qc, base + '?r=' + code);
          qc.classList.remove('hidden');
        }
      } catch (e) { console.warn('qr draw failed', e); }
      net.onJoin((id, name) => {
        if (!S.netPeers.some(p => p.id === id)) S.netPeers.push({ id: id, name: name });
        S.camsLocked = false; // new phone -> host re-confirms the wall
        renderLobbyPeers();
        renderLobby();
      });
      net.onLeave((id) => {
        S.netPeers = S.netPeers.filter(p => p.id !== id);
        S.camsLocked = false;
        renderLobbyPeers();
        renderLobby();
      });
      net.onHostMessage(onHostMessage);
      net.onServer((up) => {
        if (S.net !== net || S.netRole !== 'host') return;
        // The room only exists while the host holds its server link —
        // if this drops (sleep/background), joiners get "peer unavailable".
        setLobbyStatus(up
          ? 'Waiting for phones…'
          : 'Lost the match server — reconnecting… keep this screen open and the phone awake.');
      });
      renderLobbyPeers();
      renderLobby();
      setLobbyStatus('Waiting for phones…');
    } catch (e) {
      setLobbyStatus('Could not create the room. Check your internet and try again.');
    }
  }

  async function joinMatch() {
    const code = (($('join-code').value || '').toUpperCase().trim());
    const name = (($('join-name').value || '').trim() || 'Phone').slice(0, 24);
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      setJoinStatus('Enter the 6-character code shown on the host phone.');
      return;
    }
    if (!NetSync.peerAvailable()) {
      setJoinStatus('Multi-phone needs internet for the one-time handshake — the sync library could not load.');
      return;
    }
    S.netDead = false;
    setJoinStatus('Connecting…');
    $('btn-join').classList.add('hidden');
    const net = new NetSync();
    const mySeq = S.netSeq || 0;
    try {
      await net.joinRoom(code, name, (e) =>
        setJoinStatus('Connection problem: ' + (e && e.message ? e.message : e)));
      if (mySeq !== (S.netSeq || 0)) { try { net.close(); } catch (e) {} return; } // user backed out meanwhile
      S.net = net; S.netRole = 'joiner';
      net.onMessage(onNetMessage);
      net.onLeave(() => netHostGone());
      setJoinStatus('Connected! Tap where this phone is, then scan the court.');
      $('btn-join').classList.add('hidden');
      $('btn-qr-scan').classList.add('hidden');
      $('join-position').classList.remove('hidden');
      $('btn-join-scan').classList.remove('hidden');
      renderCornerPicker();
    } catch (e) {
      // Surface the real reason. "Could not connect to peer" means the room
      // is gone on the server — the host phone left the Room code screen or
      // went to sleep — so say that instead of blaming the code/internet.
      const msg = e && e.message ? e.message : String(e);
      const roomGone = /could not connect to peer|peer-unavailable/i.test(msg);
      const timedOut = /timed out/i.test(msg);
      setJoinStatus(roomGone
        ? 'That room is gone — the host phone probably left the Room code screen or fell asleep. Keep the host on that screen and try again, or have the host make a fresh room.'
        : timedOut
          ? 'Could not join (timed out). If the phones are on cellular, put them all on the same WiFi — one phone\u2019s hotspot works great — then try again.'
          : 'Could not join (' + msg + '). Check the code and your internet, then try again.');
      $('btn-join').classList.remove('hidden');
    }
  }

  // ---------- in-app QR scanner (fast join) ----------
  // jsQR (MIT, via CDN — same pattern as PeerJS) is lazy-loaded the first
  // time the join view opens. If it can't load, the Scan button stays hidden
  // and typing the code still works.
  let qrLibState = 'idle'; // idle | loading | ready | failed
  function prepQrScanButton() {
    const btn = $('btn-qr-scan');
    if (!btn) return;
    if (typeof jsQR !== 'undefined' || qrLibState === 'ready') {
      qrLibState = 'ready';
      if (S.screen === 'lobby') btn.classList.remove('hidden');
      return;
    }
    if (qrLibState === 'loading' || qrLibState === 'failed') return;
    qrLibState = 'loading';
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
    s.onload = () => {
      qrLibState = 'ready';
      const b = $('btn-qr-scan');
      if (b && S.screen === 'lobby') b.classList.remove('hidden');
    };
    s.onerror = () => { qrLibState = 'failed'; };
    document.head.appendChild(s);
  }

  let qrStream = null, qrTimer = 0;
  const qrWork = document.createElement('canvas');

  async function openQrScanner() {
    closeQrScanner();
    showScreen('scanqr');
    setStatus('qr-status', 'Point at the QR code on the host phone…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      qrStream = stream;
      const v = $('qr-video');
      v.srcObject = stream;
      await v.play();
      qrTimer = setTimeout(qrScanTick, 300);
    } catch (e) {
      setStatus('qr-status', 'Camera unavailable — type the 6-character code instead.');
    }
  }

  function qrScanTick() {
    qrTimer = 0;
    if (S.screen !== 'scanqr') return; // user left the scanner
    try {
      const v = $('qr-video');
      if (v && v.videoWidth && typeof jsQR !== 'undefined') {
        const w = 640, h = Math.max(2, Math.round(640 * v.videoHeight / v.videoWidth));
        qrWork.width = w; qrWork.height = h;
        const ctx = qrWork.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(v, 0, 0, w, h);
        const res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h);
        if (res && res.data) {
          const m = /[?&]r=([A-Za-z0-9]{6})(?:[^A-Za-z0-9]|$)/.exec(res.data);
          if (m) {
            const code = m[1].toUpperCase();
            closeQrScanner();
            showLobby('join');
            prepQrScanButton();
            $('join-code').value = code;
            setJoinStatus('Joining room ' + code + '…');
            setTimeout(joinMatch, 300);
            return;
          }
          setStatus('qr-status', 'That QR is not a KitchenEye invite — point at the host phone\u2019s code.');
        }
      }
    } catch (e) { /* keep scanning */ }
    qrTimer = setTimeout(qrScanTick, 250);
  }

  function closeQrScanner() {
    if (qrTimer) { clearTimeout(qrTimer); qrTimer = 0; }
    if (qrStream) { try { qrStream.getTracks().forEach(t => t.stop()); } catch (e) {} qrStream = null; }
    const v = $('qr-video');
    if (v) { try { v.pause(); } catch (e) {} v.srcObject = null; }
  }

  // ---------- director wall: host sees every phone's camera ----------
  // Joiners publish a tiny monitor feed (320x180 @ ~8fps via canvas
  // captureStream) to the host. The host lobby shows a 2x2 wall plus a mini
  // court diagram with each phone's position, then locks in before Start.

  function activeVideoEl() {
    const jv = $('judge-video');
    if (jv && !jv.paused && jv.videoWidth) return jv;
    return S.video;
  }

  /** Last ~10 ball positions in court feet, for the Hawk-Eye trail. */
  function courtTrail() {
    try {
      const h = S.tracker.hist.slice(-10);
      if (!h.length || !S.H) return null;
      return h.map(p => {
        const [X, Y] = applyHomography(S.H, p.x, p.y);
        return [Math.round(X * 10) / 10, Math.round(Y * 10) / 10];
      });
    } catch (e) { return null; }
  }

  /** Where this phone stands, in court feet (from the scan homography). */
  function cameraCourtPos() {
    try {
      if (!S.H || !S.video || !S.video.videoWidth || !S.detScale) return null;
      const dx = (S.video.videoWidth / 2) / S.detScale;
      const dy = (S.video.videoHeight * 0.96) / S.detScale;
      const [X, Y] = applyHomography(S.H, dx, dy);
      if (!isFinite(X) || !isFinite(Y)) return null;
      return { x: X, y: Y };
    } catch (e) { return null; }
  }

  function posLabel(p) {
    if (!p) return 'position unknown';
    if (p.corner && CORNERS[p.corner]) return CORNERS[p.corner].label;
    if (p.y < -0.5) return 'behind N baseline';
    if (p.y > 44.5) return 'behind S baseline';
    if (p.x < -0.5 || p.x > 20.5) return 'sideline';
    return 'on the court';
  }
  function posCoords(p) {
    if (!p) return null;
    if (p.corner && CORNERS[p.corner]) return CORNERS[p.corner];
    if (isFinite(p.x) && isFinite(p.y)) return p;
    return null;
  }


  // Joiner-declared court corners (2x2 grid mirroring the position diagram).
  const CORNERS = {
    TL: { x: 2, y: -3, label: 'Top Left' },
    TR: { x: 18, y: -3, label: 'Top Right' },
    BL: { x: 2, y: 47, label: 'Bottom Left' },
    BR: { x: 18, y: 47, label: 'Bottom Right' },
    T: { x: 10, y: -3, label: 'Top half' },
    B: { x: 10, y: 47, label: 'Bottom half' },
  };
  // Claimable zones on the court diagram (SVG coords, viewBox 0 0 140 224).
  // Doubles = 4 corners, singles = top/bottom halves.
  function zoneDefs() {
    if (S.matchFormat === 'singles') return [
      { code: 'T', x0: 20, y0: 16, x1: 120, y1: 112, cx: 70, cy: 64 },
      { code: 'B', x0: 20, y0: 112, x1: 120, y1: 208, cx: 70, cy: 160 },
    ];
    return [
      { code: 'TL', x0: 20, y0: 16, x1: 70, y1: 112, cx: 45, cy: 64 },
      { code: 'TR', x0: 70, y0: 16, x1: 120, y1: 112, cx: 95, cy: 64 },
      { code: 'BL', x0: 20, y0: 112, x1: 70, y1: 208, cx: 45, cy: 160 },
      { code: 'BR', x0: 70, y0: 112, x1: 120, y1: 208, cx: 95, cy: 160 },
    ];
  }
  function formatCorners() { return zoneDefs().map(z => z.code); }
  // Phone identity colors: 1 = host, 2-4 = joiners in join order.
  const PHONE_COLORS = ['#7CFC00', '#ffd24d', '#6ec6ff', '#e06c9f'];
  // Clean court lines, no text. Centerline skips the kitchen (two segments).
  function courtLinesSVG() {
    const sy = y => 16 + (y / 44) * 192;
    const g = '#7CFC00';
    return '<rect x="20" y="16" width="100" height="192" fill="none" stroke="' + g + '" stroke-width="2"/>' +
      '<line x1="20" y1="' + sy(15).toFixed(1) + '" x2="120" y2="' + sy(15).toFixed(1) + '" stroke="' + g + '" stroke-width="1.2"/>' +
      '<line x1="20" y1="' + sy(29).toFixed(1) + '" x2="120" y2="' + sy(29).toFixed(1) + '" stroke="' + g + '" stroke-width="1.2"/>' +
      '<line x1="70" y1="16" x2="70" y2="' + sy(15).toFixed(1) + '" stroke="' + g + '" stroke-width="1.2"/>' +
      '<line x1="70" y1="' + sy(29).toFixed(1) + '" x2="70" y2="208" stroke="' + g + '" stroke-width="1.2"/>' +
      '<line x1="20" y1="' + sy(22).toFixed(1) + '" x2="120" y2="' + sy(22).toFixed(1) + '" stroke="#5a6b8a" stroke-width="1" stroke-dasharray="5 4" opacity="0.7"/>';
  }
  function zoneRectSVG(z, attrs) {
    return '<rect x="' + z.x0 + '" y="' + z.y0 + '" width="' + (z.x1 - z.x0) + '" height="' + (z.y1 - z.y0) + '" ' + attrs + '/>';
  }
  function cornerQuadrant(p) {
    if (!p) return null;
    return (p.y < 22 ? 'T' : 'B') + (p.x < 10 ? 'L' : 'R');
  }

  // Lobby refresh: the position diagram + start button. (The live video
  // wall is gone — corner taps give the positions, no laggy streams.)
  function renderLobby() {
    if (S.netRole !== 'host') return;
    renderPosDiagram();
    renderLobbyPeers();
    updateStartButton();
  }

  // Host position board: each claimed zone shows that phone's number in its
  // center. Open zones are tappable — that's how the host claims a zone.
  function renderPosDiagram() {
    const svg = $('pos-diagram');
    if (!svg) return;
    const zones = zoneDefs();
    // claims: zone code -> { num, color }
    const claims = {};
    if (S.hostCorner) claims[S.hostCorner] = { num: 1, color: PHONE_COLORS[0] };
    S.netPeers.forEach((p, i) => {
      if (p.corner && zones.some(z => z.code === p.corner) && !claims[p.corner]) {
        claims[p.corner] = { num: i + 2, color: PHONE_COLORS[(i + 1) % PHONE_COLORS.length] };
      }
    });
    let s = courtLinesSVG();
    zones.forEach(z => {
      const c = claims[z.code];
      if (c) {
        s += zoneRectSVG(z, 'fill="' + c.color + '" opacity="0.22" rx="4"') +
          '<circle cx="' + z.cx + '" cy="' + z.cy + '" r="16" fill="' + c.color + '"/>' +
          '<text x="' + z.cx + '" y="' + (z.cy + 6) + '" text-anchor="middle" font-size="17" font-weight="700" fill="#0a0f1e" font-family="system-ui">' + c.num + '</text>';
      } else {
        s += zoneRectSVG(z, 'fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.28)" stroke-width="1" stroke-dasharray="6 5" rx="4" data-hzone="' + z.code + '" style="cursor:pointer" class="zone-avail"');
      }
    });
    svg.innerHTML = s;
    svg.querySelectorAll('[data-hzone]').forEach(r => {
      const tap = e => { e.preventDefault(); hostPickZone(r.dataset.hzone); };
      r.addEventListener('click', tap);
      r.addEventListener('touchstart', tap, { passive: false });
    });
    renderPosLegend(claims);
  }

  function hostPickZone(code) {
    if (!zoneDefs().some(z => z.code === code)) return;
    // Can't take a joiner's zone.
    if (S.netPeers.some(p => p.corner === code)) return;
    S.hostCorner = code;
    broadcastTaken();
    renderLobby();
  }

  function broadcastTaken() {
    if (S.netRole !== 'host' || !S.net) return;
    try {
      S.net.broadcast({ t: 'taken', corners: takenList() });
    } catch (e) {}
  }

  function takenList() {
    const t = S.netPeers.map(x => x.corner).filter(Boolean);
    if (S.hostCorner) t.push(S.hostCorner);
    return t;
  }

  // Legend under the diagram: number badge + phone name, matching the board.
  function renderPosLegend(claims) {
    const ul = $('pos-legend');
    if (!ul) return;
    ul.innerHTML = '';
    const rows = [{ num: 1, color: PHONE_COLORS[0], name: 'This phone (host)' }]
      .concat(S.netPeers.map((p, i) => ({ num: i + 2, color: PHONE_COLORS[(i + 1) % PHONE_COLORS.length], name: p.name || 'Phone' })));
    rows.forEach(r => {
      const li = document.createElement('li');
      const b = document.createElement('span');
      b.className = 'num-badge';
      b.style.background = r.color;
      b.textContent = r.num;
      li.appendChild(b);
      li.appendChild(document.createTextNode(' ' + r.name));
      ul.appendChild(li);
    });
  }

  function updateStartButton() {
    const startBtn = $('btn-lobby-start');
    if (!startBtn || S.netRole !== 'host') return;
    const needScan = !S.H;
    const needLock = S.netPeers.length > 0 && !S.camsLocked;
    // Keep Start tappable even when not ready: tapping it explains what's
    // missing (via hostStartMatch) instead of silently doing nothing.
    startBtn.disabled = false;
    const lockBtn = $('btn-lock-cams');
    if (lockBtn) {
      lockBtn.classList.toggle('hidden', S.netPeers.length === 0);
      lockBtn.disabled = !!S.camsLocked;
      lockBtn.textContent = S.camsLocked ? '✓ Cameras locked in' : '2 · Cameras look good — lock in';
    }
    const hint = $('lock-hint');
    if (hint) {
      hint.textContent = needScan ? 'Step 1: scan your court, then lock in the cameras.'
        : needLock ? 'Check each camera feed above, then lock in to enable Start.'
        : (S.netPeers.length ? 'All set — start the match when ready.' : '');
    }
  }

  // Join-phone zone picker: a tappable court. Taken zones are grayed out
  // and dead; the picked zone lights up. No words on the court itself.
  function renderCornerPicker() {
    const svg = $('corner-svg');
    if (!svg) return;
    const zones = zoneDefs();
    let s = courtLinesSVG();
    zones.forEach(z => {
      const taken = S.takenCorners.includes(z.code) && S.myCorner !== z.code;
      const mine = S.myCorner === z.code;
      if (mine) {
        s += zoneRectSVG(z, 'fill="#7CFC00" opacity="0.28" stroke="#7CFC00" stroke-width="2.5" rx="4"') +
          '<circle cx="' + z.cx + '" cy="' + z.cy + '" r="15" fill="#7CFC00"/>' +
          '<path d="M ' + (z.cx - 7) + ' ' + z.cy + ' l 5 5 l 9 -10" stroke="#0a0f1e" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
      } else if (taken) {
        s += zoneRectSVG(z, 'fill="#232c40" opacity="0.85" rx="4"') +
          '<line x1="' + (z.cx - 8) + '" y1="' + (z.cy - 8) + '" x2="' + (z.cx + 8) + '" y2="' + (z.cy + 8) + '" stroke="#5a6b8a" stroke-width="2.5" stroke-linecap="round"/>' +
          '<line x1="' + (z.cx + 8) + '" y1="' + (z.cy - 8) + '" x2="' + (z.cx - 8) + '" y2="' + (z.cy + 8) + '" stroke="#5a6b8a" stroke-width="2.5" stroke-linecap="round"/>';
      } else {
        s += zoneRectSVG(z, 'fill="rgba(124,252,0,0.07)" stroke="rgba(124,252,0,0.45)" stroke-width="1.5" rx="4" data-zone="' + z.code + '" style="cursor:pointer" class="zone-avail"');
      }
    });
    svg.innerHTML = s;
    svg.querySelectorAll('[data-zone]').forEach(r => {
      const tap = e => { e.preventDefault(); pickCorner(r.dataset.zone); };
      r.addEventListener('click', tap);
      r.addEventListener('touchstart', tap, { passive: false });
    });
    const sc = $('btn-join-scan');
    if (sc) sc.disabled = !S.myCorner;
  }

  function pickCorner(corner) {
    if (!CORNERS[corner]) return;
    if (S.takenCorners.includes(corner) && S.myCorner !== corner) return; // taken: can't
    S.myCorner = corner;
    renderCornerPicker();
    $('btn-join-scan').disabled = false;
    if (S.net) { try { S.net.send({ t: 'corner', corner: corner }); } catch (e) {} }
    setJoinStatus('You\u2019re at ' + CORNERS[corner].label + ' — now scan the court from there.');
  }

  function expectedPhones() { return S.matchFormat === 'singles' ? 2 : 4; }

  function setFormat(f) {
    if (f !== 'singles' && f !== 'doubles') return;
    S.matchFormat = f;
    if (S.hostCorner && !zoneDefs().some(z => z.code === S.hostCorner)) S.hostCorner = null;
    S.scorePrefs.mode = f; // the match score follows the format
    saveScore();
    if (S.netRole === 'host' && S.net) {
      S.net.matchFormat = f;
      try { S.net.broadcast({ t: 'fmt', format: f }); } catch (e) {}
    }
    renderScoreboard();
    $('btn-fmt-singles').classList.toggle('active', f === 'singles');
    $('btn-fmt-doubles').classList.toggle('active', f === 'doubles');
    renderLobbyPeers();
    updateStartButton();
  }

  function lockCameras() {
    S.camsLocked = true;
    setLobbyStatus('Cameras locked in — ' + (S.netPeers.length + 1) + ' phones ready.');
    updateStartButton();
  }

  function hostStartMatch() {
    if (S.netRole !== 'host' || !S.net) return;
    if (!S.H) {
      setLobbyStatus('Scan your court first (step 1 above), then start the match.');
      return;
    }
    if (S.netPeers.length && !S.camsLocked) {
      setLobbyStatus('Lock in the cameras first — check each feed above, then tap "Cameras look good".');
      return;
    }
    newScore(); // fresh game; the host owns the score
    try {
      S.net.broadcast({ t: 'score', state: S.score.state() });
      S.net.broadcast({ t: 'start' });
    } catch (e) {}
    enterJudge();
    const n = S.netPeers.length + 1;
    setStatus('judge-status', 'Match live — ' + n + ' phone' + (n === 1 ? '' : 's') +
      ' judging. Tap "Start point", then serve.');
  }

  // Joiner path from the calibrate screen's Continue button.
  function joinerContinue() {
    if (S.pendingStart) {
      S.pendingStart = false;
      enterJudge();
      setStatus('judge-status', 'Connected to host — tap "Start point", then serve.');
      return;
    }
    showLobby('waiting');
  }

  // Shared camera/scan flow for solo, host, and joiner.
  async function startScanFlow() {
    S.courtName = ($('court-name').value || 'home-court').trim() || 'home-court';
    // unlock audio on the user gesture
    try {
      if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
      if (S.audio.state === 'suspended') S.audio.resume();
    } catch (e) {}
    const ok = await startCamera();
    if (!ok) return;
    // fresh scan state
    S.H = null; S.pendingScan = null; S.tapping = false; S.manualCorners = null;
    clearTimeout(S.autoScanT);
    $('scan-confirm').classList.add('hidden');
    $('scan-done-manual').classList.add('hidden');
    // offer a saved court to skip the scan
    const saved = loadCourt(S.courtName);
    if (saved && saved.H) {
      S.H = saved.H;
      $('resume-court').classList.remove('hidden');
      setStatus('scan-status', 'Saved calibration found for "' + S.courtName + '". Resume it, or scan fresh below.');
    } else {
      $('resume-court').classList.add('hidden');
      setStatus('scan-status', 'Aim at the empty court — scanning automatically…');
      autoScanSoon();
    }
    showScreen('camera');
    clearOverlay(); // live video shows through; markers drawn on top
  }

  // ---------- boot ----------
  function init() {
    S.video = $('cam-video');
    S.overlay = $('cam-overlay');
    S.octx = S.overlay.getContext('2d');
    S.proc = document.createElement('canvas');
    S.pctx = S.proc.getContext('2d', { willReadFrequently: true });
    S.tracker = new BallTracker();
    loadCalls();
    renderHistory();
    loadScore();

    window.addEventListener('resize', () => { if (S.video && S.video.videoWidth) sizeOverlay(); });
    S.overlay.addEventListener('click', onOverlayTap);
    // iOS Safari doesn't reliably fire click on <canvas> — handle touches
    // directly (preventDefault suppresses the delayed synthetic click, so no
    // double-count). Touch objects carry clientX/clientY like mouse events.
    S.overlay.addEventListener('touchstart', function (ev) {
      ev.preventDefault();
      onOverlayTap(ev.changedTouches[0]);
    }, { passive: false });
    $('cal-canvas').addEventListener('click', onCalTap);
    $('cal-canvas').addEventListener('touchstart', function (ev) {
      ev.preventDefault();
      onCalTap(ev.changedTouches[0]);
    }, { passive: false });
    document.querySelectorAll('#preset-row .preset').forEach(b =>
      b.addEventListener('click', () => selectPreset(b.dataset.preset)));

    // v2: hide the multi-phone entry when the sync library is unreachable;
    // solo mode works untouched.
    if (!NetSync.peerAvailable()) {
      const bm = $('btn-multi');
      if (bm) bm.classList.add('hidden');
    }

    $('btn-setup').addEventListener('click', () => {
      S.netDead = false;
      startScanFlow();
    });

    // v2 lobby wiring
    $('btn-multi').addEventListener('click', () => showLobby('choose'));
    $('btn-lobby-back').addEventListener('click', () => showScreen('home'));
    $('btn-host').addEventListener('click', hostMatch);
    $('btn-show-join').addEventListener('click', () => {
      setJoinStatus('');
      $('btn-join').classList.remove('hidden');
      $('btn-join-scan').classList.add('hidden');
      showLobby('join');
      prepQrScanButton();
    });
    $('btn-join').addEventListener('click', joinMatch);
    $('btn-qr-scan').addEventListener('click', openQrScanner);
    $('btn-qr-cancel').addEventListener('click', () => { closeQrScanner(); showLobby('join'); });
    $('btn-join-scan').addEventListener('click', () => { S.netDead = false; startScanFlow(); });
    $('btn-lobby-back2').addEventListener('click', () => { netClose(); showLobby('choose'); });
    $('btn-host-scan').addEventListener('click', () => { S.netDead = false; startScanFlow(); });
    $('btn-lobby-start').addEventListener('click', hostStartMatch);
    $('btn-lock-cams').addEventListener('click', lockCameras);
    $('btn-fmt-singles').addEventListener('click', () => setFormat('singles'));
    $('btn-fmt-doubles').addEventListener('click', () => setFormat('doubles'));
    $('btn-lobby-cancel').addEventListener('click', () => { netClose(); showScreen('home'); });
    $('btn-lobby-leave').addEventListener('click', () => { netClose(); showScreen('home'); });
    $('btn-net-home').addEventListener('click', goHome);

    $('btn-retry-cam').addEventListener('click', async () => {
      if (await startCamera()) {
        showScreen('camera');
        clearOverlay();
      }
    });

    $('btn-scan').addEventListener('click', runScan);
    $('btn-scan-confirm').addEventListener('click', confirmScan);
    $('btn-manual').addEventListener('click', startManual);
    $('btn-manual-done').addEventListener('click', () => {
      $('scan-done-manual').classList.add('hidden');
      proceedAfterScan(null);
    });
    $('btn-resume-court').addEventListener('click', () => {
      proceedAfterScan(null);
    });

    $('btn-start-judge').addEventListener('click', () => {
      if (S.netRole === 'joiner' && S.net) joinerContinue();
      else if (S.netRole === 'host' && S.net) showLobby('host');
      else enterJudge();
    });

    // dispute replay + scorekeeper wiring
    $('btn-replay-back').addEventListener('click', resumeJudge);
    $('btn-us-won').addEventListener('click', () => whoWonTap('us'));
    $('btn-them-won').addEventListener('click', () => whoWonTap('them'));
    $('btn-new-game').addEventListener('click', () => {
      $('game-over').classList.add('hidden');
      newScore();
      setStatus('judge-status', 'New game. Tap "Start point".');
      updateArmUI();
    });
    $('btn-reset-score').addEventListener('click', () => {
      $('game-over').classList.add('hidden');
      newScore();
      setStatus('judge-status', 'Score reset.');
      updateArmUI();
    });
    $('score-mode').addEventListener('change', (e) => {
      S.scorePrefs.mode = e.target.value === 'singles' ? 'singles' : 'doubles';
      $('game-over').classList.add('hidden');
      newScore();
      updateArmUI();
    });
    $('score-target').addEventListener('change', (e) => {
      const t = Math.max(1, Math.min(30, Math.round(+e.target.value || 11)));
      e.target.value = t;
      S.scorePrefs.target = t;
      $('game-over').classList.add('hidden');
      newScore();
      updateArmUI();
    });
    $('team-us').addEventListener('input', (e) => {
      S.scorePrefs.teamUs = e.target.value.slice(0, 24);
      saveScore(); renderScoreboard();
    });
    $('team-them').addEventListener('input', (e) => {
      S.scorePrefs.teamThem = e.target.value.slice(0, 24);
      saveScore(); renderScoreboard();
    });
    $('speak-score').addEventListener('change', (e) => {
      S.scorePrefs.speech = e.target.checked;
      saveScore();
    });
    // reflect loaded prefs in the settings UI
    $('score-mode').value = S.scorePrefs.mode;
    $('score-target').value = S.scorePrefs.target;
    $('team-us').value = S.scorePrefs.teamUs;
    $('team-them').value = S.scorePrefs.teamThem;
    $('speak-score').checked = S.scorePrefs.speech;
    renderScoreboard();

    $('btn-cam-rescan').addEventListener('click', () => {
      S.armed = false;
      S.H = null; S.pendingScan = null; S.tapping = false; S.manualCorners = null;
      startScanFlow();
    });
    $('btn-arm').addEventListener('click', () => {
      if (S.score && S.score.over) return; // game over: start a new game first
      if (!S.armed) {
        S.armed = true;
        S.tracker.reset();
        hideWhoWon();
        $('call-banner').classList.remove('show');
        setStatus('judge-status', 'Live. Serve when ready.');
      } else {
        // Rally over -> ask who won, then score it.
        S.armed = false;
        showWhoWon();
        setStatus('judge-status', 'Point over — who won it?');
      }
      // v2: joiner cameras arm/disarm on the host's command.
      if (S.netRole === 'host' && S.net) {
        try { S.net.broadcast({ t: 'arm', armed: S.armed }); } catch (e) {}
      }
      updateArmUI();
    });

    const margin = $('margin');
    if (margin) {
      margin.addEventListener('input', () => {
        S.marginIn = parseInt(margin.value, 10) || 4;
        $('margin-val').textContent = S.marginIn + ' in';
      });
    }
    $('btn-recal-ball').addEventListener('click', () => { showScreen('calibrate'); drawCalPreview(); });
    $('btn-rescan').addEventListener('click', () => {
      S.armed = false; updateArmUI();
      S.H = null; S.pendingScan = null; S.tapping = false; S.manualCorners = null;
      $('scan-confirm').classList.add('hidden');
      $('scan-done-manual').classList.add('hidden');
      showScreen('camera'); clearOverlay();
      setStatus('scan-status', 'Aim at the empty court — scanning automatically…');
      autoScanSoon();
    });
    $('btn-home').addEventListener('click', goHome);

    // prefill saved court names
    try {
      const names = listCourts();
      if (names.length) $('court-name').value = names[0];
    } catch (e) {}

    showScreen('home');

    // v2: QR join link (?r=CODE) scanned from the host phone's screen —
    // land straight in the join view with the code filled in.
    try {
      const m = /[?&]r=([A-Za-z0-9]{6})(?:[^A-Za-z0-9]|$)/.exec(location.search || '');
      if (m) {
        const code = m[1].toUpperCase();
        if (window.history && history.replaceState) history.replaceState(null, '', location.pathname);
        showLobby('join');
        prepQrScanButton();
        $('join-code').value = code;
        setJoinStatus('Joining room ' + code + '…');
        setTimeout(joinMatch, 500);
      }
    } catch (e) {}

    // v2: if the host tab was asleep/backgrounded, its server link may have
    // dropped (joiners then get "peer unavailable"). Re-register on wake.
    function netServerCheck() {
      if (S.netRole === 'host' && S.net && S.net.peer && !S.netDead) {
        try {
          if (S.net.peer.disconnected && !S.net.peer.destroyed) {
            setLobbyStatus('Reconnecting to the match server…');
            S.net.peer.reconnect();
          }
        } catch (e) {}
      }
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) netServerCheck(); });
    window.addEventListener('focus', netServerCheck);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
