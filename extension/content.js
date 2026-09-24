const api = globalThis.browser ?? globalThis.chrome;
const playbackQueue = [];
let playing = false;
let activeSessionId = null;
let statusNode = null;
let activePlayer = null;
let stopPlaybackPromise = null;
let pendingStartResolve = null;
let lastContextPoint = null;
let keepAlivePort = null;
let keepAliveTimer = null;
let statusTextNode = null;
let statusActionNode = null;

document.addEventListener("contextmenu", (event) => {
  lastContextPoint = { x: event.clientX, y: event.clientY };
}, true);

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "extension") return false;
  if (message?.type === "FREEAIREADER_EXTRACT") {
    try {
      sendResponse(extractText(message));
    } catch (error) {
      recordContentLog("page.extract.failed", { kind: errorKind(error) });
      sendResponse({ text: "" });
    }
    return false;
  }
  if (message?.type === "FREEAIREADER_PLAY_CHUNK") {
    enqueueAudio(message);
  }
  if (message?.type === "FREEAIREADER_STATUS") {
    showStatus(message.text);
    if (message.text.startsWith("Preparing speech")) beginKeepAlive();
    if (/Reading finished|Reading stopped|Speech generation failed/.test(message.text)) endKeepAlive();
  }
  if (message?.type === "FREEAIREADER_STOP") {
    stopPlayback();
  }
  return false;
});

function extractText({ mode, x, y, selectionText }) {
  if (mode === "selection") return { text: (selectionText || getSelection()?.toString() || "").trim() };
  if (mode === "here") {
    const point = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : lastContextPoint;
    const element = point ? document.elementFromPoint(point.x, point.y) : null;
    const block = element?.closest("p, li, blockquote, h1, h2, h3, h4, pre, td, figcaption") ?? element;
    const root = document.querySelector("article, main, [role='main']") ?? document.body;
    const blocks = [...root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre, td, figcaption")]
      .filter(isReadable);
    const selected = blocks.indexOf(block);
    if (selected >= 0) return { text: blocks.slice(selected).map((node) => node.innerText).join("\n") };
    if (block && root.contains(block)) return { text: `${block.innerText || ""}\n${root.innerText || ""}` };
  }
  const root = document.querySelector("article, main, [role='main']") ?? document.body;
  return { text: root?.innerText ?? "" };
}

function isReadable(node) {
  const style = getComputedStyle(node);
  return style.display !== "none" && style.visibility !== "hidden" && node.innerText?.trim();
}

function enqueueAudio(message) {
  try {
    if (activeSessionId && activeSessionId !== message.sessionId) stopPlayback();
    activeSessionId = message.sessionId;
    const binary = atob(message.audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const url = URL.createObjectURL(new Blob([bytes], { type: message.mimeType || "audio/wav" }));
    playbackQueue.push({ ...message, url });
    pumpPlayback();
  } catch (error) {
    showStatus(`Could not prepare audio playback: ${error.message}`);
    recordContentLog("playback.prepare.failed", { index: Number(message.index) + 1, kind: errorKind(error) });
    api.runtime.sendMessage({ type: "FREEAIREADER_CHUNK_PLAYED", sessionId: message.sessionId, index: message.index }).catch(() => {});
  }
}

async function pumpPlayback() {
  if (playing || !playbackQueue.length) return;
  playing = true;
  const item = playbackQueue.shift();
  const player = new Audio(item.url);
  activePlayer = player;
  const playbackStartedAt = Date.now();
  let finishReason = "complete";
  try {
    const started = await playWithActivation(player);
    if (!started) {
      finishReason = "stopped";
      return;
    }
    recordContentLog("playback.started", { index: item.index + 1 });
    await new Promise((resolve, reject) => {
      stopPlaybackPromise = () => { finishReason = "stopped"; resolve(); };
      player.addEventListener("ended", resolve, { once: true });
      player.addEventListener("error", () => reject(new Error("The browser could not play this audio.")), { once: true });
    });
  } catch (error) {
    finishReason = "failed";
    showStatus(`Playback needs attention: ${error.message}`);
    recordContentLog("playback.failed", { index: item.index + 1, durationMs: Date.now() - playbackStartedAt, kind: errorKind(error) });
  } finally {
    if (finishReason !== "failed") recordContentLog(`playback.${finishReason}`, { index: item.index + 1, durationMs: Date.now() - playbackStartedAt });
    player.pause();
    player.removeAttribute("src");
    URL.revokeObjectURL(item.url);
    api.runtime.sendMessage({
      type: "FREEAIREADER_CHUNK_PLAYED",
      sessionId: item.sessionId,
      index: item.index
    }).catch(() => {});
    activePlayer = null;
    stopPlaybackPromise = null;
    playing = false;
    pumpPlayback();
  }
}

function stopPlayback() {
  for (const item of playbackQueue.splice(0)) URL.revokeObjectURL(item.url);
  pendingStartResolve?.(false);
  pendingStartResolve = null;
  if (statusActionNode) statusActionNode.hidden = true;
  if (activePlayer) {
    activePlayer.pause();
    activePlayer.removeAttribute("src");
    stopPlaybackPromise?.();
    activePlayer = null;
  }
  activeSessionId = null;
  endKeepAlive();
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

function showStatus(message) {
  if (!statusNode?.isConnected) {
    statusNode = document.createElement("div");
    statusNode.setAttribute("role", "status");
    Object.assign(statusNode.style, {
      position: "fixed", zIndex: "2147483647", right: "16px", bottom: "16px",
      maxWidth: "min(420px, calc(100vw - 32px))", padding: "12px 16px",
      borderRadius: "10px", background: "#154734", color: "#fff",
      font: "14px/1.4 system-ui, sans-serif", boxShadow: "0 4px 18px #0005"
    });
    statusTextNode = document.createElement("span");
    statusActionNode = document.createElement("button");
    statusActionNode.type = "button";
    statusActionNode.textContent = "Start audio";
    statusActionNode.hidden = true;
    Object.assign(statusActionNode.style, {
      marginLeft: "10px", padding: "6px 10px", border: "0", borderRadius: "6px",
      background: "#d9f2df", color: "#154734", font: "600 12px system-ui, sans-serif", cursor: "pointer"
    });
    statusNode.append(statusTextNode, statusActionNode);
    document.documentElement.append(statusNode);
  }
  statusTextNode.textContent = `FreeAIReader · ${message}`;
  statusNode.hidden = false;
  clearTimeout(statusNode.hideTimer);
  if (statusActionNode.hidden) statusNode.hideTimer = setTimeout(() => { if (statusNode) statusNode.hidden = true; }, 7000);
}

async function playWithActivation(player) {
  try {
    await player.play();
    return true;
  } catch (error) {
    if (error.name !== "NotAllowedError") throw error;
    recordContentLog("playback.autoplay.blocked");
    showStatus("Click Start audio to allow playback.");
    statusActionNode.hidden = false;
    return new Promise((resolve) => {
      pendingStartResolve = resolve;
      statusActionNode.onclick = async () => {
        try {
          await player.play();
          statusActionNode.hidden = true;
          pendingStartResolve = null;
          showStatus("Reading aloud.");
          resolve(true);
        } catch (retryError) {
          showStatus(`Playback needs attention: ${retryError.message}`);
          recordContentLog("playback.failed", { kind: errorKind(retryError) });
          const resolveStart = pendingStartResolve;
          pendingStartResolve = null;
          resolveStart?.(false);
        }
      };
    });
  }
}

function errorKind(error) {
  return error?.name === "TypeError" ? "network-or-type" : String(error?.name || "unknown").slice(0, 40);
}

function recordContentLog(event, details = {}) {
  api.runtime.sendMessage({ type: "FREEAIREADER_LOG", event, details }).catch(() => {});
}
