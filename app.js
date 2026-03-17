const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "20mb" })); // Allow large base64 images

// Serve the web UI
app.use(express.static(path.join(__dirname, "public")));

// Uploaded images stored temporarily in /public/uploads/
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─────────────────────────────────────────────
// ROUTE: /upload-image — receives base64, saves to disk, returns URL
// ─────────────────────────────────────────────
app.post("/upload-image", (req, res) => {
  try {
    const { data } = req.body; // base64 data URL
    const matches = data.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) return res.json({ ok: false, error: "Invalid image data" });

    const ext = matches[1];
    const buffer = Buffer.from(matches[2], "base64");
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    fs.writeFileSync(filepath, buffer);

    const host = process.env.PUBLIC_URL || `https://slack-poll-bot-production.up.railway.app`;
    res.json({ ok: true, url: `${host}/uploads/${filename}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE: /create-poll — called from web UI
// ─────────────────────────────────────────────
app.post("/create-poll", async (req, res) => {
  const { title, channel, options } = req.body;

  const pollData = {
    id: Date.now().toString(36),
    title,
    options,
    votes: {},
    createdBy: "web",
    channel
  };

  try {
    const msgRes = await slackApi("chat.postMessage", {
      channel,
      text: title,
      blocks: buildPollMessage(pollData)
    });

    if (!msgRes.data.ok) {
      return res.json({ ok: false, error: msgRes.data.error });
    }

    const ts = msgRes.data.ts;
    const key = pollKey(channel, ts);
    polls.set(key, pollData);

    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data?.error || err.message });
  }
});

// ─────────────────────────────────────────────
// ROUTE: /newpoll — slash command → redirect to web UI
// ─────────────────────────────────────────────

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ─────────────────────────────────────────────
// IN-MEMORY VOTE STATE
// Key: message ts + channel
// Value: { title, options: [{text, imageUrl}], votes: {userId: optionIndex} }
// ─────────────────────────────────────────────
const polls = new Map();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function slackApi(method, data) {
  return axios.post(`https://slack.com/api/${method}`, data, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" }
  });
}

function pollKey(channel, ts) {
  return `${channel}:${ts}`;
}

// ─────────────────────────────────────────────
// MODAL BUILDER
// count = number of option rows
// ─────────────────────────────────────────────
function buildModal(count, existingValues = {}) {
  const optionBlocks = Array.from({ length: count }).flatMap((_, i) => {
    const blocks = [
      {
        type: "input",
        block_id: `option_text_${i}`,
        label: { type: "plain_text", text: `Option ${i + 1}` },
        element: {
          type: "plain_text_input",
          action_id: "input",
          placeholder: { type: "plain_text", text: "e.g. Blue Minimal Design" },
          initial_value: existingValues[`option_text_${i}`] || undefined
        }
      },
      {
        type: "input",
        block_id: `option_img_${i}`,
        optional: true,
        label: { type: "plain_text", text: `Option ${i + 1} Image URL (optional)` },
        element: {
          type: "plain_text_input",
          action_id: "input",
          placeholder: { type: "plain_text", text: "https://..." },
          initial_value: existingValues[`option_img_${i}`] || undefined
        }
      }
    ];
    return blocks;
  });

  return {
    type: "modal",
    callback_id: "poll_modal",
    title: { type: "plain_text", text: "📊 New Design Poll" },
    submit: { type: "plain_text", text: "Post Poll" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ optionCount: count }),
    blocks: [
      {
        type: "input",
        block_id: "poll_title",
        label: { type: "plain_text", text: "Poll Question" },
        element: {
          type: "plain_text_input",
          action_id: "input",
          placeholder: { type: "plain_text", text: "Which design do you prefer?" },
          initial_value: existingValues["poll_title"] || undefined
        }
      },
      {
        type: "input",
        block_id: "poll_channel",
        label: { type: "plain_text", text: "Post to Channel" },
        element: {
          type: "conversations_select",
          action_id: "input",
          default_to_current_conversation: true,
          filter: { include: ["public", "private"], exclude_bot_users: true }
        }
      },
      { type: "divider" },
      ...optionBlocks,
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "➕ Add Option" },
            action_id: "add_option",
            style: "primary"
          },
          ...(count > 2 ? [{
            type: "button",
            text: { type: "plain_text", text: "➖ Remove Last" },
            action_id: "remove_option"
          }] : [])
        ]
      }
    ]
  };
}

// ─────────────────────────────────────────────
// POLL MESSAGE BUILDER (with live vote counts)
// ─────────────────────────────────────────────
function buildPollMessage(poll) {
  // Tally votes
  const tallies = new Array(poll.options.length).fill(0);
  const voters = {}; // optionIndex -> [userIds]
  poll.options.forEach((_, i) => { voters[i] = []; });

  for (const [userId, optIdx] of Object.entries(poll.votes)) {
    tallies[optIdx]++;
    voters[optIdx].push(userId);
  }

  const totalVotes = Object.keys(poll.votes).length;

  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `📊 *${poll.title}*\n_${totalVotes} vote${totalVotes !== 1 ? "s" : ""} so far — click to vote!_` }
    },
    { type: "divider" }
  ];

  // Each option: image (if any) + vote bar + button
  poll.options.forEach((opt, i) => {
    const count = tallies[i];
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const bar = buildBar(pct);
    const voterList = voters[i].length > 0
      ? voters[i].map(u => `<@${u}>`).join(", ")
      : "_no votes yet_";

    if (opt.imageUrl) {
      blocks.push({
        type: "image",
        image_url: opt.imageUrl,
        alt_text: opt.text
      });
    }

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${opt.text}*\n${bar} *${pct}%* (${count})\n${voterList}`
      },
      accessory: {
        type: "button",
        text: { type: "plain_text", text: `Vote for ${opt.text}` },
        value: String(i),
        action_id: `vote_${i}`
      }
    });

    blocks.push({ type: "divider" });
  });

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `Posted by <@${poll.createdBy}> • Poll ID: \`${poll.id}\`` }
    ]
  });

  return blocks;
}

function buildBar(pct) {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

// ─────────────────────────────────────────────
// ROUTE: /newpoll — slash command
// ─────────────────────────────────────────────
app.post("/newpoll", async (req, res) => {
  const host = process.env.PUBLIC_URL || `https://slack-poll-bot-production.up.railway.app`;
  res.json({
    response_type: "ephemeral",
    text: `📊 *Build your poll here:*\n${host}\n\n_Only you can see this link_`
  });
});

// ─────────────────────────────────────────────
// ROUTE: /interactions — all UI events
// ─────────────────────────────────────────────
app.post("/interactions", async (req, res) => {
  const payload = JSON.parse(req.body.payload);

  // ── BLOCK ACTIONS (button clicks inside modal) ──
  if (payload.type === "block_actions") {
    const actionId = payload.actions[0].action_id;

    // ── Add / Remove option in modal ──
    if (actionId === "add_option" || actionId === "remove_option") {
      res.send(""); // Must respond fast

      const meta = JSON.parse(payload.view.private_metadata || "{}");
      let count = meta.optionCount || 2;

      // Preserve current input values so user doesn't lose them
      const currentValues = {};
      const stateValues = payload.view.state.values || {};

      currentValues["poll_title"] = stateValues["poll_title"]?.input?.value || undefined;

      for (let i = 0; i < count; i++) {
        currentValues[`option_text_${i}`] = stateValues[`option_text_${i}`]?.input?.value || undefined;
        currentValues[`option_img_${i}`] = stateValues[`option_img_${i}`]?.input?.value || undefined;
      }

      if (actionId === "add_option") count = Math.min(count + 1, 10);
      if (actionId === "remove_option") count = Math.max(count - 1, 2);

      await slackApi("views.update", {
        view_id: payload.view.id,
        view: buildModal(count, currentValues)
      });

      return;
    }

    // ── Vote button click (in channel message) ──
    if (actionId.startsWith("vote_")) {
      res.send(""); // Respond fast

      const optionIndex = parseInt(actionId.split("_")[1]);
      const userId = payload.user.id;
      const channel = payload.channel?.id;
      const ts = payload.message?.ts;
      const key = pollKey(channel, ts);

      const poll = polls.get(key);
      if (!poll) return;

      // Toggle vote (click same = unvote, click different = switch)
      if (poll.votes[userId] === optionIndex) {
        delete poll.votes[userId]; // unvote
      } else {
        poll.votes[userId] = optionIndex; // vote or switch
      }

      // Update the message with new counts
      await slackApi("chat.update", {
        channel,
        ts,
        text: poll.title,
        blocks: buildPollMessage(poll)
      });

      return;
    }
  }

  // ── MODAL SUBMISSION ──
  if (payload.type === "view_submission") {
    res.json({ response_action: "clear" }); // Close modal

    const values = payload.view.state.values;
    const meta = JSON.parse(payload.view.private_metadata || "{}");
    const count = meta.optionCount || 2;

    const title = values["poll_title"]?.input?.value || "Poll";
    const channel = values["poll_channel"]?.input?.selected_conversation;

    const options = [];
    for (let i = 0; i < count; i++) {
      const text = values[`option_text_${i}`]?.input?.value;
      const imageUrl = values[`option_img_${i}`]?.input?.value || null;
      if (text) options.push({ text, imageUrl });
    }

    if (options.length < 2) return; // Safety check

    const pollData = {
      id: Date.now().toString(36),
      title,
      options,
      votes: {},
      createdBy: payload.user.id,
      channel
    };

    try {
      const msgRes = await slackApi("chat.postMessage", {
        channel,
        text: title,
        blocks: buildPollMessage(pollData)
      });

      const ts = msgRes.data.ts;
      const key = pollKey(channel, ts);
      polls.set(key, pollData);
    } catch (err) {
      console.error("chat.postMessage failed:", err.response?.data || err.message);
    }

    return;
  }

  res.send("");
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🗳️  Poll bot running on port ${PORT}`));
