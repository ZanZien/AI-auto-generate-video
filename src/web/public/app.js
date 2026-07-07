const els = {
  statusText: document.querySelector("#statusText"),
  modelBadge: document.querySelector("#modelBadge"),
  idea: document.querySelector("#idea"),
  style: document.querySelector("#style"),
  sceneCount: document.querySelector("#sceneCount"),
  channel: document.querySelector("#channel"),
  voiceName: document.querySelector("#voiceName"),
  slug: document.querySelector("#slug"),
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

function formPayload() {
  return {
    idea: els.idea.value.trim(),
    style: els.style.value,
    sceneCount: Number(els.sceneCount.value || 6),
    channel: els.channel.value.trim() || "AI Video",
    voiceName: els.voiceName.value.trim(),
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
  if (!voiceName) return script;

  script.voice = {
    provider: script.voice?.provider || "omnivoice",
    speed: typeof script.voice?.speed === "number" ? script.voice.speed : 1,
    ...script.voice,
    name: voiceName,
  };
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

function applyVoiceToEditor() {
  const script = readScriptJson({ applyVoice: true });
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  clearResult();
  addResultLine(
    els.voiceName.value.trim()
      ? `Da gan giong: ${els.voiceName.value.trim()}`
      : "Chua chon giong, JSON duoc giu nguyen.",
  );
}

async function validateScript() {
  const script = readScriptJson({ applyVoice: true });
  els.scriptEditor.value = `${JSON.stringify(script, null, 2)}\n`;
  const data = await postJson("/api/validate-script", { script });
  clearResult();
  addResultLine(`Hop le: ${data.title}`);
  addResultLine(`So scene: ${data.sceneCount}; dau: ${data.firstScene}; cuoi: ${data.lastScene}`);
}

async function saveScript() {
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
  try {
    applyVoiceToEditor();
  } catch (error) {
    showError(error);
  }
});
els.validateBtn.addEventListener("click", () => validateScript().catch(showError));
els.saveBtn.addEventListener("click", () => saveScript().catch(showError));
els.renderBtn.addEventListener("click", () => renderVideo().catch(showError));

loadStatus();
