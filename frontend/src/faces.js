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
import {
  FACE_MATCH_THRESHOLD, FACE_TRACK_MS, FACE_RECOGNIZE_MS,
  FACE_BOX_GRACE_MS, FACE_MIN_CONFIDENCE, FACE_INPUT_SIZE,
} from "./config.js";

const MODEL_URL = new URL("../models/faceapi/", import.meta.url).href;
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
    this._busy = false;          // guards the fast box-tracking scan
    this._recognizing = false;   // guards the slower recognition pass
    this._label = "unknown";     // latest identity, reused between recognitions
    this._lastSeen = 0;          // last time a face was detected (for grace)
    this._lastRecognizeTime = 0; // last identity pass
    // Lower score threshold + fixed input size = holds the face through head turns.
    this._detectorOptions = new faceapi.TinyFaceDetectorOptions({
      inputSize: FACE_INPUT_SIZE,
      scoreThreshold: FACE_MIN_CONFIDENCE,
    });
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
    this._timer = setInterval(() => this._scan(), FACE_TRACK_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._setCurrent(null);
    this._label = "unknown";
    this._lastDescriptor = null;
    this._lastSeen = 0;
    this._lastRecognizeTime = 0;
    this.onFaceBox(null);
  }

  /** Latest descriptor (Float32Array) — used when a stranger gives their name. */
  captureDescriptor() {
    return this._lastDescriptor;
  }

  // Fast path: detection-only every FACE_TRACK_MS for a smooth box that
  // follows head turns. A single miss does NOT clear the box — we hold the
  // last one for FACE_BOX_GRACE_MS so slight turns don't make it vanish.
  async _scan() {
    const video = this._video;
    if (this._busy || !video || !video.videoWidth) return;

    this._busy = true;
    try {
      const det = await faceapi.detectSingleFace(video, this._detectorOptions);
      const now = performance.now();

      if (det) {
        this._lastSeen = now;
        const b = det.box;
        this.onFaceBox({
          x: b.x / video.videoWidth,
          y: b.y / video.videoHeight,
          w: b.width / video.videoWidth,
          h: b.height / video.videoHeight,
          label: this._label,
        });
        // Identity is expensive (landmarks + 128-d descriptor) — run it on a
        // slower cadence, off the fast box loop.
        if (now - this._lastRecognizeTime > FACE_RECOGNIZE_MS) {
          this._lastRecognizeTime = now;
          this._recognize(video);   // fire-and-forget, self-guarded
        }
      } else if (now - this._lastSeen > FACE_BOX_GRACE_MS) {
        this._label = "unknown";
        this._lastDescriptor = null;
        this.onFaceBox(null);
        this._debounce(null);
      }
    } catch (e) {
      this.onLog(`face scan error: ${e?.message || e}`);
    } finally {
      this._busy = false;
    }
  }

  // Slow path: who is this? Runs the full landmark+descriptor pipeline.
  async _recognize(video) {
    if (this._recognizing || !video || !video.videoWidth) return;
    this._recognizing = true;
    try {
      const det = await faceapi
        .detectSingleFace(video, this._detectorOptions)
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!det) return;

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
      this._label = label;

      // rock-solid match on a known person -> enrich their samples
      if (label !== "unknown" && distance < ENRICH_DISTANCE) {
        const added = await this.store.addDescriptor(label, det.descriptor);
        if (added) await this.refreshMatcher();
      }

      this._debounce(label);
    } catch (e) {
      this.onLog(`face recognize error: ${e?.message || e}`);
    } finally {
      this._recognizing = false;
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
