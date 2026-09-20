# tirz-tracker 私有云端同步安全升级需求与技术方案 V2.0

> 项目：`Walking-SCR/tirz-tracker`  
> 改造原则：基于当前 Antigravity 已实现版本增量升级，不重做 UI，不重构业务逻辑，只升级「认证、GitHub 存储访问方式、部署方式、数据安全」。

---

# 1. 项目背景

当前 tirz-tracker 已经完成一版：

- 手机 Web 页面访问；
- 体重记录；
- 注射记录；
- 手机拍照 / 相册上传；
- 图片压缩；
- GitHub Private Repository 数据同步；
- GitHub Fine-Grained PAT；
- 前端直接调用 GitHub REST API；
- PAT 保存在浏览器 LocalStorage / IndexedDB；
- PWA / 手机访问相关能力。

本次**不重新开发产品功能与 UI**。

本次核心目标是解决当前架构中的一个主要安全问题：

> GitHub PAT 不应长期保存在手机浏览器中。

改造后：

```text
当前：

手机浏览器
   │
   ├── GitHub PAT
   │
   └── 直接调用 GitHub API
              ↓
         GitHub Private Repo


升级后：

手机浏览器
   │
   │ HTTPS
   ▼
Cloudflare Worker
   ├── 页面托管
   ├── 用户认证
   ├── API
   └── GitHub PAT Secret
              │
              ▼
       GitHub Private Repo
```

GitHub 仍然是唯一长期数据存储。

Cloudflare 不作为业务数据库。

---

# 2. 本次改造核心目标

## 2.1 必须实现

最终必须满足：

1. `tirz-tracker` 项目必须为 GitHub Private Repository；
2. 体重数据只能本人访问；
3. 注射数据只能本人访问；
4. 上传的电子秤照片只能本人访问；
5. 所有业务数据最终持久化在 GitHub Private Repository；
6. GitHub PAT 不允许出现在浏览器；
7. GitHub PAT 不允许存在 LocalStorage；
8. GitHub PAT 不允许存在 IndexedDB；
9. GitHub PAT 不允许写入 JS / HTML；
10. GitHub PAT 不允许提交至 Git；
11. PAT 只能保存在 Cloudflare Worker Secret；
12. 手机可以直接访问网页；
13. 支持添加到 iPhone 主屏幕；
14. Mac / iPhone 数据保持一致；
15. 日常登录不发送邮件验证码；
16. 日常登录页面只要求输入本人邮箱；
17. 不能因为取消验证码而降低为“知道邮箱即可登录”；
18. 当前已经实现的 UI、趋势图、称重、拍照等功能保持不变。

---

# 3. 非目标

本次不要过度设计。

明确不做：

- 不引入 MySQL；
- 不引入 PostgreSQL；
- 不引入 Supabase；
- 不引入 Firebase；
- 不引入 Cloudflare D1；
- 不引入 Cloudflare R2；
- 不引入 Redis；
- 不开发完整用户中心；
- 不开发注册体系；
- 不开发找回密码；
- 不开发多租户；
- 不开发 RBAC；
- 不开发复杂 OAuth Server；
- 不重写现有前端；
- 不为了技术升级改变当前 UI 风格。

这是一个：

> 单用户、个人使用、隐私优先的轻量应用。

---

# 4. 最终技术架构

采用：

> **GitHub Private Repo + Cloudflare Worker Static Assets + Worker API + Device Binding + Worker Secrets**

架构：

```text
                         iPhone / Mac
                              │
                              │ HTTPS
                              ▼
                 ┌──────────────────────┐
                 │ Cloudflare Worker    │
                 │                      │
                 │ Static Assets        │
                 │ ├─ HTML              │
                 │ ├─ CSS               │
                 │ ├─ JS                │
                 │ └─ PWA               │
                 │                      │
                 │ Authentication       │
                 │ ├─ Email             │
                 │ └─ Trusted Device    │
                 │                      │
                 │ REST API             │
                 │ ├─ Records           │
                 │ ├─ Doses             │
                 │ └─ Photos            │
                 │                      │
                 │ Worker Secrets       │
                 │ ├─ GITHUB_TOKEN      │
                 │ ├─ AUTH_SIGNING_KEY  │
                 │ └─ BOOTSTRAP_SECRET  │
                 └───────────┬──────────┘
                             │
                             │ GitHub REST API
                             ▼
                ┌────────────────────────┐
                │ GitHub Private Repo    │
                │ tirz-tracker-data      │
                │                        │
                │ data/records.json      │
                │ data/doses.json        │
                │ images/YYYY/MM/*.webp  │
                └────────────────────────┘
```

---

# 5. GitHub Repository 设计

建议代码和隐私数据分离。

## 5.1 APP Repo

```text
Walking-SCR/tirz-tracker
Private
```

存：

```text
tirz-tracker/

├── public/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── manifest.json
│   ├── icons/
│   └── vendor/
│
├── src/
│   ├── index.js
│   ├── auth.js
│   ├── github.js
│   └── api/
│
├── wrangler.jsonc
├── package.json
└── README.md
```

这里不允许出现：

```text
个人体重历史
个人照片
GitHub PAT
BOOTSTRAP_SECRET
AUTH_SIGNING_KEY
```

## 5.2 DATA Repo

新建：

```text
Walking-SCR/tirz-tracker-data
Private
```

目录：

```text
tirz-tracker-data/

├── data/
│   ├── records.json
│   └── doses.json
│
└── images/
    └── 2026/
        └── 09/
            ├── wt-20260921-083200.webp
            └── wt-20260922-081500.webp
```

原则：

> AI 编码工具修改 UI 时，默认只需要 APP Repo 权限，不需要 DATA Repo 权限。

---

# 6. 数据结构

## 6.1 records.json

示例：

```json
[
  {
    "id": "wt-20260921-083200",
    "date": "2026-09-21",
    "time": "08:32",
    "weight": 168.2,
    "unit": "斤",
    "condition": "早上空腹",
    "remark": "",
    "photo": "images/2026/09/wt-20260921-083200.webp",
    "timestamp": 1789941120000,
    "createdAt": "2026-09-21T08:32:00+08:00",
    "updatedAt": "2026-09-21T08:32:00+08:00"
  }
]
```

禁止：

```json
{
  "photo": "data:image/jpeg;base64,..."
}
```

Base64 图片不能继续直接塞入 records.json。

---

# 7. 图片存储

上传照片流程：

```text
iPhone 原始照片
      ↓
浏览器 Canvas
      ↓
缩放
      ↓
WebP
      ↓
Cloudflare Worker
      ↓
GitHub Private DATA Repo
```

建议参数：

```text
最长边：1200px
格式：WebP
Quality：0.78
```

目标：

```text
普通照片：
3～8 MB

压缩后：
约 80～300 KB
```

不保存手机原始 5MB～10MB 图片。

---

# 8. 认证设计

## 8.1 核心要求

用户明确要求：

> 日常登录不需要收验证码，只输入邮箱即可。

但：

> 仅仅检查邮箱字符串不构成身份认证。

禁止实现：

```javascript
if (email === "xxx@xxx.com") {
    loginSuccess();
}
```

否则任何知道该邮箱的人都可以登录。

所以采用：

> **邮箱 + 已授权设备凭证**

用户看到的仍然只有邮箱输入框。

---

# 9. 登录体验

正常情况下：

```text
打开 App
    ↓
输入邮箱
    ↓
Worker 判断：

① Email 是否正确
② 当前浏览器是否已经完成设备绑定
    ↓
两个条件同时成立
    ↓
登录成功
```

整个流程：

```text
不发送邮件
不发送 OTP
不收验证码
不输入密码
不输入 GitHub Token
```

---

# 10. 设备认证机制

第一次使用某一台手机时，需要完成一次：

> Trusted Device Binding

绑定成功后，Worker 写入：

```text
tirz_device
```

Cookie。

要求：

```text
HttpOnly
Secure
SameSite=Strict
Path=/
```

例如：

```text
Set-Cookie:
tirz_device=<signed-value>;
HttpOnly;
Secure;
SameSite=Strict;
Path=/;
Max-Age=15552000
```

建议设备有效期：

```text
180 天
```

浏览器 JavaScript：

**不能读取该 Cookie。**

---

# 11. 首次设备绑定

由于不能使用邮箱验证码，所以必须提供一个**独立的可信设备初始化机制**。

实现 `/setup` 管理入口。

正常用户登录页面不显示该入口。

初始化流程：

```text
首次部署
    ↓
Cloudflare 设置 BOOTSTRAP_SECRET
    ↓
本人手机打开 /setup
    ↓
完成一次设备授权
    ↓
Worker 下发 HttpOnly Device Cookie
    ↓
关闭 Bootstrap
```

`BOOTSTRAP_SECRET`：

必须存在：

```text
Cloudflare Worker Secret
```

禁止：

```text
写入 HTML
写入 JS
提交 GitHub
LocalStorage
IndexedDB
```

完成设备初始化后：

```text
BOOTSTRAP_ENABLED=false
```

关闭设备注册入口。

以后每天使用：

**完全不需要再输入这个初始化凭据。**

---

# 12. 日常登录逻辑

API：

```http
POST /api/auth/login
```

Request：

```json
{
  "email": "本人邮箱"
}
```

Worker 验证：

```text
1. email === ALLOWED_EMAIL

AND

2. tirz_device Cookie 签名合法
```

两个条件同时满足：

```text
登录成功
```

否则：

```text
401 EMAIL_NOT_ALLOWED

或

403 DEVICE_NOT_BOUND
```

---

# 13. 登录 Session

设备凭证和登录 Session 分离。

Cookie：

```text
tirz_device
```

表示：

> 这是一台可信设备。

Cookie：

```text
tirz_session
```

表示：

> 当前已经登录。

建议：

```text
tirz_device：
180 天

tirz_session：
30 天
```

如果 Session 尚未过期：

打开 App 可以直接进入。

如果 Session 过期：

```text
输入邮箱
↓
设备验证
↓
重新登录
```

仍然：

> 不发送验证码。

---

# 14. Session 签名

不需要 JWT 框架。

为了保持轻量，可直接采用：

```text
payload + HMAC-SHA256
```

Secret：

```text
AUTH_SIGNING_KEY
```

放在：

```text
Cloudflare Worker Secret
```

Payload 至少包含：

```json
{
  "email": "xxx@example.com",
  "deviceId": "xxxxxxxx",
  "type": "session",
  "iat": 1789941120,
  "exp": 1792533120
}
```

Worker 验证签名和有效期。

---

# 15. 前端不能保存任何认证 Secret

允许前端保存：

```text
UI 设置
主题
非敏感缓存
最后同步时间
```

禁止前端保存：

```text
GitHub PAT
AUTH_SIGNING_KEY
BOOTSTRAP_SECRET
GitHub 写权限 Token
```

---

# 16. Cloudflare Worker Secrets

生产环境至少配置：

```text
GITHUB_TOKEN
AUTH_SIGNING_KEY
BOOTSTRAP_SECRET
```

普通环境变量：

```text
GITHUB_OWNER=Walking-SCR
GITHUB_DATA_REPO=tirz-tracker-data
ALLOWED_EMAIL=<本人邮箱>
BOOTSTRAP_ENABLED=false
```

注意：

`.dev.vars`

必须加入：

```text
.gitignore
```

不得提交 Git。

---

# 17. GitHub Token 权限

使用：

> Fine-Grained Personal Access Token

Repository Access：

只允许：

```text
tirz-tracker-data
```

Permission：

```text
Contents:
Read and Write
```

其他权限全部关闭。

不要给予：

```text
Administration
Actions
Issues
Pull Requests
Secrets
Organization
Packages
```

---

# 18. 前端 Storage Adapter 改造

Antigravity 当前已经实现了一套：

```text
GitHubStorageAdapter
```

本次**不要大面积修改业务代码**。

建议保持 Adapter Pattern。

当前：

```text
UI
 ↓
GitHubStorageAdapter
 ↓
GitHub REST API
```

改成：

```text
UI
 ↓
CloudStorageAdapter
 ↓
/api/*
 ↓
Cloudflare Worker
 ↓
GitHub REST API
```

例如提供：

```javascript
class CloudStorageAdapter {

  async getRecords() {}

  async createRecord(record, photo) {}

  async updateRecord(id, data) {}

  async deleteRecord(id) {}

  async getDoses() {}

  async saveDose(data) {}

  async getPhoto(path) {}

}
```

上层业务组件尽可能保持现状。

---

# 19. 删除旧版 Token 配置 UI

如果目前页面存在：

```text
GitHub Token
GitHub Owner
Repo Name
PAT 配置
云端 Token 设置
```

全部删除。

用户不应该在手机 App 中看到这些配置。

可以保留：

```text
云端同步

● 已连接
最近同步：08:32
```

但不展示底层 Token。

---

# 20. 清理历史浏览器 Token

因为旧版本已经可能把 PAT 写到：

```text
LocalStorage
IndexedDB
```

新版本第一次启动必须执行一次 legacy cleanup。

例如：

```javascript
localStorage.removeItem("github_token");
localStorage.removeItem("github_pat");
localStorage.removeItem("tirz_github_token");
```

根据当前代码中真实 Key 进行处理。

IndexedDB 中如存在 PAT：

也必须删除。

注意：

不要粗暴清空整个 LocalStorage。

只能清理旧 Token 相关 Key。

---

# 21. PAT 迁移后必须轮换

因为旧 PAT 曾经存在客户端：

新架构上线并验证成功后：

必须：

```text
撤销旧 PAT
```

重新创建：

```text
新的 Fine-Grained PAT
```

新的 PAT：

> 只进入 Cloudflare Secret。

旧 PAT 不得继续使用。

---

# 22. Worker API

## Authentication

```text
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/status
POST /api/auth/bootstrap
```

## Weight Records

```text
GET    /api/records
POST   /api/records
PATCH  /api/records/:id
DELETE /api/records/:id
```

## Dose Records

```text
GET    /api/doses
POST   /api/doses
PATCH  /api/doses/:id
DELETE /api/doses/:id
```

## Photos

```text
GET /api/photos/:year/:month/:filename
```

图片上传由：

```text
POST /api/records
```

使用：

```text
multipart/form-data
```

一起提交。

---

# 23. 新增称重数据流程

```text
用户拍照
     ↓
浏览器压缩 WebP
     ↓
用户确认体重
     ↓
POST /api/records
     ↓
Worker 验证 Session
     ↓
Worker 上传 WebP 到 DATA Repo
     ↓
Worker 读取 records.json 最新 SHA
     ↓
追加记录
     ↓
GitHub PUT
     ↓
返回成功
     ↓
前端刷新趋势
```

---

# 24. GitHub 并发处理

GitHub Contents API 更新文件需要当前 SHA。

正常流程：

```text
GET records.json
      ↓
获取 SHA
      ↓
修改 JSON
      ↓
PUT records.json + SHA
```

如果出现：

```text
409 Conflict
```

Worker：

```text
重新获取最新版
↓
重新合并
↓
Retry 一次
```

最多：

```text
1 次自动重试
```

不要引入：

```text
数据库锁
Redis
Durable Objects
消息队列
```

单用户应用没有必要。

---

# 25. 图片读取

禁止前端直接请求：

```text
raw.githubusercontent.com
```

禁止把 GitHub 私有图片 URL 直接暴露给浏览器。

必须：

```text
浏览器
 ↓
GET /api/photos/...
 ↓
Worker
 ↓
GitHub Private Repo
 ↓
Worker 返回图片
```

Response：

建议：

```text
Cache-Control: private, no-store
```

---

# 26. CSRF 防护

所有修改数据的接口：

```text
POST
PATCH
DELETE
```

Worker 必须检查：

```text
Origin
```

只接受本站 Origin。

配合：

```text
SameSite=Strict
```

Cookie。

---

# 27. CORS

不需要开放跨域 API。

原则：

```text
Same-Origin Only
```

不要：

```http
Access-Control-Allow-Origin: *
```

---

# 28. HTTP Security Headers

至少配置：

```text
Content-Security-Policy
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
X-Frame-Options
```

推荐目标：

```text
default-src 'self'
connect-src 'self'
img-src 'self' data: blob:
frame-ancestors 'none'
base-uri 'none'
form-action 'self'
```

根据现有项目实际依赖调整。

---

# 29. 第三方 CDN 处理

当前项目曾使用：

```text
Tailwind CDN
Chart.js CDN
Phosphor Icons CDN
```

本次建议：

> 不再运行时加载外部 JS。

改成：

```text
npm dependency / 本地 vendor
↓
构建时打包
↓
随 Worker Static Assets 部署
```

特别是：

```text
Chart.js
图标 JS
```

不要从第三方 CDN 动态执行。

目的是降低：

> 第三方脚本读取页面数据和供应链攻击风险。

UI 样式保持不变。

---

# 30. AI 图片识别接口

如果当前项目未来真正启用 Gemini / 其他视觉模型：

禁止：

```javascript
const apiKey = "xxx";
```

也禁止浏览器直接请求模型 API。

必须：

```text
手机图片
 ↓
Worker
 ↓
AI Provider
```

API Key：

```text
Cloudflare Worker Secret
```

当前如果 AI Key 为空，可以继续保持手动确认逻辑。

本次不要因为安全架构改造额外扩大 AI 功能范围。

---

# 31. Worker Static Assets

使用 Cloudflare Workers Static Assets。

不要再拆：

```text
Cloudflare Pages
+
Cloudflare Worker
```

而是：

```text
一个 Worker Deployment
```

同时包含：

```text
public/
+
src/index.js
```

例如：

```json
{
  "name": "tirz-tracker",
  "main": "src/index.js",
  "compatibility_date": "2026-09-21",
  "assets": {
    "directory": "./public/"
  }
}
```

实际配置按照当前 Wrangler 最新格式完成。

---

# 32. PWA

保留 / 补充：

```text
manifest.json
icons
display: standalone
theme_color
background_color
```

iPhone Safari：

```text
分享
↓
添加到主屏幕
```

达到类似原生 App 的体验。

不要为了 PWA 引入复杂离线同步。

---

# 33. Service Worker

Service Worker 只能缓存：

```text
HTML
CSS
JS
Icon
```

不要缓存：

```text
records.json API Response
Dose API Response
私人照片
认证响应
```

避免隐私数据长期留在 Cache Storage。

---

# 34. 数据源原则

Cloudflare：

不是数据库。

浏览器：

不是数据库。

LocalStorage：

不是主数据源。

唯一主数据源：

```text
GitHub Private DATA Repo
```

页面刷新时：

```text
Worker
↓
GitHub
↓
读取真实数据
```

浏览器可以有短暂运行时缓存，但不得形成另一份不可控主数据。

---

# 35. 从 Antigravity 当前版本迁移

这是增量升级，不允许推倒重做。

Antigravity 开始开发前必须：

### Step 1

读取当前本地工作区。

重点查找：

```text
GitHubStorageAdapter
github token
localStorage
IndexedDB
records.json
images/
manifest
service worker
GitHub API
```

以**当前本地 Antigravity 实现版本**为基准。

不要以 GitHub 远端旧版 index.html 为基准覆盖当前代码。

### Step 2

先保证现有版本：

```text
可运行
可录体重
可上传照片
可显示趋势
可读取历史
```

建立改造前 baseline。

### Step 3

抽象现有 GitHubStorageAdapter。

尽量保持：

```text
业务层调用接口不变
```

只替换底层：

```text
Direct GitHub API

→

Worker API
```

### Step 4

增加 Cloudflare Worker API。

### Step 5

将 PAT 移至 Worker Secret。

### Step 6

增加设备绑定认证。

### Step 7

删除前端 Token 设置。

### Step 8

迁移 / 验证数据。

### Step 9

清除旧客户端 Token。

### Step 10

撤销旧 PAT。

---

# 36. 数据迁移策略

如果当前版本已经将：

```text
records.json
images/
```

上传 GitHub Private Repo：

不要重新录入数据。

迁移现有文件。

如果当前数据和应用代码在同一 Repo：

迁移：

```text
data/
images/
```

至：

```text
tirz-tracker-data
```

保证：

```text
id 不改变
date 不改变
timestamp 不改变
图片文件与记录关联不改变
```

迁移完成并验证后才能删除原数据。

---

# 37. 当前公开历史数据处理

如果个人体重数据曾经提交到 Public Repo：

必须视为曾经公开。

本次完成后：

1. 将应用 Repo 设置为 Private；
2. 移除代码中的默认真实体重数据；
3. 不再把真实记录作为 `defaultWeights` 写死；
4. 必要时清理 Git 历史；
5. Demo 数据必须使用虚构值。

新用户 / 无数据状态：

显示：

```text
暂无称重数据
```

不能自动生成真实历史数据。

---

# 38. UI 改造要求

本次原则：

> UI 尽量不动。

允许新增：

```text
登录页
未授权设备页
初始化设备页
同步状态
登录退出
```

其他页面：

```text
首页
趋势图
称重卡片
历史记录
拍照
手动补录
注射周期
视觉风格
```

保持当前实现。

---

# 39. 登录页面

只显示：

```text
邮箱地址
```

主按钮：

```text
进入
```

不要显示：

```text
发送验证码
获取验证码
密码
GitHub Token
PAT
Repository
```

如果设备没有授权：

提示：

```text
当前设备尚未授权访问此私人数据。
请先完成设备绑定。
```

不要泄露：

```text
GitHub Repo
Token
Data Path
后台错误栈
```

---

# 40. 错误处理

统一错误码：

```text
AUTH_REQUIRED
EMAIL_NOT_ALLOWED
DEVICE_NOT_BOUND
SESSION_EXPIRED

GITHUB_READ_FAILED
GITHUB_WRITE_FAILED
GITHUB_CONFLICT

PHOTO_UPLOAD_FAILED
RECORD_SAVE_FAILED
NETWORK_ERROR
```

前端展示用户可理解文案。

Console 可以记录技术错误。

但：

> 不允许输出 PAT、Secret 或完整 Authorization Header。

---

# 41. 日志安全

禁止：

```javascript
console.log(token);
console.log(request.headers);
console.log(env.GITHUB_TOKEN);
```

Worker 日志不得出现：

```text
GITHUB_TOKEN
AUTH_SIGNING_KEY
BOOTSTRAP_SECRET
完整 Cookie
照片 Base64
```

---

# 42. 故障降级

如果 GitHub 暂时不可用：

页面可以显示最近已经加载的数据。

但新增记录必须明确提示：

```text
云端保存失败，请重试
```

不要伪装保存成功。

不要产生：

```text
只存在手机却显示“同步完成”的数据。
```

---

# 43. 图片上传事务处理

流程：

```text
1 上传图片
2 更新 records.json
```

如果：

```text
图片上传成功
records.json 更新失败
```

Worker：

优先尝试删除刚上传的孤儿图片。

即：

```text
best effort rollback
```

不要引入复杂分布式事务。

---

# 44. 删除记录

用户删除记录时：

```text
删除 records.json 记录
↓
如果有关联图片
↓
同步删除图片
```

如果图片删除失败：

记录删除可以完成。

日志记录 orphan photo。

后续可以人工清理。

---

# 45. 安全边界

最终安全模型：

```text
知道网址
≠
可以访问

知道邮箱
≠
可以访问

知道 GitHub Repo 名
≠
可以访问

拥有已授权设备
+
输入正确邮箱
=
可以访问
```

GitHub PAT：

```text
只有 Worker 知道
```

---

# 46. 本次明确不采用的方案

不要继续采用：

```text
浏览器
↓
PAT
↓
GitHub REST API
```

不要采用：

```text
PAT → LocalStorage
```

不要采用：

```text
PAT → IndexedDB
```

不要采用：

```text
邮箱字符串匹配成功直接放行
```

不要采用：

```text
简单前端 PIN
```

作为服务器安全认证。

---

# 47. 测试要求

开发完成后至少测试以下场景。

## 正常

```text
授权 iPhone 登录
授权 Mac 登录
读取记录
新增记录
修改记录
删除记录
上传照片
查看照片
替换照片
新增注射记录
刷新页面
重新打开 PWA
```

## Authentication

```text
错误邮箱
正确邮箱 + 未授权设备
正确邮箱 + 已授权设备
Session 过期
Device Cookie 不存在
Cookie 被篡改
退出登录
```

## Security

验证浏览器：

```text
LocalStorage 无 GitHub PAT
IndexedDB 无 GitHub PAT
HTML 无 GitHub PAT
JS Bundle 无 GitHub PAT
Network Response 无 GitHub PAT
Console 无 GitHub PAT
```

## GitHub

验证：

```text
DATA Repo Private
图片无法匿名访问
records.json 无法匿名访问
PAT 仅 DATA Repo Contents 权限
```

---

# 48. 验收标准

只有全部满足才视为完成。

### AC-01

未登录访问页面不能读取体重数据。

### AC-02

输入正确邮箱，但从未绑定的浏览器不能读取数据。

### AC-03

已绑定手机输入本人邮箱可以登录。

### AC-04

日常登录全过程不发送邮件验证码。

### AC-05

浏览器不存在 GitHub PAT。

### AC-06

DevTools 无法找到 GitHub PAT。

### AC-07

PAT 仅存在 Cloudflare Worker Secret。

### AC-08

新增体重后 GitHub `records.json` 正确更新。

### AC-09

上传照片实际存入 Private DATA Repo。

### AC-10

匿名用户无法访问图片。

### AC-11

iPhone 和 Mac 看到相同数据。

### AC-12

刷新页面数据不丢失。

### AC-13

原有趋势图功能正常。

### AC-14

原有照片上传功能正常。

### AC-15

原有注射记录功能正常。

### AC-16

不改变当前视觉设计和主要交互。

---

# 49. 回滚要求

改造前必须创建：

```text
git tag / backup branch
```

例如：

```text
backup/pre-worker-security-migration
```

如果 Worker 新版异常：

可以恢复旧代码。

但是：

> 旧架构只能作为临时回滚，不应重新长期使用浏览器 PAT。

数据迁移前也必须备份：

```text
records.json
doses.json
images/
```

---

# 50. Antigravity 开发原则

必须遵循：

1. 先检查当前项目；
2. 不凭空假设目录；
3. 不覆盖已经完成的 UI；
4. 不大面积重写 index.html；
5. 尽量通过 Adapter 替换底层存储；
6. 每完成一个阶段进行测试；
7. 不生成假的成功状态；
8. 不把 Secret 写进代码；
9. 不为了“架构漂亮”增加不必要依赖；
10. 优先轻量；
11. 优先可维护；
12. 优先安全；
13. 必须检查 Diff；
14. 必须做手机端兼容验证。

---

# 51. 建议实施顺序

```text
Phase 0
当前代码和数据备份

        ↓

Phase 1
GitHub Repo 私有化
建立 tirz-tracker-data

        ↓

Phase 2
建立 Cloudflare Worker
Static Assets 跑通

        ↓

Phase 3
实现 GitHub Server Adapter
PAT → Worker Secret

        ↓

Phase 4
前端 GitHubStorageAdapter
替换为 Worker API

        ↓

Phase 5
实现 Device Binding
Email 登录

        ↓

Phase 6
迁移 records / doses / images

        ↓

Phase 7
删除浏览器 PAT

        ↓

Phase 8
轮换 GitHub PAT

        ↓

Phase 9
PWA / iPhone 验证

        ↓

Phase 10
安全检查 + 最终验收
```

---

# 52. 最终目标状态

最终系统应当满足：

```text
               手机只负责 UI
                      │
                      ▼
           Cloudflare Worker
             │              │
             │              │
           登录           GitHub PAT
                           Secret
                            │
                            ▼
                  GitHub Private Data
```

安全边界：

```text
浏览器泄露
→ 不会泄露 GitHub PAT

页面源码泄露
→ 不会泄露用户数据

GitHub APP Repo 被 AI 工具读取
→ 不会自动读取 DATA Repo

别人知道邮箱
→ 不能登录

别人知道网址
→ 不能登录
```

同时继续保持：

```text
轻量
单用户
低维护
没有数据库
没有服务器
没有验证码
手机可访问
数据全部在 GitHub
```

这就是本项目 V2.0 的目标架构。
