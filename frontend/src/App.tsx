import { useEffect, useState } from 'react';
import { Layout, Menu, Spin, Typography, App as AntApp, Button, Space, Upload } from 'antd';
import type { UploadProps } from 'antd';
import {
  ExperimentOutlined,
  FireOutlined,
  InboxOutlined,
  ProfileOutlined,
  DashboardOutlined,
  DownloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { seedIfEmpty } from './utils/seed';
import { useHerbStore } from './stores/herbStore';
import { useMethodStore } from './stores/methodStore';
import { useBatchStore } from './stores/batchStore';
import { useSampleStore } from './stores/sampleStore';
import { useFeedStore } from './stores/feedStore';
import { downloadText, exportBackupJson, importBackup } from './utils/export';

const { Header, Sider, Content, Footer } = Layout;
const { Title, Text } = Typography;

const MENU_ITEMS = [
  { key: '/', icon: <DashboardOutlined />, label: <Link to="/">首页总览</Link> },
  { key: '/herbs', icon: <ExperimentOutlined />, label: <Link to="/herbs">药材台账</Link> },
  { key: '/methods', icon: <FireOutlined />, label: <Link to="/methods">炮制方法</Link> },
  { key: '/batches', icon: <ProfileOutlined />, label: <Link to="/batches">工序记录台</Link> },
  { key: '/samples', icon: <InboxOutlined />, label: <Link to="/samples">留样台账</Link> },
];

/** 应用外壳：左侧导航 + 顶部导出/恢复备份，负责一次性的本地数据装载 */
export default function App() {
  const { message, modal } = AntApp.useApp();
  const [ready, setReady] = useState(false);
  const hydrateHerbs = useHerbStore((s) => s.hydrate);
  const hydrateMethods = useMethodStore((s) => s.hydrate);
  const hydrateBatches = useBatchStore((s) => s.hydrate);
  const hydrateSamples = useSampleStore((s) => s.hydrate);
  const hydrateFeeds = useFeedStore((s) => s.hydrate);
  const location = useLocation();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await seedIfEmpty();
        await Promise.all([hydrateHerbs(), hydrateMethods(), hydrateBatches(), hydrateSamples(), hydrateFeeds()]);
      } catch (error) {
        message.error(`本地数据装载失败：${(error as Error).message}`);
      } finally {
        if (alive) {
          setReady(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrateHerbs, hydrateMethods, hydrateBatches, hydrateSamples, hydrateFeeds, message]);

  const selectedKey = MENU_ITEMS.map((item) => item.key)
    .filter((key) => (key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)))
    .sort((a, b) => b.length - a.length)[0] ?? '/';

  const handleExport = async () => {
    const json = await exportBackupJson();
    downloadText(`gbherbprocess-backup-${new Date().toISOString().slice(0, 10)}.json`, json);
    message.success('已导出含投料谱系的全量 JSON 备份');
  };

  const uploadProps: UploadProps = {
    accept: 'application/json,.json',
    showUploadList: false,
    beforeUpload: async (file) => {
      modal.confirm({
        title: '恢复备份将覆盖当前全部本地数据',
        content: '旧版单来源备份会自动补成单节点谱系，恢复后各页面与再次导出均含完整来源。确认继续？',
        okText: '覆盖恢复',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: async () => {
          try {
            const text = await file.text();
            const counts = await importBackup(text);
            await Promise.all([hydrateHerbs(), hydrateMethods(), hydrateBatches(), hydrateSamples(), hydrateFeeds()]);
            message.success(
              `备份已恢复：药材 ${counts.herbs}、方法 ${counts.methods}、工序 ${counts.batches}、留样 ${counts.samples}、投料谱系 ${counts.feeds} 笔`,
            );
          } catch (error) {
            message.error(`恢复失败（原数据未改动）：${(error as Error).message}`);
          }
        },
      });
      return false;
    },
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0" width={208} style={{ background: '#1f4d2e' }}>
        <div style={{ padding: '16px 16px 8px' }}>
          <Title level={5} style={{ color: '#fff', margin: 0 }}>
            炮制工序记录台
          </Title>
          <Text style={{ color: '#a9c9b2', fontSize: 12 }}>gbherbprocess · 纯前端本地存储</Text>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[selectedKey]} items={MENU_ITEMS} style={{ background: 'transparent' }} />
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text strong>中草药炮制工序记录台</Text>
          <Space>
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />}>恢复备份</Button>
            </Upload>
            <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport}>
              导出备份
            </Button>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          {ready ? (
            <Outlet />
          ) : (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
              <Spin size="large" />
            </div>
          )}
        </Content>
        <Footer style={{ textAlign: 'center', color: '#8c9a90', padding: '12px 0' }}>
          数据保存在浏览器 IndexedDB（gbherbprocess-db），不依赖后端服务
        </Footer>
      </Layout>
    </Layout>
  );
}
