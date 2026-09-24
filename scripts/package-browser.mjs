import { cp, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2];
const targets = requested === "both" ? ["chrome", "firefox"] : [requested];

if (!targets.length || targets.some((target) => !["chrome", "firefox"].includes(target))) {
  console.error("Usage: npm run package -- <chrome|firefox|both>");
  process.exitCode = 2;
} else {
  for (const target of targets) await packageBrowser(target);
}

async function packageBrowser(target) {
  const source = path.join(root, "extension");
  const output = path.join(root, "dist", `freeaireader-${target}`);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true });

  const manifestFile = path.join(output, `manifest.${target}.json`);
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(path.join(output, "manifest.chrome.json"), { force: true });
  await rm(path.join(output, "manifest.firefox.json"), { force: true });

  const runtimeOutput = path.join(output, "vendor");
  await mkdir(runtimeOutput, { recursive: true });
  await build({
    entryPoints: [path.join(source, "model-runtime-entry.js")],
    outfile: path.join(runtimeOutput, "model-runtime.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true
  });
  await rm(path.join(output, "model-runtime-entry.js"), { force: true });
  const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");
  const ortOutput = path.join(runtimeOutput, "onnx");
  await mkdir(ortOutput, { recursive: true });
  for (const name of await readdir(ortDist)) {
    if (name === "ort.bundle.min.mjs" || (/^ort-wasm-simd-threaded(?:\.jsep|\.asyncify|\.jspi)?\.(?:mjs|wasm)$/.test(name))) {
      await copyFile(path.join(ortDist, name), path.join(ortOutput, name));
    }
  }

  const pdfBuild = path.join(root, "node_modules", "pdfjs-dist", "legacy", "build");
  const pdfOutput = path.join(output, "vendor", "pdfjs");
  await mkdir(pdfOutput, { recursive: true });
  await cp(path.join(pdfBuild, "pdf.mjs"), path.join(pdfOutput, "pdf.mjs"));
  await cp(path.join(pdfBuild, "pdf.worker.mjs"), path.join(pdfOutput, "pdf.worker.mjs"));
  for (const assetDirectory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    await cp(path.join(root, "node_modules", "pdfjs-dist", assetDirectory), path.join(pdfOutput, assetDirectory), { recursive: true });
  }
  await cp(path.join(root, "node_modules", "pdfjs-dist", "LICENSE"), path.join(output, "LICENSE-PDFJS.txt"));
  await cp(path.join(root, "LICENSE"), path.join(output, "LICENSE-MIT.txt"));
  await cp(path.join(root, "node_modules", "kokoro-js", "LICENSE"), path.join(output, "LICENSE-KOKORO.txt"));
  await cp(path.join(root, "node_modules", "@huggingface", "transformers", "LICENSE"), path.join(output, "LICENSE-TRANSFORMERS-JS.txt"));
  await cp(path.join(root, "node_modules", "phonemizer", "LICENSE"), path.join(output, "LICENSE-PHONEMIZER.txt"));
  await writeFile(path.join(output, "LICENSE-ONNX-RUNTIME-WEB.txt"), `ONNX Runtime Web is licensed under the MIT License by Microsoft Corporation.

The license and copyright notices for the upstream project are available at:
https://github.com/microsoft/onnxruntime/blob/main/README.md#license
`);
  const zipPath = path.join(root, "dist", `freeaireader-${target}.zip`);
  const files = {};
  await collectFiles(output, output, files);
  await writeFile(zipPath, zipSync(files, { level: 9 }));
  console.log(`Packaged ${target} extension at ${path.relative(root, zipPath)}`);
}

async function collectFiles(rootDirectory, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rootDirectory, fullPath, files);
    } else if (entry.isFile()) {
      const archivePath = path.relative(rootDirectory, fullPath).split(path.sep).join("/");
      files[archivePath] = new Uint8Array(await readFile(fullPath));
    }
  }
}
