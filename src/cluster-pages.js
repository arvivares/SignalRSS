import { buildClusterDetail, buildClusters, buildImpactClusters } from './cluster-service.js';
import { buildCategoryStats, buildImpactStats } from './stats-service.js';
import { escapeHtml, formatNumber, formatUtc, hostFromUrl } from './view-utils.js';

function renderClusterCard(cluster) {
  const articles = (cluster.articles || []).slice(0, 5);
  const impact = cluster.impact_level
    ? `<span class="impact-badge ${escapeHtml(cluster.impact_level.toLowerCase())}">${escapeHtml(cluster.impact_level)} · ${cluster.impact_score}/100 · ${escapeHtml(cluster.impact_category)}</span>`
    : '';
  return `<article class="card cluster">
    <div>
      <a class="cluster-title" href="/clusters/${escapeHtml(cluster.id)}"><h3>${escapeHtml(cluster.title)}</h3></a>
      <div class="meta">
        ${impact}
        <span>${escapeHtml(cluster.category_name || 'Uncategorized')}</span>
        <span>${cluster.article_count} articles</span>
        <span>${cluster.source_count} sources</span>
        <span>${formatUtc(cluster.latest_published_at)}</span>
      </div>
      <ul class="articles">
        ${articles.map((article) => `<li><a href="${escapeHtml(article.url || '#')}">${escapeHtml(article.title)}</a><div class="source">${escapeHtml(article.source || hostFromUrl(article.url) || 'source')} · similarity ${Number(article.similarity || 0).toFixed(3)}</div></li>`).join('')}
      </ul>
      ${cluster.why_it_matters ? `<p><strong>Why it matters:</strong> ${escapeHtml(cluster.why_it_matters)}</p>` : ''}
    </div>
    <div class="score">
      <strong>${Number(cluster.avg_similarity || 0).toFixed(3)}</strong>
      <span class="label">avg similarity</span>
      <p>min ${Number(cluster.min_similarity || 0).toFixed(3)}</p>
    </div>
  </article>`;
}

function renderImpactCard(cluster) {
  const reasons = Array.isArray(cluster.impact_reasons) ? cluster.impact_reasons : [];
  return `<article class="card cluster">
    <div>
      <a class="cluster-title" href="/clusters/${escapeHtml(cluster.id)}"><h3>${escapeHtml(cluster.title)}</h3></a>
      <div class="meta">
        <span class="impact-badge ${escapeHtml(cluster.impact_level.toLowerCase())}">${escapeHtml(cluster.impact_level)} · ${cluster.impact_score}/100 · ${escapeHtml(cluster.impact_category)}</span>
        <span>${cluster.article_count} articles</span>
        <span>${cluster.source_count} sources</span>
        <span>${formatUtc(cluster.latest_published_at)}</span>
      </div>
      <p>${escapeHtml(cluster.impact_summary || '')}</p>
      <p><strong>Why it matters:</strong> ${escapeHtml(cluster.why_it_matters || '')}</p>
      ${reasons.length ? `<ul class="impact-reasons">${reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="score">
      <strong>${cluster.impact_score}</strong>
      <span class="label">impact score</span>
      <p>${escapeHtml(cluster.impact_level)} priority</p>
    </div>
  </article>`;
}

function priorityFilterCard({ category, hours, currentLevel, level, count, label }) {
  const isAll = level === null;
  const href = isAll
    ? `/impact?category=${escapeHtml(category)}&hours=${hours}`
    : `/impact?category=${escapeHtml(category)}&level=${level}&hours=${hours}`;
  const active = (isAll && !currentLevel) || currentLevel === level;
  const levelClass = isAll ? 'all' : level.toLowerCase();

  return `<a class="priority-filter ${escapeHtml(levelClass)} ${active ? 'active' : ''}" href="${href}">
    <strong>${escapeHtml(isAll ? 'All' : level)} · ${escapeHtml(count)}</strong>
    <span>${escapeHtml(label)}</span>
  </a>`;
}

function metricCard(label, value, note = '') {
  return `<div class="card metric-card">
    <div>
      <div class="metric">${escapeHtml(value)}</div>
      <div class="label">${escapeHtml(label)}</div>
    </div>
    ${note ? `<p class="metric-note">${escapeHtml(note)}</p>` : ''}
  </div>`;
}

export async function renderClustersPage({ renderLayout, category = null, limit = 50 } = {}) {
  const [clusters, categories] = await Promise.all([
    buildClusters({ category, limit }),
    buildCategoryStats(),
  ]);

  const body = `
    <h1>${category ? escapeHtml(category) : 'Story Clusters'}</h1>
    <p class="lede">Inspect grouped stories, source diversity, and semantic similarity. Use this page to judge grouping quality before adjusting thresholds.</p>
    <div class="toolbar">
      <a class="pill" href="/clusters">All</a>
      ${categories.map((item) => `<a class="pill" href="/clusters?category=${escapeHtml(item.slug)}">${escapeHtml(item.name)}</a>`).join('')}
    </div>
    ${clusters.length ? clusters.map(renderClusterCard).join('') : '<div class="card empty">No clusters found.</div>'}`;

  return renderLayout({ title: 'Clusters', body });
}

export async function renderImpactPage({
  renderLayout,
  category = 'artificial-intelligence',
  level = null,
  hours = 24,
  limit = 50,
} = {}) {
  const [clusters, stats] = await Promise.all([
    buildImpactClusters({ category, level, hours, limit }),
    buildImpactStats({ category, hours }),
  ]);
  const filters = [
    priorityFilterCard({
      category,
      hours,
      currentLevel: level,
      level: null,
      count: stats.scored_clusters,
      label: 'Todos los clusters con score, ordenados por prioridad e impacto.',
    }),
    priorityFilterCard({
      category,
      hours,
      currentLevel: level,
      level: 'P0',
      count: stats.p0,
      label: 'Must read. Cambios críticos o de alto impacto real.',
    }),
    priorityFilterCard({
      category,
      hours,
      currentLevel: level,
      level: 'P1',
      count: stats.p1,
      label: 'Importante. Monitorear hoy sin falta.',
    }),
    priorityFilterCard({
      category,
      hours,
      currentLevel: level,
      level: 'P2',
      count: stats.p2,
      label: 'Relevante, pero no urgente.',
    }),
    priorityFilterCard({
      category,
      hours,
      currentLevel: level,
      level: 'P3',
      count: stats.p3,
      label: 'Ruido, nicho o baja prioridad.',
    }),
  ].join('');

  const body = `
    <h1>Impact-ranked AI news.</h1>
    <p class="lede">Prioritized clusters for the last ${hours} hours. Read P0 first, then P1; P2/P3 stay searchable for context.</p>
    <section class="priority-filters" aria-label="Impact priority filters">
      ${filters}
    </section>
    <p class="filter-note">${level ? `Showing only ${escapeHtml(level)} clusters.` : 'Showing all priority levels.'} ${stats.pending_clusters ? `${stats.pending_clusters} clusters are still pending scoring.` : 'All visible clusters are scored.'}</p>
    <div class="toolbar">
      <a class="pill" href="/api/impact?category=${escapeHtml(category)}&hours=${hours}&limit=50">JSON</a>
      <a class="pill" href="/impact/stats?category=${escapeHtml(category)}&hours=${hours}">Stats</a>
    </div>
    ${clusters.length ? clusters.map(renderImpactCard).join('') : '<div class="card empty">No impact scores found yet. Run the impact scorer job.</div>'}`;

  return renderLayout({ title: 'Impact', body });
}

export async function renderClusterDetailPage({ renderLayout, id }) {
  const cluster = await buildClusterDetail(id);
  if (!cluster) {
    return renderLayout({ title: 'Cluster not found', body: '<div class="card empty">Cluster not found.</div>' });
  }

  const body = `
    <p><a href="/clusters">← Back to clusters</a></p>
    <h1>${escapeHtml(cluster.title)}</h1>
    <p class="lede">${escapeHtml(cluster.summary || '')}</p>
    <div class="grid">
      ${metricCard('Category', cluster.category_name || 'Uncategorized')}
      ${metricCard('Articles', cluster.article_count)}
      ${metricCard('Sources', cluster.source_count)}
      ${metricCard('Avg similarity', Number(cluster.avg_similarity || 0).toFixed(3))}
      ${cluster.impact_level ? metricCard('Impact', `${cluster.impact_level} ${cluster.impact_score}`) : ''}
    </div>
    ${cluster.impact_level ? `<section class="section card">
      <h2>Impact Assessment</h2>
      <p><span class="impact-badge ${escapeHtml(cluster.impact_level.toLowerCase())}">${escapeHtml(cluster.impact_level)} · ${cluster.impact_score}/100 · ${escapeHtml(cluster.impact_category)}</span></p>
      <p>${escapeHtml(cluster.impact_summary || '')}</p>
      <p><strong>Why it matters:</strong> ${escapeHtml(cluster.why_it_matters || '')}</p>
      ${Array.isArray(cluster.impact_reasons) && cluster.impact_reasons.length ? `<ul class="impact-reasons">${cluster.impact_reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
    </section>` : ''}
    <section class="section card">
      <h2>Related Articles</h2>
      <ul class="articles">
        ${(cluster.articles || []).map((article) => `<li><a href="${escapeHtml(article.url || '#')}">${escapeHtml(article.title)}</a><div class="source">${escapeHtml(article.source || hostFromUrl(article.url) || 'source')} · ${formatUtc(article.published_at)} · similarity ${Number(article.similarity || 0).toFixed(3)} · ${escapeHtml(article.role)}</div><p>${escapeHtml(article.summary || '')}</p></li>`).join('')}
      </ul>
    </section>`;

  return renderLayout({ title: cluster.title, body });
}
