import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import pLimit from "p-limit";
import { TemplateScriptSchema, type TemplateScript, type TemplateVoiceType } from "./template-script-schema.js";
import { loadConfig } from "../config.js";
import { createTtsClient } from "../tts/tts-client.js";
import {
  getDurationSec,
  concatWithSilence,
  mixSfxOntoVoice,
  type SfxMixSpec,
} from "../assets/audio-tools.js";
import { indexSfxLibrary, pickSfxForScene, defaultPlayback } from "../assets/sfx-selector.js";
import { composeTemplate } from "./template-composer.js";
import { writeSubtitleFiles, type SubtitleCue } from "./subtitles.js";
import { fitClipToDuration, concatVideos, muxAudioOntoVideo } from "./video-tools.js";
import { log } from "../utils/logger.js";

const TOTAL_STEPS = 8;
const SCENE_GAP_SEC = 0.3;
const OUTRO_HOLD_SEC = 3;
const RENDER_FPS = 30;

/** Maps a scene role to a key the SFX selector understands (tier-3 defaults). */
const TYPE_TO_SFX: Record<string, string> = {
  hook: "hook",
  body: "callout",
  outro: "outro",
  dialogue: "callout",
};

type ResolvedVoice = {
  label: string;
  voiceName?: string;
  refAudio?: string;
  refText?: string;
  speed: number;
};

async function jsonMatches(path: string, expected: unknown): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const current = JSON.parse(await readFile(path, "utf8"));
    return JSON.stringify(current) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function resolveRefAudioPath(value: string, field = "voice.refAudio"): string {
  const trimmed = value.trim();
  if (/^\[.*\]$/.test(trimmed)) {
    throw new Error(
      `${field} is an attachment label, not a real file path. Upload the clone audio again or paste a full .wav/.mp3 path.`,
    );
  }

  const candidate = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  if (!existsSync(candidate)) {
    throw new Error(`${field} file not found: ${trimmed}`);
  }
  return candidate;
}

function resolveVoiceSpec(voice: TemplateVoiceType, label: string, refAudioField = "voice.refAudio"): ResolvedVoice {
  const refAudioRaw = voice.refAudio?.trim();
  return {
    label,
    voiceName: voice.name?.trim() || undefined,
    refAudio: refAudioRaw ? resolveRefAudioPath(refAudioRaw, refAudioField) : undefined,
    refText: voice.refText?.trim() || undefined,
    speed: voice.speed,
  };
}

function voiceOptionsFor(voice: ResolvedVoice) {
  return {
    voiceName: voice.voiceName,
    refAudio: voice.refAudio,
    refText: voice.refText,
    speed: voice.speed,
  };
}

function subtitleTextForScene(scene: TemplateScript["scenes"][number]): string {
  return scene.speaker ? `${scene.speaker}: ${scene.voiceText}` : scene.voiceText;
}

export async function runTemplatePipeline(scriptPath: string): Promise<void> {
  const cfg = loadConfig();
  const outputDir = dirname(scriptPath);
  log.info(`Output directory: ${outputDir}`);

  // STEP 1 — load + validate
  log.step(1, TOTAL_STEPS, `Load + validate template script (TTS: ${cfg.ttsProvider})`);
  const raw = JSON.parse(await readFile(scriptPath, "utf8"));
  const script: TemplateScript = TemplateScriptSchema.parse(raw);

  // STEP 2 — script.txt for CapCut
  log.step(2, TOTAL_STEPS, "Write script.txt");
  await writeFile(join(outputDir, "script.txt"), script.scenes.map(subtitleTextForScene).join("\n\n"));

  // STEP 3 — TTS per scene (idempotent)
  log.step(3, TOTAL_STEPS, "TTS each scene");
  const ttsClient = createTtsClient(cfg);
  const limit = pLimit(cfg.ttsConcurrency);
  const voiceDir = join(outputDir, "voice");
  const globalVoice = resolveVoiceSpec(script.voice, "global");
  const characterVoices = new Map(
    Object.entries(script.characters ?? {}).map(([speaker, character]) => [
      speaker,
      resolveVoiceSpec(character.voice, speaker, `characters.${speaker}.voice.refAudio`),
    ]),
  );
  const voiceForScene = (scene: TemplateScript["scenes"][number]) =>
    scene.speaker ? characterVoices.get(scene.speaker) ?? globalVoice : globalVoice;
  log.info(
    `  voice preset: ${globalVoice.refAudio ? "custom reference" : globalVoice.voiceName || "server default"} (${globalVoice.speed}x)`,
  );
  if (globalVoice.refAudio) log.info(`  clone ref audio: ${globalVoice.refAudio}`);
  if (globalVoice.refText) log.info(`  clone ref text: ${globalVoice.refText.length} chars`);
  if (characterVoices.size > 0) {
    log.info(`  dialogue voices: ${Array.from(characterVoices.keys()).join(", ")}`);
  }
  await mkdir(voiceDir, { recursive: true });
  const sceneAudio = await Promise.all(
    script.scenes.map((scene) =>
      limit(async () => {
        const sceneVoice = voiceForScene(scene);
        const out = join(voiceDir, `scene-${scene.id}.mp3`);
        const srtOut = join(voiceDir, `scene-${scene.id}.srt`);
        const metaOut = join(voiceDir, `scene-${scene.id}.meta.json`);
        const cacheMeta = {
          ttsCacheVersion: 4,
          text: scene.voiceText,
          speaker: scene.speaker ?? null,
          voiceLabel: sceneVoice.label,
          voiceName: sceneVoice.voiceName ?? null,
          refAudio: sceneVoice.refAudio ?? null,
          refText: sceneVoice.refText ?? null,
          speed: sceneVoice.speed,
        };
        if (existsSync(out) && (await jsonMatches(metaOut, cacheMeta))) {
          const dur = await getDurationSec(out);
          log.info(`  scene ${scene.id}: REUSE mp3 (${dur.toFixed(2)}s)`);
          return { id: scene.id, path: out, durationSec: dur };
        }
        log.info(`  TTS scene ${scene.id}${scene.speaker ? ` [${scene.speaker}]` : ""} (${scene.voiceText.length} chars)...`);
        await ttsClient.generate(scene.voiceText, out, srtOut, voiceOptionsFor(sceneVoice));
        await writeFile(metaOut, `${JSON.stringify(cacheMeta, null, 2)}\n`, "utf8");
        const dur = await getDurationSec(out);
        log.info(`  scene ${scene.id}: ${dur.toFixed(2)}s`);
        return { id: scene.id, path: out, durationSec: dur };
      }),
    ),
  );

  // STEP 4 — concat voice + compute scene timings
  log.step(4, TOTAL_STEPS, "Concat voice + compute timings");
  const voiceRawMp3 = join(outputDir, "voice-raw.mp3");
  const voiceMp3 = join(outputDir, "voice.mp3");
  await concatWithSilence(sceneAudio.map((a) => a.path), SCENE_GAP_SEC, voiceRawMp3);

  let cursor = 0;
  const lastIdx = script.scenes.length - 1;
  const sceneStarts: Record<string, number> = {};
  const sceneAudioById = new Map(sceneAudio.map((a) => [a.id, a]));
  const sceneDisplayDurations = script.scenes.map((scene, index) => {
    const audio = sceneAudioById.get(scene.id);
    if (!audio) throw new Error(`Missing audio timing for scene: ${scene.id}`);
    return audio.durationSec + (index < lastIdx ? SCENE_GAP_SEC : OUTRO_HOLD_SEC);
  });

  for (let i = 0; i < sceneAudio.length; i++) {
    const a = sceneAudio[i]!;
    sceneStarts[a.id] = cursor;
    cursor += a.durationSec + SCENE_GAP_SEC;
  }

  const subtitleCues: SubtitleCue[] = script.scenes.map((scene, index) => {
    const audio = sceneAudioById.get(scene.id);
    if (!audio) throw new Error(`Missing audio timing for scene: ${scene.id}`);
    const startSec = sceneStarts[scene.id];
    return {
      index: index + 1,
      startSec,
      endSec: startSec + audio.durationSec,
      text: subtitleTextForScene(scene),
    };
  });
  await writeSubtitleFiles(outputDir, subtitleCues);
  log.info("  subtitles: subtitle.srt, subtitle.vtt, subtitle.ass");

  // STEP 5 — SFX selection + mix
  log.step(5, TOTAL_STEPS, "Pick + mix SFX");
  const SFX_DIR = join(outputDir, "..", "..", "assets", "sfx");
  const sfxIndex = existsSync(SFX_DIR) ? indexSfxLibrary(SFX_DIR) : {};
  const sfxList: SfxMixSpec[] = [];
  for (const scene of script.scenes) {
    const startSec = sceneStarts[scene.id];
    if (scene.sfx) {
      if (scene.sfx.name === "none") continue;
      const p = join(SFX_DIR, `${scene.sfx.name}.mp3`);
      if (existsSync(p)) sfxList.push({ path: p, startSec: startSec + scene.sfx.startOffsetSec, volume: scene.sfx.volume });
      continue;
    }
    if (Object.keys(sfxIndex).length === 0) continue;
    const picked = pickSfxForScene({
      voiceText: scene.voiceText,
      templateName: TYPE_TO_SFX[scene.type] ?? "callout",
      sceneId: scene.id,
      index: sfxIndex,
    });
    if (!picked) continue;
    const pb = defaultPlayback(picked);
    sfxList.push({ path: join(SFX_DIR, picked.relPath), startSec: startSec + pb.offsetSec, volume: pb.volume });
  }
  await mixSfxOntoVoice(voiceRawMp3, sfxList, voiceMp3);
  const totalAudioSec = await getDurationSec(voiceMp3);
  log.info(`  voice.mp3: ${totalAudioSec.toFixed(2)}s, ${sfxList.length} SFX`);

  // STEP 6 — render each scene's template clip, fit to its narration length
  log.step(6, TOTAL_STEPS, "Render template clips + fit to narration");
  const clipsDir = join(outputDir, "clips");
  await mkdir(clipsDir, { recursive: true });
  const fittedClips: string[] = [];
  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];
    const visualDur = sceneDisplayDurations[i]!;

    const rawClip = join(clipsDir, `scene-${scene.id}.mp4`);
    const fitClip = join(clipsDir, `scene-${scene.id}-fit.mp4`);
    // IDEMPOTENT: reuse an already-rendered clip. Delete it to force a
    // re-render after editing the scene's inputs or template.
    if (existsSync(rawClip)) {
      log.info(`  scene ${scene.id}: REUSE clip — delete to force re-render`);
    } else {
      await composeTemplate({
        templateId: scene.templateId,
        inputs: scene.inputs,
        aspect: script.aspect,
        outputPath: rawClip,
        fps: RENDER_FPS,
      });
    }
    await fitClipToDuration(rawClip, visualDur, fitClip, RENDER_FPS);
    log.info(`  scene ${scene.id}: ${scene.templateId} → ${visualDur.toFixed(2)}s`);
    fittedClips.push(fitClip);
  }

  // STEP 7 — concat clips + mux voice
  log.step(7, TOTAL_STEPS, "Concat clips + mux audio");
  const silentVideo = join(outputDir, "video-silent.mp4");
  const videoPath = join(outputDir, "video.mp4");
  await concatVideos(fittedClips, silentVideo);
  await muxAudioOntoVideo(silentVideo, voiceMp3, videoPath);

  // STEP 8 — done
  log.step(8, TOTAL_STEPS, "Done");
  console.log("\n=== Result ===");
  console.log(`Video:  ${videoPath}`);
  console.log(`Audio:  ${voiceMp3}  (cho CapCut)`);
  console.log(`Script: ${join(outputDir, "script.txt")}  (cho CapCut auto-caption)`);
  console.log(`Subs:   ${join(outputDir, "subtitle.srt")} / subtitle.vtt / subtitle.ass`);
  console.log(`Tong thoi luong: ${totalAudioSec.toFixed(2)}s`);
}
