# Requirement final: Công cụ AI Training và chạy web E2E test

**Phiên bản:** 1.0 Final  
**Ngày:** 29/09/2026  
**Phạm vi:** MVP triển khai trên máy của người dùng có Chrome và website test

## 1. Mục tiêu và nguyên tắc

Công cụ nhận manual test case, để AI thực hiện các bước trên website trong **Training**, tạo Playwright TypeScript script, cho người dùng xem, chạy thử, yêu cầu AI sửa bằng prompt, rồi duyệt. **Testing** chỉ chạy phiên bản script đã duyệt và cung cấp evidence để người dùng đánh giá PASS/FAIL.

- **Script = HOW:** cách đi qua UI, locator, action và điều kiện chờ.
- **Test Case Input = WHAT:** dữ liệu cho mỗi run, được truyền qua biến; không hardcode giá trị training vào script.
- **Expected Result = HUMAN VERIFY:** người dùng xem evidence và quyết định kết quả nghiệp vụ. Lỗi chạy script được báo riêng là `ERROR`.
- Testing không gọi AI và không tự sửa script. Mọi thay đổi sau khi duyệt tạo candidate mới, trial lại và duyệt version mới.
- Một người dùng thực hiện toàn bộ thao tác. MVP không phân vai trò hoặc quy trình duyệt nhiều người.

## 2. Phạm vi MVP và môi trường chạy

1. Import `.xlsx`/`.csv` theo template gồm `test_id`, `title`, `steps`, `input`, `expected_result`; xem và sửa bản parse trước khi Training.
2. Mỗi test case có **một script** trong MVP. Một script có nhiều candidate revision và nhiều approved version.
3. Training chọn **một trong hai agent: Codex hoặc Cursor**. Kết nối Chrome profile đã đăng nhập thông qua Playwright MCP + Playwright Extension, đọc cấu trúc trang, thao tác và tạo script.
4. Người dùng xem candidate script và evidence, bấm **Run Trial**, nhập prompt sửa/training lại, lặp cho đến khi đạt rồi **Approve**.
5. Testing chạy script APPROVED với input của run, lưu screenshot cuối, log lỗi và cho người dùng chọn PASS/FAIL.
6. Lưu lịch sử prompt, revisions, versions, trial và test runs; xuất script và evidence.

**Triển khai MVP:** Training worker và Playwright MCP chạy **trên cùng máy với Chrome profile của người dùng**. Backend/UI có thể chạy trên máy đó hoặc kết nối tới worker; không giả định cloud worker có thể truy cập trực tiếp Chrome profile trên máy người dùng. Trial/Testing runner được phép chạy tại máy này nhưng dùng browser context và auth state riêng.

**Ngoài phạm vi:** AI tự xác nhận expected result; human takeover trực tiếp trong phiên browser; tự sửa script khi Testing; nhiều người dùng/phân quyền; native mobile/desktop test; visual regression và load test; thư viện script tái sử dụng giữa nhiều test case.

## 3. Dữ liệu

| Đối tượng | Trường chính | Quy tắc |
|---|---|---|
| Test case | `test_id`, `title`, `steps[]`, `input_schema`, `expected_result` | `test_id` duy nhất; giữ cả dữ liệu import gốc và bản đã xác nhận |
| Environment | `environment_id`, `base_url`, `allowed_domains`, `auth_check`, `runner_auth_ref` | `auth_check` là URL/locator hoặc quy tắc do người dùng cấu hình để xác nhận đã đăng nhập |
| Training profile | `browser_profile_id`, `display_name`, `profile_dir_name`, `browser`, `machine_id` | Tên hiển thị không dùng làm định danh kết nối; không lưu cookie/password trong bản ghi profile |
| Script | `script_id`, `test_id`, `active_agent`, `training_thread_id` | Một script/test case trong MVP; agent có thể đổi theo quy trình tại mục 5 |
| Provider thread | `provider`, `provider_thread_id`, `script_id`, `created_at`, `supersedes_thread_id` | Thread thuộc riêng một provider; ID nội bộ khác ID của Codex/Cursor |
| Candidate revision | `candidate_id`, `revision_no`, `source`, `action_log_ref`, `source_hash`, `provider_thread_id`, `created_at` | Bất biến sau khi tạo; sửa bằng prompt tạo revision mới |
| Trial run | `trial_id`, `candidate_id`, `source_hash`, `environment_id`, `input_snapshot`, `status`, `evidence_refs` | Chạy không AI; ghi đúng mã nguồn đã chạy |
| Approved version | `script_id`, `version_no`, `candidate_id`, `source_hash`, `approved_at` | Nội dung bất biến; một version gắn với một candidate đã trial thành công |
| Test run | `run_id`, `test_id`, `version_no`, `environment_id`, `input_snapshot`, `execution_status`, `review_result`, `evidence_refs` | Truy vết được toàn bộ đầu vào và kết quả |

**Template ví dụ:**

```yaml
test_id: TC_CREATE_CAMPAIGN_001
title: Tạo campaign
steps:
  - Mở trang Campaign
  - Click Create Campaign
  - Nhập Campaign Name = {{campaign_name}}
  - Chọn Objective = {{objective}}
  - Click Save
input:
  campaign_name: Summer Sale 2026
  objective: Sales
expected_result: Campaign xuất hiện trong Campaign List.
```

Parser báo lỗi dòng/ô thiếu hoặc biến trong steps không có trong `input_schema`. Input của run được kiểm tra theo schema trước khi bắt đầu. Secret và auth state được lưu riêng, không đặt trong file test case, prompt, script hoặc log hiển thị.

## 4. Chọn agent và browser profile

### 4.1 Agent

- UI cho chọn `Codex` hoặc `Cursor` khi bắt đầu Training script. Dùng **Codex SDK** hoặc **Cursor SDK** để tạo/tiếp tục agent thread; ứng dụng dùng adapter chung để gửi test case/prompt và nhận event, source, lỗi.
- Mỗi script có một provider thread đang hoạt động. Các prompt chỉnh sửa tiếp tục thread đó. `training_thread_id` là ID nội bộ; lưu ID thread/session thật của provider.
- Agent được cấp Playwright MCP để đọc accessibility snapshot/DOM qua browser tooling, click/fill/navigate và lấy locator hoặc mã Playwright. Screenshot chỉ dùng khi cấu trúc trang không đủ. Kết quả tool và mã script thực tế phải được lưu; không coi lời kể của agent là action log.
- Agent có thể trực tiếp viết/sửa script trong workspace của Training worker. Sau mỗi lượt, hệ thống snapshot nội dung script thành candidate revision bất biến. Nếu agent chỉ đưa ra code trong chat mà không có candidate file hợp lệ, lượt Training chưa hoàn tất.
- Có giới hạn thời gian và số action cho từng lượt; lỗi hoặc mơ hồ thì dừng với lý do và evidence để người dùng gửi prompt tiếp theo.

### 4.2 Profile và đăng nhập

1. Người dùng đăng ký các Chrome profile mà worker có thể kết nối: nhãn dễ đọc và `profile_dir_name` thật (ví dụ `Profile 1`). Playwright Extension phải được cài trong profile cần dùng.
2. Người dùng chọn profile **bằng UI** trước mỗi lượt Training. Nếu prompt có nhắc profile khác, UI báo xung đột để người dùng chọn lại; prompt không tự đổi profile.
3. Worker khởi tạo/kết nối Playwright MCP với extension và `--profile-dir-name=<profile_dir_name>`. Không bỏ tham số này vì extension có thể mặc định nối profile được dùng gần nhất.
4. Preflight mở/kiểm tra trang thuộc environment bằng đúng profile đã chọn, chạy `auth_check` và hiển thị `CONNECTED`, `AUTH_REQUIRED` hoặc `PROFILE_UNAVAILABLE`. Chỉ bắt đầu AI khi `CONNECTED` và `auth_check` thành công. Nếu không cấu hình được một phép kiểm tra đăng nhập đáng tin cậy, người dùng phải cấu hình nó trước khi Training.
5. Nếu phiên đăng nhập hết hạn trong lúc Training, dừng với `AUTH_REQUIRED`, lưu step/evidence; sau khi người dùng đăng nhập lại, lượt tiếp theo vẫn dùng profile đã chọn. Không tự fallback sang profile khác.

**Profile của Training và xác thực của runner là hai cấu hình riêng.** Trial/Testing khởi tạo browser context mới từ `runner_auth_ref` của environment, ví dụ Playwright storage state dành riêng cho runner. Người dùng tạo/cập nhật auth state này bằng một phiên đăng nhập riêng. Không tự sao chép cookie sống từ Chrome profile Training. Nếu runner chưa đăng nhập, Trial/Testing báo `AUTH_REQUIRED` trước action đầu tiên.

## 5. Training và revision

### 5.1 Lượt Training đầu tiên

1. Người dùng chọn test case, environment, agent, profile và input mẫu.
2. Hệ thống preflight profile/login, tạo script + provider thread nếu chưa có, gửi cho agent test case, input schema, input mẫu, base URL và chỉ dẫn về output script.
3. Agent thực hiện các manual steps trên đúng browser/profile, ghi tool events và tạo Playwright TypeScript script. Một manual step có thể gồm nhiều actions.
4. Hệ thống kiểm tra candidate: file hợp lệ, có hàm `run(page, input)`, tham chiếu các biến input đúng schema, không hardcode training input hoặc secret, không dùng tọa độ màn hình làm locator mặc định. Chưa đạt thì trả lỗi để agent sửa trong cùng lượt hoặc đánh dấu lượt `FAILED`.
5. Lưu `candidate revision`, action log, source hash, screenshot cuối và lỗi (nếu có). Người dùng xem script và đối chiếu steps trước khi trial.

### 5.2 Trial và prompt chỉnh sửa

1. **Run Trial** chạy đúng source hash của candidate từ đầu trên browser context mới với runner auth state; không dùng AI để tự sửa giữa run. Lưu step logs, screenshot cuối và trace khi lỗi.
2. Trial `PASSED` nghĩa là script chạy hết actions mà không lỗi thực thi; chưa khẳng định expected result nghiệp vụ đúng. Trial `FAILED` giữ nguyên candidate để xem và yêu cầu sửa.
3. Người dùng nhập prompt; hệ thống gửi prompt vào **cùng provider thread**, kèm candidate mới nhất, step lỗi/trial result và artifact liên quan. Agent tạo candidate revision mới. Người dùng xem và trial lại. Không ghi đè revision trước.
4. Nếu người dùng đổi `Codex ↔ Cursor`, hệ thống tạo provider thread **mới** cho cùng script từ test case, candidate, prompt và trial result đã lưu, liên kết thread cũ. Không chuyển nguyên lịch sử hội thoại giữa hai SDK và không thay approved version hiện có.
5. Nếu thread provider không thể tiếp tục, tạo thread thay thế cùng provider từ dữ liệu đã lưu. Lịch sử chat không phải nguồn duy nhất của script hay trạng thái Training.

### 5.3 Approve

Nút **Approve** chỉ khả dụng khi người dùng đã xem candidate và tồn tại trial `PASSED` cho **đúng `candidate_id`, `source_hash` và `environment_id`**. Approve tạo version bất biến `v1`, `v2`...; lưu thời điểm và người thực hiện. Nếu source thay đổi dù một dòng sau trial, phải chạy trial lại. Người dùng có thể từ chối candidate hoặc gửi thêm prompt; hệ thống không tự approve.

## 6. Testing

1. Chọn test case, environment, approved version và input run. Hệ thống xác thực schema input và runner auth.
2. Playwright runner chạy script version đã khóa trong context cô lập; không gọi Codex/Cursor. Lưu step log, thời gian, screenshot cuối, lỗi và trace nếu có.
3. Nếu script không chạy hết vì locator, timeout, auth hoặc exception: `execution_status = ERROR` với mã lỗi cụ thể. Lỗi auth không tự đánh dấu script hỏng. Lỗi locator/action đánh dấu version `SUSPECTED_BROKEN`; run vẫn trỏ đến version gốc.
4. Nếu chạy hết: `execution_status = COMPLETED`, `review_result = PENDING`. Người dùng xem expected result + evidence rồi chọn `PASS` hoặc `FAIL`, có thể thêm ghi chú. PASS/FAIL là đánh giá của người dùng, tách khỏi trạng thái thực thi.
5. Từ run `ERROR`, người dùng chọn **Send to Training**: mở lại script và provider thread của nó, đưa step lỗi/log/trace vào context, tạo candidate mới. Chỉ sau trial và Approve mới có version tiếp theo.

Version `SUSPECTED_BROKEN` vẫn xem được trong lịch sử nhưng không được chọn cho run mới; người dùng có thể tiếp tục dùng version APPROVED khác hoặc duyệt bản sửa. Version cũ và run cũ không bị thay đổi.

## 7. Trạng thái

| Đối tượng | Trạng thái | Ý nghĩa |
|---|---|---|
| Training attempt | `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `AUTH_REQUIRED` | Mỗi prompt tạo một attempt; lỗi không xóa candidate trước |
| Candidate revision | `DRAFT`, `APPROVED`, `REJECTED` | Nội dung revision bất biến; trial là bản ghi riêng |
| Trial run | `QUEUED`, `RUNNING`, `PASSED`, `FAILED`, `AUTH_REQUIRED` | PASSED chỉ là thành công thực thi |
| Script version | `APPROVED`, `SUSPECTED_BROKEN`, `RETIRED` | Version bất biến; status là metadata |
| Test execution | `QUEUED`, `RUNNING`, `COMPLETED`, `ERROR` | Tách khỏi review result |
| Test review | `PENDING`, `PASS`, `FAIL` | Chỉ có sau execution COMPLETED |

## 8. Giao diện MVP

- **Test Cases:** import, xem/sửa bản parse, input schema và expected result.
- **Environment:** base URL, allowed domains, phép kiểm tra login, runner auth state và nút kiểm tra kết nối.
- **Training:** chọn Codex/Cursor và profile, xem preflight/login, prompt history, actions, candidate source/diff, screenshot/lỗi; Run Trial, prompt sửa và Approve.
- **Testing:** chọn approved version/input, xem tiến độ, expected result, evidence và PASS/FAIL; Send to Training khi lỗi.
- **History:** lọc theo test ID, agent, script version, environment, trạng thái và thời gian; tải script/evidence.

## 9. Bảo mật và vận hành

- Chỉ cho agent thao tác các domain được cấu hình cho environment. Browser profile chỉ kết nối theo ID đã chọn; không tự chuyển profile.
- Mỗi Training attempt và Trial/Test run có timeout; worker giới hạn số phiên chạy đồng thời. Không chạy hai Training attempts đồng thời trên cùng profile.
- Không đưa password, cookie hoặc storage state vào prompt. Che secret trong log; screenshot/trace có thể chứa dữ liệu nhạy cảm nên chỉ người dùng có quyền truy cập và đặt thời hạn lưu.
- Lưu audit log cho import, prompt, agent/profile đã chọn, candidate, trial, approve, test run và review. Mỗi run giữ ID riêng và trỏ đến artifact theo thời hạn lưu trữ.
- Script do AI tạo được kiểm tra và chạy trong worker có giới hạn quyền truy cập filesystem/network theo environment; không thực thi mã do model sinh bằng `eval` trong backend ứng dụng.

## 10. Tiêu chí nghiệm thu

1. Import test case mẫu; parser báo rõ biến/ô lỗi và tạo input schema hợp lệ.
2. Cả **Codex** và **Cursor** đều có thể được chọn cho Training và tạo candidate Playwright TypeScript trên cùng flow mẫu. Nếu một SDK không kết nối được Playwright MCP + profile trong môi trường triển khai, không tuyên bố tính năng của agent đó hoàn tất.
3. Chọn profile đã đăng nhập thì preflight thành công và agent thao tác đúng profile; profile chưa đăng nhập báo `AUTH_REQUIRED` trước action đầu; không fallback sang profile khác.
4. Candidate dùng `input.<field>`, không hardcode input mẫu; source, action/tool log và hash được lưu. Người dùng xem được kết quả cuối mà không takeover browser.
5. Người dùng nhập hai prompt sửa trên cùng agent/script; cả hai tiếp tục provider thread, tạo revision riêng và giữ lịch sử sau khi mở lại ứng dụng.
6. Trial chạy từ context mới bằng runner auth, không gọi agent; chỉ candidate/hash/environment có trial PASSED mới được Approve.
7. Testing cùng một approved version chạy được với hai input khác nhau; nếu locator hỏng thì run ERROR và version SUSPECTED_BROKEN, Send to Training tạo candidate mới mà không đổi version cũ.
8. Run COMPLETED hiển thị expected result và evidence; người dùng chọn PASS/FAIL; tra được test case, input, environment, script source/version, agent, logs và screenshot.
9. Đổi agent cho cùng script tạo provider thread mới từ dữ liệu lưu, không mất candidate/version trước và yêu cầu trial lại trước khi Approve.

## 11. Ghi chú kỹ thuật khi bắt đầu triển khai

- Khởi đầu bằng một spike trên máy đích: Codex SDK và Cursor SDK lần lượt nối Playwright MCP Extension đến `Profile 1`, chạy preflight login, lấy action/code và lưu candidate; tiếp đó chạy trial Playwright bằng runner auth riêng. Đây là phép kiểm tra tích hợp bắt buộc trước khi đánh dấu mỗi adapter hoạt động.
- Playwright MCP hỗ trợ chọn profile qua `--extension --profile-dir-name=...`, dùng accessibility snapshot và trả Playwright code theo action. Khả năng này là của **Playwright MCP**, không mặc nhiên là API của browser extension trong ChatGPT Desktop.
- Có thể dùng Node.js/TypeScript cho worker, Playwright cho Trial/Testing và PostgreSQL để lưu dữ liệu. Queue và artifact storage có thể bổ sung khi cần nhiều run; đây là lựa chọn triển khai, không phải phụ thuộc chức năng của MVP.

Tài liệu tham chiếu kỹ thuật: [Playwright MCP browser extension](https://playwright.dev/mcp/configuration/browser-extension), [Playwright MCP testing/code output](https://playwright.dev/mcp/tools/assertions), [Playwright authentication](https://playwright.dev/docs/auth), [Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript), [Cursor SDK](https://cursor.com/docs/sdk/typescript).
