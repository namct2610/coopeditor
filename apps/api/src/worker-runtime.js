// Two modes:
//   - memory backend: in-process tick simulator (so dev works without a worker)
//   - pg backend: enqueue to transcode_jobs; the out-of-process worker
//     (apps/worker) does the actual work and publishes progress via the cluster event bus.

import * as store from "./store-index.js";
import { publishEvent } from "./event-bus.js";

const pendingRenditions = new Set();

export async function requestTranscode(rid) {
  const r = await store.getRendition(rid);
  if (!r) return;
  if (r.status === "ready" || r.status === "processing") return;
  await store.setRenditionStatus(rid, { status: "processing", progress: r.progress || 0 });

  if (store.backend === "pg") {
    await store.enqueueTranscode(rid);
    return;
  }
  pendingRenditions.add(rid);
}

async function tickRenditions() {
  for (const rid of [...pendingRenditions]) {
    const r = await store.getRendition(rid);
    if (!r || r.status === "ready" || r.status === "failed") { pendingRenditions.delete(rid); continue; }
    const np = (r.progress || 0) + 6 + Math.floor(Math.random() * 5);
    if (np >= 100) {
      await store.setRenditionStatus(rid, { status: "ready", progress: 100, hlsMasterUrl: "/hls/" + rid + "/master.m3u8" });
      pendingRenditions.delete(rid);
      const projectId = await store.findProjectIdForVersion(r.assetVersionId);
      const userIds = projectId ? await store.listProjectMemberUserIds(projectId) : undefined;
      publishEvent({ type: "rendition", id: rid, assetVersionId: r.assetVersionId, projectId, userIds, status: "ready", progress: 100 });
    } else {
      await store.setRenditionStatus(rid, { progress: np });
      const projectId = await store.findProjectIdForVersion(r.assetVersionId);
      const userIds = projectId ? await store.listProjectMemberUserIds(projectId) : undefined;
      publishEvent({ type: "rendition", id: rid, assetVersionId: r.assetVersionId, projectId, userIds, status: "processing", progress: np });
    }
  }
}

async function tickAssets() {
  const assets = await store.listProcessingAssets();
  for (const a of assets) {
    const np = (a.progress || 0) + 4 + Math.floor(Math.random() * 6);
    if (np >= 100) {
      await store.setAssetStatus(a.id, { status: "ready", progress: 100 });
      const userIds = await store.listProjectMemberUserIds(a.projectId);
      publishEvent({ type: "asset", id: a.id, projectId: a.projectId, userIds, status: "ready", progress: 100 });
    } else {
      await store.setAssetStatus(a.id, { progress: np });
      const userIds = await store.listProjectMemberUserIds(a.projectId);
      publishEvent({ type: "asset", id: a.id, projectId: a.projectId, userIds, status: "processing", progress: np });
    }
  }
}

let timer = null;
export async function startWorker() {
  if (timer) return;
  if (store.backend === "pg") return; // pg mode uses the external worker
  for (const r of await store.listProcessingRenditions()) pendingRenditions.add(r.id);
  timer = setInterval(() => { tickAssets().catch(() => {}); tickRenditions().catch(() => {}); }, 600);
  timer.unref && timer.unref();
}

export function stopWorker() { if (timer) clearInterval(timer); timer = null; }
export function pendingTranscodeCount() { return pendingRenditions.size; }
