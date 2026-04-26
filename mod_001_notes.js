// === MOD_001 · OBSIDIAN_DECK ===
// Cylindrical note chamber. The camera stands at the central axis of a closed
// cylinder; notes cling to the inner wall. Drag horizontally to rotate around
// the axis, vertically to ride the elevator up/down, scroll to zoom (FOV).
// As more notes are added, the wall stretches outward to make room.
//
// Power features:
//   · Ctrl/Cmd+K  — search overlay (fuzzy match, fly camera to result)
//   · M           — toggle MAP overview (FOV blowout, see almost everything)
//   · N           — new note in front of the camera
//   · R           — recenter (θ=0, y=0)
//   · /           — focus search input
//   · Esc         — close overlay / deselect / blur
//   · Delete      — purge selected note (themed confirm)
//   · Color tags  — 5 swatches in note footer
//   · Camera state persists in localStorage
//
// Tech:
//   - THREE.js cylinder geometry with backside-rendered wall texture
//   - CSS3DRenderer for notes — real HTML on the wall, native inputs
//   - Supabase `notes` table with RLS

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

const MODULE_CODE = 'MOD_001';
const SAVE_DEBOUNCE_MS = 600;
const CAM_KEY = 'niven:m001:cam';
const R_KEY   = 'niven:m001:radius';
const UNDO_LIMIT = 3;

const COLORS = [
  { id: 'red',    hex: '#ff003c', glow: 'rgba(255,0,60,0.55)' },
  { id: 'amber',  hex: '#ffae00', glow: 'rgba(255,174,0,0.55)' },
  { id: 'cyan',   hex: '#00d4ff', glow: 'rgba(0,212,255,0.55)' },
  { id: 'green',  hex: '#35ff7a', glow: 'rgba(53,255,122,0.55)' },
  { id: 'violet', hex: '#b87aff', glow: 'rgba(184,122,255,0.55)' },
];
const colorBy = (id) => COLORS.find((c) => c.id === id) || COLORS[0];

// Cylinder constants
const R_MIN = 600;
const R_MAX = 3000;
const R_DEFAULT = 1200;      // user-controlled via slider
const WALL_HEIGHT = 2400;    // total interior height
const FOV_DEFAULT = 55;
const FOV_MIN = 30;
const FOV_MAX = 95;

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
  if (state.wall) { state.wall.geometry.dispose(); state.wall.material.map?.dispose?.(); state.wall.material.dispose(); }
  if (state.wallRingTop) { state.wallRingTop.geometry.dispose(); state.wallRingTop.material.dispose(); }
  if (state.wallRingBot) { state.wallRingBot.material.dispose(); }
  state.host.remove();
  state = null;
}

// =============================================================================
// State
// =============================================================================
function createState(stage, ctx) {
  return {
    stage, sb: ctx.sb, project: ctx.project, code: ctx.code, exit: ctx.exit,

    host: null, glLayer: null, cssLayer: null,
    actionBar: null, toastEl: null,
    searchEl: null, searchInput: null, searchResults: null, searchCount: null,
    confirmEl: null, confirmTitle: null, confirmOk: null, confirmCancel: null,
    legendEl: null,

    scene: null, cssScene: null, camera: null,
    glRenderer: null, cssRenderer: null,
    wall: null, wallWire: null, particles: null,

    notes: new Map(),     // id -> { row, css3d, els, dirty, saveTimer }
    selectedId: null,

    drag: null,

    // --- Cylindrical camera state ---
    cameraTheta: 0,   targetTheta: 0,
    cameraY:     0,   targetY:     0,
    cameraFov:   FOV_DEFAULT, targetFov: FOV_DEFAULT,
    currentR:    R_DEFAULT,   targetR:   R_DEFAULT,

    radiusInput: null, radiusValueEl: null,
    undoStack: [],     // last UNDO_LIMIT deleted note rows
    undoBtn: null,

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
    <div class="m001-tint"></div>
    <div class="m001-gl"></div>
    <div class="m001-css"></div>
    <div class="m001-vignette"></div>
    <div class="m001-scanlines"></div>
    <div class="m001-altitude" aria-hidden="true">
      <div class="m001-altitude-track"><div class="m001-altitude-pip"></div></div>
      <span class="m001-altitude-label">Y±0</span>
    </div>

    <div class="m001-minimap-wrap" title="Top-down map · click to rotate camera">
      <canvas class="m001-minimap" width="170" height="170"></canvas>
      <span class="m001-minimap-label">// MAP</span>
    </div>

    <div class="m001-radiusbar" title="Wall radius">
      <span class="m001-radiusbar-label">R</span>
      <input type="range" min="${R_MIN}" max="${R_MAX}" step="50" value="${R_DEFAULT}" class="m001-radiusbar-slider" />
      <span class="m001-radiusbar-value">${R_DEFAULT}</span>
    </div>

    <div class="m001-actionbar">
      <button type="button" class="m001-action" data-act="new"      title="New note (N)"><span>+ NEW</span></button>
      <button type="button" class="m001-action" data-act="search"   title="Overview (Ctrl+K)"><span>⊕ OVERVIEW</span></button>
      <button type="button" class="m001-action" data-act="recenter" title="Recenter view (R)"><span>◎ RECENTER</span></button>
      <button type="button" class="m001-action" data-act="undo"     title="Undo last delete (Ctrl+Z)" hidden><span>↶ UNDO <em class="m001-undo-count">0</em></span></button>
      <button type="button" class="m001-action ghost" data-act="legend" title="Toggle shortcut legend"><span>?</span></button>
    </div>

    <div class="m001-legend">
      <div class="m001-legend-title">// CHAMBER · controls</div>
      <div class="m001-legend-grid">
        <span class="key">DRAG H</span><span>Rotate around axis</span>
        <span class="key">DRAG V</span><span>Ride up / down</span>
        <span class="key">SCROLL</span><span>Zoom (FOV)</span>
        <span class="key">DBL-CLICK</span><span>Spawn note on wall</span>
        <span class="key">N</span><span>New note in front</span>
        <span class="key">R</span><span>Recenter (θ=0, y=0)</span>
        <span class="key">CLICK MAP</span><span>Rotate camera to that angle</span>
        <span class="key">CTRL+K</span><span>Open Overview</span>
        <span class="key">/</span><span>Quick filter</span>
        <span class="key">DEL TAB</span><span>Purge note (right-edge strip)</span>
        <span class="key">CTRL+Z</span><span>Undo last purge</span>
        <span class="key">ESC</span><span>Deselect / close</span>
        <span class="key">DROP</span><span>Drop note on another to stack</span>
        <span class="key">DRAG STACK</span><span>Move whole stack together</span>
        <span class="key">CTRL+DRAG</span><span>Extract single note from stack</span>
        <span class="key">↻ BADGE</span><span>Cycle stack (next on top)</span>
        <span class="key">SLIDER</span><span>Adjust wall radius</span>
      </div>
    </div>

    <div class="m001-search">
      <div class="m001-search-panel">
        <span class="corner tl"></span><span class="corner tr"></span>
        <span class="corner bl"></span><span class="corner br"></span>
        <div class="m001-search-input-wrap">
          <span class="m001-search-prompt">// OVERVIEW</span>
          <input class="m001-search-input" placeholder="filter by title or body…" spellcheck="false" autocomplete="off" />
          <span class="m001-search-count">0</span>
        </div>
        <ul class="m001-search-results"></ul>
        <div class="m001-search-hint">↑↓ navigate · ↵ fly-to · ⨯ purge · ESC close</div>
      </div>
    </div>

    <div class="m001-confirm">
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

    <div class="m001-toast"></div>
  `;
  s.stage.appendChild(host);
  s.host = host;
  s.glLayer = host.querySelector('.m001-gl');
  s.cssLayer = host.querySelector('.m001-css');
  s.actionBar = host.querySelector('.m001-actionbar');
  s.toastEl = host.querySelector('.m001-toast');
  s.legendEl = host.querySelector('.m001-legend');
  s.altitudePip = host.querySelector('.m001-altitude-pip');
  s.altitudeLabel = host.querySelector('.m001-altitude-label');

  s.searchEl = host.querySelector('.m001-search');
  s.searchInput = host.querySelector('.m001-search-input');
  s.searchResults = host.querySelector('.m001-search-results');
  s.searchCount = host.querySelector('.m001-search-count');

  s.confirmEl = host.querySelector('.m001-confirm');
  s.confirmTitle = host.querySelector('.m001-confirm-target');
  s.confirmOk = host.querySelector('[data-confirm="ok"]');
  s.confirmCancel = host.querySelector('[data-confirm="cancel"]');

  s.actionBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'new':      spawnNoteInFront(s); break;
      case 'search':   openSearch(s); break;
      case 'recenter': recenter(s); break;
      case 'undo':     undoLast(s); break;
      case 'legend':   s.legendEl.classList.toggle('is-open'); break;
    }
  });
  s.undoBtn = host.querySelector('[data-act="undo"]');

  // Minimap
  s.minimapEl = host.querySelector('.m001-minimap');
  s.minimapCtx = s.minimapEl.getContext('2d');
  s.minimapEl.addEventListener('click', (e) => {
    const rect = s.minimapEl.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const dx = e.clientX - rect.left - cx;
    const dy = e.clientY - rect.top - cy;
    if (Math.hypot(dx, dy) < 10) return;
    // Camera-up convention: dx = sin(relTheta) * r, dy = -cos(relTheta) * r
    // → relTheta = atan2(dx, -dy). Adding to cameraTheta rotates camera by
    // the relative angle the user clicked toward.
    const relTheta = Math.atan2(dx, -dy);
    s.targetTheta = s.cameraTheta + relTheta;
    saveCamera(s);
  });

  // Radius slider
  s.radiusInput = host.querySelector('.m001-radiusbar-slider');
  s.radiusValueEl = host.querySelector('.m001-radiusbar-value');
  s.radiusInput.addEventListener('input', () => {
    const v = parseInt(s.radiusInput.value, 10) || R_DEFAULT;
    s.targetR = clamp(v, R_MIN, R_MAX);
    s.radiusValueEl.textContent = String(s.targetR);
    try { localStorage.setItem(R_KEY, String(s.targetR)); } catch (_) {}
  });
  // Don't let the slider's drag bubble into camera-pan
  ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'dblclick']
    .forEach((ev) => s.radiusInput.parentElement.addEventListener(ev, (e) => e.stopPropagation()));

  s.confirmOk.addEventListener('click', () => closeConfirm(s, true));
  s.confirmCancel.addEventListener('click', () => closeConfirm(s, false));
  s.confirmEl.addEventListener('click', (e) => {
    if (e.target === s.confirmEl) closeConfirm(s, false);
  });

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
// Three.js scene — cylinder chamber
// =============================================================================
function buildScene(s) {
  const w = s.stage.clientWidth;
  const h = s.stage.clientHeight;

  s.scene = new THREE.Scene();
  s.scene.fog = new THREE.Fog(0x040406, R_DEFAULT * 0.6, R_DEFAULT * 2.4);
  s.cssScene = new THREE.Scene();

  s.camera = new THREE.PerspectiveCamera(FOV_DEFAULT, w / h, 1, 8000);
  s.camera.position.set(0, 0, 0);

  s.glRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  s.glRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  s.glRenderer.setSize(w, h);
  s.glRenderer.setClearColor(0x000000, 0);
  s.glLayer.appendChild(s.glRenderer.domElement);

  s.cssRenderer = new CSS3DRenderer();
  s.cssRenderer.setSize(w, h);
  s.cssLayer.appendChild(s.cssRenderer.domElement);

  // Wall — invisible mesh, kept for raycasting only (radius scaled at runtime)
  const wallGeo = new THREE.CylinderGeometry(1, 1, WALL_HEIGHT, 96, 1, true);
  const wallMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.BackSide,
  });
  s.wall = new THREE.Mesh(wallGeo, wallMat);
  s.wall.scale.set(R_DEFAULT, 1, R_DEFAULT);
  s.scene.add(s.wall);

  // Very faint wireframe ring at top + bottom for "this is the chamber" hint
  const ringGeoTop = new THREE.RingGeometry(0.99, 1, 96);
  const ringMatTop = new THREE.MeshBasicMaterial({
    color: 0xff003c,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
  });
  const ringTop = new THREE.Mesh(ringGeoTop, ringMatTop);
  ringTop.rotation.x = -Math.PI / 2;
  ringTop.position.y = WALL_HEIGHT / 2 - 4;
  ringTop.scale.set(R_DEFAULT, R_DEFAULT, 1);
  s.scene.add(ringTop);
  const ringBot = ringTop.clone();
  ringBot.material = ringMatTop.clone();
  ringBot.position.y = -WALL_HEIGHT / 2 + 4;
  s.scene.add(ringBot);
  s.wallRingTop = ringTop;
  s.wallRingBot = ringBot;
  // Keep s.wallWire reference null — we replaced it
  s.wallWire = null;

  // Floating dust particles inside the chamber
  const particleCount = 320;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i++) {
    const r = Math.sqrt(Math.random()) * (R_DEFAULT * 0.6);
    const a = Math.random() * Math.PI * 2;
    positions[i * 3 + 0] = r * Math.cos(a);
    positions[i * 3 + 1] = (Math.random() - 0.5) * WALL_HEIGHT * 0.7;
    positions[i * 3 + 2] = r * Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const pmat = new THREE.PointsMaterial({
    color: 0xff003c,
    size: 2.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  s.particles = new THREE.Points(geo, pmat);
  s.scene.add(s.particles);

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
  const tmpV = new THREE.Vector3();

  const tick = (now) => {
    const dt = (now - t0) / 1000; t0 = now;

    if (s.particles) s.particles.rotation.y += dt * 0.012;

    // Lerp camera state
    s.cameraTheta += angleDelta(s.cameraTheta, s.targetTheta) * 0.16;
    s.cameraY     += (s.targetY - s.cameraY) * 0.16;
    s.cameraFov   += (s.targetFov - s.cameraFov) * 0.14;
    s.currentR    += (s.targetR - s.currentR) * 0.06;

    // Update wall scale + camera projection
    s.wall.scale.set(s.currentR, 1, s.currentR);
    if (s.wallRingTop) s.wallRingTop.scale.set(s.currentR, s.currentR, 1);
    if (s.wallRingBot) s.wallRingBot.scale.set(s.currentR, s.currentR, 1);
    if (s.scene.fog) {
      s.scene.fog.near = s.currentR * 0.6;
      s.scene.fog.far  = s.currentR * 2.4;
    }
    s.camera.fov = s.cameraFov;
    s.camera.updateProjectionMatrix();

    // Position camera at axis, look along theta direction
    s.camera.position.set(0, s.cameraY, 0);
    tmpV.set(
      Math.cos(s.cameraTheta) * s.currentR,
      s.cameraY,
      Math.sin(s.cameraTheta) * s.currentR
    );
    s.camera.lookAt(tmpV);

    // Re-place every note on the (possibly lerping) wall
    s.notes.forEach((n) => layoutNote(s, n));

    // Background tint based on altitude
    updateBgTint(s);

    s.glRenderer.render(s.scene, s.camera);
    s.cssRenderer.render(s.cssScene, s.camera);
    drawMinimap(s);
    s.rafId = requestAnimationFrame(tick);
  };
  s.rafId = requestAnimationFrame(tick);
}

// Camera-up minimap. The FOV wedge always points UP — the world rotates
// around the player as you turn. A note's screen position on the map matches
// what you actually see in 3D: notes to your right in the chamber are right
// of the wedge on the map.
//
// Conversion: relTheta = noteTheta - cameraTheta. Then plot at
//   x = sin(relTheta) * r,   y = -cos(relTheta) * r
// so relTheta=0 is up, π/2 is right, π is down, -π/2 is left.
//
// Each note's dot is tinted by its altitude (matching the chamber's bg tint
// system) so you can tell at a glance which "floor" a note lives on.
function altitudeColor(y, alphaBoost = 0) {
  const norm = Math.max(-1, Math.min(1, y / 1000));
  if (norm > 0.05) {
    // Warm amber up
    return `rgba(255, 140, 30, ${(0.55 + norm * 0.4 + alphaBoost).toFixed(3)})`;
  } else if (norm < -0.05) {
    // Cool indigo down
    return `rgba(110, 70, 235, ${(0.55 + -norm * 0.4 + alphaBoost).toFixed(3)})`;
  } else {
    // Neutral red at Y=0
    return `rgba(255, 0, 60, ${(0.85 + alphaBoost).toFixed(3)})`;
  }
}

function drawMinimap(s) {
  const ctx = s.minimapCtx;
  if (!ctx) return;
  const W = s.minimapEl.width;
  const H = s.minimapEl.height;
  const cx = W / 2;
  const cy = H / 2;
  const radius = Math.min(W, H) / 2 - 14;

  ctx.clearRect(0, 0, W, H);

  // Wall ring
  ctx.strokeStyle = 'rgba(255, 0, 60, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Cardinal ticks — camera-relative (forward / right / behind / left)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1;
  // Canvas angles: -π/2 = up (forward), 0 = right, π/2 = down (behind), π = left
  const cardinals = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
  cardinals.forEach((a) => {
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (radius - 4), cy + Math.sin(a) * (radius - 4));
    ctx.lineTo(cx + Math.cos(a) * (radius + 4), cy + Math.sin(a) * (radius + 4));
    ctx.stroke();
  });

  // FOV wedge — always points UP (camera-up orientation)
  const halfFov = (s.cameraFov / 2) * Math.PI / 180;
  ctx.fillStyle = 'rgba(255, 170, 0, 0.18)';
  ctx.strokeStyle = 'rgba(255, 170, 0, 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, radius, -Math.PI / 2 - halfFov, -Math.PI / 2 + halfFov);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Notes — plotted at angle relative to camera (so the world rotates as you turn)
  s.notes.forEach((n) => {
    const relTheta = (n.row.pos_x || 0) - s.cameraTheta;
    const x = cx + Math.sin(relTheta) * radius;
    const y = cy - Math.cos(relTheta) * radius;
    const isSelected = n.row.id === s.selectedId;
    const isStacked = !!n.row.stack_id && n.stackOrder === 0;
    const r = isSelected ? 5 : (isStacked ? 3.8 : 3);
    const fill = altitudeColor(n.row.pos_y || 0, isSelected ? 0.15 : 0);
    ctx.fillStyle = fill;
    ctx.shadowBlur = isSelected ? 10 : 4;
    ctx.shadowColor = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (isSelected) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  });

  // Camera position dot at center
  ctx.fillStyle = '#ffaa00';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();

  // Tiny altitude legend on the right edge of the map
  drawAltitudeLegend(ctx, W, H, s.cameraY);
}

// Vertical altitude scale on the right side of the minimap so the user knows
// which color = which Y, plus a pip showing where the camera currently is.
function drawAltitudeLegend(ctx, W, H, cameraY) {
  const x0 = W - 8;
  const yTop = 16;
  const yBot = H - 16;
  const len = yBot - yTop;
  // Gradient strip
  const grad = ctx.createLinearGradient(0, yTop, 0, yBot);
  grad.addColorStop(0,    'rgba(255, 140, 30, 0.85)');
  grad.addColorStop(0.5,  'rgba(255, 0, 60, 0.85)');
  grad.addColorStop(1,    'rgba(110, 70, 235, 0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(x0 - 1.5, yTop, 3, len);

  // Pip at current cameraY
  const norm = Math.max(-1, Math.min(1, cameraY / 1000));
  const py = yTop + (1 - (norm + 1) / 2) * len; // -1=top of strip, +1=bottom… invert because warm = up
  ctx.fillStyle = '#fff';
  ctx.fillRect(x0 - 4, py - 0.5, 8, 1.5);
}

// Shortest signed delta from a → b on a circle
function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d >  Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function wrapTheta(t) {
  return ((t + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

function layoutNote(s, n) {
  const baseTheta = n.row.pos_x || 0;
  const baseY = n.row.pos_y || 0;
  // While being dragged, the note tracks the cursor 1:1 — ignore stack offset
  const draggingSelf = s.drag && s.drag.kind === 'note' && s.drag.id === n.row.id;
  const order = draggingSelf ? 0 : (n.stackOrder || 0);
  // Stacked notes peek behind the anchor: slight tangent fan + drop + recede into wall
  const theta = baseTheta + order * 0.0055;
  const y = baseY - order * 7;
  const r = s.currentR + order * 3;
  n.css3d.position.set(r * Math.cos(theta), y, r * Math.sin(theta));
  // All stack members face same direction as the anchor
  n.css3d.rotation.set(0, -baseTheta - Math.PI / 2, 0);
}

// =============================================================================
// Stacks
// =============================================================================
function recomputeStacks(s) {
  const groups = new Map();
  s.notes.forEach((n) => {
    n.stackOrder = 0; n.stackSize = 1;
    const sid = n.row.stack_id;
    if (!sid) return;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(n);
  });
  groups.forEach((arr) => {
    if (arr.length < 2) {
      // Stack of 1 — dissolve
      arr.forEach((n) => {
        if (n.row.stack_id) {
          n.row.stack_id = null;
          n.row.stack_order = 0;
          scheduleSave(s, n, ['stack_id', 'stack_order']);
        }
      });
      return;
    }
    arr.sort((a, b) => (a.row.stack_order || 0) - (b.row.stack_order || 0));
    arr.forEach((n, i) => { n.stackOrder = i; n.stackSize = arr.length; });
  });
  s.notes.forEach((n) => updateStackBadge(s, n));
}

function updateStackBadge(s, n) {
  let badge = n.el.querySelector('.m001-stack-badge');
  const isAnchor = n.stackOrder === 0 && n.stackSize > 1;
  if (isAnchor) {
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'm001-stack-badge';
      badge.title = 'Cycle stack — bring next to top';
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        cycleStack(s, n);
      });
      n.el.appendChild(badge);
    }
    badge.innerHTML = `<span class="m001-stack-count">×${n.stackSize}</span><span class="m001-stack-arrow">↻</span>`;
    badge.hidden = false;
  } else if (badge) {
    badge.hidden = true;
  }
  n.el.classList.toggle('is-stacked', !!n.row.stack_id);
  n.el.classList.toggle('is-stack-anchor', isAnchor);
}

// Find nearest other note within snap range, ignoring the dragged one.
function findSnapTarget(s, draggedId) {
  const me = s.notes.get(draggedId);
  if (!me) return null;
  const myT = me.row.pos_x || 0;
  const myY = me.row.pos_y || 0;
  let best = null, bestScore = Infinity;
  s.notes.forEach((other) => {
    if (other.row.id === draggedId) return;
    // If other is in a stack but isn't the anchor, target the anchor instead
    if (other.row.stack_id && other.stackOrder !== 0) return;
    const dT = Math.abs(angleDelta(other.row.pos_x || 0, myT));
    const dY = Math.abs((other.row.pos_y || 0) - myY);
    if (dT > 0.18 || dY > 110) return;
    const score = dT * 250 + dY;
    if (score < bestScore) { bestScore = score; best = other; }
  });
  return best;
}

async function joinStack(s, draggedNote, targetNote) {
  // Either target already has a stack, or we create a new one with both
  let stackId = targetNote.row.stack_id;
  if (!stackId) {
    stackId = (crypto.randomUUID && crypto.randomUUID()) ||
              ('stk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    targetNote.row.stack_id = stackId;
    targetNote.row.stack_order = 0;
    scheduleSave(s, targetNote, ['stack_id', 'stack_order']);
  }
  // Find next stack_order
  let maxOrder = -1;
  s.notes.forEach((n) => {
    if (n.row.stack_id === stackId) maxOrder = Math.max(maxOrder, n.row.stack_order || 0);
  });
  // Snap dragged to anchor's position
  draggedNote.row.pos_x = targetNote.row.pos_x;
  draggedNote.row.pos_y = targetNote.row.pos_y;
  draggedNote.row.stack_id = stackId;
  draggedNote.row.stack_order = maxOrder + 1;
  scheduleSave(s, draggedNote, ['pos_x', 'pos_y', 'stack_id', 'stack_order']);
  recomputeStacks(s);
  toast(s, '// STACKED');
}

function leaveStack(s, note) {
  note.row.stack_id = null;
  note.row.stack_order = 0;
  scheduleSave(s, note, ['stack_id', 'stack_order']);
  recomputeStacks(s);
  toast(s, '// UNSTACKED');
}

// Rotate stack: anchor goes to bottom, second-from-top becomes new anchor
function cycleStack(s, anchorNote) {
  const stackId = anchorNote.row.stack_id;
  if (!stackId) return;
  const members = Array.from(s.notes.values())
    .filter((n) => n.row.stack_id === stackId)
    .sort((a, b) => (a.row.stack_order || 0) - (b.row.stack_order || 0));
  if (members.length < 2) return;
  // Shift orders: top → bottom, others → up by 1
  const top = members[0];
  for (let i = 1; i < members.length; i++) {
    members[i].row.stack_order = i - 1;
    scheduleSave(s, members[i], ['stack_order']);
  }
  top.row.stack_order = members.length - 1;
  scheduleSave(s, top, ['stack_order']);
  recomputeStacks(s);
}

// Bring a specific note to the top of its stack (used by search fly-to)
function bringToTop(s, note) {
  if (!note.row.stack_id || note.stackOrder === 0) return;
  const stackId = note.row.stack_id;
  const members = Array.from(s.notes.values())
    .filter((n) => n.row.stack_id === stackId)
    .sort((a, b) => (a.row.stack_order || 0) - (b.row.stack_order || 0));
  // Place `note` first, others follow in their existing relative order
  const reordered = [note, ...members.filter((n) => n.row.id !== note.row.id)];
  reordered.forEach((n, i) => {
    if (n.row.stack_order !== i) {
      n.row.stack_order = i;
      scheduleSave(s, n, ['stack_order']);
    }
  });
  recomputeStacks(s);
}

function clearSnapHint(s) {
  s.notes.forEach((n) => n.el.classList.remove('is-snap-target'));
}
function showSnapHint(s, target) {
  clearSnapHint(s);
  if (target) target.el.classList.add('is-snap-target');
}

function updateBgTint(s) {
  // Tint the polygon background through a soft radial overlay. Y near 0 is
  // neutral (zero alpha), high → warm amber, low → cool violet/blue.
  const norm = Math.max(-1, Math.min(1, s.cameraY / 1000));
  let r, g, b, a;
  if (norm > 0) {
    // Warm amber up
    r = 255; g = 140; b = 30;
    a = norm * 0.234;
  } else if (norm < 0) {
    // Cool indigo/violet down
    r = 80; g = 40; b = 220;
    a = -norm * 0.234;
  } else {
    r = g = b = 0; a = 0;
  }
  s.host.style.setProperty('--m001-tint-r', r);
  s.host.style.setProperty('--m001-tint-g', g);
  s.host.style.setProperty('--m001-tint-b', b);
  s.host.style.setProperty('--m001-tint-a', a.toFixed(3));

  if (s.altitudePip) {
    const pct = 50 + Math.max(-1, Math.min(1, s.cameraY / 1000)) * 50;
    s.altitudePip.style.bottom = pct + '%';
  }
  if (s.altitudeLabel) {
    const v = Math.round(s.cameraY);
    s.altitudeLabel.textContent = `Y${v >= 0 ? '+' : ''}${v}`;
  }
}

// =============================================================================
// Camera persistence (cylindrical)
// =============================================================================
function loadCamera(s) {
  try {
    const raw = localStorage.getItem(CAM_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.theta === 'number') s.cameraTheta = s.targetTheta = p.theta;
      if (typeof p.y     === 'number') s.cameraY     = s.targetY     = p.y;
      if (typeof p.fov   === 'number') s.cameraFov   = s.targetFov   = clamp(p.fov, FOV_MIN, FOV_MAX);
    }
    const rRaw = localStorage.getItem(R_KEY);
    if (rRaw) {
      const r = clamp(parseInt(rRaw, 10) || R_DEFAULT, R_MIN, R_MAX);
      s.currentR = s.targetR = r;
      if (s.radiusInput) s.radiusInput.value = String(r);
      if (s.radiusValueEl) s.radiusValueEl.textContent = String(r);
    }
  } catch (_) {}
}
function saveCamera(s) {
  if (s.cameraSaveTimer) clearTimeout(s.cameraSaveTimer);
  s.cameraSaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(CAM_KEY, JSON.stringify({
        theta: s.targetTheta,
        y:     s.targetY,
        fov:   s.targetFov,
      }));
    } catch (_) {}
  }, 400);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// =============================================================================
// Input — drag rotates / rides, scroll zooms
// =============================================================================
// Mathematical ray-vs-cylinder intersection. Camera sits on the y-axis, so the
// ray equation simplifies cleanly. Returns world-cylinder coords {theta, y}
// that always match the cursor exactly — no sign confusion possible.
function projectToWall(s, ndcX, ndcY) {
  const v = new THREE.Vector3(ndcX, ndcY, 0.5);
  v.unproject(s.camera);
  const dir = v.sub(s.camera.position).normalize();
  const denom2 = dir.x * dir.x + dir.z * dir.z;
  if (denom2 < 1e-8) return null;
  const t = s.currentR / Math.sqrt(denom2);
  if (t < 0) return null;
  const px = dir.x * t;
  const pz = dir.z * t;
  const py = s.camera.position.y + dir.y * t;
  return {
    theta: wrapTheta(Math.atan2(pz, px)),
    y: clamp(py, -1100, 1100),
  };
}

function bindInput(s) {
  const stage = s.host;

  function ndc(e) {
    const rect = s.host.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.m001-note, .m001-actionbar, .m001-search, .m001-confirm, .m001-legend, .m001-radiusbar')) return;
    s.drag = {
      kind: 'camera',
      startX: e.clientX,
      startY: e.clientY,
      origTheta: s.targetTheta,
      origY: s.targetY,
    };
    stage.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!s.drag) return;
    const fovScale = s.cameraFov / FOV_DEFAULT;

    if (s.drag.kind === 'camera') {
      const dx = e.clientX - s.drag.startX;
      const dy = e.clientY - s.drag.startY;
      // Drag right (dx>0) → world slides right → camera looks left → theta decreases
      s.targetTheta = s.drag.origTheta - dx * 0.0022 * fovScale;
      // Drag down (dy>0) → world slides down → camera moves up
      s.targetY = clamp(s.drag.origY + dy * 1.1 * fovScale, -1500, 1500);
    } else if (s.drag.kind === 'note') {
      const note = s.notes.get(s.drag.id);
      if (!note) return;
      const { x, y } = ndc(e);
      const p = projectToWall(s, x, y);
      if (p) {
        const newTheta = wrapTheta(p.theta + s.drag.offsetTheta);
        const newY = clamp(p.y + s.drag.offsetY, -1100, 1100);
        note.row.pos_x = newTheta;
        note.row.pos_y = newY;
        // Drag the whole stack together (default). Ctrl/Cmd extracts this one.
        if (note.row.stack_id && !s.drag.extractFromStack) {
          s.notes.forEach((n) => {
            if (n.row.id !== note.row.id && n.row.stack_id === note.row.stack_id) {
              n.row.pos_x = newTheta;
              n.row.pos_y = newY;
            }
          });
        }
      }
      // Snap-target hints only matter when we're moving a single note —
      // dragging a whole stack onto another note shouldn't merge stacks.
      const wholeStack = note.row.stack_id && !s.drag.extractFromStack;
      const target = wholeStack ? null : findSnapTarget(s, s.drag.id);
      showSnapHint(s, target);
    }
  };
  const onPointerUp = (e) => {
    if (!s.drag) return;
    if (s.drag.kind === 'note') {
      const note = s.notes.get(s.drag.id);
      clearSnapHint(s);
      if (note) handleNoteDrop(s, note);
    } else if (s.drag.kind === 'camera') {
      saveCamera(s);
    }
    s.drag = null;
    stage.releasePointerCapture?.(e.pointerId);
  };

  function handleNoteDrop(s, note) {
    // Whole-stack drag (no Ctrl) → just persist new pos for every member.
    if (note.row.stack_id && !s.drag?.extractFromStack) {
      s.notes.forEach((n) => {
        if (n.row.stack_id === note.row.stack_id) {
          scheduleSave(s, n, ['pos_x', 'pos_y']);
        }
      });
      return;
    }
    const target = findSnapTarget(s, note.row.id);
    if (target) {
      // Don't re-stack if already in target's stack
      if (note.row.stack_id && note.row.stack_id === target.row.stack_id) {
        scheduleSave(s, note, ['pos_x', 'pos_y']);
        return;
      }
      joinStack(s, note, target);
      return;
    }
    // No snap target. If we're in a stack, check whether we've moved away enough to leave.
    if (note.row.stack_id) {
      const stackId = note.row.stack_id;
      const others = Array.from(s.notes.values())
        .filter((n) => n.row.stack_id === stackId && n.row.id !== note.row.id);
      if (others.length === 0) {
        leaveStack(s, note);
        return;
      }
      // Anchor of the stack (excluding us)
      others.sort((a, b) => (a.row.stack_order || 0) - (b.row.stack_order || 0));
      const anchor = others[0];
      const dT = Math.abs(angleDelta(anchor.row.pos_x || 0, note.row.pos_x || 0));
      const dY = Math.abs((anchor.row.pos_y || 0) - (note.row.pos_y || 0));
      if (dT > 0.35 || dY > 220) {
        leaveStack(s, note);
        return;
      }
      // Stayed near the stack — re-snap to anchor exactly so it stays grouped
      note.row.pos_x = anchor.row.pos_x;
      note.row.pos_y = anchor.row.pos_y;
      scheduleSave(s, note, ['pos_x', 'pos_y']);
      return;
    }
    // Plain solo note move
    scheduleSave(s, note, ['pos_x', 'pos_y']);
  }
  stage.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  s.cleanups.push(() => stage.removeEventListener('pointerdown', onPointerDown));
  s.cleanups.push(() => window.removeEventListener('pointermove', onPointerMove));
  s.cleanups.push(() => window.removeEventListener('pointerup', onPointerUp));

  const onWheel = (e) => {
    if (e.target.closest('.m001-note .m001-note-body, .m001-note .m001-note-title, .m001-search')) return;
    e.preventDefault();
    const delta = e.deltaY * 0.045;
    s.targetFov = clamp(s.targetFov + delta, FOV_MIN, FOV_MAX);
    saveCamera(s);
  };
  stage.addEventListener('wheel', onWheel, { passive: false });
  s.cleanups.push(() => stage.removeEventListener('wheel', onWheel));

  const onDblClick = (e) => {
    if (e.target.closest('.m001-note, .m001-actionbar, .m001-search, .m001-confirm, .m001-legend, .m001-radiusbar, .m001-minimap-wrap')) return;
    const { x, y } = ndc(e);
    const p = projectToWall(s, x, y);
    if (!p) return;
    spawnNote(s, { pos_x: p.theta, pos_y: p.y, pos_z: 0 });
  };
  stage.addEventListener('dblclick', onDblClick);
  s.cleanups.push(() => stage.removeEventListener('dblclick', onDblClick));
}

function recenter(s) {
  s.targetTheta = 0;
  s.targetY = 0;
  s.targetFov = FOV_DEFAULT;
  saveCamera(s);
}

function flyTo(s, theta, y) {
  // Take the shortest angular path
  s.targetTheta = s.cameraTheta + angleDelta(s.cameraTheta, theta);
  s.targetY = clamp(y, -1500, 1500);
  s.targetFov = FOV_DEFAULT;
  saveCamera(s);
}

// =============================================================================
// Search overlay
// =============================================================================
function openSearch(s) {
  s.searchEl.classList.add('is-open');
  s.searchOpen = true;
  s.searchInput.value = '';
  runSearch(s);
  setTimeout(() => s.searchInput.focus(), 60);
}
function closeSearch(s) {
  s.searchEl.classList.remove('is-open');
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
        return { n, score: ti >= 0 ? 100 - ti : 50 - bi };
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
      <button type="button" class="m001-hit-del" title="Purge note" aria-label="Purge note">DEL</button>
    `;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.m001-hit-del')) return;
      s.searchActiveIdx = i;
      commitSearch(s);
    });
    li.querySelector('.m001-hit-del').addEventListener('click', (e) => {
      e.stopPropagation();
      requestDelete(s, n.row.id);
      // Drop from current view immediately, refresh list
      s.searchHits = s.searchHits.filter((x) => x.row.id !== n.row.id);
      s.searchActiveIdx = Math.min(s.searchActiveIdx, Math.max(0, s.searchHits.length - 1));
      renderSearchResults(s, q);
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
  const li = s.searchResults.children[s.searchActiveIdx];
  if (li) li.scrollIntoView({ block: 'nearest' });
}
function commitSearch(s) {
  const note = s.searchHits[s.searchActiveIdx];
  if (!note) return;
  closeSearch(s);
  // If buried in a stack, surface it first
  if (note.row.stack_id && note.stackOrder !== 0) bringToTop(s, note);
  flyTo(s, note.row.pos_x || 0, note.row.pos_y || 0);
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
    </div>
    <textarea class="m001-note-body" placeholder="// your thoughts go here…" spellcheck="false"></textarea>
    <div class="m001-note-foot">
      <div class="m001-note-colors">
        ${COLORS.map((c) => `<button type="button" class="m001-swatch" data-color="${c.id}" style="background:${c.hex}; box-shadow: 0 0 6px ${c.glow}" title="${c.id.toUpperCase()}"></button>`).join('')}
      </div>
      <span class="m001-note-saved">SYNCED</span>
    </div>
    <button type="button" class="m001-note-purge" title="Purge note (Del)" aria-label="Purge note">
      <span class="m001-note-purge-text">DEL</span>
    </button>
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
  // Wrap legacy pos_x values into [-π, π] so old pixel coords don't wrap the cylinder
  if (typeof row.pos_x === 'number' && Math.abs(row.pos_x) > Math.PI * 2) {
    row.pos_x = wrapTheta(row.pos_x);
  } else {
    row.pos_x = wrapTheta(row.pos_x || 0);
  }

  const el = makeNoteEl();
  const titleEl = el.querySelector('.m001-note-title');
  const bodyEl = el.querySelector('.m001-note-body');
  const savedEl = el.querySelector('.m001-note-saved');
  const headEl = el.querySelector('.m001-note-head');
  const purgeBtn = el.querySelector('.m001-note-purge');

  titleEl.value = row.title || '';
  bodyEl.value = row.body || '';

  const css3d = new CSS3DObject(el);
  s.cssScene.add(css3d);

  const note = { row, el, css3d, els: { titleEl, bodyEl, savedEl, headEl, purgeBtn }, dirty: new Set(), saveTimer: null };
  s.notes.set(row.id, note);
  applyNoteColor(note);
  layoutNote(s, note);

  el.addEventListener('pointerdown', () => selectNote(s, row.id));

  headEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.m001-note-title, .m001-note-purge')) return;
    e.stopPropagation();
    // Offset between cursor's wall-projection and note position so the
    // grabbed point stays under the cursor (no jump on first frame).
    const rect = s.host.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const p = projectToWall(s, ndcX, ndcY);
    s.drag = {
      kind: 'note',
      id: row.id,
      offsetTheta: p ? angleDelta(p.theta, row.pos_x || 0) : 0,
      offsetY:     p ? (row.pos_y || 0) - p.y : 0,
      origTheta: row.pos_x || 0,
      origY: row.pos_y || 0,
      // Hold Ctrl/Cmd while grabbing → extract this note from its stack.
      // Default behavior (no modifier) drags the whole stack as a group.
      extractFromStack: e.ctrlKey || e.metaKey,
    };
    s.host.setPointerCapture?.(e.pointerId);
  });

  titleEl.addEventListener('input', () => { row.title = titleEl.value; markDirty(s, note, 'title'); });
  bodyEl.addEventListener('input', () => { row.body = bodyEl.value; markDirty(s, note, 'body'); });
  titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); bodyEl.focus(); } });
  purgeBtn.addEventListener('click', (e) => { e.stopPropagation(); requestDelete(s, row.id); });
  purgeBtn.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't initiate note drag

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
    pos_x: typeof opts.pos_x === 'number' ? wrapTheta(opts.pos_x) : wrapTheta(s.targetTheta),
    pos_y: typeof opts.pos_y === 'number' ? opts.pos_y : s.targetY,
    pos_z: opts.pos_z ?? 0,
    color: '#ff003c',
  };
  const { data, error } = await s.sb.from('notes').insert(payload).select().single();
  if (error) { toast(s, 'INSERT_FAIL · ' + error.message); return; }
  const note = attachNote(s, data);
  selectNote(s, data.id);
  recomputeStacks(s);
  flyTo(s, data.pos_x || 0, data.pos_y || 0);
  setTimeout(() => note.els.bodyEl.focus(), 50);
}

function spawnNoteInFront(s) {
  // Slightly offset from the exact center so multiple "N" presses don't stack identically
  const jitter = (Math.random() - 0.5) * 0.08;
  spawnNote(s, {
    pos_x: s.targetTheta + jitter,
    pos_y: s.targetY + (Math.random() - 0.5) * 30,
    pos_z: 0,
  });
}

// (R is now manually controlled by the slider; bumpR removed.)

// Direct delete — no confirmation. Pushes to undoStack so the last
// UNDO_LIMIT deletions can be restored.
async function requestDelete(s, id) {
  const note = s.notes.get(id);
  if (!note) return;
  // Snapshot row so we can restore it later (deep clone — primitives only)
  const snapshot = JSON.parse(JSON.stringify(note.row));
  s.undoStack.push(snapshot);
  while (s.undoStack.length > UNDO_LIMIT) s.undoStack.shift();
  updateUndoButton(s);
  // Optimistic remove
  s.cssScene.remove(note.css3d);
  note.el.remove();
  s.notes.delete(id);
  if (s.selectedId === id) s.selectedId = null;
  recomputeStacks(s);
  toast(s, `// PURGED · ↶ to restore (${s.undoStack.length}/${UNDO_LIMIT})`);
  const { error } = await s.sb.from('notes').delete().eq('id', id);
  if (error) {
    console.error('[notes] delete failed', error);
    toast(s, 'DELETE_FAIL · ' + error.message);
  }
}

// Stub kept for any leftover callers
function closeConfirm(s, ok) {
  if (s.confirmEl) s.confirmEl.classList.remove('is-open');
  if (s.confirmResolve) { s.confirmResolve(ok); s.confirmResolve = null; }
}

function updateUndoButton(s) {
  if (!s.undoBtn) return;
  s.undoBtn.hidden = s.undoStack.length === 0;
  const countEl = s.undoBtn.querySelector('.m001-undo-count');
  if (countEl) countEl.textContent = String(s.undoStack.length);
}

async function undoLast(s) {
  if (s.undoStack.length === 0) return;
  const row = s.undoStack.pop();
  updateUndoButton(s);
  // Re-insert with same id so any external references stay stable
  const payload = {
    id: row.id,
    module_code: row.module_code || MODULE_CODE,
    title: row.title || '',
    body: row.body || '',
    pos_x: row.pos_x || 0,
    pos_y: row.pos_y || 0,
    pos_z: row.pos_z || 0,
    color: row.color || '#ff003c',
    stack_id: row.stack_id || null,
    stack_order: row.stack_order || 0,
  };
  const { data, error } = await s.sb.from('notes').insert(payload).select().single();
  if (error) {
    toast(s, 'RESTORE_FAIL · ' + error.message);
    // Push back so user can try again
    s.undoStack.push(row);
    updateUndoButton(s);
    return;
  }
  attachNote(s, data);
  recomputeStacks(s);
  selectNote(s, data.id);
  flyTo(s, data.pos_x || 0, data.pos_y || 0);
  if (s.searchOpen) runSearch(s);
  toast(s, '// RESTORED');
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
      body: '// OBSIDIAN_DECK · v0.3 · CHAMBER\n\nYou are at the center of a closed cylinder.\nDrag horizontally to rotate, vertically to ride up/down.\nScroll to zoom (FOV). Double-click the wall to spawn a note there.\n\nN = new note in front · M = map · Ctrl+K = search.\nThe wall stretches as you add more notes.',
      pos_x: 0, pos_y: 0, pos_z: 0,
      color: '#ff003c',
    }).select().single();
    if (welcome.data) attachNote(s, welcome.data);
    recomputeStacks(s);
    return;
  }
  data.forEach((row) => attachNote(s, row));
  recomputeStacks(s);
}

function toast(s, msg) {
  if (!s.toastEl) return;
  s.toastEl.textContent = msg;
  s.toastEl.classList.add('is-open');
  clearTimeout(s.toastTimer);
  s.toastTimer = setTimeout(() => { s.toastEl.classList.remove('is-open'); }, 2400);
}

// =============================================================================
// Keyboard shortcuts
// =============================================================================
function bindKeyboard(s) {
  const inEditable = (el) => {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  };

  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (s.searchOpen) closeSearch(s); else openSearch(s);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      // Allow native undo inside text fields
      if (inEditable(document.activeElement)) return;
      e.preventDefault();
      undoLast(s);
      return;
    }
    if (e.key === 'Escape') {
      if (s.searchOpen) { e.preventDefault(); closeSearch(s); return; }
      if (s.confirmEl.classList.contains('is-open')) { e.preventDefault(); closeConfirm(s, false); return; }
      if (inEditable(document.activeElement)) { e.preventDefault(); document.activeElement.blur(); return; }
      if (s.selectedId) { e.preventDefault(); deselect(s); return; }
      return;
    }
    if (inEditable(document.activeElement)) return;

    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); spawnNoteInFront(s); return; }
    if (e.key === 'r' || e.key === 'R') { e.preventDefault(); recenter(s); return; }
    if (e.key === '/')                  { e.preventDefault(); openSearch(s); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.selectedId) { e.preventDefault(); requestDelete(s, s.selectedId); }
      return;
    }
    const STEP_THETA = 0.18;
    const STEP_Y = 100;
    if (e.key === 'ArrowLeft')  { s.targetTheta -= STEP_THETA; saveCamera(s); }
    if (e.key === 'ArrowRight') { s.targetTheta += STEP_THETA; saveCamera(s); }
    if (e.key === 'ArrowUp')    { s.targetY = clamp(s.targetY + STEP_Y, -1500, 1500); saveCamera(s); }
    if (e.key === 'ArrowDown')  { s.targetY = clamp(s.targetY - STEP_Y, -1500, 1500); saveCamera(s); }
  };

  window.addEventListener('keydown', onKey);
  s.cleanups.push(() => window.removeEventListener('keydown', onKey));
}

// =============================================================================
// Styles
// =============================================================================
const MOD001_CSS = `
.m001-host {
  --m001-tint-r: 0; --m001-tint-g: 0; --m001-tint-b: 0; --m001-tint-a: 0;
  position: absolute;
  inset: 0;
  background: transparent;
  overflow: hidden;
  font-family: 'Share Tech Mono', monospace;
  color: #e8e8e8;
  user-select: none;
  cursor: grab;
}
.m001-host:active { cursor: grabbing; }
.m001-tint {
  position: absolute; inset: 0; z-index: 0; pointer-events: none;
  background: radial-gradient(ellipse at center,
    rgba(var(--m001-tint-r), var(--m001-tint-g), var(--m001-tint-b), var(--m001-tint-a)) 0%,
    transparent 70%);
  transition: background 0.5s linear;
}
.m001-gl, .m001-css { position: absolute; inset: 0; }
.m001-gl { z-index: 1; }
.m001-css { z-index: 2; pointer-events: none; }
.m001-css > div { pointer-events: auto; }
.m001-vignette {
  position: absolute; inset: 0; z-index: 3; pointer-events: none;
  background:
    radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.55) 100%);
}
.m001-scanlines {
  position: absolute; inset: 0; z-index: 4; pointer-events: none;
  background: repeating-linear-gradient(
    0deg, transparent 0, transparent 3px, rgba(255,0,60,0.018) 3px, rgba(255,0,60,0.018) 4px
  );
  mix-blend-mode: screen;
}

/* Altitude indicator on the right */
.m001-altitude {
  position: absolute;
  right: 1.2rem;
  top: 50%;
  transform: translateY(-50%);
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  pointer-events: none;
}
.m001-altitude-track {
  position: relative;
  width: 2px;
  height: 180px;
  background: linear-gradient(
    180deg,
    rgba(255,174,0,0.45) 0%,
    rgba(255,0,60,0.35) 50%,
    rgba(0,212,255,0.45) 100%
  );
  box-shadow: 0 0 8px rgba(255,0,60,0.25);
}
.m001-altitude-pip {
  position: absolute;
  left: -3px;
  width: 8px; height: 2px;
  background: #fff;
  box-shadow: 0 0 6px rgba(255,255,255,0.7);
  bottom: 50%;
  transition: bottom 0.16s linear;
}
.m001-altitude-label {
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  color: rgba(255,255,255,0.5);
  text-transform: uppercase;
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
  transform: translateX(-50%) translateY(8px);
  z-index: 5;
  padding: 0.9rem 1rem;
  border: 1px solid rgba(255,0,60,0.35);
  background: rgba(8,2,4,0.92);
  backdrop-filter: blur(8px);
  font-size: 0.75rem;
  color: rgba(255,255,255,0.7);
  letter-spacing: 0.08em;
  min-width: 380px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.m001-legend.is-open {
  opacity: 1;
  pointer-events: auto;
  transform: translateX(-50%) translateY(0);
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

/* Minimap */
.m001-minimap-wrap {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  z-index: 5;
  width: 170px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 0.5rem;
  border: 1px solid rgba(255, 0, 60, 0.35);
  background: rgba(8, 2, 4, 0.7);
  backdrop-filter: blur(6px);
  box-shadow: 0 0 14px rgba(255, 0, 60, 0.18);
}
.m001-minimap {
  display: block;
  width: 170px;
  height: 170px;
  cursor: crosshair;
}
.m001-minimap-label {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.62rem;
  letter-spacing: 0.18em;
  color: rgba(255, 0, 60, 0.7);
  text-transform: uppercase;
}

/* Radius slider */
.m001-radiusbar {
  position: absolute;
  top: 1.1rem; left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid rgba(255,0,60,0.25);
  background: rgba(8,2,4,0.7);
  backdrop-filter: blur(6px);
  font-family: 'Share Tech Mono', monospace;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  color: rgba(255,255,255,0.6);
  text-transform: uppercase;
}
.m001-radiusbar-label { color: #ff003c; font-family: 'Orbitron', sans-serif; letter-spacing: 0.18em; }
.m001-radiusbar-value { color: #fff; min-width: 3.2em; text-align: right; }
.m001-radiusbar-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 200px;
  height: 4px;
  background: linear-gradient(90deg, rgba(255,0,60,0.5), rgba(255,0,60,0.18));
  outline: none;
  cursor: pointer;
}
.m001-radiusbar-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px; height: 16px;
  background: #ff003c;
  border: 1px solid #ffaa00;
  cursor: grab;
  box-shadow: 0 0 10px rgba(255,0,60,0.7);
}
.m001-radiusbar-slider::-moz-range-thumb {
  width: 12px; height: 16px;
  background: #ff003c;
  border: 1px solid #ffaa00;
  cursor: grab;
  box-shadow: 0 0 10px rgba(255,0,60,0.7);
}

/* Undo button count badge */
.m001-action [hidden] { display: none !important; }
.m001-action em.m001-undo-count {
  font-style: normal;
  margin-left: 0.4rem;
  font-size: 0.7rem;
  opacity: 0.7;
}

/* Toast */
.m001-toast {
  position: absolute;
  top: 1.2rem; left: 50%;
  transform: translateX(-50%) translateY(-12px);
  z-index: 6;
  padding: 0.6rem 1rem;
  border: 1px solid #ff003c;
  background: rgba(40,0,8,0.92);
  color: #ff003c;
  font-size: 0.8rem;
  letter-spacing: 0.12em;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1);
}
.m001-toast.is-open {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* Overview overlay (formerly search) */
.m001-search {
  position: absolute;
  inset: 0;
  z-index: 7;
  background: rgba(0,0,0,0);
  backdrop-filter: blur(0px);
  -webkit-backdrop-filter: blur(0px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease, background 0.22s ease, backdrop-filter 0.22s ease;
}
.m001-search.is-open {
  opacity: 1;
  pointer-events: auto;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
.m001-search-panel {
  position: relative;
  width: min(640px, 90vw);
  background: linear-gradient(160deg, rgba(15,4,8,0.95), rgba(5,0,3,0.98));
  border: 1px solid rgba(255,0,60,0.5);
  box-shadow: 0 30px 80px rgba(0,0,0,0.8), 0 0 60px rgba(255,0,60,0.25);
  opacity: 0;
  transform: translateY(-14px) scale(0.96);
  transition: opacity 0.26s ease 0.04s, transform 0.26s cubic-bezier(0.2, 0.8, 0.3, 1) 0.04s;
}
.m001-search.is-open .m001-search-panel {
  opacity: 1;
  transform: translateY(0) scale(1);
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
.m001-hit:hover, .m001-hit.active { background: rgba(255,0,60,0.1); }
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
.m001-hit mark { background: rgba(255,0,60,0.3); color: #fff; padding: 0 1px; }
.m001-hit-preview .dim { color: rgba(255,255,255,0.3); font-style: italic; }
.m001-hit-del {
  flex: 0 0 auto;
  align-self: center;
  font-family: 'Orbitron', sans-serif;
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  padding: 0.35rem 0.7rem;
  background: transparent;
  color: rgba(255,255,255,0.4);
  border: 1px solid rgba(255,0,60,0.35);
  cursor: pointer;
  transition: all 0.15s;
  text-transform: uppercase;
}
.m001-hit-del:hover {
  background: #ff003c;
  color: #000;
  letter-spacing: 0.24em;
  box-shadow: 0 0 14px rgba(255,0,60,0.5);
}
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
  background: rgba(0,0,0,0);
  backdrop-filter: blur(0px);
  -webkit-backdrop-filter: blur(0px);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.22s ease, background 0.22s ease, backdrop-filter 0.22s ease;
}
.m001-confirm.is-open {
  opacity: 1;
  pointer-events: auto;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}
.m001-confirm-panel {
  position: relative;
  width: min(420px, 90vw);
  padding: 1.2rem 1.4rem 1.4rem;
  background: linear-gradient(135deg, rgba(40,0,8,0.95), rgba(8,0,3,0.98));
  border: 1px solid #ff003c;
  box-shadow: 0 30px 80px rgba(0,0,0,0.85), 0 0 50px rgba(255,0,60,0.45);
  opacity: 0;
  transform: translateY(-14px) scale(0.96);
  transition: opacity 0.26s ease 0.04s, transform 0.26s cubic-bezier(0.2, 0.8, 0.3, 1) 0.04s;
}
.m001-confirm.is-open .m001-confirm-panel {
  opacity: 1;
  transform: translateY(0) scale(1);
}
.m001-confirm-panel .corner { position: absolute; width: 14px; height: 14px; border: 0; }
.m001-confirm-panel .corner.tl { top: -1px; left: -1px; border-top: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-confirm-panel .corner.tr { top: -1px; right: -1px; border-top: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-confirm-panel .corner.bl { bottom: -1px; left: -1px; border-bottom: 1px solid #ff003c; border-left: 1px solid #ff003c; }
.m001-confirm-panel .corner.br { bottom: -1px; right: -1px; border-bottom: 1px solid #ff003c; border-right: 1px solid #ff003c; }
.m001-confirm-head { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.7rem; }
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
.m001-confirm-msg { margin: 0 0 1.2rem; font-size: 0.85rem; color: rgba(255,255,255,0.7); line-height: 1.5; }
.m001-confirm-msg strong {
  color: #fff;
  font-family: 'Orbitron', sans-serif;
  letter-spacing: 0.08em;
  font-weight: 500;
  display: block;
  margin-top: 0.4rem;
  font-size: 0.8rem;
}
.m001-confirm-actions { display: flex; gap: 0.6rem; justify-content: flex-end; }

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
.m001-note-corners .c { position: absolute; width: 10px; height: 10px; border: 1px solid var(--accent); }
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
/* Side-tab purge button — runs along the right edge of every note */
.m001-note-purge {
  position: absolute;
  right: -1px;
  top: 14%;
  bottom: 14%;
  width: 18px;
  background: linear-gradient(90deg,
    transparent,
    color-mix(in srgb, var(--accent) 22%, transparent) 50%,
    color-mix(in srgb, var(--accent) 38%, transparent));
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  border-left: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  z-index: 4;
  transition: width 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
  overflow: hidden;
}
.m001-note-purge-text {
  font-family: 'Orbitron', sans-serif;
  font-size: 0.6rem;
  letter-spacing: 0.2em;
  color: rgba(255,255,255,0.55);
  writing-mode: vertical-rl;
  text-orientation: mixed;
  text-transform: uppercase;
  transition: color 0.18s ease;
  pointer-events: none;
}
.m001-note-purge:hover {
  width: 32px;
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--accent) 30%, transparent),
    var(--accent));
  box-shadow: 0 0 18px var(--accent-glow);
}
.m001-note-purge:hover .m001-note-purge-text { color: #000; }
.m001-note-purge:active { background: var(--accent); }
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
.m001-note-colors { display: flex; gap: 0.35rem; }
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

/* Stack badge (anchor only) */
.m001-stack-badge {
  position: absolute;
  top: -14px; right: -14px;
  z-index: 5;
  min-width: 38px; height: 28px;
  padding: 0 0.5rem;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-family: 'Orbitron', sans-serif;
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  background: rgba(8,2,4,0.96);
  color: var(--accent);
  border: 1px solid var(--accent);
  cursor: pointer;
  box-shadow: 0 0 14px var(--accent-glow);
  transition: all 0.15s;
}
.m001-stack-badge[hidden] { display: none !important; }
.m001-stack-badge:hover {
  background: var(--accent);
  color: #000;
  transform: scale(1.08);
}
.m001-stack-badge .m001-stack-count { font-weight: 700; }
.m001-stack-badge .m001-stack-arrow {
  font-size: 0.85rem;
  opacity: 0.7;
}
.m001-stack-badge:hover .m001-stack-arrow { opacity: 1; }

/* Subtle indicator on stacked notes */
.m001-note.is-stacked.is-stack-anchor { /* anchor — keep full opacity */ }

/* Snap-target highlight while dragging another note onto this one */
.m001-note.is-snap-target {
  box-shadow:
    0 0 36px var(--accent-glow),
    0 0 80px var(--accent-glow),
    0 0 0 3px var(--accent),
    inset 0 0 50px rgba(255,255,255,0.06);
  opacity: 1;
}
.m001-note.is-snap-target::before {
  content: '◉ STACK';
  position: absolute;
  top: -22px; left: 50%;
  transform: translateX(-50%);
  font-family: 'Orbitron', sans-serif;
  font-size: 0.65rem;
  letter-spacing: 0.18em;
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent-glow);
  white-space: nowrap;
  pointer-events: none;
}
`;

// =============================================================================
// Register
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'OBSIDIAN_DECK · CYLINDER',
  mount,
  unmount,
});
