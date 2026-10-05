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
| 状态 | Zustand（herbStore / methodStore / batchStore / sampleStore） |
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
│       ├── types/             # herb-material / processing-method / process-batch / retain-sample / feed-entry
│       ├── stores/            # herbStore / methodStore / batchStore / sampleStore
│       ├── components/common/ # RatioCalculator / FireLevelTag / CabinetGrid / FilterBar / StatBadge / ProcessTimeline / EmptyPanel / LineageTree / SourceFeedsEditor
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
| `/batches` | 工序记录台 | 选方法自动带出辅料比例/火候/判断标准，录入火候与得率并判定程度 |
| `/samples` | 留样台账 | 柜位网格、到期提醒、按日期追加观察记录 |

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbherbprocess-db`），表：`herbs`、`methods`、`batches`、`samples`、`feeds`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为 `batches` 增加 `locked` 索引并回填历史数据；`db.version(3).upgrade(...)` 新增 `feeds` 逐笔投料关系表，旧工序只有 `herbId + feedKg` 单来源，升级时按该记录补一笔来源（投入量=feedKg），形成单节点谱系，留样与备份恢复后都能查回投入。
- **投料追溯**：一个工序可挂多笔来源（同规格药材拆批分投两个班组、多批拼批合并炮制），每笔记录来源（药材批次或上游工序产出）、投入量、分配时剩余量快照；实时剩余量由全部有效记录滚动计算。来源可来自上游工序产出，谱系递归展开到最初药材批次。
- **事务与撤回**：新建/重新分配在单个 Dexie 事务内完成余额读取与逐笔写入，任一笔超出剩余量即整体回滚，恢复原分配；撤回只把该笔置为 `active=false`，只影响这一笔、其他笔与工序保留，未完成工序可重新分配后重试。已锁定工序及其留样不可删除、来源不可撤回；已登记留样的工序也不可删除。
- 顶栏可「导出备份 / 恢复备份」，备份含 `feeds`；恢复后逐笔记录与完整谱系立即可见。升级前建议先导出全量 JSON。
- 首次打开且表为空时写入一批示例台账（`src/utils/seed.ts`），其中包含一批投两班组（白术 80/40、黄芪 120/120）、拼批（蜜炙黄芪 120 + 甘草 50）与以上游工序产出再投料的示例，便于直接查看谱系效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。

## 脚本

- `scripts/verify-feeds.ts`：基于 fake-indexeddb 的端到端校验（拆批/拼批、超额回滚、单笔撤回、锁定与留样保护、多层谱系、v2→v3 升级、备份往返）。运行：`npx esbuild scripts/verify-feeds.ts --bundle --platform=node --format=esm --outfile=/tmp/verify.mjs && node /tmp/verify.mjs`（依赖 `fake-indexeddb`，仅校验时临时安装）。
