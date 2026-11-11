import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export interface DocumentParseResult {
  text: string;
  pages?: number;
}

/** MIME → 解析方式。未命中的文本类按 UTF-8 直读。 */
const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
]);

export async function parseDocument(
  buffer: Buffer,
  mime: string,
): Promise<DocumentParseResult> {
  if (mime === "application/pdf") {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return { text: normalize(result.text), pages: result.pages.length };
    } finally {
      await parser.destroy();
    }
  }

  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return { text: normalize(result.value) };
  }

  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  ) {
    return parseSpreadsheet(buffer);
  }

  if (TEXT_MIMES.has(mime)) {
    return { text: normalize(buffer.toString("utf8")) };
  }

  throw new Error(`暂不支持解析该类型：${mime}`);
}

/** 每个工作表输出成「表名 + 制表符分隔的行」，保留结构但压掉多余空白。 */
async function parseSpreadsheet(
  buffer: Buffer,
): Promise<DocumentParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);

  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`## ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells = (row.values as (string | number | null)[])
        .slice(1)
        .map((value) => (value == null ? "" : String(value).trim()));
      if (cells.some(Boolean)) parts.push(cells.join("\t"));
    });
    parts.push("");
  });

  return { text: parts.join("\n").trim(), pages: workbook.worksheets.length };
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
