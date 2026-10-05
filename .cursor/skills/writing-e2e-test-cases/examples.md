# Ví dụ spec

Trang admin của dự án "Shop Admin" có hai nhóm: "Quản lý sản phẩm" và "Cài đặt kho". Ví dụ có đủ các loại case: luồng chính, validate, tìm kiếm, và dữ liệu secret. Khi xuất ra `.xlsx`, mỗi nhóm thành một sheet cùng tên.

Mỗi case có bước "Chụp màn hình…" ngay sau khi kết quả hiện ra. Case TC_PROD_001 chụp hai lần (form trước khi lưu và danh sách sau khi lưu). Không case nào có bước "Đóng trình duyệt"; việc giữ hay đóng browser sau khi chạy do Cài đặt của app quyết định.

```json
{
  "groups": [
    {
      "name": "Quản lý sản phẩm",
      "cases": [
        {
          "test_id": "TC_PROD_001",
          "title": "Thêm sản phẩm mới",
          "steps": [
            "Mở trang Sản phẩm (/admin/products)",
            "Click nút \"Thêm sản phẩm\"",
            "Nhập \"Tên sản phẩm\" = {{product_name}}",
            "Nhập \"Giá\" = {{price}}",
            "Chọn \"Danh mục\" = {{category}}",
            "Chụp màn hình form trước khi lưu",
            "Click nút \"Lưu\"",
            "Chụp màn hình danh sách sản phẩm"
          ],
          "input": { "product_name": "Áo thun basic", "price": 199000, "category": "Thời trang" },
          "expected_result": "Hiện thông báo \"Đã lưu sản phẩm\" và danh sách có dòng tên đã nhập với giá đã nhập"
        },
        {
          "test_id": "TC_PROD_002",
          "title": "Không cho lưu khi giá âm",
          "steps": [
            "Mở trang Sản phẩm (/admin/products)",
            "Click nút \"Thêm sản phẩm\"",
            "Nhập \"Tên sản phẩm\" = {{product_name}}",
            "Nhập \"Giá\" = {{price}}",
            "Click nút \"Lưu\"",
            "Chụp màn hình form đang báo lỗi"
          ],
          "input": { "product_name": "Sản phẩm lỗi giá", "price": -1 },
          "expected_result": "Form vẫn mở, dưới ô Giá hiện lỗi \"Giá phải lớn hơn 0\", sản phẩm không xuất hiện trong danh sách"
        },
        {
          "test_id": "TC_PROD_003",
          "title": "Tìm sản phẩm theo tên",
          "steps": [
            "Mở trang Sản phẩm (/admin/products)",
            "Nhập ô tìm kiếm \"Tìm sản phẩm\" = {{keyword}}",
            "Nhấn Enter",
            "Chụp màn hình kết quả tìm kiếm"
          ],
          "input": { "keyword": "Áo thun" },
          "expected_result": "Danh sách chỉ còn các sản phẩm có tên chứa từ khoá đã nhập"
        },
        {
          "test_id": "TC_PROD_004",
          "title": "Tải ảnh đại diện cho sản phẩm",
          "steps": [
            "Mở trang Sản phẩm (/admin/products)",
            "Click nút \"Thêm sản phẩm\"",
            "Nhập \"Tên sản phẩm\" = {{product_name}}",
            "Tải file \"Ảnh sản phẩm\" = {{product_image}}",
            "Click nút \"Lưu\"",
            "Chụp màn hình chi tiết sản phẩm"
          ],
          "input": { "product_name": "Áo khoác gió", "product_image": "ao-khoac.png" },
          "expected_result": "Trang chi tiết hiện ảnh vừa tải và tên file ao-khoac.png dưới ô Ảnh sản phẩm"
        }
      ]
    },
    {
      "name": "Cài đặt kho",
      "cases": [
        {
          "test_id": "TC_WH_001",
          "title": "Kết nối kho hàng bằng API key",
          "steps": [
            "Mở trang Cài đặt kho (/admin/settings/warehouse)",
            "Nhập \"API key\" = {{warehouse_api_key}}",
            "Click nút \"Kiểm tra kết nối\"",
            "Chụp màn hình trạng thái kết nối"
          ],
          "input": { "warehouse_api_key": "SECRET" },
          "expected_result": "Hiện trạng thái \"Đã kết nối\" màu xanh"
        }
      ]
    }
  ]
}
```

Kết quả script cho spec này (`--out test-cases/shop-admin.xlsx`):

```
OK  5 test case, 2 nhóm → .../test-cases/shop-admin.xlsx
  [sheet "Quản lý sản phẩm"]
    TC_PROD_001  Thêm sản phẩm mới
    ...
  [sheet "Cài đặt kho"]
    TC_WH_001  Kết nối kho hàng bằng API key
Biến cần đánh dấu secret sau khi import: warehouse_api_key
Biến kiểu file (app tự nhận khi import): product_image
File mẫu cần thêm vào dự án (Test Cases → File mẫu của dự án): ao-khoac.png
```

Khi import vào app: bấm Import, chọn hoặc nhập dự án "Shop Admin", rồi chọn file. Bản parse sẽ có 2 nhóm; sheet "Hướng dẫn" được bỏ qua. Biến `product_image` được import với kiểu `file`. Sau khi import, lọc theo dự án "Shop Admin" rồi mở "File mẫu của dự án" để thêm `ao-khoac.png`.
