export type Project = {
  id: string;
  name: string;
  createdAt: string;
};

export type Asset = {
  id: string;
  projectId: string;
  path: string;
  title: string;
  durationMs: number;
  frameRate: number;
  createdAt: string;
};

export type AssetVersion = {
  id: string;
  assetId: string;
  versionNumber: number;
  sourcePath: string;
  proxyStatus: "pending" | "processing" | "ready" | "failed";
  posterUrl?: string;
  hlsMasterUrl?: string;
  createdAt: string;
};

export type TimelineComment = {
  id: string;
  assetVersionId: string;
  authorId: string;
  content: string;
  timestampMs: number;
  frameNumber?: number;
  resolvedAt?: string;
  createdAt: string;
};

export type CreateTimelineCommentInput = Pick<
  TimelineComment,
  "assetVersionId" | "content" | "timestampMs" | "frameNumber"
>;
