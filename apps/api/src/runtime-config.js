import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const APP_DATA_DIR = process.env.APP_DATA_DIR || "/data";
const CONFIG_PATH = process.env.APP_CONFIG_PATH || join(APP_DATA_DIR, "system", "config.json");

function ensureDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function envOr(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function appDataDir() {
  return APP_DATA_DIR;
}

export function configPath() {
  return CONFIG_PATH;
}

export function readRuntimeConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return parseJson(readFileSync(CONFIG_PATH, "utf8"));
}

export function isRuntimeConfigured() {
  const cfg = readRuntimeConfig();
  return !!(cfg && typeof cfg.publicUrl === "string" && cfg.publicUrl.trim());
}

export function publicRuntimeSummary() {
  const cfg = readRuntimeConfig();
  if (!cfg) {
    return {
      configured: false,
      appDataDir: APP_DATA_DIR,
      updater: {
        feedUrl: process.env.UPDATE_FEED_URL || "",
        triggerUrl: process.env.UPDATE_TRIGGER_URL || "",
        pollIntervalSeconds: clampInt(process.env.UPDATE_POLL_INTERVAL_SECONDS, 900, 30, 86400),
        feedConfigured: !!process.env.UPDATE_FEED_URL,
        triggerConfigured: !!process.env.UPDATE_TRIGGER_URL,
      },
    };
  }
  return {
    configured: true,
    appDataDir: APP_DATA_DIR,
    configPath: CONFIG_PATH,
    publicUrl: cfg.publicUrl || "",
    dsmHost: cfg.dsmHost || "",
    dsmMountRoot: cfg.dsmMountRoot || "/nas",
    dsmDevLogin: !!cfg.dsmDevLogin,
    dsmInsecure: !!cfg.dsmInsecure,
    oidcEnabled: !!(cfg.oidc && cfg.oidc.issuerUrl && cfg.oidc.clientId && cfg.oidc.clientSecret && cfg.oidc.redirectUri),
    smtpEnabled: !!(cfg.smtp && cfg.smtp.url),
    webhookEnabled: !!((cfg.webhooks && cfg.webhooks.slackWebhookUrl) || (cfg.webhooks && cfg.webhooks.discordWebhookUrl)),
    hlsCdnEnabled: !!(cfg.hls && cfg.hls.cdnPublicUrl),
    transcode: {
      hwaccel: (cfg.transcode && cfg.transcode.hwaccel) || "",
      codecLadder: (cfg.transcode && cfg.transcode.codecLadder) || "h264",
      workerConcurrency: (cfg.transcode && cfg.transcode.workerConcurrency) || 2,
    },
    updater: {
      feedUrl: (cfg.updater && cfg.updater.feedUrl) || process.env.UPDATE_FEED_URL || "",
      triggerUrl: (cfg.updater && cfg.updater.triggerUrl) || process.env.UPDATE_TRIGGER_URL || "",
      pollIntervalSeconds: (cfg.updater && cfg.updater.pollIntervalSeconds) || clampInt(process.env.UPDATE_POLL_INTERVAL_SECONDS, 900, 30, 86400),
      feedConfigured: !!((cfg.updater && cfg.updater.feedUrl) || process.env.UPDATE_FEED_URL),
      triggerConfigured: !!((cfg.updater && cfg.updater.triggerUrl) || process.env.UPDATE_TRIGGER_URL),
    },
  };
}

export function normalizeRuntimeConfig(input) {
  const publicUrl = String(input.publicUrl || "").trim().replace(/\/+$/, "");
  const dsmHost = String(input.dsmHost || "").trim().replace(/\/+$/, "");
  const dsmMountRoot = String(input.dsmMountRoot || "/nas").trim().replace(/\/+$/, "");
  const oidc = input.oidc && typeof input.oidc === "object" ? input.oidc : {};
  const smtp = input.smtp && typeof input.smtp === "object" ? input.smtp : {};
  const webhooks = input.webhooks && typeof input.webhooks === "object" ? input.webhooks : {};
  const hls = input.hls && typeof input.hls === "object" ? input.hls : {};
  const transcode = input.transcode && typeof input.transcode === "object" ? input.transcode : {};
  const retention = input.retention && typeof input.retention === "object" ? input.retention : {};
  const updater = input.updater && typeof input.updater === "object" ? input.updater : {};

  if (!publicUrl) throw new Error("publicUrl required");
  const parsedPublicUrl = new URL(publicUrl);
  const normalized = {
    publicUrl,
    dsmHost,
    dsmMountRoot,
    dsmDevLogin: !!input.dsmDevLogin,
    dsmInsecure: !!input.dsmInsecure,
    oidc: {
      issuerUrl: String(oidc.issuerUrl || "").trim().replace(/\/+$/, ""),
      clientId: String(oidc.clientId || "").trim(),
      clientSecret: String(oidc.clientSecret || "").trim(),
      redirectUri: String(oidc.redirectUri || "").trim(),
      scopes: String(oidc.scopes || "openid email profile").trim() || "openid email profile",
    },
    smtp: {
      url: String(smtp.url || "").trim(),
      from: String(smtp.from || "Coopeditor <no-reply@example.com>").trim(),
      digestMinutes: clampInt(smtp.digestMinutes, 0, 0, 1440),
    },
    webhooks: {
      slackWebhookUrl: String(webhooks.slackWebhookUrl || "").trim(),
      discordWebhookUrl: String(webhooks.discordWebhookUrl || "").trim(),
    },
    hls: {
      cdnPublicUrl: String(hls.cdnPublicUrl || "").trim().replace(/\/+$/, ""),
      cdnSigningSecret: String(hls.cdnSigningSecret || "").trim(),
      cdnTokenTtlSeconds: clampInt(hls.cdnTokenTtlSeconds, 300, 30, 86400),
    },
    transcode: {
      hwaccel: normalizeEnum(transcode.hwaccel, ["", "nvenc", "qsv"], ""),
      codecLadder: normalizeEnum(transcode.codecLadder, ["h264", "h265", "mixed"], "h264"),
      workerConcurrency: clampInt(transcode.workerConcurrency, 2, 1, 16),
      autoscaleThreshold: clampInt(transcode.autoscaleThreshold, 5, 1, 1000),
      autoscaleStep: clampInt(transcode.autoscaleStep, 1, 1, 16),
      maxConcurrency: clampInt(transcode.maxConcurrency, 3, 1, 32),
    },
    retention: {
      auditDays: clampInt(retention.auditDays, 365, 1, 36500),
      projectPurgeDays: clampInt(retention.projectPurgeDays, 90, 1, 3650),
      commentPurgeDays: clampInt(retention.commentPurgeDays, 30, 1, 3650),
      sweepMinutes: clampInt(retention.sweepMinutes, 60, 5, 1440),
    },
    updater: {
      feedUrl: String(updater.feedUrl || process.env.UPDATE_FEED_URL || "").trim(),
      triggerUrl: String(updater.triggerUrl || process.env.UPDATE_TRIGGER_URL || "").trim(),
      triggerToken: String(updater.triggerToken || "").trim(),
      pollIntervalSeconds: clampInt(updater.pollIntervalSeconds, clampInt(process.env.UPDATE_POLL_INTERVAL_SECONDS, 900, 30, 86400), 30, 86400),
    },
    savedAt: new Date().toISOString(),
    scheme: parsedPublicUrl.protocol.replace(":", ""),
  };

  if (!normalized.dsmHost && !normalized.dsmDevLogin) {
    throw new Error("Provide dsmHost or enable dsmDevLogin");
  }
  if (normalized.oidc.issuerUrl || normalized.oidc.clientId || normalized.oidc.clientSecret || normalized.oidc.redirectUri) {
    if (!(normalized.oidc.issuerUrl && normalized.oidc.clientId && normalized.oidc.clientSecret && normalized.oidc.redirectUri)) {
      throw new Error("OIDC requires issuerUrl, clientId, clientSecret, redirectUri");
    }
  }
  return normalized;
}

export function writeRuntimeConfig(input) {
  const config = normalizeRuntimeConfig(input);
  ensureDir(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  return config;
}

export function applyRuntimeEnvFromConfig(config = readRuntimeConfig()) {
  if (!config) return false;
  process.env.PUBLIC_URL = config.publicUrl;
  process.env.ALLOWED_ORIGINS = config.publicUrl;
  process.env.DSM_HOST = config.dsmHost || "";
  process.env.DSM_MOUNT_ROOT = config.dsmMountRoot || "/nas";
  process.env.DSM_DEV_LOGIN = config.dsmDevLogin ? "1" : "";
  process.env.DSM_INSECURE = config.dsmInsecure ? "1" : "";
  process.env.COOKIE_SECURE = config.scheme === "https" ? "1" : "";

  process.env.OIDC_ISSUER_URL = config.oidc && config.oidc.issuerUrl || "";
  process.env.OIDC_CLIENT_ID = config.oidc && config.oidc.clientId || "";
  process.env.OIDC_CLIENT_SECRET = config.oidc && config.oidc.clientSecret || "";
  process.env.OIDC_REDIRECT_URI = config.oidc && config.oidc.redirectUri || "";
  process.env.OIDC_SCOPES = config.oidc && config.oidc.scopes || "openid email profile";

  process.env.SMTP_URL = config.smtp && config.smtp.url || "";
  process.env.SMTP_FROM = config.smtp && config.smtp.from || "Coopeditor <no-reply@example.com>";
  process.env.EMAIL_DIGEST_MINUTES = String(config.smtp && config.smtp.digestMinutes || 0);

  process.env.SLACK_WEBHOOK_URL = config.webhooks && config.webhooks.slackWebhookUrl || "";
  process.env.DISCORD_WEBHOOK_URL = config.webhooks && config.webhooks.discordWebhookUrl || "";

  process.env.HLS_CDN_PUBLIC_URL = config.hls && config.hls.cdnPublicUrl || "";
  process.env.HLS_CDN_SIGNING_SECRET = config.hls && config.hls.cdnSigningSecret || "";
  process.env.HLS_CDN_TOKEN_TTL_SECONDS = String(config.hls && config.hls.cdnTokenTtlSeconds || 300);

  process.env.FFMPEG_HWACCEL = config.transcode && config.transcode.hwaccel || "";
  process.env.FFMPEG_CODEC_LADDER = config.transcode && config.transcode.codecLadder || "h264";
  process.env.WORKER_CONCURRENCY = String(config.transcode && config.transcode.workerConcurrency || 2);
  process.env.WORKER_AUTOSCALE_THRESHOLD = String(config.transcode && config.transcode.autoscaleThreshold || 5);
  process.env.WORKER_AUTOSCALE_STEP = String(config.transcode && config.transcode.autoscaleStep || 1);
  process.env.WORKER_MAX_CONCURRENCY = String(config.transcode && config.transcode.maxConcurrency || 3);

  process.env.AUDIT_RETENTION_DAYS = String(config.retention && config.retention.auditDays || 365);
  process.env.PROJECT_PURGE_DAYS = String(config.retention && config.retention.projectPurgeDays || 90);
  process.env.COMMENT_PURGE_DAYS = String(config.retention && config.retention.commentPurgeDays || 30);
  process.env.RETENTION_SWEEP_MINUTES = String(config.retention && config.retention.sweepMinutes || 60);

  process.env.UPDATE_FEED_URL = envOr(config.updater && config.updater.feedUrl, process.env.UPDATE_FEED_URL || "");
  process.env.UPDATE_TRIGGER_URL = envOr(config.updater && config.updater.triggerUrl, process.env.UPDATE_TRIGGER_URL || "");
  process.env.UPDATE_TRIGGER_TOKEN = envOr(config.updater && config.updater.triggerToken, process.env.UPDATE_TRIGGER_TOKEN || "");
  process.env.UPDATE_POLL_INTERVAL_SECONDS = String(config.updater && config.updater.pollIntervalSeconds || clampInt(process.env.UPDATE_POLL_INTERVAL_SECONDS, 900, 30, 86400));
  return true;
}

function clampInt(value, fallback, min, max) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeEnum(value, options, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return options.includes(normalized) ? normalized : fallback;
}
