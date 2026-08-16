# Grok Desk via KIE

一个可部署到个人服务器的 Grok 风格聊天界面。它不绕过 KIE 的计费、并发或限流规则，实际可用量由你的 KIE 账户决定。

## 功能

- 账号密码登录，首次启动自动创建管理员
- KIE OpenAI 兼容聊天端点的流式转发
- 手机与桌面自适应界面
- 密钥仅留在服务器 `.env`，不进入浏览器和 Git
- Docker Compose 部署，用户数据持久化在 `./data`

## 本地启动

```bash
cp .env.example .env
# 编辑 .env，至少填写 KIE_API_KEY、SESSION_SECRET、ADMIN_PASSWORD
npm start
```

打开 `http://localhost:3000`。

## 服务器部署

需要 Docker Engine 和 Docker Compose Plugin。复制配置并编辑：

```bash
cp .env.example .env
nano .env
docker compose up -d --build
docker compose logs -f
```

默认仅监听服务器本机的 `127.0.0.1:3000`。生产环境请用 HTTPS 反向代理（示例见 `Caddyfile.example`），不要直接把 Node/Docker 端口暴露到公网。

## KIE 设置

`KIE_MODEL` 必须是 KIE 文档中当前可用的准确模型 slug。程序会请求：

```text
${KIE_API_BASE}/${KIE_MODEL}/v1/chat/completions
```

若你选择的 Grok 型号或接口变更，只需改 `.env` 的 `KIE_MODEL`，然后执行 `docker compose up -d`。
