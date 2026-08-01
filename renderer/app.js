// Main application logic
(function() {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────────
  const state = {
    tool: 'select',
    activeTeam: 'a',
    teams: {
      a: { name: 'Home', color: '#e63946', players: [] },
      b: { name: 'Away', color: '#457b9d', players: [] }
    },
    plays: [],          // [{ id, name, snapshots: [{ id, label, json, thumb }] }]
    activePlayId: null,
    activeSnapshotId: null,
    arrowStart: null,
    fieldInfo: null,
    nextPlayerId: 1,
    ball: null,
  };
  // Read-only bridge for renderer/sim.js (the Vue-mounted sim playback bar) —
  // exposes just enough of this module's private state/view without pulling
  // sim.js's tick engine into this IIFE or vice versa.
  window._laxState = state;

  // ─── Canvas setup ────────────────────────────────────────────────────────────
  const container = document.getElementById('canvas-container');
  const canvasEl = document.getElementById('field-canvas');
  let currentView = 'full'; // 'full' | 'half'

  function resizeCanvas() {
    const tabs = document.getElementById('view-tabs');
    const w = container.clientWidth;
    const h = container.clientHeight - (tabs ? tabs.offsetHeight : 0);
    canvasEl.width = w;
    canvasEl.height = h;
    if (window._fabricCanvas) {
      window._fabricCanvas.setWidth(w);
      window._fabricCanvas.setHeight(h);
      rebuildField();
    }
  }

  const canvas = new fabric.Canvas('field-canvas', {
    selection: true,
    preserveObjectStacking: true,
  });
  window._fabricCanvas = canvas;

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  async function rebuildField() {
    canvas.getObjects().filter(o => o._isFieldObject).forEach(o => canvas.remove(o));
    canvas.setViewportTransform([1,0,0,1,0,0]); // reset before measuring
    state.fieldInfo = await drawField(canvas, canvas.getWidth(), canvas.getHeight());
    canvas.getObjects().filter(o => !o._isFieldObject).forEach(o => canvas.bringToFront(o));
    applyCurrentView();
  }

  // ─── View tabs ────────────────────────────────────────────────────────────────
  let halfFieldZone = 'attack'; // 'attack' | 'defense' — which end the half view shows

  document.getElementById('tab-full').addEventListener('click', () => setView('full'));
  document.getElementById('tab-half').addEventListener('click', () => setView('half'));
  document.getElementById('tab-draw').addEventListener('click', () => setView('draw'));

  window._laxGetView = () => currentView;

  function setView(view) {
    currentView = view;
    document.getElementById('tab-full').classList.toggle('active', view === 'full');
    document.getElementById('tab-half').classList.toggle('active', view === 'half');
    document.getElementById('tab-draw').classList.toggle('active', view === 'draw');
    document.getElementById('tab-half').textContent =
      halfFieldZone === 'defense' ? 'Defense Zone' : 'Attack Zone';
    applyCurrentView();
  }

  function applyCurrentView() {
    if (currentView === 'half') applyHalfFieldView();
    else if (currentView === 'draw') applyDrawCircleView();
    else applyFullFieldView();
  }

  function applyFullFieldView() {
    canvas.setViewportTransform([1,0,0,1,0,0]);
    canvas.renderAll();
  }

  function applyHalfFieldView() {
    if (halfFieldZone === 'defense') applyDefenseZoneView();
    else applyAttackZoneView();
  }

  function zoomToFieldRange(x0, x1) {
    const fi = state.fieldInfo;
    if (!fi) return;
    const cw = canvas.getWidth();
    const ch = canvas.getHeight();
    const leftPx  = fi.fx(x0);
    const rightPx = fi.fx(x1);
    const topPx   = fi.fy(0);
    const botPx   = fi.fy(60);
    const zoom = Math.min(cw / (rightPx - leftPx), ch / (botPx - topPx));
    const tx = (cw - (rightPx - leftPx) * zoom) / 2 - leftPx * zoom;
    const ty = (ch - (botPx   - topPx ) * zoom) / 2 - topPx  * zoom;
    canvas.setViewportTransform([zoom, 0, 0, zoom, tx, ty]);
    canvas.renderAll();
  }

  // Attack zone: right half, x=60 → x=110 (end line)
  function applyAttackZoneView() { zoomToFieldRange(60, 110); }

  // Defense zone: left half, x=0 (end line) → x=60
  function applyDefenseZoneView() { zoomToFieldRange(0, 60); }

  // Draw circle: centered on the midfield hash (x=55), out to roughly the
  // restraining lines (~20 yards either side) — the zone where a draw plays out.
  function applyDrawCircleView() { zoomToFieldRange(35, 75); }

  // Initial field draw (async — fieldInfo is null until the image loads)
  rebuildField();

  // ─── Theme toggle ────────────────────────────────────────────────────────────
  let isDark = true;
  document.getElementById('btn-theme').addEventListener('click', () => {
    isDark = !isDark;
    document.body.classList.toggle('light-mode', !isDark);
    document.getElementById('theme-icon-dark').style.display = isDark ? '' : 'none';
    document.getElementById('theme-icon-light').style.display = isDark ? 'none' : '';
  });

  // ─── Tool buttons ─────────────────────────────────────────────────────────────
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      setTool(btn.dataset.tool);
    });
  });

  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    canvas.defaultCursor = tool === 'select' ? 'default' : 'crosshair';
    canvas.isDrawingMode = false;
    state.arrowStart = null;

    // Enable/disable selection
    canvas.selection = (tool === 'select');
    canvas.getObjects().filter(o => !o._isFieldObject).forEach(o => {
      o.selectable = (tool === 'select');
      o.evented = (tool === 'select');
    });
    canvas.discardActiveObject();
    canvas.renderAll();
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const key = e.key.toLowerCase();
    if (key === 'v') setTool('select');
    if (key === 'p') setTool('player');
    if (key === 'a') setTool('arrow');
    if (key === 't') setTool('text');
    if (key === 'delete' || key === 'backspace') deleteSelected();
    if ((e.metaKey || e.ctrlKey) && key === 'z') canvas.undo && canvas.undo();
  });

  document.getElementById('btn-delete').addEventListener('click', deleteSelected);
  document.getElementById('btn-clear').addEventListener('click', () => {
    if (!confirm('Clear all players, arrows, and text from the field?')) return;
    clearNonFieldObjects();
    state.teams.a.players = [];
    state.teams.b.players = [];
    state.ball = null;
    renderRosters();
    canvas.renderAll();
  });

  function deleteSelected() {
    const active = canvas.getActiveObjects();
    if (!active.length) return;
    active.forEach(obj => {
      // Remove from player roster if applicable
      if (obj._playerId) {
        ['a','b'].forEach(t => {
          state.teams[t].players = state.teams[t].players.filter(p => p.id !== obj._playerId);
        });
      }
      if (obj._isBall && state.ball === obj) {
        state.ball = null;
      }
      canvas.remove(obj);
    });
    canvas.discardActiveObject();
    renderRosters();
    canvas.renderAll();
  }

  function clearNonFieldObjects() {
    canvas.getObjects().filter(o => !o._isFieldObject).forEach(o => canvas.remove(o));
  }

  // ─── Canvas click handlers ────────────────────────────────────────────────────
  canvas.on('mouse:down', (opt) => {
    const pointer = canvas.getPointer(opt.e);
    if (state.tool === 'player') {
      addPlayer(pointer.x, pointer.y);
    } else if (state.tool === 'arrow') {
      if (!state.arrowStart) {
        state.arrowStart = { x: pointer.x, y: pointer.y };
      } else {
        const a = createArrow(state.arrowStart.x, state.arrowStart.y, pointer.x, pointer.y);
        a._arrowObject = true;
        canvas.add(a);
        canvas.renderAll();
        state.arrowStart = null;
      }
    } else if (state.tool === 'text') {
      addTextBox(pointer.x, pointer.y);
    }
  });

  // Show arrow preview while dragging
  let arrowPreview = null;
  canvas.on('mouse:move', (opt) => {
    if (state.tool === 'arrow' && state.arrowStart) {
      const pointer = canvas.getPointer(opt.e);
      if (arrowPreview) canvas.remove(arrowPreview);
      arrowPreview = createArrow(
        state.arrowStart.x, state.arrowStart.y,
        pointer.x, pointer.y,
        'rgba(255,200,0,0.45)'
      );
      arrowPreview.selectable = false;
      arrowPreview.evented = false;
      arrowPreview._isPreview = true;
      canvas.add(arrowPreview);
      canvas.renderAll();
    }
  });

  canvas.on('mouse:up', () => {
    if (arrowPreview) { canvas.remove(arrowPreview); arrowPreview = null; }
  });

  // ─── Player tooltip ───────────────────────────────────────────────────────────
  const tooltip = document.getElementById('player-tooltip');

  canvas.on('mouse:over', (opt) => {
    const obj = opt.target;
    if (obj && obj._playerName) {
      tooltip.textContent = obj._playerName;
      tooltip.style.display = 'block';
    }
  });

  canvas.on('mouse:out', (opt) => {
    tooltip.style.display = 'none';
  });

  container.addEventListener('mousemove', (e) => {
    if (tooltip.style.display === 'block') {
      tooltip.style.left = (e.offsetX + 14) + 'px';
      tooltip.style.top = (e.offsetY - 10) + 'px';
    }
  });

  // ─── Add player ───────────────────────────────────────────────────────────────
  function addPlayer(x, y) {
    const team = state.teams[state.activeTeam];
    const playerNum = team.players.length + 1;
    const defaultName = `${team.name} #${playerNum}`;

    showModal('Add Player', [
      { id: 'pname', label: 'Player name (optional)', type: 'text', placeholder: defaultName }
    ], (values) => {
      const name = values.pname.trim() || defaultName;
      placePlayer(state.activeTeam, x, y, name, playerNum);
      renderRosters();
      setTool('select');
    });
  }

  // Shared player placement (no modal) — cx/cy are canvas pixel coordinates (group center)
  function placePlayer(teamKey, cx, cy, name, displayLabel) {
    const team = state.teams[teamKey];
    const playerId = state.nextPlayerId++;
    const radius = 13;

    // Both children use originX/Y 'center' so they sit at (0,0) within the group
    const circle = new fabric.Circle({
      radius,
      fill: team.color,
      stroke: '#ffffff',
      strokeWidth: 2.5,
      originX: 'center',
      originY: 'center',
    });

    const labelStr = String(displayLabel);
    const label = new fabric.Text(labelStr, {
      fontSize: 13,
      fontWeight: 'bold',
      fill: '#ffffff',
      originX: 'center',
      originY: 'center',
      top: 1,  // slight downward nudge for optical centering
    });

    const group = new fabric.Group([circle, label], {
      left: cx,
      top: cy,
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hasControls: false,
      hasBorders: true,
      subTargetCheck: false,
      _playerId: playerId,
      _team: teamKey,
      _playerName: name,
    });

    canvas.add(group);
    const player = { id: playerId, name, num: displayLabel, circleObj: group, innerCircle: circle };
    team.players.push(player);
    return player;
  }

  // ─── Add text box ─────────────────────────────────────────────────────────────
  function addTextBox(x, y) {
    const tb = new fabric.Textbox('Note', {
      left: x,
      top: y,
      width: 160,
      fontSize: 14,
      fill: '#ffffff',
      backgroundColor: 'rgba(0,0,0,0.55)',
      borderColor: 'rgba(255,255,255,0.6)',
      editingBorderColor: '#4cc9f0',
      padding: 6,
      selectable: true,
      evented: true,
      _textBox: true,
    });
    canvas.add(tb);
    canvas.setActiveObject(tb);
    tb.enterEditing();
    canvas.renderAll();
    setTool('select');
  }

  // ─── Teams panel ─────────────────────────────────────────────────────────────
  // Returns the inner circle object for a player, whether freshly created or enlivened from JSON
  function getInnerCircle(player) {
    if (player.innerCircle) return player.innerCircle;
    const obj = player.circleObj;
    if (obj && obj.type === 'group') return obj.getObjects('circle')[0] || null;
    return obj;
  }

  ['a', 'b'].forEach(t => {
    document.getElementById(`team-${t}-color`).addEventListener('input', (e) => {
      state.teams[t].color = e.target.value;
      state.teams[t].players.forEach(p => {
        const inner = getInnerCircle(p);
        if (inner) inner.set({ fill: e.target.value });
      });
      canvas.renderAll();
    });

    document.getElementById(`team-${t}-name`).addEventListener('input', (e) => {
      state.teams[t].name = e.target.value;
      // Sync toggle button labels
      document.getElementById(`btn-team-${t}`).textContent = e.target.value || (t === 'a' ? 'Home' : 'Away');
    });
  });

  document.getElementById('btn-team-a').addEventListener('click', () => setActiveTeam('a'));
  document.getElementById('btn-team-b').addEventListener('click', () => setActiveTeam('b'));

  function setActiveTeam(t) {
    state.activeTeam = t;
    document.getElementById('btn-team-a').classList.toggle('active', t === 'a');
    document.getElementById('btn-team-b').classList.toggle('active', t === 'b');
    if (state.tool !== 'player') setTool('player');
  }

  function renderRosters() {
    ['a', 'b'].forEach(t => {
      const el = document.getElementById(`team-${t}-roster`);
      el.innerHTML = '';
      state.teams[t].players.forEach(p => {
        const item = document.createElement('div');
        item.className = 'roster-item';
        item.innerHTML = `
          <div class="roster-dot" style="background:${state.teams[t].color}"></div>
          <span class="roster-name">${p.name}</span>
        `;
        item.addEventListener('click', () => {
          canvas.setActiveObject(p.circleObj);
          canvas.renderAll();
        });
        el.appendChild(item);
      });
    });
  }

  // ─── Clear players ────────────────────────────────────────────────────────────
  document.getElementById('btn-clear-players').addEventListener('click', () => {
    const playerIds = new Set([
      ...state.teams.a.players.map(p => p.id),
      ...state.teams.b.players.map(p => p.id),
    ]);
    canvas.getObjects()
      .filter(o => o._playerId && playerIds.has(o._playerId))
      .forEach(o => canvas.remove(o));
    state.teams.a.players = [];
    state.teams.b.players = [];
    clearBall();
    canvas.discardActiveObject();
    renderRosters();
    canvas.renderAll();
  });

  // ─── Set formation ────────────────────────────────────────────────────────────
  // Positions in field yards (x: 0–110, y: 0–60).
  // Team A defends left goal (x=8), attacks toward x=102.
  // Team B defends right goal (x=102), attacks toward x=8.
  // Formation positions in field yards (x: 0–110, y: 0–60).
  // Center circle radius = 8 yds, center = (55, 30).
  // Restraining lines at x=30 (A's zone) and x=80 (B's zone).
  // Defenders: 2×2 box inside own restraining area.
  // Attackers: paired next to opposing team's corresponding defender (+4 yds toward center).
  // M1 pair: shoulder-to-shoulder at draw center.
  // M2+M3 pair: together on the circle edge at top (A) and bottom (B), ≈15° either side of the apex.
  // Formation positions in field yards (x: 0–110, y: 0–60).
  // Center circle radius = 8 yds, center = (55, 30). Circle top y=22, bottom y=38.
  // Restraining lines at x=30 (A's zone) and x=80 (B's zone).
  // M1 pair: side-by-side at draw center.
  // M2 pair: side-by-side at top of circle. M3 pair: side-by-side at bottom of circle.
  // Defenders: 2×2 box inside own restraining area, spread toward sidelines.
  // Attackers: next to corresponding opposing defender, 4 yds toward center, same y.
  const FORMATION = {
    a: [
      { label: 'GK', name: 'GK',  x:  9,  y: 30 },
      // Defenders — 2×2 box spread toward sidelines
      { label: 'D1', name: 'D1',  x: 13,  y: 15 },
      { label: 'D2', name: 'D2',  x: 13,  y: 45 },
      { label: 'D3', name: 'D3',  x: 23,  y: 15 },
      { label: 'D4', name: 'D4',  x: 23,  y: 45 },
      // Midfielders
      { label: 'M1', name: 'M1',  x: 54,  y: 30 },
      { label: 'M2', name: 'M2',  x: 54,  y: 22 },
      { label: 'M3', name: 'M3',  x: 54,  y: 38 },
      // Attackers — next to B's corresponding defender
      { label: 'A1', name: 'A1',  x: 83,  y: 15 },
      { label: 'A2', name: 'A2',  x: 83,  y: 45 },
      { label: 'A3', name: 'A3',  x: 93,  y: 15 },
      { label: 'A4', name: 'A4',  x: 93,  y: 45 },
    ],
    b: [
      { label: 'GK', name: 'GK',  x: 101, y: 30 },
      // Defenders — 2×2 box spread toward sidelines
      { label: 'D1', name: 'D1',  x: 87,  y: 15 },
      { label: 'D2', name: 'D2',  x: 87,  y: 45 },
      { label: 'D3', name: 'D3',  x: 97,  y: 15 },
      { label: 'D4', name: 'D4',  x: 97,  y: 45 },
      // Midfielders
      { label: 'M1', name: 'M1',  x: 56,  y: 30 },
      { label: 'M2', name: 'M2',  x: 56,  y: 22 },
      { label: 'M3', name: 'M3',  x: 56,  y: 38 },
      // Attackers — next to A's corresponding defender
      { label: 'A1', name: 'A1',  x: 17,  y: 15 },
      { label: 'A2', name: 'A2',  x: 17,  y: 45 },
      { label: 'A3', name: 'A3',  x: 27,  y: 15 },
      { label: 'A4', name: 'A4',  x: 27,  y: 45 },
    ],
  };

  // ─── Half-field formations ────────────────────────────────────────────────────
  // Attack Zone (x=80–110): Home A+M pressing the right goal; Away M+D defending it.
  const OFFENSE_HOME = [
    { label: 'M1', name: 'M1',  x: 84,  y: 30 },
    { label: 'M2', name: 'M2',  x: 86,  y: 14 },
    { label: 'M3', name: 'M3',  x: 86,  y: 46 },
    { label: 'A1', name: 'A1',  x: 90,  y: 10 },
    { label: 'A2', name: 'A2',  x: 90,  y: 50 },
    { label: 'A3', name: 'A3',  x: 95,  y: 22 },
    { label: 'A4', name: 'A4',  x: 95,  y: 38 },
  ];
  const OFFENSE_AWAY = [
    { label: 'GK', name: 'GK',  x: 101, y: 30 },
    { label: 'M1', name: 'M1',  x: 82,  y: 30 },
    { label: 'M2', name: 'M2',  x: 82,  y: 16 },
    { label: 'M3', name: 'M3',  x: 82,  y: 44 },
    { label: 'D1', name: 'D1',  x: 88,  y: 14 },
    { label: 'D2', name: 'D2',  x: 88,  y: 46 },
    { label: 'D3', name: 'D3',  x: 96,  y: 22 },
    { label: 'D4', name: 'D4',  x: 96,  y: 38 },
  ];

  // Defense Zone (x=0–30): Home D+M defending the left goal; Away A+M pressing into it.
  const DEFENSE_HOME = [
    { label: 'GK', name: 'GK',  x:  9,  y: 30 },
    { label: 'D1', name: 'D1',  x: 13,  y: 15 },
    { label: 'D2', name: 'D2',  x: 13,  y: 45 },
    { label: 'D3', name: 'D3',  x: 23,  y: 15 },
    { label: 'D4', name: 'D4',  x: 23,  y: 45 },
    { label: 'M1', name: 'M1',  x: 26,  y: 30 },
    { label: 'M2', name: 'M2',  x: 26,  y: 16 },
    { label: 'M3', name: 'M3',  x: 26,  y: 44 },
  ];
  const DEFENSE_AWAY = [
    { label: 'A1', name: 'A1',  x: 25,  y: 10 },
    { label: 'A2', name: 'A2',  x: 25,  y: 50 },
    { label: 'A3', name: 'A3',  x: 17,  y: 22 },
    { label: 'A4', name: 'A4',  x: 17,  y: 38 },
    { label: 'M1', name: 'M1',  x: 28,  y: 30 },
    { label: 'M2', name: 'M2',  x: 28,  y: 14 },
    { label: 'M3', name: 'M3',  x: 28,  y: 46 },
  ];

  // ─── Draw setup ────────────────────────────────────────────────────────────────
  // 3 players per team allowed between the restraining lines during a draw:
  // one center (at the hash, x=55/y=30 — offset slightly so both centers are
  // visible back-to-back) plus a circle/wing pair placed on the draw circle.
  // Default pair placement is just a starting point — drag them anywhere on
  // the circle and re-run; that's the main "what-if" lever for this scenario.
  const DRAW_HOME = [
    { label: 'C',  name: 'Center',   x: 54.4, y: 30 },
    { label: 'W1', name: 'Circle 1', x: 48,   y: 24 },
    { label: 'W2', name: 'Circle 2', x: 48,   y: 36 },
  ];
  const DRAW_AWAY = [
    { label: 'C',  name: 'Center',   x: 55.6, y: 30 },
    { label: 'W1', name: 'Circle 1', x: 62,   y: 24 },
    { label: 'W2', name: 'Circle 2', x: 62,   y: 36 },
  ];
  const DRAW_BALL_YARDS = { x: 55, y: 30 };

  function clearAllPlayers() {
    const allIds = new Set([
      ...state.teams.a.players.map(p => p.id),
      ...state.teams.b.players.map(p => p.id),
    ]);
    canvas.getObjects()
      .filter(o => o._playerId && allIds.has(o._playerId))
      .forEach(o => canvas.remove(o));
    state.teams.a.players = [];
    state.teams.b.players = [];
  }

  function placeHalfFieldFormation(homePosns, awayPosns) {
    const fi = state.fieldInfo;
    if (!fi) return;
    clearAllPlayers();
    homePosns.forEach(pos =>
      placePlayer('a', fi.fx(pos.x), fi.fy(pos.y), `${state.teams.a.name} ${pos.name}`, pos.label));
    awayPosns.forEach(pos =>
      placePlayer('b', fi.fx(pos.x), fi.fy(pos.y), `${state.teams.b.name} ${pos.name}`, pos.label));
    renderRosters();
    canvas.renderAll();
    setTool('select');
  }

  document.getElementById('btn-set-offense').addEventListener('click', () => {
    placeHalfFieldFormation(OFFENSE_HOME, OFFENSE_AWAY);
    halfFieldZone = 'attack';
    setView('half');
  });

  document.getElementById('btn-set-defense').addEventListener('click', () => {
    placeHalfFieldFormation(DEFENSE_HOME, DEFENSE_AWAY);
    halfFieldZone = 'defense';
    setView('half');
  });

  // ─── Formation storage helpers ────────────────────────────────────────────────
  function getFormations() {
    try {
      const s = localStorage.getItem('lax_formations');
      return s ? JSON.parse(s) : {};
    } catch (_) { return {}; }
  }

  function persistFormations(formations) {
    localStorage.setItem('lax_formations', JSON.stringify(formations));
  }

  function syncResetBtn() {
    const hasDefault = !!getFormations()['default'];
    document.getElementById('reset-formation-row').style.display = hasDefault ? '' : 'none';
  }

  syncResetBtn();

  function capturePositions() {
    const fi = state.fieldInfo;
    if (!fi) return null;
    const all = [
      ...state.teams.a.players.map(p => ({ ...p, teamKey: 'a' })),
      ...state.teams.b.players.map(p => ({ ...p, teamKey: 'b' })),
    ];
    if (!all.length) { showToast('No players on the field to save.'); return null; }
    const result = { a: [], b: [] };
    all.forEach(({ teamKey, num, circleObj }) => {
      // Group uses originX/Y 'center', so .left/.top is already the center in canvas coords.
      // Use per-axis scale because the image field is not perfectly square in yard-ratio.
      const x = Math.round(((circleObj.left - fi.offsetX) / fi.scaleX) * 10) / 10;
      const y = Math.round(((circleObj.top  - fi.offsetY) / fi.scaleY) * 10) / 10;
      result[teamKey].push({ label: String(num), name: String(num), x, y });
    });
    return result;
  }

  function placeFormationOnField(formation) {
    const fi = state.fieldInfo;
    if (!fi) return;
    const existingIds = new Set([
      ...state.teams.a.players.map(p => p.id),
      ...state.teams.b.players.map(p => p.id),
    ]);
    canvas.getObjects()
      .filter(o => o._playerId && existingIds.has(o._playerId))
      .forEach(o => canvas.remove(o));
    state.teams.a.players = [];
    state.teams.b.players = [];
    ['a', 'b'].forEach(teamKey => {
      formation[teamKey].forEach(pos => {
        placePlayer(teamKey, fi.fx(pos.x), fi.fy(pos.y),
          `${state.teams[teamKey].name} ${pos.name}`, pos.label);
      });
    });
    renderRosters();
    canvas.renderAll();
    setTool('select');
  }

  // ─── Ball marker ──────────────────────────────────────────────────────────────
  // Not tied to a team — a distinct, draggable marker for the draw/sim scenarios.
  function clearBall() {
    if (state.ball) {
      canvas.remove(state.ball);
      state.ball = null;
    }
  }

  function placeBall(cx, cy) {
    clearBall();
    const radius = 9;
    const circle = new fabric.Circle({
      radius,
      fill: '#f4d35e',
      stroke: '#8a6d1a',
      strokeWidth: 2,
      originX: 'center',
      originY: 'center',
    });
    const group = new fabric.Group([circle], {
      left: cx,
      top: cy,
      originX: 'center',
      originY: 'center',
      selectable: true,
      evented: true,
      hasControls: false,
      hasBorders: true,
      subTargetCheck: false,
      _isBall: true,
    });
    canvas.add(group);
    canvas.bringToFront(group);
    state.ball = group;
    return group;
  }

  // ─── Draw setup ────────────────────────────────────────────────────────────────
  // Places both centers, both circle pairs, and the ball at the draw circle,
  // then zooms to the draw-circle view. Static placement only for now — no
  // simulation logic yet (see the Draw Sim v1 spec for the planned build order).
  function placeDrawSetup() {
    const fi = state.fieldInfo;
    if (!fi) return;
    clearAllPlayers();
    clearBall();
    DRAW_HOME.forEach(pos =>
      placePlayer('a', fi.fx(pos.x), fi.fy(pos.y), `${state.teams.a.name} ${pos.name}`, pos.label));
    DRAW_AWAY.forEach(pos =>
      placePlayer('b', fi.fx(pos.x), fi.fy(pos.y), `${state.teams.b.name} ${pos.name}`, pos.label));
    placeBall(fi.fx(DRAW_BALL_YARDS.x), fi.fy(DRAW_BALL_YARDS.y));
    renderRosters();
    canvas.renderAll();
    setTool('select');
  }

  document.getElementById('btn-draw-setup').addEventListener('click', () => {
    placeDrawSetup();
    setView('draw');
  });

  // Set Formation — uses saved "default" or falls back to built-in
  document.getElementById('btn-set-formation').addEventListener('click', () => {
    const formations = getFormations();
    placeFormationOnField(formations['default'] || FORMATION);
  });

  // Save Formation — prompts for name; blank → "default"
  document.getElementById('btn-save-formation').addEventListener('click', () => {
    showModal('Save Formation', [
      { id: 'fname', label: 'Name (leave blank to save as default)', type: 'text', placeholder: 'default' }
    ], (values) => {
      const positions = capturePositions();
      if (!positions) return;
      const name = values.fname.trim() || 'default';
      const formations = getFormations();
      formations[name] = positions;
      persistFormations(formations);
      syncResetBtn();
      showToast(`Formation "${name}" saved.`);
    });
  });

  // Load Formation — picker modal
  document.getElementById('btn-load-formation').addEventListener('click', () => {
    const formations = getFormations();
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = 'Load Formation';
    content.appendChild(titleEl);

    const list = document.createElement('div');
    list.className = 'formations-list';

    const makeItem = (displayName, isDefault, onLoad, onDelete) => {
      const item = document.createElement('div');
      item.className = 'formation-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'formation-item-name' + (isDefault ? ' is-default' : '');
      nameSpan.textContent = displayName;

      const loadBtn = document.createElement('button');
      loadBtn.className = 'modal-btn primary formation-load-btn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => { overlay.classList.add('hidden'); onLoad(); });

      item.appendChild(nameSpan);
      item.appendChild(loadBtn);

      if (onDelete) {
        const delBtn = document.createElement('button');
        delBtn.className = 'modal-btn formation-delete-btn';
        delBtn.textContent = '✕';
        delBtn.title = `Delete "${displayName}"`;
        delBtn.addEventListener('click', () => { onDelete(); item.remove(); syncResetBtn(); });
        item.appendChild(delBtn);
      }
      return item;
    };

    // Built-in entry (always present, no delete)
    list.appendChild(makeItem('Built-in defaults', false,
      () => placeFormationOnField(FORMATION), null));

    // Saved entries
    Object.keys(formations).forEach(name => {
      const formation = formations[name];
      list.appendChild(makeItem(
        name === 'default' ? 'default ★' : name,
        name === 'default',
        () => placeFormationOnField(formation),
        () => {
          const fs = getFormations();
          delete fs[name];
          persistFormations(fs);
        }
      ));
    });

    content.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'modal-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => overlay.classList.add('hidden'));
    actions.appendChild(cancelBtn);
    content.appendChild(actions);

    overlay.classList.remove('hidden');
  });

  // Reset default — removes only the "default" saved formation
  document.getElementById('btn-reset-formation').addEventListener('click', () => {
    const formations = getFormations();
    delete formations['default'];
    persistFormations(formations);
    syncResetBtn();
    showToast('Custom default removed — Set Formation will use built-in positions.');
  });

  // ─── Playbook panel ───────────────────────────────────────────────────────────
  document.getElementById('btn-new-play').addEventListener('click', () => {
    showModal('New Play', [
      { id: 'playname', label: 'Play name', type: 'text', placeholder: 'e.g. Zone Attack' }
    ], (values) => {
      const name = values.playname.trim() || 'Untitled Play';
      const play = { id: uid(), name, snapshots: [] };
      state.plays.push(play);
      renderPlaysList();
      openPlay(play.id);
    });
  });

  function renderPlaysList() {
    const el = document.getElementById('plays-list');
    el.innerHTML = '';
    state.plays.forEach(play => {
      const item = document.createElement('div');
      item.className = 'play-item' + (play.id === state.activePlayId ? ' active' : '');
      item.dataset.playId = play.id;

      const nameEl = document.createElement('span');
      nameEl.className = 'play-name';
      nameEl.textContent = play.name;
      nameEl.addEventListener('dblclick', () => startRenamePlay(play, nameEl, item));

      const delBtn = document.createElement('button');
      delBtn.className = 'play-delete-btn';
      delBtn.title = 'Delete play';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Delete play "${play.name}"?`)) {
          state.plays = state.plays.filter(p => p.id !== play.id);
          if (state.activePlayId === play.id) closePlay();
          renderPlaysList();
        }
      });

      item.appendChild(nameEl);
      item.appendChild(delBtn);
      item.addEventListener('click', () => openPlay(play.id));
      el.appendChild(item);
    });
  }

  function startRenamePlay(play, nameEl, item) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'play-name-input';
    input.value = play.name;
    item.replaceChild(input, nameEl);
    input.focus();
    input.select();
    const finish = () => {
      play.name = input.value.trim() || play.name;
      item.replaceChild(nameEl, input);
      nameEl.textContent = play.name;
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  function openPlay(playId) {
    state.activePlayId = playId;
    const play = state.plays.find(p => p.id === playId);
    document.getElementById('snapshots-section').style.display = '';
    document.getElementById('snapshots-title').textContent = play.name;
    renderPlaysList();
    renderSnapshotsList();
  }

  function closePlay() {
    state.activePlayId = null;
    state.activeSnapshotId = null;
    document.getElementById('snapshots-section').style.display = 'none';
    renderPlaysList();
  }

  document.getElementById('btn-close-play').addEventListener('click', closePlay);

  // ─── Snapshots ────────────────────────────────────────────────────────────────
  document.getElementById('btn-add-snapshot').addEventListener('click', () => {
    if (!state.activePlayId) return;
    const play = state.plays.find(p => p.id === state.activePlayId);
    const num = play.snapshots.length + 1;
    const json = getFieldStateJSON();
    const thumb = canvas.toDataURL({ format: 'jpeg', quality: 0.5, multiplier: 0.25 });
    const snapshot = { id: uid(), label: `Frame ${num}`, json, thumb };
    play.snapshots.push(snapshot);
    state.activeSnapshotId = snapshot.id;
    renderSnapshotsList();
  });

  function renderSnapshotsList() {
    if (!state.activePlayId) return;
    const play = state.plays.find(p => p.id === state.activePlayId);
    const el = document.getElementById('snapshots-list');
    el.innerHTML = '';
    play.snapshots.forEach((snap, idx) => {
      const item = document.createElement('div');
      item.className = 'snapshot-item' + (snap.id === state.activeSnapshotId ? ' active' : '');

      const thumb = document.createElement('img');
      thumb.className = 'snapshot-thumb';
      thumb.src = snap.thumb;

      const info = document.createElement('div');
      info.className = 'snapshot-info';
      const label = document.createElement('div');
      label.className = 'snapshot-label';
      label.textContent = snap.label;
      label.addEventListener('dblclick', () => startRenameSnapshot(snap, label));
      const num = document.createElement('div');
      num.className = 'snapshot-num';
      num.textContent = `Frame ${idx + 1}`;
      info.appendChild(label);
      info.appendChild(num);

      const delBtn = document.createElement('button');
      delBtn.className = 'snapshot-delete-btn';
      delBtn.title = 'Delete frame';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        play.snapshots = play.snapshots.filter(s => s.id !== snap.id);
        if (state.activeSnapshotId === snap.id) state.activeSnapshotId = null;
        renderSnapshotsList();
      });

      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(delBtn);
      item.addEventListener('click', () => loadSnapshot(snap));
      el.appendChild(item);
    });
  }

  function startRenameSnapshot(snap, labelEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'play-name-input';
    input.value = snap.label;
    labelEl.parentNode.replaceChild(input, labelEl);
    input.focus();
    input.select();
    const finish = () => {
      snap.label = input.value.trim() || snap.label;
      input.parentNode.replaceChild(labelEl, input);
      labelEl.textContent = snap.label;
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  function loadSnapshot(snap) {
    state.activeSnapshotId = snap.id;
    clearNonFieldObjects();
    state.teams.a.players = [];
    state.teams.b.players = [];
    state.ball = null;

    fabric.util.enlivenObjects(snap.json.objects || [], (objects) => {
      objects.forEach(obj => {
        if (obj._isFieldObject) return;
        canvas.add(obj);
        if (obj._isBall) {
          state.ball = obj;
        } else if (obj._playerId && obj._team) {
          const team = state.teams[obj._team];
          if (!team.players.find(p => p.id === obj._playerId)) {
            const innerCircle = obj.type === 'group' ? obj.getObjects('circle')[0] || null : null;
            team.players.push({
              id: obj._playerId,
              name: obj._playerName || 'Player',
              num: obj._playerId,
              circleObj: obj,
              innerCircle,
            });
          }
        }
      });
      renderRosters();
      canvas.renderAll();
    });

    renderSnapshotsList();
  }

  function getFieldStateJSON() {
    const objects = canvas.getObjects()
      .filter(o => !o._isFieldObject && !o._isPreview)
      .map(o => o.toObject([
        '_playerId','_team','_playerName',
        '_arrowObject','_textBox','shaftWidth','headWidth','headLength',
        '_x1','_y1','_x2','_y2','_isBall'
      ]));
    return { objects };
  }

  // ─── PDF export ───────────────────────────────────────────────────────────────
  document.getElementById('btn-export-pdf').addEventListener('click', async () => {
    if (!state.activePlayId) return;
    const play = state.plays.find(p => p.id === state.activePlayId);
    if (!play.snapshots.length) {
      alert('Add at least one frame before exporting.');
      return;
    }

    const { jsPDF } = window.jspdf;
    // Landscape, A4
    const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();

    // Save current canvas state
    const savedJSON = getFieldStateJSON();

    for (let i = 0; i < play.snapshots.length; i++) {
      const snap = play.snapshots[i];

      // Load snapshot onto canvas for high-res render
      clearNonFieldObjects();
      await new Promise(resolve => {
        fabric.util.enlivenObjects(snap.json.objects || [], (objects) => {
          objects.forEach(obj => { if (!obj._isFieldObject) canvas.add(obj); });
          canvas.renderAll();
          resolve();
        });
      });

      const imgData = canvas.toDataURL({ format: 'png', multiplier: 2 });

      if (i > 0) pdf.addPage();

      // Title
      pdf.setFontSize(14);
      pdf.setTextColor(30, 30, 60);
      pdf.text(`${play.name}  —  ${snap.label}`, 10, 12);
      pdf.setFontSize(9);
      pdf.setTextColor(120, 120, 140);
      pdf.text(`Frame ${i + 1} of ${play.snapshots.length}`, 10, 18);

      // Field image
      const imgX = 8;
      const imgY = 22;
      const imgW = pageW - 16;
      const imgH = pageH - 28;
      pdf.addImage(imgData, 'PNG', imgX, imgY, imgW, imgH);

      // Border
      pdf.setDrawColor(80, 80, 120);
      pdf.setLineWidth(0.5);
      pdf.rect(imgX, imgY, imgW, imgH);
    }

    // Restore original canvas state
    clearNonFieldObjects();
    fabric.util.enlivenObjects(savedJSON.objects || [], (objects) => {
      objects.forEach(obj => { if (!obj._isFieldObject) canvas.add(obj); });
      canvas.renderAll();
    });

    const pdfDataUrl = pdf.output('datauristring');
    if (window.electronAPI) {
      const result = await window.electronAPI.exportPdf({ pdfDataUrl, playName: play.name });
      if (result.success) alert(`PDF exported to:\n${result.filePath}`);
    } else {
      pdf.save(`${play.name}.pdf`);
    }
  });

  // ─── Save / Load ─────────────────────────────────────────────────────────────
  document.getElementById('btn-save').addEventListener('click', async () => {
    const data = {
      teams: { a: { name: state.teams.a.name, color: state.teams.a.color },
               b: { name: state.teams.b.name, color: state.teams.b.color } },
      plays: state.plays,
      fieldState: getFieldStateJSON()
    };
    if (window.electronAPI) {
      const result = await window.electronAPI.savePlaybook(data);
      if (result.success) showToast(`Saved to ${result.filePath}`);
    }
  });

  document.getElementById('btn-load').addEventListener('click', async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.loadPlaybook();
    if (!result.success) return;
    const data = result.data;

    // Restore teams
    ['a','b'].forEach(t => {
      state.teams[t].name = data.teams[t].name;
      state.teams[t].color = data.teams[t].color;
      document.getElementById(`team-${t}-name`).value = data.teams[t].name;
      document.getElementById(`team-${t}-color`).value = data.teams[t].color;
      document.getElementById(`btn-team-${t}`).textContent = data.teams[t].name;
    });

    // Restore plays
    state.plays = data.plays || [];
    state.activePlayId = null;
    state.activeSnapshotId = null;
    closePlay();
    renderPlaysList();

    // Restore field state
    clearNonFieldObjects();
    state.teams.a.players = [];
    state.teams.b.players = [];
    state.ball = null;
    if (data.fieldState) {
      fabric.util.enlivenObjects(data.fieldState.objects || [], (objects) => {
        objects.forEach(obj => {
          if (obj._isFieldObject) return;
          canvas.add(obj);
          if (obj._isBall) {
            state.ball = obj;
          } else if (obj._playerId && obj._team) {
            const team = state.teams[obj._team];
            if (!team.players.find(p => p.id === obj._playerId)) {
              const innerCircle = obj.type === 'group' ? obj.getObjects('circle')[0] || null : null;
              team.players.push({ id: obj._playerId, name: obj._playerName || 'Player', num: obj._playerId, circleObj: obj, innerCircle });
            }
          }
        });
        renderRosters();
        canvas.renderAll();
      });
    }
  });

  // ─── Modal helper ─────────────────────────────────────────────────────────────
  function showModal(title, fields, onConfirm) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    content.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = title;
    content.appendChild(titleEl);

    const inputs = {};
    fields.forEach(f => {
      const fieldDiv = document.createElement('div');
      fieldDiv.className = 'modal-field';
      const label = document.createElement('label');
      label.textContent = f.label;
      fieldDiv.appendChild(label);
      const input = document.createElement('input');
      input.type = f.type || 'text';
      input.className = 'modal-input';
      input.placeholder = f.placeholder || '';
      if (f.value) input.value = f.value;
      fieldDiv.appendChild(input);
      content.appendChild(fieldDiv);
      inputs[f.id] = input;
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'modal-btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.className = 'modal-btn primary';
    confirm.textContent = 'OK';

    actions.appendChild(cancel);
    actions.appendChild(confirm);
    content.appendChild(actions);

    overlay.classList.remove('hidden');
    const firstInput = Object.values(inputs)[0];
    if (firstInput) { firstInput.focus(); firstInput.select(); }

    const close = () => overlay.classList.add('hidden');

    cancel.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    const submit = () => {
      const values = {};
      Object.keys(inputs).forEach(k => values[k] = inputs[k].value);
      close();
      onConfirm(values);
    };

    confirm.addEventListener('click', submit);
    content.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }

  // ─── Toast ────────────────────────────────────────────────────────────────────
  function showToast(msg) {
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:#1f2b47;border:1px solid #4cc9f0;color:#e8eaf6;padding:8px 18px;
      border-radius:6px;font-size:12px;z-index:9999;pointer-events:none;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2800);
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────
  function uid() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

})();
