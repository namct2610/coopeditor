export function buildProxyStorageReport(items = [], meta = []) {
  const byRendition = {};
  for (const it of items || []) {
    const key = String(it && it.key || "");
    const slash = key.indexOf("/");
    if (slash < 0) continue;
    const renditionId = key.slice(0, slash);
    if (!renditionId) continue;
    if (!byRendition[renditionId]) byRendition[renditionId] = { renditionId, bytes: 0, fileCount: 0 };
    byRendition[renditionId].bytes += Number(it && it.size || 0);
    byRendition[renditionId].fileCount += 1;
  }

  const metaById = new Map((meta || []).map((row) => [row.renditionId, row]));
  const renditions = Object.keys(byRendition).map((renditionId) => {
    const usage = byRendition[renditionId];
    const details = metaById.get(renditionId);
    if (!details) return { ...usage, orphan: true, label: renditionId, status: "orphan" };
    return {
      ...details,
      bytes: usage.bytes,
      fileCount: usage.fileCount,
      orphan: !!details.orphan,
      label: details.label || (details.height ? (details.height + "p") : renditionId),
      status: details.status || (details.orphan ? "orphan" : "unknown"),
    };
  }).sort((a, b) => b.bytes - a.bytes);

  const totalBytes = renditions.reduce((sum, rendition) => sum + Number(rendition.bytes || 0), 0);
  const orphanRenditions = renditions.filter((rendition) => rendition.orphan);

  return {
    totalBytes,
    orphanBytes: orphanRenditions.reduce((sum, rendition) => sum + Number(rendition.bytes || 0), 0),
    orphanCount: orphanRenditions.length,
    renditions,
  };
}
