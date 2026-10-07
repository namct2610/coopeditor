// Lịch lên sóng: one row per project across the month — a bar for the
// production window (created → last airing) and a diamond per airing — plus
// the next five airings below.

import { html } from "../lib.mjs";
import { S, set, go } from "../store.mjs";
import { ST, FST, ORDER, WD, WD_LONG, dm, daysBetween, today, todayLabel, dayFromIso, parseIso, paletteOf, tint } from "../format.mjs";
import { Thumb, StatusPill, projectThumbUrl } from "../ui.mjs";
import { projectStatus } from "./hub.mjs";

const total = (p) => ORDER.reduce((n, k) => n + ((p.statusMix && p.statusMix[k]) || 0), 0);

export function Calendar() {
  const t = today();
  const base = new Date(t.getFullYear(), t.getMonth() + S.calOffset, 1);
  const Y = base.getFullYear(), M = base.getMonth();
  const nDays = new Date(Y, M + 1, 0).getDate();
  const mStart = new Date(Y, M, 1), mEnd = new Date(Y, M, nDays);
  const idx = (d) => daysBetween(mStart, d);
  const pct = (n) => ((n / nDays) * 100).toFixed(3) + "%";

  const days = Array.from({ length: nDays }, (_, i) => {
    const d = new Date(Y, M, i + 1);
    const isToday = +d === +t;
    const wk = d.getDay() === 0 || d.getDay() === 6;
    return { n: i + 1, wd: WD[d.getDay()], wk, isToday };
  });

  const projects = S.projects.filter((p) => (p.airDates || []).length);
  const rows = projects.map((p) => {
    const airs = p.airDates.map(dayFromIso).sort((a, b) => a - b);
    const created = parseIso(p.createdAt);
    const startRaw = created ? new Date(created.getFullYear(), created.getMonth(), created.getDate()) : airs[0];
    const s = startRaw < airs[0] ? startRaw : airs[0];
    const last = airs[airs.length - 1];
    const overlap = s <= mEnd && last >= mStart;
    const bs = Math.max(idx(s), 0);
    const lastIn = last <= mEnd;
    const be = lastIn ? idx(last) + 0.5 : nDays;
    const st = projectStatus(p);
    return {
      p, st, overlap, lastIn, last, bs, be,
      // The project's own date is only firm once its final is approved.
      marks: airs.filter((d) => d >= mStart && d <= mEnd).map((d) => ({ d, past: d < t, planned: !p.airConfirmed && p.airDate && +dayFromIso(p.airDate) === +d })),
      first: airs.find((d) => d >= mStart) || last,
    };
  }).filter((r) => r.overlap || r.marks.length).sort((a, b) => a.first - b.first);

  const monthAirs = rows.reduce((n, r) => n + r.marks.length, 0);
  const upcoming = projects
    .flatMap((p) => p.airDates.map(dayFromIso).filter((d) => d >= t).map((d) => ({ d, p })))
    .sort((a, b) => a.d - b.d).slice(0, 5);
  const todayIn = t >= mStart && t <= mEnd;

  return html`<div class="screen" data-screen-label="Lịch lên sóng"><div class="page wide">
    <div class="head" style="margin-bottom:40px">
      <div class="head-main">
        <div class="eyebrow">${todayLabel()}</div>
        <h1 class="display" style="margin:0">Lịch lên sóng</h1>
        <div class="lede">${monthAirs} lượt lên sóng · ${rows.filter((r) => r.marks.length).length} dự án trong tháng</div>
      </div>
      <div class="row gap6">
        <button type="button" class="icon-btn" title="Tháng trước" onClick=${() => set({ calOffset: S.calOffset - 1 })}>‹</button>
        <div style="min-width:150px;text-align:center;font-size:16px;font-weight:600;letter-spacing:-0.01em">Tháng ${M + 1}, ${Y}</div>
        <button type="button" class="icon-btn" title="Tháng sau" onClick=${() => set({ calOffset: S.calOffset + 1 })}>›</button>
        <button type="button" class="btn btn-outline" style="margin-left:8px;height:36px;padding:0 16px;font-size:13px" onClick=${() => set({ calOffset: 0 })}>Hôm nay</button>
      </div>
    </div>

    <div class="cal-box"><div class="cal-inner">
      <div class="row" style="border-bottom:1px solid var(--line);align-items:stretch">
        <div class="cal-name col-head" style="padding:16px 22px;display:flex;align-items:flex-end">DỰ ÁN</div>
        <div class="row grow" style="min-width:0;padding:12px 0 10px">
          ${days.map((d) => html`<div class="cal-day">
            <div class="mono" style="font-size:9.5px;color:var(--tx-3)">${d.wd}</div>
            <div class="cal-num" style=${`background:${d.isToday ? "var(--acc)" : "transparent"};color:${d.isToday ? "var(--on-acc)" : d.wk ? "var(--tx-3)" : "var(--tx-2)"}`}>${d.n}</div>
          </div>`)}
        </div>
      </div>
      <div style="position:relative">
        <div style="position:absolute;top:0;bottom:0;left:300px;right:0;display:flex;pointer-events:none">
          ${days.map((d) => html`<div style=${`flex:1;background:${d.wk ? "var(--wkend)" : "transparent"}`}></div>`)}
        </div>
        ${todayIn && html`<div style="position:absolute;top:0;bottom:0;left:300px;right:0;pointer-events:none;z-index:2">
          <div style=${`position:absolute;top:0;bottom:0;left:${pct(idx(t) + 0.5)};width:2px;margin-left:-1px;background:var(--acc);opacity:0.7`}></div>
        </div>`}
        ${rows.map((r) => html`<div class="cal-row" role="link" tabindex="0" onClick=${() => go({ name: "project", pid: r.p.id })} onKeyDown=${(e) => e.key === "Enter" && go({ name: "project", pid: r.p.id })}>
          <div class="cal-name">
            <${Thumb} src=${projectThumbUrl(r.p)} pal=${paletteOf(r.p)} ratio="3/2" radius=${7} style="width:48px;flex:0 0 48px" />
            <div style="min-width:0">
              <div class="ell" style="font-size:14px;font-weight:500;letter-spacing:-0.01em">${r.p.name}</div>
              <div class="ell" style="margin-top:2px;font-size:12px;color:var(--tx-3)">${[r.p.client, total(r.p) + " video"].filter(Boolean).join(" · ")}</div>
            </div>
          </div>
          <div class="cal-track">
            ${r.overlap && html`<div style=${`position:absolute;top:50%;height:6px;margin-top:-3px;left:${pct(r.bs)};width:${pct(Math.max(r.be - r.bs, 0.5))};border-radius:3px;background:${tint(ST[r.st].c, 30)}`}></div>`}
            ${r.marks.map((m) => html`<div class="cal-mark" style=${`left:${pct(idx(m.d) + 0.5)}`}>
              <i title=${m.planned ? "Dự kiến — chốt khi duyệt Final" : "Đã chốt"} style=${m.planned
                ? `background:var(--bg-2);outline:2px dashed ${FST[r.st].c};outline-offset:-2px;box-shadow:0 0 0 3px var(--bg-2)`
                : `background:${m.past ? "var(--bg-2)" : FST[r.st].c};box-shadow:inset 0 0 0 2px ${FST[r.st].c}, 0 0 0 3px var(--bg-2)`}></i>
              <div class="mono" style="font-size:10.5px;color:var(--tx-2);white-space:nowrap">${dm(m.d)}${m.planned ? "?" : ""}</div>
            </div>`)}
            ${r.overlap && !r.lastIn && html`<div class="mono" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);font-size:11px;color:var(--tx-2);padding:3px 8px;border-radius:6px;background:var(--bg-3)">→ ${dm(r.last)}</div>`}
          </div>
        </div>`)}
        ${rows.length === 0 && html`<div style="padding:40px 22px;font-size:13.5px;color:var(--tx-3);border-top:1px solid var(--line);position:relative;z-index:1">
          Tháng này chưa có lịch lên sóng. Đặt ngày ở trang chi tiết dự án (nút “Chưa đặt ngày lên sóng”) hoặc trên từng video.
        </div>`}
      </div>
    </div></div>
    <div class="legend">
      <div class="row gap8"><span style="width:22px;height:6px;border-radius:3px;background:var(--line-2)"></span>Thời gian sản xuất</div>
      <div class="row gap8"><span style="width:10px;height:10px;transform:rotate(45deg);border-radius:2px;background:var(--s-ok)"></span>Đã chốt (Final đã duyệt)</div>
      <div class="row gap8"><span style="width:10px;height:10px;transform:rotate(45deg);border-radius:2px;outline:2px dashed var(--tx-3);outline-offset:-2px"></span>Dự kiến</div>
      <div class="row gap8"><span style="width:2px;height:14px;background:var(--acc)"></span>Hôm nay</div>
    </div>

    ${upcoming.length > 0 && html`<div style="margin-top:64px">
      <div class="sec-title" style="margin-bottom:12px">Sắp lên sóng</div>
      ${upcoming.map(({ d, p }) => {
        const n = daysBetween(t, d);
        const vids = Math.max(1, Math.round(total(p) / Math.max(1, p.airDates.length)));
        return html`<div class="list-row" style="grid-template-columns:110px 72px minmax(0,1fr) 200px 110px;padding:18px 0" role="link" tabindex="0" onClick=${() => go({ name: "project", pid: p.id })} onKeyDown=${(e) => e.key === "Enter" && go({ name: "project", pid: p.id })}>
          <div><div style="font-size:24px;font-weight:600;letter-spacing:-0.03em;line-height:1">${dm(d)}</div><div style="margin-top:5px;font-size:12px;color:var(--tx-3)">${WD_LONG[d.getDay()]}</div></div>
          <${Thumb} src=${projectThumbUrl(p)} pal=${paletteOf(p)} ratio="16/10" radius=${8} />
          <div style="min-width:0"><div class="ell" style="font-size:15.5px;font-weight:500;letter-spacing:-0.01em">${p.name}</div><div style="margin-top:3px;font-size:12.5px;color:var(--tx-3)">${total(p) ? vids + " video" : "Chưa có video"}</div></div>
          <div class="row gap8"><${StatusPill} k=${projectStatus(p)} map=${p.final ? FST : ST} />${p.airDate && +dayFromIso(p.airDate) === +d && html`<span style=${`font-size:11.5px;color:${p.airConfirmed ? "var(--s-ok)" : "var(--tx-3)"}`}>${p.airConfirmed ? "đã chốt" : "dự kiến"}</span>`}</div>
          <div style=${`font-size:13px;font-weight:500;text-align:right;color:${n <= 3 ? "var(--s-fix)" : "var(--tx-3)"}`}>${n === 0 ? "Hôm nay" : n === 1 ? "Ngày mai" : "còn " + n + " ngày"}</div>
        </div>`;
      })}
    </div>`}
  </div></div>`;
}
