#!/usr/bin/env node
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { ZodError } from "zod";
import { runTemplatePipeline } from "../render/template-pipeline.js";
import { TemplateScriptSchema } from "../render/template-script-schema.js";
import { toSlug } from "../utils/slug.js";
import { log } from "../utils/logger.js";
import { buildScriptPrompt } from "./ai-script-generator.js";

config({ path: ".env.local" });

const PORT = Number(process.env.WEB_PORT || 3210);
const MAX_BODY_BYTES = 1024 * 1024;
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
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
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

function slugFrom(value: string): string {
  return toSlug(value).replace(/[^a-z0-9-]/g, "").slice(0, 60) || "untitled";
}

function outputDirFor(slugValue: string): string {
  const slug = slugFrom(slugValue);
  const dir = resolve(outputRoot, slug);
  if (!dir.startsWith(outputRoot)) throw new Error("Invalid output slug.");
  return dir;
}

function parseScriptPayload(value: unknown) {
  if (typeof value === "string") {
    return TemplateScriptSchema.parse(JSON.parse(value));
  }
  return TemplateScriptSchema.parse(value);
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
      port: PORT,
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

server.listen(PORT, "127.0.0.1", () => {
  log.info(`Web UI running at http://127.0.0.1:${PORT}`);
});
