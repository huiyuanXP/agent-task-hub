# 功能验证

安装使用 npm run install:ci。先运行 npm run build，再进行类型、lint 和使用该构建的 HTTP/浏览器检查。不要在服务仍使用共享 .next 时重建它。

```sh
npm run build
npx --no-install tsc --noEmit
npm run lint
npm run test:local
npm run test:connectors
node --experimental-strip-types tests/connectors/project-catalog-browser.mjs
```

原生测试使用新临时 SQLite、真实本地测试账户、不同 loopback 端口和受管进程组。不得复制现有数据、模型认证或客户端 token 作为测试 fixture。API/MCP 测试保留 owner/project 隔离、严格参数、修订冲突、分页和只读快照语义。

新客户端测试包括真实归档解包、安装、STDIO MCP 初始化/调用、注册、心跳、离线、重启和撤销；流程测试包括点子到 Plan/Tickets、已批准开发 Run、实际差异与测试、用户验收。模型替身测试与真正模型调用分开记录，不能将前者算作真实 AI 闭环。

浏览器检查需要 tests/browser 的锁文件安装和 Chromium。npm run test:integration 在独立目录安装并构建，再运行真实 API/MCP/浏览器检查；中断会清理所拥有的服务，失败证据保留在 test-results。

npm run test:execution:domain 运行不依赖 Docker 的执行领域检查。npm run test:execution 和 npm run test:backend:integration 要求真实 Docker daemon、flock、proc 和锁定 Node 镜像；本机缺少它们时明确报告，CI 仍保留完整 Docker 检查。 签名传输回归还覆盖大 emoji 请求在 UTF-8 网络分块边界保持原始字节；真实后端测试代理以 Buffer 拼接，保留签名与 Content-Length，并记录安全的状态/字节诊断。

`npm run test:mcp:task-read-bytes` 使用新临时 SQLite 和真实本地 owner/project HTTP 端点验证完整 4 MiB UTF-8 envelope、双表示计费、详情共享预算、字节 continuation、项目隔离和超大单项错误；`npm run test:connectors` 包含实际 loopback/STDIO 流式读取、多字节分块、超限取消与协议行预算检查。它们不替代 Docker 实测。

只运行与实际变更相关、能验证行为的检查；通过后不重复整套测试，除非又有变更、失败或尚未解决的问题。

`npm run test:next-steps` 使用全新 SQLite 和真实 Chromium 验证点子接入项目传递、手工 Plan 保存、空看板起步、Ticket 创建及按需展开执行入口，并将截图与结果保留在 `test-results/new-user-next-steps/`。需要已有 `tests/browser` 的 Playwright 与可信 Chromium，测试仅访问自己的 loopback 服务。
详情浏览器验证使用 `npm run test:details:browser`（先构建并准备 `tests/browser` 的锁定 Playwright 与 Chromium），新建 SQLite 与合成账户，覆盖只读无写请求、30 个关联任务、长标题、焦点限制/恢复、返回滚动与筛选、草稿确认、隐藏字段保留、真实 409、完成证据定位、手工快照、点子新修订、窄屏和会话失效清理；截图默认写入 `test-results/details`，可用 `DETAIL_EVIDENCE_DIR` 指定私有证据目录。

`npm run test:planning:browser` 同样覆盖折叠规划详情中的租约时钟、失效恢复与投递退避，原因与冷却在展开前可见；这些检查不测量用户理解能力，也不代替真实模型开发或 Docker 后端验证。

整合看板验收：`node --experimental-strip-types tests/browser/board-interactions.mjs`；项目目录：`node --experimental-strip-types tests/connectors/project-catalog-browser.mjs`；共享执行：`node --experimental-strip-types tests/tickets/execution-browser.mjs`。它们均使用 fresh SQLite、loopback 和已有锁定浏览器依赖，覆盖真实页面交互与API响应。看板采用原生 PointerEvent 适配，可信触屏通过 Chromium CDP 注入；脚本目标坐标使用列与视口的可见交集。

`node --experimental-strip-types --test --experimental-test-isolation=none tests/tickets/*.test.mjs tests/local/ticket-move.test.mjs tests/connectors/project-catalog.test.mjs tests/execution/backend-http.test.mjs` 验证稳定排序、精确动作、记录写入占用/CAS、项目隔离及跨Run收据拒绝。临时凭据与SQLite由fixture生命周期清理；测试不访问已安装服务或生产记录。
