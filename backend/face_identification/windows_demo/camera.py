import cv2
import threading
import time
from logger import log_event, log_error

class CameraThread:
    def __init__(self, src=0):
        self.src = src
        self.cap = cv2.VideoCapture(self.src, cv2.CAP_DSHOW)
        if not self.cap.isOpened():
            log_error(f"Failed to open camera index {self.src}")
            self.running = False
        else:
            self.running = True
            log_event(f"Camera opened successfully.")

        self.ret = False
        self.frame = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.update, daemon=True)

    def start(self):
        if self.running:
            self.thread.start()

    def update(self):
        while self.running:
            ret, frame = self.cap.read()
            with self.lock:
                self.ret = ret
                if ret:
                    self.frame = frame.copy()
            # Small sleep to prevent high CPU usage
            time.sleep(0.01)

    def get_frame(self):
        with self.lock:
            if self.ret:
                return self.frame.copy()
            return None

    def stop(self):
        self.running = False
        if hasattr(self, 'thread') and self.thread.is_alive():
            self.thread.join()
        if self.cap.isOpened():
            self.cap.release()
        log_event("Camera stopped.")
