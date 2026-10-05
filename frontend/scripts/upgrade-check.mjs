import 'fake-indexeddb/auto';
import Dexie from 'dexie';

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  pass++;
};

// 1. 用 v2 schema 在应用库名下建库并写入旧单来源批次（必须在 import db 之前完成）
const DB_NAME = 'gbherbprocess-db';

{
  const existing = new Dexie(DB_NAME);
  await existing.delete();
  existing.close();

  const old = new Dexie(DB_NAME);
  old.version(1).stores({
    herbs: 'id, name, origin, part, batchNo, receivedAt',
    methods: 'id, name, auxiliary, fireLevel',
    batches: 'id, batchNo, herbId, methodId, degree, startedAt',
    samples: 'id, sampleNo, batchId, cabinet, retainedAt',
    meta: 'key',
  });
  old.version(2).stores({
    herbs: 'id, name, origin, part, batchNo, receivedAt',
    methods: 'id, name, auxiliary, fireLevel',
    batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
    samples: 'id, sampleNo, batchId, cabinet, retainedAt',
    meta: 'key',
  });
  await old.herbs.put({ id: 'h1', name: '旧药材', origin: '植物', part: '根', batchNo: 'OLD-01', feedKg: 100, receivedAt: '2025-01-01T00:00:00.000Z' });
  await old.batches.put({
    id: 'b1', batchNo: 'PZ-OLD-1', herbId: 'h1', methodId: 'm1', feedKg: 60, auxUsedKg: 0, fireLevel: '文火',
    startedAt: '2025-01-02T00:00:00.000Z', endedAt: '2025-01-02T00:10:00.000Z', yieldRate: 94, degree: '适中', operator: '旧员',
  });
  await old.close();
}

// 2. 用当前应用代码（v3）打开同一库，触发升级
const { db, SCHEMA_VERSION } = await import('../src/utils/db.ts');
ok('当前 schema 版本为 3', SCHEMA_VERSION === 3);
ok('升级后 feeds 表存在', db.tables.some((t) => t.name === 'feeds'));

const links = await db.feeds.toArray();
ok('旧批次自动补建单节点谱系', links.length === 1);
ok('单节点来源为旧药材、投入量 60', links[0].sourceId === 'h1' && links[0].feedKg === 60);
ok('单节点状态为在投', links[0].status === 'active');
ok('升级时重算剩余量为 40', links[0].remainKg === 40);

const herbs = await db.herbs.toArray();
ok('旧数据未丢失', herbs.length === 1 && herbs[0].name === '旧药材');
const batches = await db.batches.toArray();
ok('旧批次数据未丢失', batches.length === 1 && batches[0].batchNo === 'PZ-OLD-1');

await db.delete();
console.log(`\n${pass} 项 v2→v3 升级校验全部通过`);
process.exit(0);
