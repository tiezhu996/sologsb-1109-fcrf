import { useMemo } from 'react';
import { Button, Form, InputNumber, Select, Space, Table, Tag, Typography } from 'antd';
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons';
import type { FeedLink, FeedSourceInput, FeedSourceType } from '../../types/feed';
import type { HerbMaterial } from '../../types/herb-material';
import type { ProcessBatch } from '../../types/process-batch';
import { batchOutputKg } from '../../utils/feedLineage';

const { Text } = Typography;

export interface FeedSourcesEditorProps {
  herbs: HerbMaterial[];
  batches: ProcessBatch[];
  /** 全部投料笔次（用于计算来源余量） */
  links: FeedLink[];
  /** 编辑中的工序 id：计算余量时排除其自身在投笔次 */
  excludeBatchId?: string;
  disabled?: boolean;
}

/**
 * 逐笔投料来源编辑器：支持同规格药材拆批、多批拼批、与另一工序成品合并炮制。
 * 嵌入 Form 内，字段名为 sources（FeedSourceInput[]）。
 */
export default function FeedSourcesEditor({ herbs, batches, links, excludeBatchId, disabled }: FeedSourcesEditorProps) {
  /** 来源余量：初始量 - 其它工序在投占用 */
  const available = useMemo(() => {
    const used = new Map<string, number>();
    links.forEach((l) => {
      if (l.status !== 'active' || l.batchId === excludeBatchId) return;
      const key = `${l.sourceType}:${l.sourceId}`;
      used.set(key, (used.get(key) ?? 0) + l.feedKg);
    });
    const calc = (type: FeedSourceType, id: string, initial: number) =>
      Number(Math.max(0, initial - (used.get(`${type}:${id}`) ?? 0)).toFixed(3));
    return {
      herb: new Map(herbs.map((h) => [h.id, calc('herb', h.id, h.feedKg)])),
      batch: new Map(batches.filter((b) => b.id !== excludeBatchId).map((b) => [b.id, calc('batch', b.id, batchOutputKg(b))])),
    };
  }, [herbs, batches, links, excludeBatchId]);

  const herbOptions = herbs.map((h) => {
    const remain = available.herb.get(h.id) ?? 0;
    return {
      value: h.id,
      label: `${h.name} · ${h.batchNo}（库存 ${h.feedKg}kg / 可投 ${remain}kg）`,
      disabled: remain <= 0,
    };
  });

  const batchOptions = batches
    .filter((b) => b.id !== excludeBatchId)
    .map((b) => {
      const herb = herbs.find((h) => h.id === b.herbId);
      const remain = available.batch.get(b.id) ?? 0;
      return {
        value: b.id,
        label: `成品 ${b.batchNo} · ${herb?.name ?? '未知药材'}（产出 ${batchOutputKg(b)}kg / 可投 ${remain}kg）`,
        disabled: remain <= 0,
      };
    });

  return (
    <Form.List name="sources">
      {(fields, { add, remove }) => (
        <div style={{ background: '#f7faf7', border: '1px solid #e2efe4', borderRadius: 8, padding: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
            <Space size={8} wrap>
              <Text strong>逐笔投料来源</Text>
              <Tag color="green">拆批</Tag>
              <Tag color="geekblue">拼批 / 合并炮制</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                一笔一行，逐笔记录来源、投入量；余量不足时整单提交失败、原分配不变
              </Text>
            </Space>
            <Button
              type="dashed"
              size="small"
              icon={<PlusOutlined />}
              disabled={disabled}
              onClick={() => add({ sourceType: 'herb', sourceId: herbs[0]?.id, feedKg: 10 })}
            >
              追加一笔来源
            </Button>
          </div>

          <Table
            rowKey={(row) => String(row.key)}
            size="small"
            pagination={false}
            dataSource={fields}
            locale={{ emptyText: '请至少添加一笔来源' }}
            columns={[
              {
                title: '笔次',
                width: 60,
                align: 'right',
                render: (_, __, index) => <Text type="secondary">#{index + 1}</Text>,
              },
              {
                title: '来源类型',
                width: 130,
                render: (_, field) => <SourceTypeCell name={field.name} disabled={disabled} />,
              },
              {
                title: '来源批次',
                render: (_, field) => (
                  <SourceIdCell name={field.name} disabled={disabled} herbOptions={herbOptions} batchOptions={batchOptions} />
                ),
              },
              {
                title: '本笔投入(kg)',
                width: 150,
                render: (_, field) => (
                  <Form.Item
                    name={[field.name, 'feedKg']}
                    rules={[
                      { required: true, message: '请输入投入量' },
                      {
                        validator: (_r, value) =>
                          value === undefined || value === null || Number(value) > 0
                            ? Promise.resolve()
                            : Promise.reject(new Error('投入量需大于 0')),
                      },
                    ]}
                    style={{ marginBottom: 0 }}
                  >
                    <InputNumber min={0} step={1} size="small" style={{ width: '100%' }} disabled={disabled} />
                  </Form.Item>
                ),
              },
              {
                title: '',
                width: 44,
                render: (_, field) =>
                  fields.length > 1 ? (
                    <Button size="small" type="text" danger icon={<MinusCircleOutlined />} disabled={disabled} onClick={() => remove(field.name)} />
                  ) : null,
              },
            ]}
          />
          <TotalLine />
        </div>
      )}
    </Form.List>
  );
}

/** 来源类型单元格（Hook 在组件顶层调用，满足 Rules of Hooks） */
function SourceTypeCell({ name, disabled }: { name: number; disabled?: boolean }) {
  const form = Form.useFormInstance();
  return (
    <Form.Item name={[name, 'sourceType']} rules={[{ required: true }]} style={{ marginBottom: 0 }}>
      <Select
        size="small"
        disabled={disabled}
        options={[
          { label: '药材批次', value: 'herb' },
          { label: '上道工序成品', value: 'batch' },
        ]}
        onChange={() => form.setFieldValue(['sources', name, 'sourceId'], undefined)}
      />
    </Form.Item>
  );
}

/** 来源批次单元格，随来源类型切换候选项 */
function SourceIdCell({
  name,
  disabled,
  herbOptions,
  batchOptions,
}: {
  name: number;
  disabled?: boolean;
  herbOptions: { value: string; label: string; disabled?: boolean }[];
  batchOptions: { value: string; label: string; disabled?: boolean }[];
}) {
  const type = (Form.useWatch(['sources', name, 'sourceType']) as FeedSourceType | undefined) ?? 'herb';
  return (
    <Form.Item name={[name, 'sourceId']} rules={[{ required: true, message: '请选择来源' }]} style={{ marginBottom: 0 }}>
      <Select
        showSearch
        size="small"
        optionFilterProp="label"
        disabled={disabled}
        placeholder={type === 'herb' ? '选择药材批次' : '选择上道工序成品'}
        options={type === 'herb' ? herbOptions : batchOptions}
      />
    </Form.Item>
  );
}

/** 在投合计（监听 Form 内 sources） */
function TotalLine() {
  const sources = (Form.useWatch('sources') as FeedSourceInput[] | undefined) ?? [];
  const total = sources.reduce((sum, s) => sum + (Number(s?.feedKg) || 0), 0);
  return (
    <div style={{ marginTop: 8, textAlign: 'right' }}>
      <Text type="secondary">投料合计：</Text>
      <Text strong>{total.toFixed(1)} kg</Text>
    </div>
  );
}
