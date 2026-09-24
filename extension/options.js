import { KokoroTTS, kokoroEnv, transformersEnv } from "./vendor/model-runtime.js";

const api = globalThis.browser ?? globalThis.chrome;
if (!api?.runtime) {
  const warning = document.querySelector("#browser-api-warning");
  if (warning) warning.hidden = false;
  throw new Error("Firefox did not provide extension APIs to this tab.");
}

const DEFAULTS = {
  bufferSize: 5,
  voiceStyle: "af_heart",
  saveAudio: false,
  saveFolder: "FreeAIReader"
};

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const MODEL_CACHE_NAME = "transformers-cache";
const VOICE_CACHE_NAME = "kokoro-voices";
const VOICES = ["af_heart", "af_bella", "af_nicole", "am_adam", "bm_george"];
transformersEnv.useBrowserCache = true;
kokoroEnv.wasmPaths = api.runtime.getURL("vendor/onnx/");

const form = document.querySelector("#settings-form");
const status = document.querySelector("#settings-status");
const pdfStatus = document.querySelector("#pdf-status");
const pdfInput = document.querySelector("#pdf-file");
const readPdfButton = document.querySelector("#read-pdf");
const resumeAudioButton = document.querySelector("#resume-audio");
const downloadModelButton = document.querySelector("#download-model");
const clearModelButton = document.querySelector("#clear-model");
const testVoiceButton = document.querySelector("#test-voice");
const voiceSample = document.querySelector("#voice-sample");
const modelChoice = document.querySelector("#model-choice");
const modelStatus = document.querySelector("#model-status");
const modelProgress = document.querySelector("#model-progress");
const diagnosticLogList = document.querySelector("#diagnostic-log");
const logStatus = document.querySelector("#log-status");
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
let diagnosticsPollTimer = null;
let kokoroModel = null;
let kokoroModelPromise = null;
let inferenceBackend = "wasm";
let lastProgressByFile = new Map();

globalThis.addEventListener?.("error", (event) => {
  recordUiLog("extension.options.error", { source: "options", kind: errorKind(event.error) });
});
globalThis.addEventListener?.("unhandledrejection", (event) => {
  recordUiLog("extension.options.unhandled-rejection", { source: "options", kind: errorKind(event.reason) });
});

modelChoice.addEventListener("change", async () => {
  if (modelChoice.value === "fish") {
    modelChoice.value = "kokoro";
    await recordUiLog("model.engine.unavailable", { source: "fish-audio" });
    modelStatus.textContent = "Fish Audio’s browser engine is planned, but is not runnable in this build.";
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FREEAIREADER_SYNTHESIZE" && sender?.id === api.runtime.id) {
    synthesizeKokoro(message.text, message.voice, { source: message.source, index: message.index })
      .then((audio) => sendResponse({ ok: true, audioBase64: audio.base64, bytes: audio.bytes, backend: inferenceBackend }))
      .catch(async (error) => {
        await recordUiLog("speech.generation.failed", {
          source: message.source || "reader",
          index: Number(message.index) || 0,
          voiceStyle: message.voice,
          kind: errorKind(error)
        });
        sendResponse({ ok: false, error: error.message || "Speech generation failed." });
      });
    return true;
  }
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
refreshModelStorageStatus();
recordUiLog("app.options.opened").then(refreshDiagnosticLog);
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
      if (/fail|error|interrupt|denied|blocked|fallback|unavailable/i.test(entry.event)) li.dataset.level = "failure";
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

async function refreshModelStorageStatus() {
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const requests = await cache.keys();
    const modelFiles = requests.filter((request) => request.url.includes("Kokoro-82M-v1.0-ONNX"));
    const estimate = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    const used = estimate?.usage ? Math.round(estimate.usage / 1024 / 1024) : null;
    const persistenceHint = persisted === false
      ? " This browser has not guaranteed storage; cleanup or closing a private session may remove it."
      : "";
    modelStatus.textContent = modelFiles.length
      ? "Kokoro model files are stored in this browser cache" + (used === null ? "." : " (" + used + " MB browser storage in use).") + persistenceHint
      : "The Kokoro model has not been prepared in this browser yet.";
  } catch (error) {
    modelStatus.textContent = "Could not inspect browser model storage (" + errorKind(error) + ").";
    await recordUiLog("model.storage.inspect.failed", { kind: errorKind(error) });
  }
}

function handleModelProgress(info) {
  if (!info || typeof info !== "object") return;
  const file = String(info.file || info.name || "model file").split("/").pop().slice(0, 80);
  if (info.status === "initiate") {
    modelStatus.textContent = "Preparing " + file + "…";
    modelProgress.value = 0;
    lastProgressByFile.set(file, 0);
  } else if (info.status === "progress") {
    const percent = Math.max(0, Math.min(100, Number(info.progress) || 0));
    modelProgress.value = percent;
    modelStatus.textContent = "Downloading " + file + " — " + Math.floor(percent) + "%";
    const prior = lastProgressByFile.get(file) ?? -10;
    if (percent >= 100 || percent - prior >= 25) {
      lastProgressByFile.set(file, percent);
      recordUiLog("model.download.progress", { source: file, bytes: Number(info.loaded) || 0, totalBytes: Number(info.total) || 0 });
    }
  } else if (info.status === "done") {
    modelStatus.textContent = "Stored " + file + " in browser cache.";
    recordUiLog("model.file.cached", { source: file });
  } else if (info.status === "ready") {
    modelStatus.textContent = "Kokoro voice model is ready in this browser.";
  }
}

async function ensureKokoroLoaded() {
  if (kokoroModel) return kokoroModel;
  if (kokoroModelPromise) return kokoroModelPromise;
  kokoroModelPromise = (async () => {
    modelStatus.textContent = "Loading Kokoro in the browser…";
    await recordUiLog("model.load.started", { source: MODEL_ID });
    const useWebGpu = Boolean(navigator.gpu) && !/Firefox/i.test(navigator.userAgent);
    const preferredBackend = useWebGpu ? "webgpu" : "wasm";
    try {
      kokoroModel = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: preferredBackend,
        progress_callback: handleModelProgress
      });
      inferenceBackend = preferredBackend;
    } catch (error) {
      if (!useWebGpu) throw error;
      await recordUiLog("model.backend.fallback", { source: "kokoro", backend: "wasm", kind: errorKind(error) });
      modelStatus.textContent = "GPU setup failed; retrying with portable WebAssembly…";
      kokoroModel = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: handleModelProgress
      });
      inferenceBackend = "wasm";
    }
    await recordUiLog("model.load.complete", { source: MODEL_ID, backend: inferenceBackend });
    return kokoroModel;
  })();
  try {
    return await kokoroModelPromise;
  } catch (error) {
    kokoroModel = null;
    await recordUiLog("model.load.failed", { source: MODEL_ID, kind: errorKind(error) });
    throw error;
  } finally {
    kokoroModelPromise = null;
  }
}

async function cacheVoiceAssets() {
  const cache = await caches.open(VOICE_CACHE_NAME);
  for (let index = 0; index < VOICES.length; index += 1) {
    const voice = VOICES[index];
    const url = "https://huggingface.co/" + MODEL_ID + "/resolve/main/voices/" + voice + ".bin";
    try {
      let response = await cache.match(url);
      if (!response) {
        modelStatus.textContent = "Downloading voice " + (index + 1) + " of " + VOICES.length + "…";
        response = await fetch(url);
        if (!response.ok) throw new Error("Voice download returned HTTP " + response.status + ".");
        await cache.put(url, response.clone());
      }
      modelProgress.value = 90 + Math.floor(((index + 1) / VOICES.length) * 10);
      await recordUiLog("model.voice.cached", { source: voice, bytes: Number(response.headers.get("content-length")) || 0 });
    } catch (error) {
      await recordUiLog("model.voice.cache.failed", { source: voice, status: Number(error.status) || 0, kind: errorKind(error) });
      throw new Error("Could not save the " + voice + " voice file: " + error.message);
    }
  }
}

async function prepareKokoro() {
  if (modelChoice.value !== "kokoro") throw new Error("Choose an available browser voice model.");
  try {
    if (navigator.storage?.persist) {
      try {
        const persisted = await navigator.storage.persist();
        if (!persisted) await recordUiLog("model.storage.persistence.denied", { source: "browser" });
      } catch (error) {
        await recordUiLog("model.storage.persistence.failed", { source: "browser", kind: errorKind(error) });
      }
    }
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < 120 * 1024 * 1024) {
      throw new Error("This browser does not report enough free storage for Kokoro’s approximately 92 MB model.");
    }
    await ensureKokoroLoaded();
    const modelCache = await caches.open(MODEL_CACHE_NAME);
    const modelKeys = await modelCache.keys();
    if (!modelKeys.some((request) => request.url.includes("Kokoro-82M-v1.0-ONNX"))) {
      throw new Error("The browser could not persist Kokoro’s model files. Check private browsing storage or browser storage settings.");
    }
    await cacheVoiceAssets();
    modelProgress.value = 100;
    modelStatus.textContent = "Kokoro and the five selected voices are ready in this browser’s local cache.";
    await recordUiLog("model.download.complete", { source: MODEL_ID, backend: inferenceBackend });
    await refreshModelStorageStatus();
  } catch (error) {
    modelStatus.textContent = error.message || "Could not prepare the Kokoro model.";
    await recordUiLog("model.download.failed", { source: MODEL_ID, kind: errorKind(error) });
    throw error;
  }
}

async function audioToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { base64: btoa(binary), bytes: bytes.byteLength };
}

async function synthesizeKokoro(text, voice, details = {}) {
  if (typeof text !== "string" || !text.trim()) throw new Error("There is no text to read.");
  const safeVoice = VOICES.includes(voice) ? voice : DEFAULTS.voiceStyle;
  const startedAt = Date.now();
  try {
    const model = await ensureKokoroLoaded();
    const generated = await model.generate(text.trim(), { voice: safeVoice });
    const blob = generated.toBlob();
    const result = await audioToBase64(blob);
    if (details.source === "voice-sample") {
      if (voiceSample.dataset.objectUrl) URL.revokeObjectURL(voiceSample.dataset.objectUrl);
      const sampleUrl = URL.createObjectURL(blob);
      voiceSample.dataset.objectUrl = sampleUrl;
      voiceSample.src = sampleUrl;
      voiceSample.hidden = false;
    }
    if (details.source !== "voice-sample") {
      await recordUiLog("speech.engine.complete", {
        source: details.source || "reader",
        index: Number(details.index) || 0,
        voiceStyle: safeVoice,
        durationMs: Date.now() - startedAt,
        bytes: result.bytes,
        backend: inferenceBackend
      });
    }
    return { ...result, blob };
  } catch (error) {
    await recordUiLog("speech.engine.failed", {
      source: details.source || "reader",
      index: Number(details.index) || 0,
      voiceStyle: safeVoice,
      durationMs: Date.now() - startedAt,
      kind: errorKind(error)
    });
    throw error;
  }
}

downloadModelButton.addEventListener("click", async () => {
  downloadModelButton.disabled = true;
  clearModelButton.disabled = true;
  modelProgress.value = 0;
  lastProgressByFile = new Map();
  await recordUiLog("model.download.started", { source: MODEL_ID });
  try {
    await prepareKokoro();
  } catch (error) {
    console.error("FreeAIReader could not prepare Kokoro", error);
  } finally {
    downloadModelButton.disabled = false;
    clearModelButton.disabled = false;
    await refreshDiagnosticLog();
  }
});

testVoiceButton.addEventListener("click", async () => {
  testVoiceButton.disabled = true;
  modelStatus.textContent = "Generating a short local voice sample…";
  try {
    await recordUiLog("speech.sample.started", { voiceStyle: document.querySelector("#voice-style").value });
    await synthesizeKokoro("This is a sample of the selected Kokoro voice.", document.querySelector("#voice-style").value, { source: "voice-sample" });
    modelStatus.textContent = "Sample ready. Press play below to hear it.";
    await recordUiLog("speech.sample.complete", { voiceStyle: document.querySelector("#voice-style").value });
  } catch (error) {
    modelStatus.textContent = error.message || "Could not generate the voice sample.";
    await recordUiLog("speech.sample.failed", { voiceStyle: document.querySelector("#voice-style").value, kind: errorKind(error) });
  } finally {
    testVoiceButton.disabled = false;
    await refreshDiagnosticLog();
  }
});

clearModelButton.addEventListener("click", async () => {
  clearModelButton.disabled = true;
  try {
    if (kokoroModel?.model?.dispose) await kokoroModel.model.dispose();
    kokoroModel = null;
    kokoroModelPromise = null;
    await Promise.all([caches.delete(MODEL_CACHE_NAME), caches.delete(VOICE_CACHE_NAME)]);
    modelProgress.value = 0;
    modelStatus.textContent = "Kokoro model files removed from this browser’s local cache.";
    await recordUiLog("model.cache.cleared", { source: MODEL_ID });
  } catch (error) {
    modelStatus.textContent = "Could not remove the model cache (" + errorKind(error) + ").";
    await recordUiLog("model.cache.clear.failed", { source: MODEL_ID, kind: errorKind(error) });
  } finally {
    clearModelButton.disabled = false;
    await refreshDiagnosticLog();
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
  document.querySelector("#buffer-size").value = settings.bufferSize;
  document.querySelector("#voice-style").value = VOICES.includes(settings.voiceStyle) ? settings.voiceStyle : DEFAULTS.voiceStyle;
  document.querySelector("#save-audio").checked = Boolean(settings.saveAudio);
  document.querySelector("#save-folder").value = settings.saveFolder;
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
    const saveFolder = sanitizeFolder(document.querySelector("#save-folder").value);
    const settings = {
      bufferSize: Math.max(1, Math.min(20, Number(document.querySelector("#buffer-size").value) || 5)),
      voiceStyle: document.querySelector("#voice-style").value,
      saveAudio,
      saveFolder
    };
    await api.storage.local.set(settings);
    status.textContent = "Settings saved on this device.";
    await recordUiLog("settings.saved", { bufferSize: settings.bufferSize, voiceStyle: settings.voiceStyle });
  } catch (error) {
    status.textContent = error.message;
    await recordUiLog("settings.save.failed", { kind: errorKind(error) });
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

function sanitizeFolder(value) {
  return value.trim().replace(/\\/g, "/").split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
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
