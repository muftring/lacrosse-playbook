// Draw Sim — tick engine + playback controls (step 2), center mechanics
// (step 3), circle/wing player attributes + reaction/movement (step 4),
// and probabilistic contest resolution + outcome logging (step 5 of 6).
//
// Talks to renderer/app.js only through the small read-only bridge it
// exposes (window._laxState, window._laxGetView) and the shared fabric
// canvas (window._fabricCanvas) — no changes to app.js's own logic.
(function() {
  'use strict';

  const TICK_MS = 250;          // sim time per tick at 1x speed
  const MAX_TICKS = 120;        // ~30s draw at 250ms/tick
  const ARC_TICKS = 12;         // ~3s for the whistle-to-landing arc
  const ARC_MAX_HEIGHT = 34;    // px — purely visual, drives the shadow offset
  const WING_SPEED_PX_PER_TICK = 4;  // px per tick at speed=1
  const CONTEST_RADIUS = 14;         // px — close enough to the ball to contest it
  const CATCHABLE_Z = 18;            // px — ball height below which it's reachable
  const CONTEST_WINDOW_TICKS = 3;    // grace ticks after the first arrival, so a
                                      // trailing opponent can still get in on the roll
  const SCRUM_MARGIN = 0.15;         // relative weight gap under which it's a "50/50"
  const DRAW_LOG_KEY = 'lax_draw_log';
  const DRAW_LOG_MAX = 200;          // persisted cap; the panel only shows the most recent 20
  const DRAW_LOG_DISPLAY = 20;

  const canvas = window._fabricCanvas;

  function laxState() { return window._laxState; }
  function currentView() { return window._laxGetView ? window._laxGetView() : null; }

  // A Draw Setup is "active" once its 6 markers + ball are on the field —
  // matches what placeDrawSetup() in app.js produces, without depending on it.
  function drawSetupActive() {
    const s = laxState();
    return !!(s && s.ball && s.teams.a.players.length === 3 && s.teams.b.players.length === 3);
  }

  // The 7 real gameplay objects (used for change-detection and captured into
  // tick history). The ball-shadow (added below) is a sim.js-owned visual
  // extra, tracked separately so it doesn't confuse "did Draw Setup change?".
  function simObjects() {
    const s = laxState();
    const objs = [];
    s.teams.a.players.forEach(p => objs.push(p.circleObj));
    s.teams.b.players.forEach(p => objs.push(p.circleObj));
    objs.push(s.ball);
    return objs;
  }

  function sameObjects(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((obj, i) => obj === b[i]);
  }

  function captureTick(objs) {
    return objs.map(obj => ({ obj, left: obj.left, top: obj.top }));
  }

  function applyTick(tick) {
    if (!tick) return;
    tick.forEach(entry => entry.obj.set({ left: entry.left, top: entry.top }).setCoords());
    canvas.requestRenderAll();
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function dist(p1, p2) { return Math.hypot(p1.left - p2.left, p1.top - p2.top); }

  // ─── Center attributes ────────────────────────────────────────────────────
  // Keyed by player id (survives a marker's own object identity changing on
  // resize/reload) rather than stored on the player record, so this stays
  // decoupled from app.js's placePlayer()/placeDrawSetup(). Wrapped in
  // Vue.reactive so the attributes panel below updates live.
  const centerAttrsStore = Vue.reactive({});

  function defaultCenterAttrs() {
    return {
      draw_technique: 3,
      reaction_time: 3,
      reach: 3,
      experience: 3,
      energy: 3,
      tendency: { batLeft: '', cleanCatch: '', batRight: '' },
    };
  }

  function getCenterAttrs(playerId) {
    if (!centerAttrsStore[playerId]) centerAttrsStore[playerId] = defaultCenterAttrs();
    return centerAttrsStore[playerId];
  }

  function getCenterPlayer(teamKey) {
    const s = laxState();
    return s.teams[teamKey].players.find(p => p.num === 'C') || null;
  }

  function tendencyIsValid(tendency) {
    const { batLeft, cleanCatch, batRight } = tendency;
    if (batLeft === '' || cleanCatch === '' || batRight === '') return false;
    return Number(batLeft) + Number(cleanCatch) + Number(batRight) === 100;
  }

  // The action a center's tendency profile says they favor most.
  function dominantTendencyAction(tendency) {
    const entries = [
      ['batLeft', Number(tendency.batLeft)],
      ['cleanCatch', Number(tendency.cleanCatch)],
      ['batRight', Number(tendency.batRight)],
    ];
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0][0];
  }

  // ─── Circle/wing attributes ───────────────────────────────────────────────
  const wingAttrsStore = Vue.reactive({});

  function defaultWingAttrs() {
    // energy added in step 5: the contest-weighting requirement calls for an
    // energy multiplier, but the step 3/4 wing attribute set (taken from the
    // original design doc entity list) never included one — centers had it,
    // wings didn't. Extending the set here rather than reusing a mismatched
    // stand-in attribute; see the design doc for the corrected entity list.
    return { speed: 3, anticipation: 3, vertical: 3, ground_ball: 3, positioning_discipline: 3, energy: 3 };
  }

  function getWingAttrs(playerId) {
    if (!wingAttrsStore[playerId]) wingAttrsStore[playerId] = defaultWingAttrs();
    return wingAttrsStore[playerId];
  }

  // ─── Draw call (per-team action selection) ───────────────────────────────
  (function ensureDrawCallDefaults() {
    const s = laxState();
    if (s && !s.drawCall) s.drawCall = { a: 'cleanCatch', b: 'cleanCatch' };
  })();

  const ACTION_LABELS = {
    cleanCatch: 'Clean Catch',
    batOpen: 'Bat to Open Space',
    batLeft: 'Bat to Left Teammate',
    batRight: 'Bat to Right Teammate',
  };

  // ─── Outcome log (shared between the playback bar and the outcome panel) ──
  // Populated once per run: on a short-draw violation, or once the contest
  // resolves. Cleared on Reset / a fresh Draw Setup so a stale result never
  // outlives the field state it described.
  const outcomeState = Vue.reactive({ result: null });

  // ─── Draw run history (step 6) ────────────────────────────────────────────
  // Persisted the same way saved formations are (see getFormations()/
  // persistFormations() in app.js): a flat JSON array in localStorage. Kept
  // deliberately simple/flat — this feeds the future Phase 3 stats module
  // described in the design doc's Roadmap, not meant to be that module's
  // final schema.
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  function getDrawLog() {
    try {
      const s = localStorage.getItem(DRAW_LOG_KEY);
      return s ? JSON.parse(s) : [];
    } catch (_) { return []; }
  }

  function persistDrawLog(log) {
    localStorage.setItem(DRAW_LOG_KEY, JSON.stringify(log));
  }

  // Reactive mirror of localStorage so the Draw Log panel updates live;
  // seeded from whatever was already persisted, so a relaunch shows history
  // from before the app was closed.
  const drawLogState = Vue.reactive({ entries: getDrawLog() });

  function teamSnapshot(teamKey) {
    const s = laxState();
    const center = getCenterPlayer(teamKey);
    const attrs = center ? getCenterAttrs(center.id) : null;
    return {
      name: s.teams[teamKey].name,
      drawCall: s.drawCall[teamKey],
      drawTechnique: attrs ? attrs.draw_technique : null,
    };
  }

  // Called once per run: either from _startDraw()'s violation branch, or
  // from _checkContest() once a winner's picked.
  function recordDrawRun({ legal, winnerTeam, winnerPlayerLabel, scrum }) {
    const entry = {
      id: uid(),
      timestamp: Date.now(),
      teamA: teamSnapshot('a'),
      teamB: teamSnapshot('b'),
      legal,
      winnerTeam: winnerTeam || null,
      winnerPlayerLabel: winnerPlayerLabel || null,
      scrum: !!scrum,
      violation: !legal,
    };
    const log = getDrawLog();
    log.unshift(entry); // most-recent-first, matches how the panel displays it
    if (log.length > DRAW_LOG_MAX) log.length = DRAW_LOG_MAX;
    persistDrawLog(log);
    drawLogState.entries = log;
  }

  // ─── Legal-draw check + arc physics ───────────────────────────────────────
  function checkLegalDraw(attrsA, attrsB) {
    // Simple, deterministic threshold — real contest randomness is step 5's
    // job. Both centers weak on technique (e.g. both at 1) fails; anything
    // reasonably competent (avg >= 2) clears.
    return (attrsA.draw_technique + attrsB.draw_technique) / 2 >= 2;
  }

  function posOf(player) {
    return player ? { left: player.circleObj.left, top: player.circleObj.top } : null;
  }

  function midpointExtended(p1, p2, origin, extend) {
    const mid = { left: (p1.left + p2.left) / 2, top: (p1.top + p2.top) / 2 };
    return {
      left: origin.left + (mid.left - origin.left) * extend,
      top: origin.top + (mid.top - origin.top) * extend,
    };
  }

  function generateArcFrames(startPos, targetPos, ticks, maxHeight) {
    const frames = [];
    for (let i = 1; i <= ticks; i++) {
      const p = i / ticks;
      const eased = 1 - Math.pow(1 - p, 2); // ease-out drift toward the target
      frames.push({
        groundLeft: lerp(startPos.left, targetPos.left, eased),
        groundTop: lerp(startPos.top, targetPos.top, eased),
        z: maxHeight * 4 * p * (1 - p), // up-then-down parabola, 0 at both ends
      });
    }
    return frames;
  }

  // Which team "controls" the outcome for this simplified step — the center
  // with the higher draw_technique. Real contested possession is step 5;
  // for now this just decides whose action selection the arc aims for.
  function computeDrawOutcome() {
    const s = laxState();
    const centerA = getCenterPlayer('a');
    const centerB = getCenterPlayer('b');
    if (!centerA || !centerB || !s.ball) return { legal: true, frames: [] };

    const attrsA = getCenterAttrs(centerA.id);
    const attrsB = getCenterAttrs(centerB.id);
    if (!checkLegalDraw(attrsA, attrsB)) return { legal: false };

    const controlling = attrsA.draw_technique >= attrsB.draw_technique ? 'a' : 'b';
    const controllingAttrs = controlling === 'a' ? attrsA : attrsB;
    const opposingAttrs = controlling === 'a' ? attrsB : attrsA;
    const action = s.drawCall[controlling];

    const startPos = { left: s.ball.left, top: s.ball.top };
    const w1 = posOf(s.teams[controlling].players.find(p => p.num === 'W1'));
    const w2 = posOf(s.teams[controlling].players.find(p => p.num === 'W2'));

    let target = startPos; // cleanCatch — roughly straight up, near the hash
    if (action === 'batLeft' && w1) target = w1;
    else if (action === 'batRight' && w2) target = w2;
    else if (action === 'batOpen' && w1 && w2) target = midpointExtended(w1, w2, startPos, 1.3);

    // Opposing center's technique + reach disrupts intent, pulling the
    // outcome back toward the start point.
    const disruption = clamp((opposingAttrs.draw_technique + opposingAttrs.reach - 2) / 8, 0, 0.6);
    const finalTarget = {
      left: lerp(target.left, startPos.left, disruption),
      top: lerp(target.top, startPos.top, disruption),
    };

    // Controlling center's own technique determines how closely the result
    // matches intent — lower technique adds scatter.
    const accuracy = controllingAttrs.draw_technique / 5;
    const jitter = (1 - accuracy) * 22;
    finalTarget.left += (Math.random() * 2 - 1) * jitter;
    finalTarget.top += (Math.random() * 2 - 1) * jitter;

    return {
      legal: true,
      frames: generateArcFrames(startPos, finalTarget, ARC_TICKS, ARC_MAX_HEIGHT),
      controlling,
      action,
      finalGroundTarget: finalTarget,
    };
  }

  // ─── Circle/wing reaction state machine ──────────────────────────────────
  // IDLE (counting down reaction delay) -> REACT (moving toward a predicted
  // landing point) -> SETTLED (close enough to the ball, stop). Set up once
  // per whistle from computeDrawOutcome()'s result; advanced one tick at a
  // time from _pushNewTick() below, right alongside the ball's own arc.
  function setupWingRuntime(finalGroundTarget, controllingTeam, action) {
    const s = laxState();
    const runtime = {};
    ['a', 'b'].forEach(team => {
      const opposingCenterTeam = team === 'a' ? 'b' : 'a';
      const oppCenter = getCenterPlayer(opposingCenterTeam);
      const oppAttrs = oppCenter ? getCenterAttrs(oppCenter.id) : null;
      // Scouting bonus: this team reads the opposing center's tendency. It
      // only pays off when that center is the one actually controlling the
      // draw this run, and their chosen action matches their own tendency.
      let anticipationBonus = 0;
      if (opposingCenterTeam === controllingTeam && oppAttrs && tendencyIsValid(oppAttrs.tendency)) {
        if (dominantTendencyAction(oppAttrs.tendency) === action) anticipationBonus = 1;
      }

      ['W1', 'W2'].forEach(num => {
        const player = s.teams[team].players.find(p => p.num === num);
        if (!player) return;
        const attrs = getWingAttrs(player.id);
        const effectiveAnticipation = clamp(attrs.anticipation + anticipationBonus, 1, 5);

        // Lower anticipation = slower to react and a worse read on where
        // the ball's actually headed.
        const reactionDelay = clamp(5 - effectiveAnticipation, 0, 4);
        const errorMag = (5 - effectiveAnticipation) * 6; // px
        const angle = Math.random() * Math.PI * 2;
        const predictedTarget = {
          left: finalGroundTarget.left + Math.cos(angle) * errorMag,
          top: finalGroundTarget.top + Math.sin(angle) * errorMag,
        };

        runtime[player.id] = {
          state: reactionDelay > 0 ? 'IDLE' : 'REACT',
          reactionDelay,
          predictedTarget,
        };
      });
    });
    return runtime;
  }

  // ─── Playback bar (tick engine + Play/Pause/Step/Reset) ──────────────────
  const SimPlaybackBar = {
    template: `
      <div id="sim-playback-wrap" v-show="visible">
        <div id="sim-playback-bar">
          <button class="sim-btn" @click="stepBack" :disabled="playing || currentTick <= 0" title="Step Back">⏮</button>
          <button class="sim-btn primary" @click="togglePlay" :disabled="atEnd && !playing" :title="playing ? 'Pause' : 'Play'">
            {{ playing ? '⏸' : '▶' }}
          </button>
          <button class="sim-btn" @click="stepForward" :disabled="playing || atEnd" title="Step Forward">⏭</button>
          <button class="sim-btn secondary" @click="reset" title="Reset to tick 0">↺ Reset</button>

          <input class="sim-scrub" type="range" min="0" :max="historyLength - 1"
                 :value="currentTick" @input="onScrub($event.target.value)" />

          <span class="sim-readout">tick {{ currentTick }} / {{ maxTicks - 1 }} &middot; {{ currentSeconds }}s</span>

          <select class="sim-speed" v-model.number="speed" title="Playback speed">
            <option :value="0.5">0.5x</option>
            <option :value="1">1x</option>
            <option :value="2">2x</option>
          </select>
        </div>
      </div>
    `,
    data() {
      return {
        visible: false,
        playing: false,
        speed: 1,
        currentTick: 0,
        historyLength: 0,
        maxTicks: MAX_TICKS,
      };
    },
    computed: {
      atEnd() { return this.currentTick >= this.maxTicks - 1; },
      currentSeconds() { return (this.currentTick * TICK_MS / 1000).toFixed(2); },
    },
    mounted() {
      this._history = [];
      this._watchedObjs = null; // the 7 real gameplay objects, for change detection
      this._objs = null;        // watched objects + ball shadow, for tick capture
      this._shadowObj = null;
      this._dirty = false;
      this._timer = null;
      this._arcQueue = null;
      this._wingRuntime = null;
      this._ballZ = 0;
      this._possession = null;
      this._contestWindow = null;
      this._callInfo = null;

      // Any drag/reposition of a sim marker while paused marks the current
      // tick "dirty" — the next advance discards recorded future ticks and
      // re-records from this edited state (branch semantics).
      canvas.on('object:modified', (opt) => {
        if (!this.visible || this.playing) return;
        if (this._objs && this._objs.some(e => e.obj === opt.target)) this._dirty = true;
      });

      this._pollTimer = setInterval(() => this._poll(), 200);
      this._poll();
    },
    beforeUnmount() {
      clearInterval(this._pollTimer);
      clearTimeout(this._timer);
    },
    methods: {
      _setupShadow(ballObj) {
        if (this._shadowObj) canvas.remove(this._shadowObj);
        const shadow = new fabric.Circle({
          left: ballObj.left,
          top: ballObj.top,
          radius: 6,
          fill: 'rgba(0,0,0,0.28)',
          stroke: 'transparent',
          originX: 'center',
          originY: 'center',
          selectable: false,
          evented: false,
          _isBallShadow: true,
        });
        canvas.add(shadow);
        const ballIdx = canvas.getObjects().indexOf(ballObj);
        canvas.moveTo(shadow, Math.max(1, ballIdx));
        this._shadowObj = shadow;
      },

      _poll() {
        const active = drawSetupActive() && currentView() === 'draw';
        if (!active) { this.visible = false; return; }

        const objs = simObjects();
        if (!sameObjects(objs, this._watchedObjs)) {
          // First activation, or a fresh "Draw Setup" click replaced the
          // markers — (re)anchor tick 0 to whatever's on the field now.
          this._watchedObjs = objs;
          this._setupShadow(objs[objs.length - 1]); // ball is last of the 7
          this._objs = [...objs, this._shadowObj];
          this._history = [captureTick(this._objs)];
          this._dirty = false;
          this.playing = false;
          clearTimeout(this._timer);
          this.currentTick = 0;
          this.historyLength = 1;
          this._arcQueue = null;
          this._wingRuntime = null;
          this._ballZ = 0;
          this._possession = null;
          this._contestWindow = null;
          this._callInfo = null;
          outcomeState.result = null;
        }
        this.visible = true;
      },

      // Moves each circle/wing player one tick's worth toward its predicted
      // landing point (or leaves it alone if still IDLE, or if a contest has
      // already resolved). Runs post-whistle, in lockstep with the ball's own
      // arc/rest ticks. Reaching the ball is handled separately by
      // _checkContest() below — this method never stops a player on its own.
      _updateWingPlayers() {
        if (!this._wingRuntime) return;
        const s = laxState();

        ['a', 'b'].forEach(team => {
          ['W1', 'W2'].forEach(num => {
            const player = s.teams[team].players.find(p => p.num === num);
            if (!player) return;
            const rt = this._wingRuntime[player.id];
            if (!rt) return;

            if (rt.state === 'IDLE') {
              rt.reactionDelay--;
              if (rt.reactionDelay <= 0) rt.state = 'REACT';
              return;
            }

            const obj = player.circleObj;
            const toTarget = { left: rt.predictedTarget.left - obj.left, top: rt.predictedTarget.top - obj.top };
            const distToTarget = Math.hypot(toTarget.left, toTarget.top);
            if (distToTarget < 1) return; // reached its (possibly wrong) read — nothing more to do
            const attrs = getWingAttrs(player.id);
            const step = attrs.speed * WING_SPEED_PX_PER_TICK;
            const t = Math.min(1, step / distToTarget);
            obj.set({ left: obj.left + toTarget.left * t, top: obj.top + toTarget.top * t }).setCoords();
          });
        });
        canvas.requestRenderAll();
      },

      // Checks whether the ball is close to being caught or scooped up.
      // Anyone within CONTEST_RADIUS while the ball's at or below catchable
      // height joins a short grace window (CONTEST_WINDOW_TICKS) so a
      // trailing opponent has a real chance to get in on the roll before it
      // resolves — otherwise whoever merely arrives first would always win
      // outright, and the weighted contest in requirement 2 would rarely
      // matter. Returns true the tick it actually resolves a winner.
      _checkContest() {
        if (this._possession || !this._wingRuntime) return false;
        if (this._ballZ > CATCHABLE_Z) return false;

        const s = laxState();
        const ballGround = this._shadowObj
          ? { left: this._shadowObj.left, top: this._shadowObj.top }
          : { left: s.ball.left, top: s.ball.top };

        const nearby = [];
        ['a', 'b'].forEach(team => {
          ['W1', 'W2'].forEach(num => {
            const player = s.teams[team].players.find(p => p.num === num);
            if (!player) return;
            if (dist({ left: player.circleObj.left, top: player.circleObj.top }, ballGround) <= CONTEST_RADIUS) {
              nearby.push({ player, team });
            }
          });
        });

        if (!this._contestWindow) {
          if (!nearby.length) return false;
          this._contestWindow = { ticksLeft: CONTEST_WINDOW_TICKS, byId: new Map() };
        }
        nearby.forEach(c => this._contestWindow.byId.set(c.player.id, c));
        this._contestWindow.ticksLeft--;
        if (this._contestWindow.ticksLeft > 0) return false;

        const isAirborne = this._ballZ > 0;
        const weighted = [...this._contestWindow.byId.values()].map(c => {
          const attrs = getWingAttrs(c.player.id);
          const base = isAirborne
            ? attrs.speed + attrs.vertical
            : attrs.ground_ball + attrs.positioning_discipline;
          return { ...c, weight: Math.max(0.01, base * (attrs.energy / 5)) };
        });

        // Weighted random roll — deliberately non-deterministic. Normalizing
        // to probabilities first would be equivalent to this cumulative-sum
        // draw, so we skip the intermediate step.
        const total = weighted.reduce((sum, c) => sum + c.weight, 0);
        let r = Math.random() * total;
        let winner = weighted[weighted.length - 1];
        for (const c of weighted) {
          if (r < c.weight) { winner = c; break; }
          r -= c.weight;
        }

        // "50/50" means the two TEAMS are close, not any two individual
        // players — two teammates with identical attributes both being in
        // range would otherwise always tie with each other and falsely read
        // as a scrum even when their team heavily outweighs the opponent.
        const teamTotals = {};
        weighted.forEach(c => { teamTotals[c.team] = (teamTotals[c.team] || 0) + c.weight; });
        const teamsPresent = Object.keys(teamTotals);
        let scrum = false;
        if (teamsPresent.length === 2) {
          const [t1, t2] = teamsPresent;
          scrum = Math.abs(teamTotals[t1] - teamTotals[t2]) / Math.max(teamTotals[t1], teamTotals[t2]) <= SCRUM_MARGIN;
        }

        const winPos = { left: winner.player.circleObj.left, top: winner.player.circleObj.top };
        s.ball.set(winPos).setCoords();
        if (this._shadowObj) this._shadowObj.set(winPos).setCoords();
        this._ballZ = 0;
        this._possession = { team: winner.team, playerId: winner.player.id };

        outcomeState.result = {
          type: 'resolved',
          callingTeam: this._callInfo ? this._callInfo.controlling : null,
          action: this._callInfo ? this._callInfo.action : null,
          winnerTeam: winner.team,
          scrum,
          contestType: isAirborne ? 'airborne' : 'ground',
        };
        recordDrawRun({ legal: true, winnerTeam: winner.team, winnerPlayerLabel: winner.player.num, scrum });
        return true;
      },

      _pushNewTick() {
        if (this.historyLength >= this.maxTicks) return false;
        if (this._arcQueue && this._arcQueue.length) {
          const frame = this._arcQueue.shift();
          const ball = laxState().ball;
          ball.set({ left: frame.groundLeft, top: frame.groundTop - frame.z }).setCoords();
          if (this._shadowObj) this._shadowObj.set({ left: frame.groundLeft, top: frame.groundTop }).setCoords();
          this._ballZ = frame.z;
          canvas.requestRenderAll();
        } else if (this._wingRuntime && !this._possession) {
          this._ballZ = 0; // arc's done; ball rests until someone wins the contest
        }

        let resolved = false;
        if (this._wingRuntime && !this._possession) {
          this._updateWingPlayers();
          resolved = this._checkContest();
        }

        const captured = captureTick(this._objs);
        this._history.push(captured);
        this.historyLength = this._history.length;
        this.currentTick = this.historyLength - 1;
        return resolved;
      },

      // Shared by Step Forward and the Play loop. Returns true if this
      // advance is the one that resolved the contest (so the Play loop
      // knows to stop the clock right here, same idea as arcJustFinished).
      _advance() {
        if (this._dirty) {
          this._history = this._history.slice(0, this.currentTick + 1);
          this.historyLength = this._history.length;
          this._dirty = false;
          return this._pushNewTick();
        } else if (this.currentTick < this.historyLength - 1) {
          this.currentTick++;
          applyTick(this._history[this.currentTick]);
          return false;
        } else {
          return this._pushNewTick();
        }
      },

      stepForward() {
        if (this.atEnd) return;
        this._advance();
      },

      stepBack() {
        if (this.currentTick <= 0) return;
        this.currentTick--;
        applyTick(this._history[this.currentTick]);
        this._dirty = false;
      },

      togglePlay() { this.playing ? this.pause() : this.play(); },

      // Pressing Play from tick 0 is "the whistle" — run the legal-draw
      // check and, if it clears, queue up the ball's arc and the circle/wing
      // reaction state machine before falling into the normal tick loop.
      play() {
        if (this.atEnd) return;
        if (this.currentTick === 0 && this.historyLength === 1) {
          this._startDraw();
          return;
        }
        this.playing = true;
        this._scheduleTick();
      },

      _startDraw() {
        outcomeState.result = null;
        const outcome = computeDrawOutcome();
        if (!outcome.legal) {
          outcomeState.result = { type: 'violation' };
          recordDrawRun({ legal: false });
          return;
        }
        this._callInfo = { controlling: outcome.controlling, action: outcome.action };
        this._arcQueue = outcome.frames;
        this._wingRuntime = setupWingRuntime(outcome.finalGroundTarget, outcome.controlling, outcome.action);
        this._ballZ = 0;
        this._possession = null;
        this._contestWindow = null;
        this.playing = true;
        this._scheduleTick();
      },

      pause() {
        this.playing = false;
        clearTimeout(this._timer);
      },

      _scheduleTick() {
        clearTimeout(this._timer);
        const delay = TICK_MS / this.speed;
        this._timer = setTimeout(() => {
          const wasArcInFlight = !!(this._arcQueue && this._arcQueue.length);
          const contestResolvedNow = this._advance();
          // Don't auto-pause on "the arc just landed" if a contest window is
          // already counting down (someone's in range) — otherwise the arc's
          // own end-of-flight pause would cut the window off mid-count and
          // the trailing side would never get a chance to join the roll.
          const arcJustFinished = wasArcInFlight && !(this._arcQueue && this._arcQueue.length) && !this._contestWindow;
          if (this.playing && !this.atEnd && !arcJustFinished && !contestResolvedNow) {
            this._scheduleTick();
          } else {
            this.playing = false; // auto-pause once the arc lands, the contest resolves, or nothing's nearby yet
          }
        }, delay);
      },

      reset() {
        this.pause();
        this._history = this._history.slice(0, 1);
        this.historyLength = 1;
        this.currentTick = 0;
        this._dirty = false;
        this._arcQueue = null;
        this._wingRuntime = null;
        this._ballZ = 0;
        this._possession = null;
        this._contestWindow = null;
        this._callInfo = null;
        outcomeState.result = null;
        applyTick(this._history[0]);
      },

      onScrub(value) {
        this.pause();
        const t = Math.max(0, Math.min(this.historyLength - 1, Number(value)));
        this.currentTick = t;
        this._dirty = false;
        applyTick(this._history[t]);
      },
    },
  };

  // ─── Draw call bar (per-team center action selector) ─────────────────────
  const DrawCallBar = {
    template: `
      <div id="sim-draw-call-bar" v-show="visible">
        <div class="draw-call-team" v-for="t in ['a','b']" :key="t">
          <span class="draw-call-dot" :style="{ background: teamColor(t) }"></span>
          <span class="draw-call-name">{{ teamName(t) }}</span>
          <select class="sim-speed" v-model="calls[t]">
            <option value="cleanCatch">Clean Catch</option>
            <option value="batOpen">Bat to Open Space</option>
            <option value="batLeft">Bat to Left Teammate</option>
            <option value="batRight">Bat to Right Teammate</option>
          </select>
        </div>
      </div>
    `,
    data() {
      return { visible: false, calls: laxState().drawCall };
    },
    methods: {
      teamName(t) { return laxState().teams[t].name; },
      teamColor(t) { return laxState().teams[t].color; },
      _poll() { this.visible = drawSetupActive() && currentView() === 'draw'; },
    },
    mounted() {
      this._pollTimer = setInterval(() => this._poll(), 300);
      this._poll();
    },
    beforeUnmount() { clearInterval(this._pollTimer); },
  };

  // ─── Player attributes panel (centers from step 3, circle/wings here) ────
  const CENTER_ATTR_KEYS = ['draw_technique', 'reaction_time', 'reach', 'experience', 'energy'];
  const CENTER_ATTR_LABELS = {
    draw_technique: 'Draw Technique',
    reaction_time: 'Reaction Time',
    reach: 'Reach',
    experience: 'Experience',
    energy: 'Energy',
  };
  const WING_ATTR_KEYS = ['speed', 'anticipation', 'vertical', 'ground_ball', 'positioning_discipline', 'energy'];
  const WING_ATTR_LABELS = {
    speed: 'Speed',
    anticipation: 'Anticipation',
    vertical: 'Vertical',
    ground_ball: 'Ground Ball',
    positioning_discipline: 'Positioning',
    energy: 'Energy',
  };
  const WING_MARKER_TITLES = { W1: 'Circle 1', W2: 'Circle 2' };

  const PlayerAttributesPanel = {
    template: `
      <div id="player-attrs-panel" v-show="visible">
        <div class="player-attrs-header">
          <span>{{ title }}</span>
          <button class="panel-btn-sm" @click="close" title="Close">✕</button>
        </div>
        <div class="player-attrs-body" v-if="attrs">
          <div class="attr-row" v-for="key in attrKeys" :key="key">
            <span class="attr-name">{{ attrLabels[key] }}</span>
            <input type="range" min="1" max="5" step="1" v-model.number="attrs[key]" />
            <span class="attr-value">{{ attrs[key] }}</span>
          </div>
          <div class="tendency-section" v-if="isCenter">
            <div class="panel-label">Tendency profile (optional — blank = unknown)</div>
            <div class="tendency-row">
              <label>Bat L <input type="number" min="0" max="100" v-model="attrs.tendency.batLeft"></label>
              <label>Clean <input type="number" min="0" max="100" v-model="attrs.tendency.cleanCatch"></label>
              <label>Bat R <input type="number" min="0" max="100" v-model="attrs.tendency.batRight"></label>
            </div>
            <div class="tendency-error" v-if="tendencyError">{{ tendencyError }}</div>
          </div>
        </div>
      </div>
    `,
    data() {
      return { visible: false, playerId: null, markerType: null, title: '' };
    },
    computed: {
      isCenter() { return this.markerType === 'C'; },
      attrKeys() { return this.isCenter ? CENTER_ATTR_KEYS : WING_ATTR_KEYS; },
      attrLabels() { return this.isCenter ? CENTER_ATTR_LABELS : WING_ATTR_LABELS; },
      attrs() {
        if (this.playerId == null) return null;
        return this.isCenter ? getCenterAttrs(this.playerId) : getWingAttrs(this.playerId);
      },
      tendencySum() {
        if (!this.isCenter || !this.attrs) return null;
        const { batLeft, cleanCatch, batRight } = this.attrs.tendency;
        if (batLeft === '' || cleanCatch === '' || batRight === '') return null;
        return Number(batLeft) + Number(cleanCatch) + Number(batRight);
      },
      tendencyError() {
        if (this.tendencySum === null) return '';
        return this.tendencySum !== 100 ? `Tendency % must sum to 100 (currently ${this.tendencySum}).` : '';
      },
    },
    methods: {
      open(playerId, teamName, markerType) {
        this.playerId = playerId;
        this.markerType = markerType;
        const roleTitle = markerType === 'C' ? 'Center' : WING_MARKER_TITLES[markerType];
        this.title = `${teamName} ${roleTitle}`;
        this.visible = true;
      },
      close() { this.visible = false; },
    },
  };

  // ─── Draw outcome panel ───────────────────────────────────────────────────
  // One line summarizing the last completed run: who called it, what they
  // called, and how it came out. Persisted stats capture is step 6 — this is
  // just the on-screen readout, cleared on Reset/a fresh Draw Setup.
  const DrawOutcomePanel = {
    template: `
      <div id="draw-outcome-panel" v-if="result">
        <span class="outcome-badge" :class="badgeClass">{{ badgeLabel }}</span>
        <span class="outcome-text" v-if="result.type === 'violation'">
          Ball didn't clear both centers — no possession.
        </span>
        <span class="outcome-text" v-else>
          {{ teamName(result.callingTeam) }} called "{{ actionLabel(result.action) }}" —
          {{ teamName(result.winnerTeam) }} won the {{ result.contestType === 'airborne' ? 'airborne' : 'ground-ball' }} contest and gains possession.
        </span>
      </div>
    `,
    computed: {
      result() { return outcomeState.result; },
      badgeClass() {
        if (!this.result) return '';
        if (this.result.type === 'violation') return 'violation';
        return this.result.scrum ? 'scrum' : 'resolved';
      },
      badgeLabel() {
        if (!this.result) return '';
        if (this.result.type === 'violation') return 'Short Draw';
        return this.result.scrum ? '50/50 Scrum' : 'Resolved';
      },
    },
    methods: {
      teamName(t) { return t ? laxState().teams[t].name : 'Someone'; },
      actionLabel(a) { return ACTION_LABELS[a] || a; },
    },
  };

  // ─── Draw log panel (step 6) ──────────────────────────────────────────────
  // Cumulative history + a per-team tally, backed by the persisted log above.
  // Visible whenever the Draw Circle tab is active, independent of whether a
  // Draw Setup is currently on the field — it's a history browser, not a
  // live-run readout like the outcome panel.
  const DrawLogPanel = {
    template: `
      <div id="draw-log-panel" class="panel-section" v-show="visible">
        <div class="draw-log-header">
          <h3 class="panel-title">Draw Log</h3>
          <button class="panel-btn-sm" @click="clearLog" title="Clear Draw Log">Clear</button>
        </div>
        <div class="draw-log-tally">
          <div class="draw-log-tally-row" v-for="t in ['a','b']" :key="t">
            <span class="draw-log-tally-dot" :style="{ background: teamColor(t) }"></span>
            <span class="draw-log-tally-name">{{ teamName(t) }}</span>
            <span class="draw-log-tally-stats">{{ tally[t].taken }} taken &middot; {{ tally[t].won }} won &middot; {{ tally[t].rate }}</span>
          </div>
        </div>
        <div class="draw-log-list">
          <div class="draw-log-entry" v-for="e in recent" :key="e.id">
            <span class="draw-log-time">{{ formatTime(e.timestamp) }}</span>
            <span class="draw-log-summary">{{ summarize(e) }}</span>
          </div>
          <div class="draw-log-empty" v-if="!recent.length">No draws run yet.</div>
        </div>
      </div>
    `,
    data() { return { visible: false }; },
    computed: {
      recent() { return drawLogState.entries.slice(0, DRAW_LOG_DISPLAY); },
      tally() {
        const t = { a: { taken: 0, won: 0 }, b: { taken: 0, won: 0 } };
        drawLogState.entries.forEach(e => {
          t.a.taken++;
          t.b.taken++;
          if (e.winnerTeam === 'a') t.a.won++;
          if (e.winnerTeam === 'b') t.b.won++;
        });
        ['a', 'b'].forEach(k => {
          t[k].rate = t[k].taken ? `${Math.round((t[k].won / t[k].taken) * 100)}%` : '—';
        });
        return t;
      },
    },
    methods: {
      teamName(t) { return laxState().teams[t].name; },
      teamColor(t) { return laxState().teams[t].color; },
      formatTime(ts) {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      },
      summarize(e) {
        const callSummary = `${e.teamA.name} called ${ACTION_LABELS[e.teamA.drawCall] || e.teamA.drawCall}, ${e.teamB.name} called ${ACTION_LABELS[e.teamB.drawCall] || e.teamB.drawCall}`;
        if (e.violation) return `Short draw — no possession (${callSummary})`;
        const winnerName = e.winnerTeam === 'a' ? e.teamA.name : e.teamB.name;
        const tag = e.scrum ? ' (50/50 scrum)' : '';
        const player = e.winnerPlayerLabel ? ` ${e.winnerPlayerLabel}` : '';
        return `${winnerName}${player} won${tag} — ${callSummary}`;
      },
      clearLog() {
        if (!confirm('Clear the draw log? This cannot be undone.')) return;
        persistDrawLog([]);
        drawLogState.entries = [];
      },
      _poll() { this.visible = currentView() === 'draw'; },
    },
    mounted() {
      this._pollTimer = setInterval(() => this._poll(), 300);
      this._poll();
    },
    beforeUnmount() { clearInterval(this._pollTimer); },
  };

  Vue.createApp(SimPlaybackBar).mount('#sim-playback-mount');
  Vue.createApp(DrawCallBar).mount('#sim-draw-call-mount');
  Vue.createApp(DrawOutcomePanel).mount('#draw-outcome-mount');
  Vue.createApp(DrawLogPanel).mount('#draw-log-mount');
  const attrsPanelVm = Vue.createApp(PlayerAttributesPanel).mount('#player-attrs-mount');

  // Clicking a center or circle/wing marker ('C'/'W1'/'W2') opens the
  // attributes panel. Only acts in the select tool, and only reads the
  // click — the existing Select/Player/Arrow/Text handling in app.js's own
  // mouse:down listener is untouched.
  canvas.on('mouse:down', (opt) => {
    const s = laxState();
    if (!s || s.tool !== 'select') return;
    const target = opt.target;
    if (!target || !target._playerId) return;
    const teamKey = target._team;
    const team = s.teams[teamKey];
    const player = team && team.players.find(p => p.id === target._playerId);
    if (player && (player.num === 'C' || player.num === 'W1' || player.num === 'W2')) {
      attrsPanelVm.open(player.id, team.name, player.num);
    }
  });
})();
