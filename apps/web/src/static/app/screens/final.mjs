// Video Final: the cut assembled from the project's sources. An editor
// delivers it (upload from the computer or pick a file on the NAS); it then
// waits for the project owner, who approves it and confirms the air date, or
// sends it back. Each delivery is a round (Final v1, v2…) with its own notes.

import { html, useState, useRef } from "../lib.mjs";
import {
  S, go, canManage, isOwner, isFinal, userById, guard, toast, uploadFinal, cancelUpload, rejectFinal,
} from "../store.mjs";
import { FST, dm, dayFromIso, daysBetween, today, fmtAgo, fmtDur, paletteOf, resLabel } from "../format.mjs";
import { Thumb, StatusPill, Menu, MenuItem, posterUrl } from "../ui.mjs";
import { openOverlay } from "../overlays.mjs";

const lastFile = {}; // pid → File, so "Thử lại" can resume without re-picking

function fmtBytes(n) {
  if (!n) return "0 MB";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i < 2 ? Math.round(n) : n.toFixed(1)) + " " + u[i];
}
function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return "còn < 1 phút";
  if (sec < 3600) return "còn " + Math.round(sec / 60) + " phút";
  return "còn " + Math.floor(sec / 3600) + " giờ " + Math.round((sec % 3600) / 60) + " phút";
}

export function startFinalUpload(pid, file) {
  if (!file) return;
  if (!/\.(mp4|mov|mxf|m4v|mkv|webm|avi)$/i.test(file.name)) { toast("Chỉ nộp được file video (mp4, mov, mxf…)", "error"); return; }
  lastFile[pid] = file;
  uploadFinal(pid, file);
}
function pickFile(pid) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "video/*,.mov,.mxf,.mkv";
  inp.onchange = () => inp.files && inp.files[0] && startFinalUpload(pid, inp.files[0]);
  inp.click();
}

function UploadBar({ pid, u }) {
  const pct = u.size ? Math.min(100, (u.sent / u.size) * 100) : 0;
  const eta = u.rate > 0 ? (u.size - u.sent) / u.rate : NaN;
  const label = u.state === "processing" ? "Đang hoàn tất trên NAS — đọc thông tin video…"
    : u.state === "retrying" ? "Mất kết nối — đang thử lại, phần đã tải được giữ nguyên"
    : u.state === "error" ? u.error
    : [fmtBytes(u.sent) + " / " + fmtBytes(u.size), u.rate > 0 ? fmtBytes(u.rate) + "/s" : "", fmtEta(eta)].filter(Boolean).join(" · ");
  return html`<div class="final-upload">
    <div class="row gap10" style="align-items:baseline">
      <div class="grow ell" style="font-size:14px;font-weight:500">${u.resumed && u.state === "uploading" ? "Tải tiếp: " : "Đang nộp: "}${u.name}</div>
      <div class="mono" style="font-size:12.5px;color:var(--tx-2)">${Math.floor(pct)}%</div>
    </div>
    <div class="final-track"><div class=${"final-fill" + (u.state === "error" ? " err" : "")} style=${`width:${pct}%`}></div></div>
    <div class="row gap10">
      <div class="grow" style=${`font-size:12.5px;color:${u.state === "error" ? "var(--s-fix)" : "var(--tx-3)"}`}>${label}</div>
      ${u.state === "error" && lastFile[pid] && html`<button type="button" class="link" style="font-size:12.5px" onClick=${() => uploadFinal(pid, lastFile[pid])}>Thử lại</button>`}
      ${u.state !== "processing" && html`<button type="button" class="link" style="font-size:12.5px" onClick=${() => { if (u.state === "error" || confirm("Huỷ upload? Phần đã tải sẽ bị xoá.")) cancelUpload(pid); }}>Huỷ</button>`}
    </div>
    ${u.folder && html`<div class="muted" style="font-size:12px">Lưu vào ${u.folder} trên NAS</div>`}
  </div>`;
}

function DeliverButtons({ pid, primary, label = "Nộp Final" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  return html`<div style="position:relative">
    <button type="button" ref=${btn} class=${"btn " + (primary ? "btn-primary" : "btn-outline")} onClick=${() => setOpen(!open)}>${label} ▾</button>
    <${Menu} open=${open} onClose=${() => setOpen(false)} anchorRef=${btn} align="end" width=${260}>
      <${MenuItem} onClick=${() => { setOpen(false); pickFile(pid); }}>Upload từ máy tính</${MenuItem}>
      ${S.caps.nas && html`<${MenuItem} onClick=${() => { setOpen(false); openOverlay("import", { pid, final: true }); }}>Chọn file đã xuất trên NAS</${MenuItem}>`}
    </${Menu}>
  </div>`;
}

export function FinalPanel({ p, assets }) {
  const pid = p.id;
  const finals = (assets || []).filter(isFinal).sort((a, b) => a.position - b.position);
  const cur = finals[finals.length - 1] || null;
  const u = S.uploads[pid];
  const manage = canManage(pid);
  const owner = isOwner(pid);
  const [over, setOver] = useState(false);
  const drop = manage ? {
    onDragOver: (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: (e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startFinalUpload(pid, f); },
  } : {};
  const t = today();
  const air = p.airDate ? dayFromIso(p.airDate) : null;
  const airLine = !air ? "Chưa có ngày lên sóng dự kiến"
    : p.airConfirmed ? "Lên sóng " + dm(air) + " · đã chốt"
    : "Dự kiến lên sóng " + dm(air) + (daysBetween(t, air) >= 0 ? " (còn " + daysBetween(t, air) + " ngày)" : "") + " · chốt khi duyệt Final";

  if (!cur) {
    return html`<div class=${"final-box empty" + (over ? " over" : "")} ...${drop} data-final="empty">
      <div class="grow" style="min-width:260px">
        <div class="eyebrow" style="margin-bottom:8px">Video Final</div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.015em">Chưa nộp bản Final</div>
        <div style="margin-top:6px;font-size:13.5px;color:var(--tx-2);line-height:1.6;max-width:520px">Ghép xong các nguồn thành bản lên sóng thì nộp Final. Chủ dự án duyệt và chốt ngày lên sóng.${manage ? " Có thể kéo thả file vào đây." : ""}</div>
        <div class="muted" style="margin-top:8px;font-size:12.5px">◆ ${airLine}</div>
      </div>
      ${u ? html`<div style="flex:1 1 360px"><${UploadBar} pid=${pid} u=${u} /></div>` : manage && html`<${DeliverButtons} pid=${pid} primary />`}
    </div>`;
  }

  const st = cur.reviewStatus || "wait";
  const by = userById(cur.reviewStatusBy);
  const open = () => go({ name: "review", pid, aid: cur.id });
  const meta = [fmtDur(cur.durationMs), resLabel(cur), cur.sizeLabel && cur.sizeLabel !== "—" ? cur.sizeLabel : "", cur.openCommentsCount ? cur.openCommentsCount + " ghi chú mở" : ""].filter(Boolean).join(" · ");
  const verdict = st === "ok" ? "Duyệt" : st === "fix" ? "Trả về" : st === "air" ? "Lên sóng" : "Nộp";
  return html`<div class=${"final-box" + (over ? " over" : "")} ...${drop} data-final=${st}>
    <div class="final-thumb" role="link" tabindex="0" onClick=${open}>
      <${Thumb} src=${posterUrl(cur.id)} pal=${paletteOf(cur)} radius=${12}>
        <div class="glass mono" style="left:10px;top:10px;height:22px;padding:0 8px;border-radius:6px;font-size:11px;letter-spacing:0.06em">FINAL v${finals.length}</div>
        ${cur.status === "processing" && html`<div class="proc-veil"><div style="font-size:12px;color:#fff;margin-bottom:8px">Đang tạo proxy · ${cur.progress || 0}%</div><div class="bar-track"><div class="bar-fill" style=${`width:${cur.progress || 0}%`}></div></div></div>`}
      </${Thumb}>
    </div>
    <div class="grow" style="min-width:260px;display:flex;flex-direction:column;gap:10px">
      <div class="row gap10" style="flex-wrap:wrap">
        <div class="eyebrow">Video Final</div>
        <${StatusPill} k=${st} map=${FST} />
      </div>
      <div style="font-size:19px;font-weight:600;letter-spacing:-0.015em;cursor:pointer" onClick=${open}>${cur.title}</div>
      <div style="font-size:13px;color:var(--tx-2)">${meta}</div>
      <div style="font-size:12.5px;color:var(--tx-3)">${verdict} bởi ${by ? by.name : "—"} · ${fmtAgo(cur.reviewStatusAt || cur.createdAt)}</div>
      <div class=${"final-air" + (p.airConfirmed ? " ok" : "")}>◆ ${airLine}</div>
      ${u && html`<${UploadBar} pid=${pid} u=${u} />`}
      <div class="row gap10" style="flex-wrap:wrap;margin-top:4px">
        <button type="button" class="btn btn-outline" onClick=${open}>Xem & ghi chú</button>
        ${owner && st === "wait" && html`<button type="button" class="btn btn-primary" onClick=${() => openOverlay("approveFinal", { pid })}>Duyệt & chốt lịch</button>
          <button type="button" class="btn btn-outline" onClick=${() => guard(() => rejectFinal(pid))}>Cần sửa</button>`}
        ${owner && st === "fix" && html`<button type="button" class="btn btn-outline" onClick=${() => openOverlay("approveFinal", { pid })}>Duyệt bản này</button>`}
        ${owner && st === "ok" && html`<button type="button" class="btn btn-outline" onClick=${() => openOverlay("approveFinal", { pid })}>Đổi ngày lên sóng</button>`}
        ${!owner && st === "wait" && html`<div class="muted" style="font-size:13px">Đang chờ chủ dự án duyệt</div>`}
        <div class="grow"></div>
        ${manage && !u && html`<${DeliverButtons} pid=${pid} label=${st === "fix" ? "Nộp bản sửa" : "Nộp bản mới"} primary=${st === "fix"} />`}
      </div>
      ${finals.length > 1 && html`<div class="row" style="gap:6px 14px;flex-wrap:wrap;font-size:12.5px;color:var(--tx-3)">Các vòng trước:
        ${finals.slice(0, -1).reverse().map((f, i) => html`<button type="button" class="link" style="font-size:12.5px" onClick=${() => go({ name: "review", pid, aid: f.id })}>v${finals.length - 1 - i} · ${FST[f.reviewStatus || "wait"].label}</button>`)}
      </div>`}
    </div>
  </div>`;
}
