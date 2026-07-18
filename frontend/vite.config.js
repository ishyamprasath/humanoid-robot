import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure directories exist relative to the project root (repository root)
const ROOT_DIR = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT_DIR, "logs");
const CONV_DIR = path.join(LOGS_DIR, "conv-log");
const TASK_DIR = path.join(LOGS_DIR, "task-log");
const ACT_DIR = path.join(LOGS_DIR, "actions-log");

[CONV_DIR, TASK_DIR, ACT_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// A Vite plugin to intercept log API requests and write them to disk
function loggerPlugin() {
  return {
    name: "vite-plugin-robot-logger",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method === "POST" && req.url.startsWith("/api/log/")) {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
          }
          try {
            const data = JSON.parse(body);
            const { sessionId, timestamp, content } = data;
            const cleanSessionId = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
            const dateStr = new Date(timestamp || Date.now()).toLocaleTimeString([], { hour12: false });
            
            if (req.url === "/api/log/conversation") {
              fs.appendFileSync(
                path.join(CONV_DIR, `session-${cleanSessionId}.txt`),
                `[${dateStr}] ${content.role.toUpperCase()}: ${content.text}\n`
              );
            } else if (req.url === "/api/log/task") {
              fs.appendFileSync(
                path.join(TASK_DIR, `session-${cleanSessionId}.txt`),
                `[${dateStr}] [${content.event.toUpperCase()}] ${content.message}\n`
              );
            } else if (req.url === "/api/log/action") {
              fs.appendFileSync(
                path.join(ACT_DIR, `session-${cleanSessionId}.txt`),
                `[${dateStr}] [${content.type.toUpperCase()}] ${content.message}\n`
              );
            }
            
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
            return;
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
  build: {
    rollupOptions: {
      input: {
        face: path.resolve(__dirname, 'face.html'),
        control: path.resolve(__dirname, 'control.html'),
      }
    }
  },
  plugins: [loggerPlugin()],
});
