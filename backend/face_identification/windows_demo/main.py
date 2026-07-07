import sys
import os
import cv2
import threading
import numpy as np
from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                             QHBoxLayout, QLabel, QPushButton, QListWidget,
                             QFileDialog, QInputDialog, QMessageBox, QTextEdit, QDialog, QComboBox)
from PyQt6.QtCore import Qt, pyqtSignal, QObject, pyqtSlot
from PyQt6.QtGui import QImage, QPixmap

from camera import CameraThread
from gallery import Gallery
from vision import VisionEngine
from insightface.app import FaceAnalysis
from logger import log_event, LOG_FILE

class WorkerSignals(QObject):
    results_ready = pyqtSignal(object, list, int)
    capture_complete = pyqtSignal(str, str, list)

class MainApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Facial Identification Demo")
        self.resize(1024, 600)

        self.signals = WorkerSignals()
        self.signals.results_ready.connect(self.update_ui)
        self.signals.capture_complete.connect(self.on_capture_complete)

        main_widget = QWidget()
        self.setCentralWidget(main_widget)
        h_layout = QHBoxLayout(main_widget)

        self.video_label = QLabel()
        self.video_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.video_label.setStyleSheet("background-color: black;")
        h_layout.addWidget(self.video_label, stretch=3)

        v_layout = QVBoxLayout()
        h_layout.addLayout(v_layout, stretch=1)

        v_layout.addWidget(QLabel("<b>Live Roster</b>"))

        self.roster_list = QListWidget()
        v_layout.addWidget(self.roster_list)

        self.enroll_btn = QPushButton("Enroll Person (Folder)")
        self.enroll_btn.clicked.connect(self.enroll_dialog)
        v_layout.addWidget(self.enroll_btn)

        self.live_enroll_btn = QPushButton("Live Enroll (Webcam)")
        self.live_enroll_btn.clicked.connect(self.live_enroll_dialog)
        v_layout.addWidget(self.live_enroll_btn)

        self.improve_profile_btn = QPushButton("Improve Profile")
        self.improve_profile_btn.clicked.connect(self.improve_profile_dialog)
        v_layout.addWidget(self.improve_profile_btn)

        self.edit_profile_btn = QPushButton("Edit Profile")
        self.edit_profile_btn.clicked.connect(self.edit_profile_dialog)
        v_layout.addWidget(self.edit_profile_btn)

        self.capture_burst_btn = QPushButton("Capture Burst Now")
        self.capture_burst_btn.setStyleSheet("background-color: #ff4444; color: white; font-weight: bold; padding: 10px;")
        self.capture_burst_btn.clicked.connect(self.start_capture_burst)
        self.capture_burst_btn.hide()
        v_layout.addWidget(self.capture_burst_btn)

        self.log_btn = QPushButton("View Log")
        self.log_btn.clicked.connect(self.view_log)
        v_layout.addWidget(self.log_btn)

        log_event("Application started.")

        self.face_app = FaceAnalysis(name='buffalo_l', providers=['CUDAExecutionProvider', 'CPUExecutionProvider'])
        self.face_app.prepare(ctx_id=0, det_size=(640, 640))

        self.gallery = Gallery(self.face_app)
        self.vision = VisionEngine(self.face_app, self.gallery)

        self.camera = CameraThread(src=0)
        self.camera.start()

        self.vision_running = True
        self.capture_state = 0 # 0=Normal, 1=Pending, 2=Capturing
        self.capture_name = ""
        self.capture_title = ""
        self.capture_frames = []
        self.capture_needed = 5

        self.process_thread = threading.Thread(target=self.process_loop, daemon=True)
        self.process_thread.start()

    def process_loop(self):
        frame_count = 0
        while True:
            if not self.vision_running:
                cv2.waitKey(100)
                continue

            frame = self.camera.get_frame()
            if frame is not None:
                if self.capture_state == 2:
                    frame_count += 1
                    if frame_count % 10 == 0:
                        self.capture_frames.append(frame.copy())
                        if len(self.capture_frames) >= self.capture_needed:
                            self.capture_state = 0
                            self.signals.capture_complete.emit(self.capture_name, self.capture_title, self.capture_frames)

                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    self.signals.results_ready.emit(frame_rgb, [], len(self.capture_frames))
                else:
                    results = self.vision.process_frame(frame)
                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    self.signals.results_ready.emit(frame_rgb, results, 0)
            else:
                cv2.waitKey(10)

    def update_ui(self, frame_rgb, results, num_captured):
        h, w, ch = frame_rgb.shape
        bytes_per_line = ch * w

        roster_items = []

        if self.capture_state == 2:
            text = f"Capturing {num_captured}/{self.capture_needed}..."
            cv2.putText(frame_rgb, text, (w//2 - 150, h//2), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (0, 0, 255), 3)
        else:
            for det in results:
                box = det['box']
                name = det['name']
                conf = det['confidence']
                is_unknown = det['is_unknown']

                color = (255, 0, 0) if is_unknown else (0, 255, 0)

                cv2.rectangle(frame_rgb, (box[0], box[1]), (box[2], box[3]), color, 2)
                label = f"{name} ({conf:.2f})" if not is_unknown else name
                cv2.putText(frame_rgb, label, (box[0], max(0, box[1]-10)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

                roster_items.append(label)

        qt_img = QImage(frame_rgb.data, w, h, bytes_per_line, QImage.Format.Format_RGB888)
        pixmap = QPixmap.fromImage(qt_img)

        scaled = pixmap.scaled(self.video_label.size(), Qt.AspectRatioMode.KeepAspectRatio)
        self.video_label.setPixmap(scaled)

        if self.capture_state != 2:
            self.roster_list.clear()
            for item in set(roster_items):
                self.roster_list.addItem(item)

    def enroll_dialog(self):
        self.vision_running = False
        name, ok = QInputDialog.getText(self, "Enroll Person", "Enter person's name:")
        if ok and name:
            title, ok2 = QInputDialog.getText(self, "Enroll Person", f"Enter profile/title for {name} (Optional):")
            if ok2:
                folder_path = QFileDialog.getExistingDirectory(self, "Select folder with face photos")
                if folder_path:
                    res = self.gallery.enroll_folder(name, folder_path, title)
                    msg = res.get('message', '')
                    if res.get('status') == 'success':
                        QMessageBox.information(self, "Enrollment Success", msg)
                    else:
                        QMessageBox.warning(self, "Enrollment Failed", msg)
        self.vision_running = True

    def live_enroll_dialog(self):
        name, ok = QInputDialog.getText(self, "Live Enroll", "Enter new person's name:")
        if ok and name:
            title, ok2 = QInputDialog.getText(self, "Live Enroll", f"Enter profile/title for {name} (Optional):")
            if ok2:
                self.prepare_capture(name, title)

    def improve_profile_dialog(self):
        identities = self.gallery.get_identities()
        if not identities:
            QMessageBox.information(self, "No Profiles", "There are no enrolled profiles to improve.")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle("Improve Profile")
        layout = QVBoxLayout(dlg)

        layout.addWidget(QLabel("Select person to improve:"))
        combo = QComboBox()
        combo.addItems(identities)
        layout.addWidget(combo)

        btn = QPushButton("Select")
        btn.clicked.connect(dlg.accept)
        layout.addWidget(btn)

        if dlg.exec() == QDialog.DialogCode.Accepted:
            name = combo.currentText()
            if name:
                self.prepare_capture(name, "")

    def edit_profile_dialog(self):
        identities = self.gallery.get_identities()
        if not identities:
            QMessageBox.information(self, "No Profiles", "There are no enrolled profiles to edit.")
            return

        dlg = QDialog(self)
        dlg.setWindowTitle("Edit Profile")
        layout = QVBoxLayout(dlg)

        layout.addWidget(QLabel("Select person to edit:"))
        combo = QComboBox()
        combo.addItems(identities)
        layout.addWidget(combo)

        btn = QPushButton("Select")
        btn.clicked.connect(dlg.accept)
        layout.addWidget(btn)

        if dlg.exec() == QDialog.DialogCode.Accepted:
            old_name = combo.currentText()
            if old_name:
                current_title = self.gallery.index.get(old_name, {}).get("title", "")
                new_name, ok = QInputDialog.getText(self, "Edit Name", f"Edit name for {old_name}:", text=old_name)
                if ok and new_name:
                    new_title, ok2 = QInputDialog.getText(self, "Edit Title", f"Edit title for {new_name}:", text=current_title)
                    if ok2:
                        res = self.gallery.edit_profile(old_name, new_name, new_title)
                        if res.get('status') == 'success':
                            QMessageBox.information(self, "Edit Success", "Profile updated successfully.")
                        else:
                            QMessageBox.warning(self, "Edit Failed", res.get('message', 'Error'))

    def prepare_capture(self, name, title=""):
        self.capture_name = name
        self.capture_title = title
        self.capture_state = 1
        self.capture_burst_btn.setText(f"Capture Burst for {name}")
        self.capture_burst_btn.show()

    def start_capture_burst(self):
        self.capture_burst_btn.hide()
        self.capture_frames = []
        self.capture_state = 2

    @pyqtSlot(str, str, list)
    def on_capture_complete(self, name, title, frames):
        self.vision_running = False
        res = self.gallery.enroll_live_burst(name, frames, title)
        msg = res.get('message', '')
        if res.get('status') == 'success':
            QMessageBox.information(self, "Live Enrollment Success", msg)
        else:
            QMessageBox.warning(self, "Live Enrollment Failed", msg)
        self.vision_running = True

    def view_log(self):
        dlg = QDialog(self)
        dlg.setWindowTitle("Event Log")
        dlg.resize(600, 400)

        layout = QVBoxLayout(dlg)
        text_edit = QTextEdit()
        text_edit.setReadOnly(True)

        if os.path.exists(LOG_FILE):
            with open(LOG_FILE, 'r') as f:
                text_edit.setPlainText(f.read())

        layout.addWidget(text_edit)
        text_edit.verticalScrollBar().setValue(text_edit.verticalScrollBar().maximum())

        dlg.exec()

    def closeEvent(self, event):
        self.camera.stop()
        log_event("Application stopped.")
        event.accept()

if __name__ == '__main__':
    app = QApplication(sys.argv)
    window = MainApp()
    window.show()
    sys.exit(app.exec())
