import { buildNewsQueue } from './news-service.js';

export async function renderNewsPage({ renderLayout }) {
  const initialLevel = 'P0';
  const initialNews = await buildNewsQueue({ limit: 30, hours: 168, level: initialLevel });
  const initialJson = JSON.stringify(initialNews).replaceAll('<', '\\u003c');
  const body = `
    <div id="newsStart" class="news-start">
      <div class="news-start-inner">
        <div class="label">SignalRSS</div>
        <h1>News triage.</h1>
        <p>Elegí una prioridad y revisá una noticia por vez, siempre desde la más nueva a la más vieja.</p>
        <div class="news-priority-picker" role="radiogroup" aria-label="Prioridad">
          <button class="active" type="button" data-level="P0" role="radio" aria-checked="true">P0</button>
          <button type="button" data-level="P1" role="radio" aria-checked="false">P1</button>
          <button type="button" data-level="P2" role="radio" aria-checked="false">P2</button>
          <button type="button" data-level="P3" role="radio" aria-checked="false">P3</button>
        </div>
        <p class="news-start-meta"><strong id="selectedLevelLabel">${initialLevel}</strong> · <span id="startPendingCount">${initialNews.length}</span> noticias cargadas</p>
        <button id="startNewsButton" type="button">Comenzar</button>
      </div>
    </div>
    <section class="news-shell">
      <div class="news-copy">
        <div class="label">Swipe queue</div>
        <h1>News triage.</h1>
        <p class="lede">Revisá clusters P0 a P3 de todas las categorías. Izquierda descarta, derecha guarda como interesante.</p>
        <div class="news-stats">
          <span><strong id="newsRemaining">${initialNews.length}</strong> pendientes cargadas</span>
          <span><strong id="newsDecisionCount">0</strong> decisiones esta sesión</span>
        </div>
        <div class="toolbar">
          <a class="pill" href="/api/news/interested">Interesadas JSON</a>
          <a class="pill" href="/">Dashboard</a>
        </div>
      </div>
      <div class="swipe-stage" aria-live="polite">
        <div class="swipe-hint left">No me interesa</div>
        <div class="swipe-hint right">Me interesa</div>
        <article id="newsCard" class="swipe-card">
          <div class="card-empty">Cargando noticias...</div>
        </article>
      </div>
    </section>
    <script>
      const initialNews = ${initialJson};
      const state = {
        queue: initialNews,
        index: 0,
        decisions: 0,
        selectedLevel: '${initialLevel}',
        dragging: false,
        startX: 0,
        currentX: 0,
        started: false,
      };
      const card = document.getElementById('newsCard');
      const startScreen = document.getElementById('newsStart');
      const startButton = document.getElementById('startNewsButton');
      const priorityButtons = Array.from(document.querySelectorAll('.news-priority-picker button'));
      const selectedLevelLabel = document.getElementById('selectedLevelLabel');
      const startPendingCount = document.getElementById('startPendingCount');
      const remaining = document.getElementById('newsRemaining');
      const decisionCount = document.getElementById('newsDecisionCount');

      function esc(value) {
        return String(value || '').replace(/[&<>"']/g, (char) => ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }[char]));
      }

      function currentItem() {
        return state.queue[state.index] || null;
      }

      function updateStats() {
        remaining.textContent = Math.max(state.queue.length - state.index, 0);
        decisionCount.textContent = state.decisions;
        startPendingCount.textContent = Math.max(state.queue.length - state.index, 0);
        selectedLevelLabel.textContent = state.selectedLevel;
      }

      function formatNewsDate(value) {
        if (!value) return 'Sin fecha';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Sin fecha';
        return new Intl.DateTimeFormat('es-ES', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(date);
      }

      function renderCard() {
        const item = currentItem();
        updateStats();
        card.style.transform = '';
        card.style.opacity = '1';
        card.classList.remove('leaving-left', 'leaving-right');

        if (!item) {
          card.innerHTML = '<div class="card-empty"><h2>No quedan noticias cargadas.</h2><p>Refrescá o volvé más tarde cuando entren nuevos briefings.</p></div>';
          return;
        }

        const links = Array.isArray(item.links) ? item.links.slice(0, 3) : [];
        card.innerHTML = \`
          <div class="swipe-meta">
            <span class="impact-badge \${esc(String(item.impact_level || '').toLowerCase())}">\${esc(item.impact_level)} · \${esc(item.impact_score)}/100</span>
            <span>\${esc(item.category_name || item.category_slug)}</span>
          </div>
          <h2>\${esc(item.title)}</h2>
          <p class="swipe-summary">\${esc(item.summary)}</p>
          <div class="swipe-footer">
            <span>\${esc(item.impact_category || 'signal')}</span>
            <span>\${links.length} links</span>
          </div>
          <div class="swipe-date">\${esc(formatNewsDate(item.latest_published_at))}</div>
          \${links.length ? \`<ul class="swipe-links">\${links.map((link) => \`<li>\${esc(link.source || '')} · \${esc(link.title || link.url || '')}</li>\`).join('')}</ul>\` : ''}
        \`;
      }

      async function loadMoreIfNeeded() {
        if (state.queue.length - state.index > 6) return;
        const response = await fetch('/api/news?limit=30&level=' + encodeURIComponent(state.selectedLevel));
        if (!response.ok) return;
        const payload = await response.json();
        const known = new Set(state.queue.map((item) => item.story_hash || item.cluster_id));
        const incoming = (payload.data || []).filter((item) => !known.has(item.story_hash || item.cluster_id));
        state.queue.push(...incoming);
        updateStats();
      }

      async function loadLevel(level) {
        state.selectedLevel = level;
        state.queue = [];
        state.index = 0;
        state.decisions = 0;
        updateStats();
        card.innerHTML = '<div class="card-empty">Cargando noticias ' + esc(level) + '...</div>';

        const response = await fetch('/api/news?limit=30&level=' + encodeURIComponent(level));
        if (!response.ok) {
          card.innerHTML = '<div class="card-empty"><h2>No pude cargar noticias.</h2><p>Intentá refrescar la pantalla.</p></div>';
          return;
        }
        const payload = await response.json();
        state.queue = payload.data || [];
        state.index = 0;
        updateStats();
        renderCard();
      }

      function selectLevel(level) {
        state.selectedLevel = level;
        priorityButtons.forEach((button) => {
          const active = button.dataset.level === level;
          button.classList.toggle('active', active);
          button.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        if (state.started) {
          loadLevel(level);
        } else {
          loadLevel(level);
        }
      }

      async function swipe(action) {
        const item = currentItem();
        if (!item) return;
        card.classList.add(action === 'interested' ? 'leaving-right' : 'leaving-left');
        state.index += 1;
        state.decisions += 1;
        updateStats();

        try {
          await fetch('/api/news/swipe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cluster_id: item.cluster_id, action }),
          });
        } catch {
          // UI remains optimistic; the server is the source of truth on refresh.
        }

        setTimeout(renderCard, 180);
        loadMoreIfNeeded();
      }

      function setDrag(delta) {
        const rotate = delta / 22;
        card.style.transform = \`translateX(\${delta}px) rotate(\${rotate}deg)\`;
        card.style.opacity = String(Math.max(0.45, 1 - Math.abs(delta) / 420));
      }

      card.addEventListener('pointerdown', (event) => {
        if (!currentItem()) return;
        state.dragging = true;
        state.startX = event.clientX;
        card.setPointerCapture(event.pointerId);
      });

      card.addEventListener('pointermove', (event) => {
        if (!state.dragging) return;
        state.currentX = event.clientX - state.startX;
        setDrag(state.currentX);
      });

      card.addEventListener('pointerup', () => {
        if (!state.dragging) return;
        state.dragging = false;
        const delta = state.currentX;
        state.currentX = 0;
        if (delta > 95) return swipe('interested');
        if (delta < -95) return swipe('dismissed');
        setDrag(0);
      });

      document.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') swipe('interested');
        if (event.key === 'ArrowLeft') swipe('dismissed');
      });

      startButton.addEventListener('click', () => {
        state.started = true;
        startScreen.classList.add('hidden');
        renderCard();
      });
      priorityButtons.forEach((button) => {
        button.addEventListener('click', () => selectLevel(button.dataset.level));
      });
      renderCard();
    </script>`;

  return renderLayout({
    title: 'News',
    body,
    bodyClass: 'news-fullscreen',
    hideTopbar: true,
  });
}
