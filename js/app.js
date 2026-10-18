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
    netsync: null,
    armed: false,
    marginIn: 4,
    judging: false,
    lastCallAt: 0,
    audio: null,
    manualTaps: [],
    calls: [],              // dispute-replay records (persisted)
    replayId: null,
    score: null,            // Score instance (js/score.js)
    scorePrefs: { mode: 'doubles', target: 11, teamUs: 'Us', teamThem: 'Them', speech: false },
  };

  function showScreen(name) {
    S.screen = name;
    ['home', 'camera', 'calibrate', 'judge', 'replay'].forEach(n => {
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
      await S.video.play().catch(() => {});
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

  function drawVideoFrame() {
    S.octx.clearRect(0, 0, S.overlay.width, S.overlay.height);
    S.octx.drawImage(S.video, 0, 0, S.overlay.width, S.overlay.height);
  }

  // ---------- scan ----------
  async function runScan() {
    setStatus('scan-status', 'Scanning… hold the phone steady, court empty.');
    try {
      await new Promise(r => setTimeout(r, 60)); // let the status paint
      const res = detectCourt(S.video, SEGMENTS);
      if (!res) {
        setStatus('scan-status', 'No court found. Try better light, or tap "Tap corners manually".');
        return;
      }
      S.pendingScan = res;
      drawVideoFrame();
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
    } catch (e) {
      console.warn('scan failed', e);
      setStatus('scan-status', 'Scan failed: ' + e.message);
    }
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
    S.manualTaps = [];
    drawVideoFrame();
    setStatus('scan-status', 'Tap the 4 corners in order: near-left, near-right, far-right, far-left.');
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
  function enterCalibrate() {
    showScreen('calibrate');
    drawCalPreview();
    setStatus('cal-status', 'Tap the ball in the picture so the tracker learns its color.');
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
      setStatus('cal-status', 'Ball color learned. Tap "Start judging".');
      $('btn-start-judge').disabled = false;
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

  function drawJudgeOverlay(det) {
    const c = S.octx, W = S.overlay.width, Hh = S.overlay.height;
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

  function onBounce(b) {
    let cx, cy;
    try {
      [cx, cy] = applyHomography(S.H, b.x, b.y);
    } catch (e) { return; }
    // Ignore bounces far from the court (another court, dead ball rolling).
    if (cx < -8 || cx > 28 || cy < -8 || cy > 52) return;
    const res = judge(cx, cy, S.marginIn);
    S.netsync.sendBounce(cx, cy, b.t); // v2 seam: broadcast to other phones
    showCall(res, cx, cy);
    callSound(res.call);
    // Dispute-replay record: everything the replay view needs.
    const rec = {
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
    S.calls.unshift(rec);
    if (S.calls.length > 100) S.calls.length = 100;
    saveCalls();
    renderHistory();
    S.lastCallAt = performance.now();
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

  // ---------- boot ----------
  function init() {
    S.video = $('cam-video');
    S.overlay = $('cam-overlay');
    S.octx = S.overlay.getContext('2d');
    S.proc = document.createElement('canvas');
    S.pctx = S.proc.getContext('2d', { willReadFrequently: true });
    S.tracker = new BallTracker();
    S.netsync = new NetSync();
    loadCalls();
    renderHistory();
    loadScore();

    window.addEventListener('resize', () => { if (S.video && S.video.videoWidth) sizeOverlay(); });
    S.overlay.addEventListener('click', onOverlayTap);
    $('cal-canvas').addEventListener('click', onCalTap);

    $('btn-setup').addEventListener('click', async () => {
      S.courtName = ($('court-name').value || 'home-court').trim() || 'home-court';
      // unlock audio on the user gesture
      try {
        if (!S.audio) S.audio = new (window.AudioContext || window.webkitAudioContext)();
        if (S.audio.state === 'suspended') S.audio.resume();
      } catch (e) {}
      const ok = await startCamera();
      if (!ok) return;
      // offer a saved court to skip the scan
      const saved = loadCourt(S.courtName);
      if (saved && saved.H) {
        S.H = saved.H;
        $('resume-court').classList.remove('hidden');
        setStatus('scan-status', 'Saved calibration found for "' + S.courtName + '". Resume it, or scan fresh below.');
      } else {
        $('resume-court').classList.add('hidden');
        setStatus('scan-status', 'Aim at the empty court so all four corners are visible, then tap Scan court.');
      }
      showScreen('camera');
      drawVideoFrame();
    });

    $('btn-retry-cam').addEventListener('click', async () => {
      if (await startCamera()) {
        showScreen('camera');
        drawVideoFrame();
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

    $('btn-start-judge').addEventListener('click', enterJudge);

    // dispute replay + scorekeeper wiring
    $('btn-replay-back').addEventListener('click', resumeJudge);
    $('btn-us-won').addEventListener('click', () => recordPoint('us'));
    $('btn-them-won').addEventListener('click', () => recordPoint('them'));
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
      showScreen('camera'); drawVideoFrame();
      setStatus('scan-status', 'Aim at the empty court, then tap Scan court.');
    });
    $('btn-home').addEventListener('click', () => {
      S.armed = false;
      if (S.stream) { S.stream.getTracks().forEach(t => t.stop()); S.stream = null; }
      showScreen('home');
    });

    // prefill saved court names
    try {
      const names = listCourts();
      if (names.length) $('court-name').value = names[0];
    } catch (e) {}

    showScreen('home');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
