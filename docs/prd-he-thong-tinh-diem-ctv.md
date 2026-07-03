# PRD: Hệ thống tính điểm, hiệu suất & lương CTV Xuất khẩu Lao động

**Loại tài liệu:** Product Requirements Document (PRD) — chỉ tập trung yêu cầu nghiệp vụ/chức năng, chưa bao gồm thiết kế kỹ thuật (data schema chi tiết, API, tech stack). Bản này đã gộp các điều chỉnh nghiệp vụ thống nhất sau bản đầu tiên (mô hình mạng lưới CTV và cơ chế cộng điểm) — không còn tài liệu cập nhật rời rạc nào khác, đây là bản duy nhất.

**Phạm vi nội dung:** PRD này tập trung vào bốn mảng: **mạng lưới/đăng ký CTV**, **cơ chế tính điểm**, **đánh giá hiệu suất CTV**, và **tính lương/KPI theo tháng**. Các phần không trực tiếp phục vụ các mảng này (hồ sơ ứng viên, đa chi nhánh, cổng thông tin khách hàng...) được liệt kê ở Mục 2 như các tính năng có thể phát triển thêm ở phase sau, không đi sâu chi tiết ở đây.

---

## 1. Bối cảnh & Mục tiêu

Công ty XKLĐ vận hành thông qua một mạng lưới Cộng tác viên (CTV) tìm và giới thiệu ứng viên, đồng thời mỗi CTV có thể giới thiệu thêm CTV khác tham gia mạng lưới. Sau khi một ứng viên phỏng vấn thành công (quy trình phỏng vấn/hồ sơ nằm ngoài phạm vi hệ thống này), Admin cần một cơ chế để: ghi nhận điểm thưởng cho CTV liên quan, đánh giá hiệu suất CTV theo thời gian, và tính lương hàng tháng dựa trên điểm — tất cả phải minh bạch, có lịch sử đầy đủ để đối soát và chống gian lận.

**Mục tiêu của hệ thống:**
1. Quản lý mạng lưới CTV dưới dạng một **cây giới thiệu (referral tree) sâu không giới hạn**, cho phép CTV tự đăng ký/giới thiệu người khác tham gia.
2. Cung cấp cơ chế **Admin kiểm tra kết quả phỏng vấn → tạo đề nghị cộng điểm → chính CTV xác nhận** để kích hoạt cộng điểm — điểm không phát sinh ở bất kỳ bước nào trước khi CTV xác nhận, và không có mã/token nào phải gửi qua kênh ngoài hệ thống.
3. Tự động chia và cộng điểm cho CTV được thưởng trực tiếp và người giới thiệu của họ (đúng 1 cấp) theo tỉ lệ Admin quy định trên từng đề nghị.
4. Đánh giá hiệu suất CTV dựa trên điểm tích lũy (theo tháng/theo giai đoạn).
5. Tổng hợp điểm theo tháng làm cơ sở tính lương/KPI.
6. Đảm bảo toàn bộ giao dịch cộng điểm có lịch sử đầy đủ, bất biến, phục vụ đối soát và chống gian lận.

---

## 2. Phạm vi

**Trong phạm vi (Phase này):**
- Quản lý mạng lưới CTV dạng cây giới thiệu (đăng ký qua link mời hoặc nhập Mã CTV của người giới thiệu).
- Cơ chế đề nghị cộng điểm (Point Award) do Admin tạo sau khi kiểm tra phỏng vấn, và CTV tự xác nhận để kích hoạt cộng điểm, theo tỉ lệ chia cấu hình được.
- Sổ giao dịch điểm (Point Transaction) bất biến, phục vụ đối soát.
- Đánh giá hiệu suất CTV dựa trên điểm (tổng điểm theo kỳ, xếp hạng/so sánh giữa các CTV).
- Tổng hợp điểm & tính lương/KPI theo tháng (Salary Summary).
- Kiểm soát: mỗi đề nghị cộng điểm chỉ xác nhận được đúng một lần; lưu lịch sử đầy đủ mọi giao dịch.

**Ngoài phạm vi / Tính năng có thể phát triển thêm ở phase sau:**
- Quản lý hồ sơ & quy trình ứng viên (tạo hồ sơ, đăng ký, trạng thái phỏng vấn, thông tin cá nhân, lịch phỏng vấn...). Hệ thống này chỉ nhận **một mã tham chiếu tùy chọn** (do quy trình bên ngoài cung cấp) khi Admin tạo đề nghị cộng điểm, không quản lý vòng đời của hồ sơ đó.
- Thông báo tự động qua SMS/Zalo/email khi có đề nghị cộng điểm mới (hiện CTV tự vào hệ thống để xem, chưa có kênh đẩy thông báo ra ngoài).
- Xử lý/chi trả lương thực tế (chuyển khoản...) — Salary Summary chỉ là số liệu tính toán.
- Đa công ty/chi nhánh (multi-tenant).
- Cổng thông tin cho khách hàng/ứng viên tự tra cứu.

---

## 3. Mô hình mạng lưới CTV

- Mạng lưới CTV là một **cây giới thiệu sâu không giới hạn**: A giới thiệu B, B giới thiệu C, C giới thiệu D... không giới hạn số tầng.
- **Mỗi CTV chỉ cần biết đúng một người giới thiệu trực tiếp mình (upline)** — không cần và không thể biết ai là người giới thiệu của upline mình. Ví dụ: C biết B là người giới thiệu mình, nhưng không biết (và hệ thống không cần cho biết) A là người giới thiệu của B.
- **Hoa hồng chỉ tính đúng 1 cấp, bất kể cây sâu bao nhiêu**: khi B được cộng điểm, B nhận phần "trực tiếp"; người giới thiệu B nhận phần "gián tiếp". Nếu B giới thiệu ra C và C được cộng điểm, B nhận phần gián tiếp từ hoạt động của C — **A không nhận được gì từ hoạt động của C**, dù A là "gốc" của cả nhánh.
- **Chỉ có 2 loại tài khoản**: **Admin** (đúng 1 tài khoản, quản lý & có quyền chỉnh sửa toàn hệ thống) và **CTV** (tất cả người còn lại). Cách gọi "CTV cấp trên" / "CTV trực tiếp" chỉ là **tương đối theo vị trí trong cây** — cùng một người vừa là "cấp trên" của người mình giới thiệu, vừa là "trực tiếp" dưới người đã giới thiệu mình. Đây không phải hai loại tài khoản/quyền khác nhau.

### Đăng ký tài khoản CTV
- Mỗi CTV có một **"Mã CTV"** — chính là định danh của họ trong hệ thống, **mặc định là số điện thoại**. Đây không phải một mã riêng phải xin cấp, mà chính là thông tin định danh sẵn có của tài khoản.
- **Đăng ký luôn phải xác định được người giới thiệu** — không có chuyện tạo tài khoản CTV "mồ côi" qua kênh đăng ký thông thường. Có đúng 2 cách:
  1. **Qua link mời**: người giới thiệu chia sẻ một đường link cho người muốn tham gia; khi người đó đăng ký qua link này, hệ thống tự nhận diện và gán người chia sẻ link làm người giới thiệu — người đăng ký không cần nhập gì thêm.
  2. **Tự nhập Mã CTV**: người muốn tham gia tự đăng ký (hoặc được người khác đăng ký hộ), điền thông tin của mình và nhập **Mã CTV của người giới thiệu** (tức số điện thoại của người đó) vào một mục riêng trong biểu mẫu đăng ký.
- **Chỉ Admin mới có thể tạo tài khoản không có người giới thiệu** (tài khoản "gốc") — dùng để khởi tạo mạng lưới ban đầu. CTV thường không có cách nào tạo tài khoản không có upline.
- *Giả định cần xác nhận lại* (xem Mục 11): tài khoản đăng ký qua 1 trong 2 cách trên sẽ **kích hoạt ngay**, không cần Admin duyệt thủ công.

---

## 4. Vai trò người dùng

| Vai trò | Mô tả |
|---|---|
| **Admin** (1 tài khoản) | Tạo tài khoản "gốc" (không người giới thiệu) để khởi tạo mạng lưới; sửa/khoá tài khoản CTV bất kỳ. Kiểm tra kết quả phỏng vấn (ngoài hệ thống) và tạo đề nghị cộng điểm cho CTV liên quan. Xem toàn bộ báo cáo hiệu suất, đối soát giao dịch, chốt lương/KPI tháng. |
| **CTV** (tất cả người còn lại) | Giới thiệu người khác tham gia (qua link mời hoặc cho người khác Mã CTV của mình). Xem và xác nhận các đề nghị cộng điểm dành cho mình — hành động xác nhận này mới thực sự kích hoạt cộng điểm. Xem điểm, hiệu suất, lương/KPI hàng tháng của bản thân, và danh sách người mình **trực tiếp** giới thiệu. |

---

## 5. Khái niệm chính

- **Đề nghị cộng điểm (Point Award)**: bản ghi do Admin tạo ngay trong hệ thống sau khi kiểm tra phỏng vấn thành công — không phải một mã phải gửi đi đâu. Mang theo: CTV được thưởng, tổng điểm, tỉ lệ chia (trực tiếp/gián tiếp), mã tham chiếu hồ sơ (tùy chọn), trạng thái (chờ xác nhận/đã xác nhận). Xuất hiện thẳng trong tài khoản của CTV thụ hưởng.
- **Point Transaction**: bản ghi bất biến (append-only), sinh ra **khi CTV xác nhận** một đề nghị cộng điểm — một dòng cho phần trực tiếp, một dòng cho phần gián tiếp (nếu CTV đó có người giới thiệu). Dùng để đối soát, chống gian lận, và làm nguồn dữ liệu cho đánh giá hiệu suất.
- **Hiệu suất CTV (Performance)**: chỉ số tổng điểm tích lũy của một CTV trong một kỳ (tháng/quý), dùng để so sánh, xếp hạng, hoặc đánh giá KPI.
- **Salary Summary**: bản tổng hợp điểm & lương/KPI của từng CTV theo từng tháng, tính từ toàn bộ Point Transaction phát sinh trong tháng đó.

---

## 6. Luồng nghiệp vụ chi tiết

### 6.1. Tạo & xác nhận đề nghị cộng điểm (không có mã/token nào gửi ra ngoài hệ thống)
1. Ứng viên tham gia phỏng vấn (nằm ngoài phạm vi hệ thống này).
2. **Admin kiểm tra kết quả phỏng vấn.**
3. Nếu đạt: Admin thực hiện một thao tác **ngay trong hệ thống** để tạo một **đề nghị cộng điểm** cho đúng CTV liên quan, gồm: CTV nào được thưởng, tổng điểm, tỉ lệ chia (trực tiếp/gián tiếp), ghi chú tham chiếu (tùy chọn). Đề nghị ở trạng thái "chờ xác nhận".
4. **CTV đăng nhập, thấy đề nghị đang chờ mình, và bấm "Xác nhận".**
5. **Chỉ khi CTV xác nhận, hệ thống mới chính thức ghi nhận điểm**: CTV đó nhận phần trực tiếp; người giới thiệu CTV đó (nếu có) nhận phần gián tiếp (nếu không có người giới thiệu — xem Câu hỏi mở #1).
6. Mỗi đề nghị chỉ xác nhận được đúng một lần; nếu Admin tạo nhầm hoặc CTV chưa xác nhận, đề nghị vẫn ở trạng thái chờ, không phát sinh điểm nào.

*Vì sao cần bước CTV xác nhận thay vì Admin cộng điểm luôn* — giả định cần stakeholder xác nhận lại (xem Câu hỏi mở #2): có thể để CTV tự kiểm tra số điểm trước khi chốt (tránh Admin nhập nhầm), hoặc để tạo bằng chứng "cả hai bên đồng thuận" phục vụ đối soát/tránh tranh chấp.

### 6.2. Đánh giá hiệu suất CTV
1. Hệ thống tính tổng điểm tích lũy của mỗi CTV theo kỳ (mặc định theo tháng, có thể theo quý — xem Câu hỏi mở #8) từ toàn bộ Point Transaction của họ trong kỳ đó.
2. Hệ thống hiển thị/xếp hạng hiệu suất giữa các CTV dựa trên tổng điểm này (tiêu chí xếp hạng/ngưỡng KPI cụ thể — xem Câu hỏi mở #9).

### 6.3. Tổng hợp điểm & tính lương/KPI hàng tháng
1. Cuối mỗi tháng, hệ thống tổng hợp toàn bộ Point Transaction phát sinh trong tháng theo từng CTV.
2. Hệ thống tạo/cập nhật Salary Summary cho từng CTV: tổng điểm trong tháng, lương quy đổi (công thức — xem Câu hỏi mở #6), trạng thái (nháp/đã chốt).
3. Admin xem, rà soát và chốt (finalize) Salary Summary (quy trình chốt & điều chỉnh sau khi chốt — xem Câu hỏi mở #10).

---

## 7. Quy tắc nghiệp vụ

- Điểm **chỉ** phát sinh **sau khi CTV xác nhận** đề nghị cộng điểm — không phát sinh khi Admin tạo đề nghị, không phát sinh ở bất kỳ bước nào khác.
- Mỗi đề nghị cộng điểm chỉ xác nhận được đúng một lần.
- Tỉ lệ chia điểm (trực tiếp/gián tiếp) được cấu hình theo từng đề nghị tại thời điểm Admin tạo — không phải hằng số cố định toàn hệ thống.
- Hoa hồng gián tiếp luôn dừng ở đúng **một cấp** trên CTV được thưởng trực tiếp, bất kể CTV đó nằm sâu bao nhiêu tầng trong cây giới thiệu.
- Đăng ký tài khoản CTV luôn phải xác định được người giới thiệu (qua link hoặc Mã CTV); chỉ Admin mới tạo được tài khoản không có người giới thiệu.
- Mọi Point Transaction là bất biến (append-only) — không sửa/xóa. Nếu cần thu hồi điểm do phát hiện gian lận, phải tạo một giao dịch điều chỉnh mới (giao dịch âm) thay vì sửa giao dịch cũ (cần Admin xác nhận cơ chế này — xem Câu hỏi mở #10).
- Hiệu suất và lương/KPI của CTV luôn được tính lại từ Point Transaction gốc (không lưu số liệu "cứng" tách rời khỏi nguồn dữ liệu giao dịch), đảm bảo có thể đối soát ngược bất kỳ lúc nào.

---

## 8. Yêu cầu chức năng theo vai trò

**Admin**
- FR1: Tạo tài khoản "gốc" (không người giới thiệu) để khởi tạo mạng lưới; sửa thông tin/khoá tài khoản CTV bất kỳ (kể cả sửa nhầm người giới thiệu để đối soát).
- FR2: Xem cây mạng lưới CTV (lọc theo người giới thiệu).
- FR3: Tạo đề nghị cộng điểm cho một CTV cụ thể sau khi kiểm tra phỏng vấn, kèm tổng điểm, tỉ lệ chia, và mã tham chiếu hồ sơ (tùy chọn).
- FR4: Xem danh sách đề nghị cộng điểm theo trạng thái (chờ xác nhận/đã xác nhận).
- FR5: Xem lịch sử toàn bộ Point Transaction (đối soát, chống gian lận), lọc theo CTV/thời gian.
- FR6: Xem báo cáo hiệu suất/xếp hạng CTV theo kỳ.
- FR7: Tạo/xem/chốt Salary Summary theo tháng cho toàn bộ CTV.
- FR8: Tạo giao dịch điều chỉnh điểm khi phát hiện gian lận (append-only, có lý do & tham chiếu).

**CTV**
- FR9: Giới thiệu người khác tham gia (chia sẻ link mời hoặc cung cấp Mã CTV của mình).
- FR10: Xem các đề nghị cộng điểm đang chờ mình xác nhận, và xác nhận chúng.
- FR11: Xem điểm & lịch sử giao dịch của bản thân (bao gồm phần gián tiếp nhận từ người mình giới thiệu).
- FR12: Xem hiệu suất/KPI của bản thân theo kỳ.
- FR13: Xem Salary Summary hàng tháng của bản thân.
- FR14: Xem danh sách người mình **trực tiếp** giới thiệu (không xem được sâu hơn 1 cấp).

---

## 9. Dữ liệu cần lưu (mức khái niệm)

Ở mức PRD, liệt kê dữ liệu cần có (không phải schema kỹ thuật đầy đủ):

- **User**: định danh (Mã CTV = số điện thoại), họ tên, vai trò (ADMIN/CTV), người giới thiệu (referrer, nullable — chỉ tài khoản gốc do Admin tạo mới không có), trạng thái hoạt động.
- **Point Award**: định danh, CTV thụ hưởng, tổng điểm, tỉ lệ chia (trực tiếp/gián tiếp), mã tham chiếu hồ sơ (tùy chọn), trạng thái (chờ xác nhận/đã xác nhận), người tạo (Admin), thời điểm tạo/xác nhận.
- **Point Transaction**: định danh, đề nghị cộng điểm liên kết, CTV thụ hưởng, loại (TRỰC TIẾP/GIÁN TIẾP/ĐIỀU CHỈNH), số điểm, thời điểm tạo.
- **Salary Summary**: định danh, CTV, tháng/năm, tổng điểm, lương/KPI quy đổi, trạng thái (nháp/đã chốt), thời điểm tạo/chốt.

---

## 10. Yêu cầu phi chức năng

- **Phân quyền (RBAC)**: CTV chỉ thấy dữ liệu của mình (kể cả phần gián tiếp nhận từ người mình giới thiệu); Admin thấy toàn bộ.
- **Toàn vẹn dữ liệu**: cơ chế chống race-condition khi CTV bấm xác nhận nhiều lần/đồng thời, đảm bảo mỗi đề nghị chỉ tạo điểm đúng một lần.
- **Truy vết & đối soát**: mọi thao tác tạo đề nghị, xác nhận, điều chỉnh điểm phải có lịch sử đầy đủ (ai, khi nào).
- **Khả năng audit**: Admin có thể tra cứu lại toàn bộ lịch sử của một CTV/một đề nghị bất kỳ lúc nào.

---

## 11. Câu hỏi mở — Cần thêm thông tin

1. **Trường hợp CTV không có người giới thiệu** (tài khoản gốc do Admin tạo): phần điểm "gián tiếp" xử lý thế nào — bỏ không cộng cho ai, hay Admin nhận?
2. **Mục đích thật sự của bước CTV xác nhận** (Mục 6.1): tự kiểm tra số liệu, bằng chứng đồng thuận, hay lý do khác? Quyết định có cần thêm bước "từ chối/khiếu nại đề nghị sai" hay không.
3. Tài khoản đăng ký qua link/Mã CTV có **kích hoạt ngay** không, hay cần Admin duyệt trước?
4. Một đề nghị cộng điểm nếu CTV **không xác nhận trong thời gian dài** thì xử lý thế nào — để chờ mãi, tự động hết hạn, hay Admin có thể huỷ/nhắc lại?
5. **Admin có thể huỷ một đề nghị cộng điểm đã tạo nhưng CTV chưa xác nhận** không (ví dụ tạo nhầm)?
6. **Công thức quy đổi điểm sang lương/KPI**: Một điểm tương ứng bao nhiêu tiền? Có lương cứng + thưởng theo điểm không? Có ngưỡng KPI tối thiểu không?
7. **Quyền đặt tỉ lệ chia điểm**: Chỉ Admin được đặt/thay đổi tỉ lệ chia mỗi đề nghị, hay còn vai trò khác? Có ràng buộc tối thiểu/tối đa cho tỉ lệ không?
8. **Kỳ đánh giá hiệu suất**: tính theo tháng, theo quý, hay cả hai?
9. **Tiêu chí xếp hạng hiệu suất**: chỉ dựa trên tổng điểm, hay kết hợp thêm tiêu chí khác (VD số lượng người giới thiệu thành công)? Có cần bảng xếp hạng (leaderboard) không?
10. **Quy trình chốt lương hàng tháng**: Salary Summary có cần Admin duyệt/chốt trước khi coi là chính thức không? Sau khi chốt có cho phép điều chỉnh ảnh hưởng ngược lại tháng đó không?
11. **Phạm vi công ty**: Hệ thống phục vụ một công ty/chi nhánh XKLĐ duy nhất, hay cần tính đến khả năng mở rộng nhiều công ty/chi nhánh trong tương lai gần?

---

## 12. Giả định đã áp dụng cho phiên bản PRD này

- Hệ thống phục vụ một công ty XKLĐ duy nhất (không multi-tenant) — cho đến khi có câu trả lời khác cho Câu hỏi mở #11.
- Mạng lưới CTV là cây giới thiệu sâu không giới hạn; hoa hồng chỉ tính đúng 1 cấp trực tiếp (Mục 3).
- Tài khoản đăng ký qua link/Mã CTV kích hoạt ngay, không cần Admin duyệt — cho đến khi có câu trả lời khác cho Câu hỏi mở #3.
- Không gửi mã/token nào qua kênh ngoài hệ thống; toàn bộ luồng cộng điểm (tạo đề nghị, xác nhận) diễn ra trong ứng dụng.
- Quy trình hồ sơ ứng viên (đăng ký, phỏng vấn, trạng thái) được để lại cho phase phát triển sau (xem Mục 2); hệ thống hiện tại chỉ nhận một mã tham chiếu tùy chọn khi Admin tạo đề nghị cộng điểm.
