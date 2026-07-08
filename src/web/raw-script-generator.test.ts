import { describe, expect, it } from "vitest";
import { generateScriptFromRawScript } from "./raw-script-generator.js";

describe("raw script generator", () => {
  it("turns paragraph narration into a valid template script", () => {
    const script = generateScriptFromRawScript({
      title: "Clip day nhay Brazil",
      rawScript: [
        "Hellooo cac vo oi. Dao nay di dau cung thay Brazil trending dung khong.",
        "Dau tien dung tha long, dau goi hoi khuyu va buoc chan phai sang ngang.",
        "Tiep theo keo chan trai ve, vai tha long va bam dung beat.",
        "Sai pho bien la buoc qua manh, con dung la buoc nhe va giu co the mem.",
        "Gio tap cham vai luot truoc roi moi tang toc.",
        "Luu lai tap vai lan la len nhip lien.",
      ].join("\n\n"),
      sceneCount: 6,
      channel: "AI Video",
      voiceName: "gia",
    });

    expect(script.version).toBe("1.0");
    expect(script.renderer).toBe("hyperframes");
    expect(script.metadata.title).toBe("Clip day nhay Brazil");
    expect(script.voice.name).toBe("gia");
    expect(script.scenes).toHaveLength(6);
    expect(script.scenes[0]?.type).toBe("hook");
    expect(script.scenes[5]?.type).toBe("outro");
    expect(script.scenes[1]?.voiceText).toContain("Dau tien dung tha long");
  });

  it("can regroup sentence-only narration to the requested scene count", () => {
    const script = generateScriptFromRawScript({
      rawScript:
        "Mo dau bang mot cau that gan voi nguoi xem. Giai thich van de chinh that ngan gon. Dua ra buoc mot de lam ngay. Dua ra buoc hai de tranh sai. So sanh cach sai va cach dung. Ket lai bang loi keu goi luu video.",
      sceneCount: 4,
    });

    expect(script.scenes).toHaveLength(4);
    expect(script.scenes[0]?.id).toBe("hook");
    expect(script.scenes[3]?.id).toBe("outro");
    expect(script.scenes.every((scene) => scene.voiceText.length > 0)).toBe(true);
  });

  it("does not split short line-based narration into word fragments", () => {
    const script = generateScriptFromRawScript({
      rawScript: [
        "xin chao cac ban",
        "minh la van vien",
        "hom nay minh ke mot cau chuyen ngan",
        "cam on cac ban da lang nghe",
      ].join("\n"),
      sceneCount: 6,
    });

    expect(script.scenes).toHaveLength(4);
    expect(script.scenes.map((scene) => scene.voiceText)).toEqual([
      "xin chao cac ban",
      "minh la van vien",
      "hom nay minh ke mot cau chuyen ngan",
      "cam on cac ban da lang nghe",
    ]);
  });

  it("asks for more narration instead of creating unusable micro-scenes", () => {
    expect(() =>
      generateScriptFromRawScript({
        rawScript: ["xin chao cac ban", "minh la van vien"].join("\n"),
        sceneCount: 6,
      }),
    ).toThrow("it nhat 3 doan");
  });

  it("uses title metadata without reading it as narration", () => {
    const script = generateScriptFromRawScript({
      rawScript: [
        "Title: Meo quay video dep hon",
        "",
        "Mo dau bang mot loi hua ro rang cho nguoi xem.",
        "",
        "Dua ra meo dau tien de anh sang nhin mem hon.",
        "",
        "Dua ra meo thu hai de bo cuc gon hon.",
        "",
        "Ket lai bang loi nhac luu video de thuc hanh.",
      ].join("\n"),
    });

    expect(script.metadata.title).toBe("Meo quay video dep hon");
    expect(script.scenes[0]?.voiceText).not.toContain("Title:");
  });

  it("writes voice clone reference audio into the script", () => {
    const script = generateScriptFromRawScript({
      rawScript: ["Mo dau ngan gon.", "Noi dung chinh de nghe thu.", "Ket lai ro rang."].join("\n"),
      voiceRefAudio: "C:\\voices\\clone.wav",
    });

    expect(script.voice.refAudio).toBe("C:\\voices\\clone.wav");
  });
});
