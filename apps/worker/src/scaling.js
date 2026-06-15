export function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createScalingPolicy(env = process.env) {
  const baseConcurrency = normalizePositiveInt(env.WORKER_CONCURRENCY || "2", 2);
  const threshold = normalizePositiveInt(env.WORKER_AUTOSCALE_THRESHOLD || "5", 5);
  const extraSlots = normalizePositiveInt(env.WORKER_AUTOSCALE_STEP || "1", 1);
  const maxConcurrency = Math.max(baseConcurrency, normalizePositiveInt(env.WORKER_MAX_CONCURRENCY || String(baseConcurrency + extraSlots), baseConcurrency + extraSlots));
  return { baseConcurrency, threshold, extraSlots, maxConcurrency };
}

export function computeTargetConcurrency(depth, policy) {
  const queueDepth = Math.max(0, Number(depth) || 0);
  const burstCount = queueDepth > policy.threshold ? Math.ceil((queueDepth - policy.threshold) / policy.threshold) : 0;
  const target = policy.baseConcurrency + burstCount * policy.extraSlots;
  return Math.max(policy.baseConcurrency, Math.min(policy.maxConcurrency, target));
}

export function shouldKeepWorkerAlive(slotIndex, targetConcurrency, activeJobs) {
  if (slotIndex < targetConcurrency) return true;
  return activeJobs > 0;
}
