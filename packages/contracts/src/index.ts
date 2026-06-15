// ---------- core entities ----------

export type ProjectStatus = "progress" | "done" | "published";

export type Project = {
  id: string;
  name: string;
  status: ProjectStatus;
  client: string;
  updatedAt: string;
  teamUserIds: string[];
  myRole?: ProjectMemberRole;
  createdAt: string;
};

export type ProjectTemplate = {
  id: string;
  name: string;
  description?: string;
  sourceProjectId?: string;
  defaultClient?: string;
  createdByUserId?: string;
  createdAt: string;
};

export type SourceStatus = "ready" | "processing" | "pending" | "failed";

// An Asset is a source video inside a project. Order = timeline edit order.
export type Asset = {
  id: string;
  projectId: string;
  title: string;
  position: number;
  nasPath: string;
  codec: string;
  sizeLabel: string;
  durationMs: number;
  frameRate: number;
  status: SourceStatus;
  progress: number; // 0..100, only meaningful when status = "processing"
  commentsCount: number;
  versionsCount: number;
  // visual palette used by frontend cover gradients
  paletteA: string;
  paletteB: string;
  createdAt: string;
};

export type AssetVersion = {
  id: string;
  assetId: string;
  versionNumber: number;
  label: string; // "V1", "V2", "V3"
  note?: string; // "current"
  authorUserId: string;
  createdAt: string;
};

// A Rendition is one proxy quality of an AssetVersion.
export type RenditionStatus = "ready" | "processing" | "pending" | "failed";

export type Rendition = {
  id: string;
  assetVersionId: string;
  height: 540 | 720 | 1080;
  label: "540p" | "720p" | "1080p";
  bitrateKbps: number;
  status: RenditionStatus;
  progress: number; // 0..100
  hlsMasterUrl?: string;
};

// ---------- comments ----------

export type TimelineComment = {
  id: string;
  assetVersionId: string;
  authorUserId: string;
  content: string;
  timestampMs: number;
  frameNumber?: number;
  resolved: boolean;
  parentId?: string; // when set, this is a reply
  createdAt: string;
};

export type CreateTimelineCommentInput = {
  assetVersionId: string;
  content: string;
  timestampMs: number;
  frameNumber?: number;
  parentId?: string;
};

// ---------- users ----------

export type UserRole = "editor" | "client";
export type ProjectMemberRole = "owner" | "editor" | "reviewer" | "client";

export type User = {
  id: string;
  name: string;
  initial: string;
  color: string; // hex
  role: UserRole;
  dsmUid?: number;
  email?: string;
};

export type ProjectMember = {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  position: number;
  user?: User;
};

// ---------- auth ----------

export type DsmLoginInput = { account: string; passwd: string; otp_code?: string };
export type DsmLoginResult =
  | { ok: true; user: User }
  | { ok: false; needsOtp: true }
  | { ok: false; error: string };

// ---------- NAS browser ----------

export type NasEntry =
  | { type: "folder"; name: string; path: string; childCount: number }
  | { type: "file"; name: string; path: string; sizeLabel: string; codec: string; durationMs: number };

export type NasListing = {
  path: string;
  crumbs: { label: string; path: string }[];
  entries: NasEntry[];
};

// ---------- requests ----------

export type ReorderInput = { orderedAssetIds: string[] };
export type ImportInput = { nasPaths: string[] };
export type CreateRenditionInput = { height: 540 | 720 | 1080 };
export type PatchProjectInput = { status?: ProjectStatus; name?: string };
export type CreateProjectTemplateInput = { name: string; description?: string; sourceProjectId?: string; defaultClient?: string };
export type CreateProjectFromTemplateInput = { name?: string; client?: string };
export type PatchCommentInput = { resolved?: boolean; content?: string };
export type InviteProjectMemberInput = { userId: string; role: ProjectMemberRole };
export type PatchProjectMemberInput = { role: ProjectMemberRole };

export * from "./event-bus.js";
