import { z } from "zod";

/**
 * Script schema for the HyperFrames template pipeline. Each scene names a
 * vendored template under templates/<templateId>/ and supplies `inputs` matching
 * that template's data-composition-variables.
 */

const SfxSpec = z.object({
  name: z.string().min(1),
  volume: z.number().min(0).max(1).default(0.4),
  startOffsetSec: z.number().default(0),
});
export type TplSfxSpecType = z.infer<typeof SfxSpec>;

const VoiceSpec = z.object({
  provider: z.literal("omnivoice").default("omnivoice"),
  /** Optional voice preset. VieNeu bridge accepts this when it supports per-request voices. */
  name: z.string().min(1).optional(),
  /** Optional reference audio path for VieNeu voice cloning. */
  refAudio: z.string().min(1).optional(),
  /** Optional transcript for the reference audio, used by some clone engines. */
  refText: z.string().min(1).optional(),
  speed: z.number().min(0.5).max(2.0).default(1),
});
export type TemplateVoiceType = z.infer<typeof VoiceSpec>;

const CharacterSpec = z.object({
  label: z.string().min(1),
  voice: VoiceSpec,
});
export type TemplateCharacterType = z.infer<typeof CharacterSpec>;

const TemplateScene = z.object({
  id: z.string().min(1),
  type: z.enum(["hook", "body", "outro", "dialogue"]),
  /** Speaker key for dialogue scenes, e.g. "A", "B", "Host". */
  speaker: z.string().min(1).optional(),
  /** Spoken narration. */
  voiceText: z.string().min(1),
  /** Folder name under templates/, e.g. "frame-bold-poster". */
  templateId: z.string().min(1),
  /** Text slots for the template's data-composition-variables. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  /** Optional SFX override (else picked per scene.type + voiceText keywords). */
  sfx: SfxSpec.optional(),
});
export type TemplateSceneType = z.infer<typeof TemplateScene>;

export const TemplateScriptSchema = z
  .object({
    version: z.literal("1.0"),
    /** Discriminator: marks this as a HyperFrames-template script. */
    renderer: z.literal("hyperframes"),
    /** Standard narration keeps hook/body/outro; dialogue uses per-speaker scenes. */
    mode: z.enum(["standard", "dialogue"]).default("standard"),
    metadata: z.object({
      title: z.string().min(1),
      source: z.object({
        url: z.string(),
        domain: z.string(),
        image: z.string().url().nullable(),
      }),
      channel: z.string().min(1),
    }),
    voice: VoiceSpec,
    characters: z.record(z.string(), CharacterSpec).optional(),
    /** Output aspect for every scene (templates render a matching composition). */
    aspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
    scenes: z.array(TemplateScene).min(3).max(40),
  })
  .superRefine((script, ctx) => {
    const hasDialogueScene = script.scenes.some((scene) => scene.type === "dialogue" || scene.speaker);
    if (script.mode === "dialogue" || hasDialogueScene) {
      if (!script.characters || Object.keys(script.characters).length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["characters"],
          message: "dialogue scripts must define characters",
        });
      }

      script.scenes.forEach((scene, index) => {
        if (!scene.speaker) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", index, "speaker"],
            message: "dialogue scenes must include speaker",
          });
          return;
        }
        if (script.characters && !script.characters[scene.speaker]) {
          ctx.addIssue({
            code: "custom",
            path: ["scenes", index, "speaker"],
            message: `unknown dialogue speaker: ${scene.speaker}`,
          });
        }
      });
      return;
    }

    if (script.scenes[0]?.type !== "hook") {
      ctx.addIssue({ code: "custom", path: ["scenes", 0, "type"], message: "scenes[0] must be type=hook" });
    }
    if (script.scenes[script.scenes.length - 1]?.type !== "outro") {
      ctx.addIssue({
        code: "custom",
        path: ["scenes", script.scenes.length - 1, "type"],
        message: "last scene must be type=outro",
      });
    }
  });

export type TemplateScript = z.infer<typeof TemplateScriptSchema>;
