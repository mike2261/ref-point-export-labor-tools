"use client";

import { FormEvent, ReactNode, useEffect, useState } from "react";
import { api, User } from "./page";

type Wallet = "F" | "G";
type Balances = { f: number; g: number; redemptionUnlocked: boolean };
type Order = {
  id: string; userId: string; note: string | null; status: "PENDING" | "APPROVED" | "REJECTED";
  decidedBy: string | null; decidedAt: string | null; createdAt: string;
};
type Ledger = {
  id: string; userId: string; wallet: Wallet; type: string; points: number;
  orderId: string | null; note: string | null; createdAt: string;
};

const labels: Record<string, string> = {
  REGISTRATION_BONUS: "Thưởng đăng ký",
  REFERRAL_SIGNUP_BONUS: "Thưởng giới thiệu",
  CUSTOMER_REWARD: "Thưởng khách hàng",
  CUSTOMER_REFERRAL_BONUS: "Thưởng giới thiệu khách hàng",
  MAINTENANCE_ACCRUAL: "Điểm duy trì hàng tháng",
  MAINTENANCE_RESET: "Reset chu kỳ duy trì",
  REDEMPTION: "Đổi điểm",
  PENDING: "Đang chờ",
  APPROVED: "Đã duyệt",
  REJECTED: "Từ chối",
};

function useResource<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = () => {
    setLoading(true); setError("");
    load().then(setData).catch((e) => setError(e instanceof Error ? e.message : "Không thể tải dữ liệu")).finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setTimeout(refresh, 0); return () => window.clearTimeout(timer); }, deps);
  return { data, error, loading, refresh };
}

export function Portal({ token, user, onSignOut }: { token: string; user: User; onSignOut: () => void }) {
  const admin = user.role === "SUPER_ADMIN";
  if (admin) return <AdminPortal token={token} user={user} onSignOut={onSignOut}/>;

  const items = [["overview", "Tổng quan"], ["referral", "Giới thiệu"], ["orders", "Đơn hàng của tôi"], ["ledger", "Sổ điểm của tôi"], ["redeem", "Đổi điểm"], ["account", "Tài khoản"]];
  const [view, setView] = useState("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const title = items.find(([id]) => id === view)?.[1] || "Tổng quan";

  return <div className="portal">
    <aside className={mobileNav ? "open" : ""}>
      <div className="brand"><span className="brand-mark">XK</span><div><strong>Điểm thưởng CTV</strong><small>Hệ thống XKLĐ</small></div></div>
      <nav>{items.map(([id, label]) => <button key={id} className={view === id ? "active" : ""} onClick={() => { setView(id); setMobileNav(false); }}>{label}</button>)}</nav>
      <div className="portal-user"><span>{user.fullName.slice(0, 1)}</span><div><b>{user.fullName}</b><small>Cộng tác viên</small></div></div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Đóng menu" onClick={() => setMobileNav(false)}/>}
    <main className="portal-main">
      <header><button className="menu-toggle" onClick={() => setMobileNav(true)}>☰</button><h1>{title}</h1><div className="head-user"><span>CTV</span><b>{user.fullName.slice(0, 1)}</b><button onClick={onSignOut}>Đăng xuất</button></div></header>
      <div className="portal-content">
        {view === "overview" && <CtvOverview token={token} user={user} go={setView}/>}
        {view === "referral" && <Referral user={user}/>}
        {view === "orders" && <MyOrders token={token}/>}
        {view === "ledger" && <LedgerPage token={token} admin={false}/>}
        {view === "redeem" && <CtvRedeem token={token}/>}
        {view === "account" && <Account user={user} token={token} onSignOut={onSignOut}/>}
      </div>
    </main>
  </div>;
}

const adminTitles: Record<string, string> = {
  users: "Quản lý cộng tác viên",
  orders: "Quản lý đơn hàng",
  ledger: "Lịch sử điểm",
  rewards: "Cộng thưởng / Trừ điểm",
  account: "Tài khoản Admin",
};

function AdminPortal({ token, user, onSignOut }: { token: string; user: User; onSignOut: () => void }) {
  const [view, setView] = useState("overview");
  const goHome = () => setView("overview");
  return <main className="admin-card-app">
    <div className="admin-card-wrap">
      {view === "overview" ? <AdminOverview token={token} user={user} go={setView} onSignOut={onSignOut}/> : <>
        <header className="admin-detail-head">
          <button className="admin-back" onClick={goHome} aria-label="Quay lại">←</button>
          <div><small>TRUNG TÂM QUẢN TRỊ</small><h1>{adminTitles[view]}</h1></div>
          <button className="admin-home" onClick={goHome}>Trang chủ</button>
        </header>
        <section className="admin-detail-card">
          {view === "users" && <AdminUsers token={token}/>}
          {view === "orders" && <AdminOrders token={token}/>}
          {view === "ledger" && <LedgerPage token={token} admin/>}
          {view === "rewards" && <AdminRewardCenter token={token}/>}
          {view === "account" && <Account user={user} token={token} onSignOut={onSignOut}/>}
        </section>
      </>}
    </div>
  </main>;
}

function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "error" | "success" }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}

function Stat({ title, value, note, onClick }: { title: string; value: string | number; note: string; onClick?: () => void }) {
  return <button className="stat-card" onClick={onClick} disabled={!onClick}><small>{title}</small><strong>{value}</strong><p>{note}</p></button>;
}

function CtvOverview({ token, user, go }: { token: string; user: User; go: (v: string) => void }) {
  const b = useResource(() => api<Balances>("/api/points/balances", {}, token), [token]);
  const o = useResource(() => api<{ orders: Order[]; total: number }>("/api/orders?limit=100", {}, token), [token]);
  if (b.loading || o.loading) return <p>Đang tải tổng quan…</p>;
  if (b.error || o.error) return <Notice kind="error">{b.error || o.error}</Notice>;
  const balances = b.data!;
  const orders = o.data?.orders || [];
  const pending = orders.filter(x => x.status === "PENDING").length;
  return <section>
    <p className="welcome">Xin chào, <strong>{user.fullName}</strong>.</p>
    <div className="stats-grid">
      <Stat title="Ví F — Cá nhân" value={balances.f} note="Điểm tích lũy dài hạn, không tự reset." onClick={() => go("ledger")}/>
      <Stat title="Ví G — Duy trì" value={balances.g} note="Cộng hàng tháng, theo chu kỳ 3 tháng." onClick={() => go("ledger")}/>
      <Stat title="Đơn đang chờ" value={pending} note="Đơn của bạn đang chờ Admin xử lý." onClick={() => go("orders")}/>
      <Stat title="Tổng đơn hàng" value={o.data?.total || 0} note="Tất cả đơn hàng đã tạo." onClick={() => go("orders")}/>
    </div>
    <div className={`unlock-banner ${balances.redemptionUnlocked ? "unlocked" : ""}`}>
      <div><strong>{balances.redemptionUnlocked ? "Đã mở khóa đổi điểm" : "Chưa mở khóa đổi điểm"}</strong>
      <p>{balances.redemptionUnlocked ? "Bạn đã có đơn khách hàng được duyệt và có thể liên hệ nhận thưởng." : "Bạn cần có khách hàng được Admin duyệt để đổi điểm."}</p></div>
      <button onClick={() => go("redeem")}>Xem điều kiện</button>
    </div>
  </section>;
}

function Referral({ user }: { user: User }) {
  const [copied, setCopied] = useState("");
  const link = `${window.location.origin}/?ref=${encodeURIComponent(user.referralCode)}`;
  const copy = async (text: string, key: string) => { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(""), 1500); };
  return <section className="panel narrow"><h2>Giới thiệu bạn bè</h2><p className="muted">Chia sẻ mã hoặc liên kết để mời cộng tác viên mới.</p>
    <label>Mã giới thiệu của bạn</label><div className="copy-row"><code>{user.referralCode}</code><button onClick={() => copy(user.referralCode, "code")}>{copied === "code" ? "Đã sao chép" : "Sao chép"}</button></div>
    <label>Link mời</label><div className="copy-row"><code>{link}</code><button onClick={() => copy(link, "link")}>{copied === "link" ? "Đã sao chép" : "Sao chép"}</button></div>
    <div className="ref-note"><strong>+2 điểm F</strong><span>cho mỗi CTV đăng ký thành công bằng mã của bạn.</span></div>
  </section>;
}

function MyOrders({ token }: { token: string }) {
  const orders = useResource(() => api<{ orders: Order[]; total: number }>("/api/orders?limit=100", {}, token), [token]);
  const [note, setNote] = useState(""); const [saving, setSaving] = useState(false); const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setSaving(true); setMessage("");
    try { await api("/api/orders", { method: "POST", body: JSON.stringify({ note }) }, token); setNote(""); setMessage("Đã tạo đơn, đang chờ Admin duyệt."); orders.refresh(); }
    catch (err) { setMessage(err instanceof Error ? err.message : "Không thể tạo đơn"); } finally { setSaving(false); }
  };
  return <section>
    <form className="panel order-form" onSubmit={submit}><h2>Tạo đơn hàng</h2><label>Ghi chú khách hàng (không bắt buộc)</label><textarea value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="VD: Khách hàng Nguyễn Văn A"/><button className="primary-action" disabled={saving}>{saving ? "Đang tạo…" : "Tạo đơn"}</button>{message && <Notice kind={message.startsWith("Đã") ? "success" : "error"}>{message}</Notice>}</form>
    {orders.error && <Notice kind="error">{orders.error}</Notice>}
    <DataTable headers={["Mã đơn", "Ngày tạo", "Ghi chú", "Trạng thái"]} rows={(orders.data?.orders || []).map(x => [
      <code key="id">{x.id.slice(0, 8).toUpperCase()}</code>, date(x.createdAt), x.note || "—", <Status key="s" value={x.status}/>
    ])} empty="Bạn chưa có đơn hàng nào."/>
  </section>;
}

function AdminOrders({ token }: { token: string }) {
  const [filter, setFilter] = useState("");
  const path = `/api/admin/orders?limit=100${filter ? `&status=${filter}` : ""}`;
  const orders = useResource(() => api<{ orders: Order[] }>(path, {}, token), [token, filter]);
  const decide = async (id: string, action: "approve" | "reject") => {
    if (!confirm(action === "approve" ? "Duyệt đơn và cộng điểm?" : "Từ chối đơn này?")) return;
    try { await api(`/api/admin/orders/${id}/${action}`, { method: "POST" }, token); orders.refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Không thể xử lý"); }
  };
  return <section><div className="filter-row"><select value={filter} onChange={e => setFilter(e.target.value)}><option value="">Tất cả</option><option value="PENDING">Đang chờ</option><option value="APPROVED">Đã duyệt</option><option value="REJECTED">Từ chối</option></select></div>
    {orders.error && <Notice kind="error">{orders.error}</Notice>}
    <DataTable headers={["Ngày tạo", "Người tạo", "Ghi chú", "Trạng thái", "Hành động"]} rows={(orders.data?.orders || []).map(x => [
      date(x.createdAt), <code key="u">{x.userId.slice(0, 8)}</code>, x.note || "—", <Status key="s" value={x.status}/>,
      x.status === "PENDING" ? <div className="action-row" key="a"><button className="approve" onClick={() => decide(x.id, "approve")}>Duyệt</button><button className="reject" onClick={() => decide(x.id, "reject")}>Từ chối</button></div> : "—"
    ])} empty="Không có đơn phù hợp."/>
  </section>;
}

function LedgerPage({ token, admin }: { token: string; admin: boolean }) {
  const [wallet, setWallet] = useState("");
  const path = `${admin ? "/api/admin/ledger" : "/api/points/ledger"}?limit=100${wallet ? `&wallet=${wallet}` : ""}`;
  const ledger = useResource(() => api<{ entries: Ledger[] }>(path, {}, token), [token, wallet, admin]);
  return <section><div className="filter-row"><select value={wallet} onChange={e => setWallet(e.target.value)}><option value="">Tất cả ví</option><option value="F">Ví F</option><option value="G">Ví G</option></select></div>
    {ledger.error && <Notice kind="error">{ledger.error}</Notice>}
    <DataTable headers={admin ? ["Ngày", "Người dùng", "Ví", "Loại", "Điểm"] : ["Ngày", "Ví", "Loại", "Mã đơn", "Điểm"]} rows={(ledger.data?.entries || []).map(x => admin
      ? [date(x.createdAt), x.userId.slice(0, 8), x.wallet, labels[x.type] || x.type, <Points key="p" value={x.points}/>]
      : [date(x.createdAt), x.wallet, labels[x.type] || x.type, x.orderId?.slice(0, 8) || "—", <Points key="p" value={x.points}/>]
    )} empty="Chưa có giao dịch điểm."/>
  </section>;
}

function CtvRedeem({ token }: { token: string }) {
  const b = useResource(() => api<Balances>("/api/points/balances", {}, token), [token]);
  if (b.loading) return <p>Đang kiểm tra điều kiện…</p>;
  if (b.error) return <Notice kind="error">{b.error}</Notice>;
  const value = b.data!;
  return <section className="panel redeem-card"><div className={value.redemptionUnlocked ? "redeem-icon ok" : "redeem-icon"}>{value.redemptionUnlocked ? "✓" : "!"}</div>
    <h2>{value.redemptionUnlocked ? "Bạn đã đủ điều kiện đổi điểm" : "Bạn chưa đủ điều kiện đổi điểm"}</h2>
    <p>{value.redemptionUnlocked ? "Điểm được thanh toán bên ngoài hệ thống. Hãy chụp màn hình số dư và liên hệ Admin qua Zalo." : "Bạn cần giới thiệu khách hàng và có đơn được Admin duyệt để mở khóa đổi điểm."}</p>
    <div className="redeem-balances"><span>Ví F <b>{value.f}</b></span><span>Ví G <b>{value.g}</b></span></div>
    {value.redemptionUnlocked && <a className="primary-link" href="https://zalo.me/0971716939" target="_blank">Liên hệ Admin qua Zalo</a>}
  </section>;
}

function AdminFeatureCard({ icon, tone, value, title, note, onClick, wide = false }: {
  icon: string; tone: string; value?: string | number; title: string; note: string; onClick: () => void; wide?: boolean;
}) {
  return <button className={`admin-feature ${tone}${wide ? " wide" : ""}`} onClick={onClick}>
    <span className="feature-icon" aria-hidden="true">{icon}</span><span className="feature-arrow">→</span>
    {value !== undefined && <strong>{value}</strong>}<b>{title}</b><small>{note}</small>
  </button>;
}

function AdminOverview({ token, user, go, onSignOut }: {
  token: string; user: User; go: (view: string) => void; onSignOut: () => void;
}) {
  const users = useResource(() => api<{ users: User[]; total: number }>("/api/admin/users?limit=100", {}, token), [token]);
  const orders = useResource(() => api<{ orders: Order[]; total: number }>("/api/admin/orders?limit=100", {}, token), [token]);
  const rows = orders.data?.orders || [];
  const ctvCount = (users.data?.users || []).filter(x => x.role === "USER").length;
  const pending = rows.filter(x => x.status === "PENDING").length;
  const approved = rows.filter(x => x.status === "APPROVED").length;
  return <section className="admin-dashboard">
    <div className="admin-topline"><div className="admin-achievement"><span>♕</span><strong>Trung tâm Admin</strong></div><button className="admin-bell" aria-label="Thông báo">♢<i>{pending}</i></button></div>
    <section className="admin-profile-card">
      <div className="profile-title"><span>◎</span><strong>Thông tin quản trị viên</strong></div>
      <button className="profile-password" onClick={() => go("account")}>⌑ Đổi mật khẩu</button>
      <div className="profile-fields"><small>Họ và tên</small><h1>{user.fullName}</h1><small>Số điện thoại</small><h2>{user.phone}</h2></div>
      <button className="profile-edit" onClick={() => go("account")}>✎ Xem hồ sơ</button>
      <span className="profile-role">SUPER ADMIN</span>
    </section>
    {(users.error || orders.error) && <Notice kind="error">{users.error || orders.error}</Notice>}
    <div className="admin-feature-grid">
      <AdminFeatureCard icon="♙" tone="green" value={ctvCount} title="Cộng tác viên" note="Tài khoản đang quản lý" onClick={() => go("users")}/>
      <AdminFeatureCard icon="▣" tone="orange" value={pending} title="Đơn cần duyệt" note="Cần xử lý sớm" onClick={() => go("orders")}/>
      <AdminFeatureCard icon="✓" tone="cyan" value={approved} title="Đơn đã duyệt" note="Đã phát sinh điểm" onClick={() => go("orders")}/>
      <AdminFeatureCard icon="◇" tone="purple" value={orders.data?.total || 0} title="Tổng đơn hàng" note="Toàn bộ hệ thống" onClick={() => go("orders")}/>
      <AdminFeatureCard icon="₫" tone="gold" title="Cộng thưởng / Trừ điểm" note="Quản lý ví F và ví G" onClick={() => go("rewards")} wide/>
      <AdminFeatureCard icon="↗" tone="blue" title="Lịch sử điểm" note="Tra cứu mọi biến động" onClick={() => go("ledger")} wide/>
    </div>
    <div className="admin-quick-row"><button onClick={() => go("users")}><span>＋</span><b>Tạo tài khoản CTV</b><small>Thêm cộng tác viên mới</small><i>›</i></button></div>
    <footer className="admin-footer-actions"><button onClick={() => go("account")}>◎ Tài khoản</button><button onClick={onSignOut} className="logout">↪ Đăng xuất</button></footer>
  </section>;
}

function AdminUsers({ token }: { token: string }) {
  const [q, setQ] = useState(""); const users = useResource(() => api<{ users: User[] }>(`/api/admin/users?limit=100&q=${encodeURIComponent(q)}`, {}, token), [token, q]);
  const [form, setForm] = useState({ fullName: "", phone: "", password: "" }); const [message, setMessage] = useState("");
  const create = async (e: FormEvent) => { e.preventDefault(); setMessage(""); try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(form) }, token); setForm({ fullName: "", phone: "", password: "" }); setMessage("Đã tạo tài khoản CTV."); users.refresh(); } catch (e) { setMessage(e instanceof Error ? e.message : "Không thể tạo tài khoản"); } };
  const reset = async (u: User) => { if (!confirm(`Đặt lại mật khẩu cho ${u.fullName}?`)) return; try { const result = await api<{ temporaryPassword: string; expiresInMinutes: number }>(`/api/admin/users/${u.id}/reset-password`, { method: "POST" }, token); alert(`Mật khẩu tạm: ${result.temporaryPassword}\\nHiệu lực: ${result.expiresInMinutes} phút`); users.refresh(); } catch (e) { alert(e instanceof Error ? e.message : "Không thể reset"); } };
  return <section><form className="panel user-form" onSubmit={create}><h2>Tạo tài khoản gốc</h2><div className="form-grid"><label>Họ và tên<input value={form.fullName} onChange={e => setForm({ ...form, fullName: e.target.value })} required/></label><label>Số điện thoại<input inputMode="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required/></label><label>Mật khẩu<input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} minLength={8} required/></label></div><button className="primary-action">Tạo tài khoản</button>{message && <Notice kind={message.startsWith("Đã") ? "success" : "error"}>{message}</Notice>}</form>
    <input className="portal-search" placeholder="Tìm theo tên hoặc số điện thoại…" value={q} onChange={e => setQ(e.target.value)}/>
    <DataTable headers={["Tên", "SĐT", "Vai trò", "Trạng thái", "Ngày tạo", "Hành động"]} rows={(users.data?.users || []).filter(x => x.role === "USER").map(x => [
      x.fullName, x.phone, "CTV", <Status key="s" value={x.isActive ? "ACTIVE" : "INACTIVE"}/>, date(x.createdAt), <button className="small-btn" key="r" onClick={() => reset(x)}>Đặt lại MK</button>
    ])} empty="Không tìm thấy CTV."/>
  </section>;
}

function AdminRewardCenter({ token }: { token: string }) {
  const [mode, setMode] = useState<"bonus" | "redeem">("bonus");
  return <section>
    <div className="reward-tabs">
      <button className={mode === "bonus" ? "active" : ""} onClick={() => setMode("bonus")}>＋ Cộng thưởng ví G</button>
      <button className={mode === "redeem" ? "active" : ""} onClick={() => setMode("redeem")}>− Trừ điểm F / G</button>
    </div>
    {mode === "bonus" ? <AdminBonus token={token}/> : <AdminRedeem token={token}/>}
  </section>;
}

function AdminBonus({ token }: { token: string }) {
  const users = useResource(() => api<{ users: User[] }>("/api/admin/users?limit=100", {}, token), [token]);
  const [userId, setUserId] = useState("");
  const [balances, setBalances] = useState<Balances | null>(null);
  const [points, setPoints] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!userId) { setBalances(null); return; }
    api<Balances>(`/api/admin/users/${userId}/balances`, {}, token).then(setBalances).catch(() => setBalances(null));
  }, [userId, token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setMessage("");
    try {
      const result = await api<{ balances: { after: Balances } }>(`/api/admin/users/${userId}/g-bonus`, {
        method: "POST",
        body: JSON.stringify({ points: Number(points), reason: reason.trim(), idempotencyKey: crypto.randomUUID() }),
      }, token);
      setBalances(result.balances.after); setPoints(""); setReason(""); setMessage("Đã cộng thưởng vào ví G.");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Không thể cộng thưởng"); }
  };
  return <form className="panel narrow redeem-form reward-form bonus-form" onSubmit={submit}>
    <div className="reward-form-head"><span>₫</span><div><h2>Cộng thưởng thủ công</h2><p>Điểm được cộng vào ví G và vẫn áp dụng chu kỳ duy trì 3 tháng.</p></div></div>
    <label>Cộng tác viên<select value={userId} onChange={e => setUserId(e.target.value)} required><option value="">Chọn CTV…</option>{(users.data?.users || []).filter(x => x.role === "USER").map(x => <option key={x.id} value={x.id}>{x.fullName} — {x.phone}</option>)}</select></label>
    {balances && <div className="wallet-highlight"><small>Ví G hiện tại</small><strong>{balances.g}</strong><span>điểm</span></div>}
    <label>Số điểm thưởng<input type="number" min="1" step="1" value={points} onChange={e => setPoints(e.target.value)} placeholder="Ví dụ: 20" required/></label>
    <label>Lý do<textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={500} placeholder="Nhập lý do để tiện truy xuất lịch sử" required/></label>
    <button className="primary-action reward-submit" disabled={!userId || !points || !reason.trim()}>Xác nhận cộng điểm</button>
    {message && <Notice kind={message.startsWith("Đã") ? "success" : "error"}>{message}</Notice>}
  </form>;
}

function AdminRedeem({ token }: { token: string }) {
  const users = useResource(() => api<{ users: User[] }>("/api/admin/users?limit=100", {}, token), [token]);
  const [userId, setUserId] = useState(""); const [balances, setBalances] = useState<Balances | null>(null); const [f, setF] = useState(""); const [g, setG] = useState(""); const [note, setNote] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => { if (!userId) return; api<Balances>(`/api/admin/users/${userId}/balances`, {}, token).then(setBalances).catch(() => setBalances(null)); }, [userId, token]);
  const submit = async (e: FormEvent) => { e.preventDefault(); setMessage(""); const body: Record<string, unknown> = { userId, note, idempotencyKey: crypto.randomUUID() }; if (f) body.f = Number(f); if (g) body.g = Number(g); try { const result = await api<{ balances: Balances }>("/api/admin/redemptions", { method: "POST", body: JSON.stringify(body) }, token); setBalances(result.balances); setF(""); setG(""); setNote(""); setMessage("Đã ghi nhận đổi điểm và cập nhật số dư."); } catch (e) { setMessage(e instanceof Error ? e.message : "Không thể đổi điểm"); } };
  return <form className="panel narrow redeem-form reward-form redeem-admin-form" onSubmit={submit}><div className="reward-form-head"><span>−</span><div><h2>Trừ điểm sau khi trả thưởng</h2><p>Ghi nhận số điểm đã thanh toán bên ngoài hệ thống.</p></div></div><label>Cộng tác viên<select value={userId} onChange={e => { setUserId(e.target.value); setBalances(null); }} required><option value="">Chọn CTV…</option>{(users.data?.users || []).filter(x => x.role === "USER").map(x => <option key={x.id} value={x.id}>{x.fullName} — {x.phone}</option>)}</select></label>
    {balances && <div className="mini-balances"><span>F: <b>{balances.f}</b></span><span>G: <b>{balances.g}</b></span><span>{balances.redemptionUnlocked ? "Đã mở khóa" : "Chưa mở khóa"}</span></div>}
    <div className="form-grid two"><label>Trừ điểm ví F<input type="number" min="1" max={balances?.f} value={f} onChange={e => setF(e.target.value)}/></label><label>Trừ điểm ví G<input type="number" min="1" max={balances?.g} value={g} onChange={e => setG(e.target.value)}/></label></div>
    <label>Ghi chú<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500}/></label><button className="primary-action" disabled={!userId || (!f && !g)}>Xác nhận đổi điểm</button>{message && <Notice kind={message.startsWith("Đã") ? "success" : "error"}>{message}</Notice>}</form>;
}

function Account({ user, token, onSignOut }: { user: User; token: string; onSignOut: () => void }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" }); const [message, setMessage] = useState("");
  const submit = async (e: FormEvent) => { e.preventDefault(); setMessage(""); try { await api("/api/auth/change-password", { method: "POST", body: JSON.stringify(form) }, token); setMessage("Đổi mật khẩu thành công. Đang đăng xuất…"); setTimeout(onSignOut, 1200); } catch (e) { setMessage(e instanceof Error ? e.message : "Không thể đổi mật khẩu"); } };
  return <section className="account-grid"><div className="panel"><h2>Thông tin tài khoản</h2><dl><dt>Họ và tên</dt><dd>{user.fullName}</dd><dt>Số điện thoại</dt><dd>{user.phone}</dd><dt>Mã giới thiệu</dt><dd>{user.referralCode}</dd><dt>Vai trò</dt><dd>{user.role === "SUPER_ADMIN" ? "Super Admin" : "CTV"}</dd></dl></div>
    <form className="panel" onSubmit={submit}><h2>Đổi mật khẩu</h2><label>Mật khẩu hiện tại<input type="password" value={form.currentPassword} onChange={e => setForm({ ...form, currentPassword: e.target.value })} required/></label><label>Mật khẩu mới<input type="password" minLength={8} value={form.newPassword} onChange={e => setForm({ ...form, newPassword: e.target.value })} required/></label><label>Nhập lại mật khẩu<input type="password" minLength={8} value={form.confirmPassword} onChange={e => setForm({ ...form, confirmPassword: e.target.value })} required/></label><button className="primary-action">Đổi mật khẩu</button>{message && <Notice kind={message.startsWith("Đổi") ? "success" : "error"}>{message}</Notice>}</form>
  </section>;
}

function DataTable({ headers, rows, empty }: { headers: string[]; rows: ReactNode[][]; empty: string }) {
  return <div className="data-table"><table><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.length ? rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j} data-label={headers[j]}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length} className="empty">{empty}</td></tr>}</tbody></table></div>;
}
function Status({ value }: { value: string }) { const tone = value === "APPROVED" || value === "ACTIVE" ? "green" : value === "REJECTED" || value === "INACTIVE" ? "red" : "amber"; return <span className={`pill ${tone}`}>{labels[value] || (value === "ACTIVE" ? "Hoạt động" : value === "INACTIVE" ? "Đã khóa" : value)}</span>; }
function Points({ value }: { value: number }) { return <strong className={value >= 0 ? "plus" : "minus"}>{value > 0 ? "+" : ""}{value}</strong>; }
function date(value: string) { return new Date(value).toLocaleDateString("vi-VN"); }
