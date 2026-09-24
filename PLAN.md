# FreeAIReader project plan

## Product goal

Build **FreeAIReader**, a no-cost, ad-free browser reader that speaks webpages and PDFs with locally run Fish Audio speech generation. The project should keep page text and generated audio on the user's computer. Audio is temporary by default; users can opt in to saving generated files.

## Speech engine and licensing

- Use the official [Fish Audio `fish-speech` repository](https://github.com/fishaudio/fish-speech) as the speech engine source.
- Current Fish Audio S2 code and weights are under the Fish Audio Research License. The older Fish Speech V1.5 weights use CC BY-NC-SA 4.0 and require the legacy v1.5.1 inference server. Check each model's terms before downloading or use.
- Keep the upstream license and required notice with distributed copies, and show “Built with Fish Audio” in the extension. Do not bundle large model weights in this repository; provide setup instructions for downloading them from Fish Audio's official model links.
- Run inference through the local Fish Speech HTTP server. Free local use depends on the user's computer and does not require a paid API. The compact V1.5 guide recommends 4 GB of VRAM; the current S2 guide recommends 24 GB.

## Implementation sequence

1. Set up this project as a Git repository and add the official Fish Speech source as a Git submodule.
2. Build a shared WebExtension codebase with installable Chrome and Firefox manifests.
3. Add context menu actions for reading the page from the start, reading from the clicked location, and reading selected text.
4. Extract readable page text, split it into sentences, and keep a configurable queue of generated sentences ahead of playback (default: five).
5. Add PDF text extraction and the same sentence queue for PDF documents.
6. Add settings for the local Fish Speech server, five built-in speaking styles, MP3 reference voice cloning, buffer size, and audio retention.
7. Keep generated audio in memory and discard it after playback by default. When saving is enabled, let the user choose a subfolder under the browser's Downloads folder.
8. Add an in-app downloader for official S2-Pro files with license acknowledgment, download progress, cancellation, and the local server command. Show the upstream VRAM recommendation before download.
9. Keep a capped, on-device diagnostics log covering reading, speech, playback, PDF, settings, save, and model-download successes and failures. Let the user view, export, and clear it without recording page text, addresses, recordings, or generated audio.
10. Document local engine setup, browser installation, privacy behavior, and current platform requirements. Publish the source in a free public GitHub repository under the authenticated account.

## Initial architecture

- `extension/`: shared extension UI, background worker, content scripts, and separate Chrome/Firefox manifests.
- The extension background worker calls Fish Speech's local HTTP API directly. There is no cloud service or account requirement.
- Model weights are downloaded from Fish Audio's official Hugging Face repository into a browser Downloads subfolder after license acknowledgment.
- A capped diagnostics log is stored locally and can be exported or cleared; it contains technical metadata, not reading content.
- `vendor/fish-speech/`: upstream source tracked as a Git submodule, preserving its own license and update path.
- `NOTICE`: required Fish Audio attribution and license reference.

## Delivery checkpoints

- **Checkpoint 1:** project plan, upstream source link, license notice, and minimal extension skeleton.
- **Checkpoint 2:** local speech integration, sentence buffering, and temporary audio playback.
- **Checkpoint 3:** webpage and PDF actions, voice settings, and optional downloads.
- **Checkpoint 4:** installation guides, Chrome/Firefox packaging, and public GitHub publication.

## Acceptance requirements

- Page start, clicked-location, and selection reading work from the browser context menu.
- PDF text can be read through the same sentence queue.
- The queue defaults to five sentences and can be changed in settings.
- Five built-in voice styles and MP3 reference voice input are available.
- Generated audio is discarded after playback by default; saving is an explicit user setting.
- The extension has no ads or paid service dependency and clearly states that Fish Speech runs locally.
- Official S2-Pro files can be downloaded into a local browser Downloads folder and used with the included server command.
- The compact public Fish Speech V1.5 model (about 1.47 GB) is available in the model downloader with its legacy server instructions.
- Technical successes and failures are visible in an exportable local log with private reading content omitted.
