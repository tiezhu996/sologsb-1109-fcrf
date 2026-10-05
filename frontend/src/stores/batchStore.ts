import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { round2 } from '../utils/lineage';
import type { FeedEntry, FeedSourceType } from '../types/feed-entry';
import type { FireLevel } from '../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../types/process-batch';

/** 一笔投料来源：药材原批（herb）或上一道工序产出（batch） */
export interface SourceAllocationInput {
  sourceType: FeedSourceType;
  sourceId: string;
  amountKg: number;
  remark?: string;
}

export interface BatchInput {
  batchNo: string;
  /** 主药材（保留单字段便于按药材筛选；完整来源以 sources 逐笔记录为准） */
  herbId: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  fireLevel: FireLevel;
  startedAt: string;
  endedAt: string;
  yieldRate: number;
  degree: ProcessDegree;
  operator: string;
  remark?: string;
  /** 逐笔来源分配（拼批可多笔）；新建/编辑未锁定工序时必传 */
  sources?: SourceAllocationInput[];
}

interface BatchState {
  batches: ProcessBatch[];
  feeds: FeedEntry[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  createBatch: (input: BatchInput, lock?: boolean) => Promise<ProcessBatch>;
  updateBatch: (id: string, patch: Partial<BatchInput>, force?: boolean) => Promise<boolean>;
  /** 删除工序：已锁定或已有留样的工序禁止删除；删除时逐笔撤回来源恢复原分配 */
  removeBatch: (id: string) => Promise<void>;
  /** 提交得率与程度判定后锁定该批 */
  lockBatch: (id: string) => Promise<void>;
  /** 质检员放行/改判：仅质检员可解锁 */
  unlockAsQc: (id: string, qcBy: string) => Promise<void>;
  /** 撤回某一笔来源：只影响这一笔，其余笔与工序保留；未完成工序留待重新分配/重试 */
  withdrawFeed: (feedId: string) => Promise<void>;
  degreeCount: () => Record<ProcessDegree, number>;
  pendingBatches: () => ProcessBatch[];
  batchesOfHerb: (herbId: string) => ProcessBatch[];
}

/** 校验一组来源分配的余额；返回带剩余量快照的逐笔记录（同事务内累计扣减） */
function planFeedEntries(
  sources: SourceAllocationInput[],
  opts: {
    herbs: Map<string, number>;
    batchOutputs: Map<string, number>;
    usedByHerb: Map<string, number>;
    usedByBatch: Map<string, number>;
    excludeBatchId?: string;
    batchId: string;
    createdAt: string;
  },
): FeedEntry[] {
  if (sources.length === 0) {
    throw new Error('至少登记一笔投料来源');
  }
  const entries: FeedEntry[] = [];
  sources.forEach((src, index) => {
    const amount = round2(Number(src.amountKg));
    if (!src.sourceId) {
      throw new Error(`第 ${index + 1} 笔来源未选择批次`);
    }
    if (!(amount > 0)) {
      throw new Error(`第 ${index + 1} 笔投入量必须大于 0`);
    }
    if (src.sourceType === 'herb') {
      const total = opts.herbs.get(src.sourceId);
      if (total === undefined) {
        throw new Error(`第 ${index + 1} 笔来源药材批次不存在`);
      }
      const used = opts.usedByHerb.get(src.sourceId) ?? 0;
      if (round2(used + amount) > total + 1e-6) {
        throw new Error(`第 ${index + 1} 笔投入 ${amount}kg 超过该来源剩余 ${round2(total - used)}kg，拆批/拼批失败`);
      }
      opts.usedByHerb.set(src.sourceId, round2(used + amount));
      entries.push({
        id: uid('feed'),
        batchId: opts.batchId,
        sourceType: 'herb',
        sourceId: src.sourceId,
        amountKg: amount,
        remainAfterKg: round2(total - used - amount),
        active: true,
        createdAt: opts.createdAt,
        remark: src.remark?.trim() || undefined,
      });
    } else {
      const output = opts.batchOutputs.get(src.sourceId);
      if (output === undefined) {
        throw new Error(`第 ${index + 1} 笔来源工序不存在`);
      }
      if (src.sourceId === opts.excludeBatchId) {
        throw new Error('不能以本工序自身产出作为来源');
      }
      const used = opts.usedByBatch.get(src.sourceId) ?? 0;
      if (round2(used + amount) > output + 1e-6) {
        throw new Error(`第 ${index + 1} 笔投入 ${amount}kg 超过来源工序产出剩余 ${round2(output - used)}kg`);
      }
      opts.usedByBatch.set(src.sourceId, round2(used + amount));
      entries.push({
        id: uid('feed'),
        batchId: opts.batchId,
        sourceType: 'batch',
        sourceId: src.sourceId,
        amountKg: amount,
        remainAfterKg: round2(output - used - amount),
        active: true,
        createdAt: opts.createdAt,
        remark: src.remark?.trim() || undefined,
      });
    }
  });
  return entries;
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  batches: [],
  feeds: [],
  hydrated: false,

  hydrate: async () => {
    const [batches, feeds] = await Promise.all([
      db.batches.orderBy('startedAt').reverse().toArray(),
      db.feeds.orderBy('createdAt').toArray(),
    ]);
    set({ batches, feeds, hydrated: true });
  },

  createBatch: async (input, lock = false) => {
    const sources = (input.sources ?? []).map((s) => ({ ...s, amountKg: round2(Number(s.amountKg)) }));
    const feedKg = sources.length > 0 ? round2(sources.reduce((sum, s) => sum + s.amountKg, 0)) : round2(Number(input.feedKg) || 0);
    const batchId = uid('batch');
    const now = new Date().toISOString();
    const batch: ProcessBatch = {
      id: batchId,
      batchNo: input.batchNo.trim(),
      herbId: input.herbId,
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

    // 余额读取、逐笔校验与写入在同一事务内：任一笔超额即整体回滚，恢复原分配
    await db.transaction('rw', db.batches, db.feeds, db.herbs, async () => {
      const [herbRows, batchRows, feedRows] = await Promise.all([db.herbs.toArray(), db.batches.toArray(), db.feeds.toArray()]);
      const herbs = new Map(herbRows.map((h) => [h.id, round2(h.feedKg)]));
      const batchOutputs = new Map(batchRows.map((b) => [b.id, round2((b.feedKg * b.yieldRate) / 100)]));
      const usedByHerb = new Map<string, number>();
      const usedByBatch = new Map<string, number>();
      feedRows
        .filter((f) => f.active)
        .forEach((f) => {
          const map = f.sourceType === 'herb' ? usedByHerb : usedByBatch;
          map.set(f.sourceId, round2((map.get(f.sourceId) ?? 0) + f.amountKg));
        });
      const entries = planFeedEntries(sources, {
        herbs,
        batchOutputs,
        usedByHerb,
        usedByBatch,
        batchId,
        createdAt: input.startedAt || now,
      });
      await db.batches.put(batch);
      await db.feeds.bulkPut(entries);
    });

    set({ batches: [batch, ...get().batches], feeds: [...get().feeds] });
    const freshFeeds = await db.feeds.where('batchId').equals(batchId).toArray();
    set({ feeds: [...get().feeds, ...freshFeeds] });
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

    // 已锁定工序即便质检改判也不允许调整投料来源；未锁定工序重新分配来源时整体替换
    const replaceSources = !current.locked && patch.sources !== undefined;

    await db.transaction('rw', db.batches, db.feeds, db.herbs, async () => {
      let next: ProcessBatch = { ...current, ...patch };
      delete (next as Partial<BatchInput>).sources;

      if (replaceSources && patch.sources) {
        const sources = patch.sources.map((s) => ({ ...s, amountKg: round2(Number(s.amountKg)) }));
        const [herbRows, batchRows, feedRows] = await Promise.all([db.herbs.toArray(), db.batches.toArray(), db.feeds.toArray()]);
        const herbs = new Map(herbRows.map((h) => [h.id, round2(h.feedKg)]));
        const batchOutputs = new Map(
          batchRows.filter((b) => b.id !== id).map((b) => [b.id, round2((b.feedKg * b.yieldRate) / 100)]),
        );
        const usedByHerb = new Map<string, number>();
        const usedByBatch = new Map<string, number>();
        feedRows
          .filter((f) => f.active && f.batchId !== id)
          .forEach((f) => {
            const map = f.sourceType === 'herb' ? usedByHerb : usedByBatch;
            map.set(f.sourceId, round2((map.get(f.sourceId) ?? 0) + f.amountKg));
          });
        const nowIso = new Date().toISOString();
        const entries = planFeedEntries(sources, {
          herbs,
          batchOutputs,
          usedByHerb,
          usedByBatch,
          excludeBatchId: id,
          batchId: id,
          createdAt: nowIso,
        });
        // 旧分配逐笔标记撤回（保留追溯痕迹），再写入新分配；任一笔失败则事务回滚恢复原状
        const oldEntries = feedRows.filter((f) => f.batchId === id && f.active).map((f) => ({ ...f, active: false, withdrawnAt: nowIso }));
        const feedKg = round2(entries.reduce((sum, e) => sum + e.amountKg, 0));
        next = { ...next, feedKg, herbId: patch.herbId ?? next.herbId };
        if (oldEntries.length > 0) {
          await db.feeds.bulkPut(oldEntries);
        }
        await db.feeds.bulkPut(entries);
      }

      if (force) {
        next.qcBy = next.qcBy ?? '质检员 · 赵敏';
      }
      await db.batches.put(next);
    });

    const [nextBatch, nextFeeds] = await Promise.all([
      db.batches.get(id),
      db.feeds.where('batchId').equals(id).toArray(),
    ]);
    set({
      batches: get().batches.map((b) => (b.id === id && nextBatch ? nextBatch : b)),
      feeds: [
        ...get().feeds.filter((f) => f.batchId !== id),
        ...(nextFeeds ?? []),
      ],
    });
    return true;
  },

  removeBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    if (current.locked) {
      throw new Error('已锁定工序批次不能删除（需质检员放行后处理）');
    }
    const sampleCount = await db.samples.where('batchId').equals(id).count();
    if (sampleCount > 0) {
      throw new Error('该工序已登记留样，不能删除；请先撤下相关留样');
    }

    // 删除工序的同时逐笔撤回其来源，恢复原分配；同事务保证不留半截记录
    await db.transaction('rw', db.batches, db.feeds, async () => {
      const nowIso = new Date().toISOString();
      const entries = await db.feeds.where('batchId').equals(id).toArray();
      const withdrawn = entries
        .filter((f) => f.active)
        .map((f) => ({ ...f, active: false, withdrawnAt: nowIso, remark: f.remark ? `${f.remark}（随工序删除撤回）` : '随工序删除撤回' }));
      if (withdrawn.length > 0) {
        await db.feeds.bulkPut(withdrawn);
      }
      await db.batches.delete(id);
    });

    set({
      batches: get().batches.filter((b) => b.id !== id),
      feeds: get().feeds.filter((f) => f.batchId !== id),
    });
  },

  lockBatch: async (id) => {
    const current = get().batches.find((b) => b.id === id);
    if (!current) {
      return;
    }
    const activeTotal = round2(
      get()
        .feeds.filter((f) => f.batchId === id && f.active)
        .reduce((sum, f) => sum + f.amountKg, 0),
    );
    if (activeTotal <= 0) {
      throw new Error('该工序还没有有效的投料来源，不能锁定');
    }
    if (Math.abs(activeTotal - round2(current.feedKg)) > 0.01) {
      throw new Error(`投料来源合计 ${activeTotal}kg 与投料量 ${current.feedKg}kg 不一致，不能锁定`);
    }
    const next: ProcessBatch = { ...current, locked: true, lockedAt: new Date().toISOString() };
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

  withdrawFeed: async (feedId) => {
    const entry = get().feeds.find((f) => f.id === feedId);
    if (!entry || !entry.active) {
      return;
    }
    const batch = get().batches.find((b) => b.id === entry.batchId);
    if (batch?.locked) {
      throw new Error('已锁定工序的投料来源不能撤回');
    }

    await db.transaction('rw', db.batches, db.feeds, async () => {
      const nowIso = new Date().toISOString();
      await db.feeds.put({ ...entry, active: false, withdrawnAt: nowIso });
      if (batch) {
        const remainEntries = await db.feeds.where('batchId').equals(batch.id).toArray();
        const total = round2(
          remainEntries.filter((f) => f.active).reduce((sum, f) => sum + f.amountKg, 0),
        );
        // 只同步该工序的当前投入量；工序本身保留，未完成可重新分配后重试
        await db.batches.put({ ...batch, feedKg: total });
      }
    });

    const [nextBatch, nextEntry] = await Promise.all([db.batches.get(entry.batchId), db.feeds.get(feedId)]);
    set({
      batches: nextBatch ? get().batches.map((b) => (b.id === nextBatch.id ? nextBatch : b)) : get().batches,
      feeds: get().feeds.map((f) => (f.id === feedId && nextEntry ? nextEntry : f)),
    });
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
    get().batches.filter((b) => b.herbId === herbId || get().feeds.some((f) => f.active && f.batchId === b.id && f.sourceType === 'herb' && f.sourceId === herbId)),
}));
