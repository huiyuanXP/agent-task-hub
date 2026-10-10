# 原生执行接口衔接评估

本评估为 `pr39-integrate` 提供实施输入：复用 Run 专属 Worker、generation 租约、持久 consumer、permit 对账与 MCP 字节分页机制，通过本地账户、原生 SQLite 和现役签名 Docker 后端接入。Worker 身份、owner 发放/撤销、两个受限查询工具、SQLite 写事务 guard、generation 租约与六个动作已在本地源码实施；持久 consumer 已在本地源码实施，实际 Docker Worker 路径由专用 mandatory fixture 验收。MCP 字节分页与原生客户端有界读取已实施，现役后端已校验查询对象与整组收据的 owner/permitId/runId 绑定，并支持受信任 adapter 的 Run 范围限制。安装功能以现役源码及[功能清单](FEATURES.md)为准。

## 现役执行链与身份

| 执行记录 | 身份与入口 | 授权、租约和完成依据 |
| --- | --- | --- |
| 手工快照 | 本地 owner；记录查询与 `list_ticket_runs` | 用户填写的冻结合同和证据；投影为 `manual/snapshot`，执行授权为 null。 |
| 本机开发 Run | owner 的 `/api/workspace-runs`；项目连接的 `/api/connector/agent` | 冻结 Ticket 修订、项目、连接、workspace 和期限；owner approve 后领取，30 秒租约受 hard deadline 约束；实际 diff、文件和测试回执进入 review，owner accept 后完成。 |
| 固定 Docker Run | 本地 owner 的执行接口；独立签名 `/api/execution/checkpoint` | `execution_runs` 的冻结合同、attempt/version、登记操作与资源预算；不可变 permit 绑定实际 deadline；可信后端 result/cancel_fence/stop 收据决定结果与物理关闭。 |

workspace 的审批/验收在 [http.mts:26](../lib/workspace-runs/http.mts#L26)，冻结边界在 [service.mts:75](../lib/workspace-runs/service.mts#L75)，租约在 [service.mts:149](../lib/workspace-runs/service.mts#L149) 与 [service.mts:184](../lib/workspace-runs/service.mts#L184)。交付进入 review 在 [service.mts:225](../lib/workspace-runs/service.mts#L225)，owner 决策在 [service.mts:93](../lib/workspace-runs/service.mts#L93)。客户端以任务开始提交创建 detached worktree，收集提交、暂存、未暂存及新增文件的差异，并提交实际测试回执，见 [agent.mjs:35](../connector/agent.mjs#L35) 与 [agent.mjs:110](../connector/agent.mjs#L110)。

Docker permit 的原子插入、合同/授权/预算绑定和物理占用在 [dispatch.mts:21](../lib/execution/dispatch.mts#L21)；checkpoint 在 [dispatch.mts:47](../lib/execution/dispatch.mts#L47) 与 [backend-http.mts:15](../lib/execution/backend-http.mts#L15)。开发结果与 Docker 收据各按其协议展示，固定 `ticket.validate.v1` 操作保持登记输入与容器运行边界。完整运行合同见 [EXECUTION.md](EXECUTION.md)、[RUNNER.md](RUNNER.md) 和 [CONNECTORS.md](CONNECTORS.md)。

当前 owner `/mcp` 使用本地账户；项目 `/api/connector/mcp` 使用独立连接身份与能力清单，见 [connectors/service.mts:81](../lib/connectors/service.mts#L81) 与 [connectors/mcp.mts:14](../lib/connectors/mcp.mts#L14)。现役 `list_ticket_runs` 聚合 manual/execution，见 [task-reads/runs.mts:103](../lib/task-reads/runs.mts#L103)；workspace 查询使用 `/api/workspace-runs`，三个记录域各有明确的投影来源。

## 接入选择与实施边界

采用独立 Worker machine 端点，令本地 owner、项目连接和 Run 委派成为三个明确 principal。Docker consumer 的执行对象限定 `execution_runs`；本机开发继续使用项目连接、现役 workspace 租约、本地模型和 owner review。

| 接口或模块 | 采用的机制 | 原生接入与实施状态 |
| --- | --- | --- |
| `/api/execution/workers` | owner provision/list/revoke，稳定 requestId、有限发放、secret verifier | 已实现本地 session/API token 发放、有限发行及幂等撤销，绑定 owner、origin、issuer 摘要/期限和冻结 Run；owner/project 从可信数据解析。 |
| `/api/execution/worker-mcp` | Run 专属八工具与独立 Worker token | 已实现精确 machine route、Worker 认证、两个只读 Run 工具及六个 generation 租约动作。 |
| Worker SQL 与 guard | credentials、leases、actions、checks 四表；generation/请求唯一索引；写事务前后检查 | `007_execution_workers.sql` 建立 credentials/checks，`008_execution_worker_leases.sql` 建立 leases/actions；前后 guard 接入 `LocalDatabase.batch`，追加当前 lease/generation/action 权限条件。 |
| 固定操作后端 | permit-bound receipt ingestion、受限历史 reconcile | owner/受信任 adapter 与 Worker 动作均采用现役 permit 收据绑定；Worker historical reconcile 只处理已有委派 Run permit。 |
| consumer CLI | secret/ID 先持久化、flock、原子 journal、幂等重试 | 已实现：本地 API token bootstrap/revoke、Run 专属 Worker runtime、固定 machine transport、私有 journal 与 kernel flock。 |
| MCP 查询 | UTF-8 双表示 envelope 预算、按字节分页 | 已实施具名查询 options 与完整 UTF-8 响应边界，保留可信 project 链与游标作用域；下载包的客户端刷新安装后采用相同边界。 |

### 本地账户派生 Worker

本地身份为 `userId/username/displayName`，session 提供 `mode: local` 和 `expiresAt`；API token 是随机 43 字符 base64url，存储为 SHA-256 摘要，见 [local-auth.mts:4](../lib/local-auth.mts#L4)、[local-auth.mts:96](../lib/local-auth.mts#L96) 和 [current-user.ts:5](../lib/current-user.ts#L5)。Worker 保留 `athw1.<credentialId>.<secret>` namespace，发放有效期取 15 分钟与 issuer token 到期的较小值。

已实现的 issuer 包含可信 `owner`、`actor`、`origin`、`issuer_token_hash`、`issuer_expires_at`；冻结 Run 提供 Ticket/revision/attempt/authorization 和项目绑定。provision 参数采用 `credentialId/requestId/runId/verifier/label`，revoke 参数采用 `credentialId/requestId`；owner、project 等调用者身份字段由严格 schema 拒绝。

每次 consequential mutation 的同一 SQL 事务检查 Worker 的当前 origin、owner/Run 绑定、revoked/expiry，以及 `local_users` 中的 owner 和 `local_tokens` 中相同 owner、issuer 摘要、有效期限。SQL 写边界的时间采用 `SQL_NOW`。现役 `revokeToken` 删除 token 行，reset 原子删除账户全部 token，见 [local-auth.mts:79](../lib/local-auth.mts#L79) 与 [local-auth.mts:129](../lib/local-auth.mts#L129)；派生 Worker 通过这些存在性条件承接 logout、撤销和密码重置的即时失效语义。

owner Worker 管理 route 使用 `authenticateHeaders`/受信任 session 和实际 request credential 的摘要，保留 cookie/bearer 冲突检查、精确 Host/Origin 和写操作校验，见 [local-auth.mts:187](../lib/local-auth.mts#L187)。machine route 使用独立 bearer parser，接受 Worker namespace、拒绝 cookie，限定 JSON-RPC body 为 16 KiB、响应 envelope 为 1 MiB，参考 [MCP 边界][pr-ingress]；认证覆盖 initialize/discover/tools/list/tools/call。现役 Node 精确 machine 集合在 [server.mjs:47](../scripts/server.mjs#L47)，其余 API 与 `/mcp` 先经本地账户认证。Node 入口与 Next route 已共同提供选定路径的精确分派和 route 内认证。

本地实现见 [workers.mts](../lib/execution/workers.mts)、[worker-auth.mts](../lib/execution/worker-auth.mts)、[owner handler](../lib/execution/worker-http.mts) 和 [worker-guard.mts](../lib/execution/worker-guard.mts)。credentialId 为小写 UUID v4；同一 owner 最多有 16 个有效 Worker，列表最多返回 100 条。issuer 与 verifier 只留在私有存储，不进入管理响应或 MCP 投影。重复 provision 返回原 ID 与期限，不复活已撤销或已到期的凭据；重复 revoke 保留原撤销时间。

### 原生 SQLite 与原子权限检查

`node:sqlite` 的数据库句柄使用 WAL、外键和 `BEGIN IMMEDIATE`；迁移名及 SQL checksum 由 `schema_migrations` 跟踪，重启只应用新增 SQL，见 [database.mts:27](../lib/database.mts#L27)。[007_execution_workers.sql](../migrations/007_execution_workers.sql) 已追加 credentials/checks，并校验 local owner、冻结 Run、verifier/expiry、稳定发放/撤销请求及不可变绑定；[008_execution_worker_leases.sql](../migrations/008_execution_worker_leases.sql) 追加 generation 排他和 lease/action 请求索引，以及冻结绑定、期限与完成响应不可变约束。issuer token 摘要不设阻碍注销删除的外键，guard 在每次调用和写事务验证其当前存在性。

[worker-guard.mts](../lib/execution/worker-guard.mts) 已通过同事务检查行前后验证、WeakMap 解包及失败 CHECK 回滚接入原生 batch。`LocalDatabase.batch` 只接收同句柄原始 Statement，见 [database.mts:58](../lib/database.mts#L58)；包装器将 prepare/bind/run/batch 的语句解包后交给该句柄，first/all 只允许 SELECT，拒绝以 RETURNING 绕过写检查。验证覆盖跨句柄拒绝、撤销/自然到期紧邻 mutation、并发 guard 及零残留检查行；预读结果与 JS 时间各用于展示，写权限以事务条件为准。

### Worker 查询与租约动作

八个工具的严格 schema 见 [worker-mcp.mts](../lib/execution/worker-mcp.mts)，本地租约与 action 实现在 [worker-leases.mts](../lib/execution/worker-leases.mts)、[worker-action-store.mts](../lib/execution/worker-action-store.mts) 和 [worker-actions.mts](../lib/execution/worker-actions.mts)。leased action 绑定 `runId/requestId/leaseToken`，lease token 为 `athl1.<leaseId>.<generation>.<secret>`；同 requestId 重放返回绑定原内容的响应，内容变化产生幂等冲突。

| 工具 | 合同及当前状态 | 实施验证 |
| --- | --- | --- |
| `get_execution_run` | 已实现：只读委派 Run 及现存 permit deadline/cancel/closed 摘要 | foreign Run 拒绝，读取前后状态和占用一致。 |
| `list_execution_runs` | 已实现：仅返回 Worker 唯一委派 Run | owner 列表使用 owner 查询；隐藏工具的显式调用也拒绝。 |
| `claim_execution_run` | 已实现服务端：client 须先持久化 lease secret/verifier/requestId；6 秒排他 generation；execute 校验当前 approval/registry/revision，reconcile 要求该 Run 历史 permit | 两消费者唯一 winner、回复丢失恢复、到期接替、旧 generation 拒绝。 |
| `start_execution_run` | 已实现：当前 execute lease 调用现役 dispatch/start；采用相同不可变 permit | scope/budget/revision/registry/expiry 和占用检查；重启保持同 permit/deadline。 |
| `renew_execution_run` | 已实现：当前 execute generation、有效派生 credential 与当前 approval；幂等响应绑定 exact expiry | 自然到期/撤销竞态，同请求重试只采用原 expiry；reconcile lease 的 renew 拒绝。 |
| `report_execution_run` | 已实现：最多 2048 字符 message 的幂等 action receipt；状态由领域和后端控制 | 拒绝未知 state/evidence 字段、超限消息和终态报告。 |
| `complete_execution_run` | 已实现：获取原 permit 的可信 result，交由现役对账和 attestation ingestion | foreign signed receipt 拒绝；后端结果待就绪返回真实 `INVALID_EVIDENCE`。 |
| `cancel_execution_run` | 已实现：当前 lease 请求取消，分别记录逻辑 cancelled 与物理关闭收据 | 分别验证 result/cancel_fence/stop；历史 reconcile 仅处理已有 permit。 |

已实现的 Docker 租约 generation 与现役 workspace 的 30 秒租约各在自己的表和状态机中推进。动作保持以下条件：执行 approval 失效后，有效 Worker credential 可使用历史 reconcile 完成/取消已有 permit；Worker 或其 issuer 已失效时，恢复由 owner 路径处理。reconcile 保持既有 deadline 和操作范围。

后端接入保留 [backend-http.mts:35][pr-backend] 的 receipt `permitId/runId` 与当前查询对象匹配，以及 [:68][pr-reservation]、[:83][pr-run-scope] 的受信任 `executionRunId` 限制。现役后端在任何收据入库前[校验整组 receipt](../lib/execution/backend-http.mts#L35) 与查询 permit 的 owner/permitId/runId 一致；ingestion 继续校验签名与 receipt 自身绑定，见 [attestations.mts:55](../lib/execution/attestations.mts#L55)。受信任 adapter 可在 `AuthorizationContext.executionRunId` 绑定唯一 Run；[HTTP 与 reconcile](../lib/execution/backend-http.mts#L89) 在读取或写入前拒绝其他 Run，绑定主体不恢复前任 Run 的物理占用。该字段只由服务端传入，Worker machine 的 start/complete/cancel 使用这些受限原生 backend 调用；owner recovery 仍关闭前任物理占用，见 [backend-http.mts:75](../lib/execution/backend-http.mts#L75)。


B2 的 execute claim/start/renew/report 在每次写事务核实当前审批、Ticket 修订与 body、registry、操作/预算，以及已存在 permit 的取消/关闭/deadline 状态。lease 为 6 秒，期限受 issuer、Worker、approval 与既有 permit 的较小期限限制；任一旧 generation 的动作及缓存读取均拒绝。claim 的同请求重放返回原 metadata；原租约已失效时，该 metadata 只是历史回执，不能据此 start、续租或执行其他 leased action，也不复活租约；renew 同请求重放保留精确原 expiry。

start/complete/cancel 在外部请求前保留 pending action，安全结果完成后保存不可变响应。真实签名 result 未就绪返回 `INVALID_EVIDENCE`，不能用调用者 state/evidence 宣告完成；cancel_fence 和 stop 分别代表取消栅栏和物理关闭。外部 HTTP 与 SQLite 不是同一事务：后端已接受而 issuer/lease 随后失效时，后续数据库写入被拒绝，保留 immutable permit 与 pending action，由有效 historical reconcile 或 owner recovery 对账。完成缓存仍受当前 credential/lease/generation 校验；再次获取更新的 stop 状态须使用新 action requestId。

### 原生 consumer 持久状态与恢复

本地原创 [consumer-state.mjs](../runner/consumer-state.mjs) 使用私有 0700 目录、0600 文件与 pinned `/proc/self/fd` 目录句柄。消费者持有继承文件描述符的 kernel flock；退出或 SIGKILL 自动释放，锁文件不删除。journal 写入串行执行临时文件 fsync、rename、目录 fsync，失败后停止使用状态；严格绑定版本、canonical endpoint 和唯一 Run。实际子进程验证排他、崩溃与 rename 前后恢复。

[consumer.mjs](../runner/consumer.mjs) 的 bootstrap/revoke 从受保护文件或 fd 读取 43 字符 API token，API token 不落 journal、不输出；运行态使用 Run 专属 Worker 凭据。Worker/lease secret、ID 与 action requestId 在 HTTP 请求前 fsync 持久化，回复丢失后保持相同请求。transport endpoint 与请求 allowlist 采用 `/api/execution/worker-mcp` 和 `/api/execution/workers`，精确 Host/Origin 按本地配置校验；参考 [consumer token 解析][pr-consumer-token] 与 [consumer-transport.mjs:13][pr-transport] 的接入位置。[consumer-transport.mjs](../runner/consumer-transport.mjs) 原创实现固定端点和八工具清单、16 KiB ingress、1 MiB 流式 fatal UTF-8 response、禁止重定向与 2.5 秒 timeout；安全 typed error 保留 domain code，不返回原始秘密或服务错误。journal 掉包恢复测试证明请求重放保持相同合同。

参考 consumer 每 2 秒续租、单请求 timeout 2.5 秒、6 秒 lease、最多 60 秒轮询，见 [:136][pr-renew] 和 [:154][pr-poll]。本地 consumer 使用独立 2 秒续租 timer，单次续租不重叠，journal 串行更新防止旧 generation 回复覆盖新租约；正常轮询的 60 秒起点持久化，重启不会延长窗口。SIGINT/SIGTERM 或轮询超时保存停止意图，进行最多 6 秒的取消/历史对账收尾。只有可信 stop 与 `closed_at` 才返回 `closed`；Worker/issuer 失效或停止未确认返回 `recovery_required`（exit 2）并保留 journal，供有效历史 consumer 或 owner recovery 继续对账。consumer 窗口、租约和 permit immutable deadline 各自独立。

### MCP 字节预算与项目隔离

现役 [bounds.mts](../lib/task-reads/bounds.mts) 按 UTF-8 计量完整 4 MiB JSON envelope，text 与 structuredContent 双表示及 JSON 转义共同计费，查询为 RPC ID 和路由 metadata 预留 256 KiB。分页在 [cursor.mts](../lib/task-reads/cursor.mts) 以最后实际返回项产生 continuation；单项过大返回有界 `RESPONSE_TOO_LARGE`。详情的父记录、原点子/source revision、linkage 和 nested page 共享预算。

查询使用具名 `TaskReadOptions { project?: string, byteBudget?: number }`，见 [queries.mts](../lib/task-reads/queries.mts) 与 [runs.mts](../lib/task-reads/runs.mts)。[dispatchTaskReadTool](../lib/task-reads/mcp.mts) 和 [connector 调用](../lib/connectors/mcp.mts) 持续传递已认证 project；SQL、详情关联 Idea/Plan/历史及 cursor context 保留项目条件。tool 输入不接受 `byteBudget` 或调用者身份字段。

owner 与项目 connector 都在返回前检查完整 envelope。owner [MCP route](../app/mcp/route.ts) 使用领域有界 `readBody(req,200000)`，沿用现役 RPC/权限校验；固定执行入口保留原 16 KiB 默认 body 上限。下载包 [common.mjs](../connector/common.mjs) 对 HTTP 响应流式累计最多 4 MiB，超限立即取消且拒绝非法 UTF-8；[STDIO bridge](../connector/mcp.mjs) 保留跨 chunk 多字节字符，输入行最多 200000 bytes、完整 JSON 回复最多 4 MiB，超限行丢弃后继续接收下一行。已安装 runtime 通过重新下载并安装刷新，现有连接身份与权限不变。

实现根据本地原生合同原创，机制参考 [MCP 字节边界][pr-bounds] 与 [游标分页][pr-cursor]；未复制许可待确认的外部应用模块。实际验证覆盖中文、emoji、转义、双表示、nested context、跨项目游标、exact/one-byte overflow、未知长度分块取消及分页不漏不重，参见 [MCP 读取合同](MCP-TASK-READS.md)。

## 后续实施单元与验收

`pr39-integrate` 按以下两个单元交付，依赖沿用现役锁文件和 Node/Next、本地 SQLite 测试 harness。

| 单元 | 具体范围 | 完成依据 |
| --- | --- | --- |
| A：查询与收据绑定 | MCP 字节分页/options、owner 与项目 connector envelope、安装客户端有界读取、查询对象的 permit/run receipt 校验 | 实际 UTF-8 响应边界、项目隔离和只读表快照；可信 foreign receipt 拒绝；workspace 合同继续通过。 |
| B：Docker Worker 与 consumer | 本地 migration/issuer、owner 与 machine route、原子 guard、leases/actions、受限 reconcile、consumer CLI 和原生 fixture | 本地账户撤销/expiry、两进程竞争、请求回复丢失恢复、八工具隔离、相同 permit/deadline、真实后端结果/停止与 owner recovery。 |

模块 A 已完成原生源码适配，可单独交付；模块 B 的认证、迁移、guard、CLI 与恢复验证构成完整实现。权限、注册操作、预算与审批继续由现役执行域决定；每个实施 Run 使用其单独批准的项目/workspace 和操作范围。

现有行为检查可从 `tests/local/{auth,database}.test.mjs`、`tests/workspace-runs/service.test.mjs`、`tests/execution/{authorization,dispatch}.test.mjs` 按名称筛选账户撤销、SQLite 原子性、审批边界、workspace 交付/期限及 permit 绑定；执行 Node `--test` 时加 `--experimental-test-isolation=none` 展示实际子测试。文档交付只验证这些已实现合同。

已实施的收据查询绑定与受信任 Run 范围限制由 `tests/execution/backend-http.test.mjs` 使用新临时 SQLite、合成签名密钥和真实 loopback 协议 peer 验证；该 fixture 不代表实际 Docker 执行。

Worker 身份链使用 `npm run test:execution:workers`：新临时 SQLite、本地随机账户 token 和真实 Next loopback 端点覆盖 owner/machine 分派、八工具范围、issuer 失效、稳定重放/重启及同事务 guard 回滚。其中身份检查不启动后端；租约与动作检查使用真实 fresh SQLite、临时本地账户及实际签名 loopback 协议 peer，不启动 Docker 容器。实现 A 时选择 `test:connectors`、`test:mcp:task-reads` 和相关 `test:execution:domain`；已实施 B2 同时运行 `test:local`、`test:execution:api`、`test:workspace-loop` 与原生 Worker 测试；consumer 的 journal/transport/native CLI 测试由 `test:execution:consumer` 承载，专用实际 Docker 测试由 `test:execution:consumer:backend` 承载；CI 在显式 daemon 与锁定镜像准备后单独运行新 Worker 路径。参考 [consumer fixture:7][pr-fixture] 的接入需使用新临时 SQLite、本地测试账户/随机 API token 与 loopback server；协议/consumer 脚本在实际交付时纳入现役 package scripts。代码交付按影响完成 build、tsc、lint；真实 Docker 端到端使用 daemon、锁定镜像和现役签名 fixture，分别验证 result/cancel_fence/stop、后端失败与恢复。具体 harness 及前置条件见 [TESTING.md](TESTING.md)。

## 来源、许可与证据索引

机制来源为 [PR #39：Complete Run-scoped MCP execution leases and durable consumer](https://github.com/huiyuanXP/agent-task-hub/pull/39)，源码引用固定到 `92bd3ee788c1f22a35ccdacf140030d0463f7937`，通过本地 Git 对象 `git show` 核对。现役合同通过本 worktree 的实际文件核对；外部 PR 状态按私有证据的采集时刻解释。

应用源码许可状态为待确认：固定树中的 MIT 许可文件分别覆盖 [Superpowers skills][pr-skill-license]、[vendored shadcn CSS][pr-css-license] 和 [构建插件][pr-plugin-license]；应用模块的代码复用许可由后续实施确认并保留来源与适用 notices；模块 A 与本地 Worker 身份/guard/leases/actions/consumer 使用原创实现，未复制这些应用模块。本评估引用接口和机制，代码采用的许可凭据随具体实施范围记录。

私有研究及历史证据位于主 workspace 的 `.local/evidence/parallel-tickets-20261009/`：

| 文件 | 用途 |
| --- | --- |
| `pr39-research.md` | 适配差异、接口参数碰撞和真实冲突结果的研究输入；包含固定本地/外部 SHA 与源码定位。 |
| `pr39.diff` | 固定 PR 三点差异原文。 |
| `pr39-merge-tree.json` | 单次冲突计算的命令、基准、exit code 与完整输出；按本地基准解释合并结果。 |
| `pr39-remote.json`、`pr39-checks.json` | 采集时的外部状态和 PR 分支 CI 回执；原生适配验证使用自身的实际回执。 |

单次冲突路径和合并历史由上述私有证据承载。后续实施回执保存实际命令、Node 版本、退出码及子测试输出，并区分现役合同验证与拟实施功能验收。

[pr-workers]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/workers.mts#L8
[pr-worker-auth]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/worker-auth.mts#L10
[pr-worker-route]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/app/api/execution/workers/route.ts#L1
[pr-ingress]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/app/mcp/route.ts#L161
[pr-guard]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/worker-guard.mts#L11
[pr-sql]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/drizzle/0007_worker_delegations.sql#L1
[pr-tools]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/worker-mcp.mts#L12
[pr-leases]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/leases.mts#L15
[pr-backend]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/backend-http.mts#L35
[pr-reservation]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/backend-http.mts#L68
[pr-run-scope]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/execution/backend-http.mts#L83
[pr-state]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer-state.mjs#L7
[pr-bootstrap]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L52
[pr-actions]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L92
[pr-claim]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L102
[pr-consumer-token]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L39
[pr-transport]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer-transport.mjs#L13
[pr-renew]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L136
[pr-poll]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/runner/consumer.mjs#L154
[pr-bounds]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/task-reads/bounds.mts#L9
[pr-cursor]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/task-reads/cursor.mts#L42
[pr-queries]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/task-reads/queries.mts#L17
[pr-runs]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/lib/task-reads/runs.mts#L104
[pr-fixture]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/tests/execution/fixtures/consumer.mjs#L7
[pr-skill-license]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/.agents/LICENSE.superpowers
[pr-css-license]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/vendor/shadcn-tailwind-4.13.0.LICENSE.md
[pr-plugin-license]: https://github.com/huiyuanXP/agent-task-hub/blob/92bd3ee788c1f22a35ccdacf140030d0463f7937/build/sites-vite-plugin.LICENSE
