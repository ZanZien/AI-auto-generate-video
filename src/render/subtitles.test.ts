import { describe, expect, it } from "vitest";
import {
  formatAssTime,
  formatSrtTime,
  formatVttTime,
  toAss,
  toSrt,
  toVtt,
  wrapSubtitleText,
  type SubtitleCue,
} from "./subtitles.js";

const cues: SubtitleCue[] = [
  {
    index: 1,
    startSec: 0,
    endSec: 2.345,
    text: "Xin chao, day la cau dau tien.",
  },
  {
    index: 2,
    startSec: 2.645,
    endSec: 65.01,
    text: "Cau thu hai dai hon mot chut de kiem tra viec xuong dong tu dong.",
  },
];

describe("subtitle formatting", () => {
  it("formats timestamps for SRT, VTT and ASS", () => {
    expect(formatSrtTime(65.01)).toBe("00:01:05,010");
    expect(formatVttTime(65.01)).toBe("00:01:05.010");
    expect(formatAssTime(65.01)).toBe("0:01:05.01");
  });

  it("wraps subtitle text without losing words", () => {
    expect(wrapSubtitleText("mot hai ba bon nam sau", 10)).toBe("mot hai ba\nbon nam\nsau");
  });

  it("writes valid SRT cues", () => {
    expect(toSrt(cues)).toContain("1\n00:00:00,000 --> 00:00:02,345");
    expect(toSrt(cues)).toContain("2\n00:00:02,645 --> 00:01:05,010");
  });

  it("writes valid VTT cues", () => {
    const vtt = toVtt(cues);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:02.645 --> 00:01:05.010");
  });

  it("writes ASS events", () => {
    const ass = toAss(cues);
    expect(ass).toContain("[Events]");
    expect(ass).toContain("Dialogue: 0,0:00:02.65,0:01:05.01");
  });
});
