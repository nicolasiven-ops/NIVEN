// === Animated particle network background ===
const canvas = document.getElementById('bg-canvas');
const ctx = canvas.getContext('2d');

let W = 0, H = 0;
const DPR = Math.min(window.devicePixelRatio || 1, 2);

function resize() {
  W = canvas.width = window.innerWidth * DPR;
  H = canvas.height = window.innerHeight * DPR;
  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';
}
resize();
window.addEventListener('resize', resize);

function makeLayer(count, cfg) {
  return Array.from({ length: count }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    vx: (Math.random() - 0.5) * cfg.speed * DPR,
    vy: (Math.random() - 0.5) * cfg.speed * DPR,
    r: (Math.random() * cfg.rSpread + cfg.rBase) * DPR,
    a: Math.random() * cfg.aSpread + cfg.aBase,
  }));
}

// Far-back layer — huge, ultra-faint polygons filling the canvas
const FAR_COUNT = Math.min(28, Math.floor((window.innerWidth * window.innerHeight) / 60000));
const farParticles = makeLayer(FAR_COUNT, {
  speed: 0.05, rBase: 1.8, rSpread: 2.8, aBase: 0.04, aSpread: 0.08,
});

// Back layer — larger, slower, fainter — creates depth and bigger geometric structures
const BACK_COUNT = Math.min(60, Math.floor((window.innerWidth * window.innerHeight) / 28000));
const backParticles = makeLayer(BACK_COUNT, {
  speed: 0.09, rBase: 1.2, rSpread: 2.4, aBase: 0.08, aSpread: 0.18,
});

// Front layer — crisp mesh, main attraction
const FRONT_COUNT = Math.min(160, Math.floor((window.innerWidth * window.innerHeight) / 11000));
const frontParticles = makeLayer(FRONT_COUNT, {
  speed: 0.22, rBase: 0.5, rSpread: 1.6, aBase: 0.25, aSpread: 0.55,
});

const LAYERS = [
  {
    particles: farParticles,
    linkDist: 640 * DPR,
    triDist: 520 * DPR,
    lineColor: '140, 0, 40',
    fillColor: '160, 10, 50',
    dotColor: '180, 20, 60',
    lineAlphaMax: 0.09,
    triAlphaMax: 0.02,
    lineWidthBase: 0.4,
    lineWidthSpread: 0.25,
    glow: 24,
    glowColor: 'rgba(200, 0, 50, 0.35)',
  },
  {
    particles: backParticles,
    linkDist: 320 * DPR,
    triDist: 240 * DPR,
    lineColor: '180, 10, 50',
    fillColor: '200, 20, 60',
    dotColor: '220, 30, 70',
    lineAlphaMax: 0.22,
    triAlphaMax: 0.035,
    lineWidthBase: 0.5,
    lineWidthSpread: 0.4,
    glow: 20,
    glowColor: 'rgba(255, 20, 70, 0.6)',
  },
  {
    particles: frontParticles,
    linkDist: 190 * DPR,
    triDist: 150 * DPR,
    lineColor: '255, 30, 80',
    fillColor: '255, 0, 60',
    dotColor: '255, 50, 90',
    lineAlphaMax: 0.42,
    triAlphaMax: 0.045,
    lineWidthBase: 0.7,
    lineWidthSpread: 0.6,
    glow: 14,
    glowColor: 'rgba(255, 0, 60, 0.9)',
  },
];

function drawLayer(layer) {
  const { particles, linkDist, triDist, lineColor, fillColor, dotColor,
          lineAlphaMax, triAlphaMax, lineWidthBase, lineWidthSpread, glow, glowColor } = layer;

  // Triangular fills
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const q = particles[j];
      const dpq = Math.hypot(p.x - q.x, p.y - q.y);
      if (dpq > triDist) continue;
      for (let k = j + 1; k < particles.length; k++) {
        const r = particles[k];
        const dqr = Math.hypot(q.x - r.x, q.y - r.y);
        const dpr = Math.hypot(p.x - r.x, p.y - r.y);
        if (dqr > triDist || dpr > triDist) continue;
        const avg = (dpq + dqr + dpr) / 3;
        const alpha = (1 - avg / triDist) * triAlphaMax;
        ctx.fillStyle = `rgba(${fillColor}, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.lineTo(r.x, r.y);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Connection lines
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    for (let j = i + 1; j < particles.length; j++) {
      const q = particles[j];
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < linkDist * linkDist) {
        const d = Math.sqrt(d2);
        const t = 1 - d / linkDist;
        ctx.strokeStyle = `rgba(${lineColor}, ${t * lineAlphaMax})`;
        ctx.lineWidth = lineWidthBase + t * lineWidthSpread;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.stroke();
      }
    }
  }

  // Particles with glow
  ctx.shadowBlur = glow;
  ctx.shadowColor = glowColor;
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0 || p.x > W) p.vx *= -1;
    if (p.y < 0 || p.y > H) p.vy *= -1;

    ctx.fillStyle = `rgba(${dotColor}, ${p.a})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

function tick() {
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  for (const layer of LAYERS) drawLayer(layer);
  requestAnimationFrame(tick);
}

if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  tick();
}

// === Custom cursor ===
(() => {
  const cursor = document.querySelector('.cursor');
  const dot = document.querySelector('.cursor-dot');
  if (!cursor || !dot) return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  let visible = false;

  window.addEventListener('mousemove', (e) => {
    const t = `translate3d(${e.clientX}px, ${e.clientY}px, 0) translate(-50%, -50%)`;
    dot.style.transform = t;
    cursor.style.transform = t;
    if (!visible) {
      cursor.style.opacity = '1';
      dot.style.opacity = '1';
      visible = true;
    }
  });

  window.addEventListener('mouseleave', () => {
    cursor.style.opacity = '0';
    dot.style.opacity = '0';
    visible = false;
  });

  window.addEventListener('mousedown', () => cursor.classList.add('down'));
  window.addEventListener('mouseup',   () => cursor.classList.remove('down'));

  const hoverSel = 'a, button, .cta, .card, input, [role="button"]';
  function wireHover(root = document) {
    root.querySelectorAll(hoverSel).forEach((el) => {
      if (el.dataset.cursorWired) return;
      el.dataset.cursorWired = '1';
      el.addEventListener('mouseenter', () => cursor.classList.add('active'));
      el.addEventListener('mouseleave', () => cursor.classList.remove('active'));
    });
  }
  wireHover();
  window.__wireHover = wireHover;
})();

// === Authentication (Supabase) ===
// Single-user auth. The keyphrase the user types = Supabase account password.
// Email is fixed in config.js and never shown in the UI.
const sb = window.supabase.createClient(
  window.NIVEN_CONFIG.supabaseUrl,
  window.NIVEN_CONFIG.supabaseKey,
  { auth: { persistSession: true, autoRefreshToken: true } }
);
window.sb = sb; // expose for future modules (projects CRUD etc.)

(() => {
  const trigger = document.getElementById('auth-trigger');
  const modal = document.getElementById('auth-modal');
  const panel = modal?.querySelector('.modal-panel');
  const form = document.getElementById('auth-form');
  const input = document.getElementById('auth-input');
  const feedback = document.getElementById('auth-feedback');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('modal-subtitle');
  const stateLabel = document.getElementById('modal-state-label');
  const prompt = document.getElementById('auth-prompt');
  const transmit = document.getElementById('auth-transmit');
  const abort = document.getElementById('auth-abort');
  if (!trigger || !modal) return;

  const authText = trigger.querySelector('.auth-text');
  const email = window.NIVEN_CONFIG.authEmail;

  let session = null;
  let mode = 'auth';
  let busy = false;

  function render() {
    if (session) {
      trigger.dataset.state = 'authenticated';
      authText.textContent = 'AUTHENTICATED';
    } else {
      trigger.dataset.state = 'locked';
      authText.textContent = 'LOCKED';
    }
  }

  function setFeedback(text, type = 'info') {
    feedback.textContent = text;
    feedback.className = 'auth-feedback ' + type;
  }

  function openModal() {
    input.value = '';
    panel.classList.remove('shake', 'success');

    if (session) {
      mode = 'logout';
      title.textContent = 'TERMINATE_SESSION';
      subtitle.textContent = 'Disconnect from the secure channel?';
      stateLabel.textContent = 'SESSION_ACTIVE';
      prompt.hidden = true;
      transmit.textContent = 'DISCONNECT';
      abort.textContent = 'CANCEL';
      setFeedback('', 'info');
    } else {
      mode = 'auth';
      title.textContent = 'SECURE_CHANNEL';
      subtitle.textContent = 'Authorization required. Keyphrase verified via remote node.';
      stateLabel.textContent = 'CHANNEL_LOCKED';
      prompt.hidden = false;
      input.placeholder = 'KEYPHRASE';
      transmit.textContent = 'TRANSMIT';
      abort.textContent = 'ABORT';
      setFeedback('', 'info');
    }

    modal.hidden = false;
    setTimeout(() => {
      if (!prompt.hidden) input.focus();
      else transmit.focus();
    }, 200);
  }

  function closeModal() {
    modal.hidden = true;
    input.value = '';
  }

  function shake() {
    panel.classList.remove('shake');
    void panel.offsetWidth;
    panel.classList.add('shake');
  }

  function flashSuccess(msg, after) {
    setFeedback(msg, 'success');
    panel.classList.remove('success');
    void panel.offsetWidth;
    panel.classList.add('success');
    setTimeout(() => {
      closeModal();
      render();
      if (after) after();
    }, 950);
  }

  trigger.addEventListener('click', openModal);
  abort.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const val = input.value;

    if (mode === 'auth') {
      if (!val) { shake(); return; }
      busy = true;
      transmit.disabled = true;
      setFeedback('// HANDSHAKE …', 'info');

      const { data, error } = await sb.auth.signInWithPassword({
        email,
        password: val,
      });

      busy = false;
      transmit.disabled = false;

      if (error || !data?.session) {
        setFeedback('// ACCESS DENIED', 'error');
        shake();
        input.value = '';
        input.focus();
        return;
      }
      session = data.session;
      flashSuccess('// ACCESS GRANTED');
      return;
    }

    if (mode === 'logout') {
      busy = true;
      transmit.disabled = true;
      await sb.auth.signOut();
      busy = false;
      transmit.disabled = false;
      session = null;
      flashSuccess('// CHANNEL CLOSED');
      return;
    }
  });

  // Keep UI in sync with session state (tab-switches, token refresh, etc.)
  sb.auth.onAuthStateChange((_event, s) => {
    session = s;
    render();
  });

  // Initial boot — restore session from storage if present
  sb.auth.getSession().then(({ data }) => {
    session = data.session;
    render();
  });

  render();
  if (window.__wireHover) window.__wireHover();
})();

// === HUD clock ===
const clockEl = document.getElementById('clock');
function updateClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  clockEl.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
updateClock();
setInterval(updateClock, 1000);
