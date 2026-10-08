# 本地账户与客户端身份

账户使用本地 scrypt 密码，用户名1–64个 ASCII 字符，密码12–256字。浏览器 session 默认12小时，API token 默认30天；数据库只保留 token 的摘要。不同 owner 的记录和项目互相隔离。

```sh
npm run accounts -- create owner
npm run accounts -- reset owner
npm run accounts -- token owner
npm run accounts -- revoke
```

创建与重置从提示或 stdin 读取密码；revoke 从 stdin/提示读取 token。重置密码会撤销该账户 session/token；密码登录的节流和重置并发在数据库中原子处理。

浏览器使用 HttpOnly、SameSite=Strict cookie，HTTPS 额外使用 Secure。API 使用 Bearer token；不能同时提交两种凭据。身份 header、任意 owner 字段或客户端自报权限都不能替代认证。浏览器写操作保留精确 Host/Origin 校验。

## workspace 客户端

网页登录账户在“连接与执行”创建指定项目、指定能力的一次性授权码，十分钟有效。下载包没有任何凭据；授权码兑换后获得独立的客户端身份和 token。凭据文件0600，父目录0700。客户端 token 默认30天，可在网页撤销。

客户端只允许被授予的读取、报单、规划和执行能力。执行能力允许领取本项目的已批准任务，不允许客户端批准自己的任务；跨项目及跨 owner 访问拒绝。

机器认证仅在明确的 enroll、heartbeat、mcp 和 agent 接口处理；安装包下载是公开代码产物，业务记录和连接管理需要认证。客户端继承本机 Codex 默认配置或显式 Profile，模型账户/API 网关认证留在本机，不写进数据库或下载包；已有 provider 配置不要求再次 Device 登录。

网页撤销后，工具调用、领取和续租立即拒绝；客户端必须停止失去租约的受管进程。连接历史保留，便于查看注册、通信、错误和执行来源。
