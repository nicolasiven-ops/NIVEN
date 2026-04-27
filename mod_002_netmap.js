// === MOD_002 · NET_FORGE ===
// Flat 2D network map editor. SVG board with dotted grid, pan/zoom,
// device palette, link tool, inspector panel, layer toggle.
//
// Controls
//   N            cycle next device type and spawn at center
//   L            toggle link mode
//   DEL          delete selected element
//   ESC          deselect / cancel link
//   R            recenter view
//   Drag bg      pan
//   Scroll       zoom
//   Drag device  move
//   Click device click-then-click in link mode → connect
//
// Persistence: localStorage  niven:m002:<projectId>  → { devices, links, view }
// Supabase wiring follows once schema is decided.

const MODULE_CODE = 'MOD_002';
const SAVE_DEBOUNCE_MS = 400;
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PORTS = 2;
const DEVICE_TYPES = [
  { id: 'switch',   label: 'SWITCH',   ports: DEFAULT_PORTS, accent: '#00d4ff' },
  { id: 'router',   label: 'ROUTER',   ports: DEFAULT_PORTS, accent: '#35ff7a' },
  { id: 'firewall', label: 'FIREWALL', ports: DEFAULT_PORTS, accent: '#ff003c' },
  { id: 'endpoint', label: 'ENDPOINT', ports: DEFAULT_PORTS, accent: '#ffae00' },
  { id: 'cloud',    label: 'CLOUD',    ports: DEFAULT_PORTS, accent: '#7afcff' },
];
const TYPE_ALIASES = { server: 'endpoint', client: 'endpoint', ap: 'endpoint' };
const typeOf = (id) => DEVICE_TYPES.find((t) => t.id === id)
  || DEVICE_TYPES.find((t) => t.id === TYPE_ALIASES[id])
  || DEVICE_TYPES[0];

const LAYERS = [
  { id: 'physical', label: 'PHYSICAL' },
  { id: 'vlan',     label: 'VLAN'     },
  { id: 'routing',  label: 'ROUTING'  },
];

// VLAN colors are computed from the live set of VLANs in the network so that
// the spectrum stays evenly distributed — adding new VLANs shifts existing
// hues. See recomputeVlanIndex().
function vlanColor(s, vlan) {
  if (vlan == null || vlan === '') return '#5a5f6e';
  return s?.vlanColors?.get(String(vlan)) || '#5a5f6e';
}

function recomputeVlanIndex(s) {
  const set = new Set();
  s.devices.forEach((d) => (d.ports || []).forEach((p) => (p.vlans || []).forEach((v) => set.add(String(v)))));
  const list = [...set].sort((a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.localeCompare(b);
  });
  const N = list.length;
  s.vlanColors = new Map();
  list.forEach((v, i) => {
    const hue = N <= 1 ? 0 : Math.round((i / (N - 1)) * 300);
    s.vlanColors.set(v, `hsl(${hue}, 85%, 60%)`);
  });
  s.vlanList = list;
}

// Call after any change that might add/remove a VLAN. Recomputes the spectrum,
// redraws all links (their colors depend on it) and refreshes the legend.
function vlansChanged(s) {
  recomputeVlanIndex(s);
  renderLegend(s);
  s.links.forEach((l) => redrawLink(s, l));
}

function renderLegend(s) {
  if (!s.legendEl) return;
  s.legendEl.hidden = s.activeLayer !== 'vlan';
  const body = s.legendEl.querySelector('.m002-vlan-legend-body');
  if (!s.vlanList || !s.vlanList.length) {
    body.innerHTML = `<span class="m002-vlan-legend-empty">no VLANs assigned yet</span>`;
    return;
  }
  body.innerHTML = s.vlanList.map((v) => `
    <span class="m002-vlan-legend-chip" style="--vc:${s.vlanColors.get(v)}">
      <span class="m002-vlan-legend-dot"></span>
      <span>VLAN ${escSvg(v)}</span>
    </span>`).join('');
}

const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1 };
const DEVICE_W = 120;
const DEVICE_H = 72;
const GRID = 24;

// =============================================================================
// Lifecycle
// =============================================================================
let state = null;

function mount(stage, ctx) {
  state = createState(stage, ctx);
  buildDOM(state);
  bindBoard(state);
  bindKeyboard(state);
  loadFromStorage(state);
  applyView(state);
  render(state);
}

function unmount() {
  if (!state) return;
  for (const off of state.cleanups) { try { off(); } catch (_) {} }
  state.host?.remove();
  state = null;
}

function createState(stage, ctx) {
  return {
    stage, sb: ctx.sb, project: ctx.project, code: ctx.code, exit: ctx.exit,
    storageKey: `niven:m002:${ctx.project?.id || ctx.code}`,

    host: null, board: null, svg: null, gWorld: null,
    gStacksBg: null, gLinks: null, gDevices: null, gOverlay: null,
    palette: null, inspector: null, layerBar: null, statusBar: null, toastEl: null,

    devices: [],   // { id, type, x, y, name, ip, notes, ports: [{n,name,vlans:[]}] }
    links: [],     // { id, from, to, fromPort, toPort }
    stacks: [],    // { id, name, members: [deviceId,...], x, y, expanded }
    portModalOpen: null, // { deviceId, portN } or null
    selected: null,// { kind: 'device'|'link'|'stack', id }

    view: { ...DEFAULT_VIEW },
    linkMode: false,
    linkPending: null, // first device id in link mode
    stackMode: false,
    stackPending: null,// first target id (device or stack) in stack mode
    spawnIdx: 0,

    drag: null,
    saveTimer: null,
    cleanups: [],
  };
}

// =============================================================================
// DOM
// =============================================================================
function buildDOM(s) {
  ensureStyles();
  const host = document.createElement('div');
  host.className = 'm002-host';
  host.innerHTML = `
    <div class="m002-tint"></div>

    <div class="m002-board">
      <svg class="m002-svg" xmlns="${SVG_NS}">
        <defs>
          <pattern id="m002-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
            <circle cx="0.5" cy="0.5" r="0.6" fill="#2a2a36"/>
          </pattern>
          <pattern id="m002-grid-major" width="${GRID * 5}" height="${GRID * 5}" patternUnits="userSpaceOnUse">
            <path d="M ${GRID * 5} 0 L 0 0 0 ${GRID * 5}" fill="none" stroke="#1a1a22" stroke-width="0.6"/>
          </pattern>
          <filter id="m002-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="2.4" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <rect class="m002-grid-bg" x="-5000" y="-5000" width="10000" height="10000" fill="url(#m002-grid)"/>
        <rect class="m002-grid-bg2" x="-5000" y="-5000" width="10000" height="10000" fill="url(#m002-grid-major)"/>
        <g class="m002-world">
          <g class="m002-stacks-bg"></g>
          <g class="m002-links"></g>
          <g class="m002-devices"></g>
          <g class="m002-overlay"></g>
        </g>
      </svg>
    </div>

    <div class="m002-palette">
      <div class="m002-palette-title">// FORGE</div>
      ${DEVICE_TYPES.map((t) => `
        <button type="button" class="m002-pal-btn" data-spawn="${t.id}" title="Spawn ${t.label}" style="--accent:${t.accent}">
          <span class="m002-pal-dot"></span>
          <span>${t.label}</span>
        </button>`).join('')}
      <div class="m002-pal-sep"></div>
      <button type="button" class="m002-pal-btn m002-link-tool" data-tool="link" title="Link tool (L)">
        <span class="m002-pal-glyph">⌇</span>
        <span>LINK</span>
      </button>
      <button type="button" class="m002-pal-btn m002-stack-tool" data-tool="stack" title="Stack tool (S) — group devices into a stack">
        <span class="m002-pal-glyph">⊟</span>
        <span>STACK</span>
      </button>
      <button type="button" class="m002-pal-btn ghost" data-tool="recenter" title="Recenter (R)">
        <span class="m002-pal-glyph">◎</span>
        <span>RECENTER</span>
      </button>
    </div>

    <div class="m002-layerbar">
      ${LAYERS.map((l, i) => `
        <button type="button" class="m002-layer-pill ${i === 0 ? 'active' : ''}" data-layer="${l.id}">${l.label}</button>
      `).join('')}
    </div>

    <aside class="m002-inspector" hidden>
      <div class="m002-insp-head">
        <span class="m002-insp-id">// INSPECT</span>
        <button type="button" class="m002-insp-close" title="Close (Esc)">×</button>
      </div>
      <div class="m002-insp-body"></div>
    </aside>

    <div class="m002-statusbar">
      <span class="m002-stat-tag">// NET_FORGE</span>
      <span class="m002-stat-sep">·</span>
      <span class="m002-stat-devices">0 NODES</span>
      <span class="m002-stat-sep">·</span>
      <span class="m002-stat-links">0 LINKS</span>
      <span class="m002-stat-sep">·</span>
      <span class="m002-stat-mode">SELECT</span>
    </div>

    <aside class="m002-vlan-legend" hidden>
      <div class="m002-vlan-legend-title">// VLAN INDEX</div>
      <div class="m002-vlan-legend-body">
        <span class="m002-vlan-legend-empty">no VLANs assigned yet</span>
      </div>
    </aside>

    <div class="m002-port-modal" hidden>
      <div class="m002-port-panel">
        <div class="m002-port-modal-head">
          <span class="m002-port-modal-id">// PORT</span>
          <button type="button" class="m002-port-modal-close" title="Close">×</button>
        </div>
        <div class="m002-port-modal-body"></div>
      </div>
    </div>

    <div class="m002-toast"></div>
  `;
  s.stage.appendChild(host);
  s.host = host;
  s.board = host.querySelector('.m002-board');
  s.svg = host.querySelector('.m002-svg');
  s.gWorld = host.querySelector('.m002-world');
  s.gStacksBg = host.querySelector('.m002-stacks-bg');
  s.gLinks = host.querySelector('.m002-links');
  s.gDevices = host.querySelector('.m002-devices');
  s.gOverlay = host.querySelector('.m002-overlay');
  s.palette = host.querySelector('.m002-palette');
  s.inspector = host.querySelector('.m002-inspector');
  s.layerBar = host.querySelector('.m002-layerbar');
  s.statusBar = host.querySelector('.m002-statusbar');
  s.toastEl = host.querySelector('.m002-toast');
  s.legendEl = host.querySelector('.m002-vlan-legend');

  s.palette.addEventListener('click', (e) => {
    const spawn = e.target.closest('[data-spawn]');
    if (spawn) { spawnDevice(s, spawn.dataset.spawn); return; }
    const tool = e.target.closest('[data-tool]');
    if (!tool) return;
    if (tool.dataset.tool === 'link') toggleLinkMode(s);
    if (tool.dataset.tool === 'stack') toggleStackMode(s);
    if (tool.dataset.tool === 'recenter') recenter(s);
  });

  s.layerBar.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-layer]');
    if (!pill) return;
    s.layerBar.querySelectorAll('.m002-layer-pill').forEach((p) => p.classList.toggle('active', p === pill));
    s.activeLayer = pill.dataset.layer;
    render(s);
  });
  s.activeLayer = 'physical';

  host.querySelector('.m002-insp-close')?.addEventListener('click', () => deselect(s));

  const portModal = host.querySelector('.m002-port-modal');
  portModal.querySelector('.m002-port-modal-close')?.addEventListener('click', () => closePortModal(s));
  portModal.addEventListener('click', (e) => { if (e.target === portModal) closePortModal(s); });

  // Click empty board area → deselect
  s.svg.addEventListener('mousedown', (e) => {
    if (e.target === s.svg || e.target.classList.contains('m002-grid-bg') || e.target.classList.contains('m002-grid-bg2')) {
      if (s.linkMode && e.button === 0) {
        // ignore — link mode requires clicking devices
      }
      deselect(s);
    }
  });
}

function ensureStyles() {
  if (document.getElementById('mod002-styles')) return;
  const css = document.createElement('style');
  css.id = 'mod002-styles';
  css.textContent = MOD002_CSS;
  document.head.appendChild(css);
}

// =============================================================================
// Board interaction — pan / zoom / drag
// =============================================================================
function bindBoard(s) {
  const svg = s.svg;

  // Wheel zoom
  const onWheel = (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const wx = (mx - s.view.x) / s.view.zoom;
    const wy = (my - s.view.y) / s.view.zoom;
    const dz = Math.exp(-e.deltaY * 0.0015);
    const next = Math.max(0.25, Math.min(3, s.view.zoom * dz));
    s.view.x = mx - wx * next;
    s.view.y = my - wy * next;
    s.view.zoom = next;
    applyView(s);
    schedSave(s);
  };
  svg.addEventListener('wheel', onWheel, { passive: false });
  s.cleanups.push(() => svg.removeEventListener('wheel', onWheel));

  // Mouse interactions: pan empty, drag device, drag stack
  const onDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const devEl = e.target.closest('[data-device-id]');
    const stackEl = e.target.closest('[data-stack-id]');
    const linkEl = e.target.closest('[data-link-id]');
    const onBg = e.target === svg || e.target.classList.contains('m002-grid-bg') || e.target.classList.contains('m002-grid-bg2');

    if (s.linkMode && devEl && e.button === 0) {
      handleLinkClick(s, devEl.dataset.deviceId);
      e.preventDefault();
      return;
    }
    if (s.stackMode && e.button === 0) {
      if (stackEl) { handleStackPick(s, { kind: 'stack',  id: stackEl.dataset.stackId  }); e.preventDefault(); return; }
      if (devEl)   { handleStackPick(s, { kind: 'device', id: devEl.dataset.deviceId }); e.preventDefault(); return; }
    }

    if (stackEl && e.button === 0) {
      const st = findStackById(s, stackEl.dataset.stackId);
      if (!st) return;
      select(s, 'stack', st.id);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'stack', id: st.id, dx: st.x - w.x, dy: st.y - w.y };
      e.preventDefault();
      return;
    }

    if (devEl && e.button === 0) {
      const dev = s.devices.find((d) => d.id === devEl.dataset.deviceId);
      if (!dev) return;
      select(s, 'device', dev.id);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'device', id: dev.id, dx: dev.x - w.x, dy: dev.y - w.y };
      e.preventDefault();
      return;
    }

    if (linkEl && e.button === 0) {
      select(s, 'link', linkEl.dataset.linkId);
      e.preventDefault();
      return;
    }

    if (onBg || e.button === 1) {
      s.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: s.view.x, vy: s.view.y };
      svg.style.cursor = 'grabbing';
      e.preventDefault();
    }
  };
  const onMove = (e) => {
    if (!s.drag) return;
    if (s.drag.kind === 'pan') {
      s.view.x = s.drag.vx + (e.clientX - s.drag.startX);
      s.view.y = s.drag.vy + (e.clientY - s.drag.startY);
      applyView(s);
    } else if (s.drag.kind === 'device') {
      const w = clientToWorld(s, e.clientX, e.clientY);
      const dev = s.devices.find((d) => d.id === s.drag.id);
      if (!dev) return;
      let nx = w.x + s.drag.dx;
      let ny = w.y + s.drag.dy;
      if (!e.altKey) {
        nx = Math.round(nx / GRID) * GRID;
        ny = Math.round(ny / GRID) * GRID;
      }
      dev.x = nx; dev.y = ny;
      updateDeviceTransform(s, dev);
      updateLinksFor(s, dev.id);
      // If this device sits inside an expanded stack, the envelope/cables track too
      const stk = findStack(s, dev.id);
      if (stk && !isStackCollapsed(s, stk)) refreshStackVisuals(s, stk);
    } else if (s.drag.kind === 'stack') {
      const w = clientToWorld(s, e.clientX, e.clientY);
      const st = findStackById(s, s.drag.id);
      if (!st) return;
      let nx = w.x + s.drag.dx;
      let ny = w.y + s.drag.dy;
      if (!e.altKey) {
        nx = Math.round(nx / GRID) * GRID;
        ny = Math.round(ny / GRID) * GRID;
      }
      const ddx = nx - st.x, ddy = ny - st.y;
      st.x = nx; st.y = ny;
      st.members.forEach((mid) => {
        const m = s.devices.find((d) => d.id === mid);
        if (m) {
          m.x += ddx; m.y += ddy;
          updateDeviceTransform(s, m);
        }
      });
      // Move the collapsed icon if present
      const g = s.gDevices.querySelector(`[data-stack-id="${st.id}"]`);
      g?.setAttribute('transform', `translate(${st.x} ${st.y})`);
      // Move envelope + cables if expanded
      if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
      // Redraw links touching the stack
      s.links.forEach((l) => { if (st.members.includes(l.from) || st.members.includes(l.to)) redrawLink(s, l); });
    }
  };
  const onUp = () => {
    if (s.drag) {
      svg.style.cursor = '';
      if (s.drag.kind === 'device' || s.drag.kind === 'pan' || s.drag.kind === 'stack') schedSave(s);
    }
    s.drag = null;
  };

  const onDblClick = (e) => {
    const stackEl = e.target.closest('[data-stack-id]');
    if (!stackEl) return;
    if (s.activeLayer !== 'physical') {
      toast(s, 'Switch to PHYSICAL to expand stack');
      return;
    }
    toggleStackExpanded(s, stackEl.dataset.stackId);
    e.preventDefault();
  };
  svg.addEventListener('dblclick', onDblClick);
  s.cleanups.push(() => svg.removeEventListener('dblclick', onDblClick));
  svg.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  s.cleanups.push(() => svg.removeEventListener('mousedown', onDown));
  s.cleanups.push(() => window.removeEventListener('mousemove', onMove));
  s.cleanups.push(() => window.removeEventListener('mouseup', onUp));
}

function clientToWorld(s, cx, cy) {
  const rect = s.svg.getBoundingClientRect();
  return {
    x: (cx - rect.left - s.view.x) / s.view.zoom,
    y: (cy - rect.top  - s.view.y) / s.view.zoom,
  };
}

function applyView(s) {
  s.gWorld.setAttribute('transform', `translate(${s.view.x} ${s.view.y}) scale(${s.view.zoom})`);
}

function recenter(s) {
  s.view = { ...DEFAULT_VIEW };
  applyView(s);
  schedSave(s);
  toast(s, 'Recenter');
}

// =============================================================================
// Keyboard
// =============================================================================
function bindKeyboard(s) {
  const onKey = (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'n' || e.key === 'N') {
      const t = DEVICE_TYPES[s.spawnIdx % DEVICE_TYPES.length];
      s.spawnIdx++;
      spawnDevice(s, t.id);
    } else if (e.key === 'l' || e.key === 'L') {
      toggleLinkMode(s);
    } else if (e.key === 's' || e.key === 'S') {
      toggleStackMode(s);
    } else if (e.key === 'r' || e.key === 'R') {
      recenter(s);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.selected) deleteSelected(s);
    } else if (e.key === 'Escape') {
      if (s.portModalOpen) closePortModal(s);
      else if (s.linkMode) toggleLinkMode(s);
      else if (s.stackMode) toggleStackMode(s);
      else deselect(s);
    }
  };
  window.addEventListener('keydown', onKey);
  s.cleanups.push(() => window.removeEventListener('keydown', onKey));
}

// =============================================================================
// Devices
// =============================================================================
function spawnDevice(s, typeId) {
  const t = typeOf(typeId);
  // Place at center of current view, snapped
  const rect = s.svg.getBoundingClientRect();
  const w = clientToWorld(s, rect.left + rect.width / 2, rect.top + rect.height / 2);
  const dev = {
    id: rid(),
    type: t.id,
    x: Math.round(w.x / GRID) * GRID,
    y: Math.round(w.y / GRID) * GRID,
    name: `${t.label}-${(s.devices.filter((d) => d.type === t.id).length + 1).toString().padStart(2, '0')}`,
    ip: '',
    notes: '',
    ports: Array.from({ length: t.ports }, (_, i) => ({ n: i + 1, name: '', vlans: [] })),
  };
  s.devices.push(dev);
  drawDevice(s, dev);
  select(s, 'device', dev.id);
  updateStatus(s);
  schedSave(s);
}

function drawDevice(s, dev) {
  const t = typeOf(dev.type);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-device');
  g.setAttribute('data-device-id', dev.id);
  g.style.setProperty('--accent', t.accent);
  updateDeviceTransform({ }, dev, g);

  const w = DEVICE_W, h = DEVICE_H;
  g.innerHTML = `
    <rect class="m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
    <text class="m002-dev-type" x="${-w/2 + 10}" y="${-h/2 + 18}">${t.label}</text>
    <text class="m002-dev-name" x="${-w/2 + 10}" y="${-h/2 + 40}">${escSvg(dev.name)}</text>
    <text class="m002-dev-notes" x="${-w/2 + 10}" y="${h/2 - 10}">${escSvg(truncate(dev.notes, 18) || '—')}</text>
    <text class="m002-dev-ip" x="${w/2 - 10}" y="${h/2 - 10}" text-anchor="end">${escSvg(dev.ip || '')}</text>
  `;
  s.gDevices.appendChild(g);
}

function updateDeviceTransform(_s, dev, gEl) {
  const g = gEl || document.querySelector(`[data-device-id="${dev.id}"]`);
  if (!g) return;
  g.setAttribute('transform', `translate(${dev.x} ${dev.y})`);
}

function redrawDevice(s, dev) {
  const g = s.gDevices.querySelector(`[data-device-id="${dev.id}"]`);
  if (g) g.remove();
  drawDevice(s, dev);
  // Re-apply selection class if needed
  if (s.selected?.kind === 'device' && s.selected.id === dev.id) markSelected(s);
}

// =============================================================================
// Links
// =============================================================================
function toggleLinkMode(s) {
  s.linkMode = !s.linkMode;
  s.linkPending = null;
  s.host.classList.toggle('m002-linking', s.linkMode);
  s.palette.querySelector('.m002-link-tool')?.classList.toggle('active', s.linkMode);
  setMode(s, s.linkMode ? 'LINK · pick first node' : 'SELECT');
}

function handleLinkClick(s, deviceId) {
  if (!s.linkPending) {
    s.linkPending = deviceId;
    setMode(s, 'LINK · pick second node');
    s.gDevices.querySelector(`[data-device-id="${deviceId}"]`)?.classList.add('m002-link-pending');
    return;
  }
  if (s.linkPending === deviceId) {
    toast(s, 'Link cancelled (same node)');
    s.linkPending = null;
    s.gDevices.querySelectorAll('.m002-link-pending').forEach((el) => el.classList.remove('m002-link-pending'));
    setMode(s, 'LINK · pick first node');
    return;
  }
  const link = {
    id: rid(),
    from: s.linkPending,
    to: deviceId,
    fromPort: '',
    toPort: '',
  };
  s.links.push(link);
  drawLink(s, link);
  updateStatus(s);
  s.gDevices.querySelectorAll('.m002-link-pending').forEach((el) => el.classList.remove('m002-link-pending'));
  s.linkPending = null;
  setMode(s, 'LINK · pick first node');
  schedSave(s);
  select(s, 'link', link.id);
}

// =============================================================================
// Stacks
// =============================================================================
function findStack(s, deviceId) {
  return s.stacks.find((st) => st.members.includes(deviceId)) || null;
}
function findStackById(s, stackId) {
  return s.stacks.find((st) => st.id === stackId) || null;
}
// In logical layers (vlan/routing) the stack is always one entity. In Physical
// the stack respects its `expanded` flag.
function isStackCollapsed(s, stack) {
  if (!stack) return false;
  return s.activeLayer !== 'physical' || !stack.expanded;
}
// Where to anchor a link on this device — the device itself, or the stack icon
// if the device sits inside a collapsed stack.
function effectivePos(s, deviceId) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return null;
  const stack = findStack(s, deviceId);
  if (stack && isStackCollapsed(s, stack)) return { x: stack.x, y: stack.y };
  return { x: dev.x, y: dev.y };
}

function toggleStackMode(s) {
  s.stackMode = !s.stackMode;
  s.stackPending = null;
  if (s.stackMode && s.linkMode) toggleLinkMode(s);
  s.host.classList.toggle('m002-stacking', s.stackMode);
  s.palette.querySelector('.m002-stack-tool')?.classList.toggle('active', s.stackMode);
  s.gDevices.querySelectorAll('.m002-stack-pending').forEach((el) => el.classList.remove('m002-stack-pending'));
  setMode(s, s.stackMode ? 'STACK · pick first node/stack' : 'SELECT');
}

// In stack mode the user clicks two targets. A target is either a regular
// device or an existing stack icon. Combinations:
//   (dev,dev)   → new stack with both as members
//   (dev,stack) → add the device to the stack  (also stack,dev)
//   (stk,stk)   → merge stacks
function handleStackPick(s, target) {
  // target = { kind: 'device'|'stack', id }
  if (!s.stackPending) {
    s.stackPending = target;
    setMode(s, 'STACK · pick second node/stack');
    markStackPending(s, target, true);
    return;
  }
  if (s.stackPending.kind === target.kind && s.stackPending.id === target.id) {
    toast(s, 'Stack cancelled');
    markStackPending(s, s.stackPending, false);
    s.stackPending = null;
    setMode(s, 'STACK · pick first node/stack');
    return;
  }
  const a = s.stackPending, b = target;
  markStackPending(s, a, false);
  s.stackPending = null;
  let createdId = null;
  if (a.kind === 'device' && b.kind === 'device') {
    createdId = createStack(s, [a.id, b.id]);
  } else if (a.kind === 'stack' && b.kind === 'device') {
    addToStack(s, a.id, b.id); createdId = a.id;
  } else if (a.kind === 'device' && b.kind === 'stack') {
    addToStack(s, b.id, a.id); createdId = b.id;
  } else {
    createdId = mergeStacks(s, a.id, b.id);
  }
  setMode(s, 'STACK · pick first node/stack');
  if (createdId) select(s, 'stack', createdId);
}

function markStackPending(s, target, on) {
  const sel = target.kind === 'device'
    ? s.gDevices.querySelector(`[data-device-id="${target.id}"]`)
    : s.gDevices.querySelector(`[data-stack-id="${target.id}"]`);
  sel?.classList.toggle('m002-stack-pending', !!on);
}

function createStack(s, deviceIds) {
  const members = deviceIds.filter((id) => !findStack(s, id));
  if (members.length < 2) {
    toast(s, 'Need two un-stacked devices');
    return null;
  }
  const devs = members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  const cx = devs.reduce((sum, d) => sum + d.x, 0) / devs.length;
  const cy = devs.reduce((sum, d) => sum + d.y, 0) / devs.length;
  const idx = s.stacks.length + 1;
  const st = {
    id: 'stk_' + rid(),
    name: `STACK-${String(idx).padStart(2, '0')}`,
    members: [...members],
    x: Math.round(cx / GRID) * GRID,
    y: Math.round(cy / GRID) * GRID,
    expanded: false,
  };
  s.stacks.push(st);
  render(s);
  schedSave(s);
  return st.id;
}

function addToStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  if (findStack(s, deviceId)) { toast(s, 'Device is already in a stack'); return; }
  st.members.push(deviceId);
  render(s);
  schedSave(s);
}

function mergeStacks(s, idA, idB) {
  if (idA === idB) return idA;
  const a = findStackById(s, idA), b = findStackById(s, idB);
  if (!a || !b) return null;
  a.members = [...a.members, ...b.members.filter((m) => !a.members.includes(m))];
  s.stacks = s.stacks.filter((st) => st.id !== idB);
  render(s);
  schedSave(s);
  return a.id;
}

function removeFromStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  st.members = st.members.filter((m) => m !== deviceId);
  if (st.members.length < 2) {
    s.stacks = s.stacks.filter((x) => x.id !== stackId);
  }
  render(s);
  schedSave(s);
}

function deleteStack(s, stackId) {
  // Members survive as standalone devices.
  s.stacks = s.stacks.filter((x) => x.id !== stackId);
  render(s);
  schedSave(s);
}

function toggleStackExpanded(s, stackId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  st.expanded = !st.expanded;
  // On collapse, snap stack position to the centroid of members so the icon
  // appears where the cluster was.
  if (!st.expanded) {
    const devs = st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
    if (devs.length) {
      st.x = Math.round((devs.reduce((sum, d) => sum + d.x, 0) / devs.length) / GRID) * GRID;
      st.y = Math.round((devs.reduce((sum, d) => sum + d.y, 0) / devs.length) / GRID) * GRID;
    }
  }
  render(s);
  schedSave(s);
}

function drawCollapsedStack(s, stack) {
  const firstMember = stack.members.map((id) => s.devices.find((d) => d.id === id)).find(Boolean);
  const t = typeOf(firstMember?.type);
  const w = DEVICE_W, h = DEVICE_H;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-stack-collapsed');
  g.setAttribute('data-stack-id', stack.id);
  g.style.setProperty('--accent', t.accent);
  g.setAttribute('transform', `translate(${stack.x} ${stack.y})`);
  const memberCount = stack.members.length;
  // Two ghost rects behind to suggest depth — capped at 2 visible layers
  g.innerHTML = `
    <rect class="m002-stack-ghost" x="${-w/2 + 6}" y="${-h/2 - 6}" width="${w}" height="${h}" rx="3"/>
    <rect class="m002-stack-ghost" x="${-w/2 + 3}" y="${-h/2 - 3}" width="${w}" height="${h}" rx="3"/>
    <rect class="m002-dev-bg"      x="${-w/2}"     y="${-h/2}"     width="${w}" height="${h}" rx="3"/>
    <text class="m002-dev-type"   x="${-w/2 + 10}" y="${-h/2 + 18}">STACK · ${t.label}</text>
    <text class="m002-dev-name"   x="${-w/2 + 10}" y="${-h/2 + 40}">${escSvg(stack.name)}</text>
    <text class="m002-stack-badge" x="${w/2 - 10}"  y="${-h/2 + 18}" text-anchor="end">×${memberCount}</text>
    <text class="m002-dev-notes"  x="${-w/2 + 10}" y="${h/2 - 10}">${escSvg(memberCount + ' members')}</text>
  `;
  s.gDevices.appendChild(g);
}

function refreshStackVisuals(s, stack) {
  // Cheaper than a full render: clear envelope + cables for this stack and redraw.
  s.gStacksBg.querySelectorAll(`[data-stack-id="${stack.id}"]`).forEach((el) => el.remove());
  // Stack cables sit in gStacksBg too without an id wrapper — easier to rebuild fully.
  s.gStacksBg.innerHTML = '';
  s.stacks.forEach((st) => { if (!isStackCollapsed(s, st)) drawStackEnvelope(s, st); });
}

function drawStackEnvelope(s, stack) {
  const members = stack.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  if (members.length < 2) return;
  const padding = 18;
  const minX = Math.min(...members.map((m) => m.x - DEVICE_W / 2)) - padding;
  const minY = Math.min(...members.map((m) => m.y - DEVICE_H / 2)) - padding - 8;
  const maxX = Math.max(...members.map((m) => m.x + DEVICE_W / 2)) + padding;
  const maxY = Math.max(...members.map((m) => m.y + DEVICE_H / 2)) + padding;
  const env = document.createElementNS(SVG_NS, 'g');
  env.setAttribute('class', 'm002-stack-envelope');
  env.setAttribute('data-stack-id', stack.id);
  env.innerHTML = `
    <rect class="m002-stack-env-bg" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="6"/>
    <text class="m002-stack-env-label" x="${minX + 10}" y="${minY + 14}">// STACK · ${escSvg(stack.name)} · ×${members.length}</text>
  `;
  s.gStacksBg.appendChild(env);
  // Stack cables between consecutive members
  for (let i = 0; i < members.length - 1; i++) {
    const a = members[i], b = members[i + 1];
    const cab = document.createElementNS(SVG_NS, 'path');
    cab.setAttribute('class', 'm002-stack-cable');
    const path = orthPath(a, b, 0);
    cab.setAttribute('d', path.d);
    s.gStacksBg.appendChild(cab);
  }
}

function orthPath(a, b, off = 0) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const halfW = DEVICE_W / 2, halfH = DEVICE_H / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = Math.sign(dx) || 1;
    const ex1 = a.x + sx * halfW;
    const ex2 = b.x - sx * halfW;
    const mid = Math.round(((ex1 + ex2) / 2) / GRID) * GRID + off;
    const ay = a.y + off, by = b.y + off;
    return {
      d: `M ${ex1} ${ay} L ${mid} ${ay} L ${mid} ${by} L ${ex2} ${by}`,
      lx: mid, ly: (ay + by) / 2,
      from: { x: ex1 + sx * 6, y: ay - 6, anchor: sx > 0 ? 'start' : 'end' },
      to:   { x: ex2 - sx * 6, y: by - 6, anchor: sx > 0 ? 'end'   : 'start' },
    };
  }
  const sy = Math.sign(dy) || 1;
  const ey1 = a.y + sy * halfH;
  const ey2 = b.y - sy * halfH;
  const mid = Math.round(((ey1 + ey2) / 2) / GRID) * GRID + off;
  const ax = a.x + off, bx = b.x + off;
  return {
    d: `M ${ax} ${ey1} L ${ax} ${mid} L ${bx} ${mid} L ${bx} ${ey2}`,
    lx: (ax + bx) / 2, ly: mid,
    from: { x: ax + 6, y: ey1 + sy * 12, anchor: 'start' },
    to:   { x: bx + 6, y: ey2 - sy * 4,  anchor: 'start' },
  };
}

function linkVlans(s, link) {
  const a = s.devices.find((d) => d.id === link.from);
  const b = s.devices.find((d) => d.id === link.to);
  if (!a || !b) return [];
  const pa = a.ports.find((p) => String(p.n) === String(link.fromPort));
  const pb = b.ports.find((p) => String(p.n) === String(link.toPort));
  const va = new Set((pa?.vlans || []).map(String));
  const vb = new Set((pb?.vlans || []).map(String));
  return [...va].filter((v) => vb.has(v));
}

function portLabel(dev, portN) {
  const p = dev?.ports.find((pp) => String(pp.n) === String(portN));
  if (!p) return '?';
  return p.name || String(p.n);
}

function drawLink(s, link) {
  const a = s.devices.find((d) => d.id === link.from);
  const b = s.devices.find((d) => d.id === link.to);
  if (!a || !b) return;
  // Hide intra-stack links when the stack is collapsed (logical view, or
  // physical w/ stack collapsed) — they would self-loop on the stack icon.
  const stackA = findStack(s, a.id), stackB = findStack(s, b.id);
  if (stackA && stackA === stackB && isStackCollapsed(s, stackA)) return;
  const aPos = effectivePos(s, a.id);
  const bPos = effectivePos(s, b.id);
  const layer = s.activeLayer;
  const base = orthPath(aPos, bPos, 0);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link');
  g.setAttribute('data-link-id', link.id);

  let inner = `<path class="m002-link-hit" d="${base.d}"/>`;

  if (layer === 'vlan') {
    const vlans = linkVlans(s, link);
    if (vlans.length === 0) {
      inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#3a3a44"/>`;
    } else {
      const gap = 6;
      vlans.forEach((v, i) => {
        const off = (i - (vlans.length - 1) / 2) * gap;
        const p = orthPath(aPos, bPos, off);
        const c = vlanColor(s, v);
        inner += `<path class="m002-link-line" d="${p.d}" stroke="${c}"/>`;
        inner += `<text class="m002-link-label" x="${p.lx}" y="${p.ly - 4}" fill="${c}" text-anchor="middle">${escSvg(v)}</text>`;
      });
    }
  } else if (layer === 'routing') {
    // L3 placeholder — drawn dimmed; structure/edits coming later.
    inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#3a3a44" stroke-dasharray="4 3"/>`;
  } else {
    inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8"/>`;
    const fromTxt = link.fromPort ? portLabel(a, link.fromPort) : '';
    const toTxt   = link.toPort   ? portLabel(b, link.toPort)   : '';
    if (fromTxt) inner += `<text class="m002-link-label" x="${base.from.x}" y="${base.from.y}" fill="#9aa0a8" text-anchor="${base.from.anchor}">${escSvg(fromTxt)}</text>`;
    if (toTxt)   inner += `<text class="m002-link-label" x="${base.to.x}"   y="${base.to.y}"   fill="#9aa0a8" text-anchor="${base.to.anchor}">${escSvg(toTxt)}</text>`;
  }
  g.innerHTML = inner;
  s.gLinks.appendChild(g);
}

function updateLinksFor(s, deviceId) {
  s.links.filter((l) => l.from === deviceId || l.to === deviceId).forEach((l) => redrawLink(s, l));
}
function redrawLink(s, link) {
  const g = s.gLinks.querySelector(`[data-link-id="${link.id}"]`);
  if (g) g.remove();
  drawLink(s, link);
  if (s.selected?.kind === 'link' && s.selected.id === link.id) markSelected(s);
}

// =============================================================================
// Selection + inspector
// =============================================================================
function select(s, kind, id) {
  s.selected = { kind, id };
  markSelected(s);
  openInspector(s);
}

function deselect(s) {
  s.selected = null;
  s.host.querySelectorAll('.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
  s.inspector.hidden = true;
}

function markSelected(s) {
  s.host.querySelectorAll('.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
  if (!s.selected) return;
  let sel;
  if (s.selected.kind === 'device') sel = s.gDevices.querySelector(`[data-device-id="${s.selected.id}"]`);
  else if (s.selected.kind === 'link') sel = s.gLinks.querySelector(`[data-link-id="${s.selected.id}"]`);
  else if (s.selected.kind === 'stack') sel = s.gDevices.querySelector(`[data-stack-id="${s.selected.id}"]`);
  sel?.classList.add('m002-selected');
}

function openInspector(s) {
  if (!s.selected) { s.inspector.hidden = true; return; }
  s.inspector.hidden = false;
  const body = s.inspector.querySelector('.m002-insp-body');
  const idEl = s.inspector.querySelector('.m002-insp-id');

  if (s.selected.kind === 'device') {
    const dev = s.devices.find((d) => d.id === s.selected.id);
    if (!dev) return;
    const t = typeOf(dev.type);
    idEl.textContent = `// ${t.label}`;
    body.innerHTML = `
      <label class="m002-field"><span>NAME</span><input data-f="name" value="${escAttr(dev.name)}"/></label>
      <label class="m002-field"><span>TYPE</span>
        <select data-f="type">${DEVICE_TYPES.map((tt) => `<option value="${tt.id}" ${tt.id === dev.type ? 'selected' : ''}>${tt.label}</option>`).join('')}</select>
      </label>
      <label class="m002-field"><span>IP / CIDR</span><input data-f="ip" value="${escAttr(dev.ip)}" placeholder="10.0.0.1/24"/></label>
      <label class="m002-field"><span>PORTS</span><input data-f="ports" type="number" min="1" max="96" value="${dev.ports.length}"/></label>
      <label class="m002-field"><span>NOTES</span><textarea data-f="notes" rows="3">${escAttr(dev.notes)}</textarea></label>
      <div class="m002-ports-block">
        <div class="m002-ports-head">PORT TABLE (${dev.ports.length})</div>
        <div class="m002-ports-grid">
          <div class="m002-port-head-row">
            <span>#</span><span>PORT</span><span>COUNTERPART</span>
          </div>
          ${dev.ports.map((p) => {
            const cp = counterpartFor(s, dev.id, p.n);
            return `
            <div class="m002-port-row" data-port-open="${p.n}" tabindex="0">
              <span class="m002-port-num">${p.n}</span>
              <input data-port="${p.n}" data-pf="name" value="${escAttr(p.name)}" placeholder="port name"/>
              <span class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cp || '—')}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <button type="button" class="m002-insp-del" data-del>DELETE NODE</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => updateDeviceField(s, dev, el));
      el.addEventListener('change', () => updateDeviceField(s, dev, el));
    });
    body.querySelectorAll('[data-port]').forEach((el) => {
      el.addEventListener('input', () => {
        const p = dev.ports.find((pp) => pp.n === Number(el.dataset.port));
        if (!p) return;
        p[el.dataset.pf] = el.value;
        // Counterpart text in this row stays the same; redraw link labels
        s.links.filter((l) => (l.from === dev.id && Number(l.fromPort) === p.n) || (l.to === dev.id && Number(l.toPort) === p.n))
              .forEach((l) => redrawLink(s, l));
        schedSave(s);
      });
      // Don't open the port modal when the user clicks INTO the input
      el.addEventListener('click', (ev) => ev.stopPropagation());
    });
    body.querySelectorAll('[data-port-open]').forEach((row) => {
      row.addEventListener('click', () => openPortModal(s, dev.id, Number(row.dataset.portOpen)));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
  } else if (s.selected.kind === 'link') {
    const link = s.links.find((l) => l.id === s.selected.id);
    if (!link) return;
    const a = s.devices.find((d) => d.id === link.from);
    const b = s.devices.find((d) => d.id === link.to);
    idEl.textContent = `// LINK`;
    body.innerHTML = `
      <div class="m002-link-summary">
        <span class="m002-link-end">${escSvg(a?.name || '?')}</span>
        <span class="m002-link-arrow">⇄</span>
        <span class="m002-link-end">${escSvg(b?.name || '?')}</span>
      </div>
      <div class="m002-row2">
        <label class="m002-field"><span>FROM PORT</span>
          <select data-f="fromPort"><option value="">—</option>${(a?.ports || []).map((p) => `<option value="${p.n}" ${String(link.fromPort) === String(p.n) ? 'selected' : ''}>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</option>`).join('')}</select>
        </label>
        <label class="m002-field"><span>TO PORT</span>
          <select data-f="toPort"><option value="">—</option>${(b?.ports || []).map((p) => `<option value="${p.n}" ${String(link.toPort) === String(p.n) ? 'selected' : ''}>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</option>`).join('')}</select>
        </label>
      </div>
      <p class="m002-link-hint">VLANs werden über die Ports an beiden Enden definiert. Klick im Device-Inspector auf eine Portzeile.</p>
      <button type="button" class="m002-insp-del" data-del>DELETE LINK</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => updateLinkField(s, link, el));
      el.addEventListener('change', () => updateLinkField(s, link, el));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
  } else if (s.selected.kind === 'stack') {
    const stack = findStackById(s, s.selected.id);
    if (!stack) return;
    idEl.textContent = `// STACK · ×${stack.members.length}`;
    body.innerHTML = `
      <label class="m002-field"><span>NAME</span><input data-sf="name" value="${escAttr(stack.name)}"/></label>
      <div class="m002-field">
        <span>VIEW</span>
        <button type="button" class="m002-action" data-stk="toggle">
          ${stack.expanded ? '▴ COLLAPSE' : '▾ EXPAND (Physical only)'}
        </button>
      </div>
      <div class="m002-field">
        <span>MEMBERS (${stack.members.length})</span>
        <div class="m002-stack-members">
          ${stack.members.map((mid) => {
            const m = s.devices.find((d) => d.id === mid);
            if (!m) return '';
            const t = typeOf(m.type);
            return `
              <div class="m002-stack-member" style="--accent:${t.accent}">
                <span class="m002-stack-member-dot"></span>
                <span class="m002-stack-member-name">${escSvg(m.name)}</span>
                <span class="m002-stack-member-type">${t.label}</span>
                <button type="button" data-stk-rm="${escAttr(mid)}" title="Remove from stack">×</button>
              </div>`;
          }).join('')}
        </div>
      </div>
      <p class="m002-link-hint">Double-click den Stack im Physical-Layer um ihn aus-/einzuklappen. Logische Layer (VLAN/Routing) zeigen den Stack immer als ein Element.</p>
      <button type="button" class="m002-insp-del" data-del>UNGROUP STACK</button>
    `;
    body.querySelector('[data-sf="name"]').addEventListener('input', (e) => {
      stack.name = e.target.value;
      const g = s.gDevices.querySelector(`[data-stack-id="${stack.id}"] .m002-dev-name`);
      if (g) g.textContent = stack.name;
      schedSave(s);
    });
    body.querySelector('[data-stk="toggle"]').addEventListener('click', () => {
      if (s.activeLayer !== 'physical') { toast(s, 'Switch to PHYSICAL to expand'); return; }
      toggleStackExpanded(s, stack.id);
      openInspector(s);
    });
    body.querySelectorAll('[data-stk-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        removeFromStack(s, stack.id, b.dataset.stkRm);
        if (findStackById(s, stack.id)) openInspector(s);
        else { deselect(s); }
      });
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
  }
}

function updateDeviceField(s, dev, el) {
  const f = el.dataset.f;
  if (f === 'ports') {
    const n = Math.max(1, Math.min(96, parseInt(el.value, 10) || 1));
    if (n > dev.ports.length) {
      for (let i = dev.ports.length; i < n; i++) dev.ports.push({ n: i + 1, name: '', vlans: [] });
    } else {
      dev.ports.length = n;
      // Drop links that referenced removed ports
      s.links.forEach((l) => {
        if (l.from === dev.id && Number(l.fromPort) > n) l.fromPort = '';
        if (l.to === dev.id && Number(l.toPort) > n) l.toPort = '';
      });
    }
    redrawDevice(s, dev);
  } else if (f === 'type') {
    dev.type = el.value;
    redrawDevice(s, dev);
  } else {
    dev[f] = el.value;
    if (f === 'name' || f === 'ip' || f === 'notes') redrawDevice(s, dev);
    if (f === 'name') {
      // Counterpart text on other devices' inspector rows references this name
      s.links.filter((l) => l.from === dev.id || l.to === dev.id).forEach((l) => redrawLink(s, l));
    }
  }
  schedSave(s);
}

function updateLinkField(s, link, el) {
  link[el.dataset.f] = el.value;
  redrawLink(s, link);
  schedSave(s);
}

function deleteSelected(s) {
  if (!s.selected) return;
  if (s.selected.kind === 'device') {
    const id = s.selected.id;
    // Remove from any stack first
    const st = findStack(s, id);
    if (st) removeFromStack(s, st.id, id);
    s.devices = s.devices.filter((d) => d.id !== id);
    s.links = s.links.filter((l) => l.from !== id && l.to !== id);
  } else if (s.selected.kind === 'stack') {
    deleteStack(s, s.selected.id);
    deselect(s);
    return;
  } else {
    s.links = s.links.filter((l) => l.id !== s.selected.id);
  }
  deselect(s);
  render(s);
  schedSave(s);
}

// =============================================================================
// Counterpart helpers + Port modal
// =============================================================================
function counterpartFor(s, deviceId, portN) {
  const link = s.links.find((l) =>
    (l.from === deviceId && String(l.fromPort) === String(portN)) ||
    (l.to   === deviceId && String(l.toPort)   === String(portN))
  );
  if (!link) return null;
  const otherId = link.from === deviceId ? link.to : link.from;
  const otherPort = link.from === deviceId ? link.toPort : link.fromPort;
  const other = s.devices.find((d) => d.id === otherId);
  if (!other) return null;
  const op = other.ports.find((p) => String(p.n) === String(otherPort));
  const portTxt = op ? (op.name || op.n) : '?';
  return `${other.name} · ${portTxt}`;
}

function openPortModal(s, deviceId, portN) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return;
  const port = dev.ports.find((p) => p.n === portN);
  if (!port) return;
  s.portModalOpen = { deviceId, portN };
  const modal = s.host.querySelector('.m002-port-modal');
  const idEl = modal.querySelector('.m002-port-modal-id');
  const body = modal.querySelector('.m002-port-modal-body');
  idEl.textContent = `// ${dev.name} · PORT ${port.n}`;

  const link = s.links.find((l) =>
    (l.from === deviceId && Number(l.fromPort) === portN) ||
    (l.to   === deviceId && Number(l.toPort)   === portN)
  );
  const cp = counterpartFor(s, deviceId, portN);

  body.innerHTML = `
    <label class="m002-field"><span>PORT NAME</span>
      <input class="m002-pmodal-name" value="${escAttr(port.name)}" placeholder="e.g. GE0/0/1"/>
    </label>
    <div class="m002-field">
      <span>VLANS</span>
      <div class="m002-vlan-chips"></div>
      <div class="m002-vlan-add">
        <input class="m002-vlan-input" placeholder="VLAN id (e.g. 10)" inputmode="numeric"/>
        <button type="button" class="m002-vlan-add-btn">+ ADD</button>
      </div>
    </div>
    <div class="m002-field">
      <span>COUNTERPART</span>
      <div class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cp || '— not connected —')}</div>
    </div>
    <div class="m002-port-actions">
      ${link ? `<button type="button" class="m002-action" data-pact="unlink">DISCONNECT LINK</button>` : ''}
      <button type="button" class="m002-action danger" data-pact="delete">DELETE PORT</button>
    </div>
  `;

  const renderChips = () => {
    const chipsEl = body.querySelector('.m002-vlan-chips');
    if (!port.vlans.length) {
      chipsEl.innerHTML = `<span class="m002-vlan-empty">no VLANs assigned</span>`;
      return;
    }
    chipsEl.innerHTML = port.vlans.map((v) => `
      <span class="m002-vlan-chip" style="--vc:${vlanColor(s, v)}">
        <span>VLAN ${escSvg(v)}</span>
        <button type="button" data-vrm="${escAttr(v)}" title="Remove">×</button>
      </span>`).join('');
    chipsEl.querySelectorAll('[data-vrm]').forEach((b) => {
      b.addEventListener('click', () => {
        port.vlans = port.vlans.filter((v) => String(v) !== b.dataset.vrm);
        vlansChanged(s);
        renderChips();
        schedSave(s);
      });
    });
  };
  renderChips();

  body.querySelector('.m002-pmodal-name').addEventListener('input', (e) => {
    port.name = e.target.value;
    schedSave(s);
    s.links.filter((l) => (l.from === deviceId && Number(l.fromPort) === portN) || (l.to === deviceId && Number(l.toPort) === portN))
          .forEach((l) => redrawLink(s, l));
    // refresh row in inspector
    const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
    if (row) row.value = port.name;
  });

  const addInput = body.querySelector('.m002-vlan-input');
  const addBtn   = body.querySelector('.m002-vlan-add-btn');
  const addVlan = () => {
    const v = (addInput.value || '').trim();
    if (!v) return;
    if (!port.vlans.map(String).includes(v)) port.vlans.push(v);
    addInput.value = '';
    vlansChanged(s);
    renderChips();
    schedSave(s);
  };
  addBtn.addEventListener('click', addVlan);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addVlan(); } });

  body.querySelector('[data-pact="unlink"]')?.addEventListener('click', () => {
    if (!link) return;
    s.links = s.links.filter((l) => l.id !== link.id);
    closePortModal(s);
    if (s.selected?.kind === 'device' && s.selected.id === deviceId) openInspector(s);
    render(s);
    schedSave(s);
  });
  body.querySelector('[data-pact="delete"]')?.addEventListener('click', () => {
    deletePort(s, deviceId, portN);
    closePortModal(s);
  });

  modal.hidden = false;
  setTimeout(() => body.querySelector('.m002-pmodal-name')?.focus(), 30);
}

function closePortModal(s) {
  const modal = s.host?.querySelector('.m002-port-modal');
  if (modal) modal.hidden = true;
  s.portModalOpen = null;
}

function deletePort(s, deviceId, portN) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return;
  // Drop any links using this port on this device
  s.links = s.links.filter((l) =>
    !((l.from === deviceId && Number(l.fromPort) === portN) ||
      (l.to   === deviceId && Number(l.toPort)   === portN)));
  // Renumber: remove the port, shift later ports down
  dev.ports = dev.ports.filter((p) => p.n !== portN).map((p, idx) => ({ ...p, n: idx + 1 }));
  // Re-map link ports for this device whose port number was above the deleted one
  s.links.forEach((l) => {
    if (l.from === deviceId && Number(l.fromPort) > portN) l.fromPort = String(Number(l.fromPort) - 1);
    if (l.to   === deviceId && Number(l.toPort)   > portN) l.toPort   = String(Number(l.toPort)   - 1);
  });
  if (s.selected?.kind === 'device' && s.selected.id === deviceId) openInspector(s);
  recomputeVlanIndex(s);
  render(s);
  schedSave(s);
}

// =============================================================================
// Render — full redraw (used after layer toggle / load / delete)
// =============================================================================
function render(s) {
  recomputeVlanIndex(s);
  renderLegend(s);
  s.gStacksBg.innerHTML = '';
  s.gDevices.innerHTML = '';
  s.gLinks.innerHTML = '';

  // Stack envelopes (only when expanded in physical layer)
  s.stacks.forEach((st) => { if (!isStackCollapsed(s, st)) drawStackEnvelope(s, st); });

  // Links — drawLink itself filters intra-stack collapsed.
  s.links.forEach((l) => drawLink(s, l));

  // Members of collapsed stacks are not drawn as individual devices.
  const hidden = new Set();
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st)) st.members.forEach((m) => hidden.add(m)); });
  s.devices.forEach((d) => { if (!hidden.has(d.id)) drawDevice(s, d); });

  // Collapsed stack icons drawn last so they sit on top.
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st)) drawCollapsedStack(s, st); });

  markSelected(s);
  updateStatus(s);
}

function updateStatus(s) {
  s.host.querySelector('.m002-stat-devices').textContent = `${s.devices.length} NODES`;
  s.host.querySelector('.m002-stat-links').textContent = `${s.links.length} LINKS`;
}
function setMode(s, txt) {
  s.host.querySelector('.m002-stat-mode').textContent = txt;
}

// =============================================================================
// Persistence (localStorage prototype)
// =============================================================================
function schedSave(s) {
  clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => saveNow(s), SAVE_DEBOUNCE_MS);
}
function saveNow(s) {
  try {
    const payload = { v: 1, devices: s.devices, links: s.links, stacks: s.stacks, view: s.view };
    localStorage.setItem(s.storageKey, JSON.stringify(payload));
  } catch (e) { console.warn('[m002] save failed', e); }
}
function loadFromStorage(s) {
  try {
    const raw = localStorage.getItem(s.storageKey);
    if (!raw) return;
    const data = JSON.parse(raw);
    s.devices = Array.isArray(data.devices) ? data.devices : [];
    s.links = Array.isArray(data.links) ? data.links : [];
    s.stacks = Array.isArray(data.stacks) ? data.stacks : [];
    s.view = data.view || { ...DEFAULT_VIEW };
    migrate(s);
  } catch (e) { console.warn('[m002] load failed', e); }
}

// Convert legacy schema → current. Idempotent.
function migrate(s) {
  s.devices.forEach((d) => {
    if (TYPE_ALIASES[d.type]) d.type = TYPE_ALIASES[d.type];
    if (!Array.isArray(d.ports)) d.ports = [];
    d.ports.forEach((p) => {
      if (!Array.isArray(p.vlans)) {
        p.vlans = (p.vlan != null && p.vlan !== '') ? [String(p.vlan)] : [];
      }
      delete p.vlan;
    });
  });
  s.links.forEach((l) => {
    delete l.vlan;
    delete l.label;
  });
  // Purge stale references in stacks
  if (Array.isArray(s.stacks)) {
    const live = new Set(s.devices.map((d) => d.id));
    s.stacks.forEach((st) => {
      if (typeof st.expanded !== 'boolean') st.expanded = false;
      if (!Array.isArray(st.members)) st.members = [];
      st.members = st.members.filter((m) => live.has(m));
    });
    s.stacks = s.stacks.filter((st) => st.members.length >= 2);
  } else {
    s.stacks = [];
  }
  recomputeVlanIndex(s);
}

// =============================================================================
// Utils
// =============================================================================
function rid() { return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function escSvg(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escAttr(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(s, msg) {
  if (!s.toastEl) return;
  s.toastEl.textContent = msg;
  s.toastEl.classList.add('show');
  clearTimeout(s.toastTimer);
  s.toastTimer = setTimeout(() => s.toastEl.classList.remove('show'), 1400);
}

// =============================================================================
// CSS
// =============================================================================
const MOD002_CSS = `
.m002-host{position:absolute;inset:0;overflow:hidden;font-family:'Rajdhani',sans-serif;color:#e8e8ee;background:radial-gradient(ellipse at 50% 0%,#0d0d14 0%,#06060a 70%);}
.m002-host *{box-sizing:border-box}
.m002-host [hidden]{display:none!important;}
.m002-tint{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 50%,rgba(255,0,60,0.04) 100%);pointer-events:none;}

.m002-board{position:absolute;inset:0;}
.m002-svg{width:100%;height:100%;display:block;cursor:grab;}
.m002-host.m002-linking .m002-svg{cursor:crosshair;}
.m002-host.m002-stacking .m002-svg{cursor:cell;}
.m002-svg:active{cursor:grabbing;}

.m002-grid-bg,.m002-grid-bg2{pointer-events:all;}

.m002-device{cursor:move;filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-device:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-device.m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-dev-bg{fill:#0a0a10;stroke:var(--accent);stroke-width:1.2;}
.m002-device.m002-selected .m002-dev-bg{stroke-width:2;}
.m002-device.m002-link-pending .m002-dev-bg{stroke-dasharray:4 3;}
.m002-dev-type{font-size:9px;letter-spacing:1.6px;font-family:'Share Tech Mono',monospace;fill:var(--accent);opacity:.85;}
.m002-dev-name{font-size:14px;font-weight:600;fill:#f5f3ff;letter-spacing:.5px;}
.m002-dev-ip{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#7a7f8e;}
.m002-dev-notes{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#7a7f8e;font-style:italic;}

.m002-stack-collapsed{cursor:move;filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-stack-collapsed:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-stack-collapsed.m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-stack-collapsed.m002-stack-pending .m002-dev-bg{stroke-dasharray:4 3;}
.m002-stack-ghost{fill:#0a0a10;stroke:var(--accent);stroke-width:1;opacity:.55;}
.m002-stack-collapsed .m002-dev-bg{fill:#0a0a10;stroke:var(--accent);stroke-width:1.4;}
.m002-stack-collapsed.m002-selected .m002-dev-bg{stroke-width:2;}
.m002-stack-badge{font-size:11px;font-family:'Share Tech Mono',monospace;font-weight:600;fill:var(--accent);letter-spacing:1px;}

.m002-stack-env-bg{fill:rgba(255,255,255,0.02);stroke:#3a3a44;stroke-width:1;stroke-dasharray:5 4;}
.m002-stack-env-label{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#5a5f6e;letter-spacing:1.5px;}
.m002-stack-cable{stroke:#5a5f6e;stroke-width:1.2;stroke-dasharray:2 3;fill:none;opacity:.6;}

.m002-link-line{stroke-width:1.4;fill:none;}
.m002-link-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer;}
.m002-link:hover .m002-link-line{stroke-width:1.8;filter:drop-shadow(0 0 2px rgba(255,255,255,0.55)) drop-shadow(0 0 6px rgba(255,255,255,0.25));}
.m002-link:hover .m002-link-label{filter:drop-shadow(0 0 2px rgba(255,255,255,0.4));}
.m002-link.m002-selected .m002-link-line{stroke:#ffffff!important;stroke-width:2.4;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 10px rgba(255,255,255,0.65));}
.m002-link.m002-selected .m002-link-label{fill:#ffffff!important;}
.m002-link-label{font-size:9px;font-family:'Share Tech Mono',monospace;text-anchor:middle;letter-spacing:1px;}

.m002-palette{position:absolute;top:24px;left:24px;display:flex;flex-direction:column;gap:4px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:10px;backdrop-filter:blur(6px);min-width:160px;}
.m002-palette-title{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;margin-bottom:6px;}
.m002-pal-btn{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;color:#e8e8ee;padding:6px 10px;cursor:pointer;font-family:'Rajdhani',sans-serif;font-size:13px;letter-spacing:1.2px;text-align:left;transition:.15s;}
.m002-pal-btn:hover{border-color:#ff003c;background:rgba(255,0,60,0.06);}
.m002-pal-btn.ghost{color:#9aa0a8;}
.m002-pal-btn.active{background:rgba(0,212,255,0.1);border-color:#00d4ff;color:#00d4ff;}
.m002-pal-glyph{font-family:'Share Tech Mono',monospace;font-size:18px;width:20px;text-align:center;}
.m002-pal-dot{width:10px;height:10px;background:var(--accent);box-shadow:0 0 4px var(--accent),0 0 10px var(--accent);flex:0 0 auto;margin-left:4px;}
.m002-pal-sep{height:1px;background:#1a1a22;margin:6px 0;}

.m002-layerbar{position:absolute;top:24px;left:50%;transform:translateX(-50%);display:flex;gap:6px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:6px;backdrop-filter:blur(6px);}
.m002-layer-pill{background:transparent;border:1px solid transparent;color:#9aa0a8;padding:6px 14px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.6px;}
.m002-layer-pill:hover{color:#e8e8ee;}
.m002-layer-pill.active{background:rgba(255,0,60,0.1);border-color:#ff003c;color:#ff003c;}

.m002-inspector{position:absolute;top:24px;right:24px;width:300px;max-height:calc(100% - 48px);overflow-y:auto;background:rgba(8,8,14,0.92);border:1px solid #1a1a22;padding:14px;backdrop-filter:blur(6px);display:flex;flex-direction:column;gap:10px;}
.m002-insp-head{display:flex;justify-content:space-between;align-items:center;}
.m002-insp-id{font-family:'Share Tech Mono',monospace;font-size:11px;color:#ff003c;letter-spacing:2px;}
.m002-insp-close{background:transparent;border:none;color:#9aa0a8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;}
.m002-insp-close:hover{color:#ff003c;}
.m002-insp-body{display:flex;flex-direction:column;gap:8px;}
.m002-field{display:flex;flex-direction:column;gap:3px;}
.m002-field span{font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:1.5px;}
.m002-field input,.m002-field select,.m002-field textarea{background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:5px 8px;font-family:'Rajdhani',sans-serif;font-size:13px;outline:none;}
.m002-field input:focus,.m002-field select:focus,.m002-field textarea:focus{border-color:#ff003c;}
.m002-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.m002-link-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;background:#0a0a10;border:1px solid #1a1a22;}
.m002-link-end{font-weight:600;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-link-arrow{color:#ff003c;font-family:'Share Tech Mono',monospace;}
.m002-ports-block{display:flex;flex-direction:column;gap:4px;}
.m002-ports-head{font-family:'Share Tech Mono',monospace;font-size:10px;color:#9aa0a8;letter-spacing:1.5px;padding:4px 0;}
.m002-ports-grid{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;}
.m002-port-head-row{display:grid;grid-template-columns:18px 60px 1fr;gap:6px;align-items:center;font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:1.4px;padding:2px 4px;}
.m002-port-row{display:grid;grid-template-columns:18px 60px 1fr;gap:6px;align-items:center;cursor:pointer;padding:2px 4px;border:1px solid transparent;border-radius:2px;}
.m002-port-row:hover{background:rgba(255,0,60,0.06);border-color:#ff003c;}
.m002-port-num{font-family:'Share Tech Mono',monospace;font-size:11px;color:#9aa0a8;text-align:left;}
.m002-port-row input{background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:3px 6px;font-size:11px;font-family:'Share Tech Mono',monospace;outline:none;}
.m002-port-row input:focus{border-color:#ff003c;}
.m002-port-counter{font-family:'Share Tech Mono',monospace;font-size:11px;color:#e8e8ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;}
.m002-port-counter.dim{color:#5a5f6e;}
.m002-link-hint{font-size:11px;color:#7a7f8e;line-height:1.4;margin:0;font-style:italic;}

.m002-stack-members{display:flex;flex-direction:column;gap:4px;}
.m002-stack-member{display:grid;grid-template-columns:14px 1fr auto 22px;gap:6px;align-items:center;background:#06060a;border:1px solid #1a1a22;padding:4px 8px;}
.m002-stack-member-dot{width:8px;height:8px;background:var(--accent);box-shadow:0 0 4px var(--accent);}
.m002-stack-member-name{font-size:12px;color:#e8e8ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-stack-member-type{font-size:9px;font-family:'Share Tech Mono',monospace;color:var(--accent);letter-spacing:1px;}
.m002-stack-member button{background:transparent;border:none;color:#9aa0a8;cursor:pointer;font-size:14px;line-height:1;padding:0;}
.m002-stack-member button:hover{color:#ff003c;}

.m002-port-modal{position:absolute;inset:0;background:rgba(4,4,8,0.7);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(2px);}
.m002-port-panel{background:#0a0a10;border:1px solid #ff003c;width:340px;max-width:calc(100% - 32px);padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 0 20px rgba(255,0,60,0.25);}
.m002-port-modal-head{display:flex;justify-content:space-between;align-items:center;}
.m002-port-modal-id{font-family:'Share Tech Mono',monospace;font-size:11px;color:#ff003c;letter-spacing:2px;}
.m002-port-modal-close{background:transparent;border:none;color:#9aa0a8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;}
.m002-port-modal-close:hover{color:#ff003c;}
.m002-port-modal-body{display:flex;flex-direction:column;gap:10px;}
.m002-vlan-chips{display:flex;flex-wrap:wrap;gap:4px;min-height:24px;padding:4px;background:#06060a;border:1px solid #1a1a22;}
.m002-vlan-empty{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:1px;}
.m002-vlan-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;background:rgba(0,0,0,0.4);border:1px solid var(--vc);color:var(--vc);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;}
.m002-vlan-chip button{background:transparent;border:none;color:var(--vc);cursor:pointer;font-size:13px;line-height:1;padding:0 2px;opacity:.6;}
.m002-vlan-chip button:hover{opacity:1;}
.m002-vlan-add{display:flex;gap:4px;}
.m002-vlan-input{flex:1;background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:5px 8px;font-family:'Share Tech Mono',monospace;font-size:12px;outline:none;}
.m002-vlan-input:focus{border-color:#ff003c;}
.m002-vlan-add-btn{background:transparent;border:1px solid #ff003c;color:#ff003c;padding:5px 10px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;cursor:pointer;}
.m002-vlan-add-btn:hover{background:rgba(255,0,60,0.1);}
.m002-port-actions{display:flex;flex-direction:column;gap:6px;margin-top:4px;}
.m002-action{display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;border:1px solid #1a1a22;color:#e8e8ee;padding:7px 10px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;cursor:pointer;transition:.15s;}
.m002-action:hover{border-color:#9aa0a8;}
.m002-action.danger{border-color:#ff003c;color:#ff003c;}
.m002-action.danger:hover{background:rgba(255,0,60,0.1);}
.m002-insp-del{margin-top:6px;background:transparent;border:1px solid #ff003c;color:#ff003c;padding:6px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;cursor:pointer;}
.m002-insp-del:hover{background:rgba(255,0,60,0.1);}

.m002-vlan-legend{position:absolute;bottom:60px;left:24px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:10px 12px;backdrop-filter:blur(6px);max-width:340px;}
.m002-vlan-legend-title{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;margin-bottom:6px;}
.m002-vlan-legend-body{display:flex;flex-wrap:wrap;gap:6px;}
.m002-vlan-legend-empty{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:1px;}
.m002-vlan-legend-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;background:rgba(0,0,0,0.4);border:1px solid var(--vc);color:var(--vc);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;}
.m002-vlan-legend-dot{width:8px;height:8px;background:var(--vc);box-shadow:0 0 4px var(--vc),0 0 8px var(--vc);}

.m002-statusbar{position:absolute;bottom:16px;left:24px;display:flex;align-items:center;gap:8px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:6px 12px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;color:#9aa0a8;}
.m002-stat-tag{color:#ff003c;}
.m002-stat-sep{color:#2a2a36;}
.m002-stat-mode{color:#e8e8ee;}

.m002-toast{position:absolute;bottom:24px;left:50%;transform:translateX(-50%) translateY(20px);background:rgba(8,8,14,0.95);border:1px solid #ff003c;padding:8px 16px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;color:#ff003c;opacity:0;pointer-events:none;transition:.25s;}
.m002-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}

.m002-inspector::-webkit-scrollbar,.m002-ports-grid::-webkit-scrollbar{width:6px;}
.m002-inspector::-webkit-scrollbar-thumb,.m002-ports-grid::-webkit-scrollbar-thumb{background:#1a1a22;}
`;

// =============================================================================
// Register
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'NET_FORGE · LAYER_MAP',
  mount,
  unmount,
});
