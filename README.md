# E2E AI Trainer

Ứng dụng desktop (Electron) để biến test case viết bằng lời thành Playwright script, rồi dùng script đó chạy kiểm thử web.

Luồng làm việc: **Test Cases → Environment → Training → Testing**.

- **Training**: tạo script bằng cách ghi thao tác, hoặc nhờ AI agent (Codex / Cursor) tự viết. Sau đó chỉnh script bằng prompt hoặc sửa tay, chạy thử (Trial), rồi chấp nhận thành version.
- **Testing**: chạy version đã duyệt với input tuỳ chọn, xem ảnh, step log và trace, rồi tự đánh giá PASS/FAIL.

---

## 1. Cài đặt

### Yêu cầu

| Thành phần | Ghi chú |
|---|---|
| Windows 10/11 | |
| Node.js ≥ 22.12 (khuyến nghị 24) | `node -v` để kiểm tra |
| Google Chrome | Dùng cho Training và (mặc định) cho runner |
| Extension **Playwright MCP Bridge** | Cài vào Chrome profile dùng cho Training |
| Tài khoản AI | Codex: `codex login` **hoặc** OpenAI API key. Cursor: Cursor API key. Cần ít nhất một trong hai. |

### Cài và chạy

```powershell
cd C:\Project\e2e_test
npm install
npm start            # build rồi mở app
# hoặc: npm run dev  # chế độ phát triển (hot reload giao diện)
```

- Đăng nhập Codex bằng tài khoản ChatGPT (không cần API key): `npx codex login`.
- Chỉ khi chọn trình duyệt **Chromium** trong Cài đặt mới cần chạy thêm: `npx playwright install chromium`.
- Dữ liệu (SQLite, artifact, file mẫu) nằm ở `%APPDATA%\E2E AI Trainer\data`. Muốn sao lưu thì copy thư mục này khi app đang tắt.

---

## 2. Thiết lập lần đầu

### 2.1 Cài đặt (góc phải thanh trên)

- **Agent**:
  - Codex: nhập OpenAI API key, hoặc bỏ trống nếu đã `codex login`.
  - Cursor: bắt buộc nhập API key.
  - Chọn model. Với Codex, nên để reasoning effort ở mức **medium**.
- **Runner**:
  - Trình duyệt: Chrome, Edge hoặc Chromium.
  - Headless: chạy ẩn hoặc hiện cửa sổ.
  - Giữ trình duyệt mở sau khi chạy.
  - Tốc độ thao tác: mặc định 500 ms mỗi thao tác.
- Bấm **Kiểm tra tích hợp agent** để xác nhận key và model dùng được.

### 2.2 Environment

1. Bấm **Thêm**, rồi nhập:
   - **Tên**.
   - **Base URL**.
   - **Allowed domains**: các domain mà script được phép truy cập.
   - **Biến secret**: tên các biến như `password` hay `otp`.
2. **Giá trị secret**: nhập giá trị thật. Giá trị được mã hoá trên máy, không đưa vào test case, prompt, script hay log.
3. **Runner auth**, phiên đăng nhập dùng cho Trial, Testing và Ghi thao tác:
   - Bấm **Mở trình duyệt để đăng nhập**.
   - Đăng nhập trang web trong cửa sổ vừa mở.
   - Bấm **Lưu phiên đăng nhập**.
   - Khi phiên hết hạn, app báo `AUTH_REQUIRED`. Làm lại bước này.
4. **Chrome profiles cho Training**, profile mà AI agent điều khiển qua extension:
   - **Chọn từ profile trên máy**, đặt **Nhãn hiển thị**.
   - Có thể nhập **Extension token** để khỏi phải bấm cho phép mỗi lần. Token lấy trong extension, dạng `PLAYWRIGHT_MCP_EXTENSION_TOKEN=…`.
   - Bấm **Đăng ký profile**.
5. Bấm **Chạy preflight** để kiểm tra kết nối. Preflight cần Chrome đang mở bằng profile đó, extension đã cài và đã được cho phép kết nối.

---

## 3. Test case

### Định dạng file

File `.xlsx` hoặc `.csv` gồm 5 cột:

| Cột | Cách ghi |
|---|---|
| `test_id` | Mã duy nhất, ví dụ `TC_CAMP_001` |
| `title` | Tên ngắn |
| `steps` | Mỗi dòng một bước (trong Excel dùng Alt+Enter để xuống dòng). Dữ liệu thay đổi được viết `{{ten_bien}}` |
| `input` | Giá trị mẫu cho mọi biến: `campaign_name: Summer Sale`, `key=value` hoặc JSON |
| `expected_result` | Điều nhìn thấy được trên màn hình. Người dùng dựa vào đây để đánh giá PASS/FAIL |

Quy tắc chính:

- **Nhóm**:
  - `.xlsx`: mỗi sheet là một nhóm, tên sheet là tên nhóm.
  - `.csv`: cả file là một nhóm, mang tên file.
  - Dự án được chọn khi Import.
- **Chụp màn hình**: ghi thành một bước riêng, ví dụ `Chụp màn hình danh sách campaign`. Script chỉ chụp ở các bước này.
- Không cần bước đăng nhập (runner đã có phiên), không cần bước "đợi". Chỉ ghi `Đóng trình duyệt` khi thật sự muốn đóng; khi đó nó phải là bước cuối.
- **Secret**: không ghi mật khẩu thật. Để giá trị là `SECRET`, sau khi import đánh dấu biến đó là secret và nhập giá trị ở Environment.
- **Tải file lên**: dùng bước `Tải file "Banner" = {{banner}}`, với input là tên file trần, ví dụ `banner: banner-sale.png`. Thêm file thật vào **File mẫu của dự án → Thêm file…**.

Bấm **Mở file mẫu** hoặc **Lưu file mẫu…** để có template kèm sheet "Hướng dẫn".

### Import

1. **Test Cases → Import .xlsx / .csv**, chọn dự án (hoặc **+ Dự án mới…**) và file.
2. Xem preview. Sửa hoặc bỏ các dòng lỗi.
3. Bấm **Xác nhận và lưu**.

Ngoài ra có thể **Tạo test case** trực tiếp. Bấm vào một dòng trong bảng để mở chi tiết, sửa steps, input schema và biến secret.

---

## 4. Training

Chọn test case, Environment, Agent (Codex hoặc Cursor) và Chrome profile. Nên bấm **Kiểm tra preflight** trước.

| Nút | Kết quả |
|---|---|
| **Ghi thao tác…** | Mở Chrome với runner auth, ghi lại thao tác của bạn thành script mới (không dùng AI) |
| **Agent Training Auto** | AI tự thực hiện các bước trên Chrome profile và viết script mới |
| **Gửi prompt** | AI **sửa candidate đang chọn** theo yêu cầu của bạn, ví dụ "sửa lỗi timeout ở bước Save". Enter để gửi, Shift+Enter để xuống dòng |

Khi ghi thao tác:

- Gõ đúng các giá trị input hiển thị trong hộp thoại. App sẽ thay chúng bằng `input.*` trong script.
- Thanh nổi ở góc dưới trang có các nút:
  - **›**: sang bước tiếp theo.
  - **📷**: chụp màn hình (thêm một lệnh chụp vào script).
  - **■ Kết thúc**: dừng ghi.
- Mật khẩu bạn gõ không được lưu vào script.

Với mỗi **Candidate** (một bản script), có thể:

- **So với #N**: xem diff với bản trước.
- **Sửa code**: sửa tay, tạo candidate mới.
- **Chạy Trial…**: chạy thử với input mẫu, xem ảnh, step log và lỗi.
- **Chấp nhận**: tạo version `vN` dùng cho Testing.
- **Từ chối**.

Mẹo:

- Nếu Trial lỗi, dùng **Gửi prompt** để AI sửa, thay vì chạy lại Agent Training Auto từ đầu. Kết quả Trial gần nhất của candidate (lỗi và step log) được gửi kèm tự động.
- Muốn sửa một candidate cũ thì chọn nó ở khung Candidate trước khi Gửi prompt.

---

## 5. Testing

1. Bấm **Chạy…** ở dòng test case, chọn version, environment và input (để trống thì dùng giá trị mẫu).
2. Lần chạy mở trong khung bên phải, gồm ảnh chụp, step log và trace.
3. Đánh giá **PASS** hoặc **FAIL** theo `expected_result`.
4. Các thao tác khác:
   - **Tải evidence (.zip)** để lưu bằng chứng.
   - **Send to Training**: đưa lần chạy lỗi sang Training làm ngữ cảnh sửa script.

Nếu lỗi thuộc loại LOCATOR hoặc ACTION (không tìm thấy hoặc không thao tác được phần tử), version bị đánh dấu `SUSPECTED_BROKEN`. Khi đó cần training lại.

**History** lưu lịch sử Trial và Testing, kèm audit log của mọi thay đổi.

---

## 6. Xử lý lỗi thường gặp

| Hiện tượng | Cách xử lý |
|---|---|
| `PROFILE_UNAVAILABLE`, preflight thất bại | Mở Chrome đúng profile, kiểm tra extension Playwright MCP Bridge đã bật, bấm cho phép kết nối (hoặc nhập Extension token) |
| `AUTH_REQUIRED` khi Trial, Testing hoặc Ghi | Environment → Runner auth → đăng nhập lại → **Lưu phiên đăng nhập** |
| AI không chọn được file khi tải lên | Vào trang chi tiết extension Playwright MCP Bridge, bật **Allow access to file URLs** |
| Thiếu file mẫu khi chạy | Test Cases → File mẫu của dự án → **Thêm file…** đúng tên trong input |
| Lỗi trùng dữ liệu (tên đã tồn tại) | Đổi giá trị input mỗi lần chạy, hoặc sửa script dùng giá trị duy nhất |
| `TimeoutError` ở một locator | Chọn candidate bị lỗi, dùng **Gửi prompt** mô tả bước bị lỗi để AI sửa locator hoặc thêm chờ |
| Agent báo lỗi key hoặc model | Cài đặt → **Kiểm tra tích hợp agent** |

---

## 7. Lệnh cho developer

```powershell
npm run typecheck    # kiểm tra kiểu TypeScript
npm test             # unit test (vitest)
npm run build        # build vào dist/
npm run demo-site    # web demo để thử nghiệm
npm run e2e:runner   # kiểm tra runner end-to-end với demo site
npm run smoke:ui     # smoke test giao diện (dữ liệu tạm trong .e2e-data/)
```

Tài liệu thiết kế chi tiết nằm ở `docs/superpowers/specs/2026-09-29-e2e-ai-trainer-design.md`.
