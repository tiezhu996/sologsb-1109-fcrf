import { db } from './db';
import { HERB_ORIGINS, type HerbMaterial } from '../types/herb-material';
import { METHOD_NAMES, type ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { FeedLink, FeedSourceType } from '../types/feed';
import { recalcRemain } from './feedLineage';
import { CABINETS, type RetainSample } from '../types/retain-sample';
import { judgeDegree, expectedYieldOf } from './degree';

/** 首次打开时写入的示例台账，便于直接查看各页面效果 */
export const SEED_HERBS: HerbMaterial[] = [
  { id: 'herb-001', name: '白术', origin: '植物', part: '根', batchNo: 'BT-2401', feedKg: 120, receivedAt: '2025-08-02T09:00:00.000Z', remark: '浙江磐安产' },
  { id: 'herb-002', name: '白芍', origin: '植物', part: '根', batchNo: 'BS-2402', feedKg: 120, receivedAt: '2025-08-05T09:00:00.000Z' },
  { id: 'herb-003', name: '当归', origin: '植物', part: '根', batchNo: 'DG-2403', feedKg: 60, receivedAt: '2025-08-06T09:00:00.000Z', remark: '甘肃岷县产' },
  { id: 'herb-004', name: '陈皮', origin: '植物', part: '果实', batchNo: 'CP-2404', feedKg: 45, receivedAt: '2025-08-08T09:00:00.000Z' },
  { id: 'herb-005', name: '黄芪', origin: '植物', part: '根', batchNo: 'HQ-2405', feedKg: 200, receivedAt: '2025-08-11T09:00:00.000Z' },
  { id: 'herb-006', name: '牡蛎', origin: '矿物', part: '果实', batchNo: 'ML-2406', feedKg: 150, receivedAt: '2025-08-12T09:00:00.000Z', remark: '煅用' },
  { id: 'herb-007', name: '全蝎', origin: '动物', part: '茎', batchNo: 'QX-2407', feedKg: 12, receivedAt: '2025-08-14T09:00:00.000Z' },
  { id: 'herb-008', name: '杜仲', origin: '植物', part: '茎', batchNo: 'DZ-2408', feedKg: 90, receivedAt: '2025-08-15T09:00:00.000Z', remark: '盐炙用' },
  { id: 'herb-009', name: '桑叶', origin: '植物', part: '叶', batchNo: 'SY-2409', feedKg: 55, receivedAt: '2025-08-18T09:00:00.000Z' },
  { id: 'herb-010', name: '甘草', origin: '植物', part: '根', batchNo: 'GC-2410', feedKg: 130, receivedAt: '2025-08-20T09:00:00.000Z' },
  { id: 'herb-011', name: '白术', origin: '植物', part: '根', batchNo: 'BT-2411', feedKg: 50, receivedAt: '2025-08-21T09:00:00.000Z', remark: '浙江磐安产，同规格可拼批' },
  { id: 'herb-012', name: '白芍', origin: '植物', part: '根', batchNo: 'BS-2412', feedKg: 90, receivedAt: '2025-08-22T09:00:00.000Z', remark: '安徽亳州产，与 BS-2402 同规格拼批' },
];

export const SEED_METHODS: ProcessingMethod[] = [
  { id: 'method-001', name: '清炒', auxiliary: '无', auxRatio: 0, fireLevel: '文火', tempRange: [90, 120], duration: 12, criterion: '表面微黄、气香、断面颜色加深', criterionDimension: '色泽', applicable: '白术、桑叶、陈皮' },
  { id: 'method-002', name: '麸炒', auxiliary: '麦麸', auxRatio: 10, fireLevel: '中火', tempRange: [130, 160], duration: 10, criterion: '色转深黄、麸皮焦香、无焦斑', criterionDimension: '色泽', applicable: '白术、黄芪、甘草' },
  { id: 'method-003', name: '酒炙', auxiliary: '黄酒', auxRatio: 10, fireLevel: '文火', tempRange: [100, 130], duration: 15, criterion: '色泽加深、酒气尽、断面棕黄', criterionDimension: '气味', applicable: '当归、白芍、黄芪' },
  { id: 'method-004', name: '醋炙', auxiliary: '米醋', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 14, criterion: '表面微亮、醋气尽、无焦糊', criterionDimension: '气味', applicable: '柴胡、延胡索' },
  { id: 'method-005', name: '盐炙', auxiliary: '食盐', auxRatio: 2, fireLevel: '文火', tempRange: [110, 140], duration: 12, criterion: '色泽加深、咸味均匀、断面油润', criterionDimension: '断面', applicable: '杜仲、黄柏' },
  { id: 'method-006', name: '蜜炙', auxiliary: '蜂蜜', auxRatio: 25, fireLevel: '中火', tempRange: [120, 150], duration: 16, criterion: '表面金黄有光泽、不粘手、蜜气香', criterionDimension: '色泽', applicable: '甘草、黄芪、桑叶' },
  { id: 'method-007', name: '蒸', auxiliary: '黄酒', auxRatio: 20, fireLevel: '武火', tempRange: [100, 110], duration: 120, criterion: '内外均呈黑褐色、断面油润光亮', criterionDimension: '断面', applicable: '何首乌、地黄' },
  { id: 'method-008', name: '煮', auxiliary: '米醋', auxRatio: 20, fireLevel: '中火', tempRange: [95, 100], duration: 60, criterion: '无白心、断面角质样、有醋香', criterionDimension: '断面', applicable: '延胡索、乌头' },
  { id: 'method-009', name: '燀', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [95, 100], duration: 5, criterion: '种皮易脱落、仁无白心', criterionDimension: '断面', applicable: '苦杏仁、桃仁' },
  { id: 'method-010', name: '煅', auxiliary: '无', auxRatio: 0, fireLevel: '武火', tempRange: [300, 500], duration: 45, criterion: '质酥脆、无光泽、断面灰白', criterionDimension: '断面', applicable: '牡蛎、龙骨' },
  { id: 'method-011', name: '麸炒', auxiliary: '麦麸', auxRatio: 12, fireLevel: '文火', tempRange: [120, 150], duration: 9, criterion: '色黄、麸香明显、无焦斑', criterionDimension: '色泽', applicable: '苍术（派生）', derivedFrom: 'method-002' },
  { id: 'method-012', name: '酒炙', auxiliary: '黄酒', auxRatio: 15, fireLevel: '文火', tempRange: [100, 130], duration: 18, criterion: '酒气尽、断面棕褐、色泽均匀', criterionDimension: '断面', applicable: '川芎（派生）', derivedFrom: 'method-003' },
];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

interface SeedFeedEntry {
  sourceType: FeedSourceType;
  sourceId: string;
  feedKg: number;
}

interface SeedBatchPlan {
  id: string;
  batchNo: string;
  methodId: string;
  auxUsedKg: number;
  duration: number;
  fireLevel: ProcessBatch['fireLevel'];
  operator: string;
  remark: string;
  /** 逐笔投料来源（拆批/拼批/合并炮制）；省略时取单药材 herb-xxx 且量 = feedKg */
  feeds: SeedFeedEntry[];
  locked: boolean;
  /** 示例：待撤回笔次序号（按 feeds 下标），用于演示撤回单笔、保留原分配待重试 */
  withdrawnSeq?: number;
}

function herbSnapshot(herbId: string): { name: string; batchNo: string } {
  const herb = SEED_HERBS.find((h) => h.id === herbId);
  return { name: herb?.name ?? '未知药材', batchNo: herb?.batchNo ?? '未知批号' };
}

function buildSeedBatchesAndFeeds(): { batches: ProcessBatch[]; feeds: FeedLink[] } {
  // 说明：
  // - batch-001 白术 BT-2401（120kg）与 batch-011 拆分：70kg 给陈玉兰班组、50kg 给刘建国班组
  // - batch-002 白芍由 BS-2402 与同规格 BS-2412 拼批
  // - batch-013 麸炒白术与 batch-011 的清炒半成品合并炮制（半成品再次投料）
  // - batch-012 拼批后撤回其中一笔（BS-2402 疑似混等），工序未锁定、保留原分配待重试
  const plans: SeedBatchPlan[] = [
    { id: 'batch-001', batchNo: 'PZ-25081', methodId: 'method-002', auxUsedKg: 7, duration: 10, fireLevel: '中火', operator: '陈玉兰', remark: '麸炒白术（拆分 · 班组一 70kg）', feeds: [{ sourceType: 'herb', sourceId: 'herb-001', feedKg: 70 }], locked: true },
    { id: 'batch-002', batchNo: 'PZ-25082', methodId: 'method-003', auxUsedKg: 12, duration: 15, fireLevel: '文火', operator: '陈玉兰', remark: '酒炙白芍（同规格两批拼批）', feeds: [{ sourceType: 'herb', sourceId: 'herb-002', feedKg: 80 }, { sourceType: 'herb', sourceId: 'herb-012', feedKg: 40 }], locked: true },
    { id: 'batch-003', batchNo: 'PZ-25083', methodId: 'method-003', auxUsedKg: 6, duration: 15, fireLevel: '文火', operator: '刘建国', remark: '酒炙当归', feeds: [{ sourceType: 'herb', sourceId: 'herb-003', feedKg: 60 }], locked: true },
    { id: 'batch-004', batchNo: 'PZ-25084', methodId: 'method-001', auxUsedKg: 0, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒陈皮', feeds: [{ sourceType: 'herb', sourceId: 'herb-004', feedKg: 45 }], locked: true },
    { id: 'batch-005', batchNo: 'PZ-25085', methodId: 'method-006', auxUsedKg: 50, duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙黄芪', feeds: [{ sourceType: 'herb', sourceId: 'herb-005', feedKg: 200 }], locked: true },
    { id: 'batch-006', batchNo: 'PZ-25086', methodId: 'method-010', auxUsedKg: 0, duration: 45, fireLevel: '武火', operator: '王丽', remark: '煅牡蛎', feeds: [{ sourceType: 'herb', sourceId: 'herb-006', feedKg: 150 }], locked: true },
    { id: 'batch-007', batchNo: 'PZ-25087', methodId: 'method-005', auxUsedKg: 1.8, duration: 12, fireLevel: '文火', operator: '陈玉兰', remark: '盐炙杜仲', feeds: [{ sourceType: 'herb', sourceId: 'herb-008', feedKg: 90 }], locked: true },
    { id: 'batch-008', batchNo: 'PZ-25088', methodId: 'method-001', auxUsedKg: 0, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒桑叶', feeds: [{ sourceType: 'herb', sourceId: 'herb-009', feedKg: 55 }], locked: true },
    { id: 'batch-009', batchNo: 'PZ-25089', methodId: 'method-006', auxUsedKg: 32.5, duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙甘草', feeds: [{ sourceType: 'herb', sourceId: 'herb-010', feedKg: 130 }], locked: false },
    { id: 'batch-010', batchNo: 'PZ-25090', methodId: 'method-002', auxUsedKg: 1.2, duration: 10, fireLevel: '中火', operator: '王丽', remark: '麸炒全蝎', feeds: [{ sourceType: 'herb', sourceId: 'herb-007', feedKg: 12 }], locked: false },
    { id: 'batch-011', batchNo: 'PZ-25091', methodId: 'method-001', auxUsedKg: 0, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒白术（拆分 · 班组二 50kg，半成品留待麸炒）', feeds: [{ sourceType: 'herb', sourceId: 'herb-001', feedKg: 50 }], locked: false },
    {
      id: 'batch-012',
      batchNo: 'PZ-25092',
      methodId: 'method-003',
      auxUsedKg: 4,
      duration: 15,
      fireLevel: '文火',
      operator: '陈玉兰',
      remark: '酒炙白芍拼批 · BS-2402 一笔待复核已撤回，保留分配待重试',
      feeds: [
        { sourceType: 'herb', sourceId: 'herb-002', feedKg: 40 },
        { sourceType: 'herb', sourceId: 'herb-012', feedKg: 30 },
      ],
      locked: false,
      /** 待撤回笔次序号（按 feeds 下标） */
      withdrawnSeq: 0,
    },
    { id: 'batch-013', batchNo: 'PZ-25093', methodId: 'method-002', auxUsedKg: 9.6, duration: 10, fireLevel: '中火', operator: '刘建国', remark: '与清炒半成品（PZ-25091）合并再麸炒', feeds: [{ sourceType: 'batch', sourceId: 'batch-011', feedKg: 46 }, { sourceType: 'herb', sourceId: 'herb-011', feedKg: 50 }], locked: false },
  ];

  // 主来源药材：取该批第一笔药材来源；批次来源（与另一批合并炮制）时显式指定
  const primaryHerbOf = new Map<string, string>([
    ['batch-013', 'herb-011'],
  ]);

  const batches: ProcessBatch[] = plans.map((plan, index) => {
    const method = SEED_METHODS.find((m) => m.id === plan.methodId)!;
    const endedAt = isoMinutesAgo(45 * (index + 1));
    const startedAt = new Date(new Date(endedAt).getTime() - plan.duration * 60_000).toISOString();
    const feedKg = Number(plan.feeds.reduce((sum, f) => sum + f.feedKg, 0).toFixed(3));
    const yieldRate = Number((expectedYieldOf(method) + ((index % 5) - 2) * 0.8).toFixed(1));
    const verdict = judgeDegree({
      method,
      fireLevel: plan.fireLevel,
      duration: plan.duration,
      temp: Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate,
    });
    const herbId = primaryHerbOf.get(plan.id) ?? plan.feeds.find((f) => f.sourceType === 'herb')?.sourceId ?? '';
    return {
      id: plan.id,
      batchNo: plan.batchNo,
      herbId,
      methodId: plan.methodId,
      feedKg,
      auxUsedKg: plan.auxUsedKg,
      fireLevel: plan.fireLevel,
      startedAt,
      endedAt,
      yieldRate,
      degree: verdict.degree,
      operator: plan.operator,
      locked: plan.locked,
      lockedAt: plan.locked ? new Date(new Date(endedAt).getTime() + 30 * 60_000).toISOString() : undefined,
      qcBy: plan.locked ? '质检员 · 赵敏' : undefined,
      remark: plan.remark,
    };
  });

  const feeds: FeedLink[] = [];
  plans.forEach((plan, planIndex) => {
    const batch = batches[planIndex];
    const { withdrawnSeq } = plan;
    plan.feeds.forEach((entry, seq) => {
      const snap =
        entry.sourceType === 'herb'
          ? herbSnapshot(entry.sourceId)
          : { name: herbSnapshot(primaryHerbOf.get(entry.sourceId) ?? 'herb-001').name, batchNo: batches.find((b) => b.id === entry.sourceId)?.batchNo ?? '未知批号' };
      const withdrawn = withdrawnSeq === seq;
      feeds.push({
        id: `feed-${batch.id}-${seq + 1}`,
        batchId: batch.id,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        sourceName: snap.name,
        sourceBatchNo: snap.batchNo,
        feedKg: entry.feedKg,
        remainKg: 0,
        seq: seq + 1,
        status: withdrawn ? 'withdrawn' : 'active',
        createdAt: batch.startedAt,
        withdrawnAt: withdrawn ? new Date(new Date(batch.startedAt).getTime() + 5 * 60_000).toISOString() : undefined,
        withdrawReason: withdrawn ? '拼批复核：该来源疑似混等，撤回本笔，保留另一笔待重试' : undefined,
      });
    });
  });

  // 已撤回笔次的工序，在投合计不含该笔
  const batchWithdrawn = new Set(plans.filter((p) => p.withdrawnSeq !== undefined).map((p) => p.id));
  batches.forEach((batch) => {
    if (batchWithdrawn.has(batch.id)) {
      batch.feedKg = Number(
        feeds.filter((f) => f.batchId === batch.id && f.status === 'active').reduce((sum, f) => sum + f.feedKg, 0).toFixed(3),
      );
    }
  });

  recalcRemain(feeds, SEED_HERBS, batches);
  return { batches, feeds };
}

function buildSeedSamples(batches: ProcessBatch[]): RetainSample[] {
  const logs = (date: string, color: string, odor: string, mold: string, observer: string): RetainSample['observeLogs'][number] => ({
    id: `log-${date}-${Math.random().toString(36).slice(2, 7)}`,
    date,
    color,
    odor,
    mold,
    observer,
  });

  return batches.slice(0, 6).map((batch, index) => {
    const retainMonths = [6, 12, 18, 24][index % 4];
    const retainedAt = new Date(Date.now() - (index * 37 + 8) * 86_400_000).toISOString();
    return {
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      sampleNo: `LY-${batch.batchNo}`,
      batchId: batch.id,
      amountG: [200, 300, 500][index % 3],
      retainMonths,
      cabinet: CABINETS[(index * 5) % CABINETS.length],
      retainedAt,
      observeLogs: [
        logs(new Date(retainedAt).toISOString().slice(0, 10), '色泽符合标准', '气味正常', '无霉变', '赵敏'),
        logs(new Date(Date.now() - (index * 11 + 2) * 86_400_000).toISOString().slice(0, 10), '色泽略深', '气味正常', '无霉变', '赵敏'),
      ],
    };
  });
}

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const herbCount = await db.herbs.count();
  const methodCount = await db.methods.count();
  const batchCount = await db.batches.count();
  const sampleCount = await db.samples.count();

  const { batches, feeds } = buildSeedBatchesAndFeeds();
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.feeds, db.samples, db.meta], async () => {
    if (herbCount === 0) {
      await db.herbs.bulkPut(SEED_HERBS.filter((h) => HERB_ORIGINS.includes(h.origin)));
    }
    if (methodCount === 0) {
      await db.methods.bulkPut(SEED_METHODS.filter((m) => METHOD_NAMES.includes(m.name)));
    }
    if (batchCount === 0) {
      await db.batches.bulkPut(batches);
      await db.feeds.bulkPut(feeds);
    }
    if (sampleCount === 0) {
      await db.samples.bulkPut(buildSeedSamples(batches));
    }
    await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
  });
}

/** 清空全部本地数据（用于重置演示环境） */
export async function resetAll(): Promise<void> {
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.feeds, db.samples, db.meta], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.feeds.clear(), db.samples.clear(), db.meta.clear()]);
  });
  await seedIfEmpty();
}
