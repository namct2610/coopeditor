// Nhắc chữ (teleprompter): only the script's words, large and light on black,
// moving up past a reading line at a set pace — or scrolled by hand.
//
// It adapts to the screen: the size slider's range and the starting size come
// from the width of the text column (≈ 34 letters a line on a computer, ≈ 20
// on a phone), and the pace is in words per minute, so a bigger font, a
// narrower phone or a rotation doesn't change how fast it reads. Whatever is
// on the reading line stays there when the size or the window changes.

import { html, useState, useEffect, useLayoutEffect, useRef, useMemo } from "../lib.mjs";
import { S, go } from "../store.mjs";
import { clamp, p2 } from "../format.mjs";
import { Menu, MenuItem } from "../ui.mjs";

// ---- the words: blocks of escaped text; only bold / italic / underline /
// strike survive, so the prompter's own size and colours always apply.
const esc = (t) => t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const KEEP = { STRONG: "b", B: "b", EM: "i", I: "i", U: "u", S: "s", STRIKE: "s", DEL: "s" };
function inline(node) {
  let out = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += esc(n.nodeValue); return; }
    if (n.nodeType !== 1 || /^(IMG|LABEL|INPUT|UL|OL|BUTTON)$/.test(n.tagName)) return;
    if (n.tagName === "BR") { out += "<br>"; return; }
    if (/^(P|DIV|TD|TH)$/.test(n.tagName) && out && !/\s$/.test(out)) out += " ";
    const t = KEEP[n.tagName];
    out += t ? "<" + t + ">" + inline(n) + "</" + t + ">" : inline(n);
  });
  return out;
}
const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function prompterBlocks(body) {
  const doc = new DOMParser().parseFromString(String(body || ""), "text/html");
  const out = [];
  let scene = 0;
  const push = (kind, el, extra) => {
    const h = inline(el).trim();
    const text = plain(h).trim();
    if (text) out.push({ kind, html: h, text, ...extra });
  };
  const list = (el, level) => {
    const ordered = el.tagName === "OL";
    const start = parseInt(el.getAttribute("start"), 10) || 1;
    [...el.children].filter((li) => li.tagName === "LI").forEach((li, i) => {
      const task = li.getAttribute("data-type") === "taskItem";
      const mark = task ? (li.getAttribute("data-checked") === "true" ? "☑" : "☐") : ordered ? start + i + "." : "•";
      push("li", li, { mark, level });
      li.querySelectorAll(":scope > ul, :scope > ol, :scope > div > ul, :scope > div > ol").forEach((n) => list(n, level + 1));
    });
  };
  const walk = (el, vo) => {
    [...el.children].forEach((c) => {
      switch (c.tagName) {
        case "H2": scene += 1; push("scene", c, { label: "CẢNH " + p2(scene) }); break;
        case "H1": case "H3": push("head", c); break;
        case "BLOCKQUOTE": walk(c, true); break;
        case "PRE": push("note", c); break;
        case "UL": case "OL": list(c, 0); break;
        case "TABLE": c.querySelectorAll("tr").forEach((tr) => push("row", tr)); break;
        case "HR": out.push({ kind: "hr", text: "" }); break;
        case "DIV": case "SECTION": walk(c, vo); break;
        case "IMG": break;
        default: push(vo ? "vo" : "p", c);
      }
    });
  };
  walk(doc.body, false);
  return out;
}
const countWords = (t) => (t.match(/\S+/g) || []).length;

// ---- sizes from the screen
let EM = 0; // average letter width, in font sizes, of the app font
function letterWidth() {
  if (EM) return EM;
  try {
    const c = document.createElement("canvas").getContext("2d");
    c.font = "500 100px " + getComputedStyle(document.body).fontFamily;
    const sample = "Xin chào anh em, hôm nay mình sẽ chia sẻ những phương án tiết kiệm nhất";
    EM = c.measureText(sample).width / sample.length / 100;
  } catch (_) {}
  if (!(EM > 0.3 && EM < 0.8)) EM = 0.52;
  return EM;
}
function geometry(w, h) {
  const em = letterWidth();
  const pad = Math.round(clamp(w * 0.06, 16, 72));
  const col = Math.max(200, Math.min(w - 2 * pad, 1400));
  const min = Math.round(clamp(col / (em * 70), 14, 48));
  const max = Math.round(clamp(Math.min(col / (em * 8), h / 4.2), min + 12, 220));
  const def = Math.round(clamp(col / (em * (col >= 640 ? 34 : 20)), min, max));
  return { pad, col, min, max, def, eye: Math.round(h * 0.3), cpl: (fs) => Math.max(1, Math.round(col / (fs * em))) };
}
const LINE = 1.35;
const WPM = [60, 300];

const PREFS = "coop.prompter";
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREFS)) || {}; } catch (_) { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch (_) {} };
const fmtTime = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + p2(s % 60); };
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

export function Prompter() {
  const s = S.script && S.script.id === S.route.sid ? S.script : null;
  const blocks = useMemo(() => (s ? prompterBlocks(s.body) : []), [s && s.id, s && s.body]);
  const words = useMemo(() => blocks.reduce((n, b) => n + countWords(b.text), 0), [blocks]);
  const scenes = blocks.map((b, i) => [b, i]).filter(([b]) => b.kind === "scene" || b.kind === "head");

  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const g = geometry(vp.w, vp.h);
  const prefs = useMemo(loadPrefs, []);
  const [fsRaw, setFs] = useState(prefs.fs || 0); // 0 = the screen's own size
  const fs = clamp(fsRaw || g.def, g.min, g.max);
  const [wpm, setWpm] = useState(clamp(prefs.wpm || 150, WPM[0], WPM[1]));
  const [mirror, setMirror] = useState(!!prefs.mirror);
  const [playing, setPlaying] = useState(false);
  const [count, setCount] = useState(0);
  const [idle, setIdle] = useState(false);
  const [sceneMenu, setSceneMenu] = useState(false);
  const [full, setFull] = useState(!!fsElement());
  const [textH, setTextH] = useState(0);

  const root = useRef(null), scroller = useRef(null), text = useRef(null), bar = useRef(null), clock = useRef(null), sceneBtn = useRef(null);
  // live values for the scroll loop and listeners
  const live = useRef({ pos: 0, userAt: 0, v: 0, anchor: null, restoring: false, running: false }).current;
  const pxPerWord = textH / Math.max(1, words);
  live.v = (wpm / 60) * pxPerWord;

  useEffect(() => savePrefs({ fs: fsRaw, wpm, mirror }), [fsRaw, wpm, mirror]);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    const onFull = () => setFull(!!fsElement());
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onFull);
    document.addEventListener("webkitfullscreenchange", onFull);
    if (root.current) root.current.focus({ preventScroll: true });
    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onFull);
      document.removeEventListener("webkitfullscreenchange", onFull);
    };
  }, []);

  // Keep the screen on while prompting (needs https; elsewhere the phone's
  // own auto-lock applies).
  useEffect(() => {
    let lock = null, gone = false;
    const take = async () => {
      try {
        if (!gone && navigator.wakeLock && document.visibilityState === "visible") {
          lock = await navigator.wakeLock.request("screen");
          if (gone) lock.release().catch(() => {});
        }
      } catch (_) {}
    };
    take();
    const vis = () => { if (document.visibilityState === "visible") take(); };
    document.addEventListener("visibilitychange", vis);
    return () => { gone = true; document.removeEventListener("visibilitychange", vis); if (lock) lock.release().catch(() => {}); };
  }, []);

  // Height of the text → pixels per word → pace; follows every reflow.
  useEffect(() => {
    const el = text.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setTextH(el.offsetHeight));
    ro.observe(el);
    setTextH(el.offsetHeight);
    return () => ro.disconnect();
  }, [blocks.length > 0]);

  // What sits on the reading line, as (block, fraction of it).
  const anchorNow = () => {
    const el = scroller.current, t = text.current;
    if (!el || !t || !t.children.length) return null;
    const y = el.scrollTop, kids = t.children;
    let lo = 0, hi = kids.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (kids[mid].offsetTop <= y) lo = mid; else hi = mid - 1; }
    const k = kids[lo];
    return { i: lo, f: k.offsetHeight ? clamp((y - k.offsetTop) / k.offsetHeight, 0, 1) : 0 };
  };
  // After the size or the window changes, put the same words back on the line.
  useLayoutEffect(() => {
    const el = scroller.current, t = text.current, a = live.anchor;
    if (!el || !t || !a || !t.children[a.i]) return;
    const k = t.children[a.i];
    live.restoring = true;
    el.scrollTop = k.offsetTop + a.f * k.offsetHeight;
    live.pos = el.scrollTop;
    requestAnimationFrame(() => { live.restoring = false; });
  }, [fs, vp.w, vp.h]);

  // Progress line + time left: written straight to the DOM, not re-rendered.
  const paint = () => {
    const el = scroller.current;
    if (!el) return;
    const max = Math.max(1, el.scrollHeight - el.clientHeight);
    const p = clamp(el.scrollTop / max, 0, 1);
    if (bar.current) bar.current.style.transform = "scaleX(" + p + ")";
    if (clock.current) clock.current.textContent = Math.round(p * 100) + "% · còn " + fmtTime(live.v > 0 ? (max - el.scrollTop) / live.v : 0);
  };
  useEffect(paint);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return; // a late scroll event after leaving
    if (!live.restoring) live.anchor = anchorNow();
    if (Math.abs(el.scrollTop - live.pos) > 2) live.userAt = performance.now();
    paint();
  };

  // Moving text. A hand on the wheel or the screen holds it while it moves,
  // then it carries on from there.
  useEffect(() => {
    if (!playing) return undefined;
    const el = scroller.current;
    let last = performance.now(), raf = 0;
    live.pos = el.scrollTop;
    live.running = true;
    const step = (now) => {
      if (!live.running) return; // stopped by a tap: not one more frame
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (Math.abs(el.scrollTop - live.pos) > 2 || now - live.userAt < 350) live.pos = el.scrollTop;
      else { live.pos += live.v * dt; el.scrollTop = live.pos; }
      if (live.pos >= el.scrollHeight - el.clientHeight - 1) { setPlaying(false); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => { live.running = false; cancelAnimationFrame(raf); };
  }, [playing]);
  const hold = () => { live.userAt = performance.now(); };

  // 3-2-1 before it starts from the top.
  useEffect(() => {
    if (!count) return undefined;
    const t = setTimeout(() => { if (count === 1) { setCount(0); setPlaying(true); } else setCount(count - 1); }, 800);
    return () => clearTimeout(t);
  }, [count]);
  const toggle = () => {
    if (count) { setCount(0); return; }
    if (playing) { live.running = false; setPlaying(false); return; }
    const el = scroller.current;
    if (el && el.scrollTop >= el.scrollHeight - el.clientHeight - 1) el.scrollTop = 0;
    if (el && el.scrollTop < 2) setCount(3); else setPlaying(true);
  };

  // While it runs the controls fade out; a move or a touch brings them back.
  useEffect(() => {
    if (!playing) { setIdle(false); return undefined; }
    let t = setTimeout(() => setIdle(true), 2500);
    const wake = () => { setIdle(false); clearTimeout(t); t = setTimeout(() => setIdle(true), 2500); };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    return () => { clearTimeout(t); window.removeEventListener("pointermove", wake); window.removeEventListener("pointerdown", wake); };
  }, [playing]);

  const toggleFull = () => {
    const el = root.current;
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  };
  const canFull = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const exit = () => {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    go({ name: "script", sid: S.route.sid });
  };
  const jump = (i) => {
    const k = text.current && text.current.children[i];
    if (k) { hold(); scroller.current.scrollTo({ top: k.offsetTop, behavior: "smooth" }); }
  };
  const sizeBy = (d) => setFs(clamp(fs + d, g.min, g.max));

  useEffect(() => {
    const onKey = (e) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.key !== "Escape" && e.key !== " ") return;
      const el = scroller.current;
      if (!el) return;
      const k = e.key;
      let done = true;
      if (k === " " || k === "k" || k === "K") toggle();
      else if (k === "ArrowUp") setWpm((v) => clamp(v + 10, WPM[0], WPM[1]));
      else if (k === "ArrowDown") setWpm((v) => clamp(v - 10, WPM[0], WPM[1]));
      else if (k === "+" || k === "=") sizeBy(4);
      else if (k === "-" || k === "_") sizeBy(-4);
      else if (k === "PageDown" || k === "PageUp") { hold(); el.scrollBy({ top: (k === "PageDown" ? 1 : -1) * el.clientHeight * 0.5, behavior: "smooth" }); }
      else if (k === "Home") { hold(); el.scrollTo({ top: 0, behavior: "smooth" }); }
      else if (k === "End") { hold(); el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }
      else if (k === "m" || k === "M") setMirror((m) => !m);
      else if ((k === "f" || k === "F") && canFull) toggleFull();
      else if (k === "Escape" && !fsElement()) exit();
      else done = false;
      if (done) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A tap on the words starts / stops; a drag scrolls.
  const tap = useRef(null);
  const onDown = (e) => { tap.current = { x: e.clientX, y: e.clientY, t: Date.now() }; };
  const onUp = (e) => {
    const t = tap.current;
    tap.current = null;
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 10 && Date.now() - t.t < 400) toggle();
  };

  const loading = !s;
  const style = `--pr-fs:${fs}px;--pr-lh:${LINE};--pr-pad:${g.pad}px;--pr-col:${g.col}px;--pr-eye:${g.eye}px`;
  return html`<div class=${"prompter" + (idle ? " idle" : "") + (mirror ? " mirror" : "")} ref=${root} tabindex="-1" style=${style} data-screen-label="Nhắc chữ">
    <div class="pr-progress"><i ref=${bar}></i></div>
    <span class="pr-clock" ref=${clock} aria-label="Tiến độ và thời gian còn lại"></span>
    <div class="pr-scroll" ref=${scroller} onScroll=${onScroll} onWheel=${hold} onTouchStart=${hold} onTouchMove=${hold}
      onPointerDown=${onDown} onPointerUp=${onUp} onPointerCancel=${() => { tap.current = null; }}>
      ${loading ? html`<div class="pr-empty">Đang mở kịch bản…</div>`
        : blocks.length === 0 ? html`<div class="pr-empty">Kịch bản chưa có chữ nào để nhắc.</div>`
        : html`<div class="pr-text" ref=${text}>${blocks.map((b) => (b.kind === "hr" ? html`<div class="pr-b pr-hr"></div>`
          : html`<div class=${"pr-b pr-" + b.kind} style=${b.level ? "padding-left:" + b.level * 1.2 + "em" : ""}>
              ${b.label && html`<span class="pr-label">${b.label}</span>`}${b.mark && html`<span class="pr-mark">${b.mark}</span>`}<span dangerouslySetInnerHTML=${{ __html: b.html }}></span>
            </div>`))}</div>`}
    </div>
    <div class="pr-eye" aria-hidden="true"><i></i><i></i></div>
    ${count > 0 && html`<div class="pr-count" aria-live="assertive">${count}</div>`}
    <div class="pr-bar" onPointerDown=${(e) => e.stopPropagation()}>
      <div class="pr-row">
        <button type="button" class="pr-btn" onClick=${exit} title="Thoát (Esc)">← Thoát</button>
        <button type="button" class=${"pr-btn pr-play" + (playing || count ? " on" : "")} onClick=${toggle} title="Chạy / dừng (phím cách, hoặc chạm vào chữ)" disabled=${!blocks.length}>
          ${playing || count ? html`<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg> Dừng`
            : html`<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20"/></svg> Chạy chữ`}
        </button>
        ${scenes.length > 0 && html`<button type="button" ref=${sceneBtn} class="pr-btn" onClick=${() => setSceneMenu(!sceneMenu)} title="Tới một cảnh">Cảnh ▾</button>
          <${Menu} open=${sceneMenu} onClose=${() => setSceneMenu(false)} anchorRef=${sceneBtn} side="top" width=${300} maxHeight=${360}>
            ${scenes.map(([b, i]) => html`<${MenuItem} onClick=${() => { setSceneMenu(false); jump(i); }}><span class="ell">${b.label ? b.label + " · " : ""}${b.text}</span></${MenuItem}>`)}
          </${Menu}>`}
        <button type="button" class=${"pr-btn" + (mirror ? " on" : "")} onClick=${() => setMirror(!mirror)} title="Lật gương — cho kính nhắc chữ (M)" aria-label="Lật gương" aria-pressed=${mirror}>⇋<span class="pr-t"> Gương</span></button>
        ${canFull && html`<button type="button" class=${"pr-btn" + (full ? " on" : "")} onClick=${toggleFull} title="Toàn màn hình (F)" aria-label="Toàn màn hình" aria-pressed=${full}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${full ? "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"} /></svg><span class="pr-t">${full ? " Thu nhỏ" : " Toàn màn hình"}</span>
        </button>`}
      </div>
      <div class="pr-row">
        <label class="pr-slider" title="Cỡ chữ (phím + / −)">
          <span class="pr-k">Cỡ chữ</span>
          <span class="pr-a sm">A</span>
          <input type="range" min=${g.min} max=${g.max} step="1" value=${fs} aria-label="Cỡ chữ" onInput=${(e) => setFs(+e.target.value)} />
          <span class="pr-a lg">A</span>
          <span class="pr-v">${fs}px<span class="pr-cpl"> · ~${g.cpl(fs)} ký tự/dòng</span></span>
        </label>
        <label class="pr-slider" title="Tốc độ chạy (phím ↑ / ↓)">
          <span class="pr-k">Tốc độ</span>
          <input type="range" min=${WPM[0]} max=${WPM[1]} step="5" value=${wpm} aria-label="Tốc độ, từ mỗi phút" onInput=${(e) => setWpm(+e.target.value)} />
          <span class="pr-v">${wpm} từ/phút</span>
        </label>
      </div>
    </div>
  </div>`;
}
