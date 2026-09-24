# dsh-meter 价格表配置说明（给人看，也给 Agent 执行）

这份文档解决一件事：**用户丢给你一张截图、一个价目页链接、或一句"XX 模型多少钱"，你就能把价格直接写进配置文件**，不必让他在设置页里一格格点。

- 本文是**格式规范**；`src/host/price-file.ts` 是执行副本，`scripts/check-prices.mjs` 是验收工具。三者冲突时，以代码与自检输出为准。
- 面向 Agent 的硬性要求只有两条：**不确定就不要写数字**，以及**写完必须跑自检**。

---

## 0. 30 秒版

| 事项 | 值 |
| --- | --- |
| 文件位置 | `$DSH_HOME/dsh-meter/prices.yaml`；没设 `DSH_HOME` 就是 `~/.dsh/dsh-meter/prices.yaml` |
| 单位 | **元 / 百万 tokens** —— 就是价目页和设置页显示的那个数字，不要做任何换算 |
| 结构 | 顶层 `providers:` + `models:`，示例见 [`docs/examples/prices.deepseek.yaml`](examples/prices.deepseek.yaml) |
| 写完自检 | `node scripts/check-prices.mjs <文件>`（装成依赖后可用 `npx dsh-meter-prices <文件>`） |
| 生效方式 | 在计费卡片上点一次「刷新」（host 每次重算都会重读文件），**不需要重启** |

---

## 1. 优先级：先读这段，否则一定踩坑

价格来自三层，**从强到弱**：

```
显式配置（profile patch / 设置页保存）  >  价格文件  >  插件内置默认表
```

- **按行覆盖**：文件只影响它声明的那一行（`provider` + `model` + 可选 `reasoningEffort`），没提到的行保持原样。
- **显式配置优先**：某一行如果已经在 profile patch 或设置页里写死了，文件里的同名行**不生效**。设置卡片会显示「N 行被显式配置覆盖」，启动日志也会写明。
- 因此：**要么用文件，要么用设置页，不要混用**。混用时以显式配置为准 —— 这是刻意的，否则一次 GUI 保存就会悄悄吃掉 Agent 写的价格。
- 想让文件接管这些行：把 patch / 设置页里对应的行删掉。

`providers` 段按 provider id 逐个键合并（文件里的 provider 覆盖同名键，其余保留）。

---

## 2. 文件格式（规范）

YAML 或 JSON 都可以（JSON 是 YAML 的子集）。**文件正文就是价格表本身**，不要写成 profile patch 的条目、也不要包一层 `config:`：

```yaml
providers:
  deepseek-official:
    currency: CNY          # 可选，CNY | USD，默认 CNY
    currencySymbol: '¥'    # 可选，默认 ¥
    timezone: Asia/Shanghai # 可选，IANA 名，默认 Asia/Shanghai
models:
  - provider: deepseek-official   # 必填：harness 实际报告的 LLM 路由 id
    model: deepseek-flash         # 必填：路由报告里的模型 id
    reasoningEffort: high         # 可选：只对某个思考档位定价
    input: 1                      # 必填：未缓存输入，元/百万 tokens
    output: 4                     # 必填：输出
    cacheInput: 0.02              # 必填：缓存命中输入
    cacheWrite: 0                 # 可选：缓存写入；不单独计费就写 0 或省略
    periods:                      # 可选：高峰时段（见下）
      - startHour: 9
        endHour: 12
        days: [1, 2, 3, 4, 5]     # 0=周日 … 6=周六；省略=每天
        input: 2
        output: 8
        cacheInput: 0.04
    tiers: []                     # 可选：按长度分段（见下）
```

### `periods[]`（高峰/空闲）

- 行上的 `input`/`output`/`cacheInput`/`cacheWrite` 是**基准价**（DeepSeek 的「空闲时段」价，也是没有命中任何 `periods` 时的价）。
- 每个 `periods` 条目是一个**时段窗口**，命中时用它的价格。
- `startHour` 0–23、`endHour` 1–24（`endHour` 小于 `startHour` 表示跨夜，如 `22 → 6`）、`days` 0–6。
- 一天里有**多个高峰窗口就写多条**（DeepSeek 是 09:00–12:00 与 14:00–18:00 两条）；写成一条会把两段并成一段，等于改价。
- 判窗用该 provider 的 `timezone`（默认 `Asia/Shanghai`）。

### `tiers[]`（按长度分段）

- 一个请求的**总输入长度**（未缓存 + 缓存读取 + 缓存写入）与**输出长度**决定命中哪一档；`inputMin`/`outputMin` 含、`inputMax`/`outputMax` 不含，省略即无界。
- 命中一档后，该请求的四个桶**整档**计价；一个都不命中则回落到行上的基准价（或当前 `periods` 的价格）。
- `periods[].tiers` 与行上 `tiers` **按下标对齐**（范围取自行上那份，时段那份只带价格），长度不一致时行为不可预期，别这样写。

### 单位与上限保护

- 文件里的数字一律是 **元 / 百万 tokens**（如果 `currency: USD` 就是美元/百万）。
- 插件内部把价格存成 **1e-5 元 的整数**（1 元/M = `100000`）。那是实现细节，**不要写进文件**。
- 任何一行的任何价格 > **100000** 会被判定为「抄了内部单位」，**整个文件被拒收**（不转换、不部分应用）。
- 其它拒收条件：一行重复声明、`providers` 里的时区不是合法 IANA 名、`models` 为空、字段缺失/越界、YAML 语法错误、顶层出现 `id`/`name`/`config`（说明你贴的是 patch 条目而不是表本体）。

**只要有任何一个错误，整个文件都会被丢弃**，插件回退到内置/显式配置，并打日志、在设置卡片上显示红字。这是刻意的：「一部分价格来自文件」比「文件没生效」更难排查。

---

## 3. 三个配方（给 Agent 的执行步骤）

### 3.1 用户给了一个链接

1. 抓页面（`web_fetch`），找到模型与价格表。
2. **先确认三件事**：币种（元/美元）、单位（每百万还是每千 token）、是否分「高峰/空闲」两档。
3. 逐模型写成行：空闲价写在行上，高峰价写成 `periods`。**不要**只写平均价或只写一档。
4. 高峰时段的定义（小时、星期、时区）页面一般有脚注，照着抄；页面没写就不要编。
5. 跑自检（第 4 节），确认输出与页面一致。
6. 按第 5 节模板回报，**必须附上来源 URL 与抓取日期**。

### 3.2 用户给了一张截图

1. `read_image` 读图。
2. 先确认币种与单位；截图里常常只有数字没有单位，**单位不明就问**。
3. 只抄图上**明确给出**的数字。数字被遮挡、被截断、需要换算（比如"每千 token"）、或同一格子有多个数字 → **问用户**，不要猜、不要取平均。
4. 自检后回报，并注明"价格来自截图（YYYY-MM-DD），未与官方页面核对"。

### 3.3 用户只说了一个模型名

1. 先确定它在哪条路由下：设置页每个分组的标题里带 `(id)`；或向本机 catalog 查询：

   ```sh
   curl -sS http://127.0.0.1:19387/billing/api/catalog \
     -H 'content-type: application/json' -H 'host: 127.0.0.1:19387' -d '{}'
   ```

   返回的 `value.providers[].id` 与 `value.providers[].models[].id` 就是可用的 `provider` / `model` 写法（该路由只接受 loopback + JSON，见 `src/host/fence.ts`）。
2. 再去官方价目页拿价格，按 3.1 执行。
3. **模型 id 用路由报告的名字**，不要自己拼 `-reasoner`、`-thinking` 之类。

---

## 4. 自检（强制）

```sh
node scripts/check-prices.mjs <文件>          # 校验 + 打印每行在真实时刻的有效价
node scripts/check-prices.mjs <文件> --json   # 机器可读（含错误明细）
node scripts/check-prices.mjs <文件> --at 2026-09-01T10:00:00+08:00   # 只看某一时刻
```

- 不传路径时检查默认位置 `$DSH_HOME/dsh-meter/prices.yaml`。
- 它用的是**插件同一个加载器**，所以它接受的文件插件一定接受。
- 退出码：`0` 通过 · `1` 文件有问题（逐条列出原因）· `2` 跑不起来（没构建 / 文件不存在）。
- 输出会给每行打印 4 个探测时刻（周一 10:00 / 13:00 / 15:00 / 周六 10:00，北京时间）的 `峰|闲 输入/输出/缓存命中`。**把你抄的数字和这份输出对一遍**，尤其是高峰窗口有没有落在正确的时间上。

通过时的样子（DeepSeek 官方价，节选）：

```
price file : docs/examples/prices.deepseek.yaml
model rows : 6
effective prices, 元 / million tokens
deepseek-official/deepseek-flash      峰 2/8/0.04      闲 1/4/0.02      峰 2/8/0.04      闲 1/4/0.02
deepseek-official/deepseek-v4-pro     峰 9/27/0.3      闲 4.5/13.5/0.15  峰 9/27/0.3      闲 4.5/13.5/0.15
```

---

## 5. 回报模板（给用户的回执）

```
已写入：<文件路径>（<N> 行）
来源：<URL 或 "截图（日期，未核对）">
自检：通过（node scripts/check-prices.mjs <文件>）
逐行：
  - <provider>/<model>  空闲 <i>/<o>/<c> · 高峰 <i>/<o>/<c>（元/百万 tokens，工作日 09:00-12:00、14:00-18:00）
生效：在计费卡片点一次「刷新」即可，不需要重启
注意：<没定价的模型 / 被显式配置覆盖的行 / 未建模的节假日 等>
```

---

## 6. 不要做的事

- **不要发明、估算、或"参考同类"填价格**。没有官方价就留空并告知，插件对未登记的模型按 0 计价并显示「未登记价格」。
- **不要把内部单位写进文件**（1 元/M = `100000` 是内部表示）。校验器会拒收，但别赌。
- **不要一行写多个 provider/model**，也不要重复声明同一个 key。
- **不要改 `~/.dsh/profiles/*/cordis.patch.yml`**，除非用户明确要求走 patch 路线（那是更高优先级的一层，见第 1 节）。
- **不要声称覆盖了法定节假日**：插件的时段模型只有小时 + 星期，没有节假日日历，所以官方「不含中国法定节假日」这条**未建模**，节假日会按高峰计价。要如实写进回报。
- **不要把截图里的多个数字平均或取其一**；不清楚就问。
- **不要改插件的内置默认表**去满足单个用户的价格（那是 `src/host/default-prices.ts`，属于发版内容）。

---

## 7. 排错

| 现象 | 最可能的原因 |
| --- | --- |
| 设置卡片显示红字「配置文件未生效」 | 跑自检看**第一条**错误；常见是单位写错、字段缺失、时区名拼错 |
| 日志有 `billing: price file ignored — …` | 同上，日志里就是原因 |
| 价格明显高了 10 万倍 | 把内部 1e-5 单位写进了文件 |
| 模型显示「未登记价格」且按 0 计费 | `provider` 或 `model` 与路由报告的不一致（最常见）；用第 3.3 节的 catalog 查 |
| 高峰价没生效 | `timezone` 写错、`days` 掩码不对、或两段高峰只写了一条 `periods` |
| 文件明明有价格却没生效 | 该行已在 patch / 设置页里显式配置（卡片会显示「N 行被显式配置覆盖」） |
| 改了文件界面没变 | 在计费卡片点一次「刷新」；host 重算时才会重读文件 |

---

## 8. 价格是怎么算的（保证你写的数字含义正确）

一次请求分成四个桶，各自乘自己的单价再求和：

- **未缓存输入** `input` · **缓存命中输入** `cacheInput` · **缓存写入** `cacheWrite`（不单独计费就是 0）· **输出** `output`
- 缓存命中率 = 缓存命中输入 ÷（未缓存输入 + 缓存命中输入）
- 单价单位是「每个 token 的价格 = 每百万价 ÷ 1,000,000」，插件内部用整数运算避免浮点误差
- 峰值判定用 provider 的 `timezone`；命中任一 `periods` 窗口即用该窗口价，否则用基准价
- 有 `tiers` 时，按本次请求的总输入长度与输出长度选档，整档计价
- 费用按 provider 的 `currency` 分账（`CNY` / `USD` 各自累加，不混算）
