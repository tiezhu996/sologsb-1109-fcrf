# 中草药炮制工序记录台（gbherbprocess）

面向中药饮片厂炮制班组与质检员：登记药材批次、按炮制方法折算辅料比例与火力时间、逐批判定炮制程度、管理留样观察台账。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21809>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | Ant Design 5 + @ant-design/icons |
| 路由 | React Router 6（5 条路由） |
| 状态 | Zustand（herbStore / methodStore / batchStore / sampleStore / feedStore） |
| 存储 | IndexedDB（Dexie，库名 `gbherbprocess-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21809
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # herb-material / processing-method / process-batch / retain-sample / feed
│       ├── stores/            # herbStore / methodStore / batchStore / sampleStore / feedStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel / FeedSourcesEditor / FeedLineageList
│       ├── hooks/             # useHerbFilter / useRatio
│       ├── pages/             # ProcessBoard / HerbList / MethodList / BatchBoard / SampleLedger
│       ├── router/index.tsx   # 路由表
│       └── utils/             # db.ts / degree.ts / export.ts / seed.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 首页总览 | 待炮制批次、留样到期提示、最近工序时间线、平均得率 |
| `/herbs` | 药材台账 | 药材与批次登记，按基原/药用部位筛选，按药材分组汇总 |
| `/methods` | 炮制方法 | 辅料比例、火力与判断标准维护，辅料折算台与复制派生 |
| `/batches` | 工序记录台 | 多来源逐笔投料（拆批/拼批/与另一批合并），选方法自动带出辅料比例/火候/判断标准，录入火候与得率并判定程度；来源谱系抽屉可逐笔撤回 |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`samples`、`feeds`、`meta`。
- 投料谱系表 `feeds` 逐笔记录每道工序的来源（药材批次或上道工序成品）、投入量与入账后剩余量：同规格药材可拆批分给两个班组、多批拼批、与另一批成品合并炮制。
- `db.version(1)` 建表声明索引；`version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填；`version(3).upgrade(...)` 建 `feeds` 表并为旧单来源批次**补建单节点谱系**，逐笔重算剩余量。升级前可用顶栏「导出备份」导出全量 JSON。
- 顶栏「恢复备份」读取 JSON：恢复在单事务内完成，旧版无 `feeds` 的备份同样自动补成单节点谱系，恢复后页面与再次导出都能看到完整来源。
- 分配规则：拼批/拆分整单在一个 Dexie 事务内校验余量并提交，任一来源余量不足即回滚、原分配不变；逐笔撤回只退回这一笔，已锁定工序及其留样不可撤回/删除，未完成工序保留原分配供重试。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`，内含拆批、拼批、合并炮制与单笔撤回待重试示例），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 本地校验

```bash
cd frontend
npm install
npm test       # 账本纯函数（17 项）+ Dexie 端到端流程（29 项），基于 fake-indexeddb
npm run build  # 类型检查 + 生产构建
```
