import { useMemo } from 'react';
import { Button, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { TableColumnsType } from 'antd';
import type { FeedEntry, FeedSourceType } from '../../types/feed-entry';
import type { HerbMaterial } from '../../types/herb-material';
import type { ProcessBatch } from '../../types/process-batch';
import { batchOutputRemaining, herbRemaining, round2 } from '../../utils/lineage';

const { Text } = Typography;

export interface SourceRow {
  key: string;
  sourceType: FeedSourceType;
  sourceId: string;
  amountKg: number | null;
  remark?: string;
}

interface SourceFeedsEditorProps {
  value?: SourceRow[];
  onChange?: (rows: SourceRow[]) => void;
  herbs: HerbMaterial[];
  batches: ProcessBatch[];
  /** 全部有效投料记录（计算各来源剩余量） */
  feeds: import('../../types/feed-entry').FeedEntry[];
  /** 编辑工序时排除自身（工序产出不能投给自己） */
  selfBatchId?: string;
  disabled?: boolean;
}

/**
 * 逐笔投料来源编辑器：同规格药材可拆批（一批分投多个工序/班组）、
 * 拼批（多笔来源合并到同一工序）。每笔实时显示该来源剩余量，超额即时提示。
 */
export default function SourceFeedsEditor({ value = [], onChange, herbs, batches, feeds, selfBatchId, disabled }: SourceFeedsEditorProps) {
  const emit = (rows: SourceRow[]) => onChange?.(rows);

  const update = (key: string, patch: Partial<SourceRow>) => {
    emit(value.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const remainingOf = (row: SourceRow): number | undefined => {
    if (!row.sourceId) return undefined;
    if (row.sourceType === 'batch' && row.sourceId === selfBatchId) return undefined;
    // 基础剩余量：排除本工序既有占用（编辑重新分配时这些占用会随提交释放）
    const base =
      row.sourceType === 'herb'
        ? herbRemaining(herbs, feeds, row.sourceId)
        : batchOutputRemaining(batches, feeds, row.sourceId);
    const selfBatchFeeds = selfBatchId ? feeds.filter((f) => f.active && f.batchId === selfBatchId) : [];
    const released = selfBatchFeeds
      .filter((f) => f.sourceType === row.sourceType && f.sourceId === row.sourceId)
      .reduce((sum, f) => sum + f.amountKg, 0);
    // 再扣除本表单内其他行已经占用的同一来源
    const otherRowsUsed = value
      .filter((r) => r !== row && r.sourceType === row.sourceType && r.sourceId === row.sourceId)
      .reduce((sum, r) => sum + (Number(r.amountKg) || 0), 0);
    return round2(base + released - otherRowsUsed);
  };

  const optionRemaining = (sourceType: FeedSourceType, sourceId: string): number => {
    const base =
      sourceType === 'herb' ? herbRemaining(herbs, feeds, sourceId) : batchOutputRemaining(batches, feeds, sourceId);
    if (!selfBatchId) return base;
    const released = feeds
      .filter((f) => f.active && f.batchId === selfBatchId && f.sourceType === sourceType && f.sourceId === sourceId)
      .reduce((sum, f) => sum + f.amountKg, 0);
    const editingUsed = value
      .filter((r) => r.sourceType === sourceType && r.sourceId === sourceId)
      .reduce((sum, r) => sum + (Number(r.amountKg) || 0), 0);
    return round2(base + released - editingUsed);
  };

  const total = useMemo(() => round2(value.reduce((sum, r) => sum + (Number(r.amountKg) || 0), 0)), [value]);

  const columns: TableColumnsType<SourceRow> = [
    {
      title: '来源类型',
      width: 130,
      render: (_, row) => (
        <Select
          size="small"
          style={{ width: 120 }}
          disabled={disabled}
          value={row.sourceType}
          onChange={(sourceType: FeedSourceType) => update(row.key, { sourceType, sourceId: '' })}
          options={[
            { label: '药材原批', value: 'herb' },
            { label: '上游工序产出', value: 'batch' },
          ]}
        />
      ),
    },
    {
      title: '来源批次',
      render: (_, row) => {
        if (row.sourceType === 'herb') {
          return (
            <Select
              size="small"
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              disabled={disabled}
              value={row.sourceId || undefined}
              placeholder="选择药材批次（同规格可多笔拼批）"
              onChange={(sourceId: string) => update(row.key, { sourceId })}
              options={herbs.map((h) => ({
                label: `${h.name} · ${h.batchNo}（剩 ${optionRemaining('herb', h.id)}kg / ${h.feedKg}kg）`,
                value: h.id,
              }))}
            />
          );
        }
        return (
          <Select
            size="small"
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
            disabled={disabled}
            value={row.sourceId || undefined}
            placeholder="选择上游炮制工序"
            onChange={(sourceId: string) => update(row.key, { sourceId })}
            options={batches
              .filter((b) => b.id !== selfBatchId)
              .map((b) => {
                const herb = herbs.find((h) => h.id === b.herbId);
                const output = round2((b.feedKg * b.yieldRate) / 100);
                return {
                  label: `${b.batchNo} · ${herb?.name ?? '未知药材'}（产出 ${output}kg，剩 ${optionRemaining('batch', b.id)}kg）`,
                  value: b.id,
                };
              })}
          />
        );
      },
    },
    {
      title: '投入量(kg)',
      width: 150,
      render: (_, row) => (
        <InputNumber
          size="small"
          min={0}
          step={0.5}
          precision={2}
          style={{ width: 130 }}
          disabled={disabled}
          value={row.amountKg}
          onChange={(v) => update(row.key, { amountKg: v })}
        />
      ),
    },
    {
      title: '剩余量',
      width: 150,
      align: 'right',
      render: (_, row) => {
        const remain = remainingOf(row);
        if (remain === undefined) return <Text type="secondary">-</Text>;
        const over = Number(row.amountKg) > 0 && Number(row.amountKg) - remain > 1e-6;
        return (
          <Text type={over ? 'danger' : remain <= 0 ? 'warning' : 'secondary'}>
            {over ? '超出 ' : '剩 '}
            {Math.abs(round2((Number(row.amountKg) || 0) - remain))}kg
          </Text>
        );
      },
    },
    {
      title: '班组/说明',
      width: 150,
      render: (_, row) => (
        <Select
          size="small"
          style={{ width: 140 }}
          allowClear
          disabled={disabled}
          value={row.remark || undefined}
          placeholder="如：一班"
          onChange={(v?: string) => update(row.key, { remark: v })}
          options={['一班', '二班'].map((v) => ({ label: v, value: v }))}
        />
      ),
    },
    {
      title: '',
      width: 44,
      render: (_, row) => (
        <Button
          size="small"
          type="link"
          danger
          icon={<DeleteOutlined />}
          disabled={disabled || value.length <= 1}
          onClick={() => emit(value.filter((r) => r.key !== row.key))}
        />
      ),
    },
  ];

  return (
    <div>
      <Table rowKey="key" size="small" pagination={false} columns={columns} dataSource={value} scroll={{ x: 760 }} />
      <Space style={{ marginTop: 8 }} wrap>
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={() =>
            emit([
              ...value,
              { key: `row-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sourceType: 'herb', sourceId: '', amountKg: null },
            ])
          }
        >
          追加一笔来源（拼批）
        </Button>
        <Tag color="blue">逐笔投入合计 {total}kg（= 本工序总投料量）</Tag>
        <Text type="secondary">同一来源批次可拆投多个工序；任一笔超出剩余量将无法提交并恢复原分配。</Text>
      </Space>
    </div>
  );
}
