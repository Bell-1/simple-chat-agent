/** 文本分块：优先按标题、空行、句号切分，控制单块长度并保留少量重叠。 */

const DEFAULT_MAX_CHARS = 800;
const DEFAULT_OVERLAP = 120;

function maxChars(): number {
  const value = Number(process.env.RAG_CHUNK_CHARS || DEFAULT_MAX_CHARS);
  return Number.isFinite(value) && value >= 200 ? value : DEFAULT_MAX_CHARS;
}

/** 在句末标点处切开超长段落，尽量不破坏语义。 */
function splitLongParagraph(paragraph: string, limit: number): string[] {
  if (paragraph.length <= limit) return [paragraph];

  const sentences = paragraph.split(/(?<=[。！？!?；;])/);
  const result: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (!sentence) continue;
    if (current.length + sentence.length <= limit) {
      current += sentence;
      continue;
    }
    if (current) result.push(current);
    if (sentence.length <= limit) {
      current = sentence;
      continue;
    }
    // 单句仍超长时按固定长度硬切
    for (let i = 0; i < sentence.length; i += limit) {
      result.push(sentence.slice(i, i + limit));
    }
    current = "";
  }
  if (current) result.push(current);
  return result;
}

/** 把长文本切成带重叠的块，空文本直接返回空数组。 */
export function chunkText(
  text: string,
  options: { maxChars?: number; overlap?: number } = {},
): string[] {
  const limit = options.maxChars ?? maxChars();
  const overlap = Math.min(options.overlap ?? DEFAULT_OVERLAP, Math.floor(limit / 3));

  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];

  const paragraphs = normalized.split(/\n{2,}/);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    pieces.push(...splitLongParagraph(trimmed, limit));
  }

  const chunks: string[] = [];
  let buffer = "";

  const flush = () => {
    const content = buffer.trim();
    if (content) chunks.push(content);
    buffer = content.length > overlap ? content.slice(-overlap) : content;
  };

  for (const piece of pieces) {
    if (!buffer) {
      buffer = piece;
      continue;
    }
    if (buffer.length + piece.length + 2 <= limit) {
      buffer = `${buffer}\n\n${piece}`;
      continue;
    }
    flush();
    buffer = buffer ? `${buffer}\n\n${piece}` : piece;
  }
  if (buffer.trim()) chunks.push(buffer.trim());

  return chunks;
}
