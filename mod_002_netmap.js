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

const DEVICE_TYPES = [
  { id: 'switch',   label: 'SWITCH',   glyph: '▤', ports: 24, accent: '#00d4ff' },
  { id: 'router',   label: 'ROUTER',   glyph: '◈', ports: 4,  accent: '#35ff7a' },
  { id: 'firewall', label: 'FIREWALL', glyph: '▥', ports: 4,  accent: '#ff003c' },
  { id: 'server',   label: 'SERVER',   glyph: '▣', ports: 2,  accent: '#b87aff' },
  { id: 'ap',       label: 'AP',       glyph: '⊙', ports: 2,  accent: '#ffae00' },
  { id: 'client',   label: 'CLIENT',   glyph: '▭', ports: 1,  accent: '#9aa0a8' },
  { id: 'cloud',    label: 'CLOUD',    glyph: '☁', ports: 1,  accent: '#7afcff' },
];
const typeOf = (id) => DEVICE_TYPES.find((t) => t.id === id) || DEVICE_TYPES[0];

const LAYERS = [
  { id: 'physical', label: 'PHYSICAL' },
  { id: 'vlan',     label: 'VLAN'     },
];

const VLAN_PALETTE = [
  '#00d4ff', '#35ff7a', '#ffae00', '#ff003c',
  '#b87aff', '#7afcff', '#ff7ad9', '#f5f3ff',
];
function vlanColor(vlan) {
  if (vlan == null || vlan === '') return '#5a5f6e';
  const n = parseInt(String(vlan).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n)) return '#5a5f6e';
  return VLAN_PALETTE[n % VLAN_PALETTE.length];
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
    gLinks: null, gDevices: null, gOverlay: null,
    palette: null, inspector: null, layerBar: null, statusBar: null, toastEl: null,

    devices: [],   // { id, type, x, y, name, ip, notes, ports: [{n,name,vlan}] }
    links: [],     // { id, from, to, fromPort, toPort, vlan, label }
    selected: null,// { kind: 'device'|'link', id }

    view: { ...DEFAULT_VIEW },
    linkMode: false,
    linkPending: null, // first device id in link mode
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
          <g class="m002-links"></g>
          <g class="m002-devices"></g>
          <g class="m002-overlay"></g>
        </g>
      </svg>
    </div>

    <div class="m002-palette">
      <div class="m002-palette-title">// FORGE</div>
      ${DEVICE_TYPES.map((t) => `
        <button type="button" class="m002-pal-btn" data-spawn="${t.id}" title="Spawn ${t.label}">
          <span class="m002-pal-glyph" style="color:${t.accent}">${t.glyph}</span>
          <span>${t.label}</span>
        </button>`).join('')}
      <div class="m002-pal-sep"></div>
      <button type="button" class="m002-pal-btn m002-link-tool" data-tool="link" title="Link tool (L)">
        <span class="m002-pal-glyph">⌇</span>
        <span>LINK</span>
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

    <div class="m002-toast"></div>
  `;
  s.stage.appendChild(host);
  s.host = host;
  s.board = host.querySelector('.m002-board');
  s.svg = host.querySelector('.m002-svg');
  s.gWorld = host.querySelector('.m002-world');
  s.gLinks = host.querySelector('.m002-links');
  s.gDevices = host.querySelector('.m002-devices');
  s.gOverlay = host.querySelector('.m002-overlay');
  s.palette = host.querySelector('.m002-palette');
  s.inspector = host.querySelector('.m002-inspector');
  s.layerBar = host.querySelector('.m002-layerbar');
  s.statusBar = host.querySelector('.m002-statusbar');
  s.toastEl = host.querySelector('.m002-toast');

  s.palette.addEventListener('click', (e) => {
    const spawn = e.target.closest('[data-spawn]');
    if (spawn) { spawnDevice(s, spawn.dataset.spawn); return; }
    const tool = e.target.closest('[data-tool]');
    if (!tool) return;
    if (tool.dataset.tool === 'link') toggleLinkMode(s);
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

  // Mouse interactions: pan empty, drag device
  const onDown = (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const devEl = e.target.closest('[data-device-id]');
    const linkEl = e.target.closest('[data-link-id]');
    const onBg = e.target === svg || e.target.classList.contains('m002-grid-bg') || e.target.classList.contains('m002-grid-bg2');

    if (s.linkMode && devEl && e.button === 0) {
      handleLinkClick(s, devEl.dataset.deviceId);
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
      if (!e.altKey) { // snap unless Alt
        nx = Math.round(nx / GRID) * GRID;
        ny = Math.round(ny / GRID) * GRID;
      }
      dev.x = nx; dev.y = ny;
      updateDeviceTransform(s, dev);
      updateLinksFor(s, dev.id);
    }
  };
  const onUp = () => {
    if (s.drag) {
      svg.style.cursor = '';
      if (s.drag.kind === 'device' || s.drag.kind === 'pan') schedSave(s);
    }
    s.drag = null;
  };
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
    } else if (e.key === 'r' || e.key === 'R') {
      recenter(s);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (s.selected) deleteSelected(s);
    } else if (e.key === 'Escape') {
      if (s.linkMode) toggleLinkMode(s);
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
    ports: Array.from({ length: t.ports }, (_, i) => ({ n: i + 1, name: '', vlan: '' })),
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
  updateDeviceTransform({ }, dev, g);

  const w = DEVICE_W, h = DEVICE_H;
  g.innerHTML = `
    <rect class="m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
    <rect class="m002-dev-accent" x="${-w/2}" y="${-h/2}" width="4" height="${h}" fill="${t.accent}"/>
    <text class="m002-dev-glyph" x="${-w/2 + 18}" y="${-h/2 + 30}" fill="${t.accent}">${t.glyph}</text>
    <text class="m002-dev-type" x="${-w/2 + 36}" y="${-h/2 + 18}">${t.label}</text>
    <text class="m002-dev-name" x="${-w/2 + 36}" y="${-h/2 + 36}">${escSvg(dev.name)}</text>
    <text class="m002-dev-ip" x="${-w/2 + 8}" y="${h/2 - 8}">${escSvg(dev.ip || '—')}</text>
    <text class="m002-dev-ports" x="${w/2 - 8}" y="${h/2 - 8}" text-anchor="end">${dev.ports.length}P</text>
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
    vlan: '',
    label: '',
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

function drawLink(s, link) {
  const a = s.devices.find((d) => d.id === link.from);
  const b = s.devices.find((d) => d.id === link.to);
  if (!a || !b) return;
  const isVlanLayer = s.activeLayer === 'vlan';
  const stroke = isVlanLayer ? vlanColor(link.vlan) : '#9aa0a8';
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link');
  g.setAttribute('data-link-id', link.id);
  g.innerHTML = `
    <line class="m002-link-hit" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>
    <line class="m002-link-line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${stroke}"/>
    ${link.vlan !== '' ? `<text class="m002-link-vlan" x="${(a.x + b.x)/2}" y="${(a.y + b.y)/2 - 6}" fill="${stroke}">VLAN ${escSvg(link.vlan)}</text>` : ''}
  `;
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
  const sel = s.selected.kind === 'device'
    ? s.gDevices.querySelector(`[data-device-id="${s.selected.id}"]`)
    : s.gLinks.querySelector(`[data-link-id="${s.selected.id}"]`);
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
      <details class="m002-ports-details">
        <summary>PORT TABLE (${dev.ports.length})</summary>
        <div class="m002-ports-grid">
          ${dev.ports.map((p) => `
            <div class="m002-port-row">
              <span class="m002-port-num">${p.n}</span>
              <input data-port="${p.n}" data-pf="name" value="${escAttr(p.name)}" placeholder="label"/>
              <input data-port="${p.n}" data-pf="vlan" value="${escAttr(p.vlan)}" placeholder="vlan"/>
            </div>`).join('')}
        </div>
      </details>
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
        schedSave(s);
      });
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
  } else {
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
      <label class="m002-field"><span>VLAN</span><input data-f="vlan" value="${escAttr(link.vlan)}" placeholder="10, 20 …"/></label>
      <label class="m002-field"><span>LABEL</span><input data-f="label" value="${escAttr(link.label)}" placeholder="trunk, uplink …"/></label>
      <button type="button" class="m002-insp-del" data-del>DELETE LINK</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => updateLinkField(s, link, el));
      el.addEventListener('change', () => updateLinkField(s, link, el));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
  }
}

function updateDeviceField(s, dev, el) {
  const f = el.dataset.f;
  if (f === 'ports') {
    const n = Math.max(1, Math.min(96, parseInt(el.value, 10) || 1));
    if (n > dev.ports.length) {
      for (let i = dev.ports.length; i < n; i++) dev.ports.push({ n: i + 1, name: '', vlan: '' });
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
    if (f === 'name' || f === 'ip') redrawDevice(s, dev);
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
    s.devices = s.devices.filter((d) => d.id !== id);
    s.links = s.links.filter((l) => l.from !== id && l.to !== id);
  } else {
    s.links = s.links.filter((l) => l.id !== s.selected.id);
  }
  deselect(s);
  render(s);
  schedSave(s);
}

// =============================================================================
// Render — full redraw (used after layer toggle / load / delete)
// =============================================================================
function render(s) {
  s.gDevices.innerHTML = '';
  s.gLinks.innerHTML = '';
  s.links.forEach((l) => drawLink(s, l));
  s.devices.forEach((d) => drawDevice(s, d));
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
    const payload = { v: 1, devices: s.devices, links: s.links, view: s.view };
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
    s.view = data.view || { ...DEFAULT_VIEW };
  } catch (e) { console.warn('[m002] load failed', e); }
}

// =============================================================================
// Utils
// =============================================================================
function rid() { return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
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
.m002-svg:active{cursor:grabbing;}

.m002-grid-bg,.m002-grid-bg2{pointer-events:all;}

.m002-device{cursor:move;}
.m002-dev-bg{fill:#101019;stroke:#2a2a36;stroke-width:1;}
.m002-device:hover .m002-dev-bg{stroke:#ff003c;}
.m002-device.m002-selected .m002-dev-bg{stroke:#ff003c;stroke-width:1.6;filter:url(#m002-glow);}
.m002-device.m002-link-pending .m002-dev-bg{stroke:#00d4ff;stroke-width:1.6;}
.m002-dev-glyph{font-size:22px;font-family:'Share Tech Mono',monospace;dominant-baseline:middle;}
.m002-dev-type{font-size:9px;letter-spacing:1.4px;font-family:'Share Tech Mono',monospace;fill:#9aa0a8;}
.m002-dev-name{font-size:13px;font-weight:600;fill:#e8e8ee;}
.m002-dev-ip{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#5a5f6e;}
.m002-dev-ports{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#5a5f6e;}

.m002-link-line{stroke-width:1.4;fill:none;}
.m002-link-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer;}
.m002-link:hover .m002-link-line{stroke:#ff003c;stroke-width:2;}
.m002-link.m002-selected .m002-link-line{stroke:#ff003c;stroke-width:2.4;filter:url(#m002-glow);}
.m002-link-vlan{font-size:9px;font-family:'Share Tech Mono',monospace;text-anchor:middle;letter-spacing:1px;}

.m002-palette{position:absolute;top:24px;left:24px;display:flex;flex-direction:column;gap:4px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:10px;backdrop-filter:blur(6px);min-width:160px;}
.m002-palette-title{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;margin-bottom:6px;}
.m002-pal-btn{display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;color:#e8e8ee;padding:6px 10px;cursor:pointer;font-family:'Rajdhani',sans-serif;font-size:13px;letter-spacing:1.2px;text-align:left;transition:.15s;}
.m002-pal-btn:hover{border-color:#ff003c;background:rgba(255,0,60,0.06);}
.m002-pal-btn.ghost{color:#9aa0a8;}
.m002-pal-btn.active{background:rgba(0,212,255,0.1);border-color:#00d4ff;color:#00d4ff;}
.m002-pal-glyph{font-family:'Share Tech Mono',monospace;font-size:18px;width:20px;text-align:center;}
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
.m002-ports-details summary{font-family:'Share Tech Mono',monospace;font-size:10px;color:#9aa0a8;letter-spacing:1.5px;cursor:pointer;padding:4px 0;}
.m002-ports-grid{display:flex;flex-direction:column;gap:3px;max-height:200px;overflow-y:auto;padding-top:4px;}
.m002-port-row{display:grid;grid-template-columns:24px 1fr 70px;gap:4px;align-items:center;}
.m002-port-num{font-family:'Share Tech Mono',monospace;font-size:11px;color:#5a5f6e;text-align:right;}
.m002-port-row input{background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:3px 6px;font-size:11px;font-family:'Share Tech Mono',monospace;outline:none;}
.m002-port-row input:focus{border-color:#ff003c;}
.m002-insp-del{margin-top:6px;background:transparent;border:1px solid #ff003c;color:#ff003c;padding:6px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;cursor:pointer;}
.m002-insp-del:hover{background:rgba(255,0,60,0.1);}

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
