import { assertAllocation, recalcRemain, initialKgOf, buildSingleNodeLink } from '../src/utils/feedLineage.ts';
import { AllocationError } from '../src/types/feed.ts';

let pass = 0;
const ok = (name, cond) => {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  pass++;
};

const herbs = [
  { id: 'h1', feedKg: 120 }, // 白术 BT-2401
  { id: 'h2', feedKg: 80 }, // 白芍 BS-2402
];
const batches = [
  { id: 'b1', feedKg: 50, yieldRate: 94 }, // 清炒半成品产出 47kg
];
const now = '2025-09-01T00:00:00.000Z';
const link = (id, batchId, type, sourceId, kg, seq, extra = {}) => ({
  id, batchId, sourceType: type, sourceId, sourceName: type === 'herb' ? '药材' : '成品', sourceBatchNo: id,
  feedKg: kg, remainKg: 0, seq, status: 'active', createdAt: now, ...extra,
});

// 1. 初始可用量
ok('药材初始量 = 入库量', initialKgOf('herb', 'h1', herbs, batches) === 120);
ok('工序成品初始量 = 投料 × 得率', initialKgOf('batch', 'b1', herbs, batches) === 47);

// 2. 一批拆给两个班组 + 拼批
{
  const links = [
    link('l1', 'bA', 'herb', 'h1', 70, 1),
    link('l2', 'bB', 'herb', 'h1', 50, 1, { createdAt: '2025-09-01T01:00:00.000Z' }),
    link('l3', 'bC', 'herb', 'h2', 80, 1, { createdAt: '2025-09-01T02:00:00.000Z' }),
  ];
  const remain = recalcRemain(links, herbs, batches);
  ok('拆批后 h1 余量为 0', remain.get('herb:h1') === 0);
  ok('h2 余量为 0', remain.get('herb:h2') === 0);
  ok('每笔记录逐笔剩余量', links[0].remainKg === 50 && links[1].remainKg === 0);
}

// 3. 超配必须抛 AllocationError
{
  let threw = null;
  try {
    assertAllocation([{ sourceType: 'herb', sourceId: 'h1', feedKg: 130 }], { herbs, batches });
  } catch (e) {
    threw = e;
  }
  ok('余量不足抛 AllocationError', threw instanceof AllocationError);
}

// 4. 与另一批成品合并炮制：产出只有 47，投 48 应失败
{
  let threw = null;
  try {
    assertAllocation([{ sourceType: 'batch', sourceId: 'b1', feedKg: 48 }], { herbs, batches });
  } catch (e) {
    threw = e;
  }
  ok('成品超配抛错', threw instanceof AllocationError);
}

// 5. 拼批失败不影响原分配（事务模拟：先有 bA 在投 70，新分配 60 会超 120）
{
  const existing = [link('l1', 'bA', 'herb', 'h1', 70, 1)];
  let threw = null;
  try {
    assertAllocation([{ sourceType: 'herb', sourceId: 'h1', feedKg: 60 }], { existing, herbs, batches });
  } catch (e) {
    threw = e;
  }
  ok('含既有占用时超配抛错（失败后保留原分配）', threw instanceof AllocationError);
  ok('原分配数据未被修改', existing[0].feedKg === 70 && existing[0].remainKg === 0);
}

// 6. 撤回某一笔只影响这一笔，余量恢复
{
  const links = [
    link('l1', 'bC', 'herb', 'h2', 40, 1),
    link('l2', 'bC', 'herb', 'h2', 40, 2, { createdAt: '2025-09-01T01:00:00.000Z' }),
  ];
  recalcRemain(links, herbs, batches);
  // 撤回第一笔
  links[0] = { ...links[0], status: 'withdrawn', withdrawnAt: '2025-09-01T03:00:00.000Z' };
  const remain = recalcRemain(links, herbs, batches);
  ok('撤回一笔后来源余量恢复 40', remain.get('herb:h2') === 40);
  ok('另一笔仍在投', links[1].status === 'active' && links[1].feedKg === 40);
  ok('撤回笔次记录撤回时点余量', links[0].remainKg === 40);
}

// 7. 编辑重配：exclude 当前工序自身笔次后，新清单按全量重新校验
{
  const existing = [
    link('l1', 'bD', 'herb', 'h1', 70, 1),
    link('l2', 'bE', 'herb', 'h1', 30, 1, { createdAt: '2025-09-01T02:00:00.000Z' }),
  ];
  let threw = null;
  try {
    // bD 自己重配为 90，但 bE 已占 30 → 90+30=120 刚好；再测 91
    assertAllocation([{ sourceType: 'herb', sourceId: 'h1', feedKg: 91 }], {
      existing,
      excludeLinkIds: new Set(['l1']),
      herbs, batches,
    });
  } catch (e) {
    threw = e;
  }
  ok('重配超配抛错', threw instanceof AllocationError);
  assertAllocation([{ sourceType: 'herb', sourceId: 'h1', feedKg: 90 }], { existing, excludeLinkIds: new Set(['l1']), herbs, batches });
  ok('重配合法量通过（90 + 它工序 30 = 120）', true);
}

// 8. 旧单来源记录补成单节点谱系
{
  const batch = { id: 'bold', herbId: 'h1', feedKg: 100, yieldRate: 94 };
  const node = buildSingleNodeLink(batch, { name: '白术', batchNo: 'BT-OLD' });
  ok('单节点指向旧药材', node.sourceType === 'herb' && node.sourceId === 'h1' && node.feedKg === 100);
  const remain = recalcRemain([node], [...herbs, { id: 'hold', feedKg: 100 }].filter((h) => h.id === 'h1' || h.id === 'hold'), [{ id: 'bold', feedKg: 100, yieldRate: 94 }]);
  // h1 库存 120，投 100 → 余 20
  ok('补建节点参与重算', remain.get('herb:h1') === 20);
}

// 9. 非正投入量抛错
{
  let threw = null;
  try {
    assertAllocation([{ sourceType: 'herb', sourceId: 'h1', feedKg: 0 }], { herbs, batches });
  } catch (e) {
    threw = e;
  }
  ok('投入量为 0 抛错', threw instanceof AllocationError);
}

console.log(`\n${pass} 项核心账本校验全部通过`);
