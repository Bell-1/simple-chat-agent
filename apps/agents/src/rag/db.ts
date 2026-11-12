import { Pool } from "pg";

/**
 * RAG 向量库连接。
 *
 * 使用 Postgres + pgvector：附件分块与向量同库存放，
 * 检索时可以直接按 user_id 过滤，避免跨用户召回。
 */

let pool: Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function embeddingDim(): number {
  const value = Number(process.env.EMBEDDING_DIM || 1024);
  return Number.isFinite(value) && value > 0 ? value : 1024;
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("未配置 DATABASE_URL，无法使用资料检索");
    }
    pool = new Pool({ connectionString, max: 5 });
  }
  return pool;
}

/** 建表与索引；重复调用安全。 */
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const dim = embeddingDim();
      const client = await getPool().connect();
      try {
        await client.query("CREATE EXTENSION IF NOT EXISTS vector");
        await client.query(`
          CREATE TABLE IF NOT EXISTS doc_chunks (
            id            text PRIMARY KEY,
            user_id       text NOT NULL,
            attachment_id text NOT NULL,
            source_name   text NOT NULL,
            kind          text NOT NULL,
            chunk_index   int  NOT NULL,
            content       text NOT NULL,
            embedding     vector(${dim}) NOT NULL,
            created_at    timestamptz DEFAULT now(),
            UNIQUE (attachment_id, chunk_index)
          )
        `);
        await client.query(
          "CREATE INDEX IF NOT EXISTS doc_chunks_user_idx ON doc_chunks (user_id, attachment_id)",
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS doc_chunks_embedding_idx ON doc_chunks USING hnsw (embedding vector_cosine_ops)",
        );
      } finally {
        client.release();
      }
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

/** 测试或脚本退出时释放连接。 */
export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
  schemaReady = null;
}
