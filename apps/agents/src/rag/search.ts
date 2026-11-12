import { ensureSchema, getPool } from "./db.js";
import { embedQuery, toVectorLiteral } from "./embedding.js";

export interface SearchHit {
  attachmentId: string;
  sourceName: string;
  kind: string;
  chunkIndex: number;
  content: string;
  score: number;
}

function topK(): number {
  const value = Number(process.env.RAG_TOP_K || 6);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 20) : 6;
}

function minScore(): number {
  const value = Number(process.env.RAG_MIN_SCORE || 0.3);
  return Number.isFinite(value) ? value : 0.3;
}

/** 按用户隔离的向量检索：只召回该用户自己的附件分块。 */
export async function searchChunks(input: {
  userId: string;
  query: string;
  limit?: number;
  minScore?: number;
}): Promise<SearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  await ensureSchema();
  const vector = await embedQuery(query);
  const result = await getPool().query<{
    attachment_id: string;
    source_name: string;
    kind: string;
    chunk_index: number;
    content: string;
    score: number;
  }>(
    `SELECT attachment_id, source_name, kind, chunk_index, content,
            1 - (embedding <=> $1::vector) AS score
       FROM doc_chunks
      WHERE user_id = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3`,
    [toVectorLiteral(vector), input.userId, input.limit ?? topK()],
  );

  const threshold = input.minScore ?? minScore();
  return result.rows
    .map((row) => ({
      attachmentId: row.attachment_id,
      sourceName: row.source_name,
      kind: row.kind,
      chunkIndex: row.chunk_index,
      content: row.content,
      score: Number(row.score),
    }))
    .filter((hit) => hit.score >= threshold);
}

/** 资料库概况，供前端展示索引状态。 */
export async function getLibraryStats(userId: string): Promise<{
  documents: number;
  chunks: number;
}> {
  await ensureSchema();
  const result = await getPool().query<{ documents: string; chunks: string }>(
    `SELECT COUNT(DISTINCT attachment_id) AS documents, COUNT(*) AS chunks
       FROM doc_chunks WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    documents: Number(row?.documents ?? 0),
    chunks: Number(row?.chunks ?? 0),
  };
}
