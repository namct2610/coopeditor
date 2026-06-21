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

Trước khi deploy lên NAS, kiểm tra 3 dòng `image:` trong [docker-compose.nas.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas.yml):

```yaml
ghcr.io/namct2610/coopeditor-api:latest
ghcr.io/namct2610/coopeditor-web:latest
ghcr.io/namct2610/coopeditor-worker:latest
```

Nếu anh fork sang namespace GitHub khác thì đổi lại ở đúng 3 dòng đó.

## File dùng cho NAS

- [Caddyfile.nas](/Users/etecman/Documents/Frame%20Editor/Caddyfile.nas)
- [docker-compose.nas.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas.yml)

Hai file này là bộ deploy chuẩn nên ưu tiên dùng, bỏ qua các file `nas-auto` / `nas-clean` cũ.

## Cách chạy

```bash
docker compose -f docker-compose.nas.yml up -d
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

## Redeploy sạch trên DSM

Nếu trước đó project bị lệch mount hoặc sinh orphan container kiểu `7e47...`, làm lại sạch theo thứ tự này:

1. `Container Manager` -> `Project` -> chọn project `coopeditor` -> `Action` -> `Delete`.
2. Tick luôn phần xoá container của project cũ.
3. Vào `Container` và xoá nốt container lẻ / orphan không còn thuộc project nếu còn sót.
4. Chỉ sau khi dọn xong mới import lại [docker-compose.nas.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas.yml).

Nếu worker từng bị mount sai `/volume1:/nas:ro`, redeploy sạch như trên quan trọng hơn việc chỉ bấm restart.

## Shared Folder / Team Folder trên Synology Drive

Để import file thật và cho FFmpeg đọc được source thật:

1. `api` và `worker` phải mount đúng Team Folder / Shared Folder vào container.
   Ví dụ với Team Folder `PCNgon`, file compose đúng phải là:

```yaml
- /volume1/PCNgon:/nas:ro
```

   Không mount cả `/volume1` nếu anh chỉ muốn import trong một thư mục cụ thể.
   Quan trọng: `api` và `worker` phải giống hệt nhau.

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

[docker-compose.nas.yml](/Users/etecman/Documents/Frame%20Editor/docker-compose.nas.yml) đã có sẵn Watchtower. Khi image mới được push lên registry:
- Watchtower tự pull
- restart đúng các container có label enable
- volume `/data` giữ nguyên nên config không mất

Luồng chuẩn:
1. push code lên branch `main`
2. GitHub Actions publish image mới lên GHCR
3. Watchtower trên NAS tự phát hiện image mới và cập nhật

Lưu ý: để Watchtower check update được, package `coopeditor-api`, `coopeditor-web`, `coopeditor-worker` trên GHCR nên để `Public`. Bộ file chuẩn này không phụ thuộc `.env`.

## Rollback

Pin lại image tag trong file compose, ví dụ:

```yaml
image: ghcr.io/<github-owner>/coopeditor-api:sha-abc123
```

Rồi chạy lại:

```bash
docker compose -f docker-compose.nas.yml up -d
```

## Ghi chú bảo mật

- Mode này bỏ yêu cầu `.env` cho người vận hành NAS.
- Internal credentials giữa các container hiện đang dùng fixed value trong compose nội bộ.
- Nếu muốn harden thêm, bước tiếp theo nên là sinh secret nội bộ lần đầu và lưu vào `/data/system/secrets.json`.
