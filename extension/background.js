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

const VOICES = {
  natural: "[clear, natural, steady narrator]",
  warm: "[warm, close, relaxed narrator]",
  bright: "[bright, expressive, upbeat narrator]",
  calm: "[calm, gentle, unhurried narrator]",
  storyteller: "[expressive storyteller, varied pacing]"
};

const sessions = new Map();

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
  const saved = await api.storage.local.get(null);
  await api.storage.local.set({ ...DEFAULTS, ...saved });
  createMenus();
});

api.runtime.onStartup?.addListener(createMenus);
api.action?.onClicked.addListener(() => api.runtime.openOptionsPage());

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
    notifyTab(tab.id, "This page blocks extension text access. Use the PDF reader in FreeAIReader for PDF files.");
    return;
  }
  if (!extracted?.text?.trim()) {
    notifyTab(tab.id, "No readable text was found on this page.");
    return;
  }
  await startReading(tab.id, tab.id, extracted.text, mode, "tab");
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const key = sessionKey(sender);
  const target = sender.url?.startsWith(api.runtime.getURL("")) ? "extension" : "tab";
  if (message?.type === "FREEAIREADER_START_TEXT" && key !== undefined) {
    startReading(key, sender.tab?.id, message.text ?? "", message.source ?? "document", target)
      .then(() => sendResponse({ started: true }))
      .catch((error) => sendResponse({ error: error.message }));
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
  await sendToSession(session, { type: "FREEAIREADER_STATUS", text: `Preparing speech (${sentences.length} sentences)…` });
  fillBuffer(session);
}

function stopSession(key, sendStop = true) {
  const current = sessions.get(key);
  if (!current) return;
  current.cancelled = true;
  current.sentences.length = 0;
  sessions.delete(key);
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
      const audio = await synthesize(sentence, session.settings);
      if (session.cancelled) return;
      sentence = "";
      if (session.settings.saveAudio) {
        try {
          await saveAudio(audio, session.settings, index, session.id);
        } catch (error) {
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
  sendToSession(session, { type: "FREEAIREADER_STATUS", text: "Reading finished." }).catch(() => {});
}

function sendToSession(session, message) {
  const outgoing = { ...message, sessionId: session.id, target: session.target };
  const delivery = session.target === "extension"
    ? api.runtime.sendMessage(outgoing)
    : api.tabs.sendMessage(session.tabId, outgoing);
  return delivery.catch(() => {});
}

async function synthesize(sentence, settings) {
  const base = String(settings.serverUrl || DEFAULTS.serverUrl).replace(/\/+$/, "");
  const style = VOICES[settings.voiceStyle] || VOICES.natural;
  const references = settings.referenceAudio && settings.referenceTranscript
    ? [{ audio: settings.referenceAudio, text: settings.referenceTranscript }]
    : [];
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
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Fish Speech returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const block = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += block) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + block));
  }
  return btoa(binary);
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
