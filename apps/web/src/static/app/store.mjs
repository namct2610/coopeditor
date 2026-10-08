// App state + every action that talks to the API.
//
// One mutable object `S`; `set()` merges a patch and schedules a single
// re-render on the next frame (bursts of realtime events coalesce). Screens
// read S directly; the root component is the only subscriber.

import { useEffect, useReducer } from "./lib.mjs";
import { api, get, post, patch, del, enc, ApiError, setUnauthorizedHandler, API_BASE } from "./api.mjs";

export const S = {
  boot: "loading",          // loading | setup | login | ready | offline
  bootError: "",
  setupStatus: null,
  me: null,
  caps: { scripts: false, workspace: false, nas: false },
  prefs: {},
  route: { name: "hub" },

  projects: [],
  archived: null,           // archived projects, loaded on demand
  showArchived: false,
  users: {},                // id → user
  queue: [],
  presence: [],
  sources: {},              // projectId → assets (sources and final deliveries; see isFinal)
  uploads: {},              // projectId → final upload in progress { name, size, sent, state, error, rate }
  members: {},              // projectId → members (with .user)
  versions: {},             // assetId → versions
  comments: {},             // versionId → comments (flat, replies have parentId)
  renditions: {},           // versionId → renditions
  scripts: null,
  script: null,             // open script incl. body + comments
  scriptSave: "saved",      // saved | dirty | saving | conflict | error
  scriptConflict: null,
  scriptLoadedAt: 0,

  hubFilter: "all",
  projFilter: "all",
  view: null,               // grid | list (session override of prefs.defaultView)
  scriptFilter: "all",
  calOffset: 0,

  overlay: null,            // { kind: "palette"|"share"|"import"|"newProject"|"editProject"|"date"|"audit", ... }
  toasts: [],
  notif: {},                // projectId → unseen comment events
  updateBanner: false,
};

const subs = new Set();
let queued = false;
let version = 0;
export function set(p) {
  Object.assign(S, typeof p === "function" ? p(S) : p);
  version++;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; subs.forEach((f) => f()); });
}
export function useStore() {
  const [, force] = useReducer((x) => x + 1, 0);
  const seen = version;
  useEffect(() => {
    subs.add(force);
    // A set() between this render and the subscription would otherwise be lost.
    if (version !== seen) force();
    return () => subs.delete(force);
  }, []);
  return S;
}

// ---------- toasts ----------
let toastSeq = 0;
export function toast(msg, kind = "ok", ms = 3600) {
  const id = ++toastSeq;
  set({ toasts: [...S.toasts, { id, msg, kind }].slice(-4) });
  setTimeout(() => set({ toasts: S.toasts.filter((t) => t.id !== id) }), ms);
}
export const errMsg = (e, fallback) => (e && e.message) || fallback || "Có lỗi xảy ra";
export async function guard(fn, fallback) {
  try { return await fn(); } catch (e) { toast(errMsg(e, fallback), "error", 5200); return undefined; }
}

// ---------- routing (hash) ----------
// #/                      Hub
// #/p/:pid                Chi tiết dự án
// #/p/:pid/v/:aid?t=&c=   Review (t = ms, c = comment id)
// #/calendar  #/scripts  #/scripts/:id  #/settings/:section
export function parseHash(hash) {
  const raw = String(hash || "").replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const q = new URLSearchParams(qs || "");
  const seg = path.split("/").filter(Boolean).map(decodeURIComponent);
  if (seg[0] === "p" && seg[1] && seg[2] === "v" && seg[3]) return { name: "review", pid: seg[1], aid: seg[3], t: q.has("t") ? Number(q.get("t")) : null, c: q.get("c") || null };
  if (seg[0] === "p" && seg[1]) return { name: "project", pid: seg[1] };
  if (seg[0] === "calendar") return { name: "calendar" };
  if (seg[0] === "scripts" && seg[1]) return { name: "script", sid: seg[1] };
  if (seg[0] === "scripts") return { name: "scripts" };
  if (seg[0] === "settings") return { name: "settings", sec: seg[1] || "profile" };
  return { name: "hub" };
}
export function href(r) {
  switch (r.name) {
    case "project": return "#/p/" + enc(r.pid);
    case "review": {
      const q = new URLSearchParams();
      if (r.t != null) q.set("t", String(Math.round(r.t)));
      if (r.c) q.set("c", r.c);
      const s = q.toString();
      return "#/p/" + enc(r.pid) + "/v/" + enc(r.aid) + (s ? "?" + s : "");
    }
    case "calendar": return "#/calendar";
    case "scripts": return "#/scripts";
    case "script": return "#/scripts/" + enc(r.sid);
    case "settings": return "#/settings/" + (r.sec || "profile");
    default: return "#/";
  }
}
export function go(r) {
  const h = href(r);
  if (location.hash === h) onRoute(); else location.hash = h;
}
window.addEventListener("hashchange", () => onRoute());

let routeHook = null;
export function onRouteChange(fn) { routeHook = fn; }
export function onRoute() {
  const route = parseHash(location.hash);
  set({ route, overlay: null });
  if (S.boot !== "ready") return;
  if (route.name === "project") { loadSources(route.pid); loadMembers(route.pid); clearNotif(route.pid); }
  if (route.name === "review") { openReview(route.pid, route.aid); clearNotif(route.pid); }
  if (route.name === "scripts" || route.name === "project") loadScripts();
  if (route.name === "script") openScript(route.sid);
  if (route.name === "hub") { refreshQueue(); }
  if (routeHook) routeHook(route);
}
function clearNotif(pid) { if (S.notif[pid]) { const n = { ...S.notif }; delete n[pid]; set({ notif: n }); } }

// ---------- theme / prefs ----------
export function effectiveTheme() {
  const t = S.prefs.theme || "dark";
  if (t === "system") return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return t;
}
export function applyTheme() {
  const el = document.documentElement;
  const t = effectiveTheme();
  if (el.dataset.theme !== t) el.dataset.theme = t;
  el.style.setProperty("--h", String(S.prefs.hue ?? 285));
  try { localStorage.setItem("co-theme", S.prefs.theme || "dark"); localStorage.setItem("co-hue", String(S.prefs.hue ?? 285)); } catch (_) {}
}
if (window.matchMedia) window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => { if (S.prefs.theme === "system") applyTheme(); });
export async function setPrefs(p) {
  set({ prefs: { ...S.prefs, ...p } });
  applyTheme();
  try { const r = await patch("/me/prefs", p); set({ prefs: { ...S.prefs, ...(r && r.prefs) } }); }
  catch (e) { toast(errMsg(e, "Không lưu được tuỳ chọn giao diện"), "error"); }
}
export const viewMode = () => S.view || S.prefs.defaultView || "grid";

// ---------- boot / auth ----------
export async function boot() {
  set({ boot: "loading" });
  try {
    const st = await get("/setup/status");
    if (st && st.configured === false) { set({ boot: "setup", setupStatus: st }); return; }
  } catch (e) {
    set({ boot: "offline", bootError: errMsg(e) });
    scheduleBootRetry();
    return;
  }
  try {
    const r = await api("/me", { quiet401: true });
    await afterLogin(r);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) set({ boot: "login" });
    else { set({ boot: "offline", bootError: errMsg(e) }); scheduleBootRetry(); }
  }
}
let bootRetry = null;
function scheduleBootRetry() {
  clearTimeout(bootRetry);
  bootRetry = setTimeout(() => { if (S.boot === "offline") boot(); }, 5000);
}
export const retryBoot = () => { clearTimeout(bootRetry); boot(); };

let workspaceHook = null;
export function onWorkspaceReady(fn) { workspaceHook = fn; }

async function afterLogin(r) {
  const prefs = (r.user && r.user.prefs) || {};
  set({
    me: r.user, prefs,
    caps: { scripts: !!r.canUseScripts, workspace: !!r.canManageWorkspace, nas: !!r.canBrowseNas },
  });
  applyTheme();
  await loadWorkspace();
  set({ boot: "ready" });
  onRoute();
  if (workspaceHook) workspaceHook();
}

export async function login({ account, passwd, otp }) {
  const body = { account, passwd };
  if (otp) body.otp_code = otp;
  const r = await post("/auth/dsm/login", body);
  if (r && r.needsOtp) return r;
  // The login reply only carries the user; /me adds prefs + capability flags.
  await afterLogin(await get("/me"));
  return r;
}
let logoutHook = null;
export function onLogout(fn) { logoutHook = fn; }
export async function logout() {
  if (logoutHook) logoutHook();
  try { await post("/auth/logout"); } catch (_) {}
  set({ me: null, boot: "login", projects: [], sources: {}, comments: {}, scripts: null, script: null, queue: [] });
}
setUnauthorizedHandler(() => {
  if (S.boot === "ready") { if (logoutHook) logoutHook(); set({ boot: "login", me: null }); toast("Phiên đăng nhập đã hết hạn — đăng nhập lại", "error"); }
});

// ---------- workspace data ----------
export async function loadWorkspace() {
  const [projects, users, queue, presence] = await Promise.all([
    get("/projects"),
    get("/users").catch(() => []),
    get("/review-queue").catch(() => []),
    get("/presence").catch(() => []),
  ]);
  const map = {};
  (users || []).forEach((u) => { map[u.id] = u; });
  set({ projects: projects || [], users: map, queue: queue || [], presence: Array.isArray(presence) ? presence : (presence && presence.users) || [] });
}
let projTimer = null;
export function refreshProjects(delay = 0) {
  clearTimeout(projTimer);
  projTimer = setTimeout(async () => {
    try {
      const projects = await get("/projects");
      const owned = (list) => list.filter((p) => p.myRole === "owner" || p.myRole === "editor").length > 0;
      if (owned(projects) !== owned(S.projects)) refreshCaps();
      set({ projects });
      if (S.showArchived) loadArchived();
    } catch (_) {}
  }, delay);
}
export async function refreshQueue() { try { set({ queue: await get("/review-queue") }); } catch (_) {} }
export async function loadArchived() {
  try {
    const all = await get("/projects?includeArchived=1");
    set({ archived: all.filter((p) => p.archivedAt) });
  } catch (e) { toast(errMsg(e), "error"); }
}
export function projectById(id) {
  return S.projects.find((p) => p.id === id) || (S.archived || []).find((p) => p.id === id) || null;
}
export function userById(id) { return (id && S.users[id]) || null; }

const sourceTimers = {};
export function loadSources(pid, delay = 0) {
  if (!pid) return;
  clearTimeout(sourceTimers[pid]);
  sourceTimers[pid] = setTimeout(async () => {
    try { set({ sources: { ...S.sources, [pid]: await get("/projects/" + enc(pid) + "/sources") } }); }
    catch (e) { if (e.status === 404 || e.status === 403) set({ sources: { ...S.sources, [pid]: [] } }); }
  }, delay);
}
export async function loadMembers(pid) {
  try {
    const list = await get("/projects/" + enc(pid) + "/members");
    const users = { ...S.users };
    list.forEach((m) => { if (m.user) users[m.user.id] = { ...users[m.user.id], ...m.user }; });
    set({ members: { ...S.members, [pid]: list }, users });
  } catch (_) {}
}
export function assetById(aid) {
  for (const list of Object.values(S.sources)) { const a = (list || []).find((x) => x.id === aid); if (a) return a; }
  return null;
}
export function myRole(pid) { const p = projectById(pid); return (p && p.myRole) || null; }
export const canManage = (pid) => ["owner", "editor"].includes(myRole(pid));
export const isFinal = (a) => !!a && a.kind === "final";
export const isOwner = (pid) => myRole(pid) === "owner";

// ---------- projects ----------
export async function createProject({ name, client }) {
  const p = await post("/projects", { name, client });
  set({ projects: [p, ...S.projects] });
  // Owning a project unlocks NAS import / workspace settings — refresh flags.
  refreshCaps();
  return p;
}
export async function refreshCaps() {
  try {
    const r = await get("/me");
    set({ caps: { scripts: !!r.canUseScripts, workspace: !!r.canManageWorkspace, nas: !!r.canBrowseNas } });
  } catch (_) {}
}
export async function patchProject(pid, body) {
  const p = await patch("/projects/" + enc(pid), body);
  set({ projects: S.projects.map((x) => (x.id === pid ? p : x)) });
  refreshProjects(300);
  return p;
}
export async function archiveProject(pid) {
  await post("/projects/" + enc(pid) + "/archive");
  set({ projects: S.projects.filter((p) => p.id !== pid) });
  if (S.showArchived) loadArchived();
}
export async function restoreProject(pid) {
  const p = await post("/projects/" + enc(pid) + "/restore");
  set({ projects: [p, ...S.projects], archived: (S.archived || []).filter((x) => x.id !== pid) });
}
export async function deleteProject(pid) {
  await del("/projects/" + enc(pid));
  set({ projects: S.projects.filter((p) => p.id !== pid), archived: (S.archived || []).filter((x) => x.id !== pid) });
  refreshCaps();
}

// ---------- assets ----------
function patchAssetLocal(aid, fields) {
  const sources = { ...S.sources };
  for (const pid of Object.keys(sources)) {
    if ((sources[pid] || []).some((a) => a.id === aid)) sources[pid] = sources[pid].map((a) => (a.id === aid ? { ...a, ...fields } : a));
  }
  set({ sources });
}
export async function setReviewStatus(aid, reviewStatus) {
  const prev = assetById(aid);
  patchAssetLocal(aid, { reviewStatus });
  try {
    const a = await patch("/assets/" + enc(aid), { reviewStatus });
    patchAssetLocal(aid, { reviewStatus: a.reviewStatus, reviewStatusAt: a.reviewStatusAt, reviewStatusBy: a.reviewStatusBy });
    refreshProjects(200);
    refreshQueue();
  } catch (e) {
    if (prev) patchAssetLocal(aid, { reviewStatus: prev.reviewStatus });
    toast(errMsg(e, "Không đổi được trạng thái"), "error");
  }
}
export async function patchAsset(aid, body) {
  const a = await patch("/assets/" + enc(aid), body);
  patchAssetLocal(aid, a);
  refreshProjects(200);
  return a;
}
export async function deleteAsset(pid, aid) {
  await del("/assets/" + enc(aid));
  set({ sources: { ...S.sources, [pid]: (S.sources[pid] || []).filter((a) => a.id !== aid) } });
  refreshProjects(200);
}
export async function reorderAssets(pid, orderedIds) {
  const list = S.sources[pid] || [];
  const byId = new Map(list.map((a) => [a.id, a]));
  set({ sources: { ...S.sources, [pid]: orderedIds.map((id, i) => ({ ...byId.get(id), position: i })).filter((a) => a.id) } });
  try { set({ sources: { ...S.sources, [pid]: await patch("/projects/" + enc(pid) + "/sources/reorder", { orderedAssetIds: orderedIds }) } }); }
  catch (e) { toast(errMsg(e), "error"); loadSources(pid); }
}

// ---------- review ----------
export async function openReview(pid, aid) {
  if (!S.sources[pid]) loadSources(pid);
  if (!S.members[pid]) loadMembers(pid);
  try {
    const versions = await get("/assets/" + enc(aid) + "/versions");
    set({ versions: { ...S.versions, [aid]: versions } });
    const cur = versions[versions.length - 1];
    if (cur) await Promise.all([loadComments(cur.id), loadRenditions(cur.id)]);
  } catch (e) {
    toast(errMsg(e, "Không mở được video"), "error");
  }
}
export async function loadVersion(vid) { await Promise.all([loadComments(vid), loadRenditions(vid)]); }
const commentTimers = {};
export function loadComments(vid, delay = 0) {
  return new Promise((resolve) => {
    clearTimeout(commentTimers[vid]);
    commentTimers[vid] = setTimeout(async () => {
      try { set({ comments: { ...S.comments, [vid]: await get("/asset-versions/" + enc(vid) + "/comments") } }); } catch (_) {}
      resolve();
    }, delay);
  });
}
export async function loadRenditions(vid) {
  try { set({ renditions: { ...S.renditions, [vid]: await get("/asset-versions/" + enc(vid) + "/renditions") } }); } catch (_) {}
}
export function patchRenditionLocal(vid, rid, fields) {
  const list = S.renditions[vid];
  if (!list) return;
  set({ renditions: { ...S.renditions, [vid]: list.map((r) => (r.id === rid ? { ...r, ...fields } : r)) } });
}
// Renditions this tab asked for: polled until the worker picks them up, since
// on SPK (SQLite, no event bus) worker progress isn't pushed to the browser.
const requested = new Map();   // renditionId → requestedAt
export function renditionBusy(r) {
  if (!r) return false;
  if (r.status === "processing") return true;
  if (r.status === "ready" || r.status === "failed") { requested.delete(r.id); return false; }
  if (r.lastJobStatus === "queued" || r.lastJobStatus === "running") return true;
  const at = requested.get(r.id);
  return !!at && Date.now() - at < 15 * 60_000;
}
export async function requestRendition(vid, height) {
  try {
    const r = await post("/asset-versions/" + enc(vid) + "/renditions", { height });
    if (r && r.id) { requested.set(r.id, Date.now()); patchRenditionLocal(vid, r.id, r); }
    toast("Đã gửi yêu cầu tạo proxy " + height + "p");
    loadRenditions(vid);
    return true;
  } catch (e) { toast(errMsg(e, "Không tạo được proxy"), "error", 6000); return false; }
}
export async function postComment(vid, body) {
  const c = await post("/asset-versions/" + enc(vid) + "/comments", body);
  set({ comments: { ...S.comments, [vid]: [...(S.comments[vid] || []), c] } });
  refreshProjects(400);
  return c;
}
function patchCommentLocal(vid, id, fields) {
  set({ comments: { ...S.comments, [vid]: (S.comments[vid] || []).map((c) => (c.id === id ? { ...c, ...fields } : c)) } });
}
export async function resolveComment(vid, id, resolved) {
  patchCommentLocal(vid, id, { resolved });
  try { await patch("/comments/" + enc(id), { resolved }); refreshProjects(400); }
  catch (e) { patchCommentLocal(vid, id, { resolved: !resolved }); toast(errMsg(e), "error"); }
}
export async function editComment(vid, id, content) {
  const c = await patch("/comments/" + enc(id), { content });
  patchCommentLocal(vid, id, c);
}
export async function editCommentSketch(vid, id, annotation) {
  const c = await patch("/comments/" + enc(id), { annotation });
  patchCommentLocal(vid, id, c);
}
export async function deleteComment(vid, id) {
  await del("/comments/" + enc(id));
  set({ comments: { ...S.comments, [vid]: (S.comments[vid] || []).filter((c) => c.id !== id && c.parentId !== id) } });
  refreshProjects(400);
}

// ---------- NAS import ----------
export const nasList = (path) => get("/nas/ls?path=" + enc(path || "/"));
export async function importFiles(pid, nasPaths) {
  const r = await post("/projects/" + enc(pid) + "/import", { nasPaths }, { timeout: 120000 });
  loadSources(pid);
  refreshProjects(300);
  return r;
}

// ---------- members ----------
export async function inviteMember(pid, { userId, dsmUsername, role }) {
  await post("/projects/" + enc(pid) + "/members", userId ? { userId, role } : { dsmUsername, role });
  await loadMembers(pid);
  refreshProjects();
}
export async function setMemberRole(pid, userId, role) {
  await patch("/projects/" + enc(pid) + "/members/" + enc(userId), { role });
  await loadMembers(pid);
}
export async function removeMember(pid, userId) {
  await del("/projects/" + enc(pid) + "/members/" + enc(userId));
  await loadMembers(pid);
  refreshProjects();
}

// ---------- scripts ----------
export async function loadScripts() {
  if (!S.caps.scripts) return;
  try { set({ scripts: await get("/scripts") }); } catch (_) { if (!S.scripts) set({ scripts: [] }); }
}
// Reopening a script fetches it again (someone may have edited it since),
// unless this tab still has edits for it in flight or just loaded it.
export async function openScript(id) {
  if (S.script && S.script.id === id && (S.scriptSave !== "saved" || Date.now() - S.scriptLoadedAt < 3000)) return;
  set({ script: null, scriptSave: "saved", scriptConflict: null });
  try { set({ script: await get("/scripts/" + enc(id)), scriptLoadedAt: Date.now() }); }
  catch (e) { toast(errMsg(e, "Không mở được kịch bản"), "error"); go({ name: "scripts" }); }
}
export async function createScript(projectId) {
  const s = await post("/scripts", { title: "Kịch bản chưa đặt tên", projectId: projectId || null });
  set({ scripts: [s, ...(S.scripts || [])], script: { ...s, comments: [] }, scriptSave: "saved", scriptConflict: null, scriptLoadedAt: Date.now() });
  go({ name: "script", sid: s.id });
  return s;
}
export function patchScriptLocal(fields) {
  if (!S.script) return;
  const script = { ...S.script, ...fields };
  set({ script, scripts: (S.scripts || []).map((x) => (x.id === script.id ? { ...x, ...fields, comments: x.comments } : x)) });
}
export async function setScriptField(field, value) {
  const s = S.script;
  if (!s) return;
  const before = s[field];
  patchScriptLocal({ [field]: value });
  try {
    const r = await patch("/scripts/" + enc(s.id), { [field]: value });
    patchScriptLocal({ ...r, comments: S.script.comments });
  } catch (e) { patchScriptLocal({ [field]: before }); toast(errMsg(e), "error"); }
}
export async function deleteScript(id) {
  await del("/scripts/" + enc(id));
  set({ scripts: (S.scripts || []).filter((x) => x.id !== id), script: null });
}

// ---------- settings ----------
export const fetchUpdateStatus = (force) => get("/admin/update-status" + (force ? "?refresh=1" : ""));
export const fetchVersion = () => get("/version");

// ---------- Final video ----------
// Each delivery is its own asset (kind "final"). Owner approves it with an
// air date (which confirms the schedule) or sends it back (Cần sửa).
async function afterFinalChange(pid, project) {
  if (project) set({ projects: S.projects.map((x) => (x.id === pid ? project : x)) });
  loadSources(pid);
  refreshProjects(300);
  refreshQueue();
}
export async function deliverFinalFromNas(pid, nasPath) {
  const a = await post("/projects/" + enc(pid) + "/final", { nasPath }, { timeout: 120000 });
  await afterFinalChange(pid);
  return a;
}
export async function approveFinal(pid, airDate) {
  await afterFinalChange(pid, await post("/projects/" + enc(pid) + "/final/approve", { airDate }));
}
export async function rejectFinal(pid) {
  await afterFinalChange(pid, await post("/projects/" + enc(pid) + "/final/reject", {}));
}

// Upload from the computer in 16 MB chunks. The server remembers how far it
// got, so a dropped connection retries from there, and picking the same file
// again after a reload resumes instead of starting over.
const uploadAborts = {};
const uploadKey = (pid, f) => "coop.finalUpload:" + pid + ":" + f.name + ":" + f.size + ":" + (f.lastModified || 0);
function setUpload(pid, fields) {
  const cur = S.uploads[pid];
  set({ uploads: { ...S.uploads, [pid]: fields === null ? undefined : { ...(cur || {}), ...fields } } });
}
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendChunk(id, offset, blob, signal) {
  const res = await fetch(API_BASE + "/final-uploads/" + enc(id) + "/chunk?offset=" + offset, {
    method: "POST", credentials: "include", headers: { "content-type": "application/octet-stream" }, body: blob, signal,
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (res.ok || res.status === 409) return body && typeof body.offset === "number" ? body.offset : offset;
  throw new ApiError((body && body.error) || "Lỗi " + res.status, res.status, body);
}

export async function uploadFinal(pid, file) {
  if (S.uploads[pid] && ["uploading", "processing"].includes(S.uploads[pid].state)) return;
  const ctl = new AbortController();
  uploadAborts[pid] = ctl;
  const key = uploadKey(pid, file);
  setUpload(pid, { name: file.name, size: file.size, sent: 0, state: "uploading", error: "", rate: 0, folder: null });
  try {
    let id = lsGet(key), offset = 0, chunkSize = 16 * 1024 * 1024;
    if (id) {
      try { const st = await get("/final-uploads/" + enc(id)); offset = st.offset; chunkSize = st.chunkSize || chunkSize; }
      catch (_) { id = null; }
    }
    if (!id) {
      const init = await post("/projects/" + enc(pid) + "/final-uploads", { name: file.name, size: file.size });
      id = init.id; chunkSize = init.chunkSize || chunkSize;
      setUpload(pid, { folder: init.folder || null });
      lsSet(key, id);
    }
    setUpload(pid, { id, sent: offset, resumed: offset > 0 });
    let fails = 0, t0 = Date.now(), b0 = offset;
    while (offset < file.size) {
      if (ctl.signal.aborted) throw new DOMException("aborted", "AbortError");
      try {
        offset = await sendChunk(id, offset, file.slice(offset, Math.min(file.size, offset + chunkSize)), ctl.signal);
        fails = 0;
        const dt = (Date.now() - t0) / 1000;
        setUpload(pid, { sent: offset, rate: dt > 1 ? (offset - b0) / dt : 0, state: "uploading", error: "" });
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        if (e instanceof ApiError && e.status && e.status !== 0 && e.status < 500 && e.status !== 408) throw e;
        if (++fails > 12) throw new ApiError("Mất kết nối quá lâu — chọn lại file để tải tiếp", 0);
        setUpload(pid, { state: "retrying", error: "Mất kết nối, thử lại…" });
        await sleep(Math.min(30000, 1000 * 2 ** fails));
        try { offset = (await get("/final-uploads/" + enc(id))).offset; } catch (_) {}
      }
    }
    setUpload(pid, { state: "processing", sent: file.size });
    const r = await post("/final-uploads/" + enc(id) + "/complete", {}, { timeout: 180000 });
    lsSet(key, null);
    setUpload(pid, null);
    toast("Đã nộp " + ((r.asset && r.asset.title) || "Final") + " — chờ chủ dự án duyệt");
    await afterFinalChange(pid);
    return r.asset;
  } catch (e) {
    if (e && e.name === "AbortError") { setUpload(pid, null); return null; }
    setUpload(pid, { state: "error", error: errMsg(e, "Không upload được file") });
    return null;
  } finally {
    delete uploadAborts[pid];
  }
}
export async function cancelUpload(pid) {
  const u = S.uploads[pid];
  if (uploadAborts[pid]) uploadAborts[pid].abort();
  if (u && u.id) { try { await del("/final-uploads/" + enc(u.id)); } catch (_) {} }
  try { Object.keys(localStorage).filter((k) => k.startsWith("coop.finalUpload:" + pid + ":")).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  setUpload(pid, null);
}
export const uploadBusy = () => Object.values(S.uploads).some((u) => u && ["uploading", "retrying", "processing"].includes(u.state));
window.addEventListener("beforeunload", (e) => { if (uploadBusy()) { e.preventDefault(); e.returnValue = ""; } });
