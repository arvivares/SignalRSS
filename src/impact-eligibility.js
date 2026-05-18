export function impactWindowHoursExpression(alias = 'tc', {
  windowDefaultParam = 2,
  windowMapParam = 3,
} = {}) {
  return `COALESCE(NULLIF($${windowMapParam}::jsonb ->> ${alias}.slug, '')::int, $${windowDefaultParam}::int)`;
}

export function impactMaxClusterAgeExpression(alias = 'tc', {
  maxAgeMapParam = 4,
  maxAgeDefaultParam = 5,
} = {}) {
  return `COALESCE(NULLIF($${maxAgeMapParam}::jsonb ->> ${alias}.slug, '')::int, $${maxAgeDefaultParam}::int)`;
}

export function impactEligibilitySql(params = {}) {
  const windowHours = impactWindowHoursExpression('tc', params);
  const maxAgeHours = impactMaxClusterAgeExpression('tc', params);
  return `
    AND sc.latest_published_at >= NOW() - (${windowHours} * INTERVAL '1 hour')
    AND (${maxAgeHours} <= 0 OR sc.created_at >= NOW() - (${maxAgeHours} * INTERVAL '1 hour'))
    AND sc.latest_published_at <= NOW()
    AND EXISTS (
      SELECT 1
      FROM cluster_articles ca
      WHERE ca.cluster_id = sc.id
    )
  `;
}
