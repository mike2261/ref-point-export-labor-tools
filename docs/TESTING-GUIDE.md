# Hướng dẫn chạy và kiểm thử hệ thống

Tài liệu này dùng để kiểm thử bản hiện tại trên máy cá nhân. Backend chạy tại
`http://localhost:8787`, frontend chạy tại `http://localhost:3000`.

## 1. Chuẩn bị lần đầu

Yêu cầu: đã cài Node.js, pnpm và đã tải mã nguồn về máy.

### Backend

Mở PowerShell tại thư mục gốc `F:\PhanDeploy`:

```powershell
pnpm.cmd install
Copy-Item .dev.vars.example .dev.vars
pnpm.cmd db:migrate:local
```

Kiểm tra `.dev.vars` có các giá trị sau:

```text
JWT_SECRET=<chuỗi bí mật dài và khó đoán>
ZALO_ADMIN_URL=https://zalo.me/0971716939
ZALO_ADMIN_PHONE=0971716939
```

Tạo Super Admin (chỉ làm một lần cho một database):

```powershell
pnpm.cmd seed:admin --phone 0900000000 --name "Super Admin" --local
```

Khi được hỏi, nhập mật khẩu ít nhất 8 ký tự rồi nhấn Enter. Mật khẩu không hiện
trên màn hình khi gõ. Đây là hành vi bảo mật bình thường.

Khởi động backend:

```powershell
pnpm.cmd dev
```

Giữ cửa sổ này mở trong khi kiểm thử.

### Frontend

Mở cửa sổ PowerShell thứ hai:

```powershell
cd F:\PhanDeploy\frontend
Copy-Item .env.example .env.local
npm install
npm run dev
```

Truy cập `http://localhost:3000` trên trình duyệt.

> Nếu PowerShell chặn lệnh `pnpm`, dùng `pnpm.cmd` như các ví dụ trên.

## 2. Tài khoản dùng để kiểm thử

- Super Admin: số điện thoại `0900000000` và mật khẩu đã nhập khi chạy lệnh tạo admin.
- CTV: dùng tài khoản CTV đã đăng ký trong hệ thống. Không dùng tài khoản Super Admin
  để thử chức năng đặt lại mật khẩu vì Super Admin không được tự reset bằng luồng này.

## 3. Các kịch bản cần kiểm thử

### TC01 — Đăng nhập Super Admin

1. Mở trang đăng nhập.
2. Nhập số `0900000000` và mật khẩu đã tạo.
3. Bấm **Đăng nhập**.

Kết quả mong đợi: đăng nhập thành công và nhìn thấy khu vực quản trị/tài khoản CTV.

### TC02 — Mở hỗ trợ quên mật khẩu

1. Tại trang đăng nhập, bấm **Quên mật khẩu?**.
2. Kiểm tra cửa sổ hướng dẫn xuất hiện.
3. Kiểm tra mã QR Zalo, số `0971716939`, nút mở Zalo và ảnh đội ngũ.
4. Bấm nút Zalo trên điện thoại hoặc quét mã QR.

Kết quả mong đợi: mở đúng cuộc trò chuyện Zalo tại
`https://zalo.me/0971716939`. Nếu thiết bị không mở được liên kết, người dùng vẫn
nhìn thấy số điện thoại để liên hệ thủ công.

### TC03 — Admin đặt lại mật khẩu cho CTV

1. Người dùng liên hệ Zalo và gửi danh thiếp Zalo chứa số điện thoại đã đăng ký.
2. Admin đối chiếu số trên danh thiếp với tài khoản trong hệ thống.
3. Admin đăng nhập, mở danh sách tài khoản và chọn đúng CTV.
4. Bấm chức năng đặt lại mật khẩu và xác nhận.

Kết quả mong đợi:

- Hệ thống cấp mật khẩu tạm `1-8`.
- Mật khẩu tạm có hiệu lực 15 phút.
- Tài khoản được đánh dấu bắt buộc đổi mật khẩu.
- Hệ thống ghi nhận admin thực hiện, tài khoản được reset và thời điểm xử lý.

### TC04 — Đăng nhập bằng mật khẩu tạm

1. Đăng xuất tài khoản admin.
2. Đăng nhập bằng số điện thoại của CTV và mật khẩu `1-8`.

Kết quả mong đợi: đăng nhập được nhưng chuyển thẳng đến màn hình đổi mật khẩu;
người dùng chưa được sử dụng các chức năng khác.

### TC05 — Bắt buộc đổi mật khẩu

1. Ở màn hình đổi mật khẩu, nhập mật khẩu hiện tại là `1-8`.
2. Nhập mật khẩu mới có ít nhất 8 ký tự.
3. Nhập lại đúng mật khẩu mới và xác nhận.

Kết quả mong đợi: đổi thành công, phiên đăng nhập hiện tại kết thúc và người dùng
được yêu cầu đăng nhập lại bằng mật khẩu mới.

### TC06 — Kiểm tra mật khẩu cũ bị vô hiệu

1. Thử đăng nhập lại bằng mật khẩu `1-8`.
2. Sau đó thử bằng mật khẩu mới.

Kết quả mong đợi: `1-8` không còn dùng được; mật khẩu mới đăng nhập thành công.

### TC07 — Mật khẩu tạm hết hạn

1. Admin reset mật khẩu cho CTV.
2. Chờ quá 15 phút rồi đăng nhập bằng `1-8`.

Kết quả mong đợi: hệ thống báo mật khẩu tạm đã hết hạn. CTV phải liên hệ lại admin
để được cấp lại.

### TC08 — Nhập sai khi đổi mật khẩu

Thử lần lượt: nhập sai mật khẩu hiện tại, mật khẩu mới dưới 8 ký tự, hoặc hai ô mật
khẩu mới không giống nhau.

Kết quả mong đợi: hệ thống từ chối, hiển thị lỗi phù hợp và không thay đổi mật khẩu.

### TC09 — Phân quyền

1. Đăng nhập bằng CTV và thử truy cập chức năng reset mật khẩu của tài khoản khác.
2. Đăng nhập bằng Super Admin và thử reset chính tài khoản Super Admin.

Kết quả mong đợi: cả hai thao tác đều bị từ chối. Chỉ Super Admin được reset mật
khẩu cho tài khoản CTV.

### TC10 — Kiểm tra trên nhiều thiết bị

Kiểm tra tối thiểu trên máy tính và điện thoại, tập trung vào trang đăng nhập, cửa sổ
quên mật khẩu, mã QR, ảnh đội ngũ và màn hình bắt buộc đổi mật khẩu.

Kết quả mong đợi: nội dung không tràn màn hình, nút bấm sử dụng được và liên kết Zalo
mở đúng trên thiết bị có cài Zalo.

## 4. Chạy kiểm thử tự động

Tại thư mục gốc:

```powershell
pnpm.cmd test
```

Các bài test liên quan trực tiếp đến chức năng mới nằm trong
`test/password-recovery.test.ts`.

## 5. Xử lý lỗi thường gặp

- `pnpm.ps1 cannot be loaded`: đổi `pnpm` thành `pnpm.cmd`.
- Frontend không gọi được backend: kiểm tra backend vẫn chạy ở cổng `8787` và
  `frontend/.env.local` có `NEXT_PUBLIC_API_URL=http://localhost:8787`.
- Không thấy cấu hình Zalo: kiểm tra `.dev.vars`, sau đó tắt và chạy lại backend.
- Lệnh tạo admin báo đã tồn tại: không chạy lại; dùng tài khoản admin đã tạo.
- Mật khẩu tạm không đăng nhập được: kiểm tra chưa quá 15 phút và admin đã reset đúng
  tài khoản CTV.

