#!/usr/bin/env node
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";
import readline from "readline/promises";
import path from "path";
import { fileURLToPath } from "url";
import { recommendModel } from "./recommend.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), ".minisana");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

function saveConfig(patch) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let current = {};
  try { current = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...patch }, null, 2));
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function ask(prompt, defYes = true) {
  const tag = defYes ? "[Y/n]" : "[y/N]";
  const ans = (await rl.question(`${prompt} ${tag} `)).trim().toLowerCase();
  if (!ans) return defYes;
  return ans === "y" || ans === "yes";
}

function has(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: "ignore", shell: "/bin/sh" }); return true; }
  catch { return false; }
}

function run(cmd, opts = {}) {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: __dirname, ...opts });
}

async function main() {
  console.log("\n🌱  Minisana setup\n");

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    console.error(`✗ Node ${process.versions.node} — Minisana needs Node 18+. Update at https://nodejs.org`);
    process.exit(1);
  }
  console.log(`✓ Node ${process.versions.node}`);

  if (!existsSync(path.join(__dirname, "node_modules"))) {
    console.log("\n📦 Installing dependencies…");
    run("npm install");
  } else {
    console.log("✓ Dependencies already installed");
  }

  if (!has("minisana")) {
    if (await ask("\nInstall the `minisana` CLI globally so you can run it from anywhere?")) {
      try { run("npm link"); }
      catch {
        console.log("  ↳ retrying with sudo…");
        try { run("sudo npm link"); }
        catch { console.log("  ⚠ npm link failed — you can still run the server with `npm start`."); }
      }
    }
  } else {
    console.log("✓ `minisana` CLI already on PATH");
  }

  const wantOllama = await ask("\nUse Ollama (local AI) instead of Groq / OpenAI?", false);
  saveConfig({ useOllama: wantOllama });
  if (wantOllama) {
    if (!has("ollama")) {
      console.log("\n⚙ Ollama is not installed.");
      const isUnix = process.platform === "darwin" || process.platform === "linux";
      if (isUnix && await ask("  Install it now via the official script (https://ollama.com/install.sh)?")) {
        try { run("curl -fsSL https://ollama.com/install.sh | sh"); }
        catch { console.log("  ⚠ Install failed — try manually: https://ollama.com/download"); }
      } else if (!isUnix) {
        console.log("  Download from https://ollama.com/download, then re-run this setup.");
      }
    } else {
      console.log("✓ Ollama already installed");
    }

    if (has("ollama")) {
      const rec = recommendModel();
      console.log(`\n💻 Detected ${rec.ramGb} GB RAM → recommended model: ${rec.recommended} (${rec.size})`);
      console.log(`   ${rec.note}`);

      let installed = [];
      try {
        const out = execSync("ollama list", { encoding: "utf8" });
        installed = out.split("\n").slice(1).map(l => l.split(/\s+/)[0]).filter(Boolean);
      } catch {}

      if (!installed.includes(rec.recommended)) {
        if (await ask(`  Pull ${rec.recommended} now? (${rec.size} download)`)) {
          try { run(`ollama pull ${rec.recommended}`); }
          catch { console.log("  ⚠ Pull failed — you can retry later with the same command."); }
        }
      } else {
        console.log(`✓ ${rec.recommended} already installed`);
      }
    }
  }

  console.log("\n✅ Setup complete.\n");
  const start = await ask("Start Minisana now?");
  rl.close();

  if (start) {
    run(has("minisana") ? "minisana start" : "npm start");
  } else {
    console.log("\nStart anytime with:  minisana start   (or  npm start)");
    console.log("Then open:           http://localhost:3000");
  }
}

main().catch(e => {
  console.error(e);
  rl.close();
  process.exit(1);
});
