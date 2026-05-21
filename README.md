# Minisana

A chat-based AI agent to manage your Asana tasks using plain English.
Supports **Groq** (free cloud), **OpenAI**, **Claude** (Anthropic), and **Ollama** (local, private, free).

---

## Get started (5-minute tutorial)

A hand-held walkthrough for first-time users.

### 1. Install Node.js 18+

Download and run the installer from https://nodejs.org. To check it worked, open a terminal and run:

```bash
node --version
```

You should see `v18.x.x` or higher.

### 2. Get an Asana access token *(~30 seconds)*

1. Go to https://app.asana.com/0/my-profile-settings
2. Click **Apps** → **Manage Developer Apps** → **+ New access token**
3. Name it (e.g. *"Minisana"*), agree to the terms, click **Create**
4. **Copy the token now** — Asana only shows it once. Paste it somewhere temporary.

### 3. Pick an AI provider and get its key

Minisana supports four providers. Pick **one** — you can switch later from the settings panel without losing anything.

**Option A — Groq** *(free, recommended for beginners, ~30 seconds)*

1. Sign up at https://console.groq.com
2. Go to **API Keys** → **Create API Key**
3. Copy the key and save it next to your Asana token.

**Option B — OpenAI** *(paid, requires billing setup)*

1. Sign up at https://platform.openai.com
2. Open **Settings** → **Billing** and add a payment method (even $5 of credit lasts a long time for Minisana-sized usage)
3. Go to **API keys** → **Create new secret key**
4. Copy the `sk-...` value and save it.

> Note: a ChatGPT or ChatGPT Plus subscription does **not** include an API key — those are billed separately. You need to create the key at *platform.openai.com*, not chat.openai.com.

**Option C — Claude (Anthropic)** *(paid, requires billing setup)*

1. Sign up at https://console.anthropic.com
2. Go to **Plans & Billing** and add credit to your account
3. Go to **API Keys** → **Create Key**
4. Copy the `sk-ant-...` value and save it.

**Option D — Ollama** *(local, fully free, no API key)*

Nothing to do in this step. The setup wizard in step 4 will offer to install Ollama for you and pull the right model for your hardware. Just make sure you have ~5–20 GB of free disk for the model.

### 4. Install and start Minisana

Clone or download this repository, then in your terminal:

```bash
cd minisana
npm install
npm run setup
```

The setup wizard asks a few yes/no questions:

- *"Install the `minisana` CLI globally?"* → **y**
- *"Use Ollama (local AI)?"* → **y** if you picked Option D, otherwise **n**
  - If **y**: when it asks *"Pull `<model>` now?"* (e.g. `llama3.1:8b`) answer **y** — this is the model download
- *"Start Minisana now?"* → **y**

### 5. Connect in your browser

1. Open http://localhost:3000
2. Paste your **Asana token** into the *Asana Token* field
3. Click the provider tab matching what you set up in step 3 — **Groq** (default), **OpenAI**, **Claude**, or **Ollama**
4. For Groq / OpenAI / Claude: paste the API key. For Ollama: pick the model marked **⭐ Recommended** from the dropdown.
5. Click **Connect**

Done! Try typing *"What should I work on today?"* in the chat.

---

## Features

- **4 LLM providers** — Groq (free tier), OpenAI, Claude (Anthropic), or Ollama running locally
- **`minisana` CLI** — start/stop the agent in the background like a service
- **Task panel** — browse, filter (Open / Done / All), and search your tasks live
- **Quick add** — create tasks with section + assignee from the UI
- **Bulk actions** — select multiple tasks and complete or move them in one click
- **Project picker** — switch between Asana projects from the header
- **Dark mode** + settings (theme, provider) persisted across sessions
- **Auto-Ollama** — the server starts and warms up your local model automatically
- **Hardware-aware** — recommends the best Ollama model for your RAM
- **Paste images** directly into the chat or a task's comment box to attach them

---

## Quick install (one command)

You need **Node.js 18+** ([install](https://nodejs.org)). Then, from the project folder:

```bash
npm install
npm run setup
```

The setup wizard will:

1. Verify your Node version and install dependencies
2. Offer to link the `minisana` CLI globally so you can run it from anywhere
3. (If you choose Ollama) install the `ollama` CLI on macOS/Linux, detect your RAM, and pull the model that best fits your hardware
4. Start the server on **http://localhost:3000**

Then open **http://localhost:3000** and:

1. Paste your **Asana token** — get one at https://app.asana.com/0/my-profile-settings → *Apps* → *Manage Developer Apps* → *New access token*
2. Pick a **provider** tab (defaults to **Groq**); paste the API key. For Ollama, pick the model marked ⭐ Recommended.
3. Click **Connect**

> Your token and key are saved in the browser, so the next time you open Minisana it reconnects automatically.

You only need one provider key:

- **Groq** (free, recommended) — https://console.groq.com
- **OpenAI** — https://platform.openai.com/api-keys
- **Claude (Anthropic)** — https://console.anthropic.com/settings/keys (key starts with `sk-ant-…`)
- **Ollama** — no key, local-only (the setup wizard handles install + model pull)

---

## Manual install (if you'd rather do each step yourself)

1. **Get the code** — clone or download this repository, then `cd minisana`.
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **(Optional) Install the CLI globally** so you can call `minisana` from anywhere:
   ```bash
   npm link            # use `sudo npm link` if you hit EACCES
   ```
   This gives you:

   | Command            | What it does                                    |
   |--------------------|-------------------------------------------------|
   | `minisana start`   | Start the server in the background              |
   | `minisana stop`    | Stop the running server                         |
   | `minisana restart` | Restart it                                      |
   | `minisana status`  | Check if it's running (PID + URL + logs)        |
   | `minisana doctor`  | Scan your system and recommend an Ollama model  |
   | `minisana setup`   | Run the interactive setup wizard again          |

   Logs go to `/tmp/minisana.log`. Skip `npm link` and use `npm start` instead if you'd rather run in the foreground.

4. **(Optional, Ollama only) Pick + pull the right model for your hardware:**
   ```bash
   minisana doctor               # prints the model that fits your RAM
   ollama pull <model-it-printed>
   ```
   Rough sizing:

   | RAM         | Recommended model | Size    |
   |-------------|-------------------|---------|
   | ≤ 11 GB     | `llama3.2:3b`     | ~2 GB   |
   | 12–22 GB    | `llama3.1:8b`     | ~5 GB   |
   | 23–40 GB    | `qwen2.5:14b`     | ~9 GB   |
   | 41 GB+      | `qwen2.5:32b`     | ~20 GB  |

   (Make sure the `ollama` CLI is on your PATH — open a new terminal and run `ollama --version`. Install from https://ollama.com/download if needed.)

5. **Start the server:**
   ```bash
   minisana start                # or: npm start
   ```

6. **Open http://localhost:3000**, paste your Asana token + provider key, and click **Connect**.

---

## Example commands

- *"What tasks do I have to do?"*
- *"Mark the login bug as complete"*
- *"Move the payment task to In Progress"*
- *"Assign the API task to sarah@company.com"*
- *"Create a task to review the Q2 report due Friday"*
- *"Generate my daily standup"*

You can also work directly in the **task panel** on the right: search, filter, quick-add, multi-select, and bulk-move tasks without typing a prompt.

**Attach an image:** paste it directly into the chat input or a task's comment composer — it uploads as an Asana attachment on the next message/comment.

---

## Notes

- Your Asana and LLM keys live **only in your browser's localStorage** — they never leave your machine except to talk to the provider you chose.
- Ollama runs **fully offline** once the model is pulled.
- The server listens on port **3000** (not currently configurable).
- To stop the foreground server: `Ctrl+C`. To stop the background daemon: `minisana stop`.

---

## Troubleshooting

- **`minisana: command not found`** — run `npm link` from the project folder. If it errors with `EACCES`, try `sudo npm link`.
- **Port 3000 already in use** — `minisana start` will `kill -9` **anything** listening on :3000 (not just stale Minisana processes), so close other apps using that port first. If a stuck process persists, run `lsof -ti :3000 | xargs kill -9`.
- **Ollama "didn't respond"** on boot — make sure Ollama is installed, that `ollama --version` works from your terminal, and that `ollama serve` runs manually.
- **Check what the server is doing** — `tail -f /tmp/minisana.log`.
