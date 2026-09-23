# 联合药研议事治理

创新药合作方在共同开发委员会中管理提案、回避、表决和僵局升级。

本仓库把一份最小议案合同（schema v1）扩展为**可审计的会议与表决流程**（schema v2）：
成员资格、授权代表、议题范围、回避关系、材料版本、评议窗口、法定人数规则与表决门槛
全部按生效时间保存；宣布时冻结完整计票包；任何人在同一时点复算得到相同结论。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/contracts.js` | 数据合同：v2 形状校验、v1→v2 迁移、规范化 JSON 与 SHA-256 摘要 |
| `src/engine.js` | 纯函数计票：时点有效集合、回避/授权/资格重算、密封票揭示、确定性计票包、更正视图、纪要渲染、秘书处待办 |
| `src/builder.js` | 只追加议事簿：所有变更为追加事实（新区间、新版本、新宣布、公开更正），从不改写历史 |
| `scripts/generate_fixture.mjs` | 由固定输入确定性生成 `fixtures/committee_council.json` |

## 核心规则

### 时态事实与版本
- 治理对象是半开区间 `[effective_from, effective_to)` 事实；变更 = 关闭旧区间 + 追加新区间。
- 规则按适用范围特异性（专题 > 议题类型 > 全局）与生效时间选择；计票包记录所用规则版本。
- 材料为不可变新版本；评议窗口钉住具体 `(material_id, version_seq, sha256)`。
- 议案修订登记 `changed_topic_ids`；**只有受影响议题需要重签**，未触及议题的既有批准继续有效。

### 密封意见（离线成员）
- 提交的是 `commitment = sha256(canonical(position, opinion, nonce, attachments))` 与收票时间、序列号；开票前只能确认收讫。
- 开票时揭示，承诺与揭示逐字节绑定，不符即剔除；迟到揭示不能改变已宣布结果。
- 同一席位多张票取**序列号最高者**（同序号取收票最早者），其余标 `superseded_within_seat`。
- 一张授权只产生一张表决：受权人代投后授权人本人票剔除（`authorization_mismatch`）；受权人被回避时授权在该议题不可行使。

### 回避、资格与法定人数
- 回避可临时披露（含回溯生效）、成员资格与授权可到期；**宣布前**这些变化在计票时点重算结果。
- 法定人数分母可选扣回避后有效席位（`eligible`）或全体在席（`seated`）。
- 门槛分母：`voting`（仅赞成/反对）、`present`（含弃权）、`eligible`（全员）；
  模式 `strict`（严格过半，平局不通过）与 `weak`（达到即可，用于 2/3 特别多数）。
- 赞成与反对持平且未过门槛为 `deadlock`（走升级），区别于 `rejected`。

### 宣布之后
- 宣布冻结当时计票包（规则版本、窗口、材料、有效席位、计票、剔除票、收讫未开票、少数意见）及摘要哈希。
- **宣布后发现的错误进入公开更正程序**：原宣布保留，追加更正链与按原修订复算的计票包哈希。
- 已形成的少数意见只追加，任何更正或修订都不覆盖。

### 升级、条件与安全紧急动作
- 僵局升级按层级、权限与本级裁决期限独立跟踪，逾期挂秘书处待办。
- 条件性批准：条件有独立期限，状态 `pending/satisfied/lapsed`。
- 安全紧急动作由 DSMB 权限**先行落账生效**，不受法定人数制约；追认是独立议题、独立窗口与期限（样例为 72 小时），逾期未追认挂待办。

### 通知与纪要
- 通知投递失败不阻断决定落账，但失败通知持续出现在秘书处待办，直至处理。
- 纪要按合作方权限隐藏附件（`visible_to`），但规则版本、有效成员集合、材料摘要、条件与少数意见对所有合作方完整。
- `full_digest` 恒为未脱敏正文哈希（跨视角一致），`view_digest` 为该视角哈希。

## 复算确定性

计票结果为 `f(记录, 议案, 议题, 时点[, 修订])` 的纯函数：

```js
import { loadRecord } from './src/contracts.js';
import { tallyIssue, renderMinutes } from './src/engine.js';

const record = await loadRecord('fixtures/committee_council.json');
const tally = tallyIssue(record, 'MO-018', 'T-MILESTONE', '2026-09-23T10:00:00+08:00');
const minutes = renderMinutes(record, { as_of: '2026-10-01T12:00:00+08:00' });
```

同一输入任意人、任意进程复算得到同一 `tally_digest`；样例文件本身可由
`npm run fixture` 跨进程逐字节重新生成（ID 与时间均为确定输入）。

## 版本迁移

v1 仅含标识与时间（`schema_version` / `record_id` / `domain` / `occurred_at` /
`revision` / `source`）。`loadRecord` 对 v1 自动迁移：这些字段原样保留、语义不变，
议事簿初始为空，由秘书处按发生时间补录。新增状态均为只追加，无需改写既有事实。

## 本地检查

- `npm test`：20 项不变量测试（迁移、回避重算、密封票、授权去重、修订重签、更正链、僵局、紧急追认、脱敏纪要、待办、确定性）。
- `npm run build`：全部源文件语法检查。
- `npm run fixture`：重新生成 v2 端到端样例。
