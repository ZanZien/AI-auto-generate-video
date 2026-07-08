import { TemplateScriptSchema, type TemplateScript, type TemplateSceneType } from "../render/template-script-schema.js";

export interface RawScriptGenerationRequest {
  rawScript: string;
  title?: string;
  style?: string;
  sceneCount?: number;
  channel?: string;
  voiceName?: string;
  voiceRefAudio?: string;
  sourceUrl?: string;
  sourceDomain?: string;
}

type TemplateInputs = Record<string, unknown>;

const DEFAULT_CHANNEL = "AI Video";
const MAX_SCENES = 8;
const MIN_SCENES = 3;

function clampSceneCount(value: number | undefined, fallback: number): number {
  if (!value || !Number.isFinite(value)) return fallback;
  return Math.max(MIN_SCENES, Math.min(MAX_SCENES, Math.round(value)));
}

function foldText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase();
}

function normalizeSpace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function trimPunctuation(input: string): string {
  return input.replace(/^[\s"']+|[\s"'.,!?;:]+$/g, "").trim();
}

function stripSceneLabel(input: string): string {
  const bracketless = input.replace(/^\s*(?:\[[^\]]+\]\s*)+/, "").trim();
  const colonMatch = bracketless.match(/^([^:\n]{1,32}):\s*([\s\S]+)$/);
  if (colonMatch) {
    const label = foldText(colonMatch[1] ?? "").trim();
    if (/^(canh|scene|doan|phan|hook|intro|outro|ket bai|mo bai)\s*\d*$/.test(label)) {
      return colonMatch[2]?.trim() ?? bracketless;
    }
  }
  return bracketless.replace(/^\s*(?:[-*]\s*)?\d{1,2}[.)-]\s+/, "").trim();
}

function cleanNarration(input: string): string {
  return normalizeSpace(
    input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        const folded = foldText(line);
        if (/^(title|tieu de|chu de)\s*:/.test(folded)) return false;
        return !/^(visual|hinh|hinh anh|on screen|text|sfx|music|nhac)\s*:/.test(folded);
      })
      .map(stripSceneLabel)
      .join(" "),
  );
}

function splitParagraphs(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n+/)
    .map(cleanNarration)
    .filter(Boolean);
}

function splitLines(input: string): string[] {
  return input
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(cleanNarration)
    .filter(Boolean);
}

function splitSentences(input: string): string[] {
  const normalized = cleanNarration(input);
  const matches = normalized.match(/[^.!?;\n]+[.!?;]+|[^.!?;\n]+$/g) ?? [];
  return matches.map(normalizeSpace).filter(Boolean);
}

function splitWordsIntoParts(input: string, target: number): string[] {
  const words = normalizeSpace(input).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const parts: string[] = [];
  const partSize = Math.max(1, Math.ceil(words.length / target));
  for (let i = 0; i < target; i += 1) {
    const chunk = words.slice(i * partSize, (i + 1) * partSize).join(" ");
    if (chunk) parts.push(chunk);
  }
  return parts;
}

function groupUnits(units: string[], target: number): string[] {
  if (units.length === target) return units;
  if (units.length < target) return units;

  const groups: string[] = [];
  let cursor = 0;
  let remainingChars = units.reduce((sum, unit) => sum + unit.length, 0);

  for (let groupIndex = 0; groupIndex < target; groupIndex += 1) {
    const groupsLeft = target - groupIndex;
    const targetChars = Math.max(1, Math.ceil(remainingChars / groupsLeft));
    const current: string[] = [];
    let currentChars = 0;

    while (cursor < units.length) {
      const minUnitsForRest = groupsLeft - 1;
      const unitsLeftBeforeThis = units.length - cursor;
      if (current.length > 0 && unitsLeftBeforeThis <= minUnitsForRest) break;

      current.push(units[cursor] ?? "");
      currentChars += units[cursor]?.length ?? 0;
      remainingChars -= units[cursor]?.length ?? 0;
      cursor += 1;

      const unitsLeftAfterThis = units.length - cursor;
      if (currentChars >= targetChars && unitsLeftAfterThis >= minUnitsForRest) break;
    }

    groups.push(normalizeSpace(current.join(" ")));
  }

  return groups.filter(Boolean);
}

function chooseSceneTexts(rawScript: string, requestedCount?: number): string[] {
  const paragraphs = splitParagraphs(rawScript);
  const lines = splitLines(rawScript);
  const sentenceUnits = splitSentences(rawScript);
  const baseUnits =
    paragraphs.length >= MIN_SCENES
      ? paragraphs
      : lines.length >= MIN_SCENES
        ? lines
        : sentenceUnits.length >= MIN_SCENES
          ? sentenceUnits
          : lines.length > 1
            ? lines
            : sentenceUnits;

  if (baseUnits.length < MIN_SCENES) {
    throw new Error(
      "Kich ban can it nhat 3 doan hoac 3 cau de tao hook, body va outro. Hay them noi dung, hoac tach thanh 3 dong rieng.",
    );
  }

  const paragraphCount = paragraphs.length;
  const fallbackCount =
    paragraphCount >= MIN_SCENES && paragraphCount <= MAX_SCENES ? paragraphCount : Math.min(baseUnits.length, 6);
  const requestedTarget = clampSceneCount(requestedCount, fallbackCount);
  const target = Math.min(requestedTarget, baseUnits.length, MAX_SCENES);
  const sceneTexts = groupUnits(baseUnits, target);

  return sceneTexts.slice(0, MAX_SCENES);
}

function firstMeaningfulLine(input: string): string {
  return (
    input
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function deriveTitle(req: RawScriptGenerationRequest): string {
  const explicit = req.title?.trim();
  if (explicit) return shorten(trimPunctuation(explicit), 74);

  const firstLine = firstMeaningfulLine(req.rawScript);
  const folded = foldText(firstLine);
  if (folded.startsWith("title:") || folded.startsWith("tieu de:")) {
    return shorten(trimPunctuation(firstLine.split(":").slice(1).join(":")), 74);
  }

  const firstSentence = splitSentences(req.rawScript)[0] ?? "Untitled video";
  return shorten(trimPunctuation(stripSceneLabel(firstSentence)), 74);
}

function shorten(input: string, maxLength: number): string {
  const text = normalizeSpace(input);
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength + 1);
  return trimPunctuation(sliced.slice(0, sliced.lastIndexOf(" ") > 20 ? sliced.lastIndexOf(" ") : maxLength));
}

function firstSentence(input: string): string {
  return splitSentences(input)[0] ?? normalizeSpace(input);
}

function headlineLines(input: string, maxLines = 3): string[] {
  const text = shorten(trimPunctuation(firstSentence(input)), 58);
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return [text];

  const lines: string[] = [];
  const lineSize = Math.ceil(words.length / maxLines);
  for (let i = 0; i < maxLines; i += 1) {
    const line = words.slice(i * lineSize, (i + 1) * lineSize).join(" ");
    if (line) lines.push(line);
  }
  return lines;
}

function titleFromText(input: string, maxLength = 32): string {
  return shorten(trimPunctuation(firstSentence(input)), maxLength);
}

function descFromText(input: string, maxLength = 86): string {
  const sentences = splitSentences(input);
  return shorten(trimPunctuation(sentences[1] ?? sentences[0] ?? input), maxLength);
}

function bodyTemplateFor(text: string, index: number): string {
  const folded = foldText(text);
  if (/%|\b\d+[.,]?\d*\b|phan tram|lan|gap doi|mot nua/.test(folded)) return "frame-pentagram-stat";
  if (/( vs |so sanh|khac nhau|dung|sai|truoc|sau|nen |khong nen|loi sai)/.test(` ${folded} `)) {
    return "frame-aicoding-comparison";
  }
  if (/(buoc|meo|luu y|dau tien|tiep theo|cuoi cung|mot la|hai la|ba la|bon la)/.test(folded)) {
    return "frame-aicoding-list";
  }
  return index % 3 === 0 ? "frame-bold-poster" : index % 3 === 1 ? "frame-build-minimal" : "frame-vignelli";
}

function listItems(text: string): Array<Record<string, string>> {
  const parts = splitSentences(text);
  const source = parts.length >= 3 ? parts : groupUnits(parts.length ? parts : [text], Math.min(4, Math.max(3, parts.length || 3)));

  return source.slice(0, 4).map((part, index) => {
    const title = titleFromText(part, 28);
    return {
      icon: String(index + 1).padStart(2, "0"),
      title: title || `Y ${index + 1}`,
      desc: descFromText(part, 52) || "Giu y nay ngan gon",
      tag: index === 0 ? "Chinh" : `Y ${index + 1}`,
      level: index % 3 === 0 ? "good" : index % 3 === 1 ? "info" : "warn",
    };
  });
}

function comparisonInputs(text: string): TemplateInputs {
  const sentences = splitSentences(text);
  const left = sentences.slice(0, 2);
  const right = sentences.slice(2, 4);
  const fallbackRight = right.length ? right : sentences.slice(-2);

  return {
    badge: "So sanh",
    pre: "Truoc",
    vs: "VS",
    post: "Sau",
    left: {
      label: "Can tranh",
      from: "#ffb020",
      to: "#ff7a3d",
      bullets: (left.length ? left : [text]).slice(0, 2).map((item) => shorten(trimPunctuation(item), 44)),
      stat: "Sai",
      stat_label: "De mat nhip",
    },
    right: {
      label: "Nen lam",
      from: "#34e0c0",
      to: "#22d3ee",
      win: true,
      bullets: fallbackRight.slice(0, 2).map((item) => shorten(trimPunctuation(item), 44)),
      stat: "Dung",
      stat_label: "Ro va de theo",
    },
  };
}

function statInputValue(text: string): string {
  const match = text.match(/\b\d+[.,]?\d*\s*%|\b\d+[.,]?\d*x\b|\b\d+[.,]?\d*\b/i);
  return match?.[0] ?? "01";
}

function inputsForScene(templateId: string, text: string, index: number, title: string, channel: string): TemplateInputs {
  switch (templateId) {
    case "frame-glitch-title":
      return {
        title: titleFromText(title || text, 34),
        subtitle: titleFromText(text, 54),
      };
    case "frame-liquid-bg-hero":
      return {
        kicker: channel,
        headline: titleFromText(title || text, 42),
        subheadline: descFromText(text, 76),
        cta: "Bat dau",
        brand: channel,
      };
    case "frame-aicoding-list":
      return {
        title: "Ghi nho",
        accent: `${Math.min(4, listItems(text).length)} y`,
        subtitle: titleFromText(text, 46),
        items: listItems(text),
      };
    case "frame-aicoding-comparison":
      return comparisonInputs(text);
    case "frame-pentagram-stat":
      return {
        label: `Y ${index}`,
        headline: statInputValue(text),
        subtitle: titleFromText(text, 64),
        anchor: statInputValue(text).replace(/\D/g, "") || String(index).padStart(2, "0"),
        footer_left: channel,
        footer_right: "Auto script",
      };
    case "frame-build-minimal":
      return {
        eyebrow: `Canh ${index}`,
        hero: titleFromText(text, 26),
        desc: descFromText(text, 84),
        side_left: channel,
        side_right: "Video",
      };
    case "frame-vignelli":
      return {
        kicker: channel,
        number: String(index).padStart(2, "0"),
        label: titleFromText(text, 34),
        note: descFromText(text, 92),
        brand: channel,
      };
    case "frame-statement-outro":
      return {
        cta: titleFromText(text, 44) || "Luu lai va lam thu",
        channel,
        source: title,
      };
    case "frame-bold-poster":
    default:
      return {
        kicker: `Canh ${index}`,
        date: "Auto script",
        figure: String(index).padStart(2, "0"),
        headline: headlineLines(text),
        standfirst: descFromText(text, 96),
        footer_left: channel,
        footer_right: titleFromText(title, 28),
      };
  }
}

function sceneForText(text: string, index: number, lastIndex: number, title: string, channel: string): TemplateSceneType {
  const type = index === 0 ? "hook" : index === lastIndex ? "outro" : "body";
  const templateId =
    type === "hook" ? "frame-glitch-title" : type === "outro" ? "frame-statement-outro" : bodyTemplateFor(text, index);

  return {
    id: type === "hook" ? "hook" : type === "outro" ? "outro" : `scene-${index + 1}`,
    type,
    voiceText: text,
    templateId,
    inputs: inputsForScene(templateId, text, index + 1, title, channel),
  };
}

export function generateScriptFromRawScript(req: RawScriptGenerationRequest): TemplateScript {
  const rawScript = req.rawScript.trim();
  if (!rawScript) throw new Error("Raw script is required.");

  const channel = req.channel?.trim() || DEFAULT_CHANNEL;
  const title = deriveTitle(req);
  const sceneTexts = chooseSceneTexts(rawScript, req.sceneCount);
  const lastIndex = sceneTexts.length - 1;

  const script = {
    version: "1.0",
    renderer: "hyperframes",
    metadata: {
      title,
      source: {
        url: req.sourceUrl?.trim() || "local-raw-script",
        domain: req.sourceDomain?.trim() || "Manual Script",
        image: null,
      },
      channel,
    },
    voice: {
      provider: "omnivoice",
      ...(req.voiceName?.trim() ? { name: req.voiceName.trim() } : {}),
      ...(req.voiceRefAudio?.trim() ? { refAudio: req.voiceRefAudio.trim() } : {}),
      speed: foldText(req.style ?? "").includes("nhanh") ? 1.04 : 1,
    },
    aspect: "9:16",
    scenes: sceneTexts.map((text, index) => sceneForText(text, index, lastIndex, title, channel)),
  };

  return TemplateScriptSchema.parse(script);
}
