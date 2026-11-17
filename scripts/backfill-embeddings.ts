/**
 * v6.1 P0 回填：为旧记忆补齐 embedding / normalized_hash / valid_from。
 *
 * 用法：
 *   node scripts/backfill-embeddings.ts
 *   MNEMOS_DB_PATH=/path/to/mnemos.db node scripts/backfill-embeddings.ts
 *   node scripts/backfill-embeddings.ts --db data-v6/mnemos.db --dry-run
 *
 * 幂等：只处理 normalized_hash 或 embedding 缺失、或 embedding_model 不是本地模型的行。
 */
import { openDatabase, migrate } from '../server/src/db/index.ts';
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embedText,
  embeddingToBlob,
} from '../server/src/engine/embed.ts';
import { loadEnv } from '../server/src/env.ts';
import { memoryContentHash } from '../server/src/lib/text.ts';

interface Args {
  dbPath?: string;
  dryRun: boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): Args {
  let dbPath: string | undefined;
  let dryRun = false;
  let batchSize = 500;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') dbPath = argv[++index];
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--batch') batchSize = Math.max(1, Math.min(5_000, Number(argv[++index]) || 500));
  }
  return { dbPath, dryRun, batchSize };
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
const dbPath = args.dbPath ?? env.dbPath;
const db = openDatabase(dbPath);
migrate(db);

let processed = 0;
let updated = 0;
try {
  for (;;) {
    const rows = db
      .prepare(
        `SELECT id, content FROM memories
          WHERE normalized_hash IS NULL OR embedding IS NULL
             OR embedding_model IS NULL OR embedding_model != ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?`,
      )
      .all(EMBEDDING_MODEL, args.batchSize) as unknown as { id: string; content: string }[];
    if (rows.length === 0) break;
    processed += rows.length;
    if (!args.dryRun) db.exec('BEGIN');
    try {
      const statement = db.prepare(
        `UPDATE memories
            SET normalized_hash = COALESCE(normalized_hash, ?),
                embedding = ?,
                embedding_model = ?,
                dim = ?,
                valid_from = COALESCE(valid_from, created_at)
          WHERE id = ?`,
      );
      for (const row of rows) {
        const vector = embedText(row.content);
        if (!args.dryRun) {
          statement.run(
            memoryContentHash(row.content),
            embeddingToBlob(vector),
            EMBEDDING_MODEL,
            EMBEDDING_DIM,
            row.id,
          );
        }
        updated += 1;
      }
      if (!args.dryRun) db.exec('COMMIT');
    } catch (error) {
      if (!args.dryRun) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
      }
      throw error;
    }
    if (args.dryRun) break;
  }
  console.log(
    `[backfill] db=${dbPath} processed=${processed} updated=${updated} dryRun=${args.dryRun} model=${EMBEDDING_MODEL}`,
  );
} finally {
  db.close();
}
