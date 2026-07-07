import numpy as np
from scipy.spatial.distance import cdist
from logger import log_event, log_warning, log_error

class Tracker:
    def __init__(self, max_disappeared=5, max_distance=50):
        self.next_object_id = 0
        self.objects = {} # id -> centroid
        self.disappeared = {} # id -> count
        self.max_disappeared = max_disappeared
        self.max_distance = max_distance

    def update(self, rects):
        if len(rects) == 0:
            for object_id in list(self.disappeared.keys()):
                self.disappeared[object_id] += 1
                if self.disappeared[object_id] > self.max_disappeared:
                    self.deregister(object_id)
            return {}

        input_centroids = np.zeros((len(rects), 2), dtype="int")
        for (i, (startX, startY, endX, endY)) in enumerate(rects):
            cX = int((startX + endX) / 2.0)
            cY = int((startY + endY) / 2.0)
            input_centroids[i] = (cX, cY)

        if len(self.objects) == 0:
            for i in range(0, len(input_centroids)):
                self.register(input_centroids[i])
        else:
            object_ids = list(self.objects.keys())
            object_centroids = list(self.objects.values())

            D = cdist(np.array(object_centroids), input_centroids)

            rows = D.min(axis=1).argsort()
            cols = D.argmin(axis=1)[rows]

            used_rows = set()
            used_cols = set()

            for (row, col) in zip(rows, cols):
                if row in used_rows or col in used_cols:
                    continue
                if D[row, col] > self.max_distance:
                    continue

                object_id = object_ids[row]
                self.objects[object_id] = input_centroids[col]
                self.disappeared[object_id] = 0

                used_rows.add(row)
                used_cols.add(col)

            unused_rows = set(range(0, D.shape[0])).difference(used_rows)
            unused_cols = set(range(0, D.shape[1])).difference(used_cols)

            for row in unused_rows:
                object_id = object_ids[row]
                self.disappeared[object_id] += 1
                if self.disappeared[object_id] > self.max_disappeared:
                    self.deregister(object_id)

            for col in unused_cols:
                self.register(input_centroids[col])

        return self.objects

    def register(self, centroid):
        self.objects[self.next_object_id] = centroid
        self.disappeared[self.next_object_id] = 0
        self.next_object_id += 1

    def deregister(self, object_id):
        del self.objects[object_id]
        del self.disappeared[object_id]

class VisionEngine:
    def __init__(self, face_app, gallery):
        self.app = face_app
        self.gallery = gallery
        self.tracker = Tracker(max_disappeared=10, max_distance=100)
        self.track_identities = {}
        self.unknown_counter = 0

    def process_frame(self, frame):
        faces = self.app.get(frame)

        rects = []
        for face in faces:
            rects.append(face.bbox.astype(int))

        objects = self.tracker.update(rects)

        results = []

        lost_tracks = set(self.track_identities.keys()) - set(objects.keys())
        for tid in lost_tracks:
            if self.track_identities[tid]["is_unknown"]:
                log_event(f"Unknown track {self.track_identities[tid]['name']} left frame.")
            del self.track_identities[tid]

        for face, bbox in zip(faces, rects):
            cX = int((bbox[0] + bbox[2]) / 2.0)
            cY = int((bbox[1] + bbox[3]) / 2.0)

            matched_tid = None
            for tid, centroid in objects.items():
                if np.linalg.norm(np.array([cX, cY]) - np.array(centroid)) < 50:
                    matched_tid = tid
                    break

            if matched_tid is None:
                continue

            run_recognition = False
            if matched_tid not in self.track_identities:
                run_recognition = True
            elif self.track_identities[matched_tid]["is_unknown"]:
                run_recognition = True

            if run_recognition:
                name, title, sim = self.gallery.recognize(face.normed_embedding, threshold=0.45)

                if name is not None:
                    display_name = f"[{title}] {name}" if title else name
                    if matched_tid in self.track_identities and self.track_identities[matched_tid]["is_unknown"]:
                        log_event(f"Resolved {self.track_identities[matched_tid]['name']} -> {display_name} (conf: {sim:.2f})")
                    elif matched_tid not in self.track_identities:
                        log_event(f"Recognized {display_name} (conf: {sim:.2f})")

                    self.track_identities[matched_tid] = {"name": display_name, "confidence": sim, "is_unknown": False}
                else:
                    if matched_tid not in self.track_identities:
                        self.unknown_counter += 1
                        un_name = f"Unknown #{self.unknown_counter}"
                        self.track_identities[matched_tid] = {"name": un_name, "confidence": sim, "is_unknown": True}
                    else:
                        if sim > self.track_identities[matched_tid]["confidence"]:
                             self.track_identities[matched_tid]["confidence"] = sim

                             if sim > 0.40:
                                 log_warning(f"Borderline match for {self.track_identities[matched_tid]['name']}: sim={sim:.2f}")

            track_info = self.track_identities.get(matched_tid, {"name": "Processing", "confidence": 0, "is_unknown": True})

            results.append({
                'box': bbox,
                'name': track_info["name"],
                'confidence': track_info["confidence"],
                'track_id': matched_tid,
                'is_unknown': track_info["is_unknown"]
            })

        return results
