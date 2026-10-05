import { Empty, Space, Tag, Timeline, Typography } from 'antd';
import type { HerbMaterial } from '../../types/herb-material';
import type { ProcessingMethod } from '../../types/processing-method';
import type { ProcessBatch, ProcessDegree } from '../../types/process-batch';
import type { FeedLink } from '../../types/feed';
import { formatDate } from '../../utils/degree';

const { Text } = Typography;

export interface ProcessTimelineProps {
  batches: ProcessBatch[];
  herbs: HerbMaterial[];
  methods: ProcessingMethod[];
  /** 逐笔投料谱系（多来源时在时间线中列出） */
  links?: FeedLink[];
  limit?: number;
}

const DEGREE_COLOR: Record<ProcessDegree, string> = {
  不及: 'orange',
  适中: 'green',
  太过: 'red',
};

/** 炮制工序时间线（首页复用），展示最近批次的方法、火候、得率与逐笔来源 */
export default function ProcessTimeline({ batches, herbs, methods, links = [], limit = 6 }: ProcessTimelineProps) {
  const rows = batches.slice(0, limit);
  if (rows.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无炮制工序记录" />;
  }

  return (
    <Timeline
      items={rows.map((batch) => {
        const method = methods.find((m) => m.id === batch.methodId);
        const activeLinks = links.filter((l) => l.batchId === batch.id && l.status === 'active');
        const withdrawnCount = links.filter((l) => l.batchId === batch.id && l.status === 'withdrawn').length;
        const names = Array.from(new Set(activeLinks.map((l) => l.sourceName)));
        return {
          color: batch.degree === '适中' ? 'green' : batch.degree === '太过' ? 'red' : 'orange',
          children: (
            <div>
              <Text strong>{batch.batchNo}</Text>
              <Tag style={{ marginLeft: 8 }} color={DEGREE_COLOR[batch.degree]}>
                {batch.degree}
              </Tag>
              {batch.locked ? <Tag color="blue">已锁定</Tag> : <Tag>待判定</Tag>}
              {withdrawnCount > 0 ? <Tag color="default">{withdrawnCount} 笔已撤回</Tag> : null}
              <div style={{ fontSize: 12, color: '#6b7a70' }}>
                {names.length ? names.join('、') : herbs.find((h) => h.id === batch.herbId)?.name ?? '未知药材'} ·{' '}
                {method?.name ?? '未知方法'} · {batch.fireLevel} · {formatDate(batch.startedAt)} · 得率 {batch.yieldRate}% · 操作人{' '}
                {batch.operator}
              </div>
              {activeLinks.length > 1 ? (
                <Space size={2} wrap style={{ marginTop: 2 }}>
                  {activeLinks.map((l) => (
                    <Tag key={l.id} color={l.sourceType === 'herb' ? 'green' : 'geekblue'} style={{ fontSize: 11 }}>
                      {l.sourceBatchNo} {l.feedKg}kg
                    </Tag>
                  ))}
                </Space>
              ) : null}
            </div>
          ),
        };
      })}
    />
  );
}
