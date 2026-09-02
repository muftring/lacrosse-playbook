# Lacrosse Playbook — Design Notes

*Living design doc: architecture, decisions and rationale, roadmap, release history, and the current TODO list. Draft in Claude.ai, revise together, then download and commit to `docs/LACROSSE_PLAYBOOK_DESIGN_NOTES.md`.*

## Architecture

Electron desktop app: fabric.js for canvas rendering, jsPDF for PDF export, vanilla JS throughout, no bundler — everything loads via plain `<script>` tags in `renderer/index.html` (fabric, jsPDF, then `field.js` → `arrows.js` → `app.js` in order). Main process (`main.js`) only handles the native save/load/export-PDF file dialogs over IPC; all app logic lives in the renderer.

**Field coordinate system.** Logical yards: x from 0–110 (field length), y from 0–60 (field width). `state.fieldInfo.fx(x)` / `.fy(y)` convert yard coordinates to canvas pixel coordinates against the field background image (`renderer/assets/field-diagram.jpg`), accounting for the image's scale and offset within the canvas.

**Player markers.** A fabric.Group (circle + text label) tagged with `_playerId` / `_team` / `_playerName`, created via `placePlayer(teamKey, cx, cy, name, displayLabel)`. Formations are plain `{label, name, x, y}` arrays in yard coordinates (`FORMATION`, `OFFENSE_HOME`/`AWAY`, `DEFENSE_HOME`/`AWAY`, `DRAW_HOME`/`AWAY`), placed by functions that all funnel through `placePlayer()`. Coach-saved formations persist to `localStorage` (`lax_formations`) via `getFormations()`/`persistFormations()`.

**Plays and snapshots.** A play (`state.plays`) holds named, hand-authored, time-sequenced snapshots of marker/arrow/text positions — these are curated by the coach, not auto-generated, and are conceptually separate from any simulation.

**Ball marker.** A separate fabric.Group (not team-scoped), tagged `_isBall`, tracked at `state.ball`, created/cleared via `placeBall()`/`clearBall()`. Wired into save/load (`getFieldStateJSON()`) and snapshot load (`loadSnapshot()`) so it round-trips correctly.

**Simulation engine — rule-based, not physics/AI.** Deliberate choice: each player is a small set of numeric attributes (1–5 scale) that modify simple, hand-authored behaviors ("move toward the ball," "close out on the ball carrier"), rather than anything learned or simulated from first-principles physics/pathfinding/AI. The latter is a multi-year research project; the former is buildable by one person in a season and is the whole point of this tool — testing coaching "what-ifs," not building a game engine.

**UI framework — Vue 3, additive only.** New interactive simulation UI (playback controls, attribute panels, action selectors, outcome/stats panels) uses Vue 3's global build (`vue.global.js`, Options API, in-DOM/string templates — no bundler needed since the global build includes the runtime compiler). Installed as a plain npm dependency (`npm install vue`) and loaded from `node_modules/vue/dist/vue.global.js` via a `<script>` tag — same pattern as the existing `fabric`/`jsPDF` tags — rather than an actual network CDN, so the app keeps working offline. Existing vanilla-JS panels are left alone; Vue is layered in only where new UI is being added, not a rewrite of what already works. Lives in its own `renderer/sim.js`, talking to `app.js`'s closured state only through a small read-only bridge (`window._laxState`, `window._laxGetView`) plus the shared fabric canvas — no changes to existing formation/play/snapshot logic.

## Draw Sim v1 — Technical Spec

First scenario for the simulation engine. Scope was corrected against the real rule: **3 midfield players per team** are allowed between the restraining lines during a draw (1 center + a circle/wing pair) — not 5, an earlier misread of the general NFHS restraining-line rule.

**Real mechanics modeled.** The draw circle sits at midfield with a center hash. Two restraining lines, roughly 20 yards out from the hash on either side, bound the section where the draw plays out. One **center** per team lines up at the hash, crosse held horizontally, back-to-back with her opponent, cradling the ball between the two crosses. Two **circle/wing players** per team position anywhere around the draw circle — commonly as a pair, often mirrored toward each team's goal side, though exact placement is a coaching decision that depends on how well the centers have been scouted. On the whistle, both centers drive upward; for the draw to be legal the ball must clear both centers' height. Each center then tries to catch it cleanly or redirect/bat it to open space or a teammate.

**Why the draw first:** possession off the draw swings momentum more than almost any other set piece, and it's one of the hardest things to coach because good positioning depends on reading a specific center's habits in real time — high stakes, hard to teach, pattern-based, which is exactly what a rule-based "what-if" simulation is good for.

**Simulated area.** Full field width, bounded by the two restraining lines (~20 yards either side of the hash). Six players plus the ball; everything outside is out of scope for v1.

**Entities and attributes** (1–5 scale, default 3):
- **Center** (1/team): draw_technique, reaction_time, reach, experience, energy. Optional tendency profile (e.g. "60% bat-left / 25% clean-catch / 15% bat-right") — fill in once scouted, leave blank to drill blind.
- **Circle/wing player** (2/team, paired): speed, anticipation, vertical (reach for an airborne ball), ground_ball, positioning_discipline. Anticipation gets a bonus when a tendency profile exists for the opposing center — informed positioning should genuinely pay off in the model.
- **Ball**: position (x, y) + height (z) for the arc; states pre-draw → airborne → loose → possessed. A legal-draw check at the whistle (from both centers' draw_technique) can fail and log a short-draw violation instead of running a contest.

**Center action** (set before running, not decided by an opaque AI): Clean Catch / Bat to Open Space / Bat to Left Teammate / Bat to Right Teammate. Draw_technique determines how closely the real outcome matches intent; the opposing center's technique + reach act as disruption.

**Step 3 simplification — no contest resolution yet.** Until step 5 adds the real probabilistic contest, whichever center has the higher draw_technique is treated as "controlling" the draw and their action selection aims the arc; the opposing center's technique+reach only blend the landing spot back toward the hash (disruption) rather than actually contesting possession. This is a placeholder, not the final mechanic — step 5 replaces "higher technique auto-wins" with the real weighted roll.

**Tick loop.** Fixed 250ms timestep (~120 ticks per 30-second draw), every tick stored for scrubbing. Per tick: check trigger events → update ball physics → update each player's target via behavior state → move players (capped by speed) → resolve any ready contest → push state onto history. Controls: Play, Pause, Step forward/back, Reset, Resume. Editing while paused (reposition, change an attribute, change the action) discards stored ticks after that point; Resume recomputes forward — same branching idea as the snapshot system, just auto-generated frame by frame.

**Circle-player state machine.** IDLE (pre-whistle) → REACT (post-whistle: move toward the anticipated landing spot; anticipation shortens reaction lag and sharpens prediction; speed caps closing distance) → CONTEST (weighted probabilistic roll: speed+vertical for an airborne ball, ground_ball+positioning for a ground ball, energy as a multiplier; near-ties resolve as a 50/50 scrum) → POSSESSED. Pair placement is a first-class, freely re-editable input between runs — the main "what-if" lever.

**Stats hook.** Every run logs: who took the draw, the intended action, the actual outcome, who won, team possession, and any short-draw violation — feeds the Phase 3 stats module below. Future (not v1) extension: track whether a won/lost draw led to a scoring chance within a short window after, to actually quantify the momentum swing rather than just asserting it.

**Suggested build order:**
1. Static setup — 3 markers/team + ball at the hash. *(done — see Release History)*
2. Tick engine + Play/Pause/Step controls, no simulation logic yet — prove the scrub/branch mechanism. *(done — see Release History)*
3. Ball arc physics + legal-draw check + center action selector + clamp resolution. *(done — see Release History)*
4. Circle-player reaction/movement state machine, pair positioning as an editable input.
5. Contest resolution (probabilistic) + outcome logging, including short-draw violations.
6. Wire outcome logging into a minimal in-memory/persisted stats capture.

## Roadmap

Four layers, in order of what's built vs. not:

1. **Whiteboard** (built, needs hardening) — rosters are free-text rather than real player records, no position tagging on a marker, only runs via `npm start` from source. Before tryouts: jersey number + position on each marker, package with `electron-builder` (already a devDependency) for a real installer.
2. **Simulation engine** (in progress, highest original risk) — rule-based rather than full physics/AI (see above). Draw Sim v1 is the scoped first slice.
3. **Stats tracking** (not started, lower risk, can run in parallel) — real roster (first name + number), per-skill ratings (catch, pass, cradle, etc.), position-specific ability (attack/mid/defense/goalie), game-log entry for draws/draws won/team draw possession/attack advances/scoring chances/shots on goal/goals/turnovers/forced turnovers/re-defend pressure/effective transitions/defensive stance. Aggregate views come after entry screens work.
4. **Sharing with other coaches** (not started, deferred) — depends on one undecided question: does data need to sync live across coaches, or is "everyone gets the app, exchanges playbook files" good enough? First needs a real backend; second just needs the Phase 1 packaging. Revisit once Phases 1–3 are stable.

**Sequencing against the season** (tryouts Jan 2027, practices start later that month, first tournament first weekend of March 2027):

| Timeframe | Lacrosse milestone | Playbook tool focus |
|---|---|---|
| Now – Aug 2026 | SILVER certification | Phase 1: roster fields + packaged build |
| Fall 2026 | GOLD certification, rules study | Draw Sim steps 2–6 |
| Fall 2026 (parallel) | — | Phase 3: skill ratings + game-log entry screens |
| Jan 2027 | Tryouts | Stats module ready for tryout evaluations |
| Jan–Feb 2027 | 6 weeks of practice | Draw Sim usable for practice/drill planning |
| Mar 2027 | First tournament | Stats module exercised game-to-game |
| Spring 2027 | Regular season, playoffs, PAGLA | Phase 4 decision point |

**Main risk:** the simulation engine's scope can quietly balloon. "Place any player, program any attribute, watch any outcome" is a fine long-term vision but a bad first milestone — hence scoping to one real scenario (the draw) and proving it before generalizing.

## Release History

- **v0 — initial whiteboard prototype.** Full/attack-zone/defense-zone field views; two teams with editable name + color; drag-and-drop circular player markers with hover-visible names; arrow tool; text boxes; formations (built-in default/offense/defense presets, plus save/load custom formations); plays with named, hand-authored snapshots; multi-page PDF export per play; whole-playbook save/load as `.lax`.
- **Draw Sim step 1 — static setup** (branch `sim/draw-v1-setup`). "Draw Setup" button placing 3 markers/team (center + circle pair) plus the ball at the draw circle; new "Draw Circle" view tab zoomed to the restraining-line zone; ball wired into save/load and snapshots so it round-trips.
- **Draw Sim step 2 — tick engine + playback controls** (branch `sim/draw-tick-engine`). Adds Vue 3 (`renderer/sim.js`) and a floating "Sim Playback Bar" — visible only on the Draw Circle tab once a Draw Setup is placed — with Play/Pause, Step Back/Forward, Reset, a 0.5x/1x/2x speed selector, and a scrub slider. Fixed 250ms-per-tick history array (capped at 120 ticks ≈ 30s), auto-generated by capturing current marker/ball positions each tick — no movement logic yet, that's steps 3–4. Editing a marker/ball while paused, then stepping forward or pressing Play, truncates recorded future ticks and re-records from the edited state (branch semantics); stepping back into already-recorded ticks replays them instead of regenerating. Fully additive: no changes to `placeDrawSetup`/`placePlayer`/`placeBall` or the formation/play/snapshot code paths — `sim.js` reads app state through a small bridge (`window._laxState`, `window._laxGetView`) and the shared fabric canvas.
- **Draw Sim step 3 — center attributes, action selector, ball arc physics, legal-draw check** (branch `sim/draw-center-mechanics`). Center attributes (draw_technique/reaction_time/reach/experience/energy, 1-5, default 3) + optional bat-left/clean-catch/bat-right tendency profile, kept in a `Vue.reactive` store keyed by player id (not on the player record, to stay decoupled from `placePlayer`); clicking a center marker in the select tool opens a floating attributes panel. New "Draw Call" bar lets each team pick an action (Clean Catch / Bat to Open Space / Bat to Left / Bat to Right), stored at `state.drawCall`. Pressing Play from tick 0 is "the whistle": a deterministic legal-draw check (average draw_technique < 2 → short-draw violation banner, no ticking) gates a ball arc — the higher-draw_technique center's action aims the landing spot, the other center's technique+reach blend it back toward the hash (disruption), own technique controls scatter/jitter. The arc is generated as ordinary ticks (ball's height rendered via a ground-shadow trick — a second small circle at the true ground x/y while the ball sprite itself is offset upward by height) so Step Back/Forward/scrub work across it for free, reusing step 2's history mechanism unchanged. Auto-pauses once the arc lands. See the new "Step 3 simplification" callout above the build order — no real contest resolution yet, that's step 5.
- **Planned — Draw Sim steps 4–6.** Circle-player attributes/reaction state machine; probabilistic contest resolution/outcome log; minimal stats capture for draw runs.

## TODO

- [x] Merge the PR for `sim/draw-v1-setup` (step 1)
- [x] Draw Sim step 2: tick engine + playback controls (Vue) — branch `sim/draw-tick-engine`
- [x] Draw Sim step 3: center attributes, action selector, ball arc physics, legal-draw check — branch `sim/draw-center-mechanics`, PR pending
- [ ] Draw Sim step 4: circle/wing attributes + reaction state machine
- [ ] Draw Sim step 5: probabilistic contest resolution + outcome logging
- [ ] Draw Sim step 6: minimal stats capture for draw runs
- [ ] Phase 1: jersey number + position tagging on markers; package with `electron-builder`
- [ ] Phase 3: full player roster, skill ratings, game-log entry screens for season stats
- [ ] Phase 4: decide sync-vs-file-exchange model for sharing with other coaches
