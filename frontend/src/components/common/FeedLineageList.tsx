import { Button, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import type { FeedLink } from '../../types/feed';
import { formatDate } from '../../utils/degree';

const { Text } = Typography;

export interface FeedLineageListProps {
  links: FeedLink[];
  /** 撤回单笔回调；不提供则不显示撤回操作 */
  onWithdraw?: (link: FeedLink, reason?: string) => Promise<void> | void;
  /** 撤回是否被禁用（如工序已锁定或已有留样） */
  withdrawDisabled?: boolean;
  size?: 'small' | 'middle';
}

/** 投料谱系笔次表：逐笔展示来源、投入量、入账后剩余量与撤回状态 */
export default function FeedLineageList({ links, onWithdraw, withdrawDisabled, size = 'small' }: FeedLineageListProps) {
  const sorted = [...links].sort((a, b) => a.seq - b.seq);
  const columns: TableColumnsType<FeedLink> = [
    { title: '笔次', dataIndex: 'seq', width: 60, align: 'right', render: (v: number) => `#${v}` },
    {
      title: '来源',
      width: 230,
      render: (_, row) => (
        <Space size={4}>
          <Tag color={row.sourceType === 'herb' ? 'green' : 'geekblue'}>{row.sourceType === 'herb' ? '药材批' : '工序成品'}</Tag>
          <Text delete={row.status === 'withdrawn'} strong>
            {row.sourceName} · {row.sourceBatchNo}
          </Text>
        </Space>
      ),
    },
    { title: '投入量(kg)', dataIndex: 'feedKg', width: 100, align: 'right', render: (v: number) => v.toFixed(1) },
    {
      title: '入账后剩余(kg)',
      dataIndex: 'remainKg',
      width: 130,
      align: 'right',
      render: (v: number, row) => <Text type={row.status === 'withdrawn' ? 'secondary' : v <= 0 ? undefined : 'success'}>{Number(v).toFixed(1)}</Text>,
    },
    {
      title: '状态',
      width: 200,
      render: (_, row) =>
        row.status === 'active' ? (
          <Tag color="blue">在投</Tag>
        ) : (
          <Space direction="vertical" size={0}>
            <Tag color="default">已撤回</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.withdrawnAt ? `${formatDate(row.withdrawnAt)} ` : ''}
              {row.withdrawReason ?? ''}
            </Text>
          </Space>
        ),
    },
    {
      title: '入账时间',
      dataIndex: 'createdAt',
      width: 110,
      render: (v: string) => formatDate(v),
    },
    ...(onWithdraw
      ? [
          {
            title: '操作',
            width: 90,
            render: (_: unknown, row: FeedLink) =>
              row.status === 'active' ? (
                <Popconfirm
                  title={`撤回第 #${row.seq} 笔投料？`}
                  description="只退回这一笔的来源余量，其它笔次与该工序不受影响；工序保持未锁定可重试。"
                  okText="撤回本笔"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  disabled={withdrawDisabled}
                  onConfirm={() => onWithdraw(row)}
                >
                  <Button size="small" type="link" danger disabled={withdrawDisabled}>
                    撤回
                  </Button>
                </Popconfirm>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  -
                </Text>
              ),
          } as TableColumnsType<FeedLink>[number],
        ]
      : []),
  ];

  return (
    <Table
      rowKey="id"
      size={size}
      columns={columns}
      dataSource={sorted}
      pagination={false}
      locale={{ emptyText: '暂无投料来源记录' }}
      scroll={{ x: 900 }}
    />
  );
}
