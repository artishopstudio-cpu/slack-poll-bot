const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: "200mb" }));

app.use(express.static(path.join(__dirname, "public")));

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const polls = new Map();

function slackApi(method, data) {
  return axios.post(`https://slack.com/api/${method}`, data, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" }
  });
}

function pollKey(channel, ts) { return `${channel}:${ts}`; }

// DEBUG
app.get("/debug-channels", async (req, res) => {
  try {
    const result = await slackApi("conversations.list", { types: "public_channel,private_channel", limit: 10 });
    res.json(result.data);
  } catch (err) { res.json({ error: err.message }); }
});

// CHANNELS DROPDOWN
app.get("/channels", async (req, res) => {
  try {
    const result = await axios.post("https://slack.com/api/conversations.list", {
      types: "public_channel,private_channel", limit: 200, exclude_archived: true
    }, { headers: { Authorization: "Bearer " + BOT_TOKEN, "Content-Type": "application/json" } });
    const allChannels = result.data.channels || [];
    const channels = allChannels
      .filter(c => c && !c.is_archived && c.id && c.name)
      .map(c => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "he"));
    res.json({ ok: true, channels });
  } catch (err) {
    res.json({ ok: false, error: err.message, channels: [] });
  }
});

// UPLOAD FILE TO SLACK (images + videos)
app.post("/upload-file", async (req, res) => {
  try {
    const { data, filename, channel } = req.body;
    const matches = data.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.json({ ok: false, error: "Invalid file data" });

    const mimeType = matches[1];
    const buffer = Buffer.from(matches[2], "base64");
    const fname = filename || `upload-${Date.now()}`;

    // Step 1: Get Slack upload URL
    const getUrlRes = await axios.post("https://slack.com/api/files.getUploadURLExternal", {
      filename: fname,
      length: buffer.length
    }, { headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" } });

    if (!getUrlRes.data.ok) return res.json({ ok: false, error: getUrlRes.data.error });

    const { upload_url, file_id } = getUrlRes.data;

    // Step 2: Upload bytes to Slack
    await axios.post(upload_url, buffer, {
      headers: { "Content-Type": mimeType, "Content-Length": buffer.length },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    // Step 3: Complete upload
    const completeRes = await axios.post("https://slack.com/api/files.completeUploadExternal", {
      files: [{ id: file_id }],
      channel_id: channel || undefined
    }, { headers: { Authorization: `Bearer ${BOT_TOKEN}`, "Content-Type": "application/json" } });

    if (!completeRes.data.ok) return res.json({ ok: false, error: completeRes.data.error });

    const fileInfo = completeRes.data.files?.[0];
    res.json({
      ok: true,
      file_id,
      permalink: fileInfo?.permalink,
      url_private: fileInfo?.url_private,
      isVideo: mimeType.startsWith("video/"),
      isImage: mimeType.startsWith("image/"),
      mimeType
    });
  } catch (err) {
    console.error("upload error:", err.response?.data || err.message);
    res.json({ ok: false, error: err.message });
  }
});

// CREATE POLL
app.post("/create-poll", async (req, res) => {
  const { title, channel, options } = req.body;
  const pollData = { id: Date.now().toString(36), title, options, votes: {}, createdBy: "web", channel };
  try {
    const msgRes = await slackApi("chat.postMessage", { channel, text: title, blocks: buildPollMessage(pollData) });
    if (!msgRes.data.ok) return res.json({ ok: false, error: msgRes.data.error });
    polls.set(pollKey(channel, msgRes.data.ts), pollData);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.response?.data?.error || err.message });
  }
});

// SLASH COMMAND
app.post("/newpoll", (req, res) => {
  const host = process.env.PUBLIC_URL || `https://slack-poll-bot-production.up.railway.app`;
  res.json({ response_type: "ephemeral", text: `📊 *Build your poll here:*\n${host}\n\n_Only you can see this link_` });
});

// VOTE INTERACTIONS
app.post("/interactions", async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  if (payload.type === "block_actions") {
    const actionId = payload.actions[0].action_id;
    if (actionId.startsWith("vote_")) {
      res.send("");
      const optionIndex = parseInt(actionId.split("_")[1]);
      const userId = payload.user.id;
      const channel = payload.channel?.id;
      const ts = payload.message?.ts;
      const poll = polls.get(pollKey(channel, ts));
      if (!poll) return;
      if (poll.votes[userId] === optionIndex) { delete poll.votes[userId]; }
      else { poll.votes[userId] = optionIndex; }
      await slackApi("chat.update", { channel, ts, text: poll.title, blocks: buildPollMessage(poll) });
      return;
    }
  }
  res.send("");
});

function buildPollMessage(poll) {
  const tallies = new Array(poll.options.length).fill(0);
  const voters = {};
  poll.options.forEach((_, i) => { voters[i] = []; });
  for (const [userId, optIdx] of Object.entries(poll.votes)) {
    tallies[optIdx]++;
    voters[optIdx].push(userId);
  }
  const totalVotes = Object.keys(poll.votes).length;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `📊 *${poll.title}*\n_${totalVotes} vote${totalVotes !== 1 ? "s" : ""} so far_` } },
    { type: "divider" }
  ];
  poll.options.forEach((opt, i) => {
    const count = tallies[i];
    const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    const voterList = voters[i].length > 0 ? voters[i].map(u => `<@${u}>`).join(", ") : "_no votes yet_";

    if (opt.isImage && opt.imageUrl) {
      blocks.push({ type: "image", image_url: opt.imageUrl, alt_text: opt.text });
    } else if (opt.isVideo && opt.imageUrl) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `🎬 <${opt.imageUrl}|▶ Watch: ${opt.text}>` } });
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${opt.text}*\n${bar} *${pct}%* (${count})\n${voterList}` },
      accessory: { type: "button", text: { type: "plain_text", text: `Vote: ${opt.text}` }, value: String(i), action_id: `vote_${i}` }
    });
    blocks.push({ type: "divider" });
  });
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Poll ID: \`${poll.id}\`` }] });
  return blocks;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Poll bot running on port ${PORT}`));
