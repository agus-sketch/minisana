#!/usr/bin/env node
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { recommendModel } from "./recommend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PID_FILE = "/tmp/minisana.pid";
const LOG_FILE = "/tmp/minisana.log";
const command  = process.argv[2];

function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function getPid() {
  if (!existsSync(PID_FILE)) return null;
  const pid = parseInt(readFileSync(PID_FILE, "utf8").trim());
  if (isNaN(pid) || !isRunning(pid)) { try { unlinkSync(PID_FILE); } catch {} return null; }
  return pid;
}

function clearPort() {
  try { execSync("lsof -ti :3000 | xargs kill -9 2>/dev/null || true", { shell: true, stdio: "ignore" }); } catch {}
}

function start() {
  const pid = getPid();
  if (pid) { console.log(`⚠  Already running (PID ${pid})\n   → http://localhost:3000`); return; }
  clearPort();
  const log    = openSync(LOG_FILE, "a");
  const server = spawn("node", [path.join(__dirname, "minisana-agent.js")], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  writeFileSync(PID_FILE, String(server.pid));
  server.unref();
  console.log(`✅ Minisana started (PID ${server.pid})\n   → http://localhost:3000\n   Logs → ${LOG_FILE}`);
}

function stop() {
  const pid = getPid();
  if (!pid) { console.log("⚠  Minisana is not running"); return false; }
  try { process.kill(pid, "SIGTERM"); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  console.log(`🛑 Stopped (PID ${pid})`);
  return true;
}

function status() {
  const pid = getPid();
  if (pid) {
    console.log(`✅ Running\n   PID  → ${pid}\n   URL  → http://localhost:3000\n   Logs → ${LOG_FILE}`);
  } else {
    console.log(`🔴 Not running\n   Start with: minisana start`);
  }
}

async function doctor() {
  const rec = recommendModel();
  console.log(`💻 System: ${rec.ramGb} GB RAM`);
  console.log(`⭐ Recommended Ollama model: ${rec.recommended} (${rec.size})`);
  console.log(`   ${rec.note}`);
  if (rec.lighter) console.log(`   Lighter alternative: ${rec.lighter}`);
  if (rec.heavier) console.log(`   Heavier alternative: ${rec.heavier}`);

  let installed = [];
  try {
    const r = await fetch("http://localhost:11434/api/tags");
    const d = await r.json();
    installed = (d.models || []).map(m => m.name);
  } catch {
    console.log(`\n⚠  Ollama is not running — start it with: ollama serve`);
  }

  if (installed.length) {
    console.log(`\n📦 Installed models:`);
    installed.forEach(m => console.log(`   • ${m}${m === rec.recommended ? "  ⭐" : ""}`));
  }
  if (!installed.includes(rec.recommended)) {
    console.log(`\n→ Pull the recommended model:  ollama pull ${rec.recommended}`);
  }
}

switch (command) {
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "restart":
    stop();
    await new Promise(r => setTimeout(r, 1500));
    start();
    break;
  case "status":
    status();
    break;
  case "doctor":
    await doctor();
    break;
  case "setup":
    spawn("node", [path.join(__dirname, "setup.js")], { stdio: "inherit" }).on("exit", c => process.exit(c || 0));
    break;
  default:
    console.log("Usage: minisana start | stop | restart | status | doctor | setup");
}
