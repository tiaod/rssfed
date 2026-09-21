# 踩坑记录

按现象组织，便于搜索。每条都记录**现象 → 原因 → 解法**，多数是"看代码看不出来、只在特定环境下暴露"的那类问题。

## 构建与启动

### `node dist/index.js` 报 `ERR_MODULE_NOT_FOUND`

- **现象**：`pnpm --filter @rssfed/hono-server build`（tsc）成功，但用 node 直接跑产物时找不到 `./app` 等相对模块。
- **原因**：`tsconfig` 用 `moduleResolution: bundler`，源码里的相对导入不带扩展名；tsc 原样输出，而 Node 的 ESM 解析要求显式扩展名。
- **解法**：后端改用 esbuild 打包（`build:bundle`），把本地源码内联成单文件，第三方依赖保持 external。Docker 镜像与 CI 都走这条路径。

### 容器里跑临时脚本报 `ERR_MODULE_NOT_FOUND`

- **现象**：`docker compose exec server node /tmp/check.mjs` 找不到 `@aws-sdk/client-s3` 等依赖。
- **原因**：ESM 从**脚本所在位置**向上查找 `node_modules`，`/tmp` 不在 `/app` 之下。
- **解法**：把脚本放进应用目录再执行，例如 `docker compose cp check.mjs server:/app/packages/hono-server/`，或用 `exec -w /app/packages/hono-server`。

## 配置与环境变量

### server 报 `You are not a server admin`，CouchDB 代理认证配置失败

- **现象**：容器日志出现该错误，`couchdbs` 的 proxy auth 没配上。
- **原因**：`COUCHDB_USER` 只在 `env_file` 里或根本没设，而 `couchdb/client.ts` 对它的默认值是**空字符串**（不是 `admin`），于是 Basic 认证变成 `:password`。
- **解法**：编排里给 server 显式传 `COUCHDB_USER: ${COUCHDB_USER:-admin}`，保证与 CouchDB 容器用的是同一个用户名。

### 改了 `.env.production` 却不生效

- **原因**：`env_file` 的变量在**容器创建时**注入，`docker compose restart` 不会重新读取。
- **解法**：用 `up -d --no-build <service>` 重建容器。

### 未知的 `STORAGE_DRIVER` 静默走了别的后端

- **现象**：配置里写了拼错的驱动名，服务照常启动，但头像上传失败。
- **原因**：分派逻辑只判断了已知值，其余情况落到默认分支。
- **解法**：`createStorageFromEnv()` 现在对未知取值**直接抛错**，让配置错误在启动时就暴露，而不是运行期才以"上传失败"的形式出现。

### 示例配置与真实环境脱节

- **现象**：`.env.example` 里写的是 Garage（`localhost:3900` / `region=garage`），而实际 dev 环境用的是 SeaweedFS（`8333` / `us-east-1`），照示例配连不上。
- **教训**：示例文件是文档，改环境时容易忘记同步。发现后已把示例对齐到实际在用的服务。

## 反向代理与网络

### https 页面上附件地址是 `http://`，图片被浏览器拦截

- **现象**：头像上传成功，`avatarUrl` 返回 `http://<域名>/api/files/...`。
- **原因**：`avatar.ts` 用 `new URL(c.req.url).origin` 拼 URL，而反代之后 Node 适配器拿到的协议仍是 http（未必采用 `X-Forwarded-Proto`）。
- **解法**：优先取配置的对外地址（`BOTS_BASE_URL` / `BETTER_AUTH_URL`），只有都没配时才回退到请求 origin。

### 只转 `/api/*` 会让联邦功能整体 404

- **原因**：Hono 除 `/api/*` 外，还用 `app.all("*")` 兜底承载 ActivityPub 端点。
- **解法**：反代必须同时转发 `/mcp`、`/mcp/*`、`/.well-known/*`、`/nodeinfo/*`、`/ap/*`、`/@*`。规则见 [deploy/Caddyfile](../deploy/Caddyfile)。（`/users/*`、`/inbox` 是 Fedify 默认路由与共享 inbox，当前未启用，实测 404，留着只为将来启用时不至于又漏。）另外 `/mcp` 不能做 301/307，否则 MCP 客户端跟随跳转会丢掉 `Authorization` 头。

### webfinger 正常但 actor 取不到：反代漏放行 `/ap/*`

- **现象**：在 Mastodon 里能搜到 bot 账号（说明 webfinger 解析成功），但账号加载不出来、无法关注、也收不到投递；同时站点首页与 `/api/*` 一切正常，极易误判成联邦代码有问题。
- **原因**：BotKit 的 actor 真实路径是 **`/ap/actor/{username}`**，而反代 matcher 里放行的却是**后端并不存在的 `/users/*`**（实测 404）。webfinger 走 `/.well-known/*`，那条是被放行的，所以它照常返回 200 并给出 `/ap/actor/...` 链接；外部实例拿着这个链接回来取时才落到 Nuxt 上 404。
- **解法**：反代 matcher 必须包含 `/ap/*`（以及 profile 页的 `/@*`），改完 `caddy reload`，然后用这条确认：
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H 'Accept: application/activity+json' \
    https://<域名>/ap/actor/<bot名>     # 必须 200；返回形如 {"statusCode":404,...} 的 JSON 就是漏了
  ```
- **记录**：2026-09-21 上线验收实测踩到，详见 [cloud-deployment-todo.md](cloud-deployment-todo.md) 的「本地端到端验收」一节。

## 数据库与迁移

### `drizzle-kit push` 要 DROP `fedify_kv_v2`，会删掉 Bot 私钥

- **现象**：本地 `pnpm db:push` 提示 `You're about to delete fedify_kv_v2 table with N items`；线上 migrate 服务跑的是 `push --force`，会**自动批准**这条 DROP。⚠️ 更隐蔽的是：**表为空时连这条提示都不会出现**，drizzle 静默 DROP。
- **原因**：`fedify_kv_v2` / `fedify_message_v2` 由 `@fedify/postgres` 自建自管，不在本仓库的 Drizzle schema 里，push 因此把它们当成「多余的副本」。而 `fedify_kv_v2` 存着 Bot 的 ActivityPub **密钥对**（键形如 `["_botkit","bots",{username},"keyPairs"]`），删掉即永久丢失联邦身份 —— 已关注的实例会因公钥失效而无法验证签名。
- **解法**：把这两张表移出 `public` —— Fedify 的表统一建在独立 schema `fedify` 下。做法是给 BotKit 的独立连接设置 `search_path`（`bots/index.ts` 的 `botkitSql`，走 PG 启动参数 `options`），并在启动流程里由 `ensureFedifySchema()` 幂等建 schema。drizzle 默认只管理 `public`，从此结构上够不着它们。`drizzle.config.ts` 另保留 `tablesFilter: ["*", "!fedify_*"]` 作为第二道防线。
- **注意**：`fedify` schema 必须先于 Fedify 建表存在 —— Fedify 只建表、不建 schema，schema 缺失时建表会失败（由 `ensureFedifySchema()` 保证）。移库后 `public` 里的旧 `fedify_*` 空表可手工 DROP。

### 加唯一约束时 `push` 会问「是否 truncate 表」

- **现象**：给已有数据的表加 `.unique()` 后，`drizzle-kit push` 会问 `Do you want to truncate <table> table?`，而 `--force` 会走 truncate 分支（即清空该表）。
- **解法**：别用 `--force` 硬跑。先用等价 SQL 手工加约束 —— 数据无重复时必然成功且保留数据，之后 `push` 会认为结构已对齐：
  ```sql
  ALTER TABLE bots ADD CONSTRAINT bots_preferred_username_unique UNIQUE (preferred_username);
  ```

## 对象存储

### 上传报 `NoSuchBucket`

- **原因**：应用只做 PutObject，**不会自动建桶**。
- **解法**：首次部署后手动建一次（命令见 [docker-deployment.md](docker-deployment.md) 第 9 节）。

### 用未签名请求探测 SeaweedFS 的 S3 端口返回 403

- **说明**：这是 `AccessDenied` 的正常响应，说明服务在监听，**不是故障**。

## 本地环境与工具

### `git push` 报 `Bad owner or permissions on /etc/ssh/ssh_config.d/...`

- **现象**：SSH 到 GitHub 直接失败，提示该文件的属主/权限不对（WSL 里该符号链接属主成了 `nobody:nogroup`）。
- **解法**（二选一）：
  - 修正系统文件：`sudo chown -R root:root /etc/ssh/ssh_config.d /usr/lib/systemd/ssh_config.d`
  - 或让 git 绕过所有 ssh 配置：`git config --global core.sshCommand "ssh -F /dev/null -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes"`

### dev compose 的服务绑在 `0.0.0.0`，局域网可直连

- **风险**：PostgreSQL / CouchDB / Redis 用的都是弱口令（`rssfed` / `admin` / 无密码），而端口映射写的是 `5432:5432` 这类全网卡绑定 —— 同网段设备可以直接连上开发数据库。
- **解法**：全部改为 `127.0.0.1:5432:5432` 形式，只绑宿主回环。手机调试用不到这些端口（只用到前端的 3000 与后端的 3001）。

## 部署环境相关

### 服务器无法 `git clone` 或拉取 Docker Hub 镜像

- **现象**：`github.com` 的 HTTPS 与 `registry-1.docker.io` 均超时；但 **GitHub SSH(22) 可用**、`ghcr.io` 可用、云厂商内网镜像加速源可用。
- **影响**：代码同步走 SSH；基础镜像走加速源；自有镜像走 ghcr。

### 服务器内存不足，构建 Nuxt 会 OOM

- **现象**：容器内 `nuxt build` 被 OOM killer 干掉（机器约 2G 内存）。
- **解法**：镜像一律在 CI（或本地）构建后推送/传输，服务器只 `pull` 与运行。见 [docker-deployment.md](docker-deployment.md) 第 10 节。
