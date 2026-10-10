// Kịch bản editor parts: the TipTap extensions (images, paragraph spacing and
// indent, comment anchors, shortcuts) and the Docs-like toolbar. Every
// dropdown is a popover on <body> (ui.mjs), so the toolbar never clips one.

import { html, useState, useRef, useEffect, useLayoutEffect, isEnter } from "../lib.mjs";
import { clamp } from "../format.mjs";
import { toast, errMsg } from "../store.mjs";
import { Menu, MenuItem, Popover, IcMore } from "../ui.mjs";
import { mediaUrl, post, enc } from "../api.mjs";
import { encodeImage, MOD } from "../sketch.mjs";

// ---- TipTap (vendored UMD bundle → window.Tiptap) ----
let tiptapLoad = null;
export function ensureTiptap() {
  if (window.Tiptap) return Promise.resolve(window.Tiptap);
  if (!tiptapLoad) {
    tiptapLoad = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      // vendor/ files are cached for an hour: a new release must not run
      // against the bundle the browser kept from the previous one. The
      // suffix changes with the bundle itself, for builds without a sha.
      el.src = "vendor/tiptap.min.js?v=" + encodeURIComponent((window.__BUILD_SHA || "dev") + "-image");
      el.onload = () => (window.Tiptap ? resolve(window.Tiptap) : reject(new Error("Thiếu bộ soạn thảo")));
      el.onerror = () => { tiptapLoad = null; reject(new Error("Không tải được trình soạn thảo")); };
      document.head.appendChild(el);
    });
  }
  return tiptapLoad;
}

const key = (k, shift) => MOD + (shift ? (MOD === "⌘" ? "⇧" : "Shift+") : "") + k;

// The Ctrl/⌘K shortcut opens the toolbar's link box.
let openLinkBox = null;

export function scriptExtensions(T, { scriptId, placeholder }) {
  return [
    T.StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
    T.Highlight.configure({ multicolor: true }),
    T.TextStyleKit.configure({ lineHeight: false }), // line spacing is per paragraph (blockStyle)
    T.TextAlign.configure({ types: ["heading", "paragraph"] }),
    T.TableKit.configure({ table: { resizable: true, cellMinWidth: 60 } }), T.TaskList, T.TaskItem.configure({ nested: true }),
    T.Subscript, T.Superscript,
    T.Placeholder.configure({ placeholder }),
    T.CharacterCount, commentMark(T), blockStyle(T), scriptImage(T, scriptId), shortcuts(T),
  ];
}

// <span class="sc-comment" data-comment-id> — excludes:"" lets threads
// overlap; inclusive:false stops typing at the edge from growing the anchor.
function commentMark(T) {
  return T.Mark.create({
    name: "comment", inclusive: false, excludes: "",
    addAttributes() { return { id: { default: null, parseHTML: (el) => el.getAttribute("data-comment-id"), renderHTML: (a) => (a.id ? { "data-comment-id": a.id } : {}) } }; },
    parseHTML() { return [{ tag: "span[data-comment-id]" }]; },
    renderHTML({ HTMLAttributes }) { return ["span", T.mergeAttributes(HTMLAttributes, { class: "sc-comment" }), 0]; },
  });
}

// Line spacing and indent of a paragraph / heading.
function blockStyle(T) {
  return T.Extension.create({
    name: "blockStyle",
    addGlobalAttributes() {
      return [{
        types: ["paragraph", "heading"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => (/^\d(\.\d+)?$/.test(el.style.lineHeight) ? el.style.lineHeight : null),
            renderHTML: (a) => (a.lineHeight ? { style: "line-height:" + a.lineHeight } : {}),
          },
          indent: {
            default: 0,
            parseHTML: (el) => clamp(parseInt(el.getAttribute("data-indent"), 10) || 0, 0, 8),
            renderHTML: (a) => (a.indent ? { "data-indent": String(a.indent), style: "margin-left:" + a.indent * 2 + "em" } : {}),
          },
        },
      }];
    },
  });
}

function shortcuts(T) {
  return T.Extension.create({
    name: "scriptKeys",
    addKeyboardShortcuts() {
      return {
        "Mod-k": () => { if (openLinkBox) openLinkBox(); return true; },
        "Mod-\\": () => clearFormat(this.editor),
        "Mod-]": () => shiftIndent(this.editor, 1),
        "Mod-[": () => shiftIndent(this.editor, -1),
      };
    },
  });
}

const LISTS = ["listItem", "taskItem"];
function shiftIndent(ed, d) {
  if (!ed) return false;
  const item = LISTS.find((n) => ed.isActive(n));
  if (item) {
    const c = ed.chain().focus();
    (d > 0 ? c.sinkListItem(item) : c.liftListItem(item)).run();
    return true;
  }
  const { state } = ed, { $from, $to } = state.selection, tr = state.tr;
  state.doc.nodesBetween($from.start(), $to.end(), (node, pos) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    const n = clamp((node.attrs.indent || 0) + d, 0, 8);
    if (n !== (node.attrs.indent || 0)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: n });
    return false;
  });
  if (tr.docChanged) ed.view.dispatch(tr);
  ed.commands.focus();
  return true;
}

// Removes character formatting and paragraph alignment / spacing / indent.
// Comment anchors stay, and so does the paragraph style (Cảnh, VO…).
function clearFormat(ed) {
  if (!ed) return false;
  const { state } = ed, { from, to, empty, $from, $to } = state.selection, tr = state.tr;
  if (empty) tr.setStoredMarks([]);
  else Object.values(state.schema.marks).forEach((m) => { if (m.name !== "comment") tr.removeMark(from, to, m); });
  state.doc.nodesBetween($from.start(), $to.end(), (node, pos) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") return true;
    const a = node.attrs;
    if (a.textAlign || a.lineHeight || a.indent) tr.setNodeMarkup(pos, undefined, { ...a, textAlign: null, lineHeight: null, indent: 0 });
    return false;
  });
  ed.view.dispatch(tr);
  ed.commands.focus();
  return true;
}

// Letters an earlier server build garbled into "\uFFFD" while saving (its
// request decoding split multi-byte letters). The bytes are gone, so the
// editor points at each spot for the writer to retype.
export function brokenSpots(doc) {
  const out = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const re = /\uFFFD+/g;
    let m;
    while ((m = re.exec(node.text))) out.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    return false;
  });
  return out;
}

// ---- images ----
// The body only names the file (<img data-image-id data-script-id>); the
// address is built when the page shows it, so a script works from the LAN
// address, the QuickConnect one or a dev server alike.
const pending = new Map(); // upload key → data: URL shown until the file is on the NAS
const imageUrl = (sid, id) => mediaUrl("/scripts/" + enc(sid) + "/images/" + enc(id));

function scriptImage(T, scriptId) {
  return T.Node.create({
    name: "image", group: "block", atom: true, draggable: true, selectable: true,
    addAttributes() {
      return {
        id: { default: null, parseHTML: (el) => el.getAttribute("data-image-id"), renderHTML: (a) => (a.id ? { "data-image-id": a.id } : {}) },
        sid: { default: null, parseHTML: (el) => el.getAttribute("data-script-id"), renderHTML: (a) => (a.sid ? { "data-script-id": a.sid } : {}) },
        alt: { default: "", parseHTML: (el) => el.getAttribute("alt") || "", renderHTML: (a) => ({ alt: a.alt || "" }) },
        width: {
          default: 100,
          parseHTML: (el) => clamp(parseInt(el.getAttribute("data-width"), 10) || 100, 10, 100),
          renderHTML: (a) => ({ "data-width": String(a.width), style: "width:" + a.width + "%" }),
        },
        align: {
          default: "center",
          parseHTML: (el) => (["left", "right"].includes(el.getAttribute("data-align")) ? el.getAttribute("data-align") : "center"),
          renderHTML: (a) => ({ "data-align": a.align }),
        },
        upload: { default: null, rendered: false },
      };
    },
    parseHTML() { return [{ tag: "img[data-image-id]" }]; },
    renderHTML({ node, HTMLAttributes }) {
      return ["img", T.mergeAttributes(HTMLAttributes, node.attrs.id ? { src: imageUrl(node.attrs.sid || scriptId, node.attrs.id) } : {})];
    },
    addNodeView() {
      return ({ node, getPos, editor }) => {
        let cur = node;
        const dom = document.createElement("div");
        dom.className = "sc-img";
        dom.contentEditable = "false";
        const box = document.createElement("div");
        box.className = "sc-img-box";
        const img = document.createElement("img");
        img.draggable = false;
        img.onload = () => dom.classList.remove("broken");
        img.onerror = () => dom.classList.add("broken");
        const size = document.createElement("span");
        size.className = "sc-img-size";
        box.append(img, size);
        // Drag a side handle to resize; a centred image grows on both sides.
        ["w", "e"].forEach((side) => {
          const h = document.createElement("span");
          h.className = "sc-img-h " + side;
          h.title = "Kéo để đổi kích thước";
          h.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || !editor.isEditable) return;
            e.preventDefault(); e.stopPropagation();
            h.setPointerCapture(e.pointerId);
            const x0 = e.clientX, full = dom.clientWidth || 1, w0 = box.getBoundingClientRect().width;
            const k = (cur.attrs.align === "center" ? 2 : 1) * (side === "e" ? 1 : -1);
            let w = cur.attrs.width;
            dom.classList.add("resizing");
            size.textContent = w + "%";
            const move = (ev) => {
              w = clamp(Math.round(((w0 + (ev.clientX - x0) * k) / full) * 100), 10, 100);
              box.style.width = w + "%";
              size.textContent = w + "%";
            };
            const end = () => {
              h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", end); h.removeEventListener("pointercancel", end);
              dom.classList.remove("resizing");
              const pos = getPos();
              if (typeof pos === "number" && w !== cur.attrs.width) editor.chain().setNodeSelection(pos).updateAttributes("image", { width: w }).run();
            };
            h.addEventListener("pointermove", move); h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
          });
          box.appendChild(h);
        });
        dom.appendChild(box);
        const apply = (n) => {
          const a = n.attrs;
          dom.dataset.align = a.align || "center";
          box.style.width = (a.width || 100) + "%";
          const src = a.id ? imageUrl(a.sid || scriptId, a.id) : pending.get(a.upload) || "";
          if (img.getAttribute("src") !== src) { if (src) img.setAttribute("src", src); else img.removeAttribute("src"); }
          img.alt = a.alt || "";
          dom.classList.toggle("uploading", !a.id);
        };
        apply(node);
        return {
          dom,
          update: (n) => { if (n.type !== cur.type) return false; cur = n; apply(n); return true; },
          selectNode: () => dom.classList.add("sel"),
          deselectNode: () => dom.classList.remove("sel"),
          stopEvent: (e) => !!(e.target && e.target.closest && e.target.closest(".sc-img-h")),
          ignoreMutation: () => true,
        };
      };
    },
  });
}

// Set (or with `attrs` null, drop) the image still waiting for its upload.
function patchUpload(ed, uploadKey, attrs) {
  if (!ed || ed.isDestroyed) return;
  const { state } = ed, tr = state.tr;
  state.doc.descendants((n, pos) => {
    if (n.type.name !== "image" || n.attrs.upload !== uploadKey) return true;
    if (attrs) tr.setNodeMarkup(pos, undefined, { ...n.attrs, ...attrs });
    else tr.delete(pos, pos + n.nodeSize);
    return false;
  });
  if (tr.docChanged) ed.view.dispatch(tr.setMeta("addToHistory", false));
}

// Re-encoded in the browser (≤1600 px), shown at once from memory, then
// uploaded one by one; a failed upload takes its placeholder away again.
export async function insertImages(ed, sid, files, pos) {
  const list = [...(files || [])].filter((f) => /^image\//.test(f.type));
  if (!list.length) { toast("Chỉ chèn được file ảnh (PNG, JPEG, WebP…)", "error"); return; }
  const jobs = [];
  for (const file of list) {
    if (!ed || ed.isDestroyed) return;
    let img;
    try { img = await encodeImage(file); } catch (e) { toast(errMsg(e, "Không đọc được ảnh"), "error"); continue; }
    const k = "u" + Math.random().toString(36).slice(2);
    pending.set(k, img.data);
    // a small picture keeps about its own size in the ~650 px text column
    const width = clamp(Math.round((img.w / 650) * 100), 10, 100);
    const s = ed.state.selection;
    const at = pos != null ? pos : s.node ? s.to : { from: s.from, to: s.to };
    ed.chain().focus().insertContentAt(at, { type: "image", attrs: { sid, upload: k, width } }).run();
    pos = null; // the next one goes after it
    jobs.push({ k, data: img.data });
  }
  for (const j of jobs) {
    try {
      const r = await post("/scripts/" + enc(sid) + "/images", { dataUrl: j.data }, { timeout: 60000 });
      patchUpload(ed, j.k, { id: r.id, upload: null });
    } catch (e) {
      patchUpload(ed, j.k, null);
      toast(errMsg(e, "Không tải được ảnh lên"), "error", 5200);
    }
    pending.delete(j.k);
  }
}

export function pickImages(ed, sid) {
  if (!ed) return;
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
  inp.onchange = () => { if (inp.files && inp.files.length) insertImages(ed, sid, inp.files); };
  inp.click();
}

const imageFiles = (dt) => (dt && dt.files ? [...dt.files].filter((f) => /^image\//.test(f.type)) : []);
const htmlHasText = (h) => !!h && !!new DOMParser().parseFromString(h, "text/html").body.textContent.trim();

// editorProps: a pasted screenshot or copied picture, or image files dropped
// on the text, are uploaded and placed where they land.
export function imageHandlers(getEd, sid) {
  return {
    handlePaste(view, e) {
      const cd = e.clipboardData;
      if (!cd) return false;
      const files = imageFiles(cd);
      const htmlText = cd.getData("text/html") || "";
      // Text copied from a document wins over the picture of it some apps add.
      if (files.length && !cd.getData("text/plain").trim() && !htmlHasText(htmlText)) {
        insertImages(getEd(), sid, files);
        return true;
      }
      const foreign = (htmlText.match(/<img\b(?![^>]*data-image-id)[^>]*\ssrc=["']?(https?:|data:)/gi) || []).length;
      if (foreign) toast("Ảnh trong nội dung vừa dán không được chèn — lưu ảnh về máy rồi kéo thả vào kịch bản", "error", 6000);
      return false;
    },
    handleDrop(view, e, slice, moved) {
      if (moved) return false;
      const files = imageFiles(e.dataTransfer);
      if (!files.length) return false;
      e.preventDefault();
      const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
      insertImages(getEd(), sid, files, at ? at.pos : null);
      return true;
    },
  };
}

// ---- toolbar ----
const P = {
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  strike: "M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM21 15l-3.1-3.1a2 2 0 0 0-2.8 0L6 21",
  left: "M21 6H3M15 12H3M17 18H3",
  center: "M21 6H3M17 12H7M19 18H5",
  right: "M21 6H3M21 12H9M21 18H7",
  justify: "M21 6H3M21 12H3M21 18H3",
  spacing: "M11 6h10M11 12h10M11 18h10M3 8l3-3 3 3M3 16l3 3 3-3M6 5v14",
  bullet: "M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01",
  ordered: "M10 6h11M10 12h11M10 18h11M4 4h1v5M4 9h2M6 20H4c0-1.2 2-2 2-3.2 0-1.3-1.6-1.6-2.2-.6",
  check: "m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8",
  outdent: "m7 8-4 4 4 4M21 6H11M21 12H11M21 18H11",
  indent: "m3 8 4 4-4 4M21 6H11M21 12H11M21 18H11",
  table: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM3 9h18M3 15h18M9 3v18M15 3v18",
  clear: "M4 7V4h16v3M9 20h3M14 4 9.5 16M15 15l6 6M21 15l-6 6",
  marker: "m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
  open: "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
};
const Ic = ({ n, size = 16 }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[n]} /></svg>`;

const BLOCKS = [
  ["p", "Đoạn văn", (c) => c.setParagraph()],
  ["h2", "Cảnh", (c) => c.setHeading({ level: 2 })],
  ["h1", "Tiêu đề lớn", (c) => c.setHeading({ level: 1 })],
  ["h3", "Tiêu đề nhỏ", (c) => c.setHeading({ level: 3 })],
  ["vo", "VO / lời bình", (c) => c.setParagraph().setBlockquote()],
  ["meta", "Thông số kỹ thuật", (c) => c.setCodeBlock()],
];
function currentBlock(ed) {
  if (!ed) return "p";
  if (ed.isActive("heading", { level: 2 })) return "h2";
  if (ed.isActive("heading", { level: 1 })) return "h1";
  if (ed.isActive("heading", { level: 3 })) return "h3";
  if (ed.isActive("blockquote")) return "vo";
  if (ed.isActive("codeBlock")) return "meta";
  return "p";
}
// Text size of each paragraph style when no size is set (app.css .script-doc).
const BASE_SIZE = { p: 16.5, h1: 28, h2: 21, h3: 17, vo: 18, meta: 12 };
const SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48];
const FONTS = [
  [null, "Mặc định"],
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Tahoma, Verdana, sans-serif", "Tahoma"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["'Times New Roman', Times, serif", "Times New Roman"],
  ["Georgia, serif", "Georgia"],
  ["'Courier New', Courier, monospace", "Courier New"],
];
const fontName = (v) => String(v || "").split(",")[0].replace(/['"]/g, "").trim().toLowerCase();
// Mid-tone text colours read on the light and the dark theme alike.
const TEXT_COLORS = [["#e5484d", "Đỏ"], ["#f76b15", "Cam"], ["#d19b00", "Vàng"], ["#30a46c", "Lục"], ["#12a594", "Ngọc"], ["#0090ff", "Lam"], ["#6e56cf", "Tím"], ["#d6409f", "Hồng"], ["#8d8d86", "Xám"]];
// Pastel highlights; on the dark theme their text turns dark (app.css).
const MARK_COLORS = [["#fff59d", "Vàng"], ["#ffd8a8", "Cam"], ["#ffc9c9", "Đỏ"], ["#fcc2d7", "Hồng"], ["#e5dbff", "Tím"], ["#d0ebff", "Lam"], ["#c3fae8", "Ngọc"], ["#d3f9d8", "Lục"], ["#e9ecef", "Xám"]];
const ALIGNS = [["left", "Căn trái", "L"], ["center", "Căn giữa", "E"], ["right", "Căn phải", "R"], ["justify", "Căn đều", "J"]];
const SPACING = [["1", "Đơn"], ["1.15", "1,15"], ["1.5", "1,5"], [null, "Mặc định"], ["2", "Đôi"], ["2.5", "2,5"]];

// Colours come back from the HTML as rgb(); compare them in one form.
let colorCtx = null;
function sameColor(a, b) {
  if (!a || !b) return false;
  if (!colorCtx) colorCtx = document.createElement("canvas").getContext("2d");
  const norm = (c) => { colorCtx.fillStyle = "#000"; colorCtx.fillStyle = c; return colorCtx.fillStyle; };
  return norm(a) === norm(b);
}

const keep = (e) => e.preventDefault(); // a toolbar press leaves the selection in the text
const focusOnce = (el) => { if (el && !el.dataset.focused) { el.dataset.focused = "1"; el.focus(); el.select(); } };

function Swatches({ colors, value, none, onPick, custom }) {
  return html`<div class="sc-pal">
    <${MenuItem} check=${!value} onClick=${() => onPick(null)}>${none}</${MenuItem}>
    <div class="sc-sw">${colors.map(([c, n]) => html`<button type="button" role="menuitem" class=${"sw" + (sameColor(value, c) ? " on" : "")} title=${n} aria-label=${n} style=${"background:" + c} onClick=${() => onPick(c)}></button>`)}</div>
    ${custom && html`<label class="menu-item">Màu khác…<input type="color" value="#e5484d" onChange=${(e) => onPick(e.target.value)} /></label>`}
  </div>`;
}

function TableGrid({ onPick }) {
  const [hv, setHv] = useState([0, 0]);
  return html`<div class="tg" onMouseLeave=${() => setHv([0, 0])}>
    <div class="tg-grid">${Array.from({ length: 48 }, (_, i) => {
      const r = Math.floor(i / 8) + 1, c = (i % 8) + 1;
      return html`<button type="button" role="menuitem" class=${"tg-c" + (r <= hv[0] && c <= hv[1] ? " on" : "")} aria-label=${r + " hàng × " + c + " cột"}
        onMouseEnter=${() => setHv([r, c])} onFocus=${() => setHv([r, c])} onClick=${() => onPick(r, c)}></button>`;
    })}</div>
    <div class="tg-l">${hv[0] ? hv[0] + " hàng × " + hv[1] + " cột" : "Chọn kích thước bảng"}</div>
  </div>`;
}

// The address box opens under the selection.
function LinkBox({ ed, at, onClose }) {
  const cur = ed.getAttributes("link").href || "";
  const [v, setV] = useState(cur);
  const remove = () => { ed.chain().focus().extendMarkRange("link").unsetLink().run(); onClose(); };
  const apply = () => {
    const text = v.trim();
    if (!text) { if (cur) remove(); else onClose(); return; }
    let href = text;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[#/]/.test(href)) href = (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href) ? "mailto:" : "https://") + href;
    if (/^(javascript|data|vbscript|file):/i.test(href)) { toast("Địa chỉ liên kết không hợp lệ", "error"); return; }
    const c = ed.chain().focus();
    if (ed.state.selection.empty && !ed.isActive("link")) c.insertContent({ type: "text", text, marks: [{ type: "link", attrs: { href } }] }).run();
    else c.extendMarkRange("link").setLink({ href }).run();
    onClose();
  };
  return html`<${Popover} open=${true} at=${at} onClose=${onClose} cls="menu sc-linkpop" role="dialog" label="Liên kết" keepFocus>
    <div class="inline-input">
      <input ref=${focusOnce} value=${v} placeholder="Dán hoặc gõ địa chỉ liên kết…" aria-label="Địa chỉ liên kết"
        onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (isEnter(e)) { e.preventDefault(); apply(); } }} />
      <button type="button" class="btn btn-primary btn-xxs" onClick=${apply}>Áp dụng</button>
    </div>
    ${cur && html`<div class="row gap10" style="margin-top:8px;padding:0 4px;font-size:12.5px">
      <a class="ell grow" href=${cur} target="_blank" rel="noopener noreferrer">${cur}</a>
      <button type="button" class="link" style="font-size:12.5px;color:var(--s-fix)" onClick=${remove}>Gỡ liên kết</button>
    </div>`}
  </${Popover}>`;
}

export function Toolbar({ ed, onComment, onImage }) {
  const [open, setOpen] = useState(null); // which dropdown
  const [link, setLink] = useState(null); // where the link box opens
  const refs = useRef({}).current;
  const ref = (k) => refs[k] || (refs[k] = { current: null });
  const close = () => setOpen(null);
  const run = (fn) => () => { if (ed) fn(ed.chain().focus()).run(); };
  const pick = (fn) => () => { close(); run(fn)(); };
  const act = (name, attrs) => !!ed && ed.isActive(name, attrs);

  const openLink = () => {
    if (!ed) return;
    setOpen(null);
    let at;
    try { const c = ed.view.coordsAtPos(ed.state.selection.from); at = { x: c.left, y: c.bottom + 4 }; } catch (_) {}
    if (!at) { const r = ref("link").current.getBoundingClientRect(); at = { x: r.left, y: r.bottom + 4 }; }
    setLink(at);
  };
  useEffect(() => { openLinkBox = openLink; return () => { if (openLinkBox === openLink) openLinkBox = null; }; });

  const blk = currentBlock(ed);
  const ts = ed ? ed.getAttributes("textStyle") : {};
  const fs = parseFloat(ts.fontSize) || null;
  const size = fs || BASE_SIZE[blk];
  const stepSize = (d) => {
    const next = d > 0 ? SIZES.find((s) => s > size) : [...SIZES].reverse().find((s) => s < size);
    if (next) run((c) => c.setFontSize(next + "px"))();
  };
  const font = FONTS.find(([v]) => v && fontName(v) === fontName(ts.fontFamily));
  const markColor = ed ? ed.getAttributes("highlight").color : null;
  const align = (ALIGNS.find(([a]) => act({ textAlign: a })) || ALIGNS[0])[0];
  const spacing = ed ? ed.getAttributes(blk[0] === "h" ? "heading" : "paragraph").lineHeight || null : null;
  const inTable = act("table");
  const can = (fn) => { try { return !!ed && fn(ed.can()); } catch (_) { return false; } };

  // The groups wrap onto a second row when the column is narrow; the first
  // group of each row drops its separator.
  const bar = useRef(null);
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return undefined;
    const mark = () => { let top = null; [...el.children].forEach((g) => { g.classList.toggle("rs", g.offsetTop !== top); top = g.offsetTop; }); };
    mark();
    const ro = new ResizeObserver(mark);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tb = (label, on, fn, title, disabled) => html`<button type="button" class=${"tb" + (typeof label === "string" && label.length > 1 ? "" : " ic") + (on ? " on" : "")}
    title=${title} aria-label=${title} aria-pressed=${on ? "true" : "false"} disabled=${!ed || disabled} onMouseDown=${keep} onClick=${fn}>${label}</button>`;
  const drop = (k, label, title, menu, body, caret = true) => html`
    <button type="button" ref=${ref(k)} class=${"tb" + (open === k ? " on" : "")} title=${title} aria-label=${title} aria-haspopup="menu" aria-expanded=${open === k}
      disabled=${!ed} onMouseDown=${keep} onClick=${() => setOpen(open === k ? null : k)}>${label}${caret && html`<span class="tb-caret">▾</span>`}</button>
    <${Menu} open=${open === k} onClose=${close} anchorRef=${ref(k)} keepFocus ...${menu}>${open === k && body()}</${Menu}>`;

  return html`<div class="sc-toolbar"><div ref=${bar}>
    <div class="tb-g">
      ${tb(html`<${Ic} n="undo" />`, false, run((c) => c.undo()), "Hoàn tác (" + key("Z") + ")", !can((c) => c.undo()))}
      ${tb(html`<${Ic} n="redo" />`, false, run((c) => c.redo()), "Làm lại (" + key("Z", 1) + ")", !can((c) => c.redo()))}
    </div>
    <div class="tb-g">
      ${drop("block", html`<span class="tb-lbl">${(BLOCKS.find((b) => b[0] === blk) || BLOCKS[0])[1]}</span>`, "Kiểu đoạn", { width: 230 },
        () => BLOCKS.map(([k, l, fn]) => html`<${MenuItem} check=${k === blk} onClick=${pick(fn)}>${l}</${MenuItem}>`))}
      ${drop("font", html`<span class="tb-lbl" style=${font ? "font-family:" + font[0] : ""}>${font ? font[1] : "Phông chữ"}</span>`, "Phông chữ", { width: 220 },
        () => FONTS.map(([v, l]) => html`<${MenuItem} check=${v ? font && font[0] === v : !font} onClick=${pick((c) => (v ? c.setFontFamily(v) : c.unsetFontFamily()))}><span style=${v ? "font-family:" + v : ""}>${l}</span></${MenuItem}>`))}
    </div>
    <div class="tb-g">
      ${tb("−", false, () => stepSize(-1), "Giảm cỡ chữ", size <= SIZES[0])}
      ${drop("size", html`<span class="tb-size">${String(size).replace(".", ",")}</span>`, "Cỡ chữ", { width: 150, maxHeight: 380 },
        () => [html`<${MenuItem} check=${!fs} onClick=${pick((c) => c.unsetFontSize())}>Mặc định</${MenuItem}>`, html`<div class="menu-sep"></div>`,
          ...SIZES.map((s) => html`<${MenuItem} check=${fs === s} onClick=${pick((c) => c.setFontSize(s + "px"))}>${s}</${MenuItem}>`)], false)}
      ${tb("+", false, () => stepSize(1), "Tăng cỡ chữ", size >= SIZES[SIZES.length - 1])}
    </div>
    <div class="tb-g">
      ${tb(html`<b>B</b>`, act("bold"), run((c) => c.toggleBold()), "Đậm (" + key("B") + ")")}
      ${tb(html`<i>I</i>`, act("italic"), run((c) => c.toggleItalic()), "Nghiêng (" + key("I") + ")")}
      ${tb(html`<u>U</u>`, act("underline"), run((c) => c.toggleUnderline()), "Gạch chân (" + key("U") + ")")}
      ${tb(html`<${Ic} n="strike" />`, act("strike"), run((c) => c.toggleStrike()), "Gạch ngang (" + key("S", 1) + ")")}
      ${drop("color", html`<span class="tb-a">A<i style=${"background:" + (ts.color || "var(--tx)")}></i></span>`, "Màu chữ", { width: 220 },
        () => html`<${Swatches} colors=${TEXT_COLORS} value=${ts.color} none="Màu mặc định" custom
          onPick=${(c) => { close(); run((x) => (c ? x.setColor(c) : x.unsetColor()))(); }} />`, false)}
      ${drop("mark", html`<span class="tb-a"><${Ic} n="marker" size=${15} /><i style=${"background:" + (markColor || "transparent")}></i></span>`, "Tô nền chữ (" + key("H", 1) + ")", { width: 220 },
        () => html`<${Swatches} colors=${MARK_COLORS} value=${markColor} none="Không tô"
          onPick=${(c) => { close(); run((x) => (c ? x.setHighlight({ color: c }) : x.unsetHighlight()))(); }} />`, false)}
    </div>
    <div class="tb-g">
      <button type="button" ref=${ref("link")} class=${"tb ic" + (act("link") ? " on" : "")} title=${"Liên kết (" + key("K") + ")"} aria-label="Liên kết" disabled=${!ed} onMouseDown=${keep} onClick=${openLink}><${Ic} n="link" /></button>
      ${tb(html`<${Ic} n="image" />`, false, onImage, "Chèn ảnh (hoặc dán / kéo thả ảnh vào)")}
      <button type="button" class="tb acc" disabled=${!ed} onMouseDown=${keep} onClick=${onComment}>Bình luận</button>
    </div>
    <div class="tb-g">
      ${drop("align", html`<${Ic} n=${align} />`, "Căn lề", { width: 220 },
        () => ALIGNS.map(([a, l, k]) => html`<${MenuItem} check=${a === align} hint=${a === align ? "" : key(k, 1)} onClick=${pick((c) => c.setTextAlign(a))}><${Ic} n=${a} />${l}</${MenuItem}>`))}
      ${drop("spacing", html`<${Ic} n="spacing" />`, "Giãn dòng", { width: 190 },
        () => [html`<div class="menu-title">Giãn dòng</div>`, ...SPACING.map(([v, l]) => html`<${MenuItem} check=${v === spacing}
          onClick=${pick((c) => c.updateAttributes("paragraph", { lineHeight: v }).updateAttributes("heading", { lineHeight: v }))}>${l}</${MenuItem}>`)])}
    </div>
    <div class="tb-g">
      ${tb(html`<${Ic} n="bullet" />`, act("bulletList"), run((c) => c.toggleBulletList()), "Danh sách dấu chấm (" + key("8", 1) + ")")}
      ${tb(html`<${Ic} n="ordered" />`, act("orderedList"), run((c) => c.toggleOrderedList()), "Danh sách đánh số (" + key("7", 1) + ")")}
      ${tb(html`<${Ic} n="check" />`, act("taskList"), run((c) => c.toggleTaskList()), "Checklist (" + key("9", 1) + ")")}
      ${tb(html`<${Ic} n="outdent" />`, false, () => shiftIndent(ed, -1), "Giảm thụt lề (" + key("[") + ")")}
      ${tb(html`<${Ic} n="indent" />`, false, () => shiftIndent(ed, 1), "Tăng thụt lề (" + key("]") + ")")}
    </div>
    <div class="tb-g">
      ${drop("table", html`<${Ic} n="table" />`, inTable ? "Bảng" : "Chèn bảng", { width: inTable ? 240 : 220 }, () => (inTable ? [
        html`<${MenuItem} onClick=${pick((c) => c.addRowBefore())}>Chèn hàng phía trên</${MenuItem}>`,
        html`<${MenuItem} onClick=${pick((c) => c.addRowAfter())}>Chèn hàng phía dưới</${MenuItem}>`,
        html`<${MenuItem} onClick=${pick((c) => c.addColumnBefore())}>Chèn cột bên trái</${MenuItem}>`,
        html`<${MenuItem} onClick=${pick((c) => c.addColumnAfter())}>Chèn cột bên phải</${MenuItem}>`,
        html`<div class="menu-sep"></div>`,
        html`<${MenuItem} onClick=${pick((c) => c.deleteRow())}>Xoá hàng</${MenuItem}>`,
        html`<${MenuItem} onClick=${pick((c) => c.deleteColumn())}>Xoá cột</${MenuItem}>`,
        html`<div class="menu-sep"></div>`,
        html`<${MenuItem} disabled=${!can((c) => c.mergeCells())} onClick=${pick((c) => c.mergeCells())}>Gộp ô</${MenuItem}>`,
        html`<${MenuItem} disabled=${!can((c) => c.splitCell())} onClick=${pick((c) => c.splitCell())}>Tách ô</${MenuItem}>`,
        html`<${MenuItem} onClick=${pick((c) => c.toggleHeaderRow())}>Bật/tắt hàng tiêu đề</${MenuItem}>`,
        html`<div class="menu-sep"></div>`,
        html`<${MenuItem} danger onClick=${pick((c) => c.deleteTable())}>Xoá bảng</${MenuItem}>`,
      ] : html`<${TableGrid} onPick=${(r, c) => pick((x) => x.insertTable({ rows: r, cols: c, withHeaderRow: r > 1 }))()} />`))}
      ${drop("more", html`<${IcMore} />`, "Định dạng khác", { width: 250 }, () => [
        html`<${MenuItem} check=${act("superscript")} hint=${key(".")} onClick=${pick((c) => c.toggleSuperscript())}>Chỉ số trên (x²)</${MenuItem}>`,
        html`<${MenuItem} check=${act("subscript")} hint=${key(",")} onClick=${pick((c) => c.toggleSubscript())}>Chỉ số dưới (x₂)</${MenuItem}>`,
        html`<${MenuItem} check=${act("code")} hint=${key("E")} onClick=${pick((c) => c.toggleCode())}>Mã / thông số nội dòng</${MenuItem}>`,
        html`<div class="menu-sep"></div>`,
        html`<${MenuItem} onClick=${pick((c) => c.setHorizontalRule())}>Đường kẻ ngang</${MenuItem}>`,
        html`<${MenuItem} hint=${key("\\")} onClick=${() => { close(); clearFormat(ed); }}>Xoá định dạng</${MenuItem}>`,
      ], false)}
      ${tb(html`<${Ic} n="clear" />`, false, () => clearFormat(ed), "Xoá định dạng (" + key("\\") + ")")}
    </div>
  </div>${link && ed && html`<${LinkBox} ed=${ed} at=${link} onClose=${() => setLink(null)} />`}</div>`;
}

// Size, alignment and the rest for the picture that is selected.
export function ImageBar({ ed, sid }) {
  const anchor = useRef(null);
  const [off, setOff] = useState(null); // dismissed for the image at this position
  const sel = ed && ed.state.selection;
  const node = sel && sel.node && sel.node.type.name === "image" ? sel.node : null;
  const pos = node ? sel.from : null;
  useEffect(() => { if (off != null && off !== pos) setOff(null); }, [pos]);
  let dom = null;
  try { dom = node ? ed.view.nodeDOM(pos) : null; } catch (_) {}
  anchor.current = dom ? dom.querySelector(".sc-img-box") || dom : null;
  const a = node ? node.attrs : {};
  const open = !!(node && a.id && anchor.current && off !== pos);
  const set = (attrs) => ed.chain().focus().updateAttributes("image", attrs).run();
  const btn = (label, on, fn, title, cls = "") => html`<button type="button" class=${"tb " + cls + (on ? " on" : "")} title=${title} aria-label=${title} onMouseDown=${keep} onClick=${fn}>${label}</button>`;
  return html`<${Popover} open=${open} onClose=${() => setOff(pos)} anchorRef=${anchor} cls="menu sc-imgbar" role="toolbar" label="Ảnh" keepFocus>
    ${open && html`
      ${[25, 50, 75, 100].map((w) => btn(w + "%", a.width === w, () => set({ width: w }), "Rộng " + w + "% trang"))}
      <div class="tb-sep"></div>
      ${btn(html`<${Ic} n="left" />`, a.align === "left", () => set({ align: "left" }), "Căn trái", "ic")}
      ${btn(html`<${Ic} n="center" />`, a.align === "center", () => set({ align: "center" }), "Căn giữa", "ic")}
      ${btn(html`<${Ic} n="right" />`, a.align === "right", () => set({ align: "right" }), "Căn phải", "ic")}
      <div class="tb-sep"></div>
      ${btn("Mô tả", !!a.alt, () => { const v = window.prompt("Mô tả ảnh (hiện khi ảnh không tải được):", a.alt || ""); if (v != null) set({ alt: v.trim().slice(0, 300) }); }, "Mô tả ảnh")}
      ${btn(html`<${Ic} n="open" />`, false, () => window.open(imageUrl(a.sid || sid, a.id), "_blank", "noopener"), "Mở ảnh gốc", "ic")}
      ${btn(html`<${Ic} n="trash" />`, false, () => ed.chain().focus().deleteSelection().run(), "Xoá ảnh", "ic danger")}
    `}
  </${Popover}>`;
}
