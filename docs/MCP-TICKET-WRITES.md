# 项目 MCP Ticket 状态写回

原生项目客户端的 `POST /api/connector/mcp` 提供 `update_ticket_status`，已安装的 STDIO MCP 转发同一工具。它需要现有 `submit` 能力，只能更新此连接绑定 owner 与项目中的 Ticket；只读、仅规划或仅执行能力不提供此工具。owner token 不能冒充项目客户端。该工具不在 owner `/mcp` 或受管模型的五个只读工具 allowlist 中，不改变开发批准与验收流程。

## 输入与结果

参数必须是精确 JSON 对象，不能指定 owner、project、connection 或额外字段：

```json
{"ticket_id":"ticket-123","expected_revision":1,"request_id":"status_result_1","status":"done","evidence":"node --test: 通过，退出码 0"}
```

- `ticket_id`：非空、不含 ASCII 控制字符，最多 200 字符。
- `expected_revision`：正安全整数，必须匹配当前 Ticket 修订；不得使用最大安全整数，因为成功会增加修订。
- `request_id`：1–80 个 ASCII 字母、数字、下划线或连字符；同一连接内必须用原请求重试，换参数使用新 ID。
- `status`：`todo|running|waiting|done|error`，沿用 records API 的手工跟进状态规则。
- `evidence`：必须提供字符串，可为空；追加内容及合并后的全部证据分别不得超过 12000 UTF-8 字节，分隔符也计费。存在非空追加内容时以两个换行分隔，保留已有原文；不会截断或替换旧证据。`done` 要求合并后的证据非空。
- `waiting_reason`：仅 `waiting` 时可选，值为 `clarification|approval|review|external|recovery`；省略时保留已有合法等待原因，若原记录没有合法原因则必须填写。

合并后的整个 Ticket body 不得超过 80000 UTF-8 字节。成功结果仅 `{ticket_id,revision,status}`，revision 是此次成功保存后的固定修订。目标、范围、验收标准、项目和其它已有字段保持原值。

证据属于调用方报告；填写 `done` 或 `running` 不证明有真实进程、测试成功、模型调用或 owner 验收。工具不会创建或变更 Run、审批、预算、permit、签名收据或规划任务。真实执行与验收仍按[执行合同](EXECUTION.md)处理。

## 修订、审计与重放

写入复用本地 SQLite 的 `BEGIN IMMEDIATE` batch：实时检查连接绑定、未撤销/未过期的 `submit` 能力、owner、项目与修订，再插入一条标准 history 和执行 revision CAS。凭据到期使用实际 SQL 执行时的 SQLite 毫秒时间，并在事务末尾再次断言授权；事务等待或 history/CAS 间跨过到期时整批回滚，不能留下单独历史、失效写入或成功重放收据。历史仍为 `{title,recordId,recordKind,previousRevision,snapshot}`，history 自身 revision 为 1，snapshot 为修改前的真实完整业务 body；附加 `statusUpdate` 内部元数据记录连接/项目身份、request ID、输入摘要和固定结果，不构成另一条业务修订。

同一连接的相同 request ID 与完全相同参数重放，返回原结果，即使随后 Ticket 已有新修订也不会重新追加证据或历史。请求 ID 绑定不同参数时返回 409；同修订不同请求竞争只有一个成功，另一方得到 409，不新增失败历史。撤销、过期或移除 `submit` 后不能重放原结果。内部身份、输入摘要与凭据不会出现在公开成功结果中。

状态真正发生变化时使用 records API 同一 `ticketStatusWriteGuard`：workspace `pending|approved|running|review`、尚未确认物理关闭的 workspace Run、Docker `queued|running|waiting` 或未关闭 permit 会阻止写入。保持相同状态、仅追加证据的行为沿用 records API；Run 的独立冻结修订与后续租约检查继续有效。冲突时调用方应保留拟写状态/证据，重新读取修订或处理运行占用后再决定新请求。

## 错误与验收范围

身份失效保留 HTTP 401；能力不足的工具不会在 discovery 出现，调用返回原有 JSON-RPC 工具不可用错误。已认证写工具的业务错误沿用 MCP `isError:true`，并提供 `structuredContent.error:{status,message}`；HTTP 200 是协议响应，不表示写入成功。400 为参数/等待原因/完成证据错误，404 为不可见 Ticket，409 为修订/请求身份/运行占用冲突，413 为 UTF-8 输入、合并证据或 body 超限，503 为脱敏存储故障。

`tests/connectors/ticket-status.test.mjs` 使用实际 SQLite 事务验证 owner/project/capability、并发 CAS、重放及撤销竞态、真实延迟跨凭据到期的事务回滚、UTF-8 边界、workspace/Docker 物理占用和审计回滚。`npm run test:ticket-status:native` 在全新 SQLite 上使用真实安装 CLI、STDIO、loopback HTTP 与锁定 Chromium 验证状态/证据写回、真实页面重载与字段保留；测试的算术 subprocess 是实际调用方命令结果，不是模型证据。云端模型阶段与原生工具验收各自保留来源和界限，见[测试说明](TESTING.md)；旧源码 e5efe30 的模型协议验收不能视为本工具已由模型调用或已部署验证。
