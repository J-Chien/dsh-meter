# dsh-meter 变更记录（CHANGELOG）

> 本文档由 `PRD.md` §10「迭代记录」拆分而来，记录每个版本的具体变更与决策理由。
> 当前有效规格见 [PRD.md](PRD.md)；新的版本条目请追加在本文档**最上方**（最新在前）。

---

### v0.3.17（V4 Pro 查漏补缺）

- **effort 专属价行 + 高峰窗口的标签判定对齐（P1）**：`peakModels` 的 key 在命中 effort 专属价行时带第三段 effort（`provider/model/effort`）；client 高峰标签按 effort 查同一行（`findPriceRow` 优先 effort 行）。原实现 key 只带 `provider/model`、标签永远查通用行——effort 行配高峰窗口时标签永不亮、与卡片分栏矛盾。
- **`boundTurns` 按轮号计数（P2）**：投影帧截断的「50 轮」原按 `turn:currency` 键控，多币种轮占 2 个名额，全多币种会话实际只留 ~25 轮；改为按轮号，多币种轮只占一个名额。
- **OVERNIGHT DAYS 测试时区无关化（P2）**：断言时刻从固定 `+08:00` 字面量改为本机本地时间构造（2026-08-21 周五 / 08-22 周六），UTC+9 以东机器不再误挂。
- **C3 修复扩展到多标签页（P2）**：设置页保存除同页事件外再写 localStorage 广播，其他标签页的徽标监听 `storage` 事件重取价格表——原只有保存的那一页高峰标签会更新。
- **测试**：新增 EFFORT PEAK KEY（effort 行高峰 key、无 effort 请求不产 key）与 TURN BOUND CURRENCY（多币种 50 轮截断）两组检查。

---

### v0.3.16（审查修复批次二，review-0818）

- **压缩摘要调用计入费用（P1）**：`compaction/summary` 携带的 `usage`（摘要一次性调用的真实 provider 用量，不产生 `assistant/message`）此前完全不计费——恰恰是最贵会话里的大头。现在计入会话费用总额与空闲/高峰拆分，并在卡片压缩历史行展示「摘要花费」；其 token 不进会话 token 桶（避免一次性重读稀释缓存命中率语义），累计在 `compactions.tokens` / `compactions.cost`。投影 schema 同步。
- **折叠状态瘦身（P1）**：`BillingFoldState` 只保留 `header.config`，不再持有完整 `EpochHeader`（system prompt/工具 schema 数十 KB 不再冗余进投影持久化 checkpoint）。
- **改价后冷读复活旧价（P1）**：价格表内容哈希（FNV-1a）混入投影 `stateVersion`（base 7→8）——改价即让用旧价格折叠的持久化 checkpoint 失效、冷读全量重折；同表同版本，重启后 checkpoint 仍有效。
- **reasoningEffort 匹配优先级（P1）**：新增共享 `findPriceRow`——effort 精确匹配优先于无 effort 通用行（原数组序依赖：通用行在前则 effort 专属价永不生效；无 effort 请求会误中 effort 行）；host 折叠、高峰窗口检测、client 高峰标签三处统一走它。
- **跨天窗口 × days 语义修正（P2）**：`days` 按**窗口起始日**判定——「周五 22:00–06:00」覆盖周六凌晨（原按请求发生的日历日过滤，周六 02:00 被错误排除）；起止相同 = 全天。
- **fence CSRF 加固（P2）**：`/billing/api` 在 loopback Host 之外增加 `sec-fetch-site`（拒 `cross-site`）与 `content-type: application/json` 检查——跨域网页经 simple request 改写本地价格表的写入面被封死。
- **杂项修复**：settings.update 校验失败返回 400（原 500）；未登记请求的 turn 行保留 provider 币种（原硬编码 CNY，多币种分组错位）。
- **client 修复**：悬浮卡片首次打开即测量高度（翻转/贴底分支首次生效；卡片宽度改实测并挂 ResizeObserver 跟随内容变化）；逐轮面板多币种分组头部按币种并列（原跨币种加总假数）；设置页保存后广播 `billing:pricing-updated`，徽标高峰标签即换新表（原修改已在用模型的高峰窗口后标签永远用旧表）；迷你图增长改按轮号键控（修多币种轮次错列与 React key 冲突）；旧数据高峰窗口的首次价格编辑即生效（原被旧平价播种吞掉）；`endHour` 最小 1（原可输 0 导致保存必 400）；`buildEditor` 只用无 effort 行播种（原 effort 行保存时被拆成两行）；压缩触发线统一 Tooltip（去掉最后的原生 `title`）；触发阈值统一 `COMPACT_TRIGGER_RATIO`。
- **工程**：版本号对齐 package.json ↔ 迭代记录（0.2.6 → 0.3.16）；`dsh-llm` 补入 peerDependencies；删死代码（`currentTurnOf`、6 个无引用 locale 键、未用 `NS` 导入）；`formatTokens` 进位到 1000K 时显示 `1.00M`；invariant 空态断言补全；`src/index.ts` 重复导出清理。
- **测试**：新增 EFFORT PRECEDENCE / OVERNIGHT DAYS / FENCE / UNPRICED CURRENCY / TURN GROWTH MAP 五组检查 + compaction 计价断言。
- **迷你图第 1 轮新增占用修正**：首轮增长此前按「无前驱 → 0」处理（柱高残 4px、tooltip 显示 0），改为**整轮快照**——第 1 轮的前驱是空上下文，其装载的全部内容都是新增；截断帧的首轮（前驱在窗口外）保持不计，避免把整轮快照误当增长。
- **迷你图布局改为从左到右**：`space-between` 两端贴边（v0.3.11）与「时间递增」读感冲突——柱距随宽度变化、末柱永远贴右缘，且与详情面板图表不一致；改为固定 3px 柱距左起排列，与详情面板同款。
- **文档**：docs/prd 重组（迭代记录拆分至 CHANGELOG、v0.3 迭代 PRD 归档 archive/、FR-6~9 与完整数据模型并入主 PRD）；README 重写精简。

### v0.3.15（快照差分模型：免疫缓存失效）
- **口径再修正**：v0.3.14 的「未缓存输入 + 输出」净增在**缓存失效**时会假性暴涨（下一轮历史重放为未缓存输入，7.5K 净增变 555K）。改为**快照差分**：每轮新增 = 该轮最后一个请求总输入 − 上一轮最后一个请求总输入——总输入与缓存状态无关，命中/未命中只是同一上下文的不同计费方式，差分天然免疫缓存波动（用户反馈确认）。
- 迷你图柱高/tooltip、压缩预估增速统一改快照差分（`turnSnapshots`/`turnGrowths`）；hover 文案改「新增占用」，区块标题「最近输入」→「每轮新增」。
- 测试重写（SNAPSHOT DELTA CHECK，含缓存失效场景断言）。

### v0.3.14（净增模型：缓存命中/写入不计入增长）
- **确立口径（真实日志验证）**：每轮净增 = Σ(未缓存输入 + 输出)；缓存命中是历史重读（18 轮中单轮 31M vs 净增 71K）、缓存写入是本轮自身输入，均不计入。此前三种口径（step 求和 11M 爆表 / 最后一个请求快照 / 水平差分）全部废弃。
- 迷你图柱高与 tooltip 改净增；压缩预估增速/ETA 改净增序列（`turnNetGrowths`）；测试重写（NET GROWTH CHECK）。

### v0.3.13（迷你图柱高改上下文水平，修复多 step 求和爆表）
- **柱高/输入 tooltip 改轮次结束水平**：新增 `turnInputLevels`（每轮取最后一个请求的总输入）；迷你图此前用 `aggregateTurns` 的 step 求和——工具调用轮每步重发全历史，84 step 轮次求和 15.7M、真实水平 215K，hover 出现「11M」这类突破上下文窗口的假数。
- 测试补 `turnInputLevels`（含进行中轮）断言。

### v0.3.12（压缩预估双窗口保守化 + 余量可验证）
- **增速取双窗口最小值**：全历史 trimmed mean 与最近 10 轮 trimmed mean 取较小者——早期一次性装载（system prompt/首批上下文）抬高的全历史均值不再虚增预估轮数；近期变轻也不会过度乐观。
- **文案带余量**：`净增 +X/轮，余量 Y，约 N 轮后触发压缩`——Y/X 可心算验证 N（此前只显示 X 和 N，N 无法核对）。
- 测试补双窗口保守取小用例（COMPACTION ETA CHECK）。

### v0.3.11（迷你图改 token 柱 + 对称布局）
- **迷你图从费用柱改为输入 token 柱**：该区块处于 token 上下文（输入/命中/输出/占用条），费用柱语义突兀；柱高 = 该轮总输入 token，高峰轮暖色标记保留（该轮输入按高峰计价）；区块标签「最近消耗」→「最近输入」。
- **tooltip 改富信息**：轮次 + token 消耗（输入）+ 费用消耗 + 命中率，一段文案齐备。
- **左右间距对称**：`.turnsChart` 去掉 `gap` 改 `justify-content: space-between`——首末柱贴边、余量均匀摊入柱间，消除右缘空档。

### v0.3.10（压缩预估消除轮边界跳变 + 迷你图满宽自适应）
- **预估只用已完成轮次**：新增 `completedTurnLevels`（纯函数，进行中的轮次被排除——其水平随每个请求增长，纳入会在轮边界跳变、轮内漂移）；`ContextBar` 增速取自完成轮次 trimmed mean。
- **headroom 单调位置**：`max(最近请求输入, 上一完成轮水平)`——缓存命中丰富时请求总输入可能低于历史水平，用 max 防止位置假性回退导致 ETA 反向跳高。
- **迷你图满宽**：`TurnsBarChart` 从写死 10 轮改为 ResizeObserver 实测容器宽度、按 18px 柱宽 + 3px 间距计算可容纳轮数（至少 4 根、首次测量前 fallback 10），右边不再留白。
- 新增测试：`TURN LEVELS CHECK`（完成轮提取 + 进行中轮排除语义）。

### v0.3.9（压缩预估稳定性 + 横轴强调方式）
- **预估改 trimmed mean**：增速从「最近 5 轮简单平均」改为**最近 10 轮正差分 trimmed mean**（去掉最大最小各一个），单轮偏轻/偏重不再左右预估；<3 个正差分或无余量不显示。纯函数 `estimateCompactionGrowth`/`estimateCompactionEta` 提取到 `shared.ts` 并补单元测试（COMPACTION ETA CHECK）。
- **横轴强调改到标签**：轮次首请求（`N.1`）不再给柱体加 1px 描边（观感差），改为标签加粗 + 提亮（`font-weight 600` + secondary 色），前导 8px 间距保留。

### v0.3.8（压缩预估模型修正 + 触发线口径 + 轮次边界分组）
- **修压缩预估模型（P0）**：原实现把「每轮请求总输入」当增速——但一轮输入包含全部历史，水平值可达几十 K，headroom 只有窗口的 38% 时算出「1 轮后压缩」。改为**相邻轮次输入的差分**（每轮净增 = 本轮总输入 − 上轮总输入；差分 ≤0 丢弃——压缩后水平重置），ETA = headroom ÷ 平均正差分；<2 轮或全无正差分不显示。文案改「净增 +X/轮，约 N 轮后触发」。v0.3.9 再修：轮级水平取**该轮最后一个请求**的输入（工具调用轮内每个 step 重发全上下文，求和会多倍虚增——曾算出 +12.61M/轮），差分对水平做。
- **触发线口径澄清**：`thresholdRatio` 是 compaction-basic 的**私有 cordis patch 配置**（当前宿主 bundle 未覆盖 = 默认 0.8），无 settings 命名空间、无运行时读取面——0.8 作为「默认触发线」如实标注（tooltip 说明「宿主若覆盖则此线为近似」），不再冒充读自配置。
- **触发线样式重做**：2px 实心琥珀竖线 → 1px 半透明（45%）hairline + 顶部 4px 缺口标记，读作参考线而非数据。
- **按请求图轮次边界分组**：dense 模式下每轮**第一个请求**（step=1）加 8px 前导间距；其横轴标签 `N.1` 必标（与抽稀正交）**并加粗 + 提亮**（原方案给柱体加 1px 描边，观感差，改为在横轴标签上强调），轮次起点一眼可寻。

### v0.3.7（压缩预测条 + 请求级密集图）
- **压缩预测条（卡片占用条升级）**：
  - host 折叠 `compaction/summary` 事件（类型经 `import type {} from '@deepseek-ai/dsh-compaction'` 的 declaration merge 引入）→ `SessionBillingStats.compactions`（`count`/`lastTime`/`lastShadowedTokens`，全部为 harness 写好的真实 shadow price，插件零估算）；投影 `stateVersion` 6 → 7；`assertEmptyBillingStats` 同步。
  - 占用条 80% 处加琥珀触发线（compaction-basic 默认 `thresholdRatio=0.8` × contextWindow，即自动压缩触发点）；有压缩史时显示「已压缩 N 次 · 上次 HH:MM:SS · 释放 X tokens」；用最近 ≤5 轮真实 usage 输入增速外推「预计 N 轮后触发压缩」（粗估：harness 计量全表面启发式估算、插件只见真实 usage，分母为输入+输出窗口；无增速/无余量不显示）。
  - 新增文案 `card.compactDone`/`card.compactEta`（zh/en）；依赖新增 `@deepseek-ai/dsh-compaction ^0.1.0-rc.6`（peer + dev）；测试补 compaction 折叠断言。
- **按请求密集图**：`TurnChart` 增加 `dense` 模式——「按请求」柱宽 24px → 12px（宏观趋势视角，精确值在 tooltip/表格），标签抽稀更激进（>40 根隔 4、>80 根隔 8，首尾必标）。

### v0.3.6（图表横轴可读性 + 占用条口径修正）
- **图表横轴改纯数字标签**：详情面板横轴从「轮次 N」改为纯数字（按轮次 `12`、按请求 `12.3`），表头与 tooltip 保留完整语义——原「轮次 N」中文标签在固定柱宽下被截成「轮次轮次轮次」，`N.step` 也被截断。
- **柱宽固定 24px**（原 18px），容纳 3-4 位数字标签不截断；抽稀阈值重定（>20 根隔 1 标、>40 根隔 4 标，首尾必标）。
- **占用条口径修正**：`request/context.contextWindow` 是 provider 声明的**输入+输出合计**窗口（harness `RequestContext` 定义），不是纯输入窗口——「最近一次请求输入占上下文 32%」这类提示是混合口径、无行动意义，已删除（`SINGLE_TURN_WARN_RATIO` 与 `turn.lastInput` 一并移除）；占用条保留并注明口径（输入 / 输入+输出总窗口），≥85% 预警语义不变（输入接近总窗口时输出空间所剩无几）。
- 死 CSS（`.contextHint`）与死文案清理。

### v0.3.5（交互与视觉规范统一）
- **交互节奏统一**：新增 `src/client/interaction.ts`——悬停打开 200ms / 离开关闭 300ms / 点击取消悬停打开 100ms / tooltip 延迟 400ms，卡片与图表/按钮 tooltip 共用同一套节奏（此前悬停卡片 120ms/150ms 与原生 title 的 OS 延迟明显不同步）。
- **统一 Tooltip 替代原生 `title`**：新增 `src/client/Tooltip.tsx`（portaled、跟随锚点、Esc 关闭、z-index 300 高于卡片 100 与详情 mask 200，`role="tooltip"`）；卡片三个按钮与两个图表（迷你图、详情面板）全部改用它，原生 title 全部移除（读屏不可达、触屏无 hover、延迟不可控）。
- **设计 token 单一事实源**：新增 `src/client/theme.module.css` 的 `--billing-*` 变量层（文本三阶/表面/边框/图表色/圆角/动效曲线），四个组件 CSS 全部改经该层解析（组件不再直接引用 `--dsw-*`），跨主题改一处生效。⚠️ 踩坑记录：dsw 主题变量定义在 `body`/`body[data-ds-dark-theme]` 上（非 `:root`），token 层曾误挂 `:root` 导致全部 alias 落到亮色 fallback、暗色模式整体失效——引用 `--dsw-*` 的 `--billing-*` 必须声明在 `body`，与主题无关的常量（z-index/圆角/动效）才放 `:root`。
- **修悬停死区**：卡片与触发器之间的 8px 空隙会立刻触发离开关闭，指针无法进入卡片（P0）；新增不可见桥接层 + 卡片自身进入/离开处理，空隙不再算作离开。
- **恢复输出上限展示**：卡片占用行重新显示 `maxOutputTokens`（v0.3 承诺，美化分支误删），与 `已用/窗口` 同行展示。
- **无障碍**：卡片按钮 aria-label 规范（设置按钮改用动作语义 `settings.open.aria`）；详情面板关闭按钮修复（原误用 `settings.open` 文案）。
- **杂项**：删除 `BillingCard` 死变量；设置页保存失败增加内联错误（原静默吞掉）；capability 行分隔符只在两个字段都存在时渲染（原单字段时也带 `·`）；投影 zod 收紧 `cacheHitRate` 0..1；catalog 按 provider 并发（原串行，慢 adapter 拖慢整页）；折叠改走 `priceRequest`（计价公式单点，原与 price.ts 双份漂移）；`assertEmptyBillingStats` 纳入测试。

### v0.3.4（逐轮面板方向与表头修正）
- **图表横轴改为时间递增**：详情面板费用/token 图改为**最老轮在左、最新轮在右**（轮次从左到右递增，与阅读顺序一致）——原实现最新轮在左的倒序与时间直觉相反。列表仍保持最新轮在最上的倒序（表格阅读习惯），图表与列表解耦。
- **明细表头去括号**：表头不再显示 `（缓存未命中）/（缓存命中）` 括号，改用简洁的「未命中 / 命中 / 写入 / 输出」（复用 `turn.*` 文案键，新增 `turn.cacheMiss`，zh/en 同步）。
- **请求序号始终带 step**：「按请求」视图中每个请求的序号一律显示 `turn.step`（如 `1.1`、`2.3`），单请求轮不再省略成裸 `N`——裸序号会与「按轮次」的轮次号混淆。
- **图表跟随视图切换**：图表不再是固定按轮次聚合——「按轮次」时每轮一根柱（工具调用 step 合并），「按请求」时每个请求一根柱（序号 `N.step`）。两个视图的图表粒度与明细表粒度一致，避免「图表一样、只换表格」的冗余（v0.3.4 后续修正）。

### v0.3.3（逐轮面板体验打磨 · 三轮反馈）
- **列表/图表按轮次倒序**：详情面板的费用/token 图与明细表均改为**最新轮在前**（图表最新轮在左、列表最新轮在最上），与卡片迷你图倒序一致——原按日志升序，长会话最新数据沉底。
- **「按请求」改为可折叠轮次分组**：切到「按请求」视图时不再平铺全部请求行，而是**每轮一行聚合（含展开箭头 + 请求数）+ 点击展开该轮的请求明细**（默认全部折叠）。一个含上百次工具调用的会话从「上百行平铺翻找」变成「先看轮次聚合、需要时再展开单轮」；轮内请求保持日志顺序。图表始终按轮次聚合，与折叠表一致。

### v0.3.2（逐轮面板体验打磨 · 二轮反馈）
- **按轮次有界投影（修漏轮）**：投影帧的 `turns` 截断从「最后 N 条请求」改为「**最后 N 轮**」（`boundTurns` 纯函数，保留一个轮次的全部 step 不拆散）——原实现按请求截断，长工具链会话的早期轮次（如第 1 轮 128 条请求）会被整轮挤掉，卡片迷你图只显示后几轮。
- **纵向刻度轴方向修正**：刻度从 0（底部）递增到最大值（顶部），与柱子自底向上的生长方向一致（原实现渲染为顶→底）。
- **最近消耗倒序**：卡片迷你图最新轮在**左**（倒序），符合阅读习惯。
- **token 配色重构**：四类桶改**蓝阶渐变 + 琥珀输出**（未命中 `deepseek-400`、命中 `deepseek-200`、写入 `deepseek-500`、输出 `amber-400`）——原 `success-tertiary`/`success-secondary`/`warn-tertiary`/`business-primary` 在亮色下未命中过浅、命中/输出过深，且 `state-business-secondary` 在设计 token 中不存在导致命中缓存渲染空白。
- **明细表输入列口径修正（修重复困惑）**：表格「输入」列从「总输入」改为**未命中部分**（`inputTokens - cacheRead - cacheWrite`），与命中/写入/输出四列互斥相加 = 总用量，不再与命中/写入列重叠；token 维度下附图例口径说明（四桶互斥相加 = 总用量，与主仓库 token-meter `usageTokens` 同口径）。

### v0.3.1（逐轮面板体验打磨，GUI 实测反馈）
- **默认按轮次聚合**：详情面板与卡片迷你图默认**按轮次（turn）**展示——一个轮次内的工具调用 step 合并为一条（`aggregateTurns` 纯函数：同轮 token/费用累加、命中率按合并桶重算、多币种不混并、未登记标记仅当该轮全部请求未登记）。「按请求」视图展开每条明细（保留原粒度）。
- **图表加纵向刻度轴**：详情面板图表左侧新增刻度轴（`niceStep` 取 1/2/5 步长，2-5 个刻度），费用维度带币种符号（`formatPriceAxis` 保留小数值精度）、token 维度紧凑单位。
- **修 token 堆叠配色**：命中缓存段原用 `--dsw-alias-state-business-secondary`——该 alias 在设计 token 中不存在，渲染为空白。改用已定义的语义 token：输入未命中 `state-success-tertiary`、命中 `state-success-secondary`、缓存写入 `state-warn-tertiary`、输出 `state-business-primary`，亮暗主题均可区分。
- **时段展示仅在配置高峰时段时出现**：详情面板的「时段」列与高峰/空闲图例、以及未登记图例，仅在会话 `hasPeakConfig` 时渲染——无高峰时段配置的会话不再显示「空闲时段」误导文案。

### v0.3（逐轮消耗可视化 + 上下文窗口占用）
- **逐轮消耗数据层**：`SessionBillingStats` 新增 `turns: TurnCost[]`（最近 ≤50 条，有界）与 `lastRequestInputTokens`；`foldEvent` 对每次带 `usage` 的 `assistant/message` 逐条产出 `TurnCost`（轮次/时间/四类 token/命中率/费用/币种/时段/是否已登记），纯折叠无新数据源、与会话总量同源同事务；投影 `stateVersion` 5 → 6；全量明细走新增 `/billing/api/turns` 按需路由。
- **上下文占用（日志真实数据，纯折叠）**：`request/context` last-wins 设置/清除 `contextWindow`；`request/header.config.maxTokens` 设置/清除 `maxOutputTokens`（no-op 快路径比较纳入 `maxTokens`）；分子 = 最近一次请求总输入（`lastRequestInputTokens`，非累计）。卡片显示进度条 + 百分比 + `已用/窗口` + `输出上限`，≥85% 预警「接近上限，建议开新会话」、单请求 ≥30% 附小字提示；任一缺省不显示（不估算）。
- **逐轮消耗展示**：卡片「最近消耗」迷你横条图（最近 10 条、每轮费用、peak/off-peak 着色、hover 详情）+ 「查看详情」按钮打开独立大面板（逐轮费用柱状图 + 四段 token 堆叠图 + 逐轮明细表，费用/token 维度切换），纯 CSS 绘制不引图表库。
- **设置页模型能力**：`catalog` 路由并行调 `ctx.llm.resolveModelInfo`（单模型失败降级缺省），每个模型行显示真实上下文窗口/最大输出能力（目录解析，失败不显示；输出上限仅部署显式配置时存在，标注「（配置）」）。
- 新增 `card.*`/`turn.*`/`capability.*` 文案（zh/en）；新增 `BillingTurnsPanel.tsx` 组件。

### v0.2.6（分段编辑器文案打磨）
- **分段按序编号**：开启分段开关后，默认段显示「区间 1」，新增分段依次为「区间 2」「区间 3」…——方便对照每次请求落在哪一段；开关关闭时不显示任何分段字样。
- **区间标注输入/输出（分两行堆叠）**：每段内部「输入区间」「输出区间」各占一行（各自带 `K tokens` 单位），区分两对 min–max 上下界；两行堆叠后长边界不再换行、不溢出（原单行横排超宽会折行错位）。
- **高峰时段结构统一**：每个高峰窗口顶部是时段（起止时间），其下「分段计费」块从**区间 1**（该窗口默认/平价）开始包含全部区间，与空闲分段完全相同的 tierBox 结构——只读区间行在上、四价字段在下；区间 1 不再留在分段计费块之外。
- **高峰区间改区间记号**：高峰每段只读区间改为区间记号——`输入长度 [0, 32)`、`输出长度 [0, 0.2)`、`[0.2+)`（下限缺省 = 0、上限缺省 = `+`，无约束的维度不显示、全无约束的默认段显示「全部」）。
- **抽公共组件**：`TierRangeLine`（可编辑/只读两种模式）+ `PriceFields`（四价字段）统一空闲与高峰的分段渲染；删除 `tierRangeLabel`/`tierLabel`。
- 新增 `settings.tier.range` / `settings.tier.inputRange` / `settings.tier.outputRange` / `settings.tier.all` 文案（zh/en），删除不再使用的 `settings.tier.default`。

### v0.2.5（审查修复批次，review-k3-0816）
- **修设置页跳转选择器**：齿轮不再用裸 `aria-haspopup="dialog"` 猜测（页面至少 3 个匹配，含插件自身徽标与 ContextMeter）；插件徽标加 `data-billing-trigger` 标记，排除自身与带 aria-label 的按钮后取剩余文本按钮，nav 点击改为轮询（最长 1s）而非固定 50ms。
- **修保存数据丢失**：设置页保存时把目录外模型与 `reasoningEffort` 价格行（含其 provider 币种）原样合并回提交负载；`buildEditor` 播种优先取无 effort 行。
- **修测试链路**：`SessionEvent` 改从 `@deepseek-ai/dsh-session` 导入（原从不导出它的 shared.ts 导入，因 tests 不进 typecheck 而隐形）；`pnpm test` 改为 `node tests/pure-check.ts`（原 vitest 配置捡主仓根配置、永远跑不到本测试）；新增 `tsconfig.tests.json` 纳入 tests typecheck；修掉暴露出的 fixture 类型错误（AssistantMessage 缺 id/source）。
- **修 host 生命周期**：`scope.watch` 包进 `ctx.effect`（原 disposer 丢弃、卸载后仍触发）；`ctx.inject` 整个生命周期只调一次（原每次重挂载都新建 fiber）；卡片刷新不再 remount 全局投影，只同步价格表并折叠单会话。
- **收紧 settings schema**：价格全部 `.min(0)`、`startHour` 0–23、`endHour` 1–24，阻止 API 直写非法值打挂投影 zod 校验。
- **多币种徽标并列**：`¥1.20 + $0.35`，不再只显示最大子合计。
- **共享常量归位**：`PRICE_PRECISION`/`formatPrice`/`EMPTY_STATS` 移入 `shared.ts`（host/client 原各一份）；`EMPTY_STATS` 冻结。
- **工程**：版本号对齐到 0.2.5；`prepare` 改为完整构建（原在首次 install 时因 tsc 产物缺失必失败）；删冗余脚本；package.json 加 `files` 白名单；修 `tsconfig.json` 的 `ignoreDeprecations: "6.0"`（TS 5.9 下 typecheck 直接报错）。
- **小修**：`tierLabel` 死分支删除、「全部」进 locales（新增 `settings.tier.all`）；价格/小时/长度输入在 unmount 时提交未失焦的草稿；`foldEvent` 在 header config 未变时返回原 state（不再推空帧）；移除 client 死注入 `remote`。

### v0.2.1
- **分段计费改为开关**：每个模型行标题右侧「分段计费」switch，开启后在基础价格下方显示分段编辑器（不再放在页面最底部）；关闭则清空分段。
- **输入/输出长度区间改为横向布局**：同一行内输入区间与输出区间并排，降低卡片高度。
- **0 即填 0**：下限默认显示 `0`（真实值），上限留空 = 不限（显示 `∞`），不再出现「不限～32K」这类歧义。
- **高峰时段区间复用、价格独立**：`PeakPeriod.tiers` 只存各段高峰价格，按索引对齐模型基础分段区间；新增高峰窗口时按基础分段结构预填各段价格（区间边界不再重复编辑）。
- **卡片底色区分**：模型行左侧加品牌色竖条 + 分层底色（group 用 bg-base、模型行用 layer-1、分段/高峰用 layer-2/3），提升辨识度。

### v0.2.2（暗色模式 token 修复）
- **修复悬浮卡片「当前模型」行 dark 下底色消失**：`.modelLine` 原来用 `interactive-bg-hover-solid`，其 dark 值（`neutral-bluish-800`）与卡片背景 `specific-menu`（=`bg-layer-3`）同色，导致底色不可见。
- **统一修复卡片/设置页内 hover 反馈**：`.refresh`/`.settings`/`.removePeriod` hover 背景从 `interactive-bg-hover-solid` 改为 `interactive-bg-hover`（半透明，与官方 Menu 一致），避免 dark 下与所在表面同色。
- **设置页层级对齐官方语义**：provider 分组改为透明 + `border-l2`（官方 rowCard 模式，不再用 `bg-base` 造成 dark 大黑坑）；模型行改 `bg-module-platform`（官方 editor 填充模块语义）；`.addPeriod:hover` 由改边框色改为半透明背景（边框 l1 比 l2 更淡，原 hover 反而变淡）。

### v0.2.3（当前模型行背景调弱）
- **「当前模型」行背景从 `interactive-bg-hover-accent` 改为 `markdown-tag`**：上一版用 accent（dark 下 24% 白叠加，Δ≈61）对纯信息展示过强，dark 下抢占视觉重点；`markdown-tag`（light=浅灰、dark=比卡片深一档，Δ≈10-12）是"标签信息块"语义，亮暗都柔和克制，不抢 token/费用数字的重点。

### v0.2.4（分段与默认价格统一为连续档）
- **默认价格成为第一段**：开启分段开关后，默认价格行显示可编辑区间，成为 `tiers[0]`；「添加分段」就在默认价格行下方直接增加新区间行——分段与默认价格是连续的一整套档，不再是独立区块。
- **分段字段复用默认命名**：每个分段用与默认价格完全一致的四个字段（输入命中/未命中、缓存写入、输出），去掉"分段输入/分段输出"等前缀命名；区间行紧凑单行，不换行、不挤压布局。
- **新增/删除分段时高峰窗口同步增删**：`addTier`/`removeTier` 同步给每个高峰窗口增删对应段（区间一致、价格独立可编辑）；关闭开关时清空高峰窗口的分段数组。
- **计价兜底语义**：`tierIndex` 把无区间约束的档（默认/全部）作为最后兜底——具体区间段优先匹配，无匹配时落到默认档价；peak 按索引对齐保持不变。
- **保存**：开启时分段保存为 `tiers`（`tiers[0]` = 默认档区间 + 顶层默认价）；关闭时 `tiers` 清空，仅存顶层默认价。

### v0.2
- **缓存写入独立计价**：`ModelPrice`/`PeakPeriod`/`PriceTier` 新增 `cacheWrite` 单价；折叠中 `cacheWriteTokens` 改按 `cacheWrite` 计（未配置缺省 0），不再按缓存命中价近似。命名统一为独立「缓存写入」（非「输入（缓存写入）」）。设置页基础价与每个高峰时段/分段增加「缓存写入」输入；统计卡片在会话存在缓存写入 token 时显示「缓存写入」行。
- **分段计费**：`ModelPrice` 新增 `tiers[]`（输入/输出长度区间 + 四价）；每个请求按总输入长度（未命中+命中+写入）与输出长度命中第一个匹配分段，整单按档计价；无匹配按所在档位平价。设置页每个模型可增删多个分段，长度以 K tokens 输入、留空不限、新增自动用基础价预填。
- **高峰时段自带分段**：`PeakPeriod` 新增 `tiers[]`；新增高峰窗口时自动复制模型基础分段，每个窗口可独立编辑自己的分段与价格；活跃高峰窗口用其自身分段（无匹配则用窗口平价）。
- **默认表新增 zai**：按 bigmodel.cn 官方价写入 GLM-5.1/GLM-5-Turbo/GLM-4.5-Air（输入分段）与 GLM-4.7（输入+输出分段），GLM-5.2 平档；缓存写入为限时免费（0）。
- host 投影 `stateVersion` 4 → 5（折叠语义变更，旧缓存失效重算）。

### v0.1.1
- 设置页 provider 分组**默认全部折叠**；折叠/展开控件从行首移到**标题右侧**的箭头图标按钮，移除「展开/折叠」文本按钮（整行仍可点击切换）。

### v0.1.2
- 悬浮卡片费用区三行标签（总费用/空闲时段/高峰时段）**左对齐**（去掉分栏缩进）；空闲/高峰拆分金额改用**灰色小字**，与时段标题一致，总费用行样式不变。
- 会话头部新增**红色「高峰」标签**：会话用到配置了高峰窗口的模型且当前时刻处于高峰时显示（实心红底圆角代码块样式，每分钟重算）。

### v0.1.3
- 设置页高峰时段起止时间改为**时钟样式**显示（`9:00` / `22:00`，结束可为 `24:00`）。
- 价格输入**自动补零到两位小数**（`10` → `10.00`），超过两位小数按实际值显示（`10.155` 不变）。

### v0.1.4
- 头部状态标签**弱饱和化**：高峰改浅红底红字（不再实心红）；新增**灰色「空闲」标签**（有高峰配置但当前不在高峰时显示）；无高峰配置不显示任何标签。
- 「未登记价格」改为**琥珀色圆角标签**，与高峰/空闲标签统一成同一套 chip 样式。
- 悬浮卡片「总费用」标签去掉币种符号 `(¥)`（金额右侧已带符号，避免重复）。

### v0.1.5
- 修复未定义 token：`--dsw-alias-fill-l1/l2` 在运行时不存在，头部标签底色与设置页所有填充背景改为**运行时确认存在的 token**（`bg-layer-1/2/3` 层级底色、`state-warn-tertiary` 琥珀底、`interactive-bg-hover-*` 悬浮底），「未登记价格」「空闲」标签底色可见。
- 悬浮卡片标题下方新增**当前模型行**（`provider / model` + reasoning effort）。
- 卡片齿轮设置改为**跳转并定位当前模型**：自动展开对应 provider 分组，滚动到该模型行（下方空间足够则置顶显示，否则靠底显示，不强行留白）。

### v0.1
- 首个可用版本：会话头部常驻入口 + hover/点击卡片 + 计费设置页 + 高峰/空闲计价 + 多 provider/多币种 + 未登记价格 + 热更新开发循环。
- 全部 9 项核心需求（US-1 ~ US-9）与热更新（US-10）已实现。
