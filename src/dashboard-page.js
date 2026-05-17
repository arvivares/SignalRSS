import {
  buildCategoryStats,
  buildClusterStats,
  buildDashboardMetrics,
} from './stats-service.js';
import { escapeHtml, formatDecimal, formatNumber, formatUtc, hostFromUrl } from './view-utils.js';

function metricCard(label, value, note = '') {
  return `<div class="card metric-card">
    <div>
      <div class="metric">${escapeHtml(value)}</div>
      <div class="label">${escapeHtml(label)}</div>
    </div>
    ${note ? `<p class="metric-note">${escapeHtml(note)}</p>` : ''}
  </div>`;
}

function renderCountryBars(countries) {
  const max = Math.max(...countries.map((country) => Number(country.ingested_articles_24h || 0)), 1);
  return `<div class="bar-list">
    ${countries.slice(0, 10).map((country) => {
      const value = Number(country.ingested_articles_24h || 0);
      return `<div class="bar-row">
        <span>${escapeHtml(country.country)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(3, Math.round((value / max) * 100))}%"></span></span>
        <strong>${formatNumber(value)}</strong>
      </div>`;
    }).join('')}
  </div>`;
}

function renderHourlyChart(hourly) {
  const max = Math.max(...hourly.map((hour) => Number(hour.articles_ingested || 0)), 1);
  return `<div class="mini-chart" aria-label="Articles ingested by hour">
    ${hourly.map((hour) => {
      const value = Number(hour.articles_ingested || 0);
      const label = `${formatUtc(hour.hour_utc)} · ${formatNumber(value)} articles`;
      return `<span class="mini-bar" title="${escapeHtml(label)}" style="height:${Math.max(4, Math.round((value / max) * 100))}%"></span>`;
    }).join('')}
  </div>`;
}

function renderBacklogStatus(rows) {
  return `<div class="status-list">
    ${rows.map((row) => {
      const impactPending = Number(row.impact_pending || 0);
      const briefingPending = Number(row.briefing_pending || 0);
      const done = impactPending === 0 && briefingPending === 0;
      return `<div class="status-row">
        <div>
          <strong>${escapeHtml(row.category)}</strong>
          <span>${formatNumber(row.clusters)} clusters · ${done ? 'terminada' : 'pendiente'}</span>
        </div>
        <div class="${done ? 'ok' : 'warn'}">${formatNumber(impactPending)} impact · ${formatNumber(briefingPending)} briefs</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderPendingBriefings(rows) {
  if (!rows.length) return '<p class="ok">No hay briefings pendientes.</p>';
  return `<table class="table">
    <thead><tr><th>Categoría</th><th>Prioridad</th><th>Pendientes</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.category)}</td>
        <td><span class="impact-badge ${escapeHtml(String(row.impact_level).toLowerCase())}">${escapeHtml(row.impact_level)}</span></td>
        <td>${formatNumber(row.briefing_pending)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderMattermostStatus(rows) {
  if (!rows.length) return '<p>No Mattermost notifications tracked yet.</p>';
  return `<table class="table">
    <thead><tr><th>Categoría</th><th>Canal</th><th>Estado</th><th>Posts</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.category)}</td>
        <td>${escapeHtml(row.channel || 'default')}</td>
        <td>${escapeHtml(row.status)}${Number(row.non_200 || 0) ? ` · ${formatNumber(row.non_200)} non-200` : ''}</td>
        <td>${formatNumber(row.notifications)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderMattermostConfiguredCategories(rows) {
  if (!rows.length) return 'sin categorías configuradas';
  return rows
    .map((row) => `${row.category}${row.channel ? ` -> ${row.channel}` : ''}`)
    .join(', ');
}

function renderLlmStatus(rows) {
  if (!rows.length) return '<p>No hay requests LLM registrados en las últimas 24h.</p>';
  return `<table class="table">
    <thead><tr><th>Operación</th><th>Proveedor</th><th>P</th><th>OK/Fails</th><th>Tokens</th><th>USD</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.operation)}</td>
        <td>${escapeHtml(row.provider)}</td>
        <td>${escapeHtml(row.impact_level)}</td>
        <td>${formatNumber(row.ok)} / ${formatNumber(row.failed)}</td>
        <td>${formatNumber(row.total_tokens)}</td>
        <td>$${formatDecimal(row.cost_usd || 0)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderBriefingThroughput(rows) {
  if (!rows.length) return '<p>No hay briefings generados en las últimas 24h.</p>';
  return `<table class="table">
    <thead><tr><th>Categoría</th><th>P</th><th>1h</th><th>24h</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.category)}</td>
        <td><span class="impact-badge ${escapeHtml(String(row.impact_level).toLowerCase())}">${escapeHtml(row.impact_level)}</span></td>
        <td>${formatNumber(row.generated_1h)}</td>
        <td>${formatNumber(row.generated_24h)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderBriefingClaims(rows) {
  if (!rows.length) return '<p class="ok">No hay claims activos de briefings.</p>';
  return `<table class="table">
    <thead><tr><th>Tipo</th><th>Claims</th><th>Stale</th><th>Más viejo</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.briefing_type)}</td>
        <td>${formatNumber(row.claims)}</td>
        <td class="${Number(row.stale_claims || 0) ? 'warn' : 'ok'}">${formatNumber(row.stale_claims)}</td>
        <td>${escapeHtml(formatUtc(row.oldest_locked_at))}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderNewsSwipeSummary(rows) {
  const totals = rows.reduce((acc, row) => {
    const action = row.action || 'unknown';
    const level = row.impact_level || '-';
    acc[action] = acc[action] || { total: 0, levels: {} };
    acc[action].total += Number(row.total || 0);
    acc[action].levels[level] = (acc[action].levels[level] || 0) + Number(row.total || 0);
    return acc;
  }, {});

  const labels = [
    ['interested', 'Me gustaron'],
    ['dismissed', 'No me gustaron'],
  ];

  return `<div class="status-list">
    ${labels.map(([action, label]) => {
      const item = totals[action] || { total: 0, levels: {} };
      const levels = ['P0', 'P1', 'P2', 'P3']
        .map((level) => `${level}: ${formatNumber(item.levels[level] || 0)}`)
        .join(' · ');
      return `<div class="status-row">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(levels)}</span>
        </div>
        <div class="${action === 'interested' ? 'ok' : 'warn'}">${formatNumber(item.total)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function firstSwipeLink(row) {
  const links = Array.isArray(row.links) ? row.links : [];
  return links.find((link) => link?.url) || null;
}

function renderRecentNewsSwipes(rows) {
  if (!rows.length) return '<p>No hay swipes registrados todavía.</p>';
  return `<div class="status-list">
    ${rows.map((row) => {
      const link = firstSwipeLink(row);
      const title = row.title || link?.title || 'Sin título';
      const titleHtml = link?.url
        ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      return `<div class="status-row">
        <div>
          <strong>${titleHtml}</strong>
          <span>${escapeHtml(row.action)} · ${escapeHtml(row.impact_level || '-')} · ${escapeHtml(row.category_slug || '-')} · ${escapeHtml(formatUtc(row.swiped_at))}</span>
        </div>
        <div>${link?.source ? escapeHtml(link.source) : formatNumber(Array.isArray(row.links) ? row.links.length : 0) + ' links'}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderTopFeeds(rows) {
  return `<table class="table">
    <thead><tr><th>Feed</th><th>País</th><th>24h</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td><div class="ranked-name">${escapeHtml(row.name)}</div><div class="source">${escapeHtml(hostFromUrl(row.url) || row.url)}</div></td>
        <td>${escapeHtml(row.country)}</td>
        <td>${formatNumber(row.ingested_articles_24h)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

export async function renderDashboardPage({ renderLayout }) {
  const [clusters, categories, metrics] = await Promise.all([
    buildClusterStats(),
    buildCategoryStats(),
    buildDashboardMetrics(),
  ]);
  const articleMetrics = metrics.articles;
  const feedMetrics = metrics.feeds;
  const backlog = metrics.backlogTotals;
  const pendingCategories = metrics.backlog.filter((row) => (
    Number(row.impact_pending || 0) > 0 || Number(row.briefing_pending || 0) > 0
  ));

  const body = `
    <div class="dashboard-hero">
      <section>
        <h1>SignalRSS operations.</h1>
        <p class="lede">Estado calculado al cargar esta página. Refrescá el navegador para obtener una nueva foto de la base; no hay polling desde la UI.</p>
        <div class="toolbar">
          <a class="pill" href="/">Refresh</a>
          <a class="pill" href="/impact">Impact</a>
          <a class="pill" href="/cloud-infrastructure/p0">Cloud P0</a>
          <a class="pill" href="/p0">AI P0</a>
        </div>
      </section>
      <section class="card status-panel">
        <div class="label">Última lectura</div>
        <div class="metric">${escapeHtml(formatUtc(metrics.refreshedAt))}</div>
        <p>${formatNumber(feedMetrics.successful_feeds_24h)} de ${formatNumber(feedMetrics.enabled_feeds)} feeds respondieron en las últimas 24h.</p>
      </section>
    </div>
    <div class="grid">
      ${metricCard('Noticias ingresadas 24h', formatNumber(articleMetrics.articles_ingested_24h), `${formatDecimal(feedMetrics.avg_articles_ingested_per_hour)} por hora promedio`)}
      ${metricCard('Noticias publicadas 24h', formatNumber(articleMetrics.articles_published_24h), 'Según published_at de cada fuente')}
      ${metricCard('Feeds con novedades 24h', formatNumber(feedMetrics.feeds_with_new_articles_24h), `${formatNumber(feedMetrics.enabled_feeds)} feeds habilitados`)}
      ${metricCard('Briefings pendientes', formatNumber(backlog.briefingPending), `${formatNumber(backlog.impactPending)} impactos pendientes`)}
      ${metricCard('Artículos 7 días', formatNumber(articleMetrics.articles_ingested_7d), `${formatNumber(articleMetrics.articles_published_7d)} publicados en ventana`)}
      ${metricCard('Clusters 7 días', formatNumber(clusters.clusters_last_7_days), `${formatNumber(clusters.clustered_article_links)} links clusterizados`)}
      ${metricCard('Categorías completas', `${formatNumber(backlog.completedCategories)}/${formatNumber(metrics.backlog.length)}`, 'Sin impacto ni briefings pendientes')}
      ${metricCard('Mattermost P0 publicados', formatNumber(metrics.mattermost.reduce((total, row) => total + Number(row.notifications || 0), 0)), 'Canales integrados sin polling')}
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Entrada por país, últimas 24h</h2>
        <p>Artículos únicos vistos por primera vez, agrupados por país del feed.</p>
        ${renderCountryBars(metrics.countries)}
      </section>
      <section class="card">
        <h2>Ritmo horario</h2>
        <p>${formatNumber(articleMetrics.articles_ingested_24h)} artículos ingresados en las últimas 24h.</p>
        ${renderHourlyChart(metrics.hourly)}
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Pendientes por categoría</h2>
        <p>${pendingCategories.length ? 'Categorías con trabajo pendiente en impacto o briefings.' : 'Todas las categorías están completas.'}</p>
        ${renderBacklogStatus(metrics.backlog)}
      </section>
      <section class="card">
        <h2>Briefings pendientes</h2>
        ${renderPendingBriefings(metrics.briefingPending)}
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Feeds con más volumen 24h</h2>
        ${renderTopFeeds(metrics.topFeeds)}
      </section>
      <section class="card">
        <h2>Mattermost P0</h2>
        <p>Publicaciones registradas para las categorías integradas: ${escapeHtml(renderMattermostConfiguredCategories(metrics.mattermostCategories))}.</p>
        ${renderMattermostStatus(metrics.mattermost)}
        <div class="toolbar">
          <a class="pill" href="/classification/stats">Classification stats</a>
          <a class="pill" href="/clusters/stats">Cluster stats</a>
          <a class="pill" href="/impact/stats">Impact stats</a>
          <a class="pill" href="/api/clusters?limit=20">Cluster JSON</a>
        </div>
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>LLM 24h</h2>
        <p>Requests, fallos, tokens y coste registrados por proveedor.</p>
        ${renderLlmStatus(metrics.llm)}
      </section>
      <section class="card">
        <h2>Briefings generados</h2>
        <p>Throughput reciente por categoría y prioridad.</p>
        ${renderBriefingThroughput(metrics.briefingThroughput)}
      </section>
    </div>
    <section class="section card">
      <h2>Claims de briefings</h2>
      <p>Locks activos para detectar procesos colgados o reinicios incompletos.</p>
      ${renderBriefingClaims(metrics.briefingClaims)}
    </section>
    <div class="dashboard-grid">
      <section class="card">
        <h2>News triage</h2>
        <p>Resumen de lo que marcaste en /news.</p>
        ${renderNewsSwipeSummary(metrics.newsSwipes.summary)}
      </section>
      <section class="card">
        <h2>Últimas decisiones /news</h2>
        ${renderRecentNewsSwipes(metrics.newsSwipes.recent)}
      </section>
    </div>
    <section class="section card">
      <h2>Distribución por categoría</h2>
      <div class="toolbar">
        ${categories.map((category) => `<a class="pill" href="/clusters?category=${escapeHtml(category.slug)}">${escapeHtml(category.name)} · ${formatNumber(category.articles)}</a>`).join('')}
      </div>
    </section>`;

  return renderLayout({ title: 'Dashboard', body });
}
