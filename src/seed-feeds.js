import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDb } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const feedsPath = path.resolve(__dirname, '..', 'data', 'feeds.csv');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      cell += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') index += 1;
      row.push(cell);
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function recordsFromCsv(text) {
  const [headers, ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

async function main() {
  const csv = await fs.readFile(feedsPath, 'utf8');
  const feeds = recordsFromCsv(csv);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const feed of feeds) {
      await client.query(
        `INSERT INTO feeds (
           name, url, country, timezone_gmt, validation_status, frequency_status, enabled, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
         ON CONFLICT (url) DO UPDATE SET
           name = EXCLUDED.name,
           country = EXCLUDED.country,
           timezone_gmt = EXCLUDED.timezone_gmt,
           validation_status = EXCLUDED.validation_status,
           frequency_status = EXCLUDED.frequency_status,
           updated_at = NOW()`,
        [
          feed.name,
          feed.url,
          feed.country,
          feed.timezone_gmt,
          feed.validation_status,
          feed.frequency_status,
        ],
      );
    }

    const feedUrls = feeds.map((feed) => feed.url);
    const deleteResult = await client.query(
      'DELETE FROM feeds WHERE NOT (url = ANY($1::text[]))',
      [feedUrls],
    );

    await client.query('COMMIT');
    console.log(`Seeded ${feeds.length} feeds; removed ${deleteResult.rowCount} missing feeds`);
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
