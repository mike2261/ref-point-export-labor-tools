# Tech Spec: Backend hệ thống tính điểm CTV trên Cloudflare Workers

**Loại tài liệu:** Tech Spec (thiết kế kỹ thuật). Xây dựng trên nền PRD đã duyệt tại `docs/prd-he-thong-tinh-diem-ctv.md` (mô hình cây giới thiệu + luồng Admin tạo đề nghị / CTV xác nhận). Chỉ thiết kế **backend** — frontend sẽ là **React hoặc Next.js**, nằm ở repo khác, làm sau.

**Tech stack đã chốt:** Cloudflare Workers (TypeScript, Hono) + Cloudflare D1 (SQLite) + Cron Triggers. Không dùng Python/Postgres (đã cân nhắc, xem lý do ở cuối tài liệu — Mục 9).

---

## 1. Kiến trúc tổng quan

- **Runtime**: Cloudflare Workers, TypeScript, framework **Hono** — routing, middleware, `hono/jwt` built-in.
- **Database**: **Cloudflare D1** (SQLite), một database duy nhất — đủ cho quy mô nội bộ công ty. D1 ghi tuần tự trên cùng 1 database (single-writer), nên các thao tác ghi có điều kiện (`UPDATE ... WHERE ...`, ràng buộc `UNIQUE`) đã an toàn trước race-condition mà **không cần Durable Objects**.
- **Cron Trigger**: chạy hàng tháng để tổng hợp điểm & tính lương (Mục 6).
- **Auth**: JWT tự xây bằng `hono/jwt` (không dùng Cloudflare Access — hệ thống có luồng đăng ký công khai qua link/Mã CTV, không có IdP công ty sẵn có).
- **Không có mã/token bí mật nào gửi qua kênh ngoài hệ thống.** Cộng điểm đi qua đúng 2 bước trong app: (1) Admin kiểm tra phỏng vấn rồi tạo **Point Award** (bản ghi chờ xác nhận) cho CTV; (2) chính CTV đó đăng nhập, thấy bản ghi chờ và bấm **xác nhận** — hành động này mới sinh Point Transaction. Xem Mục 4.
- **CORS**: frontend (React/Next.js) là một origin riêng gọi API qua Bearer token — bật `cors()` middleware của Hono cho origin của frontend, không dùng cookie-based session (tránh vấn đề CSRF/cross-site cookie giữa 2 repo/domain).
- **Triển khai**: một Worker project duy nhất, một environment ban đầu (thêm staging/production sau bằng `env` block trong wrangler.jsonc khi cần).

---

## 2. Mô hình phân cấp CTV (khớp PRD Mục 3)

- Bảng `users` có cột tự tham chiếu **`referrer_id`** (nullable) — trỏ đến đúng **một** người giới thiệu trực tiếp. Cây có thể sâu không giới hạn, nhưng nghiệp vụ **chỉ đọc đúng 1 bước** (`referrer_id` của chính người đó), không bao giờ truy ngược nhiều tầng.
- **Vai trò chỉ còn 2 giá trị**: `ADMIN` (đúng 1 tài khoản) và `CTV` (tất cả người còn lại). "Cấp trên"/"trực tiếp" chỉ là khái niệm tương đối theo vị trí trong cây, không lưu thành giá trị riêng.
- **"Mã CTV" = số điện thoại của chính người dùng** — dùng làm khoá tra cứu khi người khác đăng ký dưới mình, không phải bảng/entity riêng.
- **Đăng ký luôn phải có người giới thiệu**, qua 1 trong 2 cách:
  1. **Link mời**: `.../register?ref=<phone_người_giới_thiệu>` — tự điền `referrer_id`.
  2. **Nhập tay Mã CTV**: form đăng ký có trường nhập SĐT người giới thiệu; server tra cứu, không tìm thấy → từ chối đăng ký.
- **Chỉ Admin tạo được tài khoản "gốc"** (`referrer_id = NULL`), qua endpoint riêng — không qua form đăng ký công khai.
- *Giả định đang chờ xác nhận (PRD Câu hỏi mở #3):* tài khoản đăng ký kích hoạt **ngay**, không cần Admin duyệt. Nếu cần duyệt, thêm cột `status` (PENDING/ACTIVE) — không ảnh hưởng phần còn lại của thiết kế.

---

## 3. Mô hình dữ liệu (D1 schema)

```sql
-- migrations/0001_initial_schema.sql

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,              -- cũng chính là "Mã CTV"
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,             -- "pbkdf2$<iterations>$<salt_b64>$<hash_b64>"
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'CTV')) DEFAULT 'CTV',
  referrer_id INTEGER REFERENCES users(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_referrer_id ON users(referrer_id);

-- Bản ghi Admin tạo sau khi kiểm tra phỏng vấn, chờ chính CTV xác nhận
CREATE TABLE point_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  beneficiary_user_id INTEGER NOT NULL REFERENCES users(id),  -- CTV trực tiếp được thưởng
  total_points INTEGER NOT NULL,
  direct_ratio REAL NOT NULL DEFAULT 0.9,  -- tỉ lệ phần "direct"; phần còn lại là "upline"
  reference_note TEXT,                     -- mã hồ sơ ứng viên (tùy chọn, ngoài hệ thống)
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED')) DEFAULT 'PENDING',
  created_by INTEGER NOT NULL REFERENCES users(id),  -- admin đã kiểm tra & tạo bản ghi
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT
);
CREATE INDEX idx_point_awards_beneficiary_status ON point_awards(beneficiary_user_id, status);

CREATE TABLE point_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  award_id INTEGER NOT NULL REFERENCES point_awards(id),
  beneficiary_user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('DIRECT', 'UPLINE', 'ADJUSTMENT')),
  points INTEGER NOT NULL,                 -- có thể âm với ADJUSTMENT
  created_by INTEGER REFERENCES users(id), -- người tạo ADJUSTMENT; NULL với DIRECT/UPLINE
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (award_id, type)                  -- mỗi award tối đa 1 dòng DIRECT + 1 dòng UPLINE
);
CREATE INDEX idx_point_tx_beneficiary ON point_transactions(beneficiary_user_id, created_at);

CREATE TABLE salary_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,                    -- 'YYYY-MM'
  total_points INTEGER NOT NULL,
  rate_used REAL NOT NULL,
  salary_amount REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'FINALIZED')) DEFAULT 'DRAFT',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT,
  UNIQUE (user_id, period)
);

CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                      -- vd: key='points_to_currency_rate', value='50000'
);
```

**Không có mã bí mật, không gửi gì qua kênh ngoài hệ thống.** `point_awards` chỉ là bản ghi nội bộ, hiển thị trực tiếp cho đúng CTV thụ hưởng khi họ đăng nhập. Chặn xác nhận 2 lần dùng compare-and-swap trên cột `status` (Mục 4).

---

## 4. Luồng duyệt & xác nhận cộng điểm

**Bước 1 — Admin kiểm tra phỏng vấn, tạo bản ghi chờ xác nhận:**

```typescript
// POST /admin/point-awards  { beneficiaryUserId, totalPoints, directRatio?, referenceNote? }
app.post('/admin/point-awards', requireAdmin, async (c) => {
  const { beneficiaryUserId, totalPoints, directRatio = 0.9, referenceNote } = await c.req.json();
  const admin = c.get('user');

  const beneficiary = await c.env.DB.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1')
    .bind(beneficiaryUserId).first();
  if (!beneficiary) return c.json({ error: 'BENEFICIARY_NOT_FOUND' }, 404);

  const { meta } = await c.env.DB.prepare(
    'INSERT INTO point_awards (beneficiary_user_id, total_points, direct_ratio, reference_note, created_by) VALUES (?, ?, ?, ?, ?)'
  ).bind(beneficiaryUserId, totalPoints, directRatio, referenceNote ?? null, admin.id).run();

  return c.json({ id: meta.last_row_id, status: 'PENDING' }, 201);
});
```

**Bước 2 — Chính CTV thụ hưởng xác nhận, hệ thống mới cộng điểm:**

```typescript
// POST /point-awards/:id/confirm
app.post('/point-awards/:id/confirm', async (c) => {
  const awardId = Number(c.req.param('id'));
  const currentUser = c.get('user'); // CTV đang đăng nhập

  // Compare-and-swap: chỉ thành công nếu đúng chủ nhân và đang PENDING
  const { meta } = await c.env.DB.prepare(
    "UPDATE point_awards SET status = 'CONFIRMED', confirmed_at = datetime('now') WHERE id = ? AND beneficiary_user_id = ? AND status = 'PENDING'"
  ).bind(awardId, currentUser.id).run();

  if (meta.changes === 0) {
    return c.json({ error: 'NOT_FOUND_OR_ALREADY_CONFIRMED' }, 409);
  }

  const award = await c.env.DB.prepare('SELECT * FROM point_awards WHERE id = ?').bind(awardId).first<{
    beneficiary_user_id: number; total_points: number; direct_ratio: number;
  }>();
  const referrer = await c.env.DB.prepare('SELECT referrer_id FROM users WHERE id = ?')
    .bind(award!.beneficiary_user_id).first<{ referrer_id: number | null }>();

  const directPoints = Math.round(award!.total_points * award!.direct_ratio);
  const uplinePoints = award!.total_points - directPoints;

  const statements = [
    c.env.DB.prepare('INSERT INTO point_transactions (award_id, beneficiary_user_id, type, points) VALUES (?, ?, ?, ?)')
      .bind(awardId, award!.beneficiary_user_id, 'DIRECT', directPoints),
  ];
  if (referrer?.referrer_id && uplinePoints > 0) {
    statements.push(
      c.env.DB.prepare('INSERT INTO point_transactions (award_id, beneficiary_user_id, type, points) VALUES (?, ?, ?, ?)')
        .bind(awardId, referrer.referrer_id, 'UPLINE', uplinePoints)
    );
  }
  await c.env.DB.batch(statements); // atomic: 1 hoặc 2 dòng cùng lúc

  return c.json({ ok: true, directPoints, uplinePoints });
});
```

**Vì sao an toàn khi có nhiều request đồng thời:** bước xác nhận luôn bắt đầu bằng `UPDATE ... WHERE status = 'PENDING'` — D1 xử lý ghi tuần tự trên cùng database, nên chỉ đúng một request "thắng" (`meta.changes === 1`); mọi request lặp lại sau đó nhận `changes === 0` → 409. Ràng buộc `UNIQUE(award_id, type)` trên `point_transactions` là lớp chặn thứ hai.

**Trường hợp không có upline** (`referrer.referrer_id` là `NULL`): phần điểm "upline" hiện **không cộng cho ai** — câu hỏi mở #1 trong PRD, dễ đổi sau chỉ bằng cách sửa điều kiện `if`.

---

## 5. API design

| Method & Path | Vai trò | Mô tả |
|---|---|---|
| `POST /auth/register` | Public | `{ phone, password, name, referrerCode }` — bắt buộc `referrerCode` khớp một user đang hoạt động, trừ khi gọi bởi Admin. |
| `POST /auth/login` | Public | `{ phone, password }` → JWT phiên đăng nhập. |
| `POST /admin/users` | Admin | Tạo tài khoản gốc (`referrer_id = NULL`) hoặc tạo hộ CTV bất kỳ. |
| `PATCH /admin/users/:id` | Admin | Sửa thông tin, khóa/mở tài khoản, sửa `referrer_id` (đối soát sai sót). |
| `GET /admin/users` | Admin | Danh sách CTV (lọc theo referrer_id để dựng cây khi cần). |
| `POST /admin/point-awards` | Admin | Tạo bản ghi chờ xác nhận sau khi kiểm tra phỏng vấn. |
| `GET /admin/point-awards` | Admin | Danh sách award, lọc theo trạng thái/CTV/thời gian. |
| `GET /admin/transactions` | Admin | Lịch sử `point_transactions` — phục vụ đối soát. |
| `POST /admin/transactions/adjustments` | Admin | Tạo dòng `ADJUSTMENT` kèm lý do — không sửa/xóa dòng cũ. |
| `GET /admin/salary-summaries?period=YYYY-MM` | Admin | Xem tổng hợp lương tháng, toàn bộ CTV. |
| `POST /admin/salary-summaries/:id/finalize` | Admin | Chốt một bản tổng hợp lương. |
| `GET /me/point-awards?status=PENDING` | CTV | Xem award đang chờ mình xác nhận. |
| `POST /point-awards/:id/confirm` | CTV | Xác nhận award của chính mình (Mục 4). |
| `GET /me` | CTV/Admin | Thông tin tài khoản + referrer của bản thân. |
| `GET /me/points` | CTV/Admin | Lịch sử điểm của bản thân. |
| `GET /me/referrals` | CTV/Admin | Danh sách người mình trực tiếp giới thiệu (F1). |
| `GET /me/salary-summaries` | CTV/Admin | Lương/KPI hàng tháng của bản thân. |

**Middleware**: `authMiddleware` (xác thực JWT, gắn `c.set('user', ...)`) áp cho mọi route trừ `/auth/*`; `requireAdmin` áp cho toàn bộ `/admin/*`; mọi route `/me/*` tự lọc theo `c.get('user').id`, không nhận `userId` từ client.

---

## 6. Tổng hợp lương hàng tháng (Cron Trigger)

```typescript
// wrangler.jsonc: "triggers": { "crons": ["0 2 1 * *"] }  // 02:00 UTC ngày 1 hàng tháng

export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const period = previousMonthKey(controller.scheduledTime); // vd '2026-06'
    const rate = Number((await env.DB.prepare("SELECT value FROM system_config WHERE key = 'points_to_currency_rate'").first<{ value: string }>())?.value ?? '0');

    const { results } = await env.DB.prepare(`
      SELECT beneficiary_user_id AS userId, SUM(points) AS totalPoints
      FROM point_transactions
      WHERE strftime('%Y-%m', created_at) = ?
      GROUP BY beneficiary_user_id
    `).bind(period).all<{ userId: number; totalPoints: number }>();

    const upserts = results.map((row) =>
      env.DB.prepare(`
        INSERT INTO salary_summaries (user_id, period, total_points, rate_used, salary_amount, status)
        VALUES (?, ?, ?, ?, ?, 'DRAFT')
        ON CONFLICT(user_id, period) DO UPDATE SET
          total_points = excluded.total_points, rate_used = excluded.rate_used, salary_amount = excluded.salary_amount
        WHERE salary_summaries.status = 'DRAFT'
      `).bind(row.userId, period, row.totalPoints, rate, row.totalPoints * rate)
    );
    await env.DB.batch(upserts);
  },
};
```

**Idempotent theo thiết kế**: job luôn tính lại tổng điểm gốc từ `point_transactions` rồi `UPSERT` đè lên bản ghi `DRAFT` — chạy trùng lịch (retry) không gây sai lệch, **không cần khóa/Durable Object**. Bản ghi đã `FINALIZED` không bị job này ghi đè (điều kiện `WHERE status = 'DRAFT'`).

---

## 7. Xác thực & bảo mật

- **Mật khẩu**: PBKDF2-SHA256 qua Web Crypto API sẵn có trong Workers (`crypto.subtle.deriveBits`), 100.000 vòng lặp, salt ngẫu nhiên 16 byte/người dùng — không cần thư viện ngoài.
- **Phiên đăng nhập**: JWT (HS256) ký bằng `hono/jwt`, secret `AUTH_JWT_SECRET`, thời hạn ngắn (vd 7 ngày). Frontend (React/Next.js) lưu token và gắn `Authorization: Bearer <token>` — không dùng cookie session để tránh vấn đề cross-origin giữa 2 repo.
- **Secrets**: `wrangler secret put AUTH_JWT_SECRET` — không lưu trong wrangler.jsonc.
- **RBAC**: middleware `requireAdmin` chặn toàn bộ `/admin/*`; route `/me/*` luôn tự lọc theo `c.get('user').id`.
- **CORS**: cấu hình `hono/cors` chỉ cho phép origin của frontend (domain thật khi có, `*`/localhost khi dev).

---

## 8. Cấu hình & triển khai

```jsonc
// wrangler.jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "xkld-points-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "d1_databases": [
    { "binding": "DB", "database_name": "xkld-points-db", "database_id": "<tạo bằng wrangler d1 create>", "migrations_dir": "migrations" }
  ],
  "triggers": { "crons": ["0 2 1 * *"] }
}
```

Lệnh thiết lập ban đầu:
```bash
npm create cloudflare@latest -- xkld-tools --type hono
wrangler d1 create xkld-points-db          # điền database_id vào wrangler.jsonc
wrangler d1 migrations create xkld-points-db initial_schema
wrangler d1 migrations apply xkld-points-db --local
wrangler d1 migrations apply xkld-points-db --remote
wrangler secret put AUTH_JWT_SECRET
```

**Testing**: Vitest + `@cloudflare/vitest-pool-workers`, migrations áp dụng vào D1 local cho test setup.

---

## 9. Vì sao không dùng Python/Postgres (ghi lại quyết định)

Đã cân nhắc Python (FastAPI + SQLAlchemy + Alembic + Postgres) — ưu điểm là hệ sinh thái chín muồi và transaction rõ ràng, nhưng:
- Python không chạy tốt trên Cloudflare Workers (Python Workers dùng Pyodide/WASM, không hỗ trợ package có C-extension như `pydantic-core`, `asyncpg`/`psycopg2`).
- Cách duy nhất chạy Python thật trên Cloudflare là **Containers** (đang beta, không auto-scale, cold start 2-3s, API có thể đổi) — mất phần lớn lợi ích chọn Cloudflare ngay từ đầu.
- Với quy mô dữ liệu đơn giản của hệ thống này (users, point_awards, point_transactions, salary_summaries), D1 + thao tác compare-and-swap (`UPDATE ... WHERE status = 'PENDING'`) đáp ứng đủ yêu cầu toàn vẹn dữ liệu mà không cần transaction phức tạp kiểu Postgres.

→ **Quyết định cuối cùng: Cloudflare Workers + Hono + D1** cho backend; frontend React hoặc Next.js ở repo riêng, gọi API qua Bearer token.

---

## 10. Việc cần làm tiếp theo

- Khởi tạo repo Cloudflare Worker (Hono + D1) theo Mục 8.
- Viết migration đầu tiên (Mục 3) và test bằng `wrangler dev` + Vitest.
- Xử lý các câu hỏi mở còn lại trong PRD (Mục 11) trước khi hoàn thiện logic tính lương (Mục 6) và trường hợp không có upline (Mục 4).
- Khi frontend (React/Next.js) bắt đầu, thống nhất domain/CORS origin thật để cấu hình Mục 7.
