# E2E AI Trainer — Hướng dẫn sử dụng

Ứng dụng giúp tự động kiểm thử trang web. Bạn viết các bước kiểm thử bằng lời, app tạo ra kịch bản để chạy lại nhiều lần và chụp ảnh kết quả.

---

## 1. Cài đặt

1. Cài **Google Chrome** (nếu máy chưa có).
2. Mở Chrome, vào Chrome Web Store, tìm và cài extension **Playwright MCP Bridge**.
3. Giải nén file `E2E-AI-Trainer-...-portable-x64.zip` vào một thư mục, ví dụ `D:\E2E AI Trainer`.
   - Không đặt trong `C:\Program Files`.
4. Mở thư mục đó, chạy **E2E AI Trainer.exe**.
   - Nếu Windows hiện cảnh báo màu xanh, bấm **More info** rồi **Run anyway**.

Dữ liệu của app nằm trong thư mục `data` cạnh file exe. Muốn sao lưu thì tắt app rồi copy thư mục này.

---

## 2. Thiết lập lần đầu

### Bước 1 — Cài đặt (góc phải trên cùng)

Chỉ cần dùng được **một** trong hai agent:

- **Codex**:
  - Nếu máy này đã đăng nhập Codex bằng tài khoản ChatGPT (qua app Codex, extension Codex trong VS Code/Cursor, hoặc Codex CLI) với cùng tài khoản Windows, thì **không cần nhập key**. Để trống ô OpenAI API key.
  - Nếu chưa đăng nhập, nhập **OpenAI API key**.
- **Cursor**: luôn phải nhập **Cursor API key**, kể cả khi đã đăng nhập phần mềm Cursor. Key lấy ở trang tài khoản trên cursor.com.

Sau đó chọn agent và bấm **Kiểm tra tích hợp agent**. Kết quả báo thành công là được.

### Bước 2 — Environment (trang web cần kiểm thử)

1. Bấm **Thêm**, rồi nhập:
   - **Tên**.
   - **Base URL**, ví dụ `https://app.example.com`.
2. Nếu trang cần mật khẩu, nhập ở mục **Giá trị secret**. Không ghi mật khẩu vào file test case.
3. Ở mục **Runner auth**:
   - Bấm **Mở trình duyệt để đăng nhập**.
   - Đăng nhập trang web như bình thường.
   - Bấm **Lưu phiên đăng nhập**.
4. Ở mục **Chrome profiles cho Training**:
   - Bấm **Chọn từ profile trên máy**, chọn profile Chrome đã cài extension.
   - Bấm **Đăng ký profile**.
5. Mở Chrome bằng profile đó, rồi bấm **Chạy preflight**. Khi Chrome hỏi, bấm cho phép kết nối.

---

## 3. Thêm test case

1. Vào **Test Cases**, bấm **Lưu file mẫu…** để lấy file Excel mẫu.
2. Điền mỗi dòng một test case:

| Cột | Ghi gì | Ví dụ |
|---|---|---|
| test_id | Mã test case, không trùng | `TC_LOGIN_001` |
| title | Tên ngắn | Tạo campaign mới |
| steps | Mỗi bước một dòng (Alt+Enter để xuống dòng) | `Click nút "Save"` |
| input | Dữ liệu nhập vào | `campaign_name: Summer Sale` |
| expected_result | Kết quả mong đợi trên màn hình | Campaign mới hiện trong danh sách |

   - Chỗ nào dữ liệu thay đổi được thì viết trong steps dạng `{{campaign_name}}`, và ghi giá trị ở cột input.
   - Muốn chụp ảnh ở đâu thì thêm một bước `Chụp màn hình`.
   - Mỗi sheet trong Excel là một nhóm test case.
3. Bấm **Import .xlsx / .csv**, chọn dự án và file, kiểm tra rồi bấm **Xác nhận và lưu**.

---

## 4. Training — tạo kịch bản

Vào **Training**, chọn test case, Environment và Chrome profile. Sau đó dùng một trong ba nút:

| Nút | Dùng khi |
|---|---|
| **Ghi thao tác…** | Bạn tự thao tác trên trang web, app ghi lại thành kịch bản |
| **Agent Training Auto** | Để AI tự làm theo các bước và viết kịch bản |
| **Gửi prompt** | Nhờ AI sửa kịch bản đang chọn, ví dụ "bước Save bị lỗi, sửa lại". Nhấn Enter để gửi |

**Khi ghi thao tác:**

- Gõ đúng dữ liệu hiển thị trong hộp thoại.
- Dùng thanh nhỏ ở góc dưới trang:
  - **›**: sang bước tiếp theo.
  - **📷**: chụp màn hình.
  - **■ Kết thúc**: dừng ghi.

**Sau khi có kịch bản (Candidate):**

1. Bấm **Chạy Trial…** để chạy thử.
2. Xem kết quả:
   - Nếu chạy đúng, bấm **Chấp nhận**. Kịch bản thành version dùng cho Testing.
   - Nếu lỗi, dùng **Gửi prompt** mô tả lỗi để AI sửa, rồi chạy Trial lại.

---

## 5. Testing — chạy kiểm thử

1. Vào **Testing**, bấm **Chạy…** ở test case cần chạy.
2. Chọn version và Environment, sửa dữ liệu nếu muốn, rồi chạy.
3. Xem ảnh chụp và so với kết quả mong đợi, sau đó bấm **PASS** hoặc **FAIL**.
4. Các thao tác khác:
   - **Tải evidence (.zip)**: lưu bằng chứng.
   - **Send to Training**: đưa lần chạy lỗi sang Training để sửa kịch bản.

---

## 6. Gặp lỗi?

| Thông báo | Cách xử lý |
|---|---|
| `PROFILE_UNAVAILABLE` / preflight lỗi | Mở Chrome đúng profile, kiểm tra extension Playwright MCP Bridge đang bật, bấm cho phép kết nối |
| `AUTH_REQUIRED` | Phiên đăng nhập hết hạn. Vào Environment, Runner auth, đăng nhập lại và bấm **Lưu phiên đăng nhập** |
| "Không giải mã được secret" | Xảy ra khi copy app sang máy hoặc tài khoản Windows khác. Nhập lại API key và mật khẩu |
| Codex báo lỗi đăng nhập dù không nhập key | Phiên đăng nhập Codex trên máy đã hết hạn hoặc thuộc tài khoản Windows khác. Đăng nhập lại Codex, hoặc nhập OpenAI API key |
| Tải file lên không được | Vào trang quản lý extension của Chrome, mở chi tiết Playwright MCP Bridge, bật **Allow access to file URLs** |
| Báo trùng tên khi chạy lại | Đổi dữ liệu (ví dụ tên) trước khi chạy |
| Lỗi `Timeout` ở một bước | Ở Training, dùng **Gửi prompt** mô tả bước bị lỗi để AI sửa |
