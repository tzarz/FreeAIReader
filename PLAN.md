# FreeAIReader project plan

## Product goal

Build **FreeAIReader**, a free, ad-free cross-browser reader that speaks webpages and PDFs. Speech generation, model loading, and audio playback must run inside the browser extension using JavaScript and browser APIs. Users should not install Python, a local server, or OS-specific runtime software. Page text and generated audio stay in the browser; audio is temporary unless saving is enabled.

## Speech engines

- **Kokoro ONNX (first browser engine):** use the Apache-2.0 licensed ONNX Community export through `kokoro-js` and Transformers.js. Download the quantized model and selected voice files from Hugging Face into the extension's browser cache. The ONNX model is about 92 MB. Use WebAssembly where WebGPU is unavailable and try WebGPU where supported.
- **Fish Audio (planned browser port):** the official Fish Speech weights currently use PyTorch files and Fish Audio's documented inference starts a Python API server. Those files cannot run directly in an extension. Keep Fish as a distinct future engine requiring an in-browser JavaScript/WebAssembly/WebGPU model implementation and a browser-compatible weight format. Do not expose Fish as a working engine or tell users to install a server until that port is complete.
- Kokoro supplies preset voices, not arbitrary MP3 reference voice cloning. Add reference-voice cloning only when a supported browser engine can perform it locally.
- Display each engine's model link, license, approximate storage, and runtime requirements. Do not bundle large model weights in extension packages.

## Reader behavior

1. Maintain shared Chrome and Firefox extension packages, with Edge using the Chrome package.
2. Add context-menu actions to read a page from the start, continue from a clicked location, read selected text, and stop.
3. Extract page text in the content script, split it into sentences, and prepare a configurable buffer (default five sentences).
4. Extract selectable text from local and browser-open PDFs and send it through the same reader queue.
5. Provide five built-in Kokoro voices, playback controls, and optional audio saving to a browser-selected Downloads subfolder.
6. Store model files in browser-managed extension storage. Provide visible download progress, cache status, and a way to remove the model cache. No extension code should fetch page text or generated audio to a remote service.
7. Keep a capped local diagnostics log covering setup, downloads, model loading, reading, synthesis, playback, PDFs, settings, and saves. Include failures and technical context while excluding page text, full page addresses, reference recordings, and generated audio. Let the user view, export, and clear it.

## Architecture

- `extension/`: shared extension UI, background logic, content script, and separate Chrome/Firefox manifests.
- `extension/model-runtime-entry.js`: JavaScript model runtime entry bundled into each browser package.
- `scripts/package-browser.mjs`: builds the local runtime bundle, includes browser ONNX/WebAssembly assets and licenses, then creates ZIP archives.
- `vendor/fish-speech/`: official upstream source retained for researching a later Fish browser port. It is not included in the current runtime package.
- The background coordinates sentence buffering and asks the extension options page to generate speech through its in-browser model runtime. No localhost API is used.
- Hugging Face is used only to fetch the selected model and voice files. Transformers.js stores model responses in Cache Storage; Kokoro stores voice embeddings in Cache Storage. Subsequent synthesis can use these cached files offline, subject to browser storage policies.

## Delivery checkpoints

- **Checkpoint 1:** project plan, licenses, public source repository, extension skeleton.
- **Checkpoint 2:** browser-only Kokoro model download, inference, local voice cache, and audio playback.
- **Checkpoint 3:** webpage and PDF actions, buffering, settings, persistence, and diagnostics.
- **Checkpoint 4:** Firefox and Chromium testing, installation guides, publication, and user trial.
- **Later checkpoint:** evaluate and port Fish Audio inference to a browser-compatible runtime without a local server; add MP3 reference voice cloning only if that port supports it.

## Acceptance requirements

- Reading actions work from webpage context menus and the PDF reader.
- The sentence buffer defaults to five and can be changed.
- Kokoro model files and preset voice embeddings are downloaded from the model card into browser-managed storage and can be removed from settings.
- Kokoro inference runs in JavaScript/WebAssembly or WebGPU inside the extension with no separately installed server or language runtime.
- Five preset voices are available; reference MP3 voice cloning is clearly marked as future work until a local browser engine supports it.
- Generated audio is discarded after playback unless the user opts in to saving.
- The extension is free, ad-free, and has no hosted inference requirement.
- Technical successes and failures appear in an exportable local diagnostics log that omits private reading content.
