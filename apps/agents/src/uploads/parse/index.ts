import type { AttachmentRecord } from "../types.js";
import { parseAudio, parseVideo } from "./audio.js";
import { parseDocument } from "./document.js";

export interface ParseResult {
  text: string;
  pages?: number;
}

/** 按附件类型分发解析；图片不经过这里。 */
export async function parseAttachment(
  record: AttachmentRecord,
  buffer: Buffer,
): Promise<ParseResult> {
  switch (record.kind) {
    case "document": {
      const result = await parseDocument(buffer, record.mime);
      return { text: result.text, pages: result.pages };
    }
    case "audio":
      return {
        text: await parseAudio(buffer, record.name, record.mime),
      };
    case "video":
      return {
        text: await parseVideo(buffer, record.name),
      };
    default:
      throw new Error(`该类型无需解析：${record.kind}`);
  }
}
