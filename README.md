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

Chỉ cần dùng được **một** trong hai agent. App chọn sẵn **Cursor**.

- **Cursor** (mặc định):
  - Nhập **Cursor API key** rồi bấm **Lưu**. Đã đăng nhập phần mềm Cursor vẫn phải nhập key. Key lấy ở trang tài khoản trên cursor.com.
  - Ở ô **Model Cursor**, chọn **Auto** để Cursor tự chọn model, giống app Cursor. Cũng có thể chọn một model cụ thể. Bấm **Lưu cài đặt** ở cuối trang.
- **Codex**:
  - Nếu máy này đã đăng nhập Codex bằng tài khoản ChatGPT, với cùng tài khoản Windows, thì **không cần nhập key**. Để trống ô OpenAI API key. Đăng nhập qua app Codex, extension Codex trong VS Code/Cursor, hoặc Codex CLI đều được.
  - Nếu chưa đăng nhập, nhập **OpenAI API key**.

### Bước 2 — Environment (trang web cần kiểm thử)

1. Bấm **Thêm**, rồi nhập:
   - **Tên**.
   - **Base URL**, ví dụ `https://app.example.com`.
   - Bấm **Lưu environment**.
2. Ở mục **Runner auth**:
   - Bấm **Mở trình duyệt để đăng nhập**.
   - Đăng nhập trang web như bình thường.
   - Bấm **Lưu phiên đăng nhập**.
   - App nhớ phiên này, nên test case **không cần** bước đăng nhập hay mật khẩu.
3. Ở mục **Chrome profiles cho Training**:
   - Bấm **Chọn từ profile trên máy**, chọn profile Chrome đã cài extension.
   - Bấm **Đăng ký profile**.
4. Mở Chrome bằng profile đó, đăng nhập trang web trên Chrome nếu chưa đăng nhập. Sau đó bấm **Chạy preflight**. Khi Chrome hỏi, bấm cho phép kết nối.

Mục **Giá trị secret** chỉ hiện khi có test case dùng biến bí mật, ví dụ test trang đăng nhập hoặc nhập API key vào form (xem mục 4). Bình thường bạn không cần làm gì ở đây.

App chỉ mở trang thuộc domain của Base URL. Nếu test case cần bấm sang trang ở domain khác (đăng nhập Google, cổng thanh toán, trang tài liệu…), bấm **Nâng cao: cho phép mở thêm domain khác** dưới ô Base URL. Điền domain đó, ví dụ `accounts.google.com`, rồi bấm **Lưu environment**.

### Bước 3 — Kiểm tra agent

Quay lại **Cài đặt**. Ở mục **Kiểm tra tích hợp agent**, bấm **Chạy kiểm tra** ở dòng **Cursor** (hoặc Codex nếu bạn dùng Codex). Kết quả báo thành công là được.

---

## 3. Thêm test case

Tự điền file Excel theo các bước dưới đây, hoặc nhờ AI viết giúp (xem **mục 4**).

1. Vào **Test Cases**, bấm **Mở file mẫu**. Excel sẽ mở một file mẫu mới.
2. Điền mỗi dòng một test case, rồi bấm **Ctrl+S** để lưu:

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
3. Bấm **Import .xlsx / .csv**, chọn dự án, chọn file vừa lưu (hộp chọn file mở sẵn thư mục chứa file mẫu), kiểm tra rồi bấm **Xác nhận và lưu**.

---

## 4. Nhờ AI viết test case (skill)

Thay vì tự điền Excel, bạn có thể nhờ AI trong **Cursor** viết. AI dùng skill có sẵn trong gói và tạo ra file Excel đúng định dạng để Import.

### Cài một lần

1. Cài **Node.js** bản LTS từ [nodejs.org](https://nodejs.org) (nếu máy chưa có).
2. Copy thư mục `skill\writing-e2e-test-cases` (nằm cạnh file exe) vào `C:\Users\<tên bạn>\.cursor\skills\`. Tạo thư mục `skills` nếu chưa có.
3. Khởi động lại Cursor.

### Cách dùng

1. Mở Cursor. Tốt nhất là mở thư mục **source code của trang web** cần test, vì khi có code, AI lấy đúng tên nút và tên ô trên màn hình. Không có code thì mô tả bằng lời cũng được.
2. Mở khung chat Agent, gõ yêu cầu bằng tiếng Việt, có chữ **"test case"**. Ví dụ ở bảng dưới.
3. AI tạo file `.xlsx`, thường trong thư mục `test-cases\`, rồi báo lại:
   - tên dự án nên chọn khi Import;
   - danh sách test case;
   - các biến bí mật (secret), nếu có;
   - các file mẫu cần thêm.
4. Mở file bằng Excel xem lại, rồi Import như **mục 3, bước 3**.
5. Làm theo những gì AI báo:
   - **Biến secret** (giá trị ghi là `SECRET`, hiếm gặp vì đăng nhập đã có Runner auth):
     1. Mở test case, tích cột **Secret** của biến đó.
     2. Vào Environment. Biến đó tự hiện ở mục **Giá trị secret**: nhập giá trị thật rồi bấm **Lưu**.
   - **File mẫu** (ảnh, video… để tải lên): vào **Test Cases → File mẫu của dự án → Thêm file…**, chọn đúng file có tên như AI báo.

### Ví dụ yêu cầu

| Tình huống | Gõ vào chat |
|---|---|
| Có source code, cần test một trang | `Viết test case cho trang Quản lý sản phẩm, dự án Shop Admin` |
| Nhiều tính năng, mỗi tính năng một sheet | `Viết test case cho Đăng nhập, Tạo campaign và Báo cáo, mỗi tính năng một sheet, lưu vào test-cases/ads-tool.xlsx` |
| Không có code, chỉ mô tả | `Viết test case tạo đơn hàng cho https://app.example.com: trang Đơn hàng có nút "Tạo đơn", ô "Khách hàng", ô "Số lượng", bấm "Lưu" thì hiện "Đã tạo đơn"` |
| Có tài liệu yêu cầu | `Đọc file docs/yeu-cau.md rồi viết test case cho phần Tạo đơn hàng` |
| Có tải file lên | `Viết test case tải ảnh banner ở trang Assets, gồm cả trường hợp file sai định dạng` |
| Chỉ cần case lỗi / kiểm tra dữ liệu | `Viết 5 test case negative cho form Tạo campaign (bỏ trống tên, ngân sách âm, ngày kết thúc trước ngày bắt đầu…), lưu thành file mới` |
| Muốn chụp ảnh ở nhiều bước | `Viết test case tạo sản phẩm, chụp màn hình form trước khi lưu và danh sách sau khi lưu` |

Mẹo:

- Nói rõ **tên dự án** để AI đặt mã test case không trùng với dự án khác.
- Muốn thêm case cho file đã có, bảo AI **lưu thành file mới** rồi Import vào cùng dự án. Test case cũ vẫn giữ nguyên.
- Không cần nhắc AI về đăng nhập: test case bắt đầu từ trạng thái đã đăng nhập sẵn.

---

## 5. Training — tạo kịch bản

Vào **Training**, chọn test case, Environment, Chrome profile và Agent (mặc định là **Cursor**). Sau đó dùng một trong ba nút:

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

## 6. Testing — chạy kiểm thử

1. Vào **Testing**, bấm **Chạy…** ở test case cần chạy.
2. Chọn version và Environment, sửa dữ liệu nếu muốn, rồi chạy.
3. Xem ảnh chụp và so với kết quả mong đợi, sau đó bấm **PASS** hoặc **FAIL**.
4. Các thao tác khác:
   - **Tải evidence (.zip)**: lưu bằng chứng.
   - **Send to Training**: đưa lần chạy lỗi sang Training để sửa kịch bản.

---

## 7. Gặp lỗi?

| Thông báo | Cách xử lý |
|---|---|
| `PROFILE_UNAVAILABLE` / preflight lỗi | Mở Chrome đúng profile, kiểm tra extension Playwright MCP Bridge đang bật, bấm cho phép kết nối |
| `AUTH_REQUIRED` | Phiên đăng nhập hết hạn. Vào Environment, Runner auth, đăng nhập lại và bấm **Lưu phiên đăng nhập** |
| "Không giải mã được secret" | Xảy ra khi copy app sang máy hoặc tài khoản Windows khác. Nhập lại API key, đăng nhập lại ở Runner auth |
| "Chưa cấu hình Cursor API key" | Vào Cài đặt nhập Cursor API key, hoặc chọn Codex ở Training |
| Codex báo lỗi đăng nhập dù không nhập key | Phiên đăng nhập Codex trên máy đã hết hạn hoặc thuộc tài khoản Windows khác. Đăng nhập lại Codex, hoặc nhập OpenAI API key |
| Tải file lên không được | Vào trang quản lý extension của Chrome, mở chi tiết Playwright MCP Bridge, bật **Allow access to file URLs** |
| `DOMAIN_BLOCKED` | Test case mở trang ở domain khác. Thêm domain trong lỗi vào Environment → **Nâng cao: cho phép mở thêm domain khác** |
| Báo trùng tên khi chạy lại | Đổi dữ liệu (ví dụ tên) trước khi chạy |
| AI viết test case nhưng không ra file Excel | Kiểm tra đã copy đúng thư mục skill, đã cài Node.js và đã khởi động lại Cursor. Trong chat, thêm câu `dùng skill writing-e2e-test-cases` |
| Import báo `test_id` đã thuộc dự án khác | Bảo AI: `đổi mã test case, thêm mã dự án vào đầu`, rồi Import lại |
| Lỗi `Timeout` ở một bước | Ở Training, dùng **Gửi prompt** mô tả bước bị lỗi để AI sửa |
