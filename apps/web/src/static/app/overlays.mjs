// Modal layers: ⌘K search, Chia sẻ, Thêm nguồn từ NAS, Dự án mới / sửa,
// đổi tên video, nhật ký.

import { html, useState, useEffect, useRef, useMemo } from "./lib.mjs";
import {
  S, set, go, toast, errMsg, guard, projectById, assetById, isOwner, canManage,
  createProject, patchProject, patchAsset, nasList, importFiles, inviteMember, setMemberRole, removeMember, loadMembers, createScript,
  deliverFinalFromNas, approveFinal, isFinal,
} from "./store.mjs";
import { ROLE_LABEL, ROLE_OPTS, fmtShort, fmtAgo, fmtDur, paletteOf, thumbBg, flatBg } from "./format.mjs";
import { Avatar, Seg, Spinner } from "./ui.mjs";
import { get, enc, mediaUrl } from "./api.mjs";

export function openOverlay(kind, props = {}) { set({ overlay: { kind, ...props } }); }
export function closeOverlay() { set({ overlay: null }); }

function Scrim({ children, top, pad = "120px 24px", onClose = closeOverlay }) {
  return html`<div class=${"scrim" + (top ? " top" : "")} style=${`padding:${pad}`} onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>${children}</div>`;
}

// ---------------------------------------------------------------------------
// ⌘K — projects, videos (already loaded), scripts, notes of the open video.
function Palette() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  const results = useMemo(() => {
    const n = q.trim().toLowerCase();
    const match = (s) => !n || String(s || "").toLowerCase().includes(n);
    const out = [];
    S.projects.forEach((p) => { if (match(p.name) || match(p.client)) out.push({ kind: "Dự án", label: p.name, meta: p.client, bg: thumbBg(...paletteOf(p)), go: () => go({ name: "project", pid: p.id }) }); });
    Object.entries(S.sources).forEach(([pid, list]) => (list || []).forEach((a) => {
      if (match(a.title)) out.push({ kind: "Video", label: a.title, meta: fmtDur(a.durationMs), bg: flatBg(...paletteOf(a)), go: () => go({ name: "review", pid, aid: a.id }) });
    }));
    S.queue.forEach((x) => {
      if (!S.sources[x.projectId] && match(x.title)) out.push({ kind: "Video", label: x.title, meta: x.projectName, bg: flatBg(...paletteOf({ id: x.assetId })), go: () => go({ name: "review", pid: x.projectId, aid: x.assetId }) });
    });
    (S.scripts || []).forEach((s) => { if (match(s.title)) out.push({ kind: "Kịch bản", label: s.title, meta: fmtAgo(s.updatedAt), bg: "var(--paper)", go: () => go({ name: "script", sid: s.id }) }); });
    if (S.route.name === "review") {
      Object.values(S.comments).flat().filter((c) => !c.parentId && match(c.content)).forEach((c) => {
        out.push({ kind: "Ghi chú", label: c.content, meta: fmtShort(c.timestampMs), bg: "var(--acc-soft)", go: () => go({ ...S.route, t: c.timestampMs, c: c.id }) });
      });
    }
    if (n && "dự án mới".includes(n)) out.unshift({ kind: "Lệnh", label: "Tạo dự án mới", meta: "", bg: "var(--bg-3)", go: () => openOverlay("newProject") });
    if (n && "lịch".includes(n)) out.push({ kind: "Mở", label: "Lịch lên sóng", meta: "", bg: "var(--bg-3)", go: () => go({ name: "calendar" }) });
    if (n && "cài đặt".includes(n)) out.push({ kind: "Mở", label: "Cài đặt", meta: "", bg: "var(--bg-3)", go: () => go({ name: "settings" }) });
    return out.slice(0, 8);
  }, [q]);
  const pick = (r) => { closeOverlay(); r.go(); };
  return html`<${Scrim} top>
    <div class="modal palette" role="dialog" aria-label="Tìm kiếm">
      <input ref=${inputRef} value=${q} placeholder="Tìm dự án, video, kịch bản, ghi chú…" onInput=${(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown=${(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel(Math.min(sel + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setSel(Math.max(sel - 1, 0)); }
          else if (e.key === "Enter" && results[sel]) pick(results[sel]);
          else if (e.key === "Escape") closeOverlay();
        }} />
      <div style="padding:8px">
        ${results.map((r, i) => html`<div class=${"pal-row" + (i === sel ? " on" : "")} onMouseEnter=${() => setSel(i)} onClick=${() => pick(r)}>
          <div style=${`width:36px;height:24px;flex:0 0 36px;border-radius:6px;background:${r.bg};box-shadow:inset 0 0 0 1px var(--line)`}></div>
          <div class="grow ell" style="font-size:14.5px;font-weight:500">${r.label}</div>
          <div style="font-size:12px;color:var(--tx-3);white-space:nowrap">${r.kind}${r.meta ? " · " + r.meta : ""}</div>
        </div>`)}
        ${results.length === 0 && html`<div style="padding:18px 14px;color:var(--tx-3);font-size:13.5px">Không thấy kết quả.</div>`}
      </div>
      <div class="pal-foot">↑↓ chọn · ↵ mở · esc đóng</div>
    </div>
  </${Scrim}>`;
}

// ---------------------------------------------------------------------------
function Share({ pid }) {
  const p = projectById(pid);
  const members = S.members[pid];
  const owner = isOwner(pid);
  const [name, setName] = useState("");
  const [role, setRole] = useState("reviewer");
  const [busy, setBusy] = useState(false);
  useEffect(() => { loadMembers(pid); }, [pid]);
  if (!p) return null;
  const invite = async () => {
    const v = name.trim();
    if (!v) return;
    setBusy(true);
    // Prefer an existing account (typed name or email matches), else invite by DSM username.
    const known = Object.values(S.users).find((u) => [u.name, u.email].filter(Boolean).some((x) => x.toLowerCase() === v.toLowerCase()));
    try {
      await inviteMember(pid, known ? { userId: known.id, role } : { dsmUsername: v.replace(/@.*$/, ""), role });
      setName("");
      toast("Đã mời " + (known ? known.name : v));
    } catch (e) { toast(errMsg(e, "Không mời được"), "error"); }
    setBusy(false);
  };
  const copy = async () => {
    const url = location.origin + location.pathname + "#/p/" + enc(pid);
    try { await navigator.clipboard.writeText(url); toast("Đã copy link dự án"); }
    catch (_) { window.prompt("Copy link dự án:", url); }
  };
  return html`<${Scrim}>
    <div class="modal" style="max-width:560px" role="dialog" aria-label="Chia sẻ dự án">
      <div class="modal-title">Chia sẻ dự án</div>
      <div class="modal-sub">${p.name} — thành viên đăng nhập bằng tài khoản DSM của họ.</div>
      ${owner && html`<div class="row gap10" style="margin-bottom:12px;flex-wrap:wrap">
        <input class="input on-bg" style="flex:1;min-width:180px" placeholder="Tài khoản DSM hoặc email" value=${name} list="shareUsers"
          onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && invite()} />
        <datalist id="shareUsers">${Object.values(S.users).map((u) => html`<option value=${u.name}>${u.email || ""}</option>`)}</datalist>
        <${Seg} opts=${ROLE_OPTS} value=${role} onPick=${setRole} />
        <button type="button" class="btn btn-primary" style="height:42px" disabled=${busy || !name.trim()} onClick=${invite}>Mời</button>
      </div>`}
      ${!members && html`<div style="padding:20px 0"><${Spinner} size=${20} /></div>`}
      ${(members || []).map((m) => {
        const u = m.user || S.users[m.userId] || { id: m.userId, name: m.userId };
        const me = S.me && m.userId === S.me.id;
        return html`<div class="row gap12" style="padding:12px 0;border-bottom:1px solid var(--line)">
          <${Avatar} user=${u} size=${30} />
          <div class="grow" style="min-width:0"><div style="font-size:14px;font-weight:500">${u.name}${me ? html`<span class="muted" style="font-weight:400"> · bạn</span>` : ""}</div><div style="font-size:12.5px;color:var(--tx-3)">${u.email || ""}</div></div>
          ${owner && !me
            ? html`<select class="input on-bg" style="width:auto;height:34px;font-size:13px" value=${m.role} onChange=${(e) => guard(() => setMemberRole(pid, m.userId, e.target.value))}>
                ${["owner", "editor", "reviewer", "client"].map((r) => html`<option value=${r}>${ROLE_LABEL[r]}</option>`)}
              </select>
              <button type="button" class="link" title="Gỡ khỏi dự án" onClick=${() => { if (confirm("Gỡ " + u.name + " khỏi dự án?")) guard(() => removeMember(pid, m.userId)); }}>Gỡ</button>`
            : html`<div style="font-size:13px;color:var(--tx-2)">${ROLE_LABEL[m.role] || m.role}</div>`}
        </div>`;
      })}
      <div class="modal-foot">
        <button type="button" class="grow" style="font-size:13.5px;color:var(--acc-tx);text-align:left" onClick=${copy}>Copy link dự án</button>
        <button type="button" class="btn btn-outline" style="height:38px" onClick=${closeOverlay}>Xong</button>
      </div>
    </div>
  </${Scrim}>`;
}

// ---------------------------------------------------------------------------
function Import({ pid, final }) {
  const p = projectById(pid);
  const [path, setPath] = useState("/");
  const [listing, setListing] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError("");
    nasList(path).then((l) => { if (alive) { setListing(l); setLoading(false); } })
      .catch((e) => { if (alive) { setError(errMsg(e, "Không đọc được NAS")); setLoading(false); } });
    return () => { alive = false; };
  }, [path]);
  const entries = (listing && listing.entries) || [];
  const crumbs = (listing && listing.crumbs) || [{ label: "/", path: "/" }];
  const n = Object.keys(sel).length;
  const doImport = async () => {
    if (!n) return;
    setBusy(true);
    if (final) {
      try {
        const a = await deliverFinalFromNas(pid, Object.keys(sel)[0]);
        toast("Đã nộp " + a.title + " — chờ chủ dự án duyệt");
        closeOverlay();
      } catch (e) { toast(errMsg(e, "Không nộp được Final"), "error", 6000); }
      setBusy(false);
      return;
    }
    try {
      const r = await importFiles(pid, Object.keys(sel));
      const k = (r && r.imported && r.imported.length) || 0;
      toast(k ? "Đã thêm " + k + " nguồn vào dự án" : "Không thêm được file nào — chỉ nhận file video", k ? "ok" : "error");
      closeOverlay();
    } catch (e) { toast(errMsg(e, "Không thêm được nguồn"), "error", 6000); }
    setBusy(false);
  };
  return html`<${Scrim} pad="96px 24px">
    <div class="modal" style="max-width:680px" role="dialog" aria-label=${final ? "Nộp Final từ NAS" : "Thêm nguồn từ NAS"}>
      <div class="modal-title">${final ? "Chọn file Final trên NAS" : "Thêm nguồn từ NAS"}</div>
      ${final && html`<div style="margin:-6px 0 14px;font-size:13.5px;color:var(--tx-2)">Chọn file đã xuất. Final sẽ ở trạng thái Chờ duyệt cho tới khi chủ dự án duyệt.</div>`}
      <div class="crumbs">
        ${crumbs.map((c, i) => html`${i > 0 && html`<span>/</span>`}<span class="c" onClick=${() => setPath(c.path)}>${c.label === "/" ? "NAS" : c.label}</span>`)}
      </div>
      <div style="max-height:min(52vh,520px);overflow-y:auto;margin:0 -4px;padding:0 4px">
        ${loading && html`<div style="padding:28px 0"><${Spinner} size=${22} /></div>`}
        ${error && html`<div class="err" style="padding:16px 0">${error}</div>`}
        ${!loading && !error && entries.length === 0 && html`<div class="muted" style="padding:20px 0;font-size:13.5px">Thư mục trống hoặc không có file video.</div>`}
        ${!loading && entries.map((f) => {
          if (f.type === "folder") {
            return html`<div class="file-row" onClick=${() => setPath(f.path)}>
              <div style="width:18px;flex:0 0 18px;color:var(--tx-3);text-align:center">›</div>
              <div class="grow ell" style="font-size:14.5px;font-weight:500">${f.name}</div>
              <div style="font-size:12.5px;color:var(--tx-3)">${typeof f.childCount === "number" ? f.childCount + " mục" : "thư mục"}</div>
            </div>`;
          }
          const on = !!sel[f.path];
          return html`<div class="file-row" onClick=${() => { const s = final ? {} : { ...sel }; if (on) delete s[f.path]; else s[f.path] = true; setSel(s); }}>
            <div class=${"box" + (on ? " on" : "")}>${on ? "✓" : ""}</div>
            <div class="grow" style="min-width:0">
              <div class="ell" style=${`font-size:14.5px;font-weight:500;color:${on ? "var(--tx)" : "var(--tx-2)"}`}>${f.name}</div>
              <div style="font-size:12.5px;color:var(--tx-3)">${[f.codec, f.sizeLabel, f.durationMs ? fmtDur(f.durationMs) : ""].filter(Boolean).join(" · ")}</div>
            </div>
            <div class="mono" style="font-size:11.5px;color:var(--tx-2)">${f.resolutionLabel || ""}</div>
          </div>`;
        })}
      </div>
      <div class="modal-foot">
        <div class="grow" style="font-size:13px;color:var(--tx-2)">${n ? (final ? Object.keys(sel)[0].split("/").pop() : "Đã chọn " + n + " file · file gốc giữ nguyên trên NAS") : "Chưa chọn file nào"}</div>
        <button type="button" class="link" style="padding:0 8px;font-size:13.5px" onClick=${closeOverlay}>Huỷ</button>
        <button type="button" class="btn btn-primary" disabled=${!n || busy} onClick=${doImport}>${final ? (busy ? "Đang nộp…" : "Nộp làm Final") : busy ? "Đang thêm…" : "Thêm vào " + (p ? "dự án" : "")}</button>
      </div>
    </div>
  </${Scrim}>`;
}

// ---------------------------------------------------------------------------
// Owner approves the current final and confirms the air date in one step.
function ApproveFinal({ pid }) {
  const p = projectById(pid);
  const fin = p && p.final;
  const tomorrow = new Date(Date.now() + 86400000);
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const [date, setDate] = useState((p && p.airDate) || iso(tomorrow));
  const [busy, setBusy] = useState(false);
  const reschedule = fin && fin.reviewStatus === "ok";
  const submit = async () => {
    if (!date || busy) return;
    setBusy(true);
    try {
      await approveFinal(pid, date);
      toast(reschedule ? "Đã đổi ngày lên sóng" : "Đã duyệt " + (fin ? fin.title : "Final") + " · lịch lên sóng đã chốt");
      closeOverlay();
    } catch (e) { toast(errMsg(e, "Không duyệt được"), "error"); }
    setBusy(false);
  };
  return html`<${Scrim}>
    <div class="modal" style="max-width:460px" role="dialog" aria-label="Duyệt Final">
      <div class="modal-title">${reschedule ? "Đổi ngày lên sóng" : "Duyệt " + (fin ? fin.title : "Final")}</div>
      <div style="font-size:13.5px;color:var(--tx-2);line-height:1.6;margin-bottom:18px">${reschedule
        ? "Final đã duyệt. Chọn ngày lên sóng mới — lịch vẫn ở trạng thái đã chốt."
        : html`${fin ? fin.title : "Final"} chuyển sang <b style="color:var(--s-ok);font-weight:600">Đã duyệt</b> và ngày lên sóng được chốt trên Lịch.`}</div>
      <label class="field-label" style="display:block;font-size:12.5px;color:var(--tx-3);margin-bottom:6px">Ngày lên sóng</label>
      <input type="date" class="input" value=${date} min=${iso(new Date())} onInput=${(e) => setDate(e.target.value)} style="width:100%" />
      ${p && p.airDate && p.airDate !== date && html`<div class="muted" style="font-size:12.5px;margin-top:8px">Dự kiến trước đó: ${p.airDate.split("-").reverse().join("/")}</div>`}
      <div class="modal-foot">
        <div class="grow"></div>
        <button type="button" class="link" style="padding:0 8px;font-size:13.5px" onClick=${closeOverlay}>Huỷ</button>
        <button type="button" class="btn btn-primary" disabled=${!date || busy} onClick=${submit}>${busy ? "Đang lưu…" : reschedule ? "Lưu ngày" : "Duyệt & chốt lịch"}</button>
      </div>
    </div>
  </${Scrim}>`;
}

// ---------------------------------------------------------------------------
function ProjectForm({ pid }) {
  const editing = pid ? projectById(pid) : null;
  const [name, setName] = useState(editing ? editing.name : "");
  const [client, setClient] = useState(editing ? editing.client : "");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      if (editing) { await patchProject(pid, { name: name.trim(), client: client.trim() }); closeOverlay(); }
      else { const p = await createProject({ name: name.trim(), client: client.trim() }); closeOverlay(); go({ name: "project", pid: p.id }); }
    } catch (e) { toast(errMsg(e), "error"); }
    setBusy(false);
  };
  const onKey = (e) => { if (e.key === "Enter") submit(); };
  return html`<${Scrim} pad="140px 24px">
    <div class="modal" style="max-width:480px" role="dialog">
      <div class="modal-title" style="margin-bottom:22px">${editing ? "Sửa dự án" : "Dự án mới"}</div>
      <div class="field-label">Tên dự án</div>
      <input class="input on-bg lg" autofocus value=${name} placeholder="VD: Vinamilk — TVC Tết 15s" onInput=${(e) => setName(e.target.value)} onKeyDown=${onKey} style="margin-bottom:16px" />
      <div class="field-label">Khách hàng</div>
      <input class="input on-bg lg" value=${client} placeholder="VD: Vinamilk" onInput=${(e) => setClient(e.target.value)} onKeyDown=${onKey} />
      <div class="modal-foot" style="justify-content:flex-end;margin-top:26px">
        <button type="button" class="link" style="padding:0 8px;font-size:13.5px" onClick=${closeOverlay}>Huỷ</button>
        <button type="button" class="btn btn-primary" disabled=${!name.trim() || busy} onClick=${submit}>${editing ? "Lưu" : "Tạo dự án"}</button>
      </div>
    </div>
  </${Scrim}>`;
}

function RenameAsset({ aid }) {
  const a = assetById(aid);
  const [title, setTitle] = useState(a ? a.title : "");
  if (!a) return null;
  const submit = () => guard(async () => { if (!title.trim()) return; await patchAsset(aid, { title: title.trim() }); closeOverlay(); });
  return html`<${Scrim} pad="160px 24px">
    <div class="modal" style="max-width:480px">
      <div class="modal-title" style="margin-bottom:18px">Đổi tên video</div>
      <input class="input on-bg lg" autofocus value=${title} onInput=${(e) => setTitle(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && submit()} />
      <div class="note" style="margin-top:10px">Chỉ đổi tên hiển thị — file trên NAS giữ nguyên.</div>
      <div class="modal-foot" style="justify-content:flex-end">
        <button type="button" class="link" style="padding:0 8px;font-size:13.5px" onClick=${closeOverlay}>Huỷ</button>
        <button type="button" class="btn btn-primary" onClick=${submit}>Lưu</button>
      </div>
    </div>
  </${Scrim}>`;
}

const AUDIT_LABEL = {
  "asset.imported": "thêm nguồn", "asset.updated": "sửa video", "asset.deleted": "xoá video", "asset.downloaded": "tải bản gốc",
  "comment.created": "viết ghi chú", "comment.resolved": "đánh dấu xong", "comment.reopened": "mở lại ghi chú", "comment.edited": "sửa ghi chú", "comment.deleted": "xoá ghi chú",
  "project.created": "tạo dự án", "project.update": "sửa dự án", "project.archived": "lưu trữ", "project.restored": "khôi phục", "project.downloaded": "tải ZIP",
  "project.member_added": "mời thành viên", "project.member_role_changed": "đổi quyền", "project.member_removed": "gỡ thành viên", "share.created": "tạo link chia sẻ",
};
function Audit({ pid }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { get("/projects/" + enc(pid) + "/audit?limit=200").then(setRows).catch((e) => { setRows([]); toast(errMsg(e), "error"); }); }, [pid]);
  return html`<${Scrim} pad="96px 24px">
    <div class="modal" style="max-width:640px">
      <div class="row"><div class="modal-title grow">Nhật ký hoạt động</div><a class="link" href=${mediaUrl("/projects/" + enc(pid) + "/audit.csv")}>Tải CSV</a></div>
      <div style="max-height:60vh;overflow-y:auto;margin-top:18px">
        ${!rows && html`<${Spinner} size=${22} />`}
        ${(rows || []).map((r) => {
          const u = S.users[r.actorUserId];
          const extra = r.payload && (r.payload.reviewStatus || r.payload.snippet || r.payload.title || r.payload.name || r.payload.userName);
          return html`<div class="row gap12" style="padding:10px 0;border-bottom:1px solid var(--line);font-size:13.5px">
            <${Avatar} user=${u} name=${u ? u.name : "Hệ thống"} size=${22} />
            <div class="grow ell"><b style="font-weight:500">${u ? u.name : "Hệ thống"}</b> ${AUDIT_LABEL[r.action] || r.action}${extra ? html`<span class="muted"> · ${String(extra).slice(0, 80)}</span>` : ""}</div>
            <div class="muted" style="font-size:12px;white-space:nowrap">${fmtAgo(r.createdAt)}</div>
          </div>`;
        })}
        ${rows && rows.length === 0 && html`<div class="muted">Chưa có hoạt động.</div>`}
      </div>
      <div class="modal-foot" style="justify-content:flex-end"><button type="button" class="btn btn-outline" style="height:38px" onClick=${closeOverlay}>Đóng</button></div>
    </div>
  </${Scrim}>`;
}

function NewScript({ pid }) {
  useEffect(() => { closeOverlay(); guard(() => createScript(pid), "Không tạo được kịch bản"); }, []);
  return null;
}

const KINDS = { palette: Palette, share: Share, import: Import, approveFinal: ApproveFinal, newProject: ProjectForm, editProject: ProjectForm, renameAsset: RenameAsset, audit: Audit, newScript: NewScript };

export function Overlays() {
  const o = S.overlay;
  useEffect(() => {
    if (!o) return undefined;
    const k = (e) => { if (e.key === "Escape") closeOverlay(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [o && o.kind]);
  if (!o) return null;
  const C = KINDS[o.kind];
  return C ? html`<${C} key=${o.kind + (o.pid || "")} ...${o} />` : null;
}
