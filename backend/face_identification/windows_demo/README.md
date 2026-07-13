# Facial Identification Demo

This is a real-time facial identification application built with Python, PyQt6, and the InsightFace deep learning library. 

## Quick Start (How to Run)

1. Ensure you have installed the requirements (see `requirements.txt`).
2. Run the demo using the provided batch script or via Python:
```bash
python main.py
```

## How It Works

To achieve smooth video playback while running heavy AI models, the application uses a multi-threaded architecture that decouples the camera feed from the AI processing:

1. **Camera Capture (`camera.py`)**: 
   Runs a dedicated background thread that constantly pulls the latest frames from your webcam at a high resolution (1280x720).

2. **Video Display (`main.py` -> `display_loop`)**: 
   A fast loop that takes the latest frame from the camera and displays it on the GUI at your target FPS (e.g., 30 FPS). It draws bounding boxes using an Exponential Moving Average (EMA) smoothing algorithm. This allows the bounding boxes to glide smoothly over the video instead of jumping aggressively.

3. **AI Vision Processing (`main.py` -> `process_loop` & `vision.py`)**: 
   A separate asynchronous loop that passes frames to InsightFace. InsightFace uses heavy neural networks (like `buffalo_l` or `buffalo_s`) to detect faces and extract mathematical "embeddings" (a unique 512-dimensional fingerprint of a face). Because this runs independently of the display loop, the heavy math doesn't slow down your video feed.

4. **Gallery and Enrollments (`gallery.py`)**:
   Manages the database of known faces. When a face is detected, its embedding is compared against the gallery using cosine similarity. Embeddings are saved as `.npz` files in the `gallery/` folder. The embeddings are stored in subfolders named after the active model (e.g., `gallery/buffalo_l/`) to prevent conflicts when you switch models.



### UI Features
* **Live Roster**: Displays a list of all identified people currently in the camera's view.
* **Enroll Person (Folder)**: Enroll a person by providing a folder of their photos.
* **Live Enroll (Webcam)**: Look at the camera to capture a burst of frames to instantly enroll yourself.
* **Settings**: Change the target display FPS or swap out the underlying InsightFace model on the fly. Try smaller models like `buffalo_s` for much faster processing on standard CPUs!

## Requirements
See `requirements.txt`. Requires `opencv-python`, `PyQt6`, `insightface`, `scipy`, and `numpy`.
