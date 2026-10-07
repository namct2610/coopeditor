// Kịch bản: page previews of every script, filtered by status.

import { html } from "../lib.mjs";
import { S, set, go, createScript, guard, projectById } from "../store.mjs";
import { SST, todayLabel, fmtAgo } from "../format.mjs";
import { ScriptPill } from "../ui.mjs";

export function Scripts() {
  if (!S.caps.scripts) {
    return html`<div class="screen"><div class="page"><div class="empty">Tài khoản khách không dùng được mục Kịch bản.</div></div></div>`;
  }
  const list = S.scripts;
  const all = list || [];
  const counts = { all: all.length };
  Object.keys(SST).forEach((k) => { counts[k] = all.filter((s) => s.status === k).length; });
  const shown = all.filter((s) => S.scriptFilter === "all" || s.status === S.scriptFilter);
  return html`<div class="screen" data-screen-label="Kịch bản"><div class="page">
    <div class="head" style="margin-bottom:44px">
      <div class="head-main">
        <div class="eyebrow">${todayLabel()}</div>
        <h1 class="display" style="margin:0">Kịch bản</h1>
        <div class="lede">Viết, gắn vào dự án và gửi nhóm duyệt. Tự lưu sau mỗi lần gõ.</div>
      </div>
      <button type="button" class="btn btn-primary" onClick=${() => guard(() => createScript(null), "Không tạo được kịch bản")}>Kịch bản mới</button>
    </div>
    <div class="row gap8" style="flex-wrap:wrap;margin-bottom:32px">
      ${[["all", "Tất cả"], ...Object.keys(SST).map((k) => [k, SST[k].label])].map(([k, l]) => html`
        <button type="button" class=${"chip" + (S.scriptFilter === k ? " on" : "")} onClick=${() => set({ scriptFilter: k })}>${l}<span class="n">${counts[k]}</span></button>`)}
    </div>
    ${list === null && html`<div class="empty">Đang tải…</div>`}
    ${list && shown.length > 0 && html`<div class="grid-scripts">${shown.map((s) => {
      const p = s.projectId ? projectById(s.projectId) : null;
      const lines = (s.previewLines && s.previewLines.length ? s.previewLines : ["(Trang trắng)"]);
      return html`<div class="card" key=${s.id} role="link" tabindex="0" style="gap:16px" onClick=${() => go({ name: "script", sid: s.id })} onKeyDown=${(e) => e.key === "Enter" && go({ name: "script", sid: s.id })}>
        <div class="paper">
          <div class="paper-kind">${(p ? p.client || p.name : s.projectName) || "Chưa gắn dự án"}</div>
          ${lines.map((t, i) => html`<div class=${"paper-line" + (i === 0 ? " first" : "")}>${t}</div>`)}
          <div class="fade"></div>
        </div>
        <div>
          <div style="font-size:16px;font-weight:500;letter-spacing:-0.015em;line-height:1.35;text-wrap:pretty">${s.title}</div>
          <div style="margin-top:5px;font-size:12.5px;color:var(--tx-3)">${[p ? p.client || p.name : s.projectName, "sửa " + fmtAgo(s.updatedAt) + (s.updatedByName ? " bởi " + s.updatedByName : "")].filter(Boolean).join(" · ")}</div>
        </div>
        <div class="row gap10"><${ScriptPill} k=${s.status} /><div class="grow"></div><div style="font-size:12.5px;color:var(--tx-2)">${s.commentCount ? s.commentCount + " bình luận" : ""}</div></div>
      </div>`;
    })}</div>`}
    ${list && shown.length === 0 && html`<div class="empty">${all.length ? "Không có kịch bản nào ở trạng thái này." : "Chưa có kịch bản nào. Bấm “Kịch bản mới” để bắt đầu."}</div>`}
  </div></div>`;
}
