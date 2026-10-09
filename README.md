# 点子工坊 · Agent Task Hub

本机任务工作区：点子 → Plan → Tickets → 批准开发 → Agent 执行 → 结果与验收。支持按项目安装 MCP/CLI，后台查看注册客户端及常驻 Agent 的通信状态。

本机主开发目录为 `/home/agent/projects/agent-task-hub`，使用 `main` 分支。
数据库与运行资料保存在 `.local/`，已安装的 MCP 客户端位于 `.agent-task-hub/`。
项目 `.codex/config.toml` 提供 `agent_task_hub` 连接；具体启动与收尾步骤见[本机部署](docs/DEPLOYMENT.md)。

使用 Node.js 22.23.3 或更新版本，原生 Next.js/React 与本地 SQLite。保留 package-lock.json。

```sh
npm run install:ci
npm run build
npm run accounts -- create owner
npm start
```

账户命令会从终端提示读取密码。默认地址 http://127.0.0.1:5173，数据库 .local/data.sqlite，网页登录入口 /signin。启动时自动应用尚未执行的有序 SQL；已有数据不会在普通重启时清空。

在“连接与执行”创建项目授权码并下载 MCP/CLI 包。/install 提供可点击指南，/install/manifest 提供机器可读安装接口。客户端在目标 Git 仓库运行安装命令，关联项目并添加 MCP 配置；常驻 Agent 使用本机 Codex 默认配置或 --profile 选择的模型/provider/认证，不向工坊上传模型凭据。

规划任务不会自动批准开发。开发执行在独立 Git worktree 中进行，网页记录批准范围、实际变更与测试，用户验收后才完成 Ticket。手工快照、本机 Agent 开发和固定 Docker 操作分别显示。

- [本机部署](docs/DEPLOYMENT.md)
- [账户、客户端授权与撤销](docs/AUTHENTICATION.md)
- [客户端安装与 workspace](docs/CONNECTORS.md)
- [规划与修订](docs/PLANNING.md)
- [详情页字段映射与页面结构](docs/DETAIL-PAGES.md)
- [执行和验收](docs/EXECUTION.md)
- [原生执行接口衔接评估](docs/EXECUTION-INTEGRATION.md)
- [固定 Docker Runner](docs/RUNNER.md)
- [实际功能清单](docs/FEATURES.md)
- [测试说明](docs/TESTING.md)
- [后续工作](docs/ROADMAP.md)

开发检查使用 npm run build、npx --no-install tsc --noEmit、npm run lint 和与变更相关的测试；客户端与 workspace 测试使用 npm run test:connectors。Docker 检查需要真实本机 daemon 和锁定的镜像，不能以本机 Agent 测试替代。

私有数据库、凭据、执行日志与 worktree 不进入 Git。保留 vendor、public 和 vendored skills 中的第三方许可说明。
