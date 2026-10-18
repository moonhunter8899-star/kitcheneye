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
    ['home', 'camera', 'calibrate', 'judge', 'replay', 'lobby'].forEach(n => {
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
    enterCalibrate();
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
  function enterJudge() {
    showScreen('judge');
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
  function buildCallRecord(cx, cy, res) {
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
    };
  }

  // Render a call everywhere it needs to go: banner, sound, history.
  function handleCall(rec) {
    const res = { call: rec.call, distIn: rec.distIn, line: rec.line, inside: rec.inside };
    showCall(res, rec.x, rec.y);
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
    if (netActive()) {
      // v2: report to the host; every phone renders calls only from {t:'call'}.
      const at = S.net.toHostTime(b.t);
      if (S.netRole === 'host') {
        hostCollectBounce({ x: cx, y: cy, at: at, size: size, from: 'host' });
      } else {
        try { S.net.send({ t: 'bounce', x: cx, y: cy, at: at, size: size }); } catch (e) {}
      }
      return;
    }
    // Solo: judge and show locally, exactly as before.
    const res = judge(cx, cy, S.marginIn);
    handleCall(buildCallRecord(cx, cy, res));
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
      const rec = buildCallRecord(win.x, win.y, res);
      try { S.net.broadcast({ t: 'call', rec: rec, by: 'host' }); } catch (e) {}
      handleCall(rec);
    }, 300);
  }

  function showCall(res, cx, cy) {
    const banner = $('call-banner');
    banner.textContent = res.call;
    banner.className = 'banner show ' + res.call.toLowerCase().replace(' ', '-');
    $('call-detail').textContent =
      res.line + ' · ' + res.distIn.toFixed(1) + ' in from paint · at (' +
      cx.toFixed(1) + ', ' + cy.toFixed(1) + ') ft';
    drawMiniCourt({ x: cx, y: cy, call: res.call });
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
      dots = '<circle cx="' + (bounce.x * sx).toFixed(1) + '" cy="' + (bounce.y * sy).toFixed(1) +
             '" r="9" fill="' + color + '" stroke="#fff" stroke-width="2"/>';
    }
    svg.innerHTML =
      '<rect x="0" y="0" width="200" height="300" fill="#1d3b2a"/>' +
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
    }
  }

  // Joiner: messages from the host.
  function onNetMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
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
    S.net = null; S.netRole = null; S.netPeers = [];
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
      for (const r of rows) {
        const li = document.createElement('li');
        li.textContent = r.name;
        ul.appendChild(li);
      }
    }
    const n = S.netPeers.length + 1;
    const sb = $('btn-lobby-start');
    if (sb) sb.textContent = '2 · Start match (' + n + ' phone' + (n === 1 ? '' : 's') + ')';
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
      S.net = net; S.netRole = 'host'; S.netPeers = [];
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
        renderLobbyPeers();
      });
      net.onLeave((id) => {
        S.netPeers = S.netPeers.filter(p => p.id !== id);
        renderLobbyPeers();
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
      setJoinStatus('Connected! Now scan the court from your spot.');
      $('btn-join-scan').classList.remove('hidden');
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

  function hostStartMatch() {
    if (S.netRole !== 'host' || !S.net) return;
    if (!S.H) {
      setLobbyStatus('Scan your court first (step 1 above), then start the match.');
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
    });
    $('btn-join').addEventListener('click', joinMatch);
    $('btn-join-scan').addEventListener('click', () => { S.netDead = false; startScanFlow(); });
    $('btn-lobby-back2').addEventListener('click', () => { netClose(); showLobby('choose'); });
    $('btn-host-scan').addEventListener('click', () => { S.netDead = false; startScanFlow(); });
    $('btn-lobby-start').addEventListener('click', hostStartMatch);
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
      enterCalibrate();
    });
    $('btn-resume-court').addEventListener('click', () => {
      enterCalibrate();
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
