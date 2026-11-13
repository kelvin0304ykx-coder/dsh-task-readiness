# DSH Task Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-executing-plans to implement this plan task-by-task.

**Goal:** 实现按当前任务和会话给出可核验就绪检查、探测、受控处理与复检的独立 DSH 插件候选。

**Architecture:** 无 I/O 的任务协议和诊断规则为核心；宿主适配器只提供精简、带时效的事实。Agent 工具与客户端入口共用报告和动作服务；对外副作用通过宿主管线和确认执行。自然语言交给当前会话，不另开模型。

**Tech Stack:** TypeScript、Node 24 内置测试器、DSH 0.2.2-rc.2 SDK、宿主 React 与模块加载器。构建产物预打包，不要求用户运行安装脚本。

**Spec:** [完整版设计](<../../完整版设计.md>)。用户于 2026-11-13 确认进入实现。

## Global Constraints

- 独立项目开发，不修改日常 DSH 配置、权限、模型或安装包。
- 第一版同时包含自然语言与任务模板，不自动启动隐藏的模型调用。
- 首批六类适配：web、files、image、office、browser、mcp；未知不视为通过。
- 最多 24 个能力节点；外部探测须确认且有范围、预算与取消。
- 自动变更仅限本插件任务配置；其它问题提供明确指引；never 审批不可绕过。
- 不发布、不上传；候选本地包名暂用 dsh-task-readiness，private=true，许可证暂标 UNLICENSED。
- 不使用真实客户数据，测试环境不继承日常 DSH_HOME 或凭据。

## Review Focus

1. 同名第三方工具冒充内置工具：不得因此取得自动探测权限。
2. 执行中切换模型或改变目录：旧证据和操作确认失效。
3. 探测超时后仍有外部副作用：显示未知结果，禁止自动重复执行。
4. UI 切换会话或迟到响应：不能展示或批准另一会话的计划。
5. 错误消息含地址、账号或凭据：模型结果和分享导出都只返回允许字段。

## 文件与职责

- src/core/types.ts：任务、快照、报告、探测与处理计划类型。
- src/core/intent.ts：严格校验意图、内置模板、自然语言交接文本。
- src/core/diagnose.ts：能力规则、依赖路线与分项报告。
- src/core/privacy.ts：报告摘要、分享格式和输出允许字段。
- src/core/actions.ts：计划、确认、过期、单次执行、回执、任务选项恢复。
- src/host/snapshot.ts：会话身份、工具准入、路由、权限与最小事实。
- src/host/probes.ts：已知范围内的安全探测适配，禁止任意命令/URL。
- src/host/service.ts：会话级报告与计划所有权、生命周期和容量。
- src/index.ts：宿主插件、工具与受限交互入口。
- src/client.ts：宿主客户端模块中的任务入口、报告、确认与取消。
- tests/core.test.ts、tests/actions.test.ts、tests/snapshot.test.ts、tests/host.test.ts、tests/client.test.ts：分层行为测试。
- scripts/build.mjs、scripts/check-package.mjs、scripts/integration.mjs：构建、包审计、隔离宿主验证。
- docs/implementation-ledger.md：逐任务红绿测试、裁决、验证范围和恢复入口。

## Task 1 任务意图与诊断核心

**Interfaces:** parseIntent(unknown): TaskIntent；templateIntent(id): TaskIntent；diagnose(intent, snapshot, clock): Report；shareReport(report): ShareReport。

- [ ] 写 tests/core.test.ts：24 节点上限、未知字段拒绝、没有准入时不冒称可用、ready=true 不等于实测、Office 技能未激活、路由未知、AND/OR 路线、过期证据和导出隐私。
- [ ] 先运行 Node 测试，观察缺失实现导致的红灯。
- [ ] 实现上述四个纯函数与类型，使用手工确定的期望值，不用同一个构造器生成实际与期望。
- [ ] 全套核心测试转绿，记录结果。
- [ ] 提交该独立单元的代码和测试。

## Task 2 探测与受控处理状态机

**Interfaces:** ActionStore.plan(owner, report, request): ActionPlan；confirm(owner, id, digest, revision): ActionPermit；execute(owner, id, permit, snapshot, executor, signal): ActionReceipt；cancel(owner,id): void。

- [ ] 写 tests/actions.test.ts：跨会话、过期、模型变化、重复提交、取消、never、无费用同意、超时未知结果、配置回滚冲突。
- [ ] 红灯后实现严格枚举动作与一次性确认；任何参数不得带脚本、可执行命令或任意 URL。
- [ ] 执行器仅作外部依赖，测试断言 ActionStore 的状态和次数，不断言 mock 是否存在。
- [ ] 全套转绿；记录并提交。

## Task 3 宿主快照与诊断工具

**Interfaces:** captureSnapshot(ctx, agent, toolSet, capturedStep): Promise<SessionSnapshot>；ReadinessService.check(owner,intent,context): Promise<Report>；getReport(owner,id): Report。

- [ ] 写快照测试：tools.schemas 传入准确作用域与准入集、不能使用下一轮模型替代本轮、MCP 状态未知、Office 下一步激活、无服务降级、冷会话不唤醒。
- [ ] 红灯后实现公开 SDK 适配，提取允许字段，不遍历凭据或私有状态。
- [ ] 注册 readiness_check/readiness_probe/readiness_remedy，参数与返回 schema 严格；未知调用者拒绝。
- [ ] 用真实 SDK 注册和调用测试；区分合成宿主服务与真正部署验收。
- [ ] 全套转绿；记录并提交。

## Task 4 真实探测与复检

**Interfaces:** createProbeExecutor(authorizedHost): ProbeExecutor；execution outcome 包含 succeeded/failed/cancelled/outcome_unknown，不能伪造 passed。

- [ ] 写测试证明未确认不会调用外部依赖、只运行允许的探测、网络响应壳不算成功、清理只处理自己创建的资源。
- [ ] 实现六类能力的静态状态及有公开安全入口的最小探测；不支持的后端返回 unavailable/unknown，不用替代路径绕过权限。
- [ ] 支持经确认的本插件任务输出位置/替代路线调整与复检；技能加载是明确的准备动作，不宣称可无痕回滚。
- [ ] 测试 Native/PTC 调度、取消与单次调用；记录并提交。

## Task 5 客户端任务入口与报告

**Interfaces:** 宿主允许的会话交互入口；共用序列化的 Report/ActionPlan，不另算绿勾。

- [ ] 写 tests/client.test.ts：空会话、选择模板、自然语言发送提示、错误与未知状态、切换会话、迟到响应、确认、导出脱敏。
- [ ] 实现宿主客户端模块，使用宿主 React；不建替代 Web 服务，不修改原 App shell。
- [ ] 客户端首次打开不发模型请求、不恢复冷会话、不执行探测。任何激活或普通对话发送均由明确用户动作触发。
- [ ] 全套转绿并视觉检查；记录并提交。

## Task 6 构建与隔离安装验收

**Files:** package.json、cordis.patch.yml、构建脚本、包审计脚本、使用说明与验收记录。

- [ ] 构建前声明精确 DSH 版本、peer/dev 依赖，默认不运行第三方安装脚本。
- [ ] 包审计：只含预构建代码、公开文档和必要资源，不含研究归档、测试状态、私人信息、凭据或 node_modules。
- [ ] 在隔离 DSH_HOME/profile 中做配置组合、启动、工具注册、报告读取、重启和卸载；不得继承生产配置。
- [ ] 真实外部计费探测不自动执行；已有 mock/in-process 结果不能被称为真实后端通过。
- [ ] 当前 GUI 不因启动另一个服务而更新；隔离测试服务如确需另启，先取得具体授权，不冒充现有入口已部署。
- [ ] 完整测试、类型检查、包检查和最终差异审查；保存准确未验证范围。
- [ ] 交付本地候选 tarball、使用说明和验收报告，不推送发布。

## 执行记录约定

由当前执行端在本会话直接实现，不启动未授权的额外模型。每任务在工作账记录目标、文件范围、红灯证据、绿灯证据、裁决与剩余风险。无既有 Git 仓库，因此在已隔离项目目录初始化本地仓库，不复制或移动原业务材料。设计已批准，普通实施步骤不再重复征求同一授权；新增外部副作用、真实账号测试或发布另行确认。
