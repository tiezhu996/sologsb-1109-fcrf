import { Space, Tag, Tooltip, Typography } from 'antd';
import { ApartmentOutlined, ExperimentOutlined, ProfileOutlined } from '@ant-design/icons';
import type { LineageNode } from '../../types/feed-entry';

const { Text } = Typography;

interface LineageTreeProps {
  nodes: LineageNode[];
  /** 紧凑模式（表格行内使用） */
  compact?: boolean;
}

function NodeTag({ node, flowKg }: { node: LineageNode; flowKg: number }) {
  const isHerb = node.sourceType === 'herb';
  const icon = isHerb ? <ExperimentOutlined /> : <ProfileOutlined />;
  return (
    <Tooltip title={isHerb ? '药材原批' : '上一道炮制工序产出'}>
      <Tag color={isHerb ? 'green' : 'geekblue'} icon={icon} style={{ marginInlineEnd: 4 }}>
        {node.label} · {flowKg}kg
      </Tag>
    </Tooltip>
  );
}

function Branch({ node, flowKg, depth }: { node: LineageNode; flowKg: number; depth: number }) {
  return (
    <div style={{ marginLeft: depth === 0 ? 0 : 18 }}>
      <Space size={4} wrap style={{ marginTop: depth === 0 ? 0 : 4 }}>
        {depth > 0 ? <Text type="secondary">└─</Text> : null}
        <NodeTag node={node} flowKg={flowKg} />
        {node.parents.length > 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            （本笔流入 {flowKg}kg，上游投料明细 ↓）
          </Text>
        ) : null}
      </Space>
      {node.parents.map((parent) => (
        <Branch key={parent.key} node={parent} flowKg={parent.amountKg} depth={depth + 1} />
      ))}
    </div>
  );
}

/** 来源谱系树：逐笔展开到最初药材批次（拆批/拼批/合并炮制均可追溯） */
export default function LineageTree({ nodes, compact = false }: LineageTreeProps) {
  if (nodes.length === 0) {
    return <Text type="secondary">暂无来源记录</Text>;
  }
  return (
    <div style={{ fontSize: compact ? 12 : 13 }}>
      {!compact ? (
        <Space size={4} style={{ marginBottom: 6 }}>
          <ApartmentOutlined />
          <Text type="secondary">投料来源谱系（{nodes.length} 笔直接来源，标签为沿该支路的实际投入量）</Text>
        </Space>
      ) : null}
      {nodes.map((node) => (
        <Branch key={node.key} node={node} flowKg={node.amountKg} depth={0} />
      ))}
    </div>
  );
}
