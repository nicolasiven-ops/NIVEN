// === MOD_001 · OBSIDIAN_DECK ===
// 3D notes drift in a dark void. Pan the camera with drag, zoom with scroll,
// double-click empty space to spawn a note, drag a note's header to move it,
// type to edit (debounced save), × to delete.
//
// Power features:
//   · Ctrl/Cmd+K  — search overlay (fuzzy match, fly camera to result)
//   · M           — toggle MAP overview (zoom out, see everything)
//   · N           — new note at camera focus
//   · R           — recenter camera
//   · /           — focus search input
//   · Esc         — close overlay / deselect / blur
//   · Delete      — purge selected note (with themed confirm)
//   · Color tags  — 5 swatches in note footer
//   · Persisted   — camera state lives in localStorage
//
// Tech:
//   - THREE.js WebGLRenderer for the void (grid, particles, glow)
//   - CSS3DRenderer for notes — they're real HTML, native inputs, crisp text
//   - Supabase `notes` table with RLS

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const MODULE_CODE = 'MOD_001';
const SAVE_DEBOUNCE_MS = 600;
const CAM_KEY = 'niven:m001:camera';

const COLORS = [
  { id: 'red',    hex: '#ff003c', glow: 'rgba(255,0,60,0.55)' },
  { id: 'amber',  hex: '#ffae00', glow: 'rgba(255,174,0,0.55)' },
  { id: 'cyan',   hex: '#00d4ff', glow: 'rgba(0,212,255,0.55)' },
  { id: 'green',  hex: '#35ff7a', glow: 'rgba(53,255,122,0.55)' },
  { id: 'violet', hex: '#b87aff', glow: 'rgba(184,122,255,0.55)' },
];
const colorBy = (id) => COLORS.find((c) => c.id === id) || COLORS[0];
const colorByHex = (hex) => COLORS.find((c) => c.hex === hex) || COLORS[0];

// =============================================================================
// Lifecycle
// =============================================================================
let state = null;

function mount(stage, ctx) {
  state = createState(stage, ctx);
  buildDOM(state);
  buildScene(state);
  bindInput(state);
  bindKeyboard(state);
  startLoop(state);
  loadCamera(state);
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

    host: null,
    glLayer: null, cssLayer: null,
    actionBar: null, toastEl: null,
    searchEl: null, searchInput: null, searchResults: null, searchCount: null,
    confirmEl: null, confirmTitle: null, confirmOk: null, confirmCancel: null,
    legendEl: null,

    scene: null, cssScene: null, camera: null,
    glRenderer: null, cssRenderer: null,
    grid: null, particles: null, originRing: null,

    notes: new Map(),       // id -> { row, css3d, els, dirty, saveTimer, color }
    selectedId: null,

    drag: null,             // active drag state (camera or note)

    cameraTarget: new THREE.Vector3(0, 0, 0),
    targetTarget: new THREE.Vector3(0, 0, 0), // smooth destination
    cameraDistance: 800,
    targetDistance: 800,
    preMapState: null,      // stores camera state when entering map mode
    mode: 'free',           // 'free' | 'map'

    cameraSaveTimer: null,
    confirmResolve: null,
    searchOpen: false,
    searchActiveIdx: 0,
    searchHits: [],

    rafId: 0,
    resizeObserver: null,
    cleanups: [],
  };
}

// =============================================================================
// DOM
// =============================================================================
function buildDOM(s) {
  ensureStyles();
  const host = document.createElement('div');
  host.className = 'm001-host';
  host.innerHTML = `
    <div class="m001-gl"></div>
    <div class="m001-css"></div>
    <div class="m001-vignette"></div>
    <div class="m001-scanlines"></div>

    <div class="m001-actionbar">
      <button type="button" class="m001-action" data-act="new"      title="New note (N)"><span>+ NEW</span></button>
      <button type="button" class="m001-action" data-act="search"   title="Search (Ctrl+K)"><span>⌕ SEARCH</span></button>
      <button type="button" class="m001-action" data-act="map"      title="Map overview (M)"><span>◗ MAP</span></button>
      <button type="button" class="m001-action" data-act="recenter" title="Recenter view (R)"><span>◎ RECENTER</span></button>
      <button type="button" class="m001-action ghost" data-act="legend" title="Toggle shortcut legend"><span>?</span></button>
    </div>

    <div class="m001-legend" hidden>
      <div class="m001-legend-title">// SHORTCUTS</div>
      <div class="m001-legend-grid">
        <span class="key">N</span><span>New note at focus</span>
        <span class="key">DBL-CLICK</span><span>Spawn note at cursor</span>
        <span class="key">DRAG</span><span>Pan camera</span>
        <span class="key">SCROLL</span><span>Zoom</span>
        <span class="key">M</span><span>Map overview</span>
        <span class="key">R</span><span>Recenter</span>
        <span class="key">CTRL+K</span><span>Search</span>
        <span class="key">/</span><span>Quick search</span>
        <span class="key">DEL</span><span>Delete selected</span>
        <span class="key">ESC</span><span>Deselect / close</span>
      </div>
    </div>

    <div class="m001-search" hidden>
      <div class="m001-search-panel">
        <span class="corner tl"></span><span class="corner tr"></span>
        <span class="corner bl"></span><span class="corner br"></span>
        <div class="m001-search-input-wrap">
          <span class="m001-search-prompt">QUERY //</span>
          <input class="m001-search-input" placeholder="search title or body…" spellcheck="false" autocomplete="off" />
          <span class="m001-search-count">0</span>
        </div>
        <ul class="m001-search-results"></ul>
        <div class="m001-search-hint">↑↓ navigate · ↵ fly-to · ESC close</div>
      </div>
    </div>

    <div class="m001-confirm" hidden>
      <div class="m001-confirm-panel">
        <span class="corner tl"></span><span class="corner tr"></span>
        <span class="corner bl"></span><span class="corner br"></span>
        <div class="m001-confirm-head">
          <span class="m001-confirm-glyph">!</span>
          <h3>PURGE_NOTE</h3>
        </div>
        <p class="m001-confirm-msg">Delete this note? <strong class="m001-confirm-target">—</strong></p>
        <div class="m001-confirm-actions">
          <button type="button" class="m001-action" data-confirm="cancel">CANCEL</button>
          <button type="button" class="m001-action danger" data-confirm="ok">PURGE</button>
        </div>
      </div>
    </div>

    <div class="m001-toast" hidden></div>
  `;
  s.stage.appendChild(host);
  s.host = host;
  s.glLayer = host.querySelector('.m001-gl');
  s.cssLayer = host.querySelector('.m001-css');
  s.actionBar = host.querySelector('.m001-actionbar');
  s.toastEl = host.querySelector('.m001-toast');
  s.legendEl = host.querySelector('.m001-legend');

  s.searchEl = host.querySelector('.m001-search');
  s.searchInput = host.querySelector('.m001-search-input');
  s.searchResults = host.querySelector('.m001-search-results');
  s.searchCount = host.querySelector('.m001-search-count');

  s.confirmEl = host.querySelector('.m001-confirm');
  s.confirmTitle = host.querySelector('.m001-confirm-target');
  s.confirmOk = host.querySelector('[data-confirm="ok"]');
  s.confirmCancel = host.querySelector('[data-confirm="cancel"]');

  // Action bar
  s.actionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'new':      spawnNoteAtCenter(s); break;
      case 'search':   openSearch(s); break;
      case 'map':      toggleMap(s); break;
      case 'recenter': recenter(s); break;
      case 'legend':   s.legendEl.hidden = !s.legendEl.hidden; break;
    }
  });

  // Confirm modal wiring
  s.confirmOk.addEventListener('click', () => closeConfirm(s, true));
  s.confirmCancel.addEventListener('click', () => closeConfirm(s, false));
  s.confirmEl.addEventListener('click', (e) => {
    if (e.target === s.confirmEl) closeConfirm(s, false);
  });

  // Search wiring
  s.searchInput.addEventListener('input', () => runSearch(s));
  s.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearch(s); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSearch(s, 1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); moveSearch(s, -1); }
    else if (e.key === 'Enter')     { e.preventDefault(); commitSearch(s); }
  });
  s.searchEl.addEventListener('click', (e) => {
    if (e.target === s.searchEl) closeSearch(s);
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
  s.scene.fog = new THREE.Fog(0x040406, 800, 3200);
  s.cssScene = new THREE.Scene();

  s.camera = new THREE.PerspectiveCamera(55, w / h, 1, 8000);
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

  // Grid floor
  s.grid = new THREE.GridHelper(6000, 60, 0xff003c, 0x33000a);
  s.grid.material.transparent = true;
  s.grid.material.opacity = 0.32;
  s.grid.position.y = -400;
  s.scene.add(s.grid);

  // Ceiling grid
  const ceiling = new THREE.GridHelper(6000, 60, 0x550014, 0x110005);
  ceiling.material.transparent = true;
  ceiling.material.opacity = 0.16;
  ceiling.position.y = 600;
  s.scene.add(ceiling);

  // Particles
  const particleCount = 420;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * 3200;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 1600;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 3200;
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

  // Origin focus ring
  const ringGeo = new THREE.RingGeometry(40, 42, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff003c, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -399;
  s.scene.add(ring);
  s.originRing = ring;

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
    if (s.particles) s.particles.rotation.y += dt * 0.018;
    if (s.originRing) s.originRing.material.opacity = 0.28 + Math.sin(now * 0.002) * 0.16;

    // Smooth target + distance
    s.cameraTarget.lerp(s.targetTarget, 0.18);
    s.cameraDistance += (s.targetDistance - s.cameraDistance) * 0.14;

    // For map mode we tilt the camera so we look down at the plane of notes
    let camY = s.cameraTarget.y;
    let camZ = s.cameraTarget.z + s.cameraDistance;
    if (s.mode === 'map') {
      camY = s.cameraTarget.y + s.cameraDistance * 0.6;
      camZ = s.cameraTarget.z + s.cameraDistance * 0.55;
    }
    const desired = new THREE.Vector3(s.cameraTarget.x, camY, camZ);
    s.camera.position.lerp(desired, 0.16);
    s.camera.lookAt(s.cameraTarget);

    s.glRenderer.render(s.scene, s.camera);
    s.cssRenderer.render(s.cssScene, s.camera);
    s.rafId = requestAnimationFrame(tick);
  };
  s.rafId = requestAnimationFrame(tick);
}

// =============================================================================
// Camera persistence
// =============================================================================
function loadCamera(s) {
  try {
    const raw = localStorage.getItem(CAM_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.x === 'number') s.targetTarget.x = s.cameraTarget.x = p.x;
    if (typeof p.y === 'number') s.targetTarget.y = s.cameraTarget.y = p.y;
    if (typeof p.z === 'number') s.targetTarget.z = s.cameraTarget.z = p.z;
    if (typeof p.dist === 'number') s.cameraDistance = s.targetDistance = p.dist;
  } catch (_) {}
}
function saveCamera(s) {
  if (s.cameraSaveTimer) clearTimeout(s.cameraSaveTimer);
  s.cameraSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(CAM_KEY, JSON.stringify({
        x: s.targetTarget.x,
        y: s.targetTarget.y,
        z: s.targetTarget.z,
        dist: s.targetDistance,
      }));
    } catch (_) {}
  }, 400);
}

// =============================================================================
// Input — pointer pan/zoom/spawn
// =============================================================================
function bindInput(s) {
  const stage = s.host;

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.m001-note, .m001-actionbar, .m001-search, .m001-confirm, .m001-legend')) return;
    s.drag = {
      kind: 'camera',
      startX: e.clientX,
      startY: e.clientY,
      origTarget: s.targetTarget.clone(),
      moved: false,
    };
    stage.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!s.drag) return;
    if (s.drag.kind === 'camera') {
      const factor = s.cameraDistance / 700;
      const dx = (e.clientX - s.drag.startX) * factor;
      const dy = (e.clientY - s.drag.startY) * factor;
      if (Math.abs(dx) + Math.abs(dy) > 4) s.drag.moved = true;
      s.targetTarget.x = s.drag.origTarget.x - dx;
      s.targetTarget.y = s.drag.origTarget.y + dy;
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
    } else if (s.drag.kind === 'camera') {
      saveCamera(s);
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

  const onWheel = (e) => {
    if (e.target.closest('.m001-note .m001-note-body, .m001-note .m001-note-title, .m001-search')) return;
    if (s.mode === 'map') return; // disable zoom while in map mode
    e.preventDefault();
    const delta = e.deltaY * 0.7;
    s.targetDistance = Math.max(180, Math.min(2400, s.targetDistance + delta));
    saveCamera(s);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  s.cleanups.push(() => stage.removeEventListener('wheel', onWheel));

  const onDblClick = (e) => {
    if (e.target.closest('.m001-note, .m001-actionbar, .m001-search, .m001-confirm, .m001-legend')) return;
    if (s.mode === 'map') return;
    const rect = s.host.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
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
  s.targetTarget.set(0, 0, 0);
  s.targetDistance = 800;
  saveCamera(s);
}

function flyTo(s, x, y, z, dist = 420) {
  s.targetTarget.set(x, y, z);
  s.targetDistance = dist;
  saveCamera(s);
}

// =============================================================================
// Map mode — zoom way out, look down
// =============================================================================
function toggleMap(s) {
  if (s.mode === 'map') exitMap(s);
  else enterMap(s);
}
function enterMap(s) {
  if (s.notes.size === 0) { toast(s, 'NO NOTES TO MAP'); return; }
  s.preMapState = {
    target: s.targetTarget.clone(),
    distance: s.targetDistance,
  };
  // Compute bounding center + extent
  let cx = 0, cy = 0, max = 0;
  s.notes.forEach((n) => {
    cx += n.css3d.position.x;
    cy += n.css3d.position.y;
  });
  cx /= s.notes.size; cy /= s.notes.size;
  s.notes.forEach((n) => {
    max = Math.max(max, Math.abs(n.css3d.position.x - cx), Math.abs(n.css3d.position.y - cy));
  });
  s.targetTarget.set(cx, cy, 0);
  s.targetDistance = Math.max(900, max * 2.4 + 600);
  s.mode = 'map';
  s.host.classList.add('is-map');
  const btn = s.actionBar.querySelector('[data-act="map"]');
  if (btn) btn.classList.add('active');
  toast(s, '// MAP MODE');
}
function exitMap(s) {
  if (s.preMapState) {
    s.targetTarget.copy(s.preMapState.target);
    s.targetDistance = s.preMapState.distance;
    s.preMapState = null;
  }
  s.mode = 'free';
  s.host.classList.remove('is-map');
  const btn = s.actionBar.querySelector('[data-act="map"]');
  if (btn) btn.classList.remove('active');
}

// =============================================================================
// Search overlay
// =============================================================================
function openSearch(s) {
  s.searchEl.hidden = false;
  s.searchOpen = true;
  s.searchInput.value = '';
  runSearch(s);
  setTimeout(() => s.searchInput.focus(), 30);
}
function closeSearch(s) {
  s.searchEl.hidden = true;
  s.searchOpen = false;
  s.searchActiveIdx = 0;
  s.searchHits = [];
  s.host.focus();
}
function runSearch(s) {
  const q = s.searchInput.value.trim().toLowerCase();
  const all = Array.from(s.notes.values());
  let hits;
  if (!q) {
    hits = all
      .slice()
      .sort((a, b) => new Date(b.row.updated_at || b.row.created_at) - new Date(a.row.updated_at || a.row.created_at))
      .slice(0, 30);
  } else {
    hits = all
      .map((n) => {
        const t = (n.row.title || '').toLowerCase();
        const b = (n.row.body || '').toLowerCase();
        const ti = t.indexOf(q);
        const bi = b.indexOf(q);
        if (ti < 0 && bi < 0) return null;
        return { n, score: ti >= 0 ? 100 - ti : 50 - bi, ti, bi };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.n)
      .slice(0, 30);
  }
  s.searchHits = hits;
  s.searchActiveIdx = 0;
  renderSearchResults(s, q);
}
function renderSearchResults(s, q) {
  s.searchCount.textContent = String(s.searchHits.length).padStart(2, '0');
  s.searchResults.innerHTML = '';
  s.searchHits.forEach((n, i) => {
    const li = document.createElement('li');
    li.className = 'm001-hit' + (i === s.searchActiveIdx ? ' active' : '');
    const c = colorBy(colorIdFromHex(n.row.color));
    const title = (n.row.title || 'UNTITLED').slice(0, 64);
    const preview = (n.row.body || '').replace(/\s+/g, ' ').slice(0, 90);
    li.innerHTML = `
      <span class="m001-hit-dot" style="background:${c.hex}; box-shadow: 0 0 8px ${c.glow}"></span>
      <div class="m001-hit-text">
        <div class="m001-hit-title">${highlight(title, q)}</div>
        <div class="m001-hit-preview">${highlight(preview, q) || '<span class="dim">// empty</span>'}</div>
      </div>
    `;
    li.addEventListener('click', () => {
      s.searchActiveIdx = i;
      commitSearch(s);
    });
    s.searchResults.appendChild(li);
  });
}
function highlight(text, q) {
  const safe = text.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  return safe.replace(re, (m) => `<mark>${m}</mark>`);
}
function moveSearch(s, dir) {
  if (s.searchHits.length === 0) return;
  s.searchActiveIdx = (s.searchActiveIdx + dir + s.searchHits.length) % s.searchHits.length;
  renderSearchResults(s, s.searchInput.value.trim().toLowerCase());
  // scroll active into view
  const li = s.searchResults.children[s.searchActiveIdx];
  if (li) li.scrollIntoView({ block: 'nearest' });
}
function commitSearch(s) {
  const note = s.searchHits[s.searchActiveIdx];
  if (!note) return;
  closeSearch(s);
  if (s.mode === 'map') exitMap(s);
  flyTo(s, note.css3d.position.x, note.css3d.position.y, note.css3d.position.z, 420);
  selectNote(s, note.row.id);
}

function colorIdFromHex(hex) {
  if (!hex) return 'red';
  const c = COLORS.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
  return c ? c.id : 'red';
}

// =============================================================================
// Notes
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
      <button type="button" class="m001-note-del" title="Delete (Del)">×</button>
    </div>
    <textarea class="m001-note-body" placeholder="// your thoughts go here…" spellcheck="false"></textarea>
    <div class="m001-note-foot">
      <div class="m001-note-colors">
        ${COLORS.map((c) => `<button type="button" class="m001-swatch" data-color="${c.id}" style="background:${c.hex}; box-shadow: 0 0 6px ${c.glow}" title="${c.id.toUpperCase()}"></button>`).join('')}
      </div>
      <span class="m001-note-saved">SYNCED</span>
    </div>
  `;
  return wrap;
}

function applyNoteColor(note) {
  const c = colorBy(colorIdFromHex(note.row.color));
  note.el.style.setProperty('--accent', c.hex);
  note.el.style.setProperty('--accent-glow', c.glow);
  note.el.querySelectorAll('.m001-swatch').forEach((sw) => {
    sw.classList.toggle('active', sw.dataset.color === c.id);
  });
}

function attachNote(s, row) {
  const el = makeNoteEl();
  const titleEl = el.querySelector('.m001-note-title');
  const bodyEl = el.querySelector('.m001-note-body');
  const savedEl = el.querySelector('.m001-note-saved');
  const headEl = el.querySelector('.m001-note-head');
  const delBtn = el.querySelector('.m001-note-del');

  titleEl.value = row.title || '';
  bodyEl.value = row.body || '';

  const css3d = new CSS3DObject(el);
  css3d.position.set(row.pos_x || 0, row.pos_y || 0, row.pos_z || 0);
  s.cssScene.add(css3d);

  const note = { row, el, css3d, els: { titleEl, bodyEl, savedEl, headEl, delBtn }, dirty: new Set(), saveTimer: null };
  s.notes.set(row.id, note);
  applyNoteColor(note);

  el.addEventListener('pointerdown', () => selectNote(s, row.id));

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

  titleEl.addEventListener('input', () => { row.title = titleEl.value; markDirty(s, note, 'title'); });
  bodyEl.addEventListener('input', () => { row.body = bodyEl.value; markDirty(s, note, 'body'); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); requestDelete(s, row.id); });

  // Color swatches
  el.querySelectorAll('.m001-swatch').forEach((sw) => {
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      const c = colorBy(sw.dataset.color);
      row.color = c.hex;
      applyNoteColor(note);
      scheduleSave(s, note, ['color']);
    });
  });

  return note;
}

function selectNote(s, id) {
  if (s.selectedId === id) return;
  s.selectedId = id;
  s.notes.forEach((n) => n.el.classList.toggle('is-selected', n.row.id === id));
}

function deselect(s) {
  s.selectedId = null;
  s.notes.forEach((n) => n.el.classList.remove('is-selected'));
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
    pos_x: opts.pos_x ?? s.targetTarget.x + (Math.random() - 0.5) * 80,
    pos_y: opts.pos_y ?? s.targetTarget.y + (Math.random() - 0.5) * 60,
    pos_z: opts.pos_z ?? s.targetTarget.z + (Math.random() - 0.5) * 40,
    color: '#ff003c',
  };
  const { data, error } = await s.sb.from('notes').insert(payload).select().single();
  if (error) { toast(s, 'INSERT_FAIL · ' + error.message); return; }
  const note = attachNote(s, data);
  selectNote(s, data.id);
  setTimeout(() => note.els.titleEl.focus(), 50);
}
function spawnNoteAtCenter(s) {
  spawnNote(s, {
    pos_x: s.targetTarget.x,
    pos_y: s.targetTarget.y,
    pos_z: s.targetTarget.z,
  });
}

// Themed delete confirm
function requestDelete(s, id) {
  const note = s.notes.get(id);
  if (!note) return;
  s.confirmTitle.textContent = note.row.title || '(untitled)';
  s.confirmEl.hidden = false;
  s.confirmResolve = (ok) => { if (ok) doDelete(s, id); };
  setTimeout(() => s.confirmCancel.focus(), 30);
}
function closeConfirm(s, ok) {
  s.confirmEl.hidden = true;
  if (s.confirmResolve) { s.confirmResolve(ok); s.confirmResolve = null; }
}
async function doDelete(s, id) {
  const note = s.notes.get(id);
  if (!note) return;
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
    const welcome = await s.sb.from('notes').insert({
      module_code: MODULE_CODE,
      title: 'WELCOME',
      body: '// OBSIDIAN_DECK · v0.2\n\nDouble-click empty space to spawn a note.\nDrag a note\'s header to move, drag the void to pan.\nScroll = zoom. Press M for map view, Ctrl+K for search.\n\nNotes auto-save and live in your private archive.',
      pos_x: 0, pos_y: 0, pos_z: 0,
      color: '#ff003c',
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
  s.toastTimer = setTimeout(() => { s.toastEl.hidden = true; }, 2400);
}

// =============================================================================
// Keyboard shortcuts (only active while module is mounted)
// =============================================================================
function bindKeyboard(s) {
  const inEditable = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  };

  const onKey = (e) => {
    // Global shortcuts that work even when typing in a note:
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (s.searchOpen) closeSearch(s);
      else openSearch(s);
      return;
    }
    if (e.key === 'Escape') {
      if (s.searchOpen) { e.preventDefault(); closeSearch(s); return; }
      if (!s.confirmEl.hidden) { e.preventDefault(); closeConfirm(s, false); return; }
      if (inEditable(document.activeElement)) {
        e.preventDefault();
        document.activeElement.blur();
        return;
      }
      if (s.mode === 'map') { e.preventDefault(); exitMap(s); return; }
      if (s.selectedId) { e.preventDefault(); deselect(s); return; }
      return;
    }

    // Below: only when not typing
    if (inEditable(document.activeElement)) return;

    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); spawnNoteAtCenter(s); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); toggleMap(s); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); recenter(s); return; }
    if (e.key === '/')                  { e.preventDefault(); openSearch(s); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.selectedId) { e.preventDefault(); requestDelete(s, s.selectedId); }
      return;
    }
    if (e.key === 'ArrowLeft')  { s.targetTarget.x -= 80; saveCamera(s); }
    if (e.key === 'ArrowRight') { s.targetTarget.x += 80; saveCamera(s); }
    if (e.key === 'ArrowUp')    { s.targetTarget.y += 80; saveCamera(s); }
    if (e.key === 'ArrowDown')  { s.targetTarget.y -= 80; saveCamera(s); }
  };

  window.addEventListener('keydown', onKey);
  s.cleanups.push(() => window.removeEventListener('keydown', onKey));
}

// =============================================================================
// Styles
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
.m001-host.is-map { cursor: zoom-out; }
.m001-gl, .m001-css { position: absolute; inset: 0; }
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

/* Action bar */
.m001-actionbar {
  position: absolute;
  bottom: 1.2rem; left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 0.55rem;
  border: 1px solid rgba(255,0,60,0.3);
  background: rgba(8,2,4,0.85);
  backdrop-filter: blur(6px);
}
.m001-action {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.74rem;
  letter-spacing: 0.16em;
  padding: 0.5rem 0.85rem;
  background: transparent;
  color: #ff003c;
  border: 1px solid rgba(255,0,60,0.5);
  cursor: pointer;
  transition: all 0.18s;
  text-transform: uppercase;
}
.m001-action:hover {
  background: #ff003c;
  color: #000;
  letter-spacing: 0.22em;
  box-shadow: 0 0 18px rgba(255,0,60,0.6);
}
.m001-action.active {
  background: rgba(255,0,60,0.18);
  border-color: #ff003c;
  box-shadow: 0 0 14px rgba(255,0,60,0.5);
}
.m001-action.ghost {
  border-color: rgba(255,255,255,0.18);
  color: rgba(255,255,255,0.55);
  padding: 0.5rem 0.7rem;
}
.m001-action.ghost:hover {
  background: rgba(255,255,255,0.06);
  color: #fff;
  box-shadow: none;
}
.m001-action.danger { border-color: #ff003c; color: #ff003c; }
.m001-action.danger:hover { background: #ff003c; color: #000; box-shadow: 0 0 22px rgba(255,0,60,0.7); }

/* Legend */
.m001-legend {
  position: absolute;
  bottom: 4.5rem; left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  padding: 0.9rem 1rem;
  border: 1px solid rgba(255,0,60,0.35);
  background: rgba(8,2,4,0.92);
  backdrop-filter: blur(8px);
  font-size: 0.75rem;
  color: rgba(255,255,255,0.7);
  letter-spacing: 0.08em;
  min-width: 360px;
}
.m001-legend-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.72rem;
  letter-spacing: 0.2em;
  color: #ff003c;
  margin-bottom: 0.5rem;
}
.m001-legend-grid {
  display: grid;
  grid-template-columns: 7rem 1fr;
  gap: 0.35rem 0.8rem;
}
.m001-legend-grid .key {
  font-family: 'Share Tech Mono', monospace;
  color: #ff003c;
  border: 1px solid rgba(255,0,60,0.35);
  padding: 0 0.4rem;
  text-align: center;
  background: rgba(255,0,60,0.05);
  text-transform: uppercase;
  font-size: 0.7rem;
}

/* Toast */
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

/* Search overlay */
.m001-search[hidden],
.m001-confirm[hidden] { display: none !important; }
.m001-search {
  position: absolute;
  inset: 0;
  z-index: 7;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}
.m001-search-panel {
  position: relative;
  width: min(640px, 90vw);
  background: linear-gradient(160deg, rgba(15,4,8,0.95), rgba(5,0,3,0.98));
  border: 1px solid rgba(255,0,60,0.5);
  box-shadow: 0 30px 80px rgba(0,0,0,0.8), 0 0 60px rgba(255,0,60,0.25);
}
.m001-search-panel .corner {
  position: absolute; width: 14px; height: 14px;
}
.m001-search-panel .corner.tl { top: -1px; left: -1px; border-top: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-search-panel .corner.tr { top: -1px; right: -1px; border-top: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-search-panel .corner.bl { bottom: -1px; left: -1px; border-bottom: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-search-panel .corner.br { bottom: -1px; right: -1px; border-bottom: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-search-input-wrap {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.9rem 1rem;
  border-bottom: 1px solid rgba(255,0,60,0.25);
}
.m001-search-prompt {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  color: #ff003c;
}
.m001-search-input {
  flex: 1;
  background: transparent;
  border: 0;
  color: #fff;
  font-family: 'Share Tech Mono', monospace;
  font-size: 1rem;
  outline: none;
}
.m001-search-input::placeholder { color: rgba(255,255,255,0.3); }
.m001-search-count {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.12em;
  color: rgba(255,255,255,0.5);
  border: 1px solid rgba(255,0,60,0.4);
  padding: 0.15rem 0.45rem;
}
.m001-search-results {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 50vh;
  overflow-y: auto;
}
.m001-hit {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.7rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  transition: background 0.15s;
}
.m001-hit:hover, .m001-hit.active {
  background: rgba(255,0,60,0.1);
}
.m001-hit.active {
  border-left: 2px solid #ff003c;
  padding-left: calc(1rem - 2px);
}
.m001-hit-dot {
  flex: 0 0 auto;
  width: 8px; height: 8px;
  border-radius: 50%;
  margin-top: 0.4rem;
}
.m001-hit-text { flex: 1; min-width: 0; }
.m001-hit-title {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.85rem;
  letter-spacing: 0.1em;
  color: #fff;
  text-transform: uppercase;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m001-hit-preview {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.78rem;
  color: rgba(255,255,255,0.55);
  margin-top: 0.15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m001-hit mark {
  background: rgba(255,0,60,0.3);
  color: #fff;
  padding: 0 1px;
}
.m001-hit-preview .dim { color: rgba(255,255,255,0.3); font-style: italic; }
.m001-search-hint {
  padding: 0.55rem 1rem;
  border-top: 1px solid rgba(255,0,60,0.18);
  font-size: 0.7rem;
  color: rgba(255,255,255,0.45);
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

/* Themed confirm */
.m001-confirm {
  position: absolute;
  inset: 0;
  z-index: 8;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.m001-confirm-panel {
  position: relative;
  width: min(420px, 90vw);
  padding: 1.2rem 1.4rem 1.4rem;
  background: linear-gradient(135deg, rgba(40,0,8,0.95), rgba(8,0,3,0.98));
  border: 1px solid #ff003c;
  box-shadow: 0 30px 80px rgba(0,0,0,0.85), 0 0 50px rgba(255,0,60,0.45);
}
.m001-confirm-panel .corner {
  position: absolute; width: 14px; height: 14px; border: 0;
}
.m001-confirm-panel .corner.tl { top: -1px; left: -1px; border-top: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-confirm-panel .corner.tr { top: -1px; right: -1px; border-top: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-confirm-panel .corner.bl { bottom: -1px; left: -1px; border-bottom: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-confirm-panel .corner.br { bottom: -1px; right: -1px; border-bottom: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-confirm-head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  margin-bottom: 0.7rem;
}
.m001-confirm-glyph {
  width: 30px; height: 30px;
  display: grid; place-items: center;
  font-family: 'Orbitron', sans-serif;
  font-weight: 700;
  color: #ff003c;
  border: 1px solid #ff003c;
  background: rgba(255,0,60,0.08);
  text-shadow: 0 0 10px rgba(255,0,60,0.7);
  animation: m001-flicker 2s ease-in-out infinite;
}
@keyframes m001-flicker {
  0%, 100% { box-shadow: 0 0 0 rgba(255,0,60,0); }
  50%      { box-shadow: 0 0 14px rgba(255,0,60,0.6); }
}
.m001-confirm-head h3 {
  margin: 0;
  font-family: 'Orbitron', sans-serif;
  font-size: 1rem;
  letter-spacing: 0.18em;
  color: #ff003c;
  text-shadow: 0 0 12px rgba(255,0,60,0.6);
}
.m001-confirm-msg {
  margin: 0 0 1.2rem;
  font-size: 0.85rem;
  color: rgba(255,255,255,0.7);
  line-height: 1.5;
}
.m001-confirm-msg strong {
  color: #fff;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: 0.08em;
  font-weight: 500;
  display: block;
  margin-top: 0.4rem;
  font-size: 0.8rem;
}
.m001-confirm-actions {
  display: flex;
  gap: 0.6rem;
  justify-content: flex-end;
}

/* Notes */
.m001-note {
  --accent: #ff003c;
  --accent-glow: rgba(255,0,60,0.5);
  width: 320px;
  min-height: 200px;
  background: linear-gradient(160deg, rgba(20,5,10,0.92), rgba(5,0,3,0.95));
  border: 1px solid var(--accent);
  box-shadow: 0 0 24px var(--accent-glow), inset 0 0 40px rgba(255,255,255,0.02);
  position: relative;
  display: flex;
  flex-direction: column;
  font-family: 'Share Tech Mono', monospace;
  color: #e8e8e8;
  transition: box-shadow 0.25s, border-color 0.25s, opacity 0.2s;
  opacity: 0.92;
}
.m001-note.is-selected {
  border-color: var(--accent);
  box-shadow: 0 0 36px var(--accent-glow), 0 0 80px var(--accent-glow), inset 0 0 50px rgba(255,255,255,0.04);
  opacity: 1;
}
.m001-note-corners .c {
  position: absolute; width: 10px; height: 10px;
  border: 1px solid var(--accent);
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
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent);
  cursor: grab;
}
.m001-note-head:active { cursor: grabbing; }
.m001-note-glyph {
  color: var(--accent);
  font-size: 0.85rem;
  text-shadow: 0 0 8px var(--accent-glow);
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
.m001-note-del:hover { color: var(--accent); border-color: var(--accent); }
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
  align-items: center;
  padding: 0.45rem 0.7rem;
  border-top: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  font-size: 0.62rem;
  letter-spacing: 0.12em;
  color: rgba(255,255,255,0.4);
  text-transform: uppercase;
  gap: 0.5rem;
}
.m001-note-colors {
  display: flex;
  gap: 0.35rem;
}
.m001-swatch {
  width: 11px; height: 11px;
  border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.18);
  background: #ff003c;
  cursor: pointer;
  padding: 0;
  transition: transform 0.15s, border-color 0.15s;
}
.m001-swatch:hover { transform: scale(1.25); }
.m001-swatch.active { border-color: #fff; transform: scale(1.18); }
.m001-note-saved.dirty { color: #ffaa00; }
.m001-note-saved.error { color: #ff003c; }
`;

// =============================================================================
// Register
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'OBSIDIAN_DECK · 3D NOTES',
  mount,
  unmount,
});
