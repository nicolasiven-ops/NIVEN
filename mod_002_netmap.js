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
// Persistence: Supabase table `m002_maps` (RLS scoped to auth.uid())
//   - One row per map: { id uuid, user_id uuid, name text, data jsonb, … }
//   - The whole map (devices/links/stacks/vlans/zones/view) lives in `data`.
//   - Save is debounced and runs as an UPDATE on the active row.
//   - Active map id is remembered per-project in localStorage so reloads land
//     on the same map. localStorage is otherwise NOT used as a data store.
//   - Legacy localStorage maps (pre-cloud) are auto-migrated on first authed
//     mount when the server table is empty.

const MODULE_CODE = 'MOD_002';
const SAVE_DEBOUNCE_MS = 800;
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PORTS = 2;
const DEVICE_TYPES = [
  { id: 'switch',   label: 'SWITCH',   ports: DEFAULT_PORTS, accent: '#00d4ff' },
  { id: 'router',   label: 'ROUTER',   ports: DEFAULT_PORTS, accent: '#35ff7a' },
  { id: 'firewall', label: 'FIREWALL', ports: DEFAULT_PORTS, accent: '#ff003c' },
  { id: 'endpoint', label: 'ENDPOINT', ports: DEFAULT_PORTS, accent: '#ffae00' },
  { id: 'cloud',    label: 'CLOUD',    ports: DEFAULT_PORTS, accent: '#aab4c0' },
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
  const list = (s.vlanRegistry || []).map((v) => String(v.id)).sort((a, b) => {
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

function vlanRegistryAdd(s, id, name) {
  id = String(id || '').trim();
  if (!id) return false;
  if (s.vlanRegistry.find((v) => String(v.id) === id)) return false;
  s.vlanRegistry.push({ id, name: (name || '').trim() });
  return true;
}

function vlanRegistryRemove(s, id) {
  id = String(id);
  s.vlanRegistry = s.vlanRegistry.filter((v) => String(v.id) !== id);
  s.devices.forEach((d) => {
    if (Array.isArray(d.vlans)) d.vlans = d.vlans.filter((x) => String(x) !== id);
    (d.ports || []).forEach((p) => { if (Array.isArray(p.vlans)) p.vlans = p.vlans.filter((x) => String(x) !== id); });
  });
}

// VLANs available on a device (subset of registry).
function deviceVlans(s, deviceId) {
  const dev = s.devices.find((d) => d.id === deviceId);
  return Array.isArray(dev?.vlans) ? dev.vlans.map(String) : [];
}
// VLANs configured on a specific port (subset of device.vlans).
function portVlans(s, deviceId, portN) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return [];
  const port = (dev.ports || []).find((p) => String(p.n) === String(portN));
  return Array.isArray(port?.vlans) ? port.vlans.map(String) : [];
}
// Stack VLANs are derived: union of member device VLANs.
function stackUnionVlans(s, stack) {
  const set = new Set();
  (stack.members || []).forEach((id) => deviceVlans(s, id).forEach((v) => set.add(v)));
  return [...set];
}

// Call after any change that might add/remove a VLAN. Recomputes the spectrum,
// redraws all links (their colors depend on it) and refreshes the legend.
function vlansChanged(s) {
  recomputeVlanIndex(s);
  renderLegend(s);
  s.links.forEach((l) => redrawLink(s, l));
  // Re-render any VLAN pickers visible in inspector
  s.host?.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
}

// VLAN picker — chip per available VLAN; click toggles assignment.
//
// Targets (data-vlan-target):
//   device:<id>          chips show all registered VLANs; toggle add/remove
//                        from device.vlans (cascades remove from its ports).
//   stack:<id>           bulk control over all member devices: chip "on"
//                        means at least one member has it; toggle adds/removes
//                        from every member.
//   port:<devId>:<pN>    chips show only VLANs the device supports; toggle
//                        add/remove on port.vlans.
//   link:<linkId>        chips show only VLANs both endpoint devices support;
//                        toggle add/remove on both port.vlans simultaneously.
function renderVlanPicker(s, container) {
  const parts = (container.dataset.vlanTarget || '').split(':');
  const kind = parts[0];

  // Resolve picker context
  let scope = null; // { available: [vlanId,...], isOn: (v) => bool, toggle: (v, on) => void, emptyHint: string }
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === parts[1]);
    if (!dev) { container.innerHTML = ''; return; }
    if (!Array.isArray(dev.vlans)) dev.vlans = [];
    scope = {
      available: (s.vlanList || []),
      isOn: (v) => dev.vlans.map(String).includes(v),
      toggle: (v, on) => {
        if (on) {
          if (!dev.vlans.map(String).includes(v)) dev.vlans.push(v);
        } else {
          dev.vlans = dev.vlans.filter((x) => String(x) !== v);
          // Cascade: drop from all of this device's ports as well
          (dev.ports || []).forEach((p) => { p.vlans = (p.vlans || []).filter((x) => String(x) !== v); });
        }
      },
      emptyHint: 'no VLANs declared — add them in the legend',
    };
  } else if (kind === 'stack') {
    const st = findStackById(s, parts[1]);
    if (!st) { container.innerHTML = ''; return; }
    const memberDevs = () => (st.members || []).map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
    scope = {
      available: (s.vlanList || []),
      isOn: (v) => memberDevs().some((m) => (m.vlans || []).map(String).includes(v)),
      toggle: (v, on) => {
        memberDevs().forEach((m) => {
          if (!Array.isArray(m.vlans)) m.vlans = [];
          if (on) {
            if (!m.vlans.map(String).includes(v)) m.vlans.push(v);
          } else {
            m.vlans = m.vlans.filter((x) => String(x) !== v);
            (m.ports || []).forEach((p) => { p.vlans = (p.vlans || []).filter((x) => String(x) !== v); });
          }
        });
      },
      emptyHint: 'no VLANs declared — add them in the legend',
    };
  } else if (kind === 'port') {
    const dev = s.devices.find((d) => d.id === parts[1]);
    if (!dev) { container.innerHTML = ''; return; }
    const port = (dev.ports || []).find((p) => String(p.n) === String(parts[2]));
    if (!port) { container.innerHTML = ''; return; }
    if (!Array.isArray(port.vlans)) port.vlans = [];
    scope = {
      available: (dev.vlans || []).map(String).sort(vlanSort),
      isOn: (v) => port.vlans.map(String).includes(v),
      toggle: (v, on) => {
        if (on) {
          if (!port.vlans.map(String).includes(v)) port.vlans.push(v);
        } else {
          port.vlans = port.vlans.filter((x) => String(x) !== v);
        }
      },
      emptyHint: 'device has no VLANs — assign them on the device first',
    };
  } else if (kind === 'lag') {
    const dev = s.devices.find((d) => d.id === parts[1]);
    if (!dev) { container.innerHTML = ''; return; }
    const lag = (dev.lags || []).find((l) => l.id === parts[2]);
    if (!lag) { container.innerHTML = ''; return; }
    if (!Array.isArray(lag.vlans)) lag.vlans = [];
    scope = {
      // LAG VLANs are constrained to the device's VLAN set
      available: (dev.vlans || []).map(String).sort(vlanSort),
      isOn: (v) => lag.vlans.map(String).includes(v),
      toggle: (v, on) => {
        if (on) {
          if (!lag.vlans.map(String).includes(v)) lag.vlans.push(v);
          // Push to all member ports
          (lag.ports || []).forEach((pn) => {
            const port = (dev.ports || []).find((p) => p.n === pn);
            if (!port) return;
            if (!Array.isArray(port.vlans)) port.vlans = [];
            if (!port.vlans.map(String).includes(v)) port.vlans.push(v);
          });
        } else {
          lag.vlans = lag.vlans.filter((x) => String(x) !== v);
          (lag.ports || []).forEach((pn) => {
            const port = (dev.ports || []).find((p) => p.n === pn);
            if (!port) return;
            port.vlans = (port.vlans || []).filter((x) => String(x) !== v);
          });
        }
      },
      emptyHint: 'device has no VLANs — assign them on the device first',
    };
  } else if (kind === 'link') {
    const link = s.links.find((l) => l.id === parts[1]);
    if (!link) { container.innerHTML = ''; return; }
    if (!link.fromPort || !link.toPort) {
      container.innerHTML = `<span class="m002-vlan-empty">assign From/To ports first</span>`;
      return;
    }
    const aDev = s.devices.find((d) => d.id === link.from);
    const bDev = s.devices.find((d) => d.id === link.to);
    if (!aDev || !bDev) { container.innerHTML = ''; return; }
    const aPort = (aDev.ports || []).find((p) => String(p.n) === String(link.fromPort));
    const bPort = (bDev.ports || []).find((p) => String(p.n) === String(link.toPort));
    const intersect = (aDev.vlans || []).map(String).filter((v) => (bDev.vlans || []).map(String).includes(v));
    scope = {
      available: intersect.sort(vlanSort),
      isOn: (v) => (aPort?.vlans || []).map(String).includes(v) && (bPort?.vlans || []).map(String).includes(v),
      toggle: (v, on) => {
        [aPort, bPort].forEach((p) => {
          if (!p) return;
          if (!Array.isArray(p.vlans)) p.vlans = [];
          if (on) { if (!p.vlans.map(String).includes(v)) p.vlans.push(v); }
          else    { p.vlans = p.vlans.filter((x) => String(x) !== v); }
        });
      },
      emptyHint: 'no VLAN is supported on both ends',
    };
  } else {
    container.innerHTML = '';
    return;
  }

  if (!s.vlanRegistry.length) {
    container.innerHTML = `<span class="m002-vlan-empty">no VLANs declared — add them in the legend</span>`;
    return;
  }
  if (!scope.available.length) {
    container.innerHTML = `<span class="m002-vlan-empty">${escSvg(scope.emptyHint)}</span>`;
    return;
  }

  container.innerHTML = scope.available.map((v) => {
    const c = vlanColor(s, v);
    const on = scope.isOn(v);
    return `<button type="button" class="m002-vlan-chip-btn ${on ? 'on' : ''}" data-vtoggle="${escAttr(v)}" style="--vc:${c}">VLAN ${escSvg(v)}</button>`;
  }).join('');
  container.querySelectorAll('[data-vtoggle]').forEach((b) => {
    b.addEventListener('click', () => {
      const v = b.dataset.vtoggle;
      const on = scope.isOn(v);
      snapshot(s);
      scope.toggle(v, !on);
      vlansChanged(s);
      schedSave(s);
    });
  });
}

function vlanSort(a, b) {
  const na = parseInt(a, 10), nb = parseInt(b, 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function renderLegend(s) {
  const body = s.host?.querySelector('.m002-vlan-legend-body');
  if (!body) return;
  const list = s.vlanList || [];
  const rows = list.length
    ? `<div class="m002-vlan-legend-list">${list.map((v) => {
        const entry = s.vlanRegistry.find((r) => String(r.id) === v) || { id: v, name: '' };
        return `<div class="m002-vlan-row" style="--vc:${s.vlanColors.get(v)}">
          <span class="m002-vlan-row-dot"></span>
          <span class="m002-vlan-row-id">${escSvg(v)}</span>
          <input class="m002-vlan-row-name" value="${escAttr(entry.name || '')}" placeholder="name" data-vname="${escAttr(v)}"/>
          <button type="button" class="m002-vlan-row-rm" data-vrm="${escAttr(v)}" title="Remove VLAN globally">×</button>
        </div>`;
      }).join('')}</div>`
    : `<span class="m002-vlan-legend-empty">no VLANs declared yet</span>`;

  body.innerHTML = `
    ${rows}
    <form class="m002-vlan-legend-add">
      <input class="m002-vlan-legend-input" placeholder="VLAN id (e.g. 10)" inputmode="numeric"/>
      <button type="submit" class="m002-vlan-legend-add-btn">+ ADD</button>
    </form>
  `;
  body.querySelectorAll('[data-vrm]').forEach((b) => {
    b.addEventListener('click', () => {
      snapshot(s);
      vlanRegistryRemove(s, b.dataset.vrm);
      vlansChanged(s);
      schedSave(s);
    });
  });
  body.querySelectorAll('[data-vname]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const entry = s.vlanRegistry.find((r) => String(r.id) === inp.dataset.vname);
      if (!entry) return;
      entry.name = inp.value;
      schedSave(s);
    });
  });
  const form = body.querySelector('.m002-vlan-legend-add');
  const input = form.querySelector('input');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (input.value || '').trim();
    if (!v) return;
    snapshot(s);
    if (vlanRegistryAdd(s, v)) {
      input.value = '';
      vlansChanged(s);
      schedSave(s);
    } else {
      toast(s, `VLAN ${v} already declared`);
    }
  });
}

const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1 };
const DEVICE_W = 120;
const DEVICE_H = 72;
const GRID = 24;

// =============================================================================
// Lifecycle
// =============================================================================
let state = null;

async function mount(stage, ctx) {
  state = createState(stage, ctx);
  buildDOM(state);
  bindBoard(state);
  bindKeyboard(state);
  await loadFromServer(state);
  applyLayoutForLayer(state);
  applyView(state);
  render(state);
  refreshMapBar(state);
  refreshZoneBar(state);
  showInspectorEmpty(state);
  refreshToolHighlights(state);
}

function unmount() {
  if (!state) return;
  // Best-effort: flush any pending edits before tearing down.
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  if (state.dirty) { try { saveNow(state); } catch (_) {} }
  for (const off of state.cleanups) { try { off(); } catch (_) {} }
  state.host?.remove();
  state = null;
}

function createState(stage, ctx) {
  return {
    stage, sb: ctx.sb, project: ctx.project, code: ctx.code, exit: ctx.exit,
    // Maps come from Supabase. Each entry mirrors a row's id+name; the heavy
    // map content lives in the table's `data` jsonb and is loaded on demand
    // (or on mount, for the active map).
    maps: [],          // [{id: uuid, name: string}]
    activeMapId: null,
    suspendSaves: false, // true while hydrating — avoids save loops
    dirty: false,        // an edit is pending (used by unmount best-effort flush)
    zones: [],         // [{id, name}] — per map
    activeZone: null,

    host: null, board: null, svg: null, gWorld: null,
    gStacksBg: null, gLinks: null, gDevices: null, gOverlay: null,
    palette: null, inspector: null, layerBar: null, statusBar: null, toastEl: null,

    devices: [],   // { id, type, x, y, name, ip, notes, vlans:[], lags:[{id,name,ports}], ports: [{n,name,vlans:[]}] }
    links: [],     // { id, from, to, fromPort, toPort }
    stacks: [],    // { id, name, members: [deviceId,...], x, y, expanded } — VLANs are derived from members
    vlanRegistry: [],  // [{ id: string, name?: string }] — declared VLANs in this network
    portModalOpen: null, // { deviceId, portN } or null
    selected: null,// { kind: 'device'|'link'|'stack', id }
    multiSelected: new Set(), // additional selected targets — keys "device:ID" / "stack:ID"

    view: { ...DEFAULT_VIEW },
    linkMode: false,
    linkPending: null, // first device id in link mode
    stackMode: false,
    stackPending: null,// first target id (device or stack) in stack mode
    spawnIdx: 0,

    drag: null,
    dragStackTarget: null, // "device:ID" or "stack:ID" — drop-target while dragging a device
    saveTimer: null,
    cleanups: [],
    undoStack: [],     // last N snapshots (JSON strings) of mutable state
    redoStack: [],     // forward stack after undo
    UNDO_LIMIT: 40,
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
    <aside class="m002-leftpanel">
      <section class="m002-panel-section">
        <h3 class="m002-panel-title">// FORGE</h3>
        <div class="m002-panel-grid">
          ${DEVICE_TYPES.map((t) => `
            <button type="button" class="m002-pal-btn" data-spawn="${t.id}" draggable="true" title="Click or drag to canvas to spawn ${t.label}" style="--accent:${t.accent}">
              <span class="m002-pal-dot"></span>
              <span>${t.label}</span>
            </button>`).join('')}
        </div>
      </section>

      <section class="m002-panel-section">
        <h3 class="m002-panel-title">// TOOLS</h3>
        <div class="m002-panel-grid">
          <button type="button" class="m002-pal-btn m002-select-tool active" data-tool="select" title="Select / move (default)">
            <span class="m002-pal-glyph">↖</span><span>SELECT</span>
          </button>
          <button type="button" class="m002-pal-btn m002-link-tool" data-tool="link" title="Link tool (L)">
            <span class="m002-pal-glyph">⌇</span><span>LINK</span>
          </button>
          <button type="button" class="m002-pal-btn m002-stack-tool" data-tool="stack" title="Stack tool (S)">
            <span class="m002-pal-glyph">⊟</span><span>STACK</span>
          </button>
          <button type="button" class="m002-pal-btn" data-tool="delete" title="Delete selection (Del)">
            <span class="m002-pal-glyph">×</span><span>DELETE</span>
          </button>
          <button type="button" class="m002-pal-btn ghost" data-tool="undo" title="Undo (Ctrl+Z)">
            <span class="m002-pal-glyph">↶</span><span>UNDO</span>
          </button>
          <button type="button" class="m002-pal-btn ghost" data-tool="recenter" title="Recenter (R)">
            <span class="m002-pal-glyph">◎</span><span>RECENTER</span>
          </button>
        </div>
      </section>

      <section class="m002-panel-section m002-panel-section--legend">
        <h3 class="m002-panel-title">// LEGEND · VLANS</h3>
        <div class="m002-vlan-legend-body">
          <span class="m002-vlan-legend-empty">no VLANs declared yet</span>
        </div>
      </section>

      <section class="m002-panel-hints">
        <div>DRAG NODE → CANVAS</div>
        <div>DRAG NODE → NODE = GROUP</div>
        <div>DBL-CLICK GROUP = EXPAND</div>
      </section>
    </aside>

    <main class="m002-center">
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

      <div class="m002-layerbar-wrap">
        <div class="m002-layerbar">
          ${LAYERS.map((l, i) => `
            <button type="button" class="m002-layer-pill ${i === 0 ? 'active' : ''}" data-layer="${l.id}">${l.label}</button>
          `).join('')}
        </div>
      </div>

      <div class="m002-zonebar-wrap">
        <div class="m002-zonebar"></div>
      </div>

      <div class="m002-statusbar">
        <span class="m002-stat-tag">// NET_FORGE</span>
        <span class="m002-stat-sep">·</span>
        <span class="m002-stat-devices">0 NODES</span>
        <span class="m002-stat-sep">·</span>
        <span class="m002-stat-links">0 LINKS</span>
        <span class="m002-stat-sep">·</span>
        <span class="m002-stat-mode">SELECT</span>
      </div>

    </main>

    <aside class="m002-rightpanel m002-inspector">
      <div class="m002-mapbar">
        <button type="button" class="m002-map-btn" title="Maps">
          <span class="m002-map-label">// MAP</span>
          <span class="m002-map-name">—</span>
          <span class="m002-map-caret">▾</span>
        </button>
        <div class="m002-map-menu" hidden></div>
      </div>
      <input type="file" class="m002-import-input" accept="application/json" hidden/>
      <div class="m002-insp-head">
        <span class="m002-insp-id">// INSPECT</span>
      </div>
      <div class="m002-insp-body"></div>
    </aside>

    <div class="m002-lag-modal" hidden>
      <div class="m002-port-panel">
        <div class="m002-port-modal-head">
          <span class="m002-port-modal-id">// LAG</span>
          <button type="button" class="m002-lag-modal-close" title="Close">×</button>
        </div>
        <div class="m002-lag-modal-body"></div>
      </div>
    </div>

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
  s.palette = host.querySelector('.m002-leftpanel');
  s.inspector = host.querySelector('.m002-inspector');
  s.layerBar = host.querySelector('.m002-layerbar');
  s.statusBar = host.querySelector('.m002-statusbar');
  s.toastEl = host.querySelector('.m002-toast');
  // Legend body lives in the left panel; the picker calls still target the body
  s.legendEl = host.querySelector('.m002-vlan-legend-body')?.parentElement || null;
  s.zoneBarEl = host.querySelector('.m002-zonebar');
  s.mapBtnEl = host.querySelector('.m002-map-btn');
  s.mapMenuEl = host.querySelector('.m002-map-menu');
  s.importInputEl = host.querySelector('.m002-import-input');
  s.mapBtnEl.addEventListener('click', (e) => { e.stopPropagation(); toggleMapMenu(s); });
  document.addEventListener('click', (e) => {
    if (!s.mapMenuEl) return;
    if (e.target.closest('.m002-mapbar')) return;
    if (!s.mapMenuEl.hidden) s.mapMenuEl.hidden = true;
  });
  s.importInputEl.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importMapFromFile(s, file);
    e.target.value = '';
  });
  s.zoneBarEl.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-zone]');
    if (pill) { switchZone(s, pill.dataset.zone); return; }
    if (e.target.closest('[data-act="new-zone"]')) addZone(s);
  });
  s.zoneBarEl.addEventListener('contextmenu', (e) => {
    const pill = e.target.closest('[data-zone]');
    if (!pill) return;
    e.preventDefault();
    zoneContextMenu(s, pill.dataset.zone);
  });
  // Drag-from-palette → drop-on-canvas spawning
  s.palette.addEventListener('dragstart', (e) => {
    const btn = e.target.closest('[data-spawn]');
    if (!btn) return;
    e.dataTransfer.setData('application/x-m002-spawn', btn.dataset.spawn);
    e.dataTransfer.effectAllowed = 'copy';
  });
  s.svg.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('application/x-m002-spawn')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  s.svg.addEventListener('drop', (e) => {
    const typeId = e.dataTransfer.getData('application/x-m002-spawn');
    if (!typeId) return;
    e.preventDefault();
    const w = clientToWorld(s, e.clientX, e.clientY);
    spawnDeviceAt(s, typeId, w.x, w.y);
  });

  s.palette.addEventListener('click', (e) => {
    const spawn = e.target.closest('[data-spawn]');
    if (spawn) { spawnDevice(s, spawn.dataset.spawn); return; }
    const tool = e.target.closest('[data-tool]');
    if (!tool) return;
    if (tool.dataset.tool === 'select') {
      if (s.linkMode) toggleLinkMode(s);
      if (s.stackMode) toggleStackMode(s);
    }
    if (tool.dataset.tool === 'link') toggleLinkMode(s);
    if (tool.dataset.tool === 'stack') toggleStackMode(s);
    if (tool.dataset.tool === 'delete') deleteSelected(s);
    if (tool.dataset.tool === 'undo') undo(s);
    if (tool.dataset.tool === 'recenter') recenter(s);
    refreshToolHighlights(s);
  });

  s.layerBar.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-layer]');
    if (!pill) return;
    persistCurrentLayout(s);
    s.layerBar.querySelectorAll('.m002-layer-pill').forEach((p) => p.classList.toggle('active', p === pill));
    s.activeLayer = pill.dataset.layer;
    applyLayoutForLayer(s);
    render(s);
  });
  s.activeLayer = 'physical';


  const portModal = host.querySelector('.m002-port-modal');
  portModal.querySelector('.m002-port-modal-close')?.addEventListener('click', () => closePortModal(s));
  portModal.addEventListener('click', (e) => { if (e.target === portModal) closePortModal(s); });

  const lagModal = host.querySelector('.m002-lag-modal');
  lagModal.querySelector('.m002-lag-modal-close')?.addEventListener('click', () => closeLagModal(s));
  lagModal.addEventListener('click', (e) => { if (e.target === lagModal) closeLagModal(s); });

  // Background click → deselect, but only on a true click (not a pan-drag).
  // Actual deselect call lives in the pan onUp handler below — it checks
  // whether the pointer moved beyond a small threshold before deciding.
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
      if (e.shiftKey) { toggleMultiSelect(s, 'stack', st.id); e.preventDefault(); return; }
      select(s, 'stack', st.id);
      snapshot(s);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'stack', id: st.id, dx: st.x - w.x, dy: st.y - w.y };
      e.preventDefault();
      return;
    }

    if (devEl && e.button === 0) {
      const dev = s.devices.find((d) => d.id === devEl.dataset.deviceId);
      if (!dev) return;
      if (e.shiftKey) { toggleMultiSelect(s, 'device', dev.id); e.preventDefault(); return; }
      select(s, 'device', dev.id);
      snapshot(s);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'device', id: dev.id, dx: dev.x - w.x, dy: dev.y - w.y };
      e.preventDefault();
      return;
    }

    const laglinkEl = e.target.closest('[data-laglink-id]');
    if (laglinkEl && e.button === 0) {
      // Selecting the LAG renders its editor inline in the inspector
      // (used to open a modal — moved into inspector for consistency).
      select(s, 'lag', laglinkEl.dataset.laglinkId);
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
      s.drag.lastX = e.clientX;
      s.drag.lastY = e.clientY;
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
      const ddx = nx - dev.x, ddy = ny - dev.y;
      // If this drag is part of a multi-selection, move every selected item
      const group = collectGroupTargets(s, { kind: 'device', id: dev.id });
      group.forEach((it) => moveItemBy(s, it, ddx, ddy));
      updateLinksFor(s, dev.id);
      const stk = findStack(s, dev.id);
      if (stk && !isStackCollapsed(s, stk)) refreshStackVisuals(s, stk);

      // Drag-to-stack: highlight nearest valid merge candidate.
      // Skip when this device sits inside a stack (drag-to-merge across stacks
      // is too ambiguous for the prototype) or when shift is held.
      if (!e.shiftKey && !findStack(s, dev.id)) {
        const STACK_MERGE_THRESH = 70;
        let target = null;
        for (const d of s.devices) {
          if (d.id === dev.id) continue;
          if (findStack(s, d.id)) continue;
          if (Math.hypot(dev.x - d.x, dev.y - d.y) < STACK_MERGE_THRESH) { target = { kind: 'device', id: d.id }; break; }
        }
        if (!target) {
          for (const st2 of s.stacks) {
            if (!isStackCollapsed(s, st2)) continue;
            if (st2.members.includes(dev.id)) continue;
            if (Math.hypot(dev.x - st2.x, dev.y - st2.y) < STACK_MERGE_THRESH) { target = { kind: 'stack', id: st2.id }; break; }
          }
        }
        const newKey = target ? `${target.kind}:${target.id}` : null;
        if (newKey !== s.dragStackTarget) {
          if (s.dragStackTarget) {
            const [ok, oid] = s.dragStackTarget.split(':');
            const oel = ok === 'stack'
              ? s.gDevices.querySelector(`[data-stack-id="${oid}"]`)
              : s.gDevices.querySelector(`[data-device-id="${oid}"]`);
            oel?.classList.remove('m002-drag-stack-target');
          }
          s.dragStackTarget = newKey;
          if (newKey) {
            const [nk, nid] = newKey.split(':');
            const nel = nk === 'stack'
              ? s.gDevices.querySelector(`[data-stack-id="${nid}"]`)
              : s.gDevices.querySelector(`[data-device-id="${nid}"]`);
            nel?.classList.add('m002-drag-stack-target');
          }
        }
      }
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
      writeLayoutPos(st, s.activeLayer, nx, ny);
      st.members.forEach((mid) => {
        const m = s.devices.find((d) => d.id === mid);
        if (m) {
          writeLayoutPos(m, s.activeLayer, m.x + ddx, m.y + ddy);
          updateDeviceTransform(s, m);
        }
      });
      // If part of a multi-selection, also move other selected items
      const group = collectGroupTargets(s, { kind: 'stack', id: st.id });
      group.filter((it) => !(it.kind === 'stack' && it.id === st.id)).forEach((it) => moveItemBy(s, it, ddx, ddy));
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
    // Drop-to-stack: a device was dragged onto another device or stack.
    if (s.drag?.kind === 'device' && s.dragStackTarget) {
      const [tk, tid] = s.dragStackTarget.split(':');
      const tel = tk === 'stack'
        ? s.gDevices.querySelector(`[data-stack-id="${tid}"]`)
        : s.gDevices.querySelector(`[data-device-id="${tid}"]`);
      tel?.classList.remove('m002-drag-stack-target');
      const dragId = s.drag.id;
      s.dragStackTarget = null;
      s.drag = null;
      svg.style.cursor = '';
      if (tk === 'stack') {
        addToStack(s, tid, dragId);
      } else {
        // Two standalone devices — make a fresh stack.
        createStack(s, [dragId, tid]);
      }
      return;
    }
    // Cleanup any lingering target highlight (e.g. drag started but didn't
    // land on a candidate).
    if (s.dragStackTarget) {
      const [tk, tid] = s.dragStackTarget.split(':');
      const tel = tk === 'stack'
        ? s.gDevices.querySelector(`[data-stack-id="${tid}"]`)
        : s.gDevices.querySelector(`[data-device-id="${tid}"]`);
      tel?.classList.remove('m002-drag-stack-target');
      s.dragStackTarget = null;
    }
    if (s.drag) {
      svg.style.cursor = '';
      // True background click (mousedown→mouseup with no real pan) → deselect.
      // Threshold filters out tiny tremors so pan-drags never clear the inspector.
      if (s.drag.kind === 'pan' && !s.linkMode) {
        const dx = (s.drag.lastX ?? s.drag.startX) - s.drag.startX;
        const dy = (s.drag.lastY ?? s.drag.startY) - s.drag.startY;
        if (Math.hypot(dx, dy) < 4) deselect(s);
      }
      if (s.drag.kind === 'device' || s.drag.kind === 'pan' || s.drag.kind === 'stack') schedSave(s);
    }
    s.drag = null;
  };

  const onDblClick = (e) => {
    const stackEl = e.target.closest('[data-stack-id]');
    if (!stackEl) return;
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
  renderMinimap(s);
}

// =============================================================================
// Mini-map
// =============================================================================
function worldBounds(s) {
  // Bounding box across visible items in the active layer.
  const items = [];
  s.devices.forEach((d) => { if (!findStack(s, d.id) || !isStackCollapsed(s, findStack(s, d.id))) items.push(d); });
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st)) items.push(st); });
  if (!items.length) return { minX: -200, minY: -200, maxX: 200, maxY: 200 };
  let minX =  Infinity, minY =  Infinity, maxX = -Infinity, maxY = -Infinity;
  items.forEach((it) => {
    minX = Math.min(minX, it.x - DEVICE_W); minY = Math.min(minY, it.y - DEVICE_H);
    maxX = Math.max(maxX, it.x + DEVICE_W); maxY = Math.max(maxY, it.y + DEVICE_H);
  });
  // Pad
  const padX = (maxX - minX) * 0.1, padY = (maxY - minY) * 0.1;
  return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
}

function renderMinimap(s) {
  if (!s.minimapSvg) return;
  if (s.minimapEl?.dataset.mmState === 'closed') return;
  const bb = worldBounds(s);
  const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
  if (w <= 0 || h <= 0) { s.minimapSvg.innerHTML = ''; return; }
  s.minimapSvg.setAttribute('viewBox', `${bb.minX} ${bb.minY} ${w} ${h}`);

  // Viewport rectangle in world coords
  const svgRect = s.svg.getBoundingClientRect();
  const tlW = clientToWorld(s, svgRect.left, svgRect.top);
  const brW = clientToWorld(s, svgRect.right, svgRect.bottom);

  let inner = '';
  s.devices.forEach((d) => {
    const stk = findStack(s, d.id);
    if (stk && isStackCollapsed(s, stk)) return;
    const t = typeOf(d.type);
    inner += `<rect x="${d.x - 14}" y="${d.y - 8}" width="28" height="16" rx="1" fill="${t.accent}" opacity="0.85"/>`;
  });
  s.stacks.forEach((st) => {
    if (!isStackCollapsed(s, st)) return;
    const firstM = st.members.map((id) => s.devices.find((d) => d.id === id)).find(Boolean);
    const t = typeOf(firstM?.type);
    inner += `<rect x="${st.x - 18}" y="${st.y - 10}" width="36" height="20" rx="1" fill="${t.accent}" opacity="0.95" stroke="${t.accent}" stroke-width="1"/>`;
  });
  // Viewport rect
  inner += `<rect x="${tlW.x}" y="${tlW.y}" width="${brW.x - tlW.x}" height="${brW.y - tlW.y}" fill="rgba(255,255,255,0.04)" stroke="#ff003c" stroke-width="${Math.max(w, h) * 0.005}"/>`;
  s.minimapSvg.innerHTML = inner;
}

function centerMinimapAt(s, px, py) {
  const bb = worldBounds(s);
  const wx = bb.minX + (bb.maxX - bb.minX) * px;
  const wy = bb.minY + (bb.maxY - bb.minY) * py;
  const r = s.svg.getBoundingClientRect();
  s.view.x = r.width  / 2 - wx * s.view.zoom;
  s.view.y = r.height / 2 - wy * s.view.zoom;
  applyView(s);
  schedSave(s);
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
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(s); else undo(s);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo(s);
      return;
    }
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
      const lagModal = s.host?.querySelector('.m002-lag-modal');
      if (lagModal && !lagModal.hidden) { closeLagModal(s); return; }
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
  // Center of current viewport, snapped.
  const rect = s.svg.getBoundingClientRect();
  const w = clientToWorld(s, rect.left + rect.width / 2, rect.top + rect.height / 2);
  return spawnDeviceAt(s, typeId, w.x, w.y);
}

function spawnDeviceAt(s, typeId, wx, wy) {
  snapshot(s);
  const t = typeOf(typeId);
  const dev = {
    id: rid(),
    type: t.id,
    x: Math.round(wx / GRID) * GRID,
    y: Math.round(wy / GRID) * GRID,
    name: `${t.label}-${(s.devices.filter((d) => d.type === t.id).length + 1).toString().padStart(2, '0')}`,
    ip: '',
    notes: '',
    vlans: [],
    lags: [],
    zone: s.activeZone,
    ports: Array.from({ length: t.ports }, (_, i) => ({ n: i + 1, name: '', vlans: [] })),
  };
  ensureLayouts(dev);
  // Initialize all layers to the spawn position so the device is visible
  // wherever the user navigates next.
  dev.layouts.physical = { x: dev.x, y: dev.y };
  dev.layouts.vlan     = { x: dev.x, y: dev.y };
  dev.layouts.routing  = { x: dev.x, y: dev.y };
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
  setMode(s, s.linkMode ? 'LINK · pick first node' : 'SELECT');
  refreshToolHighlights(s);
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
  snapshot(s);
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
// =============================================================================
// Per-layer layouts — every device + stack stores positions per layer so
// rearranging in VLAN doesn't disturb the Physical layout.
// =============================================================================
function ensureLayouts(item) {
  if (!item.layouts) {
    const fallback = { x: item.x ?? 0, y: item.y ?? 0 };
    item.layouts = {
      physical: { ...fallback },
      vlan:     { ...fallback },
      routing:  { ...fallback },
    };
  } else {
    if (!item.layouts.physical) item.layouts.physical = { x: item.x ?? 0, y: item.y ?? 0 };
    if (!item.layouts.vlan)    item.layouts.vlan    = { ...item.layouts.physical };
    if (!item.layouts.routing) item.layouts.routing = { ...item.layouts.physical };
  }
}
function applyLayoutForLayer(s) {
  const L = s.activeLayer;
  s.devices.forEach((d) => { ensureLayouts(d); d.x = d.layouts[L].x; d.y = d.layouts[L].y; });
  s.stacks.forEach((st) => { ensureLayouts(st); st.x = st.layouts[L].x; st.y = st.layouts[L].y; });
}
function persistCurrentLayout(s) {
  const L = s.activeLayer;
  s.devices.forEach((d) => { ensureLayouts(d); d.layouts[L] = { x: d.x, y: d.y }; });
  s.stacks.forEach((st) => { ensureLayouts(st); st.layouts[L] = { x: st.x, y: st.y }; });
}
function writeLayoutPos(item, layer, x, y) {
  ensureLayouts(item);
  item.x = x; item.y = y;
  item.layouts[layer] = { x, y };
}

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
  return !stack.expanded;
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

// =============================================================================
// Multi-selection (shift+click to add, drag any → drag all)
// =============================================================================
function selKey(kind, id) { return `${kind}:${id}`; }

function toggleMultiSelect(s, kind, id) {
  const k = selKey(kind, id);
  if (s.multiSelected.has(k)) s.multiSelected.delete(k);
  else s.multiSelected.add(k);
  // If primary selection wasn't set, pivot to this
  if (!s.selected || (s.selected.kind !== kind && s.selected.id !== id)) select(s, kind, id);
  refreshMultiSelectClasses(s);
}

function clearMultiSelection(s) {
  s.multiSelected.clear();
  refreshMultiSelectClasses(s);
}

function refreshMultiSelectClasses(s) {
  s.host.querySelectorAll('.m002-multi-selected').forEach((el) => el.classList.remove('m002-multi-selected'));
  s.multiSelected.forEach((k) => {
    const [kind, id] = k.split(':');
    const el = kind === 'device'
      ? s.gDevices.querySelector(`[data-device-id="${id}"]`)
      : s.gDevices.querySelector(`[data-stack-id="${id}"]`);
    el?.classList.add('m002-multi-selected');
  });
}

// Returns the list of items to drag together when one is grabbed.
// If the grabbed item is part of multiSelection, the whole group moves.
// Otherwise just the grabbed item.
function collectGroupTargets(s, primary) {
  const k = selKey(primary.kind, primary.id);
  const inGroup = s.multiSelected.has(k) || (s.selected && s.selected.kind === primary.kind && s.selected.id === primary.id && s.multiSelected.size > 0);
  if (!inGroup || s.multiSelected.size === 0) return [primary];
  const out = [primary];
  s.multiSelected.forEach((mk) => {
    if (mk === k) return;
    const [kind, id] = mk.split(':');
    out.push({ kind, id });
  });
  return out;
}

function moveItemBy(s, target, ddx, ddy) {
  const L = s.activeLayer;
  if (target.kind === 'device') {
    const m = s.devices.find((d) => d.id === target.id);
    if (!m) return;
    writeLayoutPos(m, L, m.x + ddx, m.y + ddy);
    updateDeviceTransform(s, m);
    const stk = findStack(s, m.id);
    if (stk && !isStackCollapsed(s, stk)) refreshStackVisuals(s, stk);
  } else if (target.kind === 'stack') {
    const st = findStackById(s, target.id);
    if (!st) return;
    writeLayoutPos(st, L, st.x + ddx, st.y + ddy);
    st.members.forEach((mid) => {
      const m = s.devices.find((d) => d.id === mid);
      if (m) {
        writeLayoutPos(m, L, m.x + ddx, m.y + ddy);
        updateDeviceTransform(s, m);
      }
    });
    const g = s.gDevices.querySelector(`[data-stack-id="${st.id}"]`);
    g?.setAttribute('transform', `translate(${st.x} ${st.y})`);
    if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
  }
  // Redraw links touching this item
  if (target.kind === 'device') {
    s.links.forEach((l) => { if (l.from === target.id || l.to === target.id) redrawLink(s, l); });
  } else {
    const st = findStackById(s, target.id);
    if (st) s.links.forEach((l) => { if (st.members.includes(l.from) || st.members.includes(l.to)) redrawLink(s, l); });
  }
}

function toggleStackMode(s) {
  s.stackMode = !s.stackMode;
  s.stackPending = null;
  if (s.stackMode && s.linkMode) toggleLinkMode(s);
  s.host.classList.toggle('m002-stacking', s.stackMode);
  s.gDevices.querySelectorAll('.m002-stack-pending').forEach((el) => el.classList.remove('m002-stack-pending'));
  setMode(s, s.stackMode ? 'STACK · pick first node/stack' : 'SELECT');
  refreshToolHighlights(s);
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
  snapshot(s);
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
    zone: s.activeZone,
  };
  ensureLayouts(st);
  st.layouts.physical = { x: st.x, y: st.y };
  st.layouts.vlan     = { x: st.x, y: st.y };
  st.layouts.routing  = { x: st.x, y: st.y };
  s.stacks.push(st);
  render(s);
  schedSave(s);
  return st.id;
}

function addToStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  if (findStack(s, deviceId)) { toast(s, 'Device is already in a stack'); return; }
  snapshot(s);
  st.members.push(deviceId);
  toast(s, `Added to ${st.name} (×${st.members.length})`);
  render(s);
  schedSave(s);
}

function mergeStacks(s, idA, idB) {
  if (idA === idB) return idA;
  const a = findStackById(s, idA), b = findStackById(s, idB);
  if (!a || !b) return null;
  snapshot(s);
  a.members = [...a.members, ...b.members.filter((m) => !a.members.includes(m))];
  s.stacks = s.stacks.filter((st) => st.id !== idB);
  render(s);
  schedSave(s);
  return a.id;
}

function removeFromStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  snapshot(s);
  st.members = st.members.filter((m) => m !== deviceId);
  if (st.members.length < 2) {
    s.stacks = s.stacks.filter((x) => x.id !== stackId);
  }
  render(s);
  schedSave(s);
}

function deleteStack(s, stackId) {
  snapshot(s);
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
      const cx = Math.round((devs.reduce((sum, d) => sum + d.x, 0) / devs.length) / GRID) * GRID;
      const cy = Math.round((devs.reduce((sum, d) => sum + d.y, 0) / devs.length) / GRID) * GRID;
      writeLayoutPos(st, s.activeLayer, cx, cy);
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

// What does this LAG connect to? Walks each member port's existing link and
// summarizes the most common destination as { device, lag?, portCount }.
function lagCounterpart(s, deviceId, lag) {
  // Manual override beats inference
  if (lag?.counterpart?.deviceId && lag?.counterpart?.lagId) {
    const dev = s.devices.find((d) => d.id === lag.counterpart.deviceId);
    const otherLag = dev?.lags?.find((ll) => ll.id === lag.counterpart.lagId);
    if (dev && otherLag) return { dev, lag: otherLag, count: otherLag.ports?.length || 0, manual: true };
  }
  const counts = new Map(); // key (otherDeviceId|otherLagId?) → { dev, lag, count }
  for (const portN of (lag.ports || [])) {
    const link = s.links.find((l) =>
      (l.from === deviceId && Number(l.fromPort) === Number(portN)) ||
      (l.to   === deviceId && Number(l.toPort)   === Number(portN))
    );
    if (!link) continue;
    const otherId = link.from === deviceId ? link.to : link.from;
    const otherPort = Number(link.from === deviceId ? link.toPort : link.fromPort);
    const otherDev = s.devices.find((d) => d.id === otherId);
    if (!otherDev) continue;
    const otherLag = (otherDev.lags || []).find((ll) => (ll.ports || []).map(Number).includes(otherPort));
    const key = otherId + (otherLag ? '|' + otherLag.id : '');
    if (!counts.has(key)) counts.set(key, { dev: otherDev, lag: otherLag, count: 0 });
    counts.get(key).count++;
  }
  if (counts.size === 0) return null;
  const top = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return top;
}

// LAG bundle key for a link — null if it's not part of any LAG-pair.
// Two links share the same key iff they connect the same {device, LAG} on each
// side (independent of direction).
// SVG fragment that decorates a bundled LAG link with a parallel double-line
// — railroad-style. Two thin orthogonal paths offset ±gap/2 from the centerline.
// Used in place of the previous ring decorations.
function lagDoubleLineHTML(aPos, bPos, opts = {}) {
  const stroke = opts.stroke || '#9aa0a8';
  const width  = opts.width  || 1.8;
  const gap    = opts.gap    || 3;
  const a = orthPath(aPos, bPos, +gap);
  const b = orthPath(aPos, bPos, -gap);
  return `
    <path class="m002-lag-line" d="${a.d}" stroke="${stroke}" stroke-width="${width}" fill="none"/>
    <path class="m002-lag-line" d="${b.d}" stroke="${stroke}" stroke-width="${width}" fill="none"/>
  `;
}

// Renders an explicit LAG-pair as a single ring-decorated link, replacing
// the underlying port-cables in any layer. Click → opens the LAG modal so
// the user can edit name / members / counterpart / VLANs in one place.
function drawLagLink(s, p) {
  const aPos = effectivePos(s, p.devA.id);
  const bPos = effectivePos(s, p.devB.id);
  const path = orthPath(aPos, bPos, 0);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link m002-link-bundle m002-laglink');
  g.setAttribute('data-laglink-id', `${p.devA.id}|${p.lagA.id}`);

  const sharedVlans = (p.lagA.vlans || []).map(String).filter((v) => (p.lagB.vlans || []).map(String).includes(v));
  let inner = `<path class="m002-link-hit" d="${path.d}"/>`;
  if (s.activeLayer === 'vlan' && sharedVlans.length) {
    // Per-VLAN colored stripes plus the double-line accent so the bundle
    // is still readable as a LAG.
    const gap = 6;
    sharedVlans.forEach((v, i) => {
      const off = (i - (sharedVlans.length - 1) / 2) * gap;
      const op = orthPath(aPos, bPos, off);
      const c = vlanColor(s, v);
      inner += `<path class="m002-link-line" d="${op.d}" stroke="${c}" stroke-width="2.4"/>`;
      inner += `<text class="m002-link-label" x="${op.lx}" y="${op.ly - 4}" fill="${c}" text-anchor="middle">${escSvg(v)}</text>`;
    });
  } else {
    // Default representation: a neutral double-line between the two devices.
    inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 2 });
  }
  inner += `<text class="m002-link-bundle-label" x="${path.lx}" y="${path.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(p.lagA.name + ' ⇄ ' + p.lagB.name)}</text>`;
  g.innerHTML = inner;
  s.gLinks.appendChild(g);
}

function lagBundleKey(s, link) {
  const a = s.devices.find((d) => d.id === link.from);
  const b = s.devices.find((d) => d.id === link.to);
  if (!a || !b) return null;
  const lagA = (a.lags || []).find((l) => l.ports.map(Number).includes(Number(link.fromPort)));
  const lagB = (b.lags || []).find((l) => l.ports.map(Number).includes(Number(link.toPort)));
  if (!lagA && !lagB) return null;
  // Direction-independent key. Single-sided LAG is allowed — bundles links
  // that share the same {LAG, peer device} pairing.
  const aSide = lagA ? `${a.id}:${lagA.id}` : `${a.id}:_`;
  const bSide = lagB ? `${b.id}:${lagB.id}` : `${b.id}:_`;
  const ends = [aSide, bSide].sort();
  return ends.join('::');
}

function linkVlans(s, link) {
  const va = new Set(portVlans(s, link.from, link.fromPort));
  const vb = new Set(portVlans(s, link.to,   link.toPort));
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
  // LAG bundling — if this link is absorbed into a bundle that another link
  // represents, skip drawing it.
  const bundleInfo = s._bundleByLink?.get(link.id);
  if (bundleInfo?.absorbed) return;
  const aPos = effectivePos(s, a.id);
  const bPos = effectivePos(s, b.id);
  const layer = s.activeLayer;
  const base = orthPath(aPos, bPos, 0);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link');
  g.setAttribute('data-link-id', link.id);
  if (bundleInfo?.members) g.classList.add('m002-link-bundle');

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
        const w = bundleInfo?.members ? 2.4 : 1.4;
        inner += `<path class="m002-link-line" d="${p.d}" stroke="${c}" stroke-width="${w}"/>`;
        inner += `<text class="m002-link-label" x="${p.lx}" y="${p.ly - 4}" fill="${c}" text-anchor="middle">${escSvg(v)}</text>`;
      });
    }
    if (bundleInfo?.members) {
      const lagA = (a.lags || []).find((l) => l.ports.map(Number).includes(Number(link.fromPort)));
      const lagB = (b.lags || []).find((l) => l.ports.map(Number).includes(Number(link.toPort)));
      const aLbl = lagA?.name || '?';
      const bLbl = lagB?.name || '?';
      const lbl = `${aLbl} ⇄ ${bLbl} · ×${bundleInfo.members.length}`;
      inner += `<text class="m002-link-bundle-label" x="${base.lx}" y="${base.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(lbl)}</text>`;
      // LAG accent — parallel double-line on top of the VLAN stripes
      inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.4, gap: 5 });
    }
  } else if (layer === 'routing') {
    if (bundleInfo?.members) {
      const lagA = (a.lags || []).find((l) => l.ports.map(Number).includes(Number(link.fromPort)));
      const lagB = (b.lags || []).find((l) => l.ports.map(Number).includes(Number(link.toPort)));
      const aLbl = lagA?.name || '?';
      const bLbl = lagB?.name || '?';
      inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 2 });
      inner += `<text class="m002-link-bundle-label" x="${base.lx}" y="${base.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(`${aLbl} ⇄ ${bLbl} · ×${bundleInfo.members.length}`)}</text>`;
    } else {
      inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#3a3a44" stroke-dasharray="4 3"/>`;
    }
  } else {
    inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8"/>`;
    const lagA = (a.lags || []).find((l) => l.ports.map(Number).includes(Number(link.fromPort)));
    const lagB = (b.lags || []).find((l) => l.ports.map(Number).includes(Number(link.toPort)));
    const fromTxt = link.fromPort ? portLabel(a, link.fromPort) + (lagA ? ` (${lagA.name})` : '') : '';
    const toTxt   = link.toPort   ? portLabel(b, link.toPort)   + (lagB ? ` (${lagB.name})` : '') : '';
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
  clearMultiSelection(s);
  showInspectorEmpty(s);
}

function markSelected(s) {
  s.host.querySelectorAll('.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
  refreshMultiSelectClasses(s);
  if (!s.selected) return;
  if (s.selected.kind === 'device') {
    s.gDevices.querySelector(`[data-device-id="${s.selected.id}"]`)?.classList.add('m002-selected');
  } else if (s.selected.kind === 'link') {
    s.gLinks.querySelector(`[data-link-id="${s.selected.id}"]`)?.classList.add('m002-selected');
  } else if (s.selected.kind === 'stack') {
    // Could be collapsed (icon in gDevices) or expanded (envelope in gStacksBg)
    s.gDevices.querySelector(`[data-stack-id="${s.selected.id}"]`)?.classList.add('m002-selected');
    s.gStacksBg.querySelector(`[data-stack-id="${s.selected.id}"]`)?.classList.add('m002-selected');
  } else if (s.selected.kind === 'lag') {
    // Highlight the LAG-bundle on canvas (rendered as a single laglink path)
    s.gLinks.querySelector(`[data-laglink-id="${s.selected.id}"]`)?.classList.add('m002-selected');
  }
}

function renderInspectorVlanPickers(s) {
  s.inspector?.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
}

function refreshToolHighlights(s) {
  const setActive = (sel, on) => s.host.querySelector(sel)?.classList.toggle('active', !!on);
  setActive('[data-tool="link"]',  s.linkMode);
  setActive('[data-tool="stack"]', s.stackMode);
  setActive('[data-tool="select"]', !s.linkMode && !s.stackMode);
}

function showInspectorEmpty(s) {
  const body = s.inspector.querySelector('.m002-insp-body');
  const idEl = s.inspector.querySelector('.m002-insp-id');
  idEl.textContent = '// INSPECT';
  body.innerHTML = `
    <div class="m002-insp-empty">
      <div class="m002-insp-empty-title">SELECT A NODE</div>
      <ul class="m002-insp-empty-hints">
        <li>CLICK to select</li>
        <li>DRAG to move</li>
        <li>SHIFT+CLICK = multi-select</li>
        <li>DRAG ONTO NODE = group</li>
      </ul>
    </div>
  `;
}

function openInspector(s) {
  if (!s.selected) { showInspectorEmpty(s); return; }
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
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="device:${escAttr(dev.id)}"></div>
      </div>
      <div class="m002-ports-block">
        <div class="m002-ports-head">LAGS (${(dev.lags || []).length})</div>
        <div class="m002-ports-grid">
          <div class="m002-lagtable-head">
            <span>NAME</span><span>PORTS</span><span>COUNTERPART</span>
          </div>
          ${(dev.lags || []).map((lag) => {
            const cp = lagCounterpart(s, dev.id, lag);
            const cpTxt = cp
              ? (cp.lag ? `${cp.dev.name} · ${cp.lag.name}` : `${cp.dev.name} · ${cp.count}p`)
              : '—';
            return `
            <div class="m002-lagtable-row" data-lag-row="${escAttr(lag.id)}" tabindex="0">
              <span class="m002-lagtable-name">${escSvg(lag.name)}</span>
              <span class="m002-lagtable-ports">${lag.ports.join(', ') || '—'}</span>
              <span class="m002-lagtable-cp ${cp ? '' : 'dim'}" title="${escAttr(cpTxt)}">${escSvg(cpTxt)}</span>
            </div>`;
          }).join('') || '<span class="m002-vlan-empty">no LAGs</span>'}
        </div>
        <button type="button" class="m002-action" data-newlag>+ NEW LAG</button>
      </div>
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
    body.querySelector('[data-newlag]')?.addEventListener('click', () => openLagModal(s, dev.id));
    body.querySelectorAll('[data-lag-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        snapshot(s);
        dev.lags = dev.lags.filter((l) => l.id !== b.dataset.lagRm);
        schedSave(s);
        render(s);
        openInspector(s);
      });
    });
    body.querySelectorAll('[data-lag-row]').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-lag-rm]')) return;
        select(s, 'lag', `${dev.id}|${row.dataset.lagRow}`);
      });
    });
    renderInspectorVlanPickers(s);
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
      <div class="m002-field">
        <span>VLANS (port-pair)</span>
        <div class="m002-vlan-picker" data-vlan-target="link:${escAttr(link.id)}"></div>
      </div>
      <p class="m002-link-hint">Aktivierte VLANs werden auf beide Ports gesetzt. Es erscheinen nur VLANs, die auf beiden Devices verfügbar sind.</p>
      <button type="button" class="m002-insp-del" data-del>DELETE LINK</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => updateLinkField(s, link, el));
      el.addEventListener('change', () => updateLinkField(s, link, el));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
    renderInspectorVlanPickers(s);
  } else if (s.selected.kind === 'stack') {
    const stack = findStackById(s, s.selected.id);
    if (!stack) return;
    idEl.textContent = `// STACK · ×${stack.members.length}`;
    body.innerHTML = `
      <label class="m002-field"><span>NAME</span><input data-sf="name" value="${escAttr(stack.name)}"/></label>
      <div class="m002-field">
        <span>VIEW</span>
        <button type="button" class="m002-action" data-stk="toggle">
          ${stack.expanded ? '▴ COLLAPSE' : '▾ EXPAND'}
        </button>
      </div>
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="stack:${escAttr(stack.id)}"></div>
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
      <p class="m002-link-hint">Doppelklick auf den Stack zum Aus-/Einklappen. Jeder Layer kann unabhängig expandiert werden.</p>
      <button type="button" class="m002-insp-del" data-del>UNGROUP STACK</button>
    `;
    body.querySelector('[data-sf="name"]').addEventListener('input', (e) => {
      stack.name = e.target.value;
      const g = s.gDevices.querySelector(`[data-stack-id="${stack.id}"] .m002-dev-name`);
      if (g) g.textContent = stack.name;
      schedSave(s);
    });
    body.querySelector('[data-stk="toggle"]').addEventListener('click', () => {
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
    renderInspectorVlanPickers(s);
  } else if (s.selected.kind === 'lag') {
    // LAG editor — link-style layout: header showing both endpoints,
    // FROM LAG / TO LAG selectors, VLANs, then secondary fields below.
    const [devId, lagId] = String(s.selected.id).split('|');
    const dev = s.devices.find((d) => d.id === devId);
    const lag = dev?.lags?.find((l) => l.id === lagId);
    if (!dev || !lag) {
      if (dev) { select(s, 'device', dev.id); return; }
      deselect(s); return;
    }

    const cp = lagCounterpart(s, devId, lag);
    const peerDev = cp?.dev || null;
    const peerLag = cp?.lag || null;

    // FROM-LAG options: every LAG on this device (lets you switch sibling LAGs).
    const fromOpts = (dev.lags || []).map((l) => ({ id: l.id, label: l.name }));

    // TO-LAG options: every LAG on every device this device has a link to.
    const linkedDevs = new Map();
    s.links.forEach((l) => {
      let other = null;
      if (l.from === devId) other = s.devices.find((d) => d.id === l.to);
      else if (l.to === devId) other = s.devices.find((d) => d.id === l.from);
      if (other && !linkedDevs.has(other.id)) linkedDevs.set(other.id, other);
    });
    const toOpts = [...linkedDevs.values()].flatMap((d) =>
      (d.lags || []).map((l) => ({ devId: d.id, devName: d.name, lagId: l.id, lagName: l.name }))
    );
    const toKey = lag.counterpart?.lagId
      ? `${lag.counterpart.deviceId}|${lag.counterpart.lagId}`
      : '';

    const otherLagPorts = new Set();
    dev.lags.forEach((l) => { if (l !== lag) l.ports.forEach((n) => otherLagPorts.add(Number(n))); });
    const lagPortSet = new Set(lag.ports.map(Number));

    idEl.textContent = `// ${dev.name} · ${lag.name}`;
    body.innerHTML = `
      <button type="button" class="m002-insp-back" data-back>← BACK TO ${escSvg(dev.name.toUpperCase())}</button>
      <div class="m002-link-summary">
        <span class="m002-link-end">${escSvg(dev.name)}</span>
        <span class="m002-link-arrow">⇄</span>
        <span class="m002-link-end ${peerDev ? '' : 'dim'}">${escSvg(peerDev?.name || '—')}</span>
      </div>
      <div class="m002-row2">
        <label class="m002-field"><span>FROM LAG</span>
          <select data-lf="from">
            ${fromOpts.map((o) => `<option value="${escAttr(o.id)}" ${o.id === lag.id ? 'selected' : ''}>${escSvg(o.label)}</option>`).join('')}
          </select>
        </label>
        <label class="m002-field"><span>TO LAG</span>
          <select data-lf="to">
            <option value="">— auto / none —</option>
            ${toOpts.map((o) => `<option value="${escAttr(o.devId + '|' + o.lagId)}" ${toKey === (o.devId + '|' + o.lagId) ? 'selected' : ''}>${escSvg(o.devName)} · ${escSvg(o.lagName)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="m002-field">
        <span>VLANS (lag-pair)</span>
        <div class="m002-vlan-picker" data-vlan-target="lag:${escAttr(devId)}:${escAttr(lag.id)}"></div>
      </div>
      ${!toOpts.length ? `<p class="m002-link-hint">No LAGs found on linked devices — create one over there first to pair.</p>` : (lag.counterpart ? '' : (peerLag ? `<p class="m002-link-hint">Auto-derived from port links. Pick "TO LAG" to lock it manually.</p>` : ''))}

      <div class="m002-lag-props">
        <label class="m002-field"><span>NAME</span>
          <input class="m002-lagm-name" value="${escAttr(lag.name)}" placeholder="e.g. Po1, LAG-CORE"/>
        </label>
        <div class="m002-field">
          <span>MEMBER PORTS (${dev.ports.length})</span>
          <div class="m002-lagm-ports">
            ${dev.ports.map((p) => {
              const inUse = otherLagPorts.has(p.n);
              const checked = lagPortSet.has(p.n);
              return `<label class="m002-lagm-port ${inUse ? 'disabled' : ''}" title="${inUse ? 'already in another LAG' : ''}">
                <input type="checkbox" data-port="${p.n}" ${checked ? 'checked' : ''} ${inUse ? 'disabled' : ''}/>
                <span>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</span>
              </label>`;
            }).join('')}
          </div>
        </div>
      </div>

      <button type="button" class="m002-insp-del" data-lact="delete">DELETE LAG</button>
    `;
    renderInspectorVlanPickers(s);

    body.querySelector('[data-back]')?.addEventListener('click', () => {
      select(s, 'device', devId);
    });

    // FROM LAG: switch which sibling LAG is being edited.
    body.querySelector('[data-lf="from"]')?.addEventListener('change', (e) => {
      const newId = e.target.value;
      if (newId && newId !== lag.id) select(s, 'lag', `${devId}|${newId}`);
    });

    // TO LAG: pick / unpick the counterpart. Mirrors what the old COUNTERPART
    // select did, with reciprocal pairing on the peer LAG.
    body.querySelector('[data-lf="to"]')?.addEventListener('change', (e) => {
      snapshot(s);
      // Detach previous reciprocal pointer
      if (lag.counterpart?.lagId) {
        const oldDev = s.devices.find((d) => d.id === lag.counterpart.deviceId);
        const oldLag = oldDev?.lags?.find((ll) => ll.id === lag.counterpart.lagId);
        if (oldLag?.counterpart?.lagId === lag.id) delete oldLag.counterpart;
      }
      const v = e.target.value;
      if (!v) { delete lag.counterpart; }
      else {
        const [oDevId, oLagId] = v.split('|');
        lag.counterpart = { deviceId: oDevId, lagId: oLagId };
        const otherDev = s.devices.find((d) => d.id === oDevId);
        const otherLag = otherDev?.lags?.find((ll) => ll.id === oLagId);
        if (otherLag) otherLag.counterpart = { deviceId: devId, lagId: lag.id };
      }
      schedSave(s);
      render(s);
      openInspector(s);
    });

    // NAME — live edit. Empty name is rejected on blur (revert).
    const nameEl = body.querySelector('.m002-lagm-name');
    nameEl?.addEventListener('input', () => {
      const v = nameEl.value.trim();
      if (!v) return; // wait for blur to validate
      lag.name = v;
      idEl.textContent = `// ${dev.name} · ${lag.name}`;
      schedSave(s);
    });
    nameEl?.addEventListener('blur', () => {
      if (!nameEl.value.trim()) {
        nameEl.value = lag.name;
        toast(s, 'LAG name cannot be empty');
      } else {
        // Redraw canvas labels referencing LAG name
        render(s);
      }
    });

    // PORT checkboxes — live edit with the 2-port minimum guard.
    body.querySelectorAll('.m002-lagm-ports input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const ports = [...body.querySelectorAll('.m002-lagm-ports input[type=checkbox]:checked')]
          .map((c) => Number(c.dataset.port));
        if (ports.length < 2) {
          // Revert and warn
          cb.checked = !cb.checked;
          toast(s, 'LAG needs at least 2 ports');
          return;
        }
        snapshot(s);
        lag.ports = ports;
        schedSave(s);
        render(s);
      });
    });

    body.querySelector('[data-lact="delete"]')?.addEventListener('click', () => {
      snapshot(s);
      if (lag.counterpart?.lagId) {
        const oDev = s.devices.find((d) => d.id === lag.counterpart.deviceId);
        const oLag = oDev?.lags?.find((ll) => ll.id === lag.counterpart.lagId);
        if (oLag?.counterpart?.lagId === lag.id) delete oLag.counterpart;
      }
      dev.lags = dev.lags.filter((l) => l.id !== lag.id);
      schedSave(s);
      render(s);
      select(s, 'device', dev.id);
    });
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
  snapshot(s);
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
  } else if (s.selected.kind === 'lag') {
    const [devId, lagId] = String(s.selected.id).split('|');
    const dev = s.devices.find((d) => d.id === devId);
    const lag = dev?.lags?.find((l) => l.id === lagId);
    if (dev && lag) {
      // Drop reciprocal counterpart pointer first
      if (lag.counterpart?.lagId) {
        const oDev = s.devices.find((d) => d.id === lag.counterpart.deviceId);
        const oLag = oDev?.lags?.find((ll) => ll.id === lag.counterpart.lagId);
        if (oLag?.counterpart?.lagId === lag.id) delete oLag.counterpart;
      }
      dev.lags = dev.lags.filter((l) => l.id !== lag.id);
    }
    render(s);
    schedSave(s);
    if (dev) select(s, 'device', dev.id); else deselect(s);
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

  // Find which LAG (if any) this port belongs to
  const portLag = (dev.lags || []).find((lag) => lag.ports.includes(portN));
  const otherLags = (dev.lags || []).filter((lag) => lag !== portLag && !lag.ports.includes(portN));

  body.innerHTML = `
    <label class="m002-field"><span>PORT NAME</span>
      <input class="m002-pmodal-name" value="${escAttr(port.name)}" placeholder="e.g. GE0/0/1"/>
    </label>
    <div class="m002-field">
      <span>COUNTERPART</span>
      ${(() => {
        // Counterpart is "the other end of the link this port is on", picked
        // from any port on devices currently linked to this device.
        const linkedDevs = new Map();
        s.links.forEach((l) => {
          let other = null;
          if (l.from === deviceId) other = s.devices.find((d) => d.id === l.to);
          else if (l.to === deviceId) other = s.devices.find((d) => d.id === l.from);
          if (other && !linkedDevs.has(other.id)) linkedDevs.set(other.id, other);
        });
        const opts = [...linkedDevs.values()].flatMap((d) =>
          (d.ports || []).map((p) => ({ devId: d.id, devName: d.name, portN: p.n, portName: p.name }))
        );
        let curKey = '';
        if (link) {
          const otherId = link.from === deviceId ? link.to : link.from;
          const otherPort = link.from === deviceId ? link.toPort : link.fromPort;
          if (otherPort) curKey = otherId + ':' + otherPort;
        }
        if (!opts.length) return `<div class="m002-port-counter dim">— not connected —</div>`;
        return `<select class="m002-pmodal-cp">
          <option value="">— not connected —</option>
          ${opts.map((o) => `<option value="${escAttr(o.devId + ':' + o.portN)}" ${curKey === (o.devId + ':' + o.portN) ? 'selected' : ''}>${escSvg(o.devName)} · ${o.portN}${o.portName ? ' · ' + escAttr(o.portName) : ''}</option>`).join('')}
        </select>`;
      })()}
    </div>
    <div class="m002-field">
      <span>VLANS (port)</span>
      <div class="m002-vlan-picker" data-vlan-target="port:${escAttr(deviceId)}:${portN}"></div>
    </div>
    <div class="m002-field">
      <span>LAG</span>
      <div class="m002-port-lag-row">
        ${portLag ? `<span class="m002-vlan-chip-btn on" style="--vc:#ff003c">${escSvg(portLag.name)}</span><button type="button" class="m002-action" data-pact="lag-remove">REMOVE</button>` : ''}
        ${otherLags.length ? `<select class="m002-port-lag-select"><option value="">— assign to LAG —</option>${otherLags.map((l) => `<option value="${escAttr(l.id)}">${escSvg(l.name)}</option>`).join('')}</select>` : (!portLag ? `<span class="m002-vlan-empty">no LAGs on this device — create one in the inspector</span>` : '')}
      </div>
    </div>
    <div class="m002-port-actions">
      ${link ? `<button type="button" class="m002-action" data-pact="unlink">DISCONNECT LINK</button>` : ''}
      <button type="button" class="m002-action danger" data-pact="delete">DELETE PORT</button>
    </div>
  `;
  renderInspectorVlanPickers(s); // also covers the port-modal's picker (it's a .m002-vlan-picker too — but inside the modal, not inspector). Re-call directly:
  body.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));

  // Port counterpart wiring — change rewires the underlying link so the peer
  // sees the same counterpart automatically (link is symmetric).
  body.querySelector('.m002-pmodal-cp')?.addEventListener('change', (e) => {
    const v = e.target.value;
    snapshot(s);
    if (!v) {
      // Disconnect: remove this port from the link if present
      if (link) {
        if (link.from === deviceId) link.fromPort = '';
        else                         link.toPort = '';
      }
    } else {
      const [otherId, otherPortN] = v.split(':');
      // Find an existing link to that device, or reuse current link if already to that device
      let target = link && (link.from === otherId || link.to === otherId) ? link
                  : s.links.find((l) => (l.from === deviceId && l.to === otherId) || (l.to === deviceId && l.from === otherId));
      if (!target) { toast(s, 'No link to that device — create one first via LINK tool'); return; }
      if (target.from === deviceId) { target.fromPort = String(portN); target.toPort = otherPortN; }
      else                          { target.toPort   = String(portN); target.fromPort = otherPortN; }
    }
    schedSave(s);
    render(s);
    openPortModal(s, deviceId, portN);
  });

  // LAG wiring
  body.querySelector('[data-pact="lag-remove"]')?.addEventListener('click', () => {
    snapshot(s);
    portLag.ports = portLag.ports.filter((n) => n !== portN);
    if (portLag.ports.length === 0) dev.lags = dev.lags.filter((l) => l !== portLag);
    schedSave(s);
    render(s);
    openPortModal(s, deviceId, portN);
  });
  body.querySelector('.m002-port-lag-select')?.addEventListener('change', (e) => {
    const lagId = e.target.value;
    if (!lagId) return;
    const lag = (dev.lags || []).find((l) => l.id === lagId);
    if (!lag) return;
    snapshot(s);
    if (portLag) portLag.ports = portLag.ports.filter((n) => n !== portN);
    if (!lag.ports.includes(portN)) lag.ports.push(portN);
    schedSave(s);
    render(s);
    openPortModal(s, deviceId, portN);
  });

  body.querySelector('.m002-pmodal-name').addEventListener('input', (e) => {
    port.name = e.target.value;
    schedSave(s);
    s.links.filter((l) => (l.from === deviceId && Number(l.fromPort) === portN) || (l.to === deviceId && Number(l.toPort) === portN))
          .forEach((l) => redrawLink(s, l));
    const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
    if (row) row.value = port.name;
  });

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

function openLagModal(s, deviceId, lagId) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return;
  if (!Array.isArray(dev.lags)) dev.lags = [];
  const editing = lagId ? dev.lags.find((l) => l.id === lagId) : null;
  const initialName = editing ? editing.name : `Po${dev.lags.length + 1}`;
  const initialPorts = new Set((editing ? editing.ports : []).map(Number));
  // Free ports = all ports not in another LAG
  const otherLagPorts = new Set();
  dev.lags.forEach((l) => { if (l !== editing) l.ports.forEach((n) => otherLagPorts.add(Number(n))); });

  const modal = s.host.querySelector('.m002-lag-modal');
  const idEl = modal.querySelector('.m002-port-modal-id');
  const body = modal.querySelector('.m002-lag-modal-body');
  idEl.textContent = `// ${dev.name} · ${editing ? 'EDIT LAG' : 'NEW LAG'}`;

  const cp = editing ? lagCounterpart(s, deviceId, editing) : null;
  const cpTxt = cp ? (cp.lag ? `${cp.dev.name} · ${cp.lag.name}` : `${cp.dev.name} · ${cp.count}p`) : '— not connected —';

  // Counterpart options: every LAG on every device that has at least one
  // link to this device. Picking one stores `lag.counterpart = { deviceId,
  // lagId }` and reciprocally pairs the peer LAG.
  const linkedDevs = new Map();
  s.links.forEach((l) => {
    let other = null;
    if (l.from === deviceId) other = s.devices.find((d) => d.id === l.to);
    else if (l.to === deviceId) other = s.devices.find((d) => d.id === l.from);
    if (other && !linkedDevs.has(other.id)) linkedDevs.set(other.id, other);
  });
  const cpOptions = [...linkedDevs.values()].flatMap((d) =>
    (d.lags || []).map((l) => ({ devId: d.id, devName: d.name, lagId: l.id, lagName: l.name }))
  );
  const cpKey = editing?.counterpart?.lagId ? `${editing.counterpart.deviceId}|${editing.counterpart.lagId}` : '';

  body.innerHTML = `
    <label class="m002-field"><span>NAME</span>
      <input class="m002-lagm-name" value="${escAttr(initialName)}" placeholder="e.g. Po1, LAG-CORE"/>
    </label>
    <div class="m002-field">
      <span>MEMBER PORTS (${dev.ports.length})</span>
      <div class="m002-lagm-ports">
        ${dev.ports.map((p) => {
          const inUse = otherLagPorts.has(p.n);
          const checked = initialPorts.has(p.n);
          return `<label class="m002-lagm-port ${inUse ? 'disabled' : ''}" title="${inUse ? 'already in another LAG' : ''}">
            <input type="checkbox" data-port="${p.n}" ${checked ? 'checked' : ''} ${inUse ? 'disabled' : ''}/>
            <span>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</span>
          </label>`;
        }).join('')}
      </div>
    </div>
    ${editing ? `
      <div class="m002-field">
        <span>COUNTERPART</span>
        <div class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cpTxt)} ${editing.counterpart ? '· (manual)' : '· (auto)'}</div>
        <select class="m002-lagm-cp">
          <option value="">— auto-derive from links —</option>
          ${cpOptions.map((o) => `<option value="${escAttr(o.devId + '|' + o.lagId)}" ${cpKey === (o.devId + '|' + o.lagId) ? 'selected' : ''}>${escSvg(o.devName)} · ${escSvg(o.lagName)}</option>`).join('')}
        </select>
        <p class="m002-link-hint">${cpOptions.length ? 'Pick the matching LAG on the peer side. The other LAG will be paired automatically.' : 'No LAGs found on linked devices — create one over there first.'}</p>
      </div>
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="lag:${escAttr(deviceId)}:${escAttr(editing.id)}"></div>
      </div>
    ` : ''}
    <div class="m002-port-actions">
      ${editing ? `<button type="button" class="m002-action danger" data-lact="delete">DELETE LAG</button>` : ''}
      <button type="button" class="m002-action" data-lact="save">${editing ? 'SAVE' : 'CREATE'}</button>
    </div>
  `;
  // VLAN picker is a `lag:<deviceId>:<lagId>` target — wire up via existing helper
  body.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
  body.querySelector('.m002-lagm-cp')?.addEventListener('change', (e) => {
    if (!editing) return;
    snapshot(s);
    // Drop any reciprocal pointer the previous counterpart held back
    if (editing.counterpart?.lagId) {
      const oldDev = s.devices.find((d) => d.id === editing.counterpart.deviceId);
      const oldLag = oldDev?.lags?.find((ll) => ll.id === editing.counterpart.lagId);
      if (oldLag?.counterpart?.lagId === editing.id) delete oldLag.counterpart;
    }
    const v = e.target.value;
    if (!v) { delete editing.counterpart; }
    else {
      const [devId, lagId] = v.split('|');
      editing.counterpart = { deviceId: devId, lagId };
      // Reciprocal pairing
      const otherDev = s.devices.find((d) => d.id === devId);
      const otherLag = otherDev?.lags?.find((ll) => ll.id === lagId);
      if (otherLag) otherLag.counterpart = { deviceId, lagId: editing.id };
    }
    schedSave(s);
    render(s);
  });
  modal.hidden = false;
  setTimeout(() => body.querySelector('.m002-lagm-name')?.focus(), 30);

  body.querySelector('[data-lact="save"]')?.addEventListener('click', () => {
    const name = (body.querySelector('.m002-lagm-name').value || '').trim();
    const ports = [...body.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.dataset.port));
    if (!name) { toast(s, 'LAG needs a name'); return; }
    if (ports.length < 2) { toast(s, 'LAG needs at least 2 ports'); return; }
    snapshot(s);
    if (editing) {
      editing.name = name;
      editing.ports = ports;
    } else {
      dev.lags.push({ id: 'lag_' + rid(), name, ports });
    }
    closeLagModal(s);
    schedSave(s);
    render(s);
    openInspector(s);
  });
  body.querySelector('[data-lact="delete"]')?.addEventListener('click', () => {
    snapshot(s);
    dev.lags = dev.lags.filter((l) => l.id !== editing.id);
    closeLagModal(s);
    schedSave(s);
    render(s);
    openInspector(s);
  });
}

function closeLagModal(s) {
  const modal = s.host?.querySelector('.m002-lag-modal');
  if (modal) modal.hidden = true;
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

  // Filter by active zone — devices/stacks/links outside the active zone hide.
  const inZone = (entity) => !s.activeZone || !entity.zone || entity.zone === s.activeZone;

  // Stack envelopes (only when expanded)
  s.stacks.forEach((st) => { if (inZone(st) && !isStackCollapsed(s, st)) drawStackEnvelope(s, st); });

  // Detect explicit LAG pairs (counterpart set on at least one side). Their
  // underlying port-links are absorbed and rendered as a single LAG-link
  // visual in every layer.
  const lagPairs = [];
  const lagPairSeen = new Set();
  s.devices.forEach((d) => {
    (d.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const otherDev = s.devices.find((dd) => dd.id === lag.counterpart.deviceId);
      const otherLag = otherDev?.lags?.find((ll) => ll.id === lag.counterpart.lagId);
      if (!otherDev || !otherLag) return;
      const key = [d.id + ':' + lag.id, otherDev.id + ':' + otherLag.id].sort().join('::');
      if (lagPairSeen.has(key)) return;
      lagPairSeen.add(key);
      lagPairs.push({ devA: d, lagA: lag, devB: otherDev, lagB: otherLag });
    });
  });
  // Absorb every link between two devices that have a paired LAG between
  // them. Links here are the abstract "these belong together" markers — once
  // the LAG-pair exists, the LAG visual *is* the connection. Earlier this
  // matched only port-by-port, which left untouched all links without port
  // assignments (the common case) and produced ghost lines next to the LAG.
  const absorbed = new Set();
  const pairedDevPairs = new Set(
    lagPairs.map((p) => [p.devA.id, p.devB.id].sort().join('::'))
  );
  s.links.forEach((l) => {
    const key = [l.from, l.to].sort().join('::');
    if (pairedDevPairs.has(key)) absorbed.add(l.id);
  });

  // Compute LAG bundles (only in logical layers, for non-paired LAGs). Per
  // render pass we mark which links are absorbed into a bundle so we don't
  // render them twice.
  const bundleByLink = new Map();
  if (s.activeLayer !== 'physical') {
    const groups = new Map();
    s.links.forEach((l) => {
      if (absorbed.has(l.id)) return;
      const key = lagBundleKey(s, l);
      if (!key) return;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    });
    groups.forEach((linksInGroup) => {
      if (linksInGroup.length < 1) return;
      const rep = linksInGroup[0];
      bundleByLink.set(rep.id, { members: linksInGroup });
      linksInGroup.slice(1).forEach((l) => bundleByLink.set(l.id, { absorbed: true }));
    });
  }
  s._bundleByLink = bundleByLink;
  s.links.forEach((l) => {
    if (absorbed.has(l.id)) return;
    const a = s.devices.find((d) => d.id === l.from);
    const b = s.devices.find((d) => d.id === l.to);
    if (!a || !b) return;
    if (!inZone(a) || !inZone(b)) return;
    drawLink(s, l);
  });
  s._bundleByLink = null;

  // Explicit LAG-pair links — drawn after regular links so they sit on top.
  lagPairs.forEach((p) => {
    if (!inZone(p.devA) || !inZone(p.devB)) return;
    drawLagLink(s, p);
  });

  // Members of collapsed stacks are not drawn as individual devices.
  const hidden = new Set();
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st)) st.members.forEach((m) => hidden.add(m)); });
  s.devices.forEach((d) => { if (!hidden.has(d.id) && inZone(d)) drawDevice(s, d); });

  // Collapsed stack icons drawn last so they sit on top.
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st) && inZone(st)) drawCollapsedStack(s, st); });

  markSelected(s);
  updateStatus(s);
  renderMinimap(s);
}

function updateStatus(s) {
  s.host.querySelector('.m002-stat-devices').textContent = `${s.devices.length} NODES`;
  s.host.querySelector('.m002-stat-links').textContent = `${s.links.length} LINKS`;
  renderMinimap(s);
}
function setMode(s, txt) {
  s.host.querySelector('.m002-stat-mode').textContent = txt;
}

// =============================================================================
// Persistence (Supabase: m002_maps, RLS-scoped to auth.uid())
// =============================================================================
const ACTIVE_KEY    = (s) => `niven:m002:active:${s.project?.id || s.code}`;
const LEGACY_META   = (s) => `niven:m002:meta:${s.project?.id || s.code}`;
const LEGACY_MAP    = (mapId) => `niven:m002:map:${mapId}`;
const LEGACY_SINGLE = (s) => `niven:m002:${s.project?.id || s.code}`;

function schedSave(s) {
  if (!s.activeMapId || s.suspendSaves) return;
  s.dirty = true;
  clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => saveNow(s), SAVE_DEBOUNCE_MS);
}

function snapshotMapData(s) {
  persistCurrentLayout(s);
  return {
    v: 3,
    devices: s.devices, links: s.links, stacks: s.stacks,
    vlanRegistry: s.vlanRegistry,
    zones: s.zones, activeZone: s.activeZone,
    view: s.view,
  };
}

async function saveNow(s) {
  if (!s.activeMapId || s.suspendSaves) return;
  // Local-only maps (offline mode) — nothing to push.
  if (!s.sb || String(s.activeMapId).startsWith('local_')) { s.dirty = false; return; }
  const data = snapshotMapData(s);
  s.dirty = false;
  try {
    const { error } = await s.sb.from('m002_maps')
      .update({ data })
      .eq('id', s.activeMapId);
    if (error) throw error;
  } catch (e) {
    console.warn('[m002] save failed', e);
    s.dirty = true; // keep flag so a later edit still triggers a retry
    toast(s, 'SYNC FAILED — changes pending');
  }
}

async function loadFromServer(s) {
  if (!s.sb) { initFreshMapLocal(s); toast(s, 'SYNC OFFLINE — local only'); return; }
  s.suspendSaves = true;
  try {
    const { data: rows, error } = await s.sb.from('m002_maps')
      .select('id,name,data')
      .order('created_at', { ascending: true });
    if (error) throw error;

    if (!rows || rows.length === 0) {
      const migrated = await migrateFromLocalStorage(s);
      if (!migrated) await createInitialMap(s);
      return;
    }

    s.maps = rows.map((r) => ({ id: r.id, name: r.name }));
    const remembered = (() => { try { return localStorage.getItem(ACTIVE_KEY(s)); } catch { return null; } })();
    const activeRow = (remembered && rows.find((r) => r.id === remembered)) || rows[0];
    s.activeMapId = activeRow.id;
    hydrateMapData(s, activeRow.data || {});
    rememberActiveMap(s);
  } catch (e) {
    console.warn('[m002] load failed', e);
    toast(s, 'SYNC OFFLINE — local only');
    initFreshMapLocal(s);
  } finally {
    s.suspendSaves = false;
  }
}

async function loadMapData(s, mapId) {
  if (!s.sb || String(mapId).startsWith('local_')) { hydrateMapData(s, {}); return; }
  s.suspendSaves = true;
  try {
    const { data: row, error } = await s.sb.from('m002_maps')
      .select('data').eq('id', mapId).single();
    if (error) throw error;
    hydrateMapData(s, row?.data || {});
  } catch (e) {
    console.warn('[m002] map load failed', e);
    hydrateMapData(s, {});
  } finally {
    s.suspendSaves = false;
  }
}

function hydrateMapData(s, data) {
  s.devices = Array.isArray(data.devices) ? data.devices : [];
  s.links = Array.isArray(data.links) ? data.links : [];
  s.stacks = Array.isArray(data.stacks) ? data.stacks : [];
  s.vlanRegistry = Array.isArray(data.vlanRegistry) ? data.vlanRegistry : [];
  s.zones = Array.isArray(data.zones) && data.zones.length ? data.zones : [{ id: 'z_main', name: 'Main' }];
  s.activeZone = data.activeZone && s.zones.find((z) => z.id === data.activeZone) ? data.activeZone : s.zones[0].id;
  s.view = data.view || { ...DEFAULT_VIEW };
  migrate(s);
}

// One-time migration: scoop pre-cloud localStorage maps and push them up.
async function migrateFromLocalStorage(s) {
  let legacyMaps = [];
  let legacyActive = null;
  try {
    const metaRaw = localStorage.getItem(LEGACY_META(s));
    if (metaRaw) {
      const meta = JSON.parse(metaRaw);
      if (Array.isArray(meta?.maps)) {
        legacyMaps = meta.maps;
        legacyActive = meta.activeMap || null;
      }
    }
    // Even older shape: a single-blob key from before the multi-map era.
    if (!legacyMaps.length) {
      const blob = localStorage.getItem(LEGACY_SINGLE(s));
      if (blob) {
        legacyMaps = [{ id: '__single__', name: 'Main', __blob: blob }];
      }
    }
  } catch (e) { console.warn('[m002] legacy read failed', e); }

  if (!legacyMaps.length) return false;

  const inserted = [];
  for (const m of legacyMaps) {
    let data = {};
    try {
      const raw = m.__blob ?? localStorage.getItem(LEGACY_MAP(m.id));
      if (raw) data = JSON.parse(raw);
    } catch {}
    const { data: row, error } = await s.sb.from('m002_maps')
      .insert({ name: m.name || 'Main', data }).select('id,name,data').single();
    if (error) { console.warn('[m002] migrate row failed', error); continue; }
    inserted.push({ row, legacyId: m.id });
  }
  if (!inserted.length) return false;

  s.maps = inserted.map((it) => ({ id: it.row.id, name: it.row.name }));
  const matchIdx = inserted.findIndex((it) => it.legacyId === legacyActive);
  const activeIt = inserted[matchIdx >= 0 ? matchIdx : 0];
  s.activeMapId = activeIt.row.id;
  hydrateMapData(s, activeIt.row.data || {});
  rememberActiveMap(s);
  toast(s, `Synced ${inserted.length} map${inserted.length === 1 ? '' : 's'} to cloud`);
  return true;
}

async function createInitialMap(s) {
  const { data: row, error } = await s.sb.from('m002_maps')
    .insert({ name: 'Main', data: {} }).select('id,name').single();
  if (error) {
    console.warn('[m002] create initial failed', error);
    initFreshMapLocal(s);
    toast(s, 'SYNC OFFLINE — local only');
    return;
  }
  s.maps = [{ id: row.id, name: row.name }];
  s.activeMapId = row.id;
  hydrateMapData(s, {});
  rememberActiveMap(s);
}

// Fallback for unauthed / network-down boots — strictly in-memory.
function initFreshMapLocal(s) {
  const id = 'local_' + rid();
  s.maps = [{ id, name: 'Main (offline)' }];
  s.activeMapId = id;
  hydrateMapData(s, {});
}

function rememberActiveMap(s) {
  if (!s.activeMapId) return;
  try { localStorage.setItem(ACTIVE_KEY(s), s.activeMapId); } catch {}
}

// =============================================================================
// Maps — switch / create / delete / export / import
// =============================================================================
function refreshMapBar(s) {
  if (!s.mapBtnEl) return;
  const active = s.maps.find((m) => m.id === s.activeMapId);
  s.mapBtnEl.querySelector('.m002-map-name').textContent = active?.name || '—';
}

function toggleMapMenu(s) {
  if (!s.mapMenuEl) return;
  if (!s.mapMenuEl.hidden) { s.mapMenuEl.hidden = true; return; }
  s.mapMenuEl.innerHTML = `
    <div class="m002-menu-section">
      ${s.maps.map((m) => `
        <button type="button" class="m002-menu-item ${m.id === s.activeMapId ? 'active' : ''}" data-mapsel="${escAttr(m.id)}">
          <span>${escSvg(m.name)}</span>
          ${m.id === s.activeMapId ? '<span class="m002-menu-dot"></span>' : ''}
        </button>`).join('')}
    </div>
    <div class="m002-menu-sep"></div>
    <div class="m002-menu-section">
      <button type="button" class="m002-menu-item" data-mapact="new">+ NEW MAP</button>
      <button type="button" class="m002-menu-item" data-mapact="rename">RENAME CURRENT</button>
      <button type="button" class="m002-menu-item danger" data-mapact="delete">DELETE CURRENT</button>
    </div>
    <div class="m002-menu-sep"></div>
    <div class="m002-menu-section">
      <button type="button" class="m002-menu-item" data-mapact="export">EXPORT JSON</button>
      <button type="button" class="m002-menu-item" data-mapact="import">IMPORT JSON</button>
    </div>
  `;
  s.mapMenuEl.querySelectorAll('[data-mapsel]').forEach((b) => {
    b.addEventListener('click', () => { switchMap(s, b.dataset.mapsel); s.mapMenuEl.hidden = true; });
  });
  s.mapMenuEl.querySelectorAll('[data-mapact]').forEach((b) => {
    b.addEventListener('click', () => {
      s.mapMenuEl.hidden = true;
      const act = b.dataset.mapact;
      if (act === 'new') createMap(s);
      else if (act === 'rename') renameCurrentMap(s);
      else if (act === 'delete') deleteCurrentMap(s);
      else if (act === 'export') exportMap(s);
      else if (act === 'import') s.importInputEl.click();
    });
  });
  s.mapMenuEl.hidden = false;
}

async function switchMap(s, mapId) {
  if (!mapId || mapId === s.activeMapId) return;
  await saveNow(s); // flush any pending edits on the outgoing map
  s.activeMapId = mapId;
  await loadMapData(s, mapId);
  applyLayoutForLayer(s);
  applyView(s);
  render(s);
  refreshMapBar(s);
  refreshZoneBar(s);
  rememberActiveMap(s);
}

async function createMap(s) {
  const name = (prompt('New map name:', `Map ${s.maps.length + 1}`) || '').trim();
  if (!name) return;
  await saveNow(s);
  if (!s.sb) {
    // Offline: in-memory only.
    const id = 'local_' + rid();
    s.maps.push({ id, name });
    s.activeMapId = id;
    hydrateMapData(s, {});
  } else {
    const { data: row, error } = await s.sb.from('m002_maps')
      .insert({ name, data: {} }).select('id,name').single();
    if (error) { console.warn('[m002] create failed', error); toast(s, 'Create failed'); return; }
    s.maps.push({ id: row.id, name: row.name });
    s.activeMapId = row.id;
    hydrateMapData(s, {});
  }
  applyLayoutForLayer(s);
  applyView(s);
  render(s);
  refreshMapBar(s);
  refreshZoneBar(s);
  rememberActiveMap(s);
  toast(s, `Map "${name}" created`);
}

async function renameCurrentMap(s) {
  const m = s.maps.find((mm) => mm.id === s.activeMapId);
  if (!m) return;
  const name = (prompt('Rename map:', m.name) || '').trim();
  if (!name) return;
  m.name = name;
  refreshMapBar(s);
  if (!s.sb || String(m.id).startsWith('local_')) return;
  const { error } = await s.sb.from('m002_maps').update({ name }).eq('id', m.id);
  if (error) { console.warn('[m002] rename failed', error); toast(s, 'Rename failed'); }
}

async function deleteCurrentMap(s) {
  if (s.maps.length <= 1) { toast(s, 'Cannot delete the last map'); return; }
  const m = s.maps.find((mm) => mm.id === s.activeMapId);
  if (!m) return;
  if (!confirm(`Delete map "${m.name}"? This cannot be undone.`)) return;
  if (s.sb && !String(m.id).startsWith('local_')) {
    const { error } = await s.sb.from('m002_maps').delete().eq('id', m.id);
    if (error) { console.warn('[m002] delete failed', error); toast(s, 'Delete failed'); return; }
  }
  s.maps = s.maps.filter((mm) => mm.id !== m.id);
  s.activeMapId = s.maps[0].id;
  await loadMapData(s, s.activeMapId);
  applyLayoutForLayer(s);
  applyView(s);
  render(s);
  refreshMapBar(s);
  refreshZoneBar(s);
  rememberActiveMap(s);
}

function exportMap(s) {
  const m = s.maps.find((mm) => mm.id === s.activeMapId);
  if (!m) return;
  const payload = { ...snapshotMapData(s), name: m.name };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${m.name.replace(/[^a-z0-9_-]+/gi, '_')}.netforge.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function importMapFromFile(s, file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      const name = (data.name || file.name.replace(/\.json$/i, '')).slice(0, 60);
      await saveNow(s); // flush current before swap
      if (!s.sb) {
        const id = 'local_' + rid();
        s.maps.push({ id, name });
        s.activeMapId = id;
      } else {
        const { data: row, error } = await s.sb.from('m002_maps')
          .insert({ name, data }).select('id,name').single();
        if (error) { console.warn('[m002] import insert failed', error); toast(s, 'Import failed — server'); return; }
        s.maps.push({ id: row.id, name: row.name });
        s.activeMapId = row.id;
      }
      hydrateMapData(s, data);
      applyLayoutForLayer(s);
      applyView(s);
      render(s);
      refreshMapBar(s);
      refreshZoneBar(s);
      rememberActiveMap(s);
      toast(s, `Imported "${name}"`);
    } catch (e) {
      console.warn('[m002] import failed', e);
      toast(s, 'Import failed — invalid JSON');
    }
  };
  reader.readAsText(file);
}

// =============================================================================
// Zones
// =============================================================================
function refreshZoneBar(s) {
  if (!s.zoneBarEl) return;
  s.zoneBarEl.innerHTML = `
    ${(s.zones || []).map((z) => `
      <button type="button" class="m002-zone-pill ${z.id === s.activeZone ? 'active' : ''}" data-zone="${escAttr(z.id)}">${escSvg(z.name)}</button>
    `).join('')}
    <button type="button" class="m002-zone-add" data-act="new-zone" title="Add zone">+</button>
  `;
}

function switchZone(s, zoneId) {
  if (!zoneId || zoneId === s.activeZone) return;
  s.activeZone = zoneId;
  refreshZoneBar(s);
  render(s);
  schedSave(s);
}

function addZone(s) {
  const name = (prompt('New zone name:', `Zone ${s.zones.length + 1}`) || '').trim();
  if (!name) return;
  const id = 'z_' + rid();
  s.zones.push({ id, name });
  s.activeZone = id;
  refreshZoneBar(s);
  render(s);
  schedSave(s);
}

function zoneContextMenu(s, zoneId) {
  const z = s.zones.find((zz) => zz.id === zoneId);
  if (!z) return;
  const action = prompt(`Zone "${z.name}":\n  r = rename\n  d = delete\nLeave empty to cancel.`);
  if (!action) return;
  if (action.toLowerCase().startsWith('r')) {
    const name = (prompt('Rename zone:', z.name) || '').trim();
    if (!name) return;
    z.name = name;
    refreshZoneBar(s);
    schedSave(s);
  } else if (action.toLowerCase().startsWith('d')) {
    if (s.zones.length <= 1) { toast(s, 'Cannot delete the last zone'); return; }
    if (!confirm(`Delete zone "${z.name}" and everything in it?`)) return;
    snapshot(s);
    s.devices = s.devices.filter((d) => d.zone !== zoneId);
    s.stacks  = s.stacks.filter((st) => st.zone !== zoneId);
    const liveIds = new Set(s.devices.map((d) => d.id));
    s.links = s.links.filter((l) => liveIds.has(l.from) && liveIds.has(l.to));
    s.zones = s.zones.filter((zz) => zz.id !== zoneId);
    s.activeZone = s.zones[0].id;
    refreshZoneBar(s);
    render(s);
    schedSave(s);
  }
}

// Convert legacy schema → current. Idempotent.
function migrate(s) {
  if (!Array.isArray(s.vlanRegistry)) s.vlanRegistry = [];
  if (!Array.isArray(s.zones) || !s.zones.length) s.zones = [{ id: 'z_main', name: 'Main' }];
  if (!s.activeZone || !s.zones.find((z) => z.id === s.activeZone)) s.activeZone = s.zones[0].id;
  const validZoneIds = new Set(s.zones.map((z) => z.id));
  const fallbackZone = s.zones[0].id;
  s.devices.forEach((d) => {
    if (!d.zone || !validZoneIds.has(d.zone)) d.zone = fallbackZone;
    if (TYPE_ALIASES[d.type]) d.type = TYPE_ALIASES[d.type];
    if (!Array.isArray(d.ports)) d.ports = [];
    if (!Array.isArray(d.vlans)) d.vlans = [];
    if (!Array.isArray(d.lags))  d.lags  = [];
    ensureLayouts(d);
    d.ports.forEach((p) => {
      // Restore per-port VLAN list. Old shape `p.vlan` (single string) → array.
      if (!Array.isArray(p.vlans)) {
        p.vlans = (p.vlan != null && p.vlan !== '') ? [String(p.vlan)] : [];
      }
      // Make sure each port-VLAN exists at device level + registry.
      p.vlans = p.vlans.map(String);
      p.vlans.forEach((v) => {
        if (!d.vlans.map(String).includes(v)) d.vlans.push(v);
        vlanRegistryAdd(s, v);
      });
      delete p.vlan;
    });
    // Constrain port.vlans to device.vlans, device.vlans to registry
    const regSet = new Set(s.vlanRegistry.map((r) => String(r.id)));
    d.vlans = d.vlans.map(String).filter((v) => regSet.has(v));
    const devSet = new Set(d.vlans);
    d.ports.forEach((p) => { p.vlans = p.vlans.filter((v) => devSet.has(v)); });
    // Sanity-check lags
    d.lags.forEach((lag) => {
      if (!Array.isArray(lag.ports)) lag.ports = [];
      if (!Array.isArray(lag.vlans)) lag.vlans = [];
      lag.ports = lag.ports.map(Number).filter((n) => d.ports.some((p) => p.n === n));
      // Drop legacy port-based counterparts — only LAG-level pairings supported.
      if (lag.counterpart && (!lag.counterpart.lagId || !lag.counterpart.deviceId)) {
        delete lag.counterpart;
      }
    });
    d.lags = d.lags.filter((lag) => lag.ports.length > 0);
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
      if (!st.zone || !validZoneIds.has(st.zone)) st.zone = fallbackZone;
      delete st.vlans;
      st.members = st.members.filter((m) => live.has(m));
      ensureLayouts(st);
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

// =============================================================================
// Undo / Redo
// =============================================================================
function snapshotPayload(s) {
  return JSON.stringify({
    devices: s.devices, links: s.links, stacks: s.stacks, vlanRegistry: s.vlanRegistry,
  });
}
function snapshot(s) {
  s.undoStack.push(snapshotPayload(s));
  while (s.undoStack.length > s.UNDO_LIMIT) s.undoStack.shift();
  s.redoStack.length = 0;
}
function applySnapshot(s, json) {
  const data = JSON.parse(json);
  s.devices = data.devices || [];
  s.links = data.links || [];
  s.stacks = data.stacks || [];
  s.vlanRegistry = data.vlanRegistry || [];
  applyLayoutForLayer(s);
  vlansChanged(s);
  render(s);
  if (s.selected) {
    const stillExists =
      (s.selected.kind === 'device' && s.devices.some((d) => d.id === s.selected.id)) ||
      (s.selected.kind === 'link'   && s.links.some((l)   => l.id === s.selected.id)) ||
      (s.selected.kind === 'stack'  && s.stacks.some((st) => st.id === s.selected.id));
    if (stillExists) openInspector(s); else deselect(s);
  }
}
function undo(s) {
  if (!s.undoStack.length) { toast(s, 'Nothing to undo'); return; }
  s.redoStack.push(snapshotPayload(s));
  applySnapshot(s, s.undoStack.pop());
  schedSave(s);
}
function redo(s) {
  if (!s.redoStack.length) { toast(s, 'Nothing to redo'); return; }
  s.undoStack.push(snapshotPayload(s));
  applySnapshot(s, s.redoStack.pop());
  schedSave(s);
}
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
.m002-host{position:absolute;inset:0;overflow:hidden;font-family:'Rajdhani',sans-serif;color:#e8e8ee;background:radial-gradient(ellipse at 50% 0%,#0d0d14 0%,#06060a 70%);display:grid;grid-template-columns:220px 1fr 320px;grid-template-rows:1fr;}
.m002-leftpanel{background:rgba(8,8,14,0.92);border-right:1px solid #1a1a22;padding:14px 12px;overflow:hidden;display:flex;flex-direction:column;gap:14px;min-height:0;}
.m002-leftpanel-spacer{flex:0 0 8px;}
.m002-panel-section.m002-panel-section--legend{flex:1 1 auto;min-height:0;overflow:hidden;}
.m002-panel-section.m002-panel-section--legend .m002-vlan-legend-body{flex:1 1 auto;min-height:0;overflow:hidden;}
.m002-rightpanel{background:rgba(8,8,14,0.92);border-left:1px solid #1a1a22;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0;}
.m002-center{position:relative;overflow:hidden;}
.m002-panel-section{display:flex;flex-direction:column;gap:6px;}
.m002-panel-title{margin:0 0 4px 0;font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;font-weight:400;text-transform:uppercase;}
.m002-panel-grid{display:flex;flex-direction:column;gap:3px;}
.m002-panel-hints{display:flex;flex-direction:column;gap:2px;font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:1.4px;padding-top:6px;border-top:1px solid #1a1a22;}
.m002-insp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:240px;text-align:center;color:#5a5f6e;}
.m002-insp-empty-title{font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;color:#7a7f8e;margin-bottom:14px;}
.m002-insp-empty-hints{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.4px;}
.m002-rightpanel .m002-insp-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1a1a22;padding-bottom:8px;}
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
.m002-stack-envelope.m002-selected .m002-stack-env-bg{stroke:#9aa0a8;stroke-width:1.4;filter:drop-shadow(0 0 3px rgba(154,160,168,0.55)) drop-shadow(0 0 9px rgba(154,160,168,0.35));}
.m002-stack-envelope.m002-selected .m002-stack-env-label{fill:#9aa0a8;}
.m002-stack-env-label{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#5a5f6e;letter-spacing:1.5px;}
.m002-stack-cable{stroke:#5a5f6e;stroke-width:1.2;stroke-dasharray:2 3;fill:none;opacity:.6;}

.m002-link-line{stroke-width:1.4;fill:none;}
.m002-link-hit{stroke:transparent;stroke-width:14;fill:none;cursor:pointer;}
.m002-link:hover .m002-link-line{stroke-width:1.8;filter:drop-shadow(0 0 2px rgba(255,255,255,0.55)) drop-shadow(0 0 6px rgba(255,255,255,0.25));}
.m002-link:hover .m002-link-label{filter:drop-shadow(0 0 2px rgba(255,255,255,0.4));}
.m002-link.m002-selected .m002-link-line{stroke:#ffffff!important;stroke-width:2.4;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 10px rgba(255,255,255,0.65));}
.m002-link.m002-selected .m002-link-label{fill:#ffffff!important;}
.m002-link-label{font-size:9px;font-family:'Share Tech Mono',monospace;text-anchor:middle;letter-spacing:1px;}

.m002-palette{display:none;}
.m002-palette-title{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;margin-bottom:6px;}
.m002-pal-btn{flex:0 0 auto;display:flex;align-items:center;gap:10px;background:transparent;border:1px solid transparent;color:#e8e8ee;padding:6px 10px;cursor:pointer;font-family:'Rajdhani',sans-serif;font-size:13px;letter-spacing:1.2px;text-align:left;transition:.15s;line-height:1.2;min-height:30px;}
.m002-panel-section{flex:0 0 auto;}
.m002-panel-grid{flex:0 0 auto;}
.m002-pal-btn:hover{border-color:#ff003c;background:rgba(255,0,60,0.06);}
.m002-pal-btn.ghost{color:#9aa0a8;}
.m002-pal-btn.active{background:rgba(0,212,255,0.1);border-color:#00d4ff;color:#00d4ff;}
.m002-pal-glyph{font-family:'Share Tech Mono',monospace;font-size:18px;width:20px;text-align:center;}
.m002-pal-dot{width:10px;height:10px;background:var(--accent);box-shadow:0 0 4px var(--accent),0 0 10px var(--accent);flex:0 0 auto;margin-left:4px;}
.m002-pal-sep{height:1px;background:#1a1a22;margin:6px 0;}

.m002-layerbar-wrap{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:5;}
.m002-zonebar-wrap{position:absolute;top:18px;right:18px;z-index:5;}
.m002-mapbar{position:relative;display:flex;border-bottom:1px solid #1a1a22;padding-bottom:8px;}
.m002-map-btn{flex:1;display:inline-flex;align-items:center;justify-content:space-between;gap:8px;background:transparent;border:1px solid #1a1a22;color:#e8e8ee;padding:6px 10px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;cursor:pointer;}
.m002-map-btn:hover{border-color:#ff003c;}
.m002-map-label{color:#5a5f6e;}
.m002-map-name{color:#e8e8ee;font-weight:600;}
.m002-map-caret{color:#7a7f8e;}
.m002-map-menu{position:absolute;top:calc(100% + 4px);left:50%;transform:translateX(-50%);background:rgba(10,10,16,0.95);border:1px solid #1a1a22;min-width:220px;backdrop-filter:blur(6px);z-index:200;}
.m002-menu-section{display:flex;flex-direction:column;}
.m002-menu-item{display:flex;justify-content:space-between;align-items:center;background:transparent;border:none;color:#e8e8ee;padding:8px 12px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;cursor:pointer;text-align:left;}
.m002-menu-item:hover{background:rgba(255,0,60,0.08);color:#ff003c;}
.m002-menu-item.active{color:#ff003c;}
.m002-menu-item.danger{color:#ff003c;}
.m002-menu-dot{width:6px;height:6px;background:#ff003c;border-radius:50%;}
.m002-menu-sep{height:1px;background:#1a1a22;}

.m002-zonebar{display:flex;gap:4px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:4px;backdrop-filter:blur(6px);}
.m002-zone-pill{background:transparent;border:1px solid transparent;color:#7a7f8e;padding:4px 10px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.4px;}
.m002-zone-pill:hover{color:#e8e8ee;}
.m002-zone-pill.active{background:rgba(0,212,255,0.08);border-color:#00d4ff;color:#00d4ff;}
.m002-zone-add{background:transparent;border:1px dashed #2a2a36;color:#7a7f8e;padding:4px 8px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:11px;line-height:1;}
.m002-zone-add:hover{border-color:#00d4ff;color:#00d4ff;}

.m002-layerbar{display:flex;gap:6px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:6px;backdrop-filter:blur(6px);}
.m002-layer-pill{background:transparent;border:1px solid transparent;color:#9aa0a8;padding:6px 14px;cursor:pointer;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.6px;}
.m002-layer-pill:hover{color:#e8e8ee;}
.m002-layer-pill.active{background:rgba(255,0,60,0.1);border-color:#ff003c;color:#ff003c;}

.m002-inspector.m002-rightpanel{padding:14px;display:flex;flex-direction:column;gap:10px;}
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
.m002-link-end.dim{color:#5a5f6e;font-weight:400;}
.m002-lag-props{margin-top:4px;padding-top:10px;border-top:1px dashed #1a1a22;display:flex;flex-direction:column;gap:8px;}

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
.m002-insp-back{align-self:flex-start;background:transparent;border:none;color:#7a7f8e;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;padding:2px 0;margin-bottom:2px;}
.m002-insp-back:hover{color:#e8e8ee;}

.m002-multi-selected .m002-dev-bg{stroke-width:2;stroke-dasharray:3 3;}
.m002-multi-selected.m002-stack-collapsed .m002-dev-bg{stroke-dasharray:3 3;}

/* Drag-to-stack: pulse the merge target while a device hovers over it */
.m002-drag-stack-target{animation:m002-merge-pulse .5s ease-in-out infinite alternate!important;}
@keyframes m002-merge-pulse{
  from{filter:drop-shadow(0 0 5px #ff003c) drop-shadow(0 0 14px #ff003c);}
  to  {filter:drop-shadow(0 0 12px #ff003c) drop-shadow(0 0 30px #ff003c);}
}

.m002-lagtable-head{display:grid;grid-template-columns:60px 50px 1fr;gap:6px;align-items:center;font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:1.4px;padding:2px 4px;}
.m002-lagtable-row{display:grid;grid-template-columns:60px 50px 1fr;gap:6px;align-items:center;cursor:pointer;padding:3px 4px;border:1px solid transparent;border-radius:2px;}
.m002-lagtable-row:hover{background:rgba(255,0,60,0.06);border-color:#ff003c;}
.m002-lagtable-name{font-family:'Share Tech Mono',monospace;font-size:11px;color:#e8e8ee;letter-spacing:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-lagtable-ports{font-family:'Share Tech Mono',monospace;font-size:10px;color:#9aa0a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-lagtable-cp{font-family:'Share Tech Mono',monospace;font-size:11px;color:#e8e8ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;}
.m002-lagtable-cp.dim{color:#5a5f6e;}

.m002-lag-line{stroke-linecap:square;}
.m002-link.m002-link-bundle:hover .m002-lag-line{stroke:#e8e8ee;}
.m002-link.m002-selected .m002-lag-line{stroke:#ff003c;}
.m002-lag-modal{position:absolute;inset:0;background:rgba(4,4,8,0.7);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(2px);}
.m002-lag-modal-body{display:flex;flex-direction:column;gap:10px;}
.m002-lagm-ports{display:flex;flex-direction:column;gap:3px;max-height:240px;overflow-y:auto;}
.m002-lagm-port{display:flex;align-items:center;gap:8px;font-family:'Share Tech Mono',monospace;font-size:11px;color:#e8e8ee;cursor:pointer;padding:3px 6px;border:1px solid transparent;}
.m002-lagm-port:hover{background:rgba(255,0,60,0.05);border-color:#1a1a22;}
.m002-lagm-port.disabled{opacity:.4;cursor:not-allowed;}
.m002-lag-modal-close{background:transparent;border:none;color:#9aa0a8;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;}
.m002-lag-modal-close:hover{color:#ff003c;}
.m002-port-lag-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.m002-port-lag-select{flex:1;background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;}
.m002-link-bundle-label{font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:1.5px;font-weight:600;}
.m002-link-bundle .m002-link-hit{stroke-width:18;}

.m002-vlan-chip-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:transparent;border:1px solid #2a2a36;color:#7a7f8e;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;cursor:pointer;transition:.15s;}
.m002-vlan-chip-btn:hover{border-color:var(--vc);color:var(--vc);}
.m002-vlan-chip-btn.on{background:rgba(0,0,0,0.3);border-color:var(--vc);color:var(--vc);box-shadow:0 0 6px var(--vc);}
.m002-vlan-picker{display:flex;flex-wrap:wrap;gap:4px;}
.m002-vlan-legend-rm{background:transparent;border:none;color:var(--vc);cursor:pointer;font-size:13px;line-height:1;padding:0 2px;opacity:.5;}
.m002-vlan-legend-rm:hover{opacity:1;}
.m002-vlan-legend-add{display:flex;gap:4px;margin-top:6px;flex:0 0 auto;align-items:stretch;}
.m002-vlan-legend-input{flex:1;background:#06060a;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;}
.m002-vlan-legend-input:focus{border-color:#ff003c;}
.m002-vlan-legend-add-btn{background:transparent;border:1px solid #ff003c;color:#ff003c;padding:4px 10px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;white-space:nowrap;flex:0 0 auto;align-self:stretch;}
.m002-vlan-legend-add-btn:hover{background:rgba(255,0,60,0.1);}

.m002-minimap{position:absolute;bottom:18px;right:18px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;backdrop-filter:blur(6px);width:180px;z-index:5;}
.m002-minimap[data-mm-state="closed"] .m002-minimap-svg{display:none;}
.m002-minimap-head{display:flex;justify-content:space-between;align-items:center;padding:4px 8px;}
.m002-minimap-title{font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:2px;}
.m002-minimap-toggle{background:transparent;border:none;color:#7a7f8e;cursor:pointer;font-size:11px;line-height:1;padding:0 4px;}
.m002-minimap-toggle:hover{color:#ff003c;}
.m002-minimap-svg{width:100%;height:120px;display:block;cursor:crosshair;background:#06060a;}

.m002-vlan-legend{display:none;}
.m002-vlan-legend-title{display:none;}
.m002-vlan-legend-body{display:flex;flex-direction:column;gap:6px;}
.m002-vlan-legend-list{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px;}
.m002-vlan-row{display:grid;grid-template-columns:8px 28px 1fr 18px;gap:6px;align-items:center;padding:4px 6px;background:#06060a;border:1px solid #1a1a22;}
.m002-vlan-row:hover{border-color:var(--vc);}
.m002-vlan-row-dot{width:8px;height:8px;background:var(--vc);box-shadow:0 0 4px var(--vc),0 0 8px var(--vc);}
.m002-vlan-row-id{font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--vc);letter-spacing:1px;}
.m002-vlan-row-name{background:transparent;border:none;color:#e8e8ee;padding:1px 4px;font-family:'Rajdhani',sans-serif;font-size:12px;outline:none;min-width:0;}
.m002-vlan-row-name:focus{background:rgba(255,255,255,0.04);}
.m002-vlan-row-rm{background:transparent;border:none;color:#5a5f6e;cursor:pointer;font-size:13px;line-height:1;padding:0;}
.m002-vlan-row-rm:hover{color:#ff003c;}
.m002-vlan-legend-list::-webkit-scrollbar{width:6px;}
.m002-vlan-legend-list::-webkit-scrollbar-thumb{background:#1a1a22;}
.m002-vlan-legend-empty{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:1px;}
.m002-vlan-legend-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;background:rgba(0,0,0,0.4);border:1px solid var(--vc);color:var(--vc);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;}
.m002-vlan-legend-dot{width:8px;height:8px;background:var(--vc);box-shadow:0 0 4px var(--vc),0 0 8px var(--vc);}

.m002-statusbar{position:absolute;bottom:16px;left:18px;z-index:5;display:flex;align-items:center;gap:8px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:6px 12px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;color:#9aa0a8;}
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
