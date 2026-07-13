# Decisions Map

<!-- 索引：所有决策。一行一条，不放正文。渐进式披露。 -->
<!-- 格式：<编号> | <标题> | <一句话> -->
0001 | state read 丰富查询（grep/过滤）
0002 | 单 agent 调 subagent 的 handoff 自动化
0003 | 旧 docs/ 体系迁移到 .wao/
0004 | WAO 开发文档自审：工具文档 vs 过程文档，迁徙适配分析
0005 | 角色矩阵定稿：Lead/Researcher/Coder-HQ/Coder-Low/Coder-MM/Tester/Auditor
0006 | 外部审计收口里程碑（P0-P2 处理）
0007 | Safety+Contract 收口里程碑完成（C1-C6）
0008 | agents.example.json 对齐决策 0005（进程式切线落地）
0009 | 2026-06-24 阶段性反思 — parser 证据链 bug + 臆测纪律
0010 | Lead-UX 方向：从"操作员"到"声明者"（指向 M7 的 UX 设计骨架）
0011 | 验收契约格式：选"用户验收脚本"（spike 收敛三选一，待 owner 确认）
0012 | daemon IPC 选型：命名管道（`node:net` over `\\.\pipe\wao-daemon`，T0b spike 后 owner 拍板）
0013 | 进程隔离 Job Object：复用 Node 内置（v22）vs 自定义实现（行业调研+零依赖约束后 owner 拍板）
0014 | FL7b coder_hq provider instability fallback
0015 | Worker credential boundary: minimize now, broker before unsupervised release
0016 | Supervised Phase 3C may resume; broker remains an unsupervised release boundary
