# KitchenEye v1 — phone line-judge for pickleball

A static web app (no build, no libraries, no server). One phone scans the
court, learns the ball's color, tracks it, and calls bounces IN / OUT /
TOO CLOSE. Host it on GitHub Pages — camera access needs HTTPS.

## What v1 does

- **Court scan** (`js/scan.js`): grab a frame, find white lines with a Hough
  transform, fit the best quadrilateral to the 20×44 ft court template
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

`js/call.js`, `js/score.js`, and `js/replay.js` export via `module.exports`
when loaded in node, so they can be unit-tested without a browser:

```sh
node --check js/score.js && node /tmp/test-score.js
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

## v2 roadmap (not built)

- QR-code pairing: one phone hosts, three join over court WiFi.
- WebRTC data channels exchange `{ type:'bounce', x, y, t }` — video never
  leaves the phones.
- Nearest-phone-wins arbitration; merged duplicates by time + position.
- Optional: 2 net-post phones for kitchen-line / NVZ fault calls.

## Files

| File | What |
|---|---|
| `index.html` | Screens: Home → Camera/Scan → Calibrate → Judge |
| `styles.css` | Dark phone-first theme |
| `js/call.js` | Pure line-call logic (testable in node) |
| `js/replay.js` | Dispute-replay SVG + captions (testable in node) |
| `js/score.js` | Pure pickleball scoring logic (testable in node) |
| `js/scan.js` | Hough court detection + homography + persistence |
| `js/track.js` | HSV ball tracking + bounce detection |
| `js/netsync.js` | v2 stub (message shapes documented) |
| `js/app.js` | State machine + camera + judge loop |
