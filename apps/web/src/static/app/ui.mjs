// Small shared components.

import { html, render, useState, useRef, useLayoutEffect } from "./lib.mjs";
import { ST, SST, tint, shortName, avatarBg, thumbBg, isoDay, today, dayFromIso, clamp, WD, p2 } from "./format.mjs";
import { mediaUrl } from "./api.mjs";
import { S, toast } from "./store.mjs";

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

// ---- popovers: menus, right-click menus, date picker ----
// Each open popover renders into its own host on <body> with position:fixed,
// placed against its trigger (or the pointer, for a right-click) and kept
// inside the window. Nothing in the page — a thumbnail's overflow:hidden, a
// scrolling toolbar, the video stage, the next card — can clip or cover it.
const pops = [];   // open popovers, last one on top
const PAD = 8, GAP = 6;
export const popoverOpen = () => pops.length > 0;

function placePop(el, o) {
  if (!el) return true;
  let a;
  if (o.at) a = { left: o.at.x, right: o.at.x, top: o.at.y, bottom: o.at.y };
  else {
    const n = o.anchorRef && o.anchorRef.current;
    if (!n || !n.isConnected) return false;
    a = n.getBoundingClientRect();
    if (a.bottom < 0 || a.top > window.innerHeight || (!a.width && !a.height)) return false;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const gap = o.at ? 2 : GAP;
  el.style.maxHeight = "";
  el.style.left = "0px"; el.style.top = "0px";
  const w = el.offsetWidth;
  let h = el.offsetHeight;
  const below = vh - PAD - a.bottom - gap, above = a.top - PAD - gap;
  let up, top;
  if (o.at) {
    // Pointer menu: below the pointer, else above it, else slid up until it
    // fits — like the system menu. Only a menu taller than the window scrolls.
    if (h > vh - 2 * PAD) { el.style.maxHeight = vh - 2 * PAD + "px"; h = vh - 2 * PAD; }
    up = h > below && h <= above;
    top = up ? a.top - gap - h : a.bottom + gap;
  } else {
    // Dropdown: the preferred side; flip when it doesn't fit and the other
    // side has more room, and scroll inside when neither side is tall enough.
    up = o.side === "top" ? !(h > above && below > above) : h > below && above > below;
    const room = Math.max(up ? above : below, Math.min(160, vh - 2 * PAD));
    if (h > room) { el.style.maxHeight = room + "px"; h = room; }
    top = up ? a.top - gap - h : a.bottom + gap;
  }
  const left = o.at ? (o.at.x + w > vw - PAD ? o.at.x - w : o.at.x) : o.align === "end" ? a.right - w : a.left;
  el.style.left = Math.round(clamp(left, PAD, Math.max(PAD, vw - PAD - w))) + "px";
  el.style.top = Math.round(clamp(top, PAD, Math.max(PAD, vh - PAD - h))) + "px";
  el.dataset.side = up ? "top" : "bottom";
  return true;
}

// The click that dismisses a right-click menu shouldn't also act on what was
// right-clicked (start the video, open the card, draw a stroke) — same as a
// native menu.
function swallowNextClick() {
  const done = () => { window.removeEventListener("click", kill, true); clearTimeout(t); };
  const kill = (e) => { e.stopPropagation(); e.preventDefault(); done(); };
  window.addEventListener("click", kill, true);
  const t = setTimeout(done, 600);
}

// Capture-phase listeners, registered when this module loads: they run before
// the review / sketch-editor shortcuts and before handlers that stop propagation.
document.addEventListener("pointerdown", (e) => {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i];
    if (p.box.contains(e.target)) return;
    const anchor = p.anchor();
    if (anchor && anchor.contains(e.target)) continue; // the trigger toggles it itself
    p.close();
    if (p.opts().at && e.button === 0 && p.owner && p.owner.contains(e.target)) {
      e.stopPropagation();
      swallowNextClick();
    }
  }
}, true);
window.addEventListener("keydown", (e) => {
  const p = pops[pops.length - 1];
  if (!p) return;
  const el = p.box.firstElementChild;
  const inside = el && el.contains(document.activeElement);
  const items = el ? [...el.querySelectorAll(".menu-item:not([disabled])")] : [];
  const k = e.key;
  if (k === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    p.close(true);
  } else if ((k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End") && items.length) {
    e.preventDefault(); e.stopImmediatePropagation();
    const i = items.indexOf(document.activeElement);
    const n = k === "Home" ? 0 : k === "End" ? items.length - 1 : k === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1;
    items[n].focus();
  } else if (k === "Tab") {
    pops.slice().forEach((x) => x.close());
  } else if (inside) {
    // Enter / Space still activate the focused item (default action), but
    // the screen's shortcuts (space = play, letters = sketch tools) stay quiet.
    e.stopImmediatePropagation();
  } else {
    pops.slice().forEach((x) => x.close());
  }
}, true);
// A pointer menu closes when the page scrolls under it, but not on the tail
// of a scroll that was already running when it opened (trackpad inertia).
document.addEventListener("scroll", (e) => {
  pops.slice().forEach((p) => {
    if (p.box.contains(e.target)) return;
    if (p.opts().at ? Date.now() - p.openedAt > 250 : !placePop(p.box.firstElementChild, p.opts())) p.close();
  });
}, true);
window.addEventListener("resize", () => {
  pops.slice().forEach((p) => { if (p.opts().at || !placePop(p.box.firstElementChild, p.opts())) p.close(); });
});
window.addEventListener("blur", () => pops.slice().forEach((p) => { if (p.opts().at) p.close(); }));

// Low-level popover: `anchorRef` (trigger element) or `at` ({x,y} pointer
// position), `align` start|end against the trigger, preferred `side`.
// `keepFocus` leaves focus where it was (the script editor keeps its selection).
export function Popover({ open, onClose, anchorRef, at, owner, align = "start", side = "bottom", cls = "menu", role = "menu", label, style = "", keepFocus, children }) {
  const hostRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const optsRef = useRef(null);
  optsRef.current = { anchorRef, at, align, side };
  const entryRef = useRef(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const box = document.createElement("div");
    box.className = "pop-host";
    document.body.appendChild(box);
    const prevFocus = document.activeElement;
    const entry = {
      box, owner: owner && owner.current !== undefined ? owner.current : owner || null,
      opts: () => optsRef.current,
      openedAt: Date.now(),
      anchor: () => (optsRef.current.anchorRef && optsRef.current.anchorRef.current) || null,
      focused: false,
      // keyboard close returns focus to where it came from
      close: (restore) => {
        if (restore) {
          const editable = prevFocus && (prevFocus.isContentEditable || /^(INPUT|TEXTAREA)$/.test(prevFocus.tagName));
          const back = (editable && prevFocus) || entry.anchor() || prevFocus;
          if (back && back.isConnected && back.focus) back.focus({ preventScroll: true });
        }
        if (closeRef.current) closeRef.current();
      },
    };
    pops.push(entry);
    hostRef.current = box;
    entryRef.current = entry;
    return () => {
      const i = pops.indexOf(entry);
      if (i >= 0) pops.splice(i, 1);
      render(null, box);
      box.remove();
      hostRef.current = null;
      entryRef.current = null;
    };
  }, [open]);
  useLayoutEffect(() => {
    const box = hostRef.current, entry = entryRef.current;
    if (!open || !box || !entry) return;
    render(html`<div class=${cls} role=${role} aria-label=${label} tabindex="-1" style=${style}
      onClick=${(e) => e.stopPropagation()} onContextMenu=${(e) => e.preventDefault()}>${children}</div>`, box);
    const el = box.firstElementChild;
    placePop(el, optsRef.current);
    if (!entry.focused) { entry.focused = true; if (!keepFocus) el.focus({ preventScroll: true }); }
  });
  return null;
}

export function Menu({ width, minWidth, maxHeight, ...rest }) {
  const style = (width ? `width:${width}px;` : "") + (minWidth ? `min-width:${minWidth}px;` : "") + (maxHeight ? `max-height:${maxHeight}px;` : "");
  return html`<${Popover} ...${rest} style=${style} />`;
}
export const MenuItem = ({ onClick, children, danger, check, hint, disabled }) => html`<button type="button" role="menuitem" class=${"menu-item" + (danger ? " danger" : "")} disabled=${disabled} style=${disabled ? "opacity:.45;cursor:default" : ""} onClick=${(e) => { e.stopPropagation(); if (!disabled) onClick(e); }}>${children}${check && html`<span class="chk">✓</span>`}${hint && html`<span class="hint">${hint}</span>`}</button>`;

// Item lists: { label, onClick, danger, hint, check, disabled } or "-" for a
// separator. Falsy entries are dropped, and so are separators left dangling.
export function cleanItems(items) {
  const out = [];
  (items || []).filter(Boolean).forEach((it) => { if (it !== "-" || (out.length && out[out.length - 1] !== "-")) out.push(it); });
  while (out[out.length - 1] === "-") out.pop();
  return out;
}
export function menuItems(list, close) {
  return list.map((it) => (it === "-" ? html`<div class="menu-sep"></div>`
    : html`<${MenuItem} danger=${it.danger} hint=${it.hint} check=${it.check} disabled=${it.disabled} onClick=${() => { close(); it.onClick(); }}>${it.label}</${MenuItem}>`));
}

// "⋯" button + menu, used on cards and rows.
export function MoreMenu({ items, cls = "more-btn", style = "", align = "end", side = "bottom", width }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const list = cleanItems(items);
  if (!list.length) return null;
  return html`<div style=${"position:absolute;" + style} onClick=${(e) => e.stopPropagation()}>
    <button type="button" ref=${btn} class=${cls + (open ? " open" : "")} style="position:static" aria-label="Thao tác khác" aria-haspopup="menu" aria-expanded=${open} onClick=${() => setOpen(!open)}><${IcMore} /></button>
    <${Menu} open=${open} onClose=${() => setOpen(false)} anchorRef=${btn} align=${align} side=${side} width=${width}>${menuItems(list, () => setOpen(false))}</${Menu}>
  </div>`;
}

// Right-click menu: spread `cm.open` on the element (onContextMenu), render
// <ContextMenu cm=${cm} items=… /> anywhere in the same component.
export function useContextMenu() {
  const [at, setAt] = useState(null);
  const owner = useRef(null);
  return {
    at, owner,
    close: () => setAt(null),
    open: (e) => {
      // Text fields keep the browser's menu (copy, paste, spelling).
      const t = e.target;
      if (t && t.closest && t.closest("input,textarea,select,[contenteditable=true]")) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget;
      owner.current = el;
      let x = e.clientX, y = e.clientY;
      if (!x && !y && el && el.getBoundingClientRect) {
        // keyboard (Shift+F10 / menu key): open at the element's corner
        const r = el.getBoundingClientRect();
        x = r.left + Math.min(24, r.width / 2); y = r.top + Math.min(24, r.height / 2);
      }
      setAt({ x, y });
    },
  };
}
export function ContextMenu({ cm, items, title, width = 250 }) {
  const list = cleanItems(items);
  return html`<${Menu} open=${!!cm.at && list.length > 0} at=${cm.at} owner=${cm.owner} onClose=${cm.close} width=${width} label=${title}>
    ${title && html`<div class="menu-title ell">${title}</div>`}
    ${menuItems(list, cm.close)}
  </${Menu}>`;
}

// Clipboard: the NAS is often opened over plain http on the LAN, where
// navigator.clipboard doesn't exist — fall back to a hidden textarea, then to
// a prompt the user can copy from.
export async function copyText(text, okMsg = "Đã copy") {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); toast(okMsg); return; }
  } catch (_) { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (_) {}
  ta.remove();
  if (ok) toast(okMsg); else window.prompt("Copy:", text);
}

// ---- date picker ----
export function DatePicker({ value, onPick, onClose, anchorRef, align = "start", side = "bottom" }) {
  const init = value ? dayFromIso(value) : today();
  const [ym, setYm] = useState([init.getFullYear(), init.getMonth()]);
  const [y, m] = ym;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - ((first.getDay() + 6) % 7));
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const t = isoDay(today());
  return html`<${Popover} open=${true} onClose=${onClose} anchorRef=${anchorRef} align=${align} side=${side} cls="date-pop" role="dialog" label="Chọn ngày">
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
  </${Popover}>`;
}

export function Toasts() {
  return html`<div class="toasts" aria-live="polite">${S.toasts.map((t) => html`<div class=${"toast " + t.kind}><span class="dot"></span>${t.msg}</div>`)}</div>`;
}

export function Spinner({ size = 28 }) { return html`<div class="spinner" style=${`width:${size}px;height:${size}px`}></div>`; }

export { WD, p2 };
