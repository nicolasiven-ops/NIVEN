// === Module (project) CRUD + hash routing ===
// Archive view: list/create/delete.
// Detail view:  #/m/<code> — read/edit/delete a single module.
(() => {
  const sb = window.sb;
  if (!sb) return;

  // --- Archive elements ---
  const grid = document.getElementById('module-grid');
  const emptyCard = document.getElementById('create-project-trigger');
  const nextCodeEl = document.getElementById('next-module-code');
  const statActive = document.querySelector('[data-stat="active"]');
  const statPlanning = document.querySelector('[data-stat="planning"]');

  // --- Module modal (create + edit) ---
  const modal = document.getElementById('module-modal');
  const panel = modal?.querySelector('.modal-panel');
  const form = document.getElementById('module-form');
  const feedback = document.getElementById('module-feedback');
  const abortBtn = document.getElementById('module-abort');
  const modalIdEl = document.getElementById('module-modal-id');
  const modalTitleEl = document.getElementById('module-title');
  const modalSubtitleEl = modal?.querySelector('.modal-subtitle');

  // --- Detail view elements ---
  const detailSection = document.getElementById('module-detail');
  const detailPanel = document.getElementById('detail-panel');
  const detailBody = document.getElementById('detail-body');
  const detailEmpty = document.getElementById('detail-empty');
  const detailMissingCode = document.getElementById('detail-missing-code');
  const detailEditBtn = document.getElementById('detail-edit');
  const detailDeleteBtn = document.getElementById('detail-delete');
  const detailDeployWrap = document.getElementById('detail-deploy');
  const detailDeployBtn = document.getElementById('detail-deploy-btn');
  const deployLabelEl = document.getElementById('deploy-label');

  // --- Runtime view elements ---
  const runtimeSection = document.getElementById('module-runtime');
  const runtimeStage = document.getElementById('module-stage');
  const runtimeEmpty = document.getElementById('runtime-empty');
  const runtimeCodeEl = document.getElementById('runtime-code');
  const runtimeLabelEl = document.getElementById('runtime-label');
  const runtimeBriefingLink = document.getElementById('runtime-briefing');

  if (!grid || !emptyCard || !modal || !form || !detailSection) return;

  let projects = [];
  let projectsLoaded = false;
  let editingId = null;
  let currentDetailCode = null;
  let currentRuntimeCode = null;
  let mountedRuntime = null; // { code, def }
  let sessionReady = false;
  let isAuthed = false;
  // Cards that have already played their entry animation in this session.
  // Re-renders (edits, deletes) won't re-animate cards the user has already seen.
  const animatedCardIds = new Set();

  // --- Utilities ---
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const nextCode = () => 'MOD_' + String(projects.length + 1).padStart(3, '0');
  const findByCode = (code) => projects.find((p) => p.code === code);
  const findById = (id) => projects.find((p) => p.id === id);
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  };

  // ================================================================
  // Archive rendering
  // ================================================================
  function cardHTML(p) {
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const status = (p.status || 'planning').toUpperCase();
    const domain = p.domain ? `<span class="dim">${esc(p.domain)}</span>` : '';
    const footer = p.url
      ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="card-link" data-no-nav>→ OPEN</a>`
      : `<span class="locked">◉ ${status === 'PLANNING' ? 'COMING SOON' : status}</span>`;
    const tagsHTML = tags.length
      ? `<div class="card-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
      : '';

    return `
      <article class="card" data-status="${esc(p.status)}" data-id="${esc(p.id)}" data-code="${esc(p.code || '')}">
        <div class="card-corners"></div>
        <button type="button" class="card-delete" aria-label="Delete module" data-delete="${esc(p.id)}">×</button>
        <div class="card-status">
          <span class="pulse"></span>
          <span>${esc(status)}</span>
        </div>
        <div class="card-id">${esc(p.code || '')}</div>
        <h3>${esc(p.title)}${domain}</h3>
        <p>${esc(p.description || '')}</p>
        ${tagsHTML}
        <div class="card-footer">${footer}</div>
      </article>
    `;
  }

  function renderArchive() {
    grid.querySelectorAll('.card:not(.card-empty)').forEach((el) => el.remove());
    const html = projects.map(cardHTML).join('');
    if (html) emptyCard.insertAdjacentHTML('beforebegin', html);

    // Stagger entry animation for cards we haven't shown yet.
    // The empty "+" slot animates last so the deal feels complete.
    const slots = [];
    grid.querySelectorAll('.card:not(.card-empty)').forEach((el) => {
      const id = el.dataset.id;
      if (id && !animatedCardIds.has(id)) slots.push({ el, id });
    });
    if (emptyCard && !animatedCardIds.has('__empty__')) slots.push({ el: emptyCard, id: '__empty__' });
    slots.forEach(({ el, id }, i) => {
      el.style.setProperty('--card-enter-delay', `${i * 70}ms`);
      el.classList.add('card-enter');
      animatedCardIds.add(id);
      el.addEventListener('animationend', function onEnd(ev) {
        if (ev.animationName !== 'card-enter') return;
        el.classList.remove('card-enter');
        el.style.removeProperty('--card-enter-delay');
        el.removeEventListener('animationend', onEnd);
      });
    });

    if (nextCodeEl) nextCodeEl.textContent = nextCode();
    updateStats();
    if (window.__wireHover) window.__wireHover();
  }

  function updateStats() {
    const active = projects.filter((p) => p.status === 'active').length;
    const planning = projects.filter((p) => p.status === 'planning').length;
    if (statActive) statActive.textContent = active;
    if (statPlanning) statPlanning.textContent = planning;
  }

  // Card click → navigate to detail. Delete button + external links stop here.
  grid.addEventListener('click', (e) => {
    if (e.target.closest('[data-delete]')) return;
    if (e.target.closest('[data-no-nav]')) return;
    const card = e.target.closest('.card:not(.card-empty)');
    if (!card) return;
    const code = card.dataset.code;
    if (code) location.hash = `#/m/${encodeURIComponent(code)}`;
  });

  grid.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-delete]');
    if (!delBtn) return;
    e.stopPropagation();
    e.preventDefault();
    const id = delBtn.dataset.delete;
    await deleteProject(id);
  });

  // --- Themed confirm dialog ---
  const confirmModal = document.getElementById('confirm-modal');
  const confirmIdEl = document.getElementById('confirm-id');
  const confirmTargetEl = document.getElementById('confirm-target');
  const confirmMsgEl = document.getElementById('confirm-message');
  const confirmOkBtn = document.getElementById('confirm-ok');
  const confirmCancelBtn = document.getElementById('confirm-cancel');
  let confirmResolve = null;

  function askPurge(proj) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      if (confirmIdEl) confirmIdEl.textContent = `${proj.code || 'MOD_???'} · PURGE`;
      if (confirmTargetEl) confirmTargetEl.textContent = proj.title || proj.code || '—';
      if (confirmMsgEl) confirmMsgEl.textContent = 'This action cannot be undone.';
      confirmModal.hidden = false;
      setTimeout(() => confirmCancelBtn?.focus(), 50);
    });
  }
  function closeConfirm(result) {
    confirmModal.hidden = true;
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }
  confirmOkBtn?.addEventListener('click', () => closeConfirm(true));
  confirmCancelBtn?.addEventListener('click', () => closeConfirm(false));
  confirmModal?.addEventListener('click', (e) => { if (e.target === confirmModal) closeConfirm(false); });
  window.addEventListener('keydown', (e) => {
    if (confirmModal && !confirmModal.hidden && e.key === 'Escape') closeConfirm(false);
  });

  async function deleteProject(id) {
    const proj = findById(id);
    if (!proj) return;
    const ok = await askPurge(proj);
    if (!ok) return;

    const { error } = await sb.from('projects').delete().eq('id', id);
    if (error) { alert('Delete failed: ' + error.message); return; }
    projects = projects.filter((p) => p.id !== id);
    renderArchive();
    // If we were viewing the deleted module, return to archive
    if (currentDetailCode && currentDetailCode === proj.code) {
      location.hash = '#/';
    }
  }

  // ================================================================
  // Data loading
  // ================================================================
  async function load() {
    const { data, error } = await sb
      .from('projects')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { console.error('[modules] load failed:', error); return; }
    projects = data || [];
    projectsLoaded = true;
    renderArchive();
    // Refresh detail if we're sitting on a detail route
    if (currentDetailCode) populateDetail(currentDetailCode);
  }

  function clearProjects() {
    projects = [];
    projectsLoaded = false;
    renderArchive();
    if (currentDetailCode) populateDetail(currentDetailCode);
  }

  // ================================================================
  // Module modal — create + edit
  // ================================================================
  function openCreateModal() {
    editingId = null;
    form.reset();
    form.querySelector('[name="code"]').value = nextCode();
    if (modalTitleEl) modalTitleEl.textContent = 'NEW_MODULE';
    if (modalSubtitleEl) modalSubtitleEl.textContent = 'Register a new project module in the archive.';
    if (modalIdEl) modalIdEl.textContent = `${nextCode()} · v0.1`;
    showModal();
  }

  function openEditModal(proj) {
    editingId = proj.id;
    form.reset();
    form.querySelector('[name="code"]').value = proj.code || '';
    form.querySelector('[name="title"]').value = proj.title || '';
    form.querySelector('[name="domain"]').value = proj.domain || '';
    form.querySelector('[name="description"]').value = proj.description || '';
    form.querySelector('[name="tags"]').value = (proj.tags || []).join(', ');
    form.querySelector('[name="status"]').value = proj.status || 'planning';
    form.querySelector('[name="url"]').value = proj.url || '';
    if (modalTitleEl) modalTitleEl.textContent = 'EDIT_MODULE';
    if (modalSubtitleEl) modalSubtitleEl.textContent = `Modify ${proj.code || 'module'} in the archive.`;
    if (modalIdEl) modalIdEl.textContent = `${proj.code || 'MOD'} · EDIT`;
    showModal();
  }

  function showModal() {
    setFeedback('', 'info');
    panel.classList.remove('shake', 'success');
    modal.hidden = false;
    setTimeout(() => form.querySelector('[name="title"]').focus(), 200);
  }

  function closeModal() {
    modal.hidden = true;
    form.reset();
    editingId = null;
  }

  function setFeedback(text, type = 'info') {
    feedback.textContent = text;
    feedback.className = 'auth-feedback ' + type;
  }
  function shake() {
    panel.classList.remove('shake');
    void panel.offsetWidth;
    panel.classList.add('shake');
  }
  function flashSuccess(msg, onDone) {
    setFeedback(msg, 'success');
    panel.classList.remove('success');
    void panel.offsetWidth;
    panel.classList.add('success');
    setTimeout(() => {
      closeModal();
      renderArchive();
      if (onDone) onDone();
    }, 850);
  }

  emptyCard.addEventListener('click', openCreateModal);
  abortBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = (fd.get('title') || '').toString().trim();
    if (!title) { setFeedback('// TITLE REQUIRED', 'error'); shake(); return; }

    const tagsRaw = (fd.get('tags') || '').toString();
    const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);

    const payload = {
      code: (fd.get('code') || '').toString().trim() || null,
      title,
      domain: (fd.get('domain') || '').toString().trim() || null,
      description: (fd.get('description') || '').toString().trim() || null,
      tags: tags.length ? tags : null,
      status: (fd.get('status') || 'planning').toString(),
      url: (fd.get('url') || '').toString().trim() || null,
    };

    const isEdit = !!editingId;
    setFeedback('// TRANSMITTING …', 'info');
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;

    let result;
    if (isEdit) {
      // updated_at bumped manually since we don't have a trigger
      payload.updated_at = new Date().toISOString();
      result = await sb
        .from('projects')
        .update(payload)
        .eq('id', editingId)
        .select()
        .single();
    } else {
      result = await sb.from('projects').insert(payload).select().single();
    }
    const { data, error } = result;
    submitBtn.disabled = false;

    if (error) {
      setFeedback('// FAILED · ' + error.message, 'error');
      shake();
      return;
    }

    if (isEdit) {
      const idx = projects.findIndex((p) => p.id === data.id);
      if (idx >= 0) projects[idx] = data;
      const newCode = data.code;
      flashSuccess('// MODULE UPDATED', () => {
        // If we were viewing this module, refresh the detail — follow code change
        if (currentDetailCode) {
          if (currentDetailCode !== newCode) {
            location.hash = `#/m/${encodeURIComponent(newCode)}`;
          } else {
            populateDetail(newCode);
          }
        }
      });
    } else {
      projects.push(data);
      flashSuccess('// MODULE DOCKED');
    }
  });

  // ================================================================
  // Detail view
  // ================================================================
  function populateDetail(code) {
    currentDetailCode = code;

    // Still booting — don't flash "SIGNAL_LOST" while we wait for session + data
    if (!sessionReady || !isAuthed || !projectsLoaded) {
      detailBody.hidden = true;
      detailEmpty.hidden = true;
      return;
    }

    const p = findByCode(code);
    if (!p) {
      detailBody.hidden = true;
      detailEmpty.hidden = false;
      if (detailMissingCode) detailMissingCode.textContent = code;
      return;
    }

    detailEmpty.hidden = true;
    detailBody.hidden = false;

    document.getElementById('detail-code').textContent = p.code || '—';
    document.getElementById('detail-status').textContent = (p.status || 'planning').toUpperCase();
    document.getElementById('detail-title-text').textContent = p.title;
    document.getElementById('detail-domain').textContent = p.domain || '';
    document.getElementById('detail-description').textContent = p.description || '—';
    document.getElementById('detail-breadcrumb-code').textContent = p.code || '—';

    const tagsEl = document.getElementById('detail-tags');
    const tagsWrap = document.getElementById('detail-tags-wrap');
    if (p.tags && p.tags.length) {
      tagsEl.innerHTML = p.tags.map((t) => `<span>${esc(t)}</span>`).join('');
      tagsWrap.hidden = false;
    } else {
      tagsWrap.hidden = true;
    }

    const urlEl = document.getElementById('detail-url');
    const urlWrap = document.getElementById('detail-url-wrap');
    if (p.url) {
      urlEl.href = p.url;
      urlEl.textContent = p.url;
      urlWrap.hidden = false;
    } else {
      urlWrap.hidden = true;
    }

    document.getElementById('detail-created').textContent = fmtDate(p.created_at);
    document.getElementById('detail-updated').textContent = fmtDate(p.updated_at);
    detailPanel.dataset.status = p.status || 'planning';

    // Show DEPLOY block if a runtime is registered for this code
    const runtime = window.NIVEN?.getModule?.(p.code);
    if (runtime && detailDeployWrap) {
      detailDeployWrap.hidden = false;
      if (deployLabelEl) deployLabelEl.textContent = runtime.label || `${p.code}_INTERFACE`;
    } else if (detailDeployWrap) {
      detailDeployWrap.hidden = true;
    }

    if (window.__wireHover) window.__wireHover();
  }

  detailEditBtn?.addEventListener('click', () => {
    const p = findByCode(currentDetailCode);
    if (p) openEditModal(p);
  });
  detailDeleteBtn?.addEventListener('click', async () => {
    const p = findByCode(currentDetailCode);
    if (p) await deleteProject(p.id);
  });
  detailDeployBtn?.addEventListener('click', () => {
    if (currentDetailCode) {
      location.hash = `#/m/${encodeURIComponent(currentDetailCode)}/run`;
    }
  });

  // Click outside the detail panel → back to archive (modal-style dismiss).
  // Ignores clicks on the panel itself, the lock screen, and any interactive
  // controls in the topbar (back link, breadcrumb).
  detailSection?.addEventListener('click', (e) => {
    if (e.target.closest('.detail-panel')) return;
    if (e.target.closest('.gated-lock')) return;
    if (e.target.closest('a, button, input, textarea, select')) return;
    location.hash = '#/';
  });

  // If a module script registers itself after the briefing is rendered, refresh.
  window.addEventListener('niven:module-registered', (e) => {
    if (currentDetailCode === e.detail?.code) populateDetail(currentDetailCode);
  });

  // ================================================================
  // Hash router — #/ for archive, #/m/<code> for detail
  // ================================================================
  function route() {
    const hash = location.hash || '#/';
    const runMatch = hash.match(/^#\/m\/([^\/]+)\/run\/?$/);
    const detailMatch = hash.match(/^#\/m\/([^\/]+)\/?$/);
    if (runMatch) {
      showRuntimeView(decodeURIComponent(runMatch[1]));
    } else if (detailMatch) {
      showDetailView(decodeURIComponent(detailMatch[1]));
    } else {
      showArchiveView();
    }
  }

  function showDetailView(code) {
    unmountRuntime();
    document.body.classList.remove('view-runtime');
    document.body.classList.add('view-detail');
    detailSection.hidden = false;
    if (runtimeSection) runtimeSection.hidden = true;
    window.scrollTo(0, 0);
    populateDetail(code);
  }

  function showArchiveView() {
    unmountRuntime();
    document.body.classList.remove('view-detail', 'view-runtime');
    detailSection.hidden = true;
    if (runtimeSection) runtimeSection.hidden = true;
    currentDetailCode = null;
  }

  function showRuntimeView(code) {
    currentDetailCode = code; // briefing-link in HUD points back here
    currentRuntimeCode = code;
    document.body.classList.remove('view-detail');
    document.body.classList.add('view-runtime');
    detailSection.hidden = true;
    if (runtimeSection) runtimeSection.hidden = false;

    if (runtimeBriefingLink) {
      runtimeBriefingLink.setAttribute('href', `#/m/${encodeURIComponent(code)}`);
    }
    if (runtimeCodeEl) runtimeCodeEl.textContent = code;

    // If still booting / not authed, mount nothing yet — the runtime route is
    // gated like the briefing. Once authed/loaded, route() re-fires.
    if (!sessionReady || !isAuthed || !projectsLoaded) return;

    const proj = findByCode(code);
    const def = window.NIVEN?.getModule?.(code);

    if (runtimeLabelEl) runtimeLabelEl.textContent = def?.label || (proj ? 'NO_RUNTIME' : 'SIGNAL_LOST');

    if (proj && def) {
      mountRuntime(code, def, proj);
    } else {
      // Empty/no-runtime placeholder
      if (runtimeEmpty) runtimeEmpty.hidden = false;
    }
  }

  function mountRuntime(code, def, proj) {
    // Tear down any previous mount before swapping
    unmountRuntime();
    if (runtimeEmpty) runtimeEmpty.hidden = true;
    // Give the module a clean stage — but keep the empty placeholder element
    // off-screen so we can restore it on unmount.
    Array.from(runtimeStage.children).forEach((c) => {
      if (c !== runtimeEmpty) c.remove();
    });
    try {
      def.mount(runtimeStage, {
        sb,
        project: proj,
        code,
        exit: () => { location.hash = `#/m/${encodeURIComponent(code)}`; },
      });
      mountedRuntime = { code, def };
    } catch (err) {
      console.error('[runtime] mount failed for', code, err);
      if (runtimeEmpty) runtimeEmpty.hidden = false;
    }
  }

  function unmountRuntime() {
    if (mountedRuntime?.def?.unmount) {
      try { mountedRuntime.def.unmount(); }
      catch (err) { console.error('[runtime] unmount failed:', err); }
    }
    mountedRuntime = null;
    currentRuntimeCode = null;
    if (runtimeStage) {
      Array.from(runtimeStage.children).forEach((c) => {
        if (c !== runtimeEmpty) c.remove();
      });
    }
  }

  // Intercept in-app nav anchors so hashchange fires even when href matches current location
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (!a) return;
    // Let default navigation happen — browsers trigger hashchange on hash-only links
  });

  window.addEventListener('hashchange', route);

  // ================================================================
  // Boot sequence
  // ================================================================
  sb.auth.getSession().then(({ data }) => {
    sessionReady = true;
    isAuthed = !!data.session;
    if (isAuthed) {
      load().then(route);
    } else {
      route();
    }
  });

  sb.auth.onAuthStateChange((_e, s) => {
    sessionReady = true;
    isAuthed = !!s;
    if (s) load().then(route);
    else { clearProjects(); route(); }
  });
})();
