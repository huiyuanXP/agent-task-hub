# 本机部署

需要 Node.js >=22.23.3。执行 npm run install:ci 保持锁文件安装，再执行 npm run build。构建生成 .next 和客户端归档，不创建业务账户或数据库。

```sh
npm run accounts -- create owner
npm start
```

密码通过终端提示读取；无人值守时可以从 stdin 传入，避免把密码写在命令参数里。

默认 APP_HOST=127.0.0.1、APP_PORT=5173、APP_ORIGIN=http://127.0.0.1:5173、APP_DB_PATH=.local/data.sqlite。设置必须在 Node 启动之前传入；单独复制 .env 不会自动配置启动脚本。

```sh
node --env-file=.env --experimental-strip-types scripts/server.mjs
```

开发模式使用 npm run dev。进程启动后每60秒维护规划投递/租约；APP_SCHEDULER_INTERVAL_MS=0 可关闭维护。常驻客户端通过 outbound 请求领取任务，无需对外暴露它的回调端口。

SQLite 使用 WAL、外键和追加的有序迁移，schema_migrations 跟踪已执行 SQL；正常重启不得重新手动执行全部原始 SQL。数据库、WAL 和连接凭据须保存到私有目录。

临时远程预览可以用 HTTPS 隧道连接 loopback 服务，并将 APP_ORIGIN 配置成该 HTTPS origin。Host/Origin 必须匹配；HTTPS 浏览器 cookie 使用 Secure。隧道地址变化时，更新服务 origin 和客户端 set-url 设置，保留数据库。

停止进程会先关闭 HTTP 与维护定时器，再关闭数据库。升级先停止旧服务、构建、再启动，避免正在访问时改写共享 .next。客户端安装入口 /install；包下载 /api/connectors/download。
