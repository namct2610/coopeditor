// Hub dự án: "Final chờ duyệt" queue on top, then every project filtered by
// status, as a grid or a list.

import { html } from "../lib.mjs";
import { S, set, go, viewMode, loadArchived, restoreProject, archiveProject, isOwner, guard } from "../store.mjs";
import { ST, ORDER, todayLabel, today, dayFromIso, daysBetween, dm, fmtAgo, fmtDur, paletteOf, tint } from "../format.mjs";
import { Thumb, AvStack, StatusPill, Seg, IcPlay, MoreMenu, posterUrl, projectThumbUrl } from "../ui.mjs";
import { openOverlay } from "../overlays.mjs";

export function nextAir(p) {
  const t = today();
  return (p.airDates || (p.airDate ? [p.airDate] : [])).map(dayFromIso).filter((d) => d >= t).sort((a, b) => a - b)[0] || null;
}
const mixTotal = (p) => p.sourcesCount || 0;
export const projectStatus = (p) => p.reviewStatus || "edit";

// Where the project stands, in words: the final round and its verdict.
export function FinalLine({ p }) {
  const f = p.final;
  const st = projectStatus(p);
  return html`<div class="row gap8" style="font-size:12.5px;color:var(--tx-3);min-width:0">
    <span class="dot dot6" style=${`background:${ST[st].c}`}></span>
    <span class="ell">${f ? "Final v" + f.round + " · " + ST[st].label + (p.airConfirmed ? " · lịch đã chốt" : "") : "Chưa nộp Final"}</span>
  </div>`;
}

function projectMenu(p) {
  if (!isOwner(p.id)) return [];
  return [
    { label: "Sửa tên / khách hàng", onClick: () => openOverlay("editProject", { pid: p.id }) },
    { label: "Lưu trữ dự án", onClick: () => guard(() => archiveProject(p.id)) },
  ];
}

function QueueCard({ q }) {
  const pal = paletteOf({ id: q.assetId });
  const notes = q.openCommentsCount ? q.openCommentsCount + " ghi chú" : "Chưa có ghi chú";
  return html`<a class="card" href=${"#/p/" + encodeURIComponent(q.projectId) + "/v/" + encodeURIComponent(q.assetId) + "?t=0"}
    onClick=${(e) => { e.preventDefault(); go({ name: "review", pid: q.projectId, aid: q.assetId, t: 0 }); }} style="color:inherit">
    <${Thumb} src=${posterUrl(q.assetId)} pal=${pal} radius=${16}>
      <div class="shade"></div>
      <div class="glass" style="left:14px;top:14px"><span class="dot" style="background:oklch(0.82 0.13 80)"></span>${q.kind === "final" ? "Final · chờ duyệt" : "Chờ review"}</div>
      <div class="on-thumb" style="left:14px;bottom:12px">v${q.versionsCount || 1} · ${fmtDur(q.durationMs)}</div>
      <div style="position:absolute;right:14px;bottom:12px;font-size:12px;color:rgba(255,255,255,0.85)">${notes}</div>
      <div class="play-dot"><${IcPlay} size=${16} color="#141413" style="margin-left:3px" /></div>
    </${Thumb}>
    <div style="min-width:0">
      <div class="card-title ell">${q.kind === "final" ? q.projectName + " — " + q.title : q.title}</div>
      <div class="card-meta ell">${[q.client || q.projectName, q.sentBy && "gửi bởi " + q.sentBy, q.sentAt && fmtAgo(q.sentAt)].filter(Boolean).join(" · ")}</div>
    </div>
  </a>`;
}

function ProjectCard({ p }) {
  const st = projectStatus(p);
  const na = nextAir(p);
  const total = mixTotal(p);
  const notes = p.openCommentsCount ? p.openCommentsCount + " ghi chú mở" : "—";
  const fresh = S.notif[p.id];
  return html`<div class="card" role="link" tabindex="0" onClick=${() => go({ name: "project", pid: p.id })} onKeyDown=${(e) => e.key === "Enter" && go({ name: "project", pid: p.id })}>
    <${Thumb} src=${projectThumbUrl(p)} pal=${paletteOf(p)} ratio="16/10" radius=${16}>
      <div class="glass" style="left:14px;top:14px"><span class="dot" style=${`background:${ST[st].c}`}></span>${ST[st].label}</div>
      <div class="glass" style="right:14px;top:14px;font-weight:400">${na ? "Lên sóng " + dm(na) : "Chưa đặt lịch"}</div>
      <div class="on-thumb" style="left:14px;bottom:12px;color:rgba(255,255,255,0.8)">${total} video</div>
      <${MoreMenu} items=${projectMenu(p)} style="right:14px;bottom:10px" menuStyle="right:0;bottom:38px" />
    </${Thumb}>
    <div>
      <div style="font-size:18px;font-weight:500;letter-spacing:-0.02em;line-height:1.3;text-wrap:pretty">${p.name}</div>
      <div class="card-meta" style="margin-top:5px">${[p.client, total + " video", "cập nhật " + fmtAgo(p.updatedAt)].filter(Boolean).join(" · ")}</div>
    </div>
    <${FinalLine} p=${p} />
    <div class="row gap12">
      <${AvStack} users=${p.team || []} size=${26} />
      <div class="grow"></div>
      ${fresh && html`<span class="pill sm" style=${`background:${tint("var(--acc)", 16)};color:var(--acc-tx)`}>${fresh} mới</span>`}
      <div style=${`font-size:13px;color:${p.openCommentsCount ? "var(--tx)" : "var(--tx-3)"}`}>${notes}</div>
    </div>
  </div>`;
}

const LIST_COLS = "120px minmax(0,1fr) 180px 130px 120px";
function ProjectRow({ p }) {
  const st = projectStatus(p);
  const na = nextAir(p);
  return html`<div class="list-row" style=${`grid-template-columns:${LIST_COLS}`} role="link" tabindex="0" onClick=${() => go({ name: "project", pid: p.id })} onKeyDown=${(e) => e.key === "Enter" && go({ name: "project", pid: p.id })}>
    <${Thumb} src=${projectThumbUrl(p)} pal=${paletteOf(p)} ratio="16/10" radius=${10} />
    <div style="min-width:0">
      <div class="ell" style="font-size:16.5px;font-weight:500;letter-spacing:-0.015em">${p.name}</div>
      <div class="row gap10" style="margin-top:4px;font-size:12.5px;color:var(--tx-3)">
        <${StatusPill} k=${st} sm />
        <span class="ell">${[p.client, mixTotal(p) + " video", "cập nhật " + fmtAgo(p.updatedAt)].filter(Boolean).join(" · ")}</span>
      </div>
    </div>
    <${FinalLine} p=${p} />
    <div style=${`font-size:13px;color:${p.openCommentsCount ? "var(--tx)" : "var(--tx-3)"}`}>${p.openCommentsCount ? p.openCommentsCount + " ghi chú mở" : "—"}</div>
    <div style="font-size:13px;color:var(--tx-2);text-align:right;white-space:nowrap">${na ? "Lên sóng " + dm(na) : "Chưa đặt lịch"}</div>
  </div>`;
}

function Archived() {
  if (!S.showArchived) {
    return html`<div style="margin-top:48px;font-size:13px;color:var(--tx-3)">Dự án đã lưu trữ · <button type="button" class="link" style="color:var(--tx-2);text-decoration:underline;text-underline-offset:3px" onClick=${() => { set({ showArchived: true }); loadArchived(); }}>hiện</button></div>`;
  }
  const list = S.archived;
  return html`<div style="margin-top:56px">
    <div class="row gap12" style="margin-bottom:12px">
      <div class="sec-title" style="font-size:17px">Đã lưu trữ</div>
      <div class="sec-count">${list ? list.length : "…"}</div>
      <div class="grow"></div>
      <button type="button" class="link" onClick=${() => set({ showArchived: false })}>ẩn</button>
    </div>
    ${list && !list.length && html`<div class="muted" style="font-size:13.5px">Không có dự án nào đã lưu trữ.</div>`}
    ${(list || []).map((p) => html`<div class="row gap16" style="padding:14px 0;border-bottom:1px solid var(--line)">
      <div class="ell grow" style="font-size:15px;color:var(--tx-2)">${p.name}<span class="muted" style="margin-left:10px;font-size:12.5px">${p.client}</span></div>
      ${isOwner(p.id) && html`<button type="button" class="btn btn-outline btn-xs" onClick=${() => guard(() => restoreProject(p.id))}>Khôi phục</button>`}
    </div>`)}
  </div>`;
}

export function Hub() {
  const projects = S.projects;
  const isGrid = viewMode() === "grid";
  const t = today();
  const airWeek = projects.reduce((n, p) => n + (p.airDates || []).map(dayFromIso).filter((d) => d >= t && daysBetween(t, d) <= 7).length, 0);
  const counts = { all: projects.length };
  ORDER.forEach((k) => { counts[k] = projects.filter((p) => projectStatus(p) === k).length; });
  const shown = projects.filter((p) => S.hubFilter === "all" || projectStatus(p) === S.hubFilter);
  const queue = S.queue;
  const mod = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K";

  return html`<div class="screen" data-screen-label="Hub dự án"><div class="page">
    <div class="head">
      <div class="head-main">
        <div class="eyebrow">${todayLabel()}</div>
        <h1 class="display" style="margin:0">Dự án</h1>
        <div class="lede">${projects.length} dự án · ${queue.length} Final chờ duyệt · ${airWeek} lịch lên sóng trong 7 ngày</div>
      </div>
      <button type="button" class="search-pill" onClick=${() => openOverlay("palette")}><span>Tìm dự án, video, ghi chú</span><span class="kbd">${mod}</span></button>
      <button type="button" class="btn btn-primary" onClick=${() => openOverlay("newProject")}>Dự án mới</button>
    </div>

    ${queue.length > 0 && html`
      <div class="row gap12" style="align-items:baseline;margin-bottom:20px"><div class="sec-title">Final chờ duyệt</div><div class="sec-count">${queue.length}</div></div>
      <div class="grid-queue">${queue.slice(0, 6).map((q) => html`<${QueueCard} key=${q.assetId} q=${q} />`)}</div>`}

    <div class="row gap12" style="flex-wrap:wrap;margin-bottom:28px">
      <div class="sec-title" style="margin-right:12px">Tất cả dự án</div>
      <div class="row gap8 grow" style="flex-wrap:wrap">
        ${[["all", "Tất cả"], ...ORDER.map((k) => [k, ST[k].label])].map(([k, label]) => html`
          <button type="button" class=${"chip" + (S.hubFilter === k ? " on" : "")} onClick=${() => set({ hubFilter: k })}>
            <span class="dot" style=${`background:${k === "all" ? "var(--tx-3)" : ST[k].c}`}></span>${label}<span class="n">${counts[k]}</span>
          </button>`)}
      </div>
      <${Seg} opts=${[["grid", "Lưới"], ["list", "Danh sách"]]} value=${isGrid ? "grid" : "list"} onPick=${(v) => set({ view: v })} />
    </div>

    ${isGrid && shown.length > 0 && html`<div class="grid-projects">${shown.map((p) => html`<${ProjectCard} key=${p.id} p=${p} />`)}</div>`}
    ${!isGrid && shown.length > 0 && html`<div style="display:flex;flex-direction:column">
      <div class="list-head col-head" style=${`grid-template-columns:${LIST_COLS}`}><div></div><div>DỰ ÁN</div><div>TIẾN ĐỘ</div><div>GHI CHÚ</div><div style="text-align:right">LÊN SÓNG</div></div>
      ${shown.map((p) => html`<${ProjectRow} key=${p.id} p=${p} />`)}
    </div>`}
    ${shown.length === 0 && projects.length > 0 && html`<div class="empty">Không có dự án nào ở trạng thái này.</div>`}
    ${projects.length === 0 && html`<div class="empty-box">
      <div class="t">Chưa có dự án nào</div>
      <div class="d">Tạo dự án, thêm video từ NAS — proxy nhẹ được tạo để cả nhóm review mượt, file gốc giữ nguyên chỗ cũ.</div>
      <button type="button" class="btn btn-primary" style="margin-top:8px" onClick=${() => openOverlay("newProject")}>Tạo dự án đầu tiên</button>
    </div>`}
    <${Archived} />
  </div></div>`;
}
