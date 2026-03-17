# 🗳️ Slack Design Poll Bot

Let your team vote on design options — with images, real-time results, and vote switching.

---

## What It Does

- `/newpoll` → opens a modal
- Add a question + up to 10 options (text + optional image URL each)
- Posts poll to any channel
- Live vote bar updates every time someone votes
- Click your own vote = unvote
- Click a different option = switch vote

---

## Setup (Step by Step)

### 1. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "Poll Bot", pick your workspace

---

### 2. Add Permissions (OAuth Scopes)

Go to **OAuth & Permissions** → **Bot Token Scopes** → Add:

| Scope | Why |
|-------|-----|
| `chat:write` | Post poll messages |
| `chat:write.public` | Post in public channels without being invited |
| `commands` | Register /newpoll |
| `channels:read` | List channels |
| `groups:read` | List private channels |

Then: **Install App to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`)

---

### 3. Enable Interactivity

Go to **Interactivity & Shortcuts**:
- Toggle ON
- Set **Request URL** to: `https://YOUR_SERVER/interactions`

---

### 4. Add Slash Command

Go to **Slash Commands** → **Create New Command**:

| Field | Value |
|-------|-------|
| Command | `/newpoll` |
| Request URL | `https://YOUR_SERVER/newpoll` |
| Description | Create a design poll |

---

### 5. Run the Server

```bash
npm install
SLACK_BOT_TOKEN=xoxb-YOUR-TOKEN node app.js
```

For local dev, expose port 3000 with [ngrok](https://ngrok.com):
```bash
ngrok http 3000
```
Use the `https://xxxx.ngrok.io` URL in your Slack app settings.

---

### 6. Deploy to Production

**Railway (recommended — free tier)**:
```bash
# Install Railway CLI
npm install -g @railway/cli

railway login
railway init
railway up
```

Set env var: `SLACK_BOT_TOKEN=xoxb-...`

**Or Render**: Connect your GitHub repo, set env var, deploy.

---

## Usage

```
/newpoll
```

Fill in:
- **Poll Question**: "Which homepage design do you prefer?"
- **Option 1**: "Minimal" + `https://...image1.jpg`
- **Option 2**: "Bold" + `https://...image2.jpg`
- Click **➕ Add Option** for more
- Hit **Post Poll**

The poll appears in your chosen channel. Team members click buttons to vote. Results update live.

---

## Architecture

```
User types /newpoll
       ↓
Slack → POST /newpoll
       ↓
Server calls views.open (modal with 2 options)
       ↓
User clicks ➕ Add Option
       ↓
Slack → POST /interactions (block_actions)
       ↓
Server reads current values + calls views.update (+1 option)
       ↓
User submits modal
       ↓
Slack → POST /interactions (view_submission)
       ↓
Server saves poll state → calls chat.postMessage
       ↓
User clicks vote button
       ↓
Slack → POST /interactions (block_actions: vote_N)
       ↓
Server updates poll.votes → calls chat.update (live bar refresh)
```

---

## Limitations

- **State is in-memory** — votes reset on server restart. For production, swap `polls` Map for a database (Redis, Postgres, SQLite).
- **Images must be public URLs** — Slack fetches them directly.
- **Max 10 options** — Slack Block Kit has a 50-block limit per message.
- **One vote per person per poll** — by design.

---

## Adding a Database (Optional)

Replace the in-memory `polls` Map with SQLite for persistence:

```bash
npm install better-sqlite3
```

```js
const Database = require('better-sqlite3');
const db = new Database('polls.db');

db.exec(`CREATE TABLE IF NOT EXISTS polls (
  key TEXT PRIMARY KEY,
  data TEXT
)`);

function savePoll(key, poll) {
  db.prepare('INSERT OR REPLACE INTO polls VALUES (?, ?)').run(key, JSON.stringify(poll));
}

function loadPoll(key) {
  const row = db.prepare('SELECT data FROM polls WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : null;
}
```

Then replace `polls.get(key)` → `loadPoll(key)` and `polls.set(key, data)` → `savePoll(key, data)`.
