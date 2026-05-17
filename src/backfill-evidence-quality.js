import { closeDb, pool } from './db.js';
import { capImpactForEvidence } from './evidence-quality.js';
import { cleanText } from './text-utils.js';

function levelForScore(score) {
  if (score >= 85) return 'P0';
  if (score >= 65) return 'P1';
  if (score >= 40) return 'P2';
  return 'P3';
}

async function loadScoredClusters() {
  const { rows } = await pool.query(`
    SELECT
      sc.id,
      sc.title,
      sc.summary,
      sc.article_count,
      sc.latest_published_at,
      tc.slug AS category_slug,
      cis.impact_level,
      cis.impact_score,
      cis.impact_category,
      cis.summary AS impact_summary,
      cis.why_it_matters,
      cis.impact_reasons,
      count(DISTINCT a.source_host)::int AS source_count,
      json_agg(
        json_build_object(
          'title', a.title,
          'url', a.canonical_url,
          'published_at', a.published_at,
          'summary', a.summary,
          'content', a.content,
          'source', a.source_host
        )
        ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST
      ) AS articles
    FROM story_clusters sc
    JOIN topic_categories tc ON tc.id = sc.category_id
    JOIN cluster_impact_scores cis ON cis.cluster_id = sc.id
    JOIN cluster_articles ca ON ca.cluster_id = sc.id
    JOIN articles a ON a.id = ca.article_id
    GROUP BY sc.id, tc.slug, cis.cluster_id
    ORDER BY sc.latest_published_at DESC NULLS LAST
  `);
  return rows;
}

async function main() {
  const applyCaps = process.env.BACKFILL_EVIDENCE_APPLY_CAPS === 'true';
  const clusters = await loadScoredClusters();
  let updated = 0;
  let capped = 0;
  let briefingsDeleted = 0;

  for (const cluster of clusters) {
    const calibrated = capImpactForEvidence(cluster, {
      impactScore: cluster.impact_score,
      impactCategory: cluster.impact_category,
      summary: cluster.impact_summary,
      whyItMatters: cluster.why_it_matters,
      reasons: Array.isArray(cluster.impact_reasons) ? cluster.impact_reasons : [],
    });
    const impactScore = applyCaps
      ? Math.max(0, Math.min(100, Math.round(Number(calibrated.impactScore || 0))))
      : Number(cluster.impact_score);
    const impactLevel = levelForScore(impactScore);
    const changedImpact = applyCaps && (
      impactScore !== Number(cluster.impact_score) || impactLevel !== cluster.impact_level
    );

    const { rowCount } = await pool.query(`
      UPDATE cluster_impact_scores
      SET impact_level = $2,
          impact_score = $3,
          impact_category = CASE WHEN $11::boolean THEN $4 ELSE impact_category END,
          summary = CASE WHEN $11::boolean THEN $5 ELSE summary END,
          why_it_matters = CASE WHEN $11::boolean THEN $6 ELSE why_it_matters END,
          impact_reasons = CASE WHEN $11::boolean THEN $7::jsonb ELSE impact_reasons END,
          evidence_confidence = $8,
          evidence_quality_score = $9,
          evidence_reasons = $10::jsonb,
          updated_at = NOW()
      WHERE cluster_id = $1
    `, [
      cluster.id,
      impactLevel,
      impactScore,
      calibrated.impactCategory,
      cleanText(calibrated.summary).slice(0, 700),
      cleanText(calibrated.whyItMatters).slice(0, 900),
      JSON.stringify(calibrated.reasons),
      calibrated.evidenceConfidence,
      calibrated.evidenceQualityScore,
      JSON.stringify(calibrated.evidenceReasons),
      applyCaps,
    ]);
    updated += rowCount;

    if (changedImpact) {
      capped += 1;
      const deleted = await pool.query('DELETE FROM cluster_briefings WHERE cluster_id = $1', [cluster.id]);
      briefingsDeleted += deleted.rowCount;
      if (capped <= 25) {
        console.log(
          `Evidence capped cluster=${cluster.id} category=${cluster.category_slug} ` +
          `${cluster.impact_level}${cluster.impact_score}->${impactLevel}${impactScore} ` +
          `confidence=${calibrated.evidenceConfidence} title=${cleanText(cluster.title).slice(0, 120)}`,
        );
      }
    }
  }

  console.log(`Evidence quality backfill updated=${updated} capped=${capped} briefings_deleted=${briefingsDeleted} apply_caps=${applyCaps}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await closeDb().catch(() => {});
});
