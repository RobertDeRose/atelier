import { nowIso } from "../util/ids.ts";

export interface PerformanceSample {
  operation: string;
  phase: string;
  durationMs: number;
  startedAt: string;
  subprocesses?: number;
  filesHashed?: number;
  bytesHashed?: number;
  cache?: "hit" | "miss" | "skip";
  detail?: Record<string, unknown>;
}

export interface PerformanceSummary {
  sampleCount: number;
  totalDurationMs: number;
  latest: PerformanceSample[];
  byPhase: Array<{
    operation: string;
    phase: string;
    count: number;
    totalDurationMs: number;
    averageDurationMs: number;
    maximumDurationMs: number;
    subprocesses: number;
    filesHashed: number;
    bytesHashed: number;
  }>;
}

/** Bounded, session-local timing recorder for interactive latency diagnostics. */
export class PerformanceRecorder {
  private readonly samples: PerformanceSample[] = [];

  constructor(private readonly limit = 500) {}

  record(sample: PerformanceSample): void {
    this.samples.push({ ...sample, durationMs: Math.max(0, sample.durationMs) });
    if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
  }

  async measure<T>(
    operation: string,
    phase: string,
    task: () => Promise<T>,
    metadata: Omit<PerformanceSample, "operation" | "phase" | "durationMs" | "startedAt"> = {},
  ): Promise<T> {
    const startedAt = nowIso();
    const started = performance.now();
    try {
      return await task();
    } finally {
      this.record({ operation, phase, durationMs: performance.now() - started, startedAt, ...metadata });
    }
  }

  measureSync<T>(
    operation: string,
    phase: string,
    task: () => T,
    metadata: Omit<PerformanceSample, "operation" | "phase" | "durationMs" | "startedAt"> = {},
  ): T {
    const startedAt = nowIso();
    const started = performance.now();
    try {
      return task();
    } finally {
      this.record({ operation, phase, durationMs: performance.now() - started, startedAt, ...metadata });
    }
  }

  list(limit = 100): PerformanceSample[] {
    return this.samples.slice(-Math.max(0, limit));
  }

  clear(): void {
    this.samples.length = 0;
  }

  summary(limit = 100): PerformanceSummary {
    const latest = this.list(limit);
    const groups = new Map<string, PerformanceSummary["byPhase"][number]>();
    for (const sample of latest) {
      const key = `${sample.operation}\0${sample.phase}`;
      const group = groups.get(key) ?? {
        operation: sample.operation,
        phase: sample.phase,
        count: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        maximumDurationMs: 0,
        subprocesses: 0,
        filesHashed: 0,
        bytesHashed: 0,
      };
      group.count += 1;
      group.totalDurationMs += sample.durationMs;
      group.maximumDurationMs = Math.max(group.maximumDurationMs, sample.durationMs);
      group.subprocesses += sample.subprocesses ?? 0;
      group.filesHashed += sample.filesHashed ?? 0;
      group.bytesHashed += sample.bytesHashed ?? 0;
      group.averageDurationMs = group.totalDurationMs / group.count;
      groups.set(key, group);
    }
    return {
      sampleCount: latest.length,
      totalDurationMs: latest.reduce((sum, sample) => sum + sample.durationMs, 0),
      latest,
      byPhase: [...groups.values()].sort((left, right) => right.totalDurationMs - left.totalDurationMs),
    };
  }
}
