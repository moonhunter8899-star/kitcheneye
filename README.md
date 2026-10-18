# KitchenEye — phone line-judge for pickleball

A static web app (no build step, no npm). One phone scans the court, learns
the ball's color, tracks it, and calls bounces IN / OUT / TOO CLOSE.
**v2 adds multi-phone matches**: one phone hosts, up to three join by code,
every phone scans from its own spot, and the closest phone's call wins.
Host it on GitHub Pages — camera access needs HTTPS.

## What v1 does

- **Court scan** (`js/scan.js`): grab a frame, find court lines with a Hough
  transform — brightness at two thresholds plus a yellow-line pass for
  blended courts (yellow pickleball lines over white tennis lines) — fit the
  best quadrilateral to the 20×44 ft court template
  (kitchen + centerlines break the symmetry so orientation resolves), show
  the detected quad for a human "looks right?", then compute the homography
  (pixel → court feet). Manual fallback: tap the 4 corners in order.
  Calibration persists in localStorage per court name.
- **Ball tracking** (`js/track.js`): tap the ball once to sample its HSV
  color. Per frame (480p): HSV threshold → density-grid blob → nearest to
  the constant-velocity prediction. Bounce = sharp sign flip of image-plane
  vertical velocity plus horizontal slowdown; the contact pixel is
  interpolated between the two frames and mapped through the homography.
- **Line calls** (`js/call.js`): pure functions. Touching paint
  (≤ 2.5 in = ball radius 1.5 in + line half-width 1 in) is IN. Within the
  too-close margin (default 4 in) of that boundary is **TOO CLOSE** — the
  app refuses to guess. Everything else: inside = IN, outside = OUT.
- **App** (`js/app.js`): Home → Camera/Scan → Tap-ball → Live judging, with
  a big banner, WebAudio beeps, a mini top-down court showing the computed
  bounce point, call history, and settings (margin slider, recalibrate,
  rescan). Camera-denied is handled with a plain-language retry screen.
- **NetSync** (`js/netsync.js`): deliberate stub. The v2 seam — message
  shapes are documented there, nothing is built.

## Dispute replay

Every line call is saved (in memory + localStorage, last 100) as a record:
bounce court coords, inches to the line, which line, the call, timestamp.
Tap any entry in **Call history** to open the replay view: a top-down SVG
of the full 20×44 court with the bounce plotted as a color-coded dot
(green IN, red OUT, amber TOO CLOSE), the judged line highlighted, and a
plain-English caption — e.g. "3.2 in past the South baseline — OUT" or
"Touching the West sideline — IN". A **Back to judging** button resumes the
live point exactly where you left it (the judge loop pauses while replaying).

## Scorekeeper

- **Logic** (`js/score.js`): pure, DOM-free, unit-testable. Doubles uses the
  real 3-number format — the game opens **0-0-2** (first serving team starts
  on server 2), server 1 → server 2 on a lost rally, side-out after server 2
  loses, points only for the serving team. Singles: 2-number score, one
  serve, side-out on a lost rally. Serving side follows score parity (even
  score serves from the right court). First to the target (default 11),
  win by 2.
- **Flow**: tap the arm button when the point ends → two big buttons
  ("Us won" / "Them won", team names editable) → score updates, the
  scoreboard refreshes, tap "Start point" for the next. The scoreboard shows
  e.g. **7 – 4 – 2** (serving team's score first) plus a serve line like
  "Us serving · server 2 · right court". A game win shows a banner with the
  final score and a New game button.
- **Settings**: match type (doubles/singles), points to win, team names,
  optional spoken score announcements (Web Speech API, off by default), and
  Reset score. Score and preferences persist in localStorage.

## Testing the pure logic

`js/call.js`, `js/score.js`, `js/replay.js`, and `js/netsync.js` export via
`module.exports` when loaded in node, so they can be unit-tested without a
browser:

```sh
node --check js/netsync.js && node /tmp/test-pickwinner.js  # arbitration
node --check js/score.js && node /tmp/test-score.js          # scoring
```

## How to test on a real court

1. Mount the phone ~6 ft behind the baseline, 8–10 ft high (fence clamp),
   ~5 ft off center, looking down its half of the court.
2. Open the Pages URL. Enter a court name, tap **Set up camera**, allow
   camera access.
3. Court empty: **Scan court** → confirm the green box sits on the lines.
   If it misses, **Tap corners manually** (near-left, near-right,
   far-right, far-left from your viewpoint).
4. Hold/place a ball where the camera sees it, **tap the ball**, then
   **Start judging**.
5. Tap **Start point**, serve, play. Each bounce gets a banner + beep.
6. Sanity check first: drop a ball on the line and 1 ft out — the calls
   should read IN / OUT.

## How to test a 4-phone match

1. Mount 4 phones: 2 behind each baseline, ~6 ft back, 8–10 ft high, each
   ~5 ft off center (fence clamps beat tripods).
2. Phone A: **Multi-phone match → Host a match** → shows a 6-character code.
3. Phones B–D: **Multi-phone match → Join a match** → enter the code →
   **Scan my court** each (auto or manual taps from their own spot) →
   ball color → **Continue** → lobby shows "Waiting for host to start…".
4. Phone A: **1 · Scan my court** → calibrate → **Continue** → back in the
   lobby → **2 · Start match**. Fresh score, all phones judge live.
5. Drop-test near each phone's lines: the nearest phone's call should be
   the one every screen shows. Tap a history entry on any phone — the
   replay diagram should match on all four.

## Honest accuracy limits (read before trusting it)

- **It computes; it doesn't see.** The call comes from mapping the bounce
  pixel through the homography, not from "seeing space" between ball and
  line. Perspective is corrected mathematically — but the correction has
  error bars that grow with distance from the phone and with low mounts.
- **Frame rate is the ceiling.** At 60 fps a driven ball (~40 mph) travels
  ~1 ft between frames; at 30 fps, ~2 ft. The bounce point is interpolated,
  and fast balls near lines are exactly what the TOO CLOSE band is for.
- **The too-close margin is the integrity feature.** Default 4 in. Inside
  the band the app says TOO CLOSE instead of guessing — same spirit as the
  human rule "no clearly-seen space, no out call." Widen it if the phone
  is far from the action.
- **One phone judges its half.** Don't trust calls on the far half of the
  court; that's what the other three phones are for in v2.
- **Scan on an empty court.** Players, shadows across lines, or faded paint
  degrade the auto-scan — use the manual corner taps then.
- **Occlusion.** A player's body between phone and bounce hides the ball;
  the track drops and no call is made (better than a wrong call).

## v2 — multi-phone matches (built)

- **Pairing** (`js/netsync.js`): one phone taps **Multi-phone match →
  Host a match** and shows a QR code plus the 6-character code. The other
  phones tap **Join a match → 📷 Scan QR code** and point at the host's
  screen — the room joins automatically (in-app scanner via lazy-loaded
  jsQR; typing the code manually still works, as does the iPhone Camera app
  via `?r=CODE` links). Star topology over WebRTC via PeerJS (the single
  required CDN dependency; if it can't load, the multi-phone buttons hide
  and solo mode works untouched). The QR itself is drawn on-device by a tiny
  dependency-free encoder (`js/qr.js`, byte mode, ECC-L) — no network call,
  works offline. Game messages are tiny JSON; the only video that travels
  is the low-res director-wall monitor feed (below).
- **Director wall**: while setting up, each joiner taps the corner it's
  standing at (Top/Bottom × Left/Right — required before scanning) and
  publishes a tiny monitor feed (320×180 @ 5 fps via canvas `captureStream`,
  bitrate-capped) to the host. The host lobby shows a 2×2 camera wall — its
  own camera plus every joiner — and a mini court diagram with a dot per
  phone at its declared corner, so the host can direct each phone to its
  mark. (The scan also cross-checks: if the computed position disagrees
  with the tapped corner, the joiner gets a warning.) The host taps
  **Cameras look good — lock in**, which enables **Start match** (any phone
  joining, leaving, or re-scanning unlocks it again for re-confirmation).
  The monitor feed stops when the match starts — it was setup-only.
- **Match format**: the host picks **Singles** (2 phones) or **Doubles**
  (4 phones); the lobby tracks phones present vs. expected and the score
  follows the format.
- **Host Hawk-Eye view**: on the host's judge screen the camera is replaced
  by one big court picture — each call draws the ball's trail plus a
  pulsing landing dot and the IN/OUT banner (the trail rides along in the
  bounce report, ~10 court-coordinate points). The host's camera keeps
  tracking with its video element hidden. Joiners keep their camera view.
- **Flow**: every phone scans the court from its own position (auto or
  manual taps — the kitchen/centerline template match disambiguates each
  phone's orientation, so all share one court coordinate frame), picks the
  ball color, then waits in the lobby. The host taps **Start match** and
  all phones judge live.
- **Arbitration**: each bounce report carries `{x, y, at, size}` in court
  feet on the host clock (joiners sync via 5 ping/pong rounds, median
  offset). The host opens a 300 ms collection window on the first report,
  then `pickWinner()` takes the **largest ball `size`** — the closest phone
  sees the biggest ball, hence the smallest error; ties break to the
  earliest timestamp. The call is computed once and broadcast as
  `{t:'call', rec}`; every phone renders, sounds, and stores it, so
  dispute replay works identically on all four.
- **Score**: the host owns the Score. Joiners see the same who-won prompt;
  their taps send `{t:'who-won', team}` to the host, which scores and
  broadcasts `{t:'score', state}`. Cross-phone double-taps for one point
  are debounced (3 s) on the host.
- **Disconnects**: a joiner leaving just drops off the host's list. If the
  host leaves, joiners show "Host left — match over" with a Home button
  and stop judging (no local guessing after a session dies).

### v2 honest limits

- **Internet once.** The PeerJS handshake needs internet; after that,
  same-WiFi keeps latency lowest, but phones on different networks still
  work through PeerJS's cloud relay.
- **Orientation depends on the scan.** Each phone resolves its own court
  orientation from the kitchen/centerline template match. If a phone's
  auto-scan locks on mirrored (rare, and the "looks right?" confirm is
  the guard), its calls mirror too — rescan if the replay diagram looks
  flipped.
- **Host is a single point of failure.** Host dies → match over.
- **Keep the host awake while phones join.** The room only exists while
  the host phone holds its link to the match server. If the host's screen
  sleeps, Safari backgrounds, or it leaves the Room code screen, the room
  vanishes and joiners get "that room is gone". The app now auto-reconnects
  when the host tab wakes and says so on screen — but during the join phase,
  keep the host on the Room code screen with the screen on.
- **Size comparison assumes equal processing.** All phones run detection
  at 480 px wide, so blob sizes are comparable. A phone with heavy
  digital zoom would report inflated sizes — don't zoom.
- **Not tested with 4 real phones yet.** Logic is unit-tested
  (`pickWinner`, clock math shape, message routing), but the real proof
  is a 4-phone court session.

## Future ideas (not built)

- 2 net-post phones for kitchen-line / NVZ fault calls.
- Automatic scorekeeping: infer the rally winner from bounce patterns
  (out-bounce on a side = that side wins) with a confirm/override prompt.

## Files

| File | What |
|---|---|
| `index.html` | Screens: Home → Camera/Scan → Calibrate → Judge |
| `styles.css` | Dark phone-first theme |
| `js/call.js` | Pure line-call logic (testable in node) |
| `js/replay.js` | Dispute-replay SVG + captions (testable in node) |
| `js/score.js` | Pure pickleball scoring logic (testable in node) |
| `js/scan.js` | Hough court detection + homography + persistence |
| `js/track.js` | HSV ball tracking + bounce detection (reports ball `size`) |
| `js/netsync.js` | v2 multi-phone sync: PeerJS host/join, clock sync, pickWinner |
| `js/qr.js` | Dependency-free QR encoder for the host's join link (verified vs jsqr) |
| `js/app.js` | State machine + camera + judge loop |
