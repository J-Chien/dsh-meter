# dsh-meter 审查报告（第二轮 · 全面复查）

> 审查人：k3 审查 agent（host/client 两路并行）+ 主会话逐条复核 · 日期：2026-08-18
> 范围：全部源码（host/client 半区、shared、构建配置、测试）+ docs 全量 · 基线：`pnpm typecheck` / `pnpm test` 绿
> **状态：发现的问题已全部修复或显性记录（v0.3.16，见 `docs/prd/CHANGELOG.md`）**；每条注明「已修 / 文档化 / 暂缓」与理由。
> 上一轮 review-k3-0816 的全部 P0/P1 已确认修复落实，无回退，不再重复列出。

## 总体评价

计价核心（`price.ts` / `session-stats.ts` 纯函数折叠）质量高：整数精度、分段取档边界、有界投影的实现均经核实正确且有测试覆盖。本轮发现的真问题集中在**两类口径裂缝**：① 有的真实消耗根本不在计价路径上（压缩摘要调用）；② 同一语义在多处各写一份导致漂移（effort 匹配、触发阈值、增长序列对齐）。文档侧的主要问题是 PRD 与代码/README 的口径漂移（FR 缺失、数据模型缺字段、交互常量过时）。

## 已修复（v0.3.16）

### Host

| # | 问题 | 修法 |
|---|---|---|
| H1 | **压缩摘要调用的真实 usage 被丢弃**：`compaction/summary` 带 `provider/model/usage`（一次性 `ctx.llm.stream()`，不产生 `assistant/message`），这笔（往往很大的）费用完全没计入会话——而发生压缩的恰是最贵的会话 | 折叠时按事件自身的 provider/model/time 计价，计入费用总额与空闲/高峰拆分；token 累计在 `compactions.tokens`/`compactions.cost`（**不进会话 token 桶**，避免一次性重读稀释命中率语义），卡片压缩历史行展示「摘要花费」。`src/host/session-stats.ts` |
| H2 | **改价后冷读可复活旧价格**：投影 checkpoint 以 `stateVersion` 判定可用性，而价格表不参与版本——改价只清内存 cell，磁盘 checkpoint 仍以旧价格为种子 | 价格表内容哈希（FNV-1a）混入 `stateVersion`（`STATE_VERSION_BASE * 2^20 + hash % 2^20`）：改价即失效全量重折；同表同版本，重启后 checkpoint 仍有效。`src/host/index.ts` |
| H3 | **折叠状态持有整个 `EpochHeader`**：system prompt/工具 schema（数十 KB 敏感文本）随 checkpoint 冗余落盘，折叠只用 `header.config` | `BillingFoldState` 改存 `config`。`src/host/session-stats.ts`（stateVersion base 7→8） |
| H4 | **reasoningEffort 行匹配顺序依赖**：`find` 数组序优先，通用行在前则 effort 专属价永不生效；无 effort 请求会误中 effort 行。同一谓词在 host 折叠、高峰检测、client 标签三处各写一份 | 共享 `findPriceRow`（shared.ts）：effort 精确匹配优先、无 effort 请求只命中通用行；三处统一调用 |
| H5 | **跨天窗口 × `days` 组合语义错误**：「周五 22:00–06:00」的周六凌晨段按当天星期几过滤被排除 | `inPeakWindow` 改为按**窗口起始日**判定（凌晨段归前一日的窗口）；起止相同 = 全天（文档化）。`src/shared.ts` |
| H6 | **CSRF 写入面**：fence 只查 Host，跨域网页可用 `no-cors` simple request 改写本地价格表 | fence 增加 `sec-fetch-site`（拒 cross-site）+ `content-type: application/json` 检查（跨域 simple request 无法设置，设置则触发本服务器不应答的 preflight）。`src/host/fence.ts` |
| H7 | `settings.update` schema 校验失败返回 500 | 包成 `BillingRouteError('bad-payload', …, 400)` |
| H8 | 未登记请求的 turn 行币种硬编码 `'CNY'`，多币种聚合错位 | 直接用 `priceRequest` 返回的 provider 币种 |

### Client

| # | 问题 | 修法 |
|---|---|---|
| C1 | **悬浮卡片首次打开高度未测量**，防溢出翻转分支首次永不生效（卡片渲染条件是 `open && pos !== null`，首次 place 时卡片未挂载） | `open` 即渲染（`pos === null` 时 `visibility: hidden`），layout effect 首次即可实测；卡片宽度改 `offsetWidth` 实测（去硬编码 320）；挂 ResizeObserver 跟随内容高度变化 |
| C2 | **逐轮面板分组头部跨币种加总假数**（`¥`+`$` 直接相加、符号取最后一个请求） | 分组头部费用按币种并列（`¥1.20 + $0.35`，与徽标同口径） |
| C3 | **修改已在用模型的高峰窗口后，徽标高峰标签永远用旧表**（价格表只在 peakModels 集合变化时重取） | 设置页保存成功广播 `billing:pricing-updated`，徽标监听即重取价格表 |
| C4 | **迷你图增长序列多币种错列**（`aggregateTurns` 按 turn:currency 分键、`turnGrowths` 按轮产一条，下标对齐错位）+ 多币种轮次 React key 冲突 | 新增 `turnGrowthByTurn`（按轮号键控，shared.ts）；key 改 `turn:currency` |
| C5 | **旧数据高峰窗口（模型有分段、窗口无分段）的首次价格编辑被吞**（播种 tiers[0] 用编辑前旧平价） | 播种时一并写入用户输入值 |
| C6 | **`endHour` 可输入 0**，host schema 要求 ≥1，保存必 400 且无法定位原因 | `HourInput` 增加 `min` prop，结束时间 clamp [1, 24] |
| C7 | **`buildEditor` 用 effort 行播种**，保存时派生出一条新无 effort 行（配置一拆二，改价看似不生效） | 只播种无 effort 行；effort 行仍由保存合并逻辑原样保留 |
| C8 | 压缩触发线用原生 `title`（违反插件自定的 Tooltip 单一事实源） | 改统一 `<Tooltip>` |
| C9 | 触发阈值硬编码 `0.8`/`'80%'` 两处 | 统一 `COMPACT_TRIGGER_RATIO`（shared.ts） |
| C10 | 小项：`formatTokens` 进位 1000K → `1.00M`；`savedFlash` 定时器清理；详情面板刷新 fetch 卸载保护；全角冒号进 locales；删死代码（6 个无引用 locale 键、未用 `NS` 导入）；注释漂移修正（TurnBar/ContextBar/dominant currency/refresh 路由） | 均已处理 |

### 工程

- 版本号对齐：`package.json` 0.2.6 → **0.3.16**（迭代记录已到 v0.3.15，版本号两轮漂移）。
- `dsh-llm` 补入 peerDependencies（host `ctx.llm` 的类型来源，原仅 devDependencies）。
- 删除 `src/shared.ts` 无调用方的 `currentTurnOf`；`src/index.ts` 重复导出 `PRICING_NS` 清理；`assertEmptyBillingStats` 补全（原漏查 7 个字段）。
- 测试新增五组：EFFORT PRECEDENCE / OVERNIGHT DAYS / FENCE / UNPRICED CURRENCY / TURN GROWTH MAP，加 compaction 计价断言。`pnpm typecheck && pnpm test && pnpm build` 全绿。

## 文档化（不改代码，已写进 README/PRD）

| # | 事项 | 处置 |
|---|---|---|
| D1 | **首次保存后内置默认表更新不再生效**：user 层整表 wholesale 覆盖 base（dsh-settings 数组合并语义），插件升级的价格修正对老用户不可见。修复需要超出 settings 分层的 per-model 合并，收益/复杂度不划算 | README 已知限制新增一条 |
| D2 | `startHour === endHour` = 全天高峰（原静默行为） | PRD FR-4 / README 明确语义 |
| D3 | 压缩摘要 token 不进会话 token 桶、逐轮明细无摘要行（费用总额 = 逐轮明细 + 摘要花费） | PRD FR-8 / README 注明口径 |

## 暂缓（记录在案，未动）

| # | 事项 | 理由 |
|---|---|---|
| S1 | **内置默认价格表未逐一核实**（wpsai 12 模型 + zai 5 个 GLM 分段价） | 本环境无法对照官方价格页；内部一致性（半开区间、边界连续、cacheWrite=0 与「限时免费」一致）已验证。**建议发布前人工对照 bigmodel.cn/pricing 与各模型官网复核**——默认表只是默认值，用户可在设置页覆盖，风险可控 |
| S2 | 冷折叠 O(n²)（`cloneStats` 每事件复制 turns 数组，改价重折万级请求日志时平方级拷贝） | 修复需可变累积器 + 跨事件不可变快照双路径，与 v0.3.5「计价公式单点」的防漂移原则冲突；实际会话规模下未见性能问题。若长会话改价卡顿再处理 |
| S3 | `catalog` 路由无超时（adapter `resolveModelInfo` 挂起会拖住设置页加载） | 未观察到真实挂起（adapter 目录查找是本地操作）；出现时再加 `Promise.race` 超时 |
| S4 | 压缩后迷你图负增长 tooltip 显示「新增占用 -512K」 | 数值如实（快照回落即负增长），措辞可再打磨；无伤正确性 |
| S5 | 设置页时段/分段行用数组下标作 React key，删除靠前项时聚焦草稿可能提交错位 | 概率低（需删除瞬间聚焦中），消除需引入稳定 id；记录待下次动该组件时处理 |
| S6 | host 冒烟：本轮 host 改动（compaction 计价、stateVersion 哈希、状态瘦身）需重启 `dsh web` 后在真实 GUI 验证一遍（卡片压缩行、改价后历史会话冷读） | 纯逻辑层测试全绿；运行时路径留待用户重启后确认 |

## 文档重组（本轮一并完成）

- `docs/prd/PRD.md`：v0.3 的 FR-6~FR-9 按 v0.3.15 现状并入 §4（原主 PRD 只有 FR-1~FR-5）；§6 数据模型从「见 README」的指针改为完整内容（补上 `compactions`/`TurnSummary` 等漂移字段 + 六处联动点清单）；§3 用户故事补 US-11~14；修正 FR-1 过时的「hover 350ms」（实际 200ms，与 `interaction.ts` 一致）。
- `docs/prd/CHANGELOG.md`：从 PRD.md §10 拆出全部迭代记录（v0.1 → v0.3.15），新增 v0.3.16 条目；新版本条目追加在最上方。
- `docs/prd/archive/PRD-v0.3-逐轮消耗与上下文占用.md`：v0.3 迭代 PRD 归档（评审结论 R-1~R-3、决策 D-1~D-9 有追溯价值），删除已过期的「交接状态」章节，加归档头。
- `README.md` 重写：功能描述精简去实现细节（细节指向 PRD），目录结构补全缺失文件（BillingTurnsPanel、locate.ts 等），数据模型速览删除（指向 PRD §6，消除双份漂移源），迁移三节压缩为一节，已知限制去重分组。

## 复核方式

- host/client 两路独立审查 agent 出报告 → 主会话对每条找代码证据复核 → 修复 → 补测试 → 全量验证。
- 排除项（经核实无问题，不一一展开）：`priceTokens` 整数运算不丢精度；`tierIndex` 半开区间与兜底语义正确；`boundTurns` 按轮截断方向正确；fence 对 `127.1`/`2130706433`/`0x7f.0.0.1` 等变形无绕过；popover 定时器成对清理无泄漏；locales zh/en 键位一致（91=91）；组件 CSS 无 `--dsw-*` 直连违规。
