import axios, { AxiosError } from "axios";
import { writeFile } from "node:fs/promises";
import type { TtsClient, TtsGenerateOptions } from "./tts-client.js";

export interface OmniVoiceOpts {
  endpoint: string; // e.g. "http://127.0.0.1:8123"
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function responseSnippet(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 300);
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8").slice(0, 300);
  if (Buffer.isBuffer(data)) return data.toString("utf8").slice(0, 300);
  return "";
}

function friendlyTtsError(status: number, details: string, refAudio?: string): string {
  const missingTorchPackage = details.match(/No module named ['"](torch|torchaudio)['"]/);
  if (missingTorchPackage) {
    const pkg = missingTorchPackage[1];
    return [
      `OmniVoice TTS failed (status ${status}).`,
      `Voice clone is reaching VieNeu-TTS, but that Python environment is missing ${pkg}.`,
      "Install torch and torchaudio in the same environment that runs VieNeu-TTS, then restart the VieNeu bridge.",
      refAudio ? `Clone audio path: ${refAudio}` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const suffix = details ? ` Response: ${details}` : " Check that the selected voice exists in your VieNeu-TTS presets.";
  return `OmniVoice TTS failed (status ${status}).${suffix}`;
}

// OmniVoice local TTS: POST { text } -> audio/mpeg bytes.
// VieNeu-compatible bridges may also accept voice/voiceName/speaker.
// srtOutPath is ignored (no subtitle support).
export class OmniVoiceClient implements TtsClient {
  constructor(private cfg: OmniVoiceOpts) {}

  async generate(
    text: string,
    audioOutPath: string,
    _srtOutPath?: string,
    options?: TtsGenerateOptions,
  ): Promise<void> {
    const delays = [1000, 2000, 4000];
    let lastErr: unknown;
    const payload: Record<string, string | number> = { text };
    const voiceName = options?.voiceName?.trim();
    const refAudio = options?.refAudio?.trim();

    if (voiceName) {
      payload.voice = voiceName;
      payload.voiceName = voiceName;
      payload.speaker = voiceName;
    }
    if (refAudio) {
      payload.ref_audio = refAudio;
      payload.refAudio = refAudio;
      payload.referenceAudio = refAudio;
    }
    if (options?.speed) payload.speed = options.speed;

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = await axios.post<ArrayBuffer>(
          `${this.cfg.endpoint}/tts`,
          payload,
          { headers: { "Content-Type": "application/json", Accept: "audio/mpeg" }, responseType: "arraybuffer", timeout: 60000 },
        );
        await writeFile(audioOutPath, Buffer.from(resp.data));
        return;
      } catch (e) {
        lastErr = e;
        const status = (e as AxiosError).response?.status;
        if (status !== undefined && status < 500 && status !== 429) {
          throw new Error(`OmniVoice TTS failed (status ${status})`);
        }
        if (attempt < delays.length) await sleep(delays[attempt]);
      }
    }
    if (axios.isAxiosError(lastErr) && lastErr.response) {
      const status = lastErr.response.status;
      const details = responseSnippet(lastErr.response.data);
      throw new Error(friendlyTtsError(status, details, refAudio));
    }
    throw lastErr;
  }
}
