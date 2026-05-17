import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { pool, closeDb } from './db.js';

const PRIORITY_ADJUDICATION_TABLES = [
  'p0_cluster_merge_adjudications',
  'p1_cluster_merge_adjudications',
  'p2_cluster_merge_adjudications',
  'p3_cluster_merge_adjudications',
];

function parseEmbedding(value) {
  return Array.isArray(value) ? value : JSON.parse(value);
}

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function dotProduct(left, right) {
  let total = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) total += left[index] * right[index];
  return total;
}

function vectorLiteral(vector) {
  return `[${vector.join(',')}]`;
}

function compareArticleStats(left, right) {
  return (
    Number(right.feed_entries || 0) - Number(left.feed_entries || 0)
    || Number(right.clustered || 0) - Number(left.clustered || 0)
    || Number(right.classifications || 0) - Number(left.classifications || 0)
    || Number(right.has_embedding || 0) - Number(left.has_embedding || 0)
    || new Date(left.first_seen_at).getTime() - new Date(right.first_seen_at).getTime()
    || String(left.id).localeCompare(String(right.id))
  );
}

class UnionFind {
  constructor() {
    this.parent = new Map();
  }

  add(id) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id) {
    this.add(id);
    const parent = this.parent.get(id);
    if (parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left, right) {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

async function loadDuplicateArticles(client) {
  const { rows } = await client.query(`
    WITH dup_urls AS (
      SELECT canonical_url
      FROM articles
      WHERE canonical_url IS NOT NULL
        AND canonical_url <> ''
      GROUP BY canonical_url
      HAVING count(*) > 1
    ),
    dup_guids AS (
      SELECT guid
      FROM articles
      WHERE guid IS NOT NULL
        AND guid <> ''
      GROUP BY guid
      HAVING count(*) > 1
    )
    SELECT
      a.id,
      a.title,
      a.canonical_url,
      a.guid,
      a.first_seen_at,
      coalesce(fe.feed_entries, 0)::int AS feed_entries,
      coalesce(ac.classifications, 0)::int AS classifications,
      (ae.article_id IS NOT NULL)::int AS has_embedding,
      (ca.article_id IS NOT NULL)::int AS clustered,
      ca.cluster_id
    FROM articles a
    LEFT JOIN dup_urls du ON du.canonical_url = a.canonical_url
    LEFT JOIN dup_guids dg ON dg.guid = a.guid
    LEFT JOIN LATERAL (
      SELECT count(*) AS feed_entries
      FROM feed_entries
      WHERE article_id = a.id
    ) fe ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS classifications
      FROM article_classifications
      WHERE article_id = a.id
    ) ac ON TRUE
    LEFT JOIN article_embeddings ae ON ae.article_id = a.id
    LEFT JOIN cluster_articles ca ON ca.article_id = a.id
    WHERE du.canonical_url IS NOT NULL
       OR dg.guid IS NOT NULL
    ORDER BY a.first_seen_at ASC, a.id ASC
  `);

  const unionFind = new UnionFind();
  const byUrl = new Map();
  const byGuid = new Map();

  for (const row of rows) {
    unionFind.add(row.id);
    if (row.canonical_url) {
      if (byUrl.has(row.canonical_url)) unionFind.union(row.id, byUrl.get(row.canonical_url));
      byUrl.set(row.canonical_url, row.id);
    }
    if (row.guid) {
      if (byGuid.has(row.guid)) unionFind.union(row.id, byGuid.get(row.guid));
      byGuid.set(row.guid, row.id);
    }
  }

  const groups = new Map();
  for (const row of rows) {
    const root = unionFind.find(row.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(row);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const sorted = [...group].sort(compareArticleStats);
      return {
        keeper: sorted[0],
        duplicates: sorted.slice(1),
        articles: sorted,
      };
    });
}

async function invalidateClusterArtifacts(client, clusterIds) {
  const uniqueClusterIds = [...new Set(clusterIds.filter(Boolean))];
  if (uniqueClusterIds.length === 0) return {
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };

  const counts = {
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };

  for (const tableName of PRIORITY_ADJUDICATION_TABLES) {
    const result = await client.query(
      `DELETE FROM ${tableName}
       WHERE left_cluster_id = ANY($1::uuid[])
          OR right_cluster_id = ANY($1::uuid[])
          OR target_cluster_id = ANY($1::uuid[])
          OR source_cluster_id = ANY($1::uuid[])`,
      [uniqueClusterIds],
    );
    counts.priorityAdjudications += result.rowCount;
  }

  const crossCategory = await client.query(
    `DELETE FROM cross_category_cluster_adjudications
     WHERE left_cluster_id = ANY($1::uuid[])
        OR right_cluster_id = ANY($1::uuid[])
        OR target_cluster_id = ANY($1::uuid[])
        OR source_cluster_id = ANY($1::uuid[])`,
    [uniqueClusterIds],
  );
  counts.crossCategoryAdjudications = crossCategory.rowCount;

  counts.briefings = (await client.query(
    'DELETE FROM cluster_briefings WHERE cluster_id = ANY($1::uuid[])',
    [uniqueClusterIds],
  )).rowCount;
  counts.impactScores = (await client.query(
    'DELETE FROM cluster_impact_scores WHERE cluster_id = ANY($1::uuid[])',
    [uniqueClusterIds],
  )).rowCount;
  counts.impactJobs = (await client.query(
    'DELETE FROM cluster_impact_jobs WHERE cluster_id = ANY($1::uuid[])',
    [uniqueClusterIds],
  )).rowCount;

  return counts;
}

async function mergeDuplicateArticle(client, keeper, duplicate) {
  await client.query(
    `DELETE FROM feed_entries duplicate_entry
     WHERE duplicate_entry.article_id = $2
       AND EXISTS (
         SELECT 1
         FROM feed_entries keeper_entry
         WHERE keeper_entry.feed_id = duplicate_entry.feed_id
           AND keeper_entry.article_id = $1
       )`,
    [keeper.id, duplicate.id],
  );
  const feedEntries = (await client.query(
    'UPDATE feed_entries SET article_id = $1 WHERE article_id = $2',
    [keeper.id, duplicate.id],
  )).rowCount;

  await client.query(
    `DELETE FROM article_classifications duplicate_classification
     WHERE duplicate_classification.article_id = $2
       AND EXISTS (
         SELECT 1
         FROM article_classifications keeper_classification
         WHERE keeper_classification.article_id = $1
           AND (
             (
               keeper_classification.category_id = duplicate_classification.category_id
               AND keeper_classification.model = duplicate_classification.model
             )
             OR (
               keeper_classification.model = duplicate_classification.model
               AND keeper_classification.rank = duplicate_classification.rank
             )
           )
       )`,
    [keeper.id, duplicate.id],
  );
  const classifications = (await client.query(
    'UPDATE article_classifications SET article_id = $1 WHERE article_id = $2',
    [keeper.id, duplicate.id],
  )).rowCount;

  await client.query(
    `DELETE FROM article_embeddings duplicate_embedding
     WHERE duplicate_embedding.article_id = $2
       AND EXISTS (
         SELECT 1
         FROM article_embeddings keeper_embedding
         WHERE keeper_embedding.article_id = $1
       )`,
    [keeper.id, duplicate.id],
  );
  const embeddings = (await client.query(
    'UPDATE article_embeddings SET article_id = $1 WHERE article_id = $2',
    [keeper.id, duplicate.id],
  )).rowCount;

  const { rows: keeperClusterRows } = await client.query(
    'SELECT cluster_id FROM cluster_articles WHERE article_id = $1',
    [keeper.id],
  );
  const keeperClusterId = keeperClusterRows[0]?.cluster_id;
  const { rows: duplicateClusterRows } = await client.query(
    'SELECT cluster_id FROM cluster_articles WHERE article_id = $1',
    [duplicate.id],
  );
  const duplicateClusterId = duplicateClusterRows[0]?.cluster_id;
  let clusterArticles = 0;

  if (duplicateClusterId && keeperClusterId) {
    clusterArticles = (await client.query(
      'DELETE FROM cluster_articles WHERE article_id = $1',
      [duplicate.id],
    )).rowCount;
  } else if (duplicateClusterId) {
    clusterArticles = (await client.query(
      'UPDATE cluster_articles SET article_id = $1 WHERE article_id = $2',
      [keeper.id, duplicate.id],
    )).rowCount;
  }

  await client.query(
    'UPDATE story_clusters SET representative_article_id = NULL WHERE representative_article_id = $1',
    [duplicate.id],
  );
  const articles = (await client.query(
    'DELETE FROM articles WHERE id = $1',
    [duplicate.id],
  )).rowCount;

  return {
    feedEntries,
    classifications,
    embeddings,
    clusterArticles,
    articles,
  };
}

async function recalculateCluster(client, clusterId) {
  const { rows } = await client.query(
    `SELECT
       ca.article_id,
       ca.role,
       a.title,
       a.summary,
       a.published_at,
       a.first_seen_at,
       ae.embedding
     FROM cluster_articles ca
     JOIN articles a ON a.id = ca.article_id
     JOIN article_embeddings ae
       ON ae.article_id = a.id
      AND ae.embedding_model = $2
     WHERE ca.cluster_id = $1
     ORDER BY ca.role = 'representative' DESC, a.published_at DESC NULLS LAST, a.first_seen_at DESC`,
    [clusterId, config.embeddingModel],
  );

  if (rows.length === 0) {
    await client.query('DELETE FROM story_clusters WHERE id = $1', [clusterId]);
    return { deleted: true };
  }

  const normalizedEmbeddings = rows.map((row) => normalize(parseEmbedding(row.embedding)));
  const centroid = normalize(normalizedEmbeddings[0].map((_, index) => (
    normalizedEmbeddings.reduce((total, embedding) => total + embedding[index], 0) / normalizedEmbeddings.length
  )));
  const representative = rows[0];
  const publishedDates = rows
    .map((row) => row.published_at || row.first_seen_at)
    .filter(Boolean)
    .map((value) => new Date(value));
  const firstPublishedAt = new Date(Math.min(...publishedDates.map((date) => date.getTime())));
  const latestPublishedAt = new Date(Math.max(...publishedDates.map((date) => date.getTime())));

  await client.query(
    `UPDATE story_clusters
     SET title = $2,
         summary = $3,
         representative_article_id = $4,
         centroid_embedding = $5::jsonb,
         centroid_embedding_vector = $6::vector,
         article_count = $7,
         first_published_at = $8,
         latest_published_at = $9,
         updated_at = NOW()
     WHERE id = $1`,
    [
      clusterId,
      representative.title,
      representative.summary,
      representative.article_id,
      JSON.stringify(centroid),
      vectorLiteral(centroid),
      rows.length,
      firstPublishedAt,
      latestPublishedAt,
    ],
  );

  await client.query(
    `UPDATE cluster_articles
     SET role = CASE WHEN cluster_articles.article_id = $2 THEN 'representative' ELSE 'member' END,
         similarity = similarity_updates.similarity
     FROM (
       SELECT unnest($3::uuid[]) AS article_id, unnest($4::numeric[]) AS similarity
     ) similarity_updates
     WHERE cluster_articles.cluster_id = $1
       AND cluster_articles.article_id = similarity_updates.article_id`,
    [
      clusterId,
      representative.article_id,
      rows.map((row) => row.article_id),
      normalizedEmbeddings.map((embedding) => Number(dotProduct(embedding, centroid).toFixed(6))),
    ],
  );

  return { deleted: false };
}

async function auditDuplicateCounts(client) {
  const { rows } = await client.query(`
    WITH checks AS (
      SELECT 'articles.canonical_url' AS check_name, count(*) AS duplicate_groups, coalesce(sum(n - 1), 0) AS extra_rows
      FROM (
        SELECT canonical_url, count(*) n
        FROM articles
        WHERE canonical_url IS NOT NULL
          AND canonical_url <> ''
        GROUP BY canonical_url
        HAVING count(*) > 1
      ) d
      UNION ALL
      SELECT 'articles.guid', count(*), coalesce(sum(n - 1), 0)
      FROM (
        SELECT guid, count(*) n
        FROM articles
        WHERE guid IS NOT NULL
          AND guid <> ''
        GROUP BY guid
        HAVING count(*) > 1
      ) d
    )
    SELECT *
    FROM checks
    WHERE duplicate_groups > 0 OR extra_rows > 0
    ORDER BY check_name
  `);
  return rows;
}

export async function deduplicateArticles({ closeConnections = true } = {}) {
  const client = await pool.connect();
  const counts = {
    groups: 0,
    duplicateArticles: 0,
    feedEntries: 0,
    classifications: 0,
    embeddings: 0,
    clusterArticles: 0,
    deletedArticles: 0,
    affectedClusters: 0,
    deletedClusters: 0,
    priorityAdjudications: 0,
    crossCategoryAdjudications: 0,
    briefings: 0,
    impactScores: 0,
    impactJobs: 0,
  };

  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX IF EXISTS idx_articles_canonical_url_unique');
    await client.query('DROP INDEX IF EXISTS idx_articles_guid_unique');

    const groups = await loadDuplicateArticles(client);
    counts.groups = groups.length;
    counts.duplicateArticles = groups.reduce((total, group) => total + group.duplicates.length, 0);
    const affectedClusterIds = new Set();

    for (const group of groups) {
      for (const article of group.articles) {
        if (article.cluster_id) affectedClusterIds.add(article.cluster_id);
      }
      for (const duplicate of group.duplicates) {
        const merged = await mergeDuplicateArticle(client, group.keeper, duplicate);
        counts.feedEntries += merged.feedEntries;
        counts.classifications += merged.classifications;
        counts.embeddings += merged.embeddings;
        counts.clusterArticles += merged.clusterArticles;
        counts.deletedArticles += merged.articles;
      }
    }

    counts.affectedClusters = affectedClusterIds.size;
    const invalidated = await invalidateClusterArtifacts(client, [...affectedClusterIds]);
    Object.assign(counts, {
      priorityAdjudications: invalidated.priorityAdjudications,
      crossCategoryAdjudications: invalidated.crossCategoryAdjudications,
      briefings: invalidated.briefings,
      impactScores: invalidated.impactScores,
      impactJobs: invalidated.impactJobs,
    });

    for (const clusterId of affectedClusterIds) {
      const result = await recalculateCluster(client, clusterId);
      if (result.deleted) counts.deletedClusters += 1;
    }

    await client.query(
      `CREATE UNIQUE INDEX idx_articles_canonical_url_unique
       ON articles (canonical_url)
       WHERE canonical_url IS NOT NULL
         AND canonical_url <> ''`,
    );
    await client.query(
      `CREATE UNIQUE INDEX idx_articles_guid_unique
       ON articles (guid)
       WHERE guid IS NOT NULL
         AND guid <> ''`,
    );

    const remainingDuplicates = await auditDuplicateCounts(client);
    if (remainingDuplicates.length > 0) {
      throw new Error(`Article duplicates remain: ${JSON.stringify(remainingDuplicates)}`);
    }

    await client.query('COMMIT');
    console.log(JSON.stringify(counts, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (closeConnections) await closeDb();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  deduplicateArticles().catch(async (error) => {
    console.error(error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
}
