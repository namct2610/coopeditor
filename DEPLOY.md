# Hướng dẫn deploy Coopeditor / Coopeditor

> Dành cho người dùng low-code: anh chỉ cần copy-paste các lệnh dưới đây. Không cần biết Node, Postgres, FFmpeg hay Docker chi tiết — Docker sẽ lo tất cả.

Thời gian dự kiến: **20–40 phút**, gồm chờ Docker pull image lần đầu.

---

## 1. Chọn máy chạy

Có 3 lựa chọn, mức độ khó tăng dần:

| Loại máy | Khi nào nên chọn | Khó/dễ |
|---|---|---|
| **Synology NAS (DSM 7+)** có Container Manager | Anh đã có NAS, footage cũng nằm trên đó → tiện nhất | ★★ |
| **VPS Ubuntu 22.04** (DigitalOcean / Vultr / Hetzner, ~5–10 USD/tháng) | Muốn truy cập từ Internet, NAS chỉ làm storage | ★★★ |
| **PC nội bộ chạy Docker Desktop** (Mac/Windows) | Chỉ dùng nội bộ LAN, không cần Internet | ★ |

Khuyến nghị: nếu đội editor chỉ ngồi cùng văn phòng, chọn **NAS** hoặc **PC nội bộ**. Nếu có editor remote → **VPS**.

Yêu cầu tối thiểu:
- 2 CPU core, 4 GB RAM (transcode CPU). 8 GB nếu muốn nhiều job song song.
- 50 GB ổ trống cho proxy cache (proxy 720p ~ 1/30 dung lượng nguồn 4K).
- Đường truyền lên ≥ 50 Mbps nếu editor remote.

Ghi chú scale:
- Stack hiện đã có sẵn Redis nội bộ cho event bus scale ngang.
- Nếu chỉ chạy 1 API node thì cứ giữ `EVENT_BUS_DRIVER=pg`.
- Khi bắt đầu chạy nhiều API node / worker node, đổi sang `EVENT_BUS_DRIVER=redis-streams`.

---

## 2. Cài Docker

### Trên Synology NAS
1. Mở **DSM → Package Center → Container Manager** → Install.
2. Đăng nhập SSH vào NAS (DSM → Control Panel → Terminal & SNMP → tick "Enable SSH service").
3. Trên máy local mở terminal:
   ```bash
   ssh admin_user@nas.local
   ```

### Trên VPS Ubuntu
SSH vào VPS rồi chạy:
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit
```
Đăng nhập lại để group có hiệu lực.

### Trên Mac/Windows
Cài [Docker Desktop](https://www.docker.com/products/docker-desktop), mở app, đợi đèn xanh ở góc dưới phải.

Kiểm tra: `docker --version` phải in ra phiên bản (vd. `Docker version 27.x.x`).

---

## 3. Tải code

```bash
# chọn thư mục mẹ
cd ~ 
# nếu repo trên GitHub
git clone https://github.com/<your-org>/coopeditor.git
cd coopeditor

# hoặc nếu anh chỉ có file zip
unzip coopeditor.zip
cd coopeditor
```

---

## 4. Cấu hình `.env`

Copy file mẫu rồi edit:
```bash
cp .env.example .env
nano .env       # hoặc vi / dùng File Station nếu trên NAS
```

**Các giá trị cần đổi (in đậm dưới):**

| Biến | Giá trị mẫu | Phải đổi thành |
|---|---|---|
| `DOMAIN` | `localhost` | **Tên miền** anh trỏ về máy này (vd `coopeditor.acme.vn`). Nếu chưa có domain, giữ `localhost` để dùng trong LAN. |
| `PUBLIC_URL` | `http://localhost` | **Phải khớp DOMAIN**: vd `https://coopeditor.acme.vn` (có `s` nếu dùng HTTPS) |
| `POSTGRES_PASSWORD` | `frame` | Password ngẫu nhiên ≥ 16 ký tự. Cách sinh: `openssl rand -base64 24` |
| `EVENT_BUS_DRIVER` | `pg` | Giữ `pg` cho 1 API node. Đổi thành **`redis-streams`** khi scale nhiều API node để event SSE/comment/rendition đi qua Redis Streams. |
| `EVENT_BUS_STREAM_KEY` | `coopeditor_events` | Chỉ đổi khi muốn tách stream theo môi trường (vd staging/prod). |
| `MINIO_ACCESS_KEY` | `minio` | Tên random (vd `coop_minio_admin`) |
| `MINIO_SECRET_KEY` | `minio12345` | Password ≥ 12 ký tự |
| `HLS_CDN_PUBLIC_URL` | (trống) | URL public của CDN/front door đứng trước route HLS, ví dụ **`https://cdn.acme.vn/api/hls`**. Chỉ cần khi editor remote nhiều. |
| `HLS_CDN_SIGNING_SECRET` | (trống) | Secret để API ký URL segment ngắn hạn cho CDN fetch mà không cần cookie. Nên tạo chuỗi ngẫu nhiên dài ≥ 32 ký tự. |
| `HLS_CDN_TOKEN_TTL_SECONDS` | `300` | TTL của signed segment URL. 300–900 giây là hợp lý. |
| `DSM_HOST` | `https://nas.example.com:5001` | URL DSM thật của anh (port `5001` = HTTPS, `5000` = HTTP) |
| `DSM_INSECURE` | (trống) | Set `=1` nếu DSM dùng self-signed cert. Tốt hơn: cấu hình Let's Encrypt cho DSM trong **Control Panel → Security → Certificate**. |
| `COOKIE_SECURE` | `1` | Giữ `1` khi có HTTPS. Đổi thành (trống) nếu test ở `localhost` qua HTTP. |
| `FFMPEG_HWACCEL` | (trống) | `nvenc` nếu máy có GPU NVIDIA; `qsv` nếu Intel có QuickSync. Để trống = chạy CPU. |
| `WORKER_CONCURRENCY` | `2` | Số job transcode chạy song song. CPU thường: 1–2. GPU mạnh: 4–8. |
| `WORKER_AUTOSCALE_THRESHOLD` | `5` | Khi queue depth vượt mốc này, worker process sẽ tự mở thêm slot xử lý. |
| `WORKER_AUTOSCALE_STEP` | `1` | Mỗi burst vượt ngưỡng cộng thêm bao nhiêu slot. |
| `WORKER_MAX_CONCURRENCY` | `3` | Trần concurrency của 1 worker process. |

> Để test ngay trước khi có DSM thật:
> - `DSM_DEV_LOGIN=1` → dev shim: đăng nhập bằng tài khoản bất kỳ.
> - `DSM_HOST=` (để trống) cũng được.

Lưu file và thoát (`Ctrl+O` → Enter → `Ctrl+X` nếu dùng nano).

### Khi nào bật CDN trước HLS?

Nếu editor chủ yếu ở cùng LAN/văn phòng thì **để trống** `HLS_CDN_PUBLIC_URL`.

Nếu có nhiều editor remote:
1. Tạo một domain CDN/front door, ví dụ `https://cdn.acme.vn/api/hls`.
2. Trỏ CDN đó về origin là route HLS của app.
3. Điền `HLS_CDN_PUBLIC_URL` và `HLS_CDN_SIGNING_SECRET` trong `.env`.

Luồng lúc này sẽ là:
- playlist `.m3u8` vẫn lấy qua API có session
- API rewrite các segment URL sang domain CDN
- CDN fetch segment từ origin bằng signed URL ngắn hạn, không cần cookie

---

## 5. Trỏ tên miền (chỉ khi không dùng `localhost`)

Vào trang quản trị DNS của tên miền, thêm record:

| Type | Name | Value |
|---|---|---|
| A | `coopeditor` (hoặc `@`) | IP công cộng của VPS / NAS |

Đợi 5–15 phút cho DNS propagate, kiểm tra bằng:
```bash
dig +short coopeditor.acme.vn
```
Phải in ra đúng IP của máy.

> **Nếu deploy trên NAS / mạng nội bộ**: vào router → Port Forwarding → forward port `80` và `443` từ Internet vào IP nội bộ của máy chạy Docker.

---

## 6. Khởi động stack

Trong thư mục `coopeditor`:

```bash
docker compose up -d
```

Lần đầu sẽ mất 5–10 phút để build image. Sau đó:

```bash
docker compose ps
```
Phải thấy mọi service `running (healthy)` hoặc `running`. Service `minio-setup` sẽ ở trạng thái `exited (0)` — đúng (nó chạy 1 lần rồi thoát).
Từ bản này sẽ có thêm service `redis`; cứ để nó chạy nội bộ, không cần mở port public.

Xem log nếu có gì hỏng:
```bash
docker compose logs -f api
docker compose logs -f worker
```
`Ctrl+C` để thoát log.

---

## 7. Truy cập lần đầu

Mở browser ở:
- `https://<DOMAIN>` nếu dùng domain
- `http://localhost` nếu test LAN

Sẽ thấy màn **Đăng nhập DSM**. Nhập tài khoản DSM (cùng tài khoản anh login vào NAS).

Nếu DSM yêu cầu **2FA**, app sẽ tự chuyển sang màn nhập mã OTP.

Đăng nhập xong sẽ thấy Workspace 11 project mẫu — đây là seed data; anh có thể bỏ qua hoặc xóa.

---

## 8. Bật tài khoản DSM thật cho team

Mỗi editor cần một tài khoản DSM hợp lệ với quyền truy cập folder Footage. Trên DSM:

1. **Control Panel → User & Group → Create User** cho mỗi editor.
2. Trong tab **Permissions**, tick các shared folder chứa footage (vd `Footage`, `Proxy`).
3. Trong tab **Applications**, đảm bảo cho phép **FileStation** (Coopeditor dùng FileStation API).
4. Khuyến nghị bật **2FA** trong **Personal → Account → Sign-in method**.

Editor mở `https://<DOMAIN>` và đăng nhập bằng chính tài khoản DSM này. App sẽ chỉ thấy folder mà DSM cho phép user đó truy cập.

---

## 9. Xác nhận transcode hoạt động

1. Vào Workspace → chọn 1 project bất kỳ → bấm **Import từ NAS**.
2. Chọn 1 file `.mov` → bấm **Import**.
3. Quay lại danh sách nguồn — sẽ thấy item mới có badge **Transcode 12%** và % tăng dần (cập nhật realtime qua SSE).
4. Mở Container Manager → log của `worker` để xem ffmpeg đang chạy:
   ```bash
   docker compose logs -f worker
   ```

Khi % chạm 100, status đổi thành **Sẵn sàng**, click vào item → màn Review mở ra và stream proxy từ MinIO qua API.

---

## 10. Bảo trì hàng ngày

### Xem log
```bash
docker compose logs -f --tail=200 api
```

### Restart 1 service
```bash
docker compose restart api
```

### Update khi có code mới
```bash
git pull
docker compose build
docker compose up -d
```

### Backup Postgres (script chạy hằng đêm)
Thêm vào crontab (`crontab -e`):
```cron
0 2 * * *  cd ~/coopeditor && docker compose exec -T postgres pg_dump -U frame coopeditor | gzip > ~/backups/db-$(date +\%F).sql.gz
```

### Backup MinIO
```cron
30 2 * * *  rsync -a --delete /var/lib/docker/volumes/coopeditor_minio_data/_data/ /mnt/backup-disk/minio/
```
(Đường dẫn volume khác nhau theo Docker version; check bằng `docker volume inspect coopeditor_minio_data`)

### Xem dung lượng MinIO
Mở `https://<DOMAIN>:9001` (MinIO console), đăng nhập bằng `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` trong `.env`.

⚠️ **Khuyến nghị**: cấu hình tường lửa chỉ cho phép port `9001` từ IP văn phòng.

---

## 11. Khắc phục sự cố thường gặp

### "DSM error: fetch failed"
- Kiểm tra `DSM_HOST` đúng URL (có `https://` và port `:5001`).
- Nếu DSM dùng self-signed cert → thêm `DSM_INSECURE=1` vào `.env`, restart api: `docker compose restart api`.
- Test từ máy chạy Docker: `curl -k https://nas.example.com:5001/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query`.

### Login pass mà /me trả 401
- Cookie `fe_sess` bị mất do API restart. Logout rồi login lại.
- Permanent fix: chuyển session sang DB (xem mục cải tiến #4 trong tài liệu này).

### Worker không tăng %
```bash
docker compose logs worker | tail -50
```
- Nếu thấy `ffmpeg: command not found` → image build lỗi, chạy lại `docker compose build worker`.
- Nếu thấy `ECONNREFUSED minio:9000` → MinIO chưa healthy, đợi 30s rồi `docker compose restart worker`.

### Editor không thấy file trong NAS browser
- Kiểm tra user DSM có quyền đọc folder đó không (DSM → Control Panel → Shared Folder → Permissions).
- Đảm bảo DSM **FileStation** package đang chạy (Package Center → FileStation).

### "Origin not allowed" trên browser console
- `PUBLIC_URL` trong `.env` không khớp URL anh đang mở. Edit `.env` → `docker compose up -d`.

### Quên password admin DSM
- Reset qua DSM Recovery (cắm USB vào NAS, đè nút RESET 4 giây).

---

## 12. Nâng cấp về sau

| Tình huống | Hành động |
|---|---|
| Team đông hơn, transcode chậm | Tăng `WORKER_CONCURRENCY` lên 4, hoặc scale worker: `docker compose up -d --scale worker=3` |
| Editor remote nhiều, bandwidth origin căng | Đặt `HLS_CDN_PUBLIC_URL` + `HLS_CDN_SIGNING_SECRET` để playlist được rewrite sang CDN và segment cache ở edge |
| Chạy nhiều API node / editor remote nhiều | Đổi `EVENT_BUS_DRIVER=redis-streams` để comment / SSE / rendition event đi qua Redis Streams thay vì Postgres NOTIFY |
| Có GPU NVIDIA | Sửa `apps/worker/Dockerfile` base sang `nvidia/cuda:12-cudnn-runtime-ubuntu22.04`, đặt `FFMPEG_HWACCEL=nvenc` |
| Storage MinIO đầy | Mount external disk, di chuyển volume `minio_data` sang đó |
| Cần audit log "ai làm gì lúc nào" | Đang thiếu — xem mục cải tiến P3 |

---

## 13. Tắt stack & uninstall

```bash
docker compose down            # tắt, giữ data
docker compose down -v         # tắt + xóa hết Postgres/MinIO/proxy → KHÔNG hồi phục được
```

---

## Cần hỗ trợ?

- Log đầy đủ: `docker compose logs --since=10m > debug.log` rồi gửi cho team kỹ thuật.
- Health check: `curl https://<DOMAIN>/api/health` → phải trả `{"ok":true,"backend":"pg"}`.
- Test data dev mode: set `DSM_DEV_LOGIN=1` trong `.env`, restart api, login bằng account bất kỳ để test trước khi cấu hình NAS thật.
