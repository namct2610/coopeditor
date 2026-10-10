// Entry: boot → (setup | login | app). The app is a vertical rail + one
// screen chosen by the hash route, with overlays and toasts on top.

import { html, render, useState, useEffect, useRef } from "./lib.mjs";
import {
  S, set, go, useStore, boot, retryBoot, login, onRoute, onWorkspaceReady, onLogout, onRouteChange,
  applyTheme, setPrefs, effectiveTheme, toast, errMsg,
} from "./store.mjs";
import { get, post } from "./api.mjs";
import { Avatar, Toasts, Spinner } from "./ui.mjs";
import { Overlays, openOverlay } from "./overlays.mjs";
import { startRealtime, stopRealtime, sendPresence } from "./realtime.mjs";
import { Hub } from "./screens/hub.mjs";
import { Project } from "./screens/project.mjs";
import { Review } from "./screens/review.mjs";
import { Calendar } from "./screens/calendar.mjs";
import { Scripts } from "./screens/scripts.mjs";
import { Script } from "./screens/script.mjs";
import { Prompter } from "./screens/prompter.mjs";
import { Settings } from "./screens/settings.mjs";

const SCREENS = { hub: Hub, project: Project, review: Review, calendar: Calendar, scripts: Scripts, script: Script, prompter: Prompter, settings: Settings };

function Rail() {
  const r = S.route.name;
  const nav = [
    ["hub", "Dự án", ["hub", "project", "review"]],
    ["calendar", "Lịch", ["calendar"]],
    S.caps.scripts && ["scripts", "Kịch bản", ["scripts", "script", "prompter"]],
  ].filter(Boolean);
  const unseen = Object.values(S.notif).reduce((a, b) => a + b, 0);
  const pendingReview = S.queue.length;
  return html`<nav class="rail" aria-label="Điều hướng chính">
    <button type="button" class="rail-logo" title="Coopeditor" onClick=${() => go({ name: "hub" })}><img src="brand/logo.png" alt="Coopeditor" /></button>
    <div class="rail-word" onClick=${() => go({ name: "hub" })}><span class="acc">Coop</span>editor</div>
    <div class="grow"></div>
    <div class="rail-nav">
      ${nav.map(([k, label, group]) => html`<button type="button" class=${"rail-item" + (group.includes(r) ? " on" : "")} onClick=${() => go({ name: k })} aria-current=${group.includes(r) ? "page" : undefined}>
        <span>${label}</span><div class="bar"></div>
        ${k === "hub" && pendingReview > 0 && html`<div class="badge" title=${pendingReview + " video chờ review"}>${pendingReview}</div>`}
      </button>`)}
    </div>
    <div class="grow"></div>
    <button type="button" class="theme-toggle" title="Đổi giao diện sáng / tối" aria-label="Đổi giao diện sáng / tối"
      onClick=${() => setPrefs({ theme: effectiveTheme() === "light" ? "dark" : "light" })}></button>
    <button type="button" class="rail-me" title=${(S.me && S.me.name) + " — cài đặt"} onClick=${() => go({ name: "settings" })}>
      <${Avatar} user=${S.me} size=${32} />
      ${unseen > 0 && html`<div class="notif" title=${unseen + " ghi chú mới ở dự án khác"}></div>`}
    </button>
  </nav>`;
}

function Shell() {
  const Screen = SCREENS[S.route.name] || Hub;
  return html`<div class="shell">
    <${Rail} />
    <main class="main"><${Screen} key=${S.route.name} /></main>
    <${Overlays} />
    <${Toasts} />
    ${S.updateBanner && html`<div class="banner"><span class="dot" style="background:var(--acc)"></span>Có bản cập nhật mới — đang tải lại…</div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
function Brand() {
  return html`<div class="auth-brand">
    <div class="mark"><img src="brand/logo.png" alt="" /></div>
    <div><div style="font-size:20px;font-weight:600;letter-spacing:-0.02em"><span style="color:var(--acc-tx)">Coop</span>editor</div>
    <div style="font-size:13px;color:var(--tx-3)">Review video, lịch lên sóng và kịch bản cho cả nhóm</div></div>
  </div>`;
}

function Login() {
  const [f, setF] = useState({ account: "", passwd: "", otp: "" });
  const [otp, setOtp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [oidc, setOidc] = useState(false);
  const first = useRef(null);
  useEffect(() => { get("/auth/oidc/enabled").then((r) => setOidc(!!(r && r.enabled))).catch(() => {}); }, []);
  useEffect(() => { first.current && first.current.focus(); }, [otp]);
  const offline = S.boot === "offline";
  const submit = async (e) => {
    e.preventDefault();
    if (busy || offline) return;
    if (!f.account || !f.passwd) { setError("Nhập tài khoản và mật khẩu"); return; }
    setBusy(true); setError("");
    try {
      const r = await login({ account: f.account.trim(), passwd: f.passwd, otp: otp ? f.otp.trim() : "" });
      if (r && r.needsOtp) {
        setOtp(true);
        setError(r.error || (r.otpInvalid ? "Mã OTP sai hoặc đã hết hạn — thử mã mới" : ""));
        setF({ ...f, otp: "" });
      }
    } catch (err) {
      setError(errMsg(err, "Đăng nhập thất bại"));
      if (otp) setF({ ...f, otp: "" });
    }
    setBusy(false);
  };
  return html`<div class="auth"><form class="auth-card" onSubmit=${submit}>
    <${Brand} />
    <div class="auth-h">${otp ? "Xác thực 2 bước" : "Đăng nhập"}</div>
    <div class="dim" style="margin-top:8px;font-size:14px;line-height:1.55">${otp ? "DSM yêu cầu mã OTP từ ứng dụng authenticator." : "Dùng tài khoản Synology DSM — quyền truy cập NAS đi theo tài khoản đó."}</div>
    <div class="auth-stack">
      ${otp
        ? html`<div class="dim" style="font-size:13.5px">Tài khoản: <b style="color:var(--tx);font-weight:500">${f.account}</b></div>
            <input ref=${first} class="input lg mono" inputmode="numeric" autocomplete="one-time-code" placeholder="6 chữ số" value=${f.otp} onInput=${(e) => setF({ ...f, otp: e.target.value })} style="letter-spacing:0.3em" />`
        : html`<input ref=${first} class="input lg" autocomplete="username" placeholder="Tài khoản DSM" value=${f.account} onInput=${(e) => setF({ ...f, account: e.target.value })} />
            <input class="input lg" type="password" autocomplete="current-password" placeholder="Mật khẩu" value=${f.passwd} onInput=${(e) => setF({ ...f, passwd: e.target.value })} />`}
    </div>
    ${offline && html`<div class="err" style="margin-top:18px;color:var(--s-wait)">Không kết nối được tới máy chủ${S.bootError ? " (" + S.bootError + ")" : ""}. Đang thử lại tự động — nếu vừa cài lại gói, đợi 30–60 giây.
      <button type="button" class="btn btn-outline btn-xs" style="margin-left:6px" onClick=${retryBoot}>Thử lại ngay</button></div>`}
    ${error && html`<div class="err" style="margin-top:18px">${error}</div>`}
    <div class="row gap12" style="margin-top:26px">
      ${otp && html`<button type="button" class="link" onClick=${() => { setOtp(false); setError(""); }}>Huỷ</button>`}
      ${!otp && oidc && html`<a class="link" href=${(location.port === "3000" ? location.protocol + "//" + location.hostname + ":4000" : "/api") + "/auth/oidc/start"}>Đăng nhập bằng SSO</a>`}
      <div class="grow"></div>
      <button type="submit" class="btn btn-primary" disabled=${busy || offline}>${busy ? "Đang xác thực…" : offline ? "Chờ kết nối…" : otp ? "Xác nhận" : "Đăng nhập"}</button>
    </div>
  </form></div>`;
}

// First run on a fresh NAS: the API's setup server serves /setup/*.
function Setup() {
  const st = S.setupStatus || {};
  const [f, setF] = useState({
    publicUrl: st.publicUrl || location.origin, dsmHost: st.dsmHost || "", dsmMountRoot: st.dsmMountRoot || "/volume1",
    dsmLibraryRoot: st.dsmLibraryRoot || "/", dsmDevLogin: false, dsmInsecure: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const field = (k, label, ph) => html`<label class="dim" for=${"setup-" + k}>${label}</label><input id=${"setup-" + k} class="input" value=${f[k]} placeholder=${ph} onInput=${(e) => setF({ ...f, [k]: e.target.value })} />`;
  const check = (k, label) => html`<div></div><label class="row gap10" style="cursor:pointer;font-size:14px"><input type="checkbox" checked=${f[k]} onChange=${(e) => setF({ ...f, [k]: e.target.checked })} style="accent-color:var(--acc);width:16px;height:16px" />${label}</label>`;
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await post("/setup/apply", { ...f, updater: st.updater ? { feedUrl: st.updater.feedUrl, pollIntervalSeconds: st.updater.pollIntervalSeconds } : undefined });
      setRestarting(true);
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try { const s = await get("/setup/status"); if (s && s.configured) { boot(); return; } } catch (_) {}
      }
      setError("Đã lưu nhưng máy chủ chưa trở lại sau 2 phút. Kiểm tra log gói Coopeditor trong DSM.");
    } catch (err) { setError(errMsg(err, "Không lưu được cấu hình")); }
    setBusy(false); setRestarting(false);
  };
  return html`<div class="auth"><form class="auth-card" style="max-width:640px" onSubmit=${submit}>
    <${Brand} />
    <div class="auth-h">Thiết lập lần đầu</div>
    <div class="dim" style="margin-top:8px;font-size:14px;line-height:1.55">Cấu hình lưu trong thư mục dữ liệu của gói, giữ nguyên khi nâng cấp. Có thể sửa sau trong Cài đặt → Hệ thống.</div>
    <div class="setup-grid">
      ${field("publicUrl", "URL truy cập", "https://nas.example.com:8686")}
      ${field("dsmHost", "DSM host", "https://nas.local:5001")}
      ${field("dsmMountRoot", "Thư mục gốc NAS", "/volume1")}
      ${field("dsmLibraryRoot", "Thư viện hiển thị", "/")}
      ${check("dsmInsecure", "DSM dùng chứng chỉ tự ký")}
      ${check("dsmDevLogin", "Đăng nhập thử không cần DSM (chỉ để test)")}
    </div>
    ${error && html`<div class="err" style="margin-top:18px">${error}</div>`}
    ${restarting && html`<div class="ok-msg row gap10" style="margin-top:18px"><${Spinner} size=${16} />Đã lưu. Máy chủ đang khởi động lại…</div>`}
    <div class="row" style="margin-top:26px"><div class="grow"></div><button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? "Đang lưu…" : "Lưu cấu hình"}</button></div>
  </form></div>`;
}

function App() {
  useStore();
  if (S.boot === "loading") {
    return html`<div class="boot"><div class="boot-mark"><img src="brand/logo.png" alt="" /></div><div class="boot-name"><span class="acc">Coop</span>editor</div><div class="boot-hint">Đang kết nối máy chủ…</div></div>`;
  }
  if (S.boot === "setup") return html`<${Setup} /><${Toasts} />`;
  if (S.boot === "login" || S.boot === "offline") return html`<${Login} /><${Toasts} />`;
  return html`<${Shell} />`;
}

// ---------------------------------------------------------------------------
// global keys
window.addEventListener("keydown", (e) => {
  // defaultPrevented: the script editor took ⌘K for a link
  if (S.boot !== "ready" || e.defaultPrevented) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openOverlay("palette"); }
});

// A tab left open across a NAS update reloads itself once the API reports a
// different build than the one this page was served with.
const BOOT_SHA = String(window.__BUILD_SHA || "unknown");
async function checkVersion() {
  try {
    const v = await get("/version");
    set({ version: v.version });
    const remote = String(v.sha || "");
    if (!remote || remote === "unknown" || BOOT_SHA === "unknown" || remote.slice(0, 12) === BOOT_SHA.slice(0, 12)) return;
    set({ updateBanner: true });
    setTimeout(() => { const u = new URL(location.href); u.searchParams.set("v", remote.slice(0, 12)); location.replace(u.toString()); }, 3000);
  } catch (_) {}
}
setInterval(checkVersion, 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.boot === "ready") checkVersion(); });

onWorkspaceReady(() => { startRealtime(); checkVersion(); });
onLogout(() => stopRealtime());
onRouteChange(() => sendPresence());

applyTheme();
render(html`<${App} />`, document.getElementById("app"));
boot();
