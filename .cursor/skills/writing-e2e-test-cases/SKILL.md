---
name: writing-e2e-test-cases
description: Creates web E2E test case files (.xlsx with one sheet per test case group, or .csv) with the columns test_id, title, steps, input, expected_result — the import format of E2E AI Trainer — for any project, by reading its routes, UI labels, forms and docs. Use when the user asks to write, create or generate test cases, an E2E test suite, or an Excel/CSV test case file for a website, page or feature ("viết/tạo test case", "file test case", "bộ test case").
---

# Viết file test case E2E

Kết quả: một file `.xlsx` (mặc định) hoặc `.csv` có đúng 5 cột `test_id, title, steps, input, expected_result`, import được vào E2E AI Trainer (Test Cases → Import) mà không có lỗi.

Cách app đọc file:
- **Dự án** không nằm trong file: người dùng chọn dự án có sẵn hoặc nhập tên dự án mới trong modal Import.
- **Nhóm** = tên sheet. Với `.xlsx`, mỗi sheet có cột `test_id` ở dòng 1 là một nhóm. Các sheet khác (ví dụ "Hướng dẫn") bị bỏ qua.
- Với `.csv` / `.yaml`, cả file là **một** nhóm, lấy theo tên file (ví dụ `Đăng nhập.csv` → nhóm "Đăng nhập").
- `test_id` phải duy nhất trong cả file **và** trên mọi dự án trong app. Import vào dự án B sẽ bị chặn nếu `test_id` đã thuộc dự án A. Import lại vào cùng dự án thì ghi đè test case cũ.

## Quy trình

```
- [ ] 1. Chốt phạm vi
- [ ] 2. Đọc project để lấy luồng và nhãn UI thật
- [ ] 3. Chọn danh sách case
- [ ] 4. Viết spec JSON
- [ ] 5. Chạy script tạo file (sửa đến khi hết ERROR)
- [ ] 6. Báo cáo
```

**1. Chốt phạm vi.** Cần biết: tính năng/trang nào, vai trò người dùng, nơi lưu file, và **tên dự án** sẽ chọn khi import (mặc định là tên project/repo). Nếu người dùng chưa nói và không suy ra được từ project, hỏi ngắn gọn (dùng AskQuestion). Mặc định lưu ở `test-cases/<du-an>.xlsx` trong project. Một file `.xlsx` có thể chứa nhiều nhóm (mỗi nhóm một sheet).

**2. Đọc project.** Lấy thông tin từ code thật, không đoán:
- Route/trang: file router, thư mục `pages/`/`app/`/`views/`, controller.
- Nhãn hiển thị: text trong JSX/template, file i18n (`locales/*.json`), `aria-label`, `placeholder`, tên nút.
- Form: tên trường, giá trị hợp lệ của select, quy tắc validate và thông báo lỗi.
- Test/tài liệu sẵn có: Playwright/Cypress spec, user story, README, requirement.
Nếu không có code UI (chỉ có mô tả hoặc URL), dùng mô tả của người dùng và ghi rõ những nhãn còn phải xác nhận.

**3. Chọn case và chia nhóm.** Luồng chính (happy path) trước, rồi validate/negative và biên quan trọng. Mỗi case một mục tiêu, chạy độc lập (không dựa vào case khác), tự mở trang đầu tiên. Khoảng 3–10 case cho một tính năng, trừ khi người dùng yêu cầu khác. Chia case theo nhóm: mặc định mỗi tính năng/màn hình một nhóm ("Đăng nhập", "Quản lý sản phẩm"…), hoặc theo cách người dùng muốn.

**4. Viết spec JSON** vào file tạm (ví dụ `.tmp/test-cases.json`), theo mẫu ở dưới và các quy tắc viết.

**5. Tạo file** — script nằm trong thư mục của skill này (cạnh `SKILL.md`); dùng đường dẫn tuyệt đối, không dùng `~` (PowerShell không mở rộng `~` cho lệnh ngoài):
```bash
node <thư-mục-skill>/scripts/make_testcases.mjs .tmp/test-cases.json --out test-cases/campaign.xlsx
```
- Đuôi `--out` quyết định định dạng: `.xlsx` (mỗi nhóm một sheet, thêm sheet "Hướng dẫn") hoặc `.csv` (UTF-8 BOM, mở được bằng Excel).
- `.csv` chỉ chứa được một nhóm, và tên file chính là tên nhóm trong app. Vì vậy hãy đặt tên file theo nhóm, ví dụ `test-cases/Đăng nhập.csv`. Nếu có nhiều nhóm thì dùng `.xlsx` hoặc tách thành nhiều file CSV.
- `ERROR` → sửa spec, chạy lại; script không ghi file khi còn lỗi. `WARN` → xem lại, sửa nếu hợp lý.
- File đã tồn tại → hỏi người dùng trước khi thêm `--force`.
- Chỉ cần Node, không cài thêm gói. Xoá file spec tạm sau khi xong.

**6. Báo cáo:** đường dẫn file, tên dự án nên chọn khi Import, danh sách nhóm kèm các `test_id — title` của từng nhóm, các nhãn UI còn phải xác nhận, các biến cần đánh dấu secret sau khi import, và (nếu có bước tải file) các biến kiểu file cùng danh sách file mẫu cần thêm vào dự án (script in ra). Khi import, app tự đặt kiểu `file` cho biến nằm trong bước tải file lên hoặc có giá trị là tên file (`.png`, `.mp4`, `.pdf`…). Người dùng chỉ cần vào trang Test Cases → "File mẫu của dự án" → "Thêm file…" để thêm đúng các file đó.

## Quy tắc viết

- **group** (tên nhóm = tên sheet): ngắn, theo tính năng ("Đăng nhập", "Tạo campaign"). Tối đa 31 ký tự, không chứa `: \ / ? * [ ]`, không bắt đầu/kết thúc bằng `'`, không trùng nhau (không phân biệt hoa/thường), không đặt là "Hướng dẫn". Script sẽ kiểm tra các điều kiện này.
- **test_id**: `TC_<TINHNANG>_<NNN>`, duy nhất, chỉ chữ/số/`_`/`.`/`-`. Nếu người dùng có nhiều dự án trong app, thêm mã dự án để không trùng giữa các dự án: `TC_<DUAN>_<TINHNANG>_<NNN>`.
- **title**: ngắn, nói mục tiêu ("Tạo campaign với Objective Sales").
- **steps**: mảng, mỗi phần tử một hành động người dùng nhìn thấy được:
  - Dùng đúng nhãn trên UI: `Click nút "Save"`, `Nhập "Campaign Name" = {{campaign_name}}`, `Chọn "Objective" = {{objective}}`.
  - Bước đầu mở trang cụ thể: `Mở trang Campaign (/campaigns)`.
  - Không selector CSS/XPath, không toạ độ, không "đợi 3 giây". Không cần bước chờ để chạy chậm lại: tốc độ thao tác do app chỉnh (Cài đặt → Runner → Tốc độ thao tác).
  - **Chụp màn hình** là một bước riêng, đặt ngay sau bước làm kết quả hiện ra, ghi rõ chụp gì: `Chụp màn hình danh sách sản phẩm`. Script Training tạo ra chỉ chụp đúng ở các bước này, nên mỗi case cần ít nhất một bước chụp, thường là ở cuối. Có thể có nhiều bước chụp (ví dụ trước và sau khi lưu).
  - **Không thêm bước `Đóng trình duyệt`** ở cuối steps. Việc giữ hay đóng browser sau khi chạy do Cài đặt của app quyết định. Chỉ thêm khi người dùng yêu cầu rõ cho case đó; khi đó nó phải là bước cuối, chỉ một lần.
  - Script kiểm tra hai loại bước này. Nó báo WARN khi thiếu bước chụp hoặc khi có bước đóng (để xác nhận người dùng thật sự yêu cầu), và báo ERROR khi bước đóng không nằm cuối hoặc có bước chụp đứng sau bước đóng.
  - Không có bước đăng nhập (runner đã có phiên đăng nhập riêng), trừ khi chính case đó kiểm tra đăng nhập.
- **Biến `{{ten_bien}}`**: cho mọi dữ liệu người chạy có thể thay đổi (tên, số lượng, lựa chọn). Tên snake_case ASCII. Nhãn UI cố định không phải biến. Dữ liệu cần duy nhất mỗi lần chạy (tên bản ghi…) phải là biến.
- **input**: object, mỗi biến trong steps có một giá trị mẫu thực tế; không thừa biến.
- **expected_result**: điều nhìn thấy được trên màn hình sau bước cuối (dòng mới trong bảng, thông báo, URL, giá trị hiển thị) — người dùng tự đánh giá PASS/FAIL theo câu này. Không mô tả trạng thái trong DB/API.
- **Tải file lên**: viết bước `Tải file "<nhãn ô>" = {{ten_bien}}` (hoặc `Chọn file "…"`, `Đính kèm "…"`), mỗi file một biến. Giá trị trong input là **đúng tên file**, có đuôi, không kèm thư mục (`"banner": "banner-sale.png"`). Script báo ERROR khi giá trị có đường dẫn. App lưu file mẫu theo dự án và đổi tên thành đường dẫn khi chạy, nên cùng một tên dùng được cho mọi case trong dự án. Case negative (file quá lớn, sai định dạng) dùng tên file riêng (`"file-qua-lon.pdf"`), và người dùng phải tự chuẩn bị file đó. Chưa hỗ trợ tải file xuống, kéo-thả file, hay chọn nhiều file trong một ô.
- **Secret**: không bao giờ ghi mật khẩu, token, API key thật. Biến secret có giá trị `"SECRET"`; sau khi import người dùng đánh dấu biến đó là secret và lưu giá trị ở màn Environment. Script báo lỗi nếu biến có tên kiểu `password`/`token` mà giá trị khác `SECRET`.
- **Ngôn ngữ**: title/steps/expected_result theo ngôn ngữ người dùng (mặc định tiếng Việt); nhãn UI giữ nguyên văn như trên màn hình.

## Mẫu spec JSON

Mỗi phần tử của `groups` trở thành một sheet (theo đúng thứ tự trong spec):

```json
{
  "groups": [
    {
      "name": "Tạo campaign",
      "cases": [
        {
          "test_id": "TC_CAMP_001",
          "title": "Tạo campaign mới",
          "steps": [
            "Mở trang Campaign (/campaigns)",
            "Click nút \"Create Campaign\"",
            "Nhập \"Campaign Name\" = {{campaign_name}}",
            "Chọn \"Objective\" = {{objective}}",
            "Click nút \"Save\"",
            "Chụp màn hình danh sách campaign"
          ],
          "input": { "campaign_name": "Summer Sale", "objective": "Sales" },
          "expected_result": "Quay về Campaign List và bảng có dòng tên đã nhập với đúng Objective"
        }
      ]
    }
  ]
}
```

Script cũng nhận `{ "cases": [...] }`, trong đó mỗi case có trường `"group"`. Case không có `group` sẽ vào nhóm "Test cases".

Không viết như sau: `"steps": ["Đăng nhập admin/123456", "Click #btn-save", "Đợi 3 giây", "Đóng trình duyệt", "Chụp màn hình", "Kiểm tra DB có bản ghi"]`. Ví dụ này có bước đăng nhập với mật khẩu thật, dùng selector, chờ cố định, chụp màn hình sau khi đã đóng trình duyệt, và kết quả không nhìn thấy trên UI.

## Tài nguyên

- Ví dụ spec nhiều case (happy path, validate, secret): [examples.md](examples.md)
