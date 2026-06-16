// Storage dispatcher: picks Postgres when DATABASE_URL is set, otherwise the
// in-memory fallback store used by local tests/dev. Exposes a uniformly async API. Server + worker use only
// this module — neither imports store.js or store-pg.js directly.

import { db } from "./db.js";
import * as mem from "./store.js";
import * as pg from "./store-pg.js";

const USE_PG = !!process.env.DATABASE_URL;
const impl = USE_PG ? pg : mem;
export const backend = USE_PG ? "pg" : "memory";

// helpers to normalise the memory store's sync results to promises
const A = (fn) => async (...args) => fn(...args);

// pass-through when implementing fn exists in the chosen backend;
// otherwise wrap an equivalent against memory primitives.

export const listProjects        = USE_PG ? impl.listProjects        : A(impl.listProjects);
export const listProjectsForUser = USE_PG ? impl.listProjectsForUser : A(impl.listProjectsForUser);
export const getProject          = USE_PG ? impl.getProject          : A(impl.getProject);
export const getProjectMember    = USE_PG ? impl.getProjectMember    : A(impl.getProjectMember);
export const listProjectMembers  = USE_PG ? impl.listProjectMembers  : A(impl.listProjectMembers);
export const listProjectMembersForUser = USE_PG ? impl.listProjectMembersForUser : A(impl.listProjectMembersForUser);
export const upsertProjectMember = USE_PG ? impl.upsertProjectMember : A(impl.upsertProjectMember);
export const setProjectMemberRole = USE_PG ? impl.setProjectMemberRole : A(impl.setProjectMemberRole);
export const removeProjectMember = USE_PG ? impl.removeProjectMember : A(impl.removeProjectMember);
export const listProjectMemberUserIds = USE_PG ? impl.listProjectMemberUserIds : A(impl.listProjectMemberUserIds);
export const patchProject        = USE_PG ? impl.patchProject        : async (id, patch) => {
  const p = mem.projects.get(id); if (!p) return null;
  if (patch.status) p.status = patch.status;
  if (patch.name) p.name = patch.name;
  if (typeof patch.client === "string") p.client = patch.client;
  p.updatedAt = "vừa xong";
  return p;
};
export const archiveProject       = USE_PG ? impl.archiveProject       : A(impl.archiveProject);
export const restoreProject       = USE_PG ? impl.restoreProject       : A(impl.restoreProject);
export const deleteProject        = USE_PG ? impl.deleteProject        : A(impl.deleteProject);
export const createProject        = USE_PG ? impl.createProject        : A(impl.createProject);
export const duplicateProject     = USE_PG ? impl.duplicateProject     : A(impl.duplicateProject);
export const listProjectTemplates = USE_PG ? impl.listProjectTemplates : A(impl.listProjectTemplates);
export const getProjectTemplate   = USE_PG ? impl.getProjectTemplate   : A(impl.getProjectTemplate);
export const createProjectTemplate = USE_PG ? impl.createProjectTemplate : A(impl.createProjectTemplate);
export const createProjectFromTemplate = USE_PG ? impl.createProjectFromTemplate : A(impl.createProjectFromTemplate);

export const listAssetsByProject = USE_PG ? impl.listAssetsByProject : A(impl.listAssetsByProject);
export const getAsset            = USE_PG ? impl.getAsset            : async (id) => mem.assets.get(id) || null;
export const patchAsset          = USE_PG ? impl.patchAsset          : A(impl.patchAsset);
export const deleteAsset         = USE_PG ? impl.deleteAsset         : A(impl.deleteAsset);
export const findProjectIdForAsset = USE_PG ? impl.findProjectIdForAsset : A(impl.findProjectIdForAsset);
export const reorderAssets       = USE_PG ? impl.reorderAssets       : A(impl.reorderAssets);
export const addAssetFromImport  = USE_PG ? impl.addAssetFromImport  : A(impl.addAssetFromImport);

export const listVersionsForAsset = USE_PG ? impl.listVersionsForAsset : A(impl.listVersionsForAsset);
export const getVersion           = USE_PG ? impl.getVersion           : async (id) => mem.versions.get(id) || null;
export const findProjectIdForVersion = USE_PG ? impl.findProjectIdForVersion : A(impl.findProjectIdForVersion);
export const findProjectIdForRendition = USE_PG ? impl.findProjectIdForRendition : A(impl.findProjectIdForRendition);

export const listRenditionsForVersion = USE_PG ? impl.listRenditionsForVersion : A(impl.listRenditionsForVersion);
export const getRendition             = USE_PG ? impl.getRendition             : async (id) => mem.renditions.get(id) || null;
export const setRenditionStatus       = USE_PG ? impl.setRenditionStatus       : A(impl.setRenditionStatus);
export const listProcessingRenditions = USE_PG ? impl.listProcessingRenditions : async () => [...mem.renditions.values()].filter((r) => r.status === "processing");
export const listProcessingAssets     = USE_PG ? impl.listProcessingAssets     : async () => [...mem.assets.values()].filter((a) => a.status === "processing");
export const setAssetStatus           = USE_PG ? impl.setAssetStatus           : async (id, patch) => { const a = mem.assets.get(id); if (a) Object.assign(a, patch); };

export const listCommentsForVersion = USE_PG ? impl.listCommentsForVersion : A(impl.listCommentsForVersion);
export const getComment            = USE_PG ? impl.getComment            : async (id) => mem.comments.get(id) || null;
export const findProjectIdForComment = USE_PG ? impl.findProjectIdForComment : A(impl.findProjectIdForComment);
export const addComment             = USE_PG ? impl.addComment             : A(impl.addComment);
export const setCommentResolved     = USE_PG ? impl.setCommentResolved     : A(impl.setCommentResolved);
export const setCommentContent      = USE_PG ? impl.setCommentContent      : A(impl.setCommentContent);
export const deleteComment          = USE_PG ? impl.deleteComment          : A(impl.deleteComment);
export const restoreComment         = USE_PG ? impl.restoreComment         : A(impl.restoreComment);

export const listUsers          = USE_PG ? impl.listUsers          : async () => [...mem.users.values()];
export const getUser            = USE_PG ? impl.getUser            : async (id) => mem.users.get(id) || null;
export const upsertUserFromDsm  = USE_PG ? impl.upsertUserFromDsm  : A(impl.upsertUserFromDsm);
export const upsertUserFromOidc = USE_PG ? impl.upsertUserFromOidc : A(impl.upsertUserFromOidc);

export const enqueueTranscode = USE_PG ? impl.enqueueTranscode : async () => {};

export function poolReady() { return USE_PG ? !!db() : true; }
