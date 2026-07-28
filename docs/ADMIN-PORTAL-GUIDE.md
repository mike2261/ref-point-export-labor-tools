# Hướng dẫn chạy và thao tác giao diện Admin

Tài liệu này hướng dẫn chạy hệ thống trên máy cá nhân và kiểm tra giao diện
Super Admin dạng card. Hướng dẫn kiểm thử toàn bộ luồng đăng nhập và quên mật
khẩu vẫn được lưu tại [`TESTING-GUIDE.md`](./TESTING-GUIDE.md).

## 1. Chuẩn bị backend

Mở PowerShell tại thư mục gốc của dự án:

```powershell
cd F:\PhanDeploy
Copy-Item .dev.vars.example .dev.vars
pnpm.cmd install
pnpm.cmd db:migrate:local
```

Kiểm tra `.dev.vars` có tối thiểu các cấu hình:

```text
JWT_SECRET=<chuỗi bí mật đủ dài>
ZALO_ADMIN_URL=https://zalo.me/0971716939
ZALO_ADMIN_PHONE=0971716939
```

Tạo tài khoản Super Admin trong lần chạy đầu tiên:

```powershell
pnpm.cmd seed:admin --phone 0900000000 --name "Super Admin" --local
```

Nhập mật khẩu có ít nhất 8 ký tự khi chương trình yêu cầu. Sau đó chạy backend:

```powershell
pnpm.cmd dev
```

Backend mặc định chạy tại `http://localhost:8787`.

## 2. Chuẩn bị frontend

Mở một cửa sổ PowerShell khác:

```powershell
cd F:\PhanDeploy\frontend
Copy-Item .env.example .env.local
npm.cmd install
npm.cmd run dev
```

Nội dung `frontend/.env.local`:

```text
NEXT_PUBLIC_API_URL=http://localhost:8787
```

Frontend thường chạy tại `http://localhost:3000`. Nếu cổng này đang được ứng
dụng khác sử dụng, Vite sẽ thông báo một địa chỉ khác, ví dụ
`http://localhost:3001`.

## 3. Đăng nhập Admin

1. Mở địa chỉ frontend trên trình duyệt.
2. Nhập số điện thoại đã dùng khi tạo Super Admin.
3. Nhập mật khẩu đã khai báo trong bước seed.
4. Bấm **Đăng nhập**.

Sau khi đăng nhập đúng vai trò `SUPER_ADMIN`, hệ thống hiển thị **Trung tâm
Admin** dạng card và không hiển thị sidebar của CTV.

## 4. Các chức năng trên Trung tâm Admin

| Card/chức năng | Nội dung |
|---|---|
| **Cộng tác viên** | Mở danh sách CTV, tìm kiếm tài khoản và tạo tài khoản CTV mới. |
| **Đơn cần duyệt** | Hiển thị các đơn đang chờ Admin kiểm tra và xử lý. |
| **Đơn đã duyệt** | Theo dõi các đơn đã duyệt và đã phát sinh điểm. |
| **Tổng đơn hàng** | Mở danh sách toàn bộ đơn hàng trong hệ thống. |
| **Cộng thưởng / Trừ điểm** | Mở trung tâm quản lý ví F và ví G. |
| **Lịch sử điểm** | Tra cứu các biến động điểm của tất cả CTV. |
| **Hồ sơ Admin** | Xem thông tin tài khoản và đổi mật khẩu. |
| **Chuông thông báo** | Hiển thị số đơn đang chờ Admin xử lý. |

Bấm **Trang chủ** trong màn hình chi tiết để quay về các card quản lý.

## 5. Tạo tài khoản CTV

1. Bấm card **Cộng tác viên**.
2. Nhập họ tên, số điện thoại và mật khẩu ban đầu.
3. Bấm **Tạo tài khoản**.
4. Dùng tài khoản vừa tạo để đăng nhập và kiểm tra giao diện CTV.

Tài khoản CTV chỉ xem được dữ liệu của chính họ; Super Admin xem được dữ liệu
toàn hệ thống.

## 6. Duyệt đơn hàng

1. CTV đăng nhập và tạo đơn hàng.
2. Admin mở card **Đơn cần duyệt** hoặc **Tổng đơn hàng**.
3. Kiểm tra người tạo, ngày tạo, ghi chú và trạng thái đơn.
4. Chọn **Duyệt** nếu thông tin hợp lệ hoặc **Từ chối** nếu không hợp lệ.

Đơn bị từ chối không được cộng điểm. Điểm thưởng theo đơn chỉ phát sinh khi
backend xác nhận duyệt thành công.

## 7. Cộng thưởng và trừ điểm

### Cộng thưởng ví G

1. Bấm card **Cộng thưởng / Trừ điểm**.
2. Chọn tab **Cộng thưởng ví G**.
3. Chọn đúng CTV.
4. Nhập số điểm và lý do.
5. Xác nhận cộng thưởng.

Lý do phải đủ rõ để tra cứu trong lịch sử điểm. Không gửi lại liên tục khi chưa
biết kết quả của lần gửi trước.

> Chức năng này chỉ hoạt động khi backend đã tích hợp API cộng thưởng ví G.

### Trừ điểm F/G

1. Chuyển sang tab **Trừ điểm F/G**.
2. Chọn CTV cần trả thưởng.
3. Nhập số điểm cần trừ từ ví F, ví G hoặc cả hai.
4. Nhập ghi chú và xác nhận.

Hệ thống không cho phép trừ vượt quá số dư. Việc chuyển tiền được thực hiện bên
ngoài hệ thống; Admin chỉ xác nhận trừ điểm sau khi đã xử lý trả thưởng.

## 8. Kiểm tra giao diện responsive

Kiểm tra tối thiểu ở ba nhóm kích thước:

- Điện thoại: các card xếp hai cột, chữ và nút không tràn màn hình.
- Tablet: card cân đối, thao tác chạm dễ sử dụng.
- Máy tính: nội dung nằm giữa, các card quản lý hiển thị rõ ràng.

Giao diện Admin không được hiển thị sidebar. Giao diện CTV vẫn giữ luồng và dữ
liệu riêng theo vai trò.

## 9. Lỗi thường gặp

- **Không đăng nhập được:** kiểm tra backend đang chạy ở cổng `8787` và thông
  tin Super Admin đã được seed đúng database local.
- **Frontend không lấy được dữ liệu:** kiểm tra
  `NEXT_PUBLIC_API_URL=http://localhost:8787`, sau đó khởi động lại frontend.
- **Không thấy thay đổi mới:** tải lại trang hoặc khởi động lại frontend.
- **Cộng thưởng ví G báo lỗi:** kiểm tra backend đã có API cộng thưởng và đang
  chạy đúng phiên bản.
- **Cổng `3000` đang bận:** mở đúng địa chỉ cổng mới được Vite in ra, thường là
  `3001`.

## 10. Kiểm tra trước khi đưa lên PR

```powershell
cd F:\PhanDeploy\frontend
npm.cmd run build
```

Build phải hoàn thành không có lỗi trước khi merge.
