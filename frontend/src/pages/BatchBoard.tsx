import { useMemo, useState } from 'react';
import { Alert, App as AntApp, Button, Card, DatePicker, Drawer, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useSearchParams } from 'react-router-dom';
import FilterBar from '../components/common/FilterBar';
import FireLevelTag from '../components/common/FireLevelTag';
import RatioCalculator from '../components/common/RatioCalculator';
import EmptyPanel from '../components/common/EmptyPanel';
import LineageTree from '../components/common/LineageTree';
import SourceFeedsEditor, { type SourceRow } from '../components/common/SourceFeedsEditor';
import { useHerbFilter } from '../hooks/useHerbFilter';
import { useHerbStore } from '../stores/herbStore';
import { useMethodStore } from '../stores/methodStore';
import { useBatchStore, type SourceAllocationInput } from '../stores/batchStore';
import { HERB_ORIGINS, HERB_PARTS } from '../types/herb-material';
import { FIRE_LEVELS, type FireLevel } from '../types/processing-method';
import { PROCESS_DEGREES, type ProcessBatch, type ProcessDegree } from '../types/process-batch';
import type { FeedEntry } from '../types/feed-entry';
import { DEGREE_RULES, judgeDegree, suggestedValues } from '../utils/degree';
import { activeFeedTotal, allFeedsOf, batchOutputRemaining, herbRemaining, lineageOf, round2 } from '../utils/lineage';
import { uid } from '../utils/id';

const { Title, Paragraph, Text } = Typography;

interface BatchFormValues {
  batchNo: string;
  herbId?: string;
  methodId: string;
  feedKg: number;
  auxUsedKg: number;
  outputKg: number;
  fireLevel: FireLevel;
  temp: number;
  duration: number;
  startedAt: Dayjs;
  endedAt: Dayjs;
  operator: string;
  degree: ProcessDegree;
  sources: SourceRow[];
  remark?: string;
}

const DEGREE_COLOR: Record<ProcessDegree, string> = { 不及: 'orange', 适中: 'green', 太过: 'red' };

/** 工序记录台：选方法自动带出辅料比例、火候与判断标准；逐笔登记投料来源（拆批/拼批） */
export default function BatchBoard() {
  const { message } = AntApp.useApp();
  const herbs = useHerbStore((s) => s.herbs);
  const methods = useMethodStore((s) => s.methods);
  const batches = useBatchStore((s) => s.batches);
  const feeds = useBatchStore((s) => s.feeds);
  const createBatch = useBatchStore((s) => s.createBatch);
  const updateBatch = useBatchStore((s) => s.updateBatch);
  const lockBatch = useBatchStore((s) => s.lockBatch);
  const unlockAsQc = useBatchStore((s) => s.unlockAsQc);
  const removeBatch = useBatchStore((s) => s.removeBatch);
  const withdrawFeed = useBatchStore((s) => s.withdrawFeed);

  const herbFilter = useHerbFilter();
  const [params] = useSearchParams();
  const degreeParam = params.get('degree') ?? '';

  const [form] = Form.useForm<BatchFormValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ProcessBatch | null>(null);
  const [qcMode, setQcMode] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [lineageTarget, setLineageTarget] = useState<ProcessBatch | null>(null);

  const watched = Form.useWatch([], form) as Partial<BatchFormValues> | undefined;
  const watchedMethod = methods.find((m) => m.id === (watched?.methodId ?? ''));
  const watchedSources = watched?.sources ?? [];
  const sourcesTotal = useMemo(
    () => round2(watchedSources.reduce((sum, r) => sum + (Number(r.amountKg) || 0), 0)),
    [watchedSources],
  );
  const watchedYieldRate = useMemo(() => {
    const feed = sourcesTotal;
    const out = Number(watched?.outputKg) || 0;
    if (feed <= 0) return 0;
    return Number(((out / feed) * 100).toFixed(1));
  }, [sourcesTotal, watched?.outputKg]);

  const verdict = useMemo(() => {
    if (!watchedMethod) return undefined;
    return judgeDegree({
      method: watchedMethod,
      fireLevel: (watched?.fireLevel ?? watchedMethod.fireLevel) as FireLevel,
      duration: Number(watched?.duration) || watchedMethod.duration,
      temp: Number(watched?.temp) || Math.round((watchedMethod.tempRange[0] + watchedMethod.tempRange[1]) / 2),
      yieldRate: watchedYieldRate,
    });
  }, [watchedMethod, watched?.fireLevel, watched?.duration, watched?.temp, watchedYieldRate]);

  const visibleHerbs = useMemo(() => herbFilter.apply(herbs), [herbs, herbFilter]);
  const visibleBatches = useMemo(() => {
    const ids = new Set(visibleHerbs.map((h) => h.id));
    return batches.filter((b) => {
      const touchesVisibleHerb =
        ids.has(b.herbId) || feeds.some((f) => f.active && f.batchId === b.id && f.sourceType === 'herb' && ids.has(f.sourceId));
      if (!touchesVisibleHerb) return false;
      if (degreeParam && b.degree !== degreeParam) return false;
      return true;
    });
  }, [batches, feeds, visibleHerbs, degreeParam]);

  const herbName = (id: string) => herbs.find((h) => h.id === id)?.name ?? '未知药材';
  const methodOf = (id: string) => methods.find((m) => m.id === id);
  const feedCountOf = (batchId: string) => feeds.filter((f) => f.batchId === batchId && f.active).length;
  const primaryHerbOf = (batch: ProcessBatch) => {
    const firstHerbFeed = feeds.find((f) => f.active && f.batchId === batch.id && f.sourceType === 'herb');
    return herbs.find((h) => h.id === (firstHerbFeed?.sourceId ?? batch.herbId))?.name ?? '未知药材';
  };

  const syncSourcesDerived = (rows: SourceRow[]) => {
    const total = round2(rows.reduce((sum, r) => sum + (Number(r.amountKg) || 0), 0));
    const firstHerb = rows.find((r) => r.sourceType === 'herb' && r.sourceId);
    let herbId = firstHerb?.sourceId;
    if (!herbId) {
      const upstream = rows.find((r) => r.sourceType === 'batch' && r.sourceId);
      herbId = batches.find((b) => b.id === upstream?.sourceId)?.herbId;
    }
    const patch: Partial<BatchFormValues> = { feedKg: total, herbId };
    const method = methods.find((m) => m.id === form.getFieldValue('methodId'));
    if (method) {
      patch.auxUsedKg = Number(((total * method.auxRatio) / 100).toFixed(2));
      // 已录入的炮制后重量是用户判定依据，不随来源改动强行覆盖；仅在为空时给参考值
      const currentOutput = Number(form.getFieldValue('outputKg')) || 0;
      if (currentOutput <= 0) {
        patch.outputKg = Number((total * (method.name === '蜜炙' ? 1.08 : 0.94)).toFixed(1));
      }
    }
    form.setFieldsValue(patch);
  };

  const openCreate = () => {
    setEditing(null);
    setQcMode(false);
    form.resetFields();
    const firstHerb = herbs[0];
    const firstMethod = methods[0];
    const now = dayjs();
    const defaultAmount = firstHerb ? Math.min(firstHerb.feedKg, herbRemaining(herbs, feeds, firstHerb.id), 60) || firstHerb.feedKg : 100;
    const base: Partial<BatchFormValues> = {
      batchNo: `PZ-${dayjs().format('YYMMDD')}-${String(batches.length + 1).padStart(2, '0')}`,
      herbId: firstHerb?.id,
      methodId: firstMethod?.id,
      feedKg: defaultAmount,
      outputKg: Number((defaultAmount * 0.94).toFixed(1)),
      auxUsedKg: Number(((defaultAmount * (firstMethod?.auxRatio ?? 0)) / 100).toFixed(2)),
      fireLevel: firstMethod?.fireLevel ?? '文火',
      temp: firstMethod ? Math.round((firstMethod.tempRange[0] + firstMethod.tempRange[1]) / 2) : 100,
      duration: firstMethod?.duration ?? 12,
      startedAt: now.subtract(20, 'minute'),
      endedAt: now,
      operator: '陈玉兰',
      degree: '适中',
      sources: [{ key: uid('row'), sourceType: 'herb', sourceId: firstHerb?.id ?? '', amountKg: defaultAmount }],
    };
    form.setFieldsValue(base as unknown as BatchFormValues);
    setOpen(true);
  };

  const openEdit = (record: ProcessBatch) => {
    setEditing(record);
    setQcMode(false);
    form.resetFields();
    const suggested = methodOf(record.methodId);
    const rows: SourceRow[] = feeds
      .filter((f) => f.batchId === record.id && f.active)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((f) => ({ key: f.id, sourceType: f.sourceType, sourceId: f.sourceId, amountKg: f.amountKg, remark: f.remark }));
    form.setFieldsValue({
      batchNo: record.batchNo,
      herbId: record.herbId,
      methodId: record.methodId,
      feedKg: record.feedKg,
      auxUsedKg: record.auxUsedKg,
      outputKg: Number(((record.feedKg * record.yieldRate) / 100).toFixed(1)),
      fireLevel: record.fireLevel,
      temp: suggested ? Math.round((suggested.tempRange[0] + suggested.tempRange[1]) / 2) : 100,
      duration: suggested?.duration ?? 12,
      startedAt: dayjs(record.startedAt),
      endedAt: dayjs(record.endedAt),
      operator: record.operator,
      degree: record.degree,
      remark: record.remark,
      sources: rows.length > 0 ? rows : [{ key: uid('row'), sourceType: 'herb', sourceId: record.herbId, amountKg: record.feedKg }],
    } as unknown as BatchFormValues);
    setOpen(true);
  };

  const buildSourcesPayload = (rows: SourceRow[]): SourceAllocationInput[] =>
    rows.map((row) => ({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      amountKg: Number(row.amountKg) || 0,
      remark: row.remark?.trim() || undefined,
    }));

  const submit = async () => {
    const values = await form.validateFields();
    const rows = values.sources ?? [];
    if (rows.length === 0) {
      message.error('请至少登记一笔投料来源');
      return;
    }
    const invalid = rows.findIndex((r) => !r.sourceId || !(Number(r.amountKg) > 0));
    if (invalid >= 0) {
      message.error(`第 ${invalid + 1} 笔来源未选择批次或投入量无效`);
      return;
    }
    const sources = buildSourcesPayload(rows);
    const feedKg = round2(sources.reduce((sum, s) => sum + s.amountKg, 0));
    const outputKg = Number(values.outputKg) || 0;
    if (feedKg <= 0) {
      message.error('投料量必须大于 0');
      return;
    }
    const yieldRate = Number(((outputKg / feedKg) * 100).toFixed(1));
    const firstHerb = sources.find((s) => s.sourceType === 'herb');
    const herbId = firstHerb?.sourceId ?? batches.find((b) => b.id === sources.find((s) => s.sourceType === 'batch')?.sourceId)?.herbId ?? '';
    const payload = {
      batchNo: values.batchNo,
      herbId,
      methodId: values.methodId,
      feedKg,
      auxUsedKg: Number(values.auxUsedKg) || 0,
      fireLevel: values.fireLevel,
      startedAt: values.startedAt.toISOString(),
      endedAt: values.endedAt.toISOString(),
      yieldRate,
      degree: values.degree,
      operator: values.operator,
      remark: values.remark,
      // 锁定工序质检改判时不带来源（来源不可调整）；未锁定工序逐笔重分配
      sources: editing?.locked ? undefined : sources,
    };
    try {
      if (editing) {
        const ok = await updateBatch(editing.id, payload, qcMode);
        if (!ok) {
          message.error('该批已锁定，请打开「质检员改判」后再提交');
          return;
        }
        if (qcMode && editing.locked) {
          await unlockAsQc(editing.id, '质检员 · 赵敏');
        }
        message.success(`已更新 ${payload.batchNo}，得率 ${yieldRate}%`);
      } else {
        await createBatch(payload, true);
        message.success(`已提交 ${payload.batchNo}，得率 ${yieldRate}%，该批已锁定`);
      }
      setOpen(false);
    } catch (error) {
      // 余额校验失败时事务已回滚，原分配保持不变，可直接修正后重试
      message.error((error as Error).message);
    }
  };

  const handleRemove = async (record: ProcessBatch) => {
    try {
      await removeBatch(record.id);
      message.success(`已删除 ${record.batchNo}，其投料来源已逐笔恢复`);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleLock = async (record: ProcessBatch) => {
    try {
      await lockBatch(record.id);
      message.success('已锁定该批');
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const handleWithdraw = async (entry: FeedEntry) => {
    try {
      await withdrawFeed(entry.id);
      message.success('已撤回该笔来源，其余来源与工序保留，可重新分配后重试');
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const columns: TableColumnsType<ProcessBatch> = [
    { title: '生产批号', dataIndex: 'batchNo', width: 130, render: (v: string) => <Text strong>{v}</Text> },
    { title: '药材', width: 90, render: (_, record) => primaryHerbOf(record) },
    { title: '方法', dataIndex: 'methodId', width: 90, render: (id: string) => methodOf(id)?.name ?? '-' },
    {
      title: '投料来源',
      width: 120,
      align: 'center',
      render: (_, record) => (
        <Button size="small" type="link" onClick={() => setLineageTarget(record)}>
          {feedCountOf(record.id)} 笔
          {feedCountOf(record.id) > 1 ? <Tag color="purple" style={{ marginInlineStart: 4 }}>拼批</Tag> : null}
        </Button>
      ),
    },
    {
      title: '火候',
      dataIndex: 'fireLevel',
      width: 180,
      render: (v: FireLevel, record) => <FireLevelTag level={v} tempRange={methodOf(record.methodId)?.tempRange} duration={methodOf(record.methodId)?.duration} />,
    },
    { title: '投料(kg)', dataIndex: 'feedKg', width: 90, align: 'right' },
    { title: '辅料(kg)', dataIndex: 'auxUsedKg', width: 90, align: 'right' },
    { title: '得率(%)', dataIndex: 'yieldRate', width: 90, align: 'right', render: (v: number) => <Text type={v < 85 ? 'danger' : undefined}>{v}</Text> },
    { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
    {
      title: '状态',
      dataIndex: 'locked',
      width: 100,
      render: (locked: boolean, record) =>
        locked ? <Tag color="blue">已锁定{record.qcBy ? ` · ${record.qcBy}` : ''}</Tag> : <Tag>待判定</Tag>,
    },
    { title: '操作人', dataIndex: 'operator', width: 90 },
    {
      title: '操作',
      width: 230,
      fixed: 'right',
      render: (_, record) => (
        <Space size={2}>
          <Button size="small" type="link" onClick={() => openEdit(record)}>
            {record.locked ? '质检改判' : '编辑'}
          </Button>
          {!record.locked ? (
            <Button size="small" type="link" onClick={() => handleLock(record)}>
              锁定
            </Button>
          ) : (
            <Button size="small" type="link" onClick={() => unlockAsQc(record.id, '质检员 · 赵敏').then(() => message.success('质检员已放行，可重新编辑'))}>
              放行
            </Button>
          )}
          <Popconfirm
            title={`确认删除 ${record.batchNo}？`}
            description="已锁定或已登记留样的工序不可删除"
            onConfirm={() => handleRemove(record)}
          >
            <Button size="small" type="link" danger disabled={record.locked}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const drawerFeeds = lineageTarget ? allFeedsOf(feeds, lineageTarget.id) : [];
  const drawerLineage = lineageTarget ? lineageOf({ herbs, batches, feeds }, lineageTarget) : [];

  const drawerColumns: TableColumnsType<FeedEntry> = [
    {
      title: '来源',
      render: (_, entry) =>
        entry.sourceType === 'herb' ? (
          herbs.find((h) => h.id === entry.sourceId) ? `${herbName(entry.sourceId)} · ${herbs.find((h) => h.id === entry.sourceId)?.batchNo}` : `药材 ${entry.sourceId}`
        ) : (
          <Space size={4}>
            <Tag color="geekblue">上游工序</Tag>
            {batches.find((b) => b.id === entry.sourceId)?.batchNo ?? entry.sourceId}
          </Space>
        ),
    },
    { title: '投入量(kg)', dataIndex: 'amountKg', width: 100, align: 'right' },
    {
      title: '当前剩余(kg)',
      width: 120,
      align: 'right',
      render: (_, entry) =>
        entry.sourceType === 'herb'
          ? herbRemaining(herbs, feeds, entry.sourceId, entry.id)
          : batchOutputRemaining(batches, feeds, entry.sourceId, entry.id),
    },
    {
      title: '分配时快照剩余(kg)',
      dataIndex: 'remainAfterKg',
      width: 150,
      align: 'right',
    },
    { title: '班组/说明', dataIndex: 'remark', width: 110, render: (v?: string) => v ?? '-' },
    {
      title: '状态',
      width: 150,
      render: (_, entry) =>
        entry.active ? (
          <Space size={4}>
            <Tag color="green">有效</Tag>
            {!lineageTarget?.locked ? (
              <Popconfirm
                title="撤回该笔投料来源？"
                description="只撤回这一笔，其余来源与本工序保留；来源剩余量恢复"
                onConfirm={() => handleWithdraw(entry).then(() => {})}
              >
                <Button size="small" type="link" danger>
                  撤回
                </Button>
              </Popconfirm>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                已锁定不可撤
              </Text>
            )}
          </Space>
        ) : (
          <Tag color="default">已于 {entry.withdrawnAt?.slice(0, 10) ?? '-'} 撤回</Tag>
        ),
    },
  ];

  return (
    <div>
      <Title level={3} style={{ marginBottom: 4 }}>
        炮制工序记录台
      </Title>
      <Paragraph type="secondary">
        同规格药材可拆批分投、多批拼批炮制；逐笔登记来源批次、投入量与剩余量，可追溯完整来源谱系。提交后锁定该批，已锁定批次及其留样不可删除、来源不可撤回。
      </Paragraph>

      <Space style={{ marginBottom: 12 }} wrap>
        <Button type="primary" onClick={openCreate}>
          新建工序记录
        </Button>
        <Button onClick={() => setShowRules((v) => !v)}>{showRules ? '收起程度判定规则' : '查看程度判定规则'}</Button>
      </Space>

      {showRules ? (
        <Card size="small" style={{ marginBottom: 12 }} title="炮制程度判定规则">
          <Table
            rowKey="degree"
            size="small"
            pagination={false}
            dataSource={DEGREE_RULES}
            columns={[
              { title: '程度', dataIndex: 'degree', width: 90, render: (v: ProcessDegree) => <Tag color={DEGREE_COLOR[v]}>{v}</Tag> },
              { title: '判定条件', dataIndex: 'condition' },
              { title: '处置', dataIndex: 'action', width: 280 },
            ]}
          />
        </Card>
      ) : null}

      <FilterBar
        fields={[
          { key: 'origin', label: '基原', options: HERB_ORIGINS, width: 110 },
          { key: 'part', label: '药用部位', options: HERB_PARTS, width: 110 },
          { key: 'degree', label: '程度', options: PROCESS_DEGREES, width: 110 },
        ]}
        resultCount={visibleBatches.length}
        totalCount={batches.length}
        keywordPlaceholder="搜索药材名 / 批号"
      />

      {visibleBatches.length === 0 ? (
        <EmptyPanel description="没有符合条件的工序记录" actionText="新建一条工序记录" onAction={openCreate} />
      ) : (
        <Table rowKey="id" size="small" columns={columns} dataSource={visibleBatches} pagination={{ pageSize: 10 }} scroll={{ x: 1500 }} />
      )}

      <Modal
        open={open}
        title={editing ? `工序记录 · ${editing.batchNo}` : '新建炮制工序记录'}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText={editing ? '保存' : '提交并锁定该批'}
        cancelText="取消"
        width={820}
      >
        <Form
          form={form}
          layout="vertical"
          onValuesChange={(changed) => {
            if ('sources' in changed) {
              syncSourcesDerived(changed.sources as SourceRow[]);
            }
            if ('methodId' in changed) {
              const method = methods.find((m) => m.id === changed.methodId);
              if (method) {
                const suggestion = suggestedValues(method);
                const feed = (form.getFieldValue('feedKg') as number) || 0;
                form.setFieldsValue({
                  fireLevel: method.fireLevel,
                  temp: suggestion.temp,
                  duration: suggestion.duration,
                  auxUsedKg: Number(((feed * method.auxRatio) / 100).toFixed(2)),
                } as unknown as Partial<BatchFormValues>);
              }
            }
            if (verdict && ('temp' in changed || 'duration' in changed || 'outputKg' in changed)) {
              form.setFieldsValue({ degree: verdict.degree } as unknown as Partial<BatchFormValues>);
            }
          }}
        >
          {editing?.locked ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="该批得率与程度已锁定；质检改判只调整判定信息，投料来源不可变更"
              action={<Switch checkedChildren="质检员改判" unCheckedChildren="只读" checked={qcMode} onChange={setQcMode} />}
            />
          ) : null}

          <Form.Item name="batchNo" label="生产批号" rules={[{ required: true, message: '请输入生产批号' }]}>
            <Input maxLength={24} disabled={Boolean(editing?.locked) && !qcMode} />
          </Form.Item>

          <Form.Item name="methodId" label="炮制方法" rules={[{ required: true, message: '请选择炮制方法' }]}>
            <Select
              disabled={Boolean(editing?.locked) && !qcMode}
              options={methods.map((m) => ({ label: `${m.name} · ${m.auxiliary} ${m.auxRatio}kg/100kg`, value: m.id }))}
            />
          </Form.Item>

          {watchedMethod ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                <Space wrap size={8}>
                  <span>辅料比例 {watchedMethod.auxRatio}kg/100kg</span>
                  <FireLevelTag level={watchedMethod.fireLevel} tempRange={watchedMethod.tempRange} duration={watchedMethod.duration} />
                  <Tag>{watchedMethod.criterionDimension}</Tag>
                </Space>
              }
              description={`判断标准：${watchedMethod.criterion}；适用药材：${watchedMethod.applicable}`}
            />
          ) : null}

          <Card
            size="small"
            style={{ marginBottom: 12 }}
            title="投料来源（逐笔登记，支持拆批/拼批）"
            extra={editing?.locked ? <Tag color="blue">已锁定，来源只读</Tag> : undefined}
          >
            <Form.Item
              name="sources"
              noStyle
              rules={[
                {
                  validator: (_, rows: SourceRow[]) => {
                    if (!rows || rows.length === 0) return Promise.reject(new Error('至少登记一笔投料来源'));
                    const bad = rows.some((r) => !r.sourceId || !(Number(r.amountKg) > 0));
                    if (bad) return Promise.reject(new Error('每笔来源都要选择批次并填写大于 0 的投入量'));
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <SourceFeedsEditor
                herbs={herbs}
                batches={batches}
                feeds={feeds}
                selfBatchId={editing?.id}
                disabled={Boolean(editing?.locked)}
              />
            </Form.Item>
          </Card>

          <RatioCalculator
            auxRatio={watchedMethod?.auxRatio ?? 0}
            auxiliary={watchedMethod?.auxiliary ?? '无'}
            feedKg={sourcesTotal}
            auxUsedKg={Number(watched?.auxUsedKg) || 0}
            outputKg={Number(watched?.outputKg) || 0}
            onChange={(patch) => {
              // 总投料量由来源笔合计决定，此处仅同步辅料；反向推算只给辅料参考
              if (patch.auxUsedKg !== undefined) {
                form.setFieldsValue({ auxUsedKg: patch.auxUsedKg } as unknown as Partial<BatchFormValues>);
              }
            }}
          />

          <Space size={12} style={{ display: 'flex', marginTop: 12 }} align="start">
            <Form.Item name="fireLevel" label="火力" rules={[{ required: true, message: '请选择火力' }]}>
              <Select style={{ width: 120 }} disabled={Boolean(editing?.locked) && !qcMode} options={FIRE_LEVELS.map((v) => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="temp" label="实际锅温(℃)" rules={[{ required: true, message: '请输入实际锅温' }]}>
              <InputNumber min={0} max={800} style={{ width: 140 }} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
            <Form.Item name="duration" label="炮制时长(min)" rules={[{ required: true, message: '请输入炮制时长' }]}>
              <InputNumber min={0} style={{ width: 140 }} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
            <Form.Item name="outputKg" label="炮制后重量(kg)" rules={[{ required: true, message: '请输入炮制后重量' }]}>
              <InputNumber min={0} step={0.5} style={{ width: 150 }} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
          </Space>

          <Form.Item name="feedKg" hidden>
            <InputNumber />
          </Form.Item>
          <Form.Item name="herbId" hidden>
            <Input />
          </Form.Item>

          <Alert
            type={verdict?.degree === '适中' ? 'success' : verdict?.degree === '太过' ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={`系统判定：${verdict?.degree ?? '待录入火候与得率'}（得率 ${watchedYieldRate}%，预期 ${verdict?.expectedYield ?? '-'}%）`}
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {(verdict?.reasons ?? ['选择方法并录入锅温、时长、炮制后重量后自动判定']).map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />

          <Form.Item name="degree" label="程度判定（可按判断标准复核后修改）" rules={[{ required: true, message: '请选择程度' }]}>
            <Select disabled={Boolean(editing?.locked) && !qcMode} options={PROCESS_DEGREES.map((v) => ({ label: v, value: v }))} />
          </Form.Item>

          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item name="startedAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
            <Form.Item name="endedAt" label="结束时间" rules={[{ required: true, message: '请选择结束时间' }]}>
              <DatePicker showTime style={{ width: 190 }} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
            <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
              <Input style={{ width: 140 }} maxLength={16} disabled={Boolean(editing?.locked) && !qcMode} />
            </Form.Item>
          </Space>

          <Form.Item name="remark" label="备注">
            <Input.TextArea rows={2} maxLength={80} disabled={Boolean(editing?.locked) && !qcMode} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        open={Boolean(lineageTarget)}
        title={`投料来源谱系 · ${lineageTarget?.batchNo ?? ''}`}
        width={720}
        onClose={() => setLineageTarget(null)}
        extra={
          lineageTarget?.locked ? <Tag color="blue">工序已锁定，来源不可撤回</Tag> : <Tag color="orange">未完成工序，可逐笔撤回后重试</Tag>
        }
      >
        {lineageTarget ? (
          <Space direction="vertical" size={16} style={{ display: 'flex' }}>
            <Card size="small">
              <LineageTree nodes={drawerLineage} />
            </Card>
            <div>
              <Text strong>逐笔投料台账</Text>
              <Text type="secondary">（合计投入 {activeFeedTotal(feeds, lineageTarget.id)}kg，含已撤回痕迹）</Text>
            </div>
            <Table rowKey="id" size="small" columns={drawerColumns} dataSource={drawerFeeds} pagination={false} />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
