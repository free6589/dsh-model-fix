# 宿主 API 与类型契约（改前必查）

本文是**本插件实际在用的宿主面**的单一事实源：服务与事件调用、宿主类型导入面、依赖宿主字面量的键/码、宿主运行时行为假设。宿主有而本插件没用的 API 一律不写。

- **更新纪律**（本体在 `AGENTS.md`「宿主契约文档纪律」）：改动服务/事件签名假设、宿主类型导入面、宿主字面量键码、宿主行为假设、版本基线任一内容，同一轮同步更新本文；升宿主大版本另须逐条复核「已知漂移与观察项」与「升级宿主时的检查清单」。
- 宿主侧引用一律写 `DSH/<宿主仓库内路径>`（虚拟锚点，本仓不检出宿主源码；行号无稳定含义，锁的是「契约来自宿主哪个文件」）。签名以本仓 devDep 声明的 `0.1.7-rc.2` 为准；查到的新版差异记入「已知漂移与观察项」，不顺手改代码。
- 本文写「是什么」，`decisions.md` 写「为什么」，条目同纪律分组。

## 宿主服务与运行时面

### settings：配置读写

- `ctx.settings`（`DSH/packages/settings/settings/src/index.ts`，类 `SettingsForms`）；`settings` 在 `src/index.ts` 的 `inject`，非可选。
- `describe(options?: { redactSecrets? }): SettingsDescriptor[]`，字段 `ns / autoGenerate / schema / value / revision / base? / user? / applies:'live' / secrets?`，无 `namespace` 等别名。本插件只用 `{ ns, user, revision }`，刻意不传 `redactSecrets`（要明文 user 层比对）。读取一律经 `src/section.ts`（`descriptorOf` / `sectionOf` / `ownSection`），读不到返回 `undefined` 不抛。
- `mutate(ns, ops: readonly SettingsPathOp[], expectedRevision?)` 返回 **void**（变更数自己数）。`SettingsPathOp = { op:'set'; path; value } | { op:'unset'; path }`；客户端线面 `SettingsPathOpView`（`DSH/packages/settings/settings/src/types.ts`）与它类型不兼容，`src/client/scope.ts` 转发时逐字段浅拷贝。
- revision 不符时 `mutate` 抛 `SettingsConflictError`（`code='SETTINGS_CONFLICT'`，带 `expected`/`actual`）；重试判定收口在 `src/shared/errors.ts` 的 `isSettingsConflict`（Node 半各写回端点与浏览器半记忆写入共用）。宿主换码或改返回失败值会让重试退化为一次失败。
- 写入语义（`applyPathOp`）：
  - 根必须纯对象（`isPlainObject` 排除数组）⇒ 自有配置只能用 `version-N → 快照` 映射，不能用列表。
  - `unset` 只删本键、不折叠空父对象 ⇒ 删空壳必须整段 `unset`（`src/compat.ts` 整段 unset、`src/empty.ts` 空壳判据都建立在这条上）。
  - 只允许写 volatile 字段（`isVolatilePath`，`DSH/packages/settings/settings/src/schema.ts`）。本插件两处写入都在 volatile 子树：自有段 `Config = z.any().volatile()`（根 volatile ⇒ 整段可写）；`llm-pi-ai` 段 `providers: z.dict(profile).default({}).volatile()`（`DSH/packages/llm/llm-pi-ai/src/config.ts`）⇒ `providers.<id>.models` 与 `compat` 可写。
  - `fix` 按 provider 整段 `set` 覆盖 `models`、不写数组下标中间段，是两侧读法（下标支持与否）的安全子集。
- **能力探测的读取假设**（`src/probe-caps.ts`，wire 级裸 HTTP 探测）：从 `llm-pi-ai` user 层 `providers.<id>` 读 `api`（仅 `openai-completions` 在 v1 探测范围）、`baseURL`（直接拼 `/chat/completions`，不猜 `/v1`）、`apiKey`（明文）与 `apiKeyEnv`（引用名，经 `ctx.credentials.resolve` 取明文）；解析不到即不发请求、记 `no-credential`。`api` 未声明按「方言未知」处理（宿主对缺省 `api` 会复用已装 provider 自己的方言，`dsh-llm-pi-ai` 的 `spec.api === undefined` 分支），同样不发请求。模型 `input` 字段的合法取值域是 `MODALITIES = ['text','image']`（`dsh-llm-pi-ai` 的 `modelFields`），故写回 `['text','image']` 不覆盖任何其它模态。

### settings：变更事件与装载时序

- `settings/document-updated` 声明在 `DSH/packages/settings/settings/src/types.ts`，payload 两个位置参数 `(ns: SettingsNamespace, revision)`，`ns` 是品牌字符串；本插件只取第一参分流。该事件只在 RAW 段变更时发（宿主自动生成段不发）——「守卫期间短路整条事件链」的必要前提。
- 自有 NS 登记晚于 `apply`：宿主无命名空间注册事件、无 ready promise（全仓检索无此面），NS 由 Loader 异步登记 ⇒ `src/migrate.ts` 有界轮询（50ms / 封顶 2s）等 `describe()` 出现 `PLUGIN_NS`，读不到早退。迁移必须先于填充（旧格式会被按新 schema 误解析）。
- 宿主事件可能在自己 HMR 事务的 AsyncLocalStorage 上下文里同步派发 ⇒ 全部 settings 写回收口在 `src/host.ts` 的 `queueTask`（收口在写 choke point，新增路径天然安全）。

### llm：验证请求

- `ctx.llm`（`DSH/packages/llm/llm/src/index.ts`，`LlmRuntime`），`inject` 非可选但只做 type-only 引用。
- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`，实跑走 `ctx.waterfall(this, 'llm/stream', …)`。适配器抛错被宿主归一化成 finish 帧（`signal.aborted || code==='ABORTED'` → `aborted`，否则 `error`）——**本插件拿到的只有 finish 帧，不接异常**。
- `GenerateOptions`（`DSH/packages/llm/llm/src/types.ts`）字段名逐字：`provider / model / reasoningEffort? / messages / system? / tools? / toolHistory? / temperature? / maxTokens? / stop? / signal? / sessionId? / purpose?`。`src/probe-engine.ts` 只用 `provider / model / reasoningEffort / messages / signal`（`AbortSignal.any` 组合外部与自建超时）。
- `StreamChunk` 判别联合：`block-start{ index, blockType }` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish{ reason, replayState? }`；索引字段名是 `index` 不是 `blockIndex`。`src/probe-engine.ts` 只认 `block-start` 判受理。
- `FinishReasonMap`（merge-extensible，按 `kind` 分派须留 fallback）：`stop / tool-calls / max-tokens / aborted(带 failure) / error(带 failure)`。`failure` 只在后两支存在 ⇒ 读 `reason.failure` 前必须判 `kind`。`aborted` 不能当失败：外部中止与自建超时都走它，故按 `signal.aborted` 区分并单列 `'aborted'`。
- `LlmFailure`：`message / code: string（自由串）/ status? / providerRetryAfterMs? / requestId? / offloadImages?` ⇒ 分类只能按 `code`；`status` 在 pi-ai 路径恒缺（上游压平成 `{message, code}`），**不可用 status 缺失推断不可达**。
- 失败码来源（`src/probe-verdict.ts` 分类依据）：`DSH/packages/llm/llm/src/error.ts` 核心常量 `QUOTA` / `ACCOUNT_QUOTA` / `INVALID_CREDENTIAL` / `EMPTY_RESPONSE` / `CONTEXT_WINDOW_EXCEEDED`；`src/index.ts` 抛 `UNSUPPORTED_REASONING_EFFORT`、`NO_ADAPTER`；`src/retry-policy.ts` 默认可重试集含 `RATE_LIMIT` / `TIMEOUT` / `TRANSPORT`。
- 本插件走 `llm-pi-ai` 路由，错误按文案正则归一化（`classifyPiAiError`：`AUTH / QUOTA / RATE_LIMIT / INVALID_REQUEST / SERVER / TIMEOUT / TRANSPORT / PI_AI_ERROR`；另有 `STREAM_CLOSED`、`UNSUPPORTED_REASONING_EFFORT`、`MISSING_CREDENTIAL`）。pi-ai 上游把 Error 压进 `error.message`、无 `status` 与 `cause` —— 这是「只按 code 分类、不比对文案」的宿主依据。`INVALID_CREDENTIAL`（给了但不能用）与 `AUTH`（上游鉴权失败）是两码，本仓凭据无效只认前者与 `MISSING_CREDENTIAL`。
- `ReasoningEffortId`（`DSH/packages/llm/llm/src/brand.ts`）：品牌类型 + 运行期工厂（不校验）。本仓只 type-only 引用、`as ReasoningEffortId` 断言，不引运行期构造器。
- 档位 id 取值由适配器自定；本仓档位名来自 models.dev 目录（`src/lookup.ts`），不是宿主枚举。不传 `reasoningEffort` 时宿主按 `defaultEffort` 物化——「不带档位 = 不发该字段」。
- **宿主按模型公告的档位本地校验**（`resolveCallWithInfo`，`DSH/packages/llm/llm/src/index.ts`）：`info.reasoning === undefined` 带档即抛 `UNSUPPORTED_REASONING_EFFORT`；档位不在 `reasoning.efforts` 也抛。⇒ 未声明的档位不出网，「探测档位」必须先预声明（见 decisions.md「探测档位」）。

### llm：模型清单面（记忆剪枝的判据）

- 三方法（`DSH/packages/llm/llm/src/index.ts`）：`listProviders()` 同步、当前全部活路由；`listModels(provider)` 直穿 adapter 无缓存，provider 未注册抛 `NO_ADAPTER`（剪枝须当「读不到」）；`listConfigurableProviders()` 同步声明序（「隐藏官方API」读它取 settingsNs / settingsPath 定位凭据段；目录条目是声明而非活路由，未声明无从判定、照常显示）。
- `listModels` 是原型方法，可用实例自有属性遮蔽（`llm.listModels = wrapped` 全部消费者生效）——「隐藏官方API」即据此实现。安装带 `Symbol.for` 标记幂等。宿主若把它改成箭头函数类字段，遮蔽失效（升宿主须复核定义位置）。
- UI 模型目录唯一生成链路（`DSH/packages/api/session-controller/src/types/catalog.ts`）：`buildModelCatalog` 逐 provider `listModels` + `resolveModelInfo`，末了 `.filter(group => group.models.length > 0)` ⇒ 返回空清单即组从目录消失。
- 目录刷新由浏览器侧宿主服务负责（`DSH/packages/client/ui-model-selection/src/client/service.ts`）：`llm/adapters-updated`、`settings/document-updated`、`credentials/record-updated`、`credentials/reference-updated` 任一到达即 `catalog.refresh()` ⇒ 插件改开关 / 配密钥后 UI 自动重取，零事件接线。
- `llm/adapters-updated`（契约 `DSH/packages/llm/llm/src/typert.host.js`）：provider 拓扑变化（adapter 注册/注销/替换、configurable-provider 目录增减）在每个 commit 点（含 dispose）触发，payload-free ⇒ 到达时拓扑已是新的。模型级增删不触发它（只改配置不重新 commit 路由）⇒ 记忆剪枝除挂它外还挂 `settings/document-updated(llm-pi-ai)`。
- `buildModelCatalog` 刻意不用：逐模型 `resolveModelInfo` 可能打网络，且默认参数求值执行未 inject 的 `ctx.agentDefaultModel`。

### hmr：`executing`（私有面）

- `ctx.get('hmr')` 服务类（`DSH/packages/boot/hmr/src/index.ts`）的 **private** 字段 `executing = new AsyncLocalStorage<boolean>()` 标记「当前异步上下文正在跑一次 HMR 事务」。
- `src/host.ts` 经模块级 `_hmrExecuting`（`src/index.ts` 子 fiber 注入）用：是 `AsyncLocalStorage` 则 `als.exit(task)` 否则裸 `task()`；注入落地前有界等待（2s 封顶、只等一次，超时降级）。**私有字段非公共面，宿主改名即静默降级**；升宿主必须复核该字段名。

### connection：RPC channel 与验证流

- `ctx.get('connection')`（`DSH/packages/client/connection/src/rpc-host.ts`，`HostConnectionService`）。connection 的 `inject` 只有 `['credentials']`、**不含 `webServer`**（webServer 是 apply 内二次注入）⇒ 本插件必须同时 inject `['connection','webServer']`（`src/rpc.ts`），不能走宿主 `connection.rpc.handle`。
- `HostConnectionHandle`（`DSH/packages/client/connection/src/rpc.ts`）：`rpc / fetch / operator / createSharedFetchHandler / requestRejection / admit / authorizeIndex / authenticatedUrl`。本插件只读 `requestRejection` 与 `fetch`。
- `requestRejection` 返回 `401 | 403 | undefined`（先 Host/Origin 围栏再浏览器认证）；宿主拒绝时响应体逐字 `unauthorized` / `forbidden`，`src/rpc-route.ts` 围栏段照抄。
- `connection.fetch.register(route)`：`ConnectionFetchRoute{ path, methods:'GET'|'HEAD'|'POST', requestBody:'buffered'|'streaming', fetch }`，`path` 须 `/api` 下绝对路径，重复注册抛；返回**异步 disposer**。fetch 回调收到标准 WHATWG `Request`（`DSH/packages/client/connection/src/http-bridge.ts`）；**`request.signal` 在客户端断开时 abort**（挂在 `res` 的 `close` 而非 `req`——Node 16+ 的 `req.close` 请求体读完即触发，会把刚开的流掐掉）。
- `buffered` 受配置 JSON 体上限约束；共享 `/api` 分发顺序 exact → interceptor → 404。
- RPC 信封（本插件在 `src/rpc-route.ts` 手搓，类型面全在 `DSH/packages/client/connection/src/rpc.ts`）：`ClientRequest{ type:'client-request'; rpcId; method; payload }`、`ServerResponse{ type:'server-response'; rpcId; result }`；`RpcId = Branded`（本仓不引运行期构造器，只用 `INVALID_RPC_ID='invalid-request'` 哨兵）；`ConnectionRpcResult<T> = { ok:true; value } | { ok:false; error: { code; message; details: object（必填） } }`；信封层错误码 `gateway/bad-request`（method/端点不匹配、信封非法 `invalid client-request message`），传输层失败 `gateway/internal`；channel 约束 `CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/` 且不得是 `/api`，endpoint 段 `ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/`（本仓逐字复制）。
- 浏览器侧 `rpc.call(channel, endpoint, payload, signal?)` 把 channel+endpoint 拼成**文档相对**路径 POST；非 2xx 抛 `transport failure`、rpcId 不符抛 `rpcId mismatch`（传输失败不是 result，卡片把 reject 与 `ok:false` 同路处理）。`signal` 只作用于这一次 fetch（宿主实现没有任何其它计时器）：中止即 reject 但 handler 照跑完（本仓 channel 路由的 signal 是占位），故写回端点按 `WRITEBACK_MS` 只解卡片占用态。

### webServer：prefix 路由

- `ctx.get('webServer')`（`DSH/packages/host/webserver/src/index.ts`，`WebServer`）。
- `register(route: WebRoute)` 同步 disposer；`WebRoute{ kind:'exact'|'prefix'; path: 绝对路径无尾斜杠; handler }`；重复 `(kind,path)` 抛。路由查找：先 exact 表、再 prefix 表取最长前缀（不要求注册在 `/api` 下）。handler 拥有完整响应生命周期（可持有响应不结束，如 SSE）。
- gzip 中间件显式跳过 `text/event-stream`（`createGzipMiddleware`），另 `content-range` 存在也跳过；压缩默认关闭。⇒ SSE 不被缓冲，但不能靠压缩规避背压。

### cordis 基础面

- `ctx.effect(execute, label?)`（`DSH/vendor/cordis/src/fiber.ts`）：execute 立即执行，disposer 调用时或 fiber 卸载时（先到者）逆序执行，重复调用 no-op，已卸载抛 `INACTIVE_EFFECT`；同步异步版均返回可 await 的 disposer。所有「注册必须挂 effect」纪律基于这一条。
- `ctx.inject(deps, callback)`（`DSH/vendor/cordis/src/registry.ts`）：等价 `this.plugin({ inject, apply: callback })`，返回 `Fiber & PromiseLike`。**未满足的服务保持 PENDING（无超时）** ⇒ 卡片等 `configForms` 必须能长期停在「加载中 / 不可用」而非抛错。
- `ctx.get(name, strict = true)`（`DSH/vendor/cordis/src/reflect.ts`）：服务未提供返回 `undefined` 不抛。
- `export const inject / name / Config` 是 cordis 插件声明面；`Config` 由宿主 settings 读取（下条）。

### Config 装载面：`z.any().volatile()`

- 宿主把插件 `Config` schema 交给 settings 派生表单与可编辑投影（`DSH/packages/settings/settings/src/schema.ts` 的 `volatileForm` / `projectForm`，后者 `schema.type === 'object'` 时只投影声明字段、未声明字段直接丢）。
- ⇒ `Config` 必须 `z.any().volatile()`：根 volatile 使整段原样通过投影；若用 dict（`type === 'object'`）未声明键会被抹成 `{}`。非 volatile 字段写入时被拒——这也是自有段可被 `mutate` 写回的前提。

### configForms：配置表单（浏览器半）

- `ctx.configForms`（`DSH/packages/client/ui-settings/src/client/config-form.ts`，`ConfigForms`）。
- `get<T>(entryId)` 只有 entryId 一个形参；查无 NS 不抛错（`status='unavailable'`，与 loading 可区分——本仓卡片依赖此差异）。decode 只存在于包内 `ConfigFormSpec`，不对外 ⇒ 本仓解码全在 `src/client/scope.ts` 的 `makeScope`。
- `ConfigFormSnapshot<T>`（`DSH/packages/client/ui-settings/src/client/config-form-types.ts`）：`status:'loading'|'ready'|'unavailable' / value / base / user / revision / writable`（devDep 版本另有 `mode`，`0.2.1-alpha.3` 已移除，见漂移项）。
- 写方法 `mutate(ops, expectedRevision?) / set(field, value) / unset(field)` 返回 **boolean**：被拒或跳过返回 false、**传输失败 reject**（JSDoc 原文：`true for Host acceptance, false for refusal or skipped writes…Transport failures reject.`）。
- 写入实际路径 `this.ctx.remote.settings.mutate(ns, ops, revision)`（revision 取 `expectedRevision ?? pendingRevision ?? 快照 revision`）；memory 模式直接 `resolve(false)`。持久化模式由连接性质决定：`isLoopback ? 'host' : 'memory'`（`DSH/packages/client/ui-settings/src/client/index.ts`）⇒ 非 loopback 下本插件所有保存返回 false（本仓以 `writable === true` 才允许保存）。
- 另有 `whileServed` / `describe()`——本仓未用，Node 半等价手段是 `src/migrate.ts` 的有界轮询。

### cordis.patch.yml 的 id ↔ 命名空间

- 命名空间 = patch 条目 id：`DSH/vendor/loader/src/config/entry.ts` 的 `EntryOptions{ id; … }` → `import(name)` → `registry.plugin(plugin, config, …)`；settings 侧只读 `entry.fiber.config`。
- 登记门槛：fiber 未 ACTIVE 或 schema 为 undefined 的 entry 被跳过 ⇒ 命名空间晚于插件 `apply`，这是 `src/migrate.ts` 必须有界轮询的原因。
- 无登记完成事件、无 ready promise：`describe()` 用 `queueMicrotask` 调度，`app-boot/config-reload` 时 `invalidate()`；客户端侧 `settings/document-updated` 触发 `mirror.load()`（fire-and-forget）。

### cordis：config 的实时引用

- `apply(ctx, config)` 第二参是 `Volatile<T>` 引用不是裸对象（`DSH/vendor/schemastery/src/index.ts`：volatile schema 产出 `createVolatile(value)`；`DSH/vendor/cosmokit/src/volatile.ts` 返回**冻结**的 `{ get: () => current }`）⇒ 必须每次 `config.get()`，不能缓存解引用（`src/index.ts` 把 getter 交给 `setConfigSource`）。
- 引用身份稳定、就地更新（`_commitVolatile` 逐个 `updateVolatile` 并 emit `loader/volatile-update`，仅发给 owning fiber）⇒ volatile 变更**不重启 fiber**。
- volatile 位置约束：根 volatile 受支持，`.volatile()` 不能叠加；volatile 字段要求固定对象路径（无外裹 volatile）。

### slots：五席注册

- `ctx.slots`（`DSH/packages/client/ui-renderer/src/client/registry.ts`，`SlotRegistry`）。
- `register` 是原型赋值、内部包 `ctx.effect` ⇒ **register 必须能挂 effect 生命周期**（实际都经 effect）；向未声明 slot 注册直接抛 `slot "…" is not declared`。
- `inject(key, callback)`：回调返回清理函数（可生成器做原子装卸），内部包 effect。
- 带 inject 的 register 重载（`DSH/packages/client/ui-slots/src/index.ts`）：`BaseOptions{ name; children?; store?; locale?; registrant? }`；工厂参数给严格 session 席位 `sessionId`、session-maybe 席位 `sessionId | undefined`，声明 store 时追加 `actions`；**没有 binding 对象参数**。
- props 合成：`InjectFace<I>` 里 `hooks` 被渲染器绑成 `use<Name>` 选择器 hook（组件看不到裸 observable）；`PropsStore<H> = { useStore; actions }`；**只有 `register({ locale: NS })` 声明了命名空间，props 上才出现 `t`**。
- 条目字段（`KindOptions`）：list `{ id; order?; label?; priority? }`、keyed `{ key; priority? }`、chain `{ select; priority? }`；`SlotLabel = string | (() => string)`（每次渲染求值）。
- 本插件五席：

| slot key | SlotMap 定义 | kind | 条目字段 |
| --- | --- | --- | --- |
| `settings.models.footer` | `DSH/packages/client/ui-settings-models/src/client/slot-contract.ts`，渲染点该包 `src/client/ModelsSection.tsx` | list | `id` / `order?` / `label?` / `priority?` |
| `plugins.bundle.config` | `DSH/packages/client/ui-plugin-manager/src/client/slot-contract.ts`（owner props `PluginConfigViewProps`） | keyed | `key`（包名）/ `priority?` |
| `plugins.row.config` | 同上（JSDoc：keyed by `<package>#<row id>`） | keyed | 同上 |
| `settings.plugins.tab` | `DSH/packages/client/ui-settings/src/client/contract/slots.ts` | list | `id` / `order?` / `label?` / `priority?` |
| `conversation.input.left` | `DSH/packages/client/ui-conversation/src/client/contract/slots.ts`（无 owner props），渲染点该包 `src/client/skeleton/InputBar.tsx` | list | `id` / `order?` / `label?` / `priority?` |

- keyed 拼接（`DSH/packages/client/ui-plugin-manager/src/client/config-ledger.ts`）：`rowConfigKey(bundle, rowId) = \`${bundle}#${rowId}\`` ⇒ 本仓 `${PLUGIN_NAME}#${PLUGIN_NS}` 逐字成立。

### locale：词典与 `t`

- `ctx.locale`（`DSH/packages/client/locale/src/client/index.ts`，`LocaleRuntime`）：事件 `'locale/change'`，**字典注册不发该事件**。
- `register(ns, dicts)` 返回幂等 disposer；**重复注册抛错** `locale namespace "…" already has locale "…"` ⇒ 一律经 `ctx.effect` 挂。
- `bind(ns)` 每 ns 缓存同一函数引用（身份稳定，可放 label thunk 依赖数组）。
- 本仓私接面（非公开类型面，宿主改名即静默失效）：`ctx.locale` 实例上的 `dicts: Map<ns, Map<localeLower, dict>>`、`publish(active, localeChanged, locales?)`、`snapshot: { active, locales }`——因 `register` 禁止同 ns+locale 重复注册，改宿主既有词条值只能 mutate 已注册对象再手动 `publish`。`localeKey()` 是 `toLowerCase`，第二层键是小写 `'zh'`。`src/client/locale-patch.ts` 即走这条路改宿主 `model` NS 的 `effort.providerDefault`（宿主 `ModelSelect.tsx` 自合成的 Default 伪菜单项取该词条，不经数据层，Node 半遮蔽碰不到）。本仓以本地 `LocaleRuntimeHack` 接口 + `as unknown as` 转换。
- 类型面（`DSH/packages/client/ui-slots/src/index.ts`）：`LocaleNamespaceMap` 声明合并点（`src/client/locale-keys.ts` 扩展）、`Translate<K> = (key, params?) => string`；locale face 在 `DSH/packages/client/ui-slots/src/renderer.ts`。调用形态就是 `t(key, params?)`。
- 官方范本（`DSH/packages/client/ui-settings-plugin-inventory/src/client/index.ts`）：`label: () => t('…')` + `locale: NS` + `ctx.effect(() => ctx.locale.register(NS, { zh, en }))`。

### sessions / modelDirectories：记忆的存取（浏览器半）

- `ctx.sessions`（`DSH/packages/api/session-controller/src/client/contract/sessions.ts`，`ISessions`）：`list / retainInfo(id) / scope(id) / binding(id)`——**未知/未保留会话 `binding` 返回 undefined 不抛错**；`SessionListState{ ids; byId; phase; projectionsBySession }`。
- 投影（`ProjectionsFace.faceOf(key)`）：face 身份稳定、永不为 undefined；`modelSelection` 键由 `DSH/packages/api/session-controller/src/model-selection-projection.ts` 安装，schema 为 provider / model / reasoningEffort，**wire 视图 `next = state.pending ?? state.lastUsed`**；`ModelSelectionProjectionState{ lastUsed; pending }`。
- `ctx.modelDirectories`（`DSH/packages/client/ui-model-selection/src/client/service.ts`，`ModelDirectoryResolver`）：`directoryFor(sessionId)` **对未知 id 显式抛错**（与 sessions.binding 相反，记忆链路 try/catch 依赖两者各自口径）。
- `ModelDirectory`（`DSH/packages/client/ui-model-selection/src/client/directory.ts`）：`store / load() / select(selection)（失败写 `status='error'` 并返回原始失败，不抛）/ assertAvailable`（抛 `model selection is unavailable for addressed subagent sessions`）。
- `ModelProviderGroup{ id; name; models: ModelCatalogModel[] }`（`DSH/packages/api/session-controller/src/types.ts`）；目录只用于写入/恢复侧（选哪档、是否公告），失效清理走 `ctx.llm` 清单。
- **`ObservableSnapshot` 不推首值**（`DSH/packages/client/store/src/contract.ts`，zustand `subscribe` 无 `fireImmediately`）⇒ 本仓所有订阅后必须手动补跑一次（含 `ctx.locale.subscribe`、`sessions.retainInfo.subscribe`）。

### agent/request：子智能体推理级别注入面

- 瀑布（`DSH/packages/core/agent/src/runtime-types.ts`）：`'agent/request'(this: Scoped<Agent>, payload: { agent; turn; step; signal }, next)`；派发器把 `payload.agent` 覆盖为运行期 Agent。
- 种子配置被 `deepFreeze(structuredClone(...))`（`DSH/packages/core/agent-loop/src/agent.ts` 的 `prepareRequest`）⇒ **中间件只能返回新对象**；`next()` 返回的是本次请求实际生效的 `LlmCallConfig`。
- 本仓 `{ prepend: true }` 钉最外层：`handler` 内 `await next()` 拿种子配置（未被更内层钩子改写）再决定覆盖。
- 全局覆盖靠 scope 过滤器（`DSH/packages/core/scope/src/index.ts`：`scopeOf(ctx) === undefined` 全局收事件）⇒ 插件根 ctx 单个监听覆盖全部 Agent，不需 `agent/created` 逐 Agent 挂。
- `ctx.on` 的 `prepend` 选项（`DSH/vendor/cordis/lib/types/events.d.ts`）：钩子表全局一张按注册先后排（outermost-first）⇒ HMR 重载后仍钉最外层。
- 官方注入范本（`DSH/packages/core/agent/src/model-selection.ts`）：先 `await next()` 再解构拼新对象；本仓 `src/subagent.ts` 同形状，只把「改成什么」换成跟随规则（见 decisions.md「子智能体」）。
- `agents` 服务（`DSH/packages/core/agent/src/index.ts`）：`get(id)` 返回**富面 Agent**（含 `options / session / ctx`）——`@deepseek-ai/dsh-agent/types` 子路径只导出精简 `{ id }`，必须包根导入；宿主取法见 `DSH/packages/subagent/subagent/src/index.ts`。**本仓不引该包**（包根类型顶掉浏览器半 `ctx.sessions`，见导入清单末条），在 `src/subagent.ts` 复制只读的 `session.header` / `requestHeader()` / `options`，经子 fiber 注入。
- 会话头与请求头（`DSH/packages/core/session/src/{types,index}.ts`）：`SessionHeader{ parentSession?; origin?: 'subagent' }`；`requestHeader(): EpochHeader{ config; adapterDefaults?; tools?; system? } | undefined`——**只反映父已发过的请求**（请求真正被准备时才写）。`adapterDefaults?.reasoningEffort === true` 表示档位是适配器默认值、本仓视为「未选」。本仓先取父会话待生效选择，取不到才回落请求头。
- 父会话待生效选择：服务名 `sessionProjections`（`DSH/packages/session/session-projection/src/index.ts`），`stateOf(session, 'modelSelection')` 未注册键返回 undefined。`pending` 即「父下一次请求该用的路由」：UI 每次选择落 `model/selection` 事件置位，匹配请求头落库后清空；宿主自己的 `selectionFor` 也按「pending 优先、无 picked 回落请求头」取。本仓不引该包类型（同 `dsh-agent` 理由），只在 `src/subagent.ts` 本地声明返回面。
- 「允许 Agent 为子智能体选择模型」（`DSH/packages/subagent/tool-subagent/src/model-selection-settings.ts` 子路径，服务名 `subagentModelSelection`）：`current()` 在 `enabled && allowedModels.length === 0` 时抛错 ⇒ 本仓 try/catch 当关闭。本仓不引该子路径类型，本地声明 `current(): { enabled: boolean }`。三服务（`agents` / `sessionProjections` / `subagentModelSelection`）全就绪才注册监听。
- 死路备忘：改宿主 `subagentModelSelection` schema（strict 对象）；拦截 `llm/stream` 瀑布（绕过授权校验且与 session log 请求头失步）；`Config.agentOptions`（第三方拿不到别的 fiber 的 config 引用）；给 fork 子智能体开路由选择（宿主刻意不给：路由变更丢失继承前缀的 KV-Cache 复用）。

### 档位自调：tools / systemPrompt / sessionController / resolveModelInfo

四服务（连同投影）由 `installSelfTune` 经 `ctx.inject` 子 fiber 统一声明（全就绪才执行，缺席 PENDING 静默）；下列只记服务契约。

- **`tools`**（`DSH/packages/core/tools/src/index.ts`；不在 devDep 清单，契约复制在 `src/self-tune.ts`）：`register(definition)` 返回同步 disposer，同名重复注册抛错。`definition`：`name / description（必填）/ parameters（JSON Schema 子集）/ output{ schema; render } / execute(args: unknown, exec)`——**register 不做参数校验**，信任边界在工具自己；`exec` 给 `signal` 与 `agent?`。`execute` 抛错的宿主处置未确认（该包无源码可查），故本仓按「可能不捕获」防御：读宿主投影/请求头失败归 `undefined`、工具回 `no-route`，不让异常冒泡出 `execute`。
- **`systemPrompt`**（`DSH/packages/core/system-prompt/src/index.ts`；契约复制同上）：`section({ name, order, text })`，重名抛错；宿主 order 序列 MCP_SERVERS=3100、TOOLS_SDK=5000，本插件用 `order: 3200` 落位其间。
- **`sessionController.selectModel`**（`@deepseek-ai/dsh-api-session-controller` 的 `src/types/commands.ts`）：会话级模型选择生效——与 UI 选择器同一链路（落 `model/selection` 成投影 `pending`），返回值带 `{ selected }`；失败**抛 `RemoteError`**（子智能体持有会话 `session/agent-busy`、模型不支持所选档位 `session/model-unavailable`），本仓文案原样透传。
- **`llm.resolveModelInfo(provider, model, signal?)`**：解析任一活路由的模型信息（档位来自适配器元数据，不限于本插件填充的模型）；本仓查询工具用它取可用档位（出参不含 `defaultEffort`），失败 catch 兜成 `resolve-failed` 不外抛。

### credentials：凭据状态面（隐藏官方API的判定依据）

- `ctx.credentials` 在 `src/index.ts` 的 `inject` 里作顶级依赖（与 `settings` / `llm` 并列），不用 `ctx.get`：宿主基础配置无条件挂载它（`DSH/packages/bundle/base/cordis.patch.yml` 无 `disabled` 条件）⇒ 缺失即异常部署，PENDING 暴露好过静默降级。
- `describe(ref): Promise<CredentialInfo{ configured; source?; writable }>`：按引用名描述、**永不回值**；解析分层 进程环境 → provider 存储 → `.env`，空值视为未配置。本仓只读 `configured`。判定口径与宿主模型页 `hasProviderApiKey` 同源（settingsNs 段沿 settingsPath 取 profile → `apiKeyEnv` → `describe().configured`，`DSH/packages/api/session-controller/src/types/catalog.ts`）。
- `resolve(ref): Promise<ResolvedCredential{ value; source } | undefined>`：按引用名**取明文**（与 `describe` 同一分层；空值跳过、未配置回 `undefined`）。仅「能力探测」的 wire 层用它取 `apiKeyEnv` 的密钥（`src/probe-caps.ts` 的 `defaultCredentialLookup`，取不到回退 `process.env[ref]`——同 `dsh-llm-pi-ai` 的 `resolveApiKey` 口径）；密钥只进 `Authorization` 头，不进日志与帧。按 seam 纪律「每次操作现解析、不跨操作缓存」。
- `credentialRef(value)`（**值导入**）：裸字符串品牌化，语法外（POSIX 标识符）抛 `TypeError` ⇒ 调用前须过 `isCredentialRefName` 预检（同包值导出、不抛）；本仓语法外引用名一律放行不隐藏。
- 官方适配器默认引用名：`llm-deepseek-api-key` 的 `Config.apiKeyEnv` 默认 `"DEEPSEEK_API_KEY"`（volatile，`config.apiKeyEnv ?? 默认`）⇒ 段缺该字段时本仓判定回退同名常量 `DEFAULT_OFFICIAL_API_KEY_ENV`。

### llm：`resolveModelInfo` 是档位显示名的唯一出口

- `reasoning.efforts[].name` 只在它返回里出现（`buildModelCatalog` 先 `listModels` 拿模型、再 `resolveModelInfo` 拿档位元数据，原样搬进目录载荷；UI 菜单 / 触发器标题 / subagent 工具全取它）⇒ 遮这一处全链覆盖（与 `official-filter` 遮 `listModels` 同一 `LlmRuntime` 实例、同一形态）。
- 消费者影响面已逐一核实：session-reference / compaction-basic / ACP / MCP-client 只取 `context` 与 `inputModalities`，零影响；**例外：`tool-subagent` 的 list-models 把 `effort.name` 拼进给 AI 的文本——开关开时 AI 看到的档位名也是中文（已知取舍）**。
- `defaultEffort` 不可翻译：它是档位 id，`LlmRuntime` 校验它落在 `efforts[].id` 内（不合法抛 `INVALID_MODEL_REASONING`）。
- 名字来路：适配器按档位 id 现算（`id` 首字母大写），配置侧只有 id 无名字字段；宿主词典刻意不本地化档位名。`normalizeModelInfo` 只校验/分离、返回新建对象，换名不动入参。
- Node 侧语言判定三路（`locale.preference` → 浏览器上报 → `en`）：宿主 locale 插件把显式选择存 `locale` 段 `preference` 字段（`DSH/packages/client/locale/src/locale-settings.ts`，随 settings 文档持久）；`locale` 服务只在浏览器半提供，Node 侧读不到自动探测结果，故未显式选择时由浏览器启动时经 `reportLocale` RPC 上报（进程内易失）。

### 模块装载：`window.__ModuleLoader__` 与 `dsh.client.inject`

- 契约（`DSH/packages/client/modules/src/index.ts`）：`ClientModuleLoaderTarget{ mode:'queue'|'live'; pendingQueue; load(registration); create(options) }`；`load` 参数（`src/client/manifest.ts`）：`ClientBundleRegistration{ id /* 插件包名 */; chunk?; factory: (require) => Record<string, unknown> }`。
- 产物形态由宿主构建注入（`DSH/packages/client/web/tsdown.client.ts`）：banner `window.__ModuleLoader__.load({ id: …, factory: (require) => {`、intro `var module = { exports: {} }; var exports = module.exports;`、footer `return module.exports; } });` ⇒ 本仓 `tsdown.config.ts` 的 banner/intro/footer 逐字复刻这三行。
- 宿主读 `materialize(id).exports`：`unwrapExports` = `exports.default ?? exports`（`__esModule` 再解一层）⇒ **default export 会丢掉 inject**（宿主 postmortem `0001-acp-default-export-drops-inject.md` 有案）；客户端半导出必须具名 `{ name?, inject?, Config?, apply }`，`apply` 必需（缺了抛 `invalid plugin…`）；`name` 不强制等于包名（只影响显示名）。
- 重复注册抛 `client-modules: duplicate factory registration…`；另有 `loaded without registering "…" via __ModuleLoader__.load`、成环 `module arrival cycle`。
- `dsh.client.inject` 权威语义（`DSH/packages/util/package-manifest/src/types.ts`）：`inject` = 「Informational package-name dependencies, not Cordis service injection.」⇒ 它**不是 cordis 服务名、不决定激活顺序**；本仓库槽位所有者包是为保证这些包先物化，服务名只写 `src/client/index.tsx` 的 `export const inject`。

## 宿主类型导入清单

`@deepseek-ai/*` 一律 type-only 导入 devDep 面（构建期擦除，升宿主时 typecheck 即暴露不兼容）；「合并」= `import type {} from '…'` 只做 `declare module` 扩充，零运行期依赖。

| 宿主模块 | 导入符号 | 形式 | 使用处 |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | `Context` / `Context as ClientContext` | type-only | Node 半各模块；`src/client/index.tsx`、`memory-listener.ts`、`rpc-carrier.ts` |
| `@deepseek-ai/schemastery` | 默认导出 `z` | **值导入** | `src/index.ts`（`Config`）、`src/upgrade.ts`（v7 冻结 schema） |
| `@deepseek-ai/dsh-settings` | `SettingsPathOp`、`SettingsDescriptor` | type-only | 各写回端点与 `src/client/scope.ts`（前者）；`src/section.ts`（后者） |
| `@deepseek-ai/dsh-settings/types` | `SettingsPathOpView` | type-only | `src/client/scope.ts`（浏览器半写回 op 目标形态；**只引 `/types` 子路径**，包根未导出） |
| `@deepseek-ai/dsh-util-values` | `deepEqualJson`（值）、`JsonValue`（type-only） | **值导入** + type-only | `src/fix.ts` `src/migrate.ts` `src/compat.ts` `src/restore.ts`（前者）；`src/client/scope.ts`（后者） |
| `@deepseek-ai/dsh-llm` | `LlmRuntime`、`ReasoningEffortId` | type-only | `src/probe-engine.ts`；`src/rpc.ts` 另有合并导入（`ctx.llm` 服务面） |
| `@deepseek-ai/dsh-llm/types` | `LlmFailure` | type-only | `src/probe-verdict.ts`、`src/probe-engine.ts`（**只在 `/types` 子路径**，包根未再导出） |
| `@deepseek-ai/dsh-client-connection` | `ConnectionRpcResult`、`HostConnectionService` | type-only | `src/rpc.ts`、`src/rpc-route.ts`、`src/client/rpc-carrier.ts`、`src/client/card.tsx` |
| `@deepseek-ai/dsh-host-webserver` | `WebServer` | type-only | `src/rpc.ts` |
| `@deepseek-ai/dsh-credentials` | `credentialRef`、`isCredentialRefName`（**值导入**）、`CredentialProvider`（type-only） | **值导入** + type-only | `src/official-filter.ts`。本仓第一个 Node 半宿主值导入：Node 半不受浏览器半基线门禁约束，但实现必须由宿主提供，故打包外置（`tsdown.config.ts` 的 `HOST_EXTERNALS` 同名条目与 Node 半 `deps.neverBundle`） |
| `node:http` | `IncomingMessage`、`ServerResponse` | type-only | `src/rpc-route.ts` |
| `@deepseek-ai/dsh-client-ui-primitives` | `import * as primitives`、`TerminalBlockLabels` | **值导入** + type-only | `src/client/` 各卡片文件（浏览器半唯一的运行期宿主 UI 依赖）。**契约漂移点**：`TerminalBlockLabels` 自 `0.2.1-alpha.2` 起新增必填 `commandLine`；devDep 停在 0.1.7-rc.2 编译面看不到，故 `terminalLabelsOf` 以 `TerminalBlockLabels & { commandLine }` 声明（避开 excess-property 报错、保住其余字段必填）；多余字段在 0.1.7-rc.2 上被静默忽略，两端兼容 |
| `@deepseek-ai/dsh-client-ui-settings/client` | `ConfigForm`、`ConfigFormSnapshot` | type-only | `src/client/index.tsx`、`src/client/scope.ts` |
| `@deepseek-ai/dsh-client-connection/client` | `ClientConnectionRpc` | type-only | `src/client/rpc-carrier.ts` |
| `@deepseek-ai/dsh-client-ui-slots` | `TranslateNS` + 合并（`LocaleNamespaceMap` 纳入 `CARD_NS`） | type-only + 合并 | 各卡片文件；合并：`src/client/locale-keys.ts` |
| `@deepseek-ai/dsh-api-session-controller/client` | 合并（`ctx.sessions`） | 合并 | `src/client/memory-listener.ts` |
| `@deepseek-ai/dsh-api-session-controller/types` | `ModelSelection`、`ModelSelectionProjection`、`ModelProviderGroup`、`ModelCatalog` | type-only | `src/client/memory-listener.ts`、`src/client/effort.ts`、`src/client/effort-name.ts`（目录载荷） |
| `@deepseek-ai/dsh-client-ui-model-selection/client` | `ModelDirectory` | type-only | `src/client/memory-listener.ts` |
| `@deepseek-ai/dsh-session/types` | `SessionId` | type-only | `src/client/memory-listener.ts`、`src/subagent.ts`、`test/subagent.test.ts`（**只引 `/types` 子路径**：包根把 Node 侧 `SessionStore` 的 `ctx.sessions` 增补带进来，见末条） |
| `@deepseek-ai/dsh-client-ui-renderer/client` | 合并（`ctx.slots`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-locale/client` | 合并（`ctx.locale`） | 合并 | `src/client/index.tsx`、`src/client/effort-name.ts` |
| `@deepseek-ai/dsh-client-ui-settings-models/client` | 合并（slot key `settings.models.footer`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-ui-plugin-manager/client` | 合并（slot key `plugins.bundle.config` / `plugins.row.config`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-client-ui-conversation/client` | 合并（slot key `conversation.input.left`） | 合并 | `src/client/index.tsx` |
| `@deepseek-ai/dsh-llm` | `LlmCallConfig` / `LlmCallConfigAdapterDefaults` / `ReasoningEffortId`（**必须包根**：`/types` 子路径不含 `LlmCallConfig`） | type-only | `src/subagent.ts` |

- 浏览器半运行期宿主依赖只有 `react`、`react/jsx-runtime` 与 `@deepseek-ai/dsh-client-ui-primitives`（其余擦除后不留痕）；ui-primitives 属平台模块（宿主冻结模块表提供），卡片用宿主运行期对象而非打包副本（符号漂移由 typecheck 拦，风险是宿主改名后运行期 `undefined`，React #130 打空该 slot 条目）。
- `ctx.llm` 只做 type-only 引用：验证请求必须经宿主 `LlmRuntime.stream` 发出，`dependencies` 不长新条目；档位 id 用 `as ReasoningEffortId` 断言不引运行期构造器。
- 浏览器侧 `connection` 的 rpc 面经 `unknown` 桥接：宿主 `connection` 服务声明合并只有服务端面，client 面（`ClientConnectionRpc`）不合并进 `Context`。
- **`ConfigForm.mutate` 入参形态**：宿主签名写的 `SettingsPathOpView` 来自未装的 `@deepseek-ai/dsh-api-remotes/client`（`skipLibCheck` 下退化成 `any`），故不能用 `Parameters<>` 取形态；`src/client/scope.ts` 直接标成 `dsh-settings` 的 `/types` 子路径同名导出（两包各持一份同形声明）。唯一残留收敛是 `unknown → JsonValue` 断言（写回值恒为配置段 JSON 值；浏览器半门禁不允许引同包 `isJsonValue`）。
- **子智能体注入面三项宿主类型按契约复制、不引宿主包**（`src/subagent.ts` 的 `SubagentHost` / `HostSelectionService` / `SubagentRequestListener`）：富面 `Agent` 只在 `@deepseek-ai/dsh-agent` 包根导出、`subagentModelSelection` 住在 `@deepseek-ai/dsh-tool-subagent/model-selection-settings`，两包都会把 `@deepseek-ai/dsh-session` 包根类型拉进 typecheck 程序，顶掉浏览器半 `ctx.sessions` 的同名增补（`ISessions` 退化成 Node 侧 `SessionStore`，`src/client/memory-listener.ts` 打 6 条类型错误）。实测：这两包只要出现在 `src/` 的 type-only 导入里就触发（`test/` 未触发但不可依赖）⇒ `package.json` 不列它们。升宿主时若宿主已修好该声明合并冲突，可改回直接导入并删本地复制。
- **档位自调注入面四个宿主服务按契约复制、不引宿主包**（`src/self-tune.ts` 的 `HostToolsService` / `HostSystemPromptService` / `HostSessionController` / `HostSessionProjections`）：`dsh-tools` / `dsh-system-prompt` 不在 devDep 清单且类型面会拉进包根冲突；`sessionController` / `sessionProjections` 虽在 devDep，但经子 fiber `child.get` 取用，一并复制让该文件零宿主类型导入。

## 依赖宿主字面量的键与码

改这些字面量必须确认宿主侧同名同值；命名空间键以 `src/shared/constants.ts` 的 `PLUGIN_NS` 为准，其余散落常量与内联处。

- **settings 命名空间**：`PLUGIN_NS = 'tikaflow-model-fix'`（= `cordis.patch.yml` 的 `id`，浏览器半 `configForms.get(ns)` 与 Node 半写回 NS 同一字面量）；`API_NS = 'llm-pi-ai'`（宿主自带段，本插件只读 user 层、在同段写 `providers.<id>.models` 与路由 `compat`）。
- **路由 compat 字段**（`src/constants.ts`）：`supportsDeveloperRole` / `supportsStore`（宿主侧 `PiAiCompatProfile` 的 `COMPLETIONS_COMPAT_GATE`，只在 `openai-completions` 消费）。效果：写 `false` = 请求体不带 `store` 键 / 系统提示用 `system`；宿主对未标注端点按「支持」推断（`model.compat.字段 ?? detected.字段` 合并），本插件翻成保守。字段名、检测取向或合并口径变化须同步。
- **子智能体宿主字面量**：服务名 `subagentModelSelection` / `agents` / `sessionProjections`（经子 fiber 注入，全就绪才注册监听）；投影键 `'modelSelection'`；`SessionHeader.origin = 'subagent'`。浏览器半读宿主段 `subagent-model-selection-settings` 的 `enabled` 布尔（`src/client/composer.tsx`，段缺席视为未开启）。
- **档位自调宿主字面量**：服务名 `tools` / `systemPrompt` / `sessionController` / `sessionProjections`（任一缺席 ⇒ 子 fiber PENDING 静默）；工具名 `query_reasoning_efforts` / `set_reasoning_effort`（同名重复注册抛错，故装载幂等——已加载时自有段变更跳过，只在开关真翻转时装/卸）；提示词段名 `model-fix:effort-tuning`、`order: 3200`。
- **RPC 路由**：channel `/tikaflow-model-fix`；`VERIFY_STREAM_ROUTE = /api/tikaflow-model-fix/verify`、`PROBE_STREAM_ROUTE = /api/tikaflow-model-fix/probe`、`CAPS_STREAM_ROUTE = /api/tikaflow-model-fix/caps`（`connection.fetch` exact 路由，须落 `/api` 下）；浏览器 `fetch` 用 `ROUTE.slice(1)` 的文档相对路径。三条流共用 `src/rpc.ts` 的 `progressStreamFetch`；写配置的两条（探测档位、能力探测）入口先查守卫，已开回 409 + 中文文案。
- **RPC endpoint**：`forceUpdate` / `resetModels` / `restoreModels`，结果信封 `{ ok: true, value: { changed } }`。
- **本插件错误码**（`ConnectionRpcResult` 的 `error.code`）：`model-fix/write-in-progress`、`model-fix/force-update-failed`、`model-fix/reset-models-failed`、`model-fix/restore-models-failed`、`model-fix/unknown-endpoint`。
- **宿主错误码**：`SETTINGS_CONFLICT`；信封层 `gateway/bad-request`；`invalid-request`（宿主自复刻的非法 rpcId 哨兵，非宿主常量）。
- **slot 席位名**：上表五键；`plugins.row.config` 的 `key` 拼接规则 `${包名}#${patch 条目 id}`。
- **locale 命名空间**：`CARD_NS = 'settings.modelFix'`。
- **LLM 失败码**（按 `failure.code` 判，不看 `status`、不比对文案）：`UNSUPPORTED_REASONING_EFFORT`、`QUOTA`、`ACCOUNT_QUOTA`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`TRANSPORT`、`STREAM_CLOSED`、`RATE_LIMIT`、`TIMEOUT`、`INVALID_REQUEST`。
- **构建期注入标识**：`__PLUGIN_VERSION__`（`tsdown.config.ts` define 内联 `package.json` version）。
- **逐字复制的宿主正则**：`EXCLUDE_ID_PATTERN`（宿主 models 页提供方 id 校验）、`ENDPOINT_SEGMENT`（宿主 RPC 路径段校验）；宿主改这两处须同步。

## 装载与 HMR 契约

- `dsh.client.inject` 只影响模块物化顺序、不影响 cordis 激活顺序（语义见「模块装载」节）。
- client 模块须 `export const name` 与 `export const apply`，复刻 `__ModuleLoader__` 闭包契约（`tsdown.config.ts` banner/intro/footer 取自宿主 `tsdown.client.ts`）。**禁 default export**（`unwrapExports` 的 `exports.default ?? exports` 会吃掉 `inject`/`Config`）。声明 `dsh.client` 后缺 `lib/client.js` 会让宿主激活期聚合抛错 ⇒ **build 必须先于安装**。
- Node 半 `export const inject = ['settings','llm','credentials']`；`configForms` 只作子 fiber 标记（不进父级 inject），共享编排体全走子 fiber ctx（理由见 decisions.md「宿主与卡片」）；`connection` / `webServer` 在 `src/rpc.ts` 子 fiber 内声明；`hmr` / `agents` / `sessionProjections` / `subagentModelSelection` 各在 `src/index.ts` / `src/subagent.ts` 子 fiber 内声明。
- **子 fiber 卸载不清理父 ctx 上的注册**（`_unload` 只清自身 disposables）：一次性注册（`locale.register`、slot 注册）必须挂会随重建而卸载的那个 fiber，否则第二次注册抛 `already has locale`。取服务不受限（属性读沿父链上溯）。
- **宿主 `ObservableSnapshot.subscribe` 一律不推首值** ⇒ 所有订阅都要手动补跑一次。
- 浏览器半样式经模块级幂等 `<style>` 注入并带 `data-plugin` 标记供宿主 HMR 认领；`ctx.locale.register` 重复注册抛错，disposer 必须经 `ctx.effect` 挂。
- 卡片样式与文案的宿主同款来源见 `docs/decisions.md` 与 `docs/ui-fusion.md`，本文不重复。

## 已知漂移与观察项

- **查阅的宿主源码可能比 devDep 新**（本仓 devDep/engines 为 `0.1.7-rc.2`）：差异记入此处，不顺手改代码、不据此升 devDep（README 支持范围与类型面基线是两件事）。
- **settings 路径 op 数组下标中间段**：较新版本已支持（越界抛 `Config array index "…" is out of range`）。本仓按 provider 整段 `set` 的写法在两种语义下都成立，不改代码；0.2.x 后若改用下标写法须先在 devDep 版本实测。
- **`unset` 不折叠空父对象**：devDep 与较新版本一致；宿主将来若折叠，本仓「整段 unset」写法仍安全。
- **平台模块表**：本仓两份副本（`eslint.config.ts` 的 `BROWSER_HOST_BASELINE` 与 `tsdown.config.ts` 的 `HOST_EXTERNALS`）比宿主 `platform.ts` 少一项 `@deepseek-ai/dsh-client-ui-dockkit`（宿主另有 `PRELOADED_CLIENT_EXTERNALS = []`）——当前无碍，宿主若把本仓在用的模块移出表则会被打进浏览器包而运行期拿不到宿主实例。升宿主时两份一起逐位比对。
- **`connection` 不注入 `webServer`**：较新版本确认，与本仓「必须自己 inject 两个服务」的写法一致。
- **官方 provider 的 `models` 有默认兜底**（`llm-deepseek` 的 `.default(DEFAULT_MODELS)`，读取侧 `(models ?? DEFAULT_MODELS).map`）：清空配置来隐藏它实测不生效，故本仓拦目录生成链路（见「模型清单面」节）。该兜底若被去掉，这条观察可撤。
- **`HOST_EXTERNALS` 含 Node 半专用条目 `@deepseek-ai/dsh-credentials`**：tsdown 默认只外置 dependencies/peerDependencies、devDependencies 会被内联（实测 0.22.14：内联出的 `credentialRef` 与宿主服务面脱钩），故该条目加进 `HOST_EXTERNALS` 让 Node 半配置复用同一张表（`deps.neverBundle`）。浏览器半不 import 它、运行期无差异；升 tsdown 时复核 `lib/index.js` 首行仍是外置 import。
- **宿主 settings 无客户端包、无命名空间登记/ready 事件**（全仓检索确认；`ConfigForms` 也无 `whileServed` 之外的等待原语）⇒ `src/migrate.ts` 的有界轮询不可省。
- **`settings.models.footer` 的 SlotMap 定义在 `@deepseek-ai/dsh-client-ui-settings-models` 而非 ui-settings**——搜 slot 定义时别只搜后者。
- **`ConfigForm` 写入「被拒 vs 传输失败」是两件事**（被拒/跳过 false、传输失败 reject）：本仓卡片只读返回值；宿主若改为传输失败也返回 false，用户只会看到「未生效」。注意 `0.2.1-alpha.3` 起非 loopback 连接不再整体 `memory` 模式（宿主删掉 `persistence = isLoopback ? 'host' : 'memory'`），远程浏览器写入也走宿主文档。
- **子智能体注入面已逐 tag 核过**：列出的宿主文件在 `dsh-v0.1.7-rc.2` / HEAD / `dsh-v0.2.1-alpha.1` 三处 blob 哈希一致；子智能体可选模型 + 推理级别能力自 `dsh-v0.1.2-alpha.1` 起存在，远早于本仓最低支持版本。
- **`ConfigFormSnapshot.mode` 在 `0.2.1-alpha.3` 被移除**（唯一编译级破坏）：本仓照旧（`src/client/scope.ts` 的 `mode` 字段无消费方，宿主快照缺失时读到 `undefined` 不参与判定；devDep 停 rc.2 故 typecheck 不报错）。升 devDep 到 alpha.3 时删掉那两行。
- **pi-ai 适配器的 `listModels` 对未解析凭据改为返回空清单**（alpha.3：rc.2 是直接抛出）：`official-filter` 按 `describe().configured` 判定、不看 `listModels` 是否抛，功能不变；`memory.ts` 的 `collectLiveModels` 把「读失败」（记 `null` 整段保留）与「成功但空」（按模型已删除剪）分开，alpha.3 下未配凭据的自定义提供方从前者落到后者 ⇒ 该提供方记忆被清——按「凭据缺失即用不了模型、删记忆是对的」口径接受，不改代码。
- **pi-ai `stream()` 删除了空闲超时抛出**（alpha.3 去掉 `LLM_STREAM_IDLE_TIMEOUT` 两行）：本仓无回归——`probe-engine.ts` 自带两级超时且与每次 `next()` 赛跑，不依赖宿主空闲看门狗与适配器配合中止。
- **非 loopback 连接的 settings 卡不再固定 `unavailable`**（alpha.3 把 `status` 收窄为 `idle | loading | ready`）：本仓 `card.tsx` 的 `status === 'unavailable'` 分支来自 `ConfigForm.derive()`（查无 NS），与连接性质无关，插件未被宿主登记时仍会命中，保留。
- **宿主自 `0.2.1-alpha.2` 起原生隐藏「未配密钥的官方 API 组」**（`llm-deepseek-api-key` 的 `discoverModels` 在 `MISSING_CREDENTIAL` 时返回 `[]`，与 rc.2 本仓功能同效）：本仓功能保留作老宿主兜底。`deepseek-account` 自 `0.1.7-rc.2` 起自带登录门，宿主自己的凭据判定显式跳过它（`hasProviderApiKey` 的 `continue`）⇒ **不得加进 `HIDDEN_OFFICIAL_PROVIDERS`**（account 段无 `apiKeyEnv` 键，判定会回退 `DEEPSEEK_API_KEY` 误隐藏可用账号组）。

## 升级宿主时的检查清单

- 逐位比对 `BROWSER_HOST_BASELINE` 与 `HOST_EXTERNALS` 同宿主 `DSH/packages/client/web/src/platform.ts`（已比对 `0.2.1-alpha.3`：宿主表仅多 `dockkit` 一项，本仓在用的模块无被移出）。
- 对本文每个宿主类型导入跑 typecheck；值导入的符号漂移 typecheck 抓不到，须人工比对 `@deepseek-ai/dsh-client-ui-primitives` 全部用到的符号。
- 逐字段比对 `TerminalBlockLabels`（0.2.1-alpha.2 起新增必填 `commandLine`）：宿主新增必填字段时编译期不报错、只在首次渲染记录区时崩。已核 `0.1.7-rc.2` 与 `0.2.1-alpha.3`：alpha.3 字段全集 = rc.2 的 13 字段 + `commandLine`，无其它新增改名，`terminalLabelsOf` 无需补字段；唯一待收是 `src/client/card.tsx` 两处 `useMemo<TerminalBlockLabels>` 标注与实参（多带 `commandLine`）不一致，升 devDep 后一并改。
- 逐条复核「宿主服务与运行时面」各节签名与行为假设，尤其 settings 写入语义、命名空间登记时序、连接断开语义。
- 复核 `SETTINGS_CONFLICT` 与 LLM 失败码字面量（尤其 `classifyPiAiError` 的文案正则——它决定 `TRANSPORT` / `STREAM_CLOSED` 的归一化来源）。
- 复核适配器是否仍兑现 `options.signal`（`LlmAdapter.stream` 契约 `implementations must honor options.signal`）：本仓 30s 软超时 + 3s 硬兜底靠它传中止；连带复核 pi-ai `idleWatchdog`（rc.2 有、alpha.3 删过、按当时版本确认）与 `LLM_STREAM_IDLE_TIMEOUT`。
- 复核五个 slot key、`rowConfigKey` 拼接、`SlotLabel` thunk 与 `PropsLocale`（`t` 只在声明 `locale:` 时上 props）。
- 复核 `ctx.sessions.binding()`（返回 `undefined`）与 `ctx.modelDirectories.directoryFor()`（抛错）的失败契约，互换会让记忆链路 try/catch 失准。
- 复核 compat 两字段的宿主契约（`openai-completions` gate、检测默认与 `??` 合并口径）。
- 复核 `Config` 仍是 volatile 实时引用（`Volatile<T>` + `loader/volatile-update`）及 `z.any()` 与 `z.object` 在 settings `projectForm` 的投影差异。
- 复核子智能体注入面六件事：`agent/request` 仍可 prepend 且种子仍 `deepFreeze`；未打 scope 标签的 ctx 仍全局收事件；`ctx.agents.get()` 仍返回富面 `Agent`；`session.requestHeader()` 仍只反映父已发过的请求；`sessionProjections.stateOf` 的 `modelSelection` 形状与 pending 语义未变；`subagentModelSelection` 缺席/抛错语义未变。
- 复核 `@deepseek-ai/dsh-session` 包根对 `Context.sessions` 的声明合并与 `@deepseek-ai/dsh-api-session-controller/client` 是否仍冲突（冲突未解：`src/subagent.ts` 三项契约复制与 `package.json` 不列 `dsh-agent` / `dsh-tool-subagent` 的约定保留；已解可改回直接导入）。
- 复核 `SettingsPathOpView` 的两份宿主声明仍同形（`dsh-settings` 的 `/types` 与 `@deepseek-ai/dsh-api-remotes/client`）；宿主若把 `dsh-api-remotes` 列为 devDep，改引真正的那份。
- 复核档位自调四件事：`tools.register` definition 形状（必填 `description`、`execute(args, exec)` 的 `exec.agent` 可缺）与 `systemPrompt.section({ name, order, text })`；宿主 `SECTION_ORDERS`（MCP 3100 / SDK 5000，本插件 3200 落位依据）；`selectModel` 失败抛 `RemoteError` 且 `session/agent-busy` / `session/model-unavailable` 两码未变；`resolveModelInfo` 返回的 `reasoning` 形状未变。
- 复核「隐藏官方API」三条宿主行为：`llm.listModels` 仍是原型方法（改箭头函数类字段则遮蔽静默失效）；`buildModelCatalog` 仍滤模型数为 0 的组；`credentials.describe` 与 `credentialRef` / `isCredentialRefName` 签名与抛错面未变。已核过 `0.2.1-alpha.3`：三条全部成立（只有 `credentials` 读取优先级与监听器失败处理语义变了）。
- 复核「本地化推理级别」四条宿主行为：宿主 UI 仍经 `ctx.remote.session` 嵌套取面调 `modelCatalog`（改走别的对象则换名层静默失效）；远程方法仍装成可配置访问器（改数据属性则 `defineProperty` 换名抛错）；「方法先于依赖方装载」的同步窗口仍在（取不到 descriptor 时本仓不装、功能静默失效）；档位显示名仍由适配器按 id 现算、UI 仍原样取 `efforts[].name`（宿主若自带本地化词条或渲染插槽，本层可撤）。
