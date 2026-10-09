# Workspace 闭环验收记录

当前实现提供项目专属 MCP 安装、连接监控、自动规划、批准开发和网页验收，常驻 Codex 可以继承本机默认配置或使用指定 Profile。

## 已验证

- 原生 Next 构建、完整 TypeScript 与 ESLint 检查通过。
- 连接领域8项、开发 Run 领域15项、独立客户端12项行为检查通过。
- 实际从 HTTP 下载客户端归档，解包安装到新 Git 项目，安装记录与后台连接 ID 一致。
- 真正的 STDIO 进程完成初始化、工具列表、报点子、报 Ticket 和查询，没有账户审批工具泄漏给客户端。
- 显式测试模型 runner 验证规划与开发流程，实际独立 worktree 产生 diff，实际 Node 测试产生退出码与输出，Chromium 完成 owner 验收。
- 心跳、重启身份保持、凭据撤销通过；服务检查验证在线/延迟/离线阈值，客户端检查取消、期限、崩溃停止和不重复启动。
- 原有本地认证 API、只读 Ticket/Plan/Run MCP、规划修订/恢复/生命周期/浏览器、执行审批浏览器及两实例隔离 API/浏览器回归通过。
- 登录浏览器测试修正响应释放夹具后通过，仍验证拒绝之前核实的旧 session 不能恢复私有状态，没有修改应用认证逻辑。

## 本机 workspace 与保留记录

- 点子工坊自身已安装并关联到项目“通用”，连接 `18a4de4d-4405-4ce8-adb2-54375d93f3fd`。
- 主开发目录为 `/home/agent/projects/agent-task-hub`，使用 `main`；主连接配置与 MCP 运行文件位于 `.agent-task-hub/`。
- 数据库 `.local/data.sqlite` 保留已有账户、40 条业务记录、2 个连接和执行历史；安装身份在 workspace 整理后保持一致。
- “工坊验收 Test”连接 `81514e3d-54da-4571-abde-f0270a48adca` 的测试项目、三份未提交改动和验证资料保存在 `.local/evidence/workspace-materials-2026-10-09.tar.gz`，执行记录保留在数据库。
- 主目录中的真实 STDIO MCP 读取到“通用”项目的 22 张 Ticket，其中 4 张完成，18 张进入后续处理范围。
- 任务开始提交作为固定交付基准；客户端 13 项行为测试通过，覆盖模型自行提交修改与保留未跟踪文件的交付场景。
- 详情信息分组 Ticket 的真实 CLI Run `cdff196e-1b42-4ef1-9bf7-6884e7c7afa2` 已交付为待验收，字段映射见 [DETAIL-PAGES.md](DETAIL-PAGES.md)；5 项现有针对性检查通过，结果已集成到 `main`，diff、文件和检查回执按 Run ID 保存在 `.local/evidence/`。
- 用户两个点子通过工坊自身已安装的项目 MCP，由当前真实主控 Agent 领取并回写，各生成一个 Plan 和三个 Tickets。
- 当前主控会话通过测试项目客户端领取一条已批准的 sum 修复 Ticket，委派真实 `gpt-6.1-sol` 子 Agent 在独立 worktree 修改 `sum.mjs`，实际 `node --test sum.test.mjs` 通过。
- 真实主控执行 Run `552b359a-f226-4f3f-8a00-6d154fa0a658` 的代码差异与测试已回写；Chromium 点击验收后，Ticket 完成并升到 v2，页面错误为零。

这条真实模型执行来源是当前主控会话，区别于独立常驻 Codex CLI；自动化测试中的模型 runner 也明确标记为测试替身。

## 真实常驻 CLI 与 Profile

客户端继承本机的模型/provider/认证配置，不再绕过用户配置或把官方账户登录当成 API 网关的前提。真实默认配置 gpt-6.1-sol / oneapi 已直接调用成功，无需新的 Device 登录。命名 Profile 使用 --profile，显式模型/推理选项仅在用户选择时传入。

用户新点子由常驻 CLI 自动生成 Plan“简化点子、计划与任务详情的信息层级”和六个 Tickets，包含信息分组、阅读/编辑模式、点子详情、Plan 关联任务、Ticket 字段解释和完整查看路径验收。

测试项目的真实常驻 CLI 修复 sum 后提交实际 Git diff 与 Node 测试结果。修复前失败、修复后通过的测试过程保留在事件中；最终结果使用每个相同测试命令的最后一次真实执行，未重跑的失败仍阻止交付。

Profile/模型/provider 通过无凭据的心跳元数据显示在后台，模型凭据仍保留在本机。连接元数据白名单检查九项、客户端配置/生命周期检查十四项及测试结果判断的两个回归场景通过；构建、类型和 lint 通过。

## 后续独立任务

独立于 Codex CLI 的直接 API Call 适配器已建立 P1 Ticket：ticket_0611f814c83da31ae52859815074a0a26883c5a32e65eab7b0f68caf11de8adc。用户可以保留官方 Codex 登录方式，已有 API provider/Profile 不需要重新登录。

本机没有 Docker daemon，容器执行检查未进行，强制 Docker CI 保留。GitHub PR #39 仍待独立适配，当前本机开发接口不声称完全兼容它的协议。
