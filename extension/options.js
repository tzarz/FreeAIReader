const api = globalThis.browser ?? globalThis.chrome;
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

loadSettings();

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
  } catch (error) {
    status.textContent = error.message;
  }
});

document.querySelector("#remove-voice").addEventListener("click", async () => {
  await api.storage.local.set({ referenceAudio: "", referenceTranscript: "" });
  document.querySelector("#voice-transcript").value = "";
  document.querySelector("#keep-voice").checked = false;
  document.querySelector("#remove-voice").hidden = true;
  status.textContent = "Saved reference voice removed.";
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
  } catch (error) {
    pdfStatus.textContent = error.message;
  } finally {
    readPdfButton.disabled = false;
  }
});

document.querySelector("#stop-reading").addEventListener("click", async () => {
  stopLocalPlayback();
  await api.runtime.sendMessage({ type: "FREEAIREADER_STOP" });
  pdfStatus.textContent = "Reading stopped.";
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
  if (activeSessionId && activeSessionId !== message.sessionId) stopLocalPlayback();
  activeSessionId = message.sessionId;
  const binary = atob(message.audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: message.mimeType || "audio/wav" }));
  playbackQueue.push({ ...message, objectUrl });
  pumpLocalPlayback();
}

async function pumpLocalPlayback() {
  if (isPlaying || !playbackQueue.length) return;
  isPlaying = true;
  const item = playbackQueue.shift();
  currentObjectUrl = item.objectUrl;
  const player = new Audio(currentObjectUrl);
  currentPlayer = player;
  try {
    const started = await playWithActivation(player);
    if (!started) return;
    await new Promise((resolve, reject) => {
      stopPlaybackPromise = resolve;
      player.addEventListener("ended", resolve, { once: true });
      player.addEventListener("error", () => reject(new Error("The browser could not play this audio.")), { once: true });
    });
  } catch (error) {
    pdfStatus.textContent = `Playback needs attention: ${error.message}`;
  } finally {
    player.pause();
    player.removeAttribute("src");
    URL.revokeObjectURL(item.objectUrl);
    currentPlayer = null;
    currentObjectUrl = null;
    stopPlaybackPromise = null;
    api.runtime.sendMessage({ type: "FREEAIREADER_CHUNK_PLAYED", sessionId: item.sessionId, index: item.index });
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
