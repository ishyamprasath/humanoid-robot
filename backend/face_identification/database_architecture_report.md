# Technical Report: Face Embedding Storage Architecture

## 1. Executive Summary (TL;DR)

This report evaluates storage architectures for real-time face embedding matching, specifically tailored for a pipeline that seamlessly identifies individuals in-frame and interfaces with the Gemini API. The system must operate efficiently on a laptop during initial development and scale down to a resource-constrained Raspberry Pi 5 for final deployment.

**TL;DR Recommendations:**
*   **For Laptop (Initial Development):** Stick with **`.npz`** files or use **SQLite**. Laptops have abundant RAM and CPU, so either will work flawlessly. SQLite is recommended if you want to start building out metadata logic (names, last seen, preferences) early.
*   **For Raspberry Pi 5 (Final Deployment):** Use **SQLite** (or stick to `.npz`). The Pi requires minimizing background processes. Avoid heavy vector databases (ChromaDB) and cloud databases (MongoDB Atlas) to preserve RAM and eliminate network latency for real-time tracking.
*   **For Multi-Device Syncing:** Use a **File-Based Cloud Sync** (e.g., AWS S3, Google Drive API, or a private Git repository). Since `.npz` and SQLite are single files, a new device can simply download the "master" file on boot, and upload it when a new face is enrolled.

---

## 2. Pipeline Overview & Constraints

The target pipeline architecture:
1.  **Capture:** Process live video feed (15-30 FPS).
2.  **Extraction:** Detect faces and generate high-dimensional vector embeddings.
3.  **Identification:** Compare extracted embeddings against a database of known users.
4.  **Action:** Pass the identified user context and visual data to the Gemini API.

**Hardware Constraints (Raspberry Pi 5):**
While a capable microcomputer, the Pi 5 shares its RAM between the OS, the camera buffer, the face extraction model, and network operations. Any database solution must have a negligible memory footprint and require minimal CPU overhead to ensure the vision pipeline does not drop frames.

---

## 3. Breakdown Analysis of Storage Options

### A. `.npz` (NumPy Zipped Archive)
*   **Mechanism:** Embeddings are stored in a compressed dictionary file and loaded entirely into RAM at runtime. Distances are calculated using raw NumPy matrix operations.
*   **Pros:** 
    *   Zero dependencies outside of `numpy`.
    *   Virtually zero CPU overhead (blistering fast for < 10,000 faces).
    *   Microscopic RAM footprint (exact size of the vectors).
*   **Cons:** 
    *   No built-in support for complex metadata (requires parallel dictionaries).
    *   Not thread-safe for concurrent writes (risky if multiple cameras enroll users simultaneously).

### B. SQLite
*   **Mechanism:** A lightweight, serverless relational database built into Python. Embeddings are stored as binary BLOBs or JSON arrays.
*   **Pros:**
    *   Zero background server processes.
    *   Excellent for metadata (relational tables for users, access logs, permissions).
    *   Safe concurrent reads/writes.
    *   Single-file portability.
*   **Cons:**
    *   Requires writing manual SQL queries and distance-calculation logic (fetching vectors to RAM to compare).

### C. Local Vector Databases (ChromaDB, Qdrant)
*   **Mechanism:** Purpose-built engines for vector similarity search (using HNSW algorithms).
*   **Pros:**
    *   Does the distance math automatically.
    *   Incredibly fast for massive datasets (100,000+ faces).
*   **Cons:**
    *   High memory overhead (loads heavy Python classes, Pydantic, and background telemetry).
    *   Overkill for small-scale robotics. Can cause RAM starvation on a Pi.

### D. Cloud Hosted Databases (MongoDB Atlas)
*   **Mechanism:** Data is stored remotely on AWS/GCP/Azure.
*   **Pros:**
    *   Perfect centralization.
    *   Zero local storage used.
*   **Cons:**
    *   Introduces 50ms - 200ms of network latency per query.
    *   Destroys real-time tracking performance (creates jitter/stuttering).
    *   Introduces a hard dependency on internet connectivity for basic vision tasks.

---

## 4. Architectural Recommendations

### Phase 1: Laptop Development
During development, your laptop can easily run ChromaDB, MongoDB, or pure NumPy. However, to ensure a smooth transition to the Pi later, you should simulate the production environment.
*   **Recommendation:** Use **SQLite**. It allows you to build out the logic for storing metadata (which you will likely need for Gemini context) without locking you into a heavy ecosystem. You can write a simple Python class to fetch the BLOB embeddings from SQLite, convert them to NumPy arrays, and compare them.

### Phase 2: Raspberry Pi 5 Deployment
When deploying, preserving the Pi's compute for the facial extraction model is paramount.
*   **Recommendation:** Continue using **SQLite** (or `.npz`). By keeping the database serverless, you ensure that 100% of the Pi's resources are dedicated to maintaining high FPS on the vision pipeline.

---

## 5. Multi-Device Enrollment Synchronization Strategy

If you build a second robot (or move to a new device) and want it to recognize everyone the first robot learned, you face a dilemma: *How do you sync data without using a centralized, high-latency cloud database like MongoDB Atlas?*

Because both `.npz` and SQLite store the entire database as a **single, portable file**, you can use a "Pull/Push File Sync" strategy.

### The File-Sync Architecture:
1.  **The Master Storage:** Set up a simple, cheap cloud storage bucket (e.g., AWS S3 bucket, Google Cloud Storage, or even a private GitHub repository).
2.  **Boot-Up (Pull):** Whenever a robot is turned on, its startup script checks the cloud bucket. If the cloud file is newer than the local file, it downloads the latest `.npz` or `.sqlite` database file before starting the camera.
3.  **New Enrollment (Push):** If the robot meets a new person and enrolls their face, it updates its local database file immediately. Then, in a background thread, it uploads the updated file back to the cloud bucket.

**Why this works perfectly for robotics:**
*   **Zero Latency Vision:** The robot always queries the *local* file on its SD card. Facial recognition remains instantaneous.
*   **Offline Tolerance:** If the robot loses WiFi, it can't sync new faces, but it still perfectly remembers everyone in its local file.
*   **Easy Setup:** No database credentials or complex APIs required—just a simple file download/upload script.
