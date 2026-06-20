# Deploy NAS Without `.env`

Mục tiêu của mode này là giống trải nghiệm Plex:
- container boot lên được ngay
- cấu hình vận hành lưu trong volume `/data`
- setup qua web ở lần chạy đầu
- update từ xa bằng image registry + Watchtower

## Chuẩn bị GHCR

Repo đã có workflow publish image tại [.github/workflows/publish-ghcr.yml](/Users/etecman/Documents/Frame%20Editor/.github/workflows/publish-ghcr.yml).

Khi repo được đẩy lên GitHub, mỗi lần push vào `main` workflow sẽ build và push 3 image:
- `ghcr.io/<github-owner>/coopeditor-api:latest`
- `ghcr.io/<github-owner>/coopeditor-web:latest`
- `ghcr.io/<github-owner>/coopeditor-worker:latest`

Trước khi deploy lên NAS, sửa 3 dòng `image:` trong [docker-compose.nas-auto.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas-auto.yml) từ:

```yaml
ghcr.io/your-github-owner/...
```

thành namespace GitHub thật của bạn.

## File dùng cho NAS

- [docker-compose.nas-auto.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas-auto.yml)
- [docker-compose.nas-clean.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas-clean.yml)
- [docker-compose.watchtower.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.watchtower.yml)
- [Caddyfile.nas](/Users/etecman/Documents/Frame%20Editor/Caddyfile.nas)
- [Caddyfile.nas-clean](/Users/etecman/Documents/Frame%20Editor/Caddyfile.nas-clean)

## Cách chạy

```bash
docker compose -f docker-compose.nas-auto.yml up -d
```

Sau đó mở:

```text
http://<IP-NAS>:8080
```

Lần đầu app sẽ vào `setup mode` và hiện form cấu hình:
- `publicUrl`
- `dsmHost` hoặc `DSM dev login`
- SMTP/webhook nếu cần
- transcode profile

Khi bấm lưu:
- config được ghi vào `/data/system/config.json`
- API tự restart
- worker tự chờ config rồi nhận cấu hình mới

## Shared Folder / Team Folder trên Synology Drive

Để import file thật và cho FFmpeg đọc được source thật:

1. `api` và `worker` phải mount đúng Team Folder / Shared Folder vào container.
   Ví dụ với Team Folder `PCNgon`, file compose đúng phải là:

```yaml
- /volume1/PCNgon:/nas:ro
```

   Không mount cả `/volume1` nếu anh chỉ muốn import trong một thư mục cụ thể.

2. Trong setup wizard, điền:

```text
DSM mount root = /nas
```

3. Nếu file nằm trong Team Folder ví dụ:

```text
/TeamFolder/ProjectA/shot01.mov
```

thì bên trong container FFmpeg sẽ đọc ở:

```text
/nas/TeamFolder/ProjectA/shot01.mov
```

Nếu bỏ trống `DSM mount root`, app vẫn có thể duyệt DSM qua API nhưng worker có thể không transcode được file thật.

## Update từ xa

`docker-compose.nas-auto.yml` đã có sẵn Watchtower. Khi image mới được push lên registry:
- Watchtower tự pull
- restart đúng các container có label enable
- volume `/data` giữ nguyên nên config không mất

Luồng chuẩn:
1. push code lên branch `main`
2. GitHub Actions publish image mới lên GHCR
3. Watchtower trên NAS tự phát hiện image mới và cập nhật

## Rollback

Pin lại image tag trong file compose, ví dụ:

```yaml
image: ghcr.io/<github-owner>/coopeditor-api:sha-abc123
```

Rồi chạy lại:

```bash
docker compose -f docker-compose.nas-auto.yml up -d
```

## Ghi chú bảo mật

- Mode này bỏ yêu cầu `.env` cho người vận hành NAS.
- Internal credentials giữa các container hiện đang dùng fixed value trong compose nội bộ.
- Nếu muốn harden thêm, bước tiếp theo nên là sinh secret nội bộ lần đầu và lưu vào `/data/system/secrets.json`.
