# E2E AI Trainer — Thiết kế triển khai MVP

Nguồn yêu cầu: `Web_E2E_AI_Training_Requirements.md` (v1.0 Final).

## 1. Công nghệ

| Thành phần | Lựa chọn |
|---|---|
| Desktop shell | Electron 44 (Node 24), `contextIsolation`, preload IPC có kiểu |
| UI | React 19 + Vite 8, tiếng Việt |
| Lưu trữ | SQLite qua `node:sqlite` (không cần native module) + thư mục artifact trong `userData` |
| Secret | Electron `safeStorage` (API key, extension token, runner storage state, secret của environment) |
| Training agent | `@openai/codex-sdk` (Codex CLI) và `@cursor/sdk` (local runtime) qua adapter chung |
| Browser tooling cho agent | `@playwright/mcp --extension --profile-dir-name=<dir>` (stdio) |
| Trial/Testing | Child process chạy bằng Electron-as-Node + `playwright` (Chrome cài sẵn hoặc Chromium) |
| Build | esbuild (main/preload/runner) + Vite (renderer), Vitest cho unit test |

## 2. Cấu trúc mã nguồn

```
src/shared   kiểu dữ liệu domain, trạng thái, hợp đồng IPC
src/core     logic thuần có unit test: parser, input schema, validator script, phân loại lỗi, luật trạng thái, auth rule
src/main     Electron main: DB, dịch vụ, training orchestrator, adapter, runner host, IPC
src/runner   tiến trình con chạy script Playwright đã transpile
src/preload  cầu nối window.api
src/renderer React UI (Test Cases, Environment, Training, Testing, History, Settings)
demo-site    website mẫu (login + campaign) để kiểm thử end-to-end
```

## 3. Luồng chính

**Import:** `.xlsx`/`.csv` → parse theo cột `test_id,title,steps,input,expected_result` → báo lỗi theo dòng/ô →
người dùng sửa bản parse → Xác nhận (lưu cả `raw_import` và bản đã xác nhận). `input` chấp nhận YAML/JSON/`key=value` mỗi dòng.
Biến `{{name}}` trong steps phải có trong input. Schema tạo từ key của input (kiểu string, required, có thể đánh dấu secret).
Bấm Import mở modal chọn **dự án** có sẵn hoặc nhập tên dự án mới (trùng tên, không phân biệt hoa/thường ⇒ dùng dự án có sẵn;
dự án mới chỉ được tạo khi xác nhận lưu). **Nhóm** = tên sheet: mọi sheet có cột `test_id` ở dòng 1 là một nhóm, sheet khác bị bỏ qua;
`.csv`/`.yaml` là một nhóm theo tên file. `test_id` duy nhất trên mọi dự án: import bị chặn nếu `test_id` đã thuộc dự án khác,
cùng dự án thì ghi đè. Danh sách Test Cases lọc theo dự án, nhóm và text. Test case có trước khi thêm dự án được đưa vào "Dự án mặc định".
Steps có thể có bước "Chụp màn hình…" và "Đóng trình duyệt" (nhận diện cả khi không dấu, `src/core/stepDirectives.ts`): prompt Training
liệt kê chính xác bước nào gọi `page.screenshot()` / `page.close()`; không có bước chụp ⇒ một ảnh sau bước cuối; không có bước đóng ⇒ script không đóng.
Validator cảnh báo (hiện trong khung Candidate) khi script lệch với các bước này. Prompt của người dùng được ưu tiên hơn.
Tốc độ thao tác: Playwright `slowMo` theo Cài đặt (mặc định 500 ms, chỉ khi chạy có giao diện); script không tự thêm waitForTimeout.
Xoá test case là xoá hẳn: cùng script, lượt Training, candidate, Trial, version (kể cả APPROVED), test run và thư mục artifacts/workspace;
modal liệt kê số lượng, bắt nhập lại `test_id` khi có version hoặc lịch sử Testing; bị chặn khi đang Training/Trial/Testing; audit log được giữ.

**Preflight:** app tự mở MCP client tới Playwright MCP (extension + profile dir đã chọn), navigate `base_url`,
trả `CONNECTED | PROFILE_UNAVAILABLE`. Không có bước kiểm tra đăng nhập (`auth_check`) — đã bỏ theo quyết định của người dùng;
agent tự báo `auth_required` nếu gặp trang đăng nhập trong lúc Training.

**Training attempt:** khóa profile → preflight → đảm bảo script + provider thread (tạo thread mới khi đổi agent hoặc
thread hỏng, `supersedes_thread_id`) → chuẩn bị workspace `workspaces/<script_id>/` với `candidate.ts` mới nhất →
gửi prompt qua adapter (MCP Playwright được cấp, `--allowed-origins`, `--output-dir` riêng cho attempt) → ghi mọi
tool event vào action log → đọc `candidate.ts` → validate AST (hàm `run(page, input)`, chỉ `input.<field>` thuộc schema,
không hardcode input mẫu/secret, không toạ độ chuột, không import/API ngoài danh sách cho phép) → nếu lỗi gửi lại tối đa 2
lượt sửa trong cùng thread → tạo candidate revision bất biến (`source_hash` sha256). Giới hạn thời gian và số browser action.

**Trial:** chạy đúng source của candidate trên browser context mới với runner storage state của environment
(chưa có storage state → `AUTH_REQUIRED`); step log, screenshot cuối, trace khi lỗi. `PASSED | FAILED | AUTH_REQUIRED`.

**Chấp nhận (Approve) / Từ chối:** người dùng toàn quyền, không phụ thuộc Trial. Chấp nhận được candidate `DRAFT` hoặc `REJECTED` (chưa `APPROVED`); Từ chối được candidate `DRAFT`. Nếu có trial `PASSED` khớp `candidate_id + source_hash + environment_id` thì version ghi kèm `trial_id`, không có thì `trial_id = NULL`.
Tạo version `vN` bất biến (lưu bản sao source).

**Testing:** chọn version `APPROVED`, input theo schema → runner → `COMPLETED` (review `PENDING` → người dùng PASS/FAIL + ghi chú)
hoặc `ERROR` với mã `LOCATOR | ACTION | TIMEOUT | AUTH_REQUIRED | DOMAIN_BLOCKED | EXCEPTION`. `LOCATOR/ACTION` →
version `SUSPECTED_BROKEN`. Send to Training tạo attempt mới trong thread của script với lỗi/log làm context.

## 4. Bảo mật

- Secret không nằm trong test case, prompt, script, log hiển thị; field schema `secret` được che `***` trong snapshot/log.
- Runner: tiến trình con, Node permission model (`--permission`, chỉ ghi vào thư mục run + temp), chặn điều hướng document ngoài `allowed_domains`,
  chỉ cho phép import `@playwright/test`/`playwright`. Backend không `eval` mã do model sinh.
- Không chạy 2 attempt đồng thời trên cùng profile; giới hạn số runner đồng thời; timeout cho mọi attempt/run.
- Audit log cho import, prompt, chọn agent/profile, candidate, trial, approve, test run, review. Dọn artifact theo số ngày lưu.

## 5. Kiểm thử

- Unit test (Vitest) cho `src/core`.
- End-to-end runner với `demo-site` (script viết tay đóng vai candidate): Trial PASSED, Approve, Testing 2 input, locator hỏng → ERROR + SUSPECTED_BROKEN.
- Spike tích hợp Codex/Cursor + Playwright Extension phải chạy trên máy người dùng (cần extension trong Chrome profile và API key).
