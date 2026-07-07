import axios, { AxiosError } from "axios";
import { writeFile } from "node:fs/promises";
import type { TtsClient, TtsGenerateOptions } from "./tts-client.js";

export interface OmniVoiceOpts {
  endpoint: string; // e.g. "http://127.0.0.1:8123"
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

    if (voiceName) {
      payload.voice = voiceName;
      payload.voiceName = voiceName;
      payload.speaker = voiceName;
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
    throw lastErr;
  }
}
