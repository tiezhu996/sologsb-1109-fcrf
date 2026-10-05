/**
 * 投料关系（逐笔记录）
 *
 * 同规格药材会拆批（一批分给多个班组/工序）或拼批（多个来源批次合并炮制），
 * 因此一个炮制工序（ProcessBatch）可挂多笔来源；本类型是每一笔来源的台账行。
 * 有效记录（active=true）的 amountKg 之和应等于工序的 feedKg。
 */

/** 来源类型：药材原批，或上一道炮制工序的产出（多道工序合并炮制时） */
export type FeedSourceType = 'herb' | 'batch';

export interface FeedEntry {
  id: string;
  /** 投入到的炮制工序 */
  batchId: string;
  /** 来源类型 */
  sourceType: FeedSourceType;
  /** 来源 id：sourceType=herb 时为药材批次 id，=batch 时为来源工序 id */
  sourceId: string;
  /** 本笔投入量（kg） */
  amountKg: number;
  /**
   * 分配时该来源的账面剩余量快照（kg），用于追溯「投完还剩多少」。
   * 实时剩余量以后续逐笔记录滚动计算为准（见 utils/lineage.ts）。
   */
  remainAfterKg: number;
  /** false = 该笔来源已被撤回（只影响这一笔，工序与其他笔保留） */
  active: boolean;
  /** 撤回时间 ISO */
  withdrawnAt?: string;
  /** 登记时间 ISO */
  createdAt: string;
  /** 备注（班组、拆批/拼批说明） */
  remark?: string;
}

/** 谱系中的一个来源节点 */
export interface LineageNode {
  /** 节点 id，药材批次为 herbId，工序节点为 `batch:${batchId}` */
  key: string;
  sourceType: FeedSourceType;
  sourceId: string;
  /** 节点显示名（药材名 / 生产批号） */
  label: string;
  /** 本节点投入到下游的量（kg） */
  amountKg: number;
  /** 上游来源节点（工序产出继续投料时递归） */
  parents: LineageNode[];
}
