# 工作流：命令、工具链陷阱与测试规范

## 命令

`pnpm typecheck` / `lint` / `test` / `build`；提交前必跑。只认这些已定义脚本，不得裸跑 bin（`tsdown --config`、`eslint` 的 TS 配置读取都挂在脚本上，裸跑漏开关就与提交前验证不等价）。

## 工具链陷阱

- pnpm 脚本必须在 shell 里直接跑，不得经 Node 子进程包裹（沙箱下 `child_process` 启 pnpm 报 `spawn EPERM`）。
- `pnpm test` 走专用单对象配置 `tsdown.test.config.ts`；禁止指回数组主配置（CLI 参数合并进每一项，浏览器半的工厂 banner 会污染测试产物）。
- TS 7 与 ESLint 并存靠 npm 别名：TS 7 原生版无 JS API、typescript-eslint 见之即抛错。故 `typescript` = `npm:@typescript/typescript6@^6.0.2`（bin 为 `tsc6`），TS 7 挂别名 `@typescript/native`。
- `pnpm lint` 走 `eslint.config.ts`（ESLint 经 devDep `jiti` 读 TS 配置）：只排除 `lib/`，其余交给 ESLint 默认忽略。硬约束五条——禁相对导入、`consistent-type-imports`、三条跨半纯度自定义规则（细则在 `AGENTS.md`「导入与打包」）。根目录两个 tsdown 配置与本配置自身都在 lint 范围内。
- 宿主包本地依赖全走 devDeps 且须与宿主 latest 同号；一律 `pnpm add` 变更（`-E` 保精确、`--save-peer` 写 peer）；升级只能写具体版本号（各子包 `latest` tag 陈旧）。
- 钩子脚本读 stdin 只能异步：Windows 上 stdin 是管道时 `fs.readFileSync(0)` 抛 `EOF`（nodejs/node#35997），git 正是用管道喂 pre-push 清单，故 `scripts/check-tag.mjs` 走 `process.stdin` 异步迭代。

## Git 钩子

由 `@pyyupsk/nit` 管理（配置在 `package.json` 的 `nit.hooks`，`.git/hooks/` 脚本由 `nit install` 生成）：

- `pre-commit` → `scripts/check-version.mjs`：README 钉死的 tarball 链接须与 `package.json` 的 version 同号。
- `pre-push` → `scripts/check-tag.mjs`：一次只允许推一个标签，且须为 v + 语义化版本并与 version 同号；无标签静默通过。

发布链（`.github/workflows/release.yml`）不重复这两道校验，只跑 install / lint / typecheck / test / pack，故钩子是这两条纪律的唯一闸门。

## 测试规范

`test/` 只收不依赖 DSH 运行时的纯函数与零 ctx 编排：配置解析与迁移、目录拍平与缓存条目校验、id 匹配与档位转换、compat 计划、`planResetModels` / `planRestore`、probe 四层（`planProbes` / `groupProbesByProvider` / `logicalProviderOf` / `classifyFailure` / `reportProvider` / `summarizeProviders` / `planEffortApply` / `declaredEffortsOf`）、三个执行器（验证 / 探测档位 / 能力探测）带桩全链路（进度帧序列、`skipped`、`done ≤ total` 不变量、早停不发终帧、中止不入账也不短路、未开跑的组不进汇报、探测预声明→收敛写回与终帧统计）、`probeOnce` 超时兜底（`timeoutMs` / `graceMs` 可选参数传小值毫秒级验证）、守卫、`rpc-route` 纯信封 + node:http 桩、`rpc` 进度流（标准 `Request`/`Response` 驱动）、`refresh` 卸载清理（替换全局 `fetch` 桩）、`fix` / `probeAndFill` 编排 + `test/ctx.ts` 常驻内存 settings 桩（`noPlugin` 模拟自有段未登记、`mutateCalls` 逐次记守卫状态）、浏览器半纯映射/文案层（含 `isUnfilled`、至多七档展开与渠道级记录行）。浏览器组件与真实 fs / 网络不进 `test/`（验证 / 探测档位执行器只依赖注入的 `llm.stream`，能力探测试注入的 `fetch`）。

模块级单例的复位纪律：`indexedCache` 与 `configSource` 每用例前调 `resetModules()`；`refresh.ts` 的 `refreshing` / `retryTimer` 用例收尾调 `cancelRefreshRetry()`；`probeOnce` 超时兜底用例挂了 `process.on('unhandledRejection')`，用例收尾必须 `off` 还原。
