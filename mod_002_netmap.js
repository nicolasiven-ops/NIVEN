// === MOD_002 · NET_FORGE ===
// Flat 2D network map editor. SVG board with dotted grid, pan/zoom,
// device palette, link tool, inspector panel, layer toggle.
//
// JUMP nodes act as portals between zones. They have no ports / VLANs.
//   - Hub-leg links: a Jump can be linked with the link tool to regular
//     devices in the *same zone*. The Jump acts as a portless hub connector.
//   - Couple: two Jumps in *different zones* of the same map are coupled
//     via the JUMP inspector's COUPLE WITH dropdown. Mutually stored as
//     `dev.coupleId` (NOT in s.links). A couple makes the Jump pair a single
//     logical hub spanning two zones — anything wired into Jump A shares a
//     broadcast domain with anything wired into Jump B.
//   - Navigation: double-click / JUMP NOW prefers the couple (jumps to the
//     peer's zone and selects the peer). Falls back to the manual zone/map
//     reference (FALLBACK TARGET) when no couple is set.
//   - Hub-tunnel in counterparts: counterpartFor() and the port-modal's
//     COUNTERPART dropdown look through coupled Jumps. Selecting a far-side
//     switch port wires both hub-leg links symmetrically. The port-modal
//     also surfaces the far-side VLANs and the through-tunnel intersection
//     for read-only inspection.
//
// Controls
//   N            cycle next device type and spawn at center
//   L            toggle link mode
//   DEL          delete selected element
//   ESC          deselect / cancel link / exit delete mode
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
//
// Companion files:
//   - mod_002_utils.js       — pure helpers (parseCidr, rid, …) imported below
//   - mod_002_persistence.js — Supabase save/load/migration for m002_maps
//   - mod_002_radial.js      — radial action menu (background dblclick popup)
//   - mod_002_netmap.css     — module styles, loaded once via <link> in index.html

import { parseCidr, prefixToMask, numToIp, cidrNormalize, ipInCidr, normalizeIpInput, rid } from './mod_002_utils.js';
import {
  configurePersistence,
  schedSave, saveNow, snapshotMapData,
  loadFromServer, loadMapData, hydrateMapData,
  rememberActiveMap,
} from './mod_002_persistence.js';
import {
  configureRadial,
  openRadialMenu,
} from './mod_002_radial.js';

// Cross-module wiring lives inside mount() to keep this top-level free of
// any code path that could throw and prevent registerModule from running.
// (See bottom of file: registerModule MUST execute or the runtime shows
// "NO RUNTIME — module has no interface registered".)

const MODULE_CODE = 'MOD_002';
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PORTS = 2;
const DEVICE_TYPES = [
  { id: 'switch',    label: 'SWITCH',   ports: DEFAULT_PORTS, accent: '#00d4ff' },
  { id: 'router',    label: 'ROUTER',   ports: DEFAULT_PORTS, accent: '#35ff7a' },
  { id: 'firewall',  label: 'FIREWALL', ports: DEFAULT_PORTS, accent: '#ff003c' },
  { id: 'endpoint',  label: 'ENDPOINT', ports: DEFAULT_PORTS, accent: '#ffae00' },
  { id: 'cloud',     label: 'CLOUD',    ports: DEFAULT_PORTS, accent: '#aab4c0' },
  // JUMP nodes are portals — they reference another zone (in the same map) or
  // another map. Double-clicking jumps. They have no ports / IP / VLANs.
  { id: 'reference', label: 'JUMP',     ports: 0,             accent: '#c084fc' },
];
const isReference = (dev) => dev && dev.type === 'reference';
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
  // Subnets that were tagged with this VLAN keep the CIDR but lose the tag
  // — VLANs and L3 are independent now and the routing layer never reads it.
  (s.subnetRegistry || []).forEach((sn) => { if (String(sn.vlanId || '') === id) sn.vlanId = null; });
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

// Type of a stack = type of its members. Stacks are uniform-type only, so any
// member is authoritative; pick the first existing one.
function stackTypeOf(s, stack) {
  if (!stack) return null;
  for (const mid of (stack.members || [])) {
    const d = s.devices.find((dv) => dv.id === mid);
    if (d) return d.type;
  }
  return null;
}

// Type id of a stack-merge target ({kind:'device'|'stack', id}).
function targetTypeOf(s, target) {
  if (!target) return null;
  if (target.kind === 'device') {
    return s.devices.find((d) => d.id === target.id)?.type ?? null;
  }
  if (target.kind === 'stack') {
    return stackTypeOf(s, findStackById(s, target.id));
  }
  return null;
}

// Call after any change that might add/remove a VLAN. Recomputes the spectrum,
// redraws all links (their colors depend on it) and refreshes the legend.
function vlansChanged(s) {
  recomputeVlanIndex(s);
  renderLegend(s);
  s.links.forEach((l) => redrawLink(s, l));
  // LAG-pair lines render their own VLAN count / stripes and aren't keyed by
  // link.id, so the per-link redraw above misses them. Refresh them too —
  // otherwise the count on a paired LAG only catches up on the next full
  // render (zoom, drag, layer toggle, …).
  redrawAllLagPairs(s);
  // Re-render any VLAN pickers visible in inspector
  s.host?.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
  // The open port modal has static FAR-SIDE / PASSING THROUGH sections that
  // depend on VLAN assignments — refresh them so a hub-tunneled port shows
  // the updated intersection without manual close/reopen.
  if (s.portModalOpen) {
    const { deviceId, portN } = s.portModalOpen;
    if (s.devices.find((d) => d.id === deviceId)) openPortModal(s, deviceId, portN);
  }
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
    const stack = findStackById(s, parts[1]);
    if (!stack) { container.innerHTML = ''; return; }
    const lag = (stack.lags || []).find((l) => l.id === parts[2]);
    if (!lag) { container.innerHTML = ''; return; }
    if (!Array.isArray(lag.vlans)) lag.vlans = [];
    // For a paired LAG, edits must apply to both sides — collect both LAGs
    // (and the union of their stack members for the availability check).
    const peerInfo = lag.counterpart
      ? findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId)
      : null;
    const lagSides = [{ stack, lag }];
    if (peerInfo) lagSides.push({ stack: peerInfo.stack, lag: peerInfo.lag });
    // Available VLANs = intersection across every stackmate's VLAN set on
    // every involved stack (otherwise a member couldn't carry the LAG-VLAN).
    const memberDevs = lagSides.flatMap(({ stack: st }) =>
      st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean));
    const intersect = memberDevs.length
      ? memberDevs.reduce((acc, m, i) => i === 0
          ? new Set((m.vlans || []).map(String))
          : new Set([...acc].filter((v) => (m.vlans || []).map(String).includes(v))), new Set())
      : new Set();
    scope = {
      available: [...intersect].sort(vlanSort),
      isOn: (v) => lag.vlans.map(String).includes(v),
      toggle: (v, on) => {
        lagSides.forEach(({ lag: lg }) => {
          if (!Array.isArray(lg.vlans)) lg.vlans = [];
          if (on) {
            if (!lg.vlans.map(String).includes(v)) lg.vlans.push(v);
            (lg.ports || []).forEach((ref) => {
              const host = s.devices.find((dd) => dd.id === ref.deviceId);
              const port = (host?.ports || []).find((p) => p.n === Number(ref.portN));
              if (!port) return;
              if (!Array.isArray(port.vlans)) port.vlans = [];
              if (!port.vlans.map(String).includes(v)) port.vlans.push(v);
            });
          } else {
            lg.vlans = lg.vlans.filter((x) => String(x) !== v);
            (lg.ports || []).forEach((ref) => {
              const host = s.devices.find((dd) => dd.id === ref.deviceId);
              const port = (host?.ports || []).find((p) => p.n === Number(ref.portN));
              if (!port) return;
              port.vlans = (port.vlans || []).filter((x) => String(x) !== v);
            });
          }
        });
      },
      emptyHint: peerInfo
        ? 'no VLANs available across all members of both stacks'
        : 'no VLANs available across all stack members',
    };
  } else if (kind === 'link') {
    const link = s.links.find((l) => l.id === parts[1]);
    if (!link) { container.innerHTML = ''; return; }
    const aDev = s.devices.find((d) => d.id === link.from);
    const bDev = s.devices.find((d) => d.id === link.to);
    if (!aDev || !bDev) { container.innerHTML = ''; return; }
    if (isReference(aDev) || isReference(bDev)) {
      container.innerHTML = `<span class="m002-vlan-empty">JUMP hub-leg — VLANs flow through, no per-link config</span>`;
      return;
    }
    if (!link.fromPort || !link.toPort) {
      container.innerHTML = `<span class="m002-vlan-empty">assign From/To ports first</span>`;
      return;
    }
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
    const reg = (s.vlanRegistry || []).find((r) => String(r.id) === String(v));
    const name = reg?.name ? ` · ${reg.name}` : '';
    return `<button type="button" class="m002-vlan-chip-btn ${on ? 'on' : ''}" data-vtoggle="${escAttr(v)}" style="--vc:${c}" title="VLAN ${escAttr(v)}${escAttr(name)}">${escSvg(v)}</button>`;
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
  const filterSet = new Set((s.view?.vlanFilter || []).map(String));
  const isFiltered = filterSet.size > 0;
  const rows = list.length
    ? `<div class="m002-vlan-legend-list">${list.map((v) => {
        const entry = s.vlanRegistry.find((r) => String(r.id) === v) || { id: v, name: '' };
        const solo = filterSet.has(String(v));
        const cls = 'm002-vlan-row'
          + (solo ? ' is-solo' : '')
          + (isFiltered && !solo ? ' is-dimmed' : '');
        const title = solo ? 'Click to remove from solo filter' : 'Click to solo this VLAN';
        return `<div class="${cls}" style="--vc:${s.vlanColors.get(v)}" data-vsolo="${escAttr(v)}" title="${title}">
          <span class="m002-vlan-row-dot"></span>
          <span class="m002-vlan-row-id">${escSvg(v)}</span>
          <input class="m002-vlan-row-name" value="${escAttr(entry.name || '')}" placeholder="name" data-vname="${escAttr(v)}"/>
          <button type="button" class="m002-vlan-row-rm" data-vrm="${escAttr(v)}" title="Remove VLAN globally">×</button>
        </div>`;
      }).join('')}</div>`
    : `<span class="m002-vlan-legend-empty">no VLANs declared yet</span>`;

  const filterBar = isFiltered
    ? `<div class="m002-vlan-legend-filter">
        <span class="m002-vlan-legend-filter-label">SOLO · ${filterSet.size}</span>
        <button type="button" class="m002-vlan-legend-clear" data-vclear>CLEAR</button>
      </div>`
    : '';

  body.innerHTML = `
    ${filterBar}
    ${rows}
    <form class="m002-vlan-legend-add">
      <input class="m002-vlan-legend-input" placeholder="VLAN id (e.g. 10)" inputmode="numeric"/>
      <button type="submit" class="m002-vlan-legend-add-btn">+ ADD</button>
    </form>
  `;
  body.querySelectorAll('[data-vrm]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      snapshot(s);
      vlanRegistryRemove(s, b.dataset.vrm);
      vlansChanged(s);
      schedSave(s);
    });
  });
  body.querySelectorAll('[data-vname]').forEach((inp) => {
    // Don't let a click on the name field bubble into the solo-toggle.
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      const entry = s.vlanRegistry.find((r) => String(r.id) === inp.dataset.vname);
      if (!entry) return;
      entry.name = inp.value;
      schedSave(s);
    });
  });
  body.querySelectorAll('[data-vsolo]').forEach((row) => {
    row.addEventListener('click', () => {
      const v = String(row.dataset.vsolo);
      if (!Array.isArray(s.view.vlanFilter)) s.view.vlanFilter = [];
      const idx = s.view.vlanFilter.findIndex((x) => String(x) === v);
      if (idx >= 0) s.view.vlanFilter.splice(idx, 1);
      else s.view.vlanFilter.push(v);
      s._vlanHover = null;
      animateSoloToggle(s);
      schedSave(s);
    });
    // Hover preview is intentionally instant — animating every mouseenter would
    // make sweeping the legend strobe drain/build clones across the canvas.
    row.addEventListener('mouseenter', () => {
      const v = String(row.dataset.vsolo);
      if (s._vlanHover === v) return;
      s._vlanHover = v;
      render(s);
    });
    row.addEventListener('mouseleave', () => {
      if (s._vlanHover == null) return;
      s._vlanHover = null;
      render(s);
    });
  });
  const clearBtn = body.querySelector('[data-vclear]');
  if (clearBtn) {
    clearBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      s.view.vlanFilter = [];
      animateSoloToggle(s);
      schedSave(s);
    });
  }
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

function renderSubnetLegend(s) {
  const body = s.host?.querySelector('.m002-subnet-legend-body');
  if (!body) return;
  const list = s.subnetRegistry || [];
  // Sort same way as recomputeSubnetIndex for legend rendering order.
  const sorted = list.slice().sort((a, b) => {
    const pa = parseCidr(a.cidr), pb = parseCidr(b.cidr);
    if (pa && pb) {
      if (pa.netNum !== pb.netNum) return pa.netNum - pb.netNum;
      return pa.prefix - pb.prefix;
    }
    return String(a.cidr).localeCompare(String(b.cidr));
  });
  const filterSet = new Set((s.view?.subnetFilter || []).map(String));
  const isFiltered = filterSet.size > 0;
  const rows = sorted.length
    ? `<div class="m002-subnet-legend-list">${sorted.map((sn) => {
        const c = subnetColor(s, sn.id);
        const vlanTag = sn.vlanId ? ` · VLAN ${escSvg(sn.vlanId)}` : '';
        const solo = filterSet.has(String(sn.id));
        const cls = 'm002-subnet-row'
          + (solo ? ' is-solo' : '')
          + (isFiltered && !solo ? ' is-dimmed' : '');
        const title = solo ? 'Click to remove from solo filter' : 'Click to solo this subnet';
        return `<div class="${cls}" style="--sc:${c}" data-subnet-id="${escAttr(sn.id)}" data-ssolo="${escAttr(sn.id)}" title="${title}">
          <span class="m002-subnet-row-dot"></span>
          <span class="m002-subnet-row-cidr">${escSvg(sn.cidr)}</span>
          <input class="m002-subnet-row-name" value="${escAttr(sn.name || '')}" placeholder="name${vlanTag}" data-sname="${escAttr(sn.id)}"/>
          <button type="button" class="m002-subnet-row-rm" data-srm="${escAttr(sn.id)}" title="Remove subnet globally">×</button>
        </div>`;
      }).join('')}</div>`
    : `<span class="m002-subnet-legend-empty">no subnets declared yet</span>`;

  const filterBar = isFiltered
    ? `<div class="m002-vlan-legend-filter">
        <span class="m002-vlan-legend-filter-label">SOLO · ${filterSet.size}</span>
        <button type="button" class="m002-vlan-legend-clear" data-sclear>CLEAR</button>
      </div>`
    : '';

  body.innerHTML = `
    ${filterBar}
    ${rows}
  `;
  body.querySelectorAll('[data-srm]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      snapshot(s);
      subnetRegistryRemove(s, b.dataset.srm);
      subnetsChanged(s);
      refreshInspectorIfL3(s);
      schedSave(s);
    });
  });
  body.querySelectorAll('[data-sname]').forEach((inp) => {
    inp.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => {
      const entry = s.subnetRegistry.find((r) => String(r.id) === inp.dataset.sname);
      if (!entry) return;
      entry.name = inp.value;
      schedSave(s);
    });
  });
  body.querySelectorAll('[data-ssolo]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = String(row.dataset.ssolo);
      if (!Array.isArray(s.view.subnetFilter)) s.view.subnetFilter = [];
      const idx = s.view.subnetFilter.findIndex((x) => String(x) === id);
      if (idx >= 0) s.view.subnetFilter.splice(idx, 1);
      else s.view.subnetFilter.push(id);
      s._subnetHover = null;
      animateSoloToggle(s);
      schedSave(s);
    });
    // Hover preview stays instant for the same reason as VLAN-solo above.
    row.addEventListener('mouseenter', () => {
      const id = String(row.dataset.ssolo);
      if (s._subnetHover === id) return;
      s._subnetHover = id;
      if (s.activeLayer === 'routing') render(s);
    });
    row.addEventListener('mouseleave', () => {
      if (s._subnetHover == null) return;
      s._subnetHover = null;
      if (s.activeLayer === 'routing') render(s);
    });
  });
  body.querySelector('[data-sclear]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    s.view.subnetFilter = [];
    animateSoloToggle(s);
    schedSave(s);
  });
}

// =============================================================================
// L3 / Routing — subnets, interfaces, routes
// =============================================================================
// The Routing layer treats IP-bearing devices (router/firewall, plus anything
// with at least one interface or a populated dev.ip) as L3 hosts. L2-only
// devices (switches without IP / interfaces) fade into the background — they
// transit frames but don't terminate IP. Subnets are first-class entities,
// auto-discovered from configured IP/CIDRs on hydrate and editable in their
// own legend (left panel). Routers/firewalls additionally store interfaces
// and a static route table — the inspector exposes both.
//
// Schema (additions):
//   s.subnetRegistry: [{ id, cidr, name, vlanId? }]   — declared subnets
//   dev.interfaces:   [{ id, name, ip, subnetId? }]    — router/firewall only
//   dev.routes:       [{ id, dst, nextHop, interfaceId?, metric? }] — router/firewall only
//
// Subnet colors are computed from the live set (HSL spread, like VLANs) so
// adding a subnet shifts existing hues and the spectrum stays even.
function isL3Type(typeId) { return typeId === 'router' || typeId === 'firewall'; }
function isL3Device(dev) {
  if (!dev) return false;
  if (isReference(dev)) return false;
  if (isL3Type(dev.type)) return true;
  if (Array.isArray(dev.interfaces) && dev.interfaces.length) return true;
  if (dev.ip && String(dev.ip).trim()) return true;
  return false;
}

function subnetColor(s, subnetId) {
  if (subnetId == null || subnetId === '') return '#5a5f6e';
  return s?.subnetColors?.get(String(subnetId)) || '#5a5f6e';
}

function recomputeSubnetIndex(s) {
  const list = (s.subnetRegistry || []).slice().sort((a, b) => {
    const pa = parseCidr(a.cidr), pb = parseCidr(b.cidr);
    if (pa && pb) {
      if (pa.netNum !== pb.netNum) return pa.netNum - pb.netNum;
      return pa.prefix - pb.prefix;
    }
    return String(a.cidr).localeCompare(String(b.cidr));
  });
  const N = list.length;
  s.subnetColors = new Map();
  list.forEach((sn, i) => {
    // Mirror the VLAN ramp (0..300° → red through the spectrum to violet)
    // so the routing layer feels like a sibling of the VLAN view.
    const hue = N <= 1 ? 0 : Math.round((i / (N - 1)) * 300);
    s.subnetColors.set(String(sn.id), `hsl(${hue}, 85%, 60%)`);
  });
  s.subnetList = list.map((sn) => String(sn.id));
}

function subnetRegistryAdd(s, cidr, name) {
  const norm = cidrNormalize(cidr);
  if (!norm) return null;
  const existing = s.subnetRegistry.find((x) => cidrNormalize(x.cidr) === norm);
  if (existing) return existing;
  const entry = { id: 'sn_' + rid(), cidr: norm, name: (name || '').trim(), vlanId: null };
  s.subnetRegistry.push(entry);
  return entry;
}

function subnetRegistryRemove(s, subnetId) {
  subnetId = String(subnetId);
  s.subnetRegistry = s.subnetRegistry.filter((sn) => String(sn.id) !== subnetId);
  // Subnet membership is now derived from each interface's ip+prefix on the
  // fly — no per-device backreferences to clean up. The auto-discover path
  // will re-add the network if any interface still uses it.
}

function subnetByCidr(s, cidr) {
  const norm = cidrNormalize(cidr);
  if (!norm) return null;
  return s.subnetRegistry.find((sn) => cidrNormalize(sn.cidr) === norm) || null;
}

// Auto-discover subnets from every device + stack VIP that has an IP +
// prefix configured. Called on hydrate and after each L3 edit; idempotent.
// Skips /32 (host route) and /31 (point-to-point) — those aren't usefully
// shown as subnets in the legend.
function autoDiscoverSubnets(s) {
  const cidrs = [];
  s.devices.forEach((d) => {
    if (isReference(d)) return;
    if (isL3Type(d.type)) {
      (d.interfaces || []).forEach((iface) => { const c = ifaceCidr(iface); if (c) cidrs.push(c); });
    } else if (d.ip) {
      cidrs.push(`${d.ip}/${d.prefix != null ? d.prefix : 24}`);
    }
  });
  (s.stacks || []).forEach((st) => {
    (st.virtualInterfaces || []).forEach((vif) => {
      if (!vif.ip) return;
      cidrs.push(`${vif.ip}/${vif.prefix != null ? vif.prefix : 24}`);
    });
  });
  cidrs.forEach((str) => {
    const p = parseCidr(str);
    if (!p) return;
    if (p.prefix >= 31) return;
    subnetRegistryAdd(s, `${p.network}/${p.prefix}`, '');
  });
}

function subnetsChanged(s) {
  recomputeSubnetIndex(s);
  renderSubnetLegend(s);
  // The L3 ribbons depend on subnet membership of every device, so any
  // edit to an IP / prefix / gateway demands a redraw of the dedicated
  // path layer. Cheap (one BFS group + a handful of SVG paths).
  if (s.activeLayer === 'routing') drawL3Paths(s);
}

// Refresh the inspector when a subnet add/remove changed the registry options.
// Called from explicit commit points (AUTO-DERIVE, manual ADD, RM) rather
// than from subnetsChanged() so we don't clobber input focus mid-typing.
function refreshInspectorIfL3(s) {
  if (s.selected?.kind !== 'device') return;
  const dev = s.devices.find((d) => d.id === s.selected.id);
  if (dev && isL3Type(dev.type)) openInspector(s);
}

// Default gateway suggestion for an IP + prefix pair. Routing convention:
// the first usable address inside the subnet (network address + 1). For /31
// (point-to-point) and /32 (host route) there is no meaningful gateway, so
// we return an empty string and the inspector leaves the field blank.
//
// One special case: when the typed IP IS itself the would-be-gateway address
// of its own subnet (the "x.x.x.1" of /24 etc.), the device is presumably
// ACTING as a gateway rather than pointing at one. Returning '' suppresses
// the auto-fill so the user doesn't end up with router.gateway === router.ip,
// which would also poison the L3 ribbon flow-direction inference.
function defaultGatewayFor(ip, prefix) {
  if (!ip) return '';
  const pfx = Number(prefix);
  if (!Number.isFinite(pfx) || pfx >= 31 || pfx < 0) return '';
  const p = parseCidr(ip + '/' + pfx);
  if (!p) return '';
  const gw = numToIp((p.netNum + 1) >>> 0);
  if (gw === p.ip) return '';
  return gw;
}

// Drop a default route into a routes[] table when one isn't already there
// and the host's IP/prefix yield a usable next-hop suggestion. Returns true
// if a route was added — callers use that to know they should refresh the
// inspector. Once present, the user owns the entry; we never overwrite it.
function autoCreateDefaultRoute(routes, ip, prefix, interfaceId) {
  if (!Array.isArray(routes)) return false;
  if (!ip) return false;
  if (routes.some((r) => cidrNormalize(r.dst) === '0.0.0.0/0')) return false;
  const gw = defaultGatewayFor(ip, prefix);
  if (!gw) return false;
  routes.push({
    id: 'rt_' + rid(),
    dst: '0.0.0.0/0',
    nextHop: gw,
    interfaceId: interfaceId || null,
    metric: 1,
  });
  return true;
}

// IP / CIDR utilities ---------------------------------------------------------
// parseCidr / prefixToMask / numToIp / cidrNormalize / ipInCidr / normalizeIpInput
// live in mod_002_utils.js (imported at the top of this file).

// Build a CIDR string from an interface's separated ip + prefix fields.
// Tolerates legacy interfaces where ip still carries an embedded "/N".
function ifaceCidr(iface) {
  if (!iface || !iface.ip) return null;
  const raw = String(iface.ip).trim();
  if (raw.includes('/')) return raw;
  const pfx = iface.prefix != null ? Number(iface.prefix) : 24;
  if (!Number.isFinite(pfx)) return raw;
  return `${raw}/${pfx}`;
}

// Resolve which subnet (if any) an interface belongs to. The interface no
// longer carries an explicit subnetId — the subnet falls out of ip+prefix:
//   1. exact network match against the registry (CIDR equality)
//   2. containment match — if the registry holds a wider subnet, the host
//      IP is treated as a member of it (bare IP / mismatched prefix UX)
function ifaceSubnet(s, iface) {
  const cidr = ifaceCidr(iface);
  if (!cidr) return null;
  return subnetForIp(s, cidr);
}

// Match an IP (with or without a prefix) against the subnet registry. With a
// prefix shorter than /32 we look for the exact network entry first; if no
// prefix is supplied (or it's /32), we look for any registered subnet that
// contains the address and return the most-specific one. This is the bridge
// between "user types 10.0.0.10" and "the routing layer treats it as
// belonging to the declared 10.0.0.0/24" — without the user having to repeat
// the /24 on every endpoint.
function subnetForIp(s, ip) {
  const p = parseCidr(ip);
  if (!p) return null;
  if (p.prefix < 32) {
    const cidr = `${p.network}/${p.prefix}`;
    const exact = s.subnetRegistry.find((sn) => cidrNormalize(sn.cidr) === cidr);
    if (exact) return exact;
  }
  // Containment search — works for bare IPs and /32 host addresses too.
  let best = null, bestPrefix = -1;
  for (const sn of s.subnetRegistry) {
    const p2 = parseCidr(sn.cidr);
    if (!p2) continue;
    if (((p.ipNum & p2.mask) >>> 0) === p2.netNum && p2.prefix > bestPrefix) {
      best = sn;
      bestPrefix = p2.prefix;
    }
  }
  return best;
}

// All subnets a device touches (via its interfaces, or via dev.ip for non-L3
// hosts). Returns subnet entries, deduplicated. Bare-IP (no /N) matching
// works through subnetForIp containment, which is what makes a hand-typed
// "10.0.0.10" on an endpoint actually count as a member of the registered
// 10.0.0.0/24 in the routing layer.
//
// Stack-VIP semantics: when this device is a member of a stack that owns at
// least one virtual interface, the L3 identity for routing belongs to the
// stack's VIP — NOT to the member's own IP. The member's IP keeps its place
// in the inspector (mgmt/console access) but is invisible to the path-
// highlight engine. Otherwise endpoints aimed at the VIP would also "see"
// the per-member IPs and produce phantom L3 ribbons into the stack interior.
function deviceSubnets(s, dev) {
  if (!dev) return [];
  // When this device is a member of a VIP-bearing stack, the stack's VIP is
  // the routing identity. The member's own IP stays in the inspector for
  // mgmt access but does NOT generate L3 ribbons — otherwise endpoints
  // aimed at the VIP would also get phantom ribbons to .2 and .3 of the
  // stack members. Members of non-VIP stacks (plain L2 switches usually
  // without IPs) are unaffected.
  const stack = findStack(s, dev.id);
  if (stack && stackHasVip(stack)) return [];
  const out = [];
  const seen = new Set();
  const add = (sn) => { if (sn && !seen.has(sn.id)) { seen.add(sn.id); out.push(sn); } };
  (dev.interfaces || []).forEach((iface) => add(ifaceSubnet(s, iface)));
  if (dev.ip) add(subnetForIp(s, dev.ip));
  return out;
}

function stackHasVip(stack) {
  return Array.isArray(stack?.virtualInterfaces) && stack.virtualInterfaces.some((vif) => vif && vif.ip);
}

// IPs an entity (device or stack) terminates — for direction inference on
// L3 ribbons. Stacks return their VIPs; routers/firewalls their interface
// IPs; endpoints/clouds/switches their dev.ip.
function entityIps(s, id) {
  const stack = (s.stacks || []).find((st) => st.id === id);
  if (stack) return (stack.virtualInterfaces || []).map((vif) => vif.ip).filter(Boolean);
  const dev = s.devices.find((d) => d.id === id);
  if (!dev) return [];
  if (isL3Type(dev.type)) return (dev.interfaces || []).map((iface) => iface.ip).filter(Boolean);
  return dev.ip ? [dev.ip] : [];
}

// =============================================================================
// Conflict validation
// =============================================================================
// Generic "this input doesn't make sense from a network perspective" guard.
// Today catches duplicate IPs across non-L3 device addresses, router/firewall
// interface IPs, and stack virtual-interface IPs — but the shape (locate-
// conflict + reject-write + flag-field + pulse-tile) is reusable for future
// validators (duplicate hostnames, overlapping subnets, VLAN clashes, ...).
//
// Conflict report shape:
//   { ownerKind: 'device'|'stack', ownerId, ownerLabel, slotKind, slotLabel }
//
// `slotKey` strings disambiguate the editing slot from the conflict slot, so
// editing an iface's existing IP (typing the same value back) does NOT report
// a conflict against itself. Format: "dev:<id>" / "iface:<devId>:<ifId>" /
// "vif:<stackId>:<vifId>".

function ipSlotKey(kind, ...rest) { return [kind, ...rest].join(':'); }

function* iterateIpSlots(s) {
  for (const d of (s.devices || [])) {
    if (isReference(d)) continue;
    if (isL3Type(d.type)) {
      for (const iface of (d.interfaces || [])) {
        if (iface && iface.ip) {
          yield {
            key: ipSlotKey('iface', d.id, iface.id),
            ip: String(iface.ip).trim(),
            ownerKind: 'device', ownerId: d.id, ownerLabel: d.name || '',
            slotKind: 'interface', slotLabel: iface.name || '',
          };
        }
      }
    } else if (d.ip) {
      yield {
        key: ipSlotKey('dev', d.id),
        ip: String(d.ip).trim(),
        ownerKind: 'device', ownerId: d.id, ownerLabel: d.name || '',
        slotKind: 'device', slotLabel: '',
      };
    }
  }
  for (const st of (s.stacks || [])) {
    for (const vif of (st.virtualInterfaces || [])) {
      if (vif && vif.ip) {
        yield {
          key: ipSlotKey('vif', st.id, vif.id),
          ip: String(vif.ip).trim(),
          ownerKind: 'stack', ownerId: st.id, ownerLabel: st.name || '',
          slotKind: 'vip', slotLabel: vif.name || '',
        };
      }
    }
  }
}

// Return the conflicting slot (or null) for a candidate IP. `excludeKey`
// skips the editing slot itself so re-typing an already-stored value is a
// no-op, not a self-collision. `ip` should already be passed through
// normalizeIpInput; partial / empty values short-circuit to null.
function findIpConflict(s, ip, excludeKey) {
  const target = String(ip || '').trim();
  if (!target) return null;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) return null;
  for (const slot of iterateIpSlots(s)) {
    if (slot.key === excludeKey) continue;
    if (slot.ip === target) return slot;
  }
  return null;
}

// Trigger the red pulse on any on-canvas representation of an entity. Hits
// the device tile, the collapsed-stack tile, the stack envelope, and the
// stack cabinet — every element bound to that id gets the class so an
// expanded stack flashes its envelope while a collapsed one flashes its tile.
const _conflictPulseTimers = new Map();
function pulseConflictEntity(s, entityId) {
  if (!entityId || !s.gDevices) return;
  const targets = new Set();
  s.gDevices.querySelectorAll(`[data-device-id="${entityId}"]`).forEach((el) => targets.add(el));
  s.gDevices.querySelectorAll(`[data-stack-id="${entityId}"]`).forEach((el) => targets.add(el));
  s.gStacksBg?.querySelectorAll(`[data-stack-id="${entityId}"]`).forEach((el) => targets.add(el));
  if (!targets.size) return;
  targets.forEach((el) => {
    el.classList.remove('m002-conflict-pulse');
    void el.getBoundingClientRect();
    el.classList.add('m002-conflict-pulse');
  });
  clearTimeout(_conflictPulseTimers.get(entityId));
  _conflictPulseTimers.set(entityId, setTimeout(() => {
    targets.forEach((el) => el.classList.remove('m002-conflict-pulse'));
    _conflictPulseTimers.delete(entityId);
  }, 1800));
}

function describeConflictTarget(conflict) {
  const owner = conflict.ownerLabel || `unnamed ${conflict.ownerKind}`;
  if (conflict.slotKind === 'interface' && conflict.slotLabel) return `${owner} · ${conflict.slotLabel}`;
  if (conflict.slotKind === 'vip' && conflict.slotLabel) return `${owner} · ${conflict.slotLabel} (VIP)`;
  if (conflict.slotKind === 'vip') return `${owner} (VIP)`;
  return owner;
}

// Range check for a fully-shaped quad-IPv4. Returns the offending octet
// (number) when one is > 255, else null. Partial / non-quad input passes
// through as null so live-typing stays unblocked.
function findIpRangeError(ip) {
  const target = String(ip || '').trim();
  if (!target) return null;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) return null;
  const oct = target.split('.').map((o) => parseInt(o, 10));
  const bad = oct.find((o) => o > 255);
  return bad == null ? null : { kind: 'range', badOctet: bad };
}

// Combined validator. Range first (a malformed quad can't usefully be tested
// for collisions), then conflict. Returns one of:
//   null                  → input is acceptable
//   { kind: 'range', ... } → octet > 255
//   { kind: 'conflict', conflict } → IP already used by another slot
function findIpInputError(s, ip, excludeKey) {
  const range = findIpRangeError(ip);
  if (range) return range;
  const conflict = findIpConflict(s, ip, excludeKey);
  if (conflict) return { kind: 'conflict', conflict };
  return null;
}

const _REJECT_TITLE_PREFIXES = ['IP already in use', 'Invalid IPv4'];

function clearFieldRejection(el) {
  if (!el || !el.classList) return;
  el.classList.remove('m002-field-conflict');
  if (el.dataset && el.dataset.conflictWith) delete el.dataset.conflictWith;
  if (el.title && _REJECT_TITLE_PREFIXES.some((p) => el.title.startsWith(p))) {
    el.removeAttribute('title');
  }
}

function markFieldRejection(el, err) {
  if (!el || !el.classList) return;
  el.classList.add('m002-field-conflict');
  if (err.kind === 'range') {
    el.title = `Invalid IPv4: octet ${err.badOctet} out of range (0–255) — input rejected`;
  } else {
    el.title = `IP already in use by ${describeConflictTarget(err.conflict)} — input rejected`;
  }
}

// Single entry-point for IP-edit handlers: returns true when the value should
// be REJECTED (caller skips its mutation/save path). On rejection: marks the
// field red, and for a conflict additionally pulses the colliding tile on
// first detection (and again only when the target-id changes — keeps the
// pulse from re-firing on every keystroke against the same conflict source).
// Empty / partial / mid-typing inputs always pass through (return false +
// clear marker) so live typing stays usable.
function rejectIpEdit(s, el, slotKey, candidateIp) {
  const err = findIpInputError(s, candidateIp, slotKey);
  if (!err) {
    clearFieldRejection(el);
    return false;
  }
  markFieldRejection(el, err);
  if (err.kind === 'conflict') {
    const prev = el.dataset.conflictWith || '';
    if (err.conflict.ownerId !== prev) {
      el.dataset.conflictWith = err.conflict.ownerId;
      pulseConflictEntity(s, err.conflict.ownerId);
    }
  } else if (el.dataset && el.dataset.conflictWith) {
    delete el.dataset.conflictWith;
  }
  return true;
}

// Gateway IPs configured on an entity. Source of truth is the entity's
// routes[] table — every entry whose destination is the default route
// (0.0.0.0/0) contributes its next-hop. Routers, endpoints, and stacks
// share this shape now that gateway is no longer a per-interface field.
function entityGateways(s, id) {
  const fromRoutes = (routes) => (routes || [])
    .filter((r) => cidrNormalize(r.dst) === '0.0.0.0/0')
    .map((r) => r.nextHop)
    .filter(Boolean);
  const stack = (s.stacks || []).find((st) => st.id === id);
  if (stack) return fromRoutes(stack.routes);
  const dev = s.devices.find((d) => d.id === id);
  if (!dev) return [];
  return fromRoutes(dev.routes);
}

// Subnets a stack participates in via its virtual interfaces.
function stackSubnets(s, stack) {
  if (!stack) return [];
  const out = [];
  const seen = new Set();
  (stack.virtualInterfaces || []).forEach((vif) => {
    if (!vif.ip) return;
    const cidr = `${vif.ip}/${vif.prefix != null ? vif.prefix : 24}`;
    const sn = subnetForIp(s, cidr);
    if (sn && !seen.has(sn.id)) { seen.add(sn.id); out.push(sn); }
  });
  return out;
}

// Vote-based default-gateway resolution. Every default route's next-hop in
// the map counts as a vote for whichever entity terminates that IP. Per
// subnet, the IP with the most votes wins the "default gateway" title and
// its owning entity gets the DGW badge.
//
// Cached per-render via s._dgwWinners (a Set of winning IPs) so isDefault
// Gateway() stays cheap when called from drawDevice / drawCollapsedStack
// in a single pass.
function dgwWinningIps(s) {
  if (s._dgwWinners) return s._dgwWinners;
  const counts = new Map(); // subnetCidrNorm → Map<nextHopIp, count>
  const collect = (routes) => {
    (routes || []).forEach((r) => {
      if (cidrNormalize(r.dst) !== '0.0.0.0/0') return;
      if (!r.nextHop) return;
      const sn = subnetForIp(s, r.nextHop);
      if (!sn) return;
      const sub = cidrNormalize(sn.cidr);
      if (!counts.has(sub)) counts.set(sub, new Map());
      const m = counts.get(sub);
      m.set(r.nextHop, (m.get(r.nextHop) || 0) + 1);
    });
  };
  s.devices.forEach((d) => collect(d.routes));
  s.stacks.forEach((st) => collect(st.routes));
  const winners = new Set();
  counts.forEach((m) => {
    let best = null, bestCount = 0;
    m.forEach((c, ip) => { if (c > bestCount) { best = ip; bestCount = c; } });
    if (best) winners.add(best);
  });
  s._dgwWinners = winners;
  return winners;
}

function isDefaultGateway(s, dev) {
  if (!dev || !s) return false;
  const winners = dgwWinningIps(s);
  if (!winners.size) return false;
  // Stack: any VIP IP that's a winning gateway IP counts.
  // Otherwise: device's interface IPs (router/firewall) or dev.ip (rest).
  const myIps = [];
  if (isL3Type(dev.type)) {
    (dev.interfaces || []).forEach((iface) => { if (iface.ip) myIps.push(iface.ip); });
  } else if (dev.ip) {
    myIps.push(dev.ip);
  }
  return myIps.some((ip) => winners.has(ip));
}

// Stack version — VIPs are the stack's L3 face, so any VIP being a winning
// next-hop puts the DGW badge on the collapsed stack icon.
function stackIsDefaultGateway(s, stack) {
  if (!stack) return false;
  const winners = dgwWinningIps(s);
  if (!winners.size) return false;
  return (stack.virtualInterfaces || []).some((vif) => vif.ip && winners.has(vif.ip));
}

// Compute L3 paths for the routing layer. ONE ribbon per L3 entity that
// has a default gateway configured — sourcing from the entity, terminating
// at whichever entity owns the gateway IP. No all-pairs explosion. No
// peer-to-peer paths between same-subnet hosts. Only "this thing routes
// outbound through that thing" relationships, which is what the routing
// view is really showing.
//
// Stack handling:
//   - A stack with a VIP is a first-class L3 destination — endpoints whose
//     gateway field equals one of the stack's VIPs route TO the stack.
//   - Members of a stack with VIP don't generate their own gateway paths;
//     the stack speaks for them. Members of a non-VIP stack still do.
//   - Self-targeting is suppressed: a member whose gateway happens to be
//     its own stack's VIP doesn't get a phantom ribbon to the stack centre
//     it lives inside.
//
// Returns: Array<{ subnetId, ids: [entityId,...] }>. ids always has length
// ≥ 2 (source + target) and may include any number of transit hops.
function computeL3Paths(s) {
  const paths = [];
  if (!s.links?.length && !(s.stacks?.length)) return paths;

  // Zone gate: an entity counts as in-scope when it has no zone, no zone is
  // active, or its zone matches the active one. Without this, ribbons from
  // a different zone bleed through into the current view.
  const inZone = (entity) => !s.activeZone || !entity?.zone || entity.zone === s.activeZone;
  const devInZone = new Set(s.devices.filter(inZone).map((d) => d.id));
  const stackInZone = new Set(s.stacks.filter(inZone).map((st) => st.id));
  const idInZone = (id) => devInZone.has(id) || stackInZone.has(id);

  // Adjacency over the in-zone union of devices and stacks. Each stack is
  // also a virtual node connected to its in-zone members.
  const adj = new Map();
  const ensure = (id) => { if (!adj.has(id)) adj.set(id, new Set()); };
  s.devices.forEach((d) => { if (devInZone.has(d.id)) ensure(d.id); });
  s.stacks.forEach((st) => { if (stackInZone.has(st.id)) ensure(st.id); });
  s.links.forEach((l) => {
    if (!idInZone(l.from) || !idInZone(l.to)) return;
    ensure(l.from); ensure(l.to);
    adj.get(l.from).add(l.to);
    adj.get(l.to).add(l.from);
  });
  s.stacks.forEach((st) => {
    if (!stackInZone.has(st.id)) return;
    (st.members || []).forEach((mid) => {
      if (!devInZone.has(mid)) return;
      ensure(mid);
      adj.get(st.id).add(mid);
      adj.get(mid).add(st.id);
    });
  });

  // Quick lookup: which stack does a given member id belong to?
  const stackOfMember = new Map();
  s.stacks.forEach((st) => (st.members || []).forEach((mid) => stackOfMember.set(mid, st.id)));

  // Build an IP → owning entity index so a gateway IP resolves to whatever
  // device/stack actually terminates it. Stacks with VIPs win over their
  // members (the VIP IS the stack's L3 face).
  const ownerOfIp = new Map();
  s.devices.forEach((d) => {
    if (isReference(d)) return;
    if (isL3Type(d.type)) {
      (d.interfaces || []).forEach((iface) => { if (iface.ip) ownerOfIp.set(iface.ip, d.id); });
    } else if (d.ip) {
      ownerOfIp.set(d.ip, d.id);
    }
  });
  s.stacks.forEach((st) => {
    (st.virtualInterfaces || []).forEach((vif) => { if (vif.ip) ownerOfIp.set(vif.ip, st.id); });
  });

  // Enumerate every L3 source that has a gateway pointing somewhere. For
  // each, find the owning entity of that gateway IP, BFS the link graph,
  // and emit one path. No peer-to-peer paths — only "X routes through Y".
  const sources = []; // { srcId, gateway }
  s.devices.forEach((d) => {
    if (isReference(d)) return;
    if (!devInZone.has(d.id)) return;
    // Skip device's own gateways when the device is a VIP'd-stack member —
    // the stack speaks for them.
    const stk = stackOfMember.get(d.id);
    if (stk) {
      const stack = s.stacks.find((st) => st.id === stk);
      if (stack && stackHasVip(stack)) return;
    }
    entityGateways(s, d.id).forEach((g) => sources.push({ srcId: d.id, gateway: g }));
  });
  s.stacks.forEach((st) => {
    if (!stackInZone.has(st.id)) return;
    if (!stackHasVip(st)) return;
    entityGateways(s, st.id).forEach((g) => sources.push({ srcId: st.id, gateway: g }));
  });

  for (const { srcId, gateway } of sources) {
    const targetId = ownerOfIp.get(gateway);
    if (!targetId) continue;
    if (targetId === srcId) continue;
    if (!idInZone(targetId)) continue;
    // Skip when the gateway IP is owned by the source's own stack (a member
    // pointing at its containing stack's VIP). Drawing a ribbon from a
    // collapsed-stack member to the stack centre it lives inside is the
    // self-targeting "Linie ins eigene Stack-Innere" the user flagged.
    if (stackOfMember.get(srcId) === targetId) continue;
    if (stackOfMember.get(targetId) === srcId) continue;
    // Resolve the subnet — bare gateway IP, containment match.
    const sn = subnetForIp(s, gateway);
    if (!sn) continue;

    // BFS the link graph for the shortest path between source and target
    // entities (devices or stack ids; stack-as-virtual-node bridges members).
    const parent = new Map();
    const visited = new Set([srcId]);
    const queue = [srcId];
    let found = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === targetId) { found = true; break; }
      for (const nb of adj.get(cur) || []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        parent.set(nb, cur);
        queue.push(nb);
      }
    }
    if (!found && !parent.has(targetId)) continue;
    const ids = [targetId];
    let cur = targetId;
    while (parent.has(cur)) {
      cur = parent.get(cur);
      ids.unshift(cur);
    }
    // Collapse TRANSIT members onto their stack id whenever the stack is
    // visible as a single envelope on canvas — i.e. (a) the stack id already
    // appears in the BFS path OR (b) the stack is expanded. Endpoints
    // (ids[0] / ids[last]) are NEVER collapsed: a member with its own IP is
    // a real L3 source/target in its own right (the line is "from this
    // element with an IP to its default gateway"), so it must anchor at
    // the member's position — not at the stack centre. The collapse only
    // hides BFS-bridge members that sit mid-path.
    const stackIdsInPath = new Set();
    for (const id of ids) if ((s.stacks || []).some((st) => st.id === id)) stackIdsInPath.add(id);
    const lastIdx = ids.length - 1;
    const collapsed = ids.map((id, idx) => {
      if (idx === 0 || idx === lastIdx) return id;
      const owningStackId = stackOfMember.get(id);
      if (!owningStackId) return id;
      const st = s.stacks.find((x) => x.id === owningStackId);
      if (!st) return id;
      if (stackIdsInPath.has(owningStackId) || !isStackCollapsed(s, st)) return owningStackId;
      return id;
    });
    // Dedupe consecutive duplicates (stack-virtual-node BFS can cause them,
    // and the collapse pass above can produce same-stack runs).
    const trimmed = [];
    for (const id of collapsed) if (trimmed[trimmed.length - 1] !== id) trimmed.push(id);
    if (trimmed.length < 2) continue;
    paths.push({ subnetId: sn.id, ids: trimmed });
  }
  return paths;
}

// Geometric waypoint for an L3-ribbon node. For an expanded stack we use
// the envelope's geometric centre (midpoint of the dashed bounding box)
// instead of the member centroid effectivePos() returns — so a ribbon
// passing through an open stack hits the visual middle of the box rather
// than drifting toward whichever member happens to sit off-axis. For
// collapsed stacks and bare devices we defer to effectivePos().
function ribbonWaypoint(s, id) {
  const stack = (s.stacks || []).find((st) => st.id === id);
  if (stack && !isStackCollapsed(s, stack)) {
    const r = stackEnvelopeRect(s, stack);
    if (r) return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 };
  }
  return effectivePos(s, id);
}

// Bounding rect of the dashed envelope drawn around an expanded stack.
// Mirrors the math in drawStackEnvelope so a ribbon dock-point sits exactly
// on the visible boundary. Returns null when the stack is collapsed or has
// fewer than two members (no envelope drawn).
function stackEnvelopeRect(s, stack) {
  if (!stack || isStackCollapsed(s, stack)) return null;
  const members = (stack.members || []).map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  if (members.length < 2) return null;
  const padding = 18;
  const minX = Math.min(...members.map((m) => m.x - DEVICE_W / 2)) - padding;
  const minY = Math.min(...members.map((m) => m.y - DEVICE_H / 2)) - padding - 8;
  const maxX = Math.max(...members.map((m) => m.x + DEVICE_W / 2)) + padding;
  const maxY = Math.max(...members.map((m) => m.y + DEVICE_H / 2)) + padding;
  return { minX, minY, maxX, maxY };
}

// Slab-test entry point of segment from→to into rect. Returns the point
// where the segment first crosses the rect boundary, or null if `from` is
// already inside (the caller should keep its original endpoint then).
function segmentRectEntry(from, to, rect) {
  if (!from || !to || !rect) return null;
  const insideFrom = from.x >= rect.minX && from.x <= rect.maxX
                  && from.y >= rect.minY && from.y <= rect.maxY;
  if (insideFrom) return null;
  const dx = to.x - from.x, dy = to.y - from.y;
  let tNear = 0, tFar = 1;
  if (dx !== 0) {
    const t1 = (rect.minX - from.x) / dx;
    const t2 = (rect.maxX - from.x) / dx;
    tNear = Math.max(tNear, Math.min(t1, t2));
    tFar  = Math.min(tFar,  Math.max(t1, t2));
  } else if (from.x < rect.minX || from.x > rect.maxX) {
    return null;
  }
  if (dy !== 0) {
    const t1 = (rect.minY - from.y) / dy;
    const t2 = (rect.maxY - from.y) / dy;
    tNear = Math.max(tNear, Math.min(t1, t2));
    tFar  = Math.min(tFar,  Math.max(t1, t2));
  } else if (from.y < rect.minY || from.y > rect.maxY) {
    return null;
  }
  if (tNear > tFar) return null;
  const t = Math.max(0, Math.min(1, tNear));
  return { x: from.x + dx * t, y: from.y + dy * t };
}

// Inserts a perpendicular midpoint between every pair of adjacent points.
// The midpoint is offset perpendicular to the segment by a fraction of its
// length, capped — short segments stay subtle, long ones bow noticeably.
// The offset alternates direction along the path (using the seed) so the
// resulting curve has organic swing rather than a uniform arc, and so two
// ribbons in the same subnet don't all bow the same way. Without this the
// auto-collapsed routing layer produces nearly straight lines that lose
// all the visual character the multi-hop physical path used to provide.
function puffPath(pts, seed) {
  if (!pts || pts.length < 2) return pts || [];
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 24) { out.push(b); continue; } // too short to bother
    const nx = -dy / len, ny = dx / len;
    const sign = ((seed >> i) & 1) ? 1 : -1;
    const off = Math.min(len * 0.18, 70);
    out.push({ x: (a.x + b.x) / 2 + nx * off * sign, y: (a.y + b.y) / 2 + ny * off * sign });
    out.push(b);
  }
  return out;
}

// Catmull-Rom-to-Bezier smoothing through a list of points. Two-point paths
// are rendered as a straight line; three-or-more produce a smooth curve
// that hits every node it passes through. Tension factor 1/6 gives the
// classic uniform Catmull-Rom feel — soft but recognisable.
function smoothPath(pts) {
  if (!pts || pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x} ${p2.y}`;
  }
  return d;
}

// Render the L3 paths into their dedicated <g> layer. Pairs that share
// device sequences (e.g. three endpoints all connected through the same
// switch) get fan-out offsets so multiple L3 ribbons through the same
// transit hop don't fully overlap.
function drawL3Paths(s) {
  if (!s.gL3Paths) return;
  s.gL3Paths.innerHTML = '';
  if (s.activeLayer !== 'routing') return;
  const paths = computeL3Paths(s);
  if (!paths.length) return;
  // Subnet solo: persisted filter + transient hover preview from the legend
  // mouseenter. When set, only paths whose subnet is in the filter render —
  // others fade out entirely so the user can isolate one subnet at a time.
  const persisted = (s.view?.subnetFilter || []).map(String);
  const hover = s._subnetHover != null ? String(s._subnetHover) : null;
  const filter = hover && !persisted.includes(hover) ? [...persisted, hover] : persisted;
  const filterSet = new Set(filter);
  const isFiltered = filterSet.size > 0;
  let html = '';
  paths.forEach((p) => {
    if (isFiltered && !filterSet.has(String(p.subnetId))) return;
    const sn = s.subnetRegistry.find((x) => x.id === p.subnetId);
    if (!sn) return;
    const c = subnetColor(s, sn.id);
    // Use ribbonWaypoint so collapsed-stack members contribute their real
    // positions to the curve. Catmull-Rom through the actual member layout
    // gives the swing back without needing the synthetic puff offsets.
    const pts = p.ids.map((id) => ribbonWaypoint(s, id)).filter(Boolean);
    if (pts.length < 2) return;
    // Dock ribbon ends on the envelope edge of an expanded stack instead of
    // diving to its centroid — matches how a device's body covers the line
    // tip, so the ribbon visibly terminates at the stack's perimeter rather
    // than crossing it.
    const headStack = (s.stacks || []).find((st) => st.id === p.ids[0]);
    const headRect = stackEnvelopeRect(s, headStack);
    if (headRect) {
      const hit = segmentRectEntry(pts[1], pts[0], headRect);
      if (hit) pts[0] = hit;
    }
    const tailIdx = p.ids.length - 1;
    const tailStack = (s.stacks || []).find((st) => st.id === p.ids[tailIdx]);
    const tailRect = stackEnvelopeRect(s, tailStack);
    if (tailRect) {
      const hit = segmentRectEntry(pts[tailIdx - 1], pts[tailIdx], tailRect);
      if (hit) pts[tailIdx] = hit;
    }
    const d = smoothPath(pts);
    if (!d) return;
    // Paths are sourced from "entity → its gateway", so the geometric path
    // already runs in the right direction (start = source, end = gateway).
    // The pulse always animates forward. Wrap the three layers in a <g> so
    // the VFX system can identify and animate each route as one unit, and
    // tag the direction so the drain knows where to flow.
    const routeId = `${p.ids[0]}|${p.ids[p.ids.length - 1]}|${p.subnetId}`;
    // Inline fill="none" — the parent-scoped `.m002-l3-paths path{fill:none}`
    // rule does NOT follow these paths into the m002-vfx-exits group when the
    // VFX system clones them for the drain, so SVG's default black fill
    // becomes visible the moment our drain dasharray opens a gap. Inline
    // attribute survives cloneNode.
    html += `<g class="m002-l3-route" data-l3-route="${escAttr(routeId)}">`;
    html += `<path class="m002-l3-path-glow" d="${d}" fill="none" style="stroke:${c};color:${c}"/>`;
    html += `<path class="m002-l3-path" d="${d}" fill="none" style="stroke:${c};color:${c}"/>`;
    html += `<path class="m002-l3-path-flow" d="${d}" fill="none" style="stroke:${c};color:${c}" data-flow-dir="forward"/>`;
    html += `</g>`;
  });
  s.gL3Paths.innerHTML = html;
}

const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1, vlanFilter: [], subnetFilter: [] };
// Both dimensions are multiples of 2*GRID so half-w / half-h are whole-cell
// values. This keeps the device's *corners* (and centre) on grid dots when
// dev.x / dev.y are snapped to GRID — without this the corners landed at
// cell centres (5×3 cells, half = 2.5×1.5) and the box read as offset.
const DEVICE_W = 144;
const DEVICE_H = 96;
const GRID = 24;
// Spacing between parallel lanes when multiple distinct links share the same
// pair of visual endpoints (multi-link UX). Within a single lane VLAN stripes
// keep their own narrower 6 px gap.
const LANE_GAP = 14;

// =============================================================================
// Lifecycle
// =============================================================================
let state = null;

async function mount(stage, ctx) {
  // Wire cross-module deps before any persistence/radial code runs. Wrapped
  // in try/catch so a malformed callback can't take the whole module down
  // — registerModule has already fired by the time we get here.
  try {
    configurePersistence({ migrate, toast });
    configureRadial({
      clientToWorld, toggleLinkMode, toggleDeleteMode, undo,
      spawnDeviceAt, switchZone, escAttr, escSvg,
      getDeviceTypes: () => DEVICE_TYPES,
    });
  } catch (e) {
    console.warn('[m002] dep wiring failed', e);
  }
  state = createState(stage, ctx);
  buildDOM(state);
  // Stamp the body-level style attr after host exists so cursor/global chrome
  // overrides can key off it the moment the user enters Plexus.
  applyStyle(state, state.prefs?.style);
  bindBoard(state);
  bindKeyboard(state);
  await loadFromServer(state);
  applyView(state);
  render(state);
  refreshMapBar(state);
  refreshZoneBar(state);
  showInspectorEmpty(state);
  refreshToolHighlights(state);
  startFlowTicker(state);
}

function unmount() {
  if (!state) return;
  // Best-effort: flush any pending edits before tearing down.
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  if (state.dirty) { try { saveNow(state); } catch (_) {} }
  if (state._zoneAnim) { try { cancelAnimationFrame(state._zoneAnim); } catch (_) {} state._zoneAnim = null; }
  stopFlowTicker(state);
  for (const off of state.cleanups) { try { off(); } catch (_) {} }
  state.host?.remove();
  // Drop the tool-cursor classes we stamped on body — other modules
  // shouldn't inherit them.
  document.body.classList.remove('m002-tool-select', 'm002-tool-link', 'm002-tool-delete');
  // Drop the per-style body attr / classes so the hub cursor/chrome reverts.
  delete document.body.dataset.m002Style;
  STYLES.forEach((x) => document.body.classList.remove('m002-style-' + x.id));
  // Tear down the cursor-enforcer + restore native bracket colours.
  if (_m002StyleEnforcer) {
    try { _m002StyleEnforcer.disconnect(); } catch (_) {}
    _m002StyleEnforcer = null;
  }
  if (_m002StyleEnforcerInt) {
    clearInterval(_m002StyleEnforcerInt);
    _m002StyleEnforcerInt = null;
  }
  _m002ClearSketchCursor();
  state = null;
}

// JS-driven flow animation. Replaces the CSS @keyframes that was governed by
// `prefers-reduced-motion` — corporate Windows profiles often force that flag
// and silently disabled the pulse. requestAnimationFrame is purely a repaint
// hook and ignores reduced-motion, so the pulse runs unconditionally for
// users who have the editor open.
function startFlowTicker(s) {
  if (s.flowFrame) return;
  const PERIOD = 1500; // ms per cycle
  const SPAN = 98;     // dashoffset travel range (matches stroke-dasharray "6 92")
  const tick = (t) => {
    s.flowFrame = requestAnimationFrame(tick);
    if (s.host?.classList.contains('m002-dragging')) return;
    const phase = (t % PERIOD) / PERIOD;
    const fwd = (1 - phase) * SPAN;
    const rev = phase * SPAN;
    // L2 link flow — only on incident links of the current selection. The
    // routing layer suppresses these entirely (CSS hides them) so the only
    // animated thing in that view is the L3 ribbon pulse aimed at the
    // gateway. No competing white pulse on the underlying L2 wires.
    if (s.activeLayer !== 'routing') {
      const flows = s.gLinks?.querySelectorAll('.m002-link-flow');
      if (flows && flows.length) {
        flows.forEach((p) => {
          const reverse = p.parentElement?.getAttribute('data-flow-from') === 'to';
          p.style.strokeDashoffset = (reverse ? rev : fwd).toFixed(2);
        });
      }
    }
    // L3 ribbon flow — always on while the routing layer is active. Direction
    // points toward whichever endpoint is the other endpoint's default gateway.
    const ribbons = s.gL3Paths?.querySelectorAll('.m002-l3-path-flow');
    if (ribbons && ribbons.length) {
      ribbons.forEach((p) => {
        const reverse = p.getAttribute('data-flow-dir') === 'reverse';
        p.style.strokeDashoffset = (reverse ? rev : fwd).toFixed(2);
      });
    }
  };
  s.flowFrame = requestAnimationFrame(tick);
}

function stopFlowTicker(s) {
  if (s.flowFrame) cancelAnimationFrame(s.flowFrame);
  s.flowFrame = null;
}

// Visual styles registry. Each entry is a swappable preset for the canvas
// look. The active style is applied via host.dataset.gridStyle so CSS rules
// scoped to [data-grid-style="..."] decide what grid layers are visible.
// Add new styles here — UI in renderPrefsInspector iterates over this list.
const STYLES = [
  { id: 'futuristic', label: 'FUTURISTIC',      desc: 'Micro-dots + crosshair major grid (default).' },
  { id: 'sketch',     label: 'SKETCH',          desc: 'Light mode · pencil on graph paper · muted colors.' },
];
const DEFAULT_STYLE = 'futuristic';

const DEFAULT_PREFS = { style: DEFAULT_STYLE, autoRecenter: false, freeMove: false, snapOnDrop: true, shortPortLabels: true };
const PREFS_KEY = 'm002.preferences';
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

// Applies a visual style to the live host. Stamps the data-grid-style attr
// the CSS keys off, and persists the choice. Safe to call before the host
// exists (e.g. during early prefs hydration) — it just becomes a no-op then.
function applyStyle(s, styleId) {
  const valid = STYLES.find((x) => x.id === styleId) ? styleId : DEFAULT_STYLE;
  if (s.prefs) { s.prefs.style = valid; savePrefs(s.prefs); }
  if (s.host) s.host.dataset.gridStyle = valid;
  if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.m002Style = valid;
    STYLES.forEach((x) => document.body.classList.remove('m002-style-' + x.id));
    document.body.classList.add('m002-style-' + valid);
  }
}

function createState(stage, ctx) {
  return {
    stage, sb: ctx.sb, project: ctx.project, code: ctx.code, exit: ctx.exit,
    prefs: loadPrefs(),
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
    gStacksBg: null, gLinks: null, gDevices: null, gOverlay: null, gPulse: null,
    palette: null, inspector: null, layerBar: null, statusBar: null, toastStackEl: null,

    devices: [],   // { id, type, x, y, name, ip, notes, vlans:[], interfaces:[{id,name,ip,subnetId?}], routes:[{id,dst,nextHop,interfaceId?,metric?}], ports: [{n,name,vlans:[]}] }
    links: [],     // { id, from, to, fromPort, toPort }
    stacks: [],    // { id, name, members: [deviceId,...], x, y, expanded, lags:[], stackLinks:[{id,fromDevice,toDevice,fromPort,toPort}] } — VLANs are derived from members
    vlanRegistry: [],  // [{ id: string, name?: string }] — declared VLANs in this network
    subnetRegistry: [], // [{ id, cidr, name?, vlanId? }] — declared L3 subnets
    portModalOpen: null, // { deviceId, portN } or null
    detailDeviceId: null, // when set, the dedicated Detail-View overlay shows this device
    selected: null,// { kind: 'device'|'link'|'stack', id }
    multiSelected: new Set(), // additional selected targets — keys "device:ID" / "stack:ID"

    view: { ...DEFAULT_VIEW },
    linkMode: false,
    linkPending: null, // first device id in link mode
    deleteMode: false, // when true, clicks on canvas elements delete them
    spawnIdx: 0,

    drag: null,
    dragVisual: null, // active "lift + inertia" animation state for the dragged element
    dragStackTarget: null, // "device:ID" or "stack:ID" — drop-target while dragging a device
    dragStackTargetCompat: null, // 'ok' | 'bad' — green/red glow state for current target
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
  const host = document.createElement('div');
  host.className = 'm002-host';
  host.dataset.gridStyle = (s.prefs && s.prefs.style) || DEFAULT_STYLE;
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
          <button type="button" class="m002-pal-btn m002-delete-tool" data-tool="delete" title="Delete tool — click anything to remove">
            <span class="m002-pal-glyph">×</span><span>DELETE</span>
          </button>
          <button type="button" class="m002-pal-btn ghost" data-tool="undo" title="Undo (Ctrl+Z)">
            <span class="m002-pal-glyph">↶</span><span>UNDO</span>
          </button>
        </div>
      </section>

      <section class="m002-panel-section m002-panel-section--legend">
        <h3 class="m002-panel-title">// LEGEND · VLANS</h3>
        <div class="m002-vlan-legend-body">
          <span class="m002-vlan-legend-empty">no VLANs declared yet</span>
        </div>
      </section>

      <section class="m002-panel-section m002-panel-section--legend m002-panel-section--subnets">
        <h3 class="m002-panel-title">// LEGEND · SUBNETS</h3>
        <div class="m002-subnet-legend-body">
          <span class="m002-subnet-legend-empty">no subnets declared yet</span>
        </div>
      </section>

      <section class="m002-panel-hints">
        <div>DRAG NODE → CANVAS</div>
        <div>DRAG NODE → NODE = GROUP</div>
        <div>DBL-CLICK GROUP = EXPAND</div>
      </section>

      <button type="button" class="m002-prefs-btn" data-prefs title="Preferences">
        <span class="m002-prefs-glyph">⚙</span><span>SETTINGS</span>
      </button>
    </aside>

    <main class="m002-center">
      <div class="m002-tint"></div>

      <div class="m002-board">
        <svg class="m002-svg" xmlns="${SVG_NS}">
          <defs>
            <pattern id="m002-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
              <circle cx="0.5" cy="0.5" r="0.72" fill="#2a2a36"/>
            </pattern>
            <pattern id="m002-grid-major" width="${GRID * 5}" height="${GRID * 5}" patternUnits="userSpaceOnUse">
              <path d="M ${GRID * 5} 0 L 0 0 0 ${GRID * 5}" fill="none" stroke="#1a1a22" stroke-width="0.72"/>
            </pattern>
            <pattern id="m002-grid-sketch-minor" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse">
              <path d="M ${GRID} 0 L 0 0 0 ${GRID}" fill="none" stroke="#c8d4dc" stroke-width="0.6"/>
            </pattern>
            <pattern id="m002-grid-sketch-major" width="${GRID * 5}" height="${GRID * 5}" patternUnits="userSpaceOnUse">
              <path d="M ${GRID * 5} 0 L 0 0 0 ${GRID * 5}" fill="none" stroke="#8fa6b8" stroke-width="0.85"/>
            </pattern>
            <filter id="m002-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.4" result="b"/>
              <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <g class="m002-world">
            <rect class="m002-grid-bg" x="-50000" y="-50000" width="100000" height="100000" fill="url(#m002-grid)"/>
            <rect class="m002-grid-bg2" x="-50000" y="-50000" width="100000" height="100000" fill="url(#m002-grid-major)"/>
            <g class="m002-vfx-pulse" pointer-events="none"></g>
            <g class="m002-stacks-bg"></g>
            <g class="m002-links"></g>
            <g class="m002-l3-paths"></g>
            <g class="m002-devices"></g>
            <g class="m002-overlay"></g>
            <g class="m002-vfx-exits" pointer-events="none"></g>
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

      <div class="m002-detail-overlay" hidden>
        <div class="m002-detail-head">
          <button type="button" class="m002-detail-back" title="Back to map (ESC)"><span class="m002-detail-back-glyph">←</span><span>MAP</span></button>
          <span class="m002-detail-title">// DETAIL</span>
          <span class="m002-detail-spacer"></span>
        </div>
        <div class="m002-detail-body"></div>
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

    <div class="m002-toast-stack"></div>
  `;
  s.stage.appendChild(host);
  s.host = host;
  s.board = host.querySelector('.m002-board');
  s.svg = host.querySelector('.m002-svg');
  s.gWorld = host.querySelector('.m002-world');
  s.gStacksBg = host.querySelector('.m002-stacks-bg');
  s.gLinks = host.querySelector('.m002-links');
  s.gL3Paths = host.querySelector('.m002-l3-paths');
  s.gDevices = host.querySelector('.m002-devices');
  s.gOverlay = host.querySelector('.m002-overlay');
  s.gPulse = host.querySelector('.m002-vfx-pulse');
  s.gExits = host.querySelector('.m002-vfx-exits');
  s.palette = host.querySelector('.m002-leftpanel');
  s.inspector = host.querySelector('.m002-inspector');
  s.layerBar = host.querySelector('.m002-layerbar');
  s.statusBar = host.querySelector('.m002-statusbar');
  s.toastStackEl = host.querySelector('.m002-toast-stack');
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
    const prefsBtn = e.target.closest('[data-prefs]');
    if (prefsBtn) {
      // Settings panel — uses a synthetic selection kind so openInspector
      // routes the body to renderPrefsInspector.
      s.selected = { kind: 'prefs', id: 'prefs' };
      markSelected(s);
      openInspector(s);
      return;
    }
    const tool = e.target.closest('[data-tool]');
    if (!tool) return;
    if (tool.dataset.tool === 'select') {
      if (s.linkMode) toggleLinkMode(s);
      if (s.deleteMode) toggleDeleteMode(s);
    }
    if (tool.dataset.tool === 'link') toggleLinkMode(s);
    if (tool.dataset.tool === 'delete') toggleDeleteMode(s);
    if (tool.dataset.tool === 'undo') undo(s);
    if (tool.dataset.tool === 'recenter') recenter(s);
    refreshToolHighlights(s);
  });

  s.layerBar.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-layer]');
    if (!pill) return;
    s.layerBar.querySelectorAll('.m002-layer-pill').forEach((p) => p.classList.toggle('active', p === pill));
    const prev = s.activeLayer;
    // Defer the state + attribute change into the vfxAnimateView callback
    // so its `before` snapshot still sees the OLD active-layer CSS context.
    // That's required for the persisting-element overlay-drain to freeze
    // the pre-transition look.
    // Sequential timing — drain old layer fully, THEN build new layer. The
    // parallel default cross-faded persisting-changed elements (e.g. non-L3
    // devices dimming on entry into Routing) which read as "morph" instead
    // of "swap"; sequential makes the layer change feel like a deliberate
    // context shift. Generous easing on both halves — easeIn on drain so the
    // exit accelerates into emptiness, easeOutCubic on build so the new look
    // settles in instead of snapping.
    vfxAnimateView(s, () => {
      s.activeLayer = pill.dataset.layer;
      s.host.setAttribute('data-active-layer', s.activeLayer);
      // Persist on the map's view block so a tab change / reload returns
      // the user to the layer they were on.
      if (!s.view || typeof s.view !== 'object') s.view = { ...DEFAULT_VIEW };
      s.view.activeLayer = s.activeLayer;
      schedSave(s);
      // Routing-layer ergonomics:
      //   - L3 stacks (VIPs or L3 members) auto-EXPAND so the user can see
      //     the individual L3 entities inside them.
      //   - Pure-L2 stacks auto-COLLAPSE — they're transit, no L3 to show.
      // We remember which stacks we touched so leaving the layer restores
      // the user's prior layout without clobbering manual changes.
      if (s.activeLayer === 'routing' && prev !== 'routing') {
        const collapsedByLayer = [];
        const expandedByLayer = [];
        (s.stacks || []).forEach((st) => {
          const isL3 = stackHasVip(st) || st.members.some((mid) => {
            const m = s.devices.find((d) => d.id === mid);
            return m && isL3Device(m);
          });
          if (isL3 && !st.expanded) {
            st.expanded = true;
            layoutStackMembersIfOverlapping(s, st);
            expandedByLayer.push(st.id);
          } else if (!isL3 && st.expanded) {
            st.expanded = false;
            collapsedByLayer.push(st.id);
          }
        });
        s._routingAutoCollapsed = collapsedByLayer;
        s._routingAutoExpanded = expandedByLayer;
      } else if (prev === 'routing' && s.activeLayer !== 'routing') {
        // Leaving routing — restore stacks we touched on entry to their prior
        // states.
        (s._routingAutoCollapsed || []).forEach((id) => {
          const st = (s.stacks || []).find((x) => x.id === id);
          if (st) st.expanded = true;
        });
        (s._routingAutoExpanded || []).forEach((id) => {
          const st = (s.stacks || []).find((x) => x.id === id);
          if (st) st.expanded = false;
        });
        s._routingAutoCollapsed = null;
        s._routingAutoExpanded = null;
      }
      render(s);
    }, null, {
      mode: 'sequential',
      drainMs: VFX_LAYER_DRAIN_MS,
      buildMs: VFX_LAYER_BUILD_MS,
      drainEase: vfxEaseInQuad,
      buildEase: vfxEaseOutCubic,
    });
  });
  s.activeLayer = 'physical';
  s.host.setAttribute('data-active-layer', s.activeLayer);


  const lagModal = host.querySelector('.m002-lag-modal');
  lagModal.querySelector('.m002-lag-modal-close')?.addEventListener('click', () => closeLagModal(s));
  lagModal.addEventListener('click', (e) => { if (e.target === lagModal) closeLagModal(s); });

  const detailOverlay = host.querySelector('.m002-detail-overlay');
  detailOverlay?.querySelector('.m002-detail-back')?.addEventListener('click', () => exitDetailView(s));
  // Double-click on empty detail-view background → back to map. Interactive
  // elements (ports, back button, future controls) live in deeper containers
  // and use [data-detail-stop] to opt out of this exit.
  detailOverlay?.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-detail-stop]')) return;
    exitDetailView(s);
  });
  // Single-click routing inside the detail overlay:
  //   • port  → highlight the port (and drop the central element's selection)
  //              + open the port's detail in the inspector
  //   • device → drop the port focus (back to device inspector) + reselect
  //              the central element so the user sees what's currently active
  // The dblclick handler above still gets the *bg* exit because [data-detail-stop]
  // sits on both ports and the device, so neither single-click bubbles into bg.
  detailOverlay?.addEventListener('click', (e) => {
    // 1. Peer-tile click — Position-Swap hop to the peer device. Peer
    //    tiles still carry data-detail-peer-id (centre tile carries
    //    data-detail-center instead) so a closest() on this attribute
    //    cleanly differentiates a hop click from a centre re-focus.
    const peerEl = e.target.closest('[data-detail-peer-id]');
    if (peerEl && s.detailDeviceId) {
      const peerId = peerEl.dataset.detailPeerId;
      hopToPeer(s, peerId, peerEl);
      return;
    }
    // 2. Peer-link click — select the underlying link (same behaviour as
    //    clicking a wire on the main grid). Visually mark the line as
    //    selected within the overlay too, since markSelected() targets
    //    s.gLinks and won't reach the overlay's standalone link element.
    const linkEl = e.target.closest('[data-detail-link]');
    if (linkEl && s.detailDeviceId) {
      const linkId = linkEl.dataset.detailLink;
      detailOverlay.querySelectorAll('.m002-detail-peer-link.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
      linkEl.classList.add('m002-selected');
      detailOverlay.querySelectorAll('.m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
      detailOverlay.querySelector('.m002-detail-tile.is-center')?.classList.remove('is-selected');
      select(s, 'link', linkId);
      return;
    }
    // 3. Port click — highlight the port and open it in the inspector
    //    (port modal). Peer navigation lives on the peer-tile now, so the
    //    port itself is purely a "show me this port's detail" affordance.
    const portEl = e.target.closest('[data-detail-port]');
    if (portEl && s.detailDeviceId) {
      const portN = Number(portEl.dataset.detailPort);
      if (!Number.isFinite(portN)) return;
      detailOverlay.querySelectorAll('.m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
      detailOverlay.querySelectorAll('.m002-detail-peer-link.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
      detailOverlay.querySelector('.m002-detail-tile.is-center')?.classList.remove('is-selected');
      portEl.classList.add('is-selected');
      openPortModal(s, s.detailDeviceId, portN);
      return;
    }
    // 4. Central-tile click — drop port focus, reselect the central
    //    element so the inspector shows device-level info.
    if (e.target.closest('[data-detail-center]') && s.detailDeviceId) {
      detailOverlay.querySelectorAll('.m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
      detailOverlay.querySelectorAll('.m002-detail-peer-link.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
      detailOverlay.querySelector('.m002-detail-tile.is-center')?.classList.add('is-selected');
      if (s.portModalOpen) closePortModal(s);
    }
  });

  // Background click → deselect, but only on a true click (not a pan-drag).
  // Actual deselect call lives in the pan onUp handler below — it checks
  // whether the pointer moved beyond a small threshold before deciding.
}

// =============================================================================
// Drag lift + positional inertia — picks the dragged element up off the board
// (scale-up, deeper shadow) and lets its visual position lag the cursor like
// a soft-spring tether. Quick swings make the body trail behind the pointer;
// when the pointer stops, the body coasts past the cursor and floats back to
// rest. The element stays upright the whole time — no rotation. The rAF tick
// owns the dragged element's transform attribute (and its lift lock keeps
// other writers from clobbering it mid-frame).
// =============================================================================
const DRAG_LIFT_SCALE = 1.10;
const DRAG_LIFT_SCALE_LERP = 0.22;
const DRAG_LIFT_LAG_FACTOR = 80;     // ms — multiplies smoothed cursor velocity into target offset
const DRAG_LIFT_LAG_MAX = 90;        // world units — cap so it never trails out of arm's reach
const DRAG_LIFT_VEL_SMOOTH = 0.30;   // EMA factor for cursor velocity (0..1, higher = snappier)
const DRAG_LIFT_VEL_DECAY = 0.88;    // smoothed-velocity decay each frame — higher keeps target alive longer
const DRAG_LIFT_SPRING_STIFF = 0.05; // very gentle pull — soft, viscous return
const DRAG_LIFT_SPRING_DAMP = 0.28;  // mildly underdamped — one visible overshoot, then settle
const DRAG_LIFT_END_EPS = 0.0015;    // stop animating once inside this scale band
const DRAG_LIFT_OFFSET_EPS = 0.08;   // ...and this offset/velocity band

function dragLiftElement(s) {
  if (!s.dragVisual) return null;
  const { kind, id } = s.dragVisual;
  if (kind === 'device') return s.gDevices?.querySelector(`[data-device-id="${id}"]`) || null;
  if (kind === 'stack')  return s.gDevices?.querySelector(`[data-stack-id="${id}"]`)  || null;
  return null;
}

function dragLiftPosition(s) {
  if (!s.dragVisual) return null;
  const { kind, id } = s.dragVisual;
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === id);
    return dev ? { x: dev.x, y: dev.y } : null;
  }
  if (kind === 'stack') {
    const st = findStackById(s, id);
    return st ? { x: st.x, y: st.y } : null;
  }
  return null;
}

function applyDragLiftTransform(s) {
  const dv = s.dragVisual;
  if (!dv) return;
  const el = dragLiftElement(s);
  const pos = dragLiftPosition(s);
  if (!el || !pos) return;
  const x = pos.x + dv.offX;
  const y = pos.y + dv.offY;
  el.setAttribute('transform', `translate(${x.toFixed(3)} ${y.toFixed(3)}) scale(${dv.scale.toFixed(4)})`);
}

function startDragLift(s, kind, id) {
  // Cancel any settle-animation still running from a previous gesture.
  if (s.dragVisual?.raf) cancelAnimationFrame(s.dragVisual.raf);
  if (s.dragVisual) {
    const prev = dragLiftElement(s);
    if (prev) { delete prev.dataset.m002LiftLock; prev.classList.remove('m002-lifted'); }
  }
  s.dragVisual = {
    kind, id,
    scale: 1,
    scaleTarget: DRAG_LIFT_SCALE,
    // Visual offset (world units) from the logical/cursor anchor — the body
    // lags the cursor by `(offX, offY)` while keeping links rooted at the
    // logical centre, so the trail effect doesn't drag the wiring with it.
    offX: 0, offY: 0,
    offVX: 0, offVY: 0,
    targetOffX: 0, targetOffY: 0,
    smoothVX: 0, smoothVY: 0,        // EMA of cursor velocity in world units / ms
    lastClientX: null, lastClientY: null,
    lastTime: performance.now(),
    ending: false,
    raf: null,
  };
  const el = dragLiftElement(s);
  if (el) {
    el.dataset.m002LiftLock = '1';
    el.classList.add('m002-lifted');
  }
  const tick = () => {
    const dv = s.dragVisual;
    if (!dv) return;
    // Scale lerp toward current target (1.10 while held, 1.0 once ending).
    dv.scale += (dv.scaleTarget - dv.scale) * DRAG_LIFT_SCALE_LERP;
    // Smoothed cursor velocity decays when the pointer stops moving so the
    // target offset eases back to 0 and the spring carries the body home.
    dv.smoothVX *= DRAG_LIFT_VEL_DECAY;
    dv.smoothVY *= DRAG_LIFT_VEL_DECAY;
    if (dv.ending) {
      dv.targetOffX = 0;
      dv.targetOffY = 0;
    } else {
      // Re-derive target each frame from smoothed velocity so an idle pointer
      // pulls the offset back to 0 even without a fresh mousemove.
      let tx = -dv.smoothVX * DRAG_LIFT_LAG_FACTOR;
      let ty = -dv.smoothVY * DRAG_LIFT_LAG_FACTOR;
      const mag = Math.hypot(tx, ty);
      if (mag > DRAG_LIFT_LAG_MAX) {
        const f = DRAG_LIFT_LAG_MAX / mag;
        tx *= f; ty *= f;
      }
      dv.targetOffX = tx;
      dv.targetOffY = ty;
    }
    // 2D spring on offset — under-damped so the body coasts past the cursor
    // when motion stops, then floats back through 0 with one or two visible
    // bobs before settling. That's the "leicht um den Mauszeiger floaten"
    // behaviour we're after.
    const ax = (dv.targetOffX - dv.offX) * DRAG_LIFT_SPRING_STIFF - dv.offVX * DRAG_LIFT_SPRING_DAMP;
    const ay = (dv.targetOffY - dv.offY) * DRAG_LIFT_SPRING_STIFF - dv.offVY * DRAG_LIFT_SPRING_DAMP;
    dv.offVX += ax;
    dv.offVY += ay;
    dv.offX += dv.offVX;
    dv.offY += dv.offVY;
    applyDragLiftTransform(s);
    const settled = dv.ending
      && Math.abs(dv.scaleTarget - dv.scale) < DRAG_LIFT_END_EPS
      && Math.abs(dv.offX) < DRAG_LIFT_OFFSET_EPS
      && Math.abs(dv.offY) < DRAG_LIFT_OFFSET_EPS
      && Math.abs(dv.offVX) < DRAG_LIFT_OFFSET_EPS
      && Math.abs(dv.offVY) < DRAG_LIFT_OFFSET_EPS;
    if (settled) {
      const el2 = dragLiftElement(s);
      const pos = dragLiftPosition(s);
      if (el2 && pos) {
        delete el2.dataset.m002LiftLock;
        el2.classList.remove('m002-lifted');
        el2.setAttribute('transform', `translate(${pos.x} ${pos.y})`);
      }
      s.dragVisual = null;
      return;
    }
    dv.raf = requestAnimationFrame(tick);
  };
  s.dragVisual.raf = requestAnimationFrame(tick);
}

function updateDragLiftFromPointer(s, clientX, clientY) {
  const dv = s.dragVisual;
  if (!dv || dv.ending) return;
  const now = performance.now();
  if (dv.lastClientX != null) {
    const dt = Math.max(1, now - dv.lastTime);
    // Cursor velocity in world units / ms — divide by zoom so a 12-pixel lag
    // looks the same regardless of how zoomed-in the canvas is.
    const zoom = s.view?.zoom || 1;
    const ivx = (clientX - dv.lastClientX) / dt / zoom;
    const ivy = (clientY - dv.lastClientY) / dt / zoom;
    const a = DRAG_LIFT_VEL_SMOOTH;
    dv.smoothVX = dv.smoothVX * (1 - a) + ivx * a;
    dv.smoothVY = dv.smoothVY * (1 - a) + ivy * a;
  }
  dv.lastClientX = clientX;
  dv.lastClientY = clientY;
  dv.lastTime = now;
}

function endDragLift(s) {
  const dv = s.dragVisual;
  if (!dv) return;
  dv.ending = true;
  dv.scaleTarget = 1;
  dv.targetOffX = 0;
  dv.targetOffY = 0;
}

// Aligns a freshly-dropped device or stack onto the nearest grid cell when
// "Snap to grid on drop" is enabled. The snap is applied as a delta so any
// multi-selection that came along during the drag stays cohesive — they
// shift by the same vector instead of each landing on its own cell.
function snapDropToGrid(s, kind, id) {
  let cx, cy;
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === id);
    if (!dev) return;
    cx = dev.x; cy = dev.y;
  } else if (kind === 'stack') {
    const st = findStackById(s, id);
    if (!st) return;
    cx = st.x; cy = st.y;
  } else return;
  const tx = Math.round(cx / GRID) * GRID;
  const ty = Math.round(cy / GRID) * GRID;
  const ddx = tx - cx, ddy = ty - cy;
  if (ddx === 0 && ddy === 0) return;
  const group = collectGroupTargets(s, { kind, id });
  group.forEach((it) => moveItemBy(s, it, ddx, ddy));
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === id);
    if (dev) updateLinksFor(s, dev.id);
  }
  // Mirror onMove: redraw LAG-pair lines for every involved stack member.
  // moveItemBy redraws regular per-link <g>'s but not the laglink-id pair
  // visuals, so a free-move drop would otherwise leave the LAG-pair line
  // pinned at the last off-grid position from the drag.
  group.forEach((it) => {
    if (it.kind === 'stack') {
      const st = findStackById(s, it.id);
      if (st) st.members.forEach((mid) => updateLagPairsFor(s, mid));
    } else if (it.kind === 'device') {
      updateLagPairsFor(s, it.id);
    }
  });
  if (s.activeLayer === 'routing') drawL3Paths(s);
  refreshAggregates(s);
}

function cancelDragLift(s) {
  // Immediate teardown — used when the lifted element is about to be replaced
  // (drop-to-stack merges the source into a freshly-rendered stack icon, so a
  // soft settle would tick against a stale dom node).
  const dv = s.dragVisual;
  if (!dv) return;
  if (dv.raf) cancelAnimationFrame(dv.raf);
  const el = dragLiftElement(s);
  if (el) { delete el.dataset.m002LiftLock; el.classList.remove('m002-lifted'); }
  s.dragVisual = null;
}

// =============================================================================
// Rope drag — right-click + drag from a device pulls a fluid cable that you can
// drop on another device to create a link. The rope tip springs after the cursor
// (under-damped to feel cable-like), the curve sags between origin and tip, and
// a missed drop animates the tip retracting back into the source element.
// =============================================================================
const ROPE_SPRING_STIFF   = 0.20;
const ROPE_SPRING_DAMP    = 0.55;
const ROPE_SAG_FACTOR     = 0.18;   // sag depth as fraction of length
const ROPE_SAG_MAX        = 70;     // world units cap so long pulls stay on screen
const ROPE_TIP_LAG_FACTOR = 35;     // ms — velocity → trailing offset on the tip
const ROPE_TIP_LAG_MAX    = 60;
const ROPE_VEL_SMOOTH     = 0.30;
const ROPE_VEL_DECAY      = 0.85;
const ROPE_RETRACT_END    = 0.6;    // retract animation stop threshold (world units)

function startRopeDrag(s, fromDeviceId, clientX, clientY) {
  cancelRopeDrag(s);
  const dev = s.devices.find((d) => d.id === fromDeviceId);
  if (!dev || !s.gOverlay) return;
  const origin = effectivePos(s, fromDeviceId);
  if (!origin) return;
  const w = clientToWorld(s, clientX, clientY);
  const t = typeOf(dev.type);
  const accent = t?.accent || '#ff003c';

  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-rope');
  g.setAttribute('pointer-events', 'none');
  const halo = document.createElementNS(SVG_NS, 'path');
  halo.setAttribute('class', 'm002-rope-halo');
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', accent);
  halo.setAttribute('stroke-width', '7');
  halo.setAttribute('stroke-linecap', 'round');
  halo.setAttribute('opacity', '0.18');
  const line = document.createElementNS(SVG_NS, 'path');
  line.setAttribute('class', 'm002-rope-line');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', accent);
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  const tipDot = document.createElementNS(SVG_NS, 'circle');
  tipDot.setAttribute('class', 'm002-rope-tip');
  tipDot.setAttribute('r', '4.5');
  tipDot.setAttribute('fill', accent);
  g.appendChild(halo);
  g.appendChild(line);
  g.appendChild(tipDot);
  s.gOverlay.appendChild(g);

  s.dragRope = {
    fromId: fromDeviceId,
    accent,
    originX: origin.x, originY: origin.y,
    tipX: w.x, tipY: w.y,
    targetX: w.x, targetY: w.y,
    tipVX: 0, tipVY: 0,
    smoothVX: 0, smoothVY: 0,
    lastClientX: clientX, lastClientY: clientY,
    lastTime: performance.now(),
    g, halo, line, tipDot,
    targetId: null,
    retracting: false,
    moved: false,
    startClientX: clientX, startClientY: clientY,
    raf: null,
  };
  s.host?.classList.add('m002-roping');
  applyRopePath(s);

  const tick = () => {
    const r = s.dragRope;
    if (!r) return;
    // Origin can shift if the source device is moved between frames (rare —
    // rope owns the gesture so device drag isn't possible — but keep it honest).
    const op = effectivePos(s, r.fromId);
    if (op) { r.originX = op.x; r.originY = op.y; }
    r.smoothVX *= ROPE_VEL_DECAY;
    r.smoothVY *= ROPE_VEL_DECAY;
    let tx, ty;
    if (r.retracting) {
      tx = r.originX; ty = r.originY;
    } else {
      // Trail the cursor by a velocity-proportional offset so quick swipes
      // see the tip lag, then catch up — the same trick used for drag-lift.
      let lagX = -r.smoothVX * ROPE_TIP_LAG_FACTOR;
      let lagY = -r.smoothVY * ROPE_TIP_LAG_FACTOR;
      const lm = Math.hypot(lagX, lagY);
      if (lm > ROPE_TIP_LAG_MAX) { const f = ROPE_TIP_LAG_MAX / lm; lagX *= f; lagY *= f; }
      tx = r.targetX + lagX;
      ty = r.targetY + lagY;
    }
    const ax = (tx - r.tipX) * ROPE_SPRING_STIFF - r.tipVX * ROPE_SPRING_DAMP;
    const ay = (ty - r.tipY) * ROPE_SPRING_STIFF - r.tipVY * ROPE_SPRING_DAMP;
    r.tipVX += ax; r.tipVY += ay;
    r.tipX += r.tipVX; r.tipY += r.tipVY;
    applyRopePath(s);
    if (r.retracting) {
      const d = Math.hypot(r.tipX - r.originX, r.tipY - r.originY);
      const v = Math.hypot(r.tipVX, r.tipVY);
      if (d < ROPE_RETRACT_END && v < ROPE_RETRACT_END) {
        cancelRopeDrag(s);
        return;
      }
    }
    r.raf = requestAnimationFrame(tick);
  };
  s.dragRope.raf = requestAnimationFrame(tick);
}

function ropePathD(ox, oy, tx, ty) {
  const dx = tx - ox, dy = ty - oy;
  const d = Math.hypot(dx, dy);
  const sag = Math.min(d * ROPE_SAG_FACTOR, ROPE_SAG_MAX);
  const c1x = ox + dx * 0.33;
  const c1y = oy + dy * 0.33 + sag;
  const c2x = ox + dx * 0.66;
  const c2y = oy + dy * 0.66 + sag;
  return `M ${ox.toFixed(2)} ${oy.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${tx.toFixed(2)} ${ty.toFixed(2)}`;
}

function applyRopePath(s) {
  const r = s.dragRope;
  if (!r) return;
  const d = ropePathD(r.originX, r.originY, r.tipX, r.tipY);
  r.halo.setAttribute('d', d);
  r.line.setAttribute('d', d);
  r.tipDot.setAttribute('cx', r.tipX.toFixed(2));
  r.tipDot.setAttribute('cy', r.tipY.toFixed(2));
}

function updateRopeFromPointer(s, clientX, clientY) {
  const r = s.dragRope;
  if (!r || r.retracting) return;
  const w = clientToWorld(s, clientX, clientY);
  r.targetX = w.x;
  r.targetY = w.y;
  const now = performance.now();
  if (r.lastClientX != null) {
    const dt = Math.max(1, now - r.lastTime);
    const zoom = s.view?.zoom || 1;
    const ivx = (clientX - r.lastClientX) / dt / zoom;
    const ivy = (clientY - r.lastClientY) / dt / zoom;
    const a = ROPE_VEL_SMOOTH;
    r.smoothVX = r.smoothVX * (1 - a) + ivx * a;
    r.smoothVY = r.smoothVY * (1 - a) + ivy * a;
  }
  r.lastClientX = clientX;
  r.lastClientY = clientY;
  r.lastTime = now;
  if (Math.hypot(clientX - r.startClientX, clientY - r.startClientY) > 4) r.moved = true;
  setRopeTarget(s, ropeTargetUnder(s, clientX, clientY));
}

function ropeTargetUnder(s, clientX, clientY) {
  const r = s.dragRope;
  if (!r) return null;
  // elementsFromPoint walks the full hit stack — needed because overlay UI
  // (the custom cursor follower, vignette, etc.) sits on top of the SVG and
  // would otherwise mask the device hit. We just look for the first ancestor
  // carrying a device id.
  const els = document.elementsFromPoint(clientX, clientY);
  for (const el of els) {
    const devEl = el.closest && el.closest('[data-device-id]');
    if (devEl && devEl.dataset.deviceId !== r.fromId) return devEl.dataset.deviceId;
  }
  return null;
}

function setRopeTarget(s, deviceId) {
  const r = s.dragRope;
  if (!r) return;
  if (r.targetId === deviceId) return;
  if (r.targetId) {
    s.gDevices?.querySelector(`[data-device-id="${r.targetId}"]`)?.classList.remove('m002-rope-target');
  }
  r.targetId = deviceId || null;
  if (r.targetId) {
    s.gDevices?.querySelector(`[data-device-id="${r.targetId}"]`)?.classList.add('m002-rope-target');
  }
}

function commitRopeLink(s, fromId, toId) {
  // Mirror handleLinkClick's validity rules — the rope is just a faster gesture,
  // not a way to slip past the constraints (no intra-stack, no JUMP↔JUMP, no
  // cross-zone JUMP hub-leg).
  const devA = s.devices.find((d) => d.id === fromId);
  const devB = s.devices.find((d) => d.id === toId);
  if (!devA || !devB) return false;
  const stA = findStack(s, fromId);
  const stB = findStack(s, toId);
  if (stA && stA === stB) {
    // Two members of the same stack — turn this gesture into a stack-link.
    const slId = commitIntraStackLink(s, stA, fromId, toId);
    if (slId) toast(s, 'Stack-link added');
    return !!slId;
  }
  if (isReference(devA) && isReference(devB)) { toast(s, 'Couple JUMPs via the inspector COUPLE WITH dropdown'); return false; }
  if ((isReference(devA) || isReference(devB)) && devA.zone !== devB.zone) { toast(s, 'JUMP hub-leg must stay in the same zone'); return false; }
  snapshot(s);
  const link = { id: rid(), from: fromId, to: toId, fromPort: '', toPort: '' };
  s.links.push(link);
  invalidateEdgeSlots(s);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (l.from === link.from || l.from === link.to ||
        l.to   === link.from || l.to   === link.to) redrawLink(s, l);
  });
  drawLink(s, link);
  if (s.activeLayer === 'routing') drawL3Paths(s);
  updateStatus(s);
  schedSave(s);
  select(s, 'link', link.id);
  toast(s, `Linked ${devA.name} ⇄ ${devB.name}`);
  return true;
}

function endRopeDrag(s) {
  const r = s.dragRope;
  if (!r) return;
  if (r.targetId && r.moved) {
    const fromId = r.fromId;
    const toId = r.targetId;
    setRopeTarget(s, null);
    cancelRopeDrag(s);
    commitRopeLink(s, fromId, toId);
    return;
  }
  setRopeTarget(s, null);
  // Missed drop — let the tip spring home, then dispose in the rAF tick.
  r.retracting = true;
}

function cancelRopeDrag(s) {
  const r = s.dragRope;
  if (!r) return;
  if (r.raf) cancelAnimationFrame(r.raf);
  if (r.targetId) {
    s.gDevices?.querySelector(`[data-device-id="${r.targetId}"]`)?.classList.remove('m002-rope-target');
  }
  r.g?.remove();
  s.dragRope = null;
  s.host?.classList.remove('m002-roping');
}

// =============================================================================
// Auto-link suggestion — while a device is being dragged, the nearest unlinked
// device within a sweet-spot range grows a tentative connection toward it.
// Visually it's two straight stubs reaching out from each end; their length
// scales with proximity, and the moment the gap collapses they snap together
// into a single solid line. Drop within range commits the link; drop outside
// just relocates as usual. Stack-merge (closer than 70 units, same type) takes
// priority since the visuals would otherwise step on each other.
// =============================================================================
const AUTOLINK_MIN_DIST = 95;       // a hair above the stack-merge threshold so
                                    // they don't both fight for the same hover
const AUTOLINK_MAX_DIST = 346;      // suggestion starts pre-fading from here so
                                    // approaching a device feels magnetic well
                                    // before the link actually arms
const AUTOLINK_CONNECT_T  = 0.50;   // mid-band: stubs snap into one solid line
                                    // and the drop is armed for commit. A wide
                                    // armed band → easy to land the connection
                                    // without having to nudge devices on top of
                                    // each other.

function alreadyLinkedDevices(s, deviceId) {
  const set = new Set();
  s.links?.forEach((l) => {
    if (l.from === deviceId) set.add(l.to);
    else if (l.to === deviceId) set.add(l.from);
  });
  // Hub-tunnel: a JUMP relays its broadcast domain to every other hub-leg in
  // its zone AND to the hub-legs of its coupled peer in the other zone. Treat
  // anything sharing that domain as already connected — auto-link should not
  // suggest a redundant wire to a node the JUMP already speaks for.
  const direct = Array.from(set);
  direct.forEach((nbId) => {
    const nb = s.devices.find((d) => d.id === nbId);
    if (!isReference(nb)) return;
    hubLocalLegs(s, nb.id).forEach(({ device }) => { if (device.id !== deviceId) set.add(device.id); });
    hubFarLegs(s, nb.id).forEach(({ device }) => { if (device.id !== deviceId) set.add(device.id); });
  });
  // Source side: a JUMP being dragged also shares a domain with its couple
  // peer's hub-legs (cross-zone), so include them too for symmetry. The
  // auto-link zone filter still hides cross-zone candidates from the canvas.
  const self = s.devices.find((d) => d.id === deviceId);
  if (isReference(self)) {
    hubFarLegs(s, deviceId).forEach(({ device }) => set.add(device.id));
  }
  return set;
}

// Member of a collapsed stack? Then it's not visually distinct — the stack
// icon stands in for the whole bundle, and a per-member wire makes no sense.
function isHiddenInCollapsedStack(s, devId) {
  const st = findStack(s, devId);
  return !!(st && isStackCollapsed(s, st));
}

function findAutoLinkCandidate(s, dev) {
  // Dragged member of a collapsed stack: only the icon is visible, no per-member
  // wire to draw. Member of an EXPANDED stack is fair game — its body is on
  // screen and the user can pull a wire out of it.
  if (isHiddenInCollapsedStack(s, dev.id)) return null;
  const linked = alreadyLinkedDevices(s, dev.id);
  const devZone = dev.zone || null;
  const fromStack = findStack(s, dev.id);
  let best = null;
  let bestDist = Infinity;
  for (const d of s.devices) {
    if (d.id === dev.id) continue;
    if (linked.has(d.id)) continue;
    // JUMP↔JUMP couplings happen via the inspector, not the canvas — skip the
    // pair where both ends are JUMPs. JUMP + non-JUMP is a valid hub-leg.
    if (isReference(dev) && isReference(d)) continue;
    // Hidden inside a collapsed stack → invisible target, skip.
    if (isHiddenInCollapsedStack(s, d.id)) continue;
    // Same-stack siblings would be intra-stack links, owned by the stack-link
    // editor — not auto-link's job.
    const toStack = findStack(s, d.id);
    if (fromStack && toStack && fromStack === toStack) continue;
    // Cross-zone candidates aren't visible in the current view — never
    // suggest a wire to a hidden node.
    if ((d.zone || null) !== devZone) continue;
    const dx = dev.x - d.x, dy = dev.y - d.y;
    const dist = Math.hypot(dx, dy);
    if (dist < AUTOLINK_MIN_DIST || dist > AUTOLINK_MAX_DIST) continue;
    if (dist < bestDist) { bestDist = dist; best = d; }
  }
  return best ? { dev: best, dist: bestDist } : null;
}

function ensureAutoLinkLayer(s) {
  if (s.autoLink?.g && s.autoLink.g.isConnected) return s.autoLink;
  if (!s.gOverlay) return null;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-autolink');
  g.setAttribute('pointer-events', 'none');
  // Two reaching stubs (one rooted on each device). Paths instead of straight
  // lines so they can wave/snake-search as they extend toward each other.
  const fromStub = document.createElementNS(SVG_NS, 'path');
  fromStub.setAttribute('class', 'm002-autolink-stub m002-autolink-stub-from');
  fromStub.setAttribute('fill', 'none');
  fromStub.setAttribute('stroke-linecap', 'round');
  fromStub.setAttribute('stroke-width', '2');
  fromStub.setAttribute('opacity', '0');
  const toStub = document.createElementNS(SVG_NS, 'path');
  toStub.setAttribute('class', 'm002-autolink-stub m002-autolink-stub-to');
  toStub.setAttribute('fill', 'none');
  toStub.setAttribute('stroke-linecap', 'round');
  toStub.setAttribute('stroke-width', '2');
  toStub.setAttribute('opacity', '0');
  const fromTip = document.createElementNS(SVG_NS, 'circle');
  fromTip.setAttribute('class', 'm002-autolink-tip');
  fromTip.setAttribute('r', '2.4');
  fromTip.setAttribute('opacity', '0');
  const toTip = document.createElementNS(SVG_NS, 'circle');
  toTip.setAttribute('class', 'm002-autolink-tip');
  toTip.setAttribute('r', '2.4');
  toTip.setAttribute('opacity', '0');
  const fullLine = document.createElementNS(SVG_NS, 'line');
  fullLine.setAttribute('class', 'm002-autolink-full');
  fullLine.setAttribute('stroke-linecap', 'round');
  fullLine.setAttribute('stroke-width', '2.4');
  fullLine.setAttribute('opacity', '0');
  g.appendChild(fromStub);
  g.appendChild(toStub);
  g.appendChild(fromTip);
  g.appendChild(toTip);
  g.appendChild(fullLine);
  s.gOverlay.appendChild(g);
  s.autoLink = {
    g, fromStub, toStub, fromTip, toTip, fullLine,
    targetId: null,
    fromId: null,
    armed: false, // true once the stubs would meet — the only state that allows commit
    t0: performance.now(), // animation epoch — drives the wave phase
    raf: null,
  };
  return s.autoLink;
}

function setAutoLinkTarget(s, fromDev, candidate) {
  const al = ensureAutoLinkLayer(s);
  if (!al) return;
  const desiredTarget = candidate?.dev?.id || null;
  if (al.targetId !== desiredTarget) {
    if (al.targetId) {
      s.gDevices?.querySelector(`[data-device-id="${al.targetId}"]`)?.classList.remove('m002-autolink-target');
    }
    al.targetId = desiredTarget;
    if (al.targetId) {
      s.gDevices?.querySelector(`[data-device-id="${al.targetId}"]`)?.classList.add('m002-autolink-target');
    }
  }
  al.fromId = fromDev.id;

  if (!candidate) {
    al.fromStub.setAttribute('opacity', '0');
    al.toStub.setAttribute('opacity', '0');
    al.fromTip.setAttribute('opacity', '0');
    al.toTip.setAttribute('opacity', '0');
    al.fullLine.setAttribute('opacity', '0');
    al.armed = false;
    return;
  }

  // Each stub wears its own device's accent so the two reach toward each
  // other in their own colours; they only blend at the moment of contact.
  const fromT = typeOf(fromDev.type);
  const toT   = typeOf(candidate.dev.type);
  const fromAccent = fromT?.accent || '#ff003c';
  const toAccent   = toT?.accent   || fromAccent;
  al.fromStub.setAttribute('stroke', fromAccent);
  al.toStub.setAttribute('stroke', toAccent);
  al.fromTip.setAttribute('fill', fromAccent);
  al.toTip.setAttribute('fill', toAccent);
  al.fullLine.setAttribute('stroke', fromAccent);

  drawAutoLinkReach(s, fromDev, candidate.dev, candidate.dist);
}

// Ray from a centred rectangle's centre along (ux, uy) hits the rect border at:
//   t = min(hw / |ux|, hh / |uy|)
// The clamp keeps a near-axial line from blowing the divisor up.
function rectEdgeAlongDir(cx, cy, hw, hh, ux, uy) {
  const ax = Math.max(Math.abs(ux), 1e-6);
  const ay = Math.max(Math.abs(uy), 1e-6);
  const t = Math.min(hw / ax, hh / ay);
  return { x: cx + ux * t, y: cy + uy * t };
}

// Snake-path: cubic Bezier from (ax, ay) to (bx, by) with two control points
// offset perpendicular to the spine by an animated sine wave. The wave eases
// out at the root (which is anchored on a device) and at the tip (where the
// other half is reaching toward us), so the centre wobbles freely while the
// endpoints stay pinned. Bias t0 so the wave at root/tip starts at zero —
// avoids a kink the moment the path is rebuilt.
function snakePathD(ax, ay, bx, by, ux, uy, time, phase, amp) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  // Perpendicular unit vector (rotate spine 90°).
  const px = -uy, py = ux;
  // Two control points along the spine at 1/3 and 2/3.
  const sample = (t) => {
    // Envelope is 0 at endpoints, 1 in the middle — sin(πt) does that smoothly.
    const env = Math.sin(t * Math.PI);
    // Two superimposed waves give a more organic, less metronome motion.
    const w  = Math.sin(t * Math.PI * 1.6 + time * 0.0055 + phase) * 0.7
             + Math.sin(t * Math.PI * 2.6 - time * 0.0038 + phase * 1.7) * 0.3;
    return amp * env * w;
  };
  const o1 = sample(0.33);
  const o2 = sample(0.66);
  const c1x = ax + dx * 0.33 + px * o1;
  const c1y = ay + dy * 0.33 + py * o1;
  const c2x = ax + dx * 0.66 + px * o2;
  const c2y = ay + dy * 0.66 + py * o2;
  return `M ${ax.toFixed(2)} ${ay.toFixed(2)} C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${bx.toFixed(2)} ${by.toFixed(2)}`;
}

function drawAutoLinkReach(s, fromDev, toDev, dist) {
  const al = s.autoLink;
  if (!al) return;
  const aCenter = effectivePos(s, fromDev.id);
  const bCenter = effectivePos(s, toDev.id);
  if (!aCenter || !bCenter) return;

  const span = AUTOLINK_MAX_DIST - AUTOLINK_MIN_DIST;
  const raw  = 1 - Math.min(1, Math.max(0, (dist - AUTOLINK_MIN_DIST) / span));
  // Smoothstep — slow start, smooth into the meeting point.
  const reach = raw * raw * (3 - 2 * raw);

  // Direction along the centre-to-centre line; the edge intersections inherit
  // it so both stubs start exactly on each device's border (no more wires
  // sprouting out of the centre and crossing the icon's interior).
  const dx = bCenter.x - aCenter.x, dy = bCenter.y - aCenter.y;
  const dlen = Math.hypot(dx, dy) || 1;
  const ux = dx / dlen, uy = dy / dlen;
  const a = rectEdgeAlongDir(aCenter.x, aCenter.y, DEVICE_W / 2, DEVICE_H / 2,  ux,  uy);
  const b = rectEdgeAlongDir(bCenter.x, bCenter.y, DEVICE_W / 2, DEVICE_H / 2, -ux, -uy);
  // Recompute the gap between the two edge points — the stubs grow into THIS
  // gap, not the full centre-to-centre distance, so the meeting point sits
  // visually between the two icons.
  const gx = b.x - a.x, gy = b.y - a.y;
  const glen = Math.hypot(gx, gy) || 1;
  const half = glen / 2;

  // Stubs scale so they fully meet at midpoint exactly when reach hits
  // CONNECT_T. Past that they hold the meeting visual instead of overshooting
  // — calm and steady, no oscillation, and the moment of "joined" lasts the
  // entire armed band so the user has a generous landing window.
  const lenFactor = Math.min(1, reach / AUTOLINK_CONNECT_T);
  const stubLen = half * lenFactor;
  const armed = reach >= AUTOLINK_CONNECT_T;
  al.armed = armed;

  const aTipX = a.x + ux * stubLen;
  const aTipY = a.y + uy * stubLen;
  const bTipX = b.x - ux * stubLen;
  const bTipY = b.y - uy * stubLen;

  // Cache the geometry so the rAF tick can re-render the wavy path each frame
  // without recomputing reach/edge intersections from scratch.
  al.geom = {
    ax: a.x, ay: a.y, aTipX, aTipY,
    bx: b.x, by: b.y, bTipX, bTipY,
    ux, uy,
    stubLen,
    armed,
    reach,
  };
  applyAutoLinkFrame(al);

  al.fromTip.setAttribute('cx', aTipX.toFixed(2));
  al.fromTip.setAttribute('cy', aTipY.toFixed(2));
  al.toTip.setAttribute('cx', bTipX.toFixed(2));
  al.toTip.setAttribute('cy', bTipY.toFixed(2));

  // Opacity ramps with reach; once armed, both stubs go full strength so the
  // joined line reads as solid. Tip dots dim out at meeting because the two
  // would just overlap on the midpoint.
  const op = armed ? 1 : (0.30 + 0.65 * reach);
  al.fromStub.setAttribute('opacity', String(op));
  al.toStub.setAttribute('opacity', String(op));
  const tipOp = armed ? 0 : (0.40 + 0.55 * reach);
  al.fromTip.setAttribute('opacity', String(tipOp));
  al.toTip.setAttribute('opacity', String(tipOp));
  // The pre-rendered fullLine layer is no longer needed — stubs do the whole
  // animation continuously now, no discrete swap.
  al.fullLine.setAttribute('opacity', '0');

  // Make sure the wave loop is running — rAF stops itself once the layer is
  // cleared, so kick it back on every time we get a fresh candidate.
  if (!al.raf) {
    const tick = () => {
      const cur = s.autoLink;
      if (!cur || !cur.targetId || !cur.geom) { if (cur) cur.raf = null; return; }
      applyAutoLinkFrame(cur);
      cur.raf = requestAnimationFrame(tick);
    };
    al.raf = requestAnimationFrame(tick);
  }
}

// Re-render the snake paths from cached geometry. Called on every move (so
// the spine keeps up with cursor) and on every rAF (so the wave keeps moving
// even when the pointer is still).
function applyAutoLinkFrame(al) {
  const g = al.geom;
  if (!g) return;
  const time = performance.now() - al.t0;
  // Wave amplitude — generous mid-reach so the stubs really hunt for each
  // other, then tames down once armed so the joined line reads as a calm
  // commitment rather than a wriggling worm.
  const baseAmp = g.armed
    ? 4.0 + 2.0 * Math.sin(time * 0.0030)         // gentle live pulse, more presence
    : 8.0 + 16.0 * g.reach * (1 - g.reach * 0.5); // bigger swing, especially mid-reach
  // Two stubs run at different phases so they don't mirror each other.
  const dFrom = snakePathD(g.ax, g.ay, g.aTipX, g.aTipY, g.ux, g.uy, time, 0,    baseAmp);
  const dTo   = snakePathD(g.bx, g.by, g.bTipX, g.bTipY, -g.ux, -g.uy, time, 2.1, baseAmp);
  al.fromStub.setAttribute('d', dFrom);
  al.toStub.setAttribute('d', dTo);
}

function clearAutoLink(s) {
  const al = s.autoLink;
  if (!al) return;
  if (al.raf) cancelAnimationFrame(al.raf);
  if (al.targetId) {
    s.gDevices?.querySelector(`[data-device-id="${al.targetId}"]`)?.classList.remove('m002-autolink-target');
  }
  al.g?.remove();
  s.autoLink = null;
}

function commitAutoLink(s, fromId, toId) {
  // Same validity gate as handleLinkClick / commitRopeLink — auto-link is just
  // another path to the same data mutation, the constraints stay identical.
  const devA = s.devices.find((d) => d.id === fromId);
  const devB = s.devices.find((d) => d.id === toId);
  if (!devA || !devB) return false;
  const stA = findStack(s, fromId);
  const stB = findStack(s, toId);
  if (stA && stA === stB) return false;
  if (isReference(devA) && isReference(devB)) return false;
  if ((isReference(devA) || isReference(devB)) && devA.zone !== devB.zone) return false;
  // Defensive: if a link already exists between this pair, skip — auto-link
  // is a one-shot suggestion, not a way to stack duplicates.
  const dup = s.links?.some((l) => (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId));
  if (dup) return false;
  snapshot(s);
  const link = { id: rid(), from: fromId, to: toId, fromPort: '', toPort: '' };
  s.links.push(link);
  invalidateEdgeSlots(s);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (l.from === link.from || l.from === link.to ||
        l.to   === link.from || l.to   === link.to) redrawLink(s, l);
  });
  drawLink(s, link);
  if (s.activeLayer === 'routing') drawL3Paths(s);
  updateStatus(s);
  schedSave(s);
  return true;
}

// =============================================================================
// Board interaction — pan / zoom / drag
// =============================================================================
function bindBoard(s) {
  const svg = s.svg;

  // Custom-cursor hover state. The N.IVEN cursor's .active class scales the
  // brackets up by default — in MOD_002 we instead pivot the whole bracket
  // frame 45° around the cursor centre, "standing on its tip". To rotate
  // them as one unit (instead of each bracket spinning in place), wrap the
  // bracket spans in a frame div on mount and restore on unmount.
  const cursorEl = document.querySelector('.cursor');
  if (cursorEl && !cursorEl.querySelector('.m002-cursor-frame')) {
    const frame = document.createElement('div');
    frame.className = 'm002-cursor-frame';
    while (cursorEl.firstChild) frame.appendChild(cursorEl.firstChild);
    cursorEl.appendChild(frame);
    s.cleanups.push(() => {
      const f = cursorEl.querySelector('.m002-cursor-frame');
      if (f) {
        while (f.firstChild) cursorEl.appendChild(f.firstChild);
        f.remove();
      }
    });
  }
  const interactiveSel = '[data-device-id], [data-stack-id], [data-link-id], [data-laglink-id], [data-agg-key], .m002-link-hit, .m002-stack-collapsed, .m002-stack-envelope';
  const onHoverIn = (e) => {
    if (!cursorEl) return;
    if (e.target.closest(interactiveSel)) cursorEl.classList.add('active');
  };
  const onHoverOut = (e) => {
    if (!cursorEl) return;
    if (e.relatedTarget && e.relatedTarget.closest(interactiveSel)) return;
    cursorEl.classList.remove('active');
  };
  s.host.addEventListener('mouseover', onHoverIn);
  s.host.addEventListener('mouseout', onHoverOut);
  s.cleanups.push(() => {
    s.host.removeEventListener('mouseover', onHoverIn);
    s.host.removeEventListener('mouseout', onHoverOut);
    cursorEl?.classList.remove('active');
  });

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
    const devEl = e.target.closest('[data-device-id]');
    const stackEl = e.target.closest('[data-stack-id]');
    const linkEl = e.target.closest('[data-link-id]');
    const onBg = e.target === svg || e.target.classList.contains('m002-grid-bg') || e.target.classList.contains('m002-grid-bg2');

    // Right-click on the background → open the radial action menu at the
    // cursor. Right-click on a device is intentionally a no-op for now —
    // reserved for a future per-node context action. The native browser menu
    // is suppressed in either case via the contextmenu listener below.
    if (e.button === 2) {
      if (devEl || stackEl || linkEl) {
        e.preventDefault();
        return;
      }
      openRadialMenu(s, e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    if (e.button !== 0 && e.button !== 1) return;

    if (s.linkMode && devEl && e.button === 0) {
      handleLinkClick(s, devEl.dataset.deviceId);
      e.preventDefault();
      return;
    }
    if (s.deleteMode && e.button === 0) {
      if (linkEl)  { deleteRef(s, { kind: 'link',   id: linkEl.dataset.linkId   }); e.preventDefault(); return; }
      if (stackEl) { deleteRef(s, { kind: 'stack',  id: stackEl.dataset.stackId }); e.preventDefault(); return; }
      if (devEl)   { deleteRef(s, { kind: 'device', id: devEl.dataset.deviceId  }); e.preventDefault(); return; }
      // Empty space: fall through so the user can still pan in delete mode.
    }

    if (stackEl && e.button === 0) {
      const st = findStackById(s, stackEl.dataset.stackId);
      if (!st) return;
      if (e.shiftKey) { toggleMultiSelect(s, 'stack', st.id); e.preventDefault(); return; }
      // Select without recentering — the recenter fires on mouseup if the
      // gesture stayed a click (no drag). Otherwise dragging would fight the
      // camera glide and the icon would slide out from under the pointer.
      select(s, 'stack', st.id, { skipRecenter: true });
      snapshot(s);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'stack', id: st.id, dx: st.x - w.x, dy: st.y - w.y, startX: e.clientX, startY: e.clientY, recenterPending: true };
      s.host.classList.add('m002-dragging');
      e.preventDefault();
      return;
    }

    if (devEl && e.button === 0) {
      const dev = s.devices.find((d) => d.id === devEl.dataset.deviceId);
      if (!dev) return;
      if (e.shiftKey) { toggleMultiSelect(s, 'device', dev.id); e.preventDefault(); return; }
      // JUMP nodes: defer the action to mouseup. A clean click triggers
      // jumpToReference (so single-click hops zones, no double-click
      // needed); a drag past 4px relocates the icon as usual and selects.
      if (isReference(dev)) {
        snapshot(s);
        const w = clientToWorld(s, e.clientX, e.clientY);
        // recenterPending stays false: JUMPs hop on click (no auto-recenter
        // semantics), but the flag still needs to read `false` after a real
        // drag so snap-on-drop in onUp accepts it as a "real drag".
        s.drag = { kind: 'device', id: dev.id, dx: dev.x - w.x, dy: dev.y - w.y, startX: e.clientX, startY: e.clientY, jumpPending: true, recenterPending: false, moved: false };
        s.host.classList.add('m002-dragging');
        e.preventDefault();
        return;
      }
      select(s, 'device', dev.id, { skipRecenter: true });
      snapshot(s);
      const w = clientToWorld(s, e.clientX, e.clientY);
      s.drag = { kind: 'device', id: dev.id, dx: dev.x - w.x, dy: dev.y - w.y, startX: e.clientX, startY: e.clientY, recenterPending: true };
      s.host.classList.add('m002-dragging');
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

    const aggEl = e.target.closest('[data-agg-key]');
    if (aggEl && e.button === 0) {
      // Aggregate summary clicked — open the LAG configurator inline in the
      // inspector. The selection kind 'agg' carries the aggregate key so the
      // form can resolve the constituent links.
      select(s, 'agg', aggEl.dataset.aggKey);
      e.preventDefault();
      return;
    }

    if (linkEl && e.button === 0) {
      select(s, 'link', linkEl.dataset.linkId);
      e.preventDefault();
      return;
    }

    if (onBg || e.button === 1) {
      // Background click with link / delete tool active drops back to
      // SELECT. Cleaner than forcing the user to hit the toolbar pill or
      // ESC. Middle-click skips this so power-users can pan without
      // losing their active tool.
      if (e.button === 0 && (s.linkMode || s.deleteMode)) {
        if (s.linkMode) toggleLinkMode(s);
        if (s.deleteMode) toggleDeleteMode(s);
        refreshToolHighlights(s);
      }
      s.drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, vx: s.view.x, vy: s.view.y };
      e.preventDefault();
    }
  };
  const onMove = (e) => {
    if (s.dragRope) updateRopeFromPointer(s, e.clientX, e.clientY);
    if (!s.drag) return;
    if (s.drag.kind === 'pan') {
      s.drag.lastX = e.clientX;
      s.drag.lastY = e.clientY;
      s.view.x = s.drag.vx + (e.clientX - s.drag.startX);
      s.view.y = s.drag.vy + (e.clientY - s.drag.startY);
      applyView(s);
    } else if (s.drag.kind === 'device') {
      // JUMP click-vs-drag detection: once the pointer crosses a small
      // threshold, treat the gesture as a real drag and select normally.
      // Otherwise mouseup triggers jumpToReference (no select intermediate).
      if (s.drag.jumpPending) {
        const moved = Math.hypot(e.clientX - s.drag.startX, e.clientY - s.drag.startY) > 4;
        if (moved) {
          s.drag.jumpPending = false;
          select(s, 'device', s.drag.id, { skipRecenter: true });
          if (!s.dragVisual) startDragLift(s, 'device', s.drag.id);
        } else {
          return; // still ambiguous, don't move yet
        }
      }
      // Auto-recenter is deferred to mouseup so the camera doesn't fight an
      // active drag. Once the pointer crosses 4px we know the gesture is a
      // drag, not a clean click.
      if (s.drag.recenterPending && s.drag.startX != null) {
        if (Math.hypot(e.clientX - s.drag.startX, e.clientY - s.drag.startY) > 4) {
          s.drag.recenterPending = false;
          if (!s.dragVisual) startDragLift(s, 'device', s.drag.id);
        }
      }
      const w = clientToWorld(s, e.clientX, e.clientY);
      const dev = s.devices.find((d) => d.id === s.drag.id);
      if (!dev) return;
      let nx = w.x + s.drag.dx;
      let ny = w.y + s.drag.dy;
      // Snap during drag — Alt is a per-gesture inverter on top of the prefs
      // toggle, so users keep an escape hatch in either configuration.
      const freeDrag = !!s.prefs?.freeMove;
      const snapNow = e.altKey ? freeDrag : !freeDrag;
      const snapX = Math.round(nx / GRID) * GRID;
      const snapY = Math.round(ny / GRID) * GRID;
      if (snapNow) {
        nx = snapX;
        ny = snapY;
        clearSnapPreview(s);
      } else if (s.prefs?.snapOnDrop) {
        // Free-move: preview where the element would land on release —
        // gated by a brief dwell so a fast sweep doesn't flicker ghosts.
        scheduleSnapPreview(s, snapX, snapY, dragSnapAccent(s, 'device', dev.id));
      } else {
        clearSnapPreview(s);
      }
      s.drag.lastAlt = !!e.altKey;
      const ddx = nx - dev.x, ddy = ny - dev.y;
      // If this drag is part of a multi-selection, move every selected item
      const group = collectGroupTargets(s, { kind: 'device', id: dev.id });
      group.forEach((it) => moveItemBy(s, it, ddx, ddy));
      updateLinksFor(s, dev.id);
      const stk = findStack(s, dev.id);
      if (stk && !isStackCollapsed(s, stk)) refreshStackVisuals(s, stk);
      // L3 ribbons follow device positions — redraw the entire path layer
      // while dragging so the smooth curves stay anchored to the moving node.
      if (s.activeLayer === 'routing') drawL3Paths(s);
      refreshAggregates(s);

      // Drag-to-stack: highlight nearest valid merge candidate.
      // Skip when this device sits inside a stack (drag-to-merge across stacks
      // is too ambiguous for the prototype) or when shift is held.
      if (!e.shiftKey && !findStack(s, dev.id) && !isReference(dev)) {
        const STACK_MERGE_THRESH = 70;
        // Cross-zone entities are invisible in the current view — never let
        // a coincidental overlap create an interaction with a hidden node.
        const devZone = dev.zone || null;
        const sameZone = (other) => (other?.zone || null) === devZone;
        let target = null;
        for (const d of s.devices) {
          if (d.id === dev.id) continue;
          if (findStack(s, d.id)) continue;
          if (isReference(d)) continue;
          if (!sameZone(d)) continue;
          if (Math.hypot(dev.x - d.x, dev.y - d.y) < STACK_MERGE_THRESH) { target = { kind: 'device', id: d.id }; break; }
        }
        if (!target) {
          for (const st2 of s.stacks) {
            if (!isStackCollapsed(s, st2)) continue;
            if (st2.members.includes(dev.id)) continue;
            if (!sameZone(st2)) continue;
            if (Math.hypot(dev.x - st2.x, dev.y - st2.y) < STACK_MERGE_THRESH) { target = { kind: 'stack', id: st2.id }; break; }
          }
        }
        const compat = target ? (targetTypeOf(s, target) === dev.type) : false;
        const newKey = target ? `${target.kind}:${target.id}` : null;
        const newCompat = compat ? 'ok' : 'bad';
        if (newKey !== s.dragStackTarget || (target && s.dragStackTargetCompat !== newCompat)) {
          if (s.dragStackTarget) {
            const [ok, oid] = s.dragStackTarget.split(':');
            const oel = ok === 'stack'
              ? s.gDevices.querySelector(`[data-stack-id="${oid}"]`)
              : s.gDevices.querySelector(`[data-device-id="${oid}"]`);
            oel?.classList.remove('m002-drag-stack-target', 'm002-merge-ok', 'm002-merge-bad');
          }
          s.dragStackTarget = newKey;
          s.dragStackTargetCompat = target ? newCompat : null;
          if (newKey) {
            const [nk, nid] = newKey.split(':');
            const nel = nk === 'stack'
              ? s.gDevices.querySelector(`[data-stack-id="${nid}"]`)
              : s.gDevices.querySelector(`[data-device-id="${nid}"]`);
            nel?.classList.add('m002-drag-stack-target', compat ? 'm002-merge-ok' : 'm002-merge-bad');
          }
        }
      }
      // Stack-merge glow wins over the snap-to-grid ghost — they share the
      // same visual weight and the ghost predicts a landing spot the drop
      // will overrule anyway. Clear on every tick while a target is locked
      // (the snap preview was re-scheduled above this block).
      if (s.dragStackTarget) clearSnapPreview(s);

      // Auto-link suggestion. Only kicks in once the gesture has clearly
      // become a drag (recenterPending flipped off, JUMP click-vs-drag past
      // its 4px threshold) and never competes with a pending stack-merge —
      // close enough to merge, the user likely wants the stack, not a wire.
      // Shift suppresses it as an escape hatch.
      if (!e.shiftKey && !s.dragStackTarget && s.drag.recenterPending === false && !s.drag.jumpPending) {
        const cand = findAutoLinkCandidate(s, dev);
        setAutoLinkTarget(s, dev, cand);
      } else if (s.autoLink) {
        setAutoLinkTarget(s, dev, null);
      }
    } else if (s.drag.kind === 'stack') {
      if (s.drag.recenterPending && s.drag.startX != null) {
        if (Math.hypot(e.clientX - s.drag.startX, e.clientY - s.drag.startY) > 4) {
          s.drag.recenterPending = false;
          if (!s.dragVisual) startDragLift(s, 'stack', s.drag.id);
        }
      }
      const w = clientToWorld(s, e.clientX, e.clientY);
      const st = findStackById(s, s.drag.id);
      if (!st) return;
      let nx = w.x + s.drag.dx;
      let ny = w.y + s.drag.dy;
      const freeDrag = !!s.prefs?.freeMove;
      const snapNow = e.altKey ? freeDrag : !freeDrag;
      const snapX = Math.round(nx / GRID) * GRID;
      const snapY = Math.round(ny / GRID) * GRID;
      if (snapNow) {
        nx = snapX;
        ny = snapY;
        clearSnapPreview(s);
      } else if (s.prefs?.snapOnDrop) {
        scheduleSnapPreview(s, snapX, snapY, dragSnapAccent(s, 'stack', st.id), stackSnapPreviewOpts(s, st));
      } else {
        clearSnapPreview(s);
      }
      s.drag.lastAlt = !!e.altKey;
      const ddx = nx - st.x, ddy = ny - st.y;
      st.x = nx; st.y = ny;
      st.members.forEach((mid) => {
        const m = s.devices.find((d) => d.id === mid);
        if (m) {
          m.x += ddx; m.y += ddy;
          updateDeviceTransform(s, m);
        }
      });
      // If part of a multi-selection, also move other selected items
      const group = collectGroupTargets(s, { kind: 'stack', id: st.id });
      group.filter((it) => !(it.kind === 'stack' && it.id === st.id)).forEach((it) => moveItemBy(s, it, ddx, ddy));
      // Move the collapsed icon if present (skip while the lift loop owns its
      // transform — the rAF tick keeps wobble + position in sync)
      const g = s.gDevices.querySelector(`[data-stack-id="${st.id}"]`);
      if (g && !g.dataset.m002LiftLock) g.setAttribute('transform', `translate(${st.x} ${st.y})`);
      // Move envelope + cables if expanded
      if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
      // Redraw links touching the stack — absorbed ones (owned by a LAG-pair
      // visual) get their stale element removed instead, otherwise the bare
      // link line leaks out from underneath the LAG double-line.
      const absorbed = computeAbsorbedLinkIds(s);
      s.links.forEach((l) => {
        if (!(st.members.includes(l.from) || st.members.includes(l.to))) return;
        if (absorbed.has(l.id)) {
          s.gLinks.querySelector(`[data-link-id="${l.id}"]`)?.remove();
          return;
        }
        redrawLink(s, l);
      });
      st.members.forEach((mid) => updateLagPairsFor(s, mid));
      if (s.activeLayer === 'routing') drawL3Paths(s);
      refreshAggregates(s);
    }
    // Lift / inertia: read pointer velocity, refresh the wobble target, and
    // re-write the dragged element's transform so the rAF settle never lags
    // a frame behind the cursor.
    if (s.dragVisual && (s.drag.kind === 'device' || s.drag.kind === 'stack')) {
      updateDragLiftFromPointer(s, e.clientX, e.clientY);
      applyDragLiftTransform(s);
    }
  };
  const onUp = (e) => {
    // Rope drag finishes independently of s.drag (right-click never sets it).
    if (s.dragRope && e.button === 2) {
      endRopeDrag(s);
      e.preventDefault();
      return;
    }
    // JUMP click without drag → hop to the referenced zone / map. Drag past
    // the 4px threshold flips jumpPending off in onMove and the mouseup
    // falls through to the regular drag-end path.
    if (s.drag?.kind === 'device' && s.drag.jumpPending) {
      const dev = s.devices.find((d) => d.id === s.drag.id);
      s.drag = null;
      s.host.classList.remove('m002-dragging');
      cancelDragLift(s); // jumping unmounts the zone — no settle animation possible
      clearAutoLink(s);
      if (dev) jumpToReference(s, dev);
      return;
    }
    // Auto-recenter on mouseup: only fires when the gesture stayed a click
    // (no drag past 4px). Avoids the camera fighting an active drag and
    // letting the icon slip out from under the pointer.
    const recenterClick = s.drag?.recenterPending === true && (s.drag.kind === 'device' || s.drag.kind === 'stack');
    const recenterId = recenterClick ? s.drag.id : null;
    const recenterKind = recenterClick ? s.drag.kind : null;
    // Drop-to-stack: a device was dragged onto another device or stack.
    if (s.drag?.kind === 'device' && s.dragStackTarget) {
      const [tk, tid] = s.dragStackTarget.split(':');
      const tel = tk === 'stack'
        ? s.gDevices.querySelector(`[data-stack-id="${tid}"]`)
        : s.gDevices.querySelector(`[data-device-id="${tid}"]`);
      tel?.classList.remove('m002-drag-stack-target', 'm002-merge-ok', 'm002-merge-bad');
      const dragId = s.drag.id;
      const compat = s.dragStackTargetCompat === 'ok';
      s.dragStackTarget = null;
      s.dragStackTargetCompat = null;
      s.drag = null;
      cancelDragLift(s); // merging re-renders the source — kill the wobble before its element vanishes
      clearAutoLink(s);
      if (!compat) {
        toast(s, 'Stack only allowed between same device types');
        return;
      }
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
      tel?.classList.remove('m002-drag-stack-target', 'm002-merge-ok', 'm002-merge-bad');
      s.dragStackTarget = null;
      s.dragStackTargetCompat = null;
    }
    // Auto-link commit. Only the "armed" state — when the two stubs have
    // visually fused into one line — actually creates the link. Faint hints
    // along the approach are visual nudges, not commitments; releasing in
    // that range just relocates the device.
    if (s.drag?.kind === 'device' && s.autoLink?.targetId && s.autoLink.armed) {
      const fromId = s.drag.id;
      const toId = s.autoLink.targetId;
      const ok = commitAutoLink(s, fromId, toId);
      clearAutoLink(s);
      if (ok) {
        const dev = s.devices.find((d) => d.id === toId);
        if (dev) {
          const t = typeOf(dev.type);
          if (t?.accent) vfxGridPulse(s, dev.x, dev.y, t.accent);
        }
      }
    } else if (s.autoLink) {
      clearAutoLink(s);
    }
    if (s.drag) {
      // True background click (mousedown→mouseup with no real pan) → deselect.
      // Threshold filters out tiny tremors so pan-drags never clear the inspector.
      if (s.drag.kind === 'pan' && !s.linkMode) {
        const dx = (s.drag.lastX ?? s.drag.startX) - s.drag.startX;
        const dy = (s.drag.lastY ?? s.drag.startY) - s.drag.startY;
        if (Math.hypot(dx, dy) < 4) deselect(s);
      }
      // Snap-on-drop: only after a real drag (recenterPending flips off in
      // onMove past 4px), only when the user wants it, and Alt at release is
      // an escape hatch so off-grid placement is still reachable per gesture.
      const realDrag = s.drag.recenterPending === false;
      const altAtRelease = !!(e?.altKey ?? s.drag.lastAlt);
      if (realDrag && s.prefs?.snapOnDrop && !altAtRelease
          && (s.drag.kind === 'device' || s.drag.kind === 'stack')) {
        snapDropToGrid(s, s.drag.kind, s.drag.id);
      }
      // Grid energy pulse on real drops (palette spawn handled separately
      // in spawnDeviceAt). Skip stacks-being-merged-into-other-stacks —
      // they don't really land on the grid, they fold into another entity.
      if (realDrag && (s.drag.kind === 'device' || s.drag.kind === 'stack') && !s.dragStackTarget) {
        if (s.drag.kind === 'device') {
          const dev = s.devices.find((d) => d.id === s.drag.id);
          if (dev) {
            const t = typeOf(dev.type);
            if (t?.accent) vfxGridPulse(s, dev.x, dev.y, t.accent);
          }
        } else {
          const st = (s.stacks || []).find((x) => x.id === s.drag.id);
          if (st) {
            const t = typeOf(stackTypeOf(s, st));
            if (t?.accent) {
              // Expanded stacks have a dashed envelope that's bigger than
              // the device box — launch tendrils from THAT perimeter so
              // they don't appear to spawn inside the stack. Collapsed
              // stacks fall through to the device-sized default.
              const env = stackEnvelopeRect(s, st);
              if (env) {
                const ecx = (env.minX + env.maxX) / 2;
                const ecy = (env.minY + env.maxY) / 2;
                const ehw = (env.maxX - env.minX) / 2;
                const ehh = (env.maxY - env.minY) / 2;
                vfxGridPulse(s, ecx, ecy, t.accent, ehw, ehh);
              } else {
                vfxGridPulse(s, st.x, st.y, t.accent);
              }
            }
          }
        }
      }
      if (s.drag.kind === 'device' || s.drag.kind === 'pan' || s.drag.kind === 'stack') schedSave(s);
    }
    s.drag = null;
    s.host.classList.remove('m002-dragging');
    clearSnapPreview(s);
    // Spring the lifted element back to rest (1.0 scale, 0° tilt) — settles
    // smoothly over a few frames after release so the gesture has follow-through.
    endDragLift(s);
    // Fire the deferred auto-recenter now that the gesture is done. Skipped
    // if the pointer moved (full drag) — recenterPending was flipped off in
    // onMove. Stays gated by the user's preference.
    if (recenterClick && s.prefs?.autoRecenter && recenterKind && recenterId) {
      recenterOnSelection(s, recenterKind, recenterId);
    }
  };

  const onDblClick = (e) => {
    const devEl = e.target.closest('[data-device-id]');
    if (devEl) {
      const dev = s.devices.find((d) => d.id === devEl.dataset.deviceId);
      if (dev && isReference(dev)) {
        jumpToReference(s, dev);
        e.preventDefault();
        return;
      }
      if (dev) {
        enterDetailView(s, dev.id);
        e.preventDefault();
        return;
      }
    }
    const stackEl = e.target.closest('[data-stack-id]');
    if (stackEl) {
      toggleStackExpanded(s, stackEl.dataset.stackId);
      e.preventDefault();
      return;
    }
    // Background double-click: no-op. Radial menu now opens on right-click.
  };
  svg.addEventListener('dblclick', onDblClick);
  s.cleanups.push(() => svg.removeEventListener('dblclick', onDblClick));
  svg.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  // Suppress the native context menu on the canvas — right-click is reserved
  // for rope-drag, and the menu would pop up over the in-flight rope.
  const onCtx = (e) => e.preventDefault();
  svg.addEventListener('contextmenu', onCtx);
  s.cleanups.push(() => svg.removeEventListener('mousedown', onDown));
  s.cleanups.push(() => window.removeEventListener('mousemove', onMove));
  s.cleanups.push(() => window.removeEventListener('mouseup', onUp));
  s.cleanups.push(() => svg.removeEventListener('contextmenu', onCtx));
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
  // Layer pill: restore the saved active layer if the map carries one. The
  // activeLayer is part of view state so it round-trips per-map across
  // unmount/remount (tab change, hash navigation, browser reload).
  const savedLayer = s.view?.activeLayer;
  const valid = LAYERS.find((l) => l.id === savedLayer);
  if (valid) {
    s.activeLayer = savedLayer;
    s.host?.setAttribute('data-active-layer', s.activeLayer);
    s.layerBar?.querySelectorAll('.m002-layer-pill').forEach((p) => {
      p.classList.toggle('active', p.dataset.layer === s.activeLayer);
    });
  }
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
// PNG export — current zone, fits all devices/links/labels with padding.
// Renders the live SVG into a Blob, paints onto a 2× canvas, downloads.
// =============================================================================
function exportPNG(s) {
  const inZone = (e) => !s.activeZone || !e.zone || e.zone === s.activeZone;
  const devs = (s.devices || []).filter(inZone);
  if (!devs.length) { toast(s, 'Map is empty — nothing to export'); return; }

  const PAD = 80;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  devs.forEach((d) => {
    minX = Math.min(minX, d.x - DEVICE_W / 2);
    minY = Math.min(minY, d.y - DEVICE_H / 2);
    maxX = Math.max(maxX, d.x + DEVICE_W / 2);
    maxY = Math.max(maxY, d.y + DEVICE_H / 2);
  });
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const w = maxX - minX, h = maxY - minY;
  const SCALE = 2;

  // Clone the live SVG, then strip / reset things we don't want in the export.
  const clone = s.svg.cloneNode(true);
  const world = clone.querySelector('.m002-world');
  if (world) world.removeAttribute('transform');
  clone.querySelectorAll('.m002-overlay').forEach((el) => { el.innerHTML = ''; });
  clone.querySelectorAll('.m002-link-pending, .m002-stub-line, .m002-rubber').forEach((el) => el.remove());
  clone.querySelectorAll('[class*="selected"], [class*="hover"]').forEach((el) => {
    el.setAttribute('class', el.getAttribute('class').replace(/\s*m002-[^\s]*-(selected|hover)/g, ''));
  });

  // Inline the module's CSS so the SVG renders standalone in an Image element.
  const styleSrc = document.getElementById('mod002-styles');
  const defs = clone.querySelector('defs');
  if (styleSrc && defs) {
    const styleEl = document.createElementNS(SVG_NS, 'style');
    styleEl.textContent = styleSrc.textContent;
    defs.appendChild(styleEl);
  }

  // Solid background (board tint) painted under the grid so transparent areas
  // outside the dotted pattern still get the dark sci-fi look.
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', minX); bg.setAttribute('y', minY);
  bg.setAttribute('width', w); bg.setAttribute('height', h);
  bg.setAttribute('fill', '#07070c');
  if (world) world.insertBefore(bg, world.firstChild);

  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
  clone.setAttribute('width', w);
  clone.setAttribute('height', h);
  clone.removeAttribute('style');

  const ser = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([ser], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * SCALE);
    canvas.height = Math.round(h * SCALE);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#07070c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(url);
    canvas.toBlob((png) => {
      if (!png) { toast(s, 'Export failed'); return; }
      const a = document.createElement('a');
      const dlUrl = URL.createObjectURL(png);
      const zone = (s.zones?.find((z) => z.id === s.activeZone)?.name || 'map')
        .replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
      const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
      a.href = dlUrl;
      a.download = `niven-netmap-${zone}-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
      toast(s, `Exported ${canvas.width}×${canvas.height} PNG`);
    }, 'image/png');
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast(s, 'Export failed'); };
  img.src = url;
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
    } else if (e.key === 'r' || e.key === 'R') {
      recenter(s);
    } else if (e.key === 'Delete') {
      // Backspace deliberately excluded — too easy to clobber a stack while
      // navigating between input fields. Use DEL or the delete tool.
      if (s.selected) deleteSelected(s);
    } else if (e.key === 'Escape') {
      const lagModal = s.host?.querySelector('.m002-lag-modal');
      if (lagModal && !lagModal.hidden) { closeLagModal(s); return; }
      if (s.dragRope) { cancelRopeDrag(s); return; }
      if (s.portModalOpen) closePortModal(s);
      else if (s.detailDeviceId) exitDetailView(s);
      else if (s.linkMode) toggleLinkMode(s);
      else if (s.deleteMode) toggleDeleteMode(s);
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
    hostname: '',
    ip: '',
    prefix: 24,
    notes: '',
    vlans: [],
    lags: [],
    routes: [],
    zone: s.activeZone,
    ports: Array.from({ length: t.ports }, (_, i) => ({ n: i + 1, name: '', vlans: [] })),
  };
  if (t.id === 'reference') {
    dev.refMode = 'zone';
    dev.refZoneId = null;
    dev.refMapId = null;
    dev.coupleId = null;
  }
  if (isL3Type(t.id)) {
    // Routers/firewalls own the interfaces[] table directly; the dev.ip
    // trio above is irrelevant for them and gets stripped during migrate
    // anyway. Provision the empty arrays here so the inspector can bind.
    dev.interfaces = [];
    dev.routes = [];
  }
  s.devices.push(dev);
  drawDevice(s, dev);
  vfxGridPulse(s, dev.x, dev.y, t.accent);
  select(s, 'device', dev.id);
  updateStatus(s);
  toast(s, `Added ${dev.name}`);
  schedSave(s);
}

// Resolve a reference's target into a display label. Returns "(no target)" if
// nothing is set, or "(missing)" if the target id no longer exists.
function referenceTargetLabel(s, dev) {
  if (!isReference(dev)) return '';
  if (dev.refMode === 'map') {
    if (!dev.refMapId) return '(no target)';
    const m = (s.maps || []).find((mm) => mm.id === dev.refMapId);
    return m ? m.name : '(missing map)';
  }
  if (!dev.refZoneId) return '(no target)';
  const z = (s.zones || []).find((zz) => zz.id === dev.refZoneId);
  return z ? z.name : '(missing zone)';
}

// Resolve the live couple peer for a Jump (or null if uncoupled / stale).
function couplePeer(s, dev) {
  if (!isReference(dev) || !dev.coupleId) return null;
  const peer = s.devices.find((d) => d.id === dev.coupleId);
  if (!peer || !isReference(peer)) return null;
  return peer;
}

// Mutually couple two Jumps. Drops any prior couples on either side. Both
// Jumps must already exist in s.devices and live in different zones.
function coupleJumps(s, devA, devB) {
  if (!isReference(devA) || !isReference(devB)) return false;
  if (devA.id === devB.id) return false;
  // Break any pre-existing couples on either side first.
  uncoupleJump(s, devA);
  uncoupleJump(s, devB);
  devA.coupleId = devB.id;
  devB.coupleId = devA.id;
  // Sync the manual zone reference so JUMP NOW / target label stay coherent.
  devA.refMode = 'zone';
  devA.refZoneId = devB.zone || null;
  devB.refMode = 'zone';
  devB.refZoneId = devA.zone || null;
  // Lock peer to source coordinates — prerequisite for the no-drift hop.
  devB.x = devA.x;
  devB.y = devA.y;
  return true;
}

function uncoupleJump(s, dev) {
  if (!isReference(dev) || !dev.coupleId) return;
  const peer = s.devices.find((d) => d.id === dev.coupleId);
  if (peer && peer.coupleId === dev.id) peer.coupleId = null;
  dev.coupleId = null;
}

// All hub-legs directly attached to this Jump — links between the Jump and a
// non-Jump device. JUMPs have no ports so the Jump-side port-ref is always
// empty; the relevant info is the far device + the port chosen on its side.
function hubLocalLegs(s, jumpId) {
  const out = [];
  s.links.forEach((l) => {
    let farId, farPort;
    if (l.from === jumpId)      { farId = l.to;   farPort = l.toPort; }
    else if (l.to === jumpId)   { farId = l.from; farPort = l.fromPort; }
    else return;
    const farDev = s.devices.find((d) => d.id === farId);
    if (!farDev || isReference(farDev)) return;
    out.push({ device: farDev, portN: farPort, link: l });
  });
  return out;
}

// Far-side hub-legs reachable through the coupled peer (i.e. the legs in the
// other zone that share this hub's broadcast domain).
function hubFarLegs(s, jumpId) {
  const jump = s.devices.find((d) => d.id === jumpId);
  if (!isReference(jump)) return [];
  const peer = couplePeer(s, jump);
  if (!peer) return [];
  return hubLocalLegs(s, peer.id);
}

// If a link is a hub-leg from a stack member to a JUMP whose couple peer
// terminates a counterparted LAG on the far-side stack, return the cross-zone
// LAG-pair payload. Port assignment on the link itself is optional — the LAG
// counterpart relationship + hub-leg presence on both sides is enough to
// claim the link as part of the LAG-pair visual.
function hubTunnelLagPair(s, link) {
  const a = s.devices.find((d) => d.id === link.from);
  const b = s.devices.find((d) => d.id === link.to);
  if (!a || !b) return null;
  const aIsJump = isReference(a);
  const bIsJump = isReference(b);
  if (aIsJump === bIsJump) return null;
  const memberDev = aIsJump ? b : a;
  const jumpDev = aIsJump ? a : b;
  const memberStack = findStack(s, memberDev.id);
  if (!memberStack) return null;
  const peerJump = couplePeer(s, jumpDev);
  if (!peerJump) return null;
  for (const lag of (memberStack.lags || [])) {
    if (!lag.counterpart?.lagId) continue;
    const peerInfo = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
    if (!peerInfo) continue;
    if (peerInfo.stack.zone === memberStack.zone) continue;
    if ((peerJump.zone || null) !== (peerInfo.stack.zone || null)) continue;
    const peerMembers = new Set(peerInfo.stack.members || []);
    const peerHasHubLeg = s.links.some((l) => {
      if (l.from === peerJump.id) return peerMembers.has(l.to);
      if (l.to === peerJump.id) return peerMembers.has(l.from);
      return false;
    });
    if (!peerHasHubLeg) continue;
    return {
      localLag: lag,
      localStack: memberStack,
      peerLag: peerInfo.lag,
      peerStack: peerInfo.stack,
      jumpDev,
      peerJump,
      memberDev,
      memberPort: aIsJump ? link.toPort : link.fromPort,
    };
  }
  return null;
}

// All stacks reachable from this stack via either a direct member-to-member
// link OR a JUMP hub-tunnel (same-zone hub-leg + the coupled peer's hub-legs).
// Used by the LAG counterpart picker so a LAG can pair with another stack's
// LAG even when the only path between them runs through a JUMP couple.
function linkedStacksFor(s, stack) {
  const out = new Map();
  if (!stack) return out;
  const myMembers = new Set(stack.members || []);
  s.links.forEach((l) => {
    const fromStack = findStack(s, l.from);
    const toStack = findStack(s, l.to);
    if (fromStack && toStack) {
      let other = null;
      if (fromStack.id === stack.id && toStack.id !== stack.id) other = toStack;
      else if (toStack.id === stack.id && fromStack.id !== stack.id) other = fromStack;
      if (other && !out.has(other.id)) out.set(other.id, other);
      return;
    }
    // Hub-tunnel: a hub-leg from one of MY members to a JUMP. The JUMP's
    // remaining hub-legs (this zone) and its couple peer's hub-legs (the
    // other zone) reach stacks that are equally valid LAG-pair candidates.
    let myMember = null;
    let jumpDev = null;
    if (myMembers.has(l.from)) {
      myMember = l.from;
      jumpDev = s.devices.find((d) => d.id === l.to);
    } else if (myMembers.has(l.to)) {
      myMember = l.to;
      jumpDev = s.devices.find((d) => d.id === l.from);
    }
    if (!myMember || !jumpDev || !isReference(jumpDev)) return;
    const collect = (jId) => hubLocalLegs(s, jId).forEach(({ device }) => {
      const otherStk = findStack(s, device.id);
      if (!otherStk || otherStk.id === stack.id) return;
      if (!out.has(otherStk.id)) out.set(otherStk.id, otherStk);
    });
    collect(jumpDev.id);
    const peer = couplePeer(s, jumpDev);
    if (peer) collect(peer.id);
  });
  return out;
}

function jumpToReference(s, dev) {
  if (!isReference(dev)) return;
  // Couple takes priority: if a peer Jump exists, jump to its zone and
  // select the peer so the user lands directly on the wormhole's other end.
  const peer = couplePeer(s, dev);
  if (peer) {
    // Restore the saved peer-side view so the camera glides to where the
    // user last worked in that zone. Couple is purely logical (broadcast
    // domain) — peers keep independent world coordinates, so the camera
    // anchor is what makes the hop land coherently.
    const anchorView = peer.cameraAnchor || null;
    if (peer.zone && peer.zone !== s.activeZone) {
      switchZone(s, peer.zone, { x: dev.x, y: dev.y }, anchorView ? { toView: anchorView } : {});
    } else if (anchorView) {
      // Same-zone edge case (couples are normally cross-zone, but be defensive).
      const from = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
      animateZoneView(s, from, { x: anchorView.x, y: anchorView.y, zoom: anchorView.zoom }, 520);
    }
    // Zone glide already animated us to the saved view — don't override
    // it with an auto-recenter on the peer.
    select(s, 'device', peer.id, { skipRecenter: true });
    return;
  }
  if (dev.refMode === 'map') {
    if (!dev.refMapId) { toast(s, 'JUMP target not set'); return; }
    if (!(s.maps || []).some((m) => m.id === dev.refMapId)) { toast(s, 'JUMP target map missing'); return; }
    if (dev.refMapId === s.activeMapId) { toast(s, 'Already on this map'); return; }
    switchMap(s, dev.refMapId);
    return;
  }
  if (!dev.refZoneId) { toast(s, 'JUMP target not set'); return; }
  if (!(s.zones || []).some((z) => z.id === dev.refZoneId)) { toast(s, 'JUMP target zone missing'); return; }
  if (dev.refZoneId === s.activeZone) { toast(s, 'Already in this zone'); return; }
  switchZone(s, dev.refZoneId, { x: dev.x, y: dev.y });
}

function drawDevice(s, dev) {
  const t = typeOf(dev.type);
  const g = document.createElementNS(SVG_NS, 'g');
  const peer = isReference(dev) ? couplePeer(s, dev) : null;
  const cls = ['m002-device'];
  if (isReference(dev)) cls.push('m002-device-ref');
  if (peer) cls.push('m002-device-coupled');
  const memberStack = findStack(s, dev.id);
  if (memberStack && !isStackCollapsed(s, memberStack)) {
    cls.push('m002-stack-member');
    if (stackHasVip(memberStack)) cls.push('m002-stack-member-vip');
  }
  g.setAttribute('class', cls.join(' '));
  g.setAttribute('data-device-id', dev.id);
  // Layer-aware data hooks. CSS dims data-l3="false" devices in the routing
  // layer so switches without an IP visibly recede.
  g.setAttribute('data-l3', isL3Device(dev) ? 'true' : 'false');
  if (isDefaultGateway(s, dev)) g.setAttribute('data-gw', 'true');
  // VLAN solo state — drives the dim / amber CSS on the VLAN layer. JUMPs
  // (references) borrow their peer's state when coupled so the portal mirrors
  // the real device on the other side; uncoupled JUMPs have no peer to speak
  // for them and dim out as 'isolated' when a filter is active.
  if (isReference(dev)) {
    const filter = effectiveVlanSolo(s);
    if (filter.length) {
      const peerForVsolo = couplePeer(s, dev);
      const peerState = peerForVsolo ? vlanSoloStateForDevice(s, peerForVsolo) : null;
      g.setAttribute('data-vlan-solo', peerState || 'unmatched-isolated');
    }
    // Routing-solo mirrors the same JUMP-borrows-peer logic on the routing
    // layer — uncoupled JUMPs dim out as isolated when a subnet filter is on.
    if (s.activeLayer === 'routing' && effectiveSubnetSolo(s).length) {
      const peerForRsolo = couplePeer(s, dev);
      const peerRState = peerForRsolo ? subnetSoloStateForDevice(s, peerForRsolo) : null;
      g.setAttribute('data-routing-solo', peerRState || 'unmatched-isolated');
    }
  } else {
    const vsState = vlanSoloStateForDevice(s, dev);
    if (vsState) g.setAttribute('data-vlan-solo', vsState);
    if (s.activeLayer === 'routing') {
      const rsState = subnetSoloStateForDevice(s, dev);
      if (rsState) g.setAttribute('data-routing-solo', rsState);
    }
  }
  g.style.setProperty('--accent', t.accent);
  updateDeviceTransform({ }, dev, g);

  const w = DEVICE_W, h = DEVICE_H;
  if (isReference(dev)) {
    g.innerHTML = `
      <rect class="m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
      <text class="m002-dev-name" x="0" y="${-h/2 + 30}" text-anchor="middle">${escSvg(dev.name)}</text>
    `;
  } else {
    // L3 routing-layer label: show interface count for routers/firewalls,
    // primary IP for everyone else. Default-gateway badge sits top-right.
    const ifaceCount = Array.isArray(dev.interfaces) ? dev.interfaces.length : 0;
    const l3Label = isL3Type(dev.type) && ifaceCount
      ? `${ifaceCount} IF`
      : (dev.ip || '');
    const gwBadge = isDefaultGateway(s, dev)
      ? `<g class="m002-dev-gw-badge"><rect x="${w/2 - 30}" y="${-h/2 + 4}" width="26" height="14" rx="2"/><text x="${w/2 - 17}" y="${-h/2 + 14}" text-anchor="middle">DGW</text></g>`
      : '';
    g.innerHTML = `
      <rect class="m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
      <text class="m002-dev-name" x="0" y="${-h/2 + 30}" text-anchor="middle">${escSvg(dev.name)}</text>
      <text class="m002-dev-notes" x="${-w/2 + 10}" y="${h/2 - 10}">${escSvg(truncate(dev.notes, 18) || '—')}</text>
      <text class="m002-dev-ip" x="${w/2 - 10}" y="${h/2 - 10}" text-anchor="end">${escSvg(dev.ip || '')}</text>
      <text class="m002-dev-l3" x="${w/2 - 10}" y="${h/2 - 10}" text-anchor="end">${escSvg(l3Label)}</text>
      ${gwBadge}
    `;
  }
  s.gDevices.appendChild(g);
}

function updateDeviceTransform(_s, dev, gEl) {
  const g = gEl || document.querySelector(`[data-device-id="${dev.id}"]`);
  if (!g) return;
  // While the lift+inertia animation owns this element's transform, leave it
  // alone — the rAF loop composes translate+rotate+scale every frame and a
  // bare translate write here would erase the wobble for one frame.
  if (g.dataset.m002LiftLock) return;
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
  toast(s, s.linkMode ? 'LINK mode' : 'SELECT mode');
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
  // Two members of the same stack — these are stacking cables, not regular
  // links. Drop straight into a stack-link instead of bouncing the user.
  const stA = findStack(s, s.linkPending);
  const stB = findStack(s, deviceId);
  if (stA && stA === stB) {
    const slId = commitIntraStackLink(s, stA, s.linkPending, deviceId);
    if (slId) toast(s, 'Stack-link added');
    s.gDevices.querySelectorAll('.m002-link-pending').forEach((el) => el.classList.remove('m002-link-pending'));
    s.linkPending = null;
    setMode(s, 'LINK · pick first node');
    return;
  }
  // Jump-aware routing: a Jump↔Jump pick across zones is coupling (a portal
  // pair, stored as mutual `coupleId` — not in s.links). Same-zone Jump↔Jump
  // is rejected (no zone crossing → no point). Jump↔non-Jump must stay in
  // the same zone (the Jump is a hub leg in its own zone).
  const devA = s.devices.find((d) => d.id === s.linkPending);
  const devB = s.devices.find((d) => d.id === deviceId);
  const clearPending = () => {
    s.gDevices.querySelectorAll('.m002-link-pending').forEach((el) => el.classList.remove('m002-link-pending'));
    s.linkPending = null;
    setMode(s, 'LINK · pick first node');
  };
  if (!devA || !devB) { clearPending(); return; }
  if (isReference(devA) && isReference(devB)) {
    // Coupling is owned by the JUMP inspector now. The link tool only handles
    // hub-legs (JUMP ↔ regular device).
    toast(s, 'Couple JUMPs via the inspector COUPLE WITH dropdown');
    clearPending();
    return;
  }
  if ((isReference(devA) || isReference(devB)) && devA.zone !== devB.zone) {
    toast(s, 'JUMP hub-leg must stay in the same zone');
    clearPending();
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
  // Adding a link may shift sibling links between the same visual endpoints
  // into new lanes AND may turn either endpoint into a hub (≥2 distinct peers)
  // which forces every incident link to re-orient onto the shared trunk axis.
  // Invalidate the slot cache and redraw every link that touches either of
  // this link's endpoints so existing edges fan out and re-align as needed.
  invalidateEdgeSlots(s);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (l.from === link.from || l.from === link.to ||
        l.to   === link.from || l.to   === link.to) redrawLink(s, l);
  });
  drawLink(s, link);
  // A new edge can extend or split L3 paths (e.g. now-connected router and
  // endpoint suddenly share a path through the new wire). Refresh ribbons.
  if (s.activeLayer === 'routing') drawL3Paths(s);
  updateStatus(s);
  s.gDevices.querySelectorAll('.m002-link-pending').forEach((el) => el.classList.remove('m002-link-pending'));
  s.linkPending = null;
  setMode(s, 'LINK · pick first node');
  schedSave(s);
  select(s, 'link', link.id);
  toast(s, `Linked ${devA.name} ⇄ ${devB.name}`);
}

// =============================================================================
// Stacks
// =============================================================================
// Positions are unified across layers — switching Physical / VLAN / Routing
// no longer moves elements on the grid.

function findStack(s, deviceId) {
  return s.stacks.find((st) => st.members.includes(deviceId)) || null;
}
function findStackById(s, stackId) {
  return s.stacks.find((st) => st.id === stackId) || null;
}
// In logical layers (vlan/routing) the stack is always one entity. In Physical
// the stack respects its `expanded` flag. Routing-solo additionally force-
// collapses stacks that don't participate in the soloed subnet — that override
// is held in a transient set so it never mutates the persisted expanded flag,
// which means the user's manual expand-state survives a filter cycle untouched.
function isStackCollapsed(s, stack) {
  if (!stack) return false;
  if (s?._soloCollapsedIds?.has(stack.id)) return true;
  return !stack.expanded;
}
// Where to anchor a link on this device — the device itself, or the stack icon
// if the device sits inside a collapsed stack.
function effectivePos(s, id) {
  // Stack id first — IDs are namespaced ("stk_..." / "x..." / "if_..." etc),
  // so a hit here can't collide with a device. When the stack is expanded we
  // pick the centroid of its visible members so a ribbon endpoint feels
  // anchored to the cluster rather than a random corner.
  const stack = (s.stacks || []).find((st) => st.id === id);
  if (stack) {
    if (isStackCollapsed(s, stack)) return { x: stack.x, y: stack.y };
    const ms = (stack.members || []).map((mid) => s.devices.find((d) => d.id === mid)).filter(Boolean);
    if (ms.length) {
      return {
        x: ms.reduce((sum, m) => sum + m.x, 0) / ms.length,
        y: ms.reduce((sum, m) => sum + m.y, 0) / ms.length,
      };
    }
    return { x: stack.x, y: stack.y };
  }
  const dev = s.devices.find((d) => d.id === id);
  if (!dev) return null;
  const stk = findStack(s, id);
  if (stk && isStackCollapsed(s, stk)) return { x: stk.x, y: stk.y };
  return { x: dev.x, y: dev.y };
}

// =============================================================================
// Edge slots — when several distinct links share the same pair of *visual*
// endpoints (collapsed-stack icon, or device), they get parallel lanes so they
// don't overlap. Stable, deterministic order keeps lane assignments from
// jumping across save/reload. LAG-pair lines participate in the same slot
// pool to avoid colliding with regular links between the same stacks.
// =============================================================================
function visualEndpointKey(s, devIdA, devIdB) {
  const stA = findStack(s, devIdA);
  const stB = findStack(s, devIdB);
  const epA = stA && isStackCollapsed(s, stA) ? `stack:${stA.id}` : `device:${devIdA}`;
  const epB = stB && isStackCollapsed(s, stB) ? `stack:${stB.id}` : `device:${devIdB}`;
  return [epA, epB].sort().join('|');
}

function invalidateEdgeSlots(s) {
  s._edgeSlots = null;
  s._hubSides = null;
  s._endpointDegrees = null;
}

// Hub sides — when ≥2 distinct peers approach a hub from the SAME side
// (north / south / east / west), those peers share that hub's side as their
// merged approach anchor. Result: every link in such a peer-group lands on
// one fixed midpoint anchor on the hub, and the trunk segment leading into
// that anchor is visually shared instead of fanning into N parallel
// corridors.
//
// Per-side bucketing (instead of one trunk-axis per hub) means a hub with
// peers above AND below merges them into TWO separate trunks — one entering
// from the north, one from the south — rather than crushing all approaches
// onto a single axis that doesn't fit half of them.
function ensureHubSides(s) {
  if (s._hubSides) return s._hubSides;
  const m = new Map(); // hubKey → Map<peerKey, side>
  const degrees = new Map(); // endpointKey → distinct-peer count (transit detection)
  const epPos = (id) => effectivePos(s, id);
  const epKey = (id) => {
    if ((s.stacks || []).some((st) => st.id === id)) return `stack:${id}`;
    const stack = findStack(s, id);
    return stack && isStackCollapsed(s, stack) ? `stack:${stack.id}` : `device:${id}`;
  };
  const inZone = (entId) => {
    if (!s.activeZone) return true;
    const dev = s.devices.find((d) => d.id === entId);
    if (dev) return !dev.zone || dev.zone === s.activeZone;
    const st = (s.stacks || []).find((x) => x.id === entId);
    if (st) return !st.zone || st.zone === s.activeZone;
    return true;
  };
  const peerMap = new Map();
  for (const link of (s.links || [])) {
    if (!link.from || !link.to || link.from === link.to) continue;
    if (!inZone(link.from) || !inZone(link.to)) continue;
    const fromKey = epKey(link.from), toKey = epKey(link.to);
    if (fromKey === toKey) continue;
    const fromPos = epPos(link.from), toPos = epPos(link.to);
    if (!fromPos || !toPos) continue;
    if (!peerMap.has(fromKey)) peerMap.set(fromKey, new Map());
    if (!peerMap.has(toKey)) peerMap.set(toKey, new Map());
    if (!peerMap.get(fromKey).has(toKey)) peerMap.get(fromKey).set(toKey, toPos);
    if (!peerMap.get(toKey).has(fromKey)) peerMap.get(toKey).set(fromKey, fromPos);
  }
  for (const [hubKey, peers] of peerMap) {
    if (peers.size < 2) continue;
    const hubId = hubKey.split(':')[1];
    const hubPos = epPos(hubId) || (() => {
      const st = (s.stacks || []).find((x) => x.id === hubId);
      return st ? { x: st.x, y: st.y } : null;
    })();
    if (!hubPos) continue;
    // Bucket peers by which side of the hub they sit on (dominant axis decides).
    const sideBuckets = { N: [], S: [], E: [], W: [] };
    for (const [peerKey, peerPos] of peers) {
      const dx = peerPos.x - hubPos.x;
      const dy = peerPos.y - hubPos.y;
      let side;
      if (Math.abs(dx) >= Math.abs(dy)) side = dx > 0 ? 'E' : 'W';
      else                                side = dy > 0 ? 'S' : 'N';
      sideBuckets[side].push(peerKey);
    }
    const peerToSide = new Map();
    for (const [side, list] of Object.entries(sideBuckets)) {
      if (list.length < 2) continue;
      for (const pk of list) peerToSide.set(pk, side);
    }
    if (peerToSide.size) m.set(hubKey, peerToSide);
  }
  for (const [key, peers] of peerMap) degrees.set(key, peers.size);
  s._hubSides = m;
  s._endpointDegrees = degrees;
  return m;
}

function endpointIsTransit(s, id) {
  ensureHubSides(s);
  const epKey = (s.stacks || []).some((st) => st.id === id)
    ? `stack:${id}`
    : (() => {
        const stack = findStack(s, id);
        return stack && isStackCollapsed(s, stack) ? `stack:${stack.id}` : `device:${id}`;
      })();
  return (s._endpointDegrees?.get(epKey) || 0) >= 2;
}

// Which hub side, if any, should this link's hub anchor be locked to?
// Returns { hubIsB: bool, hubSide: 'N'|'E'|'S'|'W' } or null. Used by orthPath
// to force the L corner onto the hub's midline so peer links converge.
function hubMergeInfo(s, link) {
  const sides = ensureHubSides(s);
  if (!sides.size) return null;
  const epKey = (id) => {
    if ((s.stacks || []).some((st) => st.id === id)) return `stack:${id}`;
    const stack = findStack(s, id);
    return stack && isStackCollapsed(s, stack) ? `stack:${stack.id}` : `device:${id}`;
  };
  const fromKey = epKey(link.from), toKey = epKey(link.to);
  const toMap = sides.get(toKey);
  if (toMap && toMap.has(fromKey)) return { hubIsB: true,  hubSide: toMap.get(fromKey) };
  const fromMap = sides.get(fromKey);
  if (fromMap && fromMap.has(toKey)) return { hubIsB: false, hubSide: fromMap.get(toKey) };
  return null;
}

// Aggregate every non-paired-LAG link between two collapsed stacks (or a
// collapsed stack and a non-stack device) into a single summary group.
// Result: Map<aggKey, { aSide, bSide, linkIds: [...] }>. aSide/bSide are
// stack ids when collapsed, otherwise device ids. The renderer draws ONE
// dim line per group instead of fanning N parallel stubs across the
// canvas — cleaner, and the N value lets the user click through later
// to configure a LAG over those wires.
function computeStackPairAggregations(s, absorbed) {
  const groups = new Map();
  const zoneOk = (entity) => !s.activeZone || !entity?.zone || entity.zone === s.activeZone;
  // Stack-pairs that already have a paired LAG between them — we skip
  // aggregating those entirely. The aggregate is a "no LAG yet" filler;
  // once even one LAG-pair exists it stops being useful and turns into
  // visual clutter alongside the proper LAG-pair line.
  const pairedStackPairs = new Set();
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peerId = lag.counterpart.stackId;
      if (!peerId || peerId === stA.id) return;
      pairedStackPairs.add([stA.id, peerId].sort().join('::'));
    });
  });
  s.links.forEach((l) => {
    if (absorbed.has(l.id)) return;
    const a = s.devices.find((d) => d.id === l.from);
    const b = s.devices.find((d) => d.id === l.to);
    if (!a || !b) return;
    if (!zoneOk(a) || !zoneOk(b)) return;
    const stkA = findStack(s, l.from);
    const stkB = findStack(s, l.to);
    const aCollapsed = stkA && isStackCollapsed(s, stkA);
    const bCollapsed = stkB && isStackCollapsed(s, stkB);
    // Stack ↔ Stack only. Stack ↔ single device keeps the original per-link
    // rendering — aggregating those would hide one-off links that the user
    // can perfectly well manage as regular wires.
    if (!aCollapsed || !bCollapsed) return;
    const aSide = stkA.id;
    const bSide = stkB.id;
    if (aSide === bSide) return;
    const key = [aSide, bSide].sort().join('::');
    if (pairedStackPairs.has(key)) return;
    if (!groups.has(key)) groups.set(key, { aSide, bSide, linkIds: [] });
    groups.get(key).linkIds.push(l.id);
  });
  return groups;
}

function ensureEdgeSlots(s) {
  if (s._edgeSlots) return s._edgeSlots;
  const absorbed = computeAbsorbedLinkIds(s);
  const aggregations = computeStackPairAggregations(s, absorbed);
  const aggregatedLinkIds = new Set();
  aggregations.forEach((agg) => agg.linkIds.forEach((id) => aggregatedLinkIds.add(id)));
  const groups = new Map();
  // Regular links — skip those absorbed into a LAG-pair line or rolled up
  // into a stack-pair aggregation (those are not drawn as their own edge).
  s.links.forEach((l) => {
    if (absorbed.has(l.id)) return;
    if (aggregatedLinkIds.has(l.id)) return;
    const key = visualEndpointKey(s, l.from, l.to);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ kind: 'link', id: l.id, sortKey: 'link:' + l.id });
  });
  // Explicit LAG-pair lines — only counted when both stacks collapsed (that's
  // when drawLagLink actually runs and a stack-to-stack double-line appears).
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      const selfKey = stA.id + ':' + lag.id;
      const peerKey = peer.stack.id + ':' + peer.lag.id;
      if (selfKey > peerKey) return; // dedupe pair
      if (!isStackCollapsed(s, stA) || !isStackCollapsed(s, peer.stack)) return;
      const ep = [`stack:${stA.id}`, `stack:${peer.stack.id}`].sort().join('|');
      if (!groups.has(ep)) groups.set(ep, []);
      groups.get(ep).push({ kind: 'lag', id: `${stA.id}|${lag.id}`, sortKey: 'lag:' + selfKey });
    });
  });
  // Aggregated stack-pair summaries — one item per group, slotted alongside
  // any LAG-pair / link items between the same visual endpoints.
  aggregations.forEach((agg, key) => {
    const stkA = (s.stacks || []).find((st) => st.id === agg.aSide);
    const stkB = (s.stacks || []).find((st) => st.id === agg.bSide);
    const epA = stkA ? `stack:${stkA.id}` : `device:${agg.aSide}`;
    const epB = stkB ? `stack:${stkB.id}` : `device:${agg.bSide}`;
    const ep = [epA, epB].sort().join('|');
    if (!groups.has(ep)) groups.set(ep, []);
    groups.get(ep).push({ kind: 'agg', id: key, sortKey: 'agg:' + key });
  });
  const out = new Map();
  groups.forEach((items) => {
    items.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const n = items.length;
    items.forEach((item, i) => {
      const lane = (i - (n - 1) / 2) * LANE_GAP;
      out.set(`${item.kind}:${item.id}`, { slot: i, count: n, lane });
    });
  });
  s._edgeSlots = out;
  return out;
}

function laneForLink(s, linkId) {
  return ensureEdgeSlots(s).get(`link:${linkId}`)?.lane || 0;
}
function laneForAgg(s, aggKey) {
  return ensureEdgeSlots(s).get(`agg:${aggKey}`)?.lane || 0;
}
function laneForLag(s, stackAId, lagAId) {
  return ensureEdgeSlots(s).get(`lag:${stackAId}|${lagAId}`)?.lane || 0;
}

// =============================================================================
// LAG model — LAGs live on stacks (`stack.lags`). A stack is the only entity
// that aggregates links, so port-refs `{ deviceId, portN }` must always point
// at one of the stack's own members. Counterparts cross from one stack's LAG
// to another: `lag.counterpart = { stackId, lagId }`.
// =============================================================================
function lagHasPort(lag, deviceId, portN) {
  return (lag?.ports || []).some((p) => p.deviceId === deviceId && Number(p.portN) === Number(portN));
}
function lagPortsOnDevice(lag, deviceId) {
  return (lag?.ports || []).filter((p) => p.deviceId === deviceId).map((p) => Number(p.portN));
}
// Locate the stack a LAG record lives on (or null if it's an orphan).
function lagOwnerStack(s, lag) {
  return s.stacks.find((st) => (st.lags || []).includes(lag)) || null;
}
function findStackLag(s, stackId, lagId) {
  const st = findStackById(s, stackId);
  if (!st) return null;
  const lag = (st.lags || []).find((l) => l.id === lagId);
  return lag ? { stack: st, lag } : null;
}
// Look up the LAG that owns a specific (deviceId, portN). Walks the device's
// stack, if any.
function findPortLag(s, deviceId, portN) {
  const stack = findStack(s, deviceId);
  if (!stack) return null;
  for (const lag of (stack.lags || [])) {
    if (lagHasPort(lag, deviceId, portN)) return { stack, lag };
  }
  return null;
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
  if (target.kind === 'device') {
    const m = s.devices.find((d) => d.id === target.id);
    if (!m) return;
    m.x += ddx; m.y += ddy;
    updateDeviceTransform(s, m);
    const stk = findStack(s, m.id);
    if (stk && !isStackCollapsed(s, stk)) refreshStackVisuals(s, stk);
  } else if (target.kind === 'stack') {
    const st = findStackById(s, target.id);
    if (!st) return;
    st.x += ddx; st.y += ddy;
    st.members.forEach((mid) => {
      const m = s.devices.find((d) => d.id === mid);
      if (m) {
        m.x += ddx; m.y += ddy;
        updateDeviceTransform(s, m);
      }
    });
    const g = s.gDevices.querySelector(`[data-stack-id="${st.id}"]`);
    if (g && !g.dataset.m002LiftLock) g.setAttribute('transform', `translate(${st.x} ${st.y})`);
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

function toggleDeleteMode(s) {
  s.deleteMode = !s.deleteMode;
  if (s.deleteMode && s.linkMode) toggleLinkMode(s);
  s.host.classList.toggle('m002-deleting', s.deleteMode);
  setMode(s, s.deleteMode ? 'DELETE · click anything to remove' : 'SELECT');
  toast(s, s.deleteMode ? 'DELETE mode' : 'SELECT mode');
  refreshToolHighlights(s);
}

function createStack(s, deviceIds) {
  const members = deviceIds.filter((id) => !findStack(s, id));
  if (members.length < 2) {
    toast(s, 'Need two un-stacked devices');
    return null;
  }
  const types = new Set(members.map((id) => s.devices.find((d) => d.id === id)?.type).filter(Boolean));
  if (types.size > 1) {
    toast(s, 'Stack only allowed between same device types');
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
    lags: [],
    stackLinks: [],
    virtualInterfaces: [],
    routes: [],
  };
  s.stacks.push(st);
  render(s);
  schedSave(s);
  toast(s, `Stack created: ${st.name} (×${st.members.length})`);
  return st.id;
}

function addToStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  if (findStack(s, deviceId)) { toast(s, 'Device is already in a stack'); return; }
  const stType = stackTypeOf(s, st);
  const devType = s.devices.find((d) => d.id === deviceId)?.type;
  if (stType && devType && stType !== devType) {
    toast(s, 'Stack only allowed between same device types');
    return;
  }
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
  const ta = stackTypeOf(s, a), tb = stackTypeOf(s, b);
  if (ta && tb && ta !== tb) {
    toast(s, 'Stack only allowed between same device types');
    return null;
  }
  snapshot(s);
  a.members = [...a.members, ...b.members.filter((m) => !a.members.includes(m))];
  s.stacks = s.stacks.filter((st) => st.id !== idB);
  render(s);
  schedSave(s);
  toast(s, `Stacks merged → ${a.name} (×${a.members.length})`);
  return a.id;
}

function removeFromStack(s, stackId, deviceId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  const stName = st.name;
  snapshot(s);
  st.members = st.members.filter((m) => m !== deviceId);
  if (st.members.length < 2) {
    // Stack collapses entirely → every LAG dies with it (LAGs only exist on
    // stacks). Reciprocal counterpart pointers on peer LAGs get cleaned up.
    dropStackAndItsLags(s, st);
    toast(s, `Stack ${stName} dissolved`);
  } else {
    // Surviving stack just loses port-refs that pointed at the leaving member.
    (st.lags || []).forEach((lag) => {
      lag.ports = (lag.ports || []).filter((p) => p.deviceId !== deviceId);
    });
    st.lags = (st.lags || []).filter((lag) => lag.ports.length > 0);
    // Drop any stack-links that touched the leaving member.
    st.stackLinks = (st.stackLinks || []).filter((sl) =>
      sl.fromDevice !== deviceId && sl.toDevice !== deviceId
    );
    toast(s, `Removed from ${stName} (×${st.members.length})`);
  }
  render(s);
  schedSave(s);
}

function deleteStack(s, stackId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  const stName = st.name;
  snapshot(s);
  dropStackAndItsLags(s, st);
  render(s);
  schedSave(s);
  toast(s, `Stack ${stName} deleted`);
}

// Drop a stack and every LAG it owned. Also break any peer-LAG counterpart
// pointer that referenced one of those LAGs.
function dropStackAndItsLags(s, st) {
  const droppedLagIds = new Set((st.lags || []).map((l) => l.id));
  s.stacks.forEach((other) => {
    if (other.id === st.id) return;
    (other.lags || []).forEach((lag) => {
      if (lag.counterpart?.stackId === st.id && droppedLagIds.has(lag.counterpart.lagId)) {
        delete lag.counterpart;
      }
    });
  });
  s.stacks = s.stacks.filter((x) => x.id !== st.id);
}

// Stack-links — "stacking cables" between members of a single stack. Modeled
// per-stack so they vanish with the stack and can carry per-cable port refs.
function addStackLink(s, stackId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  if (st.members.length < 2) { toast(s, 'Need at least 2 members'); return; }
  if (!Array.isArray(st.stackLinks)) st.stackLinks = [];
  snapshot(s);
  st.stackLinks.push({
    id: 'sl_' + rid(),
    fromDevice: st.members[0],
    toDevice: st.members[1],
    fromPort: '',
    toPort: '',
  });
  if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
  schedSave(s);
  openInspector(s);
}

// Drawing a regular link between two members of the same stack is really a
// stack-link gesture — same shape, same per-cable port refs, just owned by
// the stack instead of the global link list. Returns the new sl id.
function commitIntraStackLink(s, st, fromId, toId) {
  if (!st || fromId === toId) return null;
  if (!st.members.includes(fromId) || !st.members.includes(toId)) return null;
  if (!Array.isArray(st.stackLinks)) st.stackLinks = [];
  snapshot(s);
  const sl = {
    id: 'sl_' + rid(),
    fromDevice: fromId,
    toDevice: toId,
    fromPort: '',
    toPort: '',
  };
  st.stackLinks.push(sl);
  if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
  schedSave(s);
  return sl.id;
}

function removeStackLink(s, stackId, slId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  snapshot(s);
  st.stackLinks = (st.stackLinks || []).filter((sl) => sl.id !== slId);
  if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
  schedSave(s);
  openInspector(s);
}

function updateStackLinkField(s, stackId, slId, field, value) {
  const st = findStackById(s, stackId);
  if (!st) return;
  const sl = (st.stackLinks || []).find((x) => x.id === slId);
  if (!sl) return;
  snapshot(s);
  if (field === 'fromDevice') {
    sl.fromDevice = value;
    sl.fromPort = ''; // port list belongs to the device — reset
    if (sl.fromDevice === sl.toDevice) {
      // pick a different toDevice automatically
      const alt = st.members.find((m) => m !== value);
      if (alt) { sl.toDevice = alt; sl.toPort = ''; }
    }
  } else if (field === 'toDevice') {
    sl.toDevice = value;
    sl.toPort = '';
    if (sl.fromDevice === sl.toDevice) {
      const alt = st.members.find((m) => m !== value);
      if (alt) { sl.fromDevice = alt; sl.fromPort = ''; }
    }
  } else if (field === 'fromPort' || field === 'toPort') {
    sl[field] = value;
  }
  if (!isStackCollapsed(s, st)) refreshStackVisuals(s, st);
  schedSave(s);
  openInspector(s);
}

function toggleStackExpanded(s, stackId) {
  const st = findStackById(s, stackId);
  if (!st) return;
  // If routing-solo had this stack force-collapsed, the user's click reads
  // as "I want this open regardless" — drop the override and force-expand,
  // skipping the underlying flip (st.expanded was still true when solo hid
  // it, and a flip there would do the wrong thing on the next click cycle).
  if (s._soloCollapsedIds?.has(stackId)) {
    s._soloCollapsedIds.delete(stackId);
    st.expanded = true;
  } else {
    st.expanded = !st.expanded;
  }
  const devs = st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  // Heal sub-grid positions left behind by older versions of this code
  // (v2.33.44–v2.33.49 transient stages, where the recenter-on-expand pass
  // shifted members by sub-grid amounts to chase a half-grid bbox-centre).
  // Idempotent: snapping an already-grid-aligned coordinate to the nearest
  // grid line is a no-op. Worst-case shift = ±GRID/2 = 12px per coordinate,
  // applied uniformly across the stack so relative arrangement survives.
  st.x = Math.round(st.x / GRID) * GRID;
  st.y = Math.round(st.y / GRID) * GRID;
  devs.forEach((d) => {
    d.x = Math.round(d.x / GRID) * GRID;
    d.y = Math.round(d.y / GRID) * GRID;
  });
  // Anchor = centre of the member bounding box. Same point in both states so
  // toggling collapsed↔expanded never drifts the stack sideways: the icon
  // sits exactly where the visual midpoint of the expanded view was, and the
  // expanded bbox is centred exactly where the icon stood. Centroid (mean of
  // member positions) was wrong for asymmetric layouts — two stacks aligned
  // by their icons would expand to bboxes whose midpoints were offset by
  // (centroid − bbox-centre), and vice-versa.
  if (devs.length) {
    if (!st.expanded) {
      // st.x,st.y = bbox-centre snapped to nearest grid. Members are NOT
      // moved — they keep their existing grid-aligned positions. For an
      // asymmetric layout the true bbox-centre may fall on a half-grid line;
      // accepting a ≤GRID/2 icon-vs-bbox offset is the lesser evil compared
      // to (i) shifting members by sub-grid amounts (members go off-grid —
      // direct user complaint), or (ii) leaving st.x,st.y on a half-grid line
      // (icon between grid lines, and the next user-drag snap creates sub-
      // grid member shifts). The auto-column layout below now uses
      // stepY = 6·GRID so newly laid-out stacks always have bbox-centre
      // exactly on grid for any member count, eliminating any one-time st.y
      // jump on the first toggle after auto-layout.
      const xs = devs.map((d) => d.x);
      const ys = devs.map((d) => d.y);
      st.x = Math.round(((Math.min(...xs) + Math.max(...xs)) / 2) / GRID) * GRID;
      st.y = Math.round(((Math.min(...ys) + Math.max(...ys)) / 2) / GRID) * GRID;
    } else {
      // On expand: only auto-layout overlapping members. NO recenter pass —
      // shifting an existing arrangement by sub-grid amounts to match an
      // arbitrary anchor would push members off the grid. Legacy stacks
      // (where st.x was a centroid, not a bbox-centre) self-heal on the
      // very next collapse, which snaps st.x,st.y to the bbox-centre.
      layoutStackMembersIfOverlapping(s, st);
    }
  }
  render(s);
  schedSave(s);
}

// If members of an expanded stack visually overlap, re-arrange them in a
// clean column centered on the stack anchor with two grid lines of breathing
// room between cells. Members that already sit cleanly are left untouched.
function layoutStackMembersIfOverlapping(s, st) {
  const devs = st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  if (devs.length < 2) return false;
  let overlap = false;
  for (let i = 0; i < devs.length && !overlap; i++) {
    for (let j = i + 1; j < devs.length; j++) {
      if (Math.abs(devs[i].x - devs[j].x) < DEVICE_W && Math.abs(devs[i].y - devs[j].y) < DEVICE_H) {
        overlap = true;
        break;
      }
    }
  }
  if (!overlap) return false;
  // stepY = DEVICE_H + 2·GRID = 144 = 6·GRID. Picked over the older 5·GRID
  // (= 120) so totalH/2 is always a multiple of GRID, regardless of member
  // count: for any N, every member lands exactly on a grid line AND the
  // bbox-centre lands exactly on a grid line (= st.y). With 5·GRID, even-N
  // stacks had bbox-centre on a half-grid line, which forced a choice
  // between off-grid members and per-toggle drift.
  const stepY = DEVICE_H + 2 * GRID;
  const totalH = (devs.length - 1) * stepY;
  const colX = Math.round(st.x / GRID) * GRID;
  const startY = Math.round((st.y - totalH / 2) / GRID) * GRID;
  devs.forEach((d, i) => {
    d.x = colX;
    d.y = startY + i * stepY;
  });
  return true;
}

function drawCollapsedStack(s, stack) {
  const firstMember = stack.members.map((id) => s.devices.find((d) => d.id === id)).find(Boolean);
  const t = typeOf(firstMember?.type);
  const w = DEVICE_W, h = DEVICE_H;
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-stack-collapsed');
  g.setAttribute('data-stack-id', stack.id);
  // L3 status: the stack lights up on the routing layer when it owns a VIP
  // (its own L3 identity) OR when any member terminates IP independently.
  // A pure L2 switch-stack with no VIP fades along with regular switches.
  const stackIsL3 = stackHasVip(stack) || stack.members.some((mid) => {
    const m = s.devices.find((d) => d.id === mid);
    return m && isL3Device(m);
  });
  g.setAttribute('data-l3', stackIsL3 ? 'true' : 'false');
  if (stackIsDefaultGateway(s, stack)) g.setAttribute('data-gw', 'true');
  const vsState = vlanSoloStateForStack(s, stack);
  if (vsState) g.setAttribute('data-vlan-solo', vsState);
  if (s.activeLayer === 'routing') {
    const rsState = subnetSoloStateForStack(s, stack);
    if (rsState) g.setAttribute('data-routing-solo', rsState);
  }
  g.style.setProperty('--accent', t.accent);
  g.setAttribute('transform', `translate(${stack.x} ${stack.y})`);
  const memberCount = stack.members.length;
  const gwBadge = stackIsDefaultGateway(s, stack)
    ? `<g class="m002-dev-gw-badge"><rect x="${w/2 - 30}" y="${-h/2 + 4}" width="26" height="14" rx="2"/><text x="${w/2 - 17}" y="${-h/2 + 14}" text-anchor="middle">DGW</text></g>`
    : '';
  // Two ghost rects behind to suggest depth — capped at 2 visible layers
  g.innerHTML = `
    <rect class="m002-stack-ghost" x="${-w/2 + 6}" y="${-h/2 - 6}" width="${w}" height="${h}" rx="3"/>
    <rect class="m002-stack-ghost" x="${-w/2 + 3}" y="${-h/2 - 3}" width="${w}" height="${h}" rx="3"/>
    <rect class="m002-dev-bg"      x="${-w/2}"     y="${-h/2}"     width="${w}" height="${h}" rx="3"/>
    <text class="m002-dev-name m002-stack-name" x="0" y="${-h/2 + 36}" text-anchor="middle">${escSvg(stack.name)}</text>
    <text class="m002-stack-badge" x="${w/2 - 10}"  y="${-h/2 + 18}" text-anchor="end">×${memberCount}</text>
    <text class="m002-dev-notes"  x="${-w/2 + 10}" y="${h/2 - 10}">${escSvg(memberCount + ' members')}</text>
    ${gwBadge}
  `;
  s.gDevices.appendChild(g);
}

function refreshStackVisuals(s, stack) {
  // Cheaper than a full render: clear envelope + cables for this stack and redraw.
  s.gStacksBg.querySelectorAll(`[data-stack-id="${stack.id}"]`).forEach((el) => el.remove());
  // Stack cables sit in gStacksBg too without an id wrapper — easier to rebuild fully.
  s.gStacksBg.innerHTML = '';
  // Active-zone gate: without it, cross-zone envelopes (and their click-eating
  // hit areas) bleed into the current view whenever any stack moves.
  const inZone = (st) => !s.activeZone || !st.zone || st.zone === s.activeZone;
  s.stacks.forEach((st) => { if (inZone(st) && !isStackCollapsed(s, st)) drawStackEnvelope(s, st); });
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
  const t = typeOf(stackTypeOf(s, stack));
  if (t?.accent) env.style.setProperty('--accent', t.accent);
  // The envelope itself is an L3 entity ONLY when the stack carries a VIP.
  // A stack without a VIP is just a container — its router/firewall members
  // speak L3 individually; the envelope must stay neutral in routing layer.
  const stackIsL3 = stackHasVip(stack);
  env.setAttribute('data-l3', stackIsL3 ? 'true' : 'false');
  const envVsState = vlanSoloStateForStack(s, stack);
  if (envVsState) env.setAttribute('data-vlan-solo', envVsState);
  const envRsState = s.activeLayer === 'routing' ? subnetSoloStateForStack(s, stack) : null;
  if (envRsState) env.setAttribute('data-routing-solo', envRsState);
  env.innerHTML = `
    <rect class="m002-stack-env-bg" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="6"/>
    <text class="m002-stack-env-label" x="${minX + 10}" y="${minY + 14}">${escSvg(stack.name)} ×${members.length}</text>
  `;
  s.gStacksBg.appendChild(env);
  // Stacking cables — only the user-configured stack-links. Each one is a
  // dashed orthogonal path between two members, with optional port labels at
  // the endpoints. Lanes keep parallel cables between the same member-pair
  // from overlapping.
  const lanesByPair = new Map();
  (stack.stackLinks || []).forEach((sl) => {
    const key = [sl.fromDevice, sl.toDevice].sort().join('|');
    if (!lanesByPair.has(key)) lanesByPair.set(key, 0);
  });
  (stack.stackLinks || []).forEach((sl, idx) => {
    const a = members.find((m) => m.id === sl.fromDevice);
    const b = members.find((m) => m.id === sl.toDevice);
    if (!a || !b) return;
    const key = [sl.fromDevice, sl.toDevice].sort().join('|');
    const laneIdx = lanesByPair.get(key) || 0;
    lanesByPair.set(key, laneIdx + 1);
    const off = (laneIdx - 0) * 8;
    const cab = document.createElementNS(SVG_NS, 'g');
    cab.setAttribute('class', 'm002-stacklink');
    cab.setAttribute('data-stack-id', stack.id);
    cab.setAttribute('data-stacklink-id', sl.id);
    // Stack-internal cables share the parent stack's VLAN-solo state — when
    // the stack itself is dimmed/amber, its stacking cables follow suit
    // instead of staying lit and visually contradicting the envelope.
    if (envVsState) cab.setAttribute('data-vlan-solo', envVsState);
    if (envRsState) cab.setAttribute('data-routing-solo', envRsState);
    const path = orthPath(a, b, off, s, [a.id, b.id]);
    let inner = `<path class="m002-stack-cable" d="${path.d}"/>`;
    // Port labels on stacking cables only in Physical — VLAN/Routing layers
    // already speak via colour, the textual port stencil is just clutter there.
    if (s.activeLayer === 'physical') {
      const shortMode = s.prefs?.shortPortLabels !== false;
      const fmt = (lbl) => shortMode ? shortPortLabel(lbl) : lbl;
      const fromLbl = sl.fromPort ? fmt(portLabel(a, sl.fromPort)) : '';
      const toLbl   = sl.toPort   ? fmt(portLabel(b, sl.toPort))   : '';
      if (fromLbl || toLbl) {
        const lbl = (fromLbl || '?') + ' ⇄ ' + (toLbl || '?');
        inner += `<text class="m002-stack-cable-label" x="${path.lx}" y="${path.ly - 4}" text-anchor="middle">${escSvg(lbl)}</text>`;
      }
    }
    cab.innerHTML = inner;
    s.gStacksBg.appendChild(cab);
  });
}

// Bounding rects of every visible device + collapsed-stack icon. Link routes
// score themselves against this list and pick the orientation that punches
// through fewest boxes. Endpoints are excluded so a link doesn't count its
// own anchor devices as obstacles.
function routingObstacles(s, excludeIds) {
  if (!s) return [];
  const ex = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const out = [];
  const halfW = DEVICE_W / 2, halfH = DEVICE_H / 2;
  (s.devices || []).forEach((d) => {
    if (ex.has(d.id)) return;
    const stack = findStack(s, d.id);
    if (stack && isStackCollapsed(s, stack)) return; // hidden inside icon
    if (s.activeZone && d.zone && d.zone !== s.activeZone) return;
    out.push({ x: d.x - halfW, y: d.y - halfH, w: DEVICE_W, h: DEVICE_H });
  });
  (s.stacks || []).forEach((st) => {
    if (ex.has(st.id)) return;
    if (!isStackCollapsed(s, st)) return;
    if (s.activeZone && st.zone && st.zone !== s.activeZone) return;
    out.push({ x: st.x - halfW, y: st.y - halfH, w: DEVICE_W, h: DEVICE_H });
  });
  return out;
}

// Endpoint exclusion set for a port-link — both anchored devices AND the
// stack icons they collapse into (the visible obstacle is the icon, not the
// hidden member). Used by every drawLink/drawLag* call so the route doesn't
// score its own anchor as an obstacle.
function linkExcludeIds(s, link) {
  const out = [link.from, link.to];
  const sa = findStack(s, link.from);
  const sb = findStack(s, link.to);
  if (sa) out.push(sa.id);
  if (sb) out.push(sb.id);
  return out;
}

function hSegmentHitsRect(y, x1, x2, r, pad = 4) {
  if (y <= r.y - pad || y >= r.y + r.h + pad) return false;
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
  return hi > r.x - pad && lo < r.x + r.w + pad;
}
function vSegmentHitsRect(x, y1, y2, r, pad = 4) {
  if (x <= r.x - pad || x >= r.x + r.w + pad) return false;
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
  return hi > r.y - pad && lo < r.y + r.h + pad;
}

// Anchor at the midpoint of one of a device's four sides. `off` shifts the
// anchor along that side (perpendicular to its outward direction) — used by
// parallel lanes so multiple links to the same side don't all stack on top
// of each other.
function anchorAt(devPos, side, off = 0) {
  const halfW = DEVICE_W / 2, halfH = DEVICE_H / 2;
  switch (side) {
    case 'N': return { x: devPos.x + off, y: devPos.y - halfH };
    case 'S': return { x: devPos.x + off, y: devPos.y + halfH };
    case 'E': return { x: devPos.x + halfW, y: devPos.y + off };
    case 'W': return { x: devPos.x - halfW, y: devPos.y + off };
  }
}

// Default anchor pair: each endpoint picks the side that most directly faces
// the other (dominant-axis projection of the centre-to-centre vector). Pairs
// always come out OPPOSITE (E↔W or N↔S) — when the link exits the top of
// source, it enters the bottom of the target, mirroring how a real cable
// would naturally route between facing edges. Same-row pairs collapse to a
// single straight segment; diagonals become a Z (≤2 bends) instead of an L
// whose corner would clip into one box's interior side.
function pickAnchorSides(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { aSide: dx > 0 ? 'E' : 'W', bSide: dx > 0 ? 'W' : 'E' };
  }
  return { aSide: dy > 0 ? 'S' : 'N', bSide: dy > 0 ? 'N' : 'S' };
}

// When the hub's anchor is locked to a specific side (because ≥2 peers merge
// on that side), the source still picks its FACING side — the dominant-axis
// projection of source→hub. With facing-side exits the link enters/leaves
// each box on the visually correct edge (top exit → bottom entry, etc.)
// instead of bursting out of a side that points away from the other end.
function sourceSideForHub(srcPos, hubPos, _hubSide) {
  const dx = hubPos.x - srcPos.x, dy = hubPos.y - srcPos.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'S' : 'N';
  return dx > 0 ? 'E' : 'W';
}

// Build orthogonal waypoints between two anchors honouring each anchor's
// outward exit direction. Returns [{x,y}, ...] of length 2 (straight),
// 3 (single L), or 4 (Z / U). Both sides perpendicular → single L. Both
// sides on the same axis pointing AT each other (E↔W or N↔S) → straight
// when aligned, Z otherwise. Both sides identical → U-bypass.
//
// `snapMode` controls the near-aligned-snap behaviour for opposite-facing
// anchors:
//   'avg'  — both anchors shift halfway to the average coordinate (default).
//   'a'    — pin aP at its midpoint, pull bP onto aP's coord (used when A is
//            a transit / multi-degree endpoint; keeps every link through it
//            anchored at the same y/x so consecutive links visually meet).
//   'b'    — symmetric: pin bP, move aP.
//   'none' — never snap; always Z when misaligned.
function pointsForAnchors(aP, aSide, bP, bSide, snapMode = 'avg', bendCoord = null) {
  const aH = aSide === 'E' || aSide === 'W';
  const bH = bSide === 'E' || bSide === 'W';
  const oppHoriz = (aSide === 'E' && bSide === 'W') || (aSide === 'W' && bSide === 'E');
  const oppVert  = (aSide === 'N' && bSide === 'S') || (aSide === 'S' && bSide === 'N');
  // Snap small misalignments to a shared coordinate so a near-aligned pair
  // becomes a true straight line instead of a Z with two ~1px kinks. Tight
  // snap window — one GRID step — caps each anchor's drift from its side
  // midpoint at half a grid cell. Devices that drift further keep their
  // Z so the anchor doesn't slide visibly toward a box corner.
  const SNAP_TOL = GRID; // total misalignment tolerated; per-anchor shift is half this
  if (oppHoriz) {
    if (snapMode !== 'none' && Math.abs(aP.y - bP.y) <= SNAP_TOL) {
      let y;
      if      (snapMode === 'a') y = aP.y;
      else if (snapMode === 'b') y = bP.y;
      else                       y = (aP.y + bP.y) / 2;
      return [{ x: aP.x, y }, { x: bP.x, y }];
    }
    // Hub-merge approach lane: when bendCoord.x is set, every peer link bends
    // at the same x just outside the hub edge so their vertical legs overlap
    // into a single visible trunk before entering the hub.
    const mx = (bendCoord && bendCoord.x !== undefined) ? bendCoord.x : (aP.x + bP.x) / 2;
    return [aP, { x: mx, y: aP.y }, { x: mx, y: bP.y }, bP];
  }
  if (oppVert) {
    if (snapMode !== 'none' && Math.abs(aP.x - bP.x) <= SNAP_TOL) {
      let x;
      if      (snapMode === 'a') x = aP.x;
      else if (snapMode === 'b') x = bP.x;
      else                       x = (aP.x + bP.x) / 2;
      return [{ x, y: aP.y }, { x, y: bP.y }];
    }
    const my = (bendCoord && bendCoord.y !== undefined) ? bendCoord.y : (aP.y + bP.y) / 2;
    return [aP, { x: aP.x, y: my }, { x: bP.x, y: my }, bP];
  }
  if (aSide === bSide) {
    if (aH) {
      const sgn = aSide === 'W' ? -1 : 1;
      const xByp = (sgn === -1 ? Math.min(aP.x, bP.x) : Math.max(aP.x, bP.x)) + sgn * GRID;
      return [aP, { x: xByp, y: aP.y }, { x: xByp, y: bP.y }, bP];
    }
    const sgn = aSide === 'N' ? -1 : 1;
    const yByp = (sgn === -1 ? Math.min(aP.y, bP.y) : Math.max(aP.y, bP.y)) + sgn * GRID;
    return [aP, { x: aP.x, y: yByp }, { x: bP.x, y: yByp }, bP];
  }
  // Perpendicular pair → single L. Corner at (V-side x, H-side y).
  const cx = aH ? bP.x : aP.x;
  const cy = aH ? aP.y : bP.y;
  return [aP, { x: cx, y: cy }, bP];
}

function pointsToPath(pts) {
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i].x} ${pts[i].y}`;
  return d;
}

function pointsLabel(pts) {
  // Midpoint of the longest segment so the badge sits on a clean run, not
  // a corner.
  let best = 0, bx = pts[0].x, by = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    const len = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    if (len > best) { best = len; bx = (a.x + b.x) / 2; by = (a.y + b.y) / 2; }
  }
  return { lx: bx, ly: by };
}

function pointsHitAny(pts, obstacles, pad = 4) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i-1], b = pts[i];
    for (const r of obstacles) {
      if (a.y === b.y) {
        if (hSegmentHitsRect(a.y, a.x, b.x, r, pad)) return true;
      } else if (a.x === b.x) {
        if (vSegmentHitsRect(a.x, a.y, b.y, r, pad)) return true;
      }
    }
  }
  return false;
}

// When the simple route (straight or single L) is blocked, build a Z-detour
// past the offending obstacle. Tries 4 detour positions (left/right of the
// obstacle for vertical bypass; above/below for horizontal bypass) and picks
// the first that clears every obstacle. Returns the detoured pts or null.
function detourAroundObstacles(pts, obstacles, pad = 8) {
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  // Find the first obstacle hit by any segment.
  let hit = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i-1], q = pts[i];
    for (const r of obstacles) {
      if (p.y === q.y && hSegmentHitsRect(p.y, p.x, q.x, r, pad)) { hit = r; break; }
      if (p.x === q.x && vSegmentHitsRect(p.x, p.y, q.y, r, pad)) { hit = r; break; }
    }
    if (hit) break;
  }
  if (!hit) return null;
  const tryShifts = [
    { axis: 'x', val: hit.x - pad - 1 },
    { axis: 'x', val: hit.x + hit.w + pad + 1 },
    { axis: 'y', val: hit.y - pad - 1 },
    { axis: 'y', val: hit.y + hit.h + pad + 1 },
  ];
  for (const sh of tryShifts) {
    const cand = sh.axis === 'x'
      ? [a, { x: sh.val, y: a.y }, { x: sh.val, y: b.y }, b]
      : [a, { x: a.x, y: sh.val }, { x: b.x, y: sh.val }, b];
    if (!pointsHitAny(cand, obstacles, pad)) return cand;
  }
  return null;
}

// Orthogonal route from a→b. Anchors live exclusively on side midpoints; the
// path is built from the anchor pair (opposite-facing → straight or Z;
// perpendicular → single L; same-side → U). Hub-merge locks the hub's side
// so peer links converge on a shared trunk anchor.
//
// Selection: try the PREFERRED pair first (each endpoint's facing side, so
// "exit top → enter bottom" reads naturally). If that path is clean, use
// it — even if some other anchor pair would have one fewer bend. Only
// when the preferred pair is blocked by an obstacle do we search the rest
// of the (aSide, bSide) grid for the lowest-bend clean alternative. If
// EVERY combination is blocked, fall back to a Z-detour off the preferred
// pair so the line still bypasses the offender instead of vanishing
// behind it.
const _ORTH_SIDES = ['N', 'E', 'S', 'W'];
function orthPath(a, b, off = 0, s = null, excludeIds = null, hubInfo = null, transit = null) {
  const obstacles = routingObstacles(s, excludeIds);
  let prefA, prefB;
  if (hubInfo) {
    if (hubInfo.hubIsB) { prefB = hubInfo.hubSide; prefA = sourceSideForHub(a, b, prefB); }
    else                { prefA = hubInfo.hubSide; prefB = sourceSideForHub(b, a, prefA); }
  } else {
    const sd = pickAnchorSides(a, b);
    prefA = sd.aSide; prefB = sd.bSide;
  }
  // Transit-aware snap mode: when one endpoint is a transit (≥2 distinct
  // peers), pin its anchor to its true midpoint and pull the other anchor
  // to match — so consecutive links through a JUMP/hub all attach at the
  // same y/x and visually meet through it instead of stair-stepping by a
  // few px each.
  const aTransit = !!(transit && transit.aIsTransit);
  const bTransit = !!(transit && transit.bIsTransit);
  const snapMode = aTransit && !bTransit ? 'a'
                 : bTransit && !aTransit ? 'b'
                 : aTransit && bTransit  ? 'none'
                 : 'avg';
  // Hub-merge approach lane: when this link is part of a hub-merge group,
  // every peer link bends at a SHARED coord one GRID-step outside the hub's
  // merge side. Their otherwise-independent Z-arms now stack onto the same
  // trunk axis just before entering the hub — visually a single shared
  // approach into the hub instead of N parallel corridors.
  let bendCoord = null;
  if (hubInfo) {
    const hubPos = hubInfo.hubIsB ? b : a;
    const hHalfW = DEVICE_W / 2, hHalfH = DEVICE_H / 2;
    if      (hubInfo.hubSide === 'W') bendCoord = { x: hubPos.x - hHalfW - GRID };
    else if (hubInfo.hubSide === 'E') bendCoord = { x: hubPos.x + hHalfW + GRID };
    else if (hubInfo.hubSide === 'N') bendCoord = { y: hubPos.y - hHalfH - GRID };
    else if (hubInfo.hubSide === 'S') bendCoord = { y: hubPos.y + hHalfH + GRID };
  }
  // 1) Preferred pair first. Wins outright when clean — the facing-side
  // exit/entry rule beats a slightly cheaper bend count from a side that
  // doesn't visually face the other end.
  const prefAP = anchorAt(a, prefA, off);
  const prefBP = anchorAt(b, prefB, off);
  const prefPts = pointsForAnchors(prefAP, prefA, prefBP, prefB, snapMode, bendCoord);
  if (!pointsHitAny(prefPts, obstacles)) {
    const lbl = pointsLabel(prefPts);
    return {
      d: pointsToPath(prefPts),
      lx: lbl.lx, ly: lbl.ly,
      from: { x: prefPts[0].x, y: prefPts[0].y, anchor: 'start' },
      to:   { x: prefPts[prefPts.length - 1].x, y: prefPts[prefPts.length - 1].y, anchor: 'end' },
    };
  }
  // 2) Preferred is blocked — search alternatives, locking whichever side
  // the hub merge fixed. Lowest-bend clean candidate wins.
  const aChoices = hubInfo && !hubInfo.hubIsB ? [hubInfo.hubSide] : _ORTH_SIDES;
  const bChoices = hubInfo &&  hubInfo.hubIsB ? [hubInfo.hubSide] : _ORTH_SIDES;
  let best = null;
  for (const aS of aChoices) {
    for (const bS of bChoices) {
      if (aS === prefA && bS === prefB) continue; // already tested
      const aP = anchorAt(a, aS, off);
      const bP = anchorAt(b, bS, off);
      const pts = pointsForAnchors(aP, aS, bP, bS, snapMode, bendCoord);
      if (pointsHitAny(pts, obstacles)) continue;
      const bends = pts.length - 2;
      if (best === null || bends < best.bends) best = { bends, pts };
    }
  }
  // 3) Still nothing — Z-detour off the preferred pair.
  const chosen = best ? best.pts : (detourAroundObstacles(prefPts, obstacles) || prefPts);
  const lbl = pointsLabel(chosen);
  return {
    d: pointsToPath(chosen),
    lx: lbl.lx, ly: lbl.ly,
    from: { x: chosen[0].x, y: chosen[0].y, anchor: 'start' },
    to:   { x: chosen[chosen.length - 1].x, y: chosen[chosen.length - 1].y, anchor: 'end' },
  };
}

// What does this LAG connect to? Walks each member port's existing link and
// summarizes the most common destination as { device, lag?, portCount }.
function lagCounterpart(s, stackId, lag) {
  // Manual override beats inference
  if (lag?.counterpart?.stackId && lag?.counterpart?.lagId) {
    const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
    if (peer) return { stack: peer.stack, lag: peer.lag, count: peer.lag.ports?.length || 0, manual: true };
  }
  // Auto-derive from port-links. Iterate every (host, portN) the LAG owns,
  // then tally which peer stack-LAG the matching links resolve to.
  const counts = new Map(); // key (peerStackId|peerLagId?) → { stack, lag, count }
  for (const portRef of (lag.ports || [])) {
    const hostId = portRef.deviceId;
    const portN = Number(portRef.portN);
    const link = s.links.find((l) =>
      (l.from === hostId && Number(l.fromPort) === portN) ||
      (l.to   === hostId && Number(l.toPort)   === portN)
    );
    if (!link) continue;
    const otherId = link.from === hostId ? link.to : link.from;
    const otherPort = Number(link.from === hostId ? link.toPort : link.fromPort);
    const peerStack = findStack(s, otherId);
    if (!peerStack) continue;
    const peerLagInfo = findPortLag(s, otherId, otherPort);
    const peerLag = peerLagInfo?.lag || null;
    const key = peerStack.id + (peerLag ? '|' + peerLag.id : '');
    if (!counts.has(key)) counts.set(key, { stack: peerStack, lag: peerLag, count: 0 });
    counts.get(key).count++;
  }
  if (counts.size === 0) return null;
  return [...counts.values()].sort((a, b) => b.count - a.count)[0];
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
  const lane   = opts.lane   || 0;
  const a = orthPath(aPos, bPos, lane + gap, opts.s, opts.excludeIds, opts.hubInfo, opts.transit);
  const b = orthPath(aPos, bPos, lane - gap, opts.s, opts.excludeIds, opts.hubInfo, opts.transit);
  return `
    <path class="m002-lag-line" d="${a.d}" stroke="${stroke}" stroke-width="${width}" fill="none"/>
    <path class="m002-lag-line" d="${b.d}" stroke="${stroke}" stroke-width="${width}" fill="none"/>
  `;
}

// Renders an explicit LAG-pair as a single ring-decorated link, replacing
// the underlying port-cables in any layer. Click → opens the LAG modal so
// the user can edit name / members / counterpart / VLANs in one place.
function drawLagLink(s, p) {
  // Only invoked when both stacks are collapsed — endpoints anchor at stack
  // icons. When either side is expanded, render() draws the underlying port-
  // links instead (the LAG is implicit, marked at each port).
  const aPos = { x: p.stackA.x, y: p.stackA.y };
  const bPos = { x: p.stackB.x, y: p.stackB.y };
  const lane = laneForLag(s, p.stackA.id, p.lagA.id);
  const excl = [p.stackA.id, p.stackB.id];
  const forced = hubMergeInfo(s, { from: p.stackA.id, to: p.stackB.id });
  const transit = { aIsTransit: endpointIsTransit(s, p.stackA.id), bIsTransit: endpointIsTransit(s, p.stackB.id) };
  const path = orthPath(aPos, bPos, lane, s, excl, forced, transit);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link m002-link-bundle m002-laglink');
  g.setAttribute('data-laglink-id', `${p.stackA.id}|${p.lagA.id}`);

  const sharedVlans = (p.lagA.vlans || []).map(String).filter((v) => (p.lagB.vlans || []).map(String).includes(v));
  const filter = effectiveVlanSolo(s);
  const isFiltered = filter.length > 0;
  const drawnVlans = isFiltered ? sharedVlans.filter((v) => filter.includes(v)) : [];
  if (s.activeLayer === 'vlan' && isFiltered && drawnVlans.length === 0) {
    const lagUnion = [...new Set([...(p.lagA.vlans || []), ...(p.lagB.vlans || [])].map(String))];
    const asym = lagUnion.some((v) => filter.includes(v));
    g.classList.add(asym ? 'm002-link-vsolo-asym' : 'm002-link-vsolo-dim');
  }
  let inner = `<path class="m002-link-hit" d="${path.d}"/>`;
  if (s.activeLayer === 'routing') {
    // Routing layer: LAG-pairs are L2 plumbing — paint them as the same dim
    // dashed underlay every other link gets. The L3 ribbon above carries the
    // colour. Without this we'd stack a gray double-line beneath the ribbon
    // and end up with four parallel highlights through one wire pair.
    if (linkRoutingSoloDim(s, { from: p.stackA.id, to: p.stackB.id })) {
      g.classList.add('m002-link-rsolo-dim');
    }
    inner += `<path class="m002-link-line m002-link-dim" d="${path.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
  } else if (s.activeLayer === 'vlan' && drawnVlans.length) {
    const gap = 6;
    drawnVlans.forEach((v, i) => {
      const off = lane + (i - (drawnVlans.length - 1) / 2) * gap;
      const op = orthPath(aPos, bPos, off, s, excl, forced, transit);
      const c = vlanColor(s, v);
      inner += `<path class="m002-link-line m002-link-stripe" d="${op.d}" style="stroke:${c};color:${c}" stroke-width="2.4"/>`;
      inner += `<text class="m002-link-label m002-link-stripe-label" x="${op.lx}" y="${op.ly - 4}" style="fill:${c};color:${c}" text-anchor="middle">${escSvg(v)}</text>`;
    });
  } else {
    inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 2, lane, s, excludeIds: excl, hubInfo: forced, transit });
    if (s.activeLayer === 'vlan' && !isFiltered && sharedVlans.length) {
      inner += `<text class="m002-link-vlan-count" x="${path.lx}" y="${path.ly - 4}" fill="#9aa0a8" text-anchor="middle">${sharedVlans.length}x</text>`;
    }
  }
  // "Po1 ⇄ Po2" stencil only in Physical — VLAN/Routing already speak via
  // colour + count, the textual LAG name is just clutter there.
  if (s.activeLayer === 'physical') {
    inner += `<text class="m002-link-bundle-label" x="${path.lx}" y="${path.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(p.lagA.name + ' ⇄ ' + p.lagB.name)}</text>`;
  }
  g.innerHTML = inner;
  // Flow path is injected on-demand by applyIncidentFlow() — store the path
  // shape here so the injection has nothing to recompute. No idle <path> means
  // no Firefox SVG-pattern flicker around the cursor.
  g.setAttribute('data-flow-d', path.d);
  s.gLinks.appendChild(g);
}

function aggEndpointPos(s, id) {
  const stack = (s.stacks || []).find((st) => st.id === id);
  if (stack) return { x: stack.x, y: stack.y };
  const dev = s.devices.find((d) => d.id === id);
  if (dev) return { x: dev.x, y: dev.y };
  return null;
}

// Wipe and re-render every stack-pair aggregate. Called from drag onMove
// handlers — collapsed-stack icons or attached devices have moved, so the
// aggregate dim line needs to follow. Cheap: typically a handful of <g>s.
function refreshAggregates(s) {
  if (!s.gLinks) return;
  s.gLinks.querySelectorAll('[data-agg-key]').forEach((el) => el.remove());
  const absorbed = computeAbsorbedLinkIds(s);
  const aggs = computeStackPairAggregations(s, absorbed);
  aggs.forEach((agg, key) => {
    const aPos = aggEndpointPos(s, agg.aSide);
    const bPos = aggEndpointPos(s, agg.bSide);
    if (aPos && bPos) drawStackPairAggregate(s, key, agg, aPos, bPos);
  });
}

// Single dim summary line replacing N parallel non-paired-LAG stubs between
// two collapsed-stack (or stack + device) endpoints. Click target carries
// the aggregation key so a future LAG-config flow can resolve the linkIds.
function drawStackPairAggregate(s, key, agg, aPos, bPos) {
  const lane = laneForAgg(s, key);
  const forced = hubMergeInfo(s, { from: agg.aSide, to: agg.bSide });
  const transit = { aIsTransit: endpointIsTransit(s, agg.aSide), bIsTransit: endpointIsTransit(s, agg.bSide) };
  const path = orthPath(aPos, bPos, lane, s, [agg.aSide, agg.bSide], forced, transit);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link m002-link-agg');
  g.setAttribute('data-agg-key', key);
  if (s.activeLayer === 'routing'
      && linkRoutingSoloDim(s, { from: agg.aSide, to: agg.bSide })) {
    g.classList.add('m002-link-rsolo-dim');
  }
  let inner = `<path class="m002-link-hit" d="${path.d}"/>`;
  inner += `<path class="m002-link-line m002-link-agg-line" d="${path.d}" stroke="#5a5f6e" stroke-dasharray="6 4" stroke-width="1.4"/>`;
  // No textual badge — the dashed line itself is enough of a placeholder.
  // Click target is the full hit-region (m002-link-hit) above.
  g.innerHTML = inner;
  s.gLinks.appendChild(g);
}

function lagBundleKey(s, link) {
  const infoA = findPortLag(s, link.from, link.fromPort);
  const infoB = findPortLag(s, link.to,   link.toPort);
  if (!infoA && !infoB) return null;
  // Bundling collapses every member-port link into a single LAG line. That
  // only makes visual sense when both owning stacks are collapsed — once a
  // stack is expanded the user wants to see the underlying port-links as
  // discrete edges between the visible members.
  const stackA = findStack(s, link.from);
  const stackB = findStack(s, link.to);
  if (stackA && !isStackCollapsed(s, stackA)) return null;
  if (stackB && !isStackCollapsed(s, stackB)) return null;
  // Direction-independent key keyed on the OWNING STACK on each side. Using
  // stack ids (not the per-member device id of the no-LAG side) ensures all
  // links from one stack's LAG to any member of the peer stack collapse
  // into a single bundle — otherwise N parallel "Po1 ⇄ ? · ×1" stubs
  // appear when the peer side has no LAG configured.
  const aSide = infoA
    ? `${infoA.stack.id}:${infoA.lag.id}`
    : (stackA ? `${stackA.id}:_` : `${link.from}:_`);
  const bSide = infoB
    ? `${infoB.stack.id}:${infoB.lag.id}`
    : (stackB ? `${stackB.id}:_` : `${link.to}:_`);
  return [aSide, bSide].sort().join('::');
}

function linkVlans(s, link) {
  const va = new Set(portVlans(s, link.from, link.fromPort));
  const vb = new Set(portVlans(s, link.to,   link.toPort));
  return [...va].filter((v) => vb.has(v));
}
// Union of VLANs across both endpoint ports. VLAN solo uses this to flag
// "asymmetric" links: one side carries the soloed VLAN, the other doesn't,
// so the intersection (linkVlans) is empty but the union still matches.
function linkVlansUnion(s, link) {
  const va = portVlans(s, link.from, link.fromPort).map(String);
  const vb = portVlans(s, link.to,   link.toPort).map(String);
  return [...new Set([...va, ...vb])];
}

// Effective VLAN solo set = persisted filter + transient hover preview from
// legend mouseenter. Hover acts additively so users can preview a single VLAN
// without losing whatever they already soloed.
function effectiveVlanSolo(s) {
  const filter = (s.view?.vlanFilter || []).map(String);
  const hover = s._vlanHover != null ? String(s._vlanHover) : null;
  if (hover && !filter.includes(hover)) return [...filter, hover];
  return filter;
}

// Per-element VLAN-solo state for canvas dimming. Four states, tuned to flag
// "should this element have the VLAN?" at a glance:
//   'matched'             VLAN configured AND ≥1 port carries it       → normal
//   'configured-only'     VLAN configured, no port carries it          → orange
//   'unmatched-adjacent'  no VLAN, but a linked neighbor has it        → yellow
//   'unmatched-isolated'  no VLAN, no neighbor has it either           → grey
//   null                  no filter active                              → normal
function vlanSoloCtx(s) {
  const filter = effectiveVlanSolo(s);
  if (!filter.length) return null;
  // Reuse cached context within a single render cycle. render() clears the
  // cache so the next paint sees fresh state; redraw* paths recompute.
  if (s._vlanSoloCtx && s._vlanSoloCtx.filterKey === filter.join('|')) return s._vlanSoloCtx;
  const carrier = new Map();    // device.id → has any soloed VLAN at dev level
  const neighbors = new Map();  // device.id → Set of linked device ids
  s.devices.forEach((d) => {
    carrier.set(d.id, (d.vlans || []).some((v) => filter.includes(String(v))));
    neighbors.set(d.id, new Set());
  });
  (s.links || []).forEach((l) => {
    if (!l.from || !l.to || l.from === l.to) return;
    neighbors.get(l.from)?.add(l.to);
    neighbors.get(l.to)?.add(l.from);
  });
  const ctx = { filter, filterKey: filter.join('|'), carrier, neighbors };
  s._vlanSoloCtx = ctx;
  return ctx;
}
function vlanSoloStateForDevice(s, dev) {
  const ctx = vlanSoloCtx(s);
  if (!ctx) return null;
  const { filter, carrier, neighbors } = ctx;
  const devHas = carrier.get(dev.id);
  if (devHas) {
    const portCarries = (dev.ports || []).some((p) =>
      (p.vlans || []).some((v) => filter.includes(String(v)))
    );
    return portCarries ? 'matched' : 'configured-only';
  }
  const adj = neighbors.get(dev.id);
  if (adj) {
    for (const nid of adj) if (carrier.get(nid)) return 'unmatched-adjacent';
  }
  return 'unmatched-isolated';
}
// Soft update path for VLAN solo toggles / hovers / clears. Re-evaluates the
// state for every existing canvas element and updates data-vlan-solo in place,
// so CSS transitions can interpolate the dim/amber fade instead of snapping
// from a wiped DOM tree. Links/legend still rebuild — they don't carry
// transitions on the visual properties that change.
function applyVlanSoloVisuals(s) {
  s._vlanSoloCtx = null;
  if (s.gDevices) {
    const filterActive = effectiveVlanSolo(s).length > 0;
    s.devices.forEach((dev) => {
      const g = s.gDevices.querySelector(`[data-device-id="${dev.id}"]`);
      if (!g) return;
      if (isReference(dev)) {
        if (!filterActive) { g.removeAttribute('data-vlan-solo'); return; }
        const peerForVsolo = couplePeer(s, dev);
        const peerState = peerForVsolo ? vlanSoloStateForDevice(s, peerForVsolo) : null;
        g.setAttribute('data-vlan-solo', peerState || 'unmatched-isolated');
        return;
      }
      const st = vlanSoloStateForDevice(s, dev);
      if (st) g.setAttribute('data-vlan-solo', st);
      else g.removeAttribute('data-vlan-solo');
    });
    s.stacks.forEach((stack) => {
      const collapsed = s.gDevices.querySelector(`.m002-stack-collapsed[data-stack-id="${stack.id}"]`);
      const envelope = s.gStacksBg?.querySelector(`.m002-stack-envelope[data-stack-id="${stack.id}"]`);
      const cables = s.gStacksBg?.querySelectorAll(`.m002-stacklink[data-stack-id="${stack.id}"]`) || [];
      const st = vlanSoloStateForStack(s, stack);
      [collapsed, envelope, ...cables].forEach((el) => {
        if (!el) return;
        if (st) el.setAttribute('data-vlan-solo', st);
        else el.removeAttribute('data-vlan-solo');
      });
    });
  }
  // Links carry VLAN stripes / count badges that depend on the filter — bare
  // attribute swaps can't transition those, so a redraw is fine. The
  // .m002-vsolo-fade class triggers a one-shot opacity ease-in so the swap
  // doesn't snap; we strip the class on animationend to keep future redraws
  // (drag, layer toggle, …) from inheriting the fade.
  s.links.forEach((l) => redrawLink(s, l));
  redrawAllLagPairs(s);
  if (s.gLinks) {
    s.gLinks.querySelectorAll('.m002-link, .m002-laglink').forEach((g) => {
      g.classList.add('m002-vsolo-fade');
      g.addEventListener('animationend', () => g.classList.remove('m002-vsolo-fade'), { once: true });
    });
  }
  renderLegend(s);
}

function vlanSoloStateForStack(s, stack) {
  const ctx = vlanSoloCtx(s);
  if (!ctx) return null;
  const { filter, carrier, neighbors } = ctx;
  const memberIds = new Set(stack.members || []);
  let stackHas = false;
  let portCarries = false;
  (stack.members || []).forEach((id) => {
    if (carrier.get(id)) stackHas = true;
    const m = s.devices.find((d) => d.id === id);
    if (!m) return;
    if ((m.ports || []).some((p) => (p.vlans || []).some((v) => filter.includes(String(v))))) {
      portCarries = true;
    }
  });
  if (stackHas) return portCarries ? 'matched' : 'configured-only';
  for (const id of memberIds) {
    const adj = neighbors.get(id);
    if (!adj) continue;
    for (const nid of adj) {
      if (memberIds.has(nid)) continue;
      if (carrier.get(nid)) return 'unmatched-adjacent';
    }
  }
  return 'unmatched-isolated';
}

// =============================================================================
// Routing (subnet) solo — sibling of VLAN solo for the routing layer
// =============================================================================
// Mirrors the VLAN-solo model. When the user solos one or more subnets in the
// subnet legend (or hovers a row to preview one), every entity on the canvas
// gets a data-routing-solo state that CSS uses to dim non-participants.
//
// Per-element states (binary — routing has no "configured but unwired"
// equivalent of VLAN's amber state; a subnet either is or isn't on a device):
//   'matched'             entity participates in the soloed subnet           → normal
//   'unmatched-adjacent'  entity doesn't, but a linked neighbor does          → dim
//   'unmatched-isolated'  entity doesn't, no neighbor does either             → dim
//   null                  no filter active                                    → normal
//
// "Participates" = entity has an IP/VIP/interface that resolves into the
// soloed subnet. Pure transit hops (L2 switches the ribbon glides through
// without terminating IP) do NOT count as participants and dim out — the
// routing layer is an L3 view, and "trägt den Stream" is not the same as
// "ist Teil des Netzes".
function effectiveSubnetSolo(s) {
  const filter = (s.view?.subnetFilter || []).map(String);
  const hover = s._subnetHover != null ? String(s._subnetHover) : null;
  if (hover && !filter.includes(hover)) return [...filter, hover];
  return filter;
}

function subnetSoloCtx(s) {
  const filter = effectiveSubnetSolo(s);
  if (!filter.length) return null;
  if (s._subnetSoloCtx && s._subnetSoloCtx.filterKey === filter.join('|')) return s._subnetSoloCtx;
  const filterSet = new Set(filter);
  // Direct membership: anything whose own IP/interface/VIP lands in a soloed
  // subnet. carrier holds entity ids (devices + stacks).
  const carrier = new Set();
  s.devices.forEach((d) => {
    if (isReference(d)) return;
    if (deviceSubnets(s, d).some((sn) => filterSet.has(String(sn.id)))) carrier.add(d.id);
  });
  (s.stacks || []).forEach((st) => {
    if (stackSubnets(s, st).some((sn) => filterSet.has(String(sn.id)))) carrier.add(st.id);
  });
  // stackOfMember used downstream by linkRoutingSoloDim + state resolvers
  // to fold member matches up to their stack and vice versa.
  const stackOfMember = new Map();
  (s.stacks || []).forEach((st) => (st.members || []).forEach((mid) => stackOfMember.set(mid, st.id)));
  // Adjacency over the link graph (devices + stack-as-virtual-node), used to
  // separate "unmatched-isolated" from "unmatched-adjacent". Mirrors the
  // adjacency built in computeL3Paths but indexed by id only.
  const neighbors = new Map();
  const ensure = (id) => { if (!neighbors.has(id)) neighbors.set(id, new Set()); };
  s.devices.forEach((d) => ensure(d.id));
  (s.stacks || []).forEach((st) => ensure(st.id));
  (s.links || []).forEach((l) => {
    if (!l.from || !l.to || l.from === l.to) return;
    ensure(l.from); ensure(l.to);
    neighbors.get(l.from).add(l.to);
    neighbors.get(l.to).add(l.from);
  });
  (s.stacks || []).forEach((st) => {
    (st.members || []).forEach((mid) => {
      ensure(st.id); ensure(mid);
      neighbors.get(st.id).add(mid);
      neighbors.get(mid).add(st.id);
    });
  });
  const ctx = { filter, filterKey: filter.join('|'), carrier, neighbors, stackOfMember };
  s._subnetSoloCtx = ctx;
  return ctx;
}

function subnetSoloStateForDevice(s, dev) {
  const ctx = subnetSoloCtx(s);
  if (!ctx) return null;
  if (ctx.carrier.has(dev.id)) return 'matched';
  // A member of a matched stack inherits the stack's state — otherwise an
  // expanded VIP'd stack would light up while its switch members read as
  // dim, contradicting the envelope around them.
  const owningStack = ctx.stackOfMember.get(dev.id);
  if (owningStack && ctx.carrier.has(owningStack)) return 'matched';
  const adj = ctx.neighbors.get(dev.id);
  if (adj) for (const nid of adj) if (ctx.carrier.has(nid)) return 'unmatched-adjacent';
  return 'unmatched-isolated';
}

function subnetSoloStateForStack(s, stack) {
  const ctx = subnetSoloCtx(s);
  if (!ctx) return null;
  if (ctx.carrier.has(stack.id)) return 'matched';
  // Member-level match folds back up onto the stack so the envelope and
  // collapsed icon stay in sync with their members.
  if ((stack.members || []).some((mid) => ctx.carrier.has(mid))) return 'matched';
  for (const mid of (stack.members || [])) {
    const adj = ctx.neighbors.get(mid);
    if (!adj) continue;
    for (const nid of adj) if (ctx.carrier.has(nid)) return 'unmatched-adjacent';
  }
  return 'unmatched-isolated';
}

// Force-collapse stacks that don't participate in the soloed subnet so their
// members stop cluttering the view — the L3 read becomes "only the boxes
// that are part of this network are open". Driven off the PERSISTED filter
// (s.view.subnetFilter) only, NOT the hover-inclusive effective filter, so
// scrubbing through legend rows previews dimming without thrashing every
// stack open and shut. Restores cleanly when the filter clears, when the
// user un-solos the last subnet, or when leaving the routing layer — by
// design the override lives in a transient set, not in persisted st.expanded,
// so manual expand-state survives the cycle untouched.
function applySubnetSoloStackCollapse(s) {
  if (!s._soloCollapsedIds) s._soloCollapsedIds = new Set();
  if (s.activeLayer !== 'routing') {
    s._soloCollapsedIds.clear();
    s._soloCollapseFilterKey = null;
    return;
  }
  const filter = (s.view?.subnetFilter || []).map(String);
  const key = filter.join('|');
  // Only rebuild on actual filter change. Otherwise this fires on every
  // render (drag, layer toggle, manual stack expand, etc) and would re-add
  // a stack the user just manually expanded — fighting their click.
  if (s._soloCollapseFilterKey === key) return;
  s._soloCollapseFilterKey = key;
  if (!filter.length) { s._soloCollapsedIds.clear(); return; }
  const filterSet = new Set(filter);
  const stackParticipates = (st) => {
    if (stackSubnets(s, st).some((sn) => filterSet.has(String(sn.id)))) return true;
    return (st.members || []).some((mid) => {
      const m = s.devices.find((d) => d.id === mid);
      if (!m) return false;
      return deviceSubnets(s, m).some((sn) => filterSet.has(String(sn.id)));
    });
  };
  const next = new Set();
  (s.stacks || []).forEach((st) => {
    if (!st || (st.members || []).length < 2) return;
    if (!st.expanded) return; // already collapsed by user — no override needed
    if (stackParticipates(st)) return;
    next.add(st.id);
  });
  s._soloCollapsedIds = next;
}

// Link-level routing-solo: matched when both endpoints participate in any
// soloed subnet, dim otherwise. Stacks fold to their member ids transparently
// — link.from/to already carry device ids so we resolve through the stack
// relationship for collapsed-stack endpoints.
function linkRoutingSoloDim(s, link) {
  const ctx = subnetSoloCtx(s);
  if (!ctx) return false;
  const isMatched = (id) => {
    if (!id) return false;
    if (ctx.carrier.has(id)) return true;
    const stk = ctx.stackOfMember.get(id);
    return stk ? ctx.carrier.has(stk) : false;
  };
  return !(isMatched(link.from) && isMatched(link.to));
}

function portLabel(dev, portN) {
  const p = dev?.ports.find((pp) => String(pp.n) === String(portN));
  if (!p) return '?';
  return p.name || String(p.n);
}

// Strip everything before the last digit run so a long port name like
// "eth1/1/12" collapses to just "12" on the canvas — keeps endpoint
// stencils tight and prevents adjacent labels from colliding. Falls back
// to the original string if there are no trailing digits at all.
function shortPortLabel(full) {
  if (!full) return full;
  const m = String(full).match(/(\d+)$/);
  return m ? m[1] : full;
}

// Natural compare for LAG names so "Po2" sorts between "Po1" and "Po10"
// instead of lexicographic Po1/Po10/Po2/Po5. Splits each name into runs of
// digits vs non-digits and compares run-by-run.
function naturalCompareName(a, b) {
  const ax = String(a ?? '').match(/(\d+|\D+)/g) || [];
  const bx = String(b ?? '').match(/(\d+|\D+)/g) || [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const an = /^\d+$/.test(ax[i]) ? Number(ax[i]) : null;
    const bn = /^\d+$/.test(bx[i]) ? Number(bx[i]) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
    } else {
      const c = ax[i].localeCompare(bx[i], undefined, { sensitivity: 'base' });
      if (c) return c;
    }
  }
  return ax.length - bx.length;
}

function sortLagsInStack(stack) {
  if (!stack || !Array.isArray(stack.lags)) return;
  stack.lags.sort((a, b) => naturalCompareName(a?.name, b?.name));
}

// Auto-Prefix port naming: the user types a full port name once
// (e.g. "eth1/1/1") and then for sibling ports types only the trailing
// digit ("5") — we expand it back to "eth1/1/5" using the device's
// learned prefix. Triggered on commit (change/blur), not on every
// keystroke, so editing mid-string isn't disrupted.
//   • Pure-digit input + known dev.portPrefix → expand.
//   • Anything ending in <text><digits>            → learn prefix.
// Returns the final string the input should display.
function commitAutoPrefixPortName(dev, raw) {
  let v = String(raw ?? '');
  if (/^\d+$/.test(v.trim()) && dev.portPrefix) {
    v = dev.portPrefix + v.trim();
  }
  const m = v.match(/^(.+?)(\d+)$/);
  if (m && m[1]) {
    dev.portPrefix = m[1];
  }
  return v;
}

// Sort order for the port-table display: ports with names land in
// natural-numeric order on the name; empty-name ports drop to the end
// in physical-port-number order. Returns Map<port.n, sortIndex>.
// dev.ports stays untouched — sorting is applied via CSS flex `order`
// so live focus/listeners survive a name commit without DOM rebuild.
function computePortSortOrder(ports) {
  const sorted = (ports || []).slice().sort((a, b) => {
    const aEmpty = !a?.name;
    const bEmpty = !b?.name;
    if (aEmpty && bEmpty) return (a?.n || 0) - (b?.n || 0);
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    return naturalCompareName(a.name, b.name) || (a.n - b.n);
  });
  const m = new Map();
  sorted.forEach((p, i) => m.set(p.n, i));
  return m;
}

// Returns Set<port.n> of every port whose trimmed name collides with at
// least one other port on the same device. Empty names are exempt — multiple
// unnamed ports are normal. Case-sensitive (typical network conventions).
function findDuplicatePortNs(ports) {
  const counts = new Map();
  (ports || []).forEach((p) => {
    const k = (p?.name || '').trim();
    if (!k) return;
    counts.set(k, (counts.get(k) || 0) + 1);
  });
  const dupes = new Set();
  (ports || []).forEach((p) => {
    const k = (p?.name || '').trim();
    if (k && counts.get(k) > 1) dupes.add(p.n);
  });
  return dupes;
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
  const lane = laneForLink(s, link.id);
  const excl = linkExcludeIds(s, link);
  const forced = hubMergeInfo(s, link);
  const transit = { aIsTransit: endpointIsTransit(s, a.id), bIsTransit: endpointIsTransit(s, b.id) };
  const base = orthPath(aPos, bPos, lane, s, excl, forced, transit);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link');
  g.setAttribute('data-link-id', link.id);
  if (bundleInfo?.members) g.classList.add('m002-link-bundle');

  let inner = `<path class="m002-link-hit" d="${base.d}"/>`;

  // Hub-tunnel LAG-pair representative — when this hub-leg link is the
  // chosen draw of a couple-bonded LAG-pair, render the LAG-pair visual
  // (double line + cross-zone LAG names) instead of the per-port "1 (Po1)
  // ⇄ ?" label. Other hub-leg links in the same group are absorbed in
  // render(), so this single path speaks for the whole bundle.
  const tunnelRepCount = s._hubTunnelRep?.get(link.id);
  if (tunnelRepCount) {
    const tp = hubTunnelLagPair(s, link);
    if (tp) {
      g.classList.add('m002-link-bundle');
      if (layer === 'vlan') {
        const vlans = (tp.localLag.vlans || []).map(String).filter((v) =>
          (tp.peerLag.vlans || []).map(String).includes(v)
        );
        const filter = effectiveVlanSolo(s);
        const isFiltered = filter.length > 0;
        const drawn = isFiltered ? vlans.filter((v) => filter.includes(v)) : [];
        if (isFiltered && drawn.length === 0) {
          const tunUnion = [...new Set([...(tp.localLag.vlans || []), ...(tp.peerLag.vlans || [])].map(String))];
          const asym = tunUnion.some((v) => filter.includes(v));
          g.classList.add(asym ? 'm002-link-vsolo-asym' : 'm002-link-vsolo-dim');
        }
        if (drawn.length > 0) {
          const gap = 6;
          drawn.forEach((v, i) => {
            const off = lane + (i - (drawn.length - 1) / 2) * gap;
            const p = orthPath(aPos, bPos, off, s, excl, forced, transit);
            const c = vlanColor(s, v);
            inner += `<path class="m002-link-line m002-link-stripe" d="${p.d}" style="stroke:${c};color:${c}" stroke-width="2.4"/>`;
            inner += `<text class="m002-link-label m002-link-stripe-label" x="${p.lx}" y="${p.ly - 4}" style="fill:${c};color:${c}" text-anchor="middle">${escSvg(v)}</text>`;
          });
        } else if (vlans.length === 0) {
          inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#3a3a44"/>`;
          inner += `<text class="m002-link-vlan-count" x="${base.lx}" y="${base.ly - 4}" fill="#5a5f6e" text-anchor="middle">0x</text>`;
        } else {
          inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8" stroke-width="2.4"/>`;
          if (!isFiltered) {
            inner += `<text class="m002-link-vlan-count" x="${base.lx}" y="${base.ly - 4}" fill="#9aa0a8" text-anchor="middle">${vlans.length}x</text>`;
          }
        }
        inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.4, gap: 5, lane, s, excludeIds: excl, hubInfo: forced, transit });
      } else if (layer === 'routing') {
        if (linkRoutingSoloDim(s, link)) g.classList.add('m002-link-rsolo-dim');
        inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
      } else {
        inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.8, gap: 5, lane, s, excludeIds: excl, hubInfo: forced, transit });
      }
      // Physical layer carries the LAG-name pair label; VLAN already speaks
      // through its own stripes / count badge, and routing stays unlabelled
      // like every other dim underlay.
      if (layer === 'physical') {
        const lbl = `${tp.localLag.name} ⇄ ${tp.peerLag.name}`;
        inner += `<text class="m002-link-bundle-label" x="${base.lx}" y="${base.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(lbl)}</text>`;
      }
      g.innerHTML = inner;
      g.setAttribute('data-flow-d', base.d);
      s.gLinks.appendChild(g);
      return;
    }
  }

  if (layer === 'vlan') {
    const vlans = linkVlans(s, link);
    const filter = effectiveVlanSolo(s);
    const isFiltered = filter.length > 0;
    // Trace mode: only render colored stripes for VLANs the user has soloed.
    // Without a solo filter the link stays neutral with a count badge — colored
    // parallel lines stop scaling past ~7 VLANs and lose meaning when many
    // VLANs share similar hues.
    const drawn = isFiltered ? vlans.filter((v) => filter.includes(String(v))) : [];
    if (isFiltered && drawn.length === 0) {
      const union = linkVlansUnion(s, link);
      const asym = union.some((v) => filter.includes(String(v)));
      g.classList.add(asym ? 'm002-link-vsolo-asym' : 'm002-link-vsolo-dim');
    }
    if (vlans.length === 0) {
      inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#3a3a44"/>`;
    } else if (isFiltered && drawn.length === 0) {
      // Link carries no soloed VLAN — render at normal neutral so trace mode
      // emphasises matches without hiding the rest of the topology.
      const w = bundleInfo?.members ? 2.4 : 1.4;
      inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8" stroke-width="${w}"/>`;
    } else if (drawn.length > 0) {
      const gap = 6;
      drawn.forEach((v, i) => {
        const off = lane + (i - (drawn.length - 1) / 2) * gap;
        const p = orthPath(aPos, bPos, off, s, excl, forced, transit);
        const c = vlanColor(s, v);
        const w = bundleInfo?.members ? 2.4 : 1.4;
        // Inline style on stripes — beats the .m002-selected white-stroke rule
        // so a selected, soloed link keeps its VLAN colour. `color` lets the
        // selection drop-shadow filter pick up the VLAN colour via currentColor.
        inner += `<path class="m002-link-line m002-link-stripe" d="${p.d}" style="stroke:${c};color:${c}" stroke-width="${w}"/>`;
        inner += `<text class="m002-link-label m002-link-stripe-label" x="${p.lx}" y="${p.ly - 4}" style="fill:${c};color:${c}" text-anchor="middle">${escSvg(v)}</text>`;
      });
    } else {
      const w = bundleInfo?.members ? 2.4 : 1.4;
      inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8" stroke-width="${w}"/>`;
      inner += `<text class="m002-link-vlan-count" x="${base.lx}" y="${base.ly - 4}" fill="#9aa0a8" text-anchor="middle">${vlans.length}x</text>`;
    }
    if (bundleInfo?.members) {
      const lagA = findPortLag(s, a.id, link.fromPort)?.lag;
      const lagB = findPortLag(s, b.id, link.toPort)?.lag;
      const aLbl = lagA?.name || '?';
      const bLbl = lagB?.name || '?';
      const lbl = `${aLbl} ⇄ ${bLbl} · ×${bundleInfo.members.length}`;
      inner += `<text class="m002-link-bundle-label" x="${base.lx}" y="${base.ly + 14}" fill="#e8e8ee" text-anchor="middle">${escSvg(lbl)}</text>`;
      // LAG accent — parallel double-line on top of the VLAN stripes
      inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.4, gap: 5, lane, s, excludeIds: excl, hubInfo: forced, transit });
    }
  } else if (layer === 'routing') {
    // L3 view. Every wire (regular link OR LAG-bundle rep) draws as a single
    // dim dashed underlay. The colourful streams live in the dedicated
    // m002-l3-paths layer floating above. Suppressing the LAG double-line
    // here avoids stacking it under the L3 ribbon and producing four
    // parallel highlights between two collapsed stacks.
    if (linkRoutingSoloDim(s, link)) g.classList.add('m002-link-rsolo-dim');
    inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
  } else {
    inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8"/>`;
    const lagA = findPortLag(s, a.id, link.fromPort)?.lag;
    const lagB = findPortLag(s, b.id, link.toPort)?.lag;
    const shortMode = s.prefs?.shortPortLabels !== false;
    const fmt = (lbl) => shortMode ? shortPortLabel(lbl) : lbl;
    const fromTxt = link.fromPort ? fmt(portLabel(a, link.fromPort)) + (lagA ? ` (${lagA.name})` : '') : '';
    const toTxt   = link.toPort   ? fmt(portLabel(b, link.toPort))   + (lagB ? ` (${lagB.name})` : '') : '';
    if (fromTxt || toTxt) {
      const lbl = (fromTxt || '?') + ' ⇄ ' + (toTxt || '?');
      inner += `<text class="m002-link-label" x="${base.lx}" y="${base.ly - 4}" fill="#9aa0a8" text-anchor="middle">${escSvg(lbl)}</text>`;
    }
  }
  g.innerHTML = inner;
  // Flow path is injected on-demand by applyIncidentFlow() — store the path
  // shape here so the injection has nothing to recompute. No idle <path> means
  // no Firefox SVG-pattern flicker around the cursor.
  g.setAttribute('data-flow-d', base.d);
  s.gLinks.appendChild(g);
}

function updateLinksFor(s, deviceId) {
  // Mirror render()'s absorption — every link the LAG-pair owns is skipped
  // here (and any stale DOM element removed) so partial redraws don't leak a
  // bare third line beneath the LAG double-line.
  const absorbed = computeAbsorbedLinkIds(s);
  s.links.filter((l) => l.from === deviceId || l.to === deviceId).forEach((l) => {
    if (absorbed.has(l.id)) {
      s.gLinks.querySelector(`[data-link-id="${l.id}"]`)?.remove();
      return;
    }
    redrawLink(s, l);
  });
  updateLagPairsFor(s, deviceId);
}

// Shared absorption set so render() and partial redraws agree. Absorb a link
// only when both sides of the LAG-pair are collapsed — once a stack expands,
// the user sees the actual physical port-links and the LAG itself is implicit.
function computeAbsorbedLinkIds(s) {
  const absorbed = new Set();
  // Hub-tunnel LAG-pair: collapse every (stack, JUMP, LAG) group of hub-leg
  // links into one drawn representative; the others get absorbed. The rep
  // map is stashed on `s` so drawLink knows which link to render with the
  // LAG-pair visual.
  const tunnelGroups = new Map();
  s.links.forEach((l) => {
    const tp = hubTunnelLagPair(s, l);
    if (!tp) return;
    const key = `${tp.localStack.id}|${tp.jumpDev.id}|${tp.localLag.id}`;
    if (!tunnelGroups.has(key)) tunnelGroups.set(key, []);
    tunnelGroups.get(key).push(l.id);
  });
  s._hubTunnelRep = new Map();
  tunnelGroups.forEach((ids) => {
    const [rep, ...rest] = ids;
    s._hubTunnelRep.set(rep, ids.length);
    rest.forEach((id) => absorbed.add(id));
  });
  // First pass: per-LAG-pair port absorption (the canonical case).
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      // Only count each pair once.
      const selfKey = stA.id + ':' + lag.id;
      const peerKey = peer.stack.id + ':' + peer.lag.id;
      if (selfKey > peerKey) return;
      // Expanded → no absorption: physical port-links draw as themselves.
      if (!isStackCollapsed(s, stA) || !isStackCollapsed(s, peer.stack)) return;
      const portsA = new Set(lag.ports.map((pp) => pp.deviceId + ':' + Number(pp.portN)));
      const portsB = new Set(peer.lag.ports.map((pp) => pp.deviceId + ':' + Number(pp.portN)));
      const membersA = new Set(stA.members);
      const membersB = new Set(peer.stack.members);
      s.links.forEach((l) => {
        if (l.fromPort && l.toPort) {
          const fk = l.from + ':' + Number(l.fromPort);
          const tk = l.to   + ':' + Number(l.toPort);
          if ((portsA.has(fk) && portsB.has(tk)) || (portsB.has(fk) && portsA.has(tk))) absorbed.add(l.id);
        } else {
          if ((membersA.has(l.from) && membersB.has(l.to)) || (membersB.has(l.from) && membersA.has(l.to))) absorbed.add(l.id);
        }
      });
    });
  });
  // Second pass: a paired LAG between two collapsed stacks already speaks
  // for the bundle visually. Any LEFTOVER member-member links between those
  // same two stacks (extra wires, single-sided LAGs that didn't match a
  // port set) get swallowed too — otherwise they pile up as overlapping
  // stubs underneath the proper LAG-pair line.
  const pairedStackPairs = new Set();
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      if (!isStackCollapsed(s, stA) || !isStackCollapsed(s, peer.stack)) return;
      pairedStackPairs.add([stA.id, peer.stack.id].sort().join('::'));
    });
  });
  if (pairedStackPairs.size) {
    const memberToStack = new Map();
    s.stacks.forEach((st) => (st.members || []).forEach((mid) => memberToStack.set(mid, st.id)));
    s.links.forEach((l) => {
      if (absorbed.has(l.id)) return;
      const aStack = memberToStack.get(l.from);
      const bStack = memberToStack.get(l.to);
      if (!aStack || !bStack || aStack === bStack) return;
      const key = [aStack, bStack].sort().join('::');
      if (pairedStackPairs.has(key)) absorbed.add(l.id);
    });
  }
  return absorbed;
}
function redrawLink(s, link) {
  const g = s.gLinks.querySelector(`[data-link-id="${link.id}"]`);
  if (g) g.remove();
  // If both stacks of this link's LAG-pair are collapsed, the link is absorbed
  // into the LAG visual — don't redraw the bare line.
  const absorbed = computeAbsorbedLinkIds(s);
  if (absorbed.has(link.id)) return;
  invalidateEdgeSlots(s);
  drawLink(s, link);
  // Always reapply selection / incident-flow state — the new <g> has none of
  // those classes yet, and applyIncidentFlow() needs to re-flag this redrawn
  // link if it belongs to the active selection.
  markSelected(s);
}

// Wipe and redraw every LAG-pair line on the canvas. Used by vlansChanged()
// so the VLAN count / stripe pattern on a paired LAG updates immediately —
// the link-keyed partial redraw can't reach these (different DOM key).
function redrawAllLagPairs(s) {
  if (!s.gLinks) return;
  s.gLinks.querySelectorAll('[data-laglink-id]').forEach((el) => el.remove());
  const inZone = (st) => !s.activeZone || !st.zone || st.zone === s.activeZone;
  const seen = new Set();
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      const key = [stA.id + ':' + lag.id, peer.stack.id + ':' + peer.lag.id].sort().join('::');
      if (seen.has(key)) return;
      seen.add(key);
      if (!isStackCollapsed(s, stA) || !isStackCollapsed(s, peer.stack)) return;
      if (!inZone(stA) || !inZone(peer.stack)) return;
      // Cross-zone LAG-pair (bonded via a JUMP couple) — the line would jump
      // out into the peer zone's coords. The LAG visualization belongs on the
      // bundled hub-leg link in this zone instead.
      if ((stA.zone || null) !== (peer.stack.zone || null)) return;
      drawLagLink(s, { stackA: stA, lagA: lag, stackB: peer.stack, lagB: peer.lag });
    });
  });
  markSelected(s);
}

// Redraw any LAG-pair line that this device participates in. Only drawn when
// both sides are collapsed; expanded-mode renders just port-links so we make
// sure any stale lag-pair element is removed.
function updateLagPairsFor(s, deviceId) {
  const stack = findStack(s, deviceId);
  if (!stack) return;
  const seen = new Set();
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      // Only handle pairs that involve the dragged device's stack.
      if (stA.id !== stack.id && peer.stack.id !== stack.id) return;
      const key = [stA.id + ':' + lag.id, peer.stack.id + ':' + peer.lag.id].sort().join('::');
      if (seen.has(key)) return;
      seen.add(key);
      s.gLinks.querySelector(`[data-laglink-id="${stA.id}|${lag.id}"]`)?.remove();
      s.gLinks.querySelector(`[data-laglink-id="${peer.stack.id}|${peer.lag.id}"]`)?.remove();
      // Cross-zone LAG-pair (couple-bonded) — see redrawAllLagPairs for the
      // same gate. The bundled hub-leg link carries the LAG visual in zone.
      if ((stA.zone || null) !== (peer.stack.zone || null)) return;
      if (isStackCollapsed(s, stA) && isStackCollapsed(s, peer.stack)) {
        drawLagLink(s, { stackA: stA, lagA: lag, stackB: peer.stack, lagB: peer.lag });
      }
    });
  });
  // Always reapply — same reason as redrawLink: incident-flow needs the
  // freshly drawn laglink groups re-flagged.
  markSelected(s);
}

// =============================================================================
// Selection + inspector
// =============================================================================
function select(s, kind, id, options = {}) {
  // Clear any port-focus on selection: clicking the device on the canvas
  // (or any other device / link / stack) should return the inspector to
  // the device-level form. openPortModal() bypasses select() and sets
  // s.portModalOpen + s.selected itself, so this doesn't break the port
  // table click path.
  if (s.portModalOpen) s.portModalOpen = null;
  s.selected = { kind, id };
  markSelected(s);
  openInspector(s);
  if (s.prefs?.autoRecenter && !options.skipRecenter) recenterOnSelection(s, kind, id);
}

// Pan the camera so a freshly-selected device or stack lands in the middle
// of the canvas. Skipped for non-positional selections (link / lag / agg /
// prefs). Reuses the zone-switch animation helper for a smooth glide.
function recenterOnSelection(s, kind, id) {
  let world = null;
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === id);
    // JUMPs are navigation portals — auto-recentering on them fights the
    // intent (the zone-switch animation already moves the camera).
    if (dev && !isReference(dev)) world = { x: dev.x, y: dev.y };
  } else if (kind === 'stack') {
    const st = s.stacks.find((x) => x.id === id);
    if (st) world = { x: st.x, y: st.y };
  }
  if (!world) return;
  const rect = s.svg.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const z = s.view.zoom;
  const target = { x: cx - world.x * z, y: cy - world.y * z, zoom: z };
  const from = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  if (Math.abs(target.x - from.x) < 1 && Math.abs(target.y - from.y) < 1) return;
  animateZoneView(s, from, target, 520);
}

function deselect(s) {
  s.selected = null;
  s.portModalOpen = null;
  s.host.querySelectorAll('.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
  clearMultiSelection(s);
  // Strip the incident-flow pulse — it was anchored to the prior selection
  // and would otherwise keep animating after the user clicked into empty
  // canvas. applyIncidentFlow() with no selection set is a no-op apart
  // from the cleanup pass at its top.
  applyIncidentFlow(s);
  showInspectorEmpty(s);
}

function markSelected(s) {
  s.host.querySelectorAll('.m002-selected').forEach((el) => el.classList.remove('m002-selected'));
  refreshMultiSelectClasses(s);
  applyIncidentFlow(s);
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

// Animated traffic pulse on every link incident to the current selection.
// Direction (`data-flow-from`) is set so the pulse always travels *away* from
// the selected node — picked up by CSS via animation-direction. Cleared and
// reapplied on every selection change / partial redraw via markSelected().
function applyIncidentFlow(s) {
  s.gLinks.querySelectorAll('.m002-link-incident').forEach((el) => {
    el.classList.remove('m002-link-incident');
    el.removeAttribute('data-flow-from');
    el.querySelectorAll(':scope > .m002-link-flow').forEach((p) => p.remove());
  });
  if (!s.selected) return;

  const flag = (g, side) => {
    if (!g) return;
    g.classList.add('m002-link-incident');
    if (side) g.setAttribute('data-flow-from', side);
    // Inject the flow path lazily — only links that are incident to the active
    // selection ever carry one. data-flow-d was stamped by drawLink/drawLagLink.
    if (!g.querySelector(':scope > .m002-link-flow')) {
      const d = g.getAttribute('data-flow-d');
      if (d) {
        const flow = document.createElementNS(SVG_NS, 'path');
        flow.setAttribute('class', 'm002-link-flow');
        flow.setAttribute('d', d);
        g.appendChild(flow);
      }
    }
  };

  const sel = s.selected;
  if (sel.kind === 'link') {
    flag(s.gLinks.querySelector(`[data-link-id="${sel.id}"]`), null);
    return;
  }
  if (sel.kind === 'lag') {
    const [stackId, lagId] = String(sel.id).split('|');
    const own = s.gLinks.querySelector(`[data-laglink-id="${stackId}|${lagId}"]`);
    flag(own, 'from');
    // Only one side of the pair owns the rendered laglink — also flag the peer
    // selector for completeness in case rendering picked the other end.
    const stack = s.stacks.find((st) => st.id === stackId);
    const lag = stack?.lags?.find((l) => l.id === lagId);
    if (lag?.counterpart?.lagId) {
      const peer = s.gLinks.querySelector(`[data-laglink-id="${lag.counterpart.stackId}|${lag.counterpart.lagId}"]`);
      flag(peer, 'from');
    }
    return;
  }

  // Resolve which device-ids belong to the selection (a stack expands to its members).
  const memberIds = new Set();
  if (sel.kind === 'device') {
    memberIds.add(sel.id);
  } else if (sel.kind === 'stack') {
    const st = findStackById(s, sel.id);
    if (st) st.members.forEach((m) => memberIds.add(m));
    memberIds.add(sel.id); // a collapsed stack is its own endpoint
  }
  if (!memberIds.size) return;

  s.gLinks.querySelectorAll('[data-link-id]').forEach((g) => {
    const link = s.links.find((l) => l.id === g.getAttribute('data-link-id'));
    if (!link) return;
    if (memberIds.has(link.from)) flag(g, 'from');
    else if (memberIds.has(link.to)) flag(g, 'to');
  });
  s.gLinks.querySelectorAll('[data-laglink-id]').forEach((g) => {
    const [stackId, lagId] = g.getAttribute('data-laglink-id').split('|');
    const stack = s.stacks.find((st) => st.id === stackId);
    if (!stack) return;
    const lag = stack.lags?.find((l) => l.id === lagId);
    const peerInfo = lag?.counterpart?.lagId
      ? findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId)
      : null;
    const onSelf = stack.members.some((m) => memberIds.has(m)) || memberIds.has(stack.id);
    const onPeer = peerInfo?.stack?.members?.some((m) => memberIds.has(m)) || (peerInfo?.stack && memberIds.has(peerInfo.stack.id));
    if (onSelf) flag(g, 'from');
    else if (onPeer) flag(g, 'to');
  });
}

function renderInspectorVlanPickers(s) {
  s.inspector?.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
}

// =============================================================================
// L3 inspector — interfaces + routes for router/firewall
// =============================================================================
function renderL3SectionsHTML(s, dev) {
  if (!isL3Type(dev.type)) return '';
  const open = s.inspectorL3Open !== false; // default open
  const ifaces = Array.isArray(dev.interfaces) ? dev.interfaces : [];
  const routes = Array.isArray(dev.routes) ? dev.routes : [];
  // Prefix dropdown 0..32 — default 24 lives in the data, so just selection.
  // Routing-relevant range is realistically /8..../32, but we expose the full
  // legal range; users typing in lab scenarios sometimes want /0 (default).
  const prefixOptions = (selected) => {
    const sel = Number.isFinite(Number(selected)) ? Number(selected) : 24;
    let html = '';
    for (let i = 32; i >= 0; i--) {
      html += `<option value="${i}" ${i === sel ? 'selected' : ''}>/${i}</option>`;
    }
    return html;
  };
  const ifaceOptions = (selectedId) => {
    const opts = ['<option value="">—</option>'];
    ifaces.forEach((iface) => {
      const sel = String(selectedId || '') === String(iface.id) ? 'selected' : '';
      const lbl = iface.name + (iface.ip ? ` · ${iface.ip}` : '');
      opts.push(`<option value="${escAttr(iface.id)}" ${sel}>${escSvg(lbl)}</option>`);
    });
    return opts.join('');
  };
  const ifaceHeader = ifaces.length
    ? `<div class="m002-iface-head">
         <span></span>
         <span>NAME</span>
         <span>IP</span>
         <span>PREFIX</span>
         <span></span>
       </div>`
    : '';
  const ifaceRows = ifaces.length
    ? ifaces.map((iface) => {
        const sn = ifaceSubnet(s, iface);
        const c = sn ? subnetColor(s, sn.id) : '#3a3a44';
        return `<div class="m002-iface-row" data-iface-id="${escAttr(iface.id)}" style="--sc:${c}">
          <span class="m002-iface-dot" title="${sn ? escAttr('subnet ' + sn.cidr) : 'no subnet'}"></span>
          <input class="m002-iface-name" data-if-f="name" value="${escAttr(iface.name)}" placeholder="if0"/>
          <input class="m002-iface-ip" data-if-f="ip" value="${escAttr(iface.ip)}" placeholder="10.0.0.10"/>
          <select class="m002-iface-prefix" data-if-f="prefix" title="prefix length">${prefixOptions(iface.prefix)}</select>
          <button type="button" class="m002-iface-rm" data-if-rm title="Remove interface">×</button>
        </div>`;
      }).join('')
    : `<span class="m002-vlan-empty">no interfaces — add one to terminate IP traffic on this device</span>`;
  return `
    <details class="m002-insp-l3"${open ? ' open' : ''}>
      <summary>// L3</summary>
      <div class="m002-l3-block">
        <div class="m002-l3-head">
          <span>INTERFACES (${ifaces.length})</span>
          <button type="button" class="m002-action small" data-if-add>+ ADD</button>
        </div>
        <div class="m002-iface-list">${ifaceHeader}${ifaceRows}</div>
      </div>
      ${renderRoutesBlockHTML(s, dev)}
    </details>
  `;
}

// Routes table block — shared between routers/firewalls (where it sits next
// to the interfaces table), non-L3 devices (single implicit interface), and
// stacks (with the VIP list as the "interface" surface). The OUT IF column
// only renders when the entity has multiple interfaces to pick from.
function renderRoutesBlockHTML(s, host) {
  const routes = Array.isArray(host?.routes) ? host.routes : [];
  const ifaces = Array.isArray(host?.interfaces) ? host.interfaces
                : Array.isArray(host?.virtualInterfaces) ? host.virtualInterfaces
                : [];
  const hasIfaceCol = ifaces.length > 0;
  const ifaceOptions = (selectedId) => {
    const opts = ['<option value="">—</option>'];
    ifaces.forEach((iface) => {
      const sel = String(selectedId || '') === String(iface.id) ? 'selected' : '';
      const lbl = (iface.name || '') + (iface.ip ? ` · ${iface.ip}` : '');
      opts.push(`<option value="${escAttr(iface.id)}" ${sel}>${escSvg(lbl)}</option>`);
    });
    return opts.join('');
  };
  const head = routes.length
    ? `<div class="m002-route-head ${hasIfaceCol ? '' : 'm002-route-head--no-iface'}">
         <span>DESTINATION</span>
         <span>NEXT-HOP</span>
         ${hasIfaceCol ? '<span>OUT IF</span>' : ''}
         <span>METRIC</span>
         <span></span>
       </div>`
    : '';
  const rows = routes.length
    ? routes.map((r) => {
        const isDefault = cidrNormalize(r.dst) === '0.0.0.0/0';
        return `<div class="m002-route-row ${isDefault ? 'is-default' : ''} ${hasIfaceCol ? '' : 'm002-route-row--no-iface'}" data-route-id="${escAttr(r.id)}">
          <input class="m002-route-dst" data-rt-f="dst" value="${escAttr(r.dst)}" placeholder="0.0.0.0/0"/>
          <input class="m002-route-nexthop" data-rt-f="nextHop" value="${escAttr(r.nextHop)}" placeholder="next-hop IP"/>
          ${hasIfaceCol ? `<select class="m002-route-iface" data-rt-f="interfaceId" title="outgoing interface">${ifaceOptions(r.interfaceId)}</select>` : ''}
          <input class="m002-route-metric" data-rt-f="metric" value="${escAttr(r.metric ?? '')}" placeholder="metric" inputmode="numeric"/>
          <button type="button" class="m002-route-rm" data-rt-rm title="Remove route">×</button>
        </div>`;
      }).join('')
    : `<span class="m002-vlan-empty">no routes</span>`;
  const hasDefault = routes.some((r) => cidrNormalize(r.dst) === '0.0.0.0/0');
  return `
    <div class="m002-l3-block">
      <div class="m002-l3-head">
        <span>ROUTES (${routes.length})</span>
        <span class="m002-l3-head-actions">
          ${hasDefault ? '' : '<button type="button" class="m002-action small" data-rt-add-default>+ DEFAULT</button>'}
          <button type="button" class="m002-action small" data-rt-add>+ ADD</button>
        </span>
      </div>
      <div class="m002-route-list">${head}${rows}</div>
    </div>
  `;
}

function bindL3Sections(s, dev, body) {
  if (!isL3Type(dev.type)) return;
  const det = body.querySelector('.m002-insp-l3');
  if (!det) return;
  det.addEventListener('toggle', (e) => { s.inspectorL3Open = e.target.open; });

  const refreshSelfAndCanvas = () => {
    schedSave(s);
    redrawDevice(s, dev);
    if (s.activeLayer === 'routing') {
      s.links.filter((l) => l.from === dev.id || l.to === dev.id).forEach((l) => redrawLink(s, l));
    }
  };

  // Interface rows
  body.querySelectorAll('.m002-iface-row').forEach((row) => {
    const ifaceId = row.dataset.ifaceId;
    const iface = (dev.interfaces || []).find((x) => x.id === ifaceId);
    if (!iface) return;
    row.querySelectorAll('[data-if-f]').forEach((el) => {
      const isSelect = el.tagName === 'SELECT';
      // Commit a field edit. Two side-effects beyond the raw assignment:
      //   - on ip / prefix change, auto-fill the gateway if the user hasn't
      //     typed one (live "Vorgetippt = NetzIP + 1") and auto-register
      //     the derived subnet in the legend so it shows up immediately
      //   - rerender for selects so dependent UI (subnet legend, dot colour,
      //     gateway placeholder) refreshes; inputs keep typing focus instead
      // `committed` flips the auto-default-route side-effect on. While the
      // user is still typing (`input` event), we only assign + refresh —
      // dropping a default route + re-opening the inspector mid-keystroke
      // would yank focus out of the input the moment "10.0.0.4" appeared
      // valid, before the user could finish typing "10.0.0.40".
      const apply = (rerender, committed = false) => {
        const f = el.dataset.ifF;
        const val = f === 'ip' ? normalizeIpInput(el.value) : el.value;
        if (f === 'ip' && rejectIpEdit(s, el, ipSlotKey('iface', dev.id, iface.id), val)) return;
        if (f === 'prefix') {
          iface.prefix = Math.max(0, Math.min(32, Number(val)));
        } else {
          iface[f] = val;
        }
        if (f === 'ip' || f === 'prefix') {
          // Auto-add the derived network to the subnet registry (idempotent).
          const cidr = ifaceCidr(iface);
          const p = parseCidr(cidr);
          if (p && p.prefix < 31) {
            subnetRegistryAdd(s, `${p.network}/${p.prefix}`, '');
          }
          subnetsChanged(s);
          if (committed) {
            // First IP on a router/firewall: drop in a default route so the
            // gateway is visible and editable in the routes table without
            // the user having to add it manually. defaultGatewayFor() picks
            // .1-of-the-net (suppressed when the iface IS .1).
            const added = autoCreateDefaultRoute(dev.routes, iface.ip, iface.prefix, iface.id);
            if (added) { refreshSelfAndCanvas(); openInspector(s); return; }
          }
        }
        refreshSelfAndCanvas();
        if (rerender) openInspector(s);
      };
      if (isSelect) {
        // Selects only fire `change` (commit-equivalent) — pass committed=true.
        el.addEventListener('change', () => apply(true, true));
      } else {
        el.addEventListener('input', () => apply(false, false));
        el.addEventListener('change', () => {
          if (el.dataset.ifF === 'ip') {
            const fixed = normalizeIpInput(el.value);
            if (fixed !== el.value) el.value = fixed;
            apply(false, true);
            return;
          }
          if (el.dataset.ifF === 'name') openInspector(s);
        });
      }
    });
    row.querySelector('[data-if-rm]')?.addEventListener('click', () => {
      snapshot(s);
      dev.interfaces = (dev.interfaces || []).filter((x) => x.id !== ifaceId);
      // Drop route references to this interface as well.
      dev.routes = (dev.routes || []).map((r) => r.interfaceId === ifaceId ? { ...r, interfaceId: null } : r);
      refreshSelfAndCanvas();
      openInspector(s);
    });
  });

  body.querySelector('[data-if-add]')?.addEventListener('click', () => {
    snapshot(s);
    if (!Array.isArray(dev.interfaces)) dev.interfaces = [];
    const idx = dev.interfaces.length;
    dev.interfaces.push({ id: 'if_' + rid(), name: `if${idx}`, ip: '', prefix: 24 });
    refreshSelfAndCanvas();
    openInspector(s);
  });

  bindRoutesSection(s, dev, body, refreshSelfAndCanvas);
}

// Wire the routes table on any host (device or stack). Refreshes the canvas
// + redraws L3 ribbons via the supplied refreshFn so vote-based DGW visuals
// update as the user edits next-hops.
function bindRoutesSection(s, host, body, refreshFn) {
  const refresh = () => {
    schedSave(s);
    if (typeof refreshFn === 'function') refreshFn();
    if (s.activeLayer === 'routing') drawL3Paths(s);
  };
  body.querySelectorAll('.m002-route-row').forEach((row) => {
    const rid_ = row.dataset.routeId;
    const route = (host.routes || []).find((x) => x.id === rid_);
    if (!route) return;
    row.querySelectorAll('[data-rt-f]').forEach((el) => {
      const isSelect = el.tagName === 'SELECT';
      const apply = (rerender) => {
        const f = el.dataset.rtF;
        if (f === 'metric') {
          const n = el.value === '' ? null : Number(el.value);
          route.metric = (Number.isFinite(n) ? n : null);
        } else if (f === 'interfaceId') {
          route.interfaceId = el.value || null;
        } else if (f === 'dst' || f === 'nextHop') {
          route[f] = normalizeIpInput(el.value);
        } else {
          route[f] = el.value;
        }
        refresh();
        if (rerender) openInspector(s);
      };
      if (isSelect) el.addEventListener('change', () => apply(false));
      else {
        el.addEventListener('input', () => apply(false));
        el.addEventListener('change', () => {
          if (el.dataset.rtF === 'dst' || el.dataset.rtF === 'nextHop') {
            const fixed = normalizeIpInput(el.value);
            if (fixed !== el.value) { el.value = fixed; apply(false); }
            // Editing the destination might flip the route between default
            // and not-default — re-render so the +DEFAULT button toggles.
            openInspector(s);
          }
        });
      }
    });
    row.querySelector('[data-rt-rm]')?.addEventListener('click', () => {
      snapshot(s);
      host.routes = (host.routes || []).filter((x) => x.id !== rid_);
      refresh();
      openInspector(s);
    });
  });
  body.querySelector('[data-rt-add]')?.addEventListener('click', () => {
    snapshot(s);
    if (!Array.isArray(host.routes)) host.routes = [];
    host.routes.push({ id: 'rt_' + rid(), dst: '', nextHop: '', interfaceId: null, metric: 1 });
    refresh();
    openInspector(s);
  });
  body.querySelector('[data-rt-add-default]')?.addEventListener('click', () => {
    snapshot(s);
    if (!Array.isArray(host.routes)) host.routes = [];
    host.routes.push({ id: 'rt_' + rid(), dst: '0.0.0.0/0', nextHop: '', interfaceId: null, metric: 1 });
    refresh();
    openInspector(s);
  });
}

// Wire the VIP rows on the stack inspector. Mirrors bindL3Sections but for
// stack.virtualInterfaces. Live gateway suggestion + auto-discover the
// derived subnet so the routing layer reflects the change immediately.
function bindStackVipSection(s, stack, body) {
  const refresh = () => {
    schedSave(s);
    if (s.activeLayer === 'routing') drawL3Paths(s);
    // Stack icon may have just become L3 (or stopped being L3) — repaint.
    if (isStackCollapsed(s, stack)) {
      const old = s.gDevices.querySelector(`[data-stack-id="${stack.id}"]`);
      old?.remove();
      drawCollapsedStack(s, stack);
      markSelected(s);
    }
  };

  body.querySelectorAll('[data-vif-id]').forEach((row) => {
    const vifId = row.dataset.vifId;
    const vif = (stack.virtualInterfaces || []).find((x) => x.id === vifId);
    if (!vif) return;
    row.querySelectorAll('[data-vif-f]').forEach((el) => {
      const isSelect = el.tagName === 'SELECT';
      // `committed` flips the auto-default-route side-effect on. Live-typing
      // skips it so the inspector doesn't rebuild + steal focus mid-keystroke
      // when "10.0.0.4" momentarily looks like a complete IP.
      const apply = (rerender, committed = false) => {
        const f = el.dataset.vifF;
        const val = f === 'ip' ? normalizeIpInput(el.value) : el.value;
        if (f === 'ip' && rejectIpEdit(s, el, ipSlotKey('vif', stack.id, vif.id), val)) return;
        if (f === 'prefix') {
          vif.prefix = Math.max(0, Math.min(32, Number(val)));
        } else {
          vif[f] = val;
        }
        let routeAdded = false;
        if (f === 'ip' || f === 'prefix') {
          const cidr = vif.ip ? `${vif.ip}/${vif.prefix != null ? vif.prefix : 24}` : null;
          const p = cidr ? parseCidr(cidr) : null;
          if (p && p.prefix < 31) subnetRegistryAdd(s, `${p.network}/${p.prefix}`, '');
          if (!Array.isArray(stack.routes)) stack.routes = [];
          if (committed) routeAdded = autoCreateDefaultRoute(stack.routes, vif.ip, vif.prefix, vif.id);
          subnetsChanged(s);
        }
        refresh();
        if (rerender || routeAdded) openInspector(s);
      };
      if (isSelect) el.addEventListener('change', () => apply(true, true));
      else {
        el.addEventListener('input', () => apply(false, false));
        el.addEventListener('change', () => {
          if (el.dataset.vifF === 'ip') {
            const fixed = normalizeIpInput(el.value);
            if (fixed !== el.value) el.value = fixed;
            apply(false, true);
            return;
          }
          if (el.dataset.vifF === 'name') openInspector(s);
        });
      }
    });
    row.querySelector('[data-vif-rm]')?.addEventListener('click', () => {
      snapshot(s);
      stack.virtualInterfaces = (stack.virtualInterfaces || []).filter((x) => x.id !== vifId);
      subnetsChanged(s);
      refresh();
      openInspector(s);
    });
  });

  body.querySelector('[data-vif-add]')?.addEventListener('click', () => {
    snapshot(s);
    if (!Array.isArray(stack.virtualInterfaces)) stack.virtualInterfaces = [];
    const idx = stack.virtualInterfaces.length;
    stack.virtualInterfaces.push({ id: 'vif_' + rid(), name: `vip${idx}`, ip: '', prefix: 24 });
    refresh();
    openInspector(s);
  });

  // Stack also owns a routes table — wire its row events.
  bindRoutesSection(s, stack, body, () => {
    if (isStackCollapsed(s, stack)) {
      const old = s.gDevices.querySelector(`[data-stack-id="${stack.id}"]`);
      old?.remove();
      drawCollapsedStack(s, stack);
      markSelected(s);
    }
  });
}

// Aggregate inspector — opens when the user clicks the dim "×N · click to
// LAG" summary line between two collapsed stacks (or stack + device). Lists
// the constituent links and lets the user create a LAG (or LAG-pair when
// both sides are stacks) covering them in one shot.
function renderAggInspector(s, body, idEl) {
  const key = s.selected.id;
  const aggregations = computeStackPairAggregations(s, computeAbsorbedLinkIds(s));
  const agg = aggregations.get(key);
  if (!agg) { deselect(s); return; }

  const stkA = (s.stacks || []).find((st) => st.id === agg.aSide);
  const stkB = (s.stacks || []).find((st) => st.id === agg.bSide);
  const sideName = (id, stk) => stk ? stk.name : (s.devices.find((d) => d.id === id)?.name || id);

  // Resolve which port lives on which side per constituent link. The link's
  // .from might align with either aSide or bSide depending on creation order.
  const linkRows = agg.linkIds.map((lid) => {
    const l = s.links.find((x) => x.id === lid);
    if (!l) return null;
    const fromStack = findStack(s, l.from);
    const fromMatchesA = (fromStack && fromStack.id === agg.aSide) || l.from === agg.aSide;
    const aDevId = fromMatchesA ? l.from : l.to;
    const bDevId = fromMatchesA ? l.to : l.from;
    const aPort = fromMatchesA ? l.fromPort : l.toPort;
    const bPort = fromMatchesA ? l.toPort : l.fromPort;
    const aDev = s.devices.find((d) => d.id === aDevId);
    const bDev = s.devices.find((d) => d.id === bDevId);
    return { l, aDev, bDev, aPort, bPort };
  }).filter(Boolean);

  idEl.textContent = `// LAG · ×${agg.linkIds.length}`;

  const lagOptions = (stack) => {
    if (!stack) return '';
    const opts = ['<option value="__new">+ NEW LAG</option>'];
    (stack.lags || []).forEach((lag) => {
      opts.push(`<option value="${escAttr(lag.id)}">${escSvg(lag.name)}</option>`);
    });
    return opts.join('');
  };

  const sideBlock = (label, side, stack) => {
    if (!stack) {
      return `<div class="m002-l3-block">
        <div class="m002-l3-head"><span>${label}</span></div>
        <div class="m002-vlan-empty">${escSvg(sideName(side, null))} is not a stack — LAG will only be created on the other side.</div>
      </div>`;
    }
    const defaultName = `Po${(stack.lags || []).length + 1}`;
    return `<div class="m002-l3-block">
      <div class="m002-l3-head">
        <span>${label} · ${escSvg(stack.name)}</span>
      </div>
      <div class="m002-agg-side">
        <select class="m002-agg-lagpick" data-agg-side="${side}" data-agg-f="lagId">${lagOptions(stack)}</select>
        <input class="m002-agg-lagname" data-agg-side="${side}" data-agg-f="name" value="${escAttr(defaultName)}" placeholder="LAG name (e.g. Po1)"/>
      </div>
    </div>`;
  };

  const linksTable = `
    <div class="m002-l3-block">
      <div class="m002-l3-head"><span>LINKS (×${linkRows.length})</span></div>
      <div class="m002-agg-links">
        ${linkRows.map((r) => `<div class="m002-agg-link-row">
          <span class="m002-agg-port">${escSvg((r.aDev?.name || '?') + (r.aPort ? ` · p${r.aPort}` : ''))}</span>
          <span class="m002-agg-arrow">⇄</span>
          <span class="m002-agg-port">${escSvg((r.bDev?.name || '?') + (r.bPort ? ` · p${r.bPort}` : ''))}</span>
        </div>`).join('')}
      </div>
    </div>
  `;

  body.innerHTML = `
    <p class="m002-link-hint">×${agg.linkIds.length} link${agg.linkIds.length === 1 ? '' : 's'} between <b>${escSvg(sideName(agg.aSide, stkA))}</b> and <b>${escSvg(sideName(agg.bSide, stkB))}</b>.</p>
    ${sideBlock('SIDE A', agg.aSide, stkA)}
    ${sideBlock('SIDE B', agg.bSide, stkB)}
    ${linksTable}
    <button type="button" class="m002-action" data-agg-create>CREATE LAG${(stkA && stkB) ? '-PAIR' : ''}</button>
  `;

  // Toggle name input visibility when picking existing vs new
  body.querySelectorAll('[data-agg-side]').forEach((el) => {
    el.addEventListener('input', () => syncAggSide(body));
    el.addEventListener('change', () => syncAggSide(body));
  });
  syncAggSide(body);

  body.querySelector('[data-agg-create]')?.addEventListener('click', () => {
    snapshot(s);
    const sideAChoice = body.querySelector('[data-agg-side="' + agg.aSide + '"][data-agg-f="lagId"]')?.value;
    const sideAName = body.querySelector('[data-agg-side="' + agg.aSide + '"][data-agg-f="name"]')?.value || '';
    const sideBChoice = body.querySelector('[data-agg-side="' + agg.bSide + '"][data-agg-f="lagId"]')?.value;
    const sideBName = body.querySelector('[data-agg-side="' + agg.bSide + '"][data-agg-f="name"]')?.value || '';
    const lagA = stkA ? resolveOrCreateLag(stkA, sideAChoice, sideAName) : null;
    const lagB = stkB ? resolveOrCreateLag(stkB, sideBChoice, sideBName) : null;
    // Add the constituent ports to each side's LAG.
    linkRows.forEach((r) => {
      if (lagA && r.aDev && r.aPort) {
        const portN = Number(r.aPort);
        if (!lagA.ports.some((p) => p.deviceId === r.aDev.id && Number(p.portN) === portN)) {
          lagA.ports.push({ deviceId: r.aDev.id, portN });
        }
      }
      if (lagB && r.bDev && r.bPort) {
        const portN = Number(r.bPort);
        if (!lagB.ports.some((p) => p.deviceId === r.bDev.id && Number(p.portN) === portN)) {
          lagB.ports.push({ deviceId: r.bDev.id, portN });
        }
      }
    });
    // LAG-pair: counterpart link both sides.
    if (lagA && lagB && stkA && stkB) {
      lagA.counterpart = { stackId: stkB.id, lagId: lagB.id };
      lagB.counterpart = { stackId: stkA.id, lagId: lagA.id };
    }
    toast(s, lagA && lagB ? `LAG-pair created: ${lagA.name} ⇄ ${lagB.name}` : (lagA ? `LAG ${lagA.name} created` : `LAG ${lagB?.name} created`));
    render(s);
    schedSave(s);
    if (lagA && stkA) select(s, 'lag', `${stkA.id}|${lagA.id}`);
    else if (lagB && stkB) select(s, 'lag', `${stkB.id}|${lagB.id}`);
    else deselect(s);
  });
}

// Settings inspector — opens via the gear button at the bottom of the
// left panel. Hosts user-preference toggles persisted in localStorage so
// they outlive map switches and unmounts.
function renderPrefsInspector(s, body, idEl) {
  idEl.textContent = '// SETTINGS';
  const prefs = s.prefs || (s.prefs = loadPrefs());
  const activeStyle = STYLES.find((x) => x.id === prefs.style) ? prefs.style : DEFAULT_STYLE;
  body.innerHTML = `
    <div class="m002-prefs-section">
      <div class="m002-prefs-section-head">// VISUAL STYLE</div>
      <div class="m002-style-picker">
        ${STYLES.map((style) => `
          <button type="button" class="m002-style-pill ${style.id === activeStyle ? 'active' : ''}" data-style="${style.id}" title="${escSvg(style.desc)}">
            <span class="m002-style-pill-label">${escSvg(style.label)}</span>
            <span class="m002-style-pill-desc">${escSvg(style.desc)}</span>
          </button>
        `).join('')}
      </div>
    </div>

    <div class="m002-prefs-section">
      <div class="m002-prefs-section-head">// BEHAVIOR</div>
      <label class="m002-prefs-row">
        <span>
          <span class="m002-prefs-label">Auto-recenter on selection</span>
          <span class="m002-prefs-sublabel">Pan the camera so the clicked element ends up in the middle of the canvas.</span>
        </span>
        <input type="checkbox" data-pref="autoRecenter" ${prefs.autoRecenter ? 'checked' : ''}/>
      </label>
      <label class="m002-prefs-row">
        <span>
          <span class="m002-prefs-label">Free movement (no grid)</span>
          <span class="m002-prefs-sublabel">Drag elements smoothly without the grid pulling them. Hold Alt to invert per-gesture.</span>
        </span>
        <input type="checkbox" data-pref="freeMove" ${prefs.freeMove ? 'checked' : ''}/>
      </label>
      <label class="m002-prefs-row">
        <span>
          <span class="m002-prefs-label">Snap to grid on drop</span>
          <span class="m002-prefs-sublabel">When you release, the element settles onto the nearest grid cell. Alt at release skips it.</span>
        </span>
        <input type="checkbox" data-pref="snapOnDrop" ${prefs.snapOnDrop ? 'checked' : ''}/>
      </label>
      <label class="m002-prefs-row">
        <span>
          <span class="m002-prefs-label">Port-Beschriftungen kürzen</span>
          <span class="m002-prefs-sublabel">Zeigt am Kabelende nur die letzte Zahl des Portnamens (z. B. „eth1/1/12" → „12"). Spart Platz und vermeidet Überlappungen bei dichten Verbindungen.</span>
        </span>
        <input type="checkbox" data-pref="shortPortLabels" ${prefs.shortPortLabels !== false ? 'checked' : ''}/>
      </label>
    </div>
  `;
  body.querySelectorAll('[data-pref]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.pref;
      const val = el.type === 'checkbox' ? el.checked : el.value;
      s.prefs[key] = val;
      savePrefs(s.prefs);
      if (key === 'shortPortLabels') render(s);
    });
  });
  body.querySelectorAll('[data-style]').forEach((el) => {
    el.addEventListener('click', () => {
      applyStyle(s, el.dataset.style);
      body.querySelectorAll('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === el.dataset.style));
    });
  });
}

function syncAggSide(body) {
  body.querySelectorAll('.m002-agg-side').forEach((row) => {
    const pick = row.querySelector('[data-agg-f="lagId"]');
    const nameInput = row.querySelector('[data-agg-f="name"]');
    if (!pick || !nameInput) return;
    const isNew = pick.value === '__new';
    nameInput.style.display = isNew ? '' : 'none';
  });
}

function resolveOrCreateLag(stack, lagId, defaultName) {
  if (!Array.isArray(stack.lags)) stack.lags = [];
  if (lagId && lagId !== '__new') {
    const existing = stack.lags.find((l) => l.id === lagId);
    if (existing) return existing;
  }
  const newLag = {
    id: 'lag_' + rid(),
    name: (defaultName || 'Po' + (stack.lags.length + 1)).trim(),
    ports: [],
    vlans: [],
  };
  stack.lags.push(newLag);
  sortLagsInStack(stack);
  return newLag;
}

function refreshToolHighlights(s) {
  const setActive = (sel, on) => s.host.querySelector(sel)?.classList.toggle('active', !!on);
  setActive('[data-tool="link"]',   s.linkMode);
  setActive('[data-tool="delete"]', s.deleteMode);
  setActive('[data-tool="select"]', !s.linkMode && !s.deleteMode);
  // Tool-aware cursor recolour. CSS scoped to body classes so the global
  // N.IVEN cursor (red brackets + red dot) shifts to the active tool's hue
  // while staying in the same shape.
  const body = document.body;
  body.classList.remove('m002-tool-select', 'm002-tool-link', 'm002-tool-delete');
  if (s.linkMode) body.classList.add('m002-tool-link');
  else if (s.deleteMode) body.classList.add('m002-tool-delete');
  else body.classList.add('m002-tool-select');
}

// Renders the world-coord centre of a stored camera anchor + zoom factor.
// "—" for unset; falls back to a zoom-only label if the SVG isn't measurable
// yet (very early renders).
function formatAnchorLabel(s, anchor) {
  if (!anchor) return '—';
  const r = s.svg && s.svg.getBoundingClientRect ? s.svg.getBoundingClientRect() : null;
  const zoomTxt = (Number(anchor.zoom) || 1).toFixed(2);
  if (!r || !r.width || !r.height) return `@ ${zoomTxt}×`;
  const cx = Math.round((r.width  / 2 - anchor.x) / anchor.zoom);
  const cy = Math.round((r.height / 2 - anchor.y) / anchor.zoom);
  return `${cx}, ${cy} · ${zoomTxt}×`;
}

function renderReferenceInspector(s, dev, body) {
  const otherMaps = (s.maps || []).filter((m) => m.id !== s.activeMapId);
  const peer = couplePeer(s, dev);
  const peerZone = peer ? (s.zones || []).find((z) => z.id === peer.zone) : null;
  // Hub-leg count: same-zone links touching this Jump.
  const hubLegs = s.links.filter((l) => l.from === dev.id || l.to === dev.id).length;
  // All other Jumps anywhere in this map, sorted by zone then name. The picker
  // is the primary way to couple — link-tool no longer supports Jump↔Jump.
  const candidates = (s.devices || [])
    .filter((d) => isReference(d) && d.id !== dev.id)
    .map((d) => ({
      d,
      zone: (s.zones || []).find((z) => z.id === d.zone),
    }))
    .sort((a, b) => (a.zone?.name || '').localeCompare(b.zone?.name || '') || a.d.name.localeCompare(b.d.name));
  // Group by zone for the dropdown's optgroups.
  const byZone = new Map();
  candidates.forEach(({ d, zone }) => {
    const key = zone ? zone.id : '_none';
    if (!byZone.has(key)) byZone.set(key, { name: zone ? zone.name : '(no zone)', items: [] });
    byZone.get(key).items.push(d);
  });
  const isMap = dev.refMode === 'map';

  const anchor = dev.cameraAnchor || null;
  const anchorLabel = formatAnchorLabel(s, anchor);
  const anchorSection = `
    <div class="m002-field">
      <span>ANKER</span>
      <div class="m002-anchor-row">
        <div class="m002-field-static" data-anchor-display>${escSvg(anchorLabel)}</div>
        <button type="button" class="m002-action small" data-anchor-set>${anchor ? 'NEU' : 'SETZEN'}</button>
        ${anchor ? '<button type="button" class="m002-action small" data-anchor-clear title="Anker löschen">✕</button>' : ''}
      </div>
    </div>
  `;
  const coupleSection = peer ? `
    <div class="m002-field">
      <span>COUPLED PEER</span>
      <div class="m002-couple-card">
        <div class="m002-couple-line"><span class="m002-couple-arrow">⇄</span><span>${escSvg(peer.name)}</span></div>
        <div class="m002-couple-zone">${escSvg(peerZone ? peerZone.name : '(zone missing)')}</div>
      </div>
    </div>
    ${anchorSection}
    <div class="m002-row2">
      <button type="button" class="m002-action" data-ref-jump>JUMP NOW</button>
      <button type="button" class="m002-action" data-ref-uncouple>UNCOUPLE</button>
    </div>
  ` : `
    <div class="m002-field">
      <span>COUPLE WITH</span>
      <select data-ref-couple>
        <option value="">— select JUMP in another zone —</option>
        ${[...byZone.entries()].map(([zid, group]) => `
          <optgroup label="${escAttr(group.name)}">
            ${group.items.map((j) => {
              const sameZone = j.zone === dev.zone;
              const taken = !!j.coupleId;
              const disabled = sameZone || taken;
              const suffix = sameZone ? ' (same zone)' : (taken ? ' · coupled' : '');
              return `<option value="${escAttr(j.id)}" ${disabled ? 'disabled' : ''}>${escSvg(j.name)}${suffix}</option>`;
            }).join('')}
          </optgroup>
        `).join('')}
      </select>
    </div>
    ${candidates.length === 0 ? '<p class="m002-link-hint">Keine weiteren JUMPs auf dieser Map.</p>' : ''}
    <details class="m002-ref-fallback">
      <summary>FALLBACK TARGET (ohne Couple)</summary>
      <div class="m002-field" style="margin-top:8px;">
        <span>MODE</span>
        <div class="m002-ref-modes">
          <label class="m002-ref-mode ${!isMap ? 'active' : ''}"><input type="radio" name="m002-refmode" value="zone" ${!isMap ? 'checked' : ''}/>ZONE</label>
          <label class="m002-ref-mode ${isMap ? 'active' : ''}"><input type="radio" name="m002-refmode" value="map" ${isMap ? 'checked' : ''}/>MAP</label>
        </div>
      </div>
      ${!isMap ? `
        <label class="m002-field"><span>ZONE</span>
          <select data-rf="refZoneId">
            <option value="">— select zone —</option>
            ${(s.zones || []).filter((z) => z.id !== dev.zone).map((z) => `<option value="${escAttr(z.id)}" ${z.id === dev.refZoneId ? 'selected' : ''}>${escSvg(z.name)}</option>`).join('')}
          </select>
        </label>
      ` : `
        <label class="m002-field"><span>MAP</span>
          <select data-rf="refMapId">
            <option value="">— select map —</option>
            ${otherMaps.map((m) => `<option value="${escAttr(m.id)}" ${m.id === dev.refMapId ? 'selected' : ''}>${escSvg(m.name)}</option>`).join('')}
          </select>
        </label>
      `}
    </details>
    <button type="button" class="m002-action" data-ref-jump>JUMP NOW</button>
  `;

  // Cross-zone LAG-pair section — when a couple is in place, surface every
  // stack-pair that shares the JUMP hub (one stack on each side) so the user
  // can bond their hub-leg ports into a counterparted LAG without leaving
  // the JUMP inspector. Stacks are the only entities with LAG state in this
  // model; single-switch hub-leg pairings already work via the port-modal
  // COUNTERPART tunnel.
  let crossZoneSection = '';
  if (peer) {
    const groupByStack = (jumpId) => {
      const out = new Map();
      hubLocalLegs(s, jumpId).forEach((leg) => {
        if (!leg.portN) return;
        const stk = findStack(s, leg.device.id);
        if (!stk) return;
        if (!out.has(stk.id)) out.set(stk.id, []);
        out.get(stk.id).push(leg);
      });
      return out;
    };
    const localStacks = groupByStack(dev.id);
    const farStacks = groupByStack(peer.id);
    const pairRows = [];
    localStacks.forEach((aLegs, aId) => {
      farStacks.forEach((bLegs, bId) => {
        const aStk = s.stacks.find((st) => st.id === aId);
        const bStk = s.stacks.find((st) => st.id === bId);
        if (!aStk || !bStk) return;
        const paired = (aStk.lags || []).some((lag) =>
          lag.counterpart?.stackId === bStk.id &&
          (bStk.lags || []).some((pl) => pl.id === lag.counterpart.lagId && pl.counterpart?.stackId === aStk.id)
        );
        pairRows.push(`<div class="m002-couple-card" data-cz-a="${escAttr(aId)}" data-cz-b="${escAttr(bId)}">
          <div class="m002-couple-line"><span>${escSvg(aStk.name)}</span><span class="m002-couple-arrow">⇄</span><span>${escSvg(bStk.name)}</span></div>
          <div class="m002-couple-zone">${aLegs.length} + ${bLegs.length} hub-leg ports</div>
          <button type="button" class="m002-action" data-cz-pair ${paired ? 'disabled' : ''}>${paired ? 'PAIRED' : 'LAG-PAIR'}</button>
        </div>`);
      });
    });
    if (pairRows.length) {
      crossZoneSection = `
        <div class="m002-field">
          <span>LAG-PAIR ÜBER COUPLE</span>
        </div>
        ${pairRows.join('')}
      `;
    }
  }
  body.innerHTML = `
    <label class="m002-field"><span>NAME</span><input data-f="name" value="${escAttr(dev.name)}"/></label>
    <label class="m002-field"><span>TYPE</span>
      <select data-f="type">${DEVICE_TYPES.map((tt) => `<option value="${tt.id}" ${tt.id === dev.type ? 'selected' : ''}>${tt.label}</option>`).join('')}</select>
    </label>
    ${coupleSection}
    <div class="m002-field">
      <span>HUB LEGS</span>
      <div class="m002-field-static">${hubLegs} link${hubLegs === 1 ? '' : 's'} in dieser Zone</div>
    </div>
    ${crossZoneSection}
    <label class="m002-field"><span>NOTES</span><textarea data-f="notes" rows="3">${escAttr(dev.notes || '')}</textarea></label>
    <button type="button" class="m002-insp-del" data-del>DELETE NODE</button>
  `;

  body.querySelectorAll('[data-f]').forEach((el) => {
    el.addEventListener('input', () => updateDeviceField(s, dev, el));
    el.addEventListener('change', () => updateDeviceField(s, dev, el));
  });
  body.querySelectorAll('input[name="m002-refmode"]').forEach((el) => {
    el.addEventListener('change', () => {
      dev.refMode = el.value === 'map' ? 'map' : 'zone';
      redrawDevice(s, dev);
      schedSave(s);
      openInspector(s);
    });
  });
  body.querySelectorAll('[data-rf]').forEach((el) => {
    el.addEventListener('change', () => {
      dev[el.dataset.rf] = el.value || null;
      redrawDevice(s, dev);
      schedSave(s);
    });
  });
  body.querySelector('[data-ref-couple]')?.addEventListener('change', (e) => {
    const targetId = e.target.value;
    if (!targetId) return;
    const target = s.devices.find((d) => d.id === targetId);
    if (!target || !isReference(target)) { toast(s, 'Target JUMP missing'); return; }
    if (target.zone === dev.zone) { toast(s, 'Couple JUMPs only across different zones'); return; }
    snapshot(s);
    coupleJumps(s, dev, target);
    render(s);
    schedSave(s);
    select(s, 'device', dev.id);
    toast(s, 'JUMPs coupled');
  });
  body.querySelector('[data-anchor-set]')?.addEventListener('click', () => {
    dev.cameraAnchor = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
    schedSave(s);
    openInspector(s);
    toast(s, 'Anker gesetzt');
  });
  body.querySelector('[data-anchor-clear]')?.addEventListener('click', () => {
    dev.cameraAnchor = null;
    schedSave(s);
    openInspector(s);
    toast(s, 'Anker gelöscht');
  });
  body.querySelector('[data-ref-jump]')?.addEventListener('click', () => jumpToReference(s, dev));
  body.querySelector('[data-ref-uncouple]')?.addEventListener('click', () => {
    const peerNow = couplePeer(s, dev);
    if (!peerNow) return;
    snapshot(s);
    uncoupleJump(s, dev);
    render(s);
    schedSave(s);
    openInspector(s);
  });
  body.querySelectorAll('[data-cz-pair]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('[data-cz-a]');
      if (!row) return;
      const aId = row.getAttribute('data-cz-a');
      const bId = row.getAttribute('data-cz-b');
      const peerNow = couplePeer(s, dev);
      const aStk = s.stacks.find((st) => st.id === aId);
      const bStk = s.stacks.find((st) => st.id === bId);
      if (!aStk || !bStk || !peerNow) return;
      const aLegs = hubLocalLegs(s, dev.id).filter((leg) => findStack(s, leg.device.id)?.id === aStk.id && leg.portN);
      const bLegs = hubLocalLegs(s, peerNow.id).filter((leg) => findStack(s, leg.device.id)?.id === bStk.id && leg.portN);
      if (!aLegs.length || !bLegs.length) { toast(s, 'Keine Hub-Leg-Ports zum Bonden'); return; }
      snapshot(s);
      const lagA = resolveOrCreateLag(aStk, '__new', `Po${(aStk.lags || []).length + 1}`);
      const lagB = resolveOrCreateLag(bStk, '__new', `Po${(bStk.lags || []).length + 1}`);
      aLegs.forEach((leg) => {
        const portN = Number(leg.portN);
        if (!lagA.ports.some((p) => p.deviceId === leg.device.id && Number(p.portN) === portN)) {
          lagA.ports.push({ deviceId: leg.device.id, portN });
        }
      });
      bLegs.forEach((leg) => {
        const portN = Number(leg.portN);
        if (!lagB.ports.some((p) => p.deviceId === leg.device.id && Number(p.portN) === portN)) {
          lagB.ports.push({ deviceId: leg.device.id, portN });
        }
      });
      lagA.counterpart = { stackId: bStk.id, lagId: lagB.id };
      lagB.counterpart = { stackId: aStk.id, lagId: lagA.id };
      toast(s, `LAG-pair via ${dev.name}: ${lagA.name} ⇄ ${lagB.name}`);
      render(s);
      schedSave(s);
      openInspector(s);
    });
  });
  body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
}

function showInspectorEmpty(s) {
  const body = s.inspector.querySelector('.m002-insp-body');
  const idEl = s.inspector.querySelector('.m002-insp-id');
  idEl.textContent = '// CONTROLS';
  const row = (keys, label) => `
    <div class="m002-cheat-row">
      <div class="m002-cheat-keys">${keys.map((k) => `<kbd class="m002-kbd">${k}</kbd>`).join('<span class="m002-cheat-plus">+</span>')}</div>
      <div class="m002-cheat-label">${label}</div>
    </div>`;
  body.innerHTML = `
    <div class="m002-cheat">
      <div class="m002-cheat-hint">No selection — pick a node to inspect.</div>

      <div class="m002-cheat-group">
        <div class="m002-cheat-title">// FORGE</div>
        ${row(['N'], 'spawn next device')}
        ${row(['L'], 'toggle link mode')}
        ${row(['R'], 'recenter view')}
        ${row(['DEL'], 'delete selection')}
        ${row(['ESC'], 'deselect / cancel')}
      </div>

      <div class="m002-cheat-group">
        <div class="m002-cheat-title">// HISTORY</div>
        ${row(['CTRL', 'Z'], 'undo')}
        ${row(['CTRL', 'Y'], 'redo')}
      </div>

      <div class="m002-cheat-group">
        <div class="m002-cheat-title">// POINTER</div>
        ${row(['CLICK'], 'select node')}
        ${row(['DRAG'], 'move node')}
        ${row(['DBL'], 'enter detail / expand group')}
        ${row(['SHIFT', 'CLICK'], 'multi-select')}
        ${row(['DRAG&rarr;NODE'], 'group')}
        ${row(['WHEEL'], 'zoom')}
        ${row(['DRAG-BG'], 'pan')}
      </div>
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
    // Port-focus mode: when a port on this device is being inspected, render
    // the port detail body in place of the device form. Stale focus pointing
    // at a now-removed port falls through to the regular device view.
    if (s.portModalOpen?.deviceId === dev.id) {
      const port = dev.ports.find((p) => p.n === s.portModalOpen.portN);
      if (port) { openPortModal(s, dev.id, s.portModalOpen.portN); return; }
      s.portModalOpen = null;
    }
    const t = typeOf(dev.type);
    idEl.textContent = `// ${t.label}`;
    if (isReference(dev)) { renderReferenceInspector(s, dev, body); return; }
    body.innerHTML = `
      <label class="m002-field"><span>ALIAS</span><input data-f="name" value="${escAttr(dev.name)}"/></label>
      <div class="m002-field m002-field-ports">
        <span>PORTS</span>
        <span class="m002-port-count">${dev.ports.length}</span>
        <div class="m002-port-btns">
          <button type="button" class="m002-pcount-btn preset" data-pcount-set="24">24</button>
          <button type="button" class="m002-pcount-btn preset" data-pcount-set="48">48</button>
          <button type="button" class="m002-pcount-btn step plus" data-pcount-step="1" title="Add a port">+</button>
          <button type="button" class="m002-pcount-btn step minus" data-pcount-step="-1" title="Remove a port">−</button>
        </div>
      </div>
      <details class="m002-insp-details"${s.inspectorDetailsOpen ? ' open' : ''}>
        <summary>// DETAILS</summary>
        <label class="m002-field"><span>HOSTNAME</span><input data-f="hostname" value="${escAttr(dev.hostname || '')}" placeholder="e.g. swhq-core-01.example.com"/></label>
        <label class="m002-field"><span>NOTES</span><textarea data-f="notes" rows="3">${escAttr(dev.notes)}</textarea></label>
      </details>
      ${isL3Type(dev.type) ? renderL3SectionsHTML(s, dev) : `
      <details class="m002-insp-l3" open>
        <summary>// L3</summary>
        <div class="m002-l3-block">
          <div class="m002-iface-head m002-iface-head--non-l3">
            <span></span>
            <span>IP</span>
            <span>PREFIX</span>
            <span></span>
          </div>
          <div class="m002-iface-row m002-iface-row--non-l3">
            <span class="m002-iface-dot"></span>
            <input data-f="ip" value="${escAttr(dev.ip || '')}" placeholder="10.0.0.10"/>
            <select data-f="prefix">${(() => { let h=''; for (let i=32;i>=0;i--){ const sel = Number(dev.prefix ?? 24) === i ? 'selected' : ''; h += `<option value="${i}" ${sel}>/${i}</option>`; } return h; })()}</select>
            <span></span>
          </div>
        </div>
        ${renderRoutesBlockHTML(s, dev)}
      </details>`}
      <details class="m002-insp-vlans"${s.inspectorVlansOpen !== false ? ' open' : ''}>
        <summary>// VLANS</summary>
        <div class="m002-vlan-picker" data-vlan-target="device:${escAttr(dev.id)}"></div>
      </details>
      <div class="m002-ports-block">
        <div class="m002-ports-head">PORT TABLE (${dev.ports.length})</div>
        <div class="m002-ports-prefix" data-prefix-display${dev.portPrefix ? '' : ' hidden'}>
          <span class="m002-ports-prefix-label">auto-prefix</span>
          <code class="m002-ports-prefix-val" data-prefix-text>${escSvg(dev.portPrefix || '')}</code>
          <button type="button" class="m002-ports-prefix-clear" data-prefix-clear title="Reset prefix">✕</button>
        </div>
        <div class="m002-ports-grid">
          <div class="m002-port-head-row">
            <span>#</span><span>PORT</span><span>COUNTERPART</span>
          </div>
          ${(() => {
            const sortPos = computePortSortOrder(dev.ports);
            const dupes = findDuplicatePortNs(dev.ports);
            return dev.ports.map((p) => {
              const cp = counterpartFor(s, dev.id, p.n);
              const lagInfo = findPortLag(s, dev.id, p.n);
              const lagBadge = lagInfo ? ` <span class="m002-port-lagtag" title="part of ${escAttr(lagInfo.lag.name)} (${escAttr(lagInfo.stack.name)})">→ ${escSvg(lagInfo.lag.name)}</span>` : '';
              const order = sortPos.get(p.n) ?? 0;
              const dupeCls = dupes.has(p.n) ? ' is-duplicate' : '';
              const dupeTitle = dupes.has(p.n) ? ' title="Duplicate port name — ignored"' : '';
              return `
              <div class="m002-port-row${dupeCls}" data-port-open="${p.n}" tabindex="0" style="order:${order}"${dupeTitle}>
                <span class="m002-port-num">${p.n}</span>
                <input data-port="${p.n}" data-pf="name" value="${escAttr(p.name)}" placeholder="port name"/>
                <span class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cp || '—')}${lagBadge}</span>
              </div>`;
            }).join('');
          })()}
        </div>
      </div>
      <button type="button" class="m002-insp-del" data-del>DELETE NODE</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => {
        if (el.dataset.f === 'ip' && el.tagName === 'INPUT') {
          const candidate = normalizeIpInput(el.value);
          if (rejectIpEdit(s, el, ipSlotKey('dev', dev.id), candidate)) return;
        }
        updateDeviceField(s, dev, el, false);
      });
      el.addEventListener('change', () => {
        // IP fields: write the normalized form back into the input so the
        // user sees the correction (e.g. "10.0.0.05" → "10.0.0.5") on blur.
        if (el.dataset.f === 'ip' && el.tagName === 'INPUT') {
          const fixed = normalizeIpInput(el.value);
          if (fixed !== el.value) el.value = fixed;
          if (rejectIpEdit(s, el, ipSlotKey('dev', dev.id), fixed)) return;
        }
        updateDeviceField(s, dev, el, true);
        // Commit-only refresh for the port count: rebuilds the port table to
        // match the new size. We skip on 'input' to avoid clobbering focus
        // mid-keystroke; 'type' already re-opens itself inside the handler.
        if (el.dataset.f === 'ports') openInspector(s);
      });
    });
    // Persist the //DETAILS / //VLANS open/closed state across inspector
    // re-renders so a +/− click (or any other rerender) doesn't surprise the
    // user by collapsing the panel they had just expanded.
    body.querySelector('.m002-insp-details')?.addEventListener('toggle', (e) => {
      s.inspectorDetailsOpen = e.target.open;
    });
    body.querySelector('.m002-insp-vlans')?.addEventListener('toggle', (e) => {
      s.inspectorVlansOpen = e.target.open;
    });
    // Port-count buttons: 24 / 48 quick-presets and ± steppers. Each routes
    // through updateDeviceField('ports') with a synthetic element so the
    // existing port/link/LAG cleanup logic runs. openInspector() re-renders
    // the form so the count display and port table reflect the new size.
    const setPortCount = (n) => {
      const clamped = Math.max(1, Math.min(96, n));
      updateDeviceField(s, dev, { dataset: { f: 'ports' }, value: String(clamped) });
      openInspector(s);
    };
    body.querySelectorAll('[data-pcount-set]').forEach((btn) => {
      btn.addEventListener('click', () => setPortCount(parseInt(btn.dataset.pcountSet, 10)));
    });
    body.querySelectorAll('[data-pcount-step]').forEach((btn) => {
      btn.addEventListener('click', () => setPortCount(dev.ports.length + parseInt(btn.dataset.pcountStep, 10)));
    });
    // After a name commit, push every row's CSS `order` to its new sort
    // position and refresh the prefix hint row — no DOM rebuild, focus and
    // listeners on every input survive intact.
    const reflowPortTable = () => {
      const sortPos = computePortSortOrder(dev.ports);
      body.querySelectorAll('[data-port-open]').forEach((row) => {
        const o = sortPos.get(Number(row.dataset.portOpen));
        if (o != null) row.style.order = String(o);
      });
      const hint = body.querySelector('[data-prefix-display]');
      const txt  = body.querySelector('[data-prefix-text]');
      if (hint && txt) {
        if (dev.portPrefix) { txt.textContent = dev.portPrefix; hint.hidden = false; }
        else { hint.hidden = true; }
      }
    };
    // Live duplicate-name detection: any port whose trimmed name collides
    // with another port on this device gets the .is-duplicate class so the
    // row glows red. Recomputes on every keystroke + on commit.
    const refreshDupes = () => {
      const dupes = findDuplicatePortNs(dev.ports);
      body.querySelectorAll('[data-port-open]').forEach((row) => {
        const isDupe = dupes.has(Number(row.dataset.portOpen));
        row.classList.toggle('is-duplicate', isDupe);
        if (isDupe) row.title = 'Duplicate port name — ignored';
        else if (row.title === 'Duplicate port name — ignored') row.removeAttribute('title');
      });
    };
    body.querySelectorAll('[data-port]').forEach((el) => {
      el.addEventListener('input', () => {
        const p = dev.ports.find((pp) => pp.n === Number(el.dataset.port));
        if (!p) return;
        p[el.dataset.pf] = el.value;
        // Counterpart text in this row stays the same; redraw link labels
        s.links.filter((l) => (l.from === dev.id && Number(l.fromPort) === p.n) || (l.to === dev.id && Number(l.toPort) === p.n))
              .forEach((l) => redrawLink(s, l));
        if (el.dataset.pf === 'name') refreshDupes();
        schedSave(s);
        refreshDetailViewIfSettled(s);
      });
      if (el.dataset.pf === 'name') {
        // Click-into-empty: pre-fill with the learned prefix immediately so
        // the user types only the trailing number on top of the visible
        // prefix, instead of relying on a silent post-blur expansion.
        el.addEventListener('focus', () => {
          if (!el.value && dev.portPrefix) {
            const p = dev.ports.find((pp) => pp.n === Number(el.dataset.port));
            if (!p) return;
            el.value = dev.portPrefix;
            p.name = dev.portPrefix;
            try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
            refreshDupes();
            schedSave(s);
            refreshDetailViewIfSettled(s);
          }
        });
        // Auto-prefix expansion fires on commit, not keystroke — typing "5"
        // on a sibling port becomes "eth1/1/5" once the user blurs/Enters
        // out. The reflow updates row order + prefix hint.
        el.addEventListener('change', () => {
          const p = dev.ports.find((pp) => pp.n === Number(el.dataset.port));
          if (!p) return;
          const expanded = commitAutoPrefixPortName(dev, el.value);
          if (expanded !== el.value) {
            el.value = expanded;
            p.name = expanded;
            s.links.filter((l) => (l.from === dev.id && Number(l.fromPort) === p.n) || (l.to === dev.id && Number(l.toPort) === p.n))
                  .forEach((l) => redrawLink(s, l));
            refreshDetailViewIfSettled(s);
          }
          reflowPortTable();
          refreshDupes();
          schedSave(s);
        });
      }
      // Don't open the port modal when the user clicks INTO the input
      el.addEventListener('click', (ev) => ev.stopPropagation());
    });
    body.querySelector('[data-prefix-clear]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dev.portPrefix = '';
      const hint = body.querySelector('[data-prefix-display]');
      if (hint) hint.hidden = true;
      schedSave(s);
    });
    body.querySelectorAll('[data-port-open]').forEach((row) => {
      row.addEventListener('click', () => openPortModal(s, dev.id, Number(row.dataset.portOpen)));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
    if (isL3Type(dev.type)) {
      bindL3Sections(s, dev, body);
    } else if (!isReference(dev)) {
      // Non-L3 devices get a routes block too — wire it up so the user can
      // edit / remove / add the default route surfaced from their dev.ip.
      bindRoutesSection(s, dev, body, () => redrawDevice(s, dev));
    }
    renderInspectorVlanPickers(s);
  } else if (s.selected.kind === 'link') {
    const link = s.links.find((l) => l.id === s.selected.id);
    if (!link) return;
    // Hub-tunnel LAG-pair leg — redirect the user to the LAG inspector instead
    // of the misleading "switch ⇄ JUMP — no port" link form. The LAG editor
    // already speaks the right language (counterpart, ports, VLANs across the
    // pair) and edits both sides in one place.
    const tp = hubTunnelLagPair(s, link);
    if (tp) {
      select(s, 'lag', `${tp.localStack.id}|${tp.localLag.id}`);
      return;
    }
    const a = s.devices.find((d) => d.id === link.from);
    const b = s.devices.find((d) => d.id === link.to);
    const aRef = isReference(a), bRef = isReference(b);
    // Mirror grid layout in the header: whichever endpoint sits further left on
    // the canvas is rendered on the left of the inspector. Purely cosmetic —
    // link.from / link.to (and their port bindings) are untouched.
    const posA = effectivePos(s, a?.id) || { x: a?.x ?? 0 };
    const posB = effectivePos(s, b?.id) || { x: b?.x ?? 0 };
    const flip = posB.x < posA.x;
    const left = flip ? b : a;
    const right = flip ? a : b;
    const leftSide = flip ? 'TO' : 'FROM';
    const rightSide = flip ? 'FROM' : 'TO';
    idEl.textContent = `// LINK`;
    const portCell = (dev, side) => {
      if (isReference(dev)) {
        return `<label class="m002-field"><span>${side} PORT</span><div class="m002-field-static">JUMP — no port</div></label>`;
      }
      const f = side === 'FROM' ? 'fromPort' : 'toPort';
      const cur = side === 'FROM' ? link.fromPort : link.toPort;
      // Mirror the port-modal counterpart picker: ports already wired by *another*
      // link slide to the bottom and read as "— in use" in muted grey. They stay
      // selectable (the user may legitimately want to repurpose one), but the
      // greyed-out tail makes the free ports unambiguous at a glance.
      const isUsedByOther = (portN) => s.links.some((l) =>
        l !== link && (
          (l.from === dev.id && Number(l.fromPort) === portN) ||
          (l.to   === dev.id && Number(l.toPort)   === portN)
        )
      );
      const opts = (dev?.ports || []).map((p) => ({ p, occupied: isUsedByOther(p.n) }));
      // Stable sort: free first, occupied last; original order preserved within each group.
      opts.sort((a, b) => Number(a.occupied) - Number(b.occupied));
      const optsHTML = opts.map(({ p, occupied }) => {
        const selected = String(cur) === String(p.n);
        // Currently-selected port reads as "occupied" (its own link wires it),
        // but must remain selectable and visually highlighted — only mark *other*
        // occupied ports as muted.
        const dim = occupied && !selected;
        const label = `${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}${dim ? ' — in use' : ''}`;
        return `<option value="${p.n}"${selected ? ' selected' : ''}${dim ? ' class="is-occupied"' : ''}>${label}</option>`;
      }).join('');
      return `<label class="m002-field"><span>${side} PORT</span>
        <select class="m002-link-port-select" data-f="${f}"><option value="">—</option>${optsHTML}</select>
      </label>`;
    };
    const isHubLeg = aRef || bRef;
    body.innerHTML = `
      <div class="m002-link-summary">
        <span class="m002-link-end">${escSvg(left?.name || '?')}</span>
        <span class="m002-link-arrow">⇄</span>
        <span class="m002-link-end">${escSvg(right?.name || '?')}</span>
      </div>
      <div class="m002-row2">
        ${portCell(left, leftSide)}
        ${portCell(right, rightSide)}
      </div>
      <div class="m002-field">
        <span>VLANS${isHubLeg ? '' : ' (port-pair)'}</span>
        <div class="m002-vlan-picker" data-vlan-target="link:${escAttr(link.id)}"></div>
      </div>
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

    // LAGS section: lives on the stack now. Each row links into the symmetric
    // LAG editor and shows the per-stackmate port distribution.
    const lagsHTML = (() => {
      const rows = (stack.lags || []).map((lag) => {
        const cp = lagCounterpart(s, stack.id, lag);
        const cpTxt = cp
          ? (cp.lag ? `${cp.stack.name} · ${cp.lag.name}` : `${cp.stack.name} · ${cp.count}p`)
          : '—';
        const byHost = new Map();
        (lag.ports || []).forEach((p) => {
          if (!byHost.has(p.deviceId)) byHost.set(p.deviceId, []);
          byHost.get(p.deviceId).push(Number(p.portN));
        });
        const portTxt = [...byHost.entries()].map(([hid, ns]) => {
          const host = s.devices.find((d) => d.id === hid);
          const label = (byHost.size > 1 && host) ? `${host.name}: ` : '';
          return label + ns.sort((a, b) => a - b).join(', ');
        }).join(' · ') || '—';
        return `
          <div class="m002-lagtable-row" data-lag-row="${escAttr(lag.id)}" tabindex="0">
            <span class="m002-lagtable-name">${escSvg(lag.name)}</span>
            <span class="m002-lagtable-ports" title="${escAttr(portTxt)}">${escSvg(portTxt)}</span>
            <span class="m002-lagtable-cp ${cp ? '' : 'dim'}" title="${escAttr(cpTxt)}">${escSvg(cpTxt)}</span>
          </div>`;
      }).join('') || '<span class="m002-vlan-empty">no LAGs</span>';
      return `
        <div class="m002-ports-block">
          <div class="m002-ports-head">LAGS (${(stack.lags || []).length})</div>
          <div class="m002-ports-grid">
            <div class="m002-lagtable-head">
              <span>NAME</span><span>PORTS</span><span>COUNTERPART</span>
            </div>
            ${rows}
          </div>
          <button type="button" class="m002-action" data-newlag>+ NEW LAG</button>
        </div>
      `;
    })();

    // STACK-LINKS section: stacking cables between members. Each row is a
    // single-line editor; ports are scoped to the chosen member's port list.
    const stackLinksHTML = (() => {
      const memberOpts = (selectedId) => stack.members.map((mid) => {
        const m = s.devices.find((d) => d.id === mid);
        if (!m) return '';
        return `<option value="${escAttr(mid)}" ${selectedId === mid ? 'selected' : ''}>${escSvg(m.name)}</option>`;
      }).join('');
      const portOpts = (deviceId, selectedPort) => {
        const m = s.devices.find((d) => d.id === deviceId);
        if (!m) return '<option value="">—</option>';
        return '<option value="">—</option>' + (m.ports || []).map((p) =>
          `<option value="${p.n}" ${String(selectedPort) === String(p.n) ? 'selected' : ''}>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</option>`
        ).join('');
      };
      const rows = (stack.stackLinks || []).map((sl) => `
        <div class="m002-stacklink-row" data-sl-id="${escAttr(sl.id)}">
          <select data-sl-f="fromDevice">${memberOpts(sl.fromDevice)}</select>
          <select data-sl-f="fromPort">${portOpts(sl.fromDevice, sl.fromPort)}</select>
          <span class="m002-stacklink-arrow">⇄</span>
          <select data-sl-f="toDevice">${memberOpts(sl.toDevice)}</select>
          <select data-sl-f="toPort">${portOpts(sl.toDevice, sl.toPort)}</select>
          <button type="button" data-sl-rm title="Remove stack-link">×</button>
        </div>
      `).join('') || '<span class="m002-vlan-empty">no stack-links</span>';
      return `
        <div class="m002-ports-block">
          <div class="m002-ports-head">STACK-LINKS (${(stack.stackLinks || []).length})</div>
          <div class="m002-stacklinks-grid">
            ${rows}
          </div>
          <button type="button" class="m002-action" data-newsl ${stack.members.length < 2 ? 'disabled' : ''}>+ NEW STACK-LINK</button>
        </div>
      `;
    })();

    // VIPs — virtual L3 interfaces that ride on the stack as a whole. Each
    // row mirrors the device-interface form: NAME · IP · /PREFIX · GATEWAY.
    // VRRP / HSRP / StackWise: endpoints in the subnet point at the VIP as
    // their gateway and the VIP "floats" between member nodes during failover.
    // Members keep their own mgmt IPs; those don't generate routing endpoints
    // when a VIP is configured (see deviceSubnets()).
    const vipsHTML = (() => {
      const vifs = stack.virtualInterfaces || [];
      const head = vifs.length
        ? `<div class="m002-iface-head">
             <span></span>
             <span>NAME</span>
             <span>IP</span>
             <span>PREFIX</span>
             <span></span>
           </div>`
        : '';
      const prefixOpts = (selected) => {
        const sel = Number.isFinite(Number(selected)) ? Number(selected) : 24;
        let html = '';
        for (let i = 32; i >= 0; i--) html += `<option value="${i}" ${i === sel ? 'selected' : ''}>/${i}</option>`;
        return html;
      };
      const rows = vifs.length
        ? vifs.map((vif) => {
            const cidr = vif.ip ? `${vif.ip}/${vif.prefix != null ? vif.prefix : 24}` : null;
            const sn = cidr ? subnetForIp(s, cidr) : null;
            const c = sn ? subnetColor(s, sn.id) : '#3a3a44';
            return `<div class="m002-iface-row" data-vif-id="${escAttr(vif.id)}" style="--sc:${c}">
              <span class="m002-iface-dot" title="${sn ? escAttr('subnet ' + sn.cidr) : 'no subnet'}"></span>
              <input class="m002-iface-name" data-vif-f="name" value="${escAttr(vif.name)}" placeholder="vip0"/>
              <input class="m002-iface-ip" data-vif-f="ip" value="${escAttr(vif.ip)}" placeholder="10.0.0.1"/>
              <select class="m002-iface-prefix" data-vif-f="prefix">${prefixOpts(vif.prefix)}</select>
              <button type="button" class="m002-iface-rm" data-vif-rm title="Remove VIP">×</button>
            </div>`;
          }).join('')
        : `<span class="m002-vlan-empty">no VIPs — the stack has no L3 identity. Add one to make endpoints route through it.</span>`;
      return `
        <div class="m002-l3-block">
          <div class="m002-l3-head">
            <span>VIPS (${vifs.length})</span>
            <button type="button" class="m002-action small" data-vif-add>+ ADD</button>
          </div>
          <div class="m002-iface-list">${head}${rows}</div>
        </div>
        ${renderRoutesBlockHTML(s, stack)}
      `;
    })();
    body.innerHTML = `
      <label class="m002-field"><span>NAME</span><input data-sf="name" value="${escAttr(stack.name)}"/></label>
      <div class="m002-field">
        <span>VIEW</span>
        <button type="button" class="m002-action" data-stk="toggle">
          ${stack.expanded ? '▴ COLLAPSE' : '▾ EXPAND'}
        </button>
      </div>
      <details class="m002-insp-vlans"${s.inspectorVlansOpen !== false ? ' open' : ''}>
        <summary>// VLANS</summary>
        <div class="m002-vlan-picker" data-vlan-target="stack:${escAttr(stack.id)}"></div>
      </details>
      ${vipsHTML}
      ${lagsHTML}
      ${stackLinksHTML}
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
      <button type="button" class="m002-insp-del" data-del>UNGROUP STACK</button>
    `;
    body.querySelector('[data-sf="name"]').addEventListener('input', (e) => {
      stack.name = e.target.value;
      // Collapsed view: stack rendered as a device card in gDevices.
      const g = s.gDevices.querySelector(`[data-stack-id="${stack.id}"] .m002-dev-name`);
      if (g) g.textContent = stack.name;
      // Expanded view: envelope label in gStacksBg uses a composed string.
      const env = s.gStacksBg.querySelector(`g.m002-stack-envelope[data-stack-id="${stack.id}"] .m002-stack-env-label`);
      if (env) env.textContent = `${stack.name} ×${stack.members.length}`;
      schedSave(s);
    });
    body.querySelector('[data-stk="toggle"]').addEventListener('click', () => {
      toggleStackExpanded(s, stack.id);
      openInspector(s);
    });
    body.querySelector('.m002-insp-vlans')?.addEventListener('toggle', (e) => {
      s.inspectorVlansOpen = e.target.open;
    });
    body.querySelectorAll('[data-stk-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        removeFromStack(s, stack.id, b.dataset.stkRm);
        if (findStackById(s, stack.id)) openInspector(s);
        else { deselect(s); }
      });
    });
    body.querySelector('[data-newlag]')?.addEventListener('click', () => openLagModal(s, stack.id));
    body.querySelectorAll('[data-lag-row]').forEach((row) => {
      row.addEventListener('click', () => select(s, 'lag', `${stack.id}|${row.dataset.lagRow}`));
    });
    body.querySelector('[data-newsl]')?.addEventListener('click', () => addStackLink(s, stack.id));
    body.querySelectorAll('[data-sl-id]').forEach((row) => {
      const slId = row.dataset.slId;
      row.querySelectorAll('[data-sl-f]').forEach((el) => {
        el.addEventListener('change', () => updateStackLinkField(s, stack.id, slId, el.dataset.slF, el.value));
      });
      row.querySelector('[data-sl-rm]')?.addEventListener('click', () => removeStackLink(s, stack.id, slId));
    });
    body.querySelector('[data-del]')?.addEventListener('click', () => deleteSelected(s));
    bindStackVipSection(s, stack, body);
    renderInspectorVlanPickers(s);
  } else if (s.selected.kind === 'agg') {
    renderAggInspector(s, body, idEl);
  } else if (s.selected.kind === 'prefs') {
    renderPrefsInspector(s, body, idEl);
  } else if (s.selected.kind === 'lag') {
    // LAG editor — symmetric, both sides are stacks. FROM LAG / TO LAG pick
    // sibling and peer LAGs; per-side blocks edit each stack's own NAME and
    // MEMBER PORTS (grouped per stackmate).
    const [stackId, lagId] = String(s.selected.id).split('|');
    const stack = findStackById(s, stackId);
    const lag = stack?.lags?.find((l) => l.id === lagId);
    if (!stack || !lag) {
      if (stack) { select(s, 'stack', stack.id); return; }
      deselect(s); return;
    }

    const cp = lagCounterpart(s, stack.id, lag);
    const peerStack = cp?.stack || null;
    const peerLag = cp?.lag || null;

    // FROM-LAG options: every LAG on this stack.
    const fromOpts = (stack.lags || []).map((l) => ({ id: l.id, label: l.name }));

    // TO-LAG options: every LAG on every stack reachable from this one —
    // either a direct member-to-member edge or a JUMP hub-tunnel (same-zone
    // hub-leg or coupled-peer hub-leg).
    const linkedStacks = linkedStacksFor(s, stack);
    const toOpts = [...linkedStacks.values()].flatMap((st) =>
      (st.lags || []).map((l) => ({ stackId: st.id, stackName: st.name, lagId: l.id, lagName: l.name }))
    );
    const toKey = lag.counterpart?.lagId
      ? `${lag.counterpart.stackId}|${lag.counterpart.lagId}`
      : '';

    const isPaired = !!(peerStack && peerLag && lag.counterpart?.lagId);

    // Per-side block — both stacks editable. MEMBER PORTS is grouped per
    // stackmate so a single LAG can bundle ports across the whole stack.
    const sideHTML = (sideStack, sideLag) => {
      const memberDevs = sideStack.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
      const otherLagPorts = new Set();
      (sideStack.lags || []).forEach((l) => {
        if (l === sideLag) return;
        (l.ports || []).forEach((p) => otherLagPorts.add(p.deviceId + ':' + Number(p.portN)));
      });
      return `
        <div class="m002-lag-side" data-side-stack="${escAttr(sideStack.id)}" data-side-lag="${escAttr(sideLag.id)}">
          <div class="m002-lag-side-head">${escSvg(sideStack.name.toUpperCase())}</div>
          <label class="m002-field"><span>NAME</span>
            <input data-side-name value="${escAttr(sideLag.name)}" placeholder="e.g. Po1, LAG-CORE"/>
          </label>
          ${memberDevs.map((memberDev) => {
            const memberPorts = new Set(lagPortsOnDevice(sideLag, memberDev.id));
            return `
              <div class="m002-field">
                <span>MEMBER PORTS · ${escSvg(memberDev.name)} (${memberDev.ports.length})</span>
                <div class="m002-lagm-ports">
                  ${memberDev.ports.map((p) => {
                    const k = memberDev.id + ':' + p.n;
                    const inUse = otherLagPorts.has(k);
                    const checked = memberPorts.has(p.n);
                    return `<label class="m002-lagm-port ${inUse ? 'disabled' : ''}" title="${inUse ? 'already in another LAG' : ''}">
                      <input type="checkbox" data-side-port="${p.n}" data-side-port-dev="${escAttr(memberDev.id)}" ${checked ? 'checked' : ''} ${inUse ? 'disabled' : ''}/>
                      <span>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</span>
                    </label>`;
                  }).join('')}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    };

    idEl.textContent = isPaired
      ? `// ${stack.name} ⇄ ${peerStack.name} · LAG-PAIR`
      : `// ${stack.name} · ${lag.name}`;

    body.innerHTML = `
      <button type="button" class="m002-insp-back" data-back>← BACK TO ${escSvg(stack.name.toUpperCase())}</button>
      <div class="m002-link-summary">
        <span class="m002-link-end">${escSvg(stack.name)}</span>
        <span class="m002-link-arrow">⇄</span>
        <span class="m002-link-end ${peerStack ? '' : 'dim'}">${escSvg(peerStack?.name || '—')}</span>
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
            ${toOpts.map((o) => `<option value="${escAttr(o.stackId + '|' + o.lagId)}" ${toKey === (o.stackId + '|' + o.lagId) ? 'selected' : ''}>${escSvg(o.stackName)} · ${escSvg(o.lagName)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="m002-field">
        <span>VLANS (lag-pair)</span>
        <div class="m002-vlan-picker" data-vlan-target="lag:${escAttr(stack.id)}:${escAttr(lag.id)}"></div>
      </div>
      ${!toOpts.length ? `<p class="m002-link-hint">No LAGs found on linked stacks — create one over there first to pair.</p>` : (lag.counterpart ? '' : (peerLag ? `<p class="m002-link-hint">Auto-derived from port links. Pick "TO LAG" to lock it manually.</p>` : ''))}

      <div class="m002-lag-sides">
        ${sideHTML(stack, lag)}
        ${isPaired ? sideHTML(peerStack, peerLag) : ''}
      </div>

      <button type="button" class="m002-insp-del" data-lact="delete">${isPaired ? 'DELETE LAG-PAIR' : 'DELETE LAG'}</button>
    `;
    renderInspectorVlanPickers(s);

    body.querySelector('[data-back]')?.addEventListener('click', () => {
      select(s, 'stack', stack.id);
    });

    body.querySelector('[data-lf="from"]')?.addEventListener('change', (e) => {
      const newId = e.target.value;
      if (newId && newId !== lag.id) select(s, 'lag', `${stack.id}|${newId}`);
    });

    body.querySelector('[data-lf="to"]')?.addEventListener('change', (e) => {
      snapshot(s);
      if (lag.counterpart?.lagId) {
        const oldPeer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
        if (oldPeer?.lag.counterpart?.lagId === lag.id) delete oldPeer.lag.counterpart;
      }
      const v = e.target.value;
      if (!v) { delete lag.counterpart; }
      else {
        const [oStackId, oLagId] = v.split('|');
        lag.counterpart = { stackId: oStackId, lagId: oLagId };
        const peerInfo = findStackLag(s, oStackId, oLagId);
        if (peerInfo) peerInfo.lag.counterpart = { stackId: stack.id, lagId: lag.id };
      }
      schedSave(s);
      render(s);
      openInspector(s);
    });

    body.querySelectorAll('.m002-lag-side').forEach((sideEl) => {
      const sideStack = findStackById(s, sideEl.dataset.sideStack);
      const sideLag = sideStack?.lags?.find((l) => l.id === sideEl.dataset.sideLag);
      if (!sideStack || !sideLag) return;

      const nameEl = sideEl.querySelector('[data-side-name]');
      nameEl?.addEventListener('input', () => {
        const v = nameEl.value.trim();
        if (!v) return;
        sideLag.name = v;
        if (!isPaired && sideStack.id === stack.id && sideLag.id === lag.id) {
          idEl.textContent = `// ${stack.name} · ${lag.name}`;
        }
        schedSave(s);
      });
      nameEl?.addEventListener('blur', () => {
        if (!nameEl.value.trim()) {
          nameEl.value = sideLag.name;
          toast(s, 'LAG name cannot be empty');
        } else {
          render(s);
        }
      });

      sideEl.querySelectorAll('[data-side-port]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const ports = [...sideEl.querySelectorAll('[data-side-port]:checked')]
            .map((c) => ({ deviceId: c.dataset.sidePortDev, portN: Number(c.dataset.sidePort) }));
          if (ports.length < 2) {
            cb.checked = !cb.checked;
            toast(s, 'LAG needs at least 2 ports');
            return;
          }
          snapshot(s);
          sideLag.ports = ports;
          schedSave(s);
          render(s);
        });
      });
    });

    body.querySelector('[data-lact="delete"]')?.addEventListener('click', () => {
      snapshot(s);
      if (lag.counterpart?.lagId) {
        const peerInfo = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
        if (peerInfo) {
          if (peerInfo.lag.counterpart?.lagId === lag.id) delete peerInfo.lag.counterpart;
          peerInfo.stack.lags = peerInfo.stack.lags.filter((l) => l.id !== peerInfo.lag.id);
        }
      }
      stack.lags = stack.lags.filter((l) => l.id !== lag.id);
      schedSave(s);
      render(s);
      select(s, 'stack', stack.id);
    });
  }
}

function updateDeviceField(s, dev, el, committed = false) {
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
      // Drop stack-LAG port-refs to ports that no longer exist on this device.
      s.stacks.forEach((stk) => {
        (stk.lags || []).forEach((lag) => {
          lag.ports = (lag.ports || []).filter((p) => !(p.deviceId === dev.id && Number(p.portN) > n));
        });
        stk.lags = (stk.lags || []).filter((lag) => lag.ports.length > 0);
      });
      // Clear stack-link port-refs that pointed at removed ports.
      s.stacks.forEach((stk) => {
        (stk.stackLinks || []).forEach((sl) => {
          if (sl.fromDevice === dev.id && Number(sl.fromPort) > n) sl.fromPort = '';
          if (sl.toDevice === dev.id && Number(sl.toPort) > n) sl.toPort = '';
        });
      });
    }
    redrawDevice(s, dev);
  } else if (f === 'type') {
    const wasRef = isReference(dev);
    dev.type = el.value;
    const isRefNow = isReference(dev);
    if (isRefNow && !wasRef) {
      dev.ports = [];
      s.links = s.links.filter((l) => l.from !== dev.id && l.to !== dev.id);
      if (dev.refMode == null) dev.refMode = 'zone';
      if (dev.refZoneId === undefined) dev.refZoneId = null;
      if (dev.refMapId === undefined) dev.refMapId = null;
      if (dev.coupleId === undefined) dev.coupleId = null;
    } else if (!isRefNow && wasRef) {
      // Leaving JUMP: drop the couple so the (now non-Jump) peer reference
      // doesn't dangle on the other side. uncoupleJump checks isReference,
      // so do the peer cleanup directly here.
      if (dev.coupleId) {
        const peer = s.devices.find((d) => d.id === dev.coupleId);
        if (peer && peer.coupleId === dev.id) {
          peer.coupleId = null;
          if (peer.zone === s.activeZone) redrawDevice(s, peer);
        }
        dev.coupleId = null;
      }
      const t2 = typeOf(dev.type);
      dev.ports = Array.from({ length: t2.ports }, (_, i) => ({ n: i + 1, name: '', vlans: [] }));
    }
    // L3 fields follow the type. Becoming a router/firewall provisions
    // interfaces[] and bootstraps if0 from dev.ip+prefix. Leaving the L3
    // type drops interfaces[] but keeps routes[] — non-L3 hosts have a
    // single implicit interface and a routes table all the same.
    if (isL3Type(dev.type)) {
      if (!Array.isArray(dev.interfaces)) dev.interfaces = [];
      if (!Array.isArray(dev.routes)) dev.routes = [];
      if (!dev.interfaces.length && dev.ip && String(dev.ip).trim()) {
        const split = String(dev.ip).match(/^(.+?)\/(\d+)$/);
        const ip = split ? split[1] : String(dev.ip).trim();
        const prefix = split ? Number(split[2]) : (dev.prefix != null ? Number(dev.prefix) : 24);
        dev.interfaces.push({ id: 'if_' + rid(), name: 'if0', ip, prefix });
      }
    } else {
      delete dev.interfaces;
      if (!Array.isArray(dev.routes)) dev.routes = [];
    }
    redrawDevice(s, dev);
    openInspector(s);
  } else if (f === 'prefix') {
    dev.prefix = Math.max(0, Math.min(32, Number(el.value)));
    onL3DeviceFieldChanged(s, dev, committed);
  } else {
    dev[f] = f === 'ip' ? normalizeIpInput(el.value) : el.value;
    if (f === 'name' || f === 'ip' || f === 'notes') redrawDevice(s, dev);
    if (f === 'name') {
      // Counterpart text on other devices' inspector rows references this name
      s.links.filter((l) => l.from === dev.id || l.to === dev.id).forEach((l) => redrawLink(s, l));
    }
    if (f === 'ip') onL3DeviceFieldChanged(s, dev, committed);
  }
  schedSave(s);
  refreshDetailViewIfSettled(s);
}

// Shared post-edit logic for non-L3 device IP/prefix changes: auto-add the
// derived subnet to the registry (so the legend lights up immediately),
// auto-fill the gateway if blank, refresh the subnet legend + routing-layer
// link visuals. The auto-default-route is gated on `committed` — running it
// on every keystroke would yank focus out of the input the moment the user
// types a complete-looking IP, even if they're still going (e.g. typing
// "10.0.0.4" en route to "10.0.0.40"). Subnet registry add stays live since
// it doesn't rebuild the inspector.
function onL3DeviceFieldChanged(s, dev, committed = false) {
  if (isL3Type(dev.type) || isReference(dev)) return;
  let routeAdded = false;
  if (dev.ip) {
    const cidr = `${dev.ip}/${dev.prefix != null ? dev.prefix : 24}`;
    const p = parseCidr(cidr);
    if (p && p.prefix < 31) subnetRegistryAdd(s, `${p.network}/${p.prefix}`, '');
    if (!Array.isArray(dev.routes)) dev.routes = [];
    if (committed) routeAdded = autoCreateDefaultRoute(dev.routes, dev.ip, dev.prefix, null);
  }
  redrawDevice(s, dev);
  subnetsChanged(s);
  if (s.activeLayer === 'routing') {
    s.links.filter((l) => l.from === dev.id || l.to === dev.id).forEach((l) => redrawLink(s, l));
  }
  // The routes section just sprouted a new row — rebuild the inspector so
  // the user sees their default route appear without a manual refresh.
  if (routeAdded) openInspector(s);
}

function updateLinkField(s, link, el) {
  const field = el.dataset.f;       // 'fromPort' | 'toPort'
  const newVal = el.value;
  link[field] = newVal;
  // Port-conflict resolution: a port can only carry one link at a time. When
  // the user re-assigns a port that another link is already wired into, that
  // other link must release the port (set its matching side to '') so the
  // picker stops showing it as "still wired" and the canvas stops rendering
  // a phantom line into the now-stolen port. Empty values skip — clearing a
  // port doesn't conflict with anyone.
  const stolenLinks = [];
  if (newVal) {
    const deviceId = field === 'fromPort' ? link.from : link.to;
    const portN = Number(newVal);
    s.links.forEach((l) => {
      if (l === link) return;
      if (l.from === deviceId && Number(l.fromPort) === portN) {
        l.fromPort = '';
        stolenLinks.push(l);
      }
      if (l.to === deviceId && Number(l.toPort) === portN) {
        l.toPort = '';
        stolenLinks.push(l);
      }
    });
  }
  redrawLink(s, link);
  stolenLinks.forEach((l) => redrawLink(s, l));
  schedSave(s);
  // Live-refresh: the VLAN picker and the link summary depend on the new port
  // selection, so rebuild the inspector immediately. All [data-f] elements in
  // the link inspector are <select>, so this only fires on commit (no focus
  // loss mid-typing).
  openInspector(s);
}

function deleteSelected(s) {
  if (!s.selected) return;
  deleteRef(s, s.selected);
}

// Delete an arbitrary target by reference, regardless of current selection.
// Used by both the DEL key / inspector buttons (via deleteSelected) and the
// DELETE tool mode (click-anything-to-remove).
function deleteRef(s, ref) {
  if (!ref) return;
  const sameAsSelected = s.selected && s.selected.kind === ref.kind && s.selected.id === ref.id;
  // Capture a label before mutation so the toast can name the thing that died.
  let toastMsg = null;
  if (ref.kind === 'device') {
    const d = s.devices.find((dd) => dd.id === ref.id);
    if (d) toastMsg = `Deleted ${d.name}`;
  } else if (ref.kind === 'link') {
    const l = s.links.find((ll) => ll.id === ref.id);
    if (l) {
      const a = s.devices.find((d) => d.id === l.from);
      const b = s.devices.find((d) => d.id === l.to);
      toastMsg = `Link removed: ${a?.name ?? '?'} ⇄ ${b?.name ?? '?'}`;
    }
  } else if (ref.kind === 'lag') {
    toastMsg = 'LAG deleted';
  }
  // stack deletion routes through deleteStack() which has its own toast
  snapshot(s);
  if (ref.kind === 'device') {
    const id = ref.id;
    // Drop any couple before the device vanishes so the peer Jump's
    // coupleId doesn't point at a ghost.
    s.devices.forEach((d) => { if (isReference(d) && d.coupleId === id) d.coupleId = null; });
    // Remove from any stack first (which may dissolve it and drop its LAGs)
    const st = findStack(s, id);
    if (st) removeFromStack(s, st.id, id);
    s.devices = s.devices.filter((d) => d.id !== id);
    s.links = s.links.filter((l) => l.from !== id && l.to !== id);
    // Drop port-refs in any remaining stack-LAG that pointed at the deleted device.
    s.stacks.forEach((stk) => {
      (stk.lags || []).forEach((lag) => {
        lag.ports = (lag.ports || []).filter((p) => p.deviceId !== id);
      });
      stk.lags = (stk.lags || []).filter((lag) => lag.ports.length > 0);
    });
  } else if (ref.kind === 'stack') {
    deleteStack(s, ref.id);
    if (sameAsSelected) deselect(s);
    return;
  } else if (ref.kind === 'lag') {
    const [stackId, lagId] = String(ref.id).split('|');
    const stack = findStackById(s, stackId);
    const lag = stack?.lags?.find((l) => l.id === lagId);
    if (stack && lag) {
      if (lag.counterpart?.lagId) {
        const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
        if (peer?.lag.counterpart?.lagId === lag.id) delete peer.lag.counterpart;
      }
      stack.lags = stack.lags.filter((l) => l.id !== lag.id);
    }
    render(s);
    schedSave(s);
    if (sameAsSelected) {
      if (stack) select(s, 'stack', stack.id); else deselect(s);
    }
    if (toastMsg) toast(s, toastMsg);
    return;
  } else {
    s.links = s.links.filter((l) => l.id !== ref.id);
  }
  if (sameAsSelected) deselect(s);
  render(s);
  schedSave(s);
  if (toastMsg) toast(s, toastMsg);
}

// =============================================================================
// Counterpart helpers + Port modal
// =============================================================================
function counterpartFor(s, deviceId, portN) {
  const link = s.links.find((l) =>
    (l.from === deviceId && String(l.fromPort) === String(portN)) ||
    (l.to   === deviceId && String(l.toPort)   === String(portN))
  );
  if (link) {
    const otherId = link.from === deviceId ? link.to : link.from;
    const otherPort = link.from === deviceId ? link.toPort : link.fromPort;
    const other = s.devices.find((d) => d.id === otherId);
    if (!other) return null;
    // Hub tunnel: if this leg lands on a coupled JUMP, surface the far-side
    // hub-leg as the effective counterpart instead of the (port-less) JUMP.
    if (isReference(other)) {
      const peer = couplePeer(s, other);
      if (!peer) return `${other.name} · (uncoupled hub)`;
      const farLegs = hubFarLegs(s, other.id);
      if (farLegs.length === 0) return `${other.name} ⇄ ${peer.name} · (no far-side leg)`;
      if (farLegs.length === 1) {
        const fl = farLegs[0];
        const fp = (fl.device.ports || []).find((p) => String(p.n) === String(fl.portN));
        const portTxt = fp ? (fp.name || fp.n) : (fl.portN || '?');
        return `${fl.device.name} · ${portTxt} (via ${other.name}⇄${peer.name})`;
      }
      return `${other.name} ⇄ ${peer.name} · ${farLegs.length} legs`;
    }
    const op = other.ports.find((p) => String(p.n) === String(otherPort));
    const portTxt = op ? (op.name || op.n) : '?';
    return `${other.name} · ${portTxt}`;
  }
  // Stack-link counterpart — port belongs to a stacking cable on the owning stack.
  const stk = findStack(s, deviceId);
  if (stk) {
    const sl = (stk.stackLinks || []).find((l) =>
      (l.fromDevice === deviceId && String(l.fromPort) === String(portN)) ||
      (l.toDevice   === deviceId && String(l.toPort)   === String(portN))
    );
    if (sl) {
      const otherId = sl.fromDevice === deviceId ? sl.toDevice : sl.fromDevice;
      const otherPort = sl.fromDevice === deviceId ? sl.toPort : sl.fromPort;
      const other = s.devices.find((d) => d.id === otherId);
      if (!other) return null;
      const op = other.ports.find((p) => String(p.n) === String(otherPort));
      const portTxt = op ? (op.name || op.n) : '?';
      return `${other.name} · ${portTxt} (stack)`;
    }
  }
  return null;
}

// Port detail view. Lives inside the inspector panel (no longer a floating
// modal). Setting s.portModalOpen + selecting the device routes openInspector
// to render this body in place of the device form. Callers may invoke
// openPortModal directly (e.g. from the detail-view port click); it ensures
// the inspector context is right and renders.
function openPortModal(s, deviceId, portN) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return;
  const port = dev.ports.find((p) => p.n === portN);
  if (!port) return;
  s.portModalOpen = { deviceId, portN };
  if (!(s.selected?.kind === 'device' && s.selected.id === deviceId)) {
    s.selected = { kind: 'device', id: deviceId };
    markSelected(s);
  }
  const idEl = s.inspector.querySelector('.m002-insp-id');
  const body = s.inspector.querySelector('.m002-insp-body');
  idEl.textContent = `// ${dev.name} · PORT ${port.n}`;

  const link = s.links.find((l) =>
    (l.from === deviceId && Number(l.fromPort) === portN) ||
    (l.to   === deviceId && Number(l.toPort)   === portN)
  );
  const cp = counterpartFor(s, deviceId, portN);

  // Find which LAG (if any) this port belongs to. LAGs only exist on stacks,
  // so a standalone device's ports cannot be in a LAG.
  const portStack = findStack(s, deviceId);
  const portLagInfo = findPortLag(s, deviceId, portN);
  const portLag = portLagInfo?.lag || null;
  // Sibling LAGs the user could move this port into — every LAG on the same
  // stack (if any) that doesn't already include this port.
  const otherLags = portStack
    ? (portStack.lags || []).filter((lag) => lag !== portLag && !lagHasPort(lag, deviceId, portN))
    : [];

  body.innerHTML = `
    <button type="button" class="m002-port-back" data-pact="back">← ${escSvg(typeOf(dev.type).label)} · ${escSvg(dev.name || '')}</button>
    <label class="m002-field"><span>PORT NAME</span>
      <input class="m002-pmodal-name" value="${escAttr(port.name)}" placeholder="e.g. GE0/0/1"/>
    </label>
    <div class="m002-ports-prefix m002-ports-prefix--modal" data-prefix-display${dev.portPrefix ? '' : ' hidden'}>
      <span class="m002-ports-prefix-label">auto-prefix</span>
      <code class="m002-ports-prefix-val" data-prefix-text>${escSvg(dev.portPrefix || '')}</code>
      <button type="button" class="m002-ports-prefix-clear" data-prefix-clear title="Reset prefix">✕</button>
    </div>
    <div class="m002-field">
      <span>COUNTERPART</span>
      ${(() => {
        // Counterpart is "the other end of the link this port is on". Options
        // are: (a) any port on a directly-linked non-Jump device, OR (b) any
        // port on a far-side hub-leg device reachable through a coupled JUMP.
        // Hub-tunneled options carry the via-Jump id and the far-link id so
        // the change handler can wire both legs of the hub.
        const linkedDevs = new Map();
        s.links.forEach((l) => {
          let other = null;
          if (l.from === deviceId) other = s.devices.find((d) => d.id === l.to);
          else if (l.to === deviceId) other = s.devices.find((d) => d.id === l.from);
          if (other && !linkedDevs.has(other.id)) linkedDevs.set(other.id, other);
        });
        // A port is "occupied" if some link other than the current one (link)
        // already wires it. We keep occupied ports visible *and* selectable —
        // the user may legitimately want to repurpose one — but mark them as
        // "— in use", style them grey via the .is-occupied class, and sort
        // them after the available ports so the picker is unambiguous.
        const isPortOccupied = (devId, portN) => s.links.some((l) =>
          l !== link && (
            (l.from === devId && Number(l.fromPort) === portN) ||
            (l.to   === devId && Number(l.toPort)   === portN)
          )
        );
        const opts = [];
        linkedDevs.forEach((d) => {
          if (isReference(d)) {
            const peer = couplePeer(s, d);
            if (!peer) return; // uncoupled hub: no useful counterpart
            // Far-side hub-legs (links from peer to non-Jump devices). Each
            // gives us a far device and the link object that wires it to peer.
            const farLegs = hubLocalLegs(s, peer.id);
            const farDevs = new Map();
            farLegs.forEach((fl) => {
              if (!farDevs.has(fl.device.id)) farDevs.set(fl.device.id, { dev: fl.device, link: fl.link });
            });
            farDevs.forEach(({ dev: farDev, link: farLink }) => {
              (farDev.ports || []).forEach((p) => {
                opts.push({
                  devId: farDev.id, devName: farDev.name,
                  portN: p.n, portName: p.name,
                  via: { jumpId: d.id, peerName: peer.name, farLinkId: farLink.id },
                  occupied: isPortOccupied(farDev.id, p.n),
                });
              });
            });
          } else {
            (d.ports || []).forEach((p) => opts.push({
              devId: d.id, devName: d.name, portN: p.n, portName: p.name,
              occupied: isPortOccupied(d.id, p.n),
            }));
          }
        });
        // Available first, occupied last; preserve original order within each
        // group via a stable sort.
        opts.sort((a, b) => Number(a.occupied) - Number(b.occupied));
        // Determine current selection key for highlighting.
        let curKey = '';
        if (link) {
          const otherId = link.from === deviceId ? link.to : link.from;
          const other = s.devices.find((d) => d.id === otherId);
          if (isReference(other)) {
            // Hub-leg: derive far-side selection from the far link's port-side.
            const peer = couplePeer(s, other);
            const localPortSet = (link.from === deviceId ? link.fromPort : link.toPort);
            if (peer && localPortSet) {
              const farLegs = hubLocalLegs(s, peer.id);
              const matched = farLegs.find((fl) => fl.portN);
              if (matched) curKey = 'hub:' + matched.device.id + ':' + matched.portN + ':' + matched.link.id;
            }
          } else {
            const otherPort = link.from === deviceId ? link.toPort : link.fromPort;
            if (otherPort) curKey = otherId + ':' + otherPort;
          }
        }
        if (!opts.length) return `<div class="m002-port-counter dim">— not connected —</div>`;
        return `<select class="m002-pmodal-cp">
          <option value="">— not connected —</option>
          ${opts.map((o) => {
            const key = o.via
              ? 'hub:' + o.devId + ':' + o.portN + ':' + o.via.farLinkId
              : o.devId + ':' + o.portN;
            const isCurrent = curKey === key;
            // The currently-selected counterpart for THIS port reads as
            // "occupied" (its link is in use) but it must remain selectable —
            // the user is looking at it. Only mark *other* occupied ports.
            const occupied = o.occupied && !isCurrent;
            const label = `${o.devName} · ${o.portN}${o.portName ? ' · ' + o.portName : ''}${o.via ? ' (via ' + o.via.peerName + '⇄)' : ''}${occupied ? ' — in use' : ''}`;
            const data = o.via ? ` data-via-jump="${escAttr(o.via.jumpId)}" data-far-link="${escAttr(o.via.farLinkId)}" data-far-dev="${escAttr(o.devId)}" data-far-port="${escAttr(o.portN)}"` : '';
            return `<option value="${escAttr(key)}"${data} ${isCurrent ? 'selected' : ''}${occupied ? ' class="is-occupied"' : ''}>${escSvg(label)}</option>`;
          }).join('')}
        </select>`;
      })()}
    </div>
    <div class="m002-field">
      <span>VLANS (port)</span>
      <div class="m002-vlan-picker" data-vlan-target="port:${escAttr(deviceId)}:${portN}"></div>
    </div>
    ${(() => {
      // Far-side preview: when this port is wired into a coupled-JUMP hub, show
      // the matched far port, its VLANs, and the intersection that "passes
      // through" the hub. Read-only — the user edits VLANs on each side.
      if (!link) return '';
      const otherId = link.from === deviceId ? link.to : link.from;
      const other = s.devices.find((d) => d.id === otherId);
      if (!isReference(other)) return '';
      const peer = couplePeer(s, other);
      if (!peer) return `<div class="m002-field"><span>FAR-SIDE</span><div class="m002-port-counter dim">JUMP nicht gekoppelt — kein Tunnel-Counterpart</div></div>`;
      const farLegs = hubLocalLegs(s, peer.id).filter((fl) => fl.portN);
      if (farLegs.length === 0) return `<div class="m002-field"><span>FAR-SIDE</span><div class="m002-port-counter dim">Kein Far-Side Port gewählt — Switch auf der anderen Seite konfigurieren</div></div>`;
      const fl = farLegs[0]; // 1:1 hub assumption (single far leg with port set)
      const farPort = (fl.device.ports || []).find((p) => String(p.n) === String(fl.portN));
      if (!farPort) return '';
      const localPortObj = port;
      const localVlans = (localPortObj?.vlans || []).map(String);
      const farVlans = (farPort?.vlans || []).map(String);
      const through = localVlans.filter((v) => farVlans.includes(v));
      const chip = (v, on, dim) => { const reg = (s.vlanRegistry || []).find((r) => String(r.id) === String(v)); const name = reg?.name ? ` · ${reg.name}` : ''; return `<span class="m002-vlan-chip-btn ${on ? 'on' : ''} ${dim ? 'dim' : ''}" style="--vc:${vlanColor(s, v)}" title="VLAN ${escAttr(v)}${escAttr(name)}">${escSvg(v)}</span>`; };
      return `
        <div class="m002-field">
          <span>FAR-SIDE PORT</span>
          <div class="m002-port-counter">${escSvg(fl.device.name)} · ${escSvg(farPort.name || String(farPort.n))} <span style="color:#c084fc">(via ${escSvg(other.name)}⇄${escSvg(peer.name)})</span></div>
        </div>
        <div class="m002-field">
          <span>FAR-SIDE VLANS</span>
          <div class="m002-vlan-readonly">${farVlans.length ? farVlans.map((v) => chip(v, true, false)).join('') : '<span class="m002-vlan-empty">— keine VLANs —</span>'}</div>
        </div>
        <div class="m002-field">
          <span>PASSING THROUGH</span>
          <div class="m002-vlan-readonly">${through.length ? through.map((v) => chip(v, true, false)).join('') : '<span class="m002-vlan-empty">— keine Schnittmenge —</span>'}</div>
        </div>
      `;
    })()}
    <div class="m002-field">
      <span>LAG</span>
      <div class="m002-port-lag-row">
        ${portLag ? `<span class="m002-vlan-chip-btn on" style="--vc:#ff003c" title="part of ${escAttr(portStack?.name || '')}">${escSvg(portLag.name)}</span><button type="button" class="m002-action" data-pact="lag-remove">REMOVE</button>` : ''}
        ${otherLags.length ? `<select class="m002-port-lag-select"><option value="">— assign to LAG —</option>${otherLags.map((lag) => `<option value="${escAttr(lag.id)}">${escSvg(lag.name)}</option>`).join('')}</select>` : (!portLag ? `<span class="m002-vlan-empty">${portStack ? 'no LAGs on this stack — create one in the stack inspector' : 'standalone device — LAGs require a stack'}</span>` : '')}
      </div>
    </div>
    <div class="m002-port-actions">
      ${link ? `<button type="button" class="m002-action" data-pact="unlink">DISCONNECT LINK</button>` : ''}
      <button type="button" class="m002-action danger" data-pact="delete">DELETE PORT</button>
    </div>
  `;
  renderInspectorVlanPickers(s); // also covers the port-modal's picker (it's a .m002-vlan-picker too — but inside the modal, not inspector). Re-call directly:
  body.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));

  // Port counterpart wiring. Two flavours:
  //  • Direct: rewires the symmetric link so both ends know each other.
  //  • Hub-tunnel: the option carries data-via-jump + data-far-link. We patch
  //    the local hub-leg (Switch↔Jump) AND the far hub-leg (FarSwitch↔Peer).
  body.querySelector('.m002-pmodal-cp')?.addEventListener('change', (e) => {
    const sel = e.target.options[e.target.selectedIndex];
    const v = e.target.value;
    snapshot(s);
    if (!v) {
      // Disconnect: clear our side of the local link only. Far-side stays
      // assigned (the user can clear it from the far Switch's port modal).
      if (link) {
        if (link.from === deviceId) link.fromPort = '';
        else                         link.toPort = '';
      }
    } else if (sel?.dataset.viaJump) {
      // Hub-tunneled: wire local hub-leg + far hub-leg.
      const farLinkId = sel.dataset.farLink;
      const farDevId = sel.dataset.farDev;
      const farPortN = sel.dataset.farPort;
      const jumpId = sel.dataset.viaJump;
      // Local: ensure our link points local→jump (jump-side has no port).
      let localLink = link && ((link.from === deviceId && link.to === jumpId) || (link.to === deviceId && link.from === jumpId))
        ? link
        : s.links.find((l) => (l.from === deviceId && l.to === jumpId) || (l.to === deviceId && l.from === jumpId));
      if (!localLink) { toast(s, 'Local hub-leg link missing'); return; }
      if (localLink.from === deviceId) { localLink.fromPort = String(portN); localLink.toPort = ''; }
      else                              { localLink.toPort   = String(portN); localLink.fromPort = ''; }
      // Far: set far-Switch's port on the far hub-leg link.
      const farLink = s.links.find((l) => l.id === farLinkId);
      if (farLink) {
        if (farLink.from === farDevId) { farLink.fromPort = String(farPortN); farLink.toPort = ''; }
        else                            { farLink.toPort   = String(farPortN); farLink.fromPort = ''; }
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
    // Refresh the inspector behind the modal so its port-row counterpart text
    // reflects the new wiring once the user closes the modal.
    if (s.selected?.kind === 'device' && s.selected.id === deviceId) openInspector(s);
    openPortModal(s, deviceId, portN);
  });

  // LAG wiring — LAGs live on the device's stack. A standalone device has no
  // LAGs at all.
  body.querySelector('[data-pact="lag-remove"]')?.addEventListener('click', () => {
    if (!portLag || !portStack) return;
    snapshot(s);
    portLag.ports = (portLag.ports || []).filter((p) => !(p.deviceId === deviceId && Number(p.portN) === portN));
    if (portLag.ports.length === 0) {
      portStack.lags = portStack.lags.filter((l) => l !== portLag);
    }
    schedSave(s);
    render(s);
    openPortModal(s, deviceId, portN);
  });
  body.querySelector('.m002-port-lag-select')?.addEventListener('change', (e) => {
    const lagId = e.target.value;
    if (!lagId || !portStack) return;
    const lag = (portStack.lags || []).find((l) => l.id === lagId);
    if (!lag) return;
    snapshot(s);
    if (portLag) portLag.ports = (portLag.ports || []).filter((p) => !(p.deviceId === deviceId && Number(p.portN) === portN));
    if (!lagHasPort(lag, deviceId, portN)) lag.ports.push({ deviceId, portN });
    schedSave(s);
    render(s);
    openPortModal(s, deviceId, portN);
  });

  const refreshModalPrefixHint = () => {
    const hint = body.querySelector('[data-prefix-display]');
    const txt  = body.querySelector('[data-prefix-text]');
    if (!hint || !txt) return;
    if (dev.portPrefix) { txt.textContent = dev.portPrefix; hint.hidden = false; }
    else { hint.hidden = true; }
  };
  const refreshModalDupe = () => {
    const input = body.querySelector('.m002-pmodal-name');
    if (!input) return;
    const dupes = findDuplicatePortNs(dev.ports);
    const isDupe = dupes.has(portN);
    input.classList.toggle('is-duplicate', isDupe);
    if (isDupe) input.title = 'Duplicate port name — ignored';
    else if (input.title === 'Duplicate port name — ignored') input.removeAttribute('title');
  };
  refreshModalDupe();
  body.querySelector('.m002-pmodal-name').addEventListener('focus', (e) => {
    if (!e.target.value && dev.portPrefix) {
      e.target.value = dev.portPrefix;
      port.name = dev.portPrefix;
      try { e.target.setSelectionRange(e.target.value.length, e.target.value.length); } catch {}
      const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
      if (row) row.value = port.name;
      refreshModalDupe();
      schedSave(s);
      refreshDetailViewIfSettled(s);
    }
  });
  body.querySelector('.m002-pmodal-name').addEventListener('input', (e) => {
    port.name = e.target.value;
    schedSave(s);
    s.links.filter((l) => (l.from === deviceId && Number(l.fromPort) === portN) || (l.to === deviceId && Number(l.toPort) === portN))
          .forEach((l) => redrawLink(s, l));
    const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
    if (row) row.value = port.name;
    refreshModalDupe();
    refreshDetailViewIfSettled(s);
  });
  body.querySelector('.m002-pmodal-name').addEventListener('change', (e) => {
    const expanded = commitAutoPrefixPortName(dev, e.target.value);
    if (expanded !== e.target.value) {
      e.target.value = expanded;
      port.name = expanded;
      s.links.filter((l) => (l.from === deviceId && Number(l.fromPort) === portN) || (l.to === deviceId && Number(l.toPort) === portN))
            .forEach((l) => redrawLink(s, l));
      const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
      if (row) row.value = port.name;
      refreshDetailViewIfSettled(s);
    }
    refreshModalPrefixHint();
    refreshModalDupe();
    schedSave(s);
  });
  body.querySelector('[data-prefix-clear]')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    dev.portPrefix = '';
    refreshModalPrefixHint();
    schedSave(s);
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
  body.querySelector('[data-pact="back"]')?.addEventListener('click', () => closePortModal(s));
}

function openLagModal(s, stackId, lagId) {
  const stack = findStackById(s, stackId);
  if (!stack) return;
  if (!Array.isArray(stack.lags)) stack.lags = [];
  const editing = lagId ? stack.lags.find((l) => l.id === lagId) : null;
  const initialName = editing ? editing.name : `Po${stack.lags.length + 1}`;
  const memberDevs = stack.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  const initialPortKeys = new Set(((editing && editing.ports) || []).map((p) => p.deviceId + ':' + Number(p.portN)));
  // Free ports = ports not claimed by any other sibling LAG on this stack.
  const otherLagPorts = new Set();
  (stack.lags || []).forEach((l) => {
    if (l === editing) return;
    (l.ports || []).forEach((p) => otherLagPorts.add(p.deviceId + ':' + Number(p.portN)));
  });

  const modal = s.host.querySelector('.m002-lag-modal');
  const idEl = modal.querySelector('.m002-port-modal-id');
  const body = modal.querySelector('.m002-lag-modal-body');
  idEl.textContent = `// ${stack.name} · ${editing ? 'EDIT LAG' : 'NEW LAG'}`;

  const cp = editing ? lagCounterpart(s, stack.id, editing) : null;
  const cpTxt = cp ? (cp.lag ? `${cp.stack.name} · ${cp.lag.name}` : `${cp.stack.name} · ${cp.count}p`) : '— not connected —';

  // Counterpart options: every LAG on every other stack reachable via direct
  // edges or JUMP hub-tunnels (same-zone hub-leg / coupled-peer hub-leg).
  const linkedStacks = linkedStacksFor(s, stack);
  const cpOptions = [...linkedStacks.values()].flatMap((st) =>
    (st.lags || []).map((l) => ({ stackId: st.id, stackName: st.name, lagId: l.id, lagName: l.name }))
  );
  const cpKey = editing?.counterpart?.lagId ? `${editing.counterpart.stackId}|${editing.counterpart.lagId}` : '';

  body.innerHTML = `
    <label class="m002-field"><span>NAME</span>
      <input class="m002-lagm-name" value="${escAttr(initialName)}" placeholder="e.g. Po1, LAG-CORE"/>
    </label>
    ${memberDevs.map((md) => `
      <div class="m002-field">
        <span>MEMBER PORTS · ${escSvg(md.name)} (${md.ports.length})</span>
        <div class="m002-lagm-ports">
          ${md.ports.map((p) => {
            const k = md.id + ':' + p.n;
            const inUse = otherLagPorts.has(k);
            const checked = initialPortKeys.has(k);
            return `<label class="m002-lagm-port ${inUse ? 'disabled' : ''}" title="${inUse ? 'already in another LAG' : ''}">
              <input type="checkbox" data-port="${p.n}" data-port-dev="${escAttr(md.id)}" ${checked ? 'checked' : ''} ${inUse ? 'disabled' : ''}/>
              <span>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</span>
            </label>`;
          }).join('')}
        </div>
      </div>
    `).join('')}
    ${editing ? `
      <div class="m002-field">
        <span>COUNTERPART</span>
        <div class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cpTxt)} ${editing.counterpart ? '· (manual)' : '· (auto)'}</div>
        <select class="m002-lagm-cp">
          <option value="">— auto-derive from links —</option>
          ${cpOptions.map((o) => `<option value="${escAttr(o.stackId + '|' + o.lagId)}" ${cpKey === (o.stackId + '|' + o.lagId) ? 'selected' : ''}>${escSvg(o.stackName)} · ${escSvg(o.lagName)}</option>`).join('')}
        </select>
        <p class="m002-link-hint">${cpOptions.length ? 'Pick the matching LAG on the peer stack. The other LAG will be paired automatically.' : 'No LAGs found on linked stacks — create one over there first.'}</p>
      </div>
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="lag:${escAttr(stack.id)}:${escAttr(editing.id)}"></div>
      </div>
    ` : ''}
    <div class="m002-port-actions">
      ${editing ? `<button type="button" class="m002-action danger" data-lact="delete">DELETE LAG</button>` : ''}
      <button type="button" class="m002-action" data-lact="save">${editing ? 'SAVE' : 'CREATE'}</button>
    </div>
  `;
  body.querySelectorAll('.m002-vlan-picker').forEach((el) => renderVlanPicker(s, el));
  body.querySelector('.m002-lagm-cp')?.addEventListener('change', (e) => {
    if (!editing) return;
    snapshot(s);
    if (editing.counterpart?.lagId) {
      const oldPeer = findStackLag(s, editing.counterpart.stackId, editing.counterpart.lagId);
      if (oldPeer?.lag.counterpart?.lagId === editing.id) delete oldPeer.lag.counterpart;
    }
    const v = e.target.value;
    if (!v) { delete editing.counterpart; }
    else {
      const [oStackId, oLagId] = v.split('|');
      editing.counterpart = { stackId: oStackId, lagId: oLagId };
      const peer = findStackLag(s, oStackId, oLagId);
      if (peer) peer.lag.counterpart = { stackId: stack.id, lagId: editing.id };
    }
    schedSave(s);
    render(s);
  });
  modal.hidden = false;
  setTimeout(() => body.querySelector('.m002-lagm-name')?.focus(), 30);

  body.querySelector('[data-lact="save"]')?.addEventListener('click', () => {
    const name = (body.querySelector('.m002-lagm-name').value || '').trim();
    const ports = [...body.querySelectorAll('input[type=checkbox][data-port]:checked')]
      .map((c) => ({ deviceId: c.dataset.portDev, portN: Number(c.dataset.port) }));
    if (!name) { toast(s, 'LAG needs a name'); return; }
    if (ports.length < 2) { toast(s, 'LAG needs at least 2 ports'); return; }
    snapshot(s);
    if (editing) {
      editing.name = name;
      editing.ports = ports;
    } else {
      stack.lags.push({ id: 'lag_' + rid(), name, ports, vlans: [] });
    }
    sortLagsInStack(stack);
    closeLagModal(s);
    schedSave(s);
    render(s);
    openInspector(s);
  });
  body.querySelector('[data-lact="delete"]')?.addEventListener('click', () => {
    snapshot(s);
    stack.lags = stack.lags.filter((l) => l.id !== editing.id);
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
  if (!s.portModalOpen) return;
  s.portModalOpen = null;
  // Sync the detail overlay's visual selection to the inspector state when
  // the user came in via ESC or the back button rather than clicking the
  // central element. Drop the port highlight, restore the device's.
  s.host?.querySelectorAll('.m002-detail-overlay .m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
  s.host?.querySelector('.m002-detail-overlay .m002-detail-tile.is-center')?.classList.add('is-selected');
  // Re-render the inspector for the underlying device. If the user has since
  // selected something else, openInspector picks the right body for that.
  if (s.selected) openInspector(s);
  else showInspectorEmpty(s);
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
  // Re-map stack-LAG port-refs: drop refs to the deleted port, shift later
  // port numbers down.
  s.stacks.forEach((stk) => {
    (stk.lags || []).forEach((lag) => {
      lag.ports = (lag.ports || [])
        .filter((p) => !(p.deviceId === deviceId && Number(p.portN) === portN))
        .map((p) => (p.deviceId === deviceId && Number(p.portN) > portN)
          ? { deviceId: p.deviceId, portN: Number(p.portN) - 1 }
          : p);
    });
    stk.lags = (stk.lags || []).filter((lag) => lag.ports.length > 0);
  });
  if (s.selected?.kind === 'device' && s.selected.id === deviceId) openInspector(s);
  recomputeVlanIndex(s);
  render(s);
  schedSave(s);
}

// =============================================================================
// VFX — drain on view transitions
// =============================================================================
// When something disappears on a view change, we don't pop it out — the
// bright stroke "drains" along its path so the wall looks like a pipe whose
// water flows out, leaving nothing behind. Same trick for links and for
// element walls (device rects, stack envelope rects, collapsed-stack icons).
//
// Mechanism: snapshot the visible exit-eligible <g>s before render(), clone
// any that won't be in the new render into a side group (m002-vfx-exits),
// and animate stroke-dasharray on every stroke-bearing shape inside each
// clone. The pattern "cap gap cap totalLen" with gap growing 0→L and caps
// shrinking accordingly retracts the bright section to the path endpoints.
// Texts and rect fills fade in lockstep so labels don't float over an
// emptied frame.

const VFX_DRAIN_MS = 620;

// Sequential-mode presets — drain phase fully completes before build phase
// starts, so persisting-changed elements never visually cross-fade. Two
// flavours, each tuned to the scale of the change:
//   layer   : full context shift (Physical ↔ VLAN ↔ Routing) — ceremonial,
//             generous easing, clearly readable as "old goes away, new comes in"
//   solo    : focus narrow/widen (VLAN-solo, Subnet-solo) — snappier, decisive,
//             meant to feel like a hard refocus rather than a paradigm switch
const VFX_LAYER_DRAIN_MS = 320;
const VFX_LAYER_BUILD_MS = 380;
const VFX_SOLO_DRAIN_MS  = 220;
const VFX_SOLO_BUILD_MS  = 280;

const VFX_GROUPS = [
  // Links (paths)
  { container: 'gLinks',    selector: '[data-link-id]',                       idAttr: 'data-link-id' },
  { container: 'gLinks',    selector: '[data-laglink-id]',                    idAttr: 'data-laglink-id' },
  { container: 'gLinks',    selector: '[data-agg-key]',                       idAttr: 'data-agg-key' },
  { container: 'gStacksBg', selector: '[data-stacklink-id]',                  idAttr: 'data-stacklink-id' },
  // L3 routes (subnet ribbons drawn target → gateway)
  { container: 'gL3Paths',  selector: '[data-l3-route]',                      idAttr: 'data-l3-route' },
  // Element walls (rects)
  { container: 'gDevices',  selector: '[data-device-id]',                     idAttr: 'data-device-id' },
  { container: 'gDevices',  selector: '.m002-stack-collapsed[data-stack-id]', idAttr: 'data-stack-id' },
  { container: 'gStacksBg', selector: '.m002-stack-envelope[data-stack-id]',  idAttr: 'data-stack-id' },
];

function vfxEaseInOutQuad(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function vfxEaseInQuad(t)    { return t * t; }
function vfxEaseOutQuad(t)   { return 1 - (1 - t) * (1 - t); }
function vfxEaseOutCubic(t)  { return 1 - Math.pow(1 - t, 3); }

// Solo-toggle entry point — VLAN solo, Subnet solo, and their CLEAR buttons
// all funnel through here so they share one preset (snappier than layer
// switches, but still sequential — the user reads "old fades out, new fades
// in" instead of a cross-fade morph). Hover preview keeps the plain render
// path because animating every mouseenter would strobe drain/build clones
// across the canvas during a legend sweep.
function animateSoloToggle(s) {
  vfxAnimateView(s, () => render(s), null, {
    mode: 'sequential',
    drainMs: VFX_SOLO_DRAIN_MS,
    buildMs: VFX_SOLO_BUILD_MS,
    drainEase: vfxEaseInQuad,
    buildEase: vfxEaseOutQuad,
  });
}

function vfxSnapshot(s, freeze) {
  const map = new Map();
  for (const grp of VFX_GROUPS) {
    const root = s[grp.container];
    if (!root) continue;
    root.querySelectorAll(grp.selector).forEach((el) => {
      const id = el.getAttribute(grp.idAttr);
      if (!id) return;
      // Capture the world centre NOW — `before` snapshot's els get detached by
      // render() and getBBox returns nothing on detached SVG nodes.
      const center = vfxBBoxCenterWorld(el);
      // Freeze a digest of the visual state. Combines:
      //   - computed opacity + filter: catches CSS-driven dim flips (a
      //     non-L3 device fading on entry into routing layer)
      //   - innerHTML: catches re-rendered structure (a link's VLAN stripes
      //     appearing on entry into vlan layer, or its m002-link-dim class
      //     swapping in/out on entry into routing). Without this, links
      //     never overlay-drained on layer flips because their wrapper <g>
      //     stayed at the same key and the data-l3-only opacity check
      //     skipped them entirely.
      const cs = window.getComputedStyle(el);
      const frozen = `${cs.opacity}|${cs.filter}|${el.innerHTML}`;
      // BEFORE snapshot only: stamp the BRIGHT computed visuals as inline
      // styles on the live element so the look survives a layer flip when
      // a clone is later attached into a host with the new data-active-
      // layer attribute (whose dim CSS would otherwise override). doRender
      // detaches these elements via innerHTML wipe so the inline-style
      // pollution doesn't affect anything still on screen.
      if (freeze) vfxFreezeOldLook(el);
      // Key includes the container so a stack envelope and a stack icon —
      // both keyed by data-stack-id but in different groups — don't collide.
      map.set(grp.container + '|' + grp.idAttr + '|' + id, { el, center, frozen });
    });
  }
  return map;
}

// Snapshot the BRIGHT layer's computed visual properties as inline styles
// on the wrapper + every Element descendant. Without this, a clone made
// after a layer flip (e.g. routing → vlan) and attached into a host whose
// data-active-layer matches a dim CSS rule would render in the dim
// treatment — invisible-against-the-background drain instead of the
// "drain plays in colour over the dim background" the user wants.
//
// Wrapper opacity + filter use !important because VLAN-solo unmatched-
// isolated / unmatched-adjacent dim rules use !important. Descendants'
// fill + stroke don't need !important because none of the dim child-rules
// use it; plain inline wins via inline-vs-external specificity. Skip
// stamping fill/stroke on elements that already have an inline value
// (e.g. paths with inline fill="none") to avoid overwriting load-bearing
// presentation attributes.
function vfxFreezeOldLook(wrapperEl) {
  const wcs = window.getComputedStyle(wrapperEl);
  wrapperEl.style.setProperty('opacity', wcs.opacity, 'important');
  wrapperEl.style.setProperty('filter', wcs.filter, 'important');
  wrapperEl.querySelectorAll('*').forEach((el) => {
    if (!(el instanceof Element)) return;
    const cs = window.getComputedStyle(el);
    if (!el.style.fill) el.style.fill = cs.fill;
    if (!el.style.stroke) el.style.stroke = cs.stroke;
  });
}

function vfxBBoxCenterWorld(el) {
  let bb;
  try { bb = el.getBBox(); } catch (_) { return null; }
  if (!bb || (bb.width === 0 && bb.height === 0)) return null;
  const t = el.transform?.baseVal?.consolidate?.();
  const m = t ? t.matrix : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;
  return { x: m.a * cx + m.c * cy + m.e, y: m.b * cx + m.d * cy + m.f };
}

// For a shape, decide where the bright should remain at the end of the drain
// (= where it grows from at the start of the build). Returns a "destination"
// descriptor used by vfxApplyDrain to position the surviving dash.
//   - kind 'four-mid' + w/h: closed-perimeter (rect) → 4 bright sections, one
//                            per side, each centred on its side's midpoint;
//                            symmetric, anchor-agnostic ("4 separate drains")
//   - kind 'tail'           : open path → dash anchored at end (L3 route in
//                             DRAIN phase — keeps the source→gateway flow)
//   - kind 'head'           : open path → dash anchored at start (L3 route in
//                             BUILD phase — keeps the source→gateway flow)
//   - kind 'middle'         : symmetric drain — cap-gap-cap pattern.
//                             BUILD: caps grow from both endpoints inward and
//                             meet in the middle. DRAIN: gap opens in the
//                             middle and grows outward, caps retreat to the
//                             endpoints. Used for every regular link/path so
//                             links always animate symmetrically — endpoints
//                             → middle on build, middle → endpoints on drain.
function vfxComputeDest(shapeEl, parentG, anchor, phase) {
  // L3 ribbons have an intrinsic source→gateway flow. The path is drawn in
  // that direction (start = source/target, end = gateway). On DRAIN the
  // bright clings to the gateway end and the source end empties first; on
  // BUILD the bright sprouts from the source end and grows toward the
  // gateway. Anchor is irrelevant here — the route's own direction wins.
  if (shapeEl.closest && shapeEl.closest('.m002-l3-route')) {
    return phase === 'build' ? { kind: 'head' } : { kind: 'tail' };
  }
  const tag = shapeEl.tagName.toLowerCase();
  if (tag === 'rect') {
    const w = parseFloat(shapeEl.getAttribute('width')) || 0;
    const h = parseFloat(shapeEl.getAttribute('height')) || 0;
    if (w <= 0 || h <= 0) return { kind: 'middle' };
    return { kind: 'four-mid', w, h };
  }
  // path / line / polyline / polygon — links always animate symmetrically:
  // build grows from both endpoints inward to the middle, drain empties the
  // middle first and retreats outward to the endpoints.
  return { kind: 'middle' };
}

function vfxCollectAnimatables(rootEl, anchor, phase) {
  const shapes = [];
  rootEl.querySelectorAll('path, line, polyline, polygon, rect').forEach((el) => {
    let len = 0;
    try { if (typeof el.getTotalLength === 'function') len = el.getTotalLength(); } catch (_) { len = 0; }
    if (!len) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'rect') {
        const w = parseFloat(el.getAttribute('width')) || 0;
        const h = parseFloat(el.getAttribute('height')) || 0;
        len = 2 * (w + h);
      } else if (tag === 'line') {
        const x1 = parseFloat(el.getAttribute('x1')) || 0;
        const y1 = parseFloat(el.getAttribute('y1')) || 0;
        const x2 = parseFloat(el.getAttribute('x2')) || 0;
        const y2 = parseFloat(el.getAttribute('y2')) || 0;
        len = Math.hypot(x2 - x1, y2 - y1);
      }
    }
    if (len > 0) shapes.push({ el, len, dest: vfxComputeDest(el, rootEl, anchor, phase) });
  });
  // Texts ride opacity; rect fills (the inside of the wall) ride fill-opacity
  // so a draining wall doesn't leave a filled rectangle behind.
  const fades = [];
  rootEl.querySelectorAll('text, tspan').forEach((el) => fades.push({ el, prop: 'opacity' }));
  rootEl.querySelectorAll('rect').forEach((el) => fades.push({ el, prop: 'fillOpacity' }));
  return { shapes, fades };
}

function vfxApplyDrain(parts, p, phase) {
  // p in [0..1]: 0 = full bright, 1 = fully drained.
  // The dash patterns place a single bright section anchored at the
  // destination so the bright recedes TOWARD the anchor:
  //   - 'middle':   cap-gap-cap (symmetric, no anchor)
  //   - 'head':     dash from 0 to k (bright clings to path start)
  //   - 'tail':     dash from L-k to L (bright clings to path end)
  //   - 'centered': dash of length k centered on perimeter offset .offset
  //   - 'four-mid': 4 brights, one per side, shrinking inward to midpoints
  for (const sh of parts.shapes) {
    const L = sh.len;
    const k = L * (1 - p); // surviving bright length
    const dest = sh.dest || { kind: 'middle' };
    if (dest.kind === 'middle') {
      const g = L - k;
      const c = k / 2;
      sh.el.style.strokeDasharray = `${c} ${g} ${c} ${L}`;
      sh.el.style.strokeDashoffset = '0';
    } else if (dest.kind === 'head') {
      sh.el.style.strokeDasharray = `${k} ${L}`;
      sh.el.style.strokeDashoffset = '0';
    } else if (dest.kind === 'tail') {
      sh.el.style.strokeDasharray = `${k} ${L}`;
      sh.el.style.strokeDashoffset = `${-(L - k)}`;
    } else if (dest.kind === 'centered') {
      const startPos = dest.offset - k / 2;
      sh.el.style.strokeDasharray = `${k} ${L}`;
      sh.el.style.strokeDashoffset = `${-startPos}`;
    } else if (dest.kind === 'four-mid') {
      // 4 separate brights, one per side, each centred on its side midpoint
      // and shrinking inward toward it. Going clockwise from offset 0:
      //   gap (top-left half) | top bright | corner gap | right bright |
      //   corner gap | bottom bright | corner gap | left bright | gap
      //   (back-to-top-left half)
      // With the dasharray syntax starting on a dash, we lead with a 0-length
      // dash so the first emitted segment is the leading gap.
      const w = dest.w;
      const h = dest.h;
      const wb = w * (1 - p);            // bright per top/bottom side
      const hb = h * (1 - p);            // bright per left/right side
      const wg = w * p / 2;              // half-gap on top/bottom edge
      const hg = h * p / 2;              // half-gap on left/right edge
      const cg = wg + hg;                // full corner gap (two halves merged)
      sh.el.style.strokeDasharray =
        `0 ${wg} ${wb} ${cg} ${hb} ${cg} ${wb} ${cg} ${hb} ${hg}`;
      sh.el.style.strokeDashoffset = '0';
    }
  }
  // Fill (rect interior) and text labels ride inline opacity in lockstep with
  // the dasharray drain so the wall and its label disappear AS the perimeter
  // is consumed — not via a parallel wrapper-opacity cross-fade that
  // visually competed with the drain and made elements feel like they
  // "popped" out at the end. Drop-shadow halo is killed separately on drain
  // clones (see vfxSuppressFilters) — the filter blur radius is a fixed
  // pixel value that does NOT scale with content size, so even a tiny
  // remaining bright stroke segment casts a full-size aura that lingers
  // visually on top of the otherwise nearly-empty wall and reads as a
  // "glow effect" the user does not want.
  const fadeP = 1 - p;
  for (const f of parts.fades) {
    f.el.style[f.prop] = String(fadeP);
  }
}

// Strip every drop-shadow / blur filter on a drain clone — wrapper + every
// SVG descendant. The CSS .m002-device / .m002-stack-collapsed / etc. rules
// declare drop-shadow filters with fixed-pixel blur radii; those radii do
// not scale with the source content's alpha or size, so a half-drained wall
// still casts a full-radius halo. Without this, the drain looks like the
// wall vanishes leaving a bright glowing aura behind. Builds keep their
// filters because the filter naturally renders nothing while the dasharray
// + fades are at p=1 (nothing to project a shadow from), then ramps in
// alongside the content.
function vfxSuppressFilters(el) {
  el.style.filter = 'none';
  el.querySelectorAll('*').forEach((n) => { if (n instanceof SVGElement) n.style.filter = 'none'; });
}

// Setting individual style properties to '' empties them, but Firefox keeps
// an empty `style=""` attribute on the element. The next vfxSnapshot reads
// el.innerHTML, where `style=""` vs no style attribute serializes
// differently — a digest mismatch that drags unchanged elements into the
// persisting-changed branch and triggers a spurious drain+build pair on
// the next layer toggle. Drop the attribute outright when nothing's left.
function vfxStripEmptyStyle(el) {
  if (el.style && el.style.length === 0 && el.hasAttribute('style')) {
    el.removeAttribute('style');
  }
}

function vfxResetInlineParts(parts) {
  for (const sh of parts.shapes) {
    sh.el.style.strokeDasharray = '';
    sh.el.style.strokeDashoffset = '';
    vfxStripEmptyStyle(sh.el);
  }
  for (const f of parts.fades) {
    f.el.style[f.prop] = '';
    vfxStripEmptyStyle(f.el);
  }
}

// =============================================================================
// VFX — snap-to-grid preview during drag
// =============================================================================
// When the user drags in free-move mode, a dashed outline rectangle shows
// where the element would snap on release. Renders into m002-overlay (on
// top of devices/links) so the ghost is visible even when the dragged
// element is near the snap target — otherwise the device sits in front
// and the ghost is invisible exactly when it matters most. One reusable
// rect per state, updated in place so dragging is allocation-free.

function showSnapPreview(s, snapX, snapY, accent, opts) {
  const layer = s.gOverlay;
  if (!layer) return;
  const w = opts?.width ?? DEVICE_W;
  const h = opts?.height ?? DEVICE_H;
  const offX = opts?.offsetX ?? -w / 2;
  const offY = opts?.offsetY ?? -h / 2;
  let el = s.snapPreviewEl;
  if (!el || !el.isConnected) {
    el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('class', 'm002-snap-preview');
    el.setAttribute('rx', '3');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '1');
    el.setAttribute('stroke-dasharray', '5 4');
    el.setAttribute('pointer-events', 'none');
    layer.appendChild(el);
    s.snapPreviewEl = el;
  }
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
  el.setAttribute('x', String(snapX + offX));
  el.setAttribute('y', String(snapY + offY));
  el.setAttribute('stroke', accent || '#5a5f6e');
  el.style.display = '';
}

function hideSnapPreview(s) {
  if (s.snapPreviewEl) s.snapPreviewEl.style.display = 'none';
}

// Dwell-gated entry point. Showing the ghost on every mousemove during a
// long sweep made it strobe across the canvas — it only adds value once
// the user pauses near a candidate cell. We arm a short timer per snap
// cell; reaching a different cell resets it and re-hides the preview.
const SNAP_PREVIEW_DWELL_MS = 180;
function scheduleSnapPreview(s, snapX, snapY, accent, opts) {
  const cellKey = `${snapX}|${snapY}`;
  if (s._snapPreviewKey === cellKey) {
    // Same cell as last frame — leave any pending timer / shown ghost alone.
    if (s._snapPreviewPending) {
      s._snapPreviewPending.accent = accent;
      s._snapPreviewPending.opts = opts;
    }
    // If the ghost is already on screen, refresh accent + size live so a
    // stack that grew/shrank mid-drag (member added etc.) updates without
    // having to leave + re-enter the cell.
    if (s.snapPreviewEl && s.snapPreviewEl.style.display !== 'none') {
      showSnapPreview(s, snapX, snapY, accent, opts);
    }
    return;
  }
  s._snapPreviewKey = cellKey;
  s._snapPreviewPending = { snapX, snapY, accent, opts };
  hideSnapPreview(s);
  if (s._snapPreviewTimer) clearTimeout(s._snapPreviewTimer);
  s._snapPreviewTimer = setTimeout(() => {
    s._snapPreviewTimer = null;
    const p = s._snapPreviewPending;
    if (!p) return;
    showSnapPreview(s, p.snapX, p.snapY, p.accent, p.opts);
  }, SNAP_PREVIEW_DWELL_MS);
}

function clearSnapPreview(s) {
  if (s._snapPreviewTimer) { clearTimeout(s._snapPreviewTimer); s._snapPreviewTimer = null; }
  s._snapPreviewKey = null;
  s._snapPreviewPending = null;
  hideSnapPreview(s);
}

function dragSnapAccent(s, kind, id) {
  if (kind === 'device') {
    const dev = s.devices.find((d) => d.id === id);
    return dev ? typeOf(dev.type).accent : null;
  }
  if (kind === 'stack') {
    const st = findStackById(s, id);
    return st ? typeOf(stackTypeOf(s, st)).accent : null;
  }
  return null;
}

// Size + offset for the snap-preview ghost when dragging a stack. A collapsed
// stack still occupies one device cell, so the default DEVICE_W × DEVICE_H box
// is correct. An expanded stack visually spans every member + envelope padding,
// and a single-cell ghost there underplays "this is where the whole group will
// land" — we project the current member bounding-box around the snap anchor so
// the ghost matches the shape the user is actually moving.
function stackSnapPreviewOpts(s, st) {
  if (!st || isStackCollapsed(s, st)) return undefined;
  const members = st.members.map((mid) => s.devices.find((d) => d.id === mid)).filter(Boolean);
  if (members.length < 1) return undefined;
  const padding = 18;
  const topPadExtra = 8; // matches drawStackEnvelope — label sits on the top edge
  const minRX = Math.min(...members.map((m) => m.x - st.x - DEVICE_W / 2)) - padding;
  const minRY = Math.min(...members.map((m) => m.y - st.y - DEVICE_H / 2)) - padding - topPadExtra;
  const maxRX = Math.max(...members.map((m) => m.x - st.x + DEVICE_W / 2)) + padding;
  const maxRY = Math.max(...members.map((m) => m.y - st.y + DEVICE_H / 2)) + padding;
  return {
    width: maxRX - minRX,
    height: maxRY - minRY,
    offsetX: minRX,
    offsetY: minRY,
  };
}

// =============================================================================
// VFX — grid energy pulse on element drop
// =============================================================================
// When an element lands on the grid, send out a small handful of tendrils
// that snake along grid lines away from the drop point in the element's
// accent colour. Each tendril takes a few orthogonal steps with random
// 90° turns, draws in from origin to tip, then fades — meant to read as
// the element "patching itself into" the mainframe grid behind, not as a
// big radial halo.

const VFX_PULSE_COUNT_MIN = 9;        // tendrils per drop
const VFX_PULSE_COUNT_MAX = 13;
const VFX_PULSE_SEGS_MIN = 2;         // segments per tendril
const VFX_PULSE_SEGS_MAX = 3;
const VFX_PULSE_SEG_CELLS_MIN = 2;    // cells per segment
const VFX_PULSE_SEG_CELLS_MAX = 2;
const VFX_PULSE_FILL_MS = 435;        // tendril draw-in duration
const VFX_PULSE_DRAIN_MS = 435;       // tendril drain-out duration (origin → tip)
const VFX_PULSE_STAGGER_MS = 155;     // max random per-tendril start delay
const VFX_PULSE_HEAD_R = 1.7;         // bright energy-point radius at the build head

function vfxGridPulse(s, wx, wy, color, hw, hh) {
  // Render into the dedicated pulse layer that sits BEHIND stacks/links/
  // devices, so tendrils never cover other elements.
  const layer = s.gPulse || s.gOverlay;
  if (!layer || !color) return;
  const cx = Math.round(wx / GRID) * GRID;
  const cy = Math.round(wy / GRID) * GRID;
  // Element half-extents, snapped to grid so launch points and the
  // no-return rule both work in cell units. Caller can pass an
  // expanded stack's envelope dimensions; default is the device box.
  const halfW = Math.max(GRID, Math.round((hw != null ? hw : DEVICE_W / 2) / GRID) * GRID);
  const halfH = Math.max(GRID, Math.round((hh != null ? hh : DEVICE_H / 2) / GRID) * GRID);

  const group = document.createElementNS(SVG_NS, 'g');
  group.setAttribute('class', 'm002-vfx-grid-pulse');
  group.setAttribute('pointer-events', 'none');
  group.style.color = color;
  group.style.filter = 'drop-shadow(0 0 2px currentColor)';

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  // Scale tendril count with element perimeter so a bigger box (an
  // expanded stack envelope) gets proportionally more tendrils — the
  // device baseline reads sparse on a wide stack otherwise. Capped by
  // the smallest side's launch pool so we never ask for more unique
  // start points than the perimeter can provide.
  const basePerim = DEVICE_W + DEVICE_H;
  const elemPerim = (halfW + halfH) * 2;
  const scale = Math.max(1, elemPerim / basePerim);
  const baseCount = VFX_PULSE_COUNT_MIN
    + Math.floor(Math.random() * (VFX_PULSE_COUNT_MAX - VFX_PULSE_COUNT_MIN + 1));
  const minPoolPerSide = (Math.min(halfW, halfH) / GRID) * 2 + 1;
  const count = Math.min(Math.round(baseCount * scale), minPoolPerSide * 4);
  // Distribute first-segment directions evenly across the four sides so the
  // tendrils never bunch up at a single corner. For count=12 that's 3 per
  // side; for 13 it's 4-3-3-3; etc. Order is then shuffled so successive
  // tendrils don't always fire from the same edge. Each entry stores the
  // direction index — needed below to draw a unique offset from the
  // matching per-side pool.
  const launchDirIdx = [];
  for (let i = 0; i < count; i++) launchDirIdx.push(i % 4);
  for (let i = launchDirIdx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [launchDirIdx[i], launchDirIdx[j]] = [launchDirIdx[j], launchDirIdx[i]];
  }

  // Pre-shuffled per-side pools of grid-aligned offsets. Each tendril on a
  // given side pops a fresh offset, so no two tendrils ever start from the
  // same grid intersection (which would have made them visually merge).
  // Right/left edges vary in y; top/bottom edges vary in x.
  function buildPool(maxCells) {
    const arr = [];
    for (let i = -maxCells; i <= maxCells; i++) arr.push(i * GRID);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  const pools = [
    buildPool(halfH / GRID), // 0: right edge — y offsets
    buildPool(halfH / GRID), // 1: left edge  — y offsets
    buildPool(halfW / GRID), // 2: down edge  — x offsets
    buildPool(halfW / GRID), // 3: up edge    — x offsets
  ];

  // Launch from a unique grid intersection on the perimeter edge that
  // matches the chosen first direction. The first segment then heads
  // straight out away from the element.
  function launchPoint(dirIdx) {
    const [dx, dy] = DIRS[dirIdx];
    const pool = pools[dirIdx];
    const offset = pool.length > 0 ? pool.pop() : 0;
    if (dx !== 0) return [cx + dx * halfW, cy + offset];
    return [cx + offset, cy + dy * halfH];
  }

  // After a turn, the new direction is "away from the element" iff its
  // dot product with the position-from-center vector is non-negative.
  // For axis-aligned moves this reduces to a single-axis sign check.
  function awayFromElement(x, y, ndx, ndy) {
    return ndx * (x - cx) + ndy * (y - cy) >= 0;
  }

  const tendrils = [];
  for (let i = 0; i < count; i++) {
    const dirIdx = launchDirIdx[i];
    let [dx, dy] = DIRS[dirIdx];
    let [x, y] = launchPoint(dirIdx);
    const pts = [[x, y]];
    const segs = VFX_PULSE_SEGS_MIN
      + Math.floor(Math.random() * (VFX_PULSE_SEGS_MAX - VFX_PULSE_SEGS_MIN + 1));

    for (let j = 0; j < segs; j++) {
      const cells = VFX_PULSE_SEG_CELLS_MIN
        + Math.floor(Math.random() * (VFX_PULSE_SEG_CELLS_MAX - VFX_PULSE_SEG_CELLS_MIN + 1));
      const len = cells * GRID;
      x += dx * len;
      y += dy * len;
      pts.push([x, y]);
      if (j === segs - 1) break;
      // Two perpendicular options. Pick one that doesn't head back toward
      // the element; if both are valid, random choice.
      const optA = [-dy,  dx];
      const optB = [ dy, -dx];
      const aOK = awayFromElement(x, y, optA[0], optA[1]);
      const bOK = awayFromElement(x, y, optB[0], optB[1]);
      const next = (aOK && bOK) ? (Math.random() < 0.5 ? optA : optB)
                 : aOK ? optA
                 : bOK ? optB
                 : optA; // both invalid shouldn't happen — fallback
      [dx, dy] = next;
    }

    const d = pts.map((p, k) => (k === 0 ? 'M' : 'L') + p[0] + ' ' + p[1]).join(' ');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    // Slight stroke-width jitter per tendril for an organic feel.
    path.setAttribute('stroke-width', (0.4 + Math.random() * 0.2).toFixed(2));
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('fill', 'none');
    path.style.opacity = '0';
    group.appendChild(path);

    // Bright white "energy point" that rides the leading edge during build.
    // Fill is white so it punches above the accent stroke; the parent
    // group's drop-shadow already wraps it in the accent halo.
    const head = document.createElementNS(SVG_NS, 'circle');
    head.setAttribute('r', String(VFX_PULSE_HEAD_R));
    head.setAttribute('fill', '#ffffff');
    head.setAttribute('cx', String(pts[0][0]));
    head.setAttribute('cy', String(pts[0][1]));
    head.style.opacity = '0';
    group.appendChild(head);

    // Manhattan length — every segment is grid-aligned, no diagonals.
    let totalLen = 0;
    for (let k = 1; k < pts.length; k++) {
      totalLen += Math.abs(pts[k][0] - pts[k - 1][0])
                + Math.abs(pts[k][1] - pts[k - 1][1]);
    }
    tendrils.push({
      el: path,
      head,
      totalLen,
      delay: Math.random() * VFX_PULSE_STAGGER_MS,
      peak: 0.55 + Math.random() * 0.4,
    });
  }
  layer.appendChild(group);

  const totalMs = VFX_PULSE_STAGGER_MS + VFX_PULSE_FILL_MS + VFX_PULSE_DRAIN_MS;
  const start = performance.now();

  function step(now) {
    const t = now - start;
    if (t >= totalMs) { group.remove(); return; }
    for (const tn of tendrils) {
      const local = t - tn.delay;
      const L = tn.totalLen;
      if (local < 0) {
        tn.el.style.opacity = '0';
        tn.el.style.strokeDasharray = `0 ${L}`;
        tn.head.style.opacity = '0';
        continue;
      }
      if (local < VFX_PULSE_FILL_MS) {
        // Build: head extends from element-side origin out to the tip.
        // Visible portion is [0, k], so a single dash of length k.
        const fillP = local / VFX_PULSE_FILL_MS;
        const k = L * fillP;
        tn.el.style.strokeDasharray = `${k} ${L}`;
        tn.el.style.strokeDashoffset = '0';
        tn.el.style.opacity = String(fillP * tn.peak);
        // Energy-point rides the leading edge. Quick fade-in over the
        // first ~50ms (so it doesn't pop in mid-stride), then fades out
        // over the last quarter as it docks at the tip.
        try {
          const p = tn.el.getPointAtLength(k);
          tn.head.setAttribute('cx', String(p.x));
          tn.head.setAttribute('cy', String(p.y));
        } catch (_) { /* getPointAtLength can throw on degenerate paths */ }
        const headIn = local < 50 ? local / 50 : 1;
        const headOut = Math.min(1, (1 - fillP) * 4);
        tn.head.style.opacity = String(Math.min(headIn, headOut));
      } else if (local < VFX_PULSE_FILL_MS + VFX_PULSE_DRAIN_MS) {
        // Drain: bright recedes FROM the element-side origin TOWARD the
        // tip. Visible portion is [drainP * L, L]. Dasharray pattern is
        // (0-dash, gap to start of visible, dash to end, big gap) so the
        // first emitted segment is the leading gap.
        const drainP = (local - VFX_PULSE_FILL_MS) / VFX_PULSE_DRAIN_MS;
        const gap = L * drainP;
        const dash = L * (1 - drainP);
        tn.el.style.strokeDasharray = `0 ${gap} ${dash} ${L * 2}`;
        tn.el.style.strokeDashoffset = '0';
        tn.el.style.opacity = String(tn.peak);
        tn.head.style.opacity = '0';
      } else {
        tn.el.style.opacity = '0';
        tn.head.style.opacity = '0';
      }
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function vfxFrozenOpacity(entry) {
  // Pull the leading opacity component out of the frozen digest. Falls back
  // to 1 when no digest was captured.
  const f = entry?.frozen || '';
  const v = parseFloat((f.split('|')[0] || '1'));
  return Number.isFinite(v) ? v : 1;
}

function vfxCentroid(snapshot) {
  let cx = 0, cy = 0, n = 0;
  for (const [, entry] of snapshot) {
    const c = entry.center;
    if (!c) continue;
    cx += c.x; cy += c.y; n++;
  }
  return n > 0 ? { x: cx / n, y: cy / n } : null;
}

// opts (all optional):
//   mode        : 'parallel' (default — drain + build overlap on one timeline,
//                  used by zone hops where the camera pan masks the cross-fade)
//                 'sequential' — drain runs to completion FIRST, then build
//                  starts. Eliminates the visual cross-fade that made
//                  persisting-changed elements look like they "morphed"
//                  instead of leaving + arriving. Required for view-mode
//                  changes (Physical/VLAN/Routing) and Solo-toggles where
//                  the user reads the transition as a deliberate switch.
//   drainMs     : drain phase duration (default VFX_DRAIN_MS for parallel,
//                  preset-specific for sequential — see VFX_LAYER_*/VFX_SOLO_*)
//   buildMs     : build phase duration (sequential only)
//   drainEase   : easing for drain progress (default vfxEaseInOutQuad)
//   buildEase   : easing for build progress (default vfxEaseInOutQuad)
function vfxAnimateView(s, doRender, anchor, opts) {
  if (!s.gExits) { doRender(); return; }
  // A prior transition may still be mid-flight: build elements carry inline
  // opacity / dasharray that would poison the next `before` snapshot's digest
  // (cs.opacity + innerHTML), making unchanged elements look "changed" and
  // triggering a spurious drain+build on top of the next view. Snap any
  // in-flight builds to their finished state and drop their drains so the
  // snapshot reads CSS-derived values only.
  if (s._vfxFinish) s._vfxFinish();
  // Wipe any in-flight clones from a previous switch so we don't stack them.
  s.gExits.innerHTML = '';

  const o = opts || {};
  const sequential = o.mode === 'sequential';
  const drainMs    = Math.max(1, o.drainMs ?? VFX_DRAIN_MS);
  const buildMs    = Math.max(1, o.buildMs ?? VFX_DRAIN_MS);
  const drainEase  = o.drainEase || vfxEaseInOutQuad;
  const buildEase  = o.buildEase || vfxEaseInOutQuad;
  // BEFORE: freeze=true stamps the BRIGHT layer's look as inline styles on
  // the live elements so the about-to-be-cloned drain shapes survive the
  // layer flip without picking up the new layer's dim CSS treatment.
  // AFTER: freeze=false leaves the freshly-rendered new look CSS-driven so
  // the build animation grows IN the new dim treatment (e.g. .45 opacity
  // for routing-dimmed envelopes) — exactly what the user sees behind the
  // colour-drain overlay.
  const before = vfxSnapshot(s, true);
  doRender();
  const after = vfxSnapshot(s, false);

  // Anchor for directional drain. Explicit point wins (e.g. clicked Jump's
  // world position). Otherwise the centroid of persisting elements; if none
  // persists, the centroid of the new view; if that's also empty, no anchor
  // and the drain falls back to the symmetric cap-gap-cap from the middle.
  const persisting = new Map();
  for (const [k, entry] of after) if (before.has(k)) persisting.set(k, entry);
  const drainAnchor = anchor || vfxCentroid(persisting) || vfxCentroid(after) || vfxCentroid(before);
  const buildAnchor = anchor || vfxCentroid(persisting) || vfxCentroid(before) || vfxCentroid(after);

  // EXITS — clone old element, drain it, remove. Wrapper opacity is pinned
  // to the snapshot's frozen value (so a dimmed clone stays dimmed) but does
  // NOT fade — the dasharray + inline fill/text opacity inside vfxApplyDrain
  // own the disappearance, so the drain itself consumes the element instead
  // of a parallel wrapper-opacity cross-fade competing with it.
  const drains = [];
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    const clone = entry.el.cloneNode(true);
    clone.style.pointerEvents = 'none';
    // Strip the live link-flow overlay — its stroke-dashoffset would fight ours.
    clone.querySelectorAll('.m002-link-flow').forEach((n) => n.remove());
    s.gExits.appendChild(clone);
    const parts = vfxCollectAnimatables(clone, drainAnchor, 'drain');
    if (parts.shapes.length === 0 && parts.fades.length === 0) { clone.remove(); continue; }
    clone.style.opacity = String(vfxFrozenOpacity(entry));
    vfxSuppressFilters(clone);
    drains.push({ clone, parts });
  }

  // BUILDS — fresh element in its real container, build it up from empty.
  // Wrapper opacity is left to CSS; the dasharray + inline fades inside
  // vfxApplyDrain make the new element invisible at frame 0 (gap = full
  // perimeter, fillOpacity = 0, text opacity = 0) and grow it back in.
  // No filter suppression on builds: with the global glow-kill CSS block
  // (v2.33.26) there are no drop-shadow halos to suppress anyway, and
  // overriding `style.filter = 'none'` here would clobber legit layer-dim
  // filters like `saturate(0) brightness(.55)` — which caused a brief
  // "lighter dim" flash at end of animation before finish() restored CSS.
  const builds = [];
  for (const [key, entry] of after) {
    if (before.has(key)) continue;
    const newEl = entry.el;
    const parts = vfxCollectAnimatables(newEl, buildAnchor, 'build');
    if (parts.shapes.length === 0 && parts.fades.length === 0) continue;
    builds.push({ el: newEl, parts });
  }

  // PERSISTING with changed look (e.g. layer flip dimmed a non-L3 device, or
  // a link's VLAN stripes appeared) — overlay-drain the OLD clone on top
  // AND build the NEW underlying element so both halves of the transition
  // animate in parallel: bright drains away while dim/new look builds up.
  for (const [key, oldEntry] of before) {
    const newEntry = after.get(key);
    if (!newEntry) continue;
    if (!oldEntry.frozen || oldEntry.frozen === newEntry.frozen) continue;

    // Overlay-drain the OLD look on top of the new render. Wrapper opacity
    // is pinned to the frozen snapshot value; disappearance comes from the
    // dasharray + inline fades inside vfxApplyDrain.
    const clone = oldEntry.el.cloneNode(true);
    clone.style.pointerEvents = 'none';
    clone.style.opacity = String(vfxFrozenOpacity(oldEntry));
    clone.querySelectorAll('.m002-link-flow').forEach((n) => n.remove());
    s.gExits.appendChild(clone);
    const drainParts = vfxCollectAnimatables(clone, drainAnchor, 'drain');
    if (drainParts.shapes.length > 0 || drainParts.fades.length > 0) {
      vfxSuppressFilters(clone);
      drains.push({ clone, parts: drainParts });
    } else {
      clone.remove();
    }

    // Build up the NEW look on the underlying real element. Same machinery
    // as fresh-entry builds — wrapper opacity stays at CSS target; dasharray
    // + inline fades grow the element into view. CSS-driven filter is left
    // alone so layer-dim treatments (saturate(0) brightness(.55)) apply
    // continuously instead of snapping in at end-of-animation.
    const newEl = newEntry.el;
    const buildParts = vfxCollectAnimatables(newEl, buildAnchor, 'build');
    if (buildParts.shapes.length > 0 || buildParts.fades.length > 0) {
      builds.push({ el: newEl, parts: buildParts });
    }
  }

  if (drains.length === 0 && builds.length === 0) return;

  // Paint frame 0 immediately so neither exits nor builds flash for a frame
  // before the first rAF tick lands.
  for (const d of drains) vfxApplyDrain(d.parts, 0, 'drain'); // exits start full
  for (const b of builds) vfxApplyDrain(b.parts, 1, 'build'); // builds start empty

  // Cleanup that snaps the animation to its final state. Stored on s so a
  // follow-up vfxAnimateView (e.g. layer toggle right after a zone jump) can
  // call it before snapshotting, ensuring the digest reads CSS-derived values
  // instead of mid-fade inline noise.
  let finished = false;
  let drainsRemoved = false;
  function removeDrainClones() {
    if (drainsRemoved) return;
    drainsRemoved = true;
    for (const d of drains) d.clone.remove();
  }
  function finish() {
    if (finished) return;
    finished = true;
    removeDrainClones();
    for (const b of builds) {
      vfxResetInlineParts(b.parts);
    }
    if (s._vfxFinish === finish) s._vfxFinish = null;
  }
  s._vfxFinish = finish;

  const start = performance.now();
  if (sequential) {
    // Sequential timeline:
    //   phase A (drain), 0..drainMs        — drain runs 0→1, builds stay at p=1 (empty)
    //   phase B (build), drainMs..drain+buildMs — drains snap to finished + clones
    //                                          removed, builds run 1→0
    // Net effect: the old element fully vanishes BEFORE the new element begins
    // to materialise. Persisting-changed elements (e.g. a non-L3 device dimming
    // when entering Routing) read as a clean swap instead of a cross-fade morph.
    const totalMs = drainMs + buildMs;
    function step(now) {
      if (finished) return;
      const elapsed = now - start;
      if (elapsed < drainMs) {
        const e = drainEase(Math.min(1, elapsed / drainMs));
        for (const d of drains) vfxApplyDrain(d.parts, e, 'drain');
        // Builds remain at p=1 (set in frame-0 paint above) — no per-frame cost.
        requestAnimationFrame(step);
        return;
      }
      // Crossed into build phase. Snap drains to fully drained + drop clones
      // exactly once so they don't keep eating per-frame work or paint.
      if (!drainsRemoved) {
        for (const d of drains) vfxApplyDrain(d.parts, 1, 'drain');
        removeDrainClones();
      }
      if (elapsed >= totalMs) { finish(); return; }
      const e = buildEase(Math.min(1, (elapsed - drainMs) / buildMs));
      for (const b of builds) vfxApplyDrain(b.parts, 1 - e, 'build');
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  } else {
    function step(now) {
      if (finished) return;
      const t = Math.min(1, (now - start) / drainMs);
      const e = drainEase(t);
      for (const d of drains) vfxApplyDrain(d.parts, e, 'drain');
      for (const b of builds) vfxApplyDrain(b.parts, 1 - e, 'build');
      if (t < 1) { requestAnimationFrame(step); return; }
      finish();
    }
    requestAnimationFrame(step);
  }
}

// =============================================================================
// Render — full redraw (used after layer toggle / load / delete)
// =============================================================================
function render(s) {
  recomputeVlanIndex(s);
  recomputeSubnetIndex(s);
  renderLegend(s);
  renderSubnetLegend(s);
  invalidateEdgeSlots(s);
  s._dgwWinners = null;
  // VLAN-solo per-render context cache — drop so neighbor + carrier maps
  // rebuild against the current device/link snapshot.
  s._vlanSoloCtx = null;
  // Same story for the routing-layer subnet-solo context.
  s._subnetSoloCtx = null;
  // Recompute which stacks the routing-solo filter forces collapsed before
  // anything reads isStackCollapsed below. Called every render so a filter
  // change (legend click / clear / layer toggle / hydrate) immediately
  // produces the right collapse-state without separate wiring per call site.
  applySubnetSoloStackCollapse(s);
  s.gStacksBg.innerHTML = '';
  s.gDevices.innerHTML = '';
  s.gLinks.innerHTML = '';

  // Filter by active zone — devices/stacks/links outside the active zone hide.
  const inZone = (entity) => !s.activeZone || !entity.zone || entity.zone === s.activeZone;

  // Stack envelopes (only when expanded)
  s.stacks.forEach((st) => { if (inZone(st) && !isStackCollapsed(s, st)) drawStackEnvelope(s, st); });

  // Detect explicit LAG pairs (counterpart set on at least one side). When
  // BOTH stacks are collapsed the underlying port-links are absorbed and
  // rendered as a single LAG-pair double-line. When at least one side is
  // expanded, we draw nothing for the LAG itself — the user sees the actual
  // physical port-links between the members, with a port-side badge marking
  // their LAG membership.
  const lagPairs = [];
  const lagPairSeen = new Set();
  s.stacks.forEach((stA) => {
    (stA.lags || []).forEach((lag) => {
      if (!lag.counterpart?.lagId) return;
      const peer = findStackLag(s, lag.counterpart.stackId, lag.counterpart.lagId);
      if (!peer) return;
      const key = [stA.id + ':' + lag.id, peer.stack.id + ':' + peer.lag.id].sort().join('::');
      if (lagPairSeen.has(key)) return;
      lagPairSeen.add(key);
      lagPairs.push({ stackA: stA, lagA: lag, stackB: peer.stack, lagB: peer.lag });
    });
  });
  const absorbed = computeAbsorbedLinkIds(s);
  // computeAbsorbedLinkIds also populates s._hubTunnelRep with the chosen
  // representative link per cross-zone LAG-pair group; drawLink consults it
  // to render the LAG-pair visual on that single link.
  // Stack-pair aggregations: every non-paired-LAG link involving at least
  // one collapsed stack collapses into one summary line. Replaces the
  // per-link / non-paired-LAG-bundle visuals between collapsed stacks.
  const aggregations = computeStackPairAggregations(s, absorbed);
  const aggregatedLinkIds = new Set();
  aggregations.forEach((agg) => agg.linkIds.forEach((id) => aggregatedLinkIds.add(id)));
  s._bundleByLink = null;
  s.links.forEach((l) => {
    if (absorbed.has(l.id)) return;
    if (aggregatedLinkIds.has(l.id)) return;
    const a = s.devices.find((d) => d.id === l.from);
    const b = s.devices.find((d) => d.id === l.to);
    if (!a || !b) return;
    if (!inZone(a) || !inZone(b)) return;
    drawLink(s, l);
  });

  // Stack-pair aggregation summary lines.
  aggregations.forEach((agg, key) => {
    const aPos = aggEndpointPos(s, agg.aSide);
    const bPos = aggEndpointPos(s, agg.bSide);
    if (!aPos || !bPos) return;
    drawStackPairAggregate(s, key, agg, aPos, bPos);
  });

  // Explicit LAG-pair links — drawn after regular links so they sit on top.
  // Skip when either side is expanded, so the user sees the underlying member
  // port-links instead of a synthetic stack-to-stack double-line. Cross-zone
  // LAG-pairs (bonded via a JUMP couple) likewise skip the stack-to-stack
  // line — the LAG visualization terminates at the in-zone JUMP via the
  // bundled hub-leg link, not at the peer stack's coords in the other zone.
  lagPairs.forEach((p) => {
    if (!inZone(p.stackA) || !inZone(p.stackB)) return;
    if ((p.stackA.zone || null) !== (p.stackB.zone || null)) return;
    if (!isStackCollapsed(s, p.stackA) || !isStackCollapsed(s, p.stackB)) return;
    drawLagLink(s, p);
  });

  // Members of collapsed stacks are not drawn as individual devices.
  const hidden = new Set();
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st)) st.members.forEach((m) => hidden.add(m)); });
  s.devices.forEach((d) => { if (!hidden.has(d.id) && inZone(d)) drawDevice(s, d); });

  // Collapsed stack icons drawn last so they sit on top.
  s.stacks.forEach((st) => { if (isStackCollapsed(s, st) && inZone(st)) drawCollapsedStack(s, st); });

  // L3 ribbons — smooth subnet-coloured curves between every L3 pair, drawn
  // into a dedicated layer so they float above L2 wiring without tracing it.
  drawL3Paths(s);

  markSelected(s);
  updateStatus(s);
  renderMinimap(s);
  refreshDetailViewIfSettled(s);
}

// Re-render the Detail-View overlay if it's open AND past its choreographed
// entry (~1100ms after enterDetailView). Called from render() and from live
// input handlers in the inspector so edits propagate without the user having
// to close and reopen detail. Pre-settled, the entry animation is still in
// flight and rerendering would restart it — we skip.
function refreshDetailViewIfSettled(s) {
  if (!s.detailDeviceId) return;
  const overlay = s.host?.querySelector('.m002-detail-overlay');
  if (overlay?.classList.contains('m002-detail-overlay-settled')) {
    renderDetailView(s);
  }
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
// Detail-View — drill-down on a single element.
//   Doubleclick a device → smooth-zoom to it → dedicated overlay shows the
//   element large with all its ports (uplinks top / access bottom). ESC or the
//   "← MAP" button restores the prior viewport. Body content is rendered by
//   renderDetailView() and grows in later versions (v2.21.1+).
// =============================================================================
// Detail-View animation timings. The map zoom runs in the background and the
// overlay fade-in stacks on top with a brief lead so the camera move plants
// the user before the panel scales in. Camera easing is `easeOutCubic` (JS)
// — visible motion immediately, gentle deceleration as it lands. The earlier
// easeInOutCubic at 600ms was so smooth at the start (0.4% motion in the
// first 60ms) that the entry read as "no animation"; easeOutCubic restores
// perceptible transit while still staying away from the lurch character of
// the original easeOutExpo.
const DETAIL_ANIM_MS       = 350;
const DETAIL_ENTER_MS      = 500;
const DETAIL_FADE_OUT_MS   = 190;
const DETAIL_TARGET_ZOOM   = 1.6;

function enterDetailView(s, deviceId) {
  const dev = s.devices.find((d) => d.id === deviceId);
  if (!dev) return;
  if (s.detailDeviceId === deviceId) return;
  // Make sure the inspector context matches what the overlay is showing — the
  // user can click a port and see its detail next to the canvas without
  // ambiguity about which device the port belongs to.
  if (!(s.selected?.kind === 'device' && s.selected.id === deviceId)) {
    select(s, 'device', deviceId);
  }
  s._viewBeforeDetail = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  s.detailDeviceId = deviceId;
  const rect = s.svg.getBoundingClientRect();
  const targetZoom = DETAIL_TARGET_ZOOM;
  const targetX = rect.width / 2 - dev.x * targetZoom;
  const targetY = rect.height / 2 - dev.y * targetZoom;
  animateView(s, { x: targetX, y: targetY, zoom: targetZoom }, DETAIL_ENTER_MS);
  const overlay = s.host.querySelector('.m002-detail-overlay');
  if (overlay) {
    overlay.classList.remove('m002-detail-overlay-settled');
    renderDetailView(s);
    overlay.hidden = false;
    // Force a style/layout flush before flipping the show class so the
    // opacity transition actually runs (rAF can miss when the tab is
    // backgrounded; reading offsetHeight is reliable in every environment).
    void overlay.offsetHeight;
    overlay.classList.add('m002-detail-overlay-show');
    // After the choreographed entry finishes (~1050ms), mark the overlay as
    // "settled" so subsequent edits anywhere can rerender the detail body
    // without re-triggering the entry animation.
    if (s._detailSettleTimer) clearTimeout(s._detailSettleTimer);
    s._detailSettleTimer = setTimeout(() => {
      if (s.detailDeviceId === deviceId) overlay.classList.add('m002-detail-overlay-settled');
    }, 1100);
  }
  setMode(s, 'DETAIL');
}

// Detail-View exit choreography (v2.34 Push B). Mirrors the entry — the
// central tile collapses point-by-point in reverse, peers + ports + stubs
// + peer-links fade out in parallel ahead of it. Total exit window ~700ms;
// the camera tween (350ms) lands well before that.
//   t = 0    — overlay-leaving lands; settled is removed so leaving's
//              !important rules can drive transform/animation; centre
//              tile collapses with a 200ms delay + 480ms duration so it's
//              the last visual to vanish.
//   t = 500  — opacity fade kicks in (drop overlay-show); the .show
//              transition takes 190ms via the existing CSS rule.
//   t = 700  — overlay hidden, leaving class cleared, ready for re-entry.
const DETAIL_LEAVING_INNER_MS = 700;
const DETAIL_LEAVING_OPACITY_AT = 500;

function exitDetailView(s) {
  if (!s.detailDeviceId) return;
  s.detailDeviceId = null;
  if (s._detailSettleTimer) { clearTimeout(s._detailSettleTimer); s._detailSettleTimer = null; }
  const overlay = s.host.querySelector('.m002-detail-overlay');
  if (overlay) {
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      // Snap exit — no choreography, just opacity fade.
      overlay.classList.remove('m002-detail-overlay-show');
      overlay.classList.remove('m002-detail-overlay-settled');
      setTimeout(() => {
        if (!s.detailDeviceId) {
          overlay.hidden = true;
          overlay.classList.remove('m002-detail-overlay-leaving');
        }
      }, DETAIL_FADE_OUT_MS);
    } else {
      // Full reverse-emerge. Drop settled FIRST so the leaving rules can
      // override the !important pins on tile-inner / tile-bg.
      overlay.classList.remove('m002-detail-overlay-settled');
      overlay.classList.add('m002-detail-overlay-leaving');
      setTimeout(() => {
        if (!s.detailDeviceId) overlay.classList.remove('m002-detail-overlay-show');
      }, DETAIL_LEAVING_OPACITY_AT);
      setTimeout(() => {
        if (!s.detailDeviceId) {
          overlay.hidden = true;
          overlay.classList.remove('m002-detail-overlay-leaving');
        }
      }, DETAIL_LEAVING_INNER_MS);
    }
  }
  if (s._viewBeforeDetail) {
    animateView(s, s._viewBeforeDetail, DETAIL_ANIM_MS);
    s._viewBeforeDetail = null;
  }
  setMode(s, s.linkMode ? 'LINK · pick first node' : (s.deleteMode ? 'DELETE · click anything to remove' : 'SELECT'));
}

// Port classification for the Detail-View. A port that links to a non-endpoint
// device (switch/router/firewall/cloud/JUMP) counts as UPLINK; everything
// else — including unlinked ports and links to endpoints — counts as ACCESS.
function classifyDetailPort(s, dev, portN) {
  const link = s.links.find((l) =>
    (l.from === dev.id && Number(l.fromPort) === portN) ||
    (l.to === dev.id && Number(l.toPort) === portN)
  );
  if (!link) return { kind: 'access', occupied: false, peer: null, link: null };
  const peerId = link.from === dev.id ? link.to : link.from;
  const peer = s.devices.find((d) => d.id === peerId) || null;
  const isUplink = peer && peer.type !== 'endpoint';
  return { kind: isUplink ? 'uplink' : 'access', occupied: true, peer, link };
}

// Unified tile dimensions. Every visible device in the Detail-View — the
// central element AND every uplink peer — uses the same intrinsic 144×96
// markup so a Position-Swap hop can animate the SAME DOM node between
// slots without crossfading content. The center slot scales the tile up
// via CSS to read as the "current focus"; peer slots stay 1×.
const DETAIL = {
  port: { w: 44, h: 52 },
  gap: 6,
  // Tile geometry — center and peers share these intrinsic dimensions.
  // Scale factor differentiates the role: center renders at 1.875× (270×
  // 180, matching the previous central element's height), peers at 1×
  // (144×96, matching the previous peer-tile size).
  tile: { w: 144, h: 96 },
  centerScale: 1.875,
  // Backwards-compat alias: a few grep-y references were kept for the
  // legacy device-only call sites that still survive (e.g. computeDetail
  // Layout in archived code paths). The .h field is the only thing
  // queried; .w is unused now that tiles are uniform.
  device: { w: 270, h: 180 },
  peer: { w: 144, h: 96 },
  peerGap: 28,
  // Vertical breathing room between the peer-tile row and the uplink-port
  // row. Long enough that a Z-bend in the connecting link reads cleanly,
  // short enough that the eye still groups the peer with its port.
  peerLinkGap: 64,
  vgap: 32,
  pad: 48,
  maxCols: 24,
  // FLIP transition timing for the position-swap hop. 480ms reads as a
  // deliberate move (faster than the legacy 600ms WAAPI fly because the
  // user's eye no longer has to bridge a fade-out/respawn gap); 0ms is
  // applied via .m002-no-transition for the "set old position back"
  // (INVERT) phase.
  flipMs: 480,
};

// Compact peer label that fits a small port box (e.g. SWITCH-02 → "S2",
// ENDPOINT-01 → "E1", ROUTER-01 → "R1", JUMP → "J"). Falls back to first
// initial when the peer name has no numeric suffix.
function abbrPeer(peer) {
  if (!peer) return '';
  const head = (peer.type || '?').charAt(0).toUpperCase();
  const m = String(peer.name || '').match(/(\d+)\s*$/);
  return head + (m ? m[1].replace(/^0+/, '') || m[1] : '');
}

// =============================================================================
// Detail-View frame — managed-DOM rendering with persistent tiles.
//   computeDetailFrame(s, dev)   — pure: returns positions for tiles, ports,
//                                  links, and total SVG dimensions for `dev`
//                                  as the centre.
//   syncDetailFrame(s, frame)    — diff: ensures the SVG structure exists,
//                                  creates new tile <g>s for first-time peers,
//                                  removes tiles no longer in scope, leaves
//                                  surviving tiles' DOM nodes untouched
//                                  (their text content + selection class
//                                  state get refreshed), rebuilds ports +
//                                  links from scratch.
//   applyDetailLayout(s, frame, opts)
//                                — writes --layout-x/-y/-scale onto each
//                                  tile so CSS positions it. With opts.flip,
//                                  pre-captured oldRects drive the inverse
//                                  transform that lets a paired rAF clear
//                                  produce a smooth Position-Swap motion.
// =============================================================================
function renderDetailView(s) {
  const overlay = s.host.querySelector('.m002-detail-overlay');
  if (!overlay) return;
  const dev = s.devices.find((d) => d.id === s.detailDeviceId);
  if (!dev) return;
  const t = typeOf(dev.type);
  const titleEl = overlay.querySelector('.m002-detail-title');
  if (titleEl) titleEl.textContent = `// ${t.label} · ${dev.name || '—'}`;
  const body = overlay.querySelector('.m002-detail-body');
  if (!body) return;
  const frame = computeDetailFrame(s, dev);
  syncDetailFrame(s, body, frame);
  applyDetailLayout(s, frame, { animate: false });
}

// Pure layout computation. Returns everything any consumer (sync, hop,
// stand-alone external readers) might need. `tilePositions` is the source
// of truth for slot assignment — its first entry is the centre, the rest
// are the peer row in left-to-right display order.
function computeDetailFrame(s, dev) {
  const cls = (dev.ports || []).map((p) => ({ p, info: classifyDetailPort(s, dev, p.n) }));
  const uplinks = cls.filter((c) => c.info.kind === 'uplink');
  const access  = cls.filter((c) => c.info.kind === 'access');

  // Unique uplink peers, in port-order (so LAG'd ports group naturally).
  const peerOrder = [];
  const peerSeen = new Set();
  uplinks.forEach((c) => {
    const peer = c.info.peer;
    if (peer && !peerSeen.has(peer.id)) { peerSeen.add(peer.id); peerOrder.push(peer); }
  });

  const D = DETAIL;
  const rowW = (n) => n <= 0 ? 0 : n * D.port.w + (n - 1) * D.gap;
  const upCount = Math.min(D.maxCols, uplinks.length);
  const acCols  = Math.min(D.maxCols, Math.max(1, access.length));
  const acRows  = Math.max(1, Math.ceil(access.length / D.maxCols));
  const upW     = rowW(upCount);
  const acW     = access.length ? rowW(acCols) : 0;

  const peerCount = peerOrder.length;
  const peerRowW  = peerCount ? peerCount * D.tile.w + (peerCount - 1) * D.peerGap : 0;
  const centerW   = D.tile.w * D.centerScale;
  const centerH   = D.tile.h * D.centerScale;

  const innerW = Math.max(centerW, peerRowW, upW, acW);
  const totalW = innerW + D.pad * 2;

  const STUB_LEN = (D.vgap - 8) * 5;
  const stubPad  = STUB_LEN + 12;
  const upPad    = D.pad;
  const dnPad    = access.length ? Math.max(D.pad, stubPad) : D.pad;

  const peerRowH = peerCount ? D.tile.h + D.peerLinkGap : 0;
  const upRowH   = uplinks.length ? D.port.h + D.vgap : 0;
  const acRowsH  = access.length  ? acRows * D.port.h + (acRows - 1) * D.gap + D.vgap : 0;
  const totalH   = upPad + peerRowH + upRowH + centerH + acRowsH + dnPad;

  const cx = totalW / 2;
  const peerRowTopY = upPad;
  const peerCenterY = peerRowTopY + D.tile.h / 2;
  const upY      = peerRowTopY + peerRowH;
  const centerTopY = upY + upRowH;
  const centerY = centerTopY + centerH / 2;
  const acStartY = centerTopY + centerH + D.vgap;

  // Tile slots: centre first, peers in left-to-right order.
  const tilePositions = new Map();
  tilePositions.set(dev.id, {
    deviceId: dev.id,
    role: 'center',
    x: cx,
    y: centerY,
    scale: D.centerScale,
  });
  if (peerCount) {
    const startX = cx - peerRowW / 2;
    peerOrder.forEach((peer, i) => {
      const pcx = startX + D.tile.w / 2 + i * (D.tile.w + D.peerGap);
      tilePositions.set(peer.id, {
        deviceId: peer.id,
        role: 'peer',
        x: pcx,
        y: peerCenterY,
        scale: 1,
      });
    });
  }

  return {
    centerDev: dev,
    cls, uplinks, access,
    peerOrder,
    tilePositions,
    totalW, totalH,
    cx, upY, acStartY,
    upW, acRows,
    STUB_LEN,
  };
}

// Tile DOM lifecycle. Surviving tiles keep their <g> node; removed tiles
// are detached; new tiles are created in the tiles-group. Returns the
// list of new tile-ids (so the hop can opt them into a fade-in instead of
// a FLIP transition).
function syncDetailFrame(s, body, frame) {
  // Ensure structural skeleton — built once per body reuse, kept across
  // re-renders + hops so tiles persist.
  let svg = body.querySelector('.m002-detail-svg');
  if (!svg) {
    body.innerHTML = `
      <svg class="m002-detail-svg" preserveAspectRatio="xMidYMid meet">
        <defs class="m002-detail-defs"></defs>
        <g class="m002-detail-links-group"></g>
        <g class="m002-detail-tiles-group"></g>
        <g class="m002-detail-ports-group"></g>
      </svg>
    `;
    svg = body.querySelector('.m002-detail-svg');
  }
  svg.setAttribute('viewBox', `0 0 ${frame.totalW} ${frame.totalH}`);
  svg.setAttribute('width',  frame.totalW);
  svg.setAttribute('height', frame.totalH);

  // Defs (gradient stubs) reflect the current centre's accent.
  const t = typeOf(frame.centerDev.type);
  const defs = svg.querySelector('.m002-detail-defs');
  defs.innerHTML = `
    <linearGradient id="m002-stub-up" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${t.accent}" stop-opacity="0"/>
      <stop offset="1" stop-color="${t.accent}" stop-opacity="0.55"/>
    </linearGradient>
    <linearGradient id="m002-stub-down" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${t.accent}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${t.accent}" stop-opacity="0"/>
    </linearGradient>
  `;

  // Tile diff
  const tilesGroup = svg.querySelector('.m002-detail-tiles-group');
  const existing = new Map();
  tilesGroup.querySelectorAll('.m002-detail-tile').forEach((el) => {
    existing.set(el.dataset.detailTileId, el);
  });
  const newIds = [];
  for (const [id, pos] of frame.tilePositions) {
    const dev = s.devices.find((d) => d.id === id);
    if (!dev) continue;
    const dt = typeOf(dev.type);
    let tile = existing.get(id);
    if (!tile) {
      tile = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      tile.setAttribute('class', 'm002-detail-tile m002-detail-fresh');
      tile.dataset.detailTileId = id;
      tile.dataset.detailStop = '1';
      const w = DETAIL.tile.w, h = DETAIL.tile.h;
      tile.innerHTML = `
        <g class="m002-detail-tile-inner">
          <rect class="m002-detail-tile-bg m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
          <text class="m002-dev-type" x="${-w/2 + 10}" y="${-h/2 + 18}"></text>
          <text class="m002-detail-tile-name" x="0" y="${-h/2 + 42}" text-anchor="middle"></text>
          <text class="m002-dev-notes" x="${-w/2 + 10}" y="${h/2 - 10}"></text>
          <text class="m002-dev-ip" x="${w/2 - 10}" y="${h/2 - 10}" text-anchor="end"></text>
        </g>
      `;
      tilesGroup.appendChild(tile);
      newIds.push(id);
      existing.set(id, tile);
    }
    // Update role classes
    tile.classList.toggle('is-center', pos.role === 'center');
    tile.classList.toggle('is-peer',   pos.role === 'peer');
    // Selection state: centre is "selected" unless a port-modal is open
    // for it; peers are selected when matching s.selected.
    const isSelected = pos.role === 'center'
      ? (!s.portModalOpen || s.portModalOpen.deviceId !== id)
      : (s.selected?.kind === 'device' && s.selected.id === id);
    tile.classList.toggle('is-selected', isSelected);
    // Click-routing stamps. Peers carry data-detail-peer-id; the centre
    // carries data-detail-center. Both stamps survive role flips because
    // syncDetailFrame is called BEFORE the slot positions are written, so
    // the click handler reads the new role from the stamp, not the slot.
    if (pos.role === 'center') {
      tile.dataset.detailCenter = '1';
      delete tile.dataset.detailPeerId;
    } else {
      tile.dataset.detailPeerId = id;
      delete tile.dataset.detailCenter;
    }
    tile.style.setProperty('--accent', dt.accent);
    tile.querySelector('.m002-dev-type').textContent = dt.label;
    tile.querySelector('.m002-detail-tile-name').textContent = dev.name || '';
    tile.querySelector('.m002-dev-notes').textContent = truncate(dev.notes || '', 18) || '—';
    tile.querySelector('.m002-dev-ip').textContent = dev.ip || '';
  }
  // Remove tiles no longer in scope (peer was uplinked from old centre,
  // but isn't an uplink of the new centre).
  existing.forEach((tile, id) => {
    if (!frame.tilePositions.has(id)) tile.remove();
  });

  // Ports + links: cheap; rebuild from scratch each call. Their entry
  // animations replay via the .m002-detail-overlay-show CSS rules.
  const portsGroup = svg.querySelector('.m002-detail-ports-group');
  const linksGroup = svg.querySelector('.m002-detail-links-group');
  portsGroup.innerHTML = renderDetailPortsMarkup(s, frame);
  linksGroup.innerHTML = renderDetailLinksMarkup(s, frame);

  return { newIds };
}

// Apply tile positions via CSS variables. With opts.flip set to a Map of
// pre-hop bounding rects, performs the FLIP invert: each surviving tile
// gets --flip-dx/-dy/-scale set so it visually appears at its old screen
// position, with .m002-no-transition forced; a paired rAF then clears the
// FLIP vars and removes .m002-no-transition, kicking off the smooth
// transition to the new position. Tiles flagged as `freshIds` skip the
// invert (they're new — let them appear at their final position).
function applyDetailLayout(s, frame, opts = {}) {
  const tilesGroup = s.host.querySelector('.m002-detail-tiles-group');
  if (!tilesGroup) return;
  const tiles = tilesGroup.querySelectorAll('.m002-detail-tile');
  // Pass 1 — write new layout for every tile (no animation, no transition
  // for the brief moment we're computing the FLIP delta).
  tiles.forEach((tile) => {
    const pos = frame.tilePositions.get(tile.dataset.detailTileId);
    if (!pos) return;
    if (opts.flip) tile.classList.add('m002-no-transition');
    tile.style.setProperty('--layout-x', pos.x + 'px');
    tile.style.setProperty('--layout-y', pos.y + 'px');
    tile.style.setProperty('--layout-scale', pos.scale);
  });
  if (!opts.flip) return;
  // Pass 2 — for each tile that existed before, compute the inverse
  // transform that brings it visually back to its old position.
  tiles.forEach((tile) => {
    const id = tile.dataset.detailTileId;
    if (opts.freshIds && opts.freshIds.includes(id)) return;
    const oldRect = opts.flip.get(id);
    if (!oldRect) return;
    const newRect = tile.getBoundingClientRect();
    const dx = (oldRect.left + oldRect.width  / 2) - (newRect.left + newRect.width  / 2);
    const dy = (oldRect.top  + oldRect.height / 2) - (newRect.top  + newRect.height / 2);
    const ds = newRect.width > 0 ? oldRect.width / newRect.width : 1;
    tile.style.setProperty('--flip-dx', dx + 'px');
    tile.style.setProperty('--flip-dy', dy + 'px');
    tile.style.setProperty('--flip-scale', ds);
  });
  // Pass 3 — rAF: enable transition, clear FLIP vars. The double rAF
  // guards against browsers batching style writes within a single frame
  // and skipping the transition entirely.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tiles.forEach((tile) => {
        tile.classList.remove('m002-no-transition');
        tile.style.removeProperty('--flip-dx');
        tile.style.removeProperty('--flip-dy');
        tile.style.removeProperty('--flip-scale');
      });
    });
  });
}

// ============================================================================
// Ports + links markup. Pure-string builders; called by syncDetailFrame to
// rebuild the ports-group / links-group around the current centre. They no
// longer carry the centre device's <g> (that's a tile now), so the markup
// shrunk significantly compared to the legacy renderDetailBody.
// ============================================================================
function renderDetailPortsMarkup(s, frame) {
  const D = DETAIL;
  const t = typeOf(frame.centerDev.type);
  const cx = frame.cx;

  // Per-port enter delay (animation cascade).
  const PORT_BASE_DELAY = 700;
  const PORT_STAGGER_MS = 25;
  let portIndex = 0;
  const STUB_LEN = frame.STUB_LEN;

  const portSvg = (entry, x, y, dir /* 'up' | 'down' */) => {
    const { p, info } = entry;
    const occ = info.occupied;
    const firstV = (p.vlans || [])[0];
    const stripe = occ ? (firstV ? vlanColor(s, firstV) : t.accent) : '#2a2a36';
    const stroke = occ ? t.accent : '#2a2a36';
    const dash   = occ ? '' : ' stroke-dasharray="4 3"';
    const peerAbbr = (occ && info.peer) ? abbrPeer(info.peer) : '';

    let labelSvg = '';
    if (occ) {
      const numY = peerAbbr ? D.port.h / 2 + 2 : D.port.h / 2 + 8;
      labelSvg += `<text class="m002-detail-port-num" x="${D.port.w / 2}" y="${numY}" text-anchor="middle">${p.n}</text>`;
      if (peerAbbr) labelSvg += `<text class="m002-detail-port-peer" x="${D.port.w / 2}" y="${D.port.h - 10}" text-anchor="middle">${escSvg(peerAbbr)}</text>`;
    } else if (p.name) {
      const trimmed = String(p.name).slice(0, 7);
      labelSvg += `<text class="m002-detail-port-name" x="${D.port.w / 2}" y="${D.port.h / 2 + 4}" text-anchor="middle">${escSvg(trimmed)}</text>`;
    }

    let stubSvg = '';
    if (occ && dir === 'down') {
      const stubW = 1.4;
      const stubX = D.port.w / 2 - stubW / 2;
      stubSvg = `<rect class="m002-detail-stub" x="${stubX}" y="${D.port.h}" width="${stubW}" height="${STUB_LEN}" fill="url(#m002-stub-down)"/>`;
    }

    const enterDelay = PORT_BASE_DELAY + portIndex * PORT_STAGGER_MS;
    portIndex++;
    const outerStyle = `--accent:${t.accent};--enter-delay:${enterDelay}ms;`;
    const innerStyle = `transform-origin:${D.port.w / 2}px ${D.port.h / 2}px;`;

    return `
      <g class="m002-detail-port ${occ ? 'is-occupied' : 'is-empty'}" data-detail-port="${p.n}" data-detail-stop="1" transform="translate(${x} ${y})" style="${outerStyle}">
        ${stubSvg}
        <g class="m002-detail-port-inner" style="${innerStyle}">
          <rect class="m002-detail-port-box" width="${D.port.w}" height="${D.port.h}" fill="#0a0a10" stroke="${stroke}" stroke-width="1.4"${dash}/>
          <rect class="m002-detail-port-stripe" width="${D.port.w}" height="5" fill="${stripe}"/>
          ${labelSvg}
        </g>
      </g>
    `;
  };

  const D2 = DETAIL;
  const rowW = (n) => n <= 0 ? 0 : n * D2.port.w + (n - 1) * D2.gap;
  let out = '';
  if (frame.uplinks.length) {
    const startX = cx - frame.upW / 2;
    frame.uplinks.slice(0, D2.maxCols).forEach((c, i) => {
      out += portSvg(c, startX + i * (D2.port.w + D2.gap), frame.upY, 'up');
    });
  }
  if (frame.access.length) {
    for (let r = 0; r < frame.acRows; r++) {
      const slice = frame.access.slice(r * D2.maxCols, (r + 1) * D2.maxCols);
      const startX = cx - rowW(slice.length) / 2;
      slice.forEach((c, i) => {
        out += portSvg(c, startX + i * (D2.port.w + D2.gap), frame.acStartY + r * (D2.port.h + D2.gap), 'down');
      });
    }
  }
  return out;
}

function renderDetailLinksMarkup(s, frame) {
  if (!frame.uplinks.length) return '';
  const D = DETAIL;
  const t = typeOf(frame.centerDev.type);
  const cx = frame.cx;
  const portStartX = cx - frame.upW / 2;
  const out = [];
  frame.uplinks.slice(0, D.maxCols).forEach((c, i) => {
    const peer = c.info.peer;
    const linkObj = c.info.link;
    if (!peer || !linkObj) return;
    const tilePos = frame.tilePositions.get(peer.id);
    if (!tilePos) return;
    const portCx = portStartX + i * (D.port.w + D.gap) + D.port.w / 2;
    const portTopY = frame.upY;
    const tileBottomY = tilePos.y + D.tile.h / 2;
    const tileCx = tilePos.x;
    const midY = (tileBottomY + portTopY) / 2;
    const d = `M ${portCx} ${portTopY} V ${midY} H ${tileCx} V ${tileBottomY}`;
    const isSel = s.selected?.kind === 'link' && s.selected.id === linkObj.id;
    const firstV = (c.p.vlans || [])[0];
    const stripeColour = firstV ? vlanColor(s, firstV) : t.accent;
    out.push(
      `<g class="m002-link m002-detail-peer-link${isSel ? ' m002-selected' : ''}" data-detail-link="${escAttr(linkObj.id)}" data-detail-stop="1" style="--accent:${stripeColour}">
        <path class="m002-link-hit" d="${d}"/>
        <path class="m002-link-line" d="${d}" stroke="${stripeColour}"/>
      </g>`
    );
  });
  return out.join('');
}

// Legacy entry-point kept for the few external callers still wired to the
// old name; delegates to computeDetailFrame and projects out the four
// fields the legacy callers actually used.
function computeDetailLayout(s, dev) {
  const f = computeDetailFrame(s, dev);
  const centerPos = f.tilePositions.get(dev.id);
  return {
    totalW: f.totalW,
    totalH: f.totalH,
    cxUser: f.cx,
    cyUserDevice: centerPos ? centerPos.y : 0,
  };
}


// Smooth viewport tween for enter/exitDetailView. Cancels any running tween.
// Does NOT call schedSave — the user didn't intend to move the map.
// Easing: easeOutExpo. Decelerates aggressively at the end for a "settling"
// feel that complements the CSS overlay fade.
function animateView(s, target, durationMs) {
  if (s._viewAnimRaf) cancelAnimationFrame(s._viewAnimRaf);
  const start = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  const t0 = performance.now();
  // easeOutCubic — perceptible motion from frame 1 (~27% travelled at t=0.1
  // of the duration), gentle deceleration as the camera lands. Picked over
  // easeInOutCubic (which barely moves in the first 100ms and reads as "no
  // animation") and easeOutExpo (which front-loads ~75% of motion into the
  // first 200ms and reads as a lurch).
  const ease = (t) => (t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));
  const step = (now) => {
    const t = Math.min(1, (now - t0) / durationMs);
    const k = ease(t);
    s.view.x = start.x + (target.x - start.x) * k;
    s.view.y = start.y + (target.y - start.y) * k;
    s.view.zoom = start.zoom + (target.zoom - start.zoom) * k;
    applyView(s);
    if (t < 1) s._viewAnimRaf = requestAnimationFrame(step);
    else { s._viewAnimRaf = null; }
  };
  s._viewAnimRaf = requestAnimationFrame(step);
}

// =============================================================================
// HOP — Position-Swap navigation between switches inside Detail View.
//
// Architecture (rewritten in v2.34):
//   The detail-view tile-group is a managed DOM tree where every visible
//   device — centre + each direct uplink-peer — has its own persistent
//   <g class="m002-detail-tile" data-detail-tile-id="…">. Slot membership
//   (centre vs. peer-row) is purely a CSS-class + position decision; the
//   underlying DOM node survives the hop. That lets us animate via FLIP
//   (First-Last-Invert-Play) so the user sees the SAME element fly into
//   the centre and the SAME old centre-tile fly out into the peer row,
//   with no fade/respawn artefact in between.
//
// Sequence:
//   1. Capture every tile's getBoundingClientRect (FIRST).
//   2. Update s.detailDeviceId, sync DOM (LAST):
//      - new uplink-peers of the new centre get fresh tile <g>s,
//      - stale tiles (peers of the old centre that no longer connect) are
//        removed,
//      - persistent tiles' role/class flips, text content refreshes,
//      - ports + links rebuild around the new centre.
//   3. Write new --layout-x/-y/-scale on every tile.
//   4. For each surviving tile, set --flip-dx/-dy/-scale equal to the
//      inverse of its position-delta and force .m002-no-transition so the
//      browser snaps it visually back to its OLD position (INVERT).
//   5. rAF×2 — clear --flip-* and remove .m002-no-transition; the CSS
//      transition kicks in and the tile glides to its new slot (PLAY).
//
// s._viewBeforeDetail is NOT touched here — exiting always returns to the
// original pre-detail viewport, regardless of how many hops happened.
// =============================================================================
function hopToPeer(s, peerId, fromEl) {
  if (!peerId || peerId === s.detailDeviceId) return;
  if (s._detailHopActive) return;
  const peer = s.devices.find((d) => d.id === peerId);
  if (!peer) return;
  const overlay = s.host.querySelector('.m002-detail-overlay');
  if (!overlay) return;

  s._detailHopActive = true;
  if (s._detailSettleTimer) { clearTimeout(s._detailSettleTimer); s._detailSettleTimer = null; }

  // NOTE — we deliberately do NOT remove .m002-detail-overlay-settled here.
  // The settled rule pins .m002-detail-tile-inner / -tile-bg via !important
  // but does NOT touch the outer .m002-detail-tile (which is what the FLIP
  // transitions). Keeping settled active during the hop has two upsides:
  //   1. Surviving tiles' inners stay frozen — no risk of the show-class
  //      animation rules restarting from frame 0 just because the
  //      animation property momentarily changed.
  //   2. Newly-created tiles arrive at identity immediately (the settled
  //      rule overrides their initial-state CSS), so they don't briefly
  //      flash a 0.005 emerge-point at their final slot.

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // FIRST — capture every tile's screen-space bounding box.
  const oldRects = new Map();
  const tilesGroup = overlay.querySelector('.m002-detail-tiles-group');
  if (tilesGroup) {
    tilesGroup.querySelectorAll('.m002-detail-tile').forEach((el) => {
      oldRects.set(el.dataset.detailTileId, el.getBoundingClientRect());
    });
  }

  // Update state — focus + selection + title.
  s.detailDeviceId = peerId;
  if (!(s.selected?.kind === 'device' && s.selected.id === peerId)) {
    select(s, 'device', peerId);
  }
  const t = typeOf(peer.type);
  const titleEl = overlay.querySelector('.m002-detail-title');
  if (titleEl) titleEl.textContent = `// ${t.label} · ${peer.name || '—'}`;

  // LAST — sync DOM around the new centre. Tiles that survive the hop
  // keep their <g> nodes; new peers get fresh ones; departed peers
  // detach. Ports + links are rebuilt entirely (cheap).
  const body = overlay.querySelector('.m002-detail-body');
  const frame = computeDetailFrame(s, peer);
  const { newIds } = syncDetailFrame(s, body, frame);

  // INVERT + PLAY — write the new --layout-* on every tile, then for
  // each tile that pre-existed compute the delta and write --flip-*
  // (without transition). The double-rAF inside applyDetailLayout
  // clears --flip-* and lets the CSS transition glide each tile to
  // its new slot.
  applyDetailLayout(s, frame, {
    flip: reduceMotion ? null : oldRects,
    freshIds: newIds,
  });

  // Camera tween runs in parallel — doesn't gate the tile FLIP.
  const rect = s.svg.getBoundingClientRect();
  const tx = rect.width  / 2 - peer.x * DETAIL_TARGET_ZOOM;
  const ty = rect.height / 2 - peer.y * DETAIL_TARGET_ZOOM;
  animateView(s, { x: tx, y: ty, zoom: DETAIL_TARGET_ZOOM }, DETAIL_ENTER_MS);

  // Settle once the FLIP transition finishes — re-applies the
  // animation:none/!important guard so subsequent live edits to the
  // inspector don't re-trigger entry choreography.
  const settleAfter = (reduceMotion ? 0 : DETAIL.flipMs) + 80;
  s._detailSettleTimer = setTimeout(() => {
    if (s.detailDeviceId === peerId) overlay.classList.add('m002-detail-overlay-settled');
    s._detailHopActive = false;
  }, settleAfter);
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
      <button type="button" class="m002-menu-item" data-mapact="export-png">EXPORT PNG</button>
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
      else if (act === 'export-png') exportPNG(s);
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
  applyView(s);
  render(s);
  refreshMapBar(s);
  refreshZoneBar(s);
  rememberActiveMap(s);
  const m = s.maps.find((mm) => mm.id === mapId);
  if (m) toast(s, `Map: ${m.name}`);
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
  if (!s.sb || String(m.id).startsWith('local_')) {
    toast(s, `Map renamed: ${name}`);
    return;
  }
  const { error } = await s.sb.from('m002_maps').update({ name }).eq('id', m.id);
  if (error) { console.warn('[m002] rename failed', error); toast(s, 'Rename failed'); return; }
  toast(s, `Map renamed: ${name}`);
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
  const deletedName = m.name;
  s.maps = s.maps.filter((mm) => mm.id !== m.id);
  s.activeMapId = s.maps[0].id;
  await loadMapData(s, s.activeMapId);
  applyView(s);
  render(s);
  refreshMapBar(s);
  refreshZoneBar(s);
  rememberActiveMap(s);
  toast(s, `Map "${deletedName}" deleted`);
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
  toast(s, `Exported "${m.name}"`);
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

function switchZone(s, zoneId, anchor, opts = {}) {
  if (!zoneId || zoneId === s.activeZone) return;
  // Persist the position we're leaving so a return trip lands on the same
  // spot. Zoom is held instead of restored — the user keeps whatever scale
  // they had, so zone hopping never surprises them with a different scale.
  if (!s.view.zoneViews) s.view.zoneViews = {};
  s.view.zoneViews[s.activeZone] = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  const from = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  const saved = s.view.zoneViews[zoneId];
  // Camera anchor (set on a destination JUMP) trumps the saved zoneView so the
  // JUMP's curated landing view wins over the user's last casual position.
  const to = opts.toView
    ? { x: opts.toView.x, y: opts.toView.y, zoom: opts.toView.zoom }
    : saved
      ? { x: saved.x, y: saved.y, zoom: from.zoom } // keep current zoom
      : from;
  s.activeZone = zoneId;
  refreshZoneBar(s);
  vfxAnimateView(s, () => render(s), anchor);
  if (from.x !== to.x || from.y !== to.y) {
    animateZoneView(s, from, to, 900);
  }
  schedSave(s);
  const z = s.zones.find((zz) => zz.id === zoneId);
  if (z) toast(s, `Zone: ${z.name}`);
}

// Cinematic camera pan + zoom between two view states. Used by zone hops
// (manual pill click + JUMP-triggered switches) so the canvas glides into
// the new zone's last-known centre instead of teleporting. Symmetric
// easeInOutCubic so the start and end both feel composed — neither lurches.
function animateZoneView(s, from, to, duration) {
  if (s._zoneAnim) cancelAnimationFrame(s._zoneAnim);
  const start = performance.now();
  const ease = (t) => t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const k = ease(t);
    s.view.x = from.x + (to.x - from.x) * k;
    s.view.y = from.y + (to.y - from.y) * k;
    s.view.zoom = from.zoom + (to.zoom - from.zoom) * k;
    // Per-frame minimap rebuild is expensive enough to stutter the pan.
    // Just touch the world transform during the glide and refresh the
    // minimap once at the end.
    s.gWorld.setAttribute('transform', `translate(${s.view.x} ${s.view.y}) scale(${s.view.zoom})`);
    if (t < 1) {
      s._zoneAnim = requestAnimationFrame(step);
    } else {
      s._zoneAnim = null;
      applyView(s);
    }
  };
  s._zoneAnim = requestAnimationFrame(step);
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
  toast(s, `Zone added: ${name}`);
}

function zoneContextMenu(s, zoneId) {
  const z = s.zones.find((zz) => zz.id === zoneId);
  if (!z) return;
  const action = prompt(`Zone "${z.name}":\n  r = rename\n  d = delete\nLeave empty to cancel.`);
  if (!action) return;
  if (action.toLowerCase().startsWith('r')) {
    const name = (prompt('Rename zone:', z.name) || '').trim();
    if (!name) return;
    const oldName = z.name;
    z.name = name;
    refreshZoneBar(s);
    schedSave(s);
    toast(s, `Zone renamed: ${oldName} → ${name}`);
  } else if (action.toLowerCase().startsWith('d')) {
    if (s.zones.length <= 1) { toast(s, 'Cannot delete the last zone'); return; }
    if (!confirm(`Delete zone "${z.name}" and everything in it?`)) return;
    const deletedName = z.name;
    snapshot(s);
    s.devices = s.devices.filter((d) => d.zone !== zoneId);
    s.stacks  = s.stacks.filter((st) => st.zone !== zoneId);
    const liveIds = new Set(s.devices.map((d) => d.id));
    s.links = s.links.filter((l) => liveIds.has(l.from) && liveIds.has(l.to));
    // Couples that pointed into the deleted zone are now dangling.
    s.devices.forEach((d) => { if (isReference(d) && d.coupleId && !liveIds.has(d.coupleId)) d.coupleId = null; });
    s.zones = s.zones.filter((zz) => zz.id !== zoneId);
    s.activeZone = s.zones[0].id;
    refreshZoneBar(s);
    render(s);
    schedSave(s);
    toast(s, `Zone "${deletedName}" deleted`);
  }
}

// Convert legacy schema → current. Idempotent.
function migrate(s) {
  if (!Array.isArray(s.vlanRegistry)) s.vlanRegistry = [];
  if (!Array.isArray(s.subnetRegistry)) s.subnetRegistry = [];
  if (!Array.isArray(s.zones) || !s.zones.length) s.zones = [{ id: 'z_main', name: 'Main' }];
  if (!s.activeZone || !s.zones.find((z) => z.id === s.activeZone)) s.activeZone = s.zones[0].id;
  const validZoneIds = new Set(s.zones.map((z) => z.id));
  const fallbackZone = s.zones[0].id;
  s.devices.forEach((d) => {
    if (!d.zone || !validZoneIds.has(d.zone)) d.zone = fallbackZone;
    if (TYPE_ALIASES[d.type]) d.type = TYPE_ALIASES[d.type];
    if (!Array.isArray(d.ports)) d.ports = [];
    if (!Array.isArray(d.vlans)) d.vlans = [];
    if (d.type === 'reference' && d.coupleId === undefined) d.coupleId = null;
    // LAGs no longer hang on devices — they belong to stacks. Drop any legacy
    // device-owned LAG record on hydrate.
    delete d.lags;
    delete d.layouts;
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

    // L3 fields. Routers and firewalls own an interfaces[] table with
    // ip/prefix/gateway fields per row; non-L3 devices terminate IP via the
    // single dev.ip / dev.prefix / dev.gateway trio (one implicit interface).
    // The legacy schema stored ip as a CIDR string and bound an explicit
    // subnetId/vlanId — both fields are derived now and are stripped.
    const splitCidr = (raw, fallbackPrefix) => {
      const s = String(raw || '').trim();
      const m = s.match(/^(.+?)\/(\d+)$/);
      if (m) return { ip: m[1], prefix: Math.max(0, Math.min(32, Number(m[2]))) };
      return { ip: s, prefix: Math.max(0, Math.min(32, Number(fallbackPrefix))) };
    };
    if (isL3Type(d.type)) {
      if (!Array.isArray(d.interfaces)) d.interfaces = [];
      if (!Array.isArray(d.routes)) d.routes = [];
      d.interfaces = d.interfaces.map((iface) => {
        const split = splitCidr(iface.ip, iface.prefix != null ? iface.prefix : 24);
        return {
          id: iface.id || ('if_' + rid()),
          name: String(iface.name || ''),
          ip: split.ip,
          prefix: Number.isFinite(split.prefix) ? split.prefix : 24,
        };
      });
      d.routes = d.routes.map((r) => ({
        id: r.id || ('rt_' + rid()),
        dst: String(r.dst || ''),
        nextHop: String(r.nextHop || ''),
        interfaceId: r.interfaceId || null,
        metric: r.metric != null ? Number(r.metric) : null,
      }));
      // Bootstrap an interface from the legacy single-IP field — if a router
      // has dev.ip set but no interfaces, that IP becomes "if0".
      if (!d.interfaces.length && d.ip && String(d.ip).trim()) {
        const split = splitCidr(d.ip, d.prefix != null ? d.prefix : 24);
        d.interfaces.push({
          id: 'if_' + rid(), name: 'if0',
          ip: split.ip, prefix: split.prefix,
          gateway: defaultGatewayFor(split.ip, split.prefix),
        });
      }
    } else {
      // Non-L3 devices: split the legacy CIDR field into ip + prefix. Drop
      // the legacy gateway field — gateways live in the routes[] table now.
      // Provision a routes[] so the inspector can render a routes section
      // and the auto-default-route can pin its first entry there.
      delete d.interfaces;
      if (!isReference(d)) {
        const split = splitCidr(d.ip, d.prefix != null ? d.prefix : 24);
        d.ip = split.ip;
        d.prefix = Number.isFinite(split.prefix) ? split.prefix : 24;
        delete d.gateway;
        if (!Array.isArray(d.routes)) d.routes = [];
        d.routes = d.routes.map((r) => ({
          id: r.id || ('rt_' + rid()),
          dst: String(r.dst || ''),
          nextHop: String(r.nextHop || ''),
          interfaceId: r.interfaceId || null,
          metric: r.metric != null ? Number(r.metric) : null,
        }));
      } else {
        delete d.routes;
      }
    }
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
      if (!Array.isArray(st.lags))    st.lags    = [];
      if (!Array.isArray(st.stackLinks)) st.stackLinks = [];
      // Virtual IPs — the L3 identity of the stack as a whole. VRRP / HSRP /
      // StackWise semantics: the VIP "floats" on top of the member nodes,
      // endpoints in the subnet point at it as their next-hop. Members keep
      // their own mgmt IPs (stored on the member device) but those don't
      // generate L3 path endpoints when a VIP is set on the stack.
      if (!Array.isArray(st.virtualInterfaces)) st.virtualInterfaces = [];
      st.virtualInterfaces = st.virtualInterfaces.map((vif) => {
        let ip = String(vif.ip || '').trim();
        let prefix = vif.prefix != null ? Number(vif.prefix) : 24;
        const m = ip.match(/^(.+?)\/(\d+)$/);
        if (m) { ip = m[1]; prefix = Math.max(0, Math.min(32, Number(m[2]))); }
        return {
          id: vif.id || ('vif_' + rid()),
          name: String(vif.name || ''),
          ip,
          prefix: Number.isFinite(prefix) ? Math.max(0, Math.min(32, prefix)) : 24,
        };
      });
      // Stacks gain a routes[] table so they can carry their own default
      // route (just like routers). The route's next-hop is what the vote
      // counter sees as "this stack votes for IP X as gateway".
      if (!Array.isArray(st.routes)) st.routes = [];
      st.routes = st.routes.map((r) => ({
        id: r.id || ('rt_' + rid()),
        dst: String(r.dst || ''),
        nextHop: String(r.nextHop || ''),
        interfaceId: r.interfaceId || null,
        metric: r.metric != null ? Number(r.metric) : null,
      }));
      if (!st.zone || !validZoneIds.has(st.zone)) st.zone = fallbackZone;
      delete st.vlans;
      st.members = st.members.filter((m) => live.has(m));
      delete st.layouts;
    });
    s.stacks = s.stacks.filter((st) => st.members.length >= 2);
  } else {
    s.stacks = [];
  }
  // Migrate legacy intra-stack regular links into stack-owned stackLinks. These
  // never made physical sense as canvas edges (they self-loop on the collapsed
  // stack icon) — treat any pre-existing pair-of-members link as a stacking
  // cable and move it onto its owning stack.
  const memberOfStack = new Map();
  s.stacks.forEach((st) => st.members.forEach((m) => memberOfStack.set(m, st)));
  if (memberOfStack.size && Array.isArray(s.links)) {
    const remaining = [];
    s.links.forEach((l) => {
      const stA = memberOfStack.get(l.from);
      const stB = memberOfStack.get(l.to);
      if (stA && stA === stB) {
        stA.stackLinks.push({
          id: l.id || ('sl_' + rid()),
          fromDevice: l.from,
          toDevice: l.to,
          fromPort: l.fromPort || '',
          toPort: l.toPort || '',
        });
      } else {
        remaining.push(l);
      }
    });
    s.links = remaining;
  }
  // Sanity-check stackLinks: both endpoints must be live members of this
  // stack, and a stack-link must connect distinct members.
  s.stacks.forEach((st) => {
    const memberSet = new Set(st.members);
    st.stackLinks = (st.stackLinks || []).filter((sl) =>
      sl && sl.fromDevice !== sl.toDevice
      && memberSet.has(sl.fromDevice) && memberSet.has(sl.toDevice)
    );
    st.stackLinks.forEach((sl) => {
      if (!sl.id) sl.id = 'sl_' + rid();
      if (sl.fromPort == null) sl.fromPort = '';
      if (sl.toPort == null) sl.toPort = '';
    });
  });
  // Sanity-check stack-owned LAGs: port-refs must point at members of the
  // stack and at real ports on those members. Drop empty LAGs and reciprocal
  // counterpart pointers that no longer resolve.
  s.stacks.forEach((st) => {
    const memberSet = new Set(st.members);
    st.lags.forEach((lag) => {
      if (!Array.isArray(lag.ports)) lag.ports = [];
      if (!Array.isArray(lag.vlans)) lag.vlans = [];
      lag.ports = lag.ports.map((p) => ({ deviceId: p.deviceId, portN: Number(p.portN) }))
        .filter((p) => {
          if (!memberSet.has(p.deviceId)) return false;
          const host = s.devices.find((dd) => dd.id === p.deviceId);
          return host && host.ports.some((pp) => pp.n === p.portN);
        });
      if (lag.counterpart && (!lag.counterpart.stackId || !lag.counterpart.lagId)) {
        delete lag.counterpart;
      }
    });
    st.lags = st.lags.filter((lag) => lag.ports.length > 0);
    sortLagsInStack(st);
  });
  // Sanity-check Jump couples: must point at a live Jump in a different zone,
  // and must be mutual.
  const liveDevById = new Map(s.devices.map((d) => [d.id, d]));
  const coupleSynced = new Set();
  s.devices.forEach((d) => {
    if (!isReference(d)) { delete d.coupleId; return; }
    if (!d.coupleId) return;
    const peer = liveDevById.get(d.coupleId);
    if (!peer || !isReference(peer) || peer.zone === d.zone) { d.coupleId = null; return; }
    // Repair one-sided couples (peer doesn't point back) by enforcing mutuality.
    if (peer.coupleId !== d.id) peer.coupleId = d.id;
    // Enforce shared coordinates — older saves may have drifted. Pick a
    // canonical side (lexicographic id) so both iterations agree on the
    // anchor, otherwise we'd ping-pong on every load.
    if (coupleSynced.has(d.id)) return;
    const anchor = d.id < peer.id ? d : peer;
    const follower = anchor === d ? peer : d;
    if (follower.x !== anchor.x || follower.y !== anchor.y) {
      follower.x = anchor.x;
      follower.y = anchor.y;
    }
    coupleSynced.add(d.id);
    coupleSynced.add(peer.id);
  });
  recomputeVlanIndex(s);

  // L3 — auto-discover subnets from every populated IP so a freshly-loaded
  // map already shows meaningful content in the routing layer. Idempotent.
  autoDiscoverSubnets(s);
  // Backfill the auto-default-route for hydrated devices whose IP was set
  // before the routes[] redesign. Without this, legacy endpoints would
  // load with empty routes[] and stop voting for their gateway in the L3
  // engine — no ribbon, no DGW badge.
  s.devices.forEach((d) => {
    if (isReference(d)) return;
    if (isL3Type(d.type)) {
      (d.interfaces || []).forEach((iface) => {
        if (iface.ip) autoCreateDefaultRoute(d.routes, iface.ip, iface.prefix, iface.id);
      });
    } else if (d.ip) {
      autoCreateDefaultRoute(d.routes, d.ip, d.prefix, null);
    }
  });
  s.stacks.forEach((st) => {
    (st.virtualInterfaces || []).forEach((vif) => {
      if (vif.ip) autoCreateDefaultRoute(st.routes, vif.ip, vif.prefix, vif.id);
    });
  });
  // Interfaces now derive their subnet from ip+prefix on the fly — no
  // orphan-id sweep needed. Subnet registry just gets re-indexed.
  recomputeSubnetIndex(s);
}

// =============================================================================
// Undo / Redo
// =============================================================================
function snapshotPayload(s) {
  return JSON.stringify({
    devices: s.devices, links: s.links, stacks: s.stacks,
    vlanRegistry: s.vlanRegistry,
    subnetRegistry: s.subnetRegistry,
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
  s.subnetRegistry = data.subnetRegistry || [];
  vlansChanged(s);
  subnetsChanged(s);
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
  toast(s, 'Undo');
}
function redo(s) {
  if (!s.redoStack.length) { toast(s, 'Nothing to redo'); return; }
  s.undoStack.push(snapshotPayload(s));
  applySnapshot(s, s.redoStack.pop());
  schedSave(s);
  toast(s, 'Redo');
}
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function escSvg(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function escAttr(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(s, msg) {
  if (!s.toastStackEl) return;
  const item = document.createElement('div');
  item.className = 'm002-toast-item';
  item.textContent = msg;
  s.toastStackEl.appendChild(item);
  // force reflow so the enter transition plays
  void item.offsetWidth;
  item.classList.add('show');
  setTimeout(() => {
    item.classList.remove('show');
    item.classList.add('leave');
    setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, 260);
  }, 2800);
}


// =============================================================================
// Register
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'NET_FORGE · LAYER_MAP',
  mount,
  unmount,
});
