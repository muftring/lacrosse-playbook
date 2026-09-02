// Draw Sim — tick engine + playback controls (step 2) and center mechanics
// (step 3 of 6): center attributes, action selector, ball arc physics, and
// the legal-draw check.
//
// No circle-player reaction/movement or contest resolution yet — that's
// steps 4-5. This step only makes the ball do something on the whistle and
// proves the attribute/action inputs that later steps will read.
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

  // ─── Center attributes ────────────────────────────────────────────────────
  // Keyed by player id (survives a marker's own object identity changing on
  // resize/reload) rather than stored on the player record, so this step
  // stays decoupled from app.js's placePlayer()/placeDrawSetup(). Wrapped in
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

  // ─── Draw call (per-team action selection) ───────────────────────────────
  (function ensureDrawCallDefaults() {
    const s = laxState();
    if (s && !s.drawCall) s.drawCall = { a: 'cleanCatch', b: 'cleanCatch' };
  })();

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

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
    const opposing = controlling === 'a' ? 'b' : 'a';
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

    return { legal: true, frames: generateArcFrames(startPos, finalTarget, ARC_TICKS, ARC_MAX_HEIGHT) };
  }

  // ─── Playback bar (tick engine + Play/Pause/Step/Reset) ──────────────────
  const SimPlaybackBar = {
    template: `
      <div id="sim-playback-wrap" v-show="visible">
        <div class="sim-violation-banner" v-if="violation">
          ⚠ Short draw — the ball didn't clear both centers. Raise draw_technique or try again.
        </div>
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
        violation: false,
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
          this.violation = false;
        }
        this.visible = true;
      },

      _pushNewTick() {
        if (this.historyLength >= this.maxTicks) return;
        if (this._arcQueue && this._arcQueue.length) {
          const frame = this._arcQueue.shift();
          const ball = laxState().ball;
          ball.set({ left: frame.groundLeft, top: frame.groundTop - frame.z }).setCoords();
          if (this._shadowObj) this._shadowObj.set({ left: frame.groundLeft, top: frame.groundTop }).setCoords();
          canvas.requestRenderAll();
        }
        const captured = captureTick(this._objs);
        this._history.push(captured);
        this.historyLength = this._history.length;
        this.currentTick = this.historyLength - 1;
      },

      // Shared by Step Forward and the Play loop.
      _advance() {
        if (this._dirty) {
          this._history = this._history.slice(0, this.currentTick + 1);
          this.historyLength = this._history.length;
          this._dirty = false;
          this._pushNewTick();
        } else if (this.currentTick < this.historyLength - 1) {
          this.currentTick++;
          applyTick(this._history[this.currentTick]);
        } else {
          this._pushNewTick();
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
      // check and, if it clears, queue up the ball's arc before falling
      // into the normal tick loop.
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
        this.violation = false;
        const outcome = computeDrawOutcome();
        if (!outcome.legal) {
          this.violation = true;
          return;
        }
        this._arcQueue = outcome.frames;
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
          this._advance();
          const arcJustFinished = wasArcInFlight && !(this._arcQueue && this._arcQueue.length);
          if (this.playing && !this.atEnd && !arcJustFinished) {
            this._scheduleTick();
          } else {
            this.playing = false; // auto-pause once the arc lands — "let it sit"
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
        this.violation = false;
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

  // ─── Center attributes panel ──────────────────────────────────────────────
  const ATTR_KEYS = ['draw_technique', 'reaction_time', 'reach', 'experience', 'energy'];
  const ATTR_LABELS = {
    draw_technique: 'Draw Technique',
    reaction_time: 'Reaction Time',
    reach: 'Reach',
    experience: 'Experience',
    energy: 'Energy',
  };

  const CenterAttributesPanel = {
    template: `
      <div id="center-attrs-panel" v-show="visible">
        <div class="center-attrs-header">
          <span>{{ title }}</span>
          <button class="panel-btn-sm" @click="close" title="Close">✕</button>
        </div>
        <div class="center-attrs-body" v-if="attrs">
          <div class="attr-row" v-for="key in attrKeys" :key="key">
            <span class="attr-name">{{ attrLabels[key] }}</span>
            <input type="range" min="1" max="5" step="1" v-model.number="attrs[key]" />
            <span class="attr-value">{{ attrs[key] }}</span>
          </div>
          <div class="tendency-section">
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
      return { visible: false, playerId: null, title: '', attrKeys: ATTR_KEYS, attrLabels: ATTR_LABELS };
    },
    computed: {
      attrs() { return this.playerId != null ? getCenterAttrs(this.playerId) : null; },
      tendencySum() {
        if (!this.attrs) return null;
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
      open(playerId, teamName) {
        this.playerId = playerId;
        this.title = `${teamName} Center`;
        this.visible = true;
      },
      close() { this.visible = false; },
    },
  };

  Vue.createApp(SimPlaybackBar).mount('#sim-playback-mount');
  Vue.createApp(DrawCallBar).mount('#sim-draw-call-mount');
  const attrsPanelVm = Vue.createApp(CenterAttributesPanel).mount('#center-attrs-mount');

  // Clicking a center marker (label 'C') opens the attributes panel. Only
  // acts in the select tool, and only reads the click — the existing
  // Select/Player/Arrow/Text handling in app.js's own mouse:down listener
  // is untouched.
  canvas.on('mouse:down', (opt) => {
    const s = laxState();
    if (!s || s.tool !== 'select') return;
    const target = opt.target;
    if (!target || !target._playerId) return;
    const teamKey = target._team;
    const team = s.teams[teamKey];
    const player = team && team.players.find(p => p.id === target._playerId);
    if (player && player.num === 'C') {
      attrsPanelVm.open(player.id, team.name);
    }
  });
})();
