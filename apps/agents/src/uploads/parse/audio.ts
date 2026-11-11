import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 转写所用的模型，需与网关的 /audio/transcriptions 兼容（默认 whisper-1）。 */
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-1";

/** 调用网关的语音转写接口，返回纯文本。 */
async function transcribe(
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const baseURL =
    process.env.OPENAI_BASE_URL ||
    process.env.OPENAI_API_BASE ||
    "https://api.openai.com/v1";
  if (!apiKey) throw new Error("缺少 OPENAI_API_KEY，无法转写音视频");

  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer as unknown as BlobPart], { type: mime }),
    filename,
  );
  form.append("model", TRANSCRIBE_MODEL);

  const response = await fetch(
    `${baseURL.replace(/\/$/, "")}/audio/transcriptions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`转写失败（${response.status}）：${detail}`);
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text?.trim()) throw new Error("转写结果为空");
  return data.text.trim();
}

export async function parseAudio(
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<string> {
  return transcribe(buffer, filename, mime);
}

/**
 * 视频先抽音轨再转写。
 * ffmpeg 不随项目安装，缺失时给出明确提示，避免静默失败。
 */
export async function parseVideo(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "chat-video-"));
  const input = join(dir, "input");
  const output = join(dir, "audio.mp3");

  try {
    await writeFile(input, buffer);
    await runFfmpeg([
      "-y",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "mp3",
      output,
    ]);
    const audio = await readFile(output);
    return await transcribe(audio, `${filename}.mp3`, "audio/mpeg");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runFfmpeg(args: string[]): Promise<void> {
  const binary = process.env.FFMPEG_PATH || "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", () => {
      reject(
        new Error(
          "视频解析需要 ffmpeg，请安装后在 FFMPEG_PATH 中指定可执行文件路径",
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg 执行失败（退出码 ${code}）：${stderr}`));
    });
  });
}
