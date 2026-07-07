# 跨 Runtime Dogfood 对比：GLM-5.2 vs GPT-5.5（codex xhigh）

**日期**：2026-07-07
**类别**：调研（早期观察，非契约）
**触发**：round 4 换 runtime 后行为质变，需记录模型差异对 WAO 引导力的启示

## 背景

WAO dogfood 前 3 轮（round 1-3）用 GLM-5.2 via ZCode，round 4 换成 codex + GPT-5.5 xhigh。
同样的 SKILL.md、同样的任务 prompt、同样的实验目录结构——唯一变量是底层模型。
round 4 出现了前 3 轮从未发生的行为质变。

## 数据对比

| 维度 | R1-3 (GLM-5.2) | R4 (GPT-5.5) |
|---|---|---|
| friction 数 | 18 / 4 / 2 | 2 |
| **派 worker** | **从未**（3 轮全自做） | **✅ 派 1 个 researcher**（理性混合） |
| 派工决策质量 | "verification-cheaper" 一句话 | 对称成本账本逐维度论证 + 识别"公共基类重复读" |
| 假 declare | R3 写了文本没执行 | **根本没写**（不声明也不伪造） |
| 交付物证据密度 | 中等 | 极高（每格 `src/xxx.js:行号` 引用） |
| 主动坦白 | R3 坦白了假 declare | R4 无需坦白（没犯错） |
| 主仓库污染 | R1 污染 7 文件 | 0 |

## 关键洞察

### 1. "WAO 主控敷衍"的根因拆分

用户最初的抱怨（"只派一次 researcher 然后自己干完"）在 round 4 被**证伪**——
同样的 SKILL，GPT-5.5 做出了理性派工（派 1 个做交叉检查 + 自己整合）。

这意味着"敷衍"问题要拆成两层：
- **SKILL 引导力层**（已基本打磨收敛）：round 1-3 的 18→4→2 friction 收敛证明文档在持续变好
- **模型能力层**（本轮新发现）：GLM-5.2 即使读完打磨过的 SKILL，仍倾向自做；
  GPT-5.5 读同一份 SKILL 就能做出理性混合派工

**结论**：SKILL 的引导力有上限——它能把规则说清，但推不动一个本身不具备
"理性判断派工时机"能力的模型。换更强模型，同一份 SKILL 立刻产出高质量行为。

### 2. TD-85（执行可信度）的跨模型验证

round 3 (GLM) 出现"写了 declare 文本但没执行"，子代理主动坦白。
round 4 (GPT-5.5) 根本没碰 declare（既没声明也没伪造）。

两种行为都"没出错"，但机制不同：
- GLM：想 declare → 写了文本 → 忘了执行 → 坦白（纪律缺失但诚实）
- GPT-5.5：判断不需要 declare → 没写（判断准确，无需纪律约束）

**对 TD-85 的启示**：铁律 #6（交付物写命令 ≠ 已执行）对能力较弱的模型是必要的
护栏（防 GLM 那种"写了文本当执行了"），但对能力强的模型是冗余的（它根本不会
犯这个错）。**纪律的价值在于兜底弱模型，而非约束强模型。**

### 3. 派工 prompt 质量的模型差异

round 4 GPT-5.5 派给 researcher 的 prompt（见 `task2-researcher-prompt.md`）
写得非常专业：
- 明确"只读任务，不得修改文件、不得安装依赖"
- 6 个分析维度 + "引用具体文件/行号"
- "不要写文件，只在回复里给结果"

前 3 轮 GLM 没派工，所以没有可对比的 prompt 样本。但这说明 GPT-5.5 能产出
符合 SKILL"任务边界要写死"原则的高质量派工 prompt——这是 SKILL 一直要求
但之前无法验证的（因为 GLM 从不派工）。

## 对"是否测更多 runtime"的判断

### 建议测的

- **claude-code + claude-sonnet-4**（或同等 Anthropic 模型）：WAO 的 SKILL 原本
  是为 claude-code runtime 写的，但前 4 轮都没用真 claude-code 当 Lead。
  sonnet 的能力介于 GLM 和 GPT-5.5 之间，能补全"能力光谱"的中间数据点。
- **claude-code + GLM-5.2 via provider wrapper**：用真 claude-code runtime
  （而非 ZCode Agent）但底层走 GLM。这能分离"runtime 差异"（claude-code skill
  原生调用 vs ZCode Bash 调 npm run cli）和"模型差异"（GLM vs GPT-5.5）——
  round 1-3 的 GLM 是 via ZCode，混了两个变量。

### 不建议测的

- **能力显著弱于 GLM-5.2 的模型**：SKILL 的引导力对它们可能无效，
  且 WAO 的生产 worker 不用这类模型，测了数据无指导意义。

## 局限

- round 4 只跑了 1 次（n=1），GPT-5.5 的稳定行为需多次验证
- "GPT-5.5 派工"可能是这次任务的偶发——task2（backend 矩阵）天然有派工收益，
  换成别的任务（如 round 1 的纯审计）未必派
- 跨 runtime 对比受"SKILL 逐轮修订"干扰——R4 的 SKILL 比 R1 好得多，
  部分行为改善来自文档打磨而非模型差异

## 指针

- 4 轮 dogfood 的 friction log：`.dev/friction-log/dogfood-task*.md`
- round 4 派工 transcript：`runs/run_20260707225335046kqle8s.jsonl`
- round 4 派工 prompt 样本：`C:/Users/.../Temp/wao-dogfood-exp/task2-researcher-prompt.md`
- TD-82（declare）→ TD-85（执行可信度）→ 本文档：编排质量问题的三层深挖
