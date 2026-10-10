# 功能验证

安装使用 npm run install:ci。先运行 npm run build，再进行类型、lint 和使用该构建的 HTTP/浏览器检查。不要在服务仍使用共享 .next 时重建它。

```sh
npm run build
npx --no-install tsc --noEmit
npm run lint
npm run test:local
npm run test:connectors
```

原生测试使用新临时 SQLite、真实本地测试账户、不同 loopback 端口和受管进程组。不得复制现有数据、模型认证或客户端 token 作为测试 fixture。API/MCP 测试保留 owner/project 隔离、严格参数、修订冲突、分页和只读快照语义。

新客户端测试包括真实归档解包、安装、STDIO MCP 初始化/调用、注册、心跳、离线、重启和撤销；流程测试包括点子到 Plan/Tickets、已批准开发 Run、实际差异与测试、用户验收。模型替身测试与真正模型调用分开记录，不能将前者算作真实 AI 闭环。

浏览器检查需要 tests/browser 的锁文件安装和 Chromium。npm run test:integration 在独立目录安装并构建，再运行真实 API/MCP/浏览器检查；中断会清理所拥有的服务，失败证据保留在 test-results。

npm run test:execution:domain 运行不依赖 Docker 的执行领域检查。npm run test:execution 和 npm run test:backend:integration 要求真实 Docker daemon、flock、proc 和锁定 Node 镜像；本机缺少它们时明确报告，CI 仍保留完整 Docker 检查。

只运行与实际变更相关、能验证行为的检查；通过后不重复整套测试，除非又有变更、失败或尚未解决的问题。

`npm run test:next-steps` 使用全新 SQLite 和真实 Chromium 验证点子接入项目传递、手工 Plan 保存、空看板起步、Ticket 创建及按需展开执行入口，并将截图与结果保留在 `test-results/new-user-next-steps/`。需要已有 `tests/browser` 的 Playwright 与可信 Chromium，测试仅访问自己的 loopback 服务。
