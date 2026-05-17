import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const categoriesPath = path.resolve(__dirname, '..', 'data', 'topic-categories.json');

async function main() {
  const raw = await fs.readFile(categoriesPath, 'utf8');
  const categories = JSON.parse(raw);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const [index, category] of categories.entries()) {
      await client.query(
        `INSERT INTO topic_categories (slug, name, description, sort_order, active, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           sort_order = EXCLUDED.sort_order,
           active = TRUE,
           updated_at = NOW()`,
        [category.slug, category.name, category.description, index + 1],
      );
    }

    await client.query('COMMIT');
    console.log(`Seeded ${categories.length} topic categories`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
