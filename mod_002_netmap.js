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

const MODULE_CODE = 'MOD_002';
const SAVE_DEBOUNCE_MS = 800;
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
      render(s);
      schedSave(s);
    });
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
      render(s);
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
      render(s);
      schedSave(s);
    });
    row.addEventListener('mouseenter', () => {
      const id = String(row.dataset.ssolo);
      if (s._subnetHover === id) return;
      s._subnetHover = id;
      if (s.activeLayer === 'routing') drawL3Paths(s);
    });
    row.addEventListener('mouseleave', () => {
      if (s._subnetHover == null) return;
      s._subnetHover = null;
      if (s.activeLayer === 'routing') drawL3Paths(s);
    });
  });
  body.querySelector('[data-sclear]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    s.view.subnetFilter = [];
    render(s);
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
function parseCidr(str) {
  if (str == null) return null;
  const m = String(str).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d+))?$/);
  if (!m) return null;
  const oct = [+m[1], +m[2], +m[3], +m[4]];
  if (oct.some((o) => o < 0 || o > 255)) return null;
  const prefix = m[5] != null ? Math.max(0, Math.min(32, +m[5])) : 32;
  const ipNum = oct[0] * 0x1000000 + oct[1] * 0x10000 + oct[2] * 0x100 + oct[3];
  const mask = prefixToMask(prefix);
  const netNum = (ipNum & mask) >>> 0;
  return { ip: oct.join('.'), ipNum, prefix, mask, netNum, network: numToIp(netNum) };
}
function prefixToMask(prefix) {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xFFFFFFFF;
  return ((0xFFFFFFFF << (32 - prefix)) >>> 0);
}
function numToIp(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.'); }
// Strip leading zeros from each octet of a dotted IP / CIDR string.
// "10.0.0.05" → "10.0.0.5", "010.0.0.005/24" → "10.0.0.5/24". Only rewrites
// strings that already match the full IP shape so partial input ("10.0.0.")
// and non-IP text pass through unchanged — keeps live typing usable.
function normalizeIpInput(str) {
  if (str == null) return str;
  const s = String(str);
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d+)?$/);
  if (!m) return s;
  const oct = [m[1], m[2], m[3], m[4]].map((o) => String(parseInt(o, 10) || 0));
  if (oct.some((o) => Number(o) > 255)) return s;
  return oct.join('.') + (m[5] || '');
}
function cidrNormalize(str) {
  const p = parseCidr(str);
  if (!p) return null;
  return `${p.network}/${p.prefix}`;
}
function ipInCidr(ip, cidr) {
  const a = parseCidr(ip), b = parseCidr(cidr);
  if (!a || !b) return false;
  return ((a.ipNum & b.mask) >>> 0) === b.netNum;
}

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
    // When a stack id appears in the path (target or transit), drop any
    // member-of-that-stack hops from the same path. BFS often inserts a
    // member as transit between an external link and the stack-virtual-node,
    // which visually routes the ribbon through the member's position
    // before bending into the stack centre. Filtering those out makes the
    // ribbon glide PAST the members directly to the stack — matching the
    // "an den Membern des Default-Gateway-Stacks vorbei" requirement.
    const stackIdsInPath = new Set();
    for (const id of ids) if ((s.stacks || []).some((st) => st.id === id)) stackIdsInPath.add(id);
    const filtered = ids.filter((id) => {
      const owningStackId = stackOfMember.get(id);
      return !owningStackId || !stackIdsInPath.has(owningStackId);
    });
    // Dedupe consecutive duplicates (stack-virtual-node BFS can cause them).
    const trimmed = [];
    for (const id of filtered) if (trimmed[trimmed.length - 1] !== id) trimmed.push(id);
    if (trimmed.length < 2) continue;
    paths.push({ subnetId: sn.id, ids: trimmed });
  }
  return paths;
}

// Geometric waypoint for an L3-ribbon node. Defers to effectivePos() so
// members of a collapsed stack resolve to the stack centre (matching the
// canvas), keeping the curve gliding through stack icons rather than
// snaking out to where members would sit if expanded.
function ribbonWaypoint(s, id) {
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
  state = createState(stage, ctx);
  buildDOM(state);
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

const DEFAULT_PREFS = { autoRecenter: false, freeMove: false, snapOnDrop: true };
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
    const portEl = e.target.closest('[data-detail-port]');
    if (portEl && s.detailDeviceId) {
      const portN = Number(portEl.dataset.detailPort);
      if (!Number.isFinite(portN)) return;
      detailOverlay.querySelectorAll('.m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
      detailOverlay.querySelector('.m002-detail-device')?.classList.remove('is-selected');
      portEl.classList.add('is-selected');
      openPortModal(s, s.detailDeviceId, portN);
      return;
    }
    if (e.target.closest('.m002-detail-device') && s.detailDeviceId) {
      detailOverlay.querySelectorAll('.m002-detail-port.is-selected').forEach((el) => el.classList.remove('is-selected'));
      detailOverlay.querySelector('.m002-detail-device')?.classList.add('is-selected');
      if (s.portModalOpen) closePortModal(s);
    }
  });

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
  const newKey = visualEndpointKey(s, link.from, link.to);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (visualEndpointKey(s, l.from, l.to) === newKey) redrawLink(s, l);
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
const AUTOLINK_MAX_DIST = 432;      // suggestion starts pre-fading from here so
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
  const newKey = visualEndpointKey(s, link.from, link.to);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (visualEndpointKey(s, l.from, l.to) === newKey) redrawLink(s, l);
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
        scheduleSnapPreview(s, snapX, snapY, dragSnapAccent(s, 'stack', st.id));
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
  // VLAN solo state — drives the dim / yellow / orange CSS on the VLAN layer.
  // References don't carry their own VLANs, so they're exempt.
  if (!isReference(dev)) {
    const vsState = vlanSoloStateForDevice(s, dev);
    if (vsState) g.setAttribute('data-vlan-solo', vsState);
  }
  g.style.setProperty('--accent', t.accent);
  updateDeviceTransform({ }, dev, g);

  const w = DEVICE_W, h = DEVICE_H;
  if (isReference(dev)) {
    let arrow, target;
    if (peer) {
      const peerZone = (s.zones || []).find((z) => z.id === peer.zone);
      arrow = '⇄ HUB';
      target = peerZone ? `${peerZone.name} · ${peer.name}` : peer.name;
    } else {
      arrow = dev.refMode === 'map' ? '↗ MAP' : '→ ZONE';
      target = referenceTargetLabel(s, dev);
    }
    g.innerHTML = `
      <rect class="m002-dev-bg" x="${-w/2}" y="${-h/2}" width="${w}" height="${h}" rx="3"/>
      <text class="m002-dev-type" x="${-w/2 + 10}" y="${-h/2 + 18}">${t.label} · ${arrow}</text>
      <text class="m002-dev-name" x="${-w/2 + 10}" y="${-h/2 + 40}">${escSvg(dev.name)}</text>
      <text class="m002-dev-ref-target" x="${-w/2 + 10}" y="${h/2 - 10}">${escSvg(truncate(target, 24))}</text>
      <text class="m002-dev-ref-hint" x="${w/2 - 10}" y="${h/2 - 10}" text-anchor="end">DBL</text>
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
      <text class="m002-dev-type" x="${-w/2 + 10}" y="${-h/2 + 18}">${t.label}</text>
      <text class="m002-dev-name" x="${-w/2 + 10}" y="${-h/2 + 40}">${escSvg(dev.name)}</text>
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
  // into new lanes — invalidate the slot cache and redraw every link that
  // shares this pair so existing edges fan out to make room for the new one.
  invalidateEdgeSlots(s);
  const newKey = visualEndpointKey(s, link.from, link.to);
  s.links.forEach((l) => {
    if (l.id === link.id) return;
    if (visualEndpointKey(s, l.from, l.to) === newKey) redrawLink(s, l);
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
// the stack respects its `expanded` flag.
function isStackCollapsed(s, stack) {
  if (!stack) return false;
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
  st.expanded = !st.expanded;
  // On collapse, snap stack position to the centroid of members so the icon
  // appears where the cluster was.
  if (!st.expanded) {
    const devs = st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
    if (devs.length) {
      const cx = Math.round((devs.reduce((sum, d) => sum + d.x, 0) / devs.length) / GRID) * GRID;
      const cy = Math.round((devs.reduce((sum, d) => sum + d.y, 0) / devs.length) / GRID) * GRID;
      st.x = cx; st.y = cy;
    }
  } else {
    // On expand, lay overlapping members out cleanly. Once the user has
    // dragged them into place, positions stay put on subsequent toggles.
    layoutStackMembersIfOverlapping(s, st);
  }
  render(s);
  schedSave(s);
}

// If members of an expanded stack visually overlap, re-arrange them in a
// clean grid centered on the stack anchor with one grid line of breathing
// room between cells. Members that already sit cleanly are left untouched.
function layoutStackMembersIfOverlapping(s, st) {
  const devs = st.members.map((id) => s.devices.find((d) => d.id === id)).filter(Boolean);
  if (devs.length < 2) return;
  let overlap = false;
  for (let i = 0; i < devs.length && !overlap; i++) {
    for (let j = i + 1; j < devs.length; j++) {
      if (Math.abs(devs[i].x - devs[j].x) < DEVICE_W && Math.abs(devs[i].y - devs[j].y) < DEVICE_H) {
        overlap = true;
        break;
      }
    }
  }
  if (!overlap) return;
  // Vertical column — mirrors a physical switch stack (one switch on top of
  // the next). One grid line of breathing room between cells, centered on
  // the stack anchor.
  const stepY = DEVICE_H + GRID;
  const totalH = (devs.length - 1) * stepY;
  const colX = Math.round(st.x / GRID) * GRID;
  const startY = Math.round((st.y - totalH / 2) / GRID) * GRID;
  devs.forEach((d, i) => {
    d.x = colX;
    d.y = Math.round((startY + i * stepY) / GRID) * GRID;
  });
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
    <text class="m002-dev-type"   x="${-w/2 + 10}" y="${-h/2 + 18}">STACK · ${t.label}</text>
    <text class="m002-dev-name"   x="${-w/2 + 10}" y="${-h/2 + 40}">${escSvg(stack.name)}</text>
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
  env.innerHTML = `
    <rect class="m002-stack-env-bg" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="6"/>
    <text class="m002-stack-env-label" x="${minX + 10}" y="${minY + 14}">// STACK · ${escSvg(stack.name)} · ×${members.length}</text>
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
    const path = orthPath(a, b, off);
    let inner = `<path class="m002-stack-cable" d="${path.d}"/>`;
    // Port labels on stacking cables only in Physical — VLAN/Routing layers
    // already speak via colour, the textual port stencil is just clutter there.
    if (s.activeLayer === 'physical') {
      const fromLbl = sl.fromPort ? portLabel(a, sl.fromPort) : '';
      const toLbl   = sl.toPort   ? portLabel(b, sl.toPort)   : '';
      if (fromLbl || toLbl) {
        const lbl = (fromLbl || '?') + ' ⇄ ' + (toLbl || '?');
        inner += `<text class="m002-stack-cable-label" x="${path.lx}" y="${path.ly - 4}" text-anchor="middle">${escSvg(lbl)}</text>`;
      }
    }
    cab.innerHTML = inner;
    s.gStacksBg.appendChild(cab);
  });
}

function orthPath(a, b, off = 0) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const halfW = DEVICE_W / 2, halfH = DEVICE_H / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = Math.sign(dx) || 1;
    const ex1 = a.x + sx * halfW;
    const ex2 = b.x - sx * halfW;
    // Geometric midpoint, no grid snap. With grid-aligned endpoints the kink
    // lands on a half-grid line; snapping it to a full grid step would shift
    // the bend by ±GRID/2 and make the line look asymmetric ("imprecise").
    const mid = (ex1 + ex2) / 2 + off;
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
  const mid = (ey1 + ey2) / 2 + off;
  const ax = a.x + off, bx = b.x + off;
  return {
    d: `M ${ax} ${ey1} L ${ax} ${mid} L ${bx} ${mid} L ${bx} ${ey2}`,
    lx: (ax + bx) / 2, ly: mid,
    from: { x: ax + 8, y: ey1 + sy * 14, anchor: 'start' },
    to:   { x: bx + 8, y: ey2 - sy * 10, anchor: 'start' },
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
  const a = orthPath(aPos, bPos, lane + gap);
  const b = orthPath(aPos, bPos, lane - gap);
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
  const path = orthPath(aPos, bPos, lane);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link m002-link-bundle m002-laglink');
  g.setAttribute('data-laglink-id', `${p.stackA.id}|${p.lagA.id}`);

  const sharedVlans = (p.lagA.vlans || []).map(String).filter((v) => (p.lagB.vlans || []).map(String).includes(v));
  const filter = effectiveVlanSolo(s);
  const isFiltered = filter.length > 0;
  const drawnVlans = isFiltered ? sharedVlans.filter((v) => filter.includes(v)) : [];
  let inner = `<path class="m002-link-hit" d="${path.d}"/>`;
  if (s.activeLayer === 'routing') {
    // Routing layer: LAG-pairs are L2 plumbing — paint them as the same dim
    // dashed underlay every other link gets. The L3 ribbon above carries the
    // colour. Without this we'd stack a gray double-line beneath the ribbon
    // and end up with four parallel highlights through one wire pair.
    inner += `<path class="m002-link-line m002-link-dim" d="${path.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
  } else if (s.activeLayer === 'vlan' && drawnVlans.length) {
    const gap = 6;
    drawnVlans.forEach((v, i) => {
      const off = lane + (i - (drawnVlans.length - 1) / 2) * gap;
      const op = orthPath(aPos, bPos, off);
      const c = vlanColor(s, v);
      inner += `<path class="m002-link-line m002-link-stripe" d="${op.d}" style="stroke:${c};color:${c}" stroke-width="2.4"/>`;
      inner += `<text class="m002-link-label m002-link-stripe-label" x="${op.lx}" y="${op.ly - 4}" style="fill:${c};color:${c}" text-anchor="middle">${escSvg(v)}</text>`;
    });
  } else {
    inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 2, lane });
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
  const path = orthPath(aPos, bPos, lane);
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'm002-link m002-link-agg');
  g.setAttribute('data-agg-key', key);
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
  const lane = laneForLink(s, link.id);
  const base = orthPath(aPos, bPos, lane);
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
        if (drawn.length > 0) {
          const gap = 6;
          drawn.forEach((v, i) => {
            const off = lane + (i - (drawn.length - 1) / 2) * gap;
            const p = orthPath(aPos, bPos, off);
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
        inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.4, gap: 5, lane });
      } else if (layer === 'routing') {
        inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
      } else {
        inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.8, gap: 5, lane });
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
        const p = orthPath(aPos, bPos, off);
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
      inner += lagDoubleLineHTML(aPos, bPos, { stroke: '#9aa0a8', width: 1.4, gap: 5, lane });
    }
  } else if (layer === 'routing') {
    // L3 view. Every wire (regular link OR LAG-bundle rep) draws as a single
    // dim dashed underlay. The colourful streams live in the dedicated
    // m002-l3-paths layer floating above. Suppressing the LAG double-line
    // here avoids stacking it under the L3 ribbon and producing four
    // parallel highlights between two collapsed stacks.
    inner += `<path class="m002-link-line m002-link-dim" d="${base.d}" stroke="#2a2a36" stroke-dasharray="4 3"/>`;
  } else {
    inner += `<path class="m002-link-line" d="${base.d}" stroke="#9aa0a8"/>`;
    const lagA = findPortLag(s, a.id, link.fromPort)?.lag;
    const lagB = findPortLag(s, b.id, link.toPort)?.lag;
    const fromTxt = link.fromPort ? portLabel(a, link.fromPort) + (lagA ? ` (${lagA.name})` : '') : '';
    const toTxt   = link.toPort   ? portLabel(b, link.toPort)   + (lagB ? ` (${lagB.name})` : '') : '';
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
    : `<span class="m002-vlan-empty">no routes — type an IP on the interface above and a default route appears here automatically</span>`;
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
      const apply = (rerender) => {
        const f = el.dataset.ifF;
        const val = f === 'ip' ? normalizeIpInput(el.value) : el.value;
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
          // First IP on a router/firewall: drop in a default route so the
          // gateway is visible and editable in the routes table without the
          // user having to add it manually. The next-hop is .1-of-the-net,
          // suppressed when the iface IS .1 (defaultGatewayFor handles that).
          const added = autoCreateDefaultRoute(dev.routes, iface.ip, iface.prefix, iface.id);
          subnetsChanged(s);
          if (added) { refreshSelfAndCanvas(); openInspector(s); return; }
        }
        refreshSelfAndCanvas();
        if (rerender) openInspector(s);
      };
      if (isSelect) {
        el.addEventListener('change', () => apply(true));
      } else {
        el.addEventListener('input', () => apply(false));
        el.addEventListener('change', () => {
          if (el.dataset.ifF === 'ip') {
            const fixed = normalizeIpInput(el.value);
            if (fixed !== el.value) { el.value = fixed; apply(false); }
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
      const apply = (rerender) => {
        const f = el.dataset.vifF;
        const val = f === 'ip' ? normalizeIpInput(el.value) : el.value;
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
          routeAdded = autoCreateDefaultRoute(stack.routes, vif.ip, vif.prefix, vif.id);
          subnetsChanged(s);
        }
        refresh();
        if (rerender || routeAdded) openInspector(s);
      };
      if (isSelect) el.addEventListener('change', () => apply(true));
      else {
        el.addEventListener('input', () => apply(false));
        el.addEventListener('change', () => {
          if (el.dataset.vifF === 'ip') {
            const fixed = normalizeIpInput(el.value);
            if (fixed !== el.value) { el.value = fixed; apply(false); }
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
    <p class="m002-link-hint">×${agg.linkIds.length} link${agg.linkIds.length === 1 ? '' : 's'} between <b>${escSvg(sideName(agg.aSide, stkA))}</b> and <b>${escSvg(sideName(agg.bSide, stkB))}</b>. Configure a LAG to bundle them.</p>
    ${sideBlock('SIDE A', agg.aSide, stkA)}
    ${sideBlock('SIDE B', agg.bSide, stkB)}
    ${linksTable}
    <button type="button" class="m002-action" data-agg-create>CREATE LAG${(stkA && stkB) ? '-PAIR' : ''}</button>
    <p class="m002-link-hint">Tip: a "LAG-pair" creates and counterparts a LAG on each stack so the bundle visually reads as a single double-line afterwards.</p>
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
  body.innerHTML = `
    <p class="m002-link-hint">Preferences are stored locally and apply across all maps.</p>
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
  `;
  body.querySelectorAll('[data-pref]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.pref;
      const val = el.type === 'checkbox' ? el.checked : el.value;
      s.prefs[key] = val;
      savePrefs(s.prefs);
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
    <p class="m002-link-hint">Aktuelle Kameraposition als Landeansicht für diesen JUMP speichern. Beim nächsten Sprung des Partner-JUMPs schwenkt die Kamera genau hierhin.</p>
  `;
  const coupleSection = peer ? `
    <div class="m002-field">
      <span>COUPLED PEER</span>
      <div class="m002-couple-card">
        <div class="m002-couple-line"><span class="m002-couple-arrow">⇄</span><span>${escSvg(peer.name)}</span></div>
        <div class="m002-couple-zone">${escSvg(peerZone ? peerZone.name : '(zone missing)')}</div>
      </div>
    </div>
    <p class="m002-link-hint">JUMP-Paar bildet einen Hub: alle Hub-Legs auf beiden Seiten teilen sich eine Broadcast-Domain. Ports auf der Far-Side erscheinen im Port-Modal als Counterpart.</p>
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
    ${candidates.length === 0 ? '<p class="m002-link-hint">Keine weiteren JUMPs auf dieser Map. Erst einen JUMP in einer anderen Zone erstellen.</p>' : '<p class="m002-link-hint">Auswahl koppelt sofort. Die Far-Side wird mit-aktualisiert. Ungekoppelte JUMPs können auch als reines ZONE/MAP-Lesezeichen dienen (siehe FALLBACK TARGET).</p>'}
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
        <p class="m002-link-hint">Stacks mit Hub-Legs auf beiden Seiten — ein Klick bondet alle Ports der Seite zu einer LAG und counterparts sie über das JUMP-Paar.</p>
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
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="device:${escAttr(dev.id)}"></div>
      </div>
      <div class="m002-ports-block">
        <div class="m002-ports-head">PORT TABLE (${dev.ports.length})</div>
        <div class="m002-ports-grid">
          <div class="m002-port-head-row">
            <span>#</span><span>PORT</span><span>COUNTERPART</span>
          </div>
          ${dev.ports.map((p) => {
            const cp = counterpartFor(s, dev.id, p.n);
            const lagInfo = findPortLag(s, dev.id, p.n);
            const lagBadge = lagInfo ? ` <span class="m002-port-lagtag" title="part of ${escAttr(lagInfo.lag.name)} (${escAttr(lagInfo.stack.name)})">→ ${escSvg(lagInfo.lag.name)}</span>` : '';
            return `
            <div class="m002-port-row" data-port-open="${p.n}" tabindex="0">
              <span class="m002-port-num">${p.n}</span>
              <input data-port="${p.n}" data-pf="name" value="${escAttr(p.name)}" placeholder="port name"/>
              <span class="m002-port-counter ${cp ? '' : 'dim'}">${escSvg(cp || '—')}${lagBadge}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
      <button type="button" class="m002-insp-del" data-del>DELETE NODE</button>
    `;
    body.querySelectorAll('[data-f]').forEach((el) => {
      el.addEventListener('input', () => updateDeviceField(s, dev, el));
      el.addEventListener('change', () => {
        // IP fields: write the normalized form back into the input so the
        // user sees the correction (e.g. "10.0.0.05" → "10.0.0.5") on blur.
        if (el.dataset.f === 'ip' && el.tagName === 'INPUT') {
          const fixed = normalizeIpInput(el.value);
          if (fixed !== el.value) el.value = fixed;
        }
        updateDeviceField(s, dev, el);
        // Commit-only refresh for the port count: rebuilds the port table to
        // match the new size. We skip on 'input' to avoid clobbering focus
        // mid-keystroke; 'type' already re-opens itself inside the handler.
        if (el.dataset.f === 'ports') openInspector(s);
      });
    });
    // Persist the //DETAILS open/closed state across inspector re-renders so
    // a +/− click (or any other rerender) doesn't surprise the user by
    // collapsing the panel they had just expanded.
    body.querySelector('.m002-insp-details')?.addEventListener('toggle', (e) => {
      s.inspectorDetailsOpen = e.target.open;
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
    body.querySelectorAll('[data-port]').forEach((el) => {
      el.addEventListener('input', () => {
        const p = dev.ports.find((pp) => pp.n === Number(el.dataset.port));
        if (!p) return;
        p[el.dataset.pf] = el.value;
        // Counterpart text in this row stays the same; redraw link labels
        s.links.filter((l) => (l.from === dev.id && Number(l.fromPort) === p.n) || (l.to === dev.id && Number(l.toPort) === p.n))
              .forEach((l) => redrawLink(s, l));
        schedSave(s);
        refreshDetailViewIfSettled(s);
      });
      // Don't open the port modal when the user clicks INTO the input
      el.addEventListener('click', (ev) => ev.stopPropagation());
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
    idEl.textContent = `// LINK`;
    const portCell = (dev, side) => {
      if (isReference(dev)) {
        return `<label class="m002-field"><span>${side} PORT</span><div class="m002-field-static">JUMP — no port</div></label>`;
      }
      const f = side === 'FROM' ? 'fromPort' : 'toPort';
      const cur = side === 'FROM' ? link.fromPort : link.toPort;
      return `<label class="m002-field"><span>${side} PORT</span>
        <select data-f="${f}"><option value="">—</option>${(dev?.ports || []).map((p) => `<option value="${p.n}" ${String(cur) === String(p.n) ? 'selected' : ''}>${p.n}${p.name ? ' · ' + escAttr(p.name) : ''}</option>`).join('')}</select>
      </label>`;
    };
    const isHubLeg = aRef || bRef;
    body.innerHTML = `
      <div class="m002-link-summary">
        <span class="m002-link-end">${escSvg(a?.name || '?')}</span>
        <span class="m002-link-arrow">⇄</span>
        <span class="m002-link-end">${escSvg(b?.name || '?')}</span>
      </div>
      <div class="m002-row2">
        ${portCell(a, 'FROM')}
        ${portCell(b, 'TO')}
      </div>
      <div class="m002-field">
        <span>VLANS${isHubLeg ? '' : ' (port-pair)'}</span>
        <div class="m002-vlan-picker" data-vlan-target="link:${escAttr(link.id)}"></div>
      </div>
      <p class="m002-link-hint">${isHubLeg
        ? 'JUMP hub-leg: der Knoten reicht VLANs und Topologie unverändert weiter.'
        : 'Aktivierte VLANs werden auf beide Ports gesetzt. Es erscheinen nur VLANs, die auf beiden Devices verfügbar sind.'}</p>
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
          <p class="m002-link-hint">Stacking cables zwischen Stack-Members. Werden als gestrichelte Linien angezeigt, wenn der Stack expanded ist.</p>
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
      <div class="m002-field">
        <span>VLANS</span>
        <div class="m002-vlan-picker" data-vlan-target="stack:${escAttr(stack.id)}"></div>
      </div>
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
    onL3DeviceFieldChanged(s, dev);
  } else {
    dev[f] = f === 'ip' ? normalizeIpInput(el.value) : el.value;
    if (f === 'name' || f === 'ip' || f === 'notes') redrawDevice(s, dev);
    if (f === 'name') {
      // Counterpart text on other devices' inspector rows references this name
      s.links.filter((l) => l.from === dev.id || l.to === dev.id).forEach((l) => redrawLink(s, l));
    }
    if (f === 'ip') onL3DeviceFieldChanged(s, dev);
  }
  schedSave(s);
  refreshDetailViewIfSettled(s);
}

// Shared post-edit logic for non-L3 device IP/prefix changes: auto-add the
// derived subnet to the registry (so the legend lights up immediately),
// auto-fill the gateway if blank, refresh the subnet legend + routing-layer
// link visuals.
function onL3DeviceFieldChanged(s, dev) {
  if (isL3Type(dev.type) || isReference(dev)) return;
  let routeAdded = false;
  if (dev.ip) {
    const cidr = `${dev.ip}/${dev.prefix != null ? dev.prefix : 24}`;
    const p = parseCidr(cidr);
    if (p && p.prefix < 31) subnetRegistryAdd(s, `${p.network}/${p.prefix}`, '');
    if (!Array.isArray(dev.routes)) dev.routes = [];
    routeAdded = autoCreateDefaultRoute(dev.routes, dev.ip, dev.prefix, null);
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
  link[el.dataset.f] = el.value;
  redrawLink(s, link);
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
      const chip = (v, on, dim) => `<span class="m002-vlan-chip-btn ${on ? 'on' : ''} ${dim ? 'dim' : ''}" style="--vc:${vlanColor(s, v)}">VLAN ${escSvg(v)}</span>`;
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

  body.querySelector('.m002-pmodal-name').addEventListener('input', (e) => {
    port.name = e.target.value;
    schedSave(s);
    s.links.filter((l) => (l.from === deviceId && Number(l.fromPort) === portN) || (l.to === deviceId && Number(l.toPort) === portN))
          .forEach((l) => redrawLink(s, l));
    const row = s.inspector.querySelector(`[data-port-open="${portN}"] [data-port="${portN}"][data-pf="name"]`);
    if (row) row.value = port.name;
    refreshDetailViewIfSettled(s);
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
  s.host?.querySelector('.m002-detail-overlay .m002-detail-device')?.classList.add('is-selected');
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

function vfxSnapshot(s) {
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
      // Key includes the container so a stack envelope and a stack icon —
      // both keyed by data-stack-id but in different groups — don't collide.
      map.set(grp.container + '|' + grp.idAttr + '|' + id, { el, center, frozen });
    });
  }
  return map;
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

function vfxLocalToWorld(parentG, x, y) {
  const t = parentG?.transform?.baseVal?.consolidate?.();
  const m = t ? t.matrix : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

// For a shape, decide where the bright should remain at the end of the drain
// (= where it grows from at the start of the build). Returns a "destination"
// descriptor used by vfxApplyDrain to position the surviving dash.
//   - kind 'four-mid' + w/h: closed-perimeter (rect) → 4 bright sections, one
//                            per side, each centred on its side's midpoint;
//                            symmetric, anchor-agnostic ("4 separate drains")
//   - kind 'tail'           : open path → dash anchored at end (path end is
//                             closer to anchor, OR L3 route in DRAIN phase)
//   - kind 'head'           : open path → dash anchored at start (start
//                             closer to anchor, OR L3 route in BUILD phase)
//   - kind 'middle'         : symmetric drain (no anchor) — the cap-gap-cap
//                             pattern from the centre
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
  if (!anchor) return { kind: 'middle' };
  // path / line / polyline / polygon — work off endpoints
  let L = 0, p0, p1;
  try {
    L = shapeEl.getTotalLength();
    if (L > 0) { p0 = shapeEl.getPointAtLength(0); p1 = shapeEl.getPointAtLength(L); }
  } catch (_) { /* ignore */ }
  if (!p0 || !p1) return { kind: 'middle' };
  const w0 = vfxLocalToWorld(parentG, p0.x, p0.y);
  const w1 = vfxLocalToWorld(parentG, p1.x, p1.y);
  const d0 = (w0.x - anchor.x) ** 2 + (w0.y - anchor.y) ** 2;
  const d1 = (w1.x - anchor.x) ** 2 + (w1.y - anchor.y) ** 2;
  return d0 < d1 ? { kind: 'head' } : { kind: 'tail' };
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
  // For phase === 'build' the wrapper opacity owns the fade (and the glow
  // halo fades with it), so we skip the inline fill/text opacity work to
  // avoid double-fading. For phase === 'drain' we still want the fills/
  // texts to vanish on top of the dasharray drain so the clone fully
  // disappears before it's removed.
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
  // Visibility (fill / text / glow) rides the wrapper's opacity in BOTH
  // phases so the drop-shadow halo fades smoothly with the rest of the
  // element instead of popping. Inline fades aren't needed here.
}

function vfxSuppressFilters(el) {
  // Glow off on the wrapper + every SVG descendant so exit clones don't
  // carry a halo while their stroke drains away (and read as a "flash").
  el.style.filter = 'none';
  el.querySelectorAll('*').forEach((n) => { if (n instanceof SVGElement) n.style.filter = 'none'; });
}

function vfxRestoreFilters(el) {
  el.style.filter = '';
  el.querySelectorAll('*').forEach((n) => { if (n instanceof SVGElement) n.style.filter = ''; });
}

// For builds: capture the natural CSS opacity as the fade target, then drop
// the wrapper to opacity 0 inline. The rAF step ramps it back up to target
// over the same window the dasharray builds in. The drop-shadow halo is
// part of the wrapper's render output so it scales with this opacity —
// glow now fades in instead of popping at the end.
function vfxStartBuildFade(el) {
  const cs = window.getComputedStyle(el);
  const target = parseFloat(cs.opacity || '1');
  el.style.opacity = '0';
  return Number.isFinite(target) ? target : 1;
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

function vfxClearBuildFade(el) {
  el.style.opacity = '';
  vfxStripEmptyStyle(el);
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

function showSnapPreview(s, snapX, snapY, accent) {
  const layer = s.gOverlay;
  if (!layer) return;
  let el = s.snapPreviewEl;
  if (!el || !el.isConnected) {
    el = document.createElementNS(SVG_NS, 'rect');
    el.setAttribute('class', 'm002-snap-preview');
    el.setAttribute('width', String(DEVICE_W));
    el.setAttribute('height', String(DEVICE_H));
    el.setAttribute('rx', '3');
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke-width', '1');
    el.setAttribute('stroke-dasharray', '5 4');
    el.setAttribute('pointer-events', 'none');
    layer.appendChild(el);
    s.snapPreviewEl = el;
  }
  el.setAttribute('x', String(snapX - DEVICE_W / 2));
  el.setAttribute('y', String(snapY - DEVICE_H / 2));
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
function scheduleSnapPreview(s, snapX, snapY, accent) {
  const cellKey = `${snapX}|${snapY}`;
  if (s._snapPreviewKey === cellKey) {
    // Same cell as last frame — leave any pending timer / shown ghost alone.
    if (s._snapPreviewPending) s._snapPreviewPending.accent = accent;
    return;
  }
  s._snapPreviewKey = cellKey;
  s._snapPreviewPending = { snapX, snapY, accent };
  hideSnapPreview(s);
  if (s._snapPreviewTimer) clearTimeout(s._snapPreviewTimer);
  s._snapPreviewTimer = setTimeout(() => {
    s._snapPreviewTimer = null;
    const p = s._snapPreviewPending;
    if (!p) return;
    showSnapPreview(s, p.snapX, p.snapY, p.accent);
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

// =============================================================================
// Radial action menu — opens on background double-click
// =============================================================================
// 4 outer segments arranged at the cardinal directions:
//   N (top)    NEW       → expands inward into a 6-segment device picker
//   E (right)  LINK      → toggle link mode at click pos
//   S (bottom) DELETE    → toggle delete mode
//   W (left)   UNDO      → step back in history
// Click anywhere outside / ESC dismiss the menu. Submenu picks spawn the
// chosen device at the original double-click world position.

const RADIAL_OUTER_R = 130;
const RADIAL_INNER_R = 50;
const RADIAL_GAP_DEG = 4;          // gap between outer-ring segments
const RADIAL_SUB_GAP_DEG = 3;      // gap inside the device submenu

const RADIAL_PRIMARY = [
  { id: 'new',  dir: 'N', center: -90, label: 'NEW',  glyph: '+'  },
  { id: 'move', dir: 'E', center:   0, label: 'MOVE', glyph: '↦' },
  { id: 'tool', dir: 'S', center:  90, label: 'TOOL', glyph: '⚙' },
  { id: 'undo', dir: 'W', center: 180, label: 'UNDO', glyph: '↶' },
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

function openRadialMenu(s, clientX, clientY) {
  closeRadialMenu(s);
  const w = clientToWorld(s, clientX, clientY);
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

function closeRadialMenu(s) {
  if (!s.radial) return;
  const r = s.radial;
  s.radial = null;
  r.cleanup?.();
  r.el.classList.remove('m002-radial-in');
  r.el.classList.add('m002-radial-out');
  setTimeout(() => r.el.remove(), 160);
}

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
    if (s.linkMode) toggleLinkMode(s);
    if (s.deleteMode) toggleDeleteMode(s);
    closeRadialMenu(s);
    return;
  }
  if (action === 'select') {
    // TOOL submenu's default — clears any armed mode, then dismisses.
    if (s.linkMode) toggleLinkMode(s);
    if (s.deleteMode) toggleDeleteMode(s);
    closeRadialMenu(s);
    return;
  }
  if (action === 'link') {
    closeRadialMenu(s);
    if (!s.linkMode) toggleLinkMode(s);
    return;
  }
  if (action === 'delete') {
    closeRadialMenu(s);
    if (!s.deleteMode) toggleDeleteMode(s);
    return;
  }
  if (action === 'undo') {
    closeRadialMenu(s);
    undo(s);
    return;
  }
  if (action.startsWith('spawn:')) {
    const typeId = action.slice('spawn:'.length);
    const w = s.radial?.world;
    closeRadialMenu(s);
    if (w) spawnDeviceAt(s, typeId, w.x, w.y);
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
    switchZone(s, zoneId);
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
    // Glyph closer to inner edge, label closer to outer edge — radial reading
    // order from centre outward stays consistent across all four directions.
    const glyphPos = polarXY(cx, cy, RADIAL_INNER_R + 22, seg.center);
    const labelPos = polarXY(cx, cy, RADIAL_OUTER_R - 18, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${glyphPos.x}" y="${glyphPos.y + 8}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${seg.label}</text>
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
  const N = DEVICE_TYPES.length; // 6
  const slice = 360 / N;
  const half = slice / 2;
  // Place the first slice's center at -90° (top) so the picker reads from top.
  let segs = '';
  DEVICE_TYPES.forEach((t, i) => {
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
    const glyphPos = polarXY(cx, cy, RADIAL_INNER_R + 22, seg.center);
    const labelPos = polarXY(cx, cy, RADIAL_OUTER_R - 18, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${glyphPos.x}" y="${glyphPos.y + 8}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${seg.label}</text>
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
    const glyphPos = polarXY(cx, cy, RADIAL_INNER_R + 22, seg.center);
    const labelPos = polarXY(cx, cy, RADIAL_OUTER_R - 18, seg.center);
    segs += `
      <g class="m002-rad-seg" data-radial-action="${seg.id}" data-dir="${seg.dir}">
        <path class="m002-rad-seg-path" d="${path}"/>
        <text class="m002-rad-seg-glyph" x="${glyphPos.x}" y="${glyphPos.y + 8}" text-anchor="middle">${seg.glyph}</text>
        <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${seg.label}</text>
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
            font-family="'Share Tech Mono',monospace" font-size="10" letter-spacing="1.6">
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
        <g class="m002-rad-seg m002-rad-seg-zone${isActive ? ' m002-rad-seg-zone-active' : ''}" data-radial-action="zone:${escAttr(z.id)}">
          <path class="m002-rad-seg-path" d="${path}"/>
          <text class="m002-rad-seg-label" x="${labelPos.x}" y="${labelPos.y + 4}" text-anchor="middle">${escSvg(z.name)}</text>
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

function vfxAnimateView(s, doRender, anchor) {
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
  const before = vfxSnapshot(s);
  doRender();
  const after = vfxSnapshot(s);

  // Anchor for directional drain. Explicit point wins (e.g. clicked Jump's
  // world position). Otherwise the centroid of persisting elements; if none
  // persists, the centroid of the new view; if that's also empty, no anchor
  // and the drain falls back to the symmetric cap-gap-cap from the middle.
  const persisting = new Map();
  for (const [k, entry] of after) if (before.has(k)) persisting.set(k, entry);
  const drainAnchor = anchor || vfxCentroid(persisting) || vfxCentroid(after) || vfxCentroid(before);
  const buildAnchor = anchor || vfxCentroid(persisting) || vfxCentroid(before) || vfxCentroid(after);

  // EXITS — clone old element, drain it, remove. Wrapper opacity rides
  // OLD-opacity → 0 over the same window so the drop-shadow halo fades
  // smoothly with the wall (no glow-pop at start of drain).
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
    const startOpacity = vfxFrozenOpacity(entry);
    clone.style.opacity = String(startOpacity);
    drains.push({ clone, parts, startOpacity });
  }

  // BUILDS — fresh element in its real container, build it up from empty.
  // Wrapper opacity rides 0 → CSS-target so the drop-shadow halo fades in
  // along with the wall (no end-of-animation glow pop).
  const builds = [];
  for (const [key, entry] of after) {
    if (before.has(key)) continue;
    const newEl = entry.el;
    const parts = vfxCollectAnimatables(newEl, buildAnchor, 'build');
    if (parts.shapes.length === 0 && parts.fades.length === 0) continue;
    const target = vfxStartBuildFade(newEl);
    builds.push({ el: newEl, parts, target });
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
    // rides oldOpacity → 0 in lockstep with the dasharray drain, so the
    // glow halo fades along with everything else.
    const clone = oldEntry.el.cloneNode(true);
    clone.style.pointerEvents = 'none';
    const startOpacity = vfxFrozenOpacity(oldEntry);
    clone.style.opacity = String(startOpacity);
    clone.querySelectorAll('.m002-link-flow').forEach((n) => n.remove());
    s.gExits.appendChild(clone);
    const drainParts = vfxCollectAnimatables(clone, drainAnchor, 'drain');
    if (drainParts.shapes.length > 0 || drainParts.fades.length > 0) {
      drains.push({ clone, parts: drainParts, startOpacity });
    } else {
      clone.remove();
    }

    // Build up the NEW look on the underlying real element. Same machinery
    // as fresh-entry builds — wrapper opacity 0 → target, glow naturally
    // scales with it, no filter suppression / restore pop at the end.
    const newEl = newEntry.el;
    const buildParts = vfxCollectAnimatables(newEl, buildAnchor, 'build');
    if (buildParts.shapes.length > 0 || buildParts.fades.length > 0) {
      const target = vfxStartBuildFade(newEl);
      builds.push({ el: newEl, parts: buildParts, target });
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
  function finish() {
    if (finished) return;
    finished = true;
    for (const d of drains) d.clone.remove();
    for (const b of builds) {
      vfxResetInlineParts(b.parts);
      vfxClearBuildFade(b.el);
    }
    if (s._vfxFinish === finish) s._vfxFinish = null;
  }
  s._vfxFinish = finish;

  const start = performance.now();
  function step(now) {
    if (finished) return;
    const t = Math.min(1, (now - start) / VFX_DRAIN_MS);
    const e = vfxEaseInOutQuad(t);
    for (const d of drains) {
      vfxApplyDrain(d.parts, e, 'drain');
      d.clone.style.opacity = String(d.startOpacity * (1 - e));
    }
    for (const b of builds) {
      vfxApplyDrain(b.parts, 1 - e, 'build');
      b.el.style.opacity = String(b.target * e);
    }
    if (t < 1) { requestAnimationFrame(step); return; }
    finish();
  }
  requestAnimationFrame(step);
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
// the user before the panel scales in. Easing is `easeOutExpo` (JS) /
// cubic-bezier(0.16,1,0.3,1) (CSS) — the same family — so motion across the
// JS and CSS sides reads as one coordinated decel.
const DETAIL_ANIM_MS       = 350;
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
  animateView(s, { x: targetX, y: targetY, zoom: targetZoom }, DETAIL_ANIM_MS);
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

function exitDetailView(s) {
  if (!s.detailDeviceId) return;
  s.detailDeviceId = null;
  if (s._detailSettleTimer) { clearTimeout(s._detailSettleTimer); s._detailSettleTimer = null; }
  const overlay = s.host.querySelector('.m002-detail-overlay');
  if (overlay) {
    overlay.classList.remove('m002-detail-overlay-show');
    overlay.classList.remove('m002-detail-overlay-settled');
    // Snappier exit than entry — feels responsive when the user wants out.
    setTimeout(() => { if (!s.detailDeviceId) overlay.hidden = true; }, DETAIL_FADE_OUT_MS);
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
  if (!link) return { kind: 'access', occupied: false, peer: null };
  const peerId = link.from === dev.id ? link.to : link.from;
  const peer = s.devices.find((d) => d.id === peerId) || null;
  const isUplink = peer && peer.type !== 'endpoint';
  return { kind: isUplink ? 'uplink' : 'access', occupied: true, peer };
}

const DETAIL = {
  port: { w: 44, h: 52 },
  gap: 6,
  device: { w: 720, h: 180 },
  vgap: 32,
  pad: 48,
  maxCols: 24,
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
  body.innerHTML = renderDetailBody(s, dev, t);
}

function renderDetailBody(s, dev, t) {
  const cls = (dev.ports || []).map((p) => ({ p, info: classifyDetailPort(s, dev, p.n) }));
  const uplinks = cls.filter((c) => c.info.kind === 'uplink');
  const access  = cls.filter((c) => c.info.kind === 'access');

  const D = DETAIL;
  const rowW = (n) => n <= 0 ? 0 : n * D.port.w + (n - 1) * D.gap;
  const upCount = Math.min(D.maxCols, uplinks.length);
  const acCols  = Math.min(D.maxCols, Math.max(1, access.length));
  const acRows  = Math.max(1, Math.ceil(access.length / D.maxCols));
  const upW     = rowW(upCount);
  const acW     = access.length ? rowW(acCols) : 0;
  const innerW  = Math.max(D.device.w, upW, acW);
  const totalW  = innerW + D.pad * 2;

  // Stub line length and the matching padding so the stub never overflows the
  // viewBox. Defined here (above the layout math) so the totalH calculation
  // can grow the page when sections are present.
  const STUB_LEN = (D.vgap - 8) * 5;
  const stubPad  = STUB_LEN + 12;
  const upPad    = uplinks.length ? Math.max(D.pad, stubPad) : D.pad;
  const dnPad    = access.length  ? Math.max(D.pad, stubPad) : D.pad;

  const upRowH  = uplinks.length ? D.port.h + D.vgap : 0;
  const acRowsH = access.length  ? acRows * D.port.h + (acRows - 1) * D.gap + D.vgap : 0;
  const totalH  = upPad + upRowH + D.device.h + acRowsH + dnPad;

  const cx     = totalW / 2;
  const devX   = cx - D.device.w / 2;
  const devY   = upPad + upRowH;
  const upY    = upPad;
  const acStartY = devY + D.device.h + D.vgap;

  // Per-port enter delay (animation cascade). Element finishes around 1000ms,
  // then ports stagger every PORT_STAGGER_MS. Stubs derive their delay from
  // the parent port via a CSS calc() so they always come last on a port.
  const PORT_BASE_DELAY = 1070;
  const PORT_STAGGER_MS = 25;
  let portIndex = 0;

  const portSvg = (entry, x, y, dir /* 'up' | 'down' */) => {
    const { p, info } = entry;
    const occ = info.occupied;
    const firstV = (p.vlans || [])[0];
    const stripe = occ ? (firstV ? vlanColor(s, firstV) : t.accent) : '#2a2a36';
    const stroke = occ ? t.accent : '#2a2a36';
    const dash   = occ ? '' : ' stroke-dasharray="4 3"';
    const peerAbbr = (occ && info.peer) ? abbrPeer(info.peer) : '';

    // Empty ports: show port name (truncated) instead of the index. No
    // number — the index is implicit from grid position; the name is the
    // user-meaningful identifier ("GE0/0/12").
    let labelSvg = '';
    if (occ) {
      const numY = peerAbbr ? D.port.h / 2 + 2 : D.port.h / 2 + 8;
      labelSvg += `<text class="m002-detail-port-num" x="${D.port.w / 2}" y="${numY}" text-anchor="middle">${p.n}</text>`;
      if (peerAbbr) labelSvg += `<text class="m002-detail-port-peer" x="${D.port.w / 2}" y="${D.port.h - 10}" text-anchor="middle">${escSvg(peerAbbr)}</text>`;
    } else if (p.name) {
      const trimmed = String(p.name).slice(0, 7);
      labelSvg += `<text class="m002-detail-port-name" x="${D.port.w / 2}" y="${D.port.h / 2 + 4}" text-anchor="middle">${escSvg(trimmed)}</text>`;
    }

    // Stub: only on occupied ports. Drawn behind the box (via SVG order).
    let stubSvg = '';
    if (occ) {
      const stubW = 1.4;
      const stubX = D.port.w / 2 - stubW / 2;
      if (dir === 'up') {
        stubSvg = `<rect class="m002-detail-stub" x="${stubX}" y="${-STUB_LEN}" width="${stubW}" height="${STUB_LEN}" fill="url(#m002-stub-up)"/>`;
      } else {
        stubSvg = `<rect class="m002-detail-stub" x="${stubX}" y="${D.port.h}" width="${stubW}" height="${STUB_LEN}" fill="url(#m002-stub-down)"/>`;
      }
    }

    const enterDelay = PORT_BASE_DELAY + portIndex * PORT_STAGGER_MS;
    portIndex++;
    // Inner-wrapper holds the visual content. We animate the inner group's
    // transform (scale) without touching the outer's SVG `transform="translate"`,
    // which is the only thing keeping the port at its grid position. Without
    // this split, a CSS scale on the outer group would clobber the translate
    // and the port would render at (0,0).
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

  // Inline gradient defs for the port stubs — one fades from transparent at
  // the page edge to solid where it meets the port; the other reverses. The
  // stop-color uses the device's accent so the stubs visually tie to the
  // central element.
  let inner = `
    <defs>
      <linearGradient id="m002-stub-up" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${t.accent}" stop-opacity="0"/>
        <stop offset="1" stop-color="${t.accent}" stop-opacity="0.55"/>
      </linearGradient>
      <linearGradient id="m002-stub-down" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="${t.accent}" stop-opacity="0.55"/>
        <stop offset="1" stop-color="${t.accent}" stop-opacity="0"/>
      </linearGradient>
    </defs>
  `;

  // Device box (centered). Marked .is-selected by default since entering the
  // detail view selects the device — the click handler shifts the class to
  // the active port when one is clicked, and back to the device on element
  // click. Without this the central element looks dormant on entry.
  // The inner <g> exists so CSS can apply a scale animation around the
  // device's center on entry without fighting the parent's translate().
  const nameY = dev.ip ? D.device.h / 2 + 4 : D.device.h / 2 + 10;
  const ipY   = D.device.h / 2 + 36;
  const devSelected = !s.portModalOpen || s.portModalOpen.deviceId !== dev.id;
  const devInnerStyle = `transform-origin:${D.device.w / 2}px ${D.device.h / 2}px;`;
  inner += `
    <g class="m002-detail-device ${devSelected ? 'is-selected' : ''}" data-detail-stop="1" transform="translate(${devX} ${devY})" style="--accent:${t.accent}">
      <g class="m002-detail-device-inner" style="${devInnerStyle}">
        <rect class="m002-detail-dev-bg" width="${D.device.w}" height="${D.device.h}" fill="#0a0a10" stroke="${t.accent}" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
        <text class="m002-detail-dev-type" x="22" y="32">${t.label}</text>
        <text class="m002-detail-dev-name" x="${D.device.w / 2}" y="${nameY}" text-anchor="middle">${escSvg(dev.name || '')}</text>
        ${dev.ip ? `<text class="m002-detail-dev-ip" x="${D.device.w / 2}" y="${ipY}" text-anchor="middle">${escSvg(dev.ip)}</text>` : ''}
      </g>
    </g>
  `;

  // Uplink row (centered above device)
  if (uplinks.length) {
    const startX = cx - upW / 2;
    uplinks.slice(0, D.maxCols).forEach((c, i) => {
      inner += portSvg(c, startX + i * (D.port.w + D.gap), upY, 'up');
    });
  }

  // Access grid (multi-row, centered) below device
  if (access.length) {
    for (let r = 0; r < acRows; r++) {
      const slice = access.slice(r * D.maxCols, (r + 1) * D.maxCols);
      const startX = cx - rowW(slice.length) / 2;
      slice.forEach((c, i) => {
        inner += portSvg(c, startX + i * (D.port.w + D.gap), acStartY + r * (D.port.h + D.gap), 'down');
      });
    }
  }

  // Render at intrinsic viewBox size (1 unit = 1 CSS px) so the element keeps
  // the dimensions designed in DETAIL.* — without this the SVG would stretch
  // to fill the body via CSS width:100% and the visible element would not
  // shrink when DETAIL.device.w shrinks.
  return `
    <svg class="m002-detail-svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" preserveAspectRatio="xMidYMid meet">
      ${inner}
    </svg>
  `;
}

// Smooth viewport tween for enter/exitDetailView. Cancels any running tween.
// Does NOT call schedSave — the user didn't intend to move the map.
// Easing: easeOutExpo. Decelerates aggressively at the end for a "settling"
// feel that complements the CSS overlay fade.
function animateView(s, target, durationMs) {
  if (s._viewAnimRaf) cancelAnimationFrame(s._viewAnimRaf);
  const start = { x: s.view.x, y: s.view.y, zoom: s.view.zoom };
  const t0 = performance.now();
  const ease = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
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
  return {
    v: 4,
    devices: s.devices, links: s.links, stacks: s.stacks,
    vlanRegistry: s.vlanRegistry,
    subnetRegistry: s.subnetRegistry,
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
  s.subnetRegistry = Array.isArray(data.subnetRegistry) ? data.subnetRegistry : [];
  s.zones = Array.isArray(data.zones) && data.zones.length ? data.zones : [{ id: 'z_main', name: 'Main' }];
  s.activeZone = data.activeZone && s.zones.find((z) => z.id === data.activeZone) ? data.activeZone : s.zones[0].id;
  s.view = { ...DEFAULT_VIEW, ...(data.view || {}) };
  if (!Array.isArray(s.view.vlanFilter)) s.view.vlanFilter = [];
  if (!Array.isArray(s.view.subnetFilter)) s.view.subnetFilter = [];
  if (!s.view.zoneViews || typeof s.view.zoneViews !== 'object') s.view.zoneViews = {};
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
// Utils
// =============================================================================
function rid() { return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

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
// CSS
// =============================================================================
const MOD002_CSS = `
.m002-host{position:absolute;inset:0;overflow:hidden;font-family:'Rajdhani',sans-serif;color:#e8e8ee;background:radial-gradient(ellipse at 50% 0%,#0d0d14 0%,#06060a 70%);display:grid;grid-template-columns:220px 1fr 320px;grid-template-rows:1fr;isolation:isolate;}
.m002-leftpanel{background:rgba(8,8,14,0.92);border-right:1px solid #1a1a22;padding:14px 12px;overflow:hidden;display:flex;flex-direction:column;gap:14px;min-height:0;}
.m002-leftpanel-spacer{flex:0 0 8px;}
.m002-panel-section.m002-panel-section--legend{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column;}
.m002-panel-section.m002-panel-section--legend .m002-vlan-legend-body,
.m002-panel-section.m002-panel-section--legend .m002-subnet-legend-body{flex:1 1 auto;min-height:0;overflow:hidden;}
/* Layer-aware legends: VLAN legend lives in the VLAN layer; subnet legend
   in the routing layer. The other two layers see the off-topic ones hidden
   so the left rail stays focused on what's relevant to the current view. */
.m002-host[data-active-layer="vlan"] .m002-panel-section--subnets,
.m002-host[data-active-layer="physical"] .m002-panel-section--subnets,
.m002-host[data-active-layer="physical"] .m002-panel-section--legend:not(.m002-panel-section--subnets){display:none;}
.m002-host[data-active-layer="routing"] .m002-panel-section--legend:not(.m002-panel-section--subnets){display:none;}
.m002-rightpanel{background:rgba(8,8,14,0.92);border-left:1px solid #1a1a22;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;min-height:0;}
.m002-center{position:relative;overflow:hidden;}
.m002-panel-section{display:flex;flex-direction:column;gap:6px;}
.m002-panel-title{margin:0 0 4px 0;font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:2px;font-weight:400;text-transform:uppercase;}
.m002-panel-grid{display:flex;flex-direction:column;gap:3px;}
.m002-panel-hints{display:flex;flex-direction:column;gap:2px;font-family:'Share Tech Mono',monospace;font-size:9px;color:#5a5f6e;letter-spacing:1.4px;padding-top:6px;border-top:1px solid #1a1a22;}
.m002-prefs-btn{flex:0 0 auto;display:flex;align-items:center;gap:8px;background:transparent;border:1px solid transparent;color:#7a7f8e;padding:6px 10px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;margin-top:auto;}
.m002-prefs-btn:hover{border-color:#1a1a22;color:#e8e8ee;}
.m002-prefs-glyph{font-size:14px;line-height:1;}
.m002-prefs-row{display:flex;align-items:flex-start;gap:10px;justify-content:space-between;padding:8px 10px;background:#06060a;border:1px solid #1a1a22;}
.m002-prefs-row > span{display:flex;flex-direction:column;gap:2px;}
.m002-prefs-label{font-family:'Share Tech Mono',monospace;font-size:11px;color:#e8e8ee;letter-spacing:1.4px;}
.m002-prefs-sublabel{font-family:'Rajdhani',sans-serif;font-size:11px;color:#7a7f8e;}
.m002-prefs-row input[type="checkbox"]{flex:0 0 auto;width:16px;height:16px;accent-color:#ff003c;cursor:pointer;}
.m002-insp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;min-height:240px;text-align:center;color:#5a5f6e;}
.m002-insp-empty-title{font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:2px;color:#7a7f8e;margin-bottom:14px;}
.m002-insp-empty-hints{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:4px;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.4px;}
.m002-cheat{display:flex;flex-direction:column;gap:14px;padding:2px 0 6px;}
.m002-cheat-hint{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.4px;color:#5a5f6e;text-align:center;padding:6px 0 4px;border-bottom:1px dashed #1a1a22;}
.m002-cheat-group{display:flex;flex-direction:column;gap:4px;}
.m002-cheat-title{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:2px;color:#7a7f8e;margin-bottom:2px;}
.m002-cheat-row{display:flex;align-items:center;gap:8px;padding:2px 0;}
.m002-cheat-keys{display:flex;align-items:center;gap:3px;flex-shrink:0;min-width:96px;}
.m002-cheat-plus{font-family:'Share Tech Mono',monospace;font-size:9px;color:#3a3f4e;}
.m002-kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1px;color:#cfd2d8;background:#0d0d12;border:1px solid #2a2f3a;border-bottom-color:#1a1d24;border-right-color:#1a1d24;border-radius:2px;box-shadow:0 1px 0 #050507,inset 0 1px 0 rgba(255,255,255,0.04);}
.m002-cheat-label{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.2px;color:#8a8f9e;}
.m002-rightpanel .m002-insp-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #1a1a22;padding-bottom:8px;}
.m002-host *{box-sizing:border-box}
.m002-host [hidden]{display:none!important;}
.m002-tint{position:absolute;inset:0;background:radial-gradient(ellipse at center,transparent 50%,rgba(255,0,60,0.04) 100%);pointer-events:none;}

.m002-board{position:absolute;inset:0;}
.m002-svg{width:100%;height:100%;display:block;}
/* Hide the OS cursor everywhere inside the module — the N.IVEN custom
   cursor (corner brackets + dot) carries the affordance on its own and
   the OS grab/move/crosshair glyphs clash with the sci-fi style. */
.m002-host,.m002-host *{cursor:none !important;}

.m002-grid-bg,.m002-grid-bg2{pointer-events:all;}

/* Snap-to-grid preview during free-move drag — dashed outline at the cell
   the element would land on if dropped now. Sits in m002-overlay (above
   devices) so it overlaps the element being dragged and stays visible
   even when the snap target is right under the cursor. */
.m002-snap-preview{opacity:.85;}

.m002-device{cursor:move;filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-device:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-device.m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-device.m002-lifted{filter:drop-shadow(0 0 10px var(--accent)) drop-shadow(0 0 28px var(--accent)) drop-shadow(0 14px 26px rgba(0,0,0,.7)) drop-shadow(0 4px 6px rgba(0,0,0,.5));}
.m002-dev-bg{fill:#0a0a10;stroke:var(--accent);stroke-width:1.2;}
.m002-device.m002-selected .m002-dev-bg{stroke-width:2;}
.m002-device.m002-link-pending .m002-dev-bg{stroke-dasharray:4 3;}
.m002-rope{pointer-events:none;}
.m002-rope .m002-rope-line{filter:drop-shadow(0 0 3px currentColor);}
.m002-rope .m002-rope-tip{filter:drop-shadow(0 0 4px currentColor) drop-shadow(0 0 10px currentColor);}
.m002-device.m002-rope-target .m002-dev-bg{stroke-width:2.4;stroke-dasharray:none;filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-host.m002-roping .m002-svg{cursor:crosshair;}
.m002-host.m002-roping .m002-device{cursor:crosshair;}
.m002-autolink{pointer-events:none;}
.m002-autolink .m002-autolink-stub{filter:drop-shadow(0 0 3px currentColor);transition:opacity 60ms ease-out;}
.m002-autolink .m002-autolink-stub-from{stroke:currentColor;color:var(--accent);}
.m002-autolink .m002-autolink-stub-to{stroke:currentColor;color:var(--accent);}
.m002-autolink .m002-autolink-tip{filter:drop-shadow(0 0 3px currentColor) drop-shadow(0 0 7px currentColor);}
.m002-autolink .m002-autolink-full{filter:drop-shadow(0 0 3px currentColor) drop-shadow(0 0 9px currentColor);}
.m002-device.m002-autolink-target .m002-dev-bg{stroke-width:2;stroke-dasharray:none;filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 12px var(--accent));}
.m002-dev-type{font-size:9px;letter-spacing:1.6px;font-family:'Share Tech Mono',monospace;fill:var(--accent);opacity:.85;}
.m002-dev-name{font-size:14px;font-weight:600;fill:#f5f3ff;letter-spacing:.5px;}
.m002-dev-ip{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#7a7f8e;}
.m002-dev-notes{font-size:10px;font-family:'Share Tech Mono',monospace;fill:#7a7f8e;font-style:italic;}
.m002-device-ref .m002-dev-bg{stroke-dasharray:6 3;}
.m002-device-ref.m002-device-coupled .m002-dev-bg{stroke-dasharray:none;stroke-width:1.6;filter:drop-shadow(0 0 3px rgba(192,132,252,.55)) drop-shadow(0 0 9px rgba(192,132,252,.3));}
.m002-dev-ref-target{font-size:10px;font-family:'Share Tech Mono',monospace;fill:var(--accent);letter-spacing:.6px;}
.m002-dev-ref-hint{font-size:8px;font-family:'Share Tech Mono',monospace;fill:#7a7f8e;letter-spacing:1.4px;opacity:.7;}
.m002-ref-modes{display:flex;gap:6px;}
.m002-ref-mode{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid #1a1a22;padding:5px 8px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.4px;color:#9aa0a8;cursor:pointer;background:transparent;}
.m002-ref-mode:hover{border-color:#c084fc;color:#e8e8ee;}
.m002-ref-mode.active{border-color:#c084fc;background:rgba(192,132,252,0.08);color:#c084fc;}
.m002-ref-mode input{accent-color:#c084fc;}
.m002-couple-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid rgba(192,132,252,.45);background:rgba(192,132,252,.06);}
.m002-couple-line{display:flex;gap:8px;align-items:center;font-family:'Share Tech Mono',monospace;font-size:12px;color:#e8e8ee;letter-spacing:.6px;}
.m002-couple-arrow{color:#c084fc;font-size:14px;}
.m002-couple-zone{font-family:'Share Tech Mono',monospace;font-size:10px;color:#c084fc;letter-spacing:1.2px;text-transform:uppercase;}
.m002-field-static{padding:6px 8px;border:1px dashed #1f1f28;background:#0a0a10;font-family:'Share Tech Mono',monospace;font-size:11px;color:#9aa0a8;letter-spacing:.6px;}
.m002-anchor-row{display:flex;gap:6px;align-items:stretch;}
.m002-anchor-row .m002-field-static{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-anchor-row .m002-action{flex:0 0 auto;}
.m002-ref-fallback{margin:4px 0 8px;font-family:'Share Tech Mono',monospace;font-size:10px;color:#9aa0a8;letter-spacing:1px;}
.m002-ref-fallback summary{cursor:pointer;padding:4px 0;color:#7a7f8e;text-transform:uppercase;}
.m002-ref-fallback[open] summary{color:#c084fc;}
.m002-vlan-readonly{display:flex;flex-wrap:wrap;gap:4px;}
.m002-vlan-readonly .m002-vlan-chip-btn{cursor:default;pointer-events:none;}
.m002-vlan-readonly .m002-vlan-chip-btn.dim{opacity:.45;}

.m002-stack-collapsed{cursor:move;filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-stack-collapsed:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-stack-collapsed.m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-stack-collapsed.m002-lifted{filter:drop-shadow(0 0 10px var(--accent)) drop-shadow(0 0 28px var(--accent)) drop-shadow(0 14px 26px rgba(0,0,0,.7)) drop-shadow(0 4px 6px rgba(0,0,0,.5));}
.m002-stack-collapsed.m002-stack-pending .m002-dev-bg{stroke-dasharray:4 3;}
.m002-stack-ghost{fill:#0a0a10;stroke:var(--accent);stroke-width:1;opacity:.55;}
.m002-stack-collapsed .m002-dev-bg{fill:#0a0a10;stroke:var(--accent);stroke-width:1.4;}
.m002-stack-collapsed.m002-selected .m002-dev-bg{stroke-width:2;}
.m002-stack-badge{font-size:11px;font-family:'Share Tech Mono',monospace;font-weight:600;fill:var(--accent);letter-spacing:1px;}

.m002-stack-envelope{filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-stack-envelope:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-stack-envelope.m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-stack-env-bg{fill:#0a0a10;stroke:var(--accent);stroke-width:1.4;stroke-dasharray:10 4;opacity:1;}
.m002-stack-envelope.m002-selected .m002-stack-env-bg{stroke-width:2;}
.m002-stack-envelope.m002-selected .m002-stack-env-label{fill:var(--accent);}
.m002-stack-env-label{font-size:10px;font-family:'Share Tech Mono',monospace;fill:var(--accent);letter-spacing:1.5px;opacity:.8;}
/* Routing layer: a stack's envelope only glows when the stack itself is an
   L3 entity (data-l3="true" iff stackHasVip). Non-VIP envelopes recede so
   the eye lands on the actual IP-bearing members instead. */
.m002-host[data-active-layer="routing"] .m002-stack-envelope[data-l3="false"]{filter:none;opacity:.45;}
.m002-host[data-active-layer="routing"] .m002-stack-envelope[data-l3="false"] .m002-stack-env-bg{stroke:#3a3a44;fill:transparent;}
.m002-host[data-active-layer="routing"] .m002-stack-envelope[data-l3="false"] .m002-stack-env-label{fill:#5a5f6e;}
.m002-host[data-active-layer="routing"] .m002-stack-envelope[data-l3="false"]:hover{opacity:.7;}
/* Stack-member devices: dimmed white in physical/vlan, but in routing the
   IP-bearing members glow in their own accent (override below). */
.m002-device.m002-stack-member{filter:none;}
.m002-device.m002-stack-member:hover{filter:drop-shadow(0 0 2px rgba(245,243,255,.45)) drop-shadow(0 0 7px rgba(245,243,255,.25));}
.m002-device.m002-stack-member.m002-selected{filter:drop-shadow(0 0 3px rgba(245,243,255,.6)) drop-shadow(0 0 10px rgba(245,243,255,.35));}
.m002-device.m002-stack-member .m002-dev-bg{stroke:rgba(245,243,255,.45);}
.m002-device.m002-stack-member .m002-dev-type{fill:rgba(245,243,255,.65);}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member[data-l3="true"]{filter:drop-shadow(0 0 3px var(--accent)) drop-shadow(0 0 9px var(--accent));}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member[data-l3="true"]:hover{filter:drop-shadow(0 0 5px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member[data-l3="true"].m002-selected{filter:drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 18px var(--accent));}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member[data-l3="true"] .m002-dev-bg{stroke:var(--accent);}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member[data-l3="true"] .m002-dev-type{fill:var(--accent);opacity:.85;}
/* Members of a VIP'd stack: the stack speaks for them in routing — keep them
   muted so the envelope is the visual L3 entity, not the individual nodes. */
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip,
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip[data-l3="true"]{filter:none;}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip:hover,
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip[data-l3="true"]:hover{filter:drop-shadow(0 0 2px rgba(245,243,255,.45)) drop-shadow(0 0 7px rgba(245,243,255,.25));}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip .m002-dev-bg,
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip[data-l3="true"] .m002-dev-bg{stroke:rgba(245,243,255,.45);}
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip .m002-dev-type,
.m002-host[data-active-layer="routing"] .m002-device.m002-stack-member-vip[data-l3="true"] .m002-dev-type{fill:rgba(245,243,255,.65);opacity:1;}
.m002-stack-cable{stroke:#5a5f6e;stroke-width:1.2;stroke-dasharray:5 4;fill:none;opacity:.75;}
.m002-stacklink:hover .m002-stack-cable{stroke:#9aa0a8;opacity:1;}
.m002-stack-cable-label{font-size:9px;font-family:'Share Tech Mono',monospace;fill:#9aa0a8;letter-spacing:1px;pointer-events:none;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3px;stroke-linejoin:round;stroke-linecap:round;}
.m002-stacklink:hover .m002-stack-cable-label{fill:#9aa0a8;}

.m002-link-line{stroke-width:1.4;fill:none;}
.m002-link-hit{stroke:transparent;stroke-width:10;fill:none;cursor:pointer;}
/* Traffic-pulse on links incident to the current selection. The <path> is
   injected on-demand by applyIncidentFlow() — idle links never carry one.
   stroke-dashoffset is driven by startFlowTicker() (rAF) so the pulse runs
   even when the OS forces prefers-reduced-motion. */
.m002-link-flow{fill:none;stroke:#ffffff;stroke-width:2.4;stroke-dasharray:6 92;stroke-linecap:round;pointer-events:none;opacity:.95;filter:drop-shadow(0 0 3px #fff) drop-shadow(0 0 7px rgba(255,255,255,.55));}
.m002-link:hover .m002-link-line{stroke-width:1.8;filter:drop-shadow(0 0 2px rgba(255,255,255,0.55)) drop-shadow(0 0 6px rgba(255,255,255,0.25));}
.m002-link:hover .m002-link-label{filter:drop-shadow(0 0 2px rgba(255,255,255,0.4));}
.m002-link.m002-selected .m002-link-line{stroke:#ffffff;stroke-width:2.4;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 10px rgba(255,255,255,0.65));}
.m002-link.m002-selected .m002-link-line.m002-link-stripe{filter:drop-shadow(0 0 4px currentColor) drop-shadow(0 0 10px currentColor);}
.m002-link.m002-selected .m002-link-label{fill:#ffffff;}
.m002-link.m002-selected .m002-link-label.m002-link-stripe-label{filter:drop-shadow(0 0 3px currentColor);}
.m002-link.m002-link-faded{opacity:.25;}
.m002-link-vlan-count{font-size:9px;font-family:'Share Tech Mono',monospace;letter-spacing:1px;fill:#9aa0a8;opacity:.85;pointer-events:none;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3px;stroke-linejoin:round;stroke-linecap:round;}
.m002-link:hover .m002-link-vlan-count{opacity:1;fill:#e8e8ee;}
.m002-link-label{font-size:9px;font-family:'Share Tech Mono',monospace;text-anchor:middle;letter-spacing:1px;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3px;stroke-linejoin:round;stroke-linecap:round;}

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
/* Port-count row: label + count + 24/48/-/+ buttons inline. The count uses
   the heading font so it reads as a value, not a control. Buttons hug the
   right edge via margin-left:auto on the group. */
.m002-field-ports{flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap;}
.m002-field-ports>span:first-child{flex:0 0 auto;}
.m002-field-ports .m002-port-count{font-family:'Rajdhani',sans-serif;font-size:18px;font-weight:600;color:#e8e8ee;letter-spacing:.5px;min-width:24px;text-align:left;line-height:1;}
.m002-port-btns{display:flex;gap:6px;margin-left:auto;}
.m002-pcount-btn{background:transparent;border:1px solid;padding:4px 10px;font-family:'Share Tech Mono',monospace;font-size:11px;font-weight:600;letter-spacing:1.4px;cursor:pointer;transition:.15s;min-width:32px;line-height:1;}
.m002-pcount-btn.preset{border-color:#00d4ff;color:#00d4ff;}
.m002-pcount-btn.preset:hover{background:rgba(0,212,255,0.12);}
.m002-pcount-btn.step.plus{border-color:#35ff7a;color:#35ff7a;}
.m002-pcount-btn.step.plus:hover{background:rgba(53,255,122,0.12);}
.m002-pcount-btn.step.minus{border-color:#ff003c;color:#ff003c;}
.m002-pcount-btn.step.minus:hover{background:rgba(255,0,60,0.12);}
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
.m002-lag-sides{display:flex;flex-direction:column;gap:10px;margin-top:4px;}
.m002-lag-side{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:1px dashed #1a1a22;}
.m002-lag-side-head{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:2px;color:#ff003c;}
.m002-port-lagtag{margin-left:6px;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1px;color:#ff003c;border:1px solid #ff003c;padding:1px 4px;border-radius:2px;background:rgba(255,0,60,0.08);}

.m002-stack-members{display:flex;flex-direction:column;gap:4px;}
.m002-stack-member{display:grid;grid-template-columns:14px 1fr auto 22px;gap:6px;align-items:center;background:#06060a;border:1px solid #1a1a22;padding:4px 8px;}
.m002-stack-member-dot{width:8px;height:8px;background:var(--accent);box-shadow:0 0 4px var(--accent);}
.m002-stack-member-name{font-size:12px;color:#e8e8ee;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.m002-stack-member-type{font-size:9px;font-family:'Share Tech Mono',monospace;color:var(--accent);letter-spacing:1px;}
.m002-stack-member button{background:transparent;border:none;color:#9aa0a8;cursor:pointer;font-size:14px;line-height:1;padding:0;}
.m002-stack-member button:hover{color:#ff003c;}

/* The LAG modal still uses .m002-port-panel + .m002-port-modal-head/-id
   for its floating card. The PORT detail moved into the inspector panel, so
   no backdrop / floating panel rules remain for it. */
.m002-port-panel{background:#0a0a10;border:1px solid #ff003c;width:340px;max-width:calc(100% - 32px);padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 0 20px rgba(255,0,60,0.25);}
.m002-port-modal-head{display:flex;justify-content:space-between;align-items:center;}
.m002-port-modal-id{font-family:'Share Tech Mono',monospace;font-size:11px;color:#ff003c;letter-spacing:2px;}
.m002-port-back{display:inline-flex;align-items:center;justify-content:flex-start;background:transparent;border:1px solid #1a1a22;color:#9aa0a8;padding:6px 10px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.4px;cursor:pointer;text-align:left;text-transform:uppercase;transition:.15s;}
.m002-port-back:hover{border-color:#ff003c;color:#ff003c;background:rgba(255,0,60,0.06);}
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
.m002-pmodal-cp option.is-occupied{color:#5a5f6e;}
/* Collapsible details block in the device inspector — wraps HOSTNAME, IP and
   NOTES so the inspector stays tidy by default but the metadata is one click
   away. Mirrors the .m002-ref-fallback summary treatment. */
.m002-insp-details{margin:2px 0 6px;border:1px solid #1a1a22;background:rgba(10,10,16,0.6);}
.m002-insp-details>summary{cursor:pointer;padding:6px 10px;font-family:'Share Tech Mono',monospace;font-size:10px;color:#7a7f8e;letter-spacing:1.6px;list-style:none;user-select:none;transition:.15s;}
.m002-insp-details>summary::-webkit-details-marker{display:none;}
.m002-insp-details>summary::before{content:'▸ ';color:#5a5f6e;}
.m002-insp-details[open]>summary{color:#ff003c;border-bottom:1px solid #1a1a22;}
.m002-insp-details[open]>summary::before{content:'▾ ';color:#ff003c;}
.m002-insp-details>summary:hover{color:#ff003c;}
.m002-insp-details>.m002-field{padding:0 10px;}
.m002-insp-details>.m002-field:first-of-type{padding-top:8px;}
.m002-insp-details>.m002-field:last-of-type{padding-bottom:10px;}
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

/* Drag-to-stack: pulse the merge target while a device hovers over it.
   Green = same device type (valid stack), red = mismatched type (invalid). */
.m002-drag-stack-target.m002-merge-ok{animation:m002-merge-pulse-ok .5s ease-in-out infinite alternate!important;}
.m002-drag-stack-target.m002-merge-bad{animation:m002-merge-pulse-bad .5s ease-in-out infinite alternate!important;}
@keyframes m002-merge-pulse-ok{
  from{filter:drop-shadow(0 0 5px #35ff7a) drop-shadow(0 0 14px #35ff7a);}
  to  {filter:drop-shadow(0 0 12px #35ff7a) drop-shadow(0 0 30px #35ff7a);}
}
@keyframes m002-merge-pulse-bad{
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

.m002-stacklinks-grid{display:flex;flex-direction:column;gap:4px;}
.m002-stacklink-row{display:grid;grid-template-columns:1fr 56px 14px 1fr 56px 22px;gap:4px;align-items:center;padding:3px 0;}
.m002-stacklink-row select{background:#0a0a10;border:1px solid #1a1a22;color:#e8e8ee;padding:3px 4px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:.5px;outline:none;min-width:0;}
.m002-stacklink-row select:focus{border-color:#ff003c;}
.m002-stacklink-arrow{font-family:'Share Tech Mono',monospace;font-size:11px;color:#5a5f6e;text-align:center;}
.m002-stacklink-row button[data-sl-rm]{background:transparent;border:1px solid transparent;color:#5a5f6e;font-size:14px;cursor:pointer;line-height:1;padding:2px 4px;}
.m002-stacklink-row button[data-sl-rm]:hover{color:#ff003c;border-color:#ff003c;}

.m002-lag-line{stroke-linecap:square;}
.m002-link.m002-link-bundle:hover .m002-lag-line{stroke:#e8e8ee;}
.m002-link.m002-selected .m002-lag-line{stroke:#ffffff;stroke-width:2.4;filter:drop-shadow(0 0 4px #fff) drop-shadow(0 0 10px rgba(255,255,255,0.65));}
.m002-link.m002-selected .m002-link-bundle-label{fill:#ffffff!important;}
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
.m002-link-bundle-label{font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:1.5px;font-weight:600;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3.5px;stroke-linejoin:round;stroke-linecap:round;}
/* Stack-pair aggregate summary — replaces N parallel non-paired stubs
   between two collapsed stacks (or stack + device). A single faint dashed
   line; hover lifts it so it's clearly actionable. Click opens the LAG
   configurator. */
.m002-link-agg .m002-link-hit{stroke-width:14;cursor:pointer;}
.m002-link-agg-line{transition:stroke .15s,opacity .15s;}
.m002-link-agg:hover .m002-link-agg-line{stroke:#9aa0a8;}
.m002-link-agg-label{font-size:9px;font-family:'Share Tech Mono',monospace;letter-spacing:1.5px;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3.5px;stroke-linejoin:round;}
/* Aggregate inspector — LAG-pair configurator that opens when the user
   clicks the dim summary line between two collapsed stacks. */
.m002-agg-side{display:flex;gap:6px;align-items:center;}
.m002-agg-lagpick,.m002-agg-lagname{flex:1 1 0;min-width:0;background:#06060a;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;}
.m002-agg-lagpick:focus,.m002-agg-lagname:focus{border-color:#35ff7a;}
.m002-agg-links{display:flex;flex-direction:column;gap:3px;}
.m002-agg-link-row{display:grid;grid-template-columns:1fr 18px 1fr;gap:6px;align-items:center;padding:3px 6px;background:#06060a;border:1px solid #1a1a22;font-family:'Share Tech Mono',monospace;font-size:10px;color:#9aa0a8;}
.m002-agg-port{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.m002-agg-arrow{text-align:center;color:#5a5f6e;}
.m002-link-bundle .m002-link-hit{stroke-width:18;}

.m002-vlan-chip-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;background:transparent;border:1px solid #2a2a36;color:#7a7f8e;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;cursor:pointer;transition:.15s;}
.m002-vlan-chip-btn:hover{border-color:var(--vc);color:var(--vc);}
.m002-vlan-chip-btn.on{background:rgba(0,0,0,0.3);border-color:var(--vc);color:var(--vc);box-shadow:0 0 6px var(--vc);}
.m002-vlan-picker{display:flex;flex-wrap:wrap;gap:4px;}
.m002-vlan-legend-rm{background:transparent;border:none;color:var(--vc);cursor:pointer;font-size:13px;line-height:1;padding:0 2px;opacity:.5;}
.m002-vlan-legend-rm:hover{opacity:1;}
.m002-vlan-legend-add{display:flex;gap:4px;margin-top:6px;flex:0 0 auto;align-items:stretch;}
.m002-vlan-legend-input{flex:1 1 0;min-width:0;background:#06060a;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;}
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
.m002-vlan-row{display:grid;grid-template-columns:8px 28px 1fr 18px;gap:6px;align-items:center;padding:4px 6px;background:#06060a;border:1px solid #1a1a22;cursor:pointer;transition:.12s;}
.m002-vlan-row:hover{border-color:var(--vc);}
.m002-vlan-row.is-solo{background:rgba(255,255,255,0.04);border-color:var(--vc);box-shadow:0 0 6px rgba(255,255,255,0.06),inset 0 0 6px var(--vc);}
.m002-vlan-row.is-solo .m002-vlan-row-dot{box-shadow:0 0 6px var(--vc),0 0 14px var(--vc);}
.m002-vlan-row.is-dimmed{opacity:.4;}
.m002-vlan-row.is-dimmed:hover{opacity:.85;}
.m002-vlan-row-dot{width:8px;height:8px;background:var(--vc);box-shadow:0 0 4px var(--vc),0 0 8px var(--vc);}
.m002-vlan-legend-filter{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 6px;background:rgba(255,0,60,0.06);border:1px solid rgba(255,0,60,0.4);flex:0 0 auto;}
.m002-vlan-legend-filter-label{font-family:'Share Tech Mono',monospace;font-size:10px;color:#ff5c7a;letter-spacing:1.5px;}
.m002-vlan-legend-clear{background:transparent;border:1px solid #ff003c;color:#ff003c;padding:2px 8px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;}
.m002-vlan-legend-clear:hover{background:rgba(255,0,60,0.15);}
.m002-vlan-row-id{font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--vc);letter-spacing:1px;}
.m002-vlan-row-name{background:transparent;border:none;color:#e8e8ee;padding:1px 4px;font-family:'Rajdhani',sans-serif;font-size:12px;outline:none;min-width:0;}
.m002-vlan-row-name:focus{background:rgba(255,255,255,0.04);}
.m002-vlan-row-rm{background:transparent;border:none;color:#5a5f6e;cursor:pointer;font-size:13px;line-height:1;padding:0;}
.m002-vlan-row-rm:hover{color:#ff003c;}
.m002-vlan-legend-list::-webkit-scrollbar{width:6px;}

/* L3 / Routing — subnet legend, link styles, dim, gateway badge */
.m002-subnet-legend-body{display:flex;flex-direction:column;gap:6px;}
.m002-subnet-legend-list{display:flex;flex-direction:column;gap:3px;flex:1 1 auto;min-height:0;overflow-y:auto;padding-right:4px;}
.m002-subnet-legend-list::-webkit-scrollbar{width:6px;}
.m002-subnet-legend-empty{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:1px;font-style:italic;}
.m002-subnet-row{display:grid;grid-template-columns:8px auto 1fr 18px;gap:6px;align-items:center;padding:4px 6px;background:#06060a;border:1px solid #1a1a22;cursor:pointer;transition:.12s;}
.m002-subnet-row:hover{border-color:var(--sc);}
.m002-subnet-row.is-solo{background:rgba(255,255,255,0.04);border-color:var(--sc);box-shadow:0 0 6px rgba(255,255,255,0.06),inset 0 0 6px var(--sc);}
.m002-subnet-row.is-solo .m002-subnet-row-dot{box-shadow:0 0 6px var(--sc),0 0 14px var(--sc);}
.m002-subnet-row.is-dimmed{opacity:.4;}
.m002-subnet-row.is-dimmed:hover{opacity:.85;}
.m002-subnet-row-dot{width:8px;height:8px;background:var(--sc);box-shadow:0 0 4px var(--sc),0 0 8px var(--sc);}
.m002-subnet-row-cidr{font-family:'Share Tech Mono',monospace;font-size:11px;color:var(--sc);letter-spacing:1px;white-space:nowrap;}
.m002-subnet-row-name{background:transparent;border:none;color:#e8e8ee;padding:1px 4px;font-family:'Rajdhani',sans-serif;font-size:12px;outline:none;min-width:0;}
.m002-subnet-row-name:focus{background:rgba(255,255,255,0.04);}
.m002-subnet-row-rm{background:transparent;border:none;color:#5a5f6e;cursor:pointer;font-size:13px;line-height:1;padding:0;}
.m002-subnet-row-rm:hover{color:#ff003c;}
.m002-subnet-legend-add{display:flex;gap:4px;flex:0 0 auto;align-items:stretch;}
.m002-subnet-legend-input{flex:1 1 0;min-width:0;background:#06060a;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;}
.m002-subnet-legend-input:focus{border-color:#35ff7a;}
.m002-subnet-legend-add-btn{background:transparent;border:1px solid #35ff7a;color:#35ff7a;padding:4px 10px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;cursor:pointer;white-space:nowrap;flex:0 0 auto;align-self:stretch;}
.m002-subnet-legend-add-btn:hover{background:rgba(53,255,122,0.1);}
.m002-subnet-legend-auto{background:transparent;border:1px dashed #2a2a36;color:#7a7f8e;padding:3px 8px;font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1.5px;cursor:pointer;align-self:flex-start;}
.m002-subnet-legend-auto:hover{border-color:#35ff7a;color:#35ff7a;}

/* L3 inspector — interfaces + routes table */
.m002-insp-l3{margin-top:4px;border-top:1px solid #1a1a22;padding-top:8px;}
.m002-insp-l3 > summary{font-family:'Share Tech Mono',monospace;font-size:10px;color:#7a7f8e;letter-spacing:2px;cursor:pointer;padding:4px 0;list-style:none;}
.m002-insp-l3 > summary::-webkit-details-marker{display:none;}
.m002-insp-l3 > summary::before{content:'▸ ';color:#5a5f6e;}
.m002-insp-l3[open] > summary::before{content:'▾ ';color:#35ff7a;}
.m002-l3-block{margin-top:8px;}
.m002-l3-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;font-family:'Share Tech Mono',monospace;font-size:10px;color:#7a7f8e;letter-spacing:1.5px;}
.m002-l3-head-actions{display:flex;gap:4px;}
.m002-iface-list,.m002-route-list{display:flex;flex-direction:column;gap:3px;}
.m002-iface-head{display:grid;grid-template-columns:8px 0.7fr 1.2fr 0.5fr 1.2fr 18px;gap:4px;align-items:center;padding:0 6px 2px 6px;font-family:'Share Tech Mono',monospace;font-size:8px;color:#5a5f6e;letter-spacing:1.5px;text-transform:uppercase;}
/* Endpoint / cloud / switch single-row L3 — IP + PREFIX, no NAME / GATEWAY */
.m002-iface-row--non-l3{grid-template-columns:8px 1.4fr 0.6fr 18px !important;}
.m002-iface-head--non-l3{grid-template-columns:8px 1.4fr 0.6fr 18px !important;}
.m002-route-head{display:grid;grid-template-columns:1.2fr 1.2fr 1fr 0.6fr 18px;gap:4px;align-items:center;padding:0 6px 2px 6px;font-family:'Share Tech Mono',monospace;font-size:8px;color:#5a5f6e;letter-spacing:1.5px;text-transform:uppercase;}
.m002-iface-row{display:grid;grid-template-columns:8px 0.7fr 1.2fr 0.5fr 1.2fr 18px;gap:4px;align-items:center;padding:3px 6px;background:#06060a;border:1px solid #1a1a22;transition:.12s;}
.m002-iface-row:hover{border-color:var(--sc);}
.m002-iface-dot{width:8px;height:8px;background:var(--sc);box-shadow:0 0 3px var(--sc);}
.m002-iface-row input,.m002-iface-row select,.m002-route-row input,.m002-route-row select{background:transparent;border:1px solid #1a1a22;color:#e8e8ee;padding:2px 4px;font-family:'Share Tech Mono',monospace;font-size:10px;outline:none;min-width:0;}
.m002-iface-row input:focus,.m002-iface-row select:focus,.m002-route-row input:focus,.m002-route-row select:focus{border-color:#35ff7a;}
.m002-iface-rm,.m002-route-rm{background:transparent;border:none;color:#5a5f6e;cursor:pointer;font-size:13px;line-height:1;padding:0;}
.m002-iface-rm:hover,.m002-route-rm:hover{color:#ff003c;}
.m002-route-row{display:grid;grid-template-columns:1.2fr 1.2fr 1fr 0.6fr 18px;gap:4px;align-items:center;padding:3px 6px;background:#06060a;border:1px solid #1a1a22;}
.m002-route-row.is-default{border-color:#ffae00;}
.m002-route-row.is-default .m002-route-dst{color:#ffae00;}

/* Routing-layer canvas dimming + link styles. Collapsed stacks get the
   same fade rule as plain devices so a switch-only stack doesn't suddenly
   look L3-active just because it's collapsed. */
.m002-host[data-active-layer="routing"] .m002-device[data-l3="false"],
.m002-host[data-active-layer="routing"] .m002-stack-collapsed[data-l3="false"]{opacity:.32;filter:saturate(.4);}
.m002-host[data-active-layer="routing"] .m002-device[data-l3="false"]:hover,
.m002-host[data-active-layer="routing"] .m002-stack-collapsed[data-l3="false"]:hover{opacity:.6;}
/* VLAN solo dim — three diagnostic tiers:
   - isolated unmatched: no VLAN here, no neighbor with it → fade to grey
   - adjacent unmatched: no VLAN here, but linked neighbor has it → yellow
     ("you probably want to extend the VLAN to this device")
   - configured-only: VLAN at device level but no port carries it → orange
     ("declared but not wired") */
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="unmatched-isolated"],
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="unmatched-isolated"]{opacity:.18 !important;filter:saturate(0) brightness(.55) !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="unmatched-isolated"]:hover,
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="unmatched-isolated"]:hover{opacity:.45 !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="unmatched-adjacent"],
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="unmatched-adjacent"]{filter:drop-shadow(0 0 4px #f5d65a) drop-shadow(0 0 12px #f5d65a) !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="unmatched-adjacent"]:hover,
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="unmatched-adjacent"]:hover{filter:drop-shadow(0 0 6px #f5d65a) drop-shadow(0 0 18px #f5d65a) !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="unmatched-adjacent"] .m002-dev-bg,
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="unmatched-adjacent"] .m002-dev-bg{stroke:#f5d65a;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="configured-only"],
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="configured-only"]{filter:drop-shadow(0 0 4px #ff9b3c) drop-shadow(0 0 12px #ff9b3c) !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="configured-only"]:hover,
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="configured-only"]:hover{filter:drop-shadow(0 0 6px #ff9b3c) drop-shadow(0 0 18px #ff9b3c) !important;}
.m002-host[data-active-layer="vlan"] .m002-device[data-vlan-solo="configured-only"] .m002-dev-bg,
.m002-host[data-active-layer="vlan"] .m002-stack-collapsed[data-vlan-solo="configured-only"] .m002-dev-bg{stroke:#ff9b3c;}
.m002-link-l3{transition:stroke-width .15s;}
.m002-link-l3-glow{opacity:.22;filter:blur(2px);pointer-events:none;}
/* Detached L3 ribbons — smooth Catmull-Rom curves through L3 endpoints.
   They live in their own SVG group above the link layer so they read as a
   logical overlay rather than a re-skinned wire. fill:none keeps the curve
   transparent inside concave bends; pointer-events:none stops them from
   eating clicks meant for devices. */
/* Routing layer: kill the L2 link-flow pulse so the only animated stream is
   the L3 ribbon aimed at the gateway. Selection still highlights, but the
   pulse on the underlying L2 wire would compete visually. */
.m002-host[data-active-layer="routing"] .m002-link-flow{display:none;}
.m002-l3-paths path{fill:none;pointer-events:none;}
.m002-l3-path{stroke-width:2.5;opacity:.95;stroke-linecap:round;stroke-linejoin:round;}
.m002-l3-path-glow{stroke-width:8;opacity:.22;filter:blur(2.5px);}
/* Flow pulse — short bright dash riding along the ribbon. Direction is
   driven from JS via data-flow-dir + the rAF ticker (CSS keyframes are
   silenced under prefers-reduced-motion on corporate Windows profiles). */
.m002-l3-path-flow{stroke-width:3.2;stroke-dasharray:6 92;opacity:.95;stroke-linecap:round;filter:drop-shadow(0 0 4px currentColor);}
.m002-link-l3-label{font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:1px;font-weight:500;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3.5px;stroke-linejoin:round;stroke-linecap:round;}
.m002-link-transit-label{font-size:10px;font-family:'Share Tech Mono',monospace;letter-spacing:2px;font-weight:600;paint-order:stroke fill;stroke:#0a0a10;stroke-width:3.5px;stroke-linejoin:round;stroke-linecap:round;}
.m002-dev-l3{font-family:'Share Tech Mono',monospace;font-size:9px;letter-spacing:1px;fill:#35ff7a;display:none;}
.m002-host[data-active-layer="routing"] .m002-dev-l3{display:block;}
.m002-host[data-active-layer="routing"] .m002-dev-ip{display:none;}
.m002-dev-gw-badge{display:none;}
.m002-dev-gw-badge rect{fill:rgba(255,174,0,0.12);stroke:#ffae00;stroke-width:1;}
.m002-dev-gw-badge text{font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:1px;font-weight:700;fill:#ffae00;}
.m002-host[data-active-layer="routing"] .m002-dev-gw-badge{display:block;}
.m002-action.small{padding:2px 8px;font-size:9px;}

/* L3 trio for non-L3 device inspector (endpoint/cloud/switch) */
.m002-field-l3-trio{display:flex;flex-direction:column;gap:4px;}
.m002-l3-trio{display:grid;grid-template-columns:1.4fr 0.6fr 1.4fr;gap:4px;}
.m002-l3-trio input,.m002-l3-trio select{background:#06060a;border:1px solid #1a1a22;color:#e8e8ee;padding:4px 8px;font-family:'Share Tech Mono',monospace;font-size:11px;outline:none;min-width:0;}
.m002-l3-trio input:focus,.m002-l3-trio select:focus{border-color:#35ff7a;}

.m002-vlan-legend-list::-webkit-scrollbar-thumb{background:#1a1a22;}
.m002-vlan-legend-empty{font-family:'Share Tech Mono',monospace;font-size:10px;color:#5a5f6e;letter-spacing:1px;}
.m002-vlan-legend-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;background:rgba(0,0,0,0.4);border:1px solid var(--vc);color:var(--vc);font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1px;}
.m002-vlan-legend-dot{width:8px;height:8px;background:var(--vc);box-shadow:0 0 4px var(--vc),0 0 8px var(--vc);}

.m002-statusbar{position:absolute;bottom:16px;left:18px;z-index:5;display:flex;align-items:center;gap:8px;background:rgba(8,8,14,0.85);border:1px solid #1a1a22;padding:6px 12px;font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.5px;color:#9aa0a8;}
.m002-stat-tag{color:#ff003c;}
.m002-stat-sep{color:#2a2a36;}
.m002-stat-mode{color:#e8e8ee;}

.m002-toast-stack{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;z-index:1000;}
.m002-toast-item{background:rgba(8,8,14,0.95);border:1px solid #ff003c;padding:8px 16px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.5px;color:#ff003c;opacity:0;transform:translateY(20px);transition:opacity .25s ease,transform .25s ease;white-space:nowrap;box-shadow:0 0 12px rgba(255,0,60,0.25);}
.m002-toast-item.show{opacity:1;transform:translateY(0);}
.m002-toast-item.leave{opacity:0;transform:translateY(-6px);}

.m002-inspector::-webkit-scrollbar,.m002-ports-grid::-webkit-scrollbar{width:6px;}
.m002-inspector::-webkit-scrollbar-thumb,.m002-ports-grid::-webkit-scrollbar-thumb{background:#1a1a22;}

/* Detail-View choreographed entry:
     • backdrop fades in + blur builds up (~520ms)
     • head bar slides down from -12px
     • central element: pinpoint → vertical line → expand horizontally
       (~500ms total, runs over phases inside one keyframe set)
     • ports pop in one-by-one from the centre (delay = base + i*stagger)
     • port stubs fade in last, each one gated by its own port's delay
   Exit reuses the overlay opacity transition only; individual elements
   fade out implicitly with the parent so the exit feels snappier. */
.m002-detail-overlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;background:radial-gradient(ellipse at 50% 0%,rgba(13,13,20,0.96) 0%,rgba(6,6,10,0.985) 70%);opacity:0;transition:opacity ${DETAIL_FADE_OUT_MS}ms cubic-bezier(0.4,0,1,1);pointer-events:auto;backdrop-filter:blur(0px);-webkit-backdrop-filter:blur(0px);}
.m002-detail-overlay.m002-detail-overlay-show{opacity:1;transition:opacity ${DETAIL_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1),backdrop-filter ${DETAIL_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1),-webkit-backdrop-filter ${DETAIL_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}
.m002-detail-head{display:flex;align-items:center;gap:14px;padding:12px 18px;border-bottom:1px solid #1a1a22;background:rgba(8,8,14,0.92);transform:translateY(-12px);opacity:0;transition:transform ${DETAIL_FADE_OUT_MS}ms cubic-bezier(0.4,0,1,1),opacity ${DETAIL_FADE_OUT_MS}ms cubic-bezier(0.4,0,1,1);}
.m002-detail-overlay.m002-detail-overlay-show .m002-detail-head{transform:translateY(0);opacity:1;transition:transform ${DETAIL_ANIM_MS}ms cubic-bezier(0.16,1,0.3,1) 60ms,opacity ${DETAIL_ANIM_MS - 80}ms cubic-bezier(0.16,1,0.3,1) 60ms;}
.m002-detail-back{display:inline-flex;align-items:center;gap:8px;background:transparent;border:1px solid #1a1a22;color:#e8e8ee;padding:6px 12px;font-family:'Share Tech Mono',monospace;font-size:11px;letter-spacing:1.6px;cursor:pointer;transition:.15s;}
.m002-detail-back:hover{border-color:#ff003c;color:#ff003c;background:rgba(255,0,60,0.06);}
.m002-detail-back-glyph{font-size:14px;line-height:1;}
.m002-detail-title{font-family:'Share Tech Mono',monospace;font-size:12px;letter-spacing:2px;color:#9aa0a8;}
.m002-detail-spacer{flex:1;}
.m002-detail-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;cursor:zoom-out;}
.m002-detail-svg{display:block;max-width:100%;max-height:100%;}

/* Initial states for choreographed entry. Without these the elements pop in
   visible at frame 0 before the keyframe animation overrides on .show.
   Note: the *inner* wrappers carry the scale; the outer groups keep their
   SVG translate untouched so the port grid stays in place. */
.m002-detail-device-inner{transform:scale(0.005,0.02);opacity:0;}
.m002-detail-overlay .m002-detail-port-inner{transform:scale(0.6);opacity:0;}
.m002-detail-overlay .m002-detail-stub{opacity:0;}

/* Element entry choreography (1000ms total, 50ms lead-in delay):
     0–333ms   point appears, then vertical line grows to full height
     333–400ms HOLD — same scale, no motion (67ms breath)
     400–1000ms horizontal expansion to full width (600ms)
   Percentages map 33%→333ms, 40%→400ms, 100%→1000ms.
   Initial scale(0.005,0.02): 720×0.005=3.6 wide, 180×0.02=3.6 tall — a
   roughly square point. The fill animation (m002-detail-elem-fill) keeps
   the rect accent-coloured during the point/line phase so it reads as a
   clean blue line, then crossfades to the dark fill during horizontal
   expansion. */
@keyframes m002-detail-elem-emerge{
  0%   {transform:scale(0.005,0.02);opacity:0;}
  5%   {transform:scale(0.005,0.02);opacity:1;}
  33%  {transform:scale(0.005,1);   opacity:1;}
  40%  {transform:scale(0.005,1);   opacity:1;}
  100% {transform:scale(1,1);       opacity:1;}
}
@keyframes m002-detail-elem-fill{
  0%,40%   {fill:var(--accent);}
  60%,100% {fill:#0a0a10;}
}
@keyframes m002-detail-port-pop{
  0%   {transform:scale(0.6); opacity:0;}
  60%  {transform:scale(1.08);opacity:1;}
  100% {transform:scale(1);   opacity:1;}
}
@keyframes m002-detail-stub-fade{
  0%   {opacity:0;}
  100% {opacity:1;}
}

.m002-detail-overlay.m002-detail-overlay-show .m002-detail-device-inner{animation:m002-detail-elem-emerge 1000ms cubic-bezier(0.4,0,0.2,1) 50ms forwards;}
.m002-detail-overlay.m002-detail-overlay-show .m002-detail-dev-bg{animation:m002-detail-elem-fill 1000ms cubic-bezier(0.4,0,0.2,1) 50ms forwards;}
.m002-detail-overlay.m002-detail-overlay-show .m002-detail-port-inner{animation:m002-detail-port-pop 215ms cubic-bezier(0.34,1.4,0.5,1) forwards;animation-delay:var(--enter-delay,1070ms);}
.m002-detail-overlay.m002-detail-overlay-show .m002-detail-stub{animation:m002-detail-stub-fade 255ms ease-out forwards;animation-delay:calc(var(--enter-delay,1070ms) + 175ms);}
/* Settled state — applied ~1100ms after entry. Lets render(s) re-render the
   detail body during edits without re-running the choreographed entry. */
.m002-detail-overlay-settled .m002-detail-device-inner,
.m002-detail-overlay-settled .m002-detail-port-inner{animation:none!important;transform:none!important;opacity:1!important;}
.m002-detail-overlay-settled .m002-detail-dev-bg{animation:none!important;fill:#0a0a10!important;}
.m002-detail-overlay-settled .m002-detail-stub{animation:none!important;opacity:1!important;}
.m002-detail-device{cursor:pointer;}
.m002-detail-device .m002-detail-dev-bg{transition:filter .15s,stroke-width .15s;}
.m002-detail-device.is-selected .m002-detail-dev-bg{stroke-width:2.4;filter:drop-shadow(0 0 4px var(--accent)) drop-shadow(0 0 14px var(--accent));}
.m002-detail-dev-type{font-family:'Share Tech Mono',monospace;font-size:18px;letter-spacing:3px;fill:var(--accent);opacity:.85;}
.m002-detail-dev-name{font-family:'Rajdhani',sans-serif;font-size:34px;font-weight:600;fill:#f5f3ff;letter-spacing:1px;}
.m002-detail-dev-ip{font-family:'Share Tech Mono',monospace;font-size:18px;fill:#9aa0a8;letter-spacing:1px;}
.m002-detail-port{cursor:pointer;}
.m002-detail-port-box{transition:filter .15s,stroke .15s,stroke-width .15s;}
.m002-detail-port:hover .m002-detail-port-box{stroke:var(--accent);filter:drop-shadow(0 0 2px var(--accent)) drop-shadow(0 0 8px var(--accent));}
.m002-detail-port.is-selected .m002-detail-port-box{stroke:var(--accent);stroke-width:2.4;filter:drop-shadow(0 0 4px var(--accent)) drop-shadow(0 0 12px var(--accent));}
.m002-detail-port-num{font-family:'Share Tech Mono',monospace;font-size:14px;fill:#e8e8ee;letter-spacing:.5px;font-weight:600;}
.m002-detail-port.is-empty .m002-detail-port-num{fill:#5a5f6e;}
.m002-detail-port-peer{font-family:'Share Tech Mono',monospace;font-size:11px;fill:#9aa0a8;letter-spacing:.5px;font-weight:600;}
.m002-detail-port-name{font-family:'Share Tech Mono',monospace;font-size:11px;fill:#9aa0a8;letter-spacing:.5px;font-weight:600;}
.m002-detail-stub{pointer-events:none;}
@media (prefers-reduced-motion: reduce){
  .m002-detail-overlay,.m002-detail-overlay .m002-detail-head,.m002-detail-overlay.m002-detail-overlay-show,.m002-detail-overlay.m002-detail-overlay-show .m002-detail-head{transition:none!important;}
  .m002-detail-overlay.m002-detail-overlay-show .m002-detail-device-inner,.m002-detail-overlay.m002-detail-overlay-show .m002-detail-dev-bg,.m002-detail-overlay.m002-detail-overlay-show .m002-detail-port-inner,.m002-detail-overlay.m002-detail-overlay-show .m002-detail-stub{animation:none!important;}
  .m002-detail-device-inner,.m002-detail-port-inner,.m002-detail-stub,.m002-detail-head{transform:none!important;opacity:1!important;}
  .m002-detail-overlay{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;}
}

/* Tool-aware cursor recolour. The N.IVEN custom cursor (red brackets +
   red dot) keeps its shape but shifts hue to match the active MOD_002
   tool. Body classes set in refreshToolHighlights drive this. */
body.m002-tool-select .cur-bracket{border-color:#ffffff !important;}
body.m002-tool-select .cursor-dot{background:#ffffff !important;box-shadow:0 0 10px #ffffff,0 0 3px #fff !important;}
body.m002-tool-link .cur-bracket{border-color:#35ff7a !important;}
body.m002-tool-link .cursor-dot{background:#35ff7a !important;box-shadow:0 0 10px #35ff7a,0 0 3px #fff !important;}
/* Delete tool: keeps the red brackets but swaps the centre dot for an X. */
body.m002-tool-delete .cursor-dot{display:none;}
body.m002-tool-delete .cursor::before,
body.m002-tool-delete .cursor::after{content:'';position:absolute;left:50%;top:50%;width:14px;height:1.5px;background:#ff003c;box-shadow:0 0 6px #ff003c;}
body.m002-tool-delete .cursor::before{transform:translate(-50%,-50%) rotate(45deg);}
body.m002-tool-delete .cursor::after{transform:translate(-50%,-50%) rotate(-45deg);}
/* Hover state in MOD_002: instead of growing (the global default), the
   cursor stands on its tip — the whole bracket frame pivots 45° around
   the cursor centre, brackets travel as one unit. */
body.m002-tool-select .cursor.active,
body.m002-tool-link .cursor.active,
body.m002-tool-delete .cursor.active{width:30px;height:30px;}
body.m002-tool-select .cursor.active .cur-bracket,
body.m002-tool-link .cursor.active .cur-bracket,
body.m002-tool-delete .cursor.active .cur-bracket{width:7px;height:7px;transform:none;}
.m002-cursor-frame{position:absolute;inset:0;transition:transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1),width 0.25s,height 0.25s;transform-origin:50% 50%;}
body.m002-tool-select .cursor.active .m002-cursor-frame,
body.m002-tool-link .cursor.active .m002-cursor-frame,
body.m002-tool-delete .cursor.active .m002-cursor-frame{transform:rotate(45deg);}
/* Pressed-while-hovering: shrink the rotated cursor like the unrotated one
   does on a background grab. Higher specificity than the bare .active rule
   above so it wins; no !important needed. */
body.m002-tool-select .cursor.active.down,
body.m002-tool-link .cursor.active.down,
body.m002-tool-delete .cursor.active.down{width:22px;height:22px;}
body.m002-tool-select .cursor.active.down .cur-bracket,
body.m002-tool-link .cursor.active.down .cur-bracket,
body.m002-tool-delete .cursor.active.down .cur-bracket{width:5px;height:5px;}
body.m002-tool-select .cursor.active.down .m002-cursor-frame,
body.m002-tool-link .cursor.active.down .m002-cursor-frame,
body.m002-tool-delete .cursor.active.down .m002-cursor-frame{transform:rotate(45deg) scale(0.8);}

/* Radial action menu — opens on background right-click. Centered on the
   click point. The first open plays a draw-in sequence: centre dot →
   vertical lines → semicircle arcs (top-pole sweeps down, bottom-pole
   sweeps up) → final UI fades over the construct lines. */
.m002-radial{position:absolute;width:${RADIAL_OUTER_R * 2}px;height:${RADIAL_OUTER_R * 2}px;transform:translate(-50%,-50%);transform-origin:center;opacity:0;pointer-events:auto;z-index:60;transition:opacity 80ms ease-out;filter:drop-shadow(0 8px 22px rgba(0,0,0,0.55));}
.m002-radial.m002-radial-in{opacity:1;}
.m002-radial.m002-radial-out{opacity:0;transform:translate(-50%,-50%) scale(0.92);transition:transform 140ms ease-in,opacity 140ms ease-in;}
.m002-radial.m002-radial-swap .m002-rad-svg{opacity:0;transform:scale(0.92);}
.m002-rad-svg{display:block;width:100%;height:100%;overflow:visible;transition:opacity 110ms ease-out,transform 110ms ease-out;transform-origin:center;}
.m002-rad-bg{fill:rgba(8,8,14,0.72);stroke:rgba(255,0,60,0.18);stroke-width:1;}
.m002-rad-core{fill:rgba(10,10,16,0.96);stroke:#1a1a22;stroke-width:1;}
.m002-rad-core-label{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.6px;fill:#5a5f6e;pointer-events:none;text-transform:uppercase;}
.m002-rad-seg{cursor:pointer;}
.m002-rad-seg-path{fill:rgba(14,14,22,0.92);stroke:#2a2a36;stroke-width:1;transition:fill 120ms ease-out,stroke 120ms ease-out;}
.m002-rad-seg:hover .m002-rad-seg-path{fill:rgba(255,0,60,0.14);stroke:#ff003c;}
.m002-rad-seg-glyph{font-family:'Share Tech Mono',monospace;font-size:22px;fill:#e8e8ee;pointer-events:none;letter-spacing:0;}
.m002-rad-seg-label{font-family:'Share Tech Mono',monospace;font-size:10px;letter-spacing:1.8px;fill:#cfd2d8;pointer-events:none;text-transform:uppercase;}
.m002-rad-seg-hint{font-family:'Share Tech Mono',monospace;font-size:8px;letter-spacing:1.4px;fill:#5a5f6e;pointer-events:none;text-transform:uppercase;}
.m002-rad-seg:hover .m002-rad-seg-glyph,
.m002-rad-seg:hover .m002-rad-seg-label{fill:#ff003c;}
.m002-rad-seg:hover .m002-rad-seg-hint{fill:#9aa0a8;}
/* Device picker: per-segment accent colour drives hover & dot. */
.m002-rad-seg-dev .m002-rad-seg-dot{fill:var(--accent);filter:drop-shadow(0 0 4px var(--accent));}
.m002-rad-seg-dev:hover .m002-rad-seg-path{fill:color-mix(in srgb,var(--accent) 14%,rgba(14,14,22,0.92));stroke:var(--accent);}
.m002-rad-seg-dev:hover .m002-rad-seg-label{fill:var(--accent);}
.m002-rad-seg-back{cursor:pointer;}
.m002-rad-seg-back:hover .m002-rad-core{stroke:#ff003c;fill:rgba(255,0,60,0.08);}
.m002-rad-seg-back:hover .m002-rad-core-label{fill:#ff003c;}
/* CANCEL centre tile (primary): same hover treatment as the back tile. */
.m002-rad-seg-cancel:hover .m002-rad-core{stroke:#ff003c;fill:rgba(255,0,60,0.08);}
.m002-rad-seg-cancel:hover .m002-rad-core-label{fill:#ff003c;}
/* Zone picker — active zone reads as already-occupied; hover still pops red. */
.m002-rad-seg-zone-active .m002-rad-seg-path{fill:rgba(255,0,60,0.10);stroke:rgba(255,0,60,0.55);}
.m002-rad-seg-zone-active .m002-rad-seg-label{fill:#ff003c;}

/* === Draw-in animation overlay (primary level only) ===
   The construct primitives — dot, vertical lines, two semicircle arcs — are
   drawn in sequence, then the real UI fades over the top while the overlay
   itself fades out. */
.m002-rad-dot{fill:#e8e8ee;transform-box:fill-box;transform-origin:center;transform:scale(0);}
.m002-rad-vline{stroke:#e8e8ee;stroke-width:1.5;stroke-linecap:round;stroke-dasharray:${RADIAL_OUTER_R};stroke-dashoffset:${RADIAL_OUTER_R};}
.m002-rad-arc{stroke:#e8e8ee;stroke-width:1.5;stroke-linecap:round;stroke-dasharray:${(Math.PI * (RADIAL_OUTER_R - 0.5)).toFixed(2)};stroke-dashoffset:${(Math.PI * (RADIAL_OUTER_R - 0.5)).toFixed(2)};}
/* Build-in animation gates on [data-fresh] — set only on the very first
   open. Returning to primary via the back tile strips the marker so the
   final UI just appears at full opacity instead of replaying the sequence.
   Durations are ~30% tighter than the original draft for a snappier feel. */
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-dot{animation:m002-rad-dot-in 100ms ease-out forwards;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-vline{animation:m002-rad-line-draw 125ms cubic-bezier(.55,.05,.35,1) 75ms forwards;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-arc{animation:m002-rad-arc-draw 225ms cubic-bezier(.5,.05,.35,1) 175ms forwards;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-anim{animation:m002-rad-fade-out 170ms ease-out 420ms forwards;}
@keyframes m002-rad-dot-in{0%{transform:scale(0);opacity:0;}40%{opacity:1;}100%{transform:scale(1);opacity:1;}}
@keyframes m002-rad-line-draw{to{stroke-dashoffset:0;}}
@keyframes m002-rad-arc-draw{to{stroke-dashoffset:0;}}
@keyframes m002-rad-fade-out{to{opacity:0;}}

/* Final UI is invisible until the construct lines have done their work. */
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-bg,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-core,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-core-label,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-path,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-glyph,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-label{opacity:0;animation:m002-rad-fade-final 155ms ease-out forwards;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-bg        {animation-delay:380ms;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-path  {animation-delay:405ms;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-core      {animation-delay:435ms;}
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-glyph,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-seg-label,
.m002-radial.m002-radial-in[data-level="primary"][data-fresh] .m002-rad-core-label{animation-delay:475ms;}
@keyframes m002-rad-fade-final{from{opacity:0;}to{opacity:1;}}
`;

// =============================================================================
// Register
// =============================================================================
window.NIVEN.registerModule(MODULE_CODE, {
  label: 'NET_FORGE · LAYER_MAP',
  mount,
  unmount,
});
