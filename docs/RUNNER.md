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

Run 专属 Worker 身份链在本地源码提供发放、撤销、两个 Run 查询和六个租约动作；generation 与 action ledger 已实施，持久 consumer 尚待实施。后端接入采用原生签名协议；loopback peer 的签名证据与实际 Docker 验收分别记录，后者仍需上述 daemon 与镜像。原生账户/SQLite 接入和 permit 对账条件见[原生执行接口衔接评估](EXECUTION-INTEGRATION.md)。
