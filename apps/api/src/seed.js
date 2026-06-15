// Seed Postgres with the same fixtures the in-memory store uses, so the FE has
// data to render when running against a real DB. Idempotent: ON CONFLICT DO NOTHING.

import { randomUUID } from "node:crypto";
import { db, initPg, close } from "./db.js";
import * as mem from "./store.js"; // re-use the seeded in-memory data as the source of truth

async function run() {
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL must be set"); process.exit(1); }
  await initPg();
  const pool = db();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const u of mem.users.values()) {
      await client.query(`INSERT INTO users (id,name,initial,color,role,dsm_uid,email)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [u.id, u.name, u.initial, u.color, u.role, u.dsmUid || null, u.email || null]);
    }
    for (const p of mem.projects.values()) {
      await client.query(`INSERT INTO projects (id,name,status,client,updated_at)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.name, p.status, p.client, p.updatedAt]);
      for (let i = 0; i < (p.teamUserIds || []).length; i++) {
        await client.query(`INSERT INTO project_team (project_id,user_id,position)
          VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [p.id, p.teamUserIds[i], i]);
      }
    }
    for (const m of mem.projectMembers.values()) {
      await client.query(`INSERT INTO project_members (project_id,user_id,role,position)
        VALUES ($1,$2,$3,$4) ON CONFLICT (project_id,user_id) DO NOTHING`,
        [m.projectId, m.userId, m.role, m.position]);
    }
    for (const t of mem.projectTemplates.values()) {
      await client.query(`INSERT INTO project_templates (id,name,description,source_project_id,default_client,created_by_user_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [t.id, t.name, t.description || null, t.sourceProjectId || null, t.defaultClient || "", t.createdByUserId || null, t.createdAt]);
    }
    for (const a of mem.assets.values()) {
      await client.query(`INSERT INTO assets (id,project_id,title,position,nas_path,codec,size_label,duration_ms,frame_rate,status,progress,palette_a,palette_b)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
        [a.id, a.projectId, a.title, a.position, a.nasPath, a.codec, a.sizeLabel, a.durationMs, a.frameRate, a.status, a.progress, a.paletteA, a.paletteB]);
    }
    for (const v of mem.versions.values()) {
      await client.query(`INSERT INTO asset_versions (id,asset_id,version_number,label,note,author_user_id)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [v.id, v.assetId, v.versionNumber, v.label, v.note || null, v.authorUserId]);
    }
    for (const r of mem.renditions.values()) {
      await client.query(`INSERT INTO renditions (id,asset_version_id,height,label,bitrate_kbps,status,progress,hls_master_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.assetVersionId, r.height, r.label, r.bitrateKbps, r.status, r.progress, r.hlsMasterUrl || null]);
    }
    for (const c of mem.comments.values()) {
      await client.query(`INSERT INTO comments (id,asset_version_id,author_user_id,content,timestamp_ms,frame_number,resolved,parent_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
        [c.id, c.assetVersionId, c.authorUserId, c.content, c.timestampMs, c.frameNumber || null, c.resolved, c.parentId || null]);
    }

    await client.query("COMMIT");
    console.log("[seed] done");
  } catch (e) {
    await client.query("ROLLBACK"); console.error("[seed] failed:", e.message); process.exit(1);
  } finally { client.release(); await close(); }
}

run();
