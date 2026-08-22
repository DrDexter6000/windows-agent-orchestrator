# 治理成本基线 v1（2026-08）

> 来源：决策 0027（第三方审计处置，Owner 裁定"治理称重可做"）。
> **硬约束（Owner，2026-08-22）：测量 ≠ 裁剪授权。** 本文档只提供事实；部分流程系 Owner 作为人类刻意为之，任何砍流程动作须 Owner 另行裁定。本文不是考核工具。

## 口径与局限（v1，如实）

- **席位计数视图**：全量、精确——按 `runs list` 的 agentId 与终态统计，窗口 2026-08-08 起。
- **token/费用视图**：仅样本实测——`runs list` 投影不含每 run token，全量聚合需逐 run 调 `runs metrics`（数百次），v1 不做；选 R23-F/B 尾段已知闭环 + 当日咨询共 6 个 run 实测。
- **口径外**（本基线未计入，避免误读为完整治理成本）：delivery 管线内部的 verification/reverify 执行（发生在交付 run 内部，非独立 run）；Lead 自身的会话开销。
- 已知数据缺口：kimi lane（coder_mm）不回报 token 指标，评审双席的费用对比不对称。

## 数据 A：席位计数（2026-08-08 → 2026-08-22，直接 run 共 751）

| 席位 | runs | 非完成终态 |
|---|---|---|
| coder_hq | 215 | 46 |
| researcher | 160 | **153** |
| coder_mm（评审席） | 130 | 8 |
| auditor（评审席） | 107 | 19 |
| coder_low | 106 | 17 |
| tester | 19 | 0 |
| coder_ox | 13 | 0 |
| coder_hq_deltadrill | 1 | 0 |

**初读**：评审席合计 237/751 ≈ **31.6%** 的直接 run 用于评审/咨询。这是份额事实，不是问题判定。

复现命令：

```bash
npm run --silent cli -- runs list --format json | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const arr=(d.runs||d).filter(r=>/^run_/.test(r.runId)&&r.runId>='run_20260808');
const by={};for(const r of arr){const a=r.agentId||'?';by[a]=by[a]||{n:0,f:0};by[a].n++;if(r.state!=='completed')by[a].f++;}
console.log(arr.length,JSON.stringify(by))"
```

## 数据 B：R23-F/B 尾段样本闭环实测（逐 run `runs metrics`）

| run | 角色 | 费用 USD | 墙钟 | tokens(in/out/cacheRead) |
|---|---|---|---|---|
| run_20260821234659938taczdu | 实现（Round B 主交付，coder_hq） | 7.58 | 8.09M ms | 637K / 68K / 4.66M |
| run_20260822003231890rduwil | 实现（Round B 追加交付） | 15.84 | 5.24M ms | 670K / 91K / 18.2M |
| run_20260822131130853cvdq7o | 实现（R3 断点续接，coder_ox） | 2.45 | 1.50M ms | 182K / 21K / 2.0M |
| run_202608221342182422mgr2h | 评审（auditor 复核-3） | 1.97 | 508s | 44 / 19K / 1.29M |
| run_20260822134218788foyo6j | 评审（coder_mm 复核-3） | n/a | 487s | kimi lane 不报 token |
| run_20260822171509567sz4zsv | 咨询（本次审计评审，auditor） | 0.95 | — | 20 / 9.4K / 393K |

复现命令：`npm run --silent cli -- runs metrics <runId> --format json`

## 附带事实

- researcher（deepseek lane）窗口内 153/160 终态非完成（96%）。与本决策无关，仅登记待查：该 lane 的失败是任务形状（探索型）、配额还是解析问题，值得一次独立诊断。
- 本批次自身即治理动作的实例：决策 0027 + 四条 TD 登记 + 本基线由 Lead 直接执行并 `wao declare`（too-small）登记，未派发实现席。

## 后续

- 观察阈值（审计建议 5）暂不设立：先积累 ≥2 期可比数据再谈，且设阈值的动作本身须 Owner 批准。
- 自动化聚合（把 per-run token 并入 `runs list` 投影或提供批量 metrics）登记为候选摩擦，待真实需要再立项——不在本轮扩面。
