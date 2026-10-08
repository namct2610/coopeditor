// Chi tiết dự án: status counters (click to filter), air date, linked script,
// the videos as grid or list (list rows drag to reorder).

import { html, useState, useRef, useEffect } from "../lib.mjs";
import {
  S, set, go, viewMode, projectById, canManage, isOwner, isFinal, guard, toast, errMsg, loadSources,
  patchProject, patchAsset, deleteAsset, reorderAssets, archiveProject, deleteProject,
} from "../store.mjs";
import { SST, dm, daysBetween, today, fmtAgo, fmtDur, paletteOf, resLabel, isAudio, p2, dayFromIso } from "../format.mjs";
import { Thumb, AvStack, StatusPill, Seg, MoreMenu, DatePicker, posterUrl, useContextMenu, ContextMenu } from "../ui.mjs";
import { nextAir } from "./hub.mjs";
import { openOverlay } from "../overlays.mjs";
import { FinalPanel } from "./final.mjs";
import { api, mediaUrl, enc } from "../api.mjs";

export async function downloadZip(p) {
  try {
    const info = await api("/projects/" + enc(p.id) + "/download.zip?check=1");
    if (!info.files) return toast("Không có file gốc nào trên NAS", "error");
    if (info.busy) return toast("Đang có quá nhiều lượt tải ZIP, thử lại sau", "error");
    toast("Đang tải " + info.files + " file gốc" + (info.missing && info.missing.length ? " · thiếu " + info.missing.length + " file" : ""));
    window.location.href = mediaUrl("/projects/" + enc(p.id) + "/download.zip");
  } catch (e) { toast(errMsg(e), "error"); }
}
export function downloadSource(aid) { window.location.href = mediaUrl("/assets/" + enc(aid) + "/source?download=1"); }

function assetMeta(a) {
  return [a.codec, resLabel(a), a.frameRate ? a.frameRate + " fps" : "", a.sizeLabel && a.sizeLabel !== "—" ? a.sizeLabel : ""].filter(Boolean).join(" · ");
}
function assetMenu(pid, a, setDateFor) {
  if (!canManage(pid)) return [{ label: "Tải bản gốc", onClick: () => downloadSource(a.id) }];
  return [
    { label: a.airDate ? "Đổi ngày lên sóng (" + dm(dayFromIso(a.airDate)) + ")" : "Đặt ngày lên sóng", onClick: () => setDateFor(a.id) },
    { label: "Đổi tên", onClick: () => openOverlay("renameAsset", { pid, aid: a.id }) },
    { label: "Tải bản gốc", onClick: () => downloadSource(a.id) },
    "-",
    { label: "Xoá khỏi dự án", danger: true, onClick: () => { if (confirm("Xoá \"" + a.title + "\" khỏi dự án? File gốc trên NAS không bị xoá; ghi chú của video sẽ mất.")) guard(() => deleteAsset(pid, a.id)); } },
  ];
}

// Right-click on a video: open it, then the same actions as its "⋯" menu.
function AssetContextMenu({ cm, pid, a, open, setDateFor }) {
  return html`<${ContextMenu} cm=${cm} title=${a.title} items=${cm.at ? [{ label: "Mở review", onClick: open }, "-", ...assetMenu(pid, a, setDateFor)] : []} />`;
}

function AssetCard({ pid, a, dateFor, setDateFor }) {
  const processing = a.status === "processing";
  const audio = isAudio(a);
  const open = () => go({ name: "review", pid, aid: a.id });
  const cm = useContextMenu();
  const foot = useRef(null);
  return html`<div class="card" role="link" tabindex="0" onClick=${open} onKeyDown=${(e) => e.key === "Enter" && open()} onContextMenu=${cm.open}>
    <${Thumb} src=${posterUrl(a.id)} pal=${paletteOf(a)} radius=${14} audio=${audio}>
      <div class="glass mono" style="left:12px;top:12px;height:22px;padding:0 8px;border-radius:6px;font-size:11px">v${a.versionsCount || 1}</div>
      <div class="on-thumb" style="right:12px;bottom:10px;color:rgba(255,255,255,0.88)">${fmtDur(a.durationMs)}</div>
      ${audio && html`<div class="on-thumb" style="left:12px;bottom:10px;font-size:11px;letter-spacing:0.08em;color:rgba(255,255,255,0.7)">AUDIO</div>`}
      ${processing && html`<div class="proc-veil">
        <div style="font-size:12.5px;color:#fff;margin-bottom:8px">Đang tạo proxy · ${a.progress || 0}%</div>
        <div class="bar-track"><div class="bar-fill" style=${`width:${a.progress || 0}%`}></div></div>
      </div>`}
      ${a.status === "failed" && html`<div class="glass" style="right:12px;top:12px;background:rgba(120,30,20,.7)">Proxy lỗi</div>`}
      <${MoreMenu} items=${assetMenu(pid, a, setDateFor)} style="right:10px;top:10px" />
    </${Thumb}>
    <div style="min-width:0">
      <div class="ell" style="font-size:16px;font-weight:500;letter-spacing:-0.015em">${a.title}</div>
      <div class="ell" style="margin-top:4px;font-size:12.5px;color:var(--tx-3)">${assetMeta(a)}</div>
    </div>
    <div class="row gap10" ref=${foot}>
      ${a.airDate && html`<span class="mono" style="font-size:11.5px;color:var(--acc-tx)">◆ ${dm(dayFromIso(a.airDate))}</span>`}
      <div class="grow"></div>
      <div style="font-size:12.5px;color:var(--tx-2)">${a.openCommentsCount ? a.openCommentsCount + " ghi chú" : ""}</div>
      ${dateFor === a.id && html`<${DatePicker} value=${a.airDate} anchorRef=${foot} onClose=${() => setDateFor(null)}
        onPick=${(d) => { setDateFor(null); guard(() => patchAsset(a.id, { airDate: d })); }} />`}
    </div>
    <${AssetContextMenu} cm=${cm} pid=${pid} a=${a} open=${open} setDateFor=${setDateFor} />
  </div>`;
}

const ROW_COLS = "28px 128px minmax(0,1fr) 90px 60px";
function AssetRow({ pid, a, i, drag, dateFor, setDateFor }) {
  const processing = a.status === "processing";
  const open = () => go({ name: "review", pid, aid: a.id });
  const cm = useContextMenu();
  const row = useRef(null);
  return html`<div ref=${row} class=${"list-row" + (drag.over === a.id ? " drop-target" : "") + (drag.id === a.id ? " dragging" : "")} onContextMenu=${cm.open}
    style=${`grid-template-columns:${ROW_COLS};gap:20px;padding:14px 0;position:relative`}
    draggable=${drag.enabled} onDragStart=${(e) => drag.start(e, a.id)} onDragOver=${(e) => drag.over_(e, a.id)} onDrop=${(e) => drag.drop(e, a.id)} onDragEnd=${drag.end}
    role="link" tabindex="0" onClick=${open} onKeyDown=${(e) => e.key === "Enter" && open()}>
    <div class="mono" style="font-size:12px;color:var(--tx-3)">${p2(i + 1)}</div>
    <${Thumb} src=${posterUrl(a.id)} pal=${paletteOf(a)} radius=${9} audio=${isAudio(a)}>
      ${processing && html`<div style="position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,0.2)"><div style=${`height:100%;width:${a.progress || 0}%;background:#fff`}></div></div>`}
    </${Thumb}>
    <div style="min-width:0">
      <div class="ell" style="font-size:15.5px;font-weight:500;letter-spacing:-0.01em">${a.title} <span class="mono" style="font-size:11.5px;font-weight:400;color:var(--tx-3);margin-left:6px">v${a.versionsCount || 1}</span></div>
      <div class="ell" style="margin-top:3px;font-size:12.5px;color:var(--tx-3)">${assetMeta(a)}${processing ? " · proxy " + (a.progress || 0) + "%" : ""}${a.airDate ? " · lên sóng " + dm(dayFromIso(a.airDate)) : ""}</div>
    </div>
    <div style="font-size:12.5px;color:var(--tx-2);text-align:right;white-space:nowrap">${a.openCommentsCount ? a.openCommentsCount + " ghi chú" : ""}</div>
    <div class="mono" style="font-size:12px;color:var(--tx-2);text-align:right">${fmtDur(a.durationMs)}</div>
    <${MoreMenu} items=${assetMenu(pid, a, setDateFor)} cls="icon-btn flat" style="right:-44px;top:50%;margin-top:-18px" />
    ${dateFor === a.id && html`<${DatePicker} value=${a.airDate} anchorRef=${row} align="end" onClose=${() => setDateFor(null)}
      onPick=${(d) => { setDateFor(null); guard(() => patchAsset(a.id, { airDate: d })); }} />`}
    <${AssetContextMenu} cm=${cm} pid=${pid} a=${a} open=${open} setDateFor=${setDateFor} />
  </div>`;
}

function useDrag(pid, list, enabled) {
  const [st, setSt] = useState({ id: null, over: null });
  return {
    enabled, id: st.id, over: st.over,
    start: (e, id) => { if (!enabled) return; e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", id); } catch (_) {} setSt({ id, over: null }); },
    over_: (e, id) => { if (!st.id) return; e.preventDefault(); if (st.over !== id) setSt({ ...st, over: id }); },
    drop: (e, id) => {
      e.preventDefault();
      if (!st.id || st.id === id) return setSt({ id: null, over: null });
      const ids = list.map((a) => a.id).filter((x) => x !== st.id);
      ids.splice(ids.indexOf(id), 0, st.id);
      setSt({ id: null, over: null });
      reorderAssets(pid, ids);
    },
    end: () => setSt({ id: null, over: null }),
  };
}

export function Project() {
  const pid = S.route.pid;
  const p = projectById(pid);
  const [dateFor, setDateFor] = useState(null);
  const [airOpen, setAirOpen] = useState(false);
  const airBtn = useRef(null);
  const all = S.sources[pid];
  const list = (all || []).filter((a) => !isFinal(a)).sort((a, b) => a.position - b.position);
  const shown = list;
  const isGrid = viewMode() === "grid";
  const manage = canManage(pid);
  const drag = useDrag(pid, list, manage && !isGrid);
  // Proxy progress on the cards: poll while anything is encoding.
  const encoding = (all || []).some((a) => a.status === "processing");
  useEffect(() => {
    if (!encoding) return undefined;
    const t = setInterval(() => loadSources(pid), 4000);
    return () => clearInterval(t);
  }, [pid, encoding]);
  if (!p) {
    return html`<div class="screen"><div class="page tight">
      <button type="button" class="back" onClick=${() => go({ name: "hub" })}>← Dự án</button>
      <div class="empty">${S.projects.length ? "Không tìm thấy dự án này, hoặc bạn không còn quyền truy cập." : "Đang tải…"}</div>
    </div></div>`;
  }
  const na = nextAir(p);
  const t = today();
  const script = (S.scripts || []).find((s) => s.projectId === pid);
  const menu = [
    manage && { label: "Sửa tên / khách hàng", onClick: () => openOverlay("editProject", { pid }) },
    { label: "Tải toàn bộ file gốc (.zip)", onClick: () => downloadZip(p) },
    manage && { label: "Nhật ký hoạt động", onClick: () => openOverlay("audit", { pid }) },
    S.caps.scripts && !script && { label: "Tạo kịch bản cho dự án", onClick: () => openOverlay("newScript", { pid }) },
    isOwner(pid) && "-",
    isOwner(pid) && { label: "Lưu trữ dự án", onClick: () => guard(async () => { await archiveProject(pid); go({ name: "hub" }); toast("Đã lưu trữ dự án"); }) },
    isOwner(pid) && { label: "Xoá dự án", danger: true, onClick: () => { if (confirm("Xoá vĩnh viễn \"" + p.name + "\"? Ghi chú và proxy sẽ mất, file gốc trên NAS giữ nguyên.")) guard(async () => { await deleteProject(pid); go({ name: "hub" }); }); } },
  ];

  return html`<div class="screen" data-screen-label="Chi tiết dự án"><div class="page tight">
    <button type="button" class="back" onClick=${() => go({ name: "hub" })}>← Dự án</button>
    <div class="head" style="margin-bottom:22px">
      <div class="head-main" style="min-width:320px">
        <div class="row gap10" style="margin-bottom:12px"><div class="eyebrow" style="letter-spacing:0.08em">${p.client || "—"}</div><${StatusPill} k=${p.reviewStatus || "edit"} sm /></div>
        <h1 class="display md" style="margin:0">${p.name}</h1>
        <div style="margin-top:14px;font-size:14.5px;color:var(--tx-2)">${list.length} video · ${p.openCommentsCount || 0} ghi chú mở · ${p.totalSizeLabel || "0 GB"} trên NAS · cập nhật ${fmtAgo(p.updatedAt)}</div>
      </div>
      <div class="row gap10">
        <div style="margin-right:6px"><${AvStack} users=${p.team || []} size=${30} /></div>
        <button type="button" class="btn btn-outline" onClick=${() => openOverlay("share", { pid })}>Chia sẻ</button>
        ${manage && S.caps.nas && html`<button type="button" class="btn btn-primary" onClick=${() => openOverlay("import", { pid })}>Thêm nguồn</button>`}
        <div style="position:relative;width:40px;height:40px"><${MoreMenu} items=${menu} cls="icon-btn" style="left:0;top:2px" width=${260} /></div>
      </div>
    </div>
    <div class="row gap10" style="flex-wrap:wrap;margin-bottom:44px;position:relative">
      <button type="button" ref=${airBtn} class="acc-chip" style=${manage ? "" : "cursor:default"} onClick=${() => manage && setAirOpen(!airOpen)}>
        <span class="diamond"></span>${na ? (p.airConfirmed ? "Lên sóng " : "Dự kiến lên sóng ") + dm(na) + " · " + (daysBetween(t, na) === 0 ? "hôm nay" : "còn " + daysBetween(t, na) + " ngày") + (p.airConfirmed ? " · đã chốt" : "") : "Chưa đặt ngày lên sóng"}
      </button>
      ${airOpen && html`<${DatePicker} value=${p.airDate} anchorRef=${airBtn} onClose=${() => setAirOpen(false)}
        onPick=${(d) => { setAirOpen(false); guard(() => patchProject(pid, { airDate: d })); }} />`}
      ${script && html`<button type="button" class="ring-chip" onClick=${() => go({ name: "script", sid: script.id })}>Kịch bản: ${script.title} <span class="muted">· ${(SST[script.status] || SST.draft).label}</span></button>`}
    </div>

    ${all !== undefined && html`<${FinalPanel} p=${p} assets=${all} />`}
    ${all === undefined && html`<div class="empty">Đang tải video…</div>`}
    ${all && list.length > 0 && html`
      <div class="row gap12" style="margin-bottom:24px">
        <div class="sec-title">Nguồn</div>
        <div class="sec-count">${shown.length} video</div>
        ${drag.enabled && html`<div class="muted" style="font-size:12px">· kéo để sắp xếp</div>`}
        <div class="grow"></div>
        <${Seg} opts=${[["grid", "Lưới"], ["list", "Danh sách"]]} value=${isGrid ? "grid" : "list"} onPick=${(v) => set({ view: v })} />
      </div>
      ${isGrid && html`<div class="grid-assets">${shown.map((a) => html`<${AssetCard} key=${a.id} pid=${pid} a=${a} dateFor=${dateFor} setDateFor=${setDateFor} />`)}</div>`}
      ${!isGrid && html`<div style="display:flex;flex-direction:column;padding-right:44px">${shown.map((a, i) => html`<${AssetRow} key=${a.id} pid=${pid} a=${a} i=${list.indexOf(a)} drag=${drag} dateFor=${dateFor} setDateFor=${setDateFor} />`)}</div>`}
    `}
    ${all && list.length === 0 && html`<div class="empty-box">
      <div class="t">Dự án chưa có nguồn</div>
      <div class="d">Chọn file trên NAS — file gốc giữ nguyên chỗ cũ, proxy 720p/1080p được tạo khi cần để review mượt.</div>
      ${manage && S.caps.nas
        ? html`<button type="button" class="btn btn-primary" style="margin-top:8px" onClick=${() => openOverlay("import", { pid })}>Thêm nguồn từ NAS</button>`
        : html`<div class="muted" style="font-size:13px">Chỉ chủ dự án hoặc người quản lý mới thêm được nguồn.</div>`}
    </div>`}
  </div></div>`;
}
