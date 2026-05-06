// === MOD_002 · NET_FORGE — Persistence ===
// Supabase-backed map persistence for the NET_FORGE module.
// Table:    m002_maps  (RLS-scoped to auth.uid())
// Schema:   { id uuid, user_id uuid, name text, data jsonb, created_at }
// Workflow: one row per map; the entire map (devices/links/stacks/vlans/
//           zones/view) lives in the `data` jsonb column. Saves are
//           debounced (SAVE_DEBOUNCE_MS) and run as UPDATE on the active row.
//           The active map id is remembered per-project in localStorage so
//           reloads land on the same map. localStorage is otherwise NOT used
//           as a data store — only legacy pre-cloud blobs are auto-migrated
//           on first authed mount when the server table is empty.
//
// Cross-module deps (`migrate`, `toast`) are injected once at module init via
// configurePersistence(). This avoids a circular import with mod_002_netmap.js.

import { rid } from './mod_002_utils.js';

const SAVE_DEBOUNCE_MS = 800;

const ACTIVE_KEY    = (s) => `niven:m002:active:${s.project?.id || s.code}`;
const LEGACY_META   = (s) => `niven:m002:meta:${s.project?.id || s.code}`;
const LEGACY_MAP    = (mapId) => `niven:m002:map:${mapId}`;
const LEGACY_SINGLE = (s) => `niven:m002:${s.project?.id || s.code}`;

// Licensed (paid) mode: maps persist to localStorage instead of Supabase.
// Triggered when state.localPersist is true (set in createState from ctx.license).
const LICENSED_STORE_KEY = 'plexus:licensed:store';

function readLicensedStore() {
  try {
    const raw = localStorage.getItem(LICENSED_STORE_KEY);
    if (!raw) return { maps: [], activeMapId: null };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { maps: [], activeMapId: null };
    if (!Array.isArray(parsed.maps)) parsed.maps = [];
    return parsed;
  } catch { return { maps: [], activeMapId: null }; }
}

function writeLicensedStore(store) {
  try { localStorage.setItem(LICENSED_STORE_KEY, JSON.stringify(store)); }
  catch (e) { console.warn('[m002] licensed store write failed', e); }
}

// Sync the entire state (maps list + active map data) to the licensed store.
// Called on every saveNow when localPersist is true — ensures rename/delete
// of maps in s.maps are reflected without needing per-op store edits.
function syncLicensedStore(s) {
  const activeData = snapshotMapData(s);
  const existing = readLicensedStore();
  const newStore = {
    maps: s.maps.map((m) => {
      if (m.id === s.activeMapId) return { id: m.id, name: m.name, data: activeData };
      const prev = existing.maps.find((sm) => sm.id === m.id);
      return { id: m.id, name: m.name, data: prev?.data ?? {} };
    }),
    activeMapId: s.activeMapId,
  };
  writeLicensedStore(newStore);
}

// Local copy of DEFAULT_VIEW. MUST stay in sync with the constant of the
// same name in mod_002_netmap.js. Duplicated here so this module has zero
// circular imports back into the main module.
const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1, vlanFilter: [], subnetFilter: [] };

// --- Dependency injection ---------------------------------------------------
// Set once at module init from mod_002_netmap.js. No-op fallbacks keep things
// non-crashy if a caller forgets to wire them up.

let _migrate = (s) => {};
let _toast   = (s, msg) => {};

export function configurePersistence({ migrate, toast } = {}) {
  if (typeof migrate === 'function') _migrate = migrate;
  if (typeof toast   === 'function') _toast = toast;
}

// --- Save flow --------------------------------------------------------------

export function schedSave(s) {
  if (!s.activeMapId || s.suspendSaves) return;
  s.dirty = true;
  clearTimeout(s.saveTimer);
  s.saveTimer = setTimeout(() => saveNow(s), SAVE_DEBOUNCE_MS);
}

export function snapshotMapData(s) {
  return {
    v: 4,
    devices: s.devices, links: s.links, stacks: s.stacks,
    vlanRegistry: s.vlanRegistry,
    subnetRegistry: s.subnetRegistry,
    zones: s.zones, activeZone: s.activeZone,
    view: s.view,
  };
}

export async function saveNow(s) {
  if (!s.activeMapId || s.suspendSaves) return;
  // Licensed mode (paid demo, no Supabase) — persist whole state to localStorage.
  if (!s.sb && s.localPersist) {
    syncLicensedStore(s);
    s.dirty = false;
    return;
  }
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
    _toast(s, 'SYNC FAILED — changes pending');
  }
}

// --- Load flow --------------------------------------------------------------

export async function loadFromServer(s) {
  // Licensed mode: load from localStorage. No supabase calls.
  if (!s.sb && s.localPersist) { loadFromLicensedStore(s); return; }
  if (!s.sb) { initFreshMapLocal(s); _toast(s, 'SYNC OFFLINE — local only'); return; }
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
    _toast(s, 'SYNC OFFLINE — local only');
    initFreshMapLocal(s);
  } finally {
    s.suspendSaves = false;
  }
}

export async function loadMapData(s, mapId) {
  // Licensed mode: pull data for the requested map from localStorage.
  if (!s.sb && s.localPersist) {
    const store = readLicensedStore();
    const m = store.maps.find((x) => x.id === mapId);
    hydrateMapData(s, m?.data || {});
    return;
  }
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

export function hydrateMapData(s, data) {
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
  _migrate(s);
}

// --- Legacy migration & bootstrap -------------------------------------------

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
  _toast(s, `Synced ${inserted.length} map${inserted.length === 1 ? '' : 's'} to cloud`);
  return true;
}

async function createInitialMap(s) {
  const { data: row, error } = await s.sb.from('m002_maps')
    .insert({ name: 'Main', data: {} }).select('id,name').single();
  if (error) {
    console.warn('[m002] create initial failed', error);
    initFreshMapLocal(s);
    _toast(s, 'SYNC OFFLINE — local only');
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

// Licensed boot: hydrate from localStorage; create a fresh "Main" if empty.
function loadFromLicensedStore(s) {
  s.suspendSaves = true;
  try {
    const store = readLicensedStore();
    if (!store.maps || store.maps.length === 0) {
      const id = 'lic_' + rid();
      s.maps = [{ id, name: 'Main' }];
      s.activeMapId = id;
      hydrateMapData(s, {});
      writeLicensedStore({ maps: [{ id, name: 'Main', data: {} }], activeMapId: id });
      return;
    }
    s.maps = store.maps.map((m) => ({ id: m.id, name: m.name }));
    const remembered = store.activeMapId;
    const activeRow = (remembered && store.maps.find((m) => m.id === remembered)) || store.maps[0];
    s.activeMapId = activeRow.id;
    hydrateMapData(s, activeRow.data || {});
  } finally {
    s.suspendSaves = false;
  }
}

// --- Active-map persistence (localStorage hint) -----------------------------

export function rememberActiveMap(s) {
  if (!s.activeMapId) return;
  try { localStorage.setItem(ACTIVE_KEY(s), s.activeMapId); } catch {}
}
