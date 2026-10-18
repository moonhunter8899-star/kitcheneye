/* KitchenEye — pickleball scorekeeper (PURE logic, no DOM).
 *
 * Standard USA Pickleball scoring:
 *  - Only the serving team can score. Win a rally on serve = +1 point.
 *  - Doubles: two servers per side-out (server 1, then server 2), except the
 *    very first service turn of the game, which starts at server 2 ("0-0-2").
 *    Lose a rally on server 1 -> server 2. Lose it on server 2 -> side-out.
 *  - Singles: one serve; lose a rally on serve -> side-out.
 *  - Serving side: the serving team's score parity picks the court —
 *    even score serves from the right (even) court, odd from the left.
 *  - Game: first to `target` (default 11), win by 2.
 *
 * Teams are the abstract keys 'us' / 'them'; the UI maps display names.
 * All state is JSON-serializable via state() / Score.fromState().
 */
'use strict';

const SCORE_MODES = ['doubles', 'singles'];

function clampTarget(t) {
  const n = Math.round(Number(t));
  if (!Number.isFinite(n)) return 11;
  return Math.max(1, Math.min(30, n));
}

class Score {
  constructor(opts) {
    opts = opts || {};
    this.mode = opts.mode === 'singles' ? 'singles' : 'doubles';
    this.target = clampTarget(opts.target);
    this.scores = { us: 0, them: 0 };
    this.serving = 'us';   // which team holds the serve
    this.server = 2;       // doubles: the game opens 0-0-2
    this.over = false;
    this.winner = null;
  }

  other() {
    return this.serving === 'us' ? 'them' : 'us';
  }

  /**
   * Record a rally winner ('us' | 'them').
   * Returns an event the UI can speak/display:
   *   { type: 'point', team, scoreText }
   *   { type: 'second-serve', team, scoreText }
   *   { type: 'side-out', nowServing, scoreText }
   *   { type: 'game-over', winner, scoreText }
   */
  rallyWon(team) {
    if (this.over) {
      return { type: 'game-over', winner: this.winner, scoreText: this.scoreText() };
    }
    if (team !== 'us' && team !== 'them') {
      throw new Error('rallyWon: team must be "us" or "them"');
    }

    if (team === this.serving) {
      this.scores[team] += 1;
      const lead = this.scores[team] - this.scores[this.other()];
      if (this.scores[team] >= this.target && lead >= 2) {
        this.over = true;
        this.winner = team;
        return { type: 'game-over', winner: team, scoreText: this.scoreText() };
      }
      return { type: 'point', team, scoreText: this.scoreText() };
    }

    // Serving team lost the rally: no point, serve rotates or side-out.
    if (this.mode === 'doubles' && this.server === 1) {
      this.server = 2;
      return { type: 'second-serve', team: this.serving, scoreText: this.scoreText() };
    }
    this.serving = this.other();
    this.server = 1;
    return { type: 'side-out', nowServing: this.serving, scoreText: this.scoreText() };
  }

  /** On-court call format: serving team's score first. Doubles: "7 – 4 – 2". */
  scoreText() {
    const a = this.scores.us;
    const b = this.scores.them;
    const head = this.serving === 'us' ? a + ' – ' + b : b + ' – ' + a;
    return this.mode === 'doubles' ? head + ' – ' + this.server : head;
  }

  /** Which court the server serves from, by serving-team score parity. */
  servingSide() {
    return this.scores[this.serving] % 2 === 0 ? 'even' : 'odd';
  }

  reset() {
    this.scores = { us: 0, them: 0 };
    this.serving = 'us';
    this.server = 2;
    this.over = false;
    this.winner = null;
  }

  state() {
    return {
      mode: this.mode,
      target: this.target,
      scores: { us: this.scores.us, them: this.scores.them },
      serving: this.serving,
      server: this.server,
      over: this.over,
      winner: this.winner,
    };
  }

  static fromState(st) {
    if (!st || typeof st !== 'object') throw new Error('bad score state');
    const s = new Score({ mode: st.mode, target: st.target });
    for (const k of ['us', 'them']) {
      const v = st.scores && st.scores[k];
      if (!Number.isInteger(v) || v < 0) throw new Error('bad score state: scores');
      s.scores[k] = v;
    }
    if (st.serving !== 'us' && st.serving !== 'them') throw new Error('bad score state: serving');
    if (st.server !== 1 && st.server !== 2) throw new Error('bad score state: server');
    s.serving = st.serving;
    s.server = st.server;
    s.over = !!st.over;
    s.winner = st.winner === 'us' || st.winner === 'them' ? st.winner : null;
    if (s.over && !s.winner) throw new Error('bad score state: winner');
    return s;
  }
}

// Export for browser (<script> globals) and node (tests).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Score, SCORE_MODES, clampTarget };
}
