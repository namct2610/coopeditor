# Architecture

## 1. Bai toan can giai

Source video 4K nam tren NAS rat nang, khong phu hop de editor review truc tiep qua mang 30-50 Mbps. He thong can tao proxy nhe hon, playback muot, va van map comment chinh xac theo timeline/version.

## 2. Thanh phan he thong

### NAS Connector

- Scan folder tren SMB/NFS mount.
- Doc metadata co ban: ten file, dung luong, do dai, codec, frame rate, timecode.
- Sinh fingerprint de tranh duplicate.

### API Service

- Auth va phan quyen.
- Project / Folder / Asset / Version management.
- Comment APIs.
- Playback authorization.
- Webhook/event cho worker.

### Transcode Worker

- Nhan job tu queue.
- Dung FFmpeg tao:
  - poster image
  - thumbnails
  - waveform (neu can audio review)
  - HLS renditions
- Cap nhat trang thai processing.

### Storage Strategy

- Source goc: NAS.
- Proxy playback: MinIO/S3 hoac SSD cache.
- Metadata: PostgreSQL.
- Queue/cache: Redis.

### Web Review App

- Project browser.
- Video player HLS.
- Timeline comments.
- Version compare sau nay co the them side-by-side hoac overlay.

## 3. Tai sao nen dung proxy HLS

- Adaptive bitrate phu hop mang bien dong.
- Co the tao nhieu profile cho tung editor.
- Seek/scrub tot hon progressive MP4 khi file dai.
- Tien cho CDN/object storage neu sau nay mo rong.

## 4. Ladder bitrate de xuat

Cho mang 30-50 Mbps, nen uu tien review proxy thay vi full-res:

| Profile | Resolution | Video bitrate | Use case |
| --- | --- | --- | --- |
| low | 960x540 | 1.8 Mbps | mang yeu, nhieu nguoi xem |
| medium | 1280x720 | 3.5 Mbps | mac dinh review |
| high | 1920x1080 | 8 Mbps | check chi tiet |

Audio AAC 128-192 kbps la du cho review.

## 5. FFmpeg huong thuc te

Transcode source 4K sang HLS:

```bash
ffmpeg -i input.mov \
  -filter_complex "[0:v]split=3[v1][v2][v3];[v1]scale=w=960:h=540:force_original_aspect_ratio=decrease[v540];[v2]scale=w=1280:h=720:force_original_aspect_ratio=decrease[v720];[v3]scale=w=1920:h=1080:force_original_aspect_ratio=decrease[v1080]" \
  -map "[v540]" -map a:0 -c:v:0 h264 -b:v:0 1800k -c:a:0 aac -b:a:0 128k \
  -map "[v720]" -map a:0 -c:v:1 h264 -b:v:1 3500k -c:a:1 aac -b:a:1 128k \
  -map "[v1080]" -map a:0 -c:v:2 h264 -b:v:2 8000k -c:a:2 aac -b:a:2 192k \
  -f hls -hls_time 4 -hls_playlist_type vod -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0 v:1,a:1 v:2,a:2" \
  output_%v.m3u8
```

Neu server co GPU, co the chuyen sang NVENC/Quick Sync de giam thoi gian transcode.

## 6. Data model toi thieu

- `projects`
- `folders`
- `assets`
- `asset_versions`
- `transcode_jobs`
- `comments`
- `comment_threads`
- `playback_sessions`

## 7. Comment timeline

Moi comment nen luu:

- `assetVersionId`
- `timestampMs`
- `frameNumber`
- `authorId`
- `content`
- `resolvedAt`
- `parentId`

Dung `timestampMs` cho playback phia web, con `frameNumber` giup giu do chinh xac khi frame rate quan trong.

## 8. Luong ingest de xuat

1. Mount NAS vao may chu app.
2. API tao `library root`.
3. Scanner doc folder dinh ky hoac on-demand.
4. Moi file video moi tao `asset_version`.
5. Worker transcode.
6. Khi xong, API cho phep playback proxy.

## 9. Roadmap

### Phase 1

- Login + project browser
- NAS scan thu cong
- Proxy HLS 540p/720p
- Video player + timeline comments

### Phase 2

- Realtime comments qua WebSocket
- Mention, resolve thread
- Thumbnail strip khi scrub

### Phase 3

- Version compare
- Approval workflow
- External share link

## 10. Stack de xuat

- Frontend: Next.js
- API: Fastify/NestJS
- Worker: Node.js + BullMQ + FFmpeg
- DB: PostgreSQL
- Cache/Queue: Redis
- Proxy storage: MinIO
