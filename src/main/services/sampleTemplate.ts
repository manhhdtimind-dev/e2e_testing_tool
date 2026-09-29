import { writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { REQUIRED_COLUMNS } from "../../core/parser";

type SampleRow = Record<(typeof REQUIRED_COLUMNS)[number], string>;

export const SAMPLE_ROWS: SampleRow[] = [
  {
    test_id: "TC_CAMP_001",
    title: "Tạo campaign mới",
    steps: ["1. Mở trang Campaign", "2. Click Create Campaign", "3. Nhập Campaign Name = {{campaign_name}}", "4. Chọn Objective = {{objective}}", "5. Click Save"].join("\n"),
    input: ["campaign_name: Summer Sale", "objective: Sales"].join("\n"),
    expected_result: "Campaign mới xuất hiện trong danh sách với đúng Objective",
  },
  {
    test_id: "TC_CAMP_002",
    title: "Tìm campaign trong danh sách",
    steps: ["1. Mở trang Campaign", "2. Tìm dòng có tên {{campaign_name}} trong bảng Campaigns"].join("\n"),
    input: "campaign_name=Summer Sale",
    expected_result: "Bảng hiển thị campaign có tên đã nhập",
  },
];

const GUIDE: [string, string][] = [
  ["test_id", "Mã duy nhất của test case, ví dụ TC_CAMP_001."],
  ["title", "Tên ngắn của test case."],
  ["steps", "Mỗi dòng một bước (Alt+Enter để xuống dòng trong Excel). Dữ liệu thay đổi được viết dạng {{ten_bien}}."],
  ["input", "Giá trị mẫu cho từng biến: YAML (campaign_name: Summer Sale), key=value mỗi dòng, hoặc JSON. Mọi {{bien}} trong steps phải có ở đây."],
  ["expected_result", "Kết quả mong đợi; người dùng tự đánh giá PASS/FAIL khi Testing."],
  ["Lưu ý", "Không ghi mật khẩu/token vào file. Đánh dấu biến là secret sau khi import và lưu giá trị ở màn Environment."],
  ["Lưu ý", "App chỉ đọc sheet đầu tiên. Có thể xoá các dòng ví dụ và thêm test case của bạn."],
];

export async function writeSampleXlsx(filePath: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Test cases");
  ws.columns = [
    { header: "test_id", key: "test_id", width: 16 },
    { header: "title", key: "title", width: 30 },
    { header: "steps", key: "steps", width: 55 },
    { header: "input", key: "input", width: 32 },
    { header: "expected_result", key: "expected_result", width: 45 },
  ];
  ws.addRows(SAMPLE_ROWS);
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2446C7" } };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  const guide = wb.addWorksheet("Hướng dẫn");
  guide.columns = [
    { header: "Cột", key: "col", width: 18 },
    { header: "Cách ghi", key: "desc", width: 100 },
  ];
  guide.addRows(GUIDE.map(([col, desc]) => ({ col, desc })));
  guide.getRow(1).font = { bold: true };
  guide.eachRow((row) => {
    row.alignment = { vertical: "top", wrapText: true };
  });

  await wb.xlsx.writeFile(filePath);
}

export async function writeSampleCsv(filePath: string) {
  const csv = Papa.unparse(SAMPLE_ROWS, { columns: [...REQUIRED_COLUMNS], newline: "\r\n" });
  // BOM so Excel opens the Vietnamese text as UTF-8.
  await writeFile(filePath, `\uFEFF${csv}`, "utf8");
}
