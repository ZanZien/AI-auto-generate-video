#!/usr/bin/env node
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { ZodError } from "zod";
import { runTemplatePipeline } from "../render/template-pipeline.js";
import { TemplateScriptSchema } from "../render/template-script-schema.js";
import { toSlug } from "../utils/slug.js";
import { log } from "../utils/logger.js";
import { buildScriptPrompt } from "./ai-script-generator.js";
import { generateScriptFromRawScript } from "./raw-script-generator.js";

config({ path: ".env.local" });

const PORT = Number(process.env.WEB_PORT || 3210);
const HOST = "127.0.0.1";
const MAX_PORT_ATTEMPTS = 10;
let activePort = PORT;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const publicDir = join(here, "public");
const outputRoot = join(repoRoot, "output");

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function contentType(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".srt":
    case ".vtt":
    case ".ass":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { ok: false, error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const buffer = await readRawBody(req, MAX_BODY_BYTES);
  if (buffer.length === 0) return {};
  return JSON.parse(buffer.toString("utf8"));
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(body: Record<string, unknown>, key: string, fallback = ""): string {
  const value = body[key];
  return typeof value === "string" ? value : fallback;
}

function readNumber(body: Record<string, unknown>, key: string, fallback: number): number {
  const value = body[key];
  return typeof value === "number" ? value : fallback;
}

function readCharacterVoices(body: Record<string, unknown>): Record<string, { voiceName?: string; refAudio?: string; refText?: string }> {
  const value = body.characterVoices;
  if (!isRecord(value)) return {};

  const voices: Record<string, { voiceName?: string; refAudio?: string; refText?: string }> = {};
  for (const [speaker, rawVoice] of Object.entries(value)) {
    if (!isRecord(rawVoice)) continue;
    voices[speaker] = {
      voiceName: readString(rawVoice, "voiceName"),
      refAudio: readString(rawVoice, "refAudio"),
      refText: readString(rawVoice, "refText"),
    };
  }
  return voices;
}

function slugFrom(value: string): string {
  return toSlug(value).replace(/[^a-z0-9-]/g, "").slice(0, 60) || "untitled";
}

function outputDirFor(slugValue: string): string {
  const slug = slugFrom(slugValue);
  const dir = resolve(outputRoot, slug);
  if (!dir.startsWith(outputRoot)) throw new Error("Invalid output slug.");
  return dir;
}

function resolveRefAudioPath(value: string | undefined, field = "voice.refAudio"): string | undefined {
  const refAudio = value?.trim();
  if (!refAudio) return undefined;
  if (/^\[.*\]$/.test(refAudio)) {
    throw new Error(
      `${field} is an attachment label, not a real file path. Upload the clone audio again or paste a full .wav/.mp3 path.`,
    );
  }

  const target = isAbsolute(refAudio) ? refAudio : resolve(repoRoot, refAudio);
  if (!existsSync(target)) {
    throw new Error(`${field} file not found: ${refAudio}`);
  }
  return target;
}

function parseScriptPayload(value: unknown) {
  const script = typeof value === "string" ? TemplateScriptSchema.parse(JSON.parse(value)) : TemplateScriptSchema.parse(value);
  const refAudio = resolveRefAudioPath(script.voice.refAudio);
  if (refAudio) script.voice.refAudio = refAudio;
  for (const [speaker, character] of Object.entries(script.characters ?? {})) {
    const characterRefAudio = resolveRefAudioPath(character.voice.refAudio, `characters.${speaker}.voice.refAudio`);
    if (characterRefAudio) character.voice.refAudio = characterRefAudio;
  }
  return script;
}

function uploadExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return [".wav", ".mp3", ".m4a", ".ogg", ".flac"].includes(ext) ? ext : ".wav";
}

async function serveFile(res: ServerResponse, path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    sendError(res, 404, "Not found");
    return;
  }

  res.writeHead(200, { "Content-Type": contentType(path), "Content-Length": info.size });
  createReadStream(path).pipe(res);
}

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname.startsWith("/output/")) {
    const rel = pathname.slice("/output/".length);
    const target = resolve(outputRoot, rel);
    if (!target.startsWith(outputRoot) || !existsSync(target)) {
      sendError(res, 404, "Output file not found");
      return true;
    }
    await serveFile(res, target);
    return true;
  }

  const targetName = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = resolve(publicDir, targetName);
  if (!target.startsWith(publicDir) || !existsSync(target)) return false;
  await serveFile(res, target);
  return true;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method === "GET" && pathname === "/api/status") {
    sendJson(res, 200, {
      ok: true,
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL || "manual-prompt",
      port: activePort,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/prompt") {
    const body = await readBody(req);
    if (!isRecord(body)) throw new Error("JSON body must be an object.");
    const idea = readString(body, "idea").trim();
    if (!idea) throw new Error("Idea is required.");

    const prompt = buildScriptPrompt({
      idea,
      style: readString(body, "style"),
      sceneCount: readNumber(body, "sceneCount", 6),
      channel: readString(body, "channel", "AI Video"),
      voiceName: readString(body, "voiceName"),
    });
    const slug = slugFrom(readString(body, "slug") || idea);
    sendJson(res, 200, { ok: true, slug, prompt });
    return;
  }

  if (req.method === "POST" && pathname === "/api/script-from-text") {
    const body = await readBody(req);
    if (!isRecord(body)) throw new Error("JSON body must be an object.");
    const rawScript = readString(body, "rawScript").trim();
    if (!rawScript) throw new Error("Raw script is required.");

    const script = generateScriptFromRawScript({
      rawScript,
      title: readString(body, "title") || readString(body, "idea"),
      style: readString(body, "style"),
      sceneCount: readNumber(body, "sceneCount", 6),
      scriptMode: readString(body, "scriptMode") === "dialogue" ? "dialogue" : "standard",
      channel: readString(body, "channel", "AI Video"),
      voiceName: readString(body, "voiceName"),
      voiceRefAudio: readString(body, "voiceRefAudio"),
      voiceRefText: readString(body, "voiceRefText"),
      characterVoices: readCharacterVoices(body),
    });
    const slug = slugFrom(readString(body, "slug") || script.metadata.title);
    sendJson(res, 200, {
      ok: true,
      slug,
      title: script.metadata.title,
      sceneCount: script.scenes.length,
      script,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/upload-ref-audio") {
    const rawFilename = Array.isArray(req.headers["x-filename"])
      ? req.headers["x-filename"][0]
      : req.headers["x-filename"];
    const filename = rawFilename ? decodeURIComponent(rawFilename) : "voice.wav";
    const buffer = await readRawBody(req, MAX_UPLOAD_BYTES);
    if (buffer.length === 0) throw new Error("Audio clone file is empty.");

    const dir = join(outputRoot, "_voice_refs");
    await mkdir(dir, { recursive: true });
    const baseName = slugFrom(filename.replace(/\.[^.]+$/, "")) || "voice";
    const target = join(dir, `${Date.now()}-${baseName}${uploadExtension(filename)}`);
    await writeFile(target, buffer);
    sendJson(res, 200, {
      ok: true,
      refAudio: target,
      path: `output/_voice_refs/${target.split(/[\\/]/).pop()}`,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/validate-script") {
    const body = await readBody(req);
    if (!isRecord(body)) throw new Error("JSON body must be an object.");
    const script = parseScriptPayload(body.script);
    sendJson(res, 200, {
      ok: true,
      title: script.metadata.title,
      sceneCount: script.scenes.length,
      firstScene: script.scenes[0]?.id,
      lastScene: script.scenes[script.scenes.length - 1]?.id,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/save-script") {
    const body = await readBody(req);
    if (!isRecord(body)) throw new Error("JSON body must be an object.");
    const slug = slugFrom(readString(body, "slug") || "untitled");
    const script = parseScriptPayload(body.script);
    const dir = outputDirFor(slug);
    await mkdir(dir, { recursive: true });
    const scriptPath = join(dir, "script.json");
    await writeFile(scriptPath, `${JSON.stringify(script, null, 2)}\n`, "utf8");
    sendJson(res, 200, {
      ok: true,
      slug,
      scriptPath: `output/${slug}/script.json`,
      command: `npm run pipeline -- output/${slug}/script.json`,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/render") {
    const body = await readBody(req);
    if (!isRecord(body)) throw new Error("JSON body must be an object.");
    const slug = slugFrom(readString(body, "slug") || "untitled");
    const scriptPath = join(outputDirFor(slug), "script.json");
    if (!existsSync(scriptPath)) throw new Error(`Missing output/${slug}/script.json. Save the script first.`);
    await runTemplatePipeline(scriptPath);
    sendJson(res, 200, {
      ok: true,
      slug,
      videoPath: `output/${slug}/video.mp4`,
      videoUrl: `/output/${slug}/video.mp4`,
      voicePath: `output/${slug}/voice.mp3`,
      subtitles: [`output/${slug}/subtitle.srt`, `output/${slug}/subtitle.vtt`, `output/${slug}/subtitle.ass`],
    });
    return;
  }

  sendError(res, 404, "API route not found");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }

    if (await serveStatic(res, url.pathname)) return;
    sendError(res, 404, "Not found");
  } catch (error) {
    const status = error instanceof ZodError || error instanceof SyntaxError ? 400 : 500;
    sendError(res, status, error);
  }
});

function listen(port: number, attemptsLeft = MAX_PORT_ATTEMPTS): void {
  server.removeAllListeners("error");
  server.removeAllListeners("listening");

  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      const nextPort = port + 1;
      log.info(`Port ${port} is already in use. Trying http://${HOST}:${nextPort}`);
      listen(nextPort, attemptsLeft - 1);
      return;
    }

    log.error("Web UI failed to start", error);
    process.exit(1);
  });

  server.once("listening", () => {
    activePort = port;
    log.info(`Web UI running at http://${HOST}:${port}`);
    if (port !== PORT) {
      log.info(`WEB_PORT ${PORT} was busy, so this session is using ${port}.`);
    }
  });

  server.listen(port, HOST);
}

listen(PORT);
