// ============================================================
// Robot body — tool executor + world-frame state + task queue.
//
// This is the swap point for real hardware: today execute() updates
// an internal world model and returns simulated results; on the real
// robot the same calls drive ROS 2 / serial motors. Nothing upstream
// (the Gemini brain) needs to change.
//
// World frame: meters, origin (0,0) at room center, +x = east, +y = north.
// Heading: radians, 0 = east, pi/2 = north.
// ============================================================

import { CAMERA_HFOV, ROOM_HALF_METERS } from "./config.js";

const TASK_TYPES = ["fetch", "deliver", "inspect", "follow", "greet", "patrol", "return_home", "wait"];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round2 = (n) => Math.round(n * 100) / 100;

function normRad(r) {
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r < -Math.PI) r += 2 * Math.PI;
  return r;
}

export class Robot {
  constructor({ onAction, onState } = {}) {
    this.state = {
      x: 0,
      y: 0,
      heading: Math.PI / 2, // facing north
      gripper: "open",
      lookTarget: null, // {cam:{x,y,z}, world:{x,y}}
    };
    this.tasks = [];
    this._nextTaskId = 1;
    this.onAction = onAction || (() => {});
    this.onState = onState || (() => {});
  }

  // ------------------------------------------------------------
  // Dispatch — name + args from the Live API -> result object back
  // ------------------------------------------------------------
  execute(name, args) {
    args = args || {};
    let result;
    try {
      const handler = {
        move_robot: (a) => this._moveRobot(a),
        turn_robot: (a) => this._turnRobot(a),
        navigate_to: (a) => this._navigateTo(a),
        execute_robot_action: (a) => this._robotAction(a),
        execute_task: (a) => this._executeTask(a),
      }[name];
      result = handler ? handler(args) : { status: "error", reason: `unknown tool "${name}"` };
    } catch (e) {
      result = { status: "error", reason: String(e?.message || e) };
    }
    this.onAction(name, args, result);
    this.onState(this.snapshot());
    return result;
  }

  // ------------------------------------------------------------
  // Motor primitives
  // ------------------------------------------------------------
  _moveRobot(args) {
    const s = this.state;
    const direction = args.direction || "";
    const dist = clamp(Number(args.distance_cm) || 0, 0, 300) / 100; // meters
    const h = s.heading;
    const vec = {
      forward: [Math.cos(h), Math.sin(h)],
      backward: [-Math.cos(h), -Math.sin(h)],
      left: [Math.cos(h + Math.PI / 2), Math.sin(h + Math.PI / 2)],
      right: [Math.cos(h - Math.PI / 2), Math.sin(h - Math.PI / 2)],
    }[direction];
    if (!vec) return { status: "error", reason: `bad direction "${direction}"` };
    const lim = ROOM_HALF_METERS - 0.1;
    s.x = clamp(s.x + vec[0] * dist, -lim, lim);
    s.y = clamp(s.y + vec[1] * dist, -lim, lim);
    return {
      status: "success",
      direction,
      distance_cm: dist * 100,
      world_position_m: { x: round2(s.x), y: round2(s.y) },
    };
  }

  _turnRobot(args) {
    const deg = clamp(Number(args.angle_degrees) || 0, -180, 180);
    // positive = clockwise (right) -> decreasing heading in ENU convention
    this.state.heading = normRad(this.state.heading - (deg * Math.PI) / 180);
    return {
      status: "success",
      turned_degrees: deg,
      heading_degrees: this.headingDegrees(),
    };
  }

  _navigateTo(args) {
    const lim = ROOM_HALF_METERS - 0.1;
    const wx = clamp(Number(args.world_x) || 0, -lim, lim);
    const wy = clamp(Number(args.world_y) || 0, -lim, lim);
    const speed = clamp(Number(args.speed) || 0.6, 0.1, 1.0);
    const s = this.state;
    const dx = wx - s.x, dy = wy - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.01) s.heading = Math.atan2(dy, dx);
    s.x = wx;
    s.y = wy;
    return {
      status: "success",
      destination_m: { x: round2(wx), y: round2(wy) },
      distance_m: round2(dist),
      speed,
    };
  }

  _robotAction(args) {
    const t = args.target_coordinates || {};
    const p = args.parameters || {};
    const camX = clamp(Number(t.x ?? 0.5), 0, 1);
    const camY = clamp(Number(t.y ?? 0.5), 0, 1);
    const camZ = clamp(Number(t.z ?? 0), 0, 2);
    const world = this._cameraToWorld(camX, camZ);
    const action = args.action_type || "";
    const s = this.state;

    if (action === "look_at") {
      // pan toward the horizontal offset
      s.heading = normRad(s.heading - (camX - 0.5) * CAMERA_HFOV);
      s.lookTarget = {
        cam: { x: camX, y: camY, z: camZ },
        world: { x: round2(world[0]), y: round2(world[1]) },
      };
      return {
        status: "success",
        camera_frame: { x: camX, y: camY, z: camZ },
        world_frame_m: { x: round2(world[0]), y: round2(world[1]) },
      };
    }

    if (action === "grasp") {
      if (camZ > 1.5) {
        return {
          status: "error",
          reason: `target ${camZ.toFixed(2)} m is beyond the 1.5 m arm reach — navigate closer first.`,
        };
      }
      const force = clamp(Number(p.grip_force ?? 0.5), 0, 1);
      s.gripper = "closed";
      s.lookTarget = {
        cam: { x: camX, y: camY, z: camZ },
        world: { x: round2(world[0]), y: round2(world[1]) },
      };
      return { status: "success", gripper: "closed", grip_force: force, object_secured: true };
    }

    if (action === "release") {
      s.gripper = "open";
      return { status: "success", gripper: "open" };
    }

    if (action === "idle") return { status: "success", action: "idle" };

    return { status: "error", reason: `unknown action_type "${action}"` };
  }

  _executeTask(args) {
    const taskType = args.task_type || "";
    if (!TASK_TYPES.includes(taskType)) {
      return { status: "error", reason: `unknown task_type "${taskType}"` };
    }
    const tc = args.target_coordinates || {};
    let target = null;
    if ("world_x" in tc || "world_y" in tc) {
      target = { x: round2(Number(tc.world_x) || 0), y: round2(Number(tc.world_y) || 0) };
    }

    for (const t of this.tasks) if (t.status === "active") t.status = "completed";

    const task = {
      id: this._nextTaskId++,
      type: taskType,
      description: args.description || `${taskType} task`,
      target,
      priority: args.priority || "normal",
      status: "active",
      created_at: Date.now() / 1000,
    };
    this.tasks.unshift(task);
    this.tasks.length = Math.min(this.tasks.length, 20);
    return {
      status: "success",
      task_id: task.id,
      task_type: task.type,
      description: task.description,
      target_world_m: target,
      priority: task.priority,
    };
  }

  // ------------------------------------------------------------
  // Helpers / state export
  // ------------------------------------------------------------
  _cameraToWorld(camX, camZ) {
    const yaw = this.state.heading - (camX - 0.5) * CAMERA_HFOV;
    return [this.state.x + Math.cos(yaw) * camZ, this.state.y + Math.sin(yaw) * camZ];
  }

  headingDegrees() {
    return Math.round((((this.state.heading * 180) / Math.PI) % 360 + 360) % 360);
  }

  snapshot() {
    const s = this.state;
    return {
      pose: { x: round2(s.x), y: round2(s.y), heading_deg: this.headingDegrees() },
      gripper: s.gripper,
      look_target: s.lookTarget,
      tasks: this.tasks.map((t) => ({ ...t })),
    };
  }
}
