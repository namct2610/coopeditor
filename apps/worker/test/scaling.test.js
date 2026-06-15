import test from "node:test";
import assert from "node:assert/strict";

import { computeTargetConcurrency, createScalingPolicy, shouldKeepWorkerAlive } from "../src/scaling.js";

test("createScalingPolicy normalizes env with sane defaults", () => {
  const policy = createScalingPolicy({});
  assert.deepEqual(policy, {
    baseConcurrency: 2,
    threshold: 5,
    extraSlots: 1,
    maxConcurrency: 3,
  });
});

test("computeTargetConcurrency keeps base capacity until threshold is exceeded", () => {
  const policy = createScalingPolicy({
    WORKER_CONCURRENCY: "2",
    WORKER_AUTOSCALE_THRESHOLD: "5",
    WORKER_AUTOSCALE_STEP: "1",
    WORKER_MAX_CONCURRENCY: "4",
  });
  assert.equal(computeTargetConcurrency(0, policy), 2);
  assert.equal(computeTargetConcurrency(5, policy), 2);
  assert.equal(computeTargetConcurrency(6, policy), 3);
  assert.equal(computeTargetConcurrency(11, policy), 4);
  assert.equal(computeTargetConcurrency(30, policy), 4);
});

test("shouldKeepWorkerAlive retires only surplus idle slots", () => {
  assert.equal(shouldKeepWorkerAlive(0, 2, 0), true);
  assert.equal(shouldKeepWorkerAlive(1, 2, 0), true);
  assert.equal(shouldKeepWorkerAlive(2, 2, 1), true);
  assert.equal(shouldKeepWorkerAlive(2, 2, 0), false);
});
