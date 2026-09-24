# FreeAIReader

**No cost, no ads, just free AI voices of your desire. Power to the people.**

FreeAIReader is an open source browser reader in development. It sends text to Fish Speech running on your computer and plays the generated speech in your browser. It has no cloud account, subscription, or advertising requirement.

> **Built with Fish Audio.** Fish Speech is free for personal, noncommercial use under the [Fish Audio Research License](LICENSE-FISH-AUDIO.txt). Commercial use requires a separate license from Fish Audio. Review the upstream terms before downloading or using model weights.

This repository tracks Fish Audio's official source as a Git submodule. Model weights are large and must be downloaded separately from Fish Audio's official [S2-Pro model](https://huggingface.co/fishaudio/s2-pro). Model weights are not included here.

## Project plan

See [PLAN.md](PLAN.md) for the planned browser actions, PDF support, sentence buffer, voice settings, and audio retention behavior.

## Status

The local browser extension and speech integration are under active development. This early build is not ready for daily use.

## Get the source

Clone with Fish Speech included:

```sh
git clone --recurse-submodules https://github.com/tzarz/FreeAIReader.git
```

Or initialize the submodule after cloning:

```sh
git submodule update --init --depth 1
```

## Install Fish Speech

Fish Audio's current S2 guide recommends a GPU with 24 GB of VRAM. Fish Speech documents a CPU install too, but it may generate too slowly to keep the sentence buffer full. Its guide currently lists Linux and WSL as supported systems.

Install [uv](https://docs.astral.sh/uv/) and run these commands from the project root:

```sh
cd vendor/fish-speech
uv sync --python 3.12 --extra cu129
uv run hf download fishaudio/s2-pro --local-dir checkpoints/s2-pro
uv run python tools/api_server.py --llama-checkpoint-path checkpoints/s2-pro --decoder-checkpoint-path checkpoints/s2-pro/codec.pth --listen 127.0.0.1:8080
```

Choose the CUDA extra that matches your installed CUDA version (`cu126`, `cu128`, or `cu129`). For CPU-only setup, the official command is `uv sync --python 3.12 --extra cpu`. S2-Pro weights are several gigabytes and are downloaded from Fish Audio's official Hugging Face page under the same Fish Audio Research License.

## Build and install the extension

```sh
npm install
npm run package -- both
```

The command creates `dist/freeaireader-chrome.zip` and `dist/freeaireader-firefox.zip`, as well as unpacked folders. Load the Chrome folder from `chrome://extensions` with Developer mode enabled. For temporary Firefox use, open `about:debugging#/runtime/this-firefox` and load `dist/freeaireader-firefox/manifest.json`. Permanent Firefox installation requires Mozilla signing. Edge can load the Chrome folder from `edge://extensions`.

Click the extension icon to open settings. Right-click a webpage to read from the top, from the clicked paragraph onward, or from selected text. Use the PDF section in settings to choose a PDF file. Scanned PDFs without embedded text need OCR, which is not included yet.

## Privacy behavior

- Page text is sent to the local Fish Speech server configured in the extension.
- Page text, generated clips, and reading position stay in memory for the active reading session.
- Generated audio is discarded after playback by default.
- Saving clips is opt-in. Settings let you choose a subfolder inside the browser's Downloads folder.
- Settings are stored in the browser's extension storage. Reference voice audio is saved only when you explicitly choose the save voice option.

## Supported browsers

The planned first release targets current Chrome and Firefox desktop versions, with separate install packages. Edge can use the Chrome package. Safari is not yet targeted.

## License

Original FreeAIReader code is MIT licensed; see [LICENSE](LICENSE). Fish Speech is included as an independent submodule and is governed by that repository's license. The licenses do not replace one another.
