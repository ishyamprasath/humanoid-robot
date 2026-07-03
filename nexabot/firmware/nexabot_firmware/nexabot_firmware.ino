/*
  ============================================================
  NexaBot firmware — ESP32 / Arduino body controller
  ============================================================
  Receives one JSON command per line over USB serial (115200)
  from the NexaBot terminal task runner:

    {"cmd":"execute_robot_task","args":{"task":"move_robot","direction":"forward","distance_cm":50}}
    {"cmd":"execute_robot_task","args":{"task":"turn_robot","angle_degrees":-90}}
    {"cmd":"execute_robot_task","args":{"task":"pick_object",
        "target_coordinates":{"x":0.5,"y":0.6,"z":0.4}}}

  Requires the ArduinoJson library (Library Manager → "ArduinoJson").
  Adjust the pin map + motion constants for your chassis.
*/

#include <ArduinoJson.h>
#include <ESP32Servo.h>

// ---------------- Pin map (EDIT FOR YOUR ROBOT) ----------------
const int PIN_MOTOR_L_FWD = 26;
const int PIN_MOTOR_L_REV = 27;
const int PIN_MOTOR_R_FWD = 32;
const int PIN_MOTOR_R_REV = 33;
const int PIN_SERVO_HEAD_PAN  = 18; // look_at horizontal
const int PIN_SERVO_HEAD_TILT = 19; // look_at vertical
const int PIN_SERVO_ARM       = 21; // object reach
const int PIN_SERVO_GRIPPER   = 22;

// ---------------- Motion calibration ----------------
const float MS_PER_CM  = 22.0;  // drive time per cm at full PWM
const float MS_PER_DEG = 9.0;   // spin time per degree

Servo headPan, headTilt, arm, gripper;
String lineBuf;

void setup() {
  Serial.begin(115200);

  pinMode(PIN_MOTOR_L_FWD, OUTPUT);
  pinMode(PIN_MOTOR_L_REV, OUTPUT);
  pinMode(PIN_MOTOR_R_FWD, OUTPUT);
  pinMode(PIN_MOTOR_R_REV, OUTPUT);

  headPan.attach(PIN_SERVO_HEAD_PAN);
  headTilt.attach(PIN_SERVO_HEAD_TILT);
  arm.attach(PIN_SERVO_ARM);
  gripper.attach(PIN_SERVO_GRIPPER);

  headPan.write(90);
  headTilt.write(90);
  arm.write(20);
  gripper.write(10); // open

  Serial.println("{\"status\":\"boot\",\"msg\":\"NexaBot body online\"}");
}

void loop() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n') {
      handleCommand(lineBuf);
      lineBuf = "";
    } else if (lineBuf.length() < 512) {
      lineBuf += ch;
    }
  }
}

// ---------------- Command dispatch ----------------
void handleCommand(const String &json) {
  if (json.length() < 2) return;

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, json);
  if (err) {
    Serial.printf("{\"status\":\"error\",\"msg\":\"bad json: %s\"}\n", err.c_str());
    return;
  }

  const char *cmd = doc["cmd"] | "";
  JsonObject args = doc["args"];

  if (strcmp(cmd, "move_robot") == 0) {
    moveRobot(args["direction"] | "forward", args["distance_cm"] | 0.0f);
  } else if (strcmp(cmd, "turn_robot") == 0) {
    turnRobot(args["angle_degrees"] | 0.0f);
  } else if (strcmp(cmd, "execute_robot_task") == 0) {
    executeRobotTask(args);
  } else if (strcmp(cmd, "execute_robot_action") == 0) {
    robotAction(args);
  } else {
    Serial.println("{\"status\":\"error\",\"msg\":\"unknown cmd\"}");
    return;
  }
  Serial.printf("{\"status\":\"ack\",\"cmd\":\"%s\"}\n", cmd);
}

// ---------------- Locomotion ----------------
void drive(int lf, int lr, int rf, int rr) {
  digitalWrite(PIN_MOTOR_L_FWD, lf);
  digitalWrite(PIN_MOTOR_L_REV, lr);
  digitalWrite(PIN_MOTOR_R_FWD, rf);
  digitalWrite(PIN_MOTOR_R_REV, rr);
}
void stopMotors() { drive(0, 0, 0, 0); }

void moveRobot(const char *direction, float distanceCm) {
  distanceCm = constrain(distanceCm, 0, 300);
  unsigned long ms = (unsigned long)(distanceCm * MS_PER_CM);

  if      (strcmp(direction, "forward")  == 0) drive(1, 0, 1, 0);
  else if (strcmp(direction, "backward") == 0) drive(0, 1, 0, 1);
  else if (strcmp(direction, "left")     == 0) { turnRobot(-90); drive(1, 0, 1, 0); }
  else if (strcmp(direction, "right")    == 0) { turnRobot(90);  drive(1, 0, 1, 0); }
  else { return; }

  delay(ms);
  stopMotors();
}

void turnRobot(float angleDeg) {
  angleDeg = constrain(angleDeg, -180, 180);
  unsigned long ms = (unsigned long)(fabs(angleDeg) * MS_PER_DEG);
  if (angleDeg > 0) drive(1, 0, 0, 1);   // clockwise
  else              drive(0, 1, 1, 0);   // counter-clockwise
  delay(ms);
  stopMotors();
}

// ---------------- Exact terminal tasks ----------------
void executeRobotTask(JsonObject args) {
  const char *task = args["task"] | "idle";
  JsonObject coords = args["target_coordinates"];

  if (strcmp(task, "move_robot") == 0) {
    moveRobot(args["direction"] | "forward", args["distance_cm"] | 0.0f);
  } else if (strcmp(task, "turn_robot") == 0) {
    turnRobot(args["angle_degrees"] | 0.0f);
  } else if (strcmp(task, "stop_robot") == 0) {
    stopMotors();
  } else if (strcmp(task, "release_object") == 0) {
    gripper.write(10);
    delay(300);
    arm.write(20);
  } else if (strcmp(task, "observe_object") == 0) {
    lookAt(coords);
  } else if (strcmp(task, "approach_object") == 0) {
    lookAt(coords);
    moveRobot("forward", (coords["z"] | 0.5f) * 100.0f);
  } else if (strcmp(task, "pick_object") == 0) {
    float z = coords["z"] | 0.5f;
    if (z > 1.5f) { Serial.println("{\"status\":\"error\",\"msg\":\"out of reach\"}"); return; }
    lookAt(coords);
    arm.write(constrain((int)(30 + z * 70), 30, 130));
    delay(500);
    gripper.write(120);
  }
}

void lookAt(JsonObject coords) {
  float x = coords["x"] | 0.5f;
  float y = coords["y"] | 0.5f;
  headPan.write(constrain((int)(90 + (0.5f - x) * 70), 20, 160));
  headTilt.write(constrain((int)(90 + (y - 0.5f) * 60), 40, 140));
}

// ---------------- Legacy fine actions ----------------
void robotAction(JsonObject args) {
  const char *type = args["action_type"] | "";
  float x = args["target_coordinates"]["x"] | 0.5f;
  float y = args["target_coordinates"]["y"] | 0.5f;
  float z = args["target_coordinates"]["z"] | 0.5f;

  if (strcmp(type, "look_at") == 0) {
    // Map normalized camera frame → servo angles (90 = center)
    headPan.write(constrain((int)(90 + (0.5f - x) * 70), 20, 160));
    headTilt.write(constrain((int)(90 + (y - 0.5f) * 60), 40, 140));
  } else if (strcmp(type, "grasp") == 0) {
    if (z > 1.5f) { Serial.println("{\"status\":\"error\",\"msg\":\"out of reach\"}"); return; }
    float force = args["parameters"]["grip_force"] | 0.5f;
    arm.write(constrain((int)(30 + z * 70), 30, 130)); // reach out by depth
    delay(500);
    gripper.write(constrain((int)(10 + force * 150), 10, 160)); // close
  } else if (strcmp(type, "release") == 0) {
    gripper.write(10);
    delay(300);
    arm.write(20);
  } else if (strcmp(type, "move_to") == 0 || strcmp(type, "navigate") == 0) {
    turnRobot((x - 0.5f) * 60.0f);   // turn toward horizontal offset
    moveRobot("forward", z * 100.0f); // advance by depth (m → cm)
  }
  // "idle" → nothing
}
