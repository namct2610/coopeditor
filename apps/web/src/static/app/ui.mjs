// Small shared components.

import { html, useState, useRef, useEffect, useOutside } from "./lib.mjs";
import { ST, SST, tint, shortName, avatarBg, thumbBg, isoDay, today, dayFromIso, WD, p2 } from "./format.mjs";
import { mediaUrl } from "./api.mjs";
import { S } from "./store.mjs";

// ---- icons ----
export const IcPlay = ({ size = 15, color = "currentColor", style = "" }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill=${color} style=${"margin-left:2px;" + style}><polygon points="6 4 20 12 6 20"></polygon></svg>`;
export const IcPause = ({ size = 14 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>`;
export const IcMore = () => html`<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`;

// ---- people ----
export function personOf(userOrId, fallbackName) {
  const u = typeof userOrId === "string" ? S.users[userOrId] : userOrId;
  const name = (u && u.name) || fallbackName || "Thành viên";
  const key = (u && u.id) || name;
  return { name, short: shortName(name), bg: avatarBg(key) };
}
export function Avatar({ user, name, size = 24, title, style = "" }) {
  const p = personOf(user, name);
  const fs = size >= 60 ? 22 : size >= 34 ? 11.5 : size >= 28 ? 10 : size >= 24 ? 8.5 : 7.5;
  return html`<div class="av" title=${title || p.name} style=${`width:${size}px;height:${size}px;font-size:${fs}px;background:${p.bg};${style}`}>${p.short}</div>`;
}
export function AvStack({ users, size = 26, overlap = 8, max = 5 }) {
  const list = (users || []).slice(0, max);
  const extra = (users || []).length - list.length;
  return html`<div class="av-stack">
    ${list.map((u) => html`<${Avatar} user=${u} size=${size} style=${`margin-right:-${overlap}px`} />`)}
    ${extra > 0 && html`<div class="av" style=${`width:${size}px;height:${size}px;font-size:9.5px;background:var(--bg-3);color:var(--tx-2);margin-right:-${overlap}px;box-shadow:0 0 0 2px var(--bg)`}>+${extra}</div>`}
  </div>`;
}

// ---- status ----
export function StatusPill({ k, sm, map = ST }) {
  const s = map[k] || map[Object.keys(map)[0]];
  return html`<span class=${"pill" + (sm ? " sm" : "")} style=${`background:${tint(s.c, 16)};color:${s.c}`}><span class="dot dot6" style=${`background:${s.c}`}></span>${s.label}</span>`;
}
export const ScriptPill = ({ k }) => html`<${StatusPill} k=${k} map=${SST} />`;

export function Seg({ opts, value, onPick, cls = "" }) {
  return html`<div class=${"seg " + cls} role="tablist">
    ${opts.map(([k, label, extra]) => html`<button type="button" role="tab" aria-selected=${value === k} class=${"seg-opt" + (value === k ? " on" : "")} onClick=${(e) => { e.stopPropagation(); onPick(k); }}>${extra}${label}</button>`)}
  </div>`;
}

export function Toggle({ on, onChange, disabled, label }) {
  return html`<div role="switch" aria-checked=${!!on} aria-label=${label} aria-disabled=${disabled ? "true" : "false"} tabindex="0" class=${"toggle" + (on ? " on" : "")}
    onClick=${() => !disabled && onChange(!on)} onKeyDown=${(e) => { if (!disabled && (e.key === " " || e.key === "Enter")) { e.preventDefault(); onChange(!on); } }}><i></i></div>`;
}

// ---- thumbnails: gradient placeholder, real poster on top once it loads ----
export function Thumb({ src, pal, ratio = "16/9", radius = 16, audio, children, style = "" }) {
  // Load state is keyed by src so a cached image that loads before effects
  // run can't be reset back to hidden.
  const [state, setState] = useState({ src, st: "loading" });
  const st = state.src === src ? state.st : "loading";
  const setSt = (v) => setState({ src, st: v });
  const bg = audio ? "repeating-linear-gradient(90deg, rgba(255,255,255,0.10) 0 2px, transparent 2px 6px), linear-gradient(155deg, #1c1c1a, #3a3934)" : thumbBg(pal[0], pal[1]);
  return html`<div class="thumb" style=${`aspect-ratio:${ratio};border-radius:${radius}px;background:${bg};${style}`}>
    ${src && st !== "failed" && !audio && html`<img src=${src} alt="" loading="lazy" decoding="async" style=${st === "ok" ? "" : "opacity:0"}
      onLoad=${() => setSt("ok")} onError=${() => setSt("failed")} />`}
    ${children}
  </div>`;
}
export const posterUrl = (assetId) => mediaUrl("/assets/" + encodeURIComponent(assetId) + "/poster?fallback=none");
export const projectThumbUrl = (p) => (p && p.thumbUrl ? mediaUrl(p.thumbUrl + "?fallback=none") : "");

// ---- popover menu ----
export function Menu({ open, onClose, children, style = "", anchorRef }) {
  const ref = useRef(null);
  useOutside(ref, (e) => { if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return; onClose(); }, open);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  if (!open) return null;
  return html`<div class="menu" ref=${ref} style=${style} onClick=${(e) => e.stopPropagation()}>${children}</div>`;
}
export const MenuItem = ({ onClick, children, danger, check, hint, disabled }) => html`<button type="button" class=${"menu-item" + (danger ? " danger" : "")} disabled=${disabled} style=${disabled ? "opacity:.45;cursor:default" : ""} onClick=${(e) => { e.stopPropagation(); if (!disabled) onClick(e); }}>${children}${check && html`<span class="chk">✓</span>`}${hint && html`<span class="hint">${hint}</span>`}</button>`;

// "⋯" button + menu, used on cards and rows.
export function MoreMenu({ items, cls = "more-btn", style = "", menuStyle = "right:0;top:38px" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return html`<div style=${"position:absolute;" + style} onClick=${(e) => e.stopPropagation()}>
    <button type="button" ref=${btn} class=${cls + (open ? " open" : "")} style="position:static" aria-label="Thao tác khác" onClick=${() => setOpen(!open)}><${IcMore} /></button>
    <${Menu} open=${open} onClose=${() => setOpen(false)} anchorRef=${btn} style=${menuStyle}>
      ${list.map((it) => (it === "-" ? html`<div class="menu-sep"></div>` : html`<${MenuItem} danger=${it.danger} onClick=${() => { setOpen(false); it.onClick(); }}>${it.label}</${MenuItem}>`))}
    </${Menu}>
  </div>`;
}

// ---- date picker ----
export function DatePicker({ value, onPick, onClose, style = "" }) {
  const init = value ? dayFromIso(value) : today();
  const [ym, setYm] = useState([init.getFullYear(), init.getMonth()]);
  const ref = useRef(null);
  useOutside(ref, onClose, true);
  const [y, m] = ym;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const t = isoDay(today());
  return html`<div class="date-pop" ref=${ref} style=${style} onClick=${(e) => e.stopPropagation()}>
    <div class="row gap8">
      <button type="button" class="icon-btn flat" style="width:30px;height:30px" onClick=${() => setYm(m === 0 ? [y - 1, 11] : [y, m - 1])} aria-label="Tháng trước">‹</button>
      <div class="grow" style="text-align:center;font-weight:600;font-size:14px">Tháng ${m + 1}, ${y}</div>
      <button type="button" class="icon-btn flat" style="width:30px;height:30px" onClick=${() => setYm(m === 11 ? [y + 1, 0] : [y, m + 1])} aria-label="Tháng sau">›</button>
    </div>
    <div class="dp-grid">
      ${["T2", "T3", "T4", "T5", "T6", "T7", "CN"].map((w) => html`<div class="dp-wd">${w}</div>`)}
      ${cells.map((d) => {
        const iso = isoDay(d);
        const cls = "dp-day" + (d.getMonth() !== m ? " out" : "") + (iso === t ? " today" : "") + (iso === value ? " sel" : "");
        return html`<div class=${cls} onClick=${() => onPick(iso)}>${d.getDate()}</div>`;
      })}
    </div>
    <div class="row gap8" style="margin-top:12px">
      <button type="button" class="link" onClick=${() => onPick(t)}>Hôm nay</button>
      <div class="grow"></div>
      ${value && html`<button type="button" class="link" style="color:var(--s-fix)" onClick=${() => onPick(null)}>Bỏ lịch</button>`}
    </div>
  </div>`;
}

export function Toasts() {
  return html`<div class="toasts" aria-live="polite">${S.toasts.map((t) => html`<div class=${"toast " + t.kind}><span class="dot"></span>${t.msg}</div>`)}</div>`;
}

export function Spinner({ size = 28 }) { return html`<div class="spinner" style=${`width:${size}px;height:${size}px`}></div>`; }

export { WD, p2 };
