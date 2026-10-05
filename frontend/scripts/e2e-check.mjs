import 'fake-indexeddb/auto';
import { db } from '../src/utils/db.ts';
import { seedIfEmpty } from '../src/utils/seed.ts';
import { exportBackupJson, importBackup } from '../src/utils/export.ts';
import { useBatchStore, BatchLockedError } from '../src/stores/batchStore.ts';
import { useFeedStore } from '../src/stores/feedStore.ts';
import { useHerbStore } from '../src/stores/herbStore.ts';
import { useSampleStore } from '../src/stores/sampleStore.ts';

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  pass++;
};

const hydrateAll = () =>
  Promise.all([
    useHerbStore.getState().hydrate(),
    useBatchStore.getState().hydrate(),
    useFeedStore.getState().hydrate(),
    useSampleStore.getState().hydrate(),
  ]);

await seedIfEmpty();
await hydrateAll();

// 1. 种子：拆批、拼批、撤回待重试、合并炮制都存在
{
  const links = useFeedStore.getState().links;
  const byBatch = (id) => links.filter((l) => l.batchId === id);
  ok('白术 BT-2401 拆成两笔（70 + 50）', byBatch('batch-001')[0].feedKg === 70 && byBatch('batch-011')[0].feedKg === 50);
  ok('白芍拼批两笔来源', byBatch('batch-002').filter((l) => l.status === 'active').length === 2);
  ok('存在工序成品来源（合并炮制）', byBatch('batch-013').some((l) => l.sourceType === 'batch'));
  const b12 = byBatch('batch-012');
  ok('撤回示例：一笔撤回一笔在投', b12.some((l) => l.status === 'withdrawn') && b12.some((l) => l.status === 'active'));
  const batch12 = useBatchStore.getState().batches.find((b) => b.id === 'batch-012');
  ok('撤回后工序在投合计只剩另一笔（30kg）', batch12.feedKg === 30 && batch12.locked === false);
}

// 2. 余量：BT-2401 120 被 70+50 用完；BS-2402 120 被 80+40 占用（batch-012 的 40 已撤回）
{
  ok('BT-2401 余量 0', useFeedStore.getState().usedKgOf('herb', 'herb-001') === 120);
  ok('BS-2402 在投占用 80（撤回笔次不占）', useFeedStore.getState().usedKgOf('herb', 'herb-002') === 80);
}

// 3. 超配创建 → 抛错，库内无新增，原分配不变
const beforeCount = useBatchStore.getState().batches.length;
const beforeLinks = useFeedStore.getState().links.length;
{
  let threw = null;
  try {
    await useBatchStore.getState().createBatch(
      {
        batchNo: 'PZ-TEST-OVER',
        methodId: 'method-001',
        sources: [{ sourceType: 'herb', sourceId: 'herb-001', feedKg: 10 }], // BT-2401 已用完
        auxUsedKg: 0,
        fireLevel: '文火',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        yieldRate: 94,
        degree: '适中',
        operator: '测试员',
      },
      false,
    );
  } catch (e) {
    threw = e;
  }
  ok('超配创建抛错', threw !== null);
  ok('超配后工序数未增加', useBatchStore.getState().batches.length === beforeCount);
  ok('超配后谱系笔数未增加（事务回滚）', useFeedStore.getState().links.length === beforeLinks);
}

// 4. 合法拼批创建：用 BS-2402 余 40 + BS-2412 余 30
let newBatch;
{
  newBatch = await useBatchStore.getState().createBatch(
    {
      batchNo: 'PZ-TEST-MERGE',
      methodId: 'method-003',
      sources: [
        { sourceType: 'herb', sourceId: 'herb-002', feedKg: 40 },
        { sourceType: 'herb', sourceId: 'herb-012', feedKg: 20 },
      ],
      auxUsedKg: 7,
      fireLevel: '文火',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      yieldRate: 93,
      degree: '适中',
      operator: '测试员',
    },
    false,
  );
  const batchLinks = useFeedStore.getState().linksOfBatch(newBatch.id);
  ok('拼批两笔逐笔记录', batchLinks.length === 2 && Math.abs(newBatch.feedKg - 60) < 0.001);
  ok('两批余量均为 0', batchLinks.every((l) => l.remainKg === 0));
}

// 5. 撤回其中一笔：只影响这一笔，工序未锁定可重试
{
  const target = useFeedStore.getState().linksOfBatch(newBatch.id).find((l) => l.sourceId === 'herb-012');
  await useBatchStore.getState().withdrawFeed(target.id, '测试撤回');
  const after = useBatchStore.getState().batches.find((b) => b.id === newBatch.id);
  ok('撤回一笔后工序在投量 40', Math.abs(after.feedKg - 40) < 0.001 && after.locked === false);
  ok('撤回笔次保留且标记 withdrawn', useFeedStore.getState().linksOfBatch(newBatch.id).some((l) => l.id === target.id && l.status === 'withdrawn'));
  ok('BS-2412 撤回后占用回到 70（batch-002 40 + batch-012 在投 30，本笔 20 已退回）', useFeedStore.getState().usedKgOf('herb', 'herb-012') === 70);
  ok('另一笔仍在投', useFeedStore.getState().activeLinksOfBatch(newBatch.id).length === 1);
}

// 6. 编辑未锁定批次但来源不变：不应产生撤回记录
{
  const beforeWithdrawn = useFeedStore.getState().linksOfBatch(newBatch.id).filter((l) => l.status === 'withdrawn').length;
  await useBatchStore.getState().updateBatch(newBatch.id, {
    sources: [{ sourceType: 'herb', sourceId: 'herb-002', feedKg: 40 }],
    yieldRate: 92,
  });
  const afterLinks = useFeedStore.getState().linksOfBatch(newBatch.id);
  ok('来源不变时不新增撤回笔次', afterLinks.filter((l) => l.status === 'withdrawn').length === beforeWithdrawn);
}

// 6b. 重配超配失败：事务回滚，原分配保留
{
  const kept = useFeedStore.getState().linksOfBatch(newBatch.id).map((l) => l.id);
  let threw = null;
  try {
    await useBatchStore.getState().updateBatch(newBatch.id, {
      sources: [{ sourceType: 'herb', sourceId: 'herb-001', feedKg: 120 }], // BT-2401 已被占完
    });
  } catch (e) {
    threw = e;
  }
  ok('重配超配抛错', threw !== null);
  const after = useFeedStore.getState().linksOfBatch(newBatch.id).map((l) => l.id);
  ok('失败后原分配笔次原样保留（供重试）', kept.every((id) => after.includes(id)) && after.length === kept.length);
}

// 7. 锁定工序不能撤回、不能删、不能改来源
{
  const lockedLinks = useFeedStore.getState().activeLinksOfBatch('batch-001');
  let threw = null;
  try {
    await useBatchStore.getState().withdrawFeed(lockedLinks[0].id);
  } catch (e) {
    threw = e;
  }
  ok('锁定工序撤回被拒', threw instanceof BatchLockedError);

  let threw2 = null;
  try {
    await useBatchStore.getState().removeBatch('batch-001');
  } catch (e) {
    threw2 = e;
  }
  ok('锁定工序删除被拒', threw2 instanceof BatchLockedError);
}

// 7. 有留样的批次：留样不能删（batch-001..006 有留样）
{
  const sample = useSampleStore.getState().samples.find((s) => s.batchId === 'batch-001');
  let threw = null;
  try {
    await useSampleStore.getState().removeSample(sample.id);
  } catch (e) {
    threw = e;
  }
  ok('锁定批次的留样不能删除', threw instanceof Error);
}

// 8. 无留样未锁定批次可删，投料退回
{
  // batch-010 全蝎 12kg 未锁定无留样
  await useBatchStore.getState().removeBatch('batch-010');
  ok('删除后全蝎余量恢复 12', useFeedStore.getState().usedKgOf('herb', 'herb-007') === 0);
}

// 9. 导出备份含 feeds，恢复后谱系完整
{
  const json = await exportBackupJson();
  const payload = JSON.parse(json);
  ok('导出包含 feeds 数组', Array.isArray(payload.feeds) && payload.feeds.length > 0);
  const counts = await importBackup(json);
  ok('恢复 feeds 笔数 > 0', counts.feeds > 0);
  await hydrateAll();
  ok('恢复后仍可查到拼批来源', useFeedStore.getState().linksOfBatch('batch-002').length === 2);
}

// 10. 旧版备份（无 feeds）恢复后自动补单节点谱系
{
  const oldBackup = {
    app: 'gbherbprocess',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    herbs: [{ id: 'hx', name: '测试药材', origin: '植物', part: '根', batchNo: 'HX-1', feedKg: 100, receivedAt: new Date().toISOString() }],
    methods: [
      { id: 'mx', name: '清炒', auxiliary: '无', auxRatio: 0, fireLevel: '文火', tempRange: [90, 120], duration: 12, criterion: 'x', criterionDimension: '色泽', applicable: '' },
    ],
    batches: [
      {
        id: 'bx', batchNo: 'OLD-1', herbId: 'hx', methodId: 'mx', feedKg: 60, auxUsedKg: 0, fireLevel: '文火',
        startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), yieldRate: 94, degree: '适中', operator: 'x', locked: false,
      },
    ],
    samples: [],
  };
  const counts = await importBackup(JSON.stringify(oldBackup));
  await hydrateAll();
  const links = useFeedStore.getState().linksOfBatch('bx');
  ok('旧备份恢复后补建单节点谱系', links.length === 1 && links[0].sourceId === 'hx' && links[0].feedKg === 60);
  ok('补建节点余量为 40（100-60）', links[0].remainKg === 40);
  ok('恢复计数含补建笔次', counts.feeds === 1);
}

console.log(`\n${pass} 项端到端流程校验全部通过`);
await db.delete();
process.exit(0);
