import os
import json
import numpy as np
import cv2
from insightface.app import FaceAnalysis
from logger import log_event, log_warning, log_error

GALLERY_DIR = "gallery"
INDEX_FILE = os.path.join(GALLERY_DIR, "index.json")

class Gallery:
    def __init__(self, face_app: FaceAnalysis):
        self.face_app = face_app
        self.identities = {} # name -> list of embeddings
        self.index = {}
        os.makedirs(GALLERY_DIR, exist_ok=True)
        self.load()

    def load(self):
        if os.path.exists(INDEX_FILE):
            try:
                with open(INDEX_FILE, 'r') as f:
                    self.index = json.load(f)
            except Exception as e:
                log_error(f"Failed to load gallery index: {e}")
                self.index = {}

        self.identities = {}
        for name, meta in self.index.items():
            npz_path = os.path.join(GALLERY_DIR, f"{name}.npz")
            if os.path.exists(npz_path):
                try:
                    data = np.load(npz_path)
                    self.identities[name] = data['embeddings']
                except Exception as e:
                    log_error(f"Failed to load embeddings for {name}: {e}")

    def save_index(self):
        with open(INDEX_FILE, 'w') as f:
            json.dump(self.index, f, indent=4)

    def get_identities(self):
        return list(self.identities.keys())

    def edit_profile(self, old_name: str, new_name: str, new_title: str):
        if old_name not in self.identities:
            return {"status": "error", "message": "Profile not found."}

        if new_name != old_name and new_name in self.identities:
            return {"status": "error", "message": f"Target name '{new_name}' already exists."}

        if new_name != old_name:
            old_path = os.path.join(GALLERY_DIR, f"{old_name}.npz")
            new_path = os.path.join(GALLERY_DIR, f"{new_name}.npz")
            if os.path.exists(old_path):
                try:
                    os.rename(old_path, new_path)
                except Exception as e:
                    return {"status": "error", "message": f"Failed to rename file: {e}"}

            self.identities[new_name] = self.identities.pop(old_name)
            self.index[new_name] = self.index.pop(old_name)

        self.index[new_name]["title"] = new_title
        self.save_index()

        log_event(f"Edited profile: {old_name} -> {new_name} (Title: {new_title})")
        return {"status": "success"}

    def enroll_live_burst(self, name: str, frames: list, title: str = ""):
        embeddings = []
        rejected = 0
        reasons = []

        log_event(f"Started live enrollment for {name} with {len(frames)} frames.")

        for i, frame in enumerate(frames):
            faces = self.face_app.get(frame)
            if len(faces) == 0:
                rejected += 1
                reasons.append(f"Frame {i}: no face detected")
                continue
            elif len(faces) > 1:
                rejected += 1
                reasons.append(f"Frame {i}: multiple faces detected")
                continue

            embeddings.append(faces[0].normed_embedding)

        if len(embeddings) == 0:
            msg = f"Live enrollment failed for {name}: no valid faces found."
            log_warning(msg)
            return {"status": "error", "message": msg, "rejected": rejected, "reasons": reasons}

        if len(embeddings) > 2:
            embeds = np.array(embeddings)
            sim_matrix = np.dot(embeds, embeds.T)
            mean_sims = (np.sum(sim_matrix, axis=1) - 1) / (len(embeddings) - 1)
            valid_indices = [i for i, sim in enumerate(mean_sims) if sim > 0.6]

            dropped = len(embeddings) - len(valid_indices)
            if dropped > 0:
                rejected += dropped
                reasons.append(f"Dropped {dropped} outlier(s)")

            final_embeddings = [embeddings[i] for i in valid_indices]
        else:
            final_embeddings = embeddings

        if len(final_embeddings) == 0:
             return {"status": "error", "message": "All embeddings rejected as outliers."}

        final_embeddings = np.array(final_embeddings)

        if name in self.identities:
            self.identities[name] = np.vstack([self.identities[name], final_embeddings])
        else:
            self.identities[name] = final_embeddings

        np.savez(os.path.join(GALLERY_DIR, f"{name}.npz"), embeddings=self.identities[name])

        self.index[name] = {
            "count": len(self.identities[name]),
            "title": title if title else self.index.get(name, {}).get("title", "")
        }
        self.save_index()

        msg = f"Live enrolled {name}: {len(final_embeddings)} embeddings added, {rejected} rejected."
        log_event(msg)
        return {"status": "success", "message": msg, "rejected": rejected, "reasons": reasons}


    def enroll_folder(self, name: str, folder_path: str, title: str = ""):
        if not os.path.isdir(folder_path):
            log_error(f"Enrollment folder not found: {folder_path}")
            return {"status": "error", "message": "Folder not found"}

        embeddings = []
        rejected = 0
        reasons = []

        log_event(f"Started enrollment for {name} from {folder_path}")

        for filename in os.listdir(folder_path):
            if not filename.lower().endswith(('.png', '.jpg', '.jpeg')):
                continue

            img_path = os.path.join(folder_path, filename)
            img = cv2.imread(img_path)
            if img is None:
                rejected += 1
                reasons.append(f"{filename}: could not read image")
                continue

            faces = self.face_app.get(img)
            if len(faces) == 0:
                rejected += 1
                reasons.append(f"{filename}: no face detected")
                continue
            elif len(faces) > 1:
                rejected += 1
                reasons.append(f"{filename}: multiple faces detected")
                continue

            embeddings.append(faces[0].normed_embedding)

        if len(embeddings) == 0:
            msg = f"Enrollment failed for {name}: no valid faces found."
            log_warning(msg)
            return {"status": "error", "message": msg, "rejected": rejected, "reasons": reasons}

        # Outlier rejection (simple average pairwise distance)
        if len(embeddings) > 2:
            embeds = np.array(embeddings)
            sim_matrix = np.dot(embeds, embeds.T)
            mean_sims = (np.sum(sim_matrix, axis=1) - 1) / (len(embeddings) - 1)
            valid_indices = [i for i, sim in enumerate(mean_sims) if sim > 0.6]

            dropped = len(embeddings) - len(valid_indices)
            if dropped > 0:
                rejected += dropped
                reasons.append(f"Dropped {dropped} outlier(s)")

            final_embeddings = [embeddings[i] for i in valid_indices]
        else:
            final_embeddings = embeddings

        if len(final_embeddings) == 0:
             return {"status": "error", "message": "All embeddings rejected as outliers."}

        final_embeddings = np.array(final_embeddings)

        if name in self.identities:
            self.identities[name] = np.vstack([self.identities[name], final_embeddings])
        else:
            self.identities[name] = final_embeddings

        np.savez(os.path.join(GALLERY_DIR, f"{name}.npz"), embeddings=self.identities[name])

        self.index[name] = {
            "count": len(self.identities[name])
        }
        self.save_index()

        msg = f"Enrolled {name}: {len(final_embeddings)} embeddings added, {rejected} rejected."
        log_event(msg)
        return {"status": "success", "message": msg, "rejected": rejected, "reasons": reasons}

    def recognize(self, embedding, threshold=0.5):
        best_match = None
        best_sim = -1

        for name, saved_embeds in self.identities.items():
            sims = np.dot(saved_embeds, embedding)
            max_sim = np.max(sims)

            if max_sim > best_sim:
                best_sim = max_sim
                best_match = name

        if best_sim >= threshold:
            title = self.index.get(best_match, {}).get("title", "")
            return best_match, title, best_sim
        return None, "", best_sim
