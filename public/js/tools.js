// ============================================================
// Tool (function) declarations for the Gemini Live API.
// Gestures are gone — replaced with real, goal-directed tasks.
// Coordinates now use both camera-frame (normalized) and
// world-frame (meters) explicitly.
// ============================================================

export const TOOL_DECLARATIONS = [
  {
    name: "execute_robot_action",
    description:
      "Fine-grained motor control referenced to what the camera sees. Coordinates are in the CAMERA FRAME: x,y normalized 0-1 across the field of view, z = depth in meters (0.0 = touching, up to ~2.0). Use for look_at, grasp, release, idle.",
    parameters: {
      type: "OBJECT",
      properties: {
        action_type: {
          type: "STRING",
          enum: ["look_at", "grasp", "release", "idle"],
        },
        target_coordinates: {
          type: "OBJECT",
          properties: {
            x: { type: "NUMBER", description: "Camera-frame horizontal, 0.0 left → 1.0 right." },
            y: { type: "NUMBER", description: "Camera-frame vertical, 0.0 top → 1.0 bottom." },
            z: { type: "NUMBER", description: "Depth in meters, 0.0 (touching) → 2.0 (far)." },
          },
          required: ["x", "y", "z"],
        },
        parameters: {
          type: "OBJECT",
          properties: {
            speed: { type: "NUMBER", description: "0.1 → 1.0" },
            grip_force: { type: "NUMBER", description: "0.0 → 1.0, grasp only" },
          },
        },
      },
      required: ["action_type", "target_coordinates"],
    },
  },
  {
    name: "move_robot",
    description: "Drive the robot base in a body-relative direction by a distance in centimeters.",
    parameters: {
      type: "OBJECT",
      properties: {
        direction: { type: "STRING", enum: ["forward", "backward", "left", "right"] },
        distance_cm: { type: "NUMBER" },
      },
      required: ["direction", "distance_cm"],
    },
  },
  {
    name: "turn_robot",
    description: "Rotate the robot in place. Positive angle = clockwise (right), negative = counter-clockwise (left).",
    parameters: {
      type: "OBJECT",
      properties: {
        angle_degrees: { type: "NUMBER", description: "-180 to 180" },
      },
      required: ["angle_degrees"],
    },
  },
  {
    name: "navigate_to",
    description:
      "Drive the robot to an absolute point in the WORLD FRAME (meters). Origin (0,0) is the center of the room, +x = east (right on the map), +y = north (up on the map). Valid range roughly [-2, +2] on both axes for a 4 m × 4 m room.",
    parameters: {
      type: "OBJECT",
      properties: {
        world_x: { type: "NUMBER", description: "Target X in meters, world frame." },
        world_y: { type: "NUMBER", description: "Target Y in meters, world frame." },
        speed: { type: "NUMBER", description: "0.1 → 1.0, defaults to 0.6." },
      },
      required: ["world_x", "world_y"],
    },
  },
  {
    name: "execute_task",
    description:
      "Open a high-level TASK with a real goal (e.g. fetch an object, deliver an item, inspect a location, follow a person). Not a stylized gesture — an objective the robot commits to and works to complete. Chain motor calls afterward to fulfill it.",
    parameters: {
      type: "OBJECT",
      properties: {
        task_type: {
          type: "STRING",
          enum: ["fetch", "deliver", "inspect", "follow", "greet", "patrol", "return_home", "wait"],
        },
        description: {
          type: "STRING",
          description: "One-line natural-language goal, e.g. 'bring the water bottle from the kitchen counter'.",
        },
        target_coordinates: {
          type: "OBJECT",
          description: "Optional WORLD-FRAME target (meters). Omit if the target is a person or unknown location.",
          properties: {
            world_x: { type: "NUMBER" },
            world_y: { type: "NUMBER" },
          },
        },
        priority: {
          type: "STRING",
          enum: ["low", "normal", "high"],
        },
      },
      required: ["task_type", "description"],
    },
  },
];
