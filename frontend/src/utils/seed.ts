import { db } from './db';
import { HERB_ORIGINS, type HerbMaterial } from '../types/herb-material';
import { METHOD_NAMES, type ProcessingMethod } from '../types/processing-method';
import type { ProcessBatch } from '../types/process-batch';
import type { FeedEntry } from '../types/feed-entry';
import { CABINETS, type RetainSample } from '../types/retain-sample';
import { judgeDegree, expectedYieldOf } from './degree';
import { round2 } from './lineage';

/** 首次打开时写入的示例台账，便于直接查看各页面效果 */
export const SEED_HERBS: HerbMaterial[] = [
  { id: 'herb-001', name: '白术', origin: '植物', part: '根', batchNo: 'BT-2401', feedKg: 120, receivedAt: '2025-08-02T09:00:00.000Z', remark: '浙江磐安产' },
  { id: 'herb-002', name: '白芍', origin: '植物', part: '根', batchNo: 'BS-2402', feedKg: 80, receivedAt: '2025-08-05T09:00:00.000Z' },
  { id: 'herb-003', name: '当归', origin: '植物', part: '根', batchNo: 'DG-2403', feedKg: 60, receivedAt: '2025-08-06T09:00:00.000Z', remark: '甘肃岷县产' },
  { id: 'herb-004', name: '陈皮', origin: '植物', part: '果实', batchNo: 'CP-2404', feedKg: 45, receivedAt: '2025-08-08T09:00:00.000Z' },
  { id: 'herb-005', name: '黄芪', origin: '植物', part: '根', batchNo: 'HQ-2405', feedKg: 240, receivedAt: '2025-08-11T09:00:00.000Z' },
  { id: 'herb-006', name: '牡蛎', origin: '矿物', part: '果实', batchNo: 'ML-2406', feedKg: 150, receivedAt: '2025-08-12T09:00:00.000Z', remark: '煅用' },
  { id: 'herb-007', name: '全蝎', origin: '动物', part: '茎', batchNo: 'QX-2407', feedKg: 12, receivedAt: '2025-08-14T09:00:00.000Z' },
  { id: 'herb-008', name: '杜仲', origin: '植物', part: '茎', batchNo: 'DZ-2408', feedKg: 90, receivedAt: '2025-08-15T09:00:00.000Z', remark: '盐炙用' },
  { id: 'herb-009', name: '桑叶', origin: '植物', part: '叶', batchNo: 'SY-2409', feedKg: 55, receivedAt: '2025-08-18T09:00:00.000Z' },
  { id: 'herb-010', name: '甘草', origin: '植物', part: '根', batchNo: 'GC-2410', feedKg: 130, receivedAt: '2025-08-20T09:00:00.000Z' },
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

interface SeedPlanRow {
  batchNo: string;
  herbId: string;
  methodId: string;
  auxUsedKg: number;
  duration: number;
  fireLevel: string;
  operator: string;
  remark: string;
  /** 逐笔投料来源：[来源类型, 来源id, 投入量kg, 班组/说明] */
  sources: Array<['herb' | 'batch', string, number, string?]>;
}

/**
 * 示例投料方案：
 * - herb-001 白术 120kg 拆成 80/40 投给 batch-001 与 batch-011（一批给两个班组）
 * - herb-005 黄芪 240kg 拆成 120/120，且 batch-005 为 HQ-2405 拼 GC-2410 的拼批
 * - batch-012 以上游 batch-002 酒炙白芍产出继续投料，体现合并炮制的谱系递归
 */
const SEED_PLAN: SeedPlanRow[] = [
  { batchNo: 'PZ-25081', herbId: 'herb-001', methodId: 'method-002', auxUsedKg: 8, duration: 10, fireLevel: '中火', operator: '陈玉兰', remark: '麸炒白术（一班）', sources: [['herb', 'herb-001', 80, '一班']] },
  { batchNo: 'PZ-25082', herbId: 'herb-002', methodId: 'method-003', auxUsedKg: 8, duration: 15, fireLevel: '文火', operator: '陈玉兰', remark: '酒炙白芍', sources: [['herb', 'herb-002', 80]] },
  { batchNo: 'PZ-25083', herbId: 'herb-003', methodId: 'method-003', auxUsedKg: 6, duration: 15, fireLevel: '文火', operator: '刘建国', remark: '酒炙当归', sources: [['herb', 'herb-003', 60]] },
  { batchNo: 'PZ-25084', herbId: 'herb-004', methodId: 'method-001', auxUsedKg: 0, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒陈皮', sources: [['herb', 'herb-004', 45]] },
  { batchNo: 'PZ-25085', herbId: 'herb-005', methodId: 'method-006', auxUsedKg: 42.5, duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙黄芪拼甘草', sources: [['herb', 'herb-005', 120], ['herb', 'herb-010', 50]] },
  { batchNo: 'PZ-25086', herbId: 'herb-006', methodId: 'method-010', auxUsedKg: 0, duration: 45, fireLevel: '武火', operator: '王丽', remark: '煅牡蛎', sources: [['herb', 'herb-006', 150]] },
  { batchNo: 'PZ-25087', herbId: 'herb-008', methodId: 'method-005', auxUsedKg: 1.8, duration: 12, fireLevel: '文火', operator: '陈玉兰', remark: '盐炙杜仲', sources: [['herb', 'herb-008', 90]] },
  { batchNo: 'PZ-25088', herbId: 'herb-009', methodId: 'method-001', auxUsedKg: 0, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '清炒桑叶', sources: [['herb', 'herb-009', 55]] },
  { batchNo: 'PZ-25089', herbId: 'herb-010', methodId: 'method-006', auxUsedKg: 20, duration: 16, fireLevel: '中火', operator: '王丽', remark: '蜜炙甘草', sources: [['herb', 'herb-010', 80]] },
  { batchNo: 'PZ-25090', herbId: 'herb-007', methodId: 'method-002', auxUsedKg: 1.2, duration: 10, fireLevel: '中火', operator: '王丽', remark: '麸炒全蝎', sources: [['herb', 'herb-007', 12]] },
  { batchNo: 'PZ-25091', herbId: 'herb-001', methodId: 'method-002', auxUsedKg: 4, duration: 10, fireLevel: '中火', operator: '刘建国', remark: '麸炒白术（二班，同批拆投）', sources: [['herb', 'herb-001', 40, '二班']] },
  { batchNo: 'PZ-25092', herbId: 'herb-005', methodId: 'method-003', auxUsedKg: 12, duration: 15, fireLevel: '文火', operator: '陈玉兰', remark: '酒炙黄芪（同批另一班组）', sources: [['herb', 'herb-005', 120, '一班']] },
  { batchNo: 'PZ-25093', herbId: 'herb-002', methodId: 'method-003', auxUsedKg: 3, duration: 12, fireLevel: '文火', operator: '刘建国', remark: '复炙：以上游酒炙白芍产出继续投料', sources: [['batch', 'batch-002', 30]] },
];

export interface SeedData {
  batches: ProcessBatch[];
  feeds: FeedEntry[];
}

function buildSeedBatches(): SeedData {
  const herbTotal = new Map(SEED_HERBS.map((h) => [h.id, h.feedKg]));
  const usedHerb = new Map<string, number>();
  const usedBatchOutput = new Map<string, number>();
  const batches: ProcessBatch[] = [];
  const feeds: FeedEntry[] = [];

  SEED_PLAN.forEach((row, index) => {
    const method = SEED_METHODS.find((m) => m.id === row.methodId)!;
    const endedAt = isoMinutesAgo(45 * (index + 1));
    const startedAt = new Date(new Date(endedAt).getTime() - row.duration * 60_000).toISOString();
    const feedKg = round2(row.sources.reduce((sum, [, , amount]) => sum + amount, 0));
    const yieldRate = Number((expectedYieldOf(method) + ((index % 5) - 2) * 0.8).toFixed(1));
    const verdict = judgeDegree({
      method,
      fireLevel: row.fireLevel as ProcessBatch['fireLevel'],
      duration: row.duration,
      temp: Math.round((method.tempRange[0] + method.tempRange[1]) / 2),
      yieldRate,
    });
    const locked = index >= 2;
    const batchId = `batch-${String(index + 1).padStart(3, '0')}`;
    batches.push({
      id: batchId,
      batchNo: row.batchNo,
      herbId: row.herbId,
      methodId: row.methodId,
      feedKg,
      auxUsedKg: row.auxUsedKg,
      fireLevel: row.fireLevel as ProcessBatch['fireLevel'],
      startedAt,
      endedAt,
      yieldRate,
      degree: verdict.degree,
      operator: row.operator,
      locked,
      lockedAt: locked ? new Date(new Date(endedAt).getTime() + 30 * 60_000).toISOString() : undefined,
      qcBy: locked ? '质检员 · 赵敏' : undefined,
      remark: row.remark,
    });

    row.sources.forEach(([sourceType, sourceId, amount, team], sIndex) => {
      let remainAfter = 0;
      if (sourceType === 'herb') {
        const total = herbTotal.get(sourceId) ?? 0;
        const used = round2((usedHerb.get(sourceId) ?? 0) + amount);
        usedHerb.set(sourceId, used);
        remainAfter = round2(total - used);
      } else {
        const upstream = batches.find((b) => b.id === sourceId)!;
        const output = round2((upstream.feedKg * upstream.yieldRate) / 100);
        const used = round2((usedBatchOutput.get(sourceId) ?? 0) + amount);
        usedBatchOutput.set(sourceId, used);
        remainAfter = round2(output - used);
      }
      feeds.push({
        id: `feed-${String(index + 1).padStart(3, '0')}-${sIndex + 1}`,
        batchId,
        sourceType,
        sourceId,
        amountKg: amount,
        remainAfterKg: remainAfter,
        active: true,
        createdAt: startedAt,
        remark: team,
      });
    });
  });

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
  const feedCount = await db.feeds.count();

  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.feeds, db.meta], async () => {
    if (herbCount === 0) {
      await db.herbs.bulkPut(SEED_HERBS.filter((h) => HERB_ORIGINS.includes(h.origin)));
    }
    if (methodCount === 0) {
      await db.methods.bulkPut(SEED_METHODS.filter((m) => METHOD_NAMES.includes(m.name)));
    }
    const { batches, feeds } = buildSeedBatches();
    if (batchCount === 0) {
      await db.batches.bulkPut(batches);
    }
    if (feedCount === 0) {
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
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.feeds, db.meta], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.samples.clear(), db.feeds.clear(), db.meta.clear()]);
  });
  await seedIfEmpty();
}
