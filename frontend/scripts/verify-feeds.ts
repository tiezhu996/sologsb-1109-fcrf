/* eslint-disable no-console */
// 端到端验证（node + fake-indexeddb，非生产代码）：
// 逐笔投料、余额超额回滚、单笔撤回、锁定/留样保护、谱系、v2→v3 升级、备份恢复。
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, DB_NAME } from '../src/utils/db';
import { useBatchStore } from '../src/stores/batchStore';
import { useHerbStore } from '../src/stores/herbStore';
import { useSampleStore } from '../src/stores/sampleStore';
import { buildBackup, exportBackupJson, importBackup } from '../src/utils/export';
import { activeFeedTotal, buildLineage, herbRemaining, lineageLeafAmounts, lineageOf } from '../src/utils/lineage';
import type { ProcessingMethod } from '../src/types/processing-method';
import type { FeedEntry } from '../src/types/feed-entry';

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

async function resetDb() {
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.feeds, db.meta], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.samples.clear(), db.feeds.clear(), db.meta.clear()]);
  });
  await Promise.all([
    useHerbStore.getState().hydrate(),
    useBatchStore.getState().hydrate(),
    useSampleStore.getState().hydrate(),
  ]);
}

const METHOD: ProcessingMethod = {
  id: 'method-x',
  name: '清炒',
  auxiliary: '无',
  auxRatio: 0,
  fireLevel: '文火',
  tempRange: [90, 120],
  duration: 12,
  criterion: 'x',
  criterionDimension: '色泽',
  applicable: '通用',
};

async function seedFixture() {
  const herbStore = useHerbStore.getState();
  const herbA = await herbStore.addHerb({ name: '白术', origin: '植物', part: '根', batchNo: 'A-1', feedKg: 100, receivedAt: '2025-09-01T00:00:00.000Z' });
  const herbB = await herbStore.addHerb({ name: '白芍', origin: '植物', part: '根', batchNo: 'B-1', feedKg: 50, receivedAt: '2025-09-02T00:00:00.000Z' });
  const herbC = await herbStore.addHerb({ name: '陈皮', origin: '植物', part: '果实', batchNo: 'C-1', feedKg: 40, receivedAt: '2025-09-03T00:00:00.000Z' });
  await db.methods.put(METHOD);
  return { herbA, herbB, herbC };
}

const baseBatch = (patch: Record<string, unknown>) => ({
  batchNo: `PZ-T-${Math.random().toString(36).slice(2, 7)}`,
  methodId: METHOD.id,
  auxUsedKg: 0,
  fireLevel: '文火' as const,
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  yieldRate: 90,
  degree: '适中' as const,
  operator: '测试员',
  ...patch,
});

async function scenarioCrudRollbackWithdraw() {
  console.log('\n[1] 拆批/拼批登记、超额回滚、单笔撤回、锁定保护');
  await resetDb();
  const { herbA, herbB } = await seedFixture();
  const batchStore = useBatchStore.getState();

  // 拼批：A 60 + B 30 = 90，未锁定
  const b1 = await batchStore.createBatch(
    baseBatch({
      herbId: herbA.id,
      feedKg: 90,
      sources: [
        { sourceType: 'herb' as const, sourceId: herbA.id, amountKg: 60, remark: '一班' },
        { sourceType: 'herb' as const, sourceId: herbB.id, amountKg: 30, remark: '二班' },
      ],
    }),
    false,
  );
  assert(activeFeedTotal(useBatchStore.getState().feeds, b1.id) === 90, '拼批两笔来源合计 90kg');
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbA.id) === 40, 'A 剩余 40kg（100-60）');
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbB.id) === 20, 'B 剩余 20kg（50-30）');

  // 拆批：A 剩余 40 再投一批
  const b2 = await batchStore.createBatch(baseBatch({ herbId: herbA.id, feedKg: 40, sources: [{ sourceType: 'herb' as const, sourceId: herbA.id, amountKg: 40 }] }), false);
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbA.id) === 0, 'A 拆批后剩余 0kg');

  const batchesBefore = useBatchStore.getState().batches.length;
  // 超额：B 只剩 20，投 25 必须失败并整体回滚
  let threw = false;
  try {
    await batchStore.createBatch(baseBatch({ herbId: herbB.id, feedKg: 25, sources: [{ sourceType: 'herb' as const, sourceId: herbB.id, amountKg: 25 }] }), false);
  } catch (e) {
    threw = true;
    console.log(`     （预期拒绝：${(e as Error).message}）`);
  }
  assert(threw, '超额拼批/拆批被拒绝');
  assert(useBatchStore.getState().batches.length === batchesBefore, '失败后工序未新增（事务回滚，恢复原分配）');
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbB.id) === 20, '失败后 B 剩余量恢复为 20kg');

  // 单笔撤回：撤回 b1 的 B 30，只影响这一笔
  const bFeed = useBatchStore.getState().feeds.find((f) => f.batchId === b1.id && f.sourceId === herbB.id)!;
  await batchStore.withdrawFeed(bFeed.id);
  const b1After = useBatchStore.getState().batches.find((x) => x.id === b1.id)!;
  assert(b1After.feedKg === 60, '撤回一笔后工序投料量变为 60kg（工序保留）');
  assert(activeFeedTotal(useBatchStore.getState().feeds, b1.id) === 60, '该工序仍保留 A 的 60kg 一笔');
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbB.id) === 50, '撤回后 B 剩余量恢复为 50kg');
  const withdrawnRow = await db.feeds.get(bFeed.id);
  assert(withdrawnRow?.active === false && Boolean(withdrawnRow.withdrawnAt), '撤回记录保留 active=false 痕迹');

  // 未完成工序可重新分配后重试（把 B 的 10kg 重新补进 b1）
  await batchStore.updateBatch(b1.id, {
    sources: [
      { sourceType: 'herb' as const, sourceId: herbA.id, amountKg: 60 },
      { sourceType: 'herb' as const, sourceId: herbB.id, amountKg: 10 },
    ],
  });
  assert(activeFeedTotal(useBatchStore.getState().feeds, b1.id) === 70, '重新分配后工序合计 70kg（可重试）');

  // 来源合计由 store 回写 feedKg，一致即可锁定
  await batchStore.lockBatch(b1.id);
  assert(useBatchStore.getState().batches.find((x) => x.id === b1.id)?.locked === true, '投料齐全且一致：工序锁定成功');

  let blocked = false;
  try {
    await batchStore.withdrawFeed(useBatchStore.getState().feeds.find((f) => f.batchId === b1.id && f.active)!.id);
  } catch (e) {
    blocked = true;
    console.log(`     （预期拒绝：${(e as Error).message}）`);
  }
  assert(blocked, '已锁定工序的来源不能撤回');

  blocked = false;
  try {
    await batchStore.removeBatch(b1.id);
  } catch (e) {
    blocked = true;
    console.log(`     （预期拒绝：${(e as Error).message}）`);
  }
  assert(blocked, '已锁定工序不能删除');

  // 删除未锁定工序 b2：来源 A 恢复
  await batchStore.removeBatch(b2.id);
  assert(!useBatchStore.getState().batches.some((x) => x.id === b2.id), '未锁定工序已删除');
  // b1 仍占 A 60，所以 A 剩 40
  assert(herbRemaining(useHerbStore.getState().herbs, useBatchStore.getState().feeds, herbA.id) === 40, '删除 b2 后其 40kg 占用恢复（A 剩 40kg）');
}

async function scenarioSampleProtectionAndLineage() {
  console.log('\n[2] 留样保护、多层谱系（上游工序产出再投料）');
  await resetDb();
  const { herbA, herbC } = await seedFixture();
  const batchStore = useBatchStore.getState();
  const sampleStore = useSampleStore.getState();

  // b1: A 50kg，产出 45kg
  const b1 = await batchStore.createBatch(baseBatch({ herbId: herbA.id, feedKg: 50, sources: [{ sourceType: 'herb' as const, sourceId: herbA.id, amountKg: 50 }] }), true);
  // b2: 上游工序产出 30 + 药材 C 20 = 50（合并炮制）
  const b2 = await batchStore.createBatch(
    baseBatch({
      herbId: herbA.id,
      feedKg: 50,
      sources: [
        { sourceType: 'batch' as const, sourceId: b1.id, amountKg: 30 },
        { sourceType: 'herb' as const, sourceId: herbC.id, amountKg: 20 },
      ],
    }),
    true,
  );

  const tree = buildLineage({ herbs: useHerbStore.getState().herbs, batches: useBatchStore.getState().batches, feeds: useBatchStore.getState().feeds }, b2.id);
  assert(tree.length === 2, 'b2 有 2 个直接来源节点（工序 + 药材）');
  const batchNode = tree.find((n) => n.sourceType === 'batch');
  assert(Boolean(batchNode && batchNode.parents.length === 1 && batchNode.parents[0].sourceId === herbA.id), '上游工序节点继续展开到药材 A（谱系递归）');
  const leaves = lineageLeafAmounts(tree);
  assert(leaves.get(herbA.id)?.amountKg === 30, '叶节点 A 累计 30kg');
  assert(leaves.get(herbC.id)?.amountKg === 20, '叶节点 C 累计 20kg');

  // 留样挂在已锁定 b1 上：留样不能删
  const sample = await sampleStore.createSample({ sampleNo: 'LY-T-1', batchId: b1.id, amountG: 300, retainMonths: 12, cabinet: 'A-01' });
  let blocked = false;
  try {
    await sampleStore.removeSample(sample.id);
  } catch (e) {
    blocked = true;
    console.log(`     （预期拒绝：${(e as Error).message}）`);
  }
  assert(blocked, '已锁定工序的留样不能删除');
  assert((await db.samples.count()) === 1, '留样仍然存在');

  // 留样可通过谱系查回投入（即便经过多道工序）
  const lineageFromSample = lineageOf({ herbs: useHerbStore.getState().herbs, batches: useBatchStore.getState().batches, feeds: useBatchStore.getState().feeds }, b2);
  assert(lineageFromSample.length === 2, '留样关联批次可查回完整来源谱系');
}

async function scenarioLegacyUpgrade() {
  console.log('\n[3] 旧 v2 单来源数据升级为单节点谱系');
  // 关闭并删除真实库，用只声明 v1/v2 的旧结构库造数据
  await db.close();
  await new Dexie(DB_NAME).delete();

  class OldDB extends Dexie {
    herbs!: Dexie.Table<unknown, string>;
    batches!: Dexie.Table<unknown, string>;
    constructor() {
      super(DB_NAME);
      this.version(1).stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      });
      this.version(2).stores({
        herbs: 'id, name, origin, part, batchNo, receivedAt',
        methods: 'id, name, auxiliary, fireLevel',
        batches: 'id, batchNo, herbId, methodId, degree, startedAt, locked',
        samples: 'id, sampleNo, batchId, cabinet, retainedAt',
        meta: 'key',
      });
    }
  }
  const oldDb = new OldDB();
  await oldDb.herbs.put({ id: 'herb-old', name: '旧白术', origin: '植物', part: '根', batchNo: 'OLD-1', feedKg: 120, receivedAt: '2025-07-01T00:00:00.000Z' });
  await oldDb.batches.put({
    id: 'batch-old',
    batchNo: 'PZ-OLD-1',
    herbId: 'herb-old',
    methodId: 'method-x',
    feedKg: 70,
    auxUsedKg: 0,
    fireLevel: '文火',
    startedAt: '2025-07-02T00:00:00.000Z',
    endedAt: '2025-07-02T00:30:00.000Z',
    yieldRate: 92,
    degree: '适中',
    operator: '老记录',
    locked: true,
  });
  await oldDb.close();

  // 重新打开真实 v3 库，触发升级
  await db.open();
  const feeds = (await db.feeds.toArray()) as FeedEntry[];
  assert(feeds.length === 1, '升级后为旧工序补了 1 笔投料记录');
  assert(feeds[0].sourceType === 'herb' && feeds[0].sourceId === 'herb-old' && feeds[0].amountKg === 70, '补录记录来源=旧 herbId、投入量=feedKg');
  assert(feeds[0].remainAfterKg === 50 && feeds[0].active === true, '剩余量 50kg（120-70）且有效');

  await Promise.all([useHerbStore.getState().hydrate(), useBatchStore.getState().hydrate()]);
  const batch = useBatchStore.getState().batches.find((b) => b.id === 'batch-old')!;
  const tree = lineageOf({ herbs: useHerbStore.getState().herbs, batches: useBatchStore.getState().batches, feeds: useBatchStore.getState().feeds }, batch);
  assert(tree.length === 1 && tree[0].label.includes('旧白术') && tree[0].amountKg === 70, '旧单来源在页面上呈现为单节点谱系');
}

async function scenarioBackupRoundtrip() {
  console.log('\n[4] 备份导出/恢复后谱系完整');
  // 接在升级后的库上做恢复测试：先造一个含拼批的新库
  await resetDb();
  const { herbA, herbB } = await seedFixture();
  const batchStore = useBatchStore.getState();
  const b = await batchStore.createBatch(
    baseBatch({
      herbId: herbA.id,
      feedKg: 80,
      sources: [
        { sourceType: 'herb' as const, sourceId: herbA.id, amountKg: 55 },
        { sourceType: 'herb' as const, sourceId: herbB.id, amountKg: 25 },
      ],
    }),
    true,
  );

  const backup = await buildBackup();
  assert(Array.isArray(backup.feeds) && backup.feeds.length === 2, '导出备份包含 feeds 表 2 笔记录');
  const json = await exportBackupJson();
  assert(JSON.parse(json).schemaVersion === 3, '备份标记 schemaVersion=3');

  // 清空后恢复
  await importBackup(json);
  await Promise.all([useHerbStore.getState().hydrate(), useBatchStore.getState().hydrate()]);
  const restoredBatch = useBatchStore.getState().batches.find((x) => x.id === b.id);
  assert(Boolean(restoredBatch), '恢复后工序还在');
  const tree = lineageOf({ herbs: useHerbStore.getState().herbs, batches: useBatchStore.getState().batches, feeds: useBatchStore.getState().feeds }, restoredBatch!);
  assert(tree.length === 2 && lineageLeafAmounts(tree).size === 2, '恢复后仍可查回两笔来源的完整谱系');
}

async function main() {
  try {
    await scenarioCrudRollbackWithdraw();
    await scenarioSampleProtectionAndLineage();
    await scenarioLegacyUpgrade();
    await scenarioBackupRoundtrip();
  } finally {
    await db.close();
  }
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main();
