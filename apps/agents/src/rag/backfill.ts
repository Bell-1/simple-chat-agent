import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import type { AttachmentRecord } from "../uploads/types.js";
import { getStorageDriver, parsedTextKey } from "../uploads/storage.js";
import { closePool } from "./db.js";
import { indexAttachment } from "./ingest.js";

/**
 * 历史附件回填：把 .data/uploads.json 里已解析完成、且带 user_id 的附件
 * 重新分块入库。可重复执行（同附件会先清空旧块）。
 *
 * 用法：pnpm --filter agents exec tsx src/rag/backfill.ts
 */
loadEnv({ path: resolve(process.cwd(), "../../.env") });
loadEnv();

const DATA_FILE = fileURLToPath(
  new URL("../../.data/uploads.json", import.meta.url),
);

async function main(): Promise<void> {
  let registry: Record<string, AttachmentRecord> = {};
  try {
    registry = JSON.parse(await readFile(DATA_FILE, "utf8")) as Record<
      string,
      AttachmentRecord
    >;
  } catch {
    console.log("没有历史附件记录，无需回填");
    return;
  }

  const driver = await getStorageDriver();
  const records = Object.values(registry).filter(
    (record) => record.status === "ready" && record.kind !== "image",
  );

  let indexed = 0;
  let skipped = 0;
  for (const record of records) {
    if (!record.userId || record.parse?.status !== "ready") {
      skipped += 1;
      continue;
    }
    try {
      const buffer = await driver.readObject(parsedTextKey(record.id));
      const chunks = await indexAttachment(record, buffer.toString("utf8"));
      indexed += 1;
      console.log(`✓ ${record.name}（${chunks} 块）`);
    } catch (error) {
      console.warn(
        `✗ ${record.name}：${error instanceof Error ? error.message : error}`,
      );
      skipped += 1;
    }
  }

  console.log(`回填完成：成功 ${indexed} 个，跳过 ${skipped} 个`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
