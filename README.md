# FreeAIReader

**Free, ad-free AI voices for webpages and PDFs.**

FreeAIReader is a browser extension that generates speech locally inside the extension. It does not require Python, a background server, a cloud account, or a paid speech API.

## Browser voice model

The first in-browser engine is Kokoro 82M through `kokoro-js`, Transformers.js, and ONNX Runtime Web. The quantized ONNX model is about 92 MB and is licensed under Apache 2.0. The extension downloads it and five preset voice embeddings from [the Kokoro model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) into browser Cache Storage. After the files are cached, speech synthesis can run offline, subject to the browser's storage and private-browsing rules. Firefox Private Browsing may clear the cache when the private session ends, so the model may need to be downloaded again.

Firefox uses the WebAssembly CPU runtime. Browsers with a compatible WebGPU runtime can use GPU acceleration. Model files and voice embeddings stay in the extension's browser storage; the extension does not read them from an OS-specific folder.

Kokoro provides preset voices and does not clone an arbitrary MP3 recording. Fish Audio is a planned separate browser engine. Its official published weights and inference code currently require a different runtime, so Fish is not presented as a working option in this build. The current Fish Speech server documentation uses a Python API server; FreeAIReader will only add Fish after a browser-native port exists. See [PLAN.md](PLAN.md).

## Features

- Right-click to read from the top, from a clicked location, or from selected text.
- Read selectable text from local or browser-open PDFs.
- Five Kokoro voices and a configurable sentence buffer (five sentences by default).
- Temporary audio by default, with optional saving to a browser Downloads folder.
- Local diagnostics for setup, model download, inference, reading, playback, PDFs, settings, and failures. Logs omit page text, full page addresses, voice recordings, and generated audio; export or clear them in settings.

## Build

Requirements: Node.js and npm. No Python or speech server is used by the extension build or runtime.

```sh
npm install
npm run package -- both
```

The command creates `dist/freeaireader-chrome.zip` and `dist/freeaireader-firefox.zip`, plus unpacked folders. In Chrome or Edge, open `chrome://extensions` or `edge://extensions`, enable Developer mode, and load the unpacked `dist/freeaireader-chrome` folder. For a temporary Firefox install, open `about:debugging#/runtime/this-firefox` and load `dist/freeaireader-firefox/manifest.json`. Permanent Firefox installation requires Mozilla signing.

If Firefox always uses Private Browsing, open the add-on's Details page and set **Run in Private Windows** to **Allow**. Firefox requires that separate permission before an extension can read private-window pages.

## Privacy and storage

- Page text is sent only from the content script to the extension's local model runtime.
- Model downloads come from Hugging Face and are stored in browser Cache Storage under the extension origin.
- Generated audio is kept in memory and discarded after playback unless saving is enabled.
- Diagnostics are stored in extension storage, capped at 500 events, and never uploaded.
- Browser cleanup policies may clear cached model files; Firefox may clear them when its private session ends. The extension provides a cache status and removal control.

## Licensing

FreeAIReader source is MIT licensed. The bundled Kokoro, Transformers.js, phonemizer, and ONNX Runtime components retain their upstream licenses in the extension archive. Fish Speech remains a separate upstream submodule and is not included in the current browser runtime package.
