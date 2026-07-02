# IRDRC HUB — JavaScript Full App

Ứng dụng quản lý dự án và công việc cho IRDRC, xây dựng lại từ bản demo HTML thành ứng dụng JavaScript có **backend Node.js**, API nội bộ, đăng nhập theo tài khoản, phân quyền và lưu dữ liệu bền vững bằng tệp JSON.

## Điểm chính

- Đăng nhập tài khoản, cookie phiên `HttpOnly`.
- Phân quyền: **Admin**, **Lãnh đạo Viện**, **Nhân sự Viện**, **Cộng tác viên**.
- Quản lý hồ sơ nhân sự và phân quyền (Admin).
- Tạo dự án, chủ trì/đồng chủ trì, thành viên, địa phương, đầu ra, link hồ sơ.
- Dự án điều phối; tạo nhiều công việc liên kết ngay trong chi tiết dự án.
- Luồng công việc: **Mới giao → Đang làm → Công việc chờ duyệt → Hoàn thành**.
- Từ chối nhận việc → **Chờ điều chỉnh**; người giao cập nhật rồi giao lại.
- Không duyệt → tạo tự động việc mới `CHỈNH SỬA [Tên công việc cũ]` cho đúng người nhận.
- Dashboard, sản phẩm đầu ra, đánh giá tiến độ, xuất CSV.
- Giao diện Barlow, responsive; không cần npm dependency ngoài Node.js.

> Dữ liệu trong `data/db.json` được sinh tự động khi chạy lần đầu. File này được bỏ qua bởi Git để không vô tình đẩy dữ liệu nội bộ lên repository.

## Chạy trên máy local

Yêu cầu: **Node.js 20+**.

```bash
node server.js
```

Mở: `http://localhost:3000`

Có thể đặt biến môi trường:

```bash
PORT=8080 COOKIE_SECURE=false node server.js
```

## Tài khoản test

| Loại tài khoản | Tên đăng nhập | Mật khẩu |
|---|---|---|
| Admin | `admin` | `admin123` |
| Lãnh đạo Viện | `lanhdao.vien` | `LanhDao@2026` |
| Lãnh đạo Viện | `dc.khai` | `Khai@2026` |
| Lãnh đạo Viện | `nk.duc` | `Duc@2026` |
| Nhân sự Viện | `pt.dung` | `Dung@2026` |
| Nhân sự Viện | `thl.vu` | `Vu@2026` |
| Nhân sự Viện | `ntq.tram` | `Tram@2026` |
| Cộng tác viên | `v.son` | `Son@2026` |
| Cộng tác viên | `ntt.linh` | `Linh@2026` |
| Cộng tác viên | `ctv.minh` | `Minh@2026` |

## Đưa lên GitHub

```bash
git init
git add .
git commit -m "Initial IRDRC HUB JavaScript app"
git branch -M main
git remote add origin https://github.com/<your-account>/irdrc-hub-js.git
git push -u origin main
```

## Deploy lên server Node.js

1. Upload source hoặc clone repository vào server.
2. Cài Node.js 20+.
3. Tạo file `.env` dựa trên `.env.example`.
4. Đặt `COOKIE_SECURE=true` khi domain đã chạy HTTPS.
5. Chạy bằng process manager, ví dụ PM2:

```bash
npm install -g pm2
pm2 start server.js --name irdrc-hub
pm2 save
pm2 startup
```

Có thể reverse proxy bằng Nginx tới `http://127.0.0.1:3000`.

## Deploy bằng Docker

```bash
docker build -t irdrc-hub .
docker run -d --name irdrc-hub -p 3000:3000 -v $(pwd)/data:/app/data irdrc-hub
```

## Lưu ý triển khai thật

- Đây là kiến trúc `Node.js + JSON file` phù hợp MVP/demonstration và nhóm nhỏ. Khi chạy đa người dùng lớn, nên thay `data/db.json` bằng PostgreSQL/MySQL và dùng session store bền vững như Redis.
- Đổi toàn bộ mật khẩu test ngay sau khi triển khai.
- Thiết lập HTTPS, sao lưu thư mục `data/`, giới hạn quyền truy cập máy chủ và theo dõi log.
- GitHub Pages chỉ phù hợp cho frontend tĩnh; bản này cần **Node.js runtime** để chạy API và đăng nhập an toàn.
