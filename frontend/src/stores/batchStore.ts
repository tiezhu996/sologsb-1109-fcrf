import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';
import type { FeedLink, FeedSourceInput } from '../types/feed';
import { AllocationError } from '../types/feed';
import { assertAllocation, initialKgOf, recalcRemain, sourceKey } from '../utils/feedLineage';
import { useFeedStore } from './feedStore';

export interface BatchInput {
  batchNo: string;
  /** 兼容旧单来源入口；多来源时以 sources 为准 */
  herbId?: string;
  methodId: string;
  /** 逐笔来源分配（拆批/拼批/班组拆分/与另一批合并），为空时回退 herbId 单笔 */
  sources?: FeedSourceInput[];
  feedKg?: number;
  auxUsedKg: number;
  fireLevel: FireLevel;
  startedAt: string;
  endedAt: string;
  yieldRate: number;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
}

/** 已锁定工序（及其留样）不能被撤掉 */
export class BatchLockedError extends Error {}
/** 工序已有留样，台账需先处理留样，避免留样挂空 */
export class BatchHasSampleError extends Error {}

interface BatchState {
  batches: ProcessBatch[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /** 新建工序并逐笔入账；余量不足时事务回滚，原分配不变 */
  createBatch: (input: BatchInput, lock?: boolean) => Promise<ProcessBatch>;
  /**
   * 编辑工序。locked 工序必须 force（质检员改判），且不得改投料来源；
   * 未锁定工序可整体替换来源分配，校验失败回滚、保留原分配供重试。
   */
  updateBatch: (id: string, patch: Partial<BatchInput>, force?: boolean) => Promise<boolean>;
  /** 删除未锁定且无留样的工序，投料逐笔退回来源 */
  removeBatch: (id: string) => Promise<void>;
  /** 撤回某一笔来源：只影响这一笔，退回余量；工序保留其余分配且不锁定 */
  withdrawFeed: (linkId: string, reason?: string) => Promise<void>;
  /** 提交得率与程度判定后锁定该批 */
  lockBatch: (id: string) => Promise<void>;
  /** 质检员放行/改判：仅质检员可解锁 */
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

/** 来源批号快照（药材名/批号 或 工序批号/主来源药材名） */
function sourceSnapshot(
  sourceType: FeedSourceInput['sourceType'],
  sourceId: string,
  herbs: { id: string; name: string; batchNo: string }[],
  batches: ProcessBatch[],
): { name: string; batchNo: string } {
  if (sourceType === 'herb') {
    const herb = herbs.find((h) => h.id === sourceId);
    return { name: herb?.name ?? '未知药材', batchNo: herb?.batchNo ?? '未知批号' };
  }
  const batch = batches.find((b) => b.id === sourceId);
  const herb = herbs.find((h) => h.id === batch?.herbId);
  return { name: herb?.name ?? '炮制成品', batchNo: batch?.batchNo ?? '未知批号' };
}

/** 校验并规整来源入参：至少一笔、来源必须存在、同来源合并为一笔 */
function normalizeEntries(input: BatchInput): FeedSourceInput[] {
  const entries = (input.sources && input.sources.length
    ? input.sources
    : input.herbId
      ? [{ sourceType: 'herb' as const, sourceId: input.herbId, feedKg: input.feedKg ?? 0 }]
      : []
  ).map((e) => ({ sourceType: e.sourceType, sourceId: e.sourceId, feedKg: Number(e.feedKg) || 0 }));

  if (entries.length === 0) {
    throw new AllocationError('请至少选择一笔投料来源');
  }
  const merged = new Map<string, FeedSourceInput>();
  for (const entry of entries) {
    const key = sourceKey(entry.sourceType, entry.sourceId);
    const existed = merged.get(key);
    if (existed) {
      existed.feedKg = Number((existed.feedKg + entry.feedKg).toFixed(3));
    } else {
      merged.set(key, { ...entry });
    }
  }
  return Array.from(merged.values());
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  hydrated: false,

  hydrate: async () => {
    const batches = await db.batches.orderBy('startedAt').reverse().toArray();
    set({ batches, hydrated: true });
  },

  createBatch: async (input, lock = false) => {
    const entries = normalizeEntries(input);
    const batchId = uid('batch');
    const now = new Date().toISOString();

    let batch!: ProcessBatch;
    await db.transaction('rw', db.batches, db.feeds, db.herbs, async () => {
      const [herbs, batches, existingLinks] = await Promise.all([
        db.herbs.toArray(),
        db.batches.toArray(),
        db.feeds.toArray(),
      ]);

      const describe = (type: FeedSourceInput['sourceType'], id: string) => {
        const snap = sourceSnapshot(type, id, herbs, batches);
        return `${snap.name}（${snap.batchNo}）`;
      };
      assertAllocation(entries, { existing: existingLinks, herbs, batches, describe });

      const feedKg = Number(entries.reduce((sum, e) => sum + e.feedKg, 0).toFixed(3));
      const primary = entries[0];
      const primaryHerbId =
        primary.sourceType === 'herb'
          ? primary.sourceId
          : batches.find((b) => b.id === primary.sourceId)?.herbId ?? input.herbId ?? '';

      batch = {
        id: batchId,
        batchNo: input.batchNo.trim(),
        herbId: primaryHerbId,
        methodId: input.methodId,
        feedKg,
        auxUsedKg: Number(input.auxUsedKg) || 0,
        fireLevel: input.fireLevel,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        yieldRate: Number(input.yieldRate) || 0,
        degree: input.degree,
        operator: input.operator.trim(),
        locked: lock,
        lockedAt: lock ? now : undefined,
        remark: input.remark?.trim() || undefined,
      };
      await db.batches.put(batch);

      const newLinks: FeedLink[] = entries.map((entry, index) => {
        const snap = sourceSnapshot(entry.sourceType, entry.sourceId, herbs, batches);
        return {
          id: uid('feed'),
          batchId,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          sourceName: snap.name,
          sourceBatchNo: snap.batchNo,
          feedKg: entry.feedKg,
          remainKg: 0,
          seq: index + 1,
          status: 'active',
          createdAt: now,
        };
      });
      const allLinks = [...existingLinks, ...newLinks];
      recalcRemain(allLinks, herbs, [...batches, batch]);
      // 新笔次与同来源的历史笔次（余量快照被连带更新）一并持久化
      await db.feeds.bulkPut(allLinks);
    });

    await Promise.all([useFeedStore.getState().hydrate(), get().hydrate()]);
    return batch;
  },

  updateBatch: async (id, patch, force = false) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return false;
    }
    if (current.locked && !force) {
      return false;
    }

    await db.transaction('rw', db.batches, db.feeds, db.herbs, async () => {
      const [herbs, batches, allLinks] = await Promise.all([db.herbs.toArray(), db.batches.toArray(), db.feeds.toArray()]);
      const ownLinks = allLinks.filter((l) => l.batchId === id);
      const activeOwn = ownLinks.filter((l) => l.status === 'active');

      // 新清单与库内在投笔次逐笔比对：完全一致则不动谱系（不产生多余撤回记录）
      let entries: FeedSourceInput[] = [];
      let replacingSources = false;
      if (patch.sources !== undefined) {
        entries = normalizeEntries({ ...current, ...patch, herbId: current.herbId });
        const currentKeys = activeOwn.map((l) => `${l.sourceType}:${l.sourceId}:${l.feedKg}`).sort();
        const nextKeys = entries.map((e) => `${e.sourceType}:${e.sourceId}:${e.feedKg}`).sort();
        replacingSources = JSON.stringify(currentKeys) !== JSON.stringify(nextKeys);
        if (current.locked && replacingSources) {
          // 已锁定工序的投料来源不可改（撤不掉），质检员改判仅限火候/得率/程度
          throw new BatchLockedError('已锁定工序的投料来源不可变更');
        }
      }

      let feedKg = current.feedKg;
      let primaryHerbId = current.herbId;
      let linksToPut: FeedLink[] = [];

      if (replacingSources) {
        // 未锁定工序编辑：旧在投分配整体作废，按新清单重新分配；
        // 校验抛错时事务回滚，旧分配原样保留（未完成工序保留原分配供重试）。
        const describe = (type: FeedSourceInput['sourceType'], sourceId: string) => {
          const snap = sourceSnapshot(type, sourceId, herbs, batches);
          return `${snap.name}（${snap.batchNo}）`;
        };
        assertAllocation(entries, { existing: allLinks, excludeLinkIds: new Set(activeOwn.map((l) => l.id)), herbs, batches, describe });

        const now = new Date().toISOString();
        const retired: FeedLink[] = activeOwn.map((l) => ({
          ...l,
          status: 'withdrawn',
          withdrawnAt: now,
          withdrawReason: '编辑重配（原分配由系统逐笔退回）',
        }));
        const startSeq = ownLinks.length + 1;
        const newLinks: FeedLink[] = entries.map((entry, index) => {
          const snap = sourceSnapshot(entry.sourceType, entry.sourceId, herbs, batches);
          return {
            id: uid('feed'),
            batchId: id,
            sourceType: entry.sourceType,
            sourceId: entry.sourceId,
            sourceName: snap.name,
            sourceBatchNo: snap.batchNo,
            feedKg: entry.feedKg,
            remainKg: 0,
            seq: startSeq + index,
            status: 'active',
            createdAt: now,
          };
        });
        linksToPut = [...retired, ...newLinks];
        feedKg = Number(entries.reduce((sum, e) => sum + e.feedKg, 0).toFixed(3));
        const primary = entries[0];
        primaryHerbId =
          primary.sourceType === 'herb'
            ? primary.sourceId
            : batches.find((b) => b.id === primary.sourceId)?.herbId ?? current.herbId;
      }

      const { sources: _sources, ...fieldPatch } = patch;
      void _sources;
      const next: ProcessBatch = {
        ...current,
        ...fieldPatch,
        herbId: replacingSources ? primaryHerbId : current.herbId,
        feedKg: replacingSources ? feedKg : fieldPatch.feedKg !== undefined ? Number(fieldPatch.feedKg) : current.feedKg,
      };
      if (force) {
        next.qcBy = next.qcBy ?? '质检员 · 赵敏';
      }
      await db.batches.put(next);
      if (linksToPut.length) {
        const restLinks = allLinks.filter((l) => l.batchId !== id);
        const updatedOwn = [...ownLinks.filter((l) => l.status !== 'active'), ...linksToPut];
        const recalculated = [...restLinks, ...updatedOwn];
        recalcRemain(recalculated, herbs, batches);
        await db.feeds.bulkPut(recalculated);
      }
    });

    await Promise.all([useFeedStore.getState().hydrate(), get().hydrate()]);
    return true;
  },

  withdrawFeed: async (linkId, reason) => {
    await db.transaction('rw', db.batches, db.feeds, db.samples, db.herbs, async () => {
      const link = await db.feeds.get(linkId);
      if (!link || link.status === 'withdrawn') {
        return;
      }
      const batch = await db.batches.get(link.batchId);
      if (!batch) {
        return;
      }
      if (batch.locked) {
        throw new BatchLockedError('已锁定工序及其留样不能被撤掉');
      }
      const sampleCount = await db.samples.where('batchId').equals(batch.id).count();
      if (sampleCount > 0) {
        throw new BatchHasSampleError('该工序已登记留样，不能撤回投料');
      }

      const [herbs, batches, allLinks] = await Promise.all([db.herbs.toArray(), db.batches.toArray(), db.feeds.toArray()]);
      const next: FeedLink = {
        ...link,
        status: 'withdrawn',
        withdrawnAt: new Date().toISOString(),
        withdrawReason: reason?.trim() || undefined,
      };
      const others = allLinks.filter((l) => l.id !== linkId);
      const recalculated = [...others, next];
      recalcRemain(recalculated, herbs, batches);
      // 同来源其它笔次的余量快照也被连带更新，整表写回
      await db.feeds.bulkPut(recalculated);

      // 工序在投量同步减少；若全部撤回则为 0，维持未锁定，保留原分配记录供重试
      const activeKg = recalculated
        .filter((l) => l.batchId === batch.id && l.status === 'active')
        .reduce((sum, l) => sum + l.feedKg, 0);
      await db.batches.put({ ...batch, feedKg: Number(activeKg.toFixed(3)) });
    });
    await Promise.all([useFeedStore.getState().hydrate(), get().hydrate()]);
  },

  removeBatch: async (id) => {
    await db.transaction('rw', db.batches, db.feeds, db.samples, db.herbs, async () => {
      const batch = await db.batches.get(id);
      if (!batch) {
        return;
      }
      if (batch.locked) {
        throw new BatchLockedError('已锁定工序不能删除');
      }
      const sampleCount = await db.samples.where('batchId').equals(id).count();
      if (sampleCount > 0) {
        throw new BatchHasSampleError('该工序已有留样，请先在留样台账处理后再删除');
      }
      const downstreamCount = await db.feeds
        .where('sourceId')
        .equals(id)
        .filter((l) => l.sourceType === 'batch' && l.status === 'active')
        .count();
      if (downstreamCount > 0) {
        throw new AllocationError('该工序成品已被其它工序合并投料，谱系需保留来源，不能删除');
      }
      const [herbs, batches, allLinks] = await Promise.all([db.herbs.toArray(), db.batches.toArray(), db.feeds.toArray()]);
      const kept = allLinks.filter((l) => l.batchId !== id);
      recalcRemain(kept, herbs, batches);
      await Promise.all([db.feeds.where('batchId').equals(id).delete(), db.feeds.bulkPut(kept), db.batches.delete(id)]);
    });
    await Promise.all([useFeedStore.getState().hydrate(), get().hydrate()]);
  },

  lockBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const activeKg = useFeedStore.getState().activeFeedKg(id);
    if (activeKg <= 0) {
      throw new AllocationError('该工序没有在投的投料来源，请先补录来源后再锁定');
    }
    const next: ProcessBatch = { ...current, feedKg: activeKg, locked: true, lockedAt: new Date().toISOString() };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
  },

  unlockAsQc: async (id, qcBy) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const next: ProcessBatch = { ...current, locked: false, qcBy };
    await db.batches.put(next);
    set({ batches: get().batches.map((b) => (b.id === id ? next : b)) });
  },

  degreeCount: () => {
    const result: Record<ProcessDegree, number> = { 不及: 0, 适中: 0, 太过: 0 };
    get().batches.forEach((b) => {
      result[b.degree] += 1;
    });
    return result;
  },

  pendingBatches: () => get().batches.filter((b) => !b.locked),

  batchesOfHerb: (herbId) =>
    get().batches.filter((b) => {
      if (b.herbId === herbId) return true;
      return useFeedStore.getState().links.some((l) => l.batchId === b.id && l.status === 'active' && l.sourceType === 'herb' && l.sourceId === herbId);
    }),
}));

/** 来源最初可用量（页面下拉展示余量用） */
export function sourceInitialKg(
  sourceType: FeedSourceInput['sourceType'],
  sourceId: string,
  herbs: { id: string; feedKg: number }[],
  batches: { id: string; feedKg: number; yieldRate: number }[],
): number {
  return initialKgOf(sourceType, sourceId, herbs, batches);
}
