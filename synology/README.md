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

| # | Phase | Status |
|---|---|---|
| 1 | SPK skeleton + build pipeline | ✅ |
| 2 | SQLite driver behind pg-pool interface | ✅ |
| 3 | Drop Redis hard-dep (in-process bus) | ✅ |
| 4 | Filesystem proxy default (bỏ MinIO) | ✅ |
| 5 | Embed web SPA + worker in-process | ✅ |
| 6 | Cross-arch native bindings + workflow polish | ✅ |
| 7 | Tag `v1.0.0-spk-rc1` → first install on real NAS | 🔜 |

## Build locally (smoke test)

Packaging a `.spk` without bundling Node runtime is useful for quick
iteration on scripts/INFO. From the repo root:

```sh
SKIP_DEPS=1 bash synology/build-spk.sh x86_64 0.0.1-smoke
ls synology/build/coopeditor-x86_64-0.0.1-smoke.spk
```

This produces a ~270KB SPK that won't actually run (no Node binary
inside), but proves the layout + INFO substitution + script wiring.

## Build a real SPK

Need:
- Node 22.11.0+ binary for target arch (`linux-x64` or `linux-arm64`)
  downloadable from <https://nodejs.org/dist/>
- npm + working internet (to pull `better-sqlite3` prebuilt natives)

```sh
NODE_VERSION=22.11.0
ARCH=x86_64           # or aarch64
NODE_TARBALL_ARCH=linux-x64   # or linux-arm64 to match
curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_TARBALL_ARCH}.tar.xz" \
  | tar -xJ -C /tmp/node-stage --strip-components=1
NODE_BIN=/tmp/node-stage/bin/node \
  bash synology/build-spk.sh "$ARCH" 1.0.0-rc1
```

Output: `synology/build/coopeditor-x86_64-1.0.0-rc1.spk`.

## CI release

Push a tag matching `v*-spk*` (e.g. `v1.0.0-spk-rc1`) → the
`publish-spk.yml` workflow builds both arches, downloads matching Node
runtimes, installs prod deps with `npm_config_target_arch` so
better-sqlite3 prebuilds resolve correctly, and attaches the `.spk`
files to a GitHub Release. Synology DSM users then install via
Package Center → Manual Install.

## Why this is a long sprint

Replacing Docker isn't a refactor — it's removing 3 daemons (pg, redis,
minio) the codebase took for granted, while keeping the Docker code path
alive for existing deployments. Roughly **15-20 incremental commits**, each
small enough to revert in isolation. Phases 1-5 are pure code (no NAS
required); phases 6-7 need an actual DSM box to validate.
