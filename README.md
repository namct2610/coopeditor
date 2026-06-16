# Coopeditor

Nen tang review video noi bo theo huong Frame.io, toi uu cho workflow dung source 4K tren NAS nhung review/comment tren proxy bitrate thap.

## Muc tieu MVP

- Dong bo thu vien video tu NAS vao he thong metadata.
- Tao proxy HLS bitrate thap de phat muot tren duong truyen 30-50 Mbps.
- Xem video tren web va comment theo timeline.
- Quan ly project, asset, version va review session co nhieu editor.

## Kien truc de xuat

- `apps/web`: giao dien review video.
- `apps/api`: REST API cho auth, projects, assets, comments, playback manifests.
- `apps/worker`: worker transcode va thumbnail/waveform generation.
- `packages/contracts`: type dung chung giua web/api/worker.
- `docs/architecture.md`: thiet ke chi tiet.

## Luong du lieu

1. User khai bao duong dan NAS.
2. API quet folder, tao ban ghi asset/version trong database.
3. Worker dung FFmpeg tao proxy HLS 720p/1080p, thumbnail, waveform.
4. Web player phat proxy HLS thay vi mo file 4K goc truc tiep.
5. Editor tao comment voi `timestampMs` hoac `frameNumber`.

## Chien luoc cho mang 30-50 Mbps

- Khong stream source goc 4K cho review.
- Tao it nhat 2 proxy:
  - 540p ~1.5-2.5 Mbps
  - 720p ~3-5 Mbps
- Neu editor can check detail, cho phep chuyen len 1080p ~6-10 Mbps.
- Su dung HLS segment ngan 4-6 giay de scrub/on seek muot hon.
- Cache proxy o SSD local hoac object storage, khong doc tu NAS moi lan playback.

## Khoi dong phat trien

Repo nay moi la skeleton kien truc va contract ban dau. Buoc tiep theo hop ly nhat la:

1. Tao database schema va migration.
2. Implement NAS scanner.
3. Implement queue + FFmpeg worker.
4. Tao player page va timeline comments realtime.
