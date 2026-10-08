// Soạn kịch bản: Docs-like continuous text (TipTap), comments anchored to a
// passage, optimistic-concurrency autosave (409 → "bản mới hơn").

import { html, useState, useEffect, useRef, useReducer, isEnter } from "../lib.mjs";
import { S, set, go, toast, errMsg, guard, setScriptField, patchScriptLocal, projectById, deleteScript } from "../store.mjs";
import { SST, fmtAgo, paletteOf, thumbBg, p2 } from "../format.mjs";
import { Avatar, Seg, Menu, MenuItem, MoreMenu } from "../ui.mjs";
import { api, enc } from "../api.mjs";
import { openOverlay } from "../overlays.mjs";

// ---- TipTap (vendored UMD bundle → window.Tiptap) ----
let tiptapLoad = null;
function ensureTiptap() {
  if (window.Tiptap) return Promise.resolve(window.Tiptap);
  if (!tiptapLoad) {
    tiptapLoad = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "vendor/tiptap.min.js";
      el.onload = () => (window.Tiptap ? resolve(window.Tiptap) : reject(new Error("Thiếu bộ soạn thảo")));
      el.onerror = () => { tiptapLoad = null; reject(new Error("Không tải được trình soạn thảo")); };
      document.head.appendChild(el);
    });
  }
  return tiptapLoad;
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

// ---- autosave ----
let saveTimer = null;
let saving = null;
// `bodyHtml` is passed when the editor may be gone by the time this runs (a
// save still in flight when the screen closes).
async function saveNow(force, bodyHtml) {
  const s = S.script;
  const ed = window.__scEditor;
  if (!s || (!ed && bodyHtml == null)) return;
  if (S.scriptSave === "conflict" && !force) return;
  clearTimeout(saveTimer);
  const body = bodyHtml != null ? bodyHtml : ed.getHTML();
  if (saving) { await saving; if (S.script && S.script.id === s.id) return saveNow(force, body); return; }
  const rawTitle = S.script.title;
  const title = (rawTitle || "").trim() || "Kịch bản chưa đặt tên";
  set({ scriptSave: "saving" });
  saving = (async () => {
    try {
      const r = await api("/scripts/" + enc(s.id), { method: "PATCH", body: { title, body, baseVersion: S.script.version } });
      // Keep the saved body: the editor is rebuilt from S.script when the
      // script is reopened. The title only takes the server's form if it
      // wasn't edited further while this request was in flight.
      if (!S.script || S.script.id !== s.id) return; // another script was opened meanwhile
      patchScriptLocal({ version: r.version, updatedAt: r.updatedAt, updatedBy: r.updatedBy, updatedByName: r.updatedByName, body, ...(S.script.title === rawTitle ? { title: r.title } : {}) });
      if (S.scriptSave === "saving") set({ scriptSave: "saved", savedAt: new Date() });
    } catch (e) {
      if (!S.script || S.script.id !== s.id) return;
      if (e.status === 409) set({ scriptSave: "conflict", scriptConflict: e.body && e.body.script });
      else { set({ scriptSave: "error" }); toast(errMsg(e, "Chưa lưu được kịch bản"), "error"); }
    } finally { saving = null; }
  })();
  return saving;
}
function markDirty() {
  if (S.scriptSave === "conflict") return;
  set({ scriptSave: "dirty" });
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(), 900);
}
window.addEventListener("beforeunload", (e) => { if (S.scriptSave === "dirty" || S.scriptSave === "saving") { saveNow(); e.preventDefault(); } });

function useEditor(hostRef, script, rev, onSelect) {
  const [, tick] = useReducer((x) => x + 1, 0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!script) return undefined;
    let ed = null, dead = false;
    ensureTiptap().then((T) => {
      if (dead || !hostRef.current) return;
      ed = new T.Editor({
        element: hostRef.current,
        content: script.body || "",
        extensions: [
          T.StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true, defaultProtocol: "https" } }),
          T.TextStyleKit, T.Highlight.configure({ multicolor: true }), T.TextAlign.configure({ types: ["heading", "paragraph"] }),
          T.TableKit.configure({ table: { resizable: true, cellMinWidth: 60 } }), T.TaskList, T.TaskItem.configure({ nested: true }),
          T.Placeholder.configure({ placeholder: "Bắt đầu viết… Dùng “Cảnh” cho tiêu đề cảnh, “VO” cho lời bình." }),
          T.CharacterCount, commentMark(T),
        ],
        editorProps: { attributes: { class: "script-doc", spellcheck: "false" } },
        onUpdate: () => { markDirty(); tick(); },
        onSelectionUpdate: () => { tick(); onSelect(ed); },
        onTransaction: () => tick(),
      });
      window.__scEditor = ed;
      tick();
    }).catch((e) => setError(e.message));
    return () => {
      dead = true;
      if (ed) {
        // Unsaved edits stay with the script (a reopen shows them) and are flushed.
        if (["dirty", "saving", "conflict"].includes(S.scriptSave) && S.script && S.script.id === script.id) patchScriptLocal({ body: ed.getHTML() });
        if (S.scriptSave === "dirty" || S.scriptSave === "saving") saveNow();
        if (window.__scEditor === ed) window.__scEditor = null;
        // Destroy after the flush grabbed getHTML().
        setTimeout(() => ed.destroy(), 0);
      }
    };
  }, [script && script.id, rev]);
  return { ed: window.__scEditor, error };
}

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

export function Script() {
  const s = S.script;
  const [rev, setRev] = useState(0);
  const [active, setActive] = useState(null);
  const [filter, setFilter] = useState("open");
  const [draft, setDraft] = useState("");
  const [newThread, setNewThread] = useState(null);   // {from,to,quote}
  const [newText, setNewText] = useState("");
  const [blockMenu, setBlockMenu] = useState(false);
  const [projMenu, setProjMenu] = useState(false);
  const host = useRef(null);
  const titleRef = useRef(null);
  const blockBtn = useRef(null);
  const projBtn = useRef(null);

  const onSelect = (ed) => {
    const ids = [];
    try { ed.state.selection.$from.marks().forEach((m) => { if (m.type.name === "comment" && m.attrs.id) ids.push(m.attrs.id); }); } catch (_) {}
    if (ids.length) setActive(ids[ids.length - 1]);
  };
  const { ed, error } = useEditor(host, s && s.id === S.route.sid ? s : null, rev, onSelect);

  useEffect(() => { setActive(null); setNewThread(null); setDraft(""); }, [s && s.id]);
  useEffect(() => { const t = titleRef.current; if (t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; } }, [s && s.title, s && s.id]);

  if (!s || s.id !== S.route.sid) {
    return html`<div class="screen"><div class="page tight"><button type="button" class="back" onClick=${() => go({ name: "scripts" })}>← Kịch bản</button><div class="empty">Đang mở kịch bản…</div></div></div>`;
  }

  const project = s.projectId ? projectById(s.projectId) : null;
  const comments = s.comments || [];
  const roots = comments.filter((c) => !c.parentId);
  const repliesOf = (id) => comments.filter((c) => c.parentId === id);
  const openN = roots.filter((c) => !c.resolved).length;
  const threads = roots.filter((c) => filter === "all" || !c.resolved);
  const text = ed ? ed.state.doc.textBetween(0, ed.state.doc.content.size, " ") : "";
  const words = text.split(/\s+/).filter(Boolean).length;
  const saveLabel = { saved: "Đã lưu" + (S.savedAt ? " · " + p2(S.savedAt.getHours()) + ":" + p2(S.savedAt.getMinutes()) : ""), dirty: "Chưa lưu…", saving: "Đang lưu…", conflict: "Có bản mới hơn", error: "Lỗi lưu" }[S.scriptSave];
  const saveColor = { saved: "var(--s-ok)", dirty: "var(--tx-3)", saving: "var(--s-wait)", conflict: "var(--s-fix)", error: "var(--s-fix)" }[S.scriptSave];
  const cmd = (fn) => () => { if (ed) fn(ed.chain().focus()).run(); };

  // Resolved threads lose their highlight; the focused one gets a stronger one.
  const css = [
    ...roots.filter((c) => c.resolved).map((c) => `.script-doc .sc-comment[data-comment-id="${c.id}"]{background:none;border-bottom:none;cursor:text}`),
    active ? `.script-doc .sc-comment[data-comment-id="${active}"]{background:color-mix(in oklch,var(--s-wait) 40%,transparent)}` : "",
  ].join("");

  const startComment = () => {
    if (!ed) return;
    const { from, to } = ed.state.selection;
    if (from === to) { toast("Bôi đen đoạn văn cần bình luận trước", "error"); return; }
    setNewThread({ from, to, quote: ed.state.doc.textBetween(from, to, " ").slice(0, 500) });
    setNewText("");
    setTimeout(() => { const i = document.getElementById("scNewComment"); i && i.focus(); }, 0);
  };
  const submitThread = () => guard(async () => {
    const content = newText.trim();
    if (!content || !newThread) return;
    const c = await api("/scripts/" + enc(s.id) + "/comments", { method: "POST", body: { content, quote: newThread.quote } });
    if (ed) ed.chain().setTextSelection({ from: newThread.from, to: newThread.to }).setMark("comment", { id: c.id }).run();
    patchScriptLocal({ comments: [...(S.script.comments || []), c] });
    setNewThread(null); setNewText(""); setActive(c.id); setFilter("open");
    saveNow();
  }, "Không gửi được bình luận");
  const reply = (rootId) => guard(async () => {
    const content = draft.trim();
    if (!content) return;
    const c = await api("/scripts/" + enc(s.id) + "/comments", { method: "POST", body: { content, parentId: rootId } });
    patchScriptLocal({ comments: [...(S.script.comments || []), c] });
    setDraft("");
  }, "Không gửi được trả lời");
  const resolve = (c) => guard(async () => {
    const r = await api("/script-comments/" + enc(c.id), { method: "PATCH", body: { resolved: !c.resolved } });
    patchScriptLocal({ comments: S.script.comments.map((x) => (x.id === c.id ? { ...x, ...r } : x)) });
  });
  const removeThread = (c) => guard(async () => {
    if (!confirm("Xoá bình luận này?")) return;
    await api("/script-comments/" + enc(c.id), { method: "DELETE" });
    if (ed && !c.parentId) {
      // drop its anchor from the text too
      const { tr } = ed.state; const type = ed.schema.marks.comment;
      ed.state.doc.descendants((node, pos) => { node.marks.forEach((m) => { if (m.type === type && m.attrs.id === c.id) tr.removeMark(pos, pos + node.nodeSize, m); }); });
      ed.view.dispatch(tr);
    }
    patchScriptLocal({ comments: S.script.comments.filter((x) => x.id !== c.id && x.parentId !== c.id) });
  });
  const focusThread = (c) => {
    setActive(c.id);
    const el = host.current && host.current.querySelector(`[data-comment-id="${c.id}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const takeTheirs = () => {
    const theirs = S.scriptConflict;
    if (!theirs) return;
    patchScriptLocal({ ...theirs, comments: S.script.comments });
    set({ scriptSave: "saved", scriptConflict: null });
    setRev(rev + 1);
  };
  const keepMine = () => {
    const theirs = S.scriptConflict;
    if (theirs) patchScriptLocal({ version: theirs.version });
    set({ scriptSave: "dirty", scriptConflict: null });
    saveNow(true);
  };

  const blk = currentBlock(ed);
  const tb = (label, on, fn, title, style = "") => html`<button type="button" class=${"tb" + (on ? " on" : "")} title=${title} style=${style} onMouseDown=${(e) => e.preventDefault()} onClick=${fn}>${label}</button>`;

  return html`<div class="screen-split stack" data-screen-label="Soạn kịch bản">
    <style>${css}</style>
    <div style="flex:1;min-width:0;display:flex;flex-direction:column">
      <div class="sc-top">
        <button type="button" class="rv-crumb" style="flex:0 0 auto;max-width:none" onClick=${() => { saveNow(); go({ name: "scripts" }); }}>← Kịch bản</button>
        <div class="sc-saved"><div><span class="dot dot6" style=${`background:${saveColor}`}></span>${saveLabel}</div></div>
        <${Seg} opts=${Object.keys(SST).map((k) => [k, SST[k].label, html`<span class="dot dot6" style=${`background:${SST[k].c}`}></span>`])} value=${s.status} onPick=${(k) => setScriptField("status", k)} />
        ${project && html`<button type="button" class="btn btn-outline btn-sm" onClick=${() => openOverlay("share", { pid: project.id })}>Chia sẻ</button>`}
        <div style="position:relative;width:36px;height:36px;flex:0 0 auto"><${MoreMenu} cls="icon-btn flat" style="left:0;top:0"
          items=${[{ label: "Xoá kịch bản", danger: true, onClick: () => { if (confirm("Xoá kịch bản \"" + s.title + "\"?")) guard(async () => { clearTimeout(saveTimer); await deleteScript(s.id); go({ name: "scripts" }); }); } }]} /></div>
      </div>
      ${S.scriptSave === "conflict" && html`<div class="row gap12" style="padding:10px 28px;background:color-mix(in oklch,var(--s-fix) 12%,transparent);font-size:13px">
        <span class="grow">Có người vừa lưu bản mới hơn của kịch bản này.</span>
        <button type="button" class="btn btn-outline btn-xs" onClick=${takeTheirs}>Tải bản mới</button>
        <button type="button" class="btn btn-primary btn-xs" onClick=${keepMine}>Ghi đè bằng bản của tôi</button>
      </div>`}
      <div class="sc-toolbar"><div>
        <div style="position:relative">
          <button type="button" ref=${blockBtn} class="tb" onMouseDown=${(e) => e.preventDefault()} onClick=${() => setBlockMenu(!blockMenu)}>${(BLOCKS.find((b) => b[0] === blk) || BLOCKS[0])[1]} <span style="font-size:9px">▾</span></button>
          <${Menu} open=${blockMenu} onClose=${() => setBlockMenu(false)} anchorRef=${blockBtn} width=${220} keepFocus>
            ${BLOCKS.map(([k, l, fn]) => html`<${MenuItem} check=${k === blk} onClick=${() => { setBlockMenu(false); cmd(fn)(); }}>${l}</${MenuItem}>`)}
          </${Menu}>
        </div>
        <div class="tb-sep"></div>
        ${tb(html`<b>B</b>`, ed && ed.isActive("bold"), cmd((c) => c.toggleBold()), "Đậm (⌘B)")}
        ${tb(html`<i>I</i>`, ed && ed.isActive("italic"), cmd((c) => c.toggleItalic()), "Nghiêng (⌘I)")}
        ${tb(html`<u>U</u>`, ed && ed.isActive("underline"), cmd((c) => (c.toggleUnderline ? c.toggleUnderline() : c)), "Gạch chân (⌘U)")}
        ${tb("▍", ed && ed.isActive("highlight"), cmd((c) => c.toggleHighlight({ color: "#fff59d" })), "Tô sáng")}
        <div class="tb-sep"></div>
        ${tb("Danh sách", ed && ed.isActive("bulletList"), cmd((c) => c.toggleBulletList()), "Danh sách")}
        ${tb("Checklist", ed && ed.isActive("taskList"), cmd((c) => c.toggleTaskList()), "Checklist")}
        ${tb("Bảng", ed && ed.isActive("table"), () => ed && (ed.isActive("table") ? ed.chain().focus().deleteTable().run() : ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()), ed && ed.isActive("table") ? "Xoá bảng" : "Chèn bảng 3×3")}
        <div class="tb-sep"></div>
        <button type="button" class="tb acc" onMouseDown=${(e) => e.preventDefault()} onClick=${startComment}>Bình luận</button>
      </div></div>
      <div style="flex:1;min-height:0;overflow-y:auto" onClick=${(e) => { const el = e.target.closest && e.target.closest("[data-comment-id]"); if (el) { setActive(el.getAttribute("data-comment-id")); setFilter((f) => f); } }}>
        <div class="sc-doc-wrap">
          <div class="row gap10" style="font-size:13px;color:var(--tx-3);margin-bottom:18px;flex-wrap:wrap">
            <div style="position:relative">
              <button type="button" ref=${projBtn} class="sc-proj" onClick=${() => setProjMenu(!projMenu)}>
                <span style=${`width:18px;height:18px;border-radius:50%;background:${project ? thumbBg(...paletteOf(project)) : "var(--bg-3)"}`}></span>${project ? project.name : "Chưa gắn dự án"}
              </button>
              <${Menu} open=${projMenu} onClose=${() => setProjMenu(false)} anchorRef=${projBtn} width=${320} maxHeight=${360}>
                <div class="menu-title">Gắn vào dự án</div>
                ${S.projects.map((p) => html`<${MenuItem} check=${p.id === s.projectId} onClick=${() => { setProjMenu(false); setScriptField("projectId", p.id); }}><span class="ell">${p.name}</span></${MenuItem}>`)}
                ${s.projectId && html`<div class="menu-sep"></div><${MenuItem} onClick=${() => { setProjMenu(false); setScriptField("projectId", null); }}>Bỏ gắn dự án</${MenuItem}>`}
              </${Menu}>
            </div>
            <span>${words} từ · ~${Math.round(words / 2.6)} giây đọc</span>
          </div>
          <textarea ref=${titleRef} class="sc-title" rows="1" value=${s.title} placeholder="Tên kịch bản"
            onInput=${(e) => { patchScriptLocal({ title: e.target.value }); markDirty(); e.target.style.height = "auto"; e.target.style.height = e.target.scrollHeight + "px"; }}
            onKeyDown=${(e) => { if (isEnter(e)) { e.preventDefault(); ed && ed.commands.focus("start"); } }}></textarea>
          ${error && html`<div class="err">${error}</div>`}
          <div ref=${host}></div>
        </div>
      </div>
    </div>

    <aside class="sc-side">
      <div class="row gap12" style="padding:22px 22px 18px;border-bottom:1px solid var(--line)">
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.02em">Bình luận</div>
        <div class="grow"></div>
        <${Seg} cls="md" opts=${[["open", "Mở " + openN], ["all", "Tất cả " + roots.length]]} value=${filter} onPick=${setFilter} />
      </div>
      <div style="flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:2px">
        ${newThread && html`<div class="thread on" style="cursor:default">
          <div class="quote">${newThread.quote}</div>
          <div class="inline-input" style="height:auto;padding:6px 6px 6px 12px">
            <input id="scNewComment" value=${newText} placeholder="Bình luận về đoạn này…" onInput=${(e) => setNewText(e.target.value)}
              onKeyDown=${(e) => { if (isEnter(e)) { e.preventDefault(); submitThread(); } if (e.key === "Escape") setNewThread(null); }} />
            <button type="button" class="btn btn-primary btn-xxs" onClick=${submitThread}>Gửi</button>
          </div>
          <button type="button" class="link" style="font-size:12px;margin-top:8px" onClick=${() => setNewThread(null)}>Huỷ</button>
        </div>`}
        ${threads.map((c) => {
          const on = active === c.id;
          const reps = repliesOf(c.id);
          const mine = S.me && c.authorUserId === S.me.id;
          return html`<div class=${"thread" + (on ? " on" : "")} key=${c.id} onClick=${() => focusThread(c)}>
            ${c.quote && html`<div class="quote">${c.quote}</div>`}
            <div class="row" style="gap:9px">
              <${Avatar} user=${S.users[c.authorUserId]} name=${c.authorName} size=${24} />
              <div style="font-size:13.5px;font-weight:500" class="ell">${c.authorName}</div>
              <div style="font-size:12px;color:var(--tx-3);white-space:nowrap">${fmtAgo(c.createdAt, { suffix: false })}</div>
              <div class="grow"></div>
              <button type="button" title=${c.resolved ? "Mở lại" : "Đánh dấu xong"} class=${"check" + (c.resolved ? " done" : "")} onClick=${(e) => { e.stopPropagation(); resolve(c); }}>✓</button>
            </div>
            <div style=${`margin:8px 0 0 33px;font-size:14px;line-height:1.55;white-space:pre-wrap;color:${c.resolved ? "var(--tx-3)" : "var(--tx)"}`}>${c.content}</div>
            ${reps.length > 0 && html`<div class="replies" style="gap:10px">${reps.map((r) => html`<div>
              <div class="row gap8"><${Avatar} user=${S.users[r.authorUserId]} name=${r.authorName} size=${20} /><div style="font-size:13px;font-weight:500">${r.authorName}</div><div style="font-size:12px;color:var(--tx-3)">${fmtAgo(r.createdAt, { suffix: false })}</div></div>
              <div style="margin:4px 0 0 28px;font-size:13.5px;line-height:1.5;color:var(--tx-2);white-space:pre-wrap">${r.content}</div>
            </div>`)}</div>`}
            ${on && html`<div style="margin:12px 0 0 33px" onClick=${(e) => e.stopPropagation()}>
              <div class="inline-input">
                <input value=${draft} placeholder="Trả lời…" onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (isEnter(e)) { e.preventDefault(); reply(c.id); } }} />
                <button type="button" class="btn btn-primary btn-xxs" onClick=${() => reply(c.id)}>Gửi</button>
              </div>
              ${mine && html`<button type="button" class="link" style="font-size:12px;margin-top:8px" onClick=${() => removeThread(c)}>Xoá bình luận</button>`}
            </div>`}
          </div>`;
        })}
        ${threads.length === 0 && !newThread && html`<div style="padding:40px 12px;text-align:center;font-size:13.5px;color:var(--tx-3)">${roots.length ? "Không còn bình luận mở." : "Bôi đen một đoạn rồi bấm “Bình luận”."}</div>`}
      </div>
    </aside>
  </div>`;
}
