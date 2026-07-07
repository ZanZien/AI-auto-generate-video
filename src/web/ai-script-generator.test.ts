import { describe, expect, it } from "vitest";
import { buildIdeaPlanPrompt, buildScriptPrompt, extractJsonObject } from "./ai-script-generator.js";

describe("ai script generator helpers", () => {
  it("extracts a JSON object from fenced output", () => {
    const text = '```json\n{"ok":true,"text":"hello"}\n```';
    expect(extractJsonObject(text)).toBe('{"ok":true,"text":"hello"}');
  });

  it("extracts the first balanced JSON object", () => {
    const text = 'draft:\n{"a":"brace { inside string }","b":{"c":1}}\nthanks';
    expect(JSON.parse(extractJsonObject(text))).toEqual({
      a: "brace { inside string }",
      b: { c: 1 },
    });
  });

  it("builds prompts with repo-specific template constraints", () => {
    const planPrompt = buildIdeaPlanPrompt({ idea: "day nau trung", sceneCount: 20 });
    const scriptPrompt = buildScriptPrompt({ idea: "day nau trung", sceneCount: 2, voiceName: "Bình An" });

    expect(planPrompt).toContain("Target scenes: 8");
    expect(scriptPrompt).toContain('voice.provider must be "omnivoice"');
    expect(scriptPrompt).toContain('Set voice.name exactly to "Bình An"');
    expect(scriptPrompt).toContain("frame-aicoding-list");
    expect(scriptPrompt).toContain("Use 3 scenes total.");
  });
});
