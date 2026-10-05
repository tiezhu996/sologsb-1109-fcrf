import { db, SCHEMA_VERSION } from './db';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  herbs: unknown[];
  methods: unknown[];
  batches: unknown[];
  samples: unknown[];
  /** v3 起：逐笔投料关系（来源/投入量/剩余量/撤回痕迹与谱系的唯一事实来源） */
  feeds?: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [herbs, methods, batches, samples, feeds] = await Promise.all([
    db.herbs.toArray(),
    db.methods.toArray(),
    db.batches.toArray(),
    db.samples.toArray(),
    db.feeds.toArray(),
  ]);
  return {
    app: 'gbherbprocess',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    herbs,
    methods,
    batches,
    samples,
    feeds,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（台账打印用） */
export function downloadCsv<T extends Record<string, unknown>>(filename: string, rows: T[], columns: Array<{ key: keyof T; title: string }>): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

export interface ImportCounts {
  herbs: number;
  methods: number;
  batches: number;
  samples: number;
  feeds: number;
}

/**
 * 恢复 JSON 备份。feeds 随备份一并还原，恢复后谱系完整可见；
 * 旧版备份（无 feeds）按当前 schema 缺省处理，页面会把旧单来源回显为单节点谱系。
 */
export async function importBackup(text: string): Promise<ImportCounts> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbherbprocess') {
    throw new Error('备份文件格式不匹配（缺少 app=gbherbprocess 标记）');
  }
  const counts: ImportCounts = {
    herbs: payload.herbs?.length ?? 0,
    methods: payload.methods?.length ?? 0,
    batches: payload.batches?.length ?? 0,
    samples: payload.samples?.length ?? 0,
    feeds: payload.feeds?.length ?? 0,
  };
  await db.transaction('rw', [db.herbs, db.methods, db.batches, db.samples, db.feeds], async () => {
    await Promise.all([db.herbs.clear(), db.methods.clear(), db.batches.clear(), db.samples.clear(), db.feeds.clear()]);
    if (payload.herbs?.length) await db.herbs.bulkPut(payload.herbs as never[]);
    if (payload.methods?.length) await db.methods.bulkPut(payload.methods as never[]);
    if (payload.batches?.length) await db.batches.bulkPut(payload.batches as never[]);
    if (payload.samples?.length) await db.samples.bulkPut(payload.samples as never[]);
    if (payload.feeds?.length) await db.feeds.bulkPut(payload.feeds as never[]);
  });
  return counts;
}
