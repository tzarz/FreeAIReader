const api = globalThis.browser ?? globalThis.chrome;
const menus = api.contextMenus ?? api.menus;

const DEFAULTS = {
  serverUrl: "http://127.0.0.1:8080",
  bufferSize: 5,
  voiceStyle: "natural",
  saveAudio: false,
  saveFolder: "FreeAIReader",
  referenceAudio: "",
  referenceTranscript: ""
};

const DIAGNOSTIC_LOG_KEY = "diagnosticLog";
const LOG_LIMIT = 500;
const MODELS = {
  "fish-speech-1.5": {
    label: "Fish Speech 1.5",
    repo: "fishaudio/fish-speech-1.5",
    folder: "fish-speech-1.5",
    files: ["README.md", "config.json", "firefly-gan-vq-fsq-8x1024-21hz-generator.pth", "model.pth", "special_tokens.json", "tokenizer.tiktoken"]
  },
  "s2-pro": {
    label: "Fish Audio S2 Pro",
    repo: "fishaudio/s2-pro",
    folder: "s2-pro",
    files: [
      "LICENSE.md",
      "README.md",
      "chat_template.jinja",
      "codec.pth",
      "config.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "model.safetensors.index.json",
      "special_tokens_map.json",
      "tokenizer.json",
      "tokenizer_config.json"
    ]
  }
};

const VOICES = {
  natural: "[clear, natural, steady narrator]",
  warm: "[warm, close, relaxed narrator]",
  bright: "[bright, expressive, upbeat narrator]",
  calm: "[calm, gentle, unhurried narrator]",
  storyteller: "[expressive storyteller, varied pacing]"
};

const sessions = new Map();
let storageQueue = Promise.resolve();

function safeLogDetails(details = {}) {
  const allowed = new Set([
    "source", "index", "durationMs", "bytes", "status", "kind", "reason",
    "files", "totalBytes", "completedFiles", "totalFiles", "voiceStyle", "bufferSize"
  ]);
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = Math.max(0, Math.round(value));
    else if (typeof value === "boolean") safe[key] = value;
    else if (typeof value === "string") safe[key] = value.slice(0, 80).replace(/[\r\n\t]/g, " ");
  }
  return safe;
}

function recordLog(event, details = {}) {
  const task = storageQueue.then(async () => {
    const stored = await api.storage.local.get({ [DIAGNOSTIC_LOG_KEY]: [] });
    const log = Array.isArray(stored[DIAGNOSTIC_LOG_KEY]) ? stored[DIAGNOSTIC_LOG_KEY] : [];
    log.push({ time: new Date().toISOString(), event: String(event).slice(0, 60), ...safeLogDetails(details) });
    await api.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: log.slice(-LOG_LIMIT) });
  });
  storageQueue = task.catch((error) => console.error("FreeAIReader diagnostic log write failed", error));
  return task;
}

function errorKind(error) {
  return error?.name === "TypeError" ? "network-or-type" : String(error?.name || "unknown").slice(0, 40);
}

function isExtensionPage(sender) {
  if (sender?.id !== api.runtime.id) return false;
  const senderUrl = sender.url || sender.originUrl || sender.documentUrl;
  if (!senderUrl) return false;
  try {
    return new URL(senderUrl).origin === new URL(api.runtime.getURL("/")).origin;
  } catch {
    return false;
  }
}

function storageGet(defaults) {
  return api.storage.local.get(defaults);
}

function createMenus() {
  menus.removeAll(() => {
    menus.create({ id: "freeaireader-top", title: "Read from the top", contexts: ["page"] });
    menus.create({ id: "freeaireader-here", title: "Read from here", contexts: ["page", "selection", "link"] });
    menus.create({ id: "freeaireader-selection", title: "Read selection", contexts: ["selection"] });
    menus.create({ id: "freeaireader-stop", title: "Stop FreeAIReader", contexts: ["page"] });
  });
}

api.runtime.onInstalled.addListener(async () => {
  try {
    const saved = await api.storage.local.get(null);
    await api.storage.local.set({ ...DEFAULTS, ...saved });
    createMenus();
    await recordLog("app.installed");
  } catch (error) {
    console.error("FreeAIReader install setup failed", error);
  }
});

api.runtime.onStartup?.addListener(createMenus);
api.action?.onClicked.addListener(() => api.runtime.openOptionsPage());

api.downloads?.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
  try {
    const job = (await api.storage.local.get({ modelDownloadJob: null })).modelDownloadJob;
    const item = job?.files?.find((file) => file.id === delta.id);
    if (item) {
      const [download] = await api.downloads.search({ id: delta.id });
      const bytes = download?.bytesReceived ?? item.size;
      await recordLog(delta.state.current === "complete" ? "model.file.complete" : "model.file.failed", {
        source: item.name,
        bytes,
        kind: delta.error?.current || (delta.state.current === "interrupted" ? "interrupted" : "")
      });
      return;
    }
    const saved = await api.storage.local.get({ pendingAudioDownloads: [] });
    const pending = Array.isArray(saved.pendingAudioDownloads) ? saved.pendingAudioDownloads : [];
    const audioItem = pending.find((file) => file.id === delta.id);
    if (audioItem) {
      const [download] = await api.downloads.search({ id: delta.id });
      await recordLog(delta.state.current === "complete" ? "audio.save.complete" : "audio.save.failed", {
        source: "wav",
        index: audioItem.index,
        bytes: download?.bytesReceived ?? 0,
        kind: delta.error?.current || (delta.state.current === "interrupted" ? "interrupted" : "")
      });
      await api.storage.local.set({ pendingAudioDownloads: pending.filter((file) => file.id !== delta.id) });
    }
  } catch (error) {
    console.error("FreeAIReader could not record a download result", error);
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "FREEAIREADER_LOG") {
    const allowedContentEvents = new Set([
      "page.extract.failed", "playback.prepare.failed", "playback.started", "playback.complete",
      "playback.stopped", "playback.failed", "playback.autoplay.blocked"
    ]);
    if (!isExtensionPage(sender) && (!sender?.tab || !allowedContentEvents.has(message.event))) return false;
    const details = isExtensionPage(sender) ? message.details : { ...message.details, source: "webpage" };
    recordLog(message.event, details).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (!isExtensionPage(sender)) return false;
  if (message?.type === "FREEAIREADER_GET_LOG") {
    api.storage.local.get({ [DIAGNOSTIC_LOG_KEY]: [] })
      .then((result) => sendResponse({ entries: result[DIAGNOSTIC_LOG_KEY] ?? [] }))
      .catch((error) => sendResponse({ error: errorKind(error) }));
    return true;
  }
  if (message?.type === "FREEAIREADER_CLEAR_LOG") {
    api.storage.local.set({ [DIAGNOSTIC_LOG_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: errorKind(error) }));
    return true;
  }
  if (message?.type === "FREEAIREADER_START_MODEL_DOWNLOAD") {
    startModelDownload(message.modelKey || "fish-speech-1.5").then(sendResponse).catch(async (error) => {
      await recordLog("model.download.failed", { status: error.status || 0, kind: errorKind(error) });
      sendResponse({ error: error.message || "Could not start model download." });
    });
    return true;
  }
  if (message?.type === "FREEAIREADER_GET_MODEL_DOWNLOAD") {
    getModelDownloadStatus().then(sendResponse).catch((error) => sendResponse({ error: errorKind(error) }));
    return true;
  }
  if (message?.type === "FREEAIREADER_CANCEL_MODEL_DOWNLOAD") {
    cancelModelDownload().then(sendResponse).catch((error) => sendResponse({ error: errorKind(error) }));
    return true;
  }
  return false;
});

async function startModelDownload(modelKey = "fish-speech-1.5") {
  if (!api.downloads) throw new Error("This browser does not provide the Downloads API.");
  const model = MODELS[modelKey];
  if (!model) throw new Error("Choose a supported Fish Audio model.");
  const permission = { permissions: ["downloads"] };
  if (!(await api.permissions.contains(permission))) throw new Error("Allow Downloads permission first.");
  const old = (await api.storage.local.get({ modelDownloadJob: null })).modelDownloadJob;
  if (old?.files?.some((file) => file.id && ["in_progress", "queued"].includes(file.state))) {
    throw new Error("A model download is already running.");
  }

  await recordLog("model.list.fetch.started", { source: model.repo });
  const listingResponse = await fetch(`https://huggingface.co/api/models/${model.repo}?blobs=true`);
  if (!listingResponse.ok) {
    const error = new Error(`Could not read Fish Audio's model listing (${listingResponse.status}).`);
    error.status = listingResponse.status;
    throw error;
  }
  const listing = await listingResponse.json();
  if (listing.id !== model.repo || listing.private || listing.gated) {
    throw new Error("Fish Audio's model listing is private or gated. Check the official model page and license terms.");
  }
  const siblings = new Map((listing.siblings || []).map((file) => [file.rfilename, file]));
  const missing = model.files.filter((name) => !siblings.has(name));
  if (missing.length) throw new Error(`Official model listing is missing required files: ${missing.join(", ")}`);
  const files = model.files.map((name) => ({ name, size: Number(siblings.get(name).size) || 0, id: null, state: "starting" }));
  const job = { modelKey, label: model.label, repo: model.repo, folder: `FreeAIReader/models/${model.folder}`, sha: String(listing.sha || "").slice(0, 40), startedAt: new Date().toISOString(), files };
  await api.storage.local.set({ modelDownloadJob: job });
  await recordLog("model.download.started", {
    source: model.repo,
    files: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
  });

  for (const file of files) {
    const url = `https://huggingface.co/${model.repo}/resolve/${encodeURIComponent(job.sha || "main")}/${file.name}?download=true`;
    try {
      file.id = await api.downloads.download({
        url,
        filename: `${job.folder}/${file.name}`,
        saveAs: false,
        conflictAction: "overwrite"
      });
      file.state = "queued";
      await api.storage.local.set({ modelDownloadJob: job });
      await recordLog("model.file.queued", { source: file.name, bytes: file.size });
    } catch (error) {
      file.state = "failed-to-start";
      file.error = errorKind(error);
      await api.storage.local.set({ modelDownloadJob: job });
      await recordLog("model.file.failed", { source: file.name, kind: errorKind(error) });
    }
  }
  return { ok: true, status: await getModelDownloadStatus() };
}

async function getModelDownloadStatus() {
  const job = (await api.storage.local.get({ modelDownloadJob: null })).modelDownloadJob;
  if (!job) return { job: null };
  for (const file of job.files) {
    if (!file.id) continue;
    try {
      const [download] = await api.downloads.search({ id: file.id });
      if (download) {
        file.state = download.state;
        file.bytesReceived = Math.max(0, download.bytesReceived || 0);
        file.error = download.error || "";
      }
    } catch { /* The saved status remains visible if the browser removed its download history. */ }
  }
  const totalBytes = job.files.reduce((sum, file) => sum + file.size, 0);
  const receivedBytes = job.files.reduce((sum, file) => sum + Math.min(file.bytesReceived || (file.state === "complete" ? file.size : 0), file.size), 0);
  const completedFiles = job.files.filter((file) => file.state === "complete").length;
  const running = job.files.some((file) => ["queued", "in_progress"].includes(file.state));
  const status = running ? "downloading"
    : completedFiles === job.files.length ? "complete"
    : job.files.some((file) => ["interrupted", "failed-to-start"].includes(file.state)) ? "needs-attention"
    : "queued";
  await api.storage.local.set({ modelDownloadJob: job });
  return { job: { ...job, status, totalBytes, receivedBytes, completedFiles } };
}

async function cancelModelDownload() {
  const job = (await api.storage.local.get({ modelDownloadJob: null })).modelDownloadJob;
  if (!job) return { ok: true };
  for (const file of job.files) {
    if (file.id && ["queued", "in_progress"].includes(file.state)) {
      try { await api.downloads.cancel(file.id); } catch { /* It may have finished between status checks. */ }
    }
  }
  await recordLog("model.download.cancelled", { source: job.modelKey || job.repo });
  return { ok: true, status: await getModelDownloadStatus() };
}

api.runtime.onConnect.addListener((port) => {
  if (port.name !== "freeaireader-session") return;
  const key = sessionKey(port.sender);
  if (key === undefined) return;
  const session = sessions.get(key);
  if (!session) {
    port.disconnect();
    return;
  }
  session.keepAlivePort = port;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    if (session.keepAlivePort === port) session.keepAlivePort = null;
    if (sessions.get(key) === session) stopSession(key, false);
  });
});

menus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === "freeaireader-stop") {
    stopSession(tab.id);
    return;
  }
  const mode = info.menuItemId === "freeaireader-selection"
    ? "selection"
    : info.menuItemId === "freeaireader-here" ? "here" : "top";
  let extracted;
  try {
    extracted = await api.tabs.sendMessage(tab.id, {
      type: "FREEAIREADER_EXTRACT",
      mode,
      x: info.pageX,
      y: info.pageY,
      selectionText: info.selectionText ?? ""
    });
  } catch {
    await recordLog("page.extract.failed", { source: mode, kind: "content-script-unavailable" });
    const pdfUrl = findPdfUrl([tab.url, info.pageUrl, info.frameUrl, info.linkUrl]);
    if (pdfUrl) {
      try {
        await openPdfReader(pdfUrl);
      } catch (error) {
        await recordLog("pdf.open.failed", { source: mode, kind: errorKind(error) });
        notifyTab(tab.id, `Could not open this PDF: ${error.message}`);
      }
      return;
    }
    notifyTab(tab.id, "This page blocks extension text access. Use the PDF reader in FreeAIReader for PDF files.");
    return;
  }
  if (!extracted?.text?.trim()) {
    await recordLog("page.extract.empty", { source: mode });
    const pdfUrl = findPdfUrl([tab.url, info.pageUrl, info.frameUrl, info.linkUrl]);
    if (pdfUrl) {
      try {
        await openPdfReader(pdfUrl);
      } catch (error) {
        await recordLog("pdf.open.failed", { source: mode, kind: errorKind(error) });
        notifyTab(tab.id, `Could not open this PDF: ${error.message}`);
      }
      return;
    }
    notifyTab(tab.id, "No readable text was found on this page.");
    return;
  }
  try {
    await startReading(tab.id, tab.id, extracted.text, mode, "tab");
  } catch (error) {
    await recordLog("reading.start.failed", { source: mode, kind: errorKind(error) });
    notifyTab(tab.id, `Could not start reading: ${error.message}`);
  }
});

function findPdfUrl(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (["http:", "https:"].includes(url.protocol) && url.pathname.toLowerCase().endsWith(".pdf")) return url.href;
      if (["chrome-extension:", "moz-extension:"].includes(url.protocol)) {
        for (const key of ["src", "file", "url", "pdf"]) {
          const nested = url.searchParams.get(key);
          if (nested) {
            const result = findPdfUrl([nested]);
            if (result) return result;
          }
        }
      }
    } catch {
      // Ignore URLs that are absent or malformed.
    }
  }
  return null;
}

async function openPdfReader(pdfUrl) {
  const handoffId = crypto.randomUUID();
  const handoffKey = `freeaireader-pdf-${handoffId}`;
  await api.storage.session.set({ [handoffKey]: pdfUrl });
  await api.tabs.create({ url: `${api.runtime.getURL("options.html")}?readPdf=${handoffId}` });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const key = sessionKey(sender);
  const target = sender.url?.startsWith(api.runtime.getURL("")) ? "extension" : "tab";
  if (message?.type === "FREEAIREADER_START_TEXT" && key !== undefined) {
    startReading(key, sender.tab?.id, message.text ?? "", message.source ?? "document", target)
      .then(() => sendResponse({ started: true }))
      .catch(async (error) => {
        await recordLog("reading.start.failed", { source: message.source ?? "document", kind: errorKind(error) });
        sendResponse({ error: error.message });
      });
    return true;
  }
  if (message?.type === "FREEAIREADER_CHUNK_PLAYED" && key !== undefined) {
    acknowledgeChunk(key, message.sessionId, message.index);
  }
  if (message?.type === "FREEAIREADER_STOP" && key !== undefined) {
    stopSession(key);
  }
  return false;
});

function sessionKey(sender) {
  if (!sender) return undefined;
  const extensionPage = sender.url?.startsWith(api.runtime.getURL("")) ?? false;
  if (extensionPage) return `extension:${sender.tab?.id ?? sender.documentId ?? sender.url}`;
  return sender.tab?.id;
}

function notifyTab(tabId, text) {
  api.tabs.sendMessage(tabId, { type: "FREEAIREADER_STATUS", text }).catch(() => {});
}

function sentenceList(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
    return [...segmenter.segment(normalized)]
      .map((part) => part.segment.trim())
      .filter(Boolean);
  }
  return normalized.match(/[^.!?。！？]+[.!?。！？]*|[^.!?。！？]+$/g)
    ?.map((part) => part.trim())
    .filter(Boolean) ?? [normalized];
}

async function startReading(key, tabId, text, source, target) {
  stopSession(key);
  const sentences = sentenceList(text);
  text = "";
  if (!sentences.length) {
    await recordLog("reading.empty", { source });
    const message = { type: "FREEAIREADER_STATUS", text: "No readable text was found.", target };
    const delivery = target === "extension" ? api.runtime.sendMessage(message) : api.tabs.sendMessage(tabId, message);
    delivery.catch(() => {});
    return;
  }

  const settings = await storageGet(DEFAULTS);
  const session = {
    id: crypto.randomUUID(),
    key,
    tabId,
    source,
    sentences,
    nextIndex: 0,
    outstanding: 0,
    acknowledged: new Set(),
    bufferSize: Math.min(20, Math.max(1, Number(settings.bufferSize) || DEFAULTS.bufferSize)),
    settings,
    target,
    cancelled: false,
    filling: false
  };
  sessions.set(key, session);
  await recordLog("reading.started", { source, files: sentences.length, bufferSize: session.bufferSize, voiceStyle: settings.voiceStyle });
  await sendToSession(session, { type: "FREEAIREADER_STATUS", text: `Preparing speech (${sentences.length} sentences)…` });
  fillBuffer(session);
}

function stopSession(key, sendStop = true) {
  const current = sessions.get(key);
  if (!current) return;
  current.cancelled = true;
  current.sentences.length = 0;
  sessions.delete(key);
  recordLog("reading.stopped", { source: current.source, index: current.nextIndex });
  current.keepAlivePort?.disconnect();
  sendToSession(current, { type: "FREEAIREADER_STOP" }).catch(() => {});
  if (sendStop) sendToSession(current, { type: "FREEAIREADER_STATUS", text: "Reading stopped." }).catch(() => {});
}

function acknowledgeChunk(key, sessionId, index) {
  const session = sessions.get(key);
  if (!session || session.id !== sessionId || session.acknowledged.has(index)) return;
  session.acknowledged.add(index);
  session.outstanding = Math.max(0, session.outstanding - 1);
  fillBuffer(session);
  finishIfDone(session);
}

async function fillBuffer(session) {
  if (session.filling || session.cancelled) return;
  session.filling = true;
  try {
    while (!session.cancelled && session.sentences.length && session.outstanding < session.bufferSize) {
      let sentence = session.sentences.shift();
      const index = session.nextIndex++;
      const audio = await synthesize(sentence, session.settings, index, session);
      if (session.cancelled) return;
      sentence = "";
      if (session.settings.saveAudio) {
        try {
          await saveAudio(audio, session.settings, index, session.id);
        } catch (error) {
          await recordLog("audio.save.failed", { source: session.source, index: index + 1, kind: errorKind(error) });
          sendToSession(session, { type: "FREEAIREADER_STATUS", text: `Could not save this sentence: ${error.message}` }).catch(() => {});
        }
      }
      session.outstanding += 1;
      await sendToSession(session, {
        type: "FREEAIREADER_PLAY_CHUNK",
        sessionId: session.id,
        index,
        audioBase64: audio,
        mimeType: "audio/wav"
      });
    }
  } catch (error) {
    if (!session.cancelled) {
      await recordLog("reading.failed", { source: session.source, index: session.nextIndex, kind: errorKind(error) });
      sendToSession(session, { type: "FREEAIREADER_STATUS", text: `Speech generation failed: ${error.message}` }).catch(() => {});
      stopSession(session.key, false);
    }
  } finally {
    session.filling = false;
    finishIfDone(session);
  }
}

function finishIfDone(session) {
  if (session.cancelled || session.sentences.length || session.outstanding || session.filling) return;
  if (sessions.get(session.key) !== session) return;
  sessions.delete(session.key);
  recordLog("reading.finished", { source: session.source, files: session.nextIndex });
  sendToSession(session, { type: "FREEAIREADER_STATUS", text: "Reading finished." }).catch(() => {});
}

function sendToSession(session, message) {
  const outgoing = { ...message, sessionId: session.id, target: session.target };
  const delivery = session.target === "extension"
    ? api.runtime.sendMessage(outgoing)
    : api.tabs.sendMessage(session.tabId, outgoing);
  return delivery.catch(() => {});
}

async function synthesize(sentence, settings, index, session) {
  const base = String(settings.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, "");
  const style = VOICES[settings.voiceStyle] || VOICES.natural;
  const references = settings.referenceAudio && settings.referenceTranscript
    ? [{ audio: settings.referenceAudio, text: settings.referenceTranscript }]
    : [];
  const startedAt = Date.now();
  await recordLog("speech.generation.started", { source: session.source, index: index + 1 });
  try {
    const response = await fetch(`${base}/v1/tts?format=json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "audio/wav" },
      body: JSON.stringify({
        text: `${style} ${sentence}`,
        references,
        format: "wav",
        streaming: false,
        normalize: true,
        top_p: 0.8,
        repetition_penalty: 1.1,
        temperature: 0.8
      })
    });
    if (!response.ok) {
      const error = new Error(`Fish Speech returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const block = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += block) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
    }
    await recordLog("speech.generation.complete", {
      source: session.source,
      index: index + 1,
      durationMs: Date.now() - startedAt,
      bytes: bytes.byteLength
    });
    return btoa(binary);
  } catch (error) {
    await recordLog("speech.generation.failed", {
      source: session.source,
      index: index + 1,
      durationMs: Date.now() - startedAt,
      status: error.status || 0,
      kind: errorKind(error)
    });
    throw error;
  }
}

async function saveAudio(audioBase64, settings, index, sessionId) {
  const folder = String(settings.saveFolder || "").trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const name = `FreeAIReader-${sessionId.slice(0, 8)}-${String(index + 1).padStart(4, "0")}.wav`;
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
  const blob = new Blob([bytes], { type: "audio/wav" });
  let objectUrl = null;
  try {
    objectUrl = URL.createObjectURL(blob);
  } catch {
    // Chrome extension service workers do not expose Blob URL creation.
  }
  const url = objectUrl ?? `data:audio/wav;base64,${audioBase64}`;
  let downloadId;
  const releaseUrl = (delta) => {
    if (objectUrl && downloadId === delta.id && (delta.state?.current === "complete" || delta.state?.current === "interrupted")) {
      api.downloads.onChanged.removeListener(releaseUrl);
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  };
  if (objectUrl) api.downloads.onChanged.addListener(releaseUrl);
  try {
    downloadId = await api.downloads.download({
      url,
      filename: folder ? `${folder}/${name}` : name,
      saveAs: false,
      conflictAction: "uniquify"
    });
    const stored = await api.storage.local.get({ pendingAudioDownloads: [] });
    const pending = Array.isArray(stored.pendingAudioDownloads) ? stored.pendingAudioDownloads : [];
    pending.push({ id: downloadId, index: index + 1 });
    await api.storage.local.set({ pendingAudioDownloads: pending });
    await recordLog("audio.save.queued", { source: "wav", index: index + 1, bytes: bytes.byteLength });
  } catch (error) {
    if (objectUrl) {
      api.downloads.onChanged.removeListener(releaseUrl);
      URL.revokeObjectURL(objectUrl);
    }
    throw error;
  }
  if (objectUrl) {
    const [item] = await api.downloads.search({ id: downloadId });
    if (item?.state === "complete" || item?.state === "interrupted") {
      api.downloads.onChanged.removeListener(releaseUrl);
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }
}
