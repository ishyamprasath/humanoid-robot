// ============================================================
// FaceEngine — the robot's "who is that?" sense.
//
// Runs @vladmandic/face-api (TensorFlow.js) fully in-browser on the
// live camera <video>: ~1 scan/sec, largest face -> 128-d descriptor
// -> matched against the PeopleStore. Gemini never identifies faces
// (it can't re-identify across sessions); this engine does, and the
// session is told who's in view.
// ============================================================

import * as faceapi from "@vladmandic/face-api";
import { FACE_MATCH_THRESHOLD, FACE_SCAN_MS } from "./config.js";

const MODEL_URL = "/models/faceapi";
const ENRICH_DISTANCE = 0.35; // very confident match -> add descriptor sample

export class FaceEngine {
  constructor({ store, onPersonChange, onFaceBox, onLog }) {
    this.store = store;
    this.onPersonChange = onPersonChange || (() => {});
    this.onFaceBox = onFaceBox || (() => {});
    this.onLog = onLog || (() => {});

    this.ready = false;
    this.current = null;        // null | "unknown" | person name
    this._candidate = undefined; // debounce: last raw scan result
    this._agree = 0;             // consecutive scans agreeing with _candidate
    this._lastDescriptor = null; // latest descriptor seen (for remember_person)
    this._matcher = null;
    this._timer = null;
    this._busy = false;
    this._lastScanTime = 0;
    this._detectorOptions = new faceapi.TinyFaceDetectorOptions();
  }

  async init() {
    if (this.ready) return true;
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      await this.refreshMatcher();
      this.ready = true;
      this.onLog("face engine ready — recognition models loaded");
      return true;
    } catch (e) {
      this.onLog(`face engine failed to load models: ${e?.message || e}`);
      return false;
    }
  }

  /** Rebuild the matcher from the store (after remember/forget). */
  async refreshMatcher() {
    const people = await this.store.loadAll();
    const labeled = people
      .filter((p) => p.descriptors?.length)
      .map((p) => new faceapi.LabeledFaceDescriptors(
        p.name,
        p.descriptors.map((d) => new Float32Array(d)),
      ));
    this._matcher = labeled.length
      ? new faceapi.FaceMatcher(labeled, FACE_MATCH_THRESHOLD)
      : null;
    return people;
  }

  start(videoEl) {
    if (!this.ready || this._timer) return;
    this._video = videoEl;
    this._timer = setInterval(() => this._scan(), FACE_SCAN_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._setCurrent(null);
    this._lastDescriptor = null;
    this._lastScanTime = 0;
    this.onFaceBox(null);
  }

  /** Latest descriptor (Float32Array) — used when a stranger gives their name. */
  captureDescriptor() {
    return this._lastDescriptor;
  }

  async _scan() {
    const video = this._video;
    if (this._busy || !video || !video.videoWidth) return;

    // Dynamic throttling: if we already recognize someone, scan less frequently to save CPU/responsiveness.
    const now = performance.now();
    const currentInterval = (this.current && this.current !== "unknown") ? 3000 : FACE_SCAN_MS;
    if (this._lastScanTime && (now - this._lastScanTime < currentInterval)) {
      return;
    }
    this._lastScanTime = now;

    this._busy = true;
    try {
      const det = await faceapi
        .detectSingleFace(video, this._detectorOptions)
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (!det) {
        this._lastDescriptor = null;
        this.onFaceBox(null);
        this._debounce(null);
        return;
      }

      this._lastDescriptor = det.descriptor;
      let label = "unknown";
      let distance = 1;
      if (this._matcher) {
        const best = this._matcher.findBestMatch(det.descriptor);
        if (best.label !== "unknown") {
          label = best.label;
          distance = best.distance;
        }
      }

      // normalized box for the overlay canvas
      const b = det.detection.box;
      this.onFaceBox({
        x: b.x / video.videoWidth,
        y: b.y / video.videoHeight,
        w: b.width / video.videoWidth,
        h: b.height / video.videoHeight,
        label,
      });

      // rock-solid match on a known person -> enrich their samples
      if (label !== "unknown" && distance < ENRICH_DISTANCE) {
        const added = await this.store.addDescriptor(label, det.descriptor);
        if (added) await this.refreshMatcher();
      }

      this._debounce(label);
    } catch (e) {
      this.onLog(`face scan error: ${e?.message || e}`);
    } finally {
      this._busy = false;
    }
  }

  // Require 2 consecutive agreeing scans before switching state — kills
  // flicker between unknown/known on marginal frames.
  _debounce(result) {
    if (result === this.current) { this._candidate = undefined; this._agree = 0; return; }
    if (result === this._candidate) {
      this._agree += 1;
      if (this._agree >= 2) {
        this._candidate = undefined;
        this._agree = 0;
        this._setCurrent(result);
      }
    } else {
      this._candidate = result;
      this._agree = 1;
    }
  }

  _setCurrent(value) {
    if (value === this.current) return;
    this.current = value;
    this.onPersonChange(value);
  }
}
