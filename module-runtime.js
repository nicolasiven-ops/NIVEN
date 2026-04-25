// === N.IVEN module runtime registry ===
// Each module that has an interactive interface registers itself here.
//   window.NIVEN.registerModule('MOD_001', {
//     label: 'NOTES_3D',
//     mount(stage, ctx) { /* takes over `stage` until unmount */ },
//     unmount() { /* tear down */ },
//   });
// modules.js queries this registry to decide whether to show DEPLOY,
// and to mount/unmount on entering/leaving the runtime route.
(() => {
  const registry = new Map();

  function registerModule(code, def) {
    if (!code || !def || typeof def.mount !== 'function') {
      console.warn('[runtime] invalid module def for', code);
      return;
    }
    registry.set(code, def);
    // Notify listeners (modules.js) that registry changed — useful for
    // hot-loaded module scripts that arrive after the briefing is rendered.
    window.dispatchEvent(new CustomEvent('niven:module-registered', { detail: { code } }));
  }

  function getModule(code) {
    return registry.get(code) || null;
  }

  function hasModule(code) {
    return registry.has(code);
  }

  window.NIVEN = window.NIVEN || {};
  window.NIVEN.registerModule = registerModule;
  window.NIVEN.getModule = getModule;
  window.NIVEN.hasModule = hasModule;
})();
