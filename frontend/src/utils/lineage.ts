import type { FeedEntry, LineageNode } from '../types/feed-entry';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessBatch } from '../types/process-batch';

/** 浮点累计预留两位（kg），避免 0.1+0.2 类误差影响余额校验 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** 某药材批次被所有有效投料占用的总量（kg），excludeEntryId 用于编辑时排除自身 */
export function usedOfHerb(feeds: FeedEntry[], herbId: string, excludeEntryId?: string): number {
  return round2(
    feeds
      .filter((f) => f.active && f.sourceType === 'herb' && f.sourceId === herbId && f.id !== excludeEntryId)
      .reduce((sum, f) => sum + f.amountKg, 0),
  );
}

/** 某来源工序产出被后续工序有效投料占用的总量（kg） */
export function usedOfBatchOutput(feeds: FeedEntry[], sourceBatchId: string, excludeEntryId?: string): number {
  return round2(
    feeds
      .filter((f) => f.active && f.sourceType === 'batch' && f.sourceId === sourceBatchId && f.id !== excludeEntryId)
      .reduce((sum, f) => sum + f.amountKg, 0),
  );
}

/** 药材批次实时可用量（kg）：入库量 − 所有有效投料占用 */
export function herbRemaining(herbs: HerbMaterial[], feeds: FeedEntry[], herbId: string, excludeEntryId?: string): number {
  const herb = herbs.find((h) => h.id === herbId);
  if (!herb) return 0;
  return round2(herb.feedKg - usedOfHerb(feeds, herbId, excludeEntryId));
}

/** 工序产出实时可用量（kg）：得率折算产出 − 已被后续工序占用 */
export function batchOutputRemaining(batches: ProcessBatch[], feeds: FeedEntry[], batchId: string, excludeEntryId?: string): number {
  const batch = batches.find((b) => b.id === batchId);
  if (!batch) return 0;
  const output = round2((batch.feedKg * batch.yieldRate) / 100);
  return round2(output - usedOfBatchOutput(feeds, batchId, excludeEntryId));
}

/** 某工序的有效投料笔（按登记时间排序） */
export function activeFeedsOf(feeds: FeedEntry[], batchId: string): FeedEntry[] {
  return feeds
    .filter((f) => f.batchId === batchId && f.active)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 某工序的全部投料笔（含已撤回），有效在前 */
export function allFeedsOf(feeds: FeedEntry[], batchId: string): FeedEntry[] {
  return feeds
    .filter((f) => f.batchId === batchId)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.createdAt.localeCompare(b.createdAt));
}

/** 工序有效投料总量（kg） */
export function activeFeedTotal(feeds: FeedEntry[], batchId: string): number {
  return round2(activeFeedsOf(feeds, batchId).reduce((sum, f) => sum + f.amountKg, 0));
}

interface LineageContext {
  herbs: HerbMaterial[];
  batches: ProcessBatch[];
  feeds: FeedEntry[];
}

function herbLabel(ctx: LineageContext, herbId: string): string {
  const herb = ctx.herbs.find((h) => h.id === herbId);
  return herb ? `${herb.name}（${herb.batchNo}）` : `药材批次 ${herbId}`;
}

function batchLabel(ctx: LineageContext, batchId: string): string {
  const batch = ctx.batches.find((b) => b.id === batchId);
  if (batch) {
    const herb = ctx.herbs.find((h) => h.id === batch.herbId);
    return `${batch.batchNo}${herb ? ` · ${herb.name}` : ''}`;
  }
  return `工序 ${batchId}`;
}

function buildNode(ctx: LineageContext, sourceType: FeedEntry['sourceType'], sourceId: string, amountKg: number, trail: Set<string>): LineageNode {
  if (sourceType === 'herb') {
    return { key: sourceId, sourceType, sourceId, label: herbLabel(ctx, sourceId), amountKg: round2(amountKg), parents: [] };
  }
  const key = `batch:${sourceId}`;
  // 工序环路保护（数据异常时不再继续向上展开）
  const parents = trail.has(key)
    ? []
    : activeFeedsOf(ctx.feeds, sourceId).map((f) =>
        buildNode(ctx, f.sourceType, f.sourceId, f.amountKg, new Set(trail).add(key)),
      );
  return { key, sourceType, sourceId, label: batchLabel(ctx, sourceId), amountKg: round2(amountKg), parents };
}

/**
 * 构建某工序的完整来源谱系树（支持拼批、拆批、多道工序合并）。
 * feeds 是唯一事实来源，页面与备份恢复后都按它重建。
 */
export function buildLineage(ctx: LineageContext, batchId: string): LineageNode[] {
  return activeFeedsOf(ctx.feeds, batchId).map((f) =>
    buildNode(ctx, f.sourceType, f.sourceId, f.amountKg, new Set([`batch:${batchId}`])),
  );
}

/**
 * 旧单来源记录（只有 batch.herbId + feedKg、没有 feeds 行）补成的单节点谱系。
 * 用于 v2 数据升级与缺记录时的回显兜底。
 */
export function singleNodeLineage(ctx: LineageContext, batch: ProcessBatch): LineageNode[] {
  if (!batch.herbId) return [];
  return [
    {
      key: batch.herbId,
      sourceType: 'herb',
      sourceId: batch.herbId,
      label: herbLabel(ctx, batch.herbId),
      amountKg: round2(batch.feedKg),
      parents: [],
    },
  ];
}

/** 取工序谱系；无逐笔记录时回退为旧单来源单节点 */
export function lineageOf(ctx: LineageContext, batch: ProcessBatch): LineageNode[] {
  const nodes = buildLineage(ctx, batch.id);
  return nodes.length > 0 ? nodes : singleNodeLineage(ctx, batch);
}

/**
 * 收集谱系叶节点（最初药材批次）及追溯到本工序的实际流量（kg）。
 * 工序节点只把自身收到的流量按其上游投入比例继续下分，
 * 例如上游工序投了 A 50kg、只有 30kg 流入本工序，则 A 对本工序的贡献为 30kg。
 */
export function lineageLeafAmounts(nodes: LineageNode[]): Map<string, { label: string; amountKg: number }> {
  const map = new Map<string, { label: string; amountKg: number }>();
  const walk = (node: LineageNode, flow: number) => {
    if (node.parents.length === 0) {
      if (node.sourceType === 'herb') {
        const prev = map.get(node.sourceId);
        map.set(node.sourceId, { label: node.label, amountKg: round2((prev?.amountKg ?? 0) + flow) });
      }
      return;
    }
    const totalParent = round2(node.parents.reduce((sum, p) => sum + p.amountKg, 0));
    node.parents.forEach((p) => {
      const share = totalParent > 0 ? (flow * p.amountKg) / totalParent : flow / node.parents.length;
      walk(p, round2(share));
    });
  };
  nodes.forEach((node) => walk(node, node.amountKg));
  return map;
}
