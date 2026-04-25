// === MOD_001 · OBSIDIAN_DECK ===
// 3D notes drift in a dark void. Pan the camera with drag, zoom with scroll,
// double-click empty space to spawn a note, drag a note's header to move it,
// type to edit (debounced save), × to delete.
//
// Tech:
//   - THREE.js WebGLRenderer for the void: grid, particles, glow.
//   - CSS3DRenderer for the notes themselves — they're HTML, so input
//     fields work natively and text is crisp at every zoom level.
//
// Persistence: `notes` table on Supabase, RLS on auth.uid().

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const MODULE_CODE = 'MOD_001';
const SAVE_DEBOUNCE_MS = 600;

// =============================================================================
// Lifecycle: mount(stage, ctx) / unmount() — wired into the host shell.
// =============================================================================
let state = null;

function mount(stage, ctx) {
  state = createState(stage, ctx);
  buildDOM(state);
  buildScene(state);
  bindInput(state);
  startLoop(state);
  loadNotes(state);
}

function unmount() {
  if (!state) return;
  cancelAnimationFrame(state.rafId);
  state.resizeObserver?.disconnect();
  for (const off of state.cleanups) { try { off(); } catch (_) {} }
  state.notes.forEach((n) => n.css3d.element.remove());
  state.cssRenderer.domElement.remove();
  state.glRenderer.domElement.remove();
  state.glRenderer.dispose();
  state.host.remove();
  state = null;
}

// =============================================================================
// State
// =============================================================================
function createState(stage, ctx) {
  return {
    stage,
    sb: ctx.sb,
    project: ctx.project,
    code: ctx.code,
    exit: ctx.exit,

    host: null,            // root div inside stage
    glLayer: null,
    cssLayer: null,
    actionBar: null,

    scene: null,
    cssScene: null,
    camera: null,
    glRenderer: null,
    cssRenderer: null,
    grid: null,
    particles: null,

    notes: new Map(),       // id -> { row, css3d, els, dirtyFields, saveTimer }
    selectedId: null,

    drag: null,             // active drag state (camera or note)
    cameraTarget: new THREE.Vector3(0, 0, 0),
    cameraDistance: 800,

    rafId: 0,
    resizeObserver: null,
    cleanups: [],
  };
}

// =============================================================================
// DOM scaffolding inside the stage
// =============================================================================
function buildDOM(s) {
  const host = document.createElement('div');
  host.className = 'm001-host';
  host.innerHTML = `
    <div class="m001-gl"></div>
    <div class="m001-css"></div>
    <div class="m001-vignette"></div>
    <div class="m001-scanlines"></div>
    <div class="m001-actionbar">
      <button type="button" class="m001-action" data-act="new" title="Spawn note (Double-click empty space)">
        <span>+ NEW_NOTE</span>
      </button>
      <button type="button" class="m001-action" data-act="recenter" title="Recenter view">
        <span>◎ RECENTER</span>
      </button>
      <span class="m001-hint">DRAG · pan &nbsp; · &nbsp; SCROLL · zoom &nbsp; · &nbsp; DBL-CLICK · spawn</span>
    </div>
    <div class="m001-toast" id="m001-toast" hidden></div>
  `;
  ensureStyles();
  s.stage.appendChild(host);
  s.host = host;
  s.glLayer = host.querySelector('.m001-gl');
  s.cssLayer = host.querySelector('.m001-css');
  s.actionBar = host.querySelector('.m001-actionbar');
  s.toastEl = host.querySelector('#m001-toast');

  s.actionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'new') spawnNoteAtCenter(s);
    if (btn.dataset.act === 'recenter') recenter(s);
  });
}

function ensureStyles() {
  if (document.getElementById('mod001-styles')) return;
  const css = document.createElement('style');
  css.id = 'mod001-styles';
  css.textContent = MOD001_CSS;
  document.head.appendChild(css);
}

// =============================================================================
// Three.js scene
// =============================================================================
function buildScene(s) {
  const w = s.stage.clientWidth;
  const h = s.stage.clientHeight;

  s.scene = new THREE.Scene();
  s.scene.fog = new THREE.Fog(0x040406, 600, 2200);
  s.cssScene = new THREE.Scene();

  s.camera = new THREE.PerspectiveCamera(55, w / h, 1, 4000);
  s.camera.position.set(0, 0, s.cameraDistance);
  s.camera.lookAt(s.cameraTarget);

  s.glRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  s.glRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  s.glRenderer.setSize(w, h);
  s.glRenderer.setClearColor(0x000000, 0);
  s.glLayer.appendChild(s.glRenderer.domElement);

  s.cssRenderer = new CSS3DRenderer();
  s.cssRenderer.setSize(w, h);
  s.cssLayer.appendChild(s.cssRenderer.domElement);

  // Grid floor — large, fades into fog
  const gridSize = 4000;
  const gridDivs = 40;
  s.grid = new THREE.GridHelper(gridSize, gridDivs, 0xff003c, 0x33000a);
  s.grid.material.transparent = true;
  s.grid.material.opacity = 0.35;
  s.grid.position.y = -400;
  s.scene.add(s.grid);

  // A faint second grid at high altitude for ceiling effect
  const ceiling = new THREE.GridHelper(gridSize, gridDivs, 0x550014, 0x110005);
  ceiling.material.transparent = true;
  ceiling.material.opacity = 0.18;
  ceiling.position.y = 600;
  s.scene.add(ceiling);

  // Particles — depth cues
  const particleCount = 320;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * 2400;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 1400;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 2400;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xff003c,
    size: 2.2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  s.particles = new THREE.Points(geo, mat);
  s.scene.add(s.particles);

  // Origin marker — a subtle ring at the focus center
  const ringGeo = new THREE.RingGeometry(40, 42, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff003c, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -399;
  s.scene.add(ring);
  s.originRing = ring;

  // Resize
  s.resizeObserver = new ResizeObserver(() => onResize(s));
  s.resizeObserver.observe(s.stage);
}

function onResize(s) {
  const w = s.stage.clientWidth;
  const h = s.stage.clientHeight;
  if (!w || !h) return;
  s.camera.aspect = w / h;
  s.camera.updateProjectionMatrix();
  s.glRenderer.setSize(w, h);
  s.cssRenderer.setSize(w, h);
}

// =============================================================================
// Render loop
// =============================================================================
function startLoop(s) {
  let t0 = performance.now();
  const tick = (now) => {
    const dt = (now - t0) / 1000; t0 = now;
    // Drift particles slowly
    if (s.particles) s.particles.rotation.y += dt * 0.02;
    if (s.originRing) s.originRing.material.opacity = 0.3 + Math.sin(now * 0.002) * 0.15;

    // Smooth camera follow (target → camera position with offset on Z)
    const desired = new THREE.Vector3(s.cameraTarget.x, s.cameraTarget.y, s.cameraTarget.z + s.cameraDistance);
    s.camera.position.lerp(desired, 0.15);
    s.camera.lookAt(s.cameraTarget);

    s.glRenderer.render(s.scene, s.camera);
    s.cssRenderer.render(s.cssScene, s.camera);
    s.rafId = requestAnimationFrame(tick);
  };
  s.rafId = requestAnimationFrame(tick);
}

// =============================================================================
// Input — camera pan / zoom / spawn
// =============================================================================
function bindInput(s) {
  const stage = s.host;

  // Pan via drag on empty space (left mouse on the host but NOT on a note element)
  const onPointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const onNote = e.target.closest('.m001-note');
    if (onNote) return; // notes handle their own drag
    s.drag = {
      kind: 'camera',
      startX: e.clientX,
      startY: e.clientY,
      origTarget: s.cameraTarget.clone(),
    };
    stage.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!s.drag) return;
    if (s.drag.kind === 'camera') {
      // Pan factor scales with camera distance for consistent feel
      const factor = s.cameraDistance / 700;
      const dx = (e.clientX - s.drag.startX) * factor;
      const dy = (e.clientY - s.drag.startY) * factor;
      s.cameraTarget.x = s.drag.origTarget.x - dx;
      s.cameraTarget.y = s.drag.origTarget.y + dy;
    } else if (s.drag.kind === 'note') {
      const factor = s.cameraDistance / 700;
      const dx = (e.clientX - s.drag.startX) * factor;
      const dy = (e.clientY - s.drag.startY) * factor;
      const note = s.notes.get(s.drag.id);
      if (note) {
        note.css3d.position.x = s.drag.origPos.x + dx;
        note.css3d.position.y = s.drag.origPos.y - dy;
      }
    }
  };
  const onPointerUp = (e) => {
    if (!s.drag) return;
    if (s.drag.kind === 'note') {
      const note = s.notes.get(s.drag.id);
      if (note) {
        note.row.pos_x = note.css3d.position.x;
        note.row.pos_y = note.css3d.position.y;
        scheduleSave(s, note, ['pos_x', 'pos_y']);
      }
    }
    s.drag = null;
    stage.releasePointerCapture?.(e.pointerId);
  };
  stage.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  s.cleanups.push(() => stage.removeEventListener('pointerdown', onPointerDown));
  s.cleanups.push(() => window.removeEventListener('pointermove', onPointerMove));
  s.cleanups.push(() => window.removeEventListener('pointerup', onPointerUp));

  // Zoom on scroll
  const onWheel = (e) => {
    if (e.target.closest('.m001-note .m001-note-body, .m001-note .m001-note-title')) return; // don't hijack textarea scroll
    e.preventDefault();
    const delta = e.deltaY * 0.7;
    s.cameraDistance = Math.max(180, Math.min(2400, s.cameraDistance + delta));
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  s.cleanups.push(() => stage.removeEventListener('wheel', onWheel));

  // Double-click empty space → spawn note at projected world point
  const onDblClick = (e) => {
    if (e.target.closest('.m001-note')) return;
    if (e.target.closest('.m001-actionbar')) return;
    const rect = s.host.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    // Project to plane at z = cameraTarget.z
    const v = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(s.camera);
    const dir = v.sub(s.camera.position).normalize();
    const t = (s.cameraTarget.z - s.camera.position.z) / dir.z;
    const point = s.camera.position.clone().add(dir.multiplyScalar(t));
    spawnNote(s, { pos_x: point.x, pos_y: point.y, pos_z: point.z });
  };
  stage.addEventListener('dblclick', onDblClick);
  s.cleanups.push(() => stage.removeEventListener('dblclick', onDblClick));
}

function recenter(s) {
  s.cameraTarget.set(0, 0, 0);
  s.cameraDistance = 800;
}

// =============================================================================
// Notes — spawn / load / save / delete
// =============================================================================
function makeNoteEl() {
  const wrap = document.createElement('div');
  wrap.className = 'm001-note';
  wrap.innerHTML = `
    <div class="m001-note-corners">
      <span class="c tl"></span><span class="c tr"></span>
      <span class="c bl"></span><span class="c br"></span>
    </div>
    <div class="m001-note-head" data-drag>
      <span class="m001-note-glyph">◈</span>
      <input type="text" class="m001-note-title" placeholder="UNTITLED" maxlength="60" spellcheck="false" />
      <button type="button" class="m001-note-del" title="Delete note">×</button>
    </div>
    <textarea class="m001-note-body" placeholder="// your thoughts go here…" spellcheck="false"></textarea>
    <div class="m001-note-foot">
      <span class="m001-note-id">—</span>
      <span class="m001-note-saved">SYNCED</span>
    </div>
  `;
  return wrap;
}

function attachNote(s, row) {
  const el = makeNoteEl();
  const titleEl = el.querySelector('.m001-note-title');
  const bodyEl = el.querySelector('.m001-note-body');
  const idEl = el.querySelector('.m001-note-id');
  const savedEl = el.querySelector('.m001-note-saved');
  const headEl = el.querySelector('.m001-note-head');
  const delBtn = el.querySelector('.m001-note-del');

  titleEl.value = row.title || '';
  bodyEl.value = row.body || '';
  idEl.textContent = (row.id || '').slice(0, 8).toUpperCase();

  const css3d = new CSS3DObject(el);
  css3d.position.set(row.pos_x || 0, row.pos_y || 0, row.pos_z || 0);
  s.cssScene.add(css3d);

  const note = { row, el, css3d, els: { titleEl, bodyEl, idEl, savedEl, headEl, delBtn }, saveTimer: null, dirty: new Set() };
  s.notes.set(row.id, note);

  // Click to select / focus
  el.addEventListener('pointerdown', (e) => {
    selectNote(s, row.id);
  });

  // Drag via header
  headEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.m001-note-title, .m001-note-del')) return;
    e.stopPropagation();
    s.drag = {
      kind: 'note',
      id: row.id,
      startX: e.clientX,
      startY: e.clientY,
      origPos: css3d.position.clone(),
    };
    s.host.setPointerCapture?.(e.pointerId);
  });

  // Edit handlers (debounced save)
  titleEl.addEventListener('input', () => { row.title = titleEl.value; markDirty(s, note, 'title'); });
  bodyEl.addEventListener('input', () => { row.body = bodyEl.value; markDirty(s, note, 'body'); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteNote(s, row.id); });

  return note;
}

function selectNote(s, id) {
  if (s.selectedId === id) return;
  s.selectedId = id;
  s.notes.forEach((n) => n.el.classList.toggle('is-selected', n.row.id === id));
}

function markDirty(s, note, field) {
  note.dirty.add(field);
  note.els.savedEl.textContent = 'EDITING…';
  note.els.savedEl.classList.add('dirty');
  scheduleSave(s, note);
}

function scheduleSave(s, note, fields) {
  if (fields) fields.forEach((f) => note.dirty.add(f));
  if (note.saveTimer) clearTimeout(note.saveTimer);
  note.saveTimer = setTimeout(() => doSave(s, note), SAVE_DEBOUNCE_MS);
}

async function doSave(s, note) {
  if (!note.dirty.size) return;
  const patch = { updated_at: new Date().toISOString() };
  for (const f of note.dirty) patch[f] = note.row[f];
  note.dirty.clear();
  note.els.savedEl.textContent = 'SYNCING…';
  const { error } = await s.sb.from('notes').update(patch).eq('id', note.row.id);
  if (error) {
    note.els.savedEl.textContent = 'SYNC_FAIL';
    note.els.savedEl.classList.add('error');
    console.error('[notes] save failed', error);
    return;
  }
  note.els.savedEl.classList.remove('dirty', 'error');
  note.els.savedEl.textContent = 'SYNCED';
}

async function spawnNote(s, opts = {}) {
  const payload = {
    module_code: MODULE_CODE,
    title: '',
    body: '',
    pos_x: opts.pos_x ?? s.cameraTarget.x + (Math.random() - 0.5) * 80,
    pos_y: opts.pos_y ?? s.cameraTarget.y + (Math.random() - 0.5) * 60,
    pos_z: opts.pos_z ?? s.cameraTarget.z + (Math.random() - 0.5) * 40,
  };
  const { data, error } = await s.sb.from('notes').insert(payload).select().single();
  if (error) { toast(s, 'INSERT_FAIL · ' + error.message); return; }
  const note = attachNote(s, data);
  selectNote(s, data.id);
  setTimeout(() => note.els.titleEl.focus(), 50);
}

function spawnNoteAtCenter(s) {
  spawnNote(s, {
    pos_x: s.cameraTarget.x,
    pos_y: s.cameraTarget.y,
    pos_z: s.cameraTarget.z,
  });
}

async function deleteNote(s, id) {
  const note = s.notes.get(id);
  if (!note) return;
  if (!confirm(`Delete this note?`)) return;
  const { error } = await s.sb.from('notes').delete().eq('id', id);
  if (error) { toast(s, 'DELETE_FAIL · ' + error.message); return; }
  s.cssScene.remove(note.css3d);
  note.el.remove();
  s.notes.delete(id);
  if (s.selectedId === id) s.selectedId = null;
}

async function loadNotes(s) {
  const { data, error } = await s.sb
    .from('notes')
    .select('*')
    .eq('module_code', MODULE_CODE)
    .order('created_at', { ascending: true });
  if (error) { toast(s, 'LOAD_FAIL · ' + error.message); return; }
  if (!data || data.length === 0) {
    // Welcome note
    const welcome = await s.sb.from('notes').insert({
      module_code: MODULE_CODE,
      title: 'WELCOME',
      body: '// OBSIDIAN_DECK · v0.1\n\nDouble-click empty space to spawn a new note.\nDrag a note\'s header to move it.\nDrag empty space to pan, scroll to zoom.\n\n— Notes auto-save.',
      pos_x: 0, pos_y: 0, pos_z: 0,
    }).select().single();
    if (welcome.data) attachNote(s, welcome.data);
    return;
  }
  data.forEach((row) => attachNote(s, row));
}

function toast(s, msg) {
  if (!s.toastEl) return;
  s.toastEl.textContent = msg;
  s.toastEl.hidden = false;
  clearTimeout(s.toastTimer);
  s.toastTimer = setTimeout(() => { s.toastEl.hidden = true; }, 3000);
}

// =============================================================================
// Styles (scoped) — injected once on first mount
// =============================================================================
const MOD001_CSS = `
.m001-host {
  position: absolute;
  inset: 0;
  background: radial-gradient(ellipse at center, #0a0005 0%, #000000 70%);
  overflow: hidden;
  font-family: 'Share Tech Mono', monospace;
  color: #e8e8e8;
  user-select: none;
  cursor: grab;
}
.m001-host:active { cursor: grabbing; }
.m001-gl, .m001-css {
  position: absolute;
  inset: 0;
}
.m001-gl { z-index: 0; }
.m001-css { z-index: 1; pointer-events: none; }
.m001-css > div { pointer-events: auto; }
.m001-vignette {
  position: absolute; inset: 0; z-index: 2; pointer-events: none;
  background:
    radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.7) 100%),
    linear-gradient(180deg, rgba(255,0,60,0.04), transparent 30%, transparent 70%, rgba(255,0,60,0.04));
}
.m001-scanlines {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  background: repeating-linear-gradient(
    0deg, transparent 0, transparent 2px, rgba(255,0,60,0.025) 2px, rgba(255,0,60,0.025) 3px
  );
  mix-blend-mode: screen;
}
.m001-actionbar {
  position: absolute;
  bottom: 1.2rem; left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.8rem;
  border: 1px solid rgba(255,0,60,0.3);
  background: rgba(8,2,4,0.85);
  backdrop-filter: blur(6px);
}
.m001-action {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  padding: 0.5rem 0.9rem;
  background: transparent;
  color: #ff003c;
  border: 1px solid rgba(255,0,60,0.5);
  cursor: pointer;
  transition: all 0.2s;
  text-transform: uppercase;
}
.m001-action:hover {
  background: #ff003c;
  color: #000;
  letter-spacing: 0.26em;
  box-shadow: 0 0 18px rgba(255,0,60,0.6);
}
.m001-hint {
  font-size: 0.7rem;
  color: rgba(255,255,255,0.4);
  letter-spacing: 0.1em;
  padding: 0 0.6rem;
  text-transform: uppercase;
}
.m001-toast {
  position: absolute;
  top: 1.2rem; left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  padding: 0.6rem 1rem;
  border: 1px solid #ff003c;
  background: rgba(40,0,8,0.92);
  color: #ff003c;
  font-size: 0.8rem;
  letter-spacing: 0.12em;
}

/* === Notes === */
.m001-note {
  width: 320px;
  min-height: 200px;
  background: linear-gradient(160deg, rgba(20,5,10,0.92), rgba(5,0,3,0.95));
  border: 1px solid rgba(255,0,60,0.45);
  box-shadow: 0 0 24px rgba(255,0,60,0.18), inset 0 0 40px rgba(255,0,60,0.04);
  position: relative;
  display: flex;
  flex-direction: column;
  font-family: 'Share Tech Mono', monospace;
  color: #e8e8e8;
  transition: box-shadow 0.25s, border-color 0.25s, transform 0.15s;
}
.m001-note.is-selected {
  border-color: #ff003c;
  box-shadow: 0 0 36px rgba(255,0,60,0.45), inset 0 0 50px rgba(255,0,60,0.08);
}
.m001-note-corners .c {
  position: absolute; width: 10px; height: 10px;
  border: 1px solid #ff003c;
}
.m001-note-corners .tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.m001-note-corners .tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
.m001-note-corners .bl { bottom: -1px; left: -1px; border-right: 0; border-top: 0; }
.m001-note-corners .br { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
.m001-note-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid rgba(255,0,60,0.25);
  background: linear-gradient(90deg, rgba(255,0,60,0.12), transparent);
  cursor: grab;
}
.m001-note-head:active { cursor: grabbing; }
.m001-note-glyph {
  color: #ff003c;
  font-size: 0.85rem;
  text-shadow: 0 0 8px rgba(255,0,60,0.7);
}
.m001-note-title {
  flex: 1;
  background: transparent;
  border: 0;
  color: #fff;
  font-family: 'Orbitron', sans-serif;
  font-size: 0.85rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  outline: none;
  padding: 0.2rem 0;
}
.m001-note-title::placeholder { color: rgba(255,255,255,0.3); }
.m001-note-del {
  background: transparent;
  border: 1px solid transparent;
  color: rgba(255,255,255,0.4);
  font-size: 1.1rem;
  line-height: 1;
  width: 24px; height: 24px;
  cursor: pointer;
  transition: all 0.15s;
}
.m001-note-del:hover { color: #ff003c; border-color: rgba(255,0,60,0.5); }
.m001-note-body {
  flex: 1;
  background: transparent;
  border: 0;
  color: #d8d8d8;
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.84rem;
  line-height: 1.55;
  padding: 0.7rem 0.8rem;
  resize: none;
  outline: none;
  min-height: 130px;
}
.m001-note-body::placeholder { color: rgba(255,255,255,0.25); }
.m001-note-foot {
  display: flex;
  justify-content: space-between;
  padding: 0.4rem 0.7rem;
  border-top: 1px solid rgba(255,0,60,0.2);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
}
.m001-note-saved.dirty { color: #ffaa00; }
.m001-note-saved.error { color: #ff003c; }
`;

// =============================================================================
// Register with the host shell
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'OBSIDIAN_DECK · 3D NOTES',
  mount,
  unmount,
});
