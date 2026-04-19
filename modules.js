// === Module (project) CRUD against the Supabase `projects` table ===
// Loads the user's modules on login, renders them as cards, handles create & delete.
// Stats in ABOUT_NODE stay in sync with the current list.
(() => {
  const sb = window.sb;
  if (!sb) return;

  const grid = document.getElementById('module-grid');
  const emptyCard = document.getElementById('create-project-trigger');
  const nextCodeEl = document.getElementById('next-module-code');
  const statActive = document.querySelector('[data-stat="active"]');
  const statPlanning = document.querySelector('[data-stat="planning"]');

  const modal = document.getElementById('module-modal');
  const panel = modal?.querySelector('.modal-panel');
  const form = document.getElementById('module-form');
  const feedback = document.getElementById('module-feedback');
  const abortBtn = document.getElementById('module-abort');
  const modalIdEl = document.getElementById('module-modal-id');

  if (!grid || !emptyCard || !modal || !form) return;

  let projects = [];

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const nextCode = () => 'MOD_' + String(projects.length + 1).padStart(3, '0');

  function cardHTML(p) {
    const tags = Array.isArray(p.tags) ? p.tags : [];
    const status = (p.status || 'planning').toUpperCase();
    const domain = p.domain ? `<span class="dim">${esc(p.domain)}</span>` : '';
    const footer = p.url
      ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="card-link">→ OPEN</a>`
      : `<span class="locked">◉ ${status === 'PLANNING' ? 'COMING SOON' : status}</span>`;
    const tagsHTML = tags.length
      ? `<div class="card-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
      : '';

    return `
      <article class="card" data-status="${esc(p.status)}" data-id="${esc(p.id)}">
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

  function render() {
    // Remove all non-empty cards (idempotent re-render)
    grid.querySelectorAll('.card:not(.card-empty)').forEach((el) => el.remove());
    // Insert fresh cards before the + FREIER SLOT button
    const html = projects.map(cardHTML).join('');
    if (html) emptyCard.insertAdjacentHTML('beforebegin', html);

    if (nextCodeEl) nextCodeEl.textContent = nextCode();
    updateStats();
    wireDeletes();
    if (window.__wireHover) window.__wireHover();
  }

  function wireDeletes() {
    grid.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const id = btn.dataset.delete;
        const proj = projects.find((p) => p.id === id);
        if (!proj) return;
        if (!confirm(`Delete module "${proj.title}"?`)) return;

        const { error } = await sb.from('projects').delete().eq('id', id);
        if (error) { alert('Delete failed: ' + error.message); return; }
        projects = projects.filter((p) => p.id !== id);
        render();
      });
    });
  }

  function updateStats() {
    const active = projects.filter((p) => p.status === 'active').length;
    const planning = projects.filter((p) => p.status === 'planning').length;
    if (statActive) statActive.textContent = active;
    if (statPlanning) statPlanning.textContent = planning;
  }

  async function load() {
    const { data, error } = await sb
      .from('projects')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { console.error('[modules] load failed:', error); return; }
    projects = data || [];
    render();
  }

  function clearProjects() {
    projects = [];
    render();
  }

  // --- Create modal ---
  function openModal() {
    form.reset();
    form.querySelector('[name="code"]').value = nextCode();
    if (modalIdEl) modalIdEl.textContent = `${nextCode()} · v0.1`;
    setFeedback('', 'info');
    panel.classList.remove('shake', 'success');
    modal.hidden = false;
    setTimeout(() => form.querySelector('[name="title"]').focus(), 200);
  }
  function closeModal() {
    modal.hidden = true;
    form.reset();
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
  function flashSuccess(msg) {
    setFeedback(msg, 'success');
    panel.classList.remove('success');
    void panel.offsetWidth;
    panel.classList.add('success');
    setTimeout(() => { closeModal(); render(); }, 850);
  }

  emptyCard.addEventListener('click', openModal);
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

    setFeedback('// TRANSMITTING …', 'info');
    const submitBtn = form.querySelector('[type="submit"]');
    submitBtn.disabled = true;

    const { data, error } = await sb
      .from('projects')
      .insert(payload)
      .select()
      .single();

    submitBtn.disabled = false;

    if (error) {
      setFeedback('// FAILED · ' + error.message, 'error');
      shake();
      return;
    }
    projects.push(data);
    flashSuccess('// MODULE DOCKED');
  });

  // Boot — load once initial session is known, react to auth changes
  sb.auth.getSession().then(({ data }) => {
    if (data.session) load();
  });
  sb.auth.onAuthStateChange((_e, s) => {
    if (s) load();
    else clearProjects();
  });
})();
