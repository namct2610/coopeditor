// In-memory store seeded to match the frontend mock data exactly.
// Swap to Postgres later by re-implementing the same exported functions.

import { randomUUID } from "node:crypto";

const PAL = [
  ["#0c2436", "#1c5876"], ["#2a1d0c", "#7a521d"], ["#0c1c33", "#234a78"], ["#15171c", "#3a4453"],
  ["#291230", "#6e2a55"], ["#241a0e", "#7a5524"], ["#102b2b", "#1f5a52"], ["#1a1430", "#3a2f6e"],
];

const now = () => new Date().toISOString();

// --- users (seeded; DSM login may upsert more) ---
export const users = new Map();
function seedUser(u) { users.set(u.id, u); return u; }

seedUser({ id: "u_minh", name: "Minh", initial: "M", color: "#2da8e2", role: "editor", email: "minh@karofi.test" });
seedUser({ id: "u_lan", name: "Lan", initial: "L", color: "#e072a8", role: "editor", email: "lan@karofi.test" });
seedUser({ id: "u_tu", name: "Tú", initial: "T", color: "#f5a623", role: "editor", email: "tu@karofi.test" });
seedUser({ id: "u_phong", name: "Phong", initial: "P", color: "#a07bff", role: "editor", email: "phong@karofi.test" });
seedUser({ id: "u_khach", name: "Khách hàng", initial: "K", color: "#35c389", role: "client", email: "client@karofi.test" });

// --- projects ---
export const projects = new Map();
function P(id, name, status, client, updatedAt, teamUserIds) {
  projects.set(id, { id, name, status, client, updatedAt, teamUserIds, createdAt: now() });
}
P("p1", "TVC Q3 2026 — Karofi Hero", "progress", "Karofi PH · Brand", "12 phút trước", ["u_minh", "u_lan", "u_tu"]);
P("p2", "Product Launch — PureFlow U05", "progress", "Karofi PH · Product", "1 giờ trước", ["u_lan", "u_phong"]);
P("p3", "Brand Refresh 2026", "progress", "Karofi PH · Brand", "hôm qua", ["u_minh", "u_tu"]);
P("p4", "Tết 2026 Campaign", "progress", "Karofi PH · Seasonal", "2 ngày trước", ["u_minh", "u_lan", "u_tu", "u_phong"]);
P("p5", "Hot & Cold D66 Demo", "done", "Karofi PH · Product", "3 ngày trước", ["u_lan"]);
P("p6", "Warranty Explainer", "done", "Karofi PH · Support", "5 ngày trước", ["u_minh"]);
P("p7", "Store Opening — SM Megamall", "done", "Karofi PH · Retail", "1 tuần trước", ["u_tu", "u_phong"]);
P("p8", "60-Day Free Trial Promo", "published", "Karofi PH · Growth", "2 tuần trước", ["u_minh", "u_lan"]);
P("p9", "AquaDuo Unboxing", "published", "Karofi PH · Product", "3 tuần trước", ["u_phong"]);
P("p10", "Earth Day — Save Plastic", "published", "Karofi PH · Brand", "1 tháng trước", ["u_minh", "u_tu"]);
P("p11", "Customer Stories — Ep.1", "published", "Karofi PH · Social", "1 tháng trước", ["u_lan"]);

export const projectTemplates = new Map();
function seedProjectTemplate(t) { projectTemplates.set(t.id, t); return t; }
seedProjectTemplate({
  id: "tpl_brand_tvc",
  name: "Brand TVC",
  description: "Template cho TVC brand với owner + editor core team va client preset.",
  sourceProjectId: "p1",
  defaultClient: "Karofi PH · Brand",
  createdByUserId: "u_minh",
  createdAt: now(),
});
seedProjectTemplate({
  id: "tpl_product_launch",
  name: "Product Launch",
  description: "Template cho launch video san pham voi khung project review mac dinh.",
  sourceProjectId: "p2",
  defaultClient: "Karofi PH · Product",
  createdByUserId: "u_lan",
  createdAt: now(),
});

export const projectMembers = new Map();
function seedProjectMembers() {
  for (const p of projects.values()) {
    (p.teamUserIds || []).forEach((userId, position) => {
      const user = users.get(userId);
      const role = position === 0 ? "owner" : (user && user.role === "client" ? "client" : "editor");
      projectMembers.set(p.id + ":" + userId, {
        projectId: p.id,
        userId,
        role,
        position,
        createdAt: now(),
      });
    });
  }
}
seedProjectMembers();

// --- assets ---
export const assets = new Map();
function mkAsset(pid, rows) {
  rows.forEach((x, i) => {
    const id = pid + "s" + (i + 1);
    const [title, dur, codec, sizeLabel, status, progress, versionsCount, commentsCount] = x;
    const [paletteA, paletteB] = PAL[i % PAL.length];
    assets.set(id, {
      id, projectId: pid, title, position: i, nasPath: "\\\\NAS-STUDIO\\Footage\\" + title + ".mov",
      codec: codec || "ProRes 422", sizeLabel: sizeLabel || "—", durationMs: dur, frameRate: 24,
      width: 3840, height: 2160, resolutionLabel: "4K", mimeType: "video/quicktime",
      status: status || "ready", progress: progress || 0,
      commentsCount: commentsCount || 0, versionsCount: versionsCount || 1,
      paletteA, paletteB, createdAt: now(),
    });
  });
}
mkAsset("p1", [
  ["Opening_Wide_Kitchen", 142000, "ProRes 422 HQ", "48.2 GB", "ready", 0, 3, 6],
  ["Glass_Filling_CU", 18000, "ProRes 422", "9.1 GB", "ready", 0, 1, 2],
  ["Family_TwoShot", 24000, "ProRes 422 HQ", "12.0 GB", "processing", 62, 2, 1],
  ["Filter_Unit_Insert", 42000, "ProRes 422", "18.3 GB", "ready", 0, 2, 2],
  ["Balcony_Dusk_Wide", 67000, "ProRes 4444", "58.9 GB", "failed", 0, 1, 0],
  ["Closing_Smile_CU", 15000, "ProRes 422", "6.1 GB", "ready", 0, 3, 3],
  ["Brand_Logo_Sting", 8000, "ProRes 4444", "4.2 GB", "pending", 0, 1, 0],
  ["BTS_Bonus_Broll", 214000, "H.265", "22.4 GB", "ready", 0, 1, 0],
]);
mkAsset("p2", [
  ["Hero_Product_Spin", 96000, "ProRes 422", "31.0 GB", "ready", 0, 2, 4],
  ["Install_StepByStep", 180000, "ProRes 422", "52.0 GB", "processing", 40, 1, 2],
  ["Water_Quality_Test", 60000, "ProRes 422 HQ", "22.0 GB", "ready", 0, 1, 1],
  ["Voiceover_Scratch", 150000, "H.264", "3.1 GB", "ready", 0, 1, 3],
  ["Lower_Thirds_Pack", 12000, "ProRes 4444", "2.0 GB", "pending", 0, 1, 0],
  ["Endcard_CTA", 10000, "ProRes 422", "1.8 GB", "ready", 0, 1, 0],
]);
mkAsset("p3", [
  ["Logo_Animation_v2", 12000, "ProRes 4444", "3.2 GB", "ready", 0, 2, 1],
  ["Color_Bumper", 6000, "ProRes 4444", "1.9 GB", "processing", 30, 1, 0],
  ["Typography_Reveal", 9000, "ProRes 4444", "2.4 GB", "ready", 0, 1, 2],
  ["Sonic_Logo_Mix", 5000, "H.264", "0.4 GB", "ready", 0, 1, 0],
]);
mkAsset("p4", [
  ["Family_Reunion_Wide", 88000, "ProRes 422 HQ", "40.0 GB", "ready", 0, 1, 3],
  ["Gift_Handover_CU", 20000, "ProRes 422", "9.0 GB", "ready", 0, 1, 1],
  ["Kitchen_Prep_Montage", 55000, "ProRes 422", "24.0 GB", "processing", 18, 1, 0],
  ["Cheers_Slowmo", 30000, "ProRes 4444", "28.0 GB", "pending", 0, 1, 0],
  ["Tet_Endcard", 10000, "ProRes 422", "1.8 GB", "ready", 0, 1, 0],
]);
mkAsset("p5", [
  ["Dispenser_Hero", 60000, "ProRes 422", "22.0 GB", "ready", 0, 2, 2],
  ["Hot_Water_Demo", 40000, "ProRes 422", "15.0 GB", "ready", 0, 1, 1],
  ["Cold_Water_Demo", 38000, "ProRes 422", "14.0 GB", "ready", 0, 1, 0],
  ["Endcard_D66", 9000, "ProRes 422", "1.5 GB", "ready", 0, 1, 0],
]);
mkAsset("p6", [
  ["Animated_Explainer", 120000, "ProRes 4444", "30.0 GB", "ready", 0, 3, 4],
  ["VO_Final", 120000, "H.264", "2.6 GB", "ready", 0, 1, 0],
  ["Captions_Burn", 12000, "ProRes 422", "2.0 GB", "ready", 0, 1, 0],
]);
mkAsset("p7", [
  ["Ribbon_Cut_Wide", 45000, "ProRes 422", "20.0 GB", "ready", 0, 1, 1],
  ["Crowd_Broll", 90000, "ProRes 422", "38.0 GB", "ready", 0, 1, 0],
  ["Interview_Manager", 150000, "ProRes 422 HQ", "55.0 GB", "ready", 0, 2, 2],
  ["Product_Wall_Pan", 25000, "ProRes 422", "11.0 GB", "ready", 0, 1, 0],
  ["Endcard_Store", 8000, "ProRes 422", "1.4 GB", "ready", 0, 1, 0],
]);
mkAsset("p8", [
  ["Promo_Hero_Cut", 30000, "ProRes 422", "12.0 GB", "ready", 0, 4, 5],
  ["Testimonial_Mashup", 45000, "ProRes 422", "18.0 GB", "ready", 0, 2, 1],
  ["CTA_Endcard", 8000, "ProRes 422", "1.4 GB", "ready", 0, 1, 0],
]);
mkAsset("p9", [
  ["Unbox_Top", 40000, "ProRes 422", "16.0 GB", "ready", 0, 1, 2],
  ["Parts_Layout", 30000, "ProRes 422", "12.0 GB", "ready", 0, 1, 0],
  ["Install_Timelapse", 60000, "ProRes 422", "24.0 GB", "ready", 0, 2, 1],
  ["First_Pour", 15000, "ProRes 422", "6.0 GB", "ready", 0, 1, 0],
]);
mkAsset("p10", [
  ["Plastic_Waste_Montage", 50000, "ProRes 422", "20.0 GB", "ready", 0, 1, 1],
  ["Refill_Lifestyle", 35000, "ProRes 422", "14.0 GB", "ready", 0, 1, 0],
  ["Pledge_Endcard", 10000, "ProRes 422", "1.8 GB", "ready", 0, 1, 0],
]);
mkAsset("p11", [
  ["Customer_Interview", 200000, "ProRes 422 HQ", "70.0 GB", "ready", 0, 2, 3],
  ["Broll_Home_Use", 60000, "ProRes 422", "24.0 GB", "ready", 0, 1, 0],
]);

// --- versions: every asset gets V1..Vn ---
export const versions = new Map();
const versionsByAsset = new Map();
for (const a of assets.values()) {
  const list = [];
  for (let i = 1; i <= a.versionsCount; i++) {
    const v = {
      id: a.id + "_v" + i,
      assetId: a.id,
      versionNumber: i,
      label: "V" + i,
      note: i === a.versionsCount ? "current" : undefined,
      authorUserId: i === a.versionsCount ? "u_minh" : "u_lan",
      createdAt: now(),
    };
    versions.set(v.id, v);
    list.push(v);
  }
  versionsByAsset.set(a.id, list);
}
export function listVersionsForAsset(assetId) { return versionsByAsset.get(assetId) || []; }

// --- renditions: each version gets 720p + 1080p ---
export const renditions = new Map();
const renditionsByVersion = new Map();
const RUNGS = [
  { height: 720, label: "720p", bitrateKbps: 3500, status: "pending" },
  { height: 1080, label: "1080p", bitrateKbps: 8000, status: "pending" },
];
for (const v of versions.values()) {
  const list = [];
  for (const r of RUNGS) {
    const rid = v.id + "_" + r.label;
    const rec = {
      id: rid, assetVersionId: v.id, height: r.height, label: r.label, bitrateKbps: r.bitrateKbps,
      status: r.status, progress: r.status === "ready" ? 100 : 0,
      hlsMasterUrl: r.status === "ready" ? "/hls/" + rid + "/master.m3u8" : undefined, // always via /hls proxy

    };
    renditions.set(rid, rec);
    list.push(rec);
  }
  renditionsByVersion.set(v.id, list);
}
export function listRenditionsForVersion(versionId) { return renditionsByVersion.get(versionId) || []; }

// --- comments (seeded for p1's first asset's current version) ---
export const comments = new Map();
function seedComment(c) { comments.set(c.id, c); }
{
  const firstAsset = assets.get("p1s1");
  const firstVersion = (versionsByAsset.get(firstAsset.id) || []).slice(-1)[0];
  const vId = firstVersion.id;
  const cs = [
    { who: "u_lan", ms: 8200, content: "Cắt nhanh hơn ở đầu shot này, đang bị lê khoảng nửa giây.", resolved: false, reply: { who: "u_minh", content: "Ok mình trim lại 12 frame." } },
    { who: "u_minh", ms: 18600, content: "Color khung này hơi ngả xanh — chỉnh lại white balance cho ấm hơn chút.", resolved: false },
    { who: "u_tu", ms: 41200, content: "Tăng audio ambience bếp lên ~2dB, đang mỏng.", resolved: false },
    { who: "u_minh", ms: 64800, content: "Logo Karofi lệch khỏi safe area, kéo vào title-safe.", resolved: true, reply: { who: "u_lan", content: "Đã fix ở V3." } },
    { who: "u_khach", ms: 91500, content: "Thiếu lower-third tên nhân vật ở đoạn này. Bổ sung giúp mình nhé.", resolved: false },
    { who: "u_lan", ms: 118200, content: "Transition hơi gắt, thử dissolve 8 frame xem mượt hơn không.", resolved: false },
  ];
  cs.forEach((c) => {
    const id = randomUUID();
    seedComment({ id, assetVersionId: vId, authorUserId: c.who, content: c.content, timestampMs: c.ms, frameNumber: Math.round(c.ms / 1000 * 24), resolved: c.resolved, createdAt: now() });
    if (c.reply) {
      seedComment({ id: randomUUID(), assetVersionId: vId, authorUserId: c.reply.who, content: c.reply.content, timestampMs: c.ms, resolved: false, parentId: id, createdAt: now() });
    }
  });
}

// --- query helpers ---
export function listProjects() { return [...projects.values()]; }
export function getProject(id) { return projects.get(id); }
export function listProjectsForUser(userId, opts = {}) {
  const includeArchived = !!opts.includeArchived;
  const allowed = new Set(listProjectMembersForUser(userId).map((m) => m.projectId));
  return [...projects.values()].filter((p) => allowed.has(p.id) && (includeArchived || !p.archivedAt));
}
export function createProject({ name, client = "", status = "progress", ownerUserId }) {
  const id = "p_" + randomUUID().slice(0, 8);
  const p = { id, name, status, client, updatedAt: "vừa xong", teamUserIds: [], archivedAt: null, createdAt: now() };
  projects.set(id, p);
  if (ownerUserId) upsertProjectMember(id, ownerUserId, "owner");
  return projects.get(id);
}
export function duplicateProject(sourceId, { newName, ownerUserId }) {
  const src = projects.get(sourceId);
  if (!src) return null;
  const id = "p_" + randomUUID().slice(0, 8);
  const p = { id, name: newName || (src.name + " (copy)"), status: "progress", client: src.client, updatedAt: "vừa xong", teamUserIds: [], archivedAt: null, createdAt: now() };
  projects.set(id, p);
  // copy members
  for (const m of listProjectMembers(sourceId)) upsertProjectMember(id, m.userId, m.role);
  if (ownerUserId && !getProjectMember(id, ownerUserId)) upsertProjectMember(id, ownerUserId, "owner");
  return projects.get(id);
}
export function listProjectTemplates() {
  return [...projectTemplates.values()];
}
export function getProjectTemplate(id) {
  return projectTemplates.get(id) || null;
}
export function createProjectTemplate({ name, description = "", sourceProjectId = null, defaultClient = "", createdByUserId }) {
  const id = "tpl_" + randomUUID().slice(0, 8);
  const template = {
    id,
    name,
    description: description || "",
    sourceProjectId: sourceProjectId || null,
    defaultClient: defaultClient || "",
    createdByUserId: createdByUserId || null,
    createdAt: now(),
  };
  projectTemplates.set(id, template);
  return template;
}
export function createProjectFromTemplate(templateId, { name, client, ownerUserId }) {
  const template = getProjectTemplate(templateId);
  if (!template) return null;
  const projectName = name && name.trim() ? name.trim() : `${template.name} ${new Date().toISOString().slice(0, 10)}`;
  if (template.sourceProjectId) {
    const duplicated = duplicateProject(template.sourceProjectId, { newName: projectName, ownerUserId });
    if (!duplicated) return null;
    duplicated.client = client && client.trim() ? client.trim() : (template.defaultClient || duplicated.client || "");
    duplicated.updatedAt = "vừa xong";
    return duplicated;
  }
  return createProject({
    name: projectName,
    client: client && client.trim() ? client.trim() : (template.defaultClient || ""),
    ownerUserId,
  });
}
export function archiveProject(id) {
  const p = projects.get(id);
  if (!p || p.archivedAt) return null;
  p.archivedAt = now();
  return p;
}
export function restoreProject(id) {
  const p = projects.get(id);
  if (!p || !p.archivedAt) return null;
  p.archivedAt = null;
  return p;
}
export function deleteProject(id) {
  const p = projects.get(id);
  if (!p) return null;
  for (const asset of [...assets.values()].filter((item) => item.projectId === id)) deleteAsset(asset.id);
  for (const key of [...projectMembers.keys()]) {
    if (key.startsWith(id + ":")) projectMembers.delete(key);
  }
  for (const template of projectTemplates.values()) {
    if (template.sourceProjectId === id) template.sourceProjectId = null;
  }
  projects.delete(id);
  return p;
}
export function getProjectMember(projectId, userId) { return projectMembers.get(projectId + ":" + userId) || null; }
export function listProjectMembers(projectId) {
  return [...projectMembers.values()].filter((m) => m.projectId === projectId).sort((a, b) => a.position - b.position);
}
export function listProjectMembersForUser(userId) {
  return [...projectMembers.values()].filter((m) => m.userId === userId).sort((a, b) => a.position - b.position);
}
export function upsertProjectMember(projectId, userId, role) {
  const existing = getProjectMember(projectId, userId);
  const position = existing ? existing.position : listProjectMembers(projectId).length;
  const member = {
    projectId,
    userId,
    role,
    position,
    createdAt: existing ? existing.createdAt : now(),
  };
  projectMembers.set(projectId + ":" + userId, member);
  syncProjectTeam(projectId);
  return member;
}
export function setProjectMemberRole(projectId, userId, role) {
  const existing = getProjectMember(projectId, userId);
  if (!existing) return null;
  existing.role = role;
  projectMembers.set(projectId + ":" + userId, existing);
  syncProjectTeam(projectId);
  return existing;
}
export function removeProjectMember(projectId, userId) {
  const existing = getProjectMember(projectId, userId);
  if (!existing) return null;
  projectMembers.delete(projectId + ":" + userId);
  syncProjectTeam(projectId);
  return existing;
}
export function listProjectMemberUserIds(projectId) {
  return listProjectMembers(projectId).map((m) => m.userId);
}
function syncProjectTeam(projectId) {
  const p = projects.get(projectId);
  if (!p) return;
  p.teamUserIds = listProjectMembers(projectId).map((m) => m.userId);
}
export function listAssetsByProject(pid) {
  return [...assets.values()]
    .filter((a) => a.projectId === pid)
    .sort((a, b) => a.position - b.position)
    .map((asset) => {
      const latestVersion = (versionsByAsset.get(asset.id) || []).slice(-1)[0];
      const renditionList = latestVersion ? (renditionsByVersion.get(latestVersion.id) || []) : [];
      if (!renditionList.length) return asset;
      const processing = renditionList.filter((r) => r.status === "processing");
      const ready = renditionList.filter((r) => r.status === "ready");
      const failed = renditionList.filter((r) => r.status === "failed");
      let status = "pending";
      let progress = 0;
      if (renditionList.every((r) => r.status === "ready")) {
        status = "ready";
        progress = 100;
      } else if (renditionList.every((r) => r.status === "failed")) {
        status = "failed";
      } else if (processing.length) {
        status = "processing";
        const active = [...ready, ...processing];
        progress = active.length
          ? Math.round(active.reduce((sum, rendition) => sum + (rendition.status === "ready" ? 100 : (rendition.progress || 0)), 0) / active.length)
          : 0;
      } else if (ready.length) {
        status = "ready";
        progress = 100;
      } else if (failed.length) {
        status = "failed";
      }
      return { ...asset, status, progress };
    });
}
export function getAsset(id) { return assets.get(id) || null; }
export function patchAsset(id, patch) {
  const asset = assets.get(id);
  if (!asset) return null;
  if (typeof patch.title === "string" && patch.title.trim()) asset.title = patch.title.trim();
  if (typeof patch.position === "number") asset.position = patch.position;
  return asset;
}
export function deleteAsset(id) {
  const asset = assets.get(id);
  if (!asset) return null;
  const linkedVersions = versionsByAsset.get(id) || [];
  for (const version of linkedVersions) {
    renditionsByVersion.delete(version.id);
    for (const renditionId of [...renditions.keys()]) {
      const rendition = renditions.get(renditionId);
      if (rendition && rendition.assetVersionId === version.id) renditions.delete(renditionId);
    }
    versions.delete(version.id);
    for (const commentId of [...comments.keys()]) {
      const comment = comments.get(commentId);
      if (comment && comment.assetVersionId === version.id) comments.delete(commentId);
    }
  }
  versionsByAsset.delete(id);
  assets.delete(id);
  const siblings = listAssetsByProject(asset.projectId);
  siblings.forEach((item, index) => { item.position = index; });
  return asset;
}
export function findProjectIdForAsset(assetId) {
  const asset = assets.get(assetId);
  return asset ? asset.projectId : null;
}
export function reorderAssets(pid, orderedIds) {
  orderedIds.forEach((id, i) => { const a = assets.get(id); if (a && a.projectId === pid) a.position = i; });
}
export function getVersion(id) { return versions.get(id) || null; }
export function findProjectIdForVersion(versionId) {
  const version = versions.get(versionId);
  if (!version) return null;
  return findProjectIdForAsset(version.assetId);
}
export function findProjectIdForRendition(renditionId) {
  const rendition = renditions.get(renditionId);
  if (!rendition) return null;
  return findProjectIdForVersion(rendition.assetVersionId);
}
export function listCommentsForVersion(vid, opts = {}) {
  const includeDeleted = !!opts.includeDeleted;
  return [...comments.values()]
    .filter((c) => c.assetVersionId === vid && (includeDeleted || !c.deletedAt))
    .sort((a, b) => a.timestampMs - b.timestampMs);
}
export function getComment(id) { return comments.get(id) || null; }
export function findProjectIdForComment(commentId) {
  const comment = comments.get(commentId);
  if (!comment) return null;
  return findProjectIdForVersion(comment.assetVersionId);
}
export function addComment(input) {
  const c = {
    id: randomUUID(),
    assetVersionId: input.assetVersionId,
    authorUserId: input.authorUserId,
    content: input.content,
    timestampMs: input.timestampMs,
    frameNumber: input.frameNumber,
    resolved: false,
    parentId: input.parentId,
    annotation: input.annotation || null,
    guestLabel: input.guestLabel || null,
    guestInitial: input.guestInitial || null,
    guestColor: input.guestColor || null,
    createdAt: now(),
  };
  comments.set(c.id, c);
  return c;
}
export function setCommentResolved(id, resolved) { const c = comments.get(id); if (c) c.resolved = !!resolved; return c; }
export function setCommentContent(id, content) {
  const c = comments.get(id);
  if (c) c.content = content;
  return c;
}
export function deleteComment(id) {
  const existing = comments.get(id);
  if (!existing || existing.deletedAt) return null;
  existing.deletedAt = now();
  return existing;
}
export function restoreComment(id) {
  const existing = comments.get(id);
  if (!existing || !existing.deletedAt) return null;
  existing.deletedAt = null;
  return existing;
}

export function upsertUserFromOidc({ issuer, sub, name, email }) {
  // Match existing by (issuer,sub) or by email
  let existing = null;
  for (const u of users.values()) {
    if (u.oidcIssuer === issuer && u.oidcSub === sub) { existing = u; break; }
    if (email && u.email === email) { existing = u; break; }
  }
  if (existing) {
    existing.oidcIssuer = issuer;
    existing.oidcSub = sub;
    if (name) existing.name = name;
    if (email) existing.email = email;
    return existing;
  }
  const id = "oidc_" + sub.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const palette = ["#2da8e2", "#e072a8", "#f5a623", "#a07bff", "#35c389", "#ef4d57"];
  const h = Array.from(sub).reduce((a, c) => a + c.charCodeAt(0), 0);
  const u = { id, name: name || "User", initial: (name || "?").trim().charAt(0).toUpperCase(), color: palette[h % palette.length], role: "editor", oidcIssuer: issuer, oidcSub: sub, email };
  users.set(id, u);
  return u;
}

export function upsertUserFromDsm({ uid, name, email }) {
  const aliasId = aliasUserId(name || email || "");
  const id = aliasId || ("dsm_" + uid);
  let u = users.get(id);
  if (!u) {
    // generate stable color from uid
    const palette = ["#2da8e2", "#e072a8", "#f5a623", "#a07bff", "#35c389", "#ef4d57"];
    u = { id, name, initial: (name || "?").trim().charAt(0).toUpperCase(), color: palette[uid % palette.length], role: "editor", dsmUid: uid, email };
    users.set(id, u);
  }
  if (u) {
    u.dsmUid = uid;
    if (email) u.email = email;
    if (name) {
      u.name = name;
      u.initial = (name || "?").trim().charAt(0).toUpperCase();
    }
  }
  return u;
}

function aliasUserId(raw) {
  const key = String(raw || "").trim().toLowerCase();
  const slug = key.split("@")[0];
  const map = {
    minh: "u_minh",
    lan: "u_lan",
    tu: "u_tu",
    phong: "u_phong",
    khach: "u_khach",
    client: "u_khach",
  };
  return map[slug] || null;
}

export function addAssetFromImport({ projectId, title, codec, sizeLabel, durationMs, nasPath, width = 0, height = 0, frameRate = 24, resolutionLabel = "", mimeType = "application/octet-stream" }) {
  const id = "imp_" + randomUUID().slice(0, 8);
  const existing = listAssetsByProject(projectId).length;
  const [paletteA, paletteB] = PAL[existing % PAL.length];
  const a = {
    id, projectId, title, position: existing, nasPath, codec, sizeLabel, durationMs, frameRate: Math.round(frameRate || 24),
    width: width || 0, height: height || 0, resolutionLabel: resolutionLabel || "", mimeType: mimeType || "application/octet-stream",
    status: "pending", progress: 0,
    commentsCount: 0, versionsCount: 1, paletteA, paletteB, createdAt: now(),
  };
  assets.set(id, a);
  // seed V1
  const v = { id: id + "_v1", assetId: id, versionNumber: 1, label: "V1", note: "current", authorUserId: "u_minh", createdAt: now() };
  versions.set(v.id, v);
  versionsByAsset.set(id, [v]);
  // seed renditions (all pending until worker ticks)
  const list = RUNGS.map((r) => {
    const rec = { id: v.id + "_" + r.label, assetVersionId: v.id, height: r.height, label: r.label, bitrateKbps: r.bitrateKbps, status: "pending", progress: 0 };
    renditions.set(rec.id, rec);
    return rec;
  });
  renditionsByVersion.set(v.id, list);
  return a;
}

export function setRenditionStatus(rid, patch) { const r = renditions.get(rid); if (r) Object.assign(r, patch); return r; }
