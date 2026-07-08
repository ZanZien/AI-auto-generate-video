const els = {
  statusText: document.querySelector("#statusText"),
  modelBadge: document.querySelector("#modelBadge"),
  idea: document.querySelector("#idea"),
  rawScript: document.querySelector("#rawScript"),
  style: document.querySelector("#style"),
  sceneCount: document.querySelector("#sceneCount"),
  channel: document.querySelector("#channel"),
  voiceName: document.querySelector("#voiceName"),
  voiceRefAudio: document.querySelector("#voiceRefAudio"),
  voiceRefFile: document.querySelector("#voiceRefFile"),
  slug: document.querySelector("#slug"),
  generateScriptBtn: document.querySelector("#generateScriptBtn"),
  promptBtn: document.querySelector("#promptBtn"),
  copyPromptBtn: document.querySelector("#copyPromptBtn"),
  promptBox: document.querySelector("#promptBox"),
  scriptEditor: document.querySelector("#scriptEditor"),
  formatBtn: document.querySelector("#formatBtn"),
  applyVoiceBtn: document.querySelector("#applyVoiceBtn"),
  validateBtn: document.querySelector("#validateBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  renderBtn: document.querySelector("#renderBtn"),
  result: document.querySelector("#result"),
  videoPreview: document.querySelector("#videoPreview"),
};

const availableVoices = [
  "Tr\u00fac Ly",
  "Ph\u1ea1m Tuy\u00ean",
  "Th\u00e1i S\u01a1n",
  "Xu\u00e2n V\u0129nh",
  "Thanh B\u00ecnh",
  "Minh \u0110\u1ee9c",
  "Ng\u1ecdc Linh",
  "\u0110oan Trang",
  "Mai Anh",
  "Th\u1ee5c \u0110oan",
];

function syncVoiceOptions() {
  const current = els.voiceName.value;
  els.voiceName.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Theo JSON / bridge";
  els.voiceName.appendChild(defaultOption);

  for (const voice of availableVoices) {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = voice;
    els.voiceName.appendChild(option);
  }

  if (availableVoices.includes(current)) {
    els.voiceName.value = current;
  }
}

function formPayload() {
  return {
    idea: els.idea.value.trim(),
    rawScript: els.rawScript.value.trim(),
    style: els.style.value,
    sceneCount: Number(els.sceneCount.value || 6),
    channel: els.channel.value.trim() || "AI Video",
    voiceName: els.voiceName.value.trim(),
    voiceRefAudio: els.voiceRefAudio.value.trim(),
    slug: els.slug.value.trim(),
  };
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
    delete button.dataset.label;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || response.statusText);
  }
  return data;
}

async function uploadVoiceRefIfNeeded() {
  const file = els.voiceRefFile.files?.[0];
  if (!file) return els.voiceRefAudio.value.trim();

  const response = await fetch("/api/upload-ref-audio", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Filename": encodeURIComponent(file.name),
    },
    body: await file.arrayBuffer(),
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || response.statusText);
  }
  els.voiceRefAudio.value = data.refAudio;
  els.voiceRefFile.value = "";
  return data.refAudio;
}

function clearResult() {
  els.result.innerHTML = "";
}

function addResultLine(text, className) {
  const line = document.createElement("div");
  line.className = className ? `result-line ${className}` : "result-line";
  line.textContent = text;
  els.result.appendChild(line);
}

function addResultLink(label, href) {
  const line = document.createElement("div");
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  anchor.target = "_blank";
  line.appendChild(anchor);
  els.result.appendChild(line);
}

function showError(error) {
  clearResult();
  addResultLine(error instanceof Error ? error.message : String(error), "error");
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const input = fenced ? fenced[1].trim() : trimmed;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
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

  throw new Error("Khong tim thay JSON object trong khung script.");
}

function applySelectedVoice(script) {
  const voiceName = els.voiceName.value.trim();
  const refAudio = els.voiceRefAudio.value.trim();
  if (!voiceName && !refAudio) return script;

  script.voice = {
    provider: script.voice?.provider || "omnivoice",
    speed: typeof script.voice?.speed === "number" ? script.voice.speed : 1,
    ...script.voice,
  };
  if (voiceName) script.voice.name = voiceName;
  else if (refAudio) delete script.voice.name;
  if (refAudio) script.voice.refAudio = refAudio;
  return script;
}

function readScriptJson({ applyVoice = false } = {}) {
  const jsonText = extractJsonObject(els.scriptEditor.value);
  const script = JSON.parse(jsonText);
  return applyVoice ? applySelectedVoice(script) : script;
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    const data = await response.json();
    els.modelBadge.textContent = "manual";
    els.statusText.textContent = `Web UI dang chay tai cong ${data.port}. Khong can OPENAI_API_KEY cho buoc nay.`;
  } catch (error) {
    els.statusText.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function createPrompt() {
  const payload = formPayload();
  if (!payload.idea) throw new Error("Nhap y tuong video truoc.");

  setBusy(els.promptBtn, true, "Dang tao...");
  try {
    const data = await postJson("/api/prompt", payload);
    els.slug.value = data.slug;
    els.promptBox.value = data.prompt;
    clearResult();
    addResultLine("Da tao prompt. Copy sang ChatGPT, sau do dan JSON tra ve vao khung script.");
  } finally {
    setBusy(els.promptBtn, false);
  }
}

async function generateScriptFromRaw() {
  const payload = formPayload();
  if (!payload.rawScript) throw new Error("Dan kich ban san truoc.");

  setBusy(els.generateScriptBtn, true, "Dang sinh...");
  try {
    payload.voiceRefAudio = await uploadVoiceRefIfNeeded();
    const data = await postJson("/api/script-from-text", {
      ...payload,
      title: payload.idea,
    });
    els.slug.value = data.slug;
    els.scriptEditor.value = `${JSON.stringify(data.script, null, 2)}\n`;
    clearResult();
    addResultLine(`Da sinh script.json: ${data.title}`);
    addResultLine(`So scene: ${data.sceneCount}. Co the bam Validate, Luu script hoac Render video.`);
  } finally {
    setBusy(els.generateScriptBtn, false);
  }
}

async function copyPrompt() {
  if (!els.promptBox.value.trim()) throw new Error("Chua co prompt de copy.");
  await navigator.clipboard.writeText(els.promptBox.value);
  clearResult();
  addResultLine("Da copy prompt vao clipboard.");
}

function formatScript() {
  const script = readScriptJson();
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  clearResult();
  addResultLine("JSON da duoc format.");
}

async function applyVoiceToEditor() {
  await uploadVoiceRefIfNeeded();
  const script = readScriptJson({ applyVoice: true });
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  clearResult();
  addResultLine(
    els.voiceName.value.trim() || els.voiceRefAudio.value.trim()
      ? `Da gan giong: ${els.voiceName.value.trim() || "bridge default"}${els.voiceRefAudio.value.trim() ? " + audio clone" : ""}`
      : "Chua chon giong, JSON duoc giu nguyen.",
  );
}

async function validateScript() {
  await uploadVoiceRefIfNeeded();
  const script = readScriptJson({ applyVoice: true });
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  const data = await postJson("/api/validate-script", { script });
  clearResult();
  addResultLine(`Hop le: ${data.title}`);
  addResultLine(`So scene: ${data.sceneCount}; dau: ${data.firstScene}; cuoi: ${data.lastScene}`);
}

async function saveScript() {
  await uploadVoiceRefIfNeeded();
  const script = readScriptJson({ applyVoice: true });
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  const slug = els.slug.value.trim() || script.metadata?.title || "ai-video";
  const data = await postJson("/api/save-script", { slug, script });
  els.slug.value = data.slug;
  clearResult();
  addResultLine(`Da luu: ${data.scriptPath}`);
  addResultLine(`Lenh CLI: ${data.command}`);
  return data.slug;
}

async function renderVideo() {
  setBusy(els.renderBtn, true, "Dang render...");
  try {
    const slug = await saveScript();
    clearResult();
    addResultLine("Dang render video. Giu cua so nay mo den khi xong.");
    const data = await postJson("/api/render", { slug });
    clearResult();
    addResultLine(`Da render: ${data.videoPath}`);
    addResultLink("Mo video.mp4", data.videoUrl);
    addResultLine(`Audio: ${data.voicePath}`);
    addResultLine(`Subtitles: ${data.subtitles.join(", ")}`);
    els.videoPreview.src = `${data.videoUrl}?t=${Date.now()}`;
    els.videoPreview.load();
  } finally {
    setBusy(els.renderBtn, false);
  }
}

els.generateScriptBtn.addEventListener("click", () => generateScriptFromRaw().catch(showError));
els.promptBtn.addEventListener("click", () => createPrompt().catch(showError));
els.copyPromptBtn.addEventListener("click", () => copyPrompt().catch(showError));
els.formatBtn.addEventListener("click", () => {
  try {
    formatScript();
  } catch (error) {
    showError(error);
  }
});
els.applyVoiceBtn.addEventListener("click", () => {
  applyVoiceToEditor().catch(showError);
});
els.validateBtn.addEventListener("click", () => validateScript().catch(showError));
els.saveBtn.addEventListener("click", () => saveScript().catch(showError));
els.renderBtn.addEventListener("click", () => renderVideo().catch(showError));

syncVoiceOptions();
loadStatus();
