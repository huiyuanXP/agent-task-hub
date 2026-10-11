# 本地固定操作 Runner

Runner 是独立 Node 签名服务，应用管理审批和 Ticket 的逻辑/物理占用，Runner 管理固定容器操作、日志、产物和停止证据。它与本机 Codex 开发 Agent 是不同的执行方式。

需要真实本机 Docker daemon、Linux flock/proc 和登记的锁定 Node 镜像。默认 ticket.validate.v1 在无网络、无凭据的容器内校验冻结 Ticket，不能任意访问宿主仓库或执行自然语言任务。

私有 provisioning 命令生成控制配置、runner 配置和三个独立密钥对；使用以下原生配置命令，不向网页导出私钥。

```sh
node --experimental-strip-types scripts/provision-execution.mjs '/private/keys' 'http://127.0.0.1:5173' 'http://127.0.0.1:5174'
node --experimental-strip-types scripts/server.mjs --execution-config '/private/keys/control.json'
node --experimental-strip-types runner/main.mjs '/private/keys/runner.json'
```

生成的配置目录与文件保持0700/0600。server 在数据库打开之前校验并加载控制配置，Runner 只监听127.0.0.1。注册操作和输入/输出 manifest 必须在控制端和执行端一致。

签名 transport 将请求/响应方向、nonce、原始body、status和 audience 绑定。checkpoint 使用独立服务认证；执行凭据不能调用 owner 的批准/拒绝接口。

Runner journal 保存 permit、真实 deadline、操作和后端状态。重启不扩大期限；归档和恢复不得把历史成功收据当成再次开始授权。后台对 result、cancel_fence 和 stop 分别对账；确认容器 removed/never_admitted 后才释放物理占用。

日志与产物通过绑定许可的受限路径下载，不开放任意宿主文件。输入在固定句柄读取并按登记摘要复核，产物仅接收规定的相对路径、字节限额和类型。

相关检查为 npm run test:execution:domain、npm run test:execution、npm run test:backend:integration。缺少真实 daemon 不应假装 Docker 检查通过；本机开发闭环检查不能替代固定容器隔离检查。

Run 专属 Worker 身份链在本地源码提供发放、撤销、两个 Run 查询和六个租约动作；generation 与 action ledger 已实施，持久 consumer 已在本地源码实现，使用私有 journal 与 kernel flock 保存请求前的 secret/ID；2 秒续租、单请求 2.5 秒上限、6 秒 generation 租约和最多 60 秒正常轮询分别生效。后端接入采用原生签名协议；loopback peer 的签名证据与实际 Docker 验收分别记录，后者仍需上述 daemon 与镜像。原生账户/SQLite 接入和 permit 对账条件见[原生执行接口衔接评估](EXECUTION-INTEGRATION.md)。

## Run 专属 consumer CLI

用本地 owner 已批准的 Run 与绝对私有状态目录调用 `npm run execution:consume -- bootstrap --endpoint <origin>/api/execution/worker-mcp --run-id <run-id> --state-dir <absolute-private-directory> --token-file <absolute-private-token-file>`。受保护 token 文件属于当前 uid、0600、单链接，包含 43 字符 API token 和可选换行；也可使用继承的 `--token-fd 3`。bootstrap 的 secret/ID 在请求前保存，重试相同命令恢复相同发放请求。

`npm run execution:consume -- run --endpoint <origin>/api/execution/worker-mcp --run-id <run-id> --state-dir <absolute-private-directory>` 使用已有 Worker。`--mode reconcile` 只处理该 Run 已存在 permit；`--message` 只提交有界进度，不授予完成权限。运行态不读取 owner token，不指定 owner/project/注册权限。回复丢失保留稳定 action requestId 和首次进度消息内容；过期 generation 重新 claim，历史 metadata 不复活旧租约。SIGINT/SIGTERM 保存取消意图，只有签名 stop 确认物理关闭才输出 `closed`（exit 0）；`recovery_required`（exit 2）保留持久恢复义务。

用相同 endpoint/Run/state-dir 和受保护 token 输入运行 `revoke`，owner 撤销请求也先持久化并幂等重放。CLI 不输出 secret 或 issuer token；journal 含短期 secret，必须保留私有权限。更换 endpoint 或 Run 使用新的状态目录，现有绑定不可重新指定。实际 Docker fixture 为 `npm run test:execution:consumer:backend`，本地无 daemon 时明确失败，完整验收由有真实 socket 的 CI 运行。
