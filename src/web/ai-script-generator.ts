import { z } from "zod";
import { TemplateScriptSchema, type TemplateScript } from "../render/template-script-schema.js";

const DEFAULT_MODEL = "gpt-5.5";

export const IdeaOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  angle: z.string().min(1),
  tone: z.string().min(1),
  voiceSuggestion: z.string().min(1).optional(),
  sceneBeats: z.array(z.string().min(1)).min(3).max(8),
});

export const IdeaPlanSchema = z.object({
  options: z.array(IdeaOptionSchema).min(2).max(4),
});

export type IdeaOption = z.infer<typeof IdeaOptionSchema>;
export type IdeaPlan = z.infer<typeof IdeaPlanSchema>;

export interface IdeaPlanRequest {
  idea: string;
  style?: string;
  sceneCount?: number;
  channel?: string;
  voiceName?: string;
  model?: string;
  apiKey?: string;
}

export interface ScriptGenerationRequest extends IdeaPlanRequest {
  option?: IdeaOption;
}

function clampSceneCount(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return 6;
  return Math.max(3, Math.min(8, Math.round(value)));
}

function modelName(model?: string): string {
  return model?.trim() || process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

function apiKey(value?: string): string {
  const key = value?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("Missing OPENAI_API_KEY. Add it to .env.local before using AI generation.");
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readOutputText(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks: string[] = [];
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") chunks.push(part.text);
      if (typeof part.output_text === "string") chunks.push(part.output_text);
    }
  }

  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : undefined;
    if (typeof message?.content === "string") chunks.push(message.content);
  }

  return chunks.join("\n").trim();
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const input = fenced ? fenced[1].trim() : trimmed;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) return input.slice(start, i + 1);
    }
  }

  throw new Error("AI response did not contain a JSON object.");
}

async function openaiJson<T>(
  req: IdeaPlanRequest,
  instructions: string,
  input: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey(req.apiKey)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName(req.model),
      instructions,
      input,
    }),
  });

  const payloadText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${payloadText}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error(`OpenAI returned non-JSON API payload: ${payloadText}`);
  }

  const outputText = readOutputText(payload);
  if (!outputText) {
    throw new Error("OpenAI response did not include output text.");
  }

  const jsonText = extractJsonObject(outputText);
  return schema.parse(JSON.parse(jsonText));
}

export function buildIdeaPlanPrompt(req: IdeaPlanRequest): string {
  const sceneCount = clampSceneCount(req.sceneCount);
  return [
    `Idea: ${req.idea.trim()}`,
    `Channel: ${req.channel?.trim() || "AI Video"}`,
    `Requested style: ${req.style?.trim() || "tu nhien, de hieu"}`,
    `Target scenes: ${sceneCount}`,
    `Voice preset: ${req.voiceName?.trim() || "default"}`,
    "",
    "Analyze the idea and propose three different video directions for a Vietnamese short video.",
    "Each option should be practical for a template-based 9:16 video, not a live-action shoot.",
    "Return JSON only with this shape:",
    '{"options":[{"id":"option-1","title":"...","angle":"...","tone":"...","voiceSuggestion":"...","sceneBeats":["..."]}]}',
  ].join("\n");
}

export function buildScriptPrompt(req: ScriptGenerationRequest): string {
  const sceneCount = clampSceneCount(req.sceneCount);
  const optionBlock = req.option ? JSON.stringify(req.option, null, 2) : "No option selected.";

  return [
    `Idea: ${req.idea.trim()}`,
    `Channel: ${req.channel?.trim() || "AI Video"}`,
    `Requested style: ${req.style?.trim() || "tu nhien, de hieu"}`,
    `Target scenes: ${sceneCount}`,
    `Voice preset: ${req.voiceName?.trim() || "default"}`,
    `Selected option: ${optionBlock}`,
    "",
    "Create a complete script.json for this repository.",
    "Hard requirements:",
    '- Return JSON only. No markdown, no commentary.',
    '- Top-level fields: version "1.0", renderer "hyperframes", aspect "9:16", metadata, voice, scenes.',
    '- voice.provider must be "omnivoice"; voice.speed should be between 0.9 and 1.08.',
    req.voiceName?.trim()
      ? `- Set voice.name exactly to "${req.voiceName.trim()}".`
      : "- Omit voice.name unless the user asks for a specific voice.",
    "- Use Vietnamese voiceText. Make it natural, spoken, and useful.",
    "- voiceText must not contain emoji. Spell numbers in voiceText with Vietnamese words when possible.",
    "- First scene type must be hook. Last scene type must be outro.",
    `- Use ${sceneCount} scenes total.`,
    "- Do not invent template IDs.",
    "",
    "Allowed template IDs and important input slots:",
    "- frame-liquid-bg-hero: kicker, headline, subheadline, cta, brand.",
    "- frame-glitch-title: title, subtitle.",
    "- frame-bold-poster: kicker, date, figure, headline string array, standfirst, footer_left, footer_right.",
    "- frame-aicoding-list: title, accent, subtitle, items array with icon, title, desc, tag, level.",
    "- frame-aicoding-comparison: badge, pre, vs, post, left object, right object.",
    "- frame-pentagram-stat: label, headline, subtitle, anchor, footer_left, footer_right.",
    "- frame-build-minimal: eyebrow, hero, desc, side_left, side_right.",
    "- frame-vignelli: kicker, number, label, note, brand.",
    "- frame-logo-outro: brand_name, tagline, primary_url.",
    "- frame-statement-outro: cta, channel, source.",
    "",
    "Use short on-screen text. Keep each scene focused on one beat.",
  ].join("\n");
}

export async function generateIdeaPlan(req: IdeaPlanRequest): Promise<IdeaPlan> {
  const instructions = [
    "You are a senior Vietnamese short-video producer.",
    "You turn rough ideas into clear, selectable video directions.",
    "Return valid JSON only.",
  ].join(" ");

  return openaiJson(req, instructions, buildIdeaPlanPrompt(req), IdeaPlanSchema);
}

export async function generateScriptFromIdea(req: ScriptGenerationRequest): Promise<TemplateScript> {
  const instructions = [
    "You write valid script.json files for a TypeScript HyperFrames video pipeline.",
    "You respect the exact schema and template IDs given by the user.",
    "Return valid JSON only.",
  ].join(" ");

  return openaiJson(req, instructions, buildScriptPrompt(req), TemplateScriptSchema);
}
