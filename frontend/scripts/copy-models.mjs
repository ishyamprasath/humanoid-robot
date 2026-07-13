// Copies the face-api model weights we use out of node_modules into
// public/ so Vite serves them at /models/faceapi/. Runs on postinstall.

import { copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(root, "..", "node_modules", "@vladmandic", "face-api", "model");
const dstDir = resolve(root, "..", "public", "models", "faceapi");

// Only the three nets the app loads — detector, landmarks, recognizer.
const WANTED = /^(tiny_face_detector|face_landmark_68|face_recognition)/;

if (!existsSync(srcDir)) {
  console.error(`copy-models: source not found: ${srcDir}`);
  process.exit(0); // don't fail install on odd layouts; app logs a clear error at runtime
}

mkdirSync(dstDir, { recursive: true });
let n = 0;
for (const f of readdirSync(srcDir)) {
  if (!WANTED.test(f)) continue;
  copyFileSync(join(srcDir, f), join(dstDir, f));
  n++;
}
console.log(`copy-models: ${n} files -> public/models/faceapi`);
