// Draw Sim — tick engine + playback controls (step 2 of 6).
//
// No movement/simulation logic lives here yet — this only proves the
// tick/history/scrub mechanism the later steps (ball physics, circle-player
// reaction state machine, contest resolution) will build on. Every tick is
// just a snapshot of whatever's currently on the canvas.
//
// Talks to renderer/app.js only through the small read-only bridge it
// exposes (window._laxState, window._laxGetView) and the shared fabric
// canvas (window._fabricCanvas) — no changes to app.js's own logic.
(function() {
  'use strict';

  const TICK_MS = 250;        // sim time per tick at 1x speed
  const MAX_TICKS = 120;      // ~30s draw at 250ms/tick

  const canvas = window._fabricCanvas;

  function laxState() { return window._laxState; }
  function currentView() { return window._laxGetView ? window._laxGetView() : null; }

  // A Draw Setup is "active" once its 6 markers + ball are on the field —
  // matches what placeDrawSetup() in app.js produces, without depending on it.
  function drawSetupActive() {
    const s = laxState();
    return !!(s && s.ball && s.teams.a.players.length === 3 && s.teams.b.players.length === 3);
  }

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

  const SimPlaybackBar = {
    template: `
      <div id="sim-playback-bar" v-show="visible">
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
      this._objs = null;
      this._dirty = false;
      this._timer = null;

      // Any drag/reposition of a sim marker while paused marks the current
      // tick "dirty" — the next advance discards recorded future ticks and
      // re-records from this edited state (branch semantics).
      canvas.on('object:modified', (opt) => {
        if (!this.visible || this.playing) return;
        if (this._objs && this._objs.includes(opt.target)) this._dirty = true;
      });

      this._pollTimer = setInterval(() => this._poll(), 200);
      this._poll();
    },
    beforeUnmount() {
      clearInterval(this._pollTimer);
      clearTimeout(this._timer);
    },
    methods: {
      _poll() {
        const active = drawSetupActive() && currentView() === 'draw';
        if (!active) { this.visible = false; return; }

        const objs = simObjects();
        if (!sameObjects(objs, this._objs)) {
          // First activation, or a fresh "Draw Setup" click replaced the
          // markers — (re)anchor tick 0 to whatever's on the field now.
          this._objs = objs;
          this._history = [captureTick(objs)];
          this._dirty = false;
          this.playing = false;
          clearTimeout(this._timer);
          this.currentTick = 0;
          this.historyLength = 1;
        }
        this.visible = true;
      },

      _pushNewTick() {
        if (this.historyLength >= this.maxTicks) return;
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

      play() {
        if (this.atEnd) return;
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
          this._advance();
          if (this.playing && !this.atEnd) this._scheduleTick();
          else this.playing = false;
        }, delay);
      },

      reset() {
        this.pause();
        this._history = this._history.slice(0, 1);
        this.historyLength = 1;
        this.currentTick = 0;
        this._dirty = false;
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

  Vue.createApp(SimPlaybackBar).mount('#sim-playback-mount');
})();
