// === MOD_002 · NET_FORGE — Radial action menu ===
// Opens on background double-click. 4 outer segments arranged at the cardinal
// directions:
//   N (top)    NEW       → expands inward into a 6-segment device picker
//   E (right)  MOVE      → layer + zone navigation submenu
//   S (bottom) TOOL      → SELECT / LINK / DELETE / UNDO submenu
//   W (left)  UNDO      → step back in history
// Click anywhere outside / ESC dismiss the menu. Submenu picks spawn the
// chosen device at the original double-click world position.
//
// CSS lives in mod_002_netmap.css under .m002-radial / .m002-rad-* rules.
// RADIAL_OUTER_R is duplicated there as the literal 130 / 260 / 406.84
// values — keep both in sync if you change the geometry.
//
// Cross-module deps (callbacks + DEVICE_TYPES + esc helpers) are wired in
// once at module init via configureRadial(). Keeps this module standalone.

const RADIAL_OUTER_R = 130;
const RADIAL_INNER_R = 50;
const RADIAL_GAP_DEG = 4;          // gap between outer-ring segments
const RADIAL_SUB_GAP_DEG = 3;      // gap inside the device submenu

const RADIAL_PRIMARY = [
  { id: 'new',     dir: 'N', center: -90, label: 'NEW',  glyph: '+'  },
  { id: 'move',    dir: 'E', center:   0, label: 'MOVE', glyph: '↦' },
  { id: 'tool',    dir: 'S', center:  90, label: 'TOOL', glyph: '⚙' },
  // W slot drops the user straight into PEN. Once in draw mode, a second
  // right-click opens the pen-mode ring (WIPE/ERASE/TOGGLE/EXIT) instead of
  // re-opening primary — same slot is the entry and exit gesture.
  { id: 'pen-on', dir: 'W', center: 180, label: 'PEN',  glyph: '✎' },
];

// MOVE submenu — switches the active layer or jumps the user into the zone
// picker. Layout matches the user's mental model: physical west (default),
// VLAN north, routing east, zone south.
const RADIAL_MOVE = [
  { id: 'layer:vlan',     dir: 'N', center: -90, label: 'VLAN',     glyph: '≣' },
  { id: 'layer:routing',  dir: 'E', center:   0, label: 'ROUTING',  glyph: '↯' },
  { id: 'zones',          dir: 'S', center:  90, label: 'ZONE',     glyph: '◉' },
  { id: 'layer:physical', dir: 'W', center: 180, label: 'PHYSICAL', glyph: '⌗' },
];

// TOOL submenu — picks an interaction mode. SELECT clears any armed mode
// (the default state, so it acts as a quick "back to neutral"); LINK and
// DELETE arm their respective modes; UNDO steps back. UNDO is reachable
// from both primary and TOOL by design — a future cleanup will dedupe.
const RADIAL_TOOL = [
  { id: 'select', dir: 'N', center: -90, label: 'SELECT', glyph: '↖' },
  { id: 'link',   dir: 'E', center:   0, label: 'LINK',   glyph: '⌇' },
  { id: 'delete', dir: 'S', center:  90, label: 'DELETE', glyph: '×' },
  { id: 'undo',   dir: 'W', center: 180, label: 'UNDO',   glyph: '↶' },
];

// ELEMENT ring — opened on right-click directly on a device. Operates on the
// clicked target (stored at s.radial.target) instead of the world position.
const RADIAL_ELEMENT = [
  { id: 'el-clone',   dir: 'N', center: -90, label: 'CLONE',   glyph: '⎘' },
  { id: 'el-connect', dir: 'E', center:   0, label: 'CONNECT', glyph: '⌇' },
  { id: 'el-delete',  dir: 'S', center:  90, label: 'DELETE',  glyph: '×' },
  { id: 'el-move',    dir: 'W', center: 180, label: 'MOVE',    glyph: '↦' },
];

// STACK ring — opened on right-click on a stack icon / envelope. SPLIT is the
// inverse of stack creation (dissolves the group, keeps members standalone).
const RADIAL_STACK = [
  { id: 'st-clone',  dir: 'N', center: -90, label: 'CLONE',  glyph: '⎘' },
  { id: 'st-split',  dir: 'E', center:   0, label: 'SPLIT',  glyph: '⇄' },
  { id: 'st-delete', dir: 'S', center:  90, label: 'DELETE', glyph: '×' },
  { id: 'st-move',   dir: 'W', center: 180, label: 'MOVE',   glyph: '↦' },
];

// PEN-mode ring — opened on background right-click while a draw tool is
// active. N opens a colour picker submenu; W toggles the canvas visibility;
// E/S are the two erasers. Centre exits draw mode entirely (back to mouse).
const RADIAL_PEN = [
  { id: 'pen-color',  dir: 'N', center: -90, label: 'COLOR',  glyph: '◐' },
  { id: 'pen-wipe',   dir: 'E', center:   0, label: 'WIPE',   glyph: '◯' },
  { id: 'pen-erase',  dir: 'S', center:  90, label: 'ERASE',  glyph: '⌫' },
  { id: 'pen-toggle', dir: 'W', center: 180, label: 'TOGGLE', glyph: '◉' },
];

// Pen-mode COLOUR submenu — five swatches around the ring; centre walks back
// to the pen-mode ring. Same five colours the legacy left-edge toolbar shipped.
const RADIAL_PEN_COLORS = [
  { hex: '#e8e8ee', name: 'WHITE'  },
  { hex: '#ff003c', name: 'RED'    },
  { hex: '#ffae00', name: 'YELLOW' },
  { hex: '#35ff7a', name: 'GREEN'  },
  { hex: '#00d4ff', name: 'CYAN'   },
];

// LINK ring — DELETE south, LAG north (promote this link's ports into a
// LAG on each stacked side; both stacked → LAG-pair with counterparts).
// East/West stay empty — nothing else fits a single-link gesture.
const RADIAL_LINK = [
  { id: 'lk-lag',    dir: 'N', center: -90, label: 'LAG',    glyph: '║' },
  { id: 'lk-delete', dir: 'S', center:  90, label: 'DELETE', glyph: '×' },
];

// --- Dependency injection --------------------------------------------------
// All deps default to no-op stubs so the module is non-crashy if a caller
// forgets to wire them up.

const _deps = {
  clientToWorld:    (s, cx, cy) => ({ x: cx, y: cy }),
  toggleLinkMode:   () => {},
  toggleDeleteMode: () => {},
  undo:             () => {},
  spawnDeviceAt:    () => {},
  switchZone:       () => {},
  escAttr:          (s) => String(s ?? ''),
  escSvg:           (s) => String(s ?? ''),
  // Lazy getter for DEVICE_TYPES — the const is declared in mod_002_netmap.js
  // top-level scope and may not be initialised at the moment configureRadial
  // is called. Reading it lazily at render time sidesteps the TDZ.
  getDeviceTypes:   () => [],
  // Element-radial callbacks (right-click on a device).
  cloneDevice:       () => {},
  moveDeviceToZone:  () => {},
  connectFromDevice: () => {},
  deleteRef:         () => {},
  // Stack-radial callbacks.
  cloneStack:        () => {},
  splitStack:        () => {},
  moveStackToZone:   () => {},
  deleteStack:       () => {},
  // Link-radial callbacks.
  createLagFromLink: () => {},
  // Draw-mode callbacks.
  setDrawTool:           () => {},
  clearDrawTool:         () => {},
  setDrawColor:          () => {},
  toggleDrawingsVisible: () => {},
};

export function configureRadial(deps = {}) {
  Object.assign(_deps, deps);
}

// --- Geometry helpers ------------------------------------------------------

function polarXY(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutArcPath(cx, cy, rIn, rOut, startDeg, endDeg) {
  const sOut = polarXY(cx, cy, rOut, startDeg);
  const eOut = polarXY(cx, cy, rOut, endDeg);
  const sIn  = polarXY(cx, cy, rIn,  endDeg);
  const eIn  = polarXY(cx, cy, rIn,  startDeg);
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return `M ${sOut.x} ${sOut.y}
          A ${rOut} ${rOut} 0 ${large} 1 ${eOut.x} ${eOut.y}
          L ${sIn.x} ${sIn.y}
          A ${rIn} ${rIn} 0 ${large} 0 ${eIn.x} ${eIn.y} Z`;
}

// Glyph + label placement inside a 4-cardinal segment. Stack glyph above label
// at the wedge midline in every direction — uniform layout keeps short labels
// (VLAN, NEW) and long labels (PHYSICAL, ROUTING) reading the same and avoids
// the side-by-side bleed past the outer radius that the E/W axis used to have.
function radialLabelPositions(cx, cy, centerDeg) {
  const mid = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, centerDeg);
  return {
    glyph: { x: mid.x, y: mid.y - 2 },
    label: { x: mid.x, y: mid.y + 14 },
  };
}

// --- Public API ------------------------------------------------------------

export function openRadialMenu(s, clientX, clientY) {
  closeRadialMenu(s);
  const w = _deps.clientToWorld(s, clientX, clientY);
  const hostRect = s.host.getBoundingClientRect();
  // Keep the menu inside the host with a small margin.
  const margin = RADIAL_OUTER_R + 8;
  const localX = Math.max(margin, Math.min(hostRect.width - margin, clientX - hostRect.left));
  const localY = Math.max(margin, Math.min(hostRect.height - margin, clientY - hostRect.top));

  const root = document.createElement('div');
  root.className = 'm002-radial';
  root.style.left = `${localX}px`;
  root.style.top  = `${localY}px`;
  root.dataset.level = 'primary';
  // data-fresh marks the very first open so the build-in animation only runs
  // once. swapRadialContent leaves it alone for re-entries; the back-action
  // handler strips it before swapping primary back in.
  root.dataset.fresh = '1';
  root.innerHTML = renderRadialPrimary();
  s.host.appendChild(root);
  s.radial = { el: root, world: w, level: 'primary' };

  // Animate in next frame so the CSS transition kicks in.
  requestAnimationFrame(() => root.classList.add('m002-radial-in'));

  root.addEventListener('mousedown', (e) => e.stopPropagation());
  // Right-click on the radial itself must not raise the OS context menu —
  // the SVG-level suppressor doesn't fire here because the radial pops up
  // under the cursor and intercepts contextmenu before svg sees it.
  root.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    const seg = e.target.closest('[data-radial-action]');
    if (!seg) return;
    handleRadialAction(s, seg.dataset.radialAction);
  });

  const onDocDown = (e) => {
    if (!s.radial) return;
    if (s.radial.el.contains(e.target)) return;
    closeRadialMenu(s);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && s.radial) {
      e.stopPropagation();
      closeRadialMenu(s);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  s.radial.cleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
}

// Right-click on background while a draw tool is active. Cardinal slots are
// the draw tool roster; centre is MOUSE — exits draw mode entirely. Caller
// (netmap onDown) decides between this and the primary ring based on
// s.drawTool, so the same gesture serves both contexts.
export function openRadialPenMenu(s, clientX, clientY) {
  _openRadialTargeted(s, clientX, clientY, null, 'pen', renderRadialPen());
}

// Right-click directly on a device opens this variant. Identical chrome and
// dismissal logic to openRadialMenu, but the ring is the ELEMENT set and the
// menu carries the target ref so submenu actions know what to operate on.
export function openRadialElementMenu(s, clientX, clientY, target) {
  _openRadialTargeted(s, clientX, clientY, target, 'element', renderRadialElement());
}

// Right-click on a stack envelope or its collapsed icon — same chrome, stack-
// specific action ring, target ref carries the stack id.
export function openRadialStackMenu(s, clientX, clientY, target) {
  _openRadialTargeted(s, clientX, clientY, target, 'stack', renderRadialStack());
}

// Right-click on a link — minimal ring with only DELETE. Other cardinals
// intentionally empty.
export function openRadialLinkMenu(s, clientX, clientY, target) {
  _openRadialTargeted(s, clientX, clientY, target, 'link', renderRadialLink());
}

// Shared opener for every targeted (right-click-on-thing) variant. Identical
// dismissal + event wiring to openRadialMenu — the difference is just which
// HTML body gets injected and which level/target tag the radial carries.
function _openRadialTargeted(s, clientX, clientY, target, level, html) {
  closeRadialMenu(s);
  const w = _deps.clientToWorld(s, clientX, clientY);
  const hostRect = s.host.getBoundingClientRect();
  const margin = RADIAL_OUTER_R + 8;
  const localX = Math.max(margin, Math.min(hostRect.width - margin, clientX - hostRect.left));
  const localY = Math.max(margin, Math.min(hostRect.height - margin, clientY - hostRect.top));

  const root = document.createElement('div');
  root.className = 'm002-radial';
  root.style.left = `${localX}px`;
  root.style.top  = `${localY}px`;
  root.dataset.level = level;
  root.dataset.fresh = '1';
  root.innerHTML = html;
  s.host.appendChild(root);
  s.radial = { el: root, world: w, level, target };

  requestAnimationFrame(() => root.classList.add('m002-radial-in'));

  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); });
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    const seg = e.target.closest('[data-radial-action]');
    if (!seg) return;
    handleRadialAction(s, seg.dataset.radialAction);
  });

  const onDocDown = (e) => {
    if (!s.radial) return;
    if (s.radial.el.contains(e.target)) return;
    closeRadialMenu(s);
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && s.radial) {
      e.stopPropagation();
      closeRadialMenu(s);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);
  s.radial.cleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
}

export function closeRadialMenu(s) {
  if (!s.radial) return;
  const r = s.radial;
  s.radial = null;
  r.cleanup?.();
  r.el.classList.remove('m002-radial-in');
  r.el.classList.add('m002-radial-out');
  setTimeout(() => r.el.remove(), 160);
}

// --- Action dispatch -------------------------------------------------------

function handleRadialAction(s, action) {
  if (action === 'new') {
    showRadialDeviceSubmenu(s);
    return;
  }
  if (action === 'move') {
    showRadialMoveSubmenu(s);
    return;
  }
  if (action === 'tool') {
    showRadialToolSubmenu(s);
    return;
  }
  if (action === 'pen-on') {
    closeRadialMenu(s);
    _deps.setDrawTool(s, 'pen');
    return;
  }
  if (action === 'zones') {
    showRadialZonesSubmenu(s);
    return;
  }
  if (action === 'back') {
    // Returning to primary from any submenu — strip the fresh marker so the
    // build-in animation doesn't replay. The CSS gates the keyframes on
    // [data-fresh]; without it the final UI just appears at full opacity.
    s.radial?.el.removeAttribute('data-fresh');
    swapRadialContent(s, renderRadialPrimary(), 'primary');
    return;
  }
  if (action === 'back-move') {
    swapRadialContent(s, renderRadialMove(), 'move');
    return;
  }
  if (action === 'cancel') {
    // Centre tile in the primary ring. Closes the menu and abandons whatever
    // mode is currently armed — quick "nevermind" gesture in one click.
    if (s.linkMode) _deps.toggleLinkMode(s);
    if (s.deleteMode) _deps.toggleDeleteMode(s);
    closeRadialMenu(s);
    return;
  }
  if (action === 'select') {
    // TOOL submenu's default — clears any armed mode, then dismisses.
    if (s.linkMode) _deps.toggleLinkMode(s);
    if (s.deleteMode) _deps.toggleDeleteMode(s);
    closeRadialMenu(s);
    return;
  }
  if (action === 'link') {
    closeRadialMenu(s);
    if (!s.linkMode) _deps.toggleLinkMode(s);
    return;
  }
  if (action === 'delete') {
    closeRadialMenu(s);
    if (!s.deleteMode) _deps.toggleDeleteMode(s);
    return;
  }
  if (action === 'undo') {
    closeRadialMenu(s);
    _deps.undo(s);
    return;
  }
  if (action.startsWith('spawn:')) {
    const typeId = action.slice('spawn:'.length);
    const w = s.radial?.world;
    closeRadialMenu(s);
    if (w) _deps.spawnDeviceAt(s, typeId, w.x, w.y);
    return;
  }
  if (action.startsWith('layer:')) {
    // Bounce off the existing layer-pill click handler so all the
    // routing-mode auto-expand / view-fx side effects stay centralised.
    const layerId = action.slice('layer:'.length);
    closeRadialMenu(s);
    s.layerBar?.querySelector(`[data-layer="${layerId}"]`)?.click();
    return;
  }
  if (action.startsWith('zone:')) {
    const zoneId = action.slice('zone:'.length);
    closeRadialMenu(s);
    _deps.switchZone(s, zoneId);
    return;
  }
  // --- Element ring (right-click on a device) ---
  if (action === 'el-clone') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'device') _deps.cloneDevice(s, target.id);
    return;
  }
  if (action === 'el-connect') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'device') _deps.connectFromDevice(s, target.id);
    return;
  }
  if (action === 'el-delete') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target) _deps.deleteRef(s, target);
    return;
  }
  if (action === 'el-move') {
    showRadialElementZonesSubmenu(s);
    return;
  }
  if (action === 'back-element') {
    s.radial?.el.removeAttribute('data-fresh');
    swapRadialContent(s, renderRadialElement(), 'element');
    return;
  }
  if (action.startsWith('el-move-zone:')) {
    const zoneId = action.slice('el-move-zone:'.length);
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'device') _deps.moveDeviceToZone(s, target.id, zoneId);
    return;
  }
  // --- Stack ring (right-click on a stack) ---
  if (action === 'st-clone') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'stack') _deps.cloneStack(s, target.id);
    return;
  }
  if (action === 'st-split') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'stack') _deps.splitStack(s, target.id);
    return;
  }
  if (action === 'st-delete') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'stack') _deps.deleteStack(s, target.id);
    return;
  }
  if (action === 'st-move') {
    showRadialStackZonesSubmenu(s);
    return;
  }
  if (action === 'back-stack') {
    s.radial?.el.removeAttribute('data-fresh');
    swapRadialContent(s, renderRadialStack(), 'stack');
    return;
  }
  if (action.startsWith('st-move-zone:')) {
    const zoneId = action.slice('st-move-zone:'.length);
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'stack') _deps.moveStackToZone(s, target.id, zoneId);
    return;
  }
  // --- Link ring (right-click on a link) ---
  if (action === 'lk-delete') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target) _deps.deleteRef(s, target);
    return;
  }
  if (action === 'lk-lag') {
    const target = s.radial?.target;
    closeRadialMenu(s);
    if (target?.kind === 'link') _deps.createLagFromLink(s, target.id);
    return;
  }
  // --- Pen-mode ring (right-click on background while drawing) ---
  if (action === 'pen-color') {
    showRadialPenColorsSubmenu(s);
    return;
  }
  if (action === 'pen-wipe') {
    closeRadialMenu(s);
    _deps.setDrawTool(s, 'wipe');
    return;
  }
  if (action === 'pen-erase') {
    closeRadialMenu(s);
    _deps.setDrawTool(s, 'eraser');
    return;
  }
  if (action === 'pen-toggle') {
    closeRadialMenu(s);
    _deps.toggleDrawingsVisible(s);
    return;
  }
  if (action === 'pen-exit') {
    closeRadialMenu(s);
    _deps.clearDrawTool(s);
    return;
  }
  if (action === 'back-pen') {
    s.radial?.el.removeAttribute('data-fresh');
    swapRadialContent(s, renderRadialPen(), 'pen');
    return;
  }
  if (action.startsWith('pen-color:')) {
    const hex = action.slice('pen-color:'.length);
    closeRadialMenu(s);
    _deps.setDrawColor(s, hex);
    // After picking a colour, drop the user back into PEN so the next
    // gesture writes ink. If they were in WIPE/ERASE, that's almost
    // certainly what they want once they've reached for a colour. Skip
    // the call when already in PEN — setDrawTool toggles same-tool, which
    // would silently exit draw mode here.
    if (s.drawTool !== 'pen') _deps.setDrawTool(s, 'pen');
    return;
  }
}

function showRadialDeviceSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialDevices(), 'devices');
}

function showRadialMoveSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialMove(), 'move');
}

function showRadialToolSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialTool(), 'tool');
}

function showRadialZonesSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialZones(s), 'zones');
}

function showRadialElementZonesSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialElementZones(s), 'el-zones');
}

function showRadialPenColorsSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialPenColors(s), 'pen-colors');
}

function showRadialStackZonesSubmenu(s) {
  if (!s.radial) return;
  swapRadialContent(s, renderRadialStackZones(s), 'st-zones');
}


function swapRadialContent(s, html, level) {
  if (!s.radial) return;
  const r = s.radial.el;
  r.classList.add('m002-radial-swap');
  setTimeout(() => {
    r.innerHTML = html;
    r.dataset.level = level;
    s.radial.level = level;
    r.classList.remove('m002-radial-swap');
  }, 120);
}

// --- Render helpers --------------------------------------------------------

function renderRadialPrimary() {
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_PRIMARY.length) / 2; // 45
  let segs = '';
  RADIAL_PRIMARY.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  // Animation overlay: a centre dot, two vertical lines, and two semicircle
  // arcs that draw in sequence on first open. The arcs and lines are positioned
  // exactly on the outer/cardinal radii so they slot into the final ring outline
  // before fading to invisible. Submenu swaps don't replay this — only the
  // initial m002-radial-in pass does.
  const ARC_R = RADIAL_OUTER_R - 0.5;
  // Sweep flag 0 = counter-clockwise. Top pole arcs down via the LEFT side,
  // bottom pole arcs up via the RIGHT side — both running CCW around the ring.
  const arcRight = `M ${cx} ${cy - ARC_R} A ${ARC_R} ${ARC_R} 0 0 0 ${cx} ${cy + ARC_R}`;
  const arcLeft  = `M ${cx} ${cy + ARC_R} A ${ARC_R} ${ARC_R} 0 0 0 ${cx} ${cy - ARC_R}`;
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-cancel" data-radial-action="cancel">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">CANCEL</text>
      </g>
      ${segs}
      <g class="m002-rad-anim" pointer-events="none">
        <path class="m002-rad-arc m002-rad-arc-r" d="${arcRight}" fill="none"/>
        <path class="m002-rad-arc m002-rad-arc-l" d="${arcLeft}"  fill="none"/>
        <line class="m002-rad-vline m002-rad-vline-up" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - RADIAL_OUTER_R}"/>
        <line class="m002-rad-vline m002-rad-vline-dn" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy + RADIAL_OUTER_R}"/>
        <circle class="m002-rad-dot" cx="${cx}" cy="${cy}" r="3.5"/>
      </g>
    </svg>`;
}

function renderRadialDevices() {
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const types = _deps.getDeviceTypes();
  const N = types.length; // 6
  const slice = 360 / N;
  const half = slice / 2;
  // Place the first slice's center at -90° (top) so the picker reads from top.
  let segs = '';
  types.forEach((t, i) => {
    const center = -90 + i * slice;
    const start = center - half + RADIAL_SUB_GAP_DEG / 2;
    const end   = center + half - RADIAL_SUB_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const labelPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, center);
    const dotPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2 - 16, center);
    segs += `
      <g class="m002-rad-seg m002-rad-seg-dev" data-radial-action="spawn:${t.id}" style="--accent:${t.accent}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <circle class="m002-rad-seg-dot" cx="${dotPos.x}" cy="${dotPos.y}" r="3"/>
        <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${t.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialMove() {
  // Layer + zone navigation submenu — same 4-cardinal layout as the primary
  // ring. The centre tile takes the user back to primary (← back-action).
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_MOVE.length) / 2; // 45
  let segs = '';
  RADIAL_MOVE.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialTool() {
  // Tool / mode picker submenu — same 4-cardinal layout as primary. Centre
  // walks back to primary.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_TOOL.length) / 2;
  let segs = '';
  RADIAL_TOOL.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialElement() {
  // Element-action ring — same chrome as primary, but the centre tile is a
  // CANCEL (back to neutral / dismiss) since this menu has no parent ring to
  // walk back to.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_ELEMENT.length) / 2;
  let segs = '';
  RADIAL_ELEMENT.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-cancel" data-radial-action="cancel">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">CANCEL</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialPen() {
  // Pen-mode ring — 4 draw-tool cardinals + a centre tile that exits draw
  // mode (returns to mouse). Different from the primary ring's CANCEL: this
  // dismisses the menu AND clears s.drawTool so the cursor is interactive
  // again. The radial dispatcher invokes the action by the cancel-style
  // tile's data-radial-action="pen-exit".
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_PEN.length) / 2;
  let segs = '';
  RADIAL_PEN.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-cancel" data-radial-action="pen-exit">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">MOUSE</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialPenColors(s) {
  // Five colour swatches around the ring; centre walks back to the pen-mode
  // ring. Active colour gets a highlight ring so the current selection is
  // visible at a glance.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const N = RADIAL_PEN_COLORS.length;
  const slice = 360 / N;
  const half = slice / 2;
  let segs = '';
  RADIAL_PEN_COLORS.forEach((c, i) => {
    const center = -90 + i * slice;
    const start = center - half + RADIAL_SUB_GAP_DEG / 2;
    const end   = center + half - RADIAL_SUB_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const labelPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, center);
    const dotPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2 - 18, center);
    const isActive = (s.drawColor || '').toLowerCase() === c.hex.toLowerCase();
    segs += `
      <g class="m002-rad-seg m002-rad-seg-pen-color${isActive ? ' m002-rad-seg-pen-color-active' : ''}" data-radial-action="pen-color:${c.hex}" style="--accent:${c.hex}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <circle class="m002-rad-seg-dot" cx="${dotPos.x}" cy="${dotPos.y}" r="6" fill="${c.hex}" stroke="${isActive ? '#fff' : 'rgba(0,0,0,0.4)'}" stroke-width="1.5"/>
        <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${c.name}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back-pen">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialStack() {
  // Stack-action ring — same chrome as the device ring; CANCEL centre.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / RADIAL_STACK.length) / 2;
  let segs = '';
  RADIAL_STACK.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-cancel" data-radial-action="cancel">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">CANCEL</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialLink() {
  // Sparse ring for links — only LAG (N) and DELETE (S) make sense as quick
  // gestures. Slots are sized to the 4-way grid even though only two are
  // filled, so they sit cleanly at the cardinals instead of stretching.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const half = (360 / 4) / 2; // 4-way slot geometry; E/W stay empty
  let segs = '';
  RADIAL_LINK.forEach((seg) => {
    const start = seg.center - half + RADIAL_GAP_DEG / 2;
    const end   = seg.center + half - RADIAL_GAP_DEG / 2;
    const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
    const pos = radialLabelPositions(cx, cy, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${pos.glyph.x}" y="${pos.glyph.y}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${pos.label.x}" y="${pos.label.y}" text-anchor="middle">${seg.label}</text>
      </g>`;
  });
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-cancel" data-radial-action="cancel">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">CANCEL</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialStackZones(s) {
  // Zone picker for stack MOVE — excludes the stack's current zone. Centre
  // walks back to the stack ring.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const target = s.radial?.target;
  const stack = target?.kind === 'stack' ? (s.stacks || []).find((st) => st.id === target.id) : null;
  const currentZone = stack?.zone || s.activeZone;
  const zones = (s.zones || []).filter((z) => z.id !== currentZone);
  let segs = '';
  if (zones.length === 0) {
    segs = `
      <text class="m002-rad-empty" x="${cx}" y="${cy - RADIAL_INNER_R - 24}"
            text-anchor="middle" fill="#5a5f6e"
            font-family="'JetBrains Mono','Share Tech Mono',monospace" font-size="10" letter-spacing="1.6">
        NO OTHER ZONES
      </text>`;
  } else {
    const N = zones.length;
    const slice = 360 / N;
    const half = slice / 2;
    zones.forEach((z, i) => {
      const center = -90 + i * slice;
      const start = center - half + RADIAL_SUB_GAP_DEG / 2;
      const end   = center + half - RADIAL_SUB_GAP_DEG / 2;
      const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
      const labelPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, center);
      segs += `
        <g class="m002-rad-seg m002-rad-seg-zone" data-radial-action="st-move-zone:${_deps.escAttr(z.id)}">
          <path class="m002-rad-seg-path" d="${path}"/>
          <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${_deps.escSvg(z.name)}</text>
        </g>`;
    });
  }
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back-stack">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialElementZones(s) {
  // Zone picker for the element-radial MOVE action. Excludes the device's
  // current zone (no-op move). Centre tile walks back to the element ring.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const target = s.radial?.target;
  const dev = target?.kind === 'device' ? s.devices.find((d) => d.id === target.id) : null;
  const currentZone = dev?.zone || s.activeZone;
  const zones = (s.zones || []).filter((z) => z.id !== currentZone);
  let segs = '';
  if (zones.length === 0) {
    segs = `
      <text class="m002-rad-empty" x="${cx}" y="${cy - RADIAL_INNER_R - 24}"
            text-anchor="middle" fill="#5a5f6e"
            font-family="'JetBrains Mono','Share Tech Mono',monospace" font-size="10" letter-spacing="1.6">
        NO OTHER ZONES
      </text>`;
  } else {
    const N = zones.length;
    const slice = 360 / N;
    const half = slice / 2;
    zones.forEach((z, i) => {
      const center = -90 + i * slice;
      const start = center - half + RADIAL_SUB_GAP_DEG / 2;
      const end   = center + half - RADIAL_SUB_GAP_DEG / 2;
      const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
      const labelPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, center);
      segs += `
        <g class="m002-rad-seg m002-rad-seg-zone" data-radial-action="el-move-zone:${_deps.escAttr(z.id)}">
          <path class="m002-rad-seg-path" d="${path}"/>
          <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${_deps.escSvg(z.name)}</text>
        </g>`;
    });
  }
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back-element">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}

function renderRadialZones(s) {
  // Dynamic zone picker — one segment per zone in the current map. The active
  // zone gets a subtle highlight so the user can see where they currently are.
  // Centre tile returns to the MOVE submenu rather than primary.
  const cx = RADIAL_OUTER_R;
  const cy = RADIAL_OUTER_R;
  const size = RADIAL_OUTER_R * 2;
  const zones = s.zones || [];
  let segs = '';
  if (zones.length === 0) {
    segs = `
      <text class="m002-rad-empty" x="${cx}" y="${cy - RADIAL_INNER_R - 24}"
            text-anchor="middle" fill="#5a5f6e"
            font-family="'JetBrains Mono','Share Tech Mono',monospace" font-size="10" letter-spacing="1.6">
        NO ZONES
      </text>`;
  } else {
    const N = zones.length;
    const slice = 360 / N;
    const half = slice / 2;
    zones.forEach((z, i) => {
      const center = -90 + i * slice;
      const start = center - half + RADIAL_SUB_GAP_DEG / 2;
      const end   = center + half - RADIAL_SUB_GAP_DEG / 2;
      const path  = donutArcPath(cx, cy, RADIAL_INNER_R, RADIAL_OUTER_R, start, end);
      const labelPos = polarXY(cx, cy, (RADIAL_INNER_R + RADIAL_OUTER_R) / 2, center);
      const isActive = z.id === s.activeZone;
      segs += `
        <g class="m002-rad-seg m002-rad-seg-zone${isActive ? ' m002-rad-seg-zone-active' : ''}" data-radial-action="zone:${_deps.escAttr(z.id)}">
          <path class="m002-rad-seg-path" d="${path}"/>
          <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${_deps.escSvg(z.name)}</text>
        </g>`;
    });
  }
  return `
    <svg class="m002-rad-svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <circle class="m002-rad-bg" cx="${cx}" cy="${cy}" r="${RADIAL_OUTER_R - 1}"/>
      <g class="m002-rad-seg m002-rad-seg-back" data-radial-action="back-move">
        <circle class="m002-rad-core" cx="${cx}" cy="${cy}" r="${RADIAL_INNER_R - 4}"/>
        <text class="m002-rad-core-label" x="${cx}" y="${cy + 4}" text-anchor="middle">←</text>
      </g>
      ${segs}
    </svg>`;
}
