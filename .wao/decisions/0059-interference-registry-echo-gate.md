# 决定 0059：干扰登记册 B2 门修订——文件级失败"回响"判定（解除死机制）

- **日期**：2026-10-11
- **状态**：已实施（TD-255 批；supersede 0054 的 B2 条款，其余 0054 条款不变）
- **会审**：consult_20261011114551354jiqya4（opus+sol 双席，意见全采纳；两席独立构造的反例均成为本决定的判据输入）
- **背景（死机制实锤）**：node v22.23.1 实测——文件级根失败在任何子测失败时都回响
  `fileFailure={"message":"test failed"}`（昨日全量 canonicalRunner 与复现波 mcpRegistry 双样本）。
  0054 的 B2 门"fileFailure 在场即拒"因此对**一切有失败子测的文件**恒拒 ⇒ 资格闭集永不可满足
  ⇒ 登记册上线以来零洗白。B2 原意（防"挂死子测不进 tests[] 被搭车洗白"）必须保留，
  但"在场"不是可用的判据。

## 修订内容

**B2 门改名并收窄**：`file-failure-present` → `file-failure-unattributed`。
fileFailure 在场**且未被证为回响**才拒；`fileFailureDropped` 门同理（已证回响时被预算
丢弃的内容可证冗余，放行）。回响判定=纯函数 `fileFailureEchoOfSubtests`
（scripts/canonical-test.mjs，元测试双向钉），判据全部来自结构化事实：

1. `fileFailure`：`message==="test failed"` 且 `code==="ERR_TEST_FAILURE"` 且
   `failureType==="subtestsFailed"`（超时击杀=`testTimeoutFailure`≠此值）；
2. **逐文件 `test:summary` 在场**（"子进程跑完了"的完成性证明）且 `counts.cancelled===0`；
3. 带 file 的 `test:diagnostic` 计数===0（迟到异步错误只进 diagnostic，tests[] 看不见）；
4. tests[] 有 ≥1 条失败子测；
5. 子进程 `exitCode===1` 且无 signal。

**事实基础**（node v22.23.1 四形态事件流实测，探针 `%TEMP%\evprobe` 保留）：
纯回响=summary 在场；提前 exit(1)/exit(7)/被杀=**缺** summary；迟到异步错误=summary 在场
但 file 级 diagnostic ≥1；超时击杀=message/failureType 双异。两席反例（opus：失败子测+
延迟 exit；sol：失败子测+未完成子测退出 / 失败子测+迟到异步 throw）均被上述判据挡下。

**职责切分（opus）**：reporter 只记录事实（fileFailure 增 code/failureType、逐文件
fileSummary/fileDiagnostics 挂 suite、fileLevelOnly 列表），判定在消费侧唯一纯函数处。
旧报告缺字段 ⇒ 自然判非回响 ⇒ 拒（fail-safe：node 改文案 ⇒ 判据失配 ⇒ 拒，
方向永不放松）。布尔边界（sol）：仅 `===true` 放行，缺失/false/字符串一律按未证。

**透传链**：`firstRoundFailureDetail` 把判定结果放 detail 顶层 `fileFailureEcho`
（预算阶梯丢 fileFailure 时判定不跟着丢）；`isolation[].autoAdjudication` 带同名字段可溯源。

## 旧新混用（sol 表）

| reporter | runner | 行为 |
|---|---|---|
| 旧 | 新 | 缺事实字段 ⇒ 判非回响 ⇒ 拒 |
| 新 | 旧 | 旧 B2 门 ⇒ 拒 |
| 新 | 新 | 满足完整新资格才允许裁定 |

## 已知边界（如实入档）

- **嵌套 `t.test`/describe 容器条目**：容器失败行（"N subtest(s) failed"）也进 tests[]，
  需要各自的登记条目才能洗白——对使用该形状的文件（opus 盘点：m12-9-mcpDispatchContract、
  transcript.test.js）登记册依旧难命中；方向安全（多拒少洗），留待需要时再议。
- **不要求** `fileSummary.failed` 与 tests[] 失败条数严格相等（容器条目使 tests[] 偏多）。

## 同批相关修订（案 A/B，非 0054 契约面）

- **案 A**：零 `test()` 块的顶层脚本测试文件在 `node --test` 下 exit 0（单跑判 pass）
  但波内恒 missing（reporter 只为子测试事件建 suite）——TD-254 的 lineageClose.test.js
  即此形状，上批"并发抖动"诊断有误（迁 lock 波无效，已回退 git 组）。reporter 新增
  `fileLevelOnly` 事实；missing 的 failureDetail reason 引用该事实（可判定，非猜测）。
- **案 B（canonicalRunner TD-181(b)④ 波内间歇翻红）**：两席一致否决"直接登记洗白"
  （签名事先不可知=猜；该测试是 runner 报告管线的端到端金丝雀，洗掉它=静音唯一的文件级
  归因证据）。处置=取证面先行：断言消息带 groupError 原文、失败保留夹具、runChild/
  readReport 双包装记录子进程退出事实与读盘瞬态、中间报告快照防聚合覆盖；生产侧
  `realReadReport` 三臂分类（ENOENT=null / 其他读错误抛带码 / 解析失败抛 unparseable）
  + 波级 groupError 时聚合报告带 `childStderrTail`。日常全量充当复现循环；复发后按
  机制定修（产品侧瞬态→带日志有界重试；环境侧→实测签名登记+衰减）。若连续 K 次全量
  （基准 10 次）未复发，以"未复现、取证面保留"关闭。
- **报告 schemaVersion 6**（加性）：executionWaves[].childStderrTail（仅 groupError 波）、
  failureDetail.fileFailureEcho、isolation[].autoAdjudication.fileFailureEcho。

## 验收证据

- canonicalRunner 138/138（新增：判定函数 12 反例双向钉、realReadReport 三臂、
  **端到端正例=登记册史上首次真实洗白**（真实子进程管线 verdict=pass auto_adjudicated=1，
  首红事实保留）、sol 双反例端到端不洗白）；
- reporter.test.js 事实钉四条（summary 挂载/诊断计数/code+failureType 保留/fileLevelOnly）；
- 全量满分见批次终报。
