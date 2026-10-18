# DealPilot AI P0 整改验收记录

日期：2026-10-18（Asia/Shanghai）。范围：安全整改、稳定依赖、测试；无 AI Agent、支付宝 SDK、真实支付或发布操作。

## 恢复状态

仓库 `/workspace/dealpilot-ai`；origin 为 `869280072-ops/dealpilot-ai`。
本地当前分支 `security/p0-baseline`，HEAD `6e33e58b1e553a41fe22e6b941a7229a002de361`。本地 `work`、origin/main 均指向该提交；远端 `git ls-remote --heads` 只有 main。
最近提交包括 `6e33e58` Canary 升级、`d42d42e` React2Shell 修复、`e0dc5d4` SWR mutate 修复。
恢复时已有 21 个 tracked 文件差异及未跟踪的会话工具、proxy、测试等；旧任务未提交内容确实存在。未 reset、clean、stash、覆盖分支或丢弃工作区。
修改前备份：`/workspace/work/p0-recovery/initial.patch` 与 `untracked.tar`。复用了旧分支，并审查 `/workspace/DealPilot-AI-技术审查报告.md` 的 S1—S9。上轮结束时修改留在此分支的工作区，未提交、推送或合并。本轮按用户明确授权检查并保存为提交、推送此分支并创建面向 main 的 Draft PR；不合并、不部署、不启用支付。

## 已处理

- S1：内部认证查询与 public-user DTO 分离；API、根布局只序列化 id/name/email。团队返回字段白名单，不返回 Stripe 客户/订阅标识；用户和团队 API 使用 private/no-store。匿名及非法 Cookie 返回 null，保持现有 SWR 约定。
- S2/S3/S8：以当前数据库 membership 的 owner 角色控制邀请、删除和账单操作；删除限定本团队普通成员，保护本人与其他 owner。FormData 数字转换与校验同步修正。客户端团队权限改用 membership，服务端不信任全局 role 或提交的 teamId/userId。
- S4：支付回跳绝不调用 setSession、不修改团队订阅；要求当前登录 owner，并匹配 Stripe 服务端会话的用户/团队、完成状态及付款状态。客户端成功参数不会发放权益。
- Stripe 默认禁用（LEGACY_STRIPE_ENABLED 未设或 false）。通知入口验签；签名失败拒绝，处理失败返回 503 供重试。既有订阅更新再次查询 Stripe 当前状态，核对客户与已绑定订阅，防止旧事件回放恢复过期权益；所有非 active/trialing 状态清除产品权益。修复门户未定义 client 引用与运行时 product 类型处理。
- S5/S9：注册事务化；以数字邀请 ID 和未经验证邮箱加入团队的路径暂时关闭。邀请仅记录待处理请求，明确提示邮件和接受功能尚未启用。
- S6：AUTH_SECRET 至少 32 字节；JWT 固定 HS256、校验声明和绝对有效期；非法会话受控失效。凭据 HMAC 版本使修改密码后旧令牌失效，JWT 不包含原始密码哈希。
- S7 部分：动作失败状态不返回密码，登录页不再回填密码；新密码限制 bcrypt 72 字节。支付与开发脚本只记录固定错误信息，避免第三方错误携带密钥/Token。
- `.env*` 全部忽略，仅允许 `.env.example`；当前 tracked 环境文件仅示例。开发 setup 以 wx/0600 创建环境文件，拒绝覆盖已有文件。seed 要求明确非生产 opt-in 和自定义密码，事务执行，移除公开默认账号及远程支付商品创建。

## 开发基线

Node 24，pnpm 9.15.9，Next.js/对应 eslint-config-next 16.4.2（npm 当前 latest 核实），React/DOM 19.3.1。移除实验渲染配置，middleware 改为 Next 16 proxy，不再自动无限续期；字体使用系统字体，构建无需下载 Google Fonts。
构建脚本显式使用 webpack：本环境 Turbopack 的 PostCSS 本地端口受限；webpack 生产构建已通过。Next 自动迁移 tsconfig 的 react-jsx 与 dev 类型目录已保留。
ESLint 固定 9.39.5 以匹配现有 Next 插件 peer 范围；此主版本已标记停止维护，升级到 ESLint 10 需等待/验证插件兼容，不应将本次兼容性固定描述成所有工具均处于维护期。
覆盖固定 qs 6.16.0、shell-quote 1.12.0、browserslist 4.28.7、source-map-js 1.2.2、esbuild 0.28.1；跨主版本 esbuild 覆盖已通过构建、测试和 drizzle-kit --help，迁移生成/执行仍须测试库验证。

复现命令：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm build
pnpm typecheck
pnpm audit --prod
```

构建环境需要 POSTGRES_URL（构建不连接数据库）、至少 32 字节 AUTH_SECRET；不配置真实支付密钥，保持 LEGACY_STRIPE_ENABLED=false。新增 GitHub Actions 执行以上门禁；工作流尚未在 GitHub 运行。

## 验证证据

- pnpm 9.15.9 frozen/offline install：通过（首次补齐包后再次运行）。
- Vitest：5 个文件，38 项通过。查询/写入边界使用 mock 与 Drizzle SQL 条件校验；JWT 使用真实签名。支付事件全部合成，没有远程交易。
- ESLint：0 错误、0 警告；tsc --noEmit：通过。
- pnpm build：Next 16.4.2 webpack，编译、类型检查、15 页生成和构建追踪全部通过。沙箱内端口/子进程权限曾失败，允许子进程的执行方式成功；没有关闭 TLS 校验。
- next start：本地生产服务启动成功，9 项 HTTP 冒烟通过（匿名/非法用户和团队 API、支付禁用、后台跳转、首页、定价和登录页），测试后服务已停止。
- pnpm audit --prod：0 已知漏洞；完整 audit：1 high、0 critical，其余 0。剩余为 eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces 3.0.3，深层花括号导致栈耗尽，无上游修复版本。当前只对可信仓库 glob 使用 lint；这不是生产请求路径，也不表示风险已被修复。不得将不可信输入送入该 glob 工具链；持续跟踪上游替换/补丁。
- git diff --check 与环境文件忽略检查：通过。

没有运行真实数据库双用户 E2E、迁移、负载测试、真实/沙箱支付、Railway 验收或线上部署。代码未新增订单/后台管理接口，无法测试尚不存在的业务功能。

## 剩余上线门槛

当前结论仍为 Conditional Go：可继续开发，不应上线收费。
Stripe 关闭是本期安全基线；不要仅打开开关就开展收费。首次绑定需要持久本地订单与受信通知，当前不再依赖浏览器回跳建立绑定，因此新订阅暂不具备完整入账能力。未知/不匹配订阅通知返回可重试错误，需运维处理，不应无限忽略。
通知重查缓解回放，但尚无事件持久化、并发串行化、账本、对账、退款或严格乱序事务控制。需要这些能力后才能启用付款。
P1 尚包括分布式登录/注册限流、邮件所有权验证、邀请令牌/过期、成员关系唯一约束及迁移、多团队选择一致性、注册唯一性竞争的受控错误、完整双用户数据库回归。密码修改使当前会话也失效，用户需重新登录。
仅检查了当前 tracked 环境文件与可见日志；没有声称完成整个 Git 历史密钥扫描或线上密钥轮换。

## Vibe Pay 后续架构建议

在实际官方协议核实后实现支付适配层，不推测 SDK/API 字段。服务端商品配置决定金额、币种与额度；本地 payment_orders 记录用户/团队、价格快照、唯一订单号、渠道交易号与退款状态。
服务端创建订单后调用官方网页支付；通知按官方协议验签，核对订单、金额、币种、收款主体及最终状态。payment_events 以官方唯一标识去重，在数据库事务中更新订单并写 credit_ledger，使用唯一幂等键发额度。回跳仅展示结果，前端查本地归属订单。
重复、乱序、延迟通知与查单重试应收敛到同一状态机；账本支持发放/预占/消耗/释放/退款冲正，额度扣减需原子化。增加超时订单、失败队列、对账和告警；所有密钥仅在服务端环境管理，不写日志。
上线前按官方允许的测试环境验证：伪造通知、错误金额/收款方、跨团队读写、重复发放、并发消费、关闭回跳页面、退款与故障恢复。本期未安装支付宝工具、运行时 SDK 或进行任何交易。

## 合并阻断修复：独立密码工具与开发 seed

本轮仅处理最终审查中的 seed 导入回归及 README 不一致。`lib/auth/passwords.ts` 独立于 Next.js；会话模块保留 server-only，并重新导出原函数，bcrypt cost 10 与既有校验兼容性不变。seed runner 不导入应用数据库单例或会话模块；先检查非生产显式授权和自定义凭据，再建立连接，结束后关闭连接。利用既有 email 唯一约束和事务处理并发重复执行，已有账号不更新、不重置密码、不新增团队关系；新建失败整笔回滚。

按顺序执行 frozen-lockfile 安装（本地缓存/offline）、typecheck、lint、test、build：全部通过。7 个测试文件、47 项通过，原有 38 项安全回归保留。
新增 4 项 CLI 回归启动真实独立 Node/tsx 进程，不继承 Vitest mock，覆盖依赖导入、bcrypt 旧哈希/新哈希兼容、未授权/生产环境/无效凭据拒绝及脱敏错误。
新增 5 项真实 PostgreSQL 回归在本轮新建的独立 postgres:16.4-alpine 容器执行：临时内存数据目录，仅映射回环随机端口；显式指定全新 `dealpilot_seed_test_p0` 数据库，并应用现有 SQL 迁移。验证未授权 CLI 不写库、授权 CLI 创建、重复/并发幂等、已有非种子账号不变、成员插入失败时事务回滚。仅合成账号，不读取应用数据库地址，未连接生产数据库；容器测试后已删除。
默认测试运行未设置 SEED_TEST_DATABASE_URL 时，上述 5 项数据库测试明确跳过；不将默认 CI/mock 视为真实数据库验收。此次真实验证仅针对 seed，不替代完整双用户授权、业务迁移、支付或负载测试。braces、ESLint 维护期及支付等此前遗留风险不变。
README 已删除公开默认账号和正式收费引导，明确迁移与可选 seed、授权变量、自定义凭据、重复执行行为及安全边界。LICENSE 和版权声明保持不变。此修复满足再次审查的提交条件，不等于合并、部署或上线收费批准。
