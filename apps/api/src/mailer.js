// Optional email notifications. Disabled unless SMTP_URL is set.
// Format: SMTP_URL=smtps://user:pass@host:465 (or smtp://host:587 for STARTTLS).
//
// Lazy-loads nodemailer so memory-mode dev doesn't need the dep installed.
//
// All notifications are queued through a tiny in-process queue so the request
// hot-path never waits on SMTP. Errors are logged but never thrown.

import { logger } from "./logger.js";

const SMTP_URL = process.env.SMTP_URL || "";
const FROM_ADDR = process.env.SMTP_FROM || "Coopeditor <no-reply@example.com>";
const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");

// DIGEST_MINUTES = 0 (default) → send 1 email per comment immediately.
// DIGEST_MINUTES > 0 → batch per recipient and flush every N minutes.
const DIGEST_MINUTES = Math.max(0, Number.parseInt(process.env.EMAIL_DIGEST_MINUTES || "0", 10) || 0);
const DIGEST_INTERVAL_MS = DIGEST_MINUTES * 60_000;
const digestBuckets = new Map(); // recipient -> { entries: [...], scheduled }

let transporterPromise = null;
const queue = [];
let pumping = false;

async function getTransporter() {
  if (!SMTP_URL) return null;
  if (transporterPromise) return transporterPromise;
  transporterPromise = (async () => {
    try {
      const mod = await import("nodemailer");
      const nm = mod.default || mod;
      const t = nm.createTransport(SMTP_URL);
      logger.info({ smtp_url: redact(SMTP_URL) }, "smtp transporter ready");
      return t;
    } catch (err) {
      logger.error({ err: err.message }, "nodemailer load failed — emails disabled");
      return null;
    }
  })();
  return transporterPromise;
}

function redact(url) { return url.replace(/(:\/\/)[^:]+:[^@]+(@)/, "$1***:***$2"); }

export function enabled() { return !!SMTP_URL; }

export function enqueue(msg) {
  if (!SMTP_URL) return;
  queue.push(msg);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    const t = await getTransporter();
    if (!t) { queue.length = 0; return; }
    while (queue.length) {
      const msg = queue.shift();
      try {
        await t.sendMail({ from: FROM_ADDR, ...msg });
      } catch (err) {
        logger.error({ err: err.message, to: msg.to }, "smtp send failed");
      }
    }
  } finally {
    pumping = false;
  }
}

// --- typed notifications ---

export function notifyComment({ recipients, projectName, sourceTitle, authorName, content, projectId, timestampMs }) {
  if (!recipients || !recipients.length) return;
  const link = `${PUBLIC_URL}/?project=${encodeURIComponent(projectId)}`;
  const entry = { projectName, sourceTitle, authorName, content, link, timestampMs, at: Date.now() };
  if (DIGEST_MINUTES > 0) {
    for (const to of recipients) bucketAdd(to, entry);
    return;
  }
  const subject = `[${projectName}] ${authorName} đã comment trên ${sourceTitle}`;
  const tc = formatTc(timestampMs);
  const text =
    `${authorName} vừa thêm comment tại ${tc} trong ${sourceTitle}:\n\n` +
    `  ${content.slice(0, 400)}\n\n` +
    `Mở project: ${link}\n` +
    `— Coopeditor`;
  for (const to of recipients) enqueue({ to, subject, text });
}

function bucketAdd(recipient, entry) {
  let b = digestBuckets.get(recipient);
  if (!b) { b = { entries: [], timer: null }; digestBuckets.set(recipient, b); }
  b.entries.push(entry);
  if (!b.timer) {
    b.timer = setTimeout(() => flushBucket(recipient).catch((err) => logger.error({ err: err.message, to: recipient }, "digest flush failed")), DIGEST_INTERVAL_MS);
    b.timer.unref?.();
  }
}

async function flushBucket(recipient) {
  const b = digestBuckets.get(recipient);
  if (!b) return;
  digestBuckets.delete(recipient);
  if (!b.entries.length) return;
  const entries = b.entries;
  const subject = entries.length === 1
    ? `[${entries[0].projectName}] ${entries[0].authorName} đã comment trên ${entries[0].sourceTitle}`
    : `[Coopeditor] ${entries.length} comment mới trong ${new Set(entries.map((e) => e.projectName)).size} project`;
  const lines = [];
  if (entries.length > 1) lines.push(`Bạn có ${entries.length} comment mới trong ${DIGEST_MINUTES} phút qua:\n`);
  for (const e of entries) {
    const tc = formatTc(e.timestampMs);
    lines.push(`• [${e.projectName} / ${e.sourceTitle}] ${e.authorName} @ ${tc}`);
    lines.push(`  ${e.content.slice(0, 280)}`);
    lines.push(`  Mở: ${e.link}\n`);
  }
  lines.push("— Coopeditor");
  enqueue({ to: recipient, subject, text: lines.join("\n") });
}

// On process exit, flush every pending bucket so users don't lose notifications.
export async function flushAllDigests() {
  const recipients = [...digestBuckets.keys()];
  for (const r of recipients) {
    const b = digestBuckets.get(r);
    if (b && b.timer) { clearTimeout(b.timer); b.timer = null; }
    await flushBucket(r);
  }
}

function formatTc(ms) {
  const total = Math.floor(ms / 1000);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}
