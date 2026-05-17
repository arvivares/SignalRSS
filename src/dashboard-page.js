import {
  buildCategoryStats,
  buildClusterStats,
  buildDashboardMetrics,
  buildOpsHealth,
} from './stats-service.js';
import { escapeHtml, formatDecimal, formatNumber, formatUtc, hostFromUrl } from './view-utils.js';

function metricCard(label, value, note = '', tone = '') {
  return `<div class="card metric-card ${tone ? `metric-card-${escapeHtml(tone)}` : ''}">
    <div>
      <div class="metric">${escapeHtml(value)}</div>
      <div class="label">${escapeHtml(label)}</div>
    </div>
    ${note ? `<p class="metric-note">${escapeHtml(note)}</p>` : ''}
  </div>`;
}

function severityClass(value) {
  if (value === 'ok') return 'ok';
  if (value === 'warning') return 'warn';
  return 'danger';
}

function renderOpsSummary({ ops, metrics }) {
  const impactPending = Number(ops.queues?.impact?.totals?.pending || 0);
  const impactRunning = Number(ops.queues?.impact?.totals?.running || 0);
  const briefingPending = Number(ops.queues?.briefing?.pending || 0);
  const activeCooldowns = Number(ops.providers?.activeCooldowns?.length || 0);
  const mattermostFailed = (ops.mattermost || [])
    .filter((row) => row.status === 'failed')
    .reduce((total, row) => total + Number(row.notifications || 0), 0);
  const status = ops.status || 'unknown';
  const statusLabel = status === 'ok' ? 'Nominal' : status === 'warning' ? 'Atención' : 'Degradado';

  return `<section class="ops-hero card">
    <div class="ops-hero-main">
      <div class="ops-eyebrow">
        <span class="live-dot ${escapeHtml(severityClass(status))}"></span>
        <span>Estado operativo</span>
      </div>
      <h1>SignalRSS está ${escapeHtml(statusLabel.toLowerCase())}.</h1>
      <p class="lede">Foto de la base al refrescar. Impact, briefings, proveedores y Mattermost quedan resumidos para decidir rápido dónde intervenir.</p>
      <div class="toolbar">
        <a class="pill primary" href="/">Refresh</a>
        <a class="pill" href="/api/ops/health">Ops JSON</a>
        <a class="pill" href="/news">News triage</a>
        <a class="pill" href="/impact">Impact</a>
      </div>
    </div>
    <div class="ops-scorecard">
      <div class="ops-status ${escapeHtml(severityClass(status))}">${escapeHtml(statusLabel)}</div>
      <div class="ops-kpis">
        <div><strong>${formatNumber(impactPending)}</strong><span>impact pendientes</span></div>
        <div><strong>${formatNumber(impactRunning)}</strong><span>impact corriendo</span></div>
        <div><strong>${formatNumber(briefingPending)}</strong><span>briefs pendientes</span></div>
        <div><strong>${formatNumber(activeCooldowns)}</strong><span>cooldowns LLM</span></div>
      </div>
      <p>${formatNumber(metrics.feeds.successful_feeds_24h)} de ${formatNumber(metrics.feeds.enabled_feeds)} feeds respondieron en 24h. ${mattermostFailed ? `${formatNumber(mattermostFailed)} publicaciones Mattermost fallidas recientes.` : 'Mattermost sin fallos recientes críticos.'}</p>
    </div>
  </section>`;
}

function renderBacklogSpotlight(rows = []) {
  const pending = rows
    .filter((row) => Number(row.impact_pending || 0) > 0 || Number(row.briefing_pending || 0) > 0)
    .sort((left, right) => (
      (Number(right.impact_pending || 0) + Number(right.briefing_pending || 0))
      - (Number(left.impact_pending || 0) + Number(left.briefing_pending || 0))
    ))
    .slice(0, 5);

  if (!pending.length) {
    return `<div class="spotlight-empty">
      <strong>Sin backlog activo</strong>
      <span>Todas las categorías están al día.</span>
    </div>`;
  }

  const max = Math.max(...pending.map((row) => Number(row.impact_pending || 0) + Number(row.briefing_pending || 0)), 1);
  return `<div class="spotlight-list">
    ${pending.map((row) => {
      const impact = Number(row.impact_pending || 0);
      const briefing = Number(row.briefing_pending || 0);
      const total = impact + briefing;
      return `<div class="spotlight-row">
        <div>
          <strong>${escapeHtml(row.category)}</strong>
          <span>${formatNumber(row.clusters)} clusters · ${formatNumber(impact)} impact · ${formatNumber(briefing)} briefs</span>
        </div>
        <div class="spotlight-meter" aria-label="${escapeHtml(row.category)} backlog">
          <span style="width:${Math.max(6, Math.round((total / max) * 100))}%"></span>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderProviderPulse(ops = {}) {
  const rows = (ops.providers?.lastHour || []).slice(0, 8);
  if (!rows.length) return '<p>No hay requests LLM en la última hora.</p>';

  return `<div class="provider-pulse">
    ${rows.map((row) => {
      const failed = Number(row.failed || 0);
      const ok = Number(row.ok || 0);
      const tone = failed > ok ? 'danger' : failed > 0 ? 'warn' : 'ok';
      return `<div class="provider-chip ${tone}">
        <strong>${escapeHtml(row.provider)}</strong>
        <span>${escapeHtml(row.operation.replace('_', ' '))}</span>
        <em>${formatNumber(ok)} ok / ${formatNumber(failed)} fail</em>
      </div>`;
    }).join('')}
  </div>`;
}

function renderMattermostPulse(rows = []) {
  const failed = rows.filter((row) => row.status === 'failed');
  if (!failed.length) return '<p class="ok">Sin fallos Mattermost recientes.</p>';
  return `<div class="status-list compact">
    ${failed.slice(0, 4).map((row) => `<div class="status-row">
      <div>
        <strong>${escapeHtml(row.error || 'Mattermost failed')}</strong>
        <span>${escapeHtml(formatUtc(row.last_updated_at))}</span>
      </div>
      <div class="danger">${formatNumber(row.notifications)}</div>
    </div>`).join('')}
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
  const [clusters, categories, metrics, ops] = await Promise.all([
    buildClusterStats(),
    buildCategoryStats(),
    buildDashboardMetrics(),
    buildOpsHealth(),
  ]);
  const articleMetrics = metrics.articles;
  const feedMetrics = metrics.feeds;
  const backlog = metrics.backlogTotals;
  const pendingCategories = metrics.backlog.filter((row) => (
    Number(row.impact_pending || 0) > 0 || Number(row.briefing_pending || 0) > 0
  ));

  const body = `
    ${renderOpsSummary({ ops, metrics })}
    <div class="command-grid">
      <section class="card command-card">
        <div class="section-head">
          <div>
            <div class="label">Prioridad ahora</div>
            <h2>Backlog activo</h2>
          </div>
          <a class="pill" href="/api/ops/health">Ver detalle</a>
        </div>
        ${renderBacklogSpotlight(metrics.backlog)}
      </section>
      <section class="card command-card">
        <div class="section-head">
          <div>
            <div class="label">Riesgo de proveedor</div>
            <h2>LLM última hora</h2>
          </div>
        </div>
        ${renderProviderPulse(ops)}
      </section>
      <section class="card command-card">
        <div class="section-head">
          <div>
            <div class="label">Publicación</div>
            <h2>Mattermost</h2>
          </div>
        </div>
        ${renderMattermostPulse(ops.mattermost)}
      </section>
    </div>
    <div class="grid">
      ${metricCard('Noticias ingresadas 24h', formatNumber(articleMetrics.articles_ingested_24h), `${formatDecimal(feedMetrics.avg_articles_ingested_per_hour)} por hora promedio`, 'fresh')}
      ${metricCard('Noticias publicadas 24h', formatNumber(articleMetrics.articles_published_24h), 'Según published_at de cada fuente')}
      ${metricCard('Feeds con novedades 24h', formatNumber(feedMetrics.feeds_with_new_articles_24h), `${formatNumber(feedMetrics.enabled_feeds)} feeds habilitados`)}
      ${metricCard('Briefings pendientes', formatNumber(backlog.briefingPending), `${formatNumber(backlog.impactPending)} impactos pendientes`, backlog.briefingPending || backlog.impactPending ? 'warn' : 'fresh')}
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
