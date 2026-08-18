# 踩坑记录：上下文占用条「看不到」——文档流内包装器把进度条挤出轨道被裁掉

> 时间：2026-08-18（v0.3.18 适配 rc.7 后用户报告）
> 问题：悬浮卡片里的上下文进度条（`上下文占用 N% · 已用 / 窗口`）渲染出来了但**看不见**
> 状态：已修复（v0.3.18.1，`docs/prd/CHANGELOG.md`），渲染回归检查脚本见 `scripts/verify-card.mjs`
> 成本复盘：根因是一行 CSS，但诊断过程偏长——本文档后半部分把「慢在哪」和「下次怎么更快」一并交代。

---

## 1. 问题

用户原话：「你是不是给我修坏了，我的悬浮卡片上下文进度条看不到了」。

症状：悬浮卡片**其它部分都正常**（费用、token、命中率、迷你图都在），唯独上下文进度条那一段不见了。

关键背景：这是**回归**——之前能看见，最近某次改动后看不见了。

---

## 2. 排查过程与真正的根因

### 2.1 数据链路全部正常（排查对象选错了，但确认了「数据没丢」）

先按「数据缺失？」的方向查了整条链路，**全部绿**：

| 层 | 检查 | 结果 |
|---|---|---|
| 事件源 | 会话日志 `request/context` 事件带 `contextWindow: 1000000` | ✅ 在 |
| host 折叠 | `session-stats.ts` 折叠出 `contextWindow` / `lastRequestInputTokens` | ✅ 在 |
| 投影缓存 | `~/.dsh/storages/session_projcache.json` 的 billing cell | ✅ `cw:1000000, last:82727` |
| refresh API | `POST /billing/api/refresh` 实时返回 | ✅ `contextWindow: 1000000` |
| served bundle | `/plugins/dsh-meter/client.js` 含 context 渲染代码与 CSS | ✅ 在 |

结论：**渲染条件**（`stats.contextWindow !== undefined && stats.lastRequestInputTokens !== undefined`）必然成立——因为数据全在。

### 2.2 真正的根因：CSS 布局，不是数据

用 headless Chrome 打开真实 GUI、点进会话、hover 徽标展开卡片后：

- DOM 里**有** `.contextBlock`、`上下文占用 11% · 111K / 1.00M`、`.contextFill`（`width: 11%`）；
- 量计算样式发现：轨道 `.contextTrack` 在 `y=447`（高 4px，`overflow: hidden`），而进度条 `.contextFill` 在 **`y=465` —— 差了 18px**，完全在轨道可见盒之外，被 `overflow: hidden` 裁掉 → **看不见**。

### 2.3 是什么把进度条挤下去的

罪魁是 v0.3.16 K3 审查批次（commit `540cfa2`）：把压缩触发线 `.contextTrigger` 包进 `<Tooltip>` 组件，Tooltip 的锚点 `<span class="anchor">`（`display: inline-flex`，继承 16px 行高 → 高约 18px 的行盒）是 **`contextTrack` 的文档流内元素**。它待在 4px 高的轨道里，把紧随其后、**静态定位**的 `.contextFill` 推到了轨道下方。

```
.contextTrack (position:relative; height:4px; overflow:hidden)
├─ <span class="anchor"> (display:inline-flex; 行盒 ~18px)  ← 文档流内
│   └─ .contextTrigger (position:absolute)                   ← 绝对定位，不受影响
└─ .contextFill (position:static)                            ← 被 span 挤到轨道外 → 裁掉
```

`.contextTrigger` 自己没问题——它本来就是 `position:absolute`，以轨道为定位包含块。只有静态定位的 `.contextFill` 受害。

### 2.4 修复

`src/client/BillingAction.module.css`：`.contextFill` 改为绝对定位，与触发线同层，以轨道为包含块：

```css
.contextFill {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  ...
}
```

此后**任何文档流内兄弟元素（包括未来新增的包装器）都无法再把进度条挤出轨道**——比「把锚点改成 `display:contents`」更健壮：后者只治这一个包装器，前者从根上隔离了轨道内容与数据标记的布局耦合。

验证（headless 浏览器实测）：

| 状态 | 轨道 y | 填充 y | 间隙 | 可见 |
|---|---|---|---|---|
| 修复前 | 447 | 465 | **18px** | ❌（被 overflow:hidden 裁掉） |
| 修复后 | 447 | 447 | **0** | ✅ |

`pnpm typecheck` / `node tests/pure-check.ts` 全绿；CHANGELOG 补 v0.3.18.1 条目。

---

## 3. 时间与成本复盘（诚实版）

- 根因是一行 CSS，但**诊断过程偏长**。慢在哪：
  1. **回路选错了层**：先按「数据缺失」搭数据链路验证（全绿、无法对「渲染了但看不见」变红），直到换到**渲染层**（几何校验）才一击命中。数据回路对这个 bug 是**无效回路**——它测试的路径和数据根本没坏。
  2. **一次性工具搭建成本**：headless Chrome + CDP 从零搭（Chrome sandbox 崩溃、要 `--no-sandbox` + `--remote-allow-origins=*` + 全新 profile；Node 内置 WebSocket 不回消息要换 `ws` 包；GUI 要先点进会话才能找到徽标）。**这是一次性成本**，沉淀成脚本后免费。
  3. 便宜的部分其实很快：两个假设验证、重建、复测、补文档。
- 教训一句话：**对「看不到」类症状，先怀疑渲染层，不要先查数据层**；且一次性调试工具要沉淀，否则每次都付全价。

---

## 4. 经验教训（可复用）

### 4.1 「渲染了但看不见」是一类独立 bug

症状是「看不到 / 不见了」时，优先按这个顺序查，**别先查数据**：

1. `getBoundingClientRect()`：元素与容器是否重叠（这次就是 465 vs 447）；
2. 容器是否 `overflow: hidden` / `overflow-x/overflow-y` 裁掉了内容；
3. computed style：`display` / `visibility` / `opacity` / `position` / `color`（背景与前景同色或透明）；
4. `z-index` / 层级被盖住；
5. 最后才怀疑数据没到位——**数据缺省的表现通常是整块消失或显示「—」，而不是「有 DOM 但看不见」**。

判断依据：DOM 里能搜到 `.contextFill`、`width` 正确 → 数据没坏，是布局/样式坏了。

### 4.2 文档流内元素放进「定高 + overflow:hidden」容器是雷区

- 定高轨道的**数据标记一律绝对定位**（本次修复后 `.contextFill` 如此；`.contextTrigger` 早已如此）。
- 「给元素加包装器」这种看似无关的重构要警惕：包装器（尤其 `inline-flex` / `inline-block`，继承行高）可能成为容器里的**新文档流盒**，把兄弟元素挤出可见区。给组件加包装时，先想「这个容器是不是定高 + overflow 的，我的包装器会不会占行」。

### 4.3 回路必须断言用户症状，且在最匹配的层级

- 对渲染/几何 bug，**能断言「可见性」的回路**是几何校验（track 与 fill 的 rect 重叠 + 非透明 + 宽高 > 0），不是数据断言。
- 数据链路验证全绿 ≠ bug 不存在——只说明数据没坏。**回路要能对「这个 bug」变红**才算数（`scripts/verify-card.mjs` 修复前确实变红：间隙 18px）。

### 4.4 回归测试的结构性缺口

- `tests/pure-check.ts` 全是纯函数断言，**永远抓不到这类 CSS 布局回归**——这是仓库的盲区。
- 对策：`scripts/verify-card.mjs`（headless 几何校验）作为渲染层 sanity 脚本，纳入「UI 改动后手跑一遍」的开发循环；README 的常用命令表补一行。

### 4.5 版本/审阅批次是回归高发点

- 本次回归来自「K3 审查修复」批次——审查重点在逻辑与口径，视觉布局回归恰好不在其覆盖内。
- 教训：**改过卡片内部 DOM 结构（加包装、换组件）的批次，应跑一次渲染层 sanity**。

---

## 5. 沉淀物清单

- `src/client/BillingAction.module.css`：`.contextFill` 绝对定位（根因修复）
- `docs/prd/CHANGELOG.md`：v0.3.18.1 修复条目
- `scripts/verify-card.mjs`：headless 渲染回归检查脚本（本文档 4.3/4.4 的落地）
- 本文件：完整踩坑记录（时间 / 问题 / 解决办法 / 经验教训）
