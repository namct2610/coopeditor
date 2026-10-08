// Cài đặt: Hồ sơ, Thành viên & quyền, Proxy & transcode, Cập nhật, Giao diện
// (+ Hệ thống for workspace owners: the runtime config the old UI exposed).

import { html, useState, useEffect, isEnter } from "../lib.mjs";
import { S, set, go, toast, errMsg, guard, logout, setPrefs, viewMode, fetchUpdateStatus, inviteMember } from "../store.mjs";
import { ROLE_LABEL, ROLE_OPTS, HUES, fmtBytes, fmtAgo } from "../format.mjs";
import { Avatar, Seg, Toggle, Spinner } from "../ui.mjs";
import { get, patch, del, enc } from "../api.mjs";

const SEC = [
  ["profile", "Hồ sơ", "Thông tin đồng bộ từ tài khoản DSM khi đăng nhập."],
  ["members", "Thành viên & quyền", "Ai được xem, ghi chú hoặc quản lý các dự án bạn sở hữu."],
  ["proxy", "Proxy & transcode", "Proxy HLS cho review mượt qua mạng. File gốc 4K luôn nằm nguyên trên NAS."],
  ["update", "Cập nhật", "Gói SPK đang cài trên Synology NAS."],
  ["look", "Giao diện", "Áp dụng cho tài khoản của bạn trên mọi thiết bị."],
  ["system", "Hệ thống", "Kết nối DSM, email, webhook và đăng nhập SSO. Chỉ chủ workspace thấy mục này."],
];

function useLoad(fn, deps) {
  const [st, setSt] = useState({ data: null, error: "", loading: true });
  const reload = async () => {
    setSt((s) => ({ ...s, loading: true }));
    try { setSt({ data: await fn(), error: "", loading: false }); }
    catch (e) { setSt({ data: null, error: errMsg(e), loading: false }); }
  };
  useEffect(() => { reload(); }, deps);
  return { ...st, reload, setData: (data) => setSt((s) => ({ ...s, data })) };
}

// ---------------------------------------------------------------------------
function Profile() {
  const me = S.me || {};
  const owned = S.projects.filter((p) => p.myRole === "owner").length;
  return html`
    <div class="row gap20" style="padding-bottom:32px;border-bottom:1px solid var(--line)">
      <${Avatar} user=${me} size=${72} />
      <div class="grow">
        <div style="font-size:19px;font-weight:600;letter-spacing:-0.015em">${me.name}</div>
        <div style="font-size:13.5px;color:var(--tx-3);margin-top:2px">${owned ? "Chủ " + owned + " dự án" : "Thành viên"} · ${me.role === "client" ? "khách" : "editor"}</div>
      </div>
    </div>
    <div class="form-grid" style="padding-top:32px">
      <div class="dim">Tên hiển thị</div><input class="input" value=${me.name || ""} readonly title="Đổi trong DSM" />
      <div class="dim">Email</div><input class="input" value=${me.email || "—"} readonly title="Đổi trong DSM" />
      <div class="dim">Phiên đăng nhập</div>
      <div class="row gap14"><span>${me.dsmUid != null ? "Tài khoản DSM" : "SSO"} · hết hạn sau 12 giờ</span><div class="grow"></div>
        <button type="button" class="btn btn-outline btn-sm" onClick=${() => logout()}>Đăng nhập lại</button></div>
    </div>
    <div class="note">Tên và email lấy từ DSM mỗi lần đăng nhập — đổi trong DSM Control Panel → User.</div>`;
}

// ---------------------------------------------------------------------------
function Members() {
  const ws = useLoad(() => get("/workspace/members"), []);
  const [inv, setInv] = useState({ name: "", role: "reviewer", pid: "" });
  const owned = S.projects.filter((p) => p.myRole === "owner");
  const pid = inv.pid || (owned[0] && owned[0].id) || "";
  const setRole = (uid, role) => guard(async () => {
    const r = await patch("/workspace/members/" + enc(uid), { role });
    toast(r.changed ? "Đã đổi quyền ở " + r.changed + " dự án" : "Không có dự án nào cần đổi");
    ws.reload();
  });
  const invite = () => guard(async () => {
    if (!inv.name.trim() || !pid) return;
    await inviteMember(pid, { dsmUsername: inv.name.trim(), role: inv.role });
    toast("Đã mời " + inv.name.trim());
    setInv({ ...inv, name: "" });
    ws.reload();
  }, "Không mời được");
  return html`
    ${S.caps.workspace && owned.length > 0 && html`<div class="row gap10" style="margin-bottom:28px;flex-wrap:wrap">
      <input class="input" style="flex:1;min-width:180px" placeholder="Tài khoản DSM, vd. lan.nguyen" value=${inv.name} onInput=${(e) => setInv({ ...inv, name: e.target.value })} onKeyDown=${(e) => isEnter(e) && invite()} />
      <select class="input" style="width:auto" value=${pid} onChange=${(e) => setInv({ ...inv, pid: e.target.value })} aria-label="Dự án">
        ${owned.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
      </select>
      <${Seg} opts=${ROLE_OPTS} value=${inv.role} onPick=${(r) => setInv({ ...inv, role: r })} />
      <button type="button" class="btn btn-primary" style="height:42px" onClick=${invite}>Mời</button>
    </div>`}
    ${ws.loading && !ws.data && html`<div class="muted">Đang tải…</div>`}
    ${ws.error && html`<div class="err">${ws.error}</div>`}
    ${ws.data && ws.data.members.map((m) => html`<div class="row gap14" style="padding:16px 0;border-bottom:1px solid var(--line)">
      <${Avatar} user=${m.user} size=${36} />
      <div class="grow" style="min-width:0">
        <div style="font-size:14.5px;font-weight:500">${m.user.name}${m.isMe ? html`<span class="muted" style="font-weight:400"> · bạn</span>` : ""}</div>
        <div style="font-size:12.5px;color:var(--tx-3)">${[m.user.email, m.projects ? m.projects + " dự án của bạn" : "chưa ở dự án nào của bạn", m.mixed ? "quyền khác nhau giữa các dự án" : ""].filter(Boolean).join(" · ")}</div>
      </div>
      ${m.isMe || m.role === "owner"
        ? html`<div style="font-size:13px;color:var(--tx-3)">${m.isMe ? "Chủ workspace" : ROLE_LABEL.owner}</div>`
        : m.projects > 0 && S.caps.workspace
          ? html`<${Seg} opts=${ROLE_OPTS} value=${m.mixed ? null : m.role} onPick=${(r) => setRole(m.user.id, r)} />`
          : html`<div style="font-size:13px;color:var(--tx-3)">${m.role ? ROLE_LABEL[m.role] : "—"}</div>`}
    </div>`)}
    <div class="note">Xem: chỉ phát video. Ghi chú: thêm ghi chú, vẽ trên khung. Quản lý: thêm nguồn, đổi trạng thái, đặt lịch, tạo proxy. Đổi quyền ở đây áp dụng cho mọi dự án bạn sở hữu mà người đó tham gia; quyền riêng từng dự án chỉnh trong “Chia sẻ”.</div>`;
}

// ---------------------------------------------------------------------------
function Proxy() {
  const settings = useLoad(() => get("/admin/proxy-settings"), []);
  const summary = useLoad(() => get("/proxy-storage-summary"), []);
  const runtime = useLoad(() => get("/transcode-runtime"), []);
  const [jobs, setJobs] = useState([]);
  const [cleaning, setCleaning] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => { try { const j = await get("/transcode-queue"); if (alive) setJobs(j); } catch (_) {} };
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const owner = S.caps.workspace;
  const st = settings.data || { hlsSegmentSeconds: 4, autoRungs: [] };
  const save = (body) => guard(async () => settings.setData(await patch("/admin/proxy-settings", body)), "Không lưu được cấu hình proxy");
  const toggleRung = (h, on) => save({ autoRungs: on ? [...st.autoRungs, h] : st.autoRungs.filter((x) => x !== h) });
  const sum = summary.data || {};
  const used = sum.totalBytes || 0;
  const cap = sum.diskTotalBytes || 0;
  const cleanOrphans = () => guard(async () => {
    if (!confirm("Xoá " + sum.orphanCount + " proxy không còn video gốc (" + fmtBytes(sum.orphanBytes) + ")? File trên NAS không bị động.")) return;
    setCleaning(true);
    try {
      const full = await get("/admin/proxy-storage?refresh=1");
      const orphans = (full.renditions || []).filter((r) => r.orphan);
      for (const r of orphans) await del("/renditions/" + enc(r.renditionId) + "/proxy");
      toast("Đã dọn " + orphans.length + " proxy mồ côi");
      summary.setData(await get("/proxy-storage-summary?refresh=1"));
    } finally { setCleaning(false); }
  });
  const rt = runtime.data;
  const TIERS = [[720, "720p", "~3.5 Mbps · H.264 · chất lượng phát mặc định"], [1080, "1080p", "~8 Mbps · cho người cần xem chi tiết"]];
  return html`
    <div class="set-label">Tự tạo proxy khi thêm nguồn</div>
    <div class="row gap20" style="padding:18px 0;border-bottom:1px solid var(--line)">
      <div class="mono" style="width:70px;font-size:15px;font-weight:500">Gốc</div>
      <div class="grow" style="font-size:13.5px;color:var(--tx-2)">Phát thẳng file trên NAS · không cần chờ, nhưng nặng mạng và cần codec trình duyệt đọc được</div>
      <div class="muted" style="font-size:12.5px">luôn có</div>
    </div>
    ${TIERS.map(([h, name, desc]) => html`<div class="row gap20" style="padding:18px 0;border-bottom:1px solid var(--line)">
      <div class="mono" style="width:70px;font-size:15px;font-weight:500">${name}</div>
      <div class="grow" style="font-size:13.5px;color:var(--tx-2)">${desc}</div>
      <${Toggle} label=${"Tự tạo " + name} on=${st.autoRungs.includes(h)} disabled=${!owner} onChange=${(on) => toggleRung(h, on)} />
    </div>`)}
    <div class="set-row">
      <div class="grow"><div class="t">Độ dài segment HLS</div><div class="d">Ngắn hơn: tua mượt hơn, nhiều file hơn. Áp dụng cho proxy tạo sau.</div></div>
      <${Seg} opts=${[[4, "4 giây"], [6, "6 giây"]]} value=${st.hlsSegmentSeconds} onPick=${(v) => owner && save({ hlsSegmentSeconds: v })} />
    </div>
    ${settings.data && !settings.data.persisted && owner && html`<div class="note" style="margin-top:10px">Máy chủ này cấu hình bằng biến môi trường — thay đổi chỉ giữ đến khi API khởi động lại.</div>`}
    <div style="padding:22px 0;border-bottom:1px solid var(--line)">
      <div class="row gap12" style="align-items:baseline;margin-bottom:12px">
        <div class="grow" style="font-size:14.5px;font-weight:500">${sum.backend === "minio" ? "Kho proxy (MinIO)" : "Cache proxy"}</div>
        <div class="mono" style="font-size:12.5px;color:var(--tx-2)">${summary.loading && !summary.data ? "…" : fmtBytes(used) + (cap ? " / " + fmtBytes(cap) : "")}</div>
      </div>
      <div class="meter"><div style=${`width:${cap ? Math.min(100, Math.max(1, (used / cap) * 100)) : used ? 100 : 0}%`}></div></div>
      <div class="row gap12" style="margin-top:16px">
        <div class="grow" style="font-size:13px;color:var(--tx-3)">${sum.orphanCount ? sum.orphanCount + " proxy mồ côi · " + fmtBytes(sum.orphanBytes) + " không còn nguồn gốc" : (sum.renditionCount || 0) + " proxy · không có proxy mồ côi"}${cap ? " · ổ còn trống " + fmtBytes(sum.diskFreeBytes) : ""}</div>
        ${owner && sum.orphanCount > 0 && html`<button type="button" class="btn btn-outline btn-sm" disabled=${cleaning} onClick=${cleanOrphans}>${cleaning ? "Đang dọn…" : "Dọn"}</button>`}
      </div>
    </div>
    <div class="set-label" style="margin:32px 0 8px">Hàng đợi transcode</div>
    ${rt && rt.canTranscode === false && html`<div class="err" style="padding:10px 0">${rt.message || "Worker chưa sẵn sàng để transcode."}</div>`}
    ${jobs.length === 0 && html`<div class="muted" style="font-size:13.5px;padding:14px 0;border-bottom:1px solid var(--line)">Không có job nào đang chạy.</div>`}
    ${jobs.map((j) => html`<div style="padding:14px 0;border-bottom:1px solid var(--line)">
      <div class="row gap10" style="align-items:baseline;margin-bottom:9px">
        <div class="grow ell" style="font-size:13.5px;font-weight:500">${j.assetTitle || j.renditionId}</div>
        <div style="font-size:12.5px;color:var(--tx-3)">proxy ${j.label}</div>
        <div class="mono" style="font-size:12px;color:var(--tx-2);width:40px;text-align:right">${j.progress}%</div>
      </div>
      <div style="height:3px;border-radius:2px;background:var(--line-2)"><div style=${`width:${j.progress}%;height:100%;border-radius:2px;background:var(--tx);transition:width 600ms ease`}></div></div>
    </div>`)}
    ${rt && html`<div class="note">Worker: ${rt.status || "—"}${rt.workers && rt.workers[0] ? " · " + [rt.workers[0].hwaccel || "CPU", rt.workers[0].codecLadder].filter(Boolean).join(" · ") : ""}</div>`}`;
}

// ---------------------------------------------------------------------------
function Update() {
  const owner = S.caps.workspace;
  const status = useLoad(() => (owner ? fetchUpdateStatus(false) : get("/version").then((v) => ({ local: v }))), []);
  const [checking, setChecking] = useState(false);
  const s = status.data || {};
  const local = s.local || {};
  const remote = s.remote;
  const latest = remote && remote.version ? remote.version : local.version;
  const notes = (s.updateAvailable && remote ? remote.changes : local.changes) || [];
  const recheck = async () => { setChecking(true); try { status.setData(await fetchUpdateStatus(true)); } catch (e) { toast(errMsg(e), "error"); } setChecking(false); };
  return html`
    <div class="card-box">
      <div class="row" style="align-items:flex-end;gap:32px;flex-wrap:wrap">
        <div><div style="font-size:12.5px;color:var(--tx-3);margin-bottom:6px">Đang chạy</div><div class="mono" style="font-size:30px;font-weight:500;letter-spacing:-0.02em">${local.version || "…"}</div></div>
        <div><div style="font-size:12.5px;color:var(--tx-3);margin-bottom:6px">Mới nhất</div><div class="mono" style=${`font-size:30px;font-weight:500;letter-spacing:-0.02em;color:${s.updateAvailable ? "var(--acc-tx)" : "var(--tx)"}`}>${status.loading && !status.data ? "…" : latest || "—"}</div></div>
        <div class="grow"></div>
        ${owner && html`<button type="button" class="btn btn-outline" disabled=${checking} onClick=${recheck}>${checking ? "Đang kiểm tra…" : "Kiểm tra lại"}</button>`}
        ${s.updateAvailable
          ? html`<a class="btn btn-primary" href="https://github.com/namct2610/coopeditor/releases/latest" target="_blank" rel="noopener">Tải bản ${latest}</a>`
          : status.data && html`<div class="row gap8" style="height:40px;font-size:13.5px;color:var(--s-ok)"><span class="dot" style="background:var(--s-ok)"></span>Đang dùng bản mới nhất</div>`}
      </div>
      <div style="height:1px;background:var(--line);margin:24px 0 18px"></div>
      <div style="font-size:13.5px;font-weight:500;margin-bottom:10px">${s.updateAvailable ? "Có gì mới trong " + latest : "Trong bản " + (local.version || "")}</div>
      ${(remote && s.updateAvailable ? remote.summary : local.summary) && html`<div style="font-size:13.5px;color:var(--tx-2);margin-bottom:10px;line-height:1.55">${s.updateAvailable ? remote.summary : local.summary}</div>`}
      <div style="display:flex;flex-direction:column;gap:8px">${notes.map((c) => html`<div class="row" style="gap:12px;font-size:13.5px;color:var(--tx-2);line-height:1.5;align-items:flex-start"><span class="muted">—</span>${c}</div>`)}</div>
      ${s.error && html`<div class="err" style="margin-top:12px">${s.error}</div>`}
    </div>
    ${s.packageFeed && html`<${FeedStatus} f=${s.packageFeed} local=${local.version} />`}
    <div class="note" style="padding-top:20px">Cập nhật trực tiếp trong DSM Package Center sau khi thêm nguồn gói
      <span class="mono dim">${location.origin + (location.port === "3000" ? "" : "/api")}/spkserver</span> (Settings → Package Sources). Dữ liệu dự án được giữ nguyên khi nâng cấp.</div>`;
}

// What DSM Package Center gets from this app's /spkserver source right now.
function FeedStatus({ f, local }) {
  const pct = f.mirror && f.mirror.size ? Math.floor((f.mirror.bytes / f.mirror.size) * 100) : 0;
  const localN = String(local || "").replace(/^(\d+\.\d+\.\d+)-(?:spk-)?rc(\d+)$/, "$1-$2");
  const num = (v) => (String(v || "").match(/\d+/g) || []).map(Number);
  const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  const newer = f.offered && cmp(f.offered, localN) > 0;
  let line, tone = "var(--tx-2)";
  if (f.error && !f.offered && !(f.mirror && f.mirror.name)) { line = "Không đọc được bản mới từ GitHub: " + f.error; tone = "var(--s-fix)"; }
  else if (f.mirror && f.mirror.state === "downloading") line = "Đang tải gói " + (f.tag || "") + " về NAS · " + pct + "% — nút Update hiện trong Package Center khi tải xong.";
  else if (f.mirror && f.mirror.state === "failed") { line = "Tải gói về NAS lỗi (" + f.mirror.failures + " lần): " + f.mirror.error + ". Sẽ thử lại, sau 3 lần thì Package Center tải thẳng từ GitHub."; tone = "var(--s-fix)"; }
  else if (f.mirror && f.mirror.state === "waiting") line = "Chuẩn bị tải gói " + (f.tag || "") + " về NAS…";
  else if (f.offered) { line = newer ? "Package Center sẽ thấy bản " + f.offered + " (" + f.tag + "). Mở Package Center → Cài đặt → Nguồn gói, hoặc bấm Làm mới, để hiện nút Update." : (cmp(f.offered, localN) < 0 ? "Bản đang chạy (" + localN + ") mới hơn bản phát hành trên GitHub (" + f.offered + ")." : "Package Center đang ở bản mới nhất (" + f.offered + ")."); tone = newer ? "var(--acc-tx)" : "var(--tx-2)"; }
  else line = "Nguồn gói chưa có bản cho kiến trúc " + (f.arch || "này") + ".";
  return html`<div class="card-box" style="margin-top:16px">
    <div class="row gap10" style="margin-bottom:8px"><div style="font-size:13.5px;font-weight:500">Nguồn gói Package Center</div><div class="grow"></div>
      <div class="mono muted" style="font-size:11.5px">${f.arch || ""}${f.via ? " · qua " + f.via : ""}${f.checkedAt ? " · " + fmtAgo(f.checkedAt) : ""}</div></div>
    <div style=${`font-size:13.5px;line-height:1.55;color:${tone}`}>${line}</div>
    ${f.mirror && f.mirror.state === "downloading" && html`<div class="meter" style="margin-top:10px"><div style=${`width:${Math.max(1, pct)}%`}></div></div>`}
    ${f.error && f.offered && html`<div class="muted" style="font-size:12px;margin-top:6px">Lần kiểm tra gần nhất lỗi (${f.error}) — đang dùng kết quả trước đó.</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
function Look() {
  const theme = S.prefs.theme || "dark";
  const hue = S.prefs.hue ?? 285;
  const themes = [["dark", "Tối", "#121211", "#242321", "#f2f0eb"], ["light", "Sáng", "#f4f2ed", "#ffffff", "#1a1917"], ["system", "Theo hệ thống", "linear-gradient(90deg,#121211 50%,#f4f2ed 50%)", "rgba(128,128,128,0.35)", "#8a867f"]];
  return html`
    <div style="font-size:14.5px;font-weight:500;margin-bottom:14px">Chế độ màu</div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:40px">
      ${themes.map(([k, label, pv, card, tx]) => html`<button type="button" class=${"theme-card" + (theme === k ? " on" : "")} onClick=${() => setPrefs({ theme: k })}>
        <div style=${`aspect-ratio:16/10;border-radius:10px;background:${pv};padding:12px;display:flex;flex-direction:column;gap:7px`}>
          <div style=${`width:40%;height:7px;border-radius:4px;background:${tx};opacity:0.85`}></div>
          <div style="flex:1;display:flex;gap:6px"><div style=${`flex:1;border-radius:6px;background:${card}`}></div><div style=${`flex:1;border-radius:6px;background:${card}`}></div></div>
        </div>
        <div class="row" style="gap:9px;margin:12px 4px 0;font-size:13.5px;font-weight:500">
          <span style=${`width:14px;height:14px;border-radius:50%;background:${theme === k ? "var(--acc)" : "transparent"};box-shadow:${theme === k ? "none" : "inset 0 0 0 1.5px var(--line-2)"}`}></span>${label}
        </div>
      </button>`)}
    </div>
    <div class="set-row" style="border-top:1px solid var(--line)">
      <div class="grow"><div class="t">Màu nhấn</div><div class="d">Đầu đọc, lựa chọn, liên kết.</div></div>
      <div class="row gap14">${HUES.map(([name, h]) => html`<button type="button" title=${name} aria-label=${name} class=${"hue" + (hue === h ? " on" : "")} style=${`background:oklch(0.66 0.16 ${h})`} onClick=${() => setPrefs({ hue: h })}></button>`)}</div>
    </div>
    <div class="set-row">
      <div class="grow"><div class="t">Hiển thị video mặc định</div><div class="d">Trong danh sách dự án và chi tiết dự án.</div></div>
      <${Seg} opts=${[["grid", "Lưới"], ["list", "Danh sách"]]} value=${S.prefs.defaultView || "grid"} onPick=${(v) => { set({ view: null }); setPrefs({ defaultView: v }); }} />
    </div>`;
}

// ---------------------------------------------------------------------------
const SYS_FIELDS = [
  ["NAS & DSM", [["publicUrl", "URL truy cập", "https://nas.example.com:8686"], ["dsmHost", "DSM host", "https://nas.local:5001"], ["dsmMountRoot", "Thư mục gốc NAS", "/volume1"], ["dsmLibraryRoot", "Thư viện hiển thị", "/"]]],
  ["Email thông báo", [["smtp.url", "SMTP URL", "smtps://user:pass@smtp.example.com:465"], ["smtp.from", "Người gửi", "Coopeditor <no-reply@example.com>"]]],
  ["Webhook", [["webhooks.slackWebhookUrl", "Slack", "https://hooks.slack.com/…"], ["webhooks.discordWebhookUrl", "Discord", "https://discord.com/api/webhooks/…"]]],
  ["Đăng nhập SSO (OIDC)", [["oidc.issuerUrl", "Issuer URL", "https://accounts.google.com"], ["oidc.clientId", "Client ID", ""], ["oidc.clientSecret", "Client secret", ""], ["oidc.redirectUri", "Redirect URI", location.origin + "/api/auth/oidc/callback"]]],
];
const getPath = (o, p) => p.split(".").reduce((x, k) => (x ? x[k] : undefined), o);
function System() {
  const cfg = useLoad(() => get("/admin/runtime-config"), []);
  const [dirty, setDirty] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const config = cfg.data && cfg.data.config;
  if (!S.caps.workspace) return html`<div class="muted">Chỉ chủ workspace xem được mục này.</div>`;
  if (cfg.loading && !cfg.data) return html`<${Spinner} />`;
  if (cfg.error) return html`<div class="err">${cfg.error}</div>`;
  if (!config || !Object.keys(config).length) return html`<div class="note" style="margin-top:0">Máy chủ này được cấu hình bằng biến môi trường (.env / Docker), không chỉnh được từ giao diện.</div>`;
  const val = (k) => (k in dirty ? dirty[k] : getPath(config, k) ?? "");
  const save = async () => {
    const body = {};
    for (const [k, v] of Object.entries(dirty)) {
      const [a, b] = k.split(".");
      if (b) body[a] = { ...(body[a] || {}), [b]: v }; else body[a] = v;
    }
    setSaving(true); setMsg("");
    try { await patch("/admin/runtime-config", body); setDirty({}); setMsg("Đã lưu — áp dụng ngay, không cần khởi động lại."); cfg.reload(); }
    catch (e) { toast(errMsg(e), "error", 6000); }
    setSaving(false);
  };
  return html`
    ${SYS_FIELDS.map(([title, fields]) => html`<div style="margin-bottom:36px">
      <div class="set-label">${title}</div>
      <div class="form-grid" style="gap:12px 24px">${fields.map(([k, label, ph]) => html`
        <label class="dim" for=${"cfg-" + k}>${label}</label>
        <input id=${"cfg-" + k} class="input" value=${val(k)} placeholder=${ph} type=${/secret/i.test(k) ? "password" : "text"} autocomplete="off"
          onInput=${(e) => setDirty({ ...dirty, [k]: e.target.value })} />`)}</div>
    </div>`)}
    <div class="row gap12">
      <button type="button" class="btn btn-primary" disabled=${saving || !Object.keys(dirty).length} onClick=${save}>${saving ? "Đang lưu…" : "Lưu thay đổi"}</button>
      ${Object.keys(dirty).length > 0 && html`<button type="button" class="link" onClick=${() => setDirty({})}>Huỷ</button>`}
      ${msg && html`<span class="ok-msg">${msg}</span>`}
    </div>
    <div class="note">Mật khẩu/secret hiển thị “***” nghĩa là đã lưu — để nguyên nếu không đổi.</div>`;
}

const BODY = { profile: Profile, members: Members, proxy: Proxy, update: Update, look: Look, system: System };

export function Settings() {
  const sections = SEC.filter(([k]) => k !== "system" || S.caps.workspace);
  const sec = sections.find((x) => x[0] === S.route.sec) || sections[0];
  const Body = BODY[sec[0]];
  return html`<div class="screen-split" data-screen-label="Cài đặt">
    <div class="set-nav">
      <div class="set-title">Cài đặt</div>
      <div style="display:flex;flex-direction:column;gap:2px">
        ${sections.map(([k, label]) => html`<button type="button" class=${"set-item" + (k === sec[0] ? " on" : "")} onClick=${() => go({ name: "settings", sec: k })}>${label}</button>`)}
      </div>
      <div class="grow"></div>
      <div class="mono" style="padding:0 12px;font-size:11px;color:var(--tx-3);margin-bottom:14px">COOPEDITOR ${S.version || ""} · SPK</div>
      <button type="button" class="set-item" style="color:var(--tx-3)" onClick=${() => logout()}>Đăng xuất</button>
    </div>
    <div class="screen">
      <div class="set-body">
        <div class="set-h">${sec[1]}</div>
        <div class="set-sub">${sec[2]}</div>
        <${Body} key=${sec[0]} />
      </div>
    </div>
  </div>`;
}
