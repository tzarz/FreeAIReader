# FreeAIReader project plan

## Product goal

Build **FreeAIReader**, a no-cost, ad-free browser reader that speaks webpages and PDFs with locally run Fish Audio speech generation. The project should keep page text and generated audio on the user's computer. Audio is temporary by default; users can opt in to saving generated files.

## Speech engine and licensing

- Use the official [Fish Audio `fish-speech` repository](https://github.com/fishaudio/fish-speech) as the speech engine source.
- The current Fish Audio code and model weights are under the Fish Audio Research License. Personal and other noncommercial use is royalty-free. Any commercial use needs a separate written license.
- Keep the upstream license and required notice with distributed copies, and show “Built with Fish Audio” in the extension. Do not bundle large model weights in this repository; provide setup instructions for downloading them from Fish Audio's official model links.
- Run inference through the local Fish Speech HTTP server. Free local use depends on the user's computer and does not require a paid API. Fish Audio's current S2 guide recommends a GPU with 24 GB of VRAM; it also documents a CPU installation, which may generate speech more slowly.

## Implementation sequence

1. Set up this project as a Git repository and add the official Fish Speech source as a Git submodule.
2. Build a shared WebExtension codebase with installable Chrome and Firefox manifests.
3. Add context menu actions for reading the page from the start, reading from the clicked location, and reading selected text.
4. Extract readable page text, split it into sentences, and keep a configurable queue of generated sentences ahead of playback (default: five).
5. Add PDF text extraction and the same sentence queue for PDF documents.
6. Add settings for the local Fish Speech server, five built-in speaking styles, MP3 reference voice cloning, buffer size, and audio retention.
7. Keep generated audio in memory and discard it after playback by default. When saving is enabled, let the user choose a subfolder under the browser's Downloads folder.
8. Document local engine setup, browser installation, privacy behavior, and current platform requirements. Publish the source in a free public GitHub repository under the authenticated account.

## Initial architecture

- `extension/`: shared extension UI, background worker, content scripts, and separate Chrome/Firefox manifests.
- The extension background worker calls Fish Speech's local HTTP API directly. There is no cloud service or account requirement.
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
