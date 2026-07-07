"""
Local face memory for the Python vision worker.

Stores only face embeddings, display names, and short notes. No photos are
persisted. The files live under backend/face_memory/ and are ignored by git.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import numpy as np


class FaceMemoryStore:
    def __init__(self, directory: Path, max_descriptors: int = 5):
        self.directory = Path(directory)
        self.max_descriptors = max(1, int(max_descriptors))
        self.index_path = self.directory / "index.json"
        self.people: dict[str, dict] = {}
        self.embeddings: dict[str, np.ndarray] = {}
        self.directory.mkdir(parents=True, exist_ok=True)
        self.load()

    def load(self) -> None:
        self.people = {}
        self.embeddings = {}
        if self.index_path.exists():
            try:
                self.people = json.loads(self.index_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                self.people = {}

        for person_id, meta in list(self.people.items()):
            path = self.directory / f"{person_id}.npz"
            if not path.exists():
                continue
            try:
                data = np.load(path)
                self.embeddings[person_id] = np.asarray(data["embeddings"], dtype=np.float32)
            except (OSError, KeyError, ValueError):
                self.people.pop(person_id, None)

    def save_index(self) -> None:
        self.index_path.write_text(
            json.dumps(self.people, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def identify(self, embedding, threshold: float) -> tuple[str | None, float]:
        emb = np.asarray(embedding, dtype=np.float32)
        best_name = None
        best_sim = -1.0

        for person_id, saved in self.embeddings.items():
            if saved.size == 0:
                continue
            sims = np.dot(saved, emb)
            sim = float(np.max(sims))
            if sim > best_sim:
                best_sim = sim
                best_name = self.people.get(person_id, {}).get("name")

        if best_name and best_sim >= threshold:
            return best_name, best_sim
        return None, best_sim

    def remember_person(self, name: str, embedding) -> dict:
        clean = " ".join(str(name or "").strip().split())
        if not clean:
            return {"status": "error", "reason": "no name given"}

        person_id = self._id_for_name(clean)
        now = time.time()
        meta = self.people.get(person_id) or {
            "name": clean,
            "notes": [],
            "created_at": now,
            "last_seen_at": now,
        }
        meta["name"] = clean
        meta["last_seen_at"] = now

        emb = np.asarray(embedding, dtype=np.float32).reshape(1, -1)
        old = self.embeddings.get(person_id)
        merged = emb if old is None else np.vstack([old, emb])
        merged = merged[-self.max_descriptors:]

        self.people[person_id] = meta
        self.embeddings[person_id] = merged
        np.savez(self.directory / f"{person_id}.npz", embeddings=merged)
        self.save_index()
        return {
            "status": "success",
            "remembered": clean,
            "samples": int(merged.shape[0]),
        }

    def remember_fact(self, person_name: str | None, fact: str) -> dict:
        clean_fact = " ".join(str(fact or "").strip().split())
        if not clean_fact:
            return {"status": "error", "reason": "empty fact"}
        if not person_name:
            return {"status": "error", "reason": "no recognized person in view"}

        person_id = self._find_id(person_name)
        if not person_id:
            return {"status": "error", "reason": f'no one named "{person_name}" in memory'}

        notes = self.people[person_id].setdefault("notes", [])
        notes.append(clean_fact)
        del notes[:-20]
        self.people[person_id]["last_seen_at"] = time.time()
        self.save_index()
        return {"status": "success", "person": self.people[person_id]["name"], "noted": clean_fact}

    def forget_person(self, name: str) -> dict:
        person_id = self._find_id(name)
        if not person_id:
            return {"status": "error", "reason": f'no one named "{name}" in memory'}
        clean = self.people[person_id]["name"]
        self.people.pop(person_id, None)
        self.embeddings.pop(person_id, None)
        try:
            (self.directory / f"{person_id}.npz").unlink()
        except FileNotFoundError:
            pass
        self.save_index()
        return {"status": "success", "forgot": clean}

    def touch(self, name: str) -> None:
        person_id = self._find_id(name)
        if not person_id:
            return
        self.people[person_id]["last_seen_at"] = time.time()
        self.save_index()

    def notes_for(self, name: str) -> list[str]:
        person_id = self._find_id(name)
        if not person_id:
            return []
        return list(self.people[person_id].get("notes") or [])

    def _find_id(self, name: str | None) -> str | None:
        needle = str(name or "").strip().lower()
        if not needle:
            return None
        for person_id, meta in self.people.items():
            if str(meta.get("name") or "").lower() == needle:
                return person_id
        return None

    def _id_for_name(self, name: str) -> str:
        existing = self._find_id(name)
        if existing:
            return existing
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        slug = slug or "person"
        candidate = slug
        suffix = 2
        while candidate in self.people:
            candidate = f"{slug}-{suffix}"
            suffix += 1
        return candidate
