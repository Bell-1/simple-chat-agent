import type { AttachmentRecord } from "../uploads/types.js";
import { chunkText } from "./chunk.js";
import { ensureSchema, getPool } from "./db.js";
import { embedTexts, toVectorLiteral } from "./embedding.js";

/**
 * 附件入库：解析文本 → 分块 → 向量化 → 写入 doc_chunks。
 * 同一附件重复解析时先清空旧块，保证幂等。
 */
export async function indexAttachment(
  record: AttachmentRecord,
  text: string,
): Promise<number> {
  if (!record.userId) {
    console.warn(`[rag] 跳过无归属用户的附件：${record.id}`);
    return 0;
  }
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;

  await ensureSchema();
  const vectors = await embedTexts(chunks);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM doc_chunks WHERE attachment_id = $1", [
      record.id,
    ]);
    for (let index = 0; index < chunks.length; index++) {
      await client.query(
        `INSERT INTO doc_chunks
           (id, user_id, attachment_id, source_name, kind, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
         ON CONFLICT (attachment_id, chunk_index)
         DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
        [
          `${record.id}:${index}`,
          record.userId,
          record.id,
          record.name,
          record.kind,
          index,
          chunks[index],
          toVectorLiteral(vectors[index]),
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return chunks.length;
}

/** 删除附件时同步清理向量，避免残留可被检索到。 */
export async function removeAttachmentIndex(
  attachmentId: string,
): Promise<void> {
  try {
    await ensureSchema();
    await getPool().query("DELETE FROM doc_chunks WHERE attachment_id = $1", [
      attachmentId,
    ]);
  } catch (error) {
    console.warn("[rag] 删除附件索引失败", error);
  }
}
