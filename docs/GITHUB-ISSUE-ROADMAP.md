# GitHub issue roadmap 索引

目标仓库：`huiyuanXP/agent-task-hub`。审查日期：2026-10-04 UTC。

状态：已发布 26 个工作条目及 1 个总览 issue。总览：https://github.com/huiyuanXP/agent-task-hub/issues/27。所有条目区分已实现、部分实现、未接通和未实现；不重复把已完成的本地验证列为未实现功能。

以 GitHub issue 作为后续路线图；本文件为本次发布索引，GitHub issue 为后续路线图。P0 为生产/真实执行的门槛，P1 为核心闭环与质量，P2 为后续扩展/运维，P3 为暂缓的产品决策。

| 标识 | 优先级 | 阶段 | Issue 标题 |
| --- | --- | --- | --- |
| `baseline` | P1 | 基础工程 | [合入已验证的 VM1 初始化修复，补齐可复现开发配置](https://github.com/huiyuanXP/agent-task-hub/issues/1) |
| `lint` | P1 | 基础工程 | [修复导入源码的 49 个 lint 错误和 2 个 warning](https://github.com/huiyuanXP/agent-task-hub/issues/2) |
| `ci` | P1 | 基础工程 | [建立锁文件安装、构建、迁移和 API/浏览器回归的 CI](https://github.com/huiyuanXP/agent-task-hub/issues/4) |
| `auth` | P0 | 独立服务 | [独立部署：实现真实登录、会话和可信身份边界](https://github.com/huiyuanXP/agent-task-hub/issues/3) |
| `deployment` | P0 | 独立服务 | [独立部署：确定宿主并准备新资源、数据库绑定和迁移机制](https://github.com/huiyuanXP/agent-task-hub/issues/5) |
| `backup` | P0 | 独立服务 | [建立加密备份、隔离恢复演练和 owner 映射方案](https://github.com/huiyuanXP/agent-task-hub/issues/7) |
| `planner` | P1 | 自动规划 | [接通真实 AI Planner：保存点子后自动规划并回写 Tickets](https://github.com/huiyuanXP/agent-task-hub/issues/8) |
| `idea-revision-job` | P1 | 自动规划 | [修复点子修改后不自动创建当前修订规划任务的问题](https://github.com/huiyuanXP/agent-task-hub/issues/9) |
| `planning-recovery` | P1 | 自动规划 | [为规划事件增加后台补投递、租约恢复和可见失败状态](https://github.com/huiyuanXP/agent-task-hub/issues/10) |
| `mcp-task-read` | P1 | 任务接口 | [增加 MCP 的 Ticket/Plan 列表、详情和关联 Run 查询能力](https://github.com/huiyuanXP/agent-task-hub/issues/11) |
| `run-model` | P0 | 受控执行 | [完善执行 Run 模型：冻结修订、幂等创建和真实状态机](https://github.com/huiyuanXP/agent-task-hub/issues/12) |
| `workspace` | P0 | 受控执行 | [建立隔离执行工作区及受限文件系统/网络边界](https://github.com/huiyuanXP/agent-task-hub/issues/13) |
| `approval` | P0 | 受控执行 | [实现执行授权、审批和不可混淆的审计记录](https://github.com/huiyuanXP/agent-task-hub/issues/15) |
| `runner` | P0 | 受控执行 | [接入受控 Agent/app-server 执行适配器和生命周期管理](https://github.com/huiyuanXP/agent-task-hub/issues/16) |
| `mcp-task-execute` | P1 | 任务接口 | [增加 MCP 领取执行任务、续租和回报进度/证据的协议](https://github.com/huiyuanXP/agent-task-hub/issues/17) |
| `execution-events` | P1 | 受控执行 | [实现持久执行事件、顺序游标和断线重放](https://github.com/huiyuanXP/agent-task-hub/issues/18) |
| `execution-recovery` | P1 | 受控执行 | [实现取消、断线重连、租约回收和终态对账](https://github.com/huiyuanXP/agent-task-hub/issues/20) |
| `execution-ui` | P1 | 受控执行 | [增加真实执行进度、等待原因、审批动作和验收证据 UI](https://github.com/huiyuanXP/agent-task-hub/issues/21) |
| `scheduler` | P2 | 扩展能力 | [实现周期任务与可暂停、幂等的调度服务](https://github.com/huiyuanXP/agent-task-hub/issues/24) |
| `queue` | P2 | 扩展能力 | [将执行队列、优先级和 Ticket 依赖从文本变成调度约束](https://github.com/huiyuanXP/agent-task-hub/issues/22) |
| `quota` | P1 | 受控执行 | [实现预算、模型/执行额度和实际成本限制](https://github.com/huiyuanXP/agent-task-hub/issues/19) |
| `observability` | P1 | 运维保障 | [补齐独立服务的日志、指标、告警、健康检查和保留策略](https://github.com/huiyuanXP/agent-task-hub/issues/23) |
| `pilot` | P0 | 验收与切换 | [完成单 Ticket 真实执行试点和授权/重试/故障测试](https://github.com/huiyuanXP/agent-task-hub/issues/25) |
| `cutover` | P0 | 验收与切换 | [制定分阶段迁移、对账、切换和回滚计划](https://github.com/huiyuanXP/agent-task-hub/issues/26) |
| `pairing` | P3 | 待产品决策 | [决定是否恢复设备配对，并明确页面的暂缓状态](https://github.com/huiyuanXP/agent-task-hub/issues/6) |
| `release-policy` | P2 | 运维保障 | [完成依赖/许可审查和离线字体、CSP 发布策略](https://github.com/huiyuanXP/agent-task-hub/issues/14) |

## 建议推进顺序

1. 合入初始化修复，修复 lint，建立回归 CI。
2. 优先接通真实 Planner，修复点子修订/规划恢复，并补 MCP Ticket 读取；独立对外接入以前先完成可信身份与新资源配置。
3. 实现授权、隔离工作区、Run 状态与真实执行后端，再接执行 MCP、进度、取消/恢复和证据 UI。
4. 通过单 Ticket 故障试点后，另行授权独立发布/生产迁移；周期、队列和设备配对按对应阶段推进。

完整中文 issue 正文及可重复执行的发布脚本保存在 `/home/agent/work/agent-task-hub/initial-validation/github-issues/`，不包含 provider token、签名秘密或生产数据。

本次仅获得创建路线图 issue 的授权，不代表立即实施条目、推送现有代码、公开部署或迁移原 Site。
