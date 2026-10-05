/** 投料来源类型：药材批次，或上一道工序批次的炮制成品 */
export type FeedSourceType = 'herb' | 'batch';

/** 投料记录状态：在投 / 已撤回（撤回只影响这一笔，谱系仍保留） */
export type FeedLinkStatus = 'active' | 'withdrawn';

/**
 * 逐笔投料来源记录（投料谱系节点）
 * 同规格药材拆批、拼批、一批分给两个班组、与另一批合并炮制，
 * 都通过同一工序下的多笔 FeedLink 表达。
 */
export interface FeedLink {
  id: string;
  /** 所属炮制工序批次 */
  batchId: string;
  /** 来源类型 */
  sourceType: FeedSourceType;
  /** 来源 id（herbId 或另一工序批次 id） */
  sourceId: string;
  /** 来源名称快照（药材名），来源被删除后谱系仍可追溯 */
  sourceName: string;
  /** 来源批号快照 */
  sourceBatchNo: string;
  /** 本笔投入量（kg） */
  feedKg: number;
  /** 该来源在本笔入账之后的剩余量（kg），撤回/重配时统一重算 */
  remainKg: number;
  /** 同一工序内的笔次序号 */
  seq: number;
  /** 记录状态 */
  status: FeedLinkStatus;
  /** 入账时间 ISO */
  createdAt: string;
  /** 撤回时间 ISO */
  withdrawnAt?: string;
  /** 撤回原因 */
  withdrawReason?: string;
}

/** 提交一笔分配时的入参 */
export interface FeedSourceInput {
  sourceType: FeedSourceType;
  sourceId: string;
  feedKg: number;
}

/** 拼批/拆分分配校验失败错误（事务回滚后向页面提示） */
export class AllocationError extends Error {}
