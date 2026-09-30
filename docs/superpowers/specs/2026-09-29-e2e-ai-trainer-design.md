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
Runner luôn chụp `page.screenshot()` cả trang từ trên xuống (ép `fullPage: true`, bỏ `clip`; ảnh của locator giữ nguyên). Trang kiểu app shell
(menu cố định, layout `100vh`, nội dung cuộn trong khung `overflow: auto`) thì document không cuộn nên `fullPage` không thấy phần dưới: `src/runner/fullPage.ts`
tìm khung cuộn chính (≥ 40% rộng, ≥ 50% cao của viewport ban đầu), tạm kéo cao viewport thêm đúng phần bị ẩn (tối đa 16000px, lặp ≤ 3 lần), chụp rồi trả
viewport cũ; nếu kéo cao mà phần ẩn không giảm (khung cao cố định) thì hoàn lại, không chụp khoảng trắng. Dropdown, menu, bảng nhỏ có cuộn riêng không được mở rộng.
Khung xem ảnh trong app: slide nhỏ thu ảnh vừa khung (ảnh cao hơn 1.2× chiều rộng có nhãn "Ảnh cả trang"); chế độ phóng to hiện ảnh vừa chiều rộng và cuộn dọc,
không thu theo chiều cao, để đọc được ảnh cả trang.
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
Codex nhận mức suy nghĩ từ Cài đặt `codex_reasoning_effort` (`low | medium | high | xhigh`, mặc định `medium`; để trống = theo
`~/.codex/config.toml` của người dùng). Đo trên các lượt thật, 85–99% thời gian Training là thời gian model suy nghĩ, nên đây là đòn bẩy
chính về tốc độ và chi phí; cấu hình cá nhân mức cao (ví dụ `ultra`) làm Training rất chậm.

**Tham chiếu theo dự án (Cài đặt `training_project_refs`, mặc định bật):** mỗi lượt Training ghi lại `workspaces/<script_id>/reference/`
từ version APPROVED mới nhất của các test case khác cùng dự án (tối đa 6 script / 60 KB, xếp theo độ giống của tiêu đề + steps, cùng nhóm được cộng điểm;
`src/core/projectReferences.ts`), kèm `README.md` liệt kê steps, trang (`goto`/`waitForURL`) và locator đọc từ AST. Prompt dặn agent dùng lại
điều hướng/locator, không chép dữ liệu. Khi script bắt đầu từ đầu (chưa có candidate hoặc Training lại từ đầu), environment có runner auth và đủ secret
⇒ **soạn nháp**: agent viết thẳng phần đã có trong tham chiếu, chỉ dùng MCP cho trang chưa có; app chạy `candidate.ts` bằng runner (ẩn, không slowMo,
input mẫu + secret của environment, artifact trong thư mục attempt), lỗi thì gửi log cho agent sửa trong cùng thread (tối đa 2 vòng, `draftVerify.ts`).
Candidate là đúng source của lần chạy cuối và lần chạy đó được lưu thành Trial của candidate (`trial.training_verify`).

**Ghi thao tác (không dùng AI):** người dùng đã duyệt lệch khỏi mục "human takeover ngoài phạm vi" của yêu cầu.
Nút "Ghi thao tác…" ở Training mở modal nhập input mẫu. Điều kiện: environment có runner auth, script không đang Training, và chỉ một phiên ghi tại một thời điểm.
App mở Chrome riêng bằng Playwright, dùng storage state runner auth của environment (không copy cookie từ profile Training), bật recorder của Playwright
(`context._enableRecorder`, API riêng — ghim `playwright@1.63.0`). Một thanh nổi (custom element `e2e-rec-bar`, shadow root đóng, gọi app qua `exposeBinding`)
cho chuyển bước trước/sau, đánh dấu "Chụp màn hình" (tự sang bước kế nếu bước hiện tại là bước chụp) và "Kết thúc"; thanh công cụ riêng của recorder bị ẩn.
Trang Training hiện thanh trạng thái đang ghi và khoá Training/sửa tay/xoá cho test case đó. Kết thúc (hoặc đóng Chrome) → `src/core/recording.ts`:
bỏ nhiễu (click trên thanh nổi, click lấy focus trước khi gõ, click submit sau Enter, click vào khung danh sách thả xuống — class có
dropdown/popper/popover/listbox/menu — ngay trước khi chọn option/menuitem, điều hướng lặp), giữ locator của recorder, thay giá trị khớp input mẫu bằng
`input.<field>` (kể cả trong locator, khớp một phần ⇒ template string), giá trị secret ⇒ field secret (không khớp ⇒ `""` + ghi chú), chèn `// Step N`, `page.screenshot({ fullPage: true })` cho mỗi lần bấm 📷,
`page.waitForURL` trước ảnh khi đã chuyển trang, `page.close()` nếu đã tới bước "Đóng trình duyệt". Tab khác, giá trị không khớp input ⇒ ghi chú
"Ghi thao tác — cần xem lại" ở đầu script. Kết quả là candidate `origin = recorded` (nhãn GHI THAO TÁC), `DRAFT`, đi tiếp Trial/Chấp nhận như candidate AI.
AI không tự chạy sau khi ghi; người dùng muốn sửa thì gửi prompt như bình thường (agent nhận candidate mới nhất làm ngữ cảnh).

**Selector ổn định khi ghi** (`src/core/selectorStability.ts`, `src/main/recording/stableLocator.ts`): recorder chỉ dùng id/class khi phần tử không có
test id, role + tên, label, placeholder hay text — thường là ô chọn của UI framework (Element Plus: `#el-id-4190-146`, đổi mỗi lần tải trang).
`fragileReason` nhận ra id tự sinh (`el-id-*`, `:r1:`, `mui-*`, `radix-*`, `headlessui-*`, id có ≥ 3 chữ số liền…), class mã băm (`css-*`, CSS modules),
class bố cục (Tailwind/Bootstrap), chuỗi CSS ≥ 2 dấu `>` và `nth=`. Ngay sau thao tác, app lấy đúng phần tử trên trang đang mở, liệt kê ứng viên
(`data-testid`/`data-test`/`data-qa`/`data-cy`, `name`, `aria-label`, rồi "trong container có class ổn định gần nhất chứa label" + role/class/tag của
phần tử, rồi class ổn định của chính nó) và giữ ứng viên đầu tiên khớp đúng 1 phần tử và đúng phần tử đó, ví dụ
`page.locator('.el-form-item').filter({ has: page.getByText('Account', { exact: true }) }).getByRole('combobox')`. Mỗi selector tra một lần, tối đa 5 giây,
chờ xong trước khi đóng trình duyệt. Không tìm được ⇒ giữ selector cũ, chèn `// Cần sửa: selector dễ đổi (…)` và ghi chú đầu script. Validator cảnh báo
`FRAGILE_SELECTOR` cho `locator('<css>')` dễ hỏng (cả script AI); prompt Training dặn tránh các mẫu này.

**Tải file lên (biến kiểu `file`):** giá trị của biến là *tên* một file mẫu của dự án (`userData/fixtures/<project_id>/`, ngoài artifacts nên
không bị dọn; xoá dự án thì xoá luôn). Trang Test Cases có khung "File mẫu của dự án" (thêm qua hộp chọn file của main process, tối đa 50 MB/file,
tên được làm sạch thành tên file Windows hợp lệ; xoá có xác nhận). Form input (Training/Trial/Testing/Ghi thao tác, giá trị mẫu trong schema) chọn
từ danh sách này. Import tự đặt kiểu `file` cho biến nằm trong bước tải lên ("Tải file", "Upload", "Chọn file", "Đính kèm"; không tính "tải xuống")
hoặc có giá trị là tên file trần với đuôi phổ biến (`inferFileFields`); đường dẫn và URL giữ `string`. Chạy (Trial/Testing/kiểm chứng nháp): `resolveInput` đổi tên → đường dẫn tuyệt đối trong `input.<field>` (kiểu TS `string`);
thiếu file ⇒ lỗi input trước khi chạy; snapshot chỉ lưu tên. Training: kiểm tra file tồn tại khi bắt đầu, chép file mẫu vào `mcp-output/fixtures/`
của attempt (thư mục `--output-dir` mà Playwright MCP luôn cho đọc, không cần `--allow-unrestricted-file-access`), prompt liệt kê đường dẫn cho
`browser_file_upload` và yêu cầu script dùng `setInputFiles(input.<field>)`. Ở chế độ `--extension`, Chrome từ chối `DOM.setFileInputFiles`
("Not allowed") nếu extension Playwright MCP Bridge chưa bật "Cho phép truy cập vào URL của tệp": prompt dặn agent không thử lại/lách
(input ẩn, kéo-thả, chờ `filechooser`) mà vẫn viết `setInputFiles(input.<field>)` để runner kiểm chứng; app nhận ra lỗi (`isFileAccessDenied`),
hiện hướng dẫn bật quyền một lần trong hoạt động của agent và ghi kèm vào lỗi của attempt nếu thất bại. Validator chặn `setInputFiles`/`setFiles` với chuỗi cố định
(`HARDCODED_FILE`). Ghi thao tác: recorder (chế độ api) báo chọn file thành `fill('C:\fakepath\<tên>')` (hoặc `setInputFiles` với tên file) ⇒ đổi thành
`setInputFiles(input.<field>)` khi tên khớp input mẫu của biến file (hoặc chỉ có một biến file, kèm ghi chú); nhiều file hoặc không có biến file ⇒ ghi chú
"cần sửa tay". Chưa hỗ trợ: tải file xuống, kéo-thả file.

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
- Ghi thao tác: chỉ giữ `name/selector/text/key/options/url/files` của action recorder (bỏ `ariaSnapshot` vì chứa giá trị đã gõ, kể cả mật khẩu);
  event chỉ nằm trong bộ nhớ và bị xoá sau khi tạo candidate; `action_log.json` chỉ chứa code đã thay input/secret.
- Không chạy 2 attempt đồng thời trên cùng profile; giới hạn số runner đồng thời; timeout cho mọi attempt/run.
- Audit log cho import, prompt, chọn agent/profile, candidate, trial, approve, test run, review. Dọn artifact theo số ngày lưu.

## 5. Kiểm thử

- Unit test (Vitest) cho `src/core`.
- End-to-end runner với `demo-site` (script viết tay đóng vai candidate): Trial PASSED, Approve, Testing 2 input, locator hỏng → ERROR + SUSPECTED_BROKEN.
- UI smoke (`scripts/smoke-ui.mjs`) có phần Ghi thao tác: nối vào Chrome đang ghi qua `E2E_RECORDING_CDP_PORT` (chỉ đặt khi test), thao tác thật trên
  demo-site, bấm thanh nổi bằng chuột, kiểm tra script sinh ra dùng `input.*`, đủ ảnh và Trial PASSED với input khác.
- Tải file: demo-site có `/assets/upload` (multipart) và `/assets`; runner check chạy `setInputFiles(input.banner)` với file ngoài thư mục run;
  UI smoke thêm file mẫu cho dự án, ghi thao tác upload, Trial PASSED (site nhận đủ 2048 bytes), xoá file mẫu ⇒ Trial báo thiếu file.
- Spike tích hợp Codex/Cursor + Playwright Extension phải chạy trên máy người dùng (cần extension trong Chrome profile và API key).
