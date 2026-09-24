const api = globalThis.browser ?? globalThis.chrome;
if (!api?.runtime) {
  const warning = document.querySelector("#browser-api-warning");
  if (warning) warning.hidden = false;
  throw new Error("Firefox did not provide extension APIs to this tab.");
}

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8080",
  bufferSize: 5,
  voiceStyle: "natural",
  saveAudio: false,
  saveFolder: "FreeAIReader",
  referenceAudio: "",
  referenceTranscript: ""
};

const form = document.querySelector("#settings-form");
const status = document.querySelector("#settings-status");
const pdfStatus = document.querySelector("#pdf-status");
const pdfInput = document.querySelector("#pdf-file");
const readPdfButton = document.querySelector("#read-pdf");
const resumeAudioButton = document.querySelector("#resume-audio");
const downloadModelButton = document.querySelector("#download-model");
const cancelModelButton = document.querySelector("#cancel-model");
const modelChoice = document.querySelector("#model-choice");
const modelStatus = document.querySelector("#model-status");
const modelProgress = document.querySelector("#model-progress");
const modelFilesList = document.querySelector("#model-files");
const modelDescription = document.querySelector("#model-description");
const modelHardware = document.querySelector("#model-hardware");
const modelLicenseText = document.querySelector("#model-license-text");
const modelLink = document.querySelector("#model-link");
const modelRunSummary = document.querySelector("#model-run-summary");
const modelRunSteps = document.querySelector("#model-run-steps");
const modelRunCommand = document.querySelector("#model-run-command");
const diagnosticLogList = document.querySelector("#diagnostic-log");
const logStatus = document.querySelector("#log-status");
let selectedReference = null;
let selectedPdf = null;
let currentPlayer = null;
let currentObjectUrl = null;
let activeSessionId = null;
let stopPlaybackPromise = null;
let pendingStartResolve = null;
let playbackQueue = [];
let isPlaying = false;
let keepAlivePort = null;
let keepAliveTimer = null;
let modelPollTimer = null;
let diagnosticsPollTimer = null;

const MODEL_UI = {
  "fish-speech-1.5": {
    label: "Fish Speech V1.5",
    repo: "fishaudio/fish-speech-1.5",
    license: "CC BY-NC-SA 4.0",
    description: "The compact public model is about 1.47 GB. Fish Audio's V1.5.1 guide recommends 4 GB of GPU memory for inference; this computer's 16 GB RTX 4080 SUPER is above that recommendation.",
    hardware: "Compact option: about 1.47 GB to download. The official V1.5.1 guide recommends 4 GB of GPU memory.",
    url: "https://huggingface.co/fishaudio/fish-speech-1.5",
    steps: "V1.5 requires Fish Speech's legacy v1.5.1 server. In vendor/fish-speech, check out v1.5.1, then install Python 3.10 and PyTorch 2.4.1 as shown below.",
    command: "cd vendor/fish-speech\ngit checkout v1.5.1\npython3.10 -m venv .venv-v1.5\nsource .venv-v1.5/bin/activate\npython -m pip install --upgrade pip\npython -m pip install torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1\npython -m pip install -e '.[stable]'\npython -m tools.api_server --listen 127.0.0.1:8080 --llama-checkpoint-path \"$HOME/Downloads/FreeAIReader/models/fish-speech-1.5\" --decoder-checkpoint-path \"$HOME/Downloads/FreeAIReader/models/fish-speech-1.5/firefly-gan-vq-fsq-8x1024-21hz-generator.pth\" --decoder-config-name firefly_gan_vq"
  },
  "s2-pro": {
    label: "Fish Audio S2 Pro",
    repo: "fishaudio/s2-pro",
    license: "Fish Audio Research License",
    description: "The current flagship files total about 11 GB. Fish Audio permits research and noncommercial use under its Research License; commercial use needs a separate written license.",
    hardware: "S2 Pro option: about 11 GB to download. Fish Audio recommends 24 GB of GPU memory; this computer's 16 GB RTX 4080 SUPER is below that recommendation.",
    url: "https://huggingface.co/fishaudio/s2-pro",
    steps: "From vendor/fish-speech, use the current source checkout and choose a CUDA extra supported by your system.",
    command: "cd vendor/fish-speech\ngit checkout 214da3cd841bda85da2496b96cd3c4d7edb1337e\nuv sync --python 3.12 --extra cu129\nuv run python tools/api_server.py --llama-checkpoint-path \"$HOME/Downloads/FreeAIReader/models/s2-pro\" --decoder-checkpoint-path \"$HOME/Downloads/FreeAIReader/models/s2-pro/codec.pth\" --listen 127.0.0.1:8080"
  }
};

document.querySelector("#accept-model-license").addEventListener("change", async (event) => {
  downloadModelButton.disabled = !event.target.checked;
  if (event.target.checked) await recordUiLog("model.license.accepted", { source: MODEL_UI[modelChoice.value].repo });
});
modelChoice.addEventListener("change", () => updateModelChoice(true));
updateModelChoice(false);

function updateModelChoice(clearAgreement) {
  const selected = MODEL_UI[modelChoice.value] || MODEL_UI["fish-speech-1.5"];
  modelDescription.textContent = selected.description;
  modelHardware.textContent = selected.hardware;
  modelLicenseText.textContent = `I have reviewed and agree to use this model under the ${selected.license}.`;
  modelLink.href = selected.url;
  modelRunSummary.textContent = `Run ${selected.label} with Fish Speech`;
  modelRunSteps.textContent = selected.steps;
  modelRunCommand.textContent = selected.command;
  downloadModelButton.textContent = `Download ${selected.label} files`;
  if (clearAgreement) document.querySelector("#accept-model-license").checked = false;
  downloadModelButton.disabled = !document.querySelector("#accept-model-license").checked;
}

api.runtime.onMessage.addListener((message) => {
  if (message?.target !== "extension") return false;
  if (message?.type === "FREEAIREADER_PLAY_CHUNK") playChunk(message);
  if (message?.type === "FREEAIREADER_STATUS") {
    pdfStatus.textContent = message.text;
    if (message.text.startsWith("Preparing speech")) beginKeepAlive();
    if (/Reading finished|Reading stopped|Speech generation failed/.test(message.text)) endKeepAlive();
  }
  if (message?.type === "FREEAIREADER_STOP") stopLocalPlayback();
});

loadSettings().catch(async (error) => {
  status.textContent = "Could not load settings.";
  await recordUiLog("settings.load.failed", { kind: errorKind(error) });
});
openPdfHandoff();
refreshModelDownload();
recordUiLog("app.options.opened").then(refreshDiagnosticLog);
modelPollTimer = setInterval(refreshModelDownload, 3000);
diagnosticsPollTimer = setInterval(refreshDiagnosticLog, 5000);

async function recordUiLog(event, details = {}) {
  try {
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_LOG", event, details });
    if (!result?.ok) throw new Error("log-write-failed");
  } catch (error) {
    console.error("FreeAIReader could not write its diagnostic log", error);
    if (logStatus) logStatus.textContent = "Could not save a diagnostic event. Check Firefox's extension storage.";
  }
}

function errorKind(error) {
  return error?.name === "TypeError" ? "network-or-type" : String(error?.name || "unknown").slice(0, 40);
}

async function refreshDiagnosticLog() {
  try {
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_GET_LOG" });
    if (result?.error) throw new Error(result.error);
    const entries = result?.entries ?? [];
    diagnosticLogList.replaceChildren();
    for (const entry of [...entries].reverse()) {
      const li = document.createElement("li");
      if (/fail|error|interrupted/i.test(entry.event)) li.dataset.level = "failure";
      const time = document.createElement("time");
      time.dateTime = entry.time;
      time.textContent = `${new Date(entry.time).toLocaleString()} — `;
      const event = document.createElement("strong");
      event.textContent = entry.event;
      li.append(time, event);
      const details = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "time" && key !== "event"));
      if (Object.keys(details).length) {
        const summary = document.createElement("span");
        summary.textContent = ` ${JSON.stringify(details)}`;
        li.append(summary);
      }
      diagnosticLogList.append(li);
    }
    logStatus.textContent = `${entries.length} of 500 most recent events stored locally.`;
  } catch (error) {
    logStatus.textContent = `Could not load the diagnostic log (${errorKind(error)}).`;
  }
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit > 1 ? 2 : 0)} ${units[unit]}`;
}

async function refreshModelDownload() {
  try {
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_GET_MODEL_DOWNLOAD" });
    if (result?.error) throw new Error(result.error);
    const job = result?.job;
    if (!job) {
      modelStatus.textContent = `Files will be saved under Downloads/FreeAIReader/models/${modelChoice.value}.`;
      cancelModelButton.hidden = true;
      modelChoice.disabled = false;
      return;
    }
    if (job.status === "downloading" && modelChoice.value !== job.modelKey) {
      modelChoice.value = job.modelKey;
      updateModelChoice(false);
    }
    modelChoice.disabled = job.status === "downloading";
    modelProgress.value = job.totalBytes ? Math.floor(100 * job.receivedBytes / job.totalBytes) : 0;
    modelStatus.textContent = `${job.label || job.modelKey} — ${job.status === "complete" ? "download complete" : job.status === "needs-attention" ? "some files need attention" : "downloading"}: ${formatBytes(job.receivedBytes)} of ${formatBytes(job.totalBytes)} (${job.completedFiles}/${job.files.length} files complete).`;
    cancelModelButton.hidden = job.status !== "downloading";
    modelFilesList.replaceChildren();
    for (const file of job.files) {
      const li = document.createElement("li");
      const received = file.state === "complete" ? file.size : file.bytesReceived || 0;
      const detail = file.state === "in_progress" ? `${formatBytes(received)} / ${formatBytes(file.size)}` : file.state;
      li.textContent = `${file.name} — ${detail}${file.error ? ` (${file.error})` : ""}`;
      modelFilesList.append(li);
    }
  } catch (error) {
    modelStatus.textContent = `Could not read download status (${errorKind(error)}).`;
  }
}

downloadModelButton.addEventListener("click", async () => {
  if (!document.querySelector("#accept-model-license").checked) return;
  downloadModelButton.disabled = true;
  modelStatus.textContent = "Requesting permission and checking Fish Audio's official model listing…";
  try {
    const granted = await api.permissions.request({ permissions: ["downloads"] });
    if (!granted) {
      await recordUiLog("model.permission.denied", { source: "downloads" });
      throw new Error("Allow Downloads permission to save model files.");
    }
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_START_MODEL_DOWNLOAD", modelKey: modelChoice.value });
    if (!result?.ok) throw new Error(result?.error || "Could not start the model download.");
    modelStatus.textContent = "Model downloads queued in Firefox Downloads.";
    await refreshModelDownload();
    await refreshDiagnosticLog();
  } catch (error) {
    modelStatus.textContent = error.message;
    await recordUiLog("model.download.failed", { kind: errorKind(error) });
  } finally {
    downloadModelButton.disabled = !document.querySelector("#accept-model-license").checked;
  }
});

cancelModelButton.addEventListener("click", async () => {
  cancelModelButton.disabled = true;
  try {
    await api.runtime.sendMessage({ type: "FREEAIREADER_CANCEL_MODEL_DOWNLOAD" });
    await refreshModelDownload();
    await refreshDiagnosticLog();
  } catch (error) {
    modelStatus.textContent = `Could not cancel downloads (${errorKind(error)}).`;
    await recordUiLog("model.download.cancel.failed", { kind: errorKind(error) });
  } finally {
    cancelModelButton.disabled = false;
  }
});

document.querySelector("#refresh-log").addEventListener("click", refreshDiagnosticLog);
document.querySelector("#clear-log").addEventListener("click", async () => {
  try {
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_CLEAR_LOG" });
    if (!result?.ok) throw new Error(result?.error || "clear-failed");
    await refreshDiagnosticLog();
    logStatus.textContent = "Diagnostic log cleared.";
  } catch (error) {
    logStatus.textContent = `Could not clear the log (${errorKind(error)}).`;
  }
});

document.querySelector("#export-log").addEventListener("click", async () => {
  try {
    await recordUiLog("diagnostics.exported");
    const result = await api.runtime.sendMessage({ type: "FREEAIREADER_GET_LOG" });
    if (result?.error) throw new Error(result.error);
    const blob = new Blob([JSON.stringify({ app: "FreeAIReader", exportedAt: new Date().toISOString(), entries: result.entries }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `freeaireader-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logStatus.textContent = "Diagnostic JSON exported to your browser downloads.";
    await refreshDiagnosticLog();
  } catch (error) {
    logStatus.textContent = `Could not export the log (${errorKind(error)}).`;
    await recordUiLog("diagnostics.export.failed", { kind: errorKind(error) });
  }
});

async function loadSettings() {
  const settings = { ...DEFAULTS, ...(await api.storage.local.get(null)) };
  document.querySelector("#server-url").value = settings.serverUrl;
  document.querySelector("#buffer-size").value = settings.bufferSize;
  document.querySelector("#voice-style").value = settings.voiceStyle;
  document.querySelector("#save-audio").checked = Boolean(settings.saveAudio);
  document.querySelector("#save-folder").value = settings.saveFolder;
  document.querySelector("#voice-transcript").value = settings.referenceTranscript;
  document.querySelector("#keep-voice").checked = Boolean(settings.referenceAudio);
  document.querySelector("#remove-voice").hidden = !settings.referenceAudio;
  document.querySelector("#save-folder").disabled = !settings.saveAudio;
}

async function openPdfHandoff() {
  const handoffId = new URL(location.href).searchParams.get("readPdf");
  if (!handoffId) return;
  const handoffKey = `freeaireader-pdf-${handoffId}`;
  try {
    const handoff = await api.storage.session.get(handoffKey);
    const pdfUrl = handoff[handoffKey];
    await api.storage.session.remove(handoffKey);
    if (!pdfUrl) throw new Error("This PDF request expired. Use the PDF file picker instead.");
    await loadPdfFromUrl(pdfUrl);
    await recordUiLog("pdf.open.loaded", { source: "browser-tab" });
    readPdfButton.click();
  } catch (error) {
    pdfStatus.textContent = error.message;
    await recordUiLog("pdf.open.failed", { source: "browser-tab", kind: errorKind(error) });
  }
}

async function loadPdfFromUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Choose a local PDF from the file picker in settings.");
  }
  pdfStatus.textContent = "Loading the open PDF…";
  const response = await fetch(url.href, { credentials: "include" });
  if (!response.ok) {
    await recordUiLog("pdf.fetch.failed", { source: "browser-tab", status: response.status });
    throw new Error(`Could not read this PDF (${response.status}).`);
  }
  const filename = decodeURIComponent(url.pathname.split("/").pop() || "document.pdf");
  const bytes = await response.arrayBuffer();
  selectedPdf = new File([bytes], filename, { type: "application/pdf" });
  readPdfButton.disabled = false;
  pdfStatus.textContent = `${filename} is ready.`;
  await recordUiLog("pdf.fetch.complete", { source: "browser-tab", bytes: bytes.byteLength });
}

document.querySelector("#save-audio").addEventListener("change", (event) => {
  document.querySelector("#save-folder").disabled = !event.target.checked;
});

document.querySelector("#voice-file").addEventListener("change", (event) => {
  selectedReference = event.target.files?.[0] ?? null;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Saving…";
  try {
    const saveAudio = document.querySelector("#save-audio").checked;
    const downloadPermission = { permissions: ["downloads"] };
    if (saveAudio) {
      const granted = await api.permissions.request(downloadPermission);
      if (!granted) throw new Error("Allow downloads permission to save audio files.");
    } else if (await api.permissions.contains(downloadPermission)) {
      await api.permissions.remove(downloadPermission);
    }
    const serverUrl = normalizeLocalUrl(document.querySelector("#server-url").value);
    const transcript = document.querySelector("#voice-transcript").value.trim();
    const keepVoice = document.querySelector("#keep-voice").checked;
    let referenceAudio = "";
    if (selectedReference) {
      if (!transcript) throw new Error("Enter the words spoken in the reference MP3.");
      referenceAudio = await fileToBase64(selectedReference);
    } else if (keepVoice) {
      const old = await api.storage.local.get({ referenceAudio: "" });
      referenceAudio = old.referenceAudio;
    }
    const saveFolder = sanitizeFolder(document.querySelector("#save-folder").value);
    const settings = {
      serverUrl,
      bufferSize: Math.max(1, Math.min(20, Number(document.querySelector("#buffer-size").value) || 5)),
      voiceStyle: document.querySelector("#voice-style").value,
      saveAudio,
      saveFolder,
      referenceAudio: keepVoice ? referenceAudio : "",
      referenceTranscript: keepVoice ? transcript : ""
    };
    await api.storage.local.set(settings);
    selectedReference = null;
    document.querySelector("#voice-file").value = "";
    document.querySelector("#remove-voice").hidden = !settings.referenceAudio;
    status.textContent = "Settings saved on this device.";
    await recordUiLog("settings.saved", { bufferSize: settings.bufferSize, voiceStyle: settings.voiceStyle });
  } catch (error) {
    status.textContent = error.message;
    await recordUiLog("settings.save.failed", { kind: errorKind(error) });
  }
});

document.querySelector("#remove-voice").addEventListener("click", async () => {
  try {
    await api.storage.local.set({ referenceAudio: "", referenceTranscript: "" });
    document.querySelector("#voice-transcript").value = "";
    document.querySelector("#keep-voice").checked = false;
    document.querySelector("#remove-voice").hidden = true;
    status.textContent = "Saved reference voice removed.";
    await recordUiLog("voice.reference.removed");
  } catch (error) {
    status.textContent = "Could not remove the saved reference voice.";
    await recordUiLog("voice.reference.remove.failed", { kind: errorKind(error) });
  }
});

pdfInput.addEventListener("change", (event) => {
  selectedPdf = event.target.files?.[0] ?? null;
  readPdfButton.disabled = !selectedPdf;
  pdfStatus.textContent = selectedPdf ? `${selectedPdf.name} is ready.` : "";
});

readPdfButton.addEventListener("click", async () => {
  if (!selectedPdf) return;
  readPdfButton.disabled = true;
  pdfStatus.textContent = "Extracting PDF text…";
  const startedAt = Date.now();
  try {
    const pdfjs = await import(api.runtime.getURL("vendor/pdfjs/pdf.mjs"));
    const pdfBase = api.runtime.getURL("vendor/pdfjs/");
    pdfjs.GlobalWorkerOptions.workerSrc = `${pdfBase}pdf.worker.mjs`;
    const bytes = new Uint8Array(await selectedPdf.arrayBuffer());
    const documentPdf = await pdfjs.getDocument({
      data: bytes,
      cMapUrl: `${pdfBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${pdfBase}standard_fonts/`,
      wasmUrl: `${pdfBase}wasm/`,
      iccUrl: `${pdfBase}iccs/`
    }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= documentPdf.numPages; pageNumber += 1) {
      const page = await documentPdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str).filter(Boolean).join(" "));
    }
    const text = pages.join("\n\n").trim();
    if (!text) throw new Error("This PDF has no selectable text. Scanned pages need OCR, which is not included yet.");
    await api.runtime.sendMessage({ type: "FREEAIREADER_START_TEXT", source: "PDF", text });
    pdfStatus.textContent = `Reading ${documentPdf.numPages} pages…`;
    await recordUiLog("pdf.extract.complete", { source: "PDF", files: documentPdf.numPages, durationMs: Date.now() - startedAt, bytes: bytes.byteLength });
  } catch (error) {
    pdfStatus.textContent = error.message;
    await recordUiLog("pdf.extract.failed", { source: "PDF", durationMs: Date.now() - startedAt, kind: errorKind(error) });
  } finally {
    readPdfButton.disabled = false;
  }
});

document.querySelector("#stop-reading").addEventListener("click", async () => {
  stopLocalPlayback();
  try {
    await api.runtime.sendMessage({ type: "FREEAIREADER_STOP" });
    pdfStatus.textContent = "Reading stopped.";
  } catch (error) {
    pdfStatus.textContent = "Could not stop the reader.";
    await recordUiLog("reading.stop.failed", { source: "PDF", kind: errorKind(error) });
  }
});

function normalizeLocalUrl(value) {
  const url = new URL(value);
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !localHosts.has(url.hostname)) {
    throw new Error("The speech server must use a local address: localhost, 127.0.0.1, or ::1.");
  }
  return url.toString().replace(/\/$/, "");
}

function sanitizeFolder(value) {
  return value.trim().replace(/\\/g, "/").split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function playChunk(message) {
  try {
    if (activeSessionId && activeSessionId !== message.sessionId) stopLocalPlayback();
    activeSessionId = message.sessionId;
    const binary = atob(message.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: message.mimeType || "audio/wav" }));
    playbackQueue.push({ ...message, objectUrl });
    pumpLocalPlayback();
  } catch (error) {
    pdfStatus.textContent = `Could not prepare audio playback: ${error.message}`;
    recordUiLog("playback.prepare.failed", { source: "extension", index: Number(message.index) + 1, kind: errorKind(error) });
    api.runtime.sendMessage({ type: "FREEAIREADER_CHUNK_PLAYED", sessionId: message.sessionId, index: message.index }).catch(() => {});
  }
}

async function pumpLocalPlayback() {
  if (isPlaying || !playbackQueue.length) return;
  isPlaying = true;
  const item = playbackQueue.shift();
  currentObjectUrl = item.objectUrl;
  const player = new Audio(currentObjectUrl);
  currentPlayer = player;
  const playbackStartedAt = Date.now();
  let finishReason = "complete";
  try {
    const started = await playWithActivation(player);
    if (!started) {
      finishReason = "stopped";
      return;
    }
    await recordUiLog("playback.started", { source: "extension", index: item.index + 1 });
    await new Promise((resolve, reject) => {
      stopPlaybackPromise = () => { finishReason = "stopped"; resolve(); };
      player.addEventListener("ended", resolve, { once: true });
      player.addEventListener("error", () => reject(new Error("The browser could not play this audio.")), { once: true });
    });
  } catch (error) {
    finishReason = "failed";
    pdfStatus.textContent = `Playback needs attention: ${error.message}`;
    await recordUiLog("playback.failed", { source: "extension", index: item.index + 1, durationMs: Date.now() - playbackStartedAt, kind: errorKind(error) });
  } finally {
    if (finishReason !== "failed") {
      await recordUiLog(`playback.${finishReason}`, { source: "extension", index: item.index + 1, durationMs: Date.now() - playbackStartedAt });
    }
    player.pause();
    player.removeAttribute("src");
    URL.revokeObjectURL(item.objectUrl);
    currentPlayer = null;
    currentObjectUrl = null;
    stopPlaybackPromise = null;
    api.runtime.sendMessage({ type: "FREEAIREADER_CHUNK_PLAYED", sessionId: item.sessionId, index: item.index }).catch(() => {});
    isPlaying = false;
    pumpLocalPlayback();
  }
}

function stopLocalPlayback() {
  for (const item of playbackQueue.splice(0)) URL.revokeObjectURL(item.objectUrl);
  pendingStartResolve?.(false);
  pendingStartResolve = null;
  if (currentPlayer) {
    currentPlayer.pause();
    currentPlayer.removeAttribute("src");
    stopPlaybackPromise?.();
    currentPlayer = null;
  }
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = null;
  activeSessionId = null;
  endKeepAlive();
}

async function playWithActivation(player) {
  try {
    await player.play();
    return true;
  } catch (error) {
    if (error.name !== "NotAllowedError") throw error;
    await recordUiLog("playback.autoplay.blocked", { source: "extension" });
    pdfStatus.textContent = "Click Start audio to allow playback.";
    resumeAudioButton.hidden = false;
    return new Promise((resolve) => {
      pendingStartResolve = resolve;
      resumeAudioButton.onclick = async () => {
        try {
          await player.play();
          resumeAudioButton.hidden = true;
          pendingStartResolve = null;
          pdfStatus.textContent = "Reading aloud.";
          resolve(true);
        } catch (retryError) {
          pdfStatus.textContent = `Playback needs attention: ${retryError.message}`;
          await recordUiLog("playback.failed", { source: "extension", kind: errorKind(retryError) });
          const resolveStart = pendingStartResolve;
          pendingStartResolve = null;
          resolveStart?.(false);
        }
      };
    });
  }
}

function beginKeepAlive() {
  if (keepAlivePort) return;
  keepAlivePort = api.runtime.connect({ name: "freeaireader-session" });
  keepAliveTimer = setInterval(() => {
    try { keepAlivePort?.postMessage({ type: "heartbeat" }); } catch { endKeepAlive(); }
  }, 20000);
  keepAlivePort.onDisconnect.addListener(() => {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    keepAlivePort = null;
  });
}

function endKeepAlive() {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  const port = keepAlivePort;
  keepAlivePort = null;
  if (port) port.disconnect();
}
