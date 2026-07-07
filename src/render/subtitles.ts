import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SubtitleCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

function clampTime(sec: number): number {
  return Math.max(0, Number.isFinite(sec) ? sec : 0);
}

function splitWords(text: string): string[] {
  return text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
}

export function wrapSubtitleText(text: string, maxChars = 42): string {
  const words = splitWords(text);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= maxChars || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

export function formatSrtTime(sec: number): string {
  const totalMs = Math.round(clampTime(sec) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(ms, 3)}`;
}

export function formatVttTime(sec: number): string {
  return formatSrtTime(sec).replace(",", ".");
}

export function formatAssTime(sec: number): string {
  const totalCs = Math.round(clampTime(sec) * 100);
  const cs = totalCs % 100;
  const totalSeconds = Math.floor(totalCs / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(cs)}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue) =>
      [
        String(cue.index),
        `${formatSrtTime(cue.startSec)} --> ${formatSrtTime(cue.endSec)}`,
        wrapSubtitleText(cue.text),
      ].join("\n"),
    )
    .join("\n\n") + "\n";
}

export function toVtt(cues: SubtitleCue[]): string {
  return "WEBVTT\n\n" + cues
    .map((cue) =>
      [
        String(cue.index),
        `${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}`,
        wrapSubtitleText(cue.text),
      ].join("\n"),
    )
    .join("\n\n") + "\n";
}

function escapeAssText(text: string): string {
  return wrapSubtitleText(text)
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

export function toAss(cues: SubtitleCue[]): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,54,&H00FFFFFF,&H000000FF,&H9A000000,&H99000000,0,0,0,0,100,100,0,0,1,4,1,2,80,80,150,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const events = cues
    .map((cue) =>
      [
        "Dialogue: 0",
        formatAssTime(cue.startSec),
        formatAssTime(cue.endSec),
        "Default",
        "",
        "0",
        "0",
        "0",
        "",
        escapeAssText(cue.text),
      ].join(","),
    )
    .join("\n");

  return `${header}\n${events}\n`;
}

export async function writeSubtitleFiles(
  outputDir: string,
  cues: SubtitleCue[],
): Promise<void> {
  await Promise.all([
    writeFile(join(outputDir, "subtitle.srt"), toSrt(cues), "utf8"),
    writeFile(join(outputDir, "subtitle.vtt"), toVtt(cues), "utf8"),
    writeFile(join(outputDir, "subtitle.ass"), toAss(cues), "utf8"),
  ]);
}
