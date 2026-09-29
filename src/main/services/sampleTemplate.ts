import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { REQUIRED_COLUMNS } from "../../core/parser";

type SampleRow = Record<(typeof REQUIRED_COLUMNS)[number], string> & { group: string };

export const SAMPLE_ROWS: SampleRow[] = [
  {
    group: "Tạo campaign",
    test_id: "TC_CAMP_001",
    title: "Tạo campaign mới",
    steps: [
      "1. Mở trang Campaign",
      "2. Click Create Campaign",
      "3. Nhập Campaign Name = {{campaign_name}}",
      "4. Chọn Objective = {{objective}}",
      "5. Click Save",
      "6. Chụp màn hình danh sách campaign",
    ].join("\n"),
    input: ["campaign_name: Summer Sale", "objective: Sales"].join("\n"),
    expected_result: "Campaign mới xuất hiện trong danh sách với đúng Objective",
  },
  {
    group: "Tìm kiếm campaign",
    test_id: "TC_CAMP_002",
    title: "Tìm campaign trong danh sách",
    steps: ["1. Mở trang Campaign", "2. Tìm dòng có tên {{campaign_name}} trong bảng Campaigns", "3. Chụp màn hình", "4. Đóng trình duyệt"].join("\n"),
    input: "campaign_name=Summer Sale",
    expected_result: "Bảng hiển thị campaign có tên đã nhập",
  },
];

export const GUIDE_SHEET = "Hướng dẫn";

const GUIDE: [string, string][] = [
  ["Tên sheet", "Mỗi sheet là một nhóm test case; tên sheet được dùng làm tên nhóm (ví dụ: Tạo campaign, Tìm kiếm campaign). Dự án được chọn khi Import."],
  ["test_id", "Mã duy nhất của test case trên toàn bộ file và mọi dự án, ví dụ TC_CAMP_001."],
  ["title", "Tên ngắn của test case."],
  ["steps", "Mỗi dòng một bước (Alt+Enter để xuống dòng trong Excel). Dữ liệu thay đổi được viết dạng {{ten_bien}}."],
  ["Chụp màn hình", 'Ghi thành một bước riêng đúng chỗ cần ảnh kết quả, ví dụ "Chụp màn hình" hoặc "Chụp màn hình danh sách campaign". Script chỉ chụp ở các bước này; nếu không có bước nào, script chụp một ảnh sau bước cuối.'],
  ["Đóng trình duyệt", 'Ghi "Đóng trình duyệt" (hoặc "Đóng browser") làm bước cuối nếu muốn script tự đóng. Không ghi thì browser được giữ mở sau khi chạy (nếu bật trong Cài đặt) để người dùng xem.'],
  ["Tốc độ", "Không cần ghi bước chờ để chạy chậm lại: tốc độ thao tác khi chạy có giao diện được chỉnh trong Cài đặt → Runner → Tốc độ thao tác."],
  ["input", "Giá trị mẫu cho từng biến: YAML (campaign_name: Summer Sale), key=value mỗi dòng, hoặc JSON. Mọi {{bien}} trong steps phải có ở đây."],
  ["expected_result", "Kết quả mong đợi; người dùng tự đánh giá PASS/FAIL khi Testing."],
  ["Lưu ý", "Không ghi mật khẩu/token vào file. Đánh dấu biến là secret sau khi import và lưu giá trị ở màn Environment."],
  ["Lưu ý", "App đọc mọi sheet có cột test_id ở dòng 1; sheet khác (như sheet này) được bỏ qua. Có thể xoá các dòng ví dụ, đổi tên hoặc thêm sheet mới."],
];

export async function writeSampleXlsx(filePath: string) {
  const wb = new ExcelJS.Workbook();
  for (const group of [...new Set(SAMPLE_ROWS.map((r) => r.group))]) {
    const ws = wb.addWorksheet(group);
    ws.columns = [
      { header: "test_id", key: "test_id", width: 16 },
      { header: "title", key: "title", width: 30 },
      { header: "steps", key: "steps", width: 55 },
      { header: "input", key: "input", width: 32 },
      { header: "expected_result", key: "expected_result", width: 45 },
    ];
    ws.addRows(SAMPLE_ROWS.filter((r) => r.group === group));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2446C7" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.eachRow((row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
  }

  const guide = wb.addWorksheet(GUIDE_SHEET);
  guide.columns = [
    { header: "Mục", key: "col", width: 18 },
    { header: "Cách ghi", key: "desc", width: 100 },
  ];
  guide.addRows(GUIDE.map(([col, desc]) => ({ col, desc })));
  guide.getRow(1).font = { bold: true };
  guide.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  await wb.xlsx.writeFile(filePath);
}

/** CSV has no sheets: the whole file is one group named after the file. */
export async function writeSampleCsv(filePath: string) {
  const csv = Papa.unparse(SAMPLE_ROWS, { columns: [...REQUIRED_COLUMNS], newline: "\r\n" });
  // BOM so Excel opens the Vietnamese text as UTF-8.
  await writeFile(filePath, `\uFEFF${csv}`, "utf8");
}
