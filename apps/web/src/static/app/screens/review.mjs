// Review video: smaller stage on the left, fixed notes panel on the right.
// Threads with replies, filter by open/done and by author, avatars on the
// filmstrip at each note's timecode, drawing on the frame, safe area, frame
// stepping, speed and proxy quality.

import { html, useState, useEffect, useRef, useMemo, useCallback, useReducer } from "../lib.mjs";
import {
  S, set, go, projectById, assetById, canManage, guard, toast, errMsg, userById,
  setReviewStatus, loadVersion, loadRenditions, loadComments, requestRendition, renditionBusy, postComment, resolveComment, editComment, deleteComment,
} from "../store.mjs";
import { ST, ORDER, fmtTc, fmtShort, fmtAgo, paletteOf, flatBg, resLabel, clamp, isAudio } from "../format.mjs";
import { Avatar, Seg, Menu, MenuItem, IcPlay, IcPause, Spinner, personOf } from "../ui.mjs";
import { mediaUrl, enc } from "../api.mjs";
import { openOverlay } from "../overlays.mjs";

// ---------------------------------------------------------------------------
// Playback clock: time-driven bits subscribe to this instead of re-rendering
// the whole screen 60×/s.
function makeClock() {
  const subs = new Set();
  const c = { ms: 0, dur: 0, playing: false, waiting: false, buffered: 0 };
  let raf = 0;
  const emit = () => subs.forEach((f) => f());
  c.set = (p) => { Object.assign(c, p); emit(); };
  c.sub = (f) => { subs.add(f); return () => subs.delete(f); };
  c.loop = (video) => {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!video || video.paused) return;
      c.ms = (video.currentTime || 0) * 1000;
      emit();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  };
  c.stop = () => cancelAnimationFrame(raf);
  return c;
}
function useClock(clock) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => clock.sub(force), [clock]);
  return clock;
}

// hls.js for Chrome/Firefox/Edge; Safari plays .m3u8 natively.
function useSource(videoRef, url, onReady, onFail) {
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !url) return undefined;
    let hls = null;
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && !v.canPlayType("application/vnd.apple.mpegurl") && window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ xhrSetup: (xhr) => { xhr.withCredentials = true; }, enableWorker: true, maxBufferLength: 40, backBufferLength: 30 });
      hls.loadSource(url);
      hls.attachMedia(v);
      // Recover a couple of times (stalled segment, decoder hiccup), then give
      // up loudly instead of refetching the same segment forever.
      let recoveries = 0, failed = false;
      hls.on(window.Hls.Events.ERROR, (_e, d) => {
        if (!d || !d.fatal) return;
        console.warn("[hls]", d.type, d.details);
        if (recoveries++ < 3 && (d.type === "networkError" || d.type === "mediaError")) {
          if (d.type === "networkError") hls.startLoad(); else hls.recoverMediaError();
        } else if (!failed) {
          // Never destroy hls.js from inside its own event: switch source on
          // the next tick and let the effect cleanup tear it down.
          failed = true;
          setTimeout(() => onFail && onFail(d.details), 0);
        }
      });
    } else {
      v.src = url;
    }
    onReady && onReady();
    return () => {
      if (hls) hls.destroy();
      else { v.removeAttribute("src"); v.load(); }
    };
  }, [url]);
}

// ---------------------------------------------------------------------------
// annotations — normalised 0..1 coordinates, same payload the API validates.
const DRAW_TOOLS = [["pen", "Bút"], ["arrow", "Mũi tên"], ["rect", "Khung"], ["text", "Chữ"]];
const DRAW_COLORS = ["#f0644f", "#e9b949", "#ffffff"];
const STROKE_W = 3;

function Stroke({ s }) {
  const c = s.color || DRAW_COLORS[0];
  const sw = clamp(Number(s.width) || STROKE_W, 1, 24);
  const pts = s.points || [];
  if (!pts.length) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const common = { fill: "none", stroke: c, "stroke-width": sw, "vector-effect": "non-scaling-stroke", "stroke-linecap": "round", "stroke-linejoin": "round" };
  if (s.tool === "rect") return html`<rect x=${Math.min(a[0], b[0])} y=${Math.min(a[1], b[1])} width=${Math.abs(b[0] - a[0])} height=${Math.abs(b[1] - a[1])} ...${common} />`;
  if (s.tool === "ellipse") return html`<ellipse cx=${(a[0] + b[0]) / 2} cy=${(a[1] + b[1]) / 2} rx=${Math.abs(b[0] - a[0]) / 2} ry=${Math.abs(b[1] - a[1]) / 2} ...${common} />`;
  if (s.tool === "arrow") {
    // Arrow head drawn as two short lines in screen-independent units: the
    // svg is stretched (preserveAspectRatio=none), so derive the angle from
    // the 16:9 aspect to keep the head symmetric.
    const dx = (b[0] - a[0]) * 16, dy = (b[1] - a[1]) * 9;
    const ang = Math.atan2(dy, dx), len = 0.35;
    const hx = (t) => b[0] - (Math.cos(ang + t) * len) / 16, hy = (t) => b[1] - (Math.sin(ang + t) * len) / 9;
    return html`<g><line x1=${a[0]} y1=${a[1]} x2=${b[0]} y2=${b[1]} ...${common} />
      <polyline points=${`${hx(0.5)},${hy(0.5)} ${b[0]},${b[1]} ${hx(-0.5)},${hy(-0.5)}`} ...${common} /></g>`;
  }
  const line = pts.map((p) => p[0] + "," + p[1]).join(" ");
  if (s.tool === "highlight") return html`<polyline points=${line} ...${common} stroke-opacity="0.34" stroke-width=${sw * 6} />`;
  return html`<polyline points=${line} ...${common} />`;
}

function hasAnn(a) { return !!(a && ((a.strokes && a.strokes.length) || (a.texts && a.texts.length))); }

// ---------------------------------------------------------------------------
function authorOf(c) {
  if (c.guestLabel) return { name: c.guestLabel, key: "guest:" + c.guestLabel };
  const u = userById(c.authorUserId);
  return { name: u ? u.name : "Thành viên", key: c.authorUserId || c.id, user: u };
}

const FILM_N = 18;
const QUALITIES = [["source", "Gốc"], ["720", "720p"], ["1080", "1080p"]];
const SPEEDS = [1, 1.5, 2, 0.5];

export function Review() {
  const { pid, aid } = S.route;
  const project = projectById(pid);
  const asset = assetById(aid);
  const versions = S.versions[aid] || [];
  const [vid, setVid] = useState(null);
  const version = versions.find((v) => v.id === vid) || versions[versions.length - 1] || null;
  const versionId = version && version.id;
  const comments = (versionId && S.comments[versionId]) || null;
  const renditions = (versionId && S.renditions[versionId]) || [];
  const fps = (asset && asset.frameRate) || 24;
  const manage = canManage(pid);

  const clock = useMemo(makeClock, []);
  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const textRef = useRef(null);

  // ---- ui state ----
  const [quality, setQuality] = useState(null);      // null = auto
  const [speed, setSpeed] = useState(1);
  const [safe, setSafe] = useState(false);
  const [statusMenu, setStatusMenu] = useState(false);
  const [noteFilter, setNoteFilter] = useState("open");
  const [peopleOff, setPeopleOff] = useState({});
  const [activeId, setActiveId] = useState(S.route.c || null);
  const [expanded, setExpanded] = useState({});
  const [replyTo, setReplyTo] = useState(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState(null);       // { id, text }
  const [drawing, setDrawing] = useState(false);
  const [tool, setTool] = useState("pen");
  const [color, setColor] = useState(0);
  const [ann, setAnn] = useState({ strokes: [], texts: [] });
  const [live, setLive] = useState(null);
  const [playErr, setPlayErr] = useState(false);
  const liveRef = useRef(null);
  const [textAt, setTextAt] = useState(null);        // {x,y,value}
  const statusBtn = useRef(null);

  useEffect(() => {
    setVid(null); setActiveId(S.route.c || null); setReplyTo(null); setDraft("");
    setAnn({ strokes: [], texts: [] }); setDrawing(false); setQuality(null); setPlayErr(false);
  }, [aid]);
  useEffect(() => { if (vid) loadVersion(vid); }, [vid]);

  // ---- playback source ----
  const rByH = (h) => renditions.find((r) => r.height === h);
  const ready = (h) => { const r = rByH(h); return !!(r && r.status === "ready" && r.hlsMasterUrl); };
  const autoQ = ready(720) ? "720" : ready(1080) ? "1080" : "source";
  const effQ = quality && (quality === "source" || ready(Number(quality))) ? quality : autoQ;
  const url = !asset ? "" : effQ === "source" ? mediaUrl("/assets/" + enc(asset.id) + "/source") : mediaUrl(rByH(Number(effQ)).hlsMasterUrl);
  const resume = useRef({ ms: null, play: false });
  // Poll while a proxy is queued/encoding (SPK has no worker → browser push),
  // and refresh notes now and then in case the realtime socket is down.
  const busy = renditions.some(renditionBusy);
  useEffect(() => {
    if (!versionId || !busy) return undefined;
    const t = setInterval(() => loadRenditions(versionId), 2500);
    return () => clearInterval(t);
  }, [versionId, busy]);
  useEffect(() => {
    if (!versionId) return undefined;
    const t = setInterval(() => { if (document.visibilityState === "visible") loadComments(versionId); }, 30000);
    return () => clearInterval(t);
  }, [versionId]);
  useEffect(() => { setPlayErr(false); }, [url]);
  useSource(videoRef, url, () => clock.set({ waiting: true }), () => {
    clock.set({ waiting: false });
    toast("Không phát được proxy " + effQ + "p trên trình duyệt này — chuyển về bản gốc", "error", 6000);
    setQuality("source");
  });

  // initial seek from the link (?t=) or the comment (?c=)
  const initialSeek = useRef(null);
  useEffect(() => { initialSeek.current = S.route.t; }, [aid]);
  useEffect(() => {
    if (!comments || !S.route.c) return;
    const c = comments.find((x) => x.id === S.route.c);
    if (c) { setActiveId(c.id); seek(c.timestampMs); }
  }, [comments && comments.length > 0, aid]);

  // ---- video events → clock ----
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const upd = () => {
      let buffered = 0;
      try {
        const t = v.currentTime || 0;
        for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= t + 0.1 && v.buffered.end(i) >= t) buffered = v.buffered.end(i) * 1000;
      } catch (_) {}
      clock.set({ ms: (v.currentTime || 0) * 1000, dur: Number.isFinite(v.duration) && v.duration > 0 ? v.duration * 1000 : ((asset && asset.durationMs) || 0), playing: !v.paused, buffered });
    };
    const onMeta = () => {
      v.playbackRate = speed;
      // A ProRes/DNx .mov can "load" in Chrome on its audio track alone: no
      // error event, just no picture. No video dimensions = undecodable.
      if (effQ === "source" && !v.videoWidth && !isAudio(asset)) setPlayErr(true);
      const want = resume.current.ms != null ? resume.current.ms : initialSeek.current;
      if (want != null && Number.isFinite(want)) { try { v.currentTime = want / 1000; } catch (_) {} }
      initialSeek.current = null;
      if (resume.current.play) v.play().catch(() => {});
      resume.current = { ms: null, play: false };
      upd();
    };
    const onPlay = () => { upd(); clock.loop(v); };
    const onWait = () => clock.set({ waiting: true });
    const onGo = () => { clock.set({ waiting: false }); upd(); };
    const onErr = () => {
      clock.set({ waiting: false });
      if (effQ === "source") setPlayErr(true);
    };
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", upd);
    v.addEventListener("progress", upd);
    v.addEventListener("seeked", upd);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", upd);
    v.addEventListener("ended", upd);
    v.addEventListener("waiting", onWait);
    v.addEventListener("canplay", onGo);
    v.addEventListener("playing", onGo);
    v.addEventListener("error", onErr);
    return () => {
      clock.stop();
      ["loadedmetadata", "timeupdate", "progress", "seeked", "play", "pause", "ended", "waiting", "canplay", "playing", "error"].forEach((n) => {
        v.removeEventListener(n, n === "loadedmetadata" ? onMeta : n === "play" ? onPlay : n === "waiting" ? onWait : n === "canplay" || n === "playing" ? onGo : n === "error" ? onErr : upd);
      });
    };
  }, [url, asset && asset.id]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = speed; }, [speed]);

  const dur = () => clock.dur || (asset && asset.durationMs) || 0;
  const seek = useCallback((ms) => {
    const v = videoRef.current;
    const t = clamp(ms, 0, Math.max(0, dur() - 1));
    clock.set({ ms: t });
    if (v && v.readyState > 0) { try { v.currentTime = t / 1000; } catch (_) {} }
    else initialSeek.current = t;
  }, [clock, asset]);
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { setDrawing(false); v.play().catch((e) => { if (e && e.name !== "AbortError") toast("Không phát được video", "error"); }); }
    else v.pause();
  }, []);
  const pause = () => { const v = videoRef.current; if (v && !v.paused) v.pause(); };
  const step = (n) => { pause(); seek(clock.ms + (n * 1000) / fps); };

  const pickQuality = async (q) => {
    const v = videoRef.current;
    if (q !== "source") {
      const r = rByH(Number(q));
      if (!r || r.status !== "ready") {
        if (r && r.status === "processing") { toast("Proxy " + q + "p đang tạo · " + (r.progress || 0) + "%"); return; }
        if (!manage) { toast("Proxy " + q + "p chưa có — nhờ người quản lý dự án tạo", "error"); return; }
        return requestRendition(versionId, Number(q));
      }
    }
    resume.current = { ms: clock.ms, play: v ? !v.paused : false };
    setQuality(q);
  };
  const cycleQuality = () => {
    const order = QUALITIES.map((x) => x[0]);
    pickQuality(order[(order.indexOf(effQ) + 1) % order.length]);
  };

  // ---- keyboard ----
  useEffect(() => {
    const k = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
      if (S.overlay || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " " || e.key === "k" || e.key === "K") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.shiftKey ? seek(clock.ms - 1000) : step(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); e.shiftKey ? seek(clock.ms + 1000) : step(1); }
      else if (e.key === "Escape" && drawing) setDrawing(false);
      else if (e.key === "Enter" && !drawing) { const t = document.getElementById("noteComposer"); if (t) { e.preventDefault(); pause(); t.focus(); } }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [togglePlay, seek, drawing, fps]);

  // ---- comments model ----
  const roots = useMemo(() => (comments || []).filter((c) => !c.parentId), [comments]);
  const repliesOf = useMemo(() => {
    const m = {};
    (comments || []).forEach((c) => { if (c.parentId) (m[c.parentId] = m[c.parentId] || []).push(c); });
    Object.values(m).forEach((l) => l.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))));
    return m;
  }, [comments]);
  const authors = useMemo(() => {
    const seen = new Map();
    roots.forEach((c) => { const a = authorOf(c); if (!seen.has(a.key)) seen.set(a.key, a); });
    return [...seen.values()];
  }, [roots]);
  const openCount = roots.filter((c) => !c.resolved).length;
  const doneCount = roots.length - openCount;
  const visible = roots
    .filter((c) => !peopleOff[authorOf(c).key])
    .filter((c) => noteFilter === "all" || (noteFilter === "done" ? c.resolved : !c.resolved))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  const active = roots.find((c) => c.id === activeId) || null;
  const replyC = roots.find((c) => c.id === replyTo) || null;

  const jumpTo = (c) => { pause(); setActiveId(c.id); seek(c.timestampMs); };

  const send = async () => {
    const text = draft.trim();
    if (!text || !versionId || sending) return;
    setSending(true);
    try {
      if (replyC) {
        await postComment(versionId, { content: text, timestampMs: Math.round(replyC.timestampMs), parentId: replyC.id });
        setExpanded({ ...expanded, [replyC.id]: true });
        setReplyTo(null);
      } else {
        const ms = Math.round(clock.ms);
        const annotation = hasAnn(ann) ? { strokes: ann.strokes, texts: ann.texts } : undefined;
        const c = await postComment(versionId, { content: text, timestampMs: ms, frameNumber: Math.round((ms / 1000) * fps), annotation });
        setActiveId(c.id);
        if (noteFilter === "done") setNoteFilter("open");
        setAnn({ strokes: [], texts: [] });
        setDrawing(false);
      }
      setDraft("");
    } catch (e) { toast(errMsg(e, "Không gửi được ghi chú"), "error"); }
    setSending(false);
  };

  // ---- drawing ----
  const ptFromEvent = (e) => {
    const r = stageRef.current.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)].map((n) => Math.round(n * 1000) / 1000);
  };
  const onDown = (e) => {
    if (!drawing) return;
    e.preventDefault(); e.stopPropagation();
    const p = ptFromEvent(e);
    if (tool === "text") { setTextAt({ x: p[0], y: p[1], value: "" }); setTimeout(() => textRef.current && textRef.current.focus(), 0); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    liveRef.current = { tool, color: DRAW_COLORS[color], width: STROKE_W, points: [p] };
    setLive(liveRef.current);
  };
  // The stroke in progress lives in a ref: pointer events can arrive faster
  // than renders, and pointerup must see the last point, not a stale closure.
  const onMove = (e) => {
    const s = liveRef.current;
    if (!s) return;
    const p = ptFromEvent(e);
    liveRef.current = { ...s, points: s.tool === "pen" ? (s.points.length < 256 ? [...s.points, p] : s.points) : [s.points[0], p] };
    setLive(liveRef.current);
  };
  const onUp = (e) => {
    const s = liveRef.current;
    if (!s) return;
    if (e && e.clientX != null && s.tool !== "pen") s.points = [s.points[0], ptFromEvent(e)];
    liveRef.current = null;
    setLive(null);
    const [a, b] = [s.points[0], s.points[s.points.length - 1]];
    if (s.points.length < 2 || (Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004)) return;
    setAnn((x) => ({ ...x, strokes: [...x.strokes, s].slice(0, 50), order: [...(x.order || []), "s"] }));
  };
  const commitText = () => {
    if (textAt && textAt.value.trim()) setAnn((x) => ({ ...x, texts: [...x.texts, { x: textAt.x, y: textAt.y, color: DRAW_COLORS[color], text: textAt.value.trim().slice(0, 120) }].slice(0, 32), order: [...(x.order || []), "t"] }));
    setTextAt(null);
  };
  const undo = () => setAnn((x) => {
    const order = (x.order || []).slice();
    const last = order.pop();
    return last === "t" ? { ...x, texts: x.texts.slice(0, -1), order } : { ...x, strokes: x.strokes.slice(0, -1), order };
  });
  const toggleDraw = (e) => { if (e) e.stopPropagation(); pause(); setDrawing(!drawing); setTextAt(null); };

  if (!project || !asset) {
    return html`<div class="screen"><div class="page tight">
      <button type="button" class="back" onClick=${() => go(project ? { name: "project", pid } : { name: "hub" })}>← ${project ? project.name : "Dự án"}</button>
      <div class="empty">${S.sources[pid] ? "Không tìm thấy video này." : "Đang tải…"}</div>
    </div></div>`;
  }

  const curStatus = asset.reviewStatus || "edit";
  const presence = (S.presence || []).filter((u) => u && u.id !== (S.me && S.me.id) && u.focus && u.focus.kind === "source" && u.focus.id === aid);
  const verOpts = versions.slice(-4).map((v) => [v.id, "v" + v.versionNumber]);
  const dirtyAnn = hasAnn(ann);
  const showSavedAnn = !drawing && active && hasAnn(active.annotation) ? active : null;
  const renditionState = (q) => { if (q === "source") return ""; const r = rByH(Number(q)); if (!r) return " · —"; if (r.status === "processing") return " · " + (r.progress || 0) + "%"; if (r.status !== "ready") return " · tạo"; return ""; };

  return html`<div class="screen-split" data-screen-label="Review video">
    <div style="flex:1;min-width:0;display:flex;flex-direction:column">
      <div class="rv-top">
        <button type="button" class="rv-crumb" onClick=${() => go({ name: "project", pid })}>← ${project.name.split(" — ")[0]}</button>
        <div class="sep-v"></div>
        <div class="rv-title" title=${asset.title}>${asset.title.replace(/_v\d+$/, "")}</div>
        ${verOpts.length > 0 && html`<${Seg} cls="sm mono" opts=${verOpts} value=${versionId} onPick=${(v) => setVid(v)} />`}
        <div class="rv-presence">${presence.length > 0 && html`<div>
          <div class="row" style="padding-right:6px">${presence.slice(0, 4).map((u) => html`<${Avatar} user=${userById(u.id) || u} name=${u.name} size=${24} style="margin-right:-6px;box-shadow:0 0 0 2px var(--bg)" />`)}</div>
          đang xem
        </div>`}</div>
        <div style="position:relative">
          <button type="button" ref=${statusBtn} class="status-btn" disabled=${!manage} title=${manage ? "Đổi trạng thái video" : "Chỉ người quản lý đổi được trạng thái"}
            style=${`background:color-mix(in oklch, ${ST[curStatus].c} 16%, transparent);color:${ST[curStatus].c}`}
            onClick=${(e) => { e.stopPropagation(); if (manage) setStatusMenu(!statusMenu); }}>
            <span class="dot" style=${`background:${ST[curStatus].c}`}></span>${ST[curStatus].label}${manage && html`<span style="font-size:10px;opacity:0.8">▾</span>`}
          </button>
          <${Menu} open=${statusMenu} onClose=${() => setStatusMenu(false)} anchorRef=${statusBtn} style="right:0;top:42px;width:220px">
            <div class="menu-title">Trạng thái video</div>
            ${ORDER.map((k) => html`<${MenuItem} check=${k === curStatus} onClick=${() => { setStatusMenu(false); setReviewStatus(aid, k); }}>
              <span class="dot dot8" style=${`background:${ST[k].c}`}></span><span class="grow">${ST[k].label}</span>
            </${MenuItem}>`)}
          </${Menu}>
        </div>
        <button type="button" class="btn btn-outline btn-sm" onClick=${() => openOverlay("share", { pid })}>Chia sẻ</button>
      </div>

      <div class="stage-wrap">
        <div class="stage" ref=${stageRef} onClick=${() => { if (!drawing) togglePlay(); }}>
          <video ref=${videoRef} playsinline preload="metadata" poster=${mediaUrl("/assets/" + enc(asset.id) + "/poster?fallback=none")}></video>
          <div class="vig"></div>
          <${StageTags} clock=${clock} fps=${fps} asset=${asset} q=${effQ} />
          ${safe && html`<div class="safe" style="inset:5%"></div><div class="safe" style="inset:10%;border-color:rgba(255,255,255,0.45)"></div>`}
          <svg class=${"ann-svg" + (drawing ? " drawing" : "")} viewBox="0 0 1 1" preserveAspectRatio="none" style=${drawing ? "" : "pointer-events:none"}
            onPointerDown=${onDown} onPointerMove=${onMove} onPointerUp=${onUp} onPointerCancel=${onUp} onClick=${(e) => drawing && e.stopPropagation()}>
            ${showSavedAnn && html`<${SavedAnn} clock=${clock} c=${showSavedAnn} />`}
            ${(drawing || dirtyAnn) && ann.strokes.map((s) => html`<${Stroke} s=${s} />`)}
            ${live && html`<${Stroke} s=${live} />`}
          </svg>
          ${(drawing || dirtyAnn) && ann.texts.map((t) => html`<div class="ann-text" style=${`left:${t.x * 100}%;top:${t.y * 100}%;color:${t.color}`}>${t.text}</div>`)}
          ${showSavedAnn && html`<${SavedTexts} clock=${clock} c=${showSavedAnn} />`}
          ${textAt && html`<input ref=${textRef} class="ann-input" style=${`left:${textAt.x * 100}%;top:${textAt.y * 100}%;color:${DRAW_COLORS[color]}`} value=${textAt.value} maxlength="120" placeholder="Nhập chữ, Enter để đặt"
            onClick=${(e) => e.stopPropagation()} onInput=${(e) => setTextAt({ ...textAt, value: e.target.value })}
            onKeyDown=${(e) => { e.stopPropagation(); if (e.key === "Enter") commitText(); if (e.key === "Escape") setTextAt(null); }} onBlur=${commitText} />`}
          ${playErr && effQ === "source" ? html`<${SourceUnplayable} asset=${asset} r720=${rByH(720)} manage=${manage} onMake=${() => pickQuality("720")} />` : html`<${PlayOverlay} clock=${clock} drawing=${drawing} />`}
          ${drawing && html`<div class="draw-bar" onClick=${(e) => e.stopPropagation()}>
            <div class="row" style="gap:2px">${DRAW_TOOLS.map(([k, l]) => html`<button type="button" class=${"draw-tool" + (tool === k ? " on" : "")} onClick=${() => setTool(k)}>${l}</button>`)}</div>
            <div class="draw-sep"></div>
            <div class="row" style="gap:10px;padding:0 4px">${DRAW_COLORS.map((c, i) => html`<button type="button" aria-label=${"Màu " + (i + 1)} class=${"draw-color" + (color === i ? " on" : "")} style=${`background:${c}`} onClick=${() => setColor(i)}></button>`)}</div>
            <div class="draw-sep"></div>
            <button type="button" class="draw-mini" onClick=${undo} disabled=${!dirtyAnn}>Hoàn tác</button>
            ${dirtyAnn && html`<button type="button" class="draw-mini" onClick=${() => setAnn({ strokes: [], texts: [] })}>Xoá</button>`}
            <button type="button" class="draw-done" onClick=${toggleDraw}>Xong</button>
          </div>`}
        </div>
      </div>

      <${Transport} clock=${clock} asset=${asset} roots=${roots} peopleOff=${peopleOff} activeId=${activeId} jumpTo=${jumpTo} seek=${seek} fps=${fps}
        togglePlay=${togglePlay} step=${step} drawing=${drawing} toggleDraw=${toggleDraw} safe=${safe} setSafe=${setSafe}
        speed=${speed} cycleSpeed=${() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}
        qLabel=${(QUALITIES.find((q) => q[0] === effQ) || QUALITIES[0])[1]} cycleQuality=${cycleQuality} pickQuality=${pickQuality} effQ=${effQ} renditionState=${renditionState} />
    </div>

    <aside class="notes">
      <div class="notes-head">
        <div class="row gap10"><div style="font-size:18px;font-weight:600;letter-spacing:-0.02em">Ghi chú</div><div class="mono" style="font-size:12px;color:var(--tx-3)">${openCount} mở</div></div>
        <div class="row" style="flex-wrap:wrap;gap:10px 12px;margin-top:16px">
          <${Seg} opts=${[["open", "Mở " + openCount], ["done", "Xong " + doneCount], ["all", "Tất cả " + roots.length]]} value=${noteFilter} onPick=${setNoteFilter} />
          <div class="grow"></div>
          <div class="row" style="gap:7px;flex-wrap:wrap">${authors.map((a) => html`<button type="button" title=${a.name + (peopleOff[a.key] ? " · đang ẩn" : "")}
            style=${`border-radius:50%;opacity:${peopleOff[a.key] ? 0.3 : 1};box-shadow:${peopleOff[a.key] ? "none" : "0 0 0 2px var(--bg-2), 0 0 0 3.5px var(--line-2)"}`}
            onClick=${() => setPeopleOff({ ...peopleOff, [a.key]: !peopleOff[a.key] })}><${Avatar} user=${a.user} name=${a.name} size=${24} /></button>`)}</div>
        </div>
      </div>
      <div style="height:1px;background:var(--line);margin:18px 0 0"></div>
      <div class="notes-list">
        ${comments === null && html`<div style="padding:40px 12px;text-align:center" class="muted">Đang tải ghi chú…</div>`}
        ${visible.map((c) => html`<${Thread} key=${c.id} c=${c} replies=${repliesOf[c.id] || []} active=${c.id === activeId} expanded=${!!expanded[c.id]}
          onJump=${() => jumpTo(c)} versionId=${versionId} editing=${editing} setEditing=${setEditing}
          onReply=${() => { setReplyTo(c.id); setActiveId(c.id); setExpanded({ ...expanded, [c.id]: true }); setTimeout(() => { const t = document.getElementById("noteComposer"); t && t.focus(); }, 0); }}
          onToggle=${() => setExpanded({ ...expanded, [c.id]: !expanded[c.id] })} />`)}
        ${comments && visible.length === 0 && html`<div style="padding:40px 12px;text-align:center;font-size:13.5px;color:var(--tx-3)">${roots.length ? "Không có ghi chú nào khớp bộ lọc." : "Chưa có ghi chú. Dừng ở khung cần sửa rồi viết bên dưới."}</div>`}
      </div>
      <${Composer} clock=${clock} replyC=${replyC} cancelReply=${() => setReplyTo(null)} draft=${draft} setDraft=${setDraft} send=${send} sending=${sending}
        drawing=${drawing} toggleDraw=${toggleDraw} dirtyAnn=${dirtyAnn} />
    </aside>
  </div>`;
}

// Most camera originals (ProRes, XAVC, DNx) don't decode in browsers: say so
// on the frame and offer the proxy instead of a silent black player.
function SourceUnplayable({ asset, r720, manage, onMake }) {
  const [asked, setAsked] = useState(false);
  const st = r720 && r720.status;
  const queued = st === "pending" && (asked || r720.lastJobStatus === "queued");
  return html`<div onClick=${(e) => e.stopPropagation()} style="position:absolute;inset:0;display:grid;place-items:center;background:rgba(10,10,9,.55);backdrop-filter:blur(4px);cursor:default">
    <div style="text-align:center;max-width:420px;padding:0 24px;color:#fff">
      <div style="font-size:16px;font-weight:600">Trình duyệt không phát được file gốc</div>
      <div style="margin-top:6px;font-size:13px;color:rgba(255,255,255,.7);line-height:1.55">${asset.codec || "Codec này"} chỉ xem được qua proxy. Proxy 720p (~3.5 Mbps) được tạo một lần trên NAS, cả nhóm dùng chung.</div>
      <div style="margin-top:16px">
        ${st === "processing" || queued
          ? html`<div style="font-size:13px">${queued ? "Đã xếp hàng · chờ worker nhận…" : "Đang tạo proxy 720p · " + (r720.progress || 0) + "%"}</div><div class="bar-track" style="margin:10px auto 0;width:220px"><div class="bar-fill" style=${`width:${queued ? 2 : r720.progress || 0}%`}></div></div>`
          : manage
            ? html`<button type="button" class="draw-done" style="display:inline-flex;height:36px;padding:0 18px" onClick=${async () => { setAsked(true); if ((await onMake()) === false) setAsked(false); }}>${st === "ready" ? "Phát proxy 720p" : st === "failed" ? "Tạo lại proxy 720p" : "Tạo proxy 720p"}</button>`
            : html`<div style="font-size:13px;color:rgba(255,255,255,.7)">Nhờ người quản lý dự án tạo proxy 720p.</div>`}
      </div>
    </div>
  </div>`;
}

// ---- time-driven pieces (subscribe to the clock) ----
function StageTags({ clock, fps, asset, q }) {
  useClock(clock);
  return html`
    <div class="stage-tag" style="left:16px;top:14px">${fmtTc(clock.ms, fps)}</div>
    <div class="stage-tag" style="right:16px;top:14px;color:rgba(255,255,255,0.75)">F ${Math.floor((clock.ms / 1000) * fps)}</div>
    <div class="stage-note" style="left:16px;bottom:14px;max-width:55%">${[asset.codec, resLabel(asset), asset.frameRate ? asset.frameRate + " FPS" : ""].filter(Boolean).join(" · ").toUpperCase()}</div>
    <div class="stage-note" style="right:16px;bottom:14px;letter-spacing:0">${q === "source" ? "BẢN GỐC · NAS" : "PROXY " + q + "P · HLS"}</div>`;
}
function PlayOverlay({ clock, drawing }) {
  useClock(clock);
  if (clock.waiting && clock.playing) return html`<div class="big-play"><${Spinner} /></div>`;
  if (clock.playing || drawing) return null;
  return html`<div class="big-play"><${IcPlay} size=${22} color="#fff" style="margin-left:3px" /></div>`;
}
function SavedAnn({ clock, c }) {
  useClock(clock);
  if (Math.abs(clock.ms - c.timestampMs) > 2500) return null;
  return html`<g>${(c.annotation.strokes || []).map((s) => html`<${Stroke} s=${s} />`)}</g>`;
}
function SavedTexts({ clock, c }) {
  useClock(clock);
  if (Math.abs(clock.ms - c.timestampMs) > 2500) return null;
  return (c.annotation.texts || []).map((t) => html`<div class="ann-text" style=${`left:${t.x * 100}%;top:${t.y * 100}%;color:${t.color}`}>${t.text}</div>`);
}

function Transport(props) {
  const { clock, asset, roots, peopleOff, activeId, jumpTo, seek, fps, togglePlay, step, drawing, toggleDraw, safe, setSafe, speed, cycleSpeed, qLabel, cycleQuality, pickQuality, effQ, renditionState } = props;
  useClock(clock);
  const dur = clock.dur || asset.durationMs || 0;
  const pct = dur ? clamp((clock.ms / dur) * 100, 0, 100) : 0;
  const bufPct = dur ? clamp((clock.buffered / dur) * 100, 0, 100) : 0;
  const [hover, setHover] = useState(null);
  const [qMenu, setQMenu] = useState(false);
  const qBtn = useRef(null);
  const film = useRef(null);
  const msAt = (e) => { const r = film.current.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * dur; };
  const scrub = useRef(false);
  const pal = paletteOf(asset);
  const frames = useMemo(() => Array.from({ length: FILM_N }, (_, i) => mediaUrl("/assets/" + enc(asset.id) + "/frame?n=" + FILM_N + "&i=" + i)), [asset.id]);
  return html`<div class="transport">
    <div class="markers">
      ${roots.filter((c) => !peopleOff[authorOf(c).key]).map((c) => {
        const a = authorOf(c);
        const p = personOf(a.user, a.name);
        return html`<button type="button" class=${"marker" + (c.id === activeId ? " on" : "")} title=${a.name + " · " + fmtShort(c.timestampMs)}
          style=${`left:${dur ? clamp((c.timestampMs / dur) * 100, 0, 100) : 0}%;background:${p.bg};opacity:${c.resolved ? 0.4 : 1}`} onClick=${() => jumpTo(c)}>${p.short}</button>`;
      })}
    </div>
    <div class="filmstrip" ref=${film}
      onPointerDown=${(e) => { scrub.current = true; e.currentTarget.setPointerCapture(e.pointerId); seek(msAt(e)); }}
      onPointerMove=${(e) => { const ms = msAt(e); setHover({ ms, left: (ms / (dur || 1)) * 100 }); if (scrub.current) seek(ms); }}
      onPointerUp=${() => { scrub.current = false; }} onPointerLeave=${() => setHover(null)}>
      ${frames.map((src, i) => html`<div class="fr" style=${`background:${flatBg(...(i % 2 ? pal : [pal[1], pal[0]]))}`}><${FilmFrame} src=${src} /></div>`)}
      <div class="buffer" style=${`width:${bufPct}%`}></div>
      <div class="after" style=${`left:${pct}%`}></div>
      <div class="phead" style=${`left:${pct}%`}></div>
      ${hover && html`<div class="hover" style=${`left:${hover.left}%`}></div>`}
    </div>
    <div style="position:relative">${hover && html`<div class="hover-tc" style=${`left:${hover.left}%;bottom:52px`}>${fmtShort(hover.ms)}</div>`}</div>
    <div class="controls">
      <button type="button" class="play-btn" aria-label=${clock.playing ? "Dừng" : "Phát"} onClick=${togglePlay}>${clock.playing ? html`<${IcPause} />` : html`<${IcPlay} />`}</button>
      <button type="button" class="step-btn" title="Lùi 1 frame (←)" onClick=${() => step(-1)}>‹ 1F</button>
      <button type="button" class="step-btn" title="Tiến 1 frame (→)" onClick=${() => step(1)}>1F ›</button>
      <div class="mono" style="margin-left:6px;font-size:13px;white-space:nowrap">${fmtTc(clock.ms, fps)} <span class="muted">/ ${fmtTc(dur, fps)}</span></div>
      <div class="grow"></div>
      <button type="button" class=${"ctl" + (drawing ? " on" : "")} onClick=${toggleDraw}>Vẽ ghi chú</button>
      <button type="button" class=${"ctl" + (safe ? " on2" : "")} onClick=${() => setSafe(!safe)}>Safe area</button>
      <button type="button" class="ctl ring" title="Tốc độ" onClick=${cycleSpeed}>${speed}×</button>
      <div style="position:relative">
        <button type="button" ref=${qBtn} class="ctl ring" title="Chất lượng phát (bấm giữ Shift để xoay vòng)" onClick=${(e) => (e.shiftKey ? cycleQuality() : setQMenu(!qMenu))}>${qLabel}</button>
        <${Menu} open=${qMenu} onClose=${() => setQMenu(false)} anchorRef=${qBtn} style="right:0;bottom:42px;width:250px">
          <div class="menu-title">Chất lượng phát</div>
          ${QUALITIES.map(([k, l]) => html`<${MenuItem} check=${k === effQ} onClick=${() => { setQMenu(false); pickQuality(k); }}>
            <span class="mono" style="width:52px">${l}</span><span class="muted" style="font-size:12px">${k === "source" ? "file gốc trên NAS" : k === "720" ? "~3.5 Mbps" : "~8 Mbps"}${renditionState(k)}</span>
          </${MenuItem}>`)}
        </${Menu}>
      </div>
    </div>
  </div>`;
}

// Filmstrip frames load lazily one after another (the API also caps ffmpeg
// runs) and fall back to the gradient if the NAS can't make one.
function FilmFrame({ src }) {
  const [st, setSt] = useState("loading");
  if (st === "failed") return null;
  return html`<img src=${src} alt="" decoding="async" style=${st === "ok" ? "" : "opacity:0"} onLoad=${() => setSt("ok")} onError=${() => setSt("failed")} />`;
}

function Thread({ c, replies, active, expanded, onJump, onReply, onToggle, versionId, editing, setEditing }) {
  const a = authorOf(c);
  const mine = S.me && c.authorUserId === S.me.id && !c.guestLabel;
  const isEditing = editing && editing.id === c.id;
  return html`<div class=${"thread" + (active ? " on" : "")} onClick=${onJump}>
    <div class="row" style="gap:9px">
      <${Avatar} user=${a.user} name=${a.name} size=${24} />
      <div class="ell" style="font-size:13.5px;font-weight:500">${a.name}</div>
      <div class="tc-tag">${fmtShort(c.timestampMs)}</div>
      <div style="font-size:12px;color:var(--tx-3);white-space:nowrap">${fmtAgo(c.createdAt, { suffix: false })}</div>
      <div class="grow"></div>
      <button type="button" title=${c.resolved ? "Mở lại" : "Đánh dấu xong"} class=${"check" + (c.resolved ? " done" : "")}
        onClick=${(e) => { e.stopPropagation(); resolveComment(versionId, c.id, !c.resolved); }}>✓</button>
    </div>
    ${isEditing
      ? html`<div style="margin-left:33px" onClick=${(e) => e.stopPropagation()}>
          <textarea class="edit-area" value=${editing.text} onInput=${(e) => setEditing({ ...editing, text: e.target.value })}
            onKeyDown=${(e) => { if (e.key === "Escape") setEditing(null); }}></textarea>
          <div class="row gap8" style="margin-top:6px">
            <button type="button" class="btn btn-primary btn-xxs" onClick=${() => guard(async () => { await editComment(versionId, c.id, editing.text.trim()); setEditing(null); })}>Lưu</button>
            <button type="button" class="link" onClick=${() => setEditing(null)}>Huỷ</button>
          </div>
        </div>`
      : html`<div class="thread-text" style=${`color:${c.resolved ? "var(--tx-3)" : "var(--tx)"}`}>${c.content}</div>`}
    ${hasAnn(c.annotation) && html`<div style="margin:8px 0 0 33px;display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--tx-2)"><span style="width:10px;height:10px;border-radius:50%;border:1.5px solid var(--s-fix)"></span>Có hình vẽ trên khung</div>`}
    <div class="thread-acts">
      <button type="button" class="link" style="font-size:12.5px" onClick=${(e) => { e.stopPropagation(); onReply(); }}>Trả lời</button>
      ${replies.length > 0 && html`<button type="button" style="color:var(--acc-tx);font-size:12.5px" onClick=${(e) => { e.stopPropagation(); onToggle(); }}>${expanded ? "Ẩn phản hồi" : replies.length + " phản hồi"}</button>`}
      ${mine && !isEditing && html`<button type="button" class="link" style="font-size:12.5px" onClick=${(e) => { e.stopPropagation(); setEditing({ id: c.id, text: c.content }); }}>Sửa</button>`}
      ${mine && html`<button type="button" class="link" style="font-size:12.5px" onClick=${(e) => { e.stopPropagation(); if (confirm("Xoá ghi chú này cùng các phản hồi?")) guard(() => deleteComment(versionId, c.id)); }}>Xoá</button>`}
    </div>
    ${expanded && replies.length > 0 && html`<div class="replies" onClick=${(e) => e.stopPropagation()}>
      ${replies.map((r) => { const ra = authorOf(r); return html`<div>
        <div class="row gap8"><${Avatar} user=${ra.user} name=${ra.name} size=${20} /><div style="font-size:13px;font-weight:500">${ra.name}</div><div style="font-size:12px;color:var(--tx-3)">${fmtAgo(r.createdAt, { suffix: false })}</div></div>
        <div style="margin:5px 0 0 28px;font-size:13.5px;line-height:1.5;color:var(--tx-2);white-space:pre-wrap;word-break:break-word">${r.content}</div>
      </div>`; })}
    </div>`}
  </div>`;
}

function Composer({ clock, replyC, cancelReply, draft, setDraft, send, sending, drawing, toggleDraw, dirtyAnn }) {
  useClock(clock);
  const canSend = !!draft.trim() && !sending;
  const replyName = replyC ? authorOf(replyC).name : "";
  return html`<div class="composer">
    ${replyC && html`<div class="row gap8" style="margin:0 4px 10px;font-size:12.5px;color:var(--tx-2)">Trả lời <b style="font-weight:600;color:var(--tx)">${replyName}</b><div class="grow"></div><button type="button" class="link" style="font-size:12.5px" onClick=${cancelReply}>Huỷ</button></div>`}
    <div class="composer-box">
      <textarea id="noteComposer" rows="2" value=${draft} placeholder=${replyC ? "Viết phản hồi…" : "Ghi chú tại " + fmtShort(clock.ms) + "…"}
        onInput=${(e) => setDraft(e.target.value)}
        onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === "Escape") e.target.blur(); }}></textarea>
      <div class="row gap8" style="margin-top:6px">
        <div class="tc-tag" style="padding:3px 8px">@ ${fmtShort(replyC ? replyC.timestampMs : clock.ms)}</div>
        ${!replyC && html`<button type="button" class=${"ctl" + (drawing || dirtyAnn ? " on" : "")} style="height:26px;padding:0 10px;font-size:12px" onClick=${toggleDraw}>${dirtyAnn ? "Vẽ ✓" : "Vẽ"}</button>`}
        <div class="grow"></div>
        <div style="font-size:11.5px;color:var(--tx-3)">↵ gửi</div>
        <button type="button" class=${"btn btn-xs " + (canSend ? "btn-primary" : "")} style=${canSend ? "" : "background:var(--bg-3);color:var(--tx-3)"} disabled=${!canSend} onClick=${send}>${sending ? "Đang gửi…" : "Gửi"}</button>
      </div>
    </div>
  </div>`;
}
