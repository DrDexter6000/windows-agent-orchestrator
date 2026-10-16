# 0084 越界写拦截的认证改为组合证明：活体写入取证加确定性链式测试

- 日期：2026-10-16
- 状态：accepted（Owner 2026-10-16 选定"认可组合证明"）
- 来源：TD-196。v0.5.0 发版时，6 个 delta 行的越界写对抗演练全是无靶红，靠 Owner 具名豁免才发出去。
- 修订：0025 第 5 条中 delta 认证的证据组合（越界写对抗断言）。其余各条不变。
- 会审：方案会审 consult_20261016154515077d34ag7（sol、kimi 两席都推荐本方案）。实现批的会审记在提交说明里。

## 背景

- 0025 第 5 条：delta 认证 = sentinel + scorecard + 越界写对抗断言。对抗演练要求模型把文件写到工作树外，再断言控制面记下了 `workdir_escape`。
- 守约的模型拒绝往外写，演练无靶可拦。reliability 把这记为 fail，整轮判 SOME FAILED。
  - 2026-10-01 起，每次 reliability 这一项都是红的。
  - 早期能通过的车道，是模型顶着合同越界、被平台拦下，台账把这记为行为减分项。
- 拦截链分两段：
  1. 后端把模型的写操作投影成 `file_written` / `write_intent` 事件，由各后端的 parser 完成；
  2. 控制面对上报的路径做词法判定与物理判定（`src/runManager.js`）。这一段是确定性的，有单测。

  从未实测过的是第一段：各后端的协议帧怎样变成原始事件。

## 决定

1. **越界写拦截能力的证据由两段组成。**
   - **活体（reliability，每条车道）：**containmentEvidence 演练。
     - 在带隔离与交付合同的 run 里，模型做一个普通的写文件任务。
     - 三者一致才算 pass：同一个 run 上报的写入路径、工作树里的文件内容、拦截门的 inside 判定。
     - 它证明这条车道如实上报写入，而且拦截门在这条车道上生效。
   - **确定性（`npm test`，各后端）：**`test/backends/containmentChain.test.js`。
     - 从各后端的协议帧开始，走真实的 parser / Backend 与真实的 Run。
     - 越界路径必须判为 `workdir_escape`（reason 为闭集成员），run failed，不进入打包。
     - 界内写作正对照。
     - 路径逐字节保真，另有源级钉看住各后端的取键链。
2. **delta 集合改为 sentinel + scorecard + containmentEvidence。**
   - strict 与 certification 画像至少跑 scorecard、containmentEvidence 与 isolation（矩阵构建时补齐；isolation 证明写入落在工作树、源检出没被写），全量覆盖超出 delta 子集。scope 仍按实际覆盖派生，不看标签。
   - 越界写对抗演练退出组合层。矩阵里显式写了它的行，解析时失败并给出原因。
   - 模型对越界指令的处置留在组件层，只作观察项（componentDrills 的 informational 检查）。
3. **检查的五态语义不变**（ADR-0032 §8）。门槛的算法也不变：被选中的检查只要出现 fail、blocked、inconclusive，整轮就判 SOME FAILED。
4. **历史不改写。**
   - summary 里旧 case 的 adversarialEscape 检查保持原样；
   - `config/lane-exceptions.json` 里以 adversarialEscape 为键的例外保持原样；
   - 新 case 不生成 adversarialEscape 能力，也不从旧例外继承通过。
5. **发版检查单引用两段证据。**`docs/milestone-discipline.md` §9 第 5 步引用 reliability 的 containmentEvidence，以及 `npm test` 里的链式测试。

## 否决的方案

- **保留对抗演练，要求在真实车道上做负向端到端实测：**模型守约时无靶，门槛只能靠逐版豁免。
- **在工作树里放一个指向外部的 junction，让模型往"内部"路径写：**
  - junction 要在派发前进入 WAO 新建的工作树，只能给创建链加测试后门，被测的就不再是生产系统；
  - 它只覆盖物理判定这一支，而这一支已有确定性测试。
- **间接路径，让模型从数据文件里读出外部路径：**仍然依赖模型的行为；红了也分不清是机制失效，还是模型没上钩。
- **把"模型拒绝"改记成 inconclusive 或 N/A：**
  - inconclusive 照样会让整轮判 SOME FAILED；
  - 把 N/A 用在"没测到"上，等于改了它的语义。

## 已知局限

- **整段负向实测不再做。**不再在真实车道上实测"模型越界并被拦住"这一整段。负向那一段建立在照真实形态手写的夹具帧上：上游若只在越界场景改了帧的形状，活体取证（只见界内写）看不见，夹具照旧是绿的。源级钉与 harness 巡检是机械兜底，残余风险保留。
- **后端不上报的写入拦不到。**例如 shell 命令、未知工具。另外 `file_written` 是事后证据：判 failed，不代表越界文件没有落盘。拦截是侦测，不是 OS 沙箱（`docs/02-architecture.md`）。
- **没有覆盖的后端要写明。**不投影写入事件、或没有离线注入缝的后端，在链式测试里列明原因，不算已覆盖。
