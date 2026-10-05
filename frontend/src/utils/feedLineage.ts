import type { FeedLink, FeedSourceType, FeedSourceInput } from '../types/feed';
import { AllocationError } from '../types/feed';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessBatch } from '../types/process-batch';

/** 来源在谱系中的唯一键 */
export function sourceKey(type: FeedSourceType, id: string): string {
  return `${type}:${id}`;
}

/**
 * 炮制成品量：工序得率产出（kg），成品也可以作为下一道工序（如再炮炙）的来源。
 */
export function batchOutputKg(batch: ProcessBatch): number {
  return Number(((batch.feedKg * batch.yieldRate) / 100).toFixed(3));
}

/** 来源最初可用量：药材按入库量，工序成品按得率产出 */
export function initialKgOf(
  type: FeedSourceType,
  id: string,
  herbs: Pick<HerbMaterial, 'id' | 'feedKg'>[],
  batches: Pick<ProcessBatch, 'id' | 'feedKg' | 'yieldRate'>[],
): number {
  if (type === 'herb') {
    return herbs.find((h) => h.id === id)?.feedKg ?? 0;
  }
  const batch = batches.find((b) => b.id === id);
  return batch ? Number(((batch.feedKg * batch.yieldRate) / 100).toFixed(3)) : 0;
}

/**
 * 按入账顺序重算各来源当前余量，并把 remainKg 快照写回每一笔。
 * 拼批/拆分、撤回、失败恢复都走同一套账：在投笔次逐笔扣减，已撤回笔次不扣。
 */
export function recalcRemain(
  links: FeedLink[],
  herbs: Pick<HerbMaterial, 'id' | 'feedKg'>[],
  batches: Pick<ProcessBatch, 'id' | 'feedKg' | 'yieldRate'>[],
): Map<string, number> {
  const remaining = new Map<string, number>();
  const sorted = [...links].sort((a, b) => {
    const ta = a.status === 'withdrawn' && a.withdrawnAt ? a.withdrawnAt : a.createdAt;
    const tb = b.status === 'withdrawn' && b.withdrawnAt ? b.withdrawnAt : b.createdAt;
    return ta.localeCompare(tb) || a.seq - b.seq;
  });
  for (const link of sorted) {
    const key = sourceKey(link.sourceType, link.sourceId);
    if (!remaining.has(key)) {
      remaining.set(key, initialKgOf(link.sourceType, link.sourceId, herbs, batches));
    }
    if (link.status === 'active') {
      const next = (remaining.get(key) ?? 0) - link.feedKg;
      remaining.set(key, next);
      link.remainKg = Number(next.toFixed(3));
    } else {
      // 撤回笔次不扣减，快照记为撤回生效时点的来源余量
      link.remainKg = Number((remaining.get(key) ?? 0).toFixed(3));
    }
  }
  return remaining;
}

/**
 * 校验一组分配是否超出来源余量。
 * 同一事务内逐笔扣减，任一笔扣成负数即抛错，由 Dexie 事务整体回滚，原分配不变。
 */
export function assertAllocation(
  entries: FeedSourceInput[],
  options: {
    /** 校验通过前库内已有的在投笔次（编辑/重试时会排除当前工序自身） */
    existing?: FeedLink[];
    /** 视作不存在的笔次 id（如当前工序被替换的旧笔次） */
    excludeLinkIds?: Set<string>;
    herbs: Pick<HerbMaterial, 'id' | 'feedKg'>[];
    batches: Pick<ProcessBatch, 'id' | 'feedKg' | 'yieldRate'>[];
    /** 来源批号描述提供器，用于报错文案 */
    describe?: (type: FeedSourceType, id: string) => string;
  },
): void {
  const { herbs, batches } = options;
  const excluded = options.excludeLinkIds ?? new Set<string>();
  const remain = new Map<string, number>();
  const apply = (type: FeedSourceType, id: string, kg: number) => {
    const key = sourceKey(type, id);
    if (!remain.has(key)) {
      remain.set(key, initialKgOf(type, id, herbs, batches));
    }
    const next = (remain.get(key) ?? 0) - kg;
    if (next < -0.001) {
      const label = options.describe ? options.describe(type, id) : `${type === 'herb' ? '药材批次' : '工序批次'} ${id}`;
      throw new AllocationError(`${label} 余量不足：需 ${kg}kg，仅剩 ${(remain.get(key) ?? 0).toFixed(1)}kg，分配已取消，原分配不变`);
    }
    remain.set(key, Number(next.toFixed(3)));
  };

  (options.existing ?? [])
    .filter((l) => l.status === 'active' && !excluded.has(l.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq)
    .forEach((l) => apply(l.sourceType, l.sourceId, l.feedKg));

  entries.forEach((entry) => {
    if (!Number.isFinite(entry.feedKg) || entry.feedKg <= 0) {
      throw new AllocationError('每一笔投料量必须大于 0');
    }
    apply(entry.sourceType, entry.sourceId, entry.feedKg);
  });
}

/** 旧单来源记录升级为单节点谱系（v3 升级与备份恢复共用） */
export function buildSingleNodeLink(
  batch: ProcessBatch,
  snapshot: { name: string; batchNo: string },
  createdAt?: string,
): FeedLink {
  return {
    id: `feed-${batch.id}`,
    batchId: batch.id,
    sourceType: 'herb',
    sourceId: batch.herbId,
    sourceName: snapshot.name,
    sourceBatchNo: snapshot.batchNo,
    feedKg: batch.feedKg,
    remainKg: 0,
    seq: 1,
    status: 'active',
    createdAt: createdAt ?? batch.startedAt,
  };
}
