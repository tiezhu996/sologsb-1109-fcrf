import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import type { FeedLink } from '../types/feed';
import { recalcRemain, buildSingleNodeLink } from './feedLineage';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  samples!: Table<RetainSample, string>;
  /** 逐笔投料谱系 */
  feeds!: Table<FeedLink, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      herbs: 'id, name, origin, part, batchNo, receivedAt',
      methods: 'id, name, auxiliary, fireLevel',
      batches: 'id, batchNo, herbId, methodId, degree, startedAt',
      samples: 'id, sampleNo, batchId, cabinet, retainedAt',
      meta: 'key',
    });

    // v2：批次表增加 locked 索引（锁定/质检放行查询更快），并回填历史数据的 locked 字段。
    // 升级前请在「导出备份」中导出 JSON。
    this.version(2)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('batches')
          .toCollection()
          .modify((row: ProcessBatch) => {
            if (typeof row.locked !== 'boolean') {
              row.locked = false;
            }
          });
      });

    // v3：投料谱系表 feeds。工序批次不再只挂单一来源，同规格药材拆批、拼批、
    // 一批给两个班组、与另一批合并炮制都逐笔记录来源/投入量/剩余量。
    // 旧单来源批次升级时补建单节点谱系，升级后页面与备份恢复都能看到完整来源。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        feeds: 'id, batchId, sourceId, sourceType, status, createdAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await ensureSingleNodeLineage(tx);
      });
  }
}

export const db = new HerbProcessDB();

/** 谱系补建所需的最小事务面（v3 升级事务、普通事务都满足） */
interface LineageTx {
  table(name: string): {
    toCollection(): { toArray(): Promise<unknown[]> };
    bulkPut(rows: readonly unknown[]): Promise<unknown>;
  };
}

/**
 * 为缺少投料谱系的工序批次补建单节点谱系（v3 升级、旧备份恢复共用）。
 * 补建后按入账顺序统一重算每笔的剩余量快照。
 */
export async function ensureSingleNodeLineage(tx: LineageTx): Promise<FeedLink[]> {
  const [herbs, batches, links] = await Promise.all([
    tx.table('herbs').toCollection().toArray() as Promise<HerbMaterial[]>,
    tx.table('batches').toCollection().toArray() as Promise<ProcessBatch[]>,
    tx.table('feeds').toCollection().toArray() as Promise<FeedLink[]>,
  ]);
  const covered = new Set(links.map((l) => l.batchId));
  const additions: FeedLink[] = batches
    .filter((b) => !covered.has(b.id))
    .map((b) => {
      const herb = herbs.find((h) => h.id === b.herbId);
      return buildSingleNodeLink(b, { name: herb?.name ?? '未知药材', batchNo: herb?.batchNo ?? b.batchNo });
    });
  if (additions.length) {
    await tx.table('feeds').bulkPut(additions);
  }
  const all = [...links, ...additions];
  recalcRemain(all, herbs, batches);
  await tx.table('feeds').bulkPut(all);
  return all;
}

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
