#!/usr/bin/env node
// Validates a test case spec (JSON) and writes an .xlsx or .csv file in the E2E AI Trainer import format.
// .xlsx: one sheet per group (the sheet name is the group in the app) + a guide sheet.
// .csv: a single group; the app names it after the file.
// Zero dependencies. Usage:
//   node make_testcases.mjs <spec.json | -> --out <file.xlsx|file.csv> [--force]
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const COLUMNS = ["test_id", "title", "steps", "input", "expected_result"];
const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ID_RE = /^[A-Za-z0-9_.-]+$/;
const SECRET_NAME_RE = /pass(word)?|pwd|secret|token|api_?key|otp|pin\b|credential/i;
const SECRET_PLACEHOLDER = "SECRET";
const GUIDE_SHEET = "Hướng dẫn";
const DEFAULT_GROUP = "Test cases";
const SHEET_BAD_CHARS = /[:\\/?*[\]]/;
// Same detection as E2E AI Trainer (src/core/stepDirectives.ts).
const fold = (t) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase();
const SCREENSHOT_STEP_RE = /\bchup\s+(lai\s+)?(man\s*hinh|anh|ket\s*qua|trang|toan)|\bchup\s*(lai\s*)?[.:]?$|screenshot|\bcapture\b/;
const CLOSE_STEP_RE = /\b(dong|tat|close|thoat)\b.*\b(trinh duyet|browser|tab|cua so|window)\b/;
// File inputs: the value is the bare name of a file in the project's fixtures (app: input type "file").
const UPLOAD_STEP_RE = /\b(tai\s+(file|tep|anh)|tai\s+len|upload|chon\s+(file|tep)|dinh\s+kem|attach)\b/;
const FILE_VALUE_RE = /^[^\\/:*?"<>|]+\.(png|jpe?g|gif|webp|svg|bmp|ico|pdf|docx?|xlsx?|pptx?|csv|txt|json|xml|zip|rar|7z|mp4|mov|avi|mkv|webm|mp3|wav)$/i;
const PATH_RE = /[\\/]|^[A-Za-z]:/;

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const specPath = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out");
const out = opt("--out");
if (!specPath || !out) {
  console.error("Usage: node make_testcases.mjs <spec.json | -> --out <file.xlsx|file.csv> [--force]");
  process.exit(2);
}
const format = extname(out).toLowerCase();
if (format !== ".xlsx" && format !== ".csv") {
  console.error(`--out phải có đuôi .xlsx hoặc .csv (nhận: ${out})`);
  process.exit(2);
}
if (existsSync(out) && !args.includes("--force")) {
  console.error(`File đã tồn tại: ${out}. Thêm --force để ghi đè.`);
  process.exit(2);
}

// ---------- load & normalise ----------
let spec;
try {
  spec = JSON.parse(readFileSync(specPath === "-" ? 0 : specPath, "utf8").replace(/^\uFEFF/, ""));
} catch (e) {
  console.error(`Không đọc được spec JSON: ${e.message}`);
  process.exit(2);
}
// Accepts [...cases], { cases: [...] } or { groups: [{ name, cases: [...] }] }; a case may also carry "group".
let rawCases;
if (Array.isArray(spec?.groups)) {
  rawCases = spec.groups.flatMap((g) => (Array.isArray(g?.cases) ? g.cases : []).map((c) => ({ ...c, group: c?.group ?? g?.name })));
} else {
  rawCases = Array.isArray(spec) ? spec : spec?.cases;
}
if (!Array.isArray(rawCases) || rawCases.length === 0) {
  console.error('Spec phải là mảng test case, { "cases": [...] } hoặc { "groups": [{ "name", "cases": [...] }] } và không rỗng.');
  process.exit(2);
}

const errors = [];
const warnings = [];
const seen = new Map();

const cases = rawCases.map((c, i) => {
  const where = `#${i + 1} ${c?.test_id ?? ""}`.trim();
  const err = (m) => errors.push(`${where}: ${m}`);
  const warn = (m) => warnings.push(`${where}: ${m}`);
  const str = (v) => (v === undefined || v === null ? "" : String(v).trim());

  const test_id = str(c?.test_id);
  const group = str(c?.group).replace(/\s+/g, " ") || DEFAULT_GROUP;
  const title = str(c?.title);
  const expected_result = str(c?.expected_result);
  const steps = (Array.isArray(c?.steps) ? c.steps : str(c?.steps).split(/\r?\n/))
    .map((s) => str(s).replace(/^\s*(?:[-*•]|\d+[.)])\s*/, ""))
    .filter(Boolean);
  const input = c?.input ?? {};

  if (!test_id) err("thiếu test_id");
  else if (!ID_RE.test(test_id)) err(`test_id "${test_id}" chỉ được dùng chữ, số, _ . -`);
  else if (seen.has(test_id)) err(`test_id trùng với ${seen.get(test_id)}`);
  else seen.set(test_id, `#${i + 1}`);
  if (!title) err("thiếu title");
  if (steps.length === 0) err("thiếu steps");
  if (!expected_result) err("thiếu expected_result");
  if (typeof input !== "object" || Array.isArray(input)) err("input phải là object { bien: giá trị }");

  const used = new Set();
  const uploadVars = new Set();
  for (const s of steps) {
    for (const m of s.matchAll(VAR_RE)) {
      used.add(m[1]);
      if (UPLOAD_STEP_RE.test(fold(s)) && !/\b(xuong|download)\b/.test(fold(s))) uploadVars.add(m[1]);
    }
  }
  const files = {};
  for (const [k, v] of Object.entries(input)) {
    const value = String(v ?? "");
    const looksLikeFile = !value.includes("://") && FILE_VALUE_RE.test(value.split(/[\\/]/).pop());
    if (!uploadVars.has(k) && !looksLikeFile) continue;
    if (PATH_RE.test(value)) err(`"${k}" là biến file: chỉ ghi tên file (ví dụ "banner.png"), không kèm thư mục/ổ đĩa`);
    else if (uploadVars.has(k) && !/\.[A-Za-z0-9]{1,8}$/.test(value)) warn(`"${k}" dùng ở bước tải file nhưng giá trị "${value}" không giống tên file (thiếu đuôi .png/.pdf…)`);
    else files[k] = value;
  }
  for (const v of used) if (!(v in input)) err(`biến {{${v}}} trong steps không có trong input`);
  for (const [k, v] of Object.entries(input)) {
    if (!FIELD_RE.test(k)) err(`tên biến không hợp lệ "${k}" (chữ/số/_ và không bắt đầu bằng số)`);
    if (v !== null && typeof v === "object") err(`giá trị của "${k}" phải là chuỗi/số/boolean`);
    if (!used.has(k)) warn(`biến "${k}" có trong input nhưng không dùng trong steps`);
    if (SECRET_NAME_RE.test(k) && String(v) !== SECRET_PLACEHOLDER) {
      err(`"${k}" trông như secret: đặt giá trị "${SECRET_PLACEHOLDER}" thay cho giá trị thật`);
    }
  }
  for (const s of steps) {
    if (/\b(xpath|css selector|querySelector)\b|\/\/\w+\[|#[\w-]+\s*>/i.test(s)) warn(`step dùng selector kỹ thuật: "${s}"`);
    if (/\b(đợi|chờ|wait|sleep)\s+\d+\s*(giây|s|ms|seconds?)\b/i.test(s)) warn(`step chờ theo thời gian cố định: "${s}"`);
    if (/\b(toạ độ|tọa độ|coordinates?|x\s*=\s*\d+)/i.test(s)) warn(`step dùng toạ độ: "${s}"`);
  }
  const shotSteps = steps.map((s, k) => (SCREENSHOT_STEP_RE.test(fold(s)) ? k : -1)).filter((k) => k >= 0);
  const closeSteps = steps.map((s, k) => (CLOSE_STEP_RE.test(fold(s)) ? k : -1)).filter((k) => k >= 0);
  if (steps.length && shotSteps.length === 0) warn('không có bước "Chụp màn hình" — Trial/Testing sẽ chỉ có một ảnh sau bước cuối');
  if (closeSteps.length) warn('có bước "Đóng trình duyệt" — chỉ giữ nếu người dùng yêu cầu; mặc định không thêm, app tự giữ/đóng browser theo Cài đặt');
  if (closeSteps.length > 1) err('có nhiều bước "Đóng trình duyệt"; chỉ được một, ở cuối');
  else if (closeSteps.length === 1 && closeSteps[0] !== steps.length - 1) err(`bước "Đóng trình duyệt" phải là bước cuối (đang là bước ${closeSteps[0] + 1}/${steps.length})`);
  if (closeSteps.length && shotSteps.some((k) => k > closeSteps[0])) err('bước "Chụp màn hình" nằm sau bước "Đóng trình duyệt"');
  return { group, test_id, title, steps, input, expected_result, files };
});

// ---------- groups (= sheet names) ----------
const groups = [...new Set(cases.map((c) => c.group))];
const groupKeys = new Map();
for (const g of groups) {
  if (g.length > 31) errors.push(`nhóm "${g}": tên sheet Excel tối đa 31 ký tự`);
  if (SHEET_BAD_CHARS.test(g)) errors.push(`nhóm "${g}": tên sheet không được chứa : \\ / ? * [ ]`);
  if (/^'|'$/.test(g)) errors.push(`nhóm "${g}": tên sheet không được bắt đầu/kết thúc bằng dấu '`);
  const key = g.toLocaleLowerCase("vi");
  if (key === GUIDE_SHEET.toLocaleLowerCase("vi")) errors.push(`nhóm "${g}": trùng tên sheet hướng dẫn, hãy đặt tên khác`);
  if (groupKeys.has(key)) errors.push(`nhóm "${g}" trùng với "${groupKeys.get(key)}" (Excel không phân biệt hoa/thường)`);
  else groupKeys.set(key, g);
}
if (format === ".csv" && groups.length > 1) {
  errors.push(`CSV chỉ chứa được một nhóm (có ${groups.length}: ${groups.join(", ")}). Dùng --out .xlsx hoặc tách thành nhiều file CSV.`);
}
if (groups.length > 1 && cases.some((c) => c.group === DEFAULT_GROUP) && rawCases.some((c) => !String(c?.group ?? "").trim())) {
  warnings.push(`có case không ghi "group" nên được đưa vào nhóm "${DEFAULT_GROUP}"`);
}

for (const w of warnings) console.warn(`WARN  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\n${errors.length} lỗi — sửa spec rồi chạy lại. Chưa ghi file.`);
  process.exit(1);
}

// ---------- cell text ----------
const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;
function yamlScalar(v) {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v ?? "");
  return /^\p{L}[\p{L}\p{N} _.,@/()'-]*$/u.test(s) && !YAML_RESERVED.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s);
}
const rows = cases.map((c) => ({
  group: c.group,
  test_id: c.test_id,
  title: c.title,
  steps: c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
  input: Object.entries(c.input)
    .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
    .join("\n"),
  expected_result: c.expected_result,
}));

mkdirSync(dirname(resolve(out)), { recursive: true });
if (format === ".csv") writeCsv(out, rows);
else writeXlsx(out, rows);

const secrets = [...new Set(cases.flatMap((c) => Object.entries(c.input).filter(([, v]) => String(v) === SECRET_PLACEHOLDER).map(([k]) => k)))];
console.log(`OK  ${rows.length} test case, ${groups.length} nhóm → ${resolve(out)}`);
for (const g of groups) {
  console.log(`  [${format === ".csv" ? `nhóm trong app = tên file "${basename(out, extname(out))}"` : `sheet "${g}"`}]`);
  for (const c of cases.filter((x) => x.group === g)) console.log(`    ${c.test_id}  ${c.title}`);
}
if (secrets.length) console.log(`Biến cần đánh dấu secret sau khi import: ${secrets.join(", ")}`);
const fileVars = [...new Set(cases.flatMap((c) => Object.keys(c.files)))];
const fileNames = [...new Set(cases.flatMap((c) => Object.values(c.files)))];
if (fileVars.length) {
  console.log(`Biến kiểu file (app tự nhận khi import): ${fileVars.join(", ")}`);
  console.log(`File mẫu cần thêm vào dự án (Test Cases → File mẫu của dự án): ${fileNames.join(", ")}`);
}

// ---------- writers ----------
function writeCsv(file, data) {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [COLUMNS.join(","), ...data.map((r) => COLUMNS.map((c) => q(r[c])).join(","))];
  writeFileSync(file, `\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

function writeXlsx(file, data) {
  const esc = (s) =>
    String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const colName = (i) => String.fromCharCode(65 + i);
  const sheet = (header, body, widths) => {
    const cell = (r, c, v, s) => `<c r="${colName(c)}${r}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    const rowsXml = [header, ...body]
      .map((vals, r) => `<row r="${r + 1}">${vals.map((v, c) => cell(r + 1, c, v, r === 0 ? 1 : 2)).join("")}</row>`)
      .join("");
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` +
      `<sheetData>${rowsXml}</sheetData></worksheet>`
    );
  };
  const guide = [
    ["Tên sheet", "Mỗi sheet là một nhóm test case; tên sheet là tên nhóm trong E2E AI Trainer. Dự án được chọn khi Import. Sheet không có cột test_id (như sheet này) được bỏ qua."],
    ["test_id", "Mã duy nhất của test case trên toàn file và mọi dự án trong app."],
    ["title", "Tên ngắn nói mục tiêu của test case."],
    ["steps", "Mỗi dòng một bước (Alt+Enter để xuống dòng). Dữ liệu thay đổi viết dạng {{ten_bien}}."],
    ["Chụp màn hình", "Bước riêng đúng chỗ cần ảnh kết quả (\"Chụp màn hình\", \"Chụp màn hình danh sách sản phẩm\"). Script chỉ chụp ở các bước này."],
    ["Đóng trình duyệt", "Thường không cần: app tự giữ hoặc đóng browser sau khi chạy theo Cài đặt. Chỉ ghi \"Đóng trình duyệt\" làm bước cuối khi muốn chính script đóng browser."],
    ["input", "Giá trị mẫu cho từng biến, mỗi dòng: ten_bien: giá trị. Mọi {{bien}} trong steps phải có ở đây."],
    ["expected_result", "Kết quả nhìn thấy được sau bước cuối; người dùng tự đánh giá PASS/FAIL khi Testing."],
    ["Secret", `Không ghi mật khẩu/token thật. Dùng giá trị ${SECRET_PLACEHOLDER}, đánh dấu biến là secret sau khi import và lưu giá trị ở Environment.`],
    ["Tải file lên", "Bước: Tải file \"<nhãn ô>\" = {{ten_bien}}; input ghi đúng tên file (ví dụ banner.png), không kèm thư mục. App tự nhận biến kiểu file khi import; chỉ cần thêm file vào \"File mẫu của dự án\" ở trang Test Cases."],
  ];
  const sheets = [
    ...groups.map((g) => ({
      name: g,
      xml: sheet(COLUMNS, data.filter((r) => r.group === g).map((r) => COLUMNS.map((c) => r[c])), [16, 32, 60, 34, 48]),
    })),
    { name: GUIDE_SHEET, xml: sheet(["Mục", "Cách ghi"], guide, [18, 100]) },
  ];
  const files = {
    "[Content_Types].xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml":
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
      `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FF2446C7"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    ...Object.fromEntries(sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml])),
  };
  writeFileSync(file, zip(files));
}

// Minimal ZIP (deflate) writer.
function zip(files) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
