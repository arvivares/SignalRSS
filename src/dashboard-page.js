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
  const excludedBriefingPending = Number(ops.queues?.briefing?.excludedPending || 0);
  const activeCooldowns = Number(ops.providers?.activeCooldowns?.length || 0);
  const inactiveCooldowns = Number(ops.providers?.inactiveHistoricalCooldowns?.length || 0);
  const mattermostFailed = (ops.mattermost || [])
    .filter((row) => row.status === 'failed')
    .reduce((total, row) => total + Number(row.notifications || 0), 0);
  const status = ops.status || 'unknown';
  const statusLabel = status === 'ok' ? 'Nominal' : status === 'warning' ? 'Requiere atención' : 'Degradado';
  const title = status === 'ok'
    ? 'Todo nominal.'
    : status === 'warning'
      ? 'Hay trabajo pendiente.'
      : 'Hay fallas que requieren intervención.';

  return `<section class="ops-hero card">
    <div class="ops-hero-main">
      <div class="ops-eyebrow">
        <span class="live-dot ${escapeHtml(severityClass(status))}"></span>
        <span>Estado operativo</span>
      </div>
      <h1>${escapeHtml(title)}</h1>
      <p class="lede">Vista ejecutiva del pipeline: qué está entrando, qué falta procesar y qué puede bloquear publicaciones.</p>
      <div class="toolbar">
        <a class="pill primary" href="/">Actualizar</a>
        <a class="pill" href="/api/ops/health">Ops JSON</a>
      </div>
    </div>
    <div class="ops-scorecard">
      <div class="ops-status ${escapeHtml(severityClass(status))}">${escapeHtml(statusLabel)}</div>
      <div class="ops-kpis">
        <div><strong>${formatNumber(impactPending)}</strong><span>impact pendientes</span></div>
        <div><strong>${formatNumber(impactRunning)}</strong><span>impact corriendo</span></div>
        <div><strong>${formatNumber(briefingPending)}</strong><span>briefs pendientes</span></div>
        <div><strong>${formatNumber(activeCooldowns)}</strong><span>cooldowns activos</span></div>
      </div>
      <p>${formatNumber(metrics.feeds.successful_feeds_24h)} de ${formatNumber(metrics.feeds.enabled_feeds)} feeds respondieron en 24h. ${mattermostFailed ? `${formatNumber(mattermostFailed)} publicaciones Mattermost fallidas recientes.` : 'Mattermost sin fallos recientes críticos.'}${excludedBriefingPending ? ` ${formatNumber(excludedBriefingPending)} briefs omitidos por regla no cuentan como backlog.` : ''}${inactiveCooldowns ? ` ${formatNumber(inactiveCooldowns)} cooldowns históricos quedan fuera del circuito activo.` : ''}</p>
    </div>
  </section>`;
}

function buildRecommendedAction({ ops, metrics }) {
  const failedMattermost = (ops.mattermost || [])
    .filter((row) => row.status === 'failed')
    .reduce((total, row) => total + Number(row.notifications || 0), 0);
  const staleClaims = (ops.queues?.briefing?.claims || [])
    .reduce((total, row) => total + Number(row.stale_claims || 0), 0);
  const topBacklog = [...(metrics.backlog || [])]
    .map((row) => {
      const impactPending = Number(row.impact_pending || 0);
      const impactFailed = Number(row.impact_failed || 0);
      const briefingPending = Number(row.briefing_pending || 0);
      const score = impactPending + briefingPending + (impactFailed * 4);
      return { ...row, impactPending, impactFailed, briefingPending, score };
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)[0];

  if (staleClaims > 0) {
    return {
      tone: 'danger',
      label: 'Acción sugerida',
      title: 'Liberar claims de briefings',
      body: `${formatNumber(staleClaims)} locks parecen viejos. Conviene revisar workers antes de escalar más capacidad.`,
    };
  }

  if (topBacklog?.impactFailed > 0) {
    return {
      tone: 'danger',
      label: 'Acción sugerida',
      title: `Revisar impact en ${topBacklog.category}`,
      body: `${formatNumber(topBacklog.impactFailed)} jobs fallidos y ${formatNumber(topBacklog.impactPending)} pendientes/corriendo.`,
    };
  }

  if (failedMattermost > 0) {
    return {
      tone: 'warn',
      label: 'Acción sugerida',
      title: 'Reintentar Mattermost',
      body: `${formatNumber(failedMattermost)} publicaciones fallidas en las últimas 24h. Revisar DNS/webhook antes de reintentar.`,
    };
  }

  if (topBacklog) {
    return {
      tone: 'warn',
      label: 'Acción sugerida',
      title: `Drenar ${topBacklog.category}`,
      body: `${formatNumber(topBacklog.impactPending)} impact y ${formatNumber(topBacklog.briefingPending)} briefings pendientes/corriendo.`,
    };
  }

  return {
    tone: 'ok',
    label: 'Acción sugerida',
    title: 'No intervenir',
    body: 'El pipeline no muestra backlog operativo ni bloqueos relevantes en esta foto.',
  };
}

function renderRecommendedAction({ ops, metrics }) {
  const action = buildRecommendedAction({ ops, metrics });
  return `<section class="card action-card ${escapeHtml(action.tone)}">
    <div class="section-head">
      <div>
        <div class="label">${escapeHtml(action.label)}</div>
        <h2>${escapeHtml(action.title)}</h2>
      </div>
    </div>
    <p>${escapeHtml(action.body)}</p>
  </section>`;
}

function renderBacklogSpotlight(rows = []) {
  const pending = rows
    .filter((row) => (
      Number(row.impact_pending || 0) > 0
      || Number(row.briefing_pending || 0) > 0
      || Number(row.impact_failed || 0) > 0
    ))
    .sort((left, right) => (
      (Number(right.impact_pending || 0) + Number(right.briefing_pending || 0) + (Number(right.impact_failed || 0) * 4))
      - (Number(left.impact_pending || 0) + Number(left.briefing_pending || 0) + (Number(left.impact_failed || 0) * 4))
    ))
    .slice(0, 5);

  if (!pending.length) {
    return `<div class="spotlight-empty">
      <strong>Sin backlog activo</strong>
      <span>Todas las categorías están al día.</span>
    </div>`;
  }

  const max = Math.max(...pending.map((row) => (
    Number(row.impact_pending || 0)
    + Number(row.briefing_pending || 0)
    + (Number(row.impact_failed || 0) * 4)
  )), 1);
  return `<div class="spotlight-list">
    ${pending.map((row) => {
      const impact = Number(row.impact_pending || 0);
      const running = Number(row.impact_running || 0);
      const failed = Number(row.impact_failed || 0);
      const briefing = Number(row.briefing_pending || 0);
      const total = impact + briefing + (failed * 4);
      const details = [
        `${formatNumber(row.clusters)} clusters`,
        `${formatNumber(impact)} impact`,
        running ? `${formatNumber(running)} corriendo` : '',
        failed ? `${formatNumber(failed)} fallidos` : '',
        `${formatNumber(briefing)} briefs`,
      ].filter(Boolean).join(' · ');
      const pendingWindow = row.oldest_pending_latest_published_at
        ? `Publicadas: ${formatUtc(row.oldest_pending_latest_published_at)} a ${formatUtc(row.newest_pending_latest_published_at)}`
        : '';
      return `<div class="spotlight-row">
        <div>
          <strong>${escapeHtml(row.category)}</strong>
          <span>${escapeHtml(details)}</span>
          ${pendingWindow ? `<span>${escapeHtml(pendingWindow)}</span>` : ''}
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
      const tone = !row.enabled ? 'muted' : failed > ok ? 'danger' : failed > 0 ? 'warn' : 'ok';
      return `<div class="provider-chip ${tone}">
        <strong>${escapeHtml(row.provider)}</strong>
        <span>${escapeHtml(row.operation.replace('_', ' '))}${row.enabled ? '' : ' · fuera del circuito'}</span>
        <em>${formatNumber(ok)} ok / ${formatNumber(failed)} fail</em>
      </div>`;
    }).join('')}
  </div>`;
}

export function mattermostFailureRows(rows = []) {
  return rows.filter((row) => row.status === 'failed');
}

function renderMattermostPulse(rows = []) {
  const failed = mattermostFailureRows(rows);
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

function renderWorkerActivity(rows = []) {
  if (!rows.length) return '<p>No hay actividad reciente registrada.</p>';
  return `<div class="status-list compact">
    ${rows.slice(0, 10).map((row) => {
      const status = String(row.status || '').toLowerCase();
      const tone = status.includes('fail') || status.includes('error')
        ? 'danger'
        : status.includes('running') || status.includes('pending')
          ? 'warn'
          : 'ok';
      return `<div class="status-row">
        <div>
          <strong>${escapeHtml(row.component)} · ${escapeHtml(row.category || '-')}</strong>
          <span>${escapeHtml(formatUtc(row.last_activity_at))}${row.detail ? ` · ${escapeHtml(row.detail)}` : ''}</span>
        </div>
        <div class="${tone}">${escapeHtml(row.status || '-')}</div>
      </div>`;
    }).join('')}
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
      const impactRunning = Number(row.impact_running || 0);
      const impactFailed = Number(row.impact_failed || 0);
      const staleRunning = Number(row.impact_running_stale || row.running_stale || 0);
      const briefingPending = Number(row.briefing_pending || 0);
      const excludedBriefingPending = Number(row.excluded_briefing_pending || 0);
      const done = impactPending === 0 && impactFailed === 0 && briefingPending === 0;
      const state = staleRunning > 0 ? 'trabada' : impactFailed > 0 ? 'fallida' : done ? 'terminada' : 'pendiente';
      const detail = [
        `${formatNumber(impactPending)} impact`,
        impactRunning ? `${formatNumber(impactRunning)} corriendo` : '',
        staleRunning ? `${formatNumber(staleRunning)} stale` : '',
        impactFailed ? `${formatNumber(impactFailed)} fallidos` : '',
        `${formatNumber(briefingPending)} briefs`,
        excludedBriefingPending ? `${formatNumber(excludedBriefingPending)} omitidos por regla` : '',
      ].filter(Boolean).join(' · ');
      const pendingWindow = row.oldest_pending_latest_published_at
        ? ` · Publicadas: ${formatUtc(row.oldest_pending_latest_published_at)} a ${formatUtc(row.newest_pending_latest_published_at)}`
        : '';
      return `<div class="status-row">
        <div>
          <strong>${escapeHtml(row.category)}</strong>
          <span>${formatNumber(row.clusters)} clusters · ${escapeHtml(state)}${pendingWindow ? escapeHtml(pendingWindow) : ''}</span>
        </div>
        <div class="${impactFailed || staleRunning ? 'danger' : done ? 'ok' : 'warn'}">${escapeHtml(detail)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderDatabaseHealth(database = {}) {
  const rows = database.tables || [];
  if (!rows.length) return '<p>No hay métricas de base disponibles.</p>';
  return `<div class="status-list compact">
    ${rows.slice(0, 8).map((row) => {
      const deadPct = Number(row.dead_row_pct || 0);
      const tone = deadPct > 20 ? 'danger' : deadPct > 10 ? 'warn' : 'ok';
      return `<div class="status-row">
        <div>
          <strong>${escapeHtml(row.table_name)}</strong>
          <span>${formatNumber(row.live_rows)} vivas · ${formatNumber(row.dead_rows)} dead</span>
        </div>
        <div class="${tone}">${formatDecimal(deadPct, 1)}%</div>
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

function renderExcludedBriefings(excluded = {}) {
  const rows = excluded.byCategory || [];
  const total = Number(excluded.total || 0);
  if (!total) return '';
  return `<p class="muted">${formatNumber(total)} briefings están omitidos por configuración y no se consideran pendientes.</p>
  <table class="table">
    <thead><tr><th>Categoría</th><th>Prioridad</th><th>Omitidos</th></tr></thead>
    <tbody>
      ${rows.map((row) => `<tr>
        <td>${escapeHtml(row.category)}</td>
        <td><span class="impact-badge ${escapeHtml(String(row.impact_level).toLowerCase())}">${escapeHtml(row.impact_level)}</span></td>
        <td>${formatNumber(row.briefing_pending || row.pending)}</td>
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
    Number(row.impact_pending || 0) > 0
    || Number(row.briefing_pending || 0) > 0
    || Number(row.impact_failed || 0) > 0
  ));

  const body = `
    ${renderOpsSummary({ ops, metrics })}
    <div class="command-grid">
      ${renderRecommendedAction({ ops, metrics })}
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
    </div>
    <div class="grid">
      ${metricCard('Noticias ingresadas 24h', formatNumber(articleMetrics.articles_ingested_24h), `${formatDecimal(feedMetrics.avg_articles_ingested_per_hour)} por hora promedio`, 'fresh')}
      ${metricCard('Noticias publicadas 24h', formatNumber(articleMetrics.articles_published_24h), 'Según published_at de cada fuente')}
      ${metricCard('Feeds con novedades 24h', formatNumber(feedMetrics.feeds_with_new_articles_24h), `${formatNumber(feedMetrics.enabled_feeds)} feeds habilitados`)}
      ${metricCard('Briefings pendientes', formatNumber(backlog.briefingPending), `${formatNumber(backlog.impactPending)} impact pendientes/corriendo${backlog.impactFailed ? ` · ${formatNumber(backlog.impactFailed)} fallidos` : ''}${metrics.excludedBriefingPending?.total ? ` · ${formatNumber(metrics.excludedBriefingPending.total)} briefs omitidos` : ''}`, backlog.briefingPending || backlog.impactPending || backlog.impactFailed ? 'warn' : 'fresh')}
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
        <p>${pendingCategories.length ? 'Foto directa de jobs de impacto y briefings pendientes. Incluye jobs corriendo y fallidos.' : 'Todas las categorías están completas.'}</p>
        ${renderBacklogStatus(metrics.backlog)}
      </section>
      <section class="card">
        <h2>Actividad de workers</h2>
        <p>Última actividad persistida por componente y categoría. Se actualiza al refrescar.</p>
        ${renderWorkerActivity(metrics.workerActivity)}
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Mattermost P0</h2>
        <p>Publicaciones registradas para categorías integradas: ${escapeHtml(renderMattermostConfiguredCategories(metrics.mattermostCategories))}.</p>
        ${renderMattermostPulse(ops.mattermost)}
        ${renderMattermostStatus(metrics.mattermost)}
      </section>
      <section class="card">
        <h2>Briefings pendientes</h2>
        ${renderPendingBriefings(metrics.briefingPending)}
        ${renderExcludedBriefings(metrics.excludedBriefingPending)}
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Briefings generados</h2>
        <p>Throughput reciente por categoría y prioridad.</p>
        ${renderBriefingThroughput(metrics.briefingThroughput)}
      </section>
      <section class="card">
        <h2>Salud de base</h2>
        <p>Tablas con más filas muertas. Sirve para decidir cuándo correr mantenimiento.</p>
        ${renderDatabaseHealth(ops.database)}
      </section>
    </div>
    <div class="dashboard-grid">
      <section class="card">
        <h2>Feeds con más volumen 24h</h2>
        ${renderTopFeeds(metrics.topFeeds)}
      </section>
      <section class="card">
        <h2>Accesos operativos</h2>
        <p>Detalles técnicos para investigar cuando la home marque una acción concreta.</p>
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
        <h2>Claims de briefings</h2>
        <p>Locks activos para detectar procesos colgados o reinicios incompletos.</p>
        ${renderBriefingClaims(metrics.briefingClaims)}
      </section>
    </div>
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
