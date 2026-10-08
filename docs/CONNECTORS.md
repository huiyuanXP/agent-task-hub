# MCP / CLI 安装与连接

网页 /install 和 JSON 接口 /install/manifest 给出当前服务的实际下载地址与命令。先在“连接与执行”创建项目授权码，再下载安装包。

```sh
curl -fL 'http://127.0.0.1:5173/api/connectors/download' -o agent-task-hub-connector.tgz
tar -xzf agent-task-hub-connector.tgz
node agent-task-hub-connector/cli.mjs install --url 'http://127.0.0.1:5173' --workspace '/absolute/git/project'
```

按提示输入授权码，或使用 --code-stdin 由标准输入提供。安装器复制运行文件到私有配置目录、保存专属凭据、添加项目 MCP 配置，并打印实际可用的启动命令。已经安装后，下载目录可移除。

```sh
node agent-task-hub-connector/cli.mjs doctor --workspace '/absolute/git/project'
node agent-task-hub-connector/cli.mjs mcp --workspace '/absolute/git/project'
node agent-task-hub-connector/cli.mjs agent --workspace '/absolute/git/project'
```

MCP 使用 STDIO JSON-RPC；stdout 仅传输协议，日志写 stderr。其他 MCP 客户端按安装器打印的 command/args 配置接入。常驻 Agent 通过 outbound HTTP 领取任务和发送心跳，不依赖远程 workspace 的 inbound 回调。

后台管理已注册客户端，区分 MCP 最近使用与 daemon 在线。心跳15秒一次，45秒内为在线，45–90秒延迟，超过90秒离线。模型认证错误单独显示，不把在线等同于能执行。

服务地址变化用 set-url --url 更新；卸载使用 uninstall。卸载本机配置与网页撤销身份是两个操作，网页撤销立即禁止后续工具调用和续租。保留连接历史。

工坊自己的仓库也可用相同方式关联为一个 workspace；项目绑定名必须与点子/Ticket 的项目一致。不要把没有关联仓库的普通项目当成已经具备开发执行能力。

## 本机 Codex 配置与 Profile

客户端默认继承本机 Codex 的默认模型、provider 和认证配置，不要求已有 API 网关用户重新 Device 登录。使用 --profile mimo 或 --profile oneapi 可以选择本机已有的配置文件；具体名称及模型以安装机器的实际配置为准。

```sh
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs agent --workspace /absolute/project --profile mimo
node /absolute/project/.agent-task-hub/runtime/1.0.0/cli.mjs doctor --workspace /absolute/project
```

显式选项保存在本机客户端配置，不复制模型凭据。--profile default 恢复默认 Profile；省略 --model 和 --reasoning 时沿用 Codex 配置。后台连接记录显示所选 Profile、模型和 provider，实际调用失败时显示真实错误。

使用官方账户认证方式且本机尚未登录时，仍可自行 codex login；已有 Profile 的 API 认证由本机 Codex 处理。独立于 CLI 的直接 API Call 适配器另有后续 Ticket，尚未实现。
