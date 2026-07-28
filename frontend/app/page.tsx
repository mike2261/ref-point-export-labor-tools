"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { Portal } from "./portal";

export type Role = "SUPER_ADMIN" | "USER";
export type User = {
  id: string;
  fullName: string;
  phone: string;
  role: Role;
  referralCode: string;
  isActive: boolean;
  requiresPasswordChange: boolean;
  createdAt: string;
};
type ZaloHelp = {
  configured: boolean;
  zaloUrl: string | null;
  zaloQrValue: string | null;
  phone: string | null;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8787";
const FALLBACK_ZALO_URL = "https://zalo.me/0971716939";
const FALLBACK_ZALO_PHONE = "0971716939";

export async function api<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error || "Không thể xử lý yêu cầu"), { status: response.status, body });
  return body as T;
}

export default function Home() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem("xkld_token");
    if (!saved) { window.setTimeout(() => setReady(true), 0); return; }
    api<{ user: User }>("/api/auth/me", {}, saved)
      .then(({ user }) => { setToken(saved); setUser(user); })
      .catch(() => window.localStorage.removeItem("xkld_token"))
      .finally(() => setReady(true));
  }, []);

  function signedIn(nextToken: string, nextUser: User) {
    window.localStorage.setItem("xkld_token", nextToken);
    setToken(nextToken); setUser(nextUser);
  }

  function signOut() {
    window.localStorage.removeItem("xkld_token");
    setToken(null); setUser(null);
  }

  if (!ready) return <div className="splash"><div className="brand-mark">XK</div><span>Đang mở hệ thống…</span></div>;
  if (!user || !token) return <Login onSuccess={signedIn} onForgot={() => setForgotOpen(true)} forgotOpen={forgotOpen} closeForgot={() => setForgotOpen(false)} />;
  if (user.requiresPasswordChange) return <ForcedPasswordChange token={token} user={user} onDone={signOut} />;
  return <Portal token={token} user={user} onSignOut={signOut} />;
}

function Login({ onSuccess, onForgot, forgotOpen, closeForgot }: {
  onSuccess: (token: string, user: User) => void; onForgot: () => void; forgotOpen: boolean; closeForgot: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [fullName, setFullName] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ref = new URLSearchParams(window.location.search).get("ref");
    if (ref) window.setTimeout(() => { setReferralCode(ref); setRegistering(true); }, 0);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setLoading(true);
    try {
      const result = await api<{ user: User; token: string; requiresPasswordChange?: boolean }>(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", body: JSON.stringify(registering ? { fullName, phone, password, referralCode } : { phone, password }),
      });
      onSuccess(result.token, { ...result.user, requiresPasswordChange: Boolean(result.requiresPasswordChange || result.user.requiresPasswordChange) });
    } catch (err) { setError(err instanceof Error ? err.message : "Đăng nhập không thành công"); }
    finally { setLoading(false); }
  }

  return <main className="auth-page">
    <section className="auth-story">
      <div className="brand"><span className="brand-mark">XK</span><div><strong>Điểm thưởng CTV</strong><small>Hệ thống XKLĐ</small></div></div>
      <div className="story-copy">
        <span className="eyebrow">Dành cho cộng tác viên</span>
        <h1>Theo dõi hành trình,<br/>ghi nhận đúng đóng góp.</h1>
        <p>Đơn hàng, khách hàng và điểm thưởng của bạn được quản lý rõ ràng trong một nơi.</p>
      </div>
      <div className="security-note"><span className="dot"/>Thông tin tài khoản được bảo vệ và đối soát theo từng giao dịch.</div>
    </section>
    <section className="auth-panel">
      <form className="login-card" onSubmit={submit}>
        <div className="mobile-brand"><span className="brand-mark">XK</span><strong>Điểm thưởng CTV</strong></div>
        <span className="eyebrow blue">{registering ? "THAM GIA MẠNG LƯỚI CTV" : "CHÀO MỪNG TRỞ LẠI"}</span>
        <h2>{registering ? "Đăng ký tài khoản" : "Đăng nhập tài khoản"}</h2>
        <p className="muted">{registering ? "Tạo tài khoản bằng mã giới thiệu của người mời." : "Nhập số điện thoại đã đăng ký để tiếp tục."}</p>
        {registering && <label>Họ và tên<input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Nguyễn Văn A" required /></label>}
        <label>Số điện thoại<input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" placeholder="0xxxxxxxxx" required /></label>
        <label>Mật khẩu<div className="password-field"><input value={password} onChange={e => setPassword(e.target.value)} type={show ? "text" : "password"} placeholder="Nhập mật khẩu" required/><button type="button" onClick={() => setShow(!show)}>{show ? "Ẩn" : "Hiện"}</button></div></label>
        {registering && <label>Mã giới thiệu<input value={referralCode} onChange={e => setReferralCode(e.target.value)} placeholder="Nhập mã giới thiệu" required /></label>}
        {!registering && <button className="text-button forgot" type="button" onClick={onForgot}>Quên mật khẩu?</button>}
        {error && <div className="alert error">{error}</div>}
        <button className="primary" disabled={loading}>{loading ? "Đang xử lý…" : registering ? "Đăng ký" : "Đăng nhập"}</button>
        <p className="help-line">{registering ? "Đã có tài khoản?" : "Chưa có tài khoản?"} <button type="button" className="text-button" onClick={() => { setRegistering(!registering); setError(""); }}>{registering ? "Đăng nhập" : "Đăng ký"}</button></p>
        {!registering && <p className="help-line">Cần hỗ trợ? <button type="button" className="text-button" onClick={onForgot}>Liên hệ quản trị viên</button></p>}
      </form>
    </section>
    {forgotOpen && <ForgotPassword onClose={closeForgot}/>} 
  </main>;
}

function ForgotPassword({ onClose }: { onClose: () => void }) {
  const [help, setHelp] = useState<ZaloHelp | null>(null);
  useEffect(() => {
    api<ZaloHelp>("/api/auth/password-help")
      .then((value) => setHelp(value.configured ? value : { configured: true, zaloUrl: FALLBACK_ZALO_URL, zaloQrValue: FALLBACK_ZALO_URL, phone: FALLBACK_ZALO_PHONE }))
      .catch(() => setHelp({ configured: true, zaloUrl: FALLBACK_ZALO_URL, zaloQrValue: FALLBACK_ZALO_URL, phone: FALLBACK_ZALO_PHONE }));
  }, []);
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Quên mật khẩu">
    <div className="modal recovery-modal">
      <button className="close" onClick={onClose} aria-label="Đóng">×</button>
      <span className="step-chip">KHÔI PHỤC TÀI KHOẢN</span>
      <h2>Liên hệ Admin qua Zalo</h2>
      <p className="muted">Admin sẽ xác minh số điện thoại đã đăng ký và cấp mật khẩu tạm có hiệu lực trong 15 phút.</p>
      <div className="recovery-grid">
        <div className="qr-box">
          {help?.zaloQrValue ? <QRCode value={help.zaloQrValue} size={154}/> : <div className="qr-placeholder">Mã Zalo<br/><small>chưa cấu hình</small></div>}
        </div>
        <div style={{ height: 190, borderRadius: 16, overflow: "hidden", background: "#eaded6" }}><img src="/team-photo.png" alt="Đội ngũ hỗ trợ XKLĐ" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center" }} /></div>
      </div>
      {help?.configured ? <>
        <a className="primary link" href={help.zaloUrl || `tel:${help.phone}`}>Mở Zalo của Admin</a>
        {help.phone && <div className="fallback">Không mở được Zalo? Số hỗ trợ: <strong>{help.phone}</strong></div>}
      </> : <div className="alert info">Thông tin Zalo đang chờ quản trị viên cấu hình. Vui lòng thử lại sau.</div>}
    </div>
  </div>;
}

function ForcedPasswordChange({ token, user, onDone }: { token: string; user: User; onDone: () => void }) {
  const [currentPassword, setCurrent] = useState("1-8");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage(""); setLoading(true);
    try {
      await api("/api/auth/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword, confirmPassword }) }, token);
      setMessage("Đổi mật khẩu thành công. Đang chuyển về đăng nhập…"); setTimeout(onDone, 1200);
    } catch (err) { setMessage(err instanceof Error ? err.message : "Không thể đổi mật khẩu"); }
    finally { setLoading(false); }
  }
  return <main className="center-page"><form className="change-card" onSubmit={submit}>
    <div className="status-icon">✓</div><span className="step-chip">XÁC MINH THÀNH CÔNG</span>
    <h1>Tạo mật khẩu mới</h1><p className="muted">Xin chào {user.fullName}. Bạn cần đổi mật khẩu tạm trước khi sử dụng hệ thống.</p>
    <label>Mật khẩu tạm<input type="password" value={currentPassword} onChange={e => setCurrent(e.target.value)} required /></label>
    <label>Mật khẩu mới<input type="password" value={newPassword} onChange={e => setNew(e.target.value)} minLength={8} placeholder="Tối thiểu 8 ký tự" required /></label>
    <label>Nhập lại mật khẩu mới<input type="password" value={confirmPassword} onChange={e => setConfirm(e.target.value)} minLength={8} required /></label>
    {message && <div className={`alert ${message.startsWith("Đổi") ? "success" : "error"}`}>{message}</div>}
    <button className="primary" disabled={loading}>{loading ? "Đang cập nhật…" : "Đổi mật khẩu"}</button>
    <button className="text-button" type="button" onClick={onDone}>Đăng xuất</button>
  </form></main>;
}

function AppShell({ token, user, onSignOut }: { token: string; user: User; onSignOut: () => void }) {
  const [view, setView] = useState(user.role === "SUPER_ADMIN" ? "users" : "account");
  return <div className="app-shell">
    <aside><div className="brand"><span className="brand-mark">XK</span><div><strong>Điểm thưởng CTV</strong><small>Hệ thống XKLĐ</small></div></div>
      <nav><button className={view === "account" ? "active" : ""} onClick={() => setView("account")}>Tài khoản</button>{user.role === "SUPER_ADMIN" && <button className={view === "users" ? "active" : ""} onClick={() => setView("users")}>Cộng tác viên</button>}<button onClick={() => setView("password")}>Đổi mật khẩu</button></nav>
      <div className="side-user"><span>{user.fullName.slice(0,1)}</span><div><b>{user.fullName}</b><small>{user.role === "SUPER_ADMIN" ? "Super Admin" : "Cộng tác viên"}</small></div></div>
    </aside>
    <main className="workspace"><header><div><small>HỆ THỐNG XKLĐ</small><h1>{view === "users" ? "Cộng tác viên" : view === "password" ? "Đổi mật khẩu" : "Tài khoản của tôi"}</h1></div><button className="outline" onClick={onSignOut}>Đăng xuất</button></header>
      {view === "users" && user.role === "SUPER_ADMIN" ? <AdminUsers token={token}/> : view === "password" ? <NormalPasswordChange token={token} onDone={onSignOut}/> : <Account user={user}/>} 
    </main>
  </div>;
}

function Account({ user }: { user: User }) {
  return <section className="content-card"><div className="profile-head"><span>{user.fullName.slice(0,1)}</span><div><h2>{user.fullName}</h2><p>{user.role === "SUPER_ADMIN" ? "Quản trị viên hệ thống" : "Cộng tác viên"}</p></div></div><div className="info-grid"><Info label="Số điện thoại" value={user.phone}/><Info label="Mã giới thiệu" value={user.referralCode}/><Info label="Trạng thái" value={user.isActive ? "Đang hoạt động" : "Tạm khóa"}/><Info label="Ngày tham gia" value={new Date(user.createdAt).toLocaleDateString("vi-VN")}/></div></section>;
}
function Info({ label, value }: { label: string; value: string }) { return <div className="info-item"><small>{label}</small><strong>{value}</strong></div>; }

function NormalPasswordChange({ token, onDone }: { token: string; onDone: () => void }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" }); const [message, setMessage] = useState("");
  async function submit(e: FormEvent) { e.preventDefault(); setMessage(""); try { await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(form) }, token); setMessage("Đổi mật khẩu thành công. Vui lòng đăng nhập lại."); setTimeout(onDone, 1200); } catch (err) { setMessage(err instanceof Error ? err.message : "Không thể đổi mật khẩu"); } }
  return <form className="content-card narrow" onSubmit={submit}><h2>Bảo mật tài khoản</h2><p className="muted">Mật khẩu mới phải có tối thiểu 8 ký tự.</p>{(["currentPassword","newPassword","confirmPassword"] as const).map((key, i) => <label key={key}>{["Mật khẩu hiện tại","Mật khẩu mới","Nhập lại mật khẩu mới"][i]}<input type="password" value={form[key]} minLength={key === "currentPassword" ? 1 : 8} onChange={e => setForm({ ...form, [key]: e.target.value })} required/></label>)}{message && <div className="alert">{message}</div>}<button className="primary">Cập nhật mật khẩu</button></form>;
}

function AdminUsers({ token }: { token: string }) {
  const [users, setUsers] = useState<User[]>([]); const [query, setQuery] = useState(""); const [loading, setLoading] = useState(true); const [reset, setReset] = useState<{ user: User; expiresAt: string } | null>(null); const [error, setError] = useState("");
  useEffect(() => { const timer = setTimeout(() => { setLoading(true); api<{ users: User[] }>(`/api/admin/users?q=${encodeURIComponent(query)}`, {}, token).then(x => setUsers(x.users)).catch(e => setError(e.message)).finally(() => setLoading(false)); }, 220); return () => clearTimeout(timer); }, [query, token]);
  const ctv = useMemo(() => users.filter(u => u.role === "USER"), [users]);
  async function resetPassword(target: User) { if (!window.confirm(`Đặt lại mật khẩu cho ${target.fullName}?`)) return; setError(""); try { const data = await api<{ expiresAt: string }>(`/api/admin/users/${target.id}/reset-password`, { method: "POST" }, token); setReset({ user: target, expiresAt: data.expiresAt }); } catch (e) { setError(e instanceof Error ? e.message : "Không thể đặt lại mật khẩu"); } }
  return <section><div className="toolbar"><div><h2>Danh sách CTV</h2><p className="muted">Xác minh qua Zalo trước khi đặt lại mật khẩu.</p></div><input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm tên hoặc số điện thoại"/></div>{error && <div className="alert error">{error}</div>}<div className="table-card"><table><thead><tr><th>Cộng tác viên</th><th>Số điện thoại</th><th>Trạng thái</th><th></th></tr></thead><tbody>{loading ? <tr><td colSpan={4}>Đang tải…</td></tr> : ctv.map(x => <tr key={x.id}><td><b>{x.fullName}</b><small>Mã GT: {x.referralCode}</small></td><td>{x.phone}</td><td><span className={`status ${x.requiresPasswordChange ? "waiting" : "ok"}`}>{x.requiresPasswordChange ? "Chờ đổi mật khẩu" : "Đang hoạt động"}</span></td><td><button className="outline danger" onClick={() => resetPassword(x)}>Đặt lại mật khẩu</button></td></tr>)}</tbody></table></div>{reset && <div className="modal-backdrop"><div className="modal reset-result"><button className="close" onClick={() => setReset(null)}>×</button><div className="status-icon">✓</div><h2>Đã tạo mật khẩu tạm</h2><p>CTV <strong>{reset.user.fullName}</strong> có thể đăng nhập bằng:</p><div className="temp-password">1-8</div><p className="muted">Hết hạn lúc {new Date(reset.expiresAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}. Sau khi đăng nhập, CTV bắt buộc tạo mật khẩu mới.</p><button className="primary" onClick={() => setReset(null)}>Đã hiểu</button></div></div>}</section>;
}
