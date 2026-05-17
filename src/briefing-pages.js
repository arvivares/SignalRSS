import { briefingConfigs, buildBriefings } from './briefing-service.js';
import { DEFAULT_CATEGORY } from './route-utils.js';
import { escapeHtml, formatUtc, hostFromUrl } from './view-utils.js';

function renderBriefingCard(briefing) {
  const links = Array.isArray(briefing.links) ? briefing.links : [];
  const impactLevel = String(briefing.impact_level || 'P0').toUpperCase();
  return `<article class="card briefing">
    <div class="meta">
      <span class="impact-badge ${escapeHtml(impactLevel.toLowerCase())}">${escapeHtml(impactLevel)} · ${briefing.impact_score}/100 · ${escapeHtml(briefing.impact_category)}</span>
      <span>${formatUtc(briefing.latest_published_at)}</span>
      <span>Generado ${formatUtc(briefing.generated_at)}</span>
    </div>
    <h2>${escapeHtml(briefing.title)}</h2>
    <p>${escapeHtml(briefing.summary)}</p>
    <h3>Links de las noticias</h3>
    <ul class="briefing-links">
      ${links.map((link) => `<li><a href="${escapeHtml(link.url || '#')}">${escapeHtml(link.title || link.url || 'Link')}</a><div class="source">${escapeHtml(link.source || hostFromUrl(link.url) || 'source')} · ${formatUtc(link.published_at)}</div></li>`).join('')}
    </ul>
  </article>`;
}

function renderPagination({ path, hours, limit, page, pages, total }) {
  const previousPage = Math.max(page - 1, 1);
  const nextPage = Math.min(page + 1, pages);
  return `<nav class="pagination" aria-label="Paginación">
    <a class="pill ${page <= 1 ? 'disabled' : ''}" href="/${path}?hours=${hours}&limit=${limit}&page=${previousPage}">Anterior</a>
    <span class="source">Página ${page} de ${pages} · ${total} briefings · ordenado por fecha descendente</span>
    <a class="pill ${page >= pages ? 'disabled' : ''}" href="/${path}?hours=${hours}&limit=${limit}&page=${nextPage}">Siguiente</a>
  </nav>`;
}

export async function renderBriefingsPage({
  renderLayout,
  level = 'P0',
  category = DEFAULT_CATEGORY,
  hours = briefingConfigs[level].defaultHours(),
  limit = 50,
  page = 1,
} = {}) {
  const briefingConfig = briefingConfigs[level];
  const routePath = category === DEFAULT_CATEGORY
    ? briefingConfig.path
    : `${category}/${briefingConfig.path}`;
  const result = await buildBriefings({ level, category, hours, limit, page });
  const briefings = result.items;
  const pagination = renderPagination({
    path: routePath,
    hours,
    limit: result.limit,
    page: result.page,
    pages: result.pages,
    total: result.total,
  });
  const categoryName = category === DEFAULT_CATEGORY ? 'Artificial Intelligence' : category;
  const body = `
    <h1>${escapeHtml(level)} ${escapeHtml(categoryName)} en español.</h1>
    <p class="lede">Briefings ejecutivos en español para clusters ${escapeHtml(level)} de ${escapeHtml(categoryName)} de las últimas ${hours} horas. Cada item incluye título, resumen coherente y links de las noticias al final.</p>
    <div class="toolbar">
      <a class="pill" href="/api/${routePath}?hours=${hours}&limit=${result.limit}&page=${result.page}">JSON</a>
      <a class="pill" href="/impact?category=${escapeHtml(category)}&level=${escapeHtml(level)}">Ver ${escapeHtml(level)} original</a>
    </div>
    ${pagination}
    ${briefings.length ? briefings.map(renderBriefingCard).join('') : `<div class="card empty">No hay briefings ${escapeHtml(level)} generados todavía.</div>`}
    ${pagination}`;

  return renderLayout({ title: `${level} ${categoryName} en español`, body });
}
