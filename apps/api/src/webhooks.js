// Outbound webhook fanout. Gated per-channel by env var. Posts are fire-and-forget
// behind a tiny in-process queue so the request hot-path never waits.

import { logger } from "./logger.js";

const SLACK = process.env.SLACK_WEBHOOK_URL || "";
const DISCORD = process.env.DISCORD_WEBHOOK_URL || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

const queue = [];
let pumping = false;

export function enabled() { return !!(SLACK || DISCORD); }

function enqueue(post) { queue.push(post); pump(); }

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const p = queue.shift();
      try {
        const res = await fetch(p.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p.body) });
        if (!res.ok) logger.warn({ status: res.status, channel: p.channel }, "webhook returned non-2xx");
      } catch (err) {
        logger.error({ err: err.message, channel: p.channel }, "webhook post failed");
      }
    }
  } finally { pumping = false; }
}

// ---- typed events ----

export function notifyCommentCreated({ projectName, sourceTitle, authorName, content, projectId, timestampMs }) {
  const link = `${PUBLIC_URL}/?project=${encodeURIComponent(projectId)}`;
  const tc = formatTc(timestampMs);
  const snippet = content.length > 320 ? content.slice(0, 320) + "…" : content;
  const text = `💬 *${authorName}* đã comment trên *${projectName} / ${sourceTitle}* @ \`${tc}\`\n>${snippet}\n${link}`;
  fanout("comment.created", text, {
    slack: { text, attachments: [{ color: "#2da8e2", title: `${projectName} / ${sourceTitle}`, title_link: link, text: snippet, footer: `Comment @ ${tc} · by ${authorName}` }] },
    discord: { content: text },
  });
}

export function notifyCommentResolved({ projectName, sourceTitle, resolverName, projectId }) {
  const link = `${PUBLIC_URL}/?project=${encodeURIComponent(projectId)}`;
  const text = `✅ *${resolverName}* đã đánh dấu xong 1 comment trên *${projectName} / ${sourceTitle}*\n${link}`;
  fanout("comment.resolved", text, { slack: { text }, discord: { content: text } });
}

export function notifyProjectArchived({ projectName, actorName, projectId }) {
  const link = `${PUBLIC_URL}/?project=${encodeURIComponent(projectId)}`;
  const text = `📦 *${actorName}* đã archive project *${projectName}*\n${link}`;
  fanout("project.archived", text, { slack: { text }, discord: { content: text } });
}

function fanout(channel, fallbackText, payloads) {
  if (SLACK) enqueue({ url: SLACK, channel, body: payloads.slack || { text: fallbackText } });
  if (DISCORD) enqueue({ url: DISCORD, channel, body: payloads.discord || { content: fallbackText } });
}

function formatTc(ms) {
  if (!ms || ms < 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const ss = total % 60, mm = Math.floor(total / 60) % 60, hh = Math.floor(total / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}
