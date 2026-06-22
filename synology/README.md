# Coopeditor — native Synology SPK port

Goal: package Coopeditor as a true DSM-native SPK installable from Package
Center, with **no Docker, no Container Manager dependency**, no external
Postgres/Redis/MinIO services.

## Architecture diff vs current Docker stack

| Layer | Docker stack (today) | Native SPK (target) |
|---|---|---|
| Database | Postgres 16 container | SQLite (`better-sqlite3`) inside the SPK |
| Realtime bus | Redis 7 streams | In-process `EventEmitter` (single-process SPK) |
| Object storage | MinIO container | Filesystem at `var/proxy/` inside the SPK volume |
| HTTP gateway | Caddy container | Express static + reverse-proxy inside the API process |
| Worker | Separate worker container | Spawned child process inside the SPK |
| ffmpeg | Bundled in worker image | DSM `CodecPack` ffmpeg or static binary in `lib/` |
| Auto-update | Watchtower polling GHCR | DSM Package Center built-in |
| Process count | 8 containers | 2 processes (api + worker), 1 SQLite file |
| RAM footprint | ~1.2 GB | ~250 MB target |

## Build pipeline (when wired)

```
synology/
├── build/                      # output: .spk files
├── README.md                   # this file
└── spk-src/
    ├── INFO                    # SPK manifest (package id, version, archs)
    ├── PACKAGE_ICON*.PNG       # icons (72px, 256px) shown in Package Center
    ├── conf/
    │   ├── privilege           # run as a dedicated low-priv user
    │   └── resource            # ports/volumes claimed at install
    ├── scripts/
    │   ├── preinst             # check archs, DSM version, required deps
    │   ├── postinst            # create user, init SQLite, seed runtime cfg
    │   ├── preuninst           # confirm + checkpoint data
    │   ├── postuninst          # remove user (NOT data unless asked)
    │   └── start-stop-status   # `start` / `stop` / `status` entry points
    ├── WIZARD_UIFILES/
    │   └── install_uifile      # first-install wizard (publicUrl, NAS root)
    └── package/                # files copied into /var/packages/coopeditor/target/
        ├── bin/coopeditor      # tiny shell launcher → node app/main.js
        ├── app/                # Node sources + node_modules (vendored)
        ├── lib/                # Node runtime + ffmpeg static binary
        └── var/                # data: sqlite db, proxy/, runtime-config.json
```

## Build matrix

Multi-arch via GitHub Actions, packed by `synology/build-spk.sh`:

- `x86_64` — most Plus / FS / DS+ models (DSM 7.x)
- `aarch64` — newer ARM NAS (DS220+ has gone Intel, but DS124, RS422+ still ARM)

DSM 6.x is out of scope — release.json bumps target DSM ≥ 7.2.

## Phased roadmap

Each phase ships independently. Docker stack stays supported until SPK is GA.

1. **DB layer** — add SQLite driver alongside Postgres. `DATABASE_URL=sqlite:/path/to.db` switches; tests gate on both. (~3 days)
2. **In-process bus** — collapse Redis streams into a local emitter when
   single-process mode is detected (no `REDIS_URL`). Existing fallback already
   exists in `apps/api/src/event-bus.js`; just remove the warning. (~1 day)
3. **Filesystem proxy storage** — already partially supported via `OUTPUT_DIR`
   env in `apps/api/src/hls-proxy.js`. Promote to default when no
   `MINIO_ENDPOINT` is configured. (~1 day)
4. **Embed web SPA** — Express serves `apps/web/src/static/index.html` directly
   so no separate web container/dev-server. (~1 day)
5. **Embed worker** — spawn worker as child process from the API entrypoint
   when `WORKER_INLINE=1`; share the SQLite handle. (~2 days)
6. **SPK skeleton + GitHub Actions** — INFO + scripts + workflow that packs
   into `.spk` and uploads as GitHub Release asset. (~3 days)
7. **Wizard + Package Center metadata** — install wizard captures public URL +
   NAS mount root; Package Center sees title/description/icon. (~2 days)

After phase 7: tag `v1.0.0-spk-rc1`, install on test NAS, polish.

## Why this is a long sprint

Replacing Docker isn't a refactor — it's removing 3 daemons (pg, redis,
minio) the codebase took for granted, while keeping the Docker code path
alive for existing deployments. Roughly **15-20 incremental commits**, each
small enough to revert in isolation. Phases 1-5 are pure code (no NAS
required); phases 6-7 need an actual DSM box to validate.
