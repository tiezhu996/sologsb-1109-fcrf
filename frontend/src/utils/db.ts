import Dexie, { type Table } from 'dexie';
import type { HerbMaterial } from '../types/herb-material';
import type { ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { RetainSample } from '../types/retain-sample';
import type { FeedEntry } from '../types/feed-entry';
import { uid } from './id';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbherbprocess-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class HerbProcessDB extends Dexie {
  herbs!: Table<HerbMaterial, string>;
  methods!: Table<ProcessingMethod, string>;
  batches!: Table<ProcessBatch, string>;
  samples!: Table<RetainSample, string>;
  /** 逐笔投料关系：来源 × 工序 × 投入量/剩余量，支持拆批、拼批与来源谱系追溯 */
  feeds!: Table<FeedEntry, string>;
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

    // v3：新增 feeds 投料关系表。旧工序只有单个来源（batch.herbId + feedKg），
    // 升级时逐批补一条 herb 来源、投入量=feedKg 的记录，形成单节点谱系，
    // 使留样与导出都能查回投入来源。
    this.version(3)
      .stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        feeds: 'id, batchId, sourceType, sourceId, active, createdAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        const batches = await tx.table<ProcessBatch, string>('batches').toArray();
        const herbs = await tx.table<HerbMaterial, string>('herbs').toArray();
        const feedRows: FeedEntry[] = [];
        batches.forEach((batch) => {
          if (!batch.herbId) return;
          const herb = herbs.find((h) => h.id === batch.herbId);
          feedRows.push({
            id: uid('feed'),
            batchId: batch.id,
            sourceType: 'herb',
            sourceId: batch.herbId,
            amountKg: Number(batch.feedKg) || 0,
            remainAfterKg: herb ? Math.max(0, Number(herb.feedKg) - Number(batch.feedKg)) : 0,
            active: true,
            createdAt: batch.startedAt ?? new Date(0).toISOString(),
            remark: '历史单来源记录升级补录',
          });
        });
        if (feedRows.length > 0) {
          await tx.table('feeds').bulkPut(feedRows);
        }
      });
  }
}

export const db = new HerbProcessDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
