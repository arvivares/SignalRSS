import { cleanText } from './text-utils.js';

const METADATA_ONLY_PATTERNS = [
  /^article url:/i,
  /^comments url:/i,
  /^points:/i,
  /^# comments:/i,
  /^score:/i,
  /^source:/i,
  /^submitted by:/i,
  /^discussion:/i,
];

const SUBSTANTIVE_WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu;

const UNSUPPORTED_STRONG_CLAIMS = [
  {
    label: 'shutdown/removal',
    generated: [
      'clausurad',
      'cerrad',
      'cierre',
      'eliminad',
      'retirad',
      'retirado de la red',
      'shutdown',
      'shut down',
      'removed',
      'taken down',
      'terminated',
    ],
    evidence: [
      'clausurad',
      'cerrad',
      'cierre',
      'eliminad',
      'retirad',
      'shutdown',
      'shut down',
      'removed',
      'taken down',
      'terminated',
    ],
  },
  {
    label: 'breach/compromise',
    generated: [
      'hackead',
      'comprometid',
      'brecha',
      'filtracion',
      'filtración',
      'data leak',
      'breach',
      'hacked',
      'compromised',
    ],
    evidence: [
      'hackead',
      'comprometid',
      'brecha',
      'filtracion',
      'filtración',
      'data leak',
      'breach',
      'hacked',
      'compromised',
    ],
  },
  {
    label: 'ban/regulatory action',
    generated: [
      'prohibid',
      'bloquead',
      'sancionad',
      'multad',
      'demanda',
      'banned',
      'blocked',
      'sanctioned',
      'fined',
      'lawsuit',
    ],
    evidence: [
      'prohibid',
      'bloquead',
      'sancionad',
      'multad',
      'demanda',
      'banned',
      'blocked',
      'sanctioned',
      'fined',
      'lawsuit',
    ],
  },
  {
    label: 'global-scale assertion',
    generated: [
      'millones de usuarios',
      'impacto global',
      'global impact',
      'millions of users',
      'worldwide',
      'global outage',
    ],
    evidence: [
      'millones de usuarios',
      'impacto global',
      'global impact',
      'millions of users',
      'worldwide',
      'global outage',
    ],
  },
];

function metadataOnlyLine(line) {
  return METADATA_ONLY_PATTERNS.some((pattern) => pattern.test(line.trim()));
}

function substantiveWordCount(value = '') {
  return cleanText(value).match(SUBSTANTIVE_WORD_PATTERN)?.length || 0;
}

function usefulSummary(summary = '') {
  const lines = String(summary)
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  if (lines.length === 0) return false;
  const usefulLines = lines.filter((line) => !metadataOnlyLine(line));
  const usefulText = usefulLines.join(' ');
  return usefulText.length >= 80 || substantiveWordCount(usefulText) >= 12;
}

function metadataOnlySummary(summary = '') {
  const lines = String(summary)
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .filter(Boolean);
  return lines.length > 0 && lines.every(metadataOnlyLine);
}

export function evidenceTextForCluster(cluster = {}) {
  return [
    cluster.title,
    cluster.summary,
    cluster.impact_summary,
    cluster.why_it_matters,
    ...(cluster.articles || []).flatMap((article) => [
      article.title,
      article.summary,
      article.content,
    ]),
  ].map(cleanText).filter(Boolean).join(' ');
}

export function assessEvidenceQuality(cluster = {}) {
  const articles = Array.isArray(cluster.articles) ? cluster.articles : [];
  const articleCount = Number(cluster.article_count || articles.length || 0);
  const sourceCount = Number(cluster.source_count || new Set(articles.map((article) => article.source).filter(Boolean)).size || 0);
  const usefulSummaries = articles.filter((article) => usefulSummary(article.summary)).length;
  const metadataOnlySummaries = articles.filter((article) => metadataOnlySummary(article.summary)).length;
  const evidenceText = evidenceTextForCluster(cluster);
  const titleText = [
    cluster.title,
    ...(articles || []).map((article) => article.title),
  ].map(cleanText).filter(Boolean).join(' ');
  const evidenceWords = substantiveWordCount(evidenceText);
  const titleWords = substantiveWordCount(titleText);
  const titleChars = titleText.length;
  const metadataOnlyArticles = articles.filter((article) => article.summary && metadataOnlySummary(article.summary)).length;
  const reasons = [];

  let score = 0;
  score += Math.min(35, sourceCount * 14);
  score += Math.min(25, articleCount * 5);
  score += Math.min(30, usefulSummaries * 10);
  score += Math.min(20, Math.floor(titleChars / 40) * 4);
  score += Math.min(10, Math.floor(titleWords / 8) * 2);
  score += Math.min(10, Math.floor(evidenceWords / 60) * 2);

  if (sourceCount <= 1) reasons.push('single_source');
  if (articleCount <= 1) reasons.push('single_article');
  if (usefulSummaries === 0) reasons.push('no_substantive_summary');
  if (metadataOnlyArticles > 0) reasons.push('metadata_only_summary');
  if (evidenceWords < 35) reasons.push('thin_evidence_text');

  if (sourceCount <= 1 && metadataOnlySummaries > 0 && usefulSummaries === 0) score = Math.min(score, 20);
  if (sourceCount <= 1 && articleCount <= 1 && evidenceWords < 35 && titleWords < 8) score = Math.min(score, 30);

  const evidenceQualityScore = Math.max(0, Math.min(100, Math.round(score)));
  let evidenceConfidence = 'medium';
  if (evidenceQualityScore < 40) evidenceConfidence = 'low';
  else if (evidenceQualityScore >= 70) evidenceConfidence = 'high';

  return {
    evidenceConfidence,
    evidenceQualityScore,
    evidenceReasons: reasons,
  };
}

export function capImpactForEvidence(cluster = {}, score = {}) {
  const quality = assessEvidenceQuality(cluster);
  let impactScore = Number(score.impactScore ?? score.impact_score ?? 0);
  let impactCategory = score.impactCategory ?? score.impact_category ?? 'noise';
  let summary = cleanText(score.summary);
  let whyItMatters = cleanText(score.whyItMatters ?? score.why_it_matters);
  let reasons = Array.isArray(score.reasons || score.impact_reasons)
    ? [...(score.reasons || score.impact_reasons)]
    : [];

  if (quality.evidenceConfidence === 'low') {
    impactScore = Math.min(impactScore, 39);
    impactCategory = impactCategory === 'noise' ? impactCategory : 'noise';
    summary = cleanText(cluster.title).slice(0, 300);
    whyItMatters = 'Evidencia insuficiente para confirmar impacto ejecutivo amplio; requiere mas fuentes o contenido sustantivo.';
    reasons = [
      ...reasons,
      'Low evidence confidence.',
      ...quality.evidenceReasons.map((reason) => `Evidence quality: ${reason}.`),
    ];
  }

  return {
    ...quality,
    impactScore,
    impactCategory,
    summary,
    whyItMatters,
    reasons: [...new Set(reasons.map(cleanText).filter(Boolean))].slice(0, 8),
  };
}

export function unsupportedStrongClaims(generatedText = '', evidenceText = '') {
  const generated = cleanText(generatedText).toLowerCase();
  const evidence = cleanText(evidenceText).toLowerCase();
  if (!generated) return [];

  return UNSUPPORTED_STRONG_CLAIMS
    .filter((claim) => (
      claim.generated.some((term) => generated.includes(term))
      && !claim.evidence.some((term) => evidence.includes(term))
    ))
    .map((claim) => claim.label);
}

export function safeBriefingFallback(cluster = {}, unsupportedClaims = []) {
  const title = cleanText(cluster.title || 'Noticia con evidencia limitada').slice(0, 300);
  const sourceCount = Number(cluster.source_count || 0);
  const articleCount = Number(cluster.article_count || 0);
  const claimText = unsupportedClaims.length
    ? ` La generacion anterior incluia afirmaciones no confirmadas sobre ${unsupportedClaims.join(', ')}.`
    : '';
  return {
    title,
    summary: cleanText(
      `La evidencia disponible para este cluster es limitada: ${articleCount} articulo(s) de ${sourceCount} fuente(s). ` +
      `No se deben inferir hechos no confirmados a partir del titulo. Revisar los links originales antes de tomar decisiones ejecutivas.${claimText}`,
    ).slice(0, 1800),
  };
}
