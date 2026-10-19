/** 跨半共享的纯常量（零 Node 依赖、零 schemastery、零非基线 `@deepseek-ai/*`）。两半均直连本层（统一经 `@/shared/constants` 别名导入）；Node 专属常量仍留 `src/constants.ts`。
 * 本文件是浏览器半唯一可安全值导入的跨半来源；加 `node:`、`schemastery` 或非基线 `@deepseek-ai/*` 值导入会破坏浏览器半产物——勿加（门禁见 `eslint.config.ts`） */

/** 模型配置读写目标命名空间（harness 的 llm-pi-ai）：小写连字符字面量，由 settings 服务在注册/读写时校验 */
export const API_NS = 'llm-pi-ai'
/** 自有配置命名空间（带发布者前缀，避免与其他插件抢占通用名字；fix 即填充/修复），由插件导出的 Config schema 注册（src/index.ts） */
export const PLUGIN_NS = 'tikaflow-model-fix'

/** 插件名（= npm 包名）：Node 半日志前缀与 User-Agent、浏览器半 `export const name` 与样式标签 HMR 标记共用 */
export const PLUGIN_NAME = 'dsh-model-fix'

/** 验证进度流的路由：Node 半经 `connection.fetch` 注册的 exact 路径（宿主要求落在 `/api` 之下）；浏览器半用 `VERIFY_STREAM_URL` 那一份——宿主约定浏览器一律走文档相对路由，服务端 key 保持绝对 */
export const VERIFY_STREAM_ROUTE = `/api/${PLUGIN_NS}/verify`
/** 同一路由的文档相对形式（去掉前导斜杠），供浏览器半 `fetch` 直接使用 */
export const VERIFY_STREAM_URL = VERIFY_STREAM_ROUTE.slice(1)

/** 「探测档位」进度流的路由：与验证流同型（同一 exact 注册面、同样的 `buffered` 请求体、同样的 SSE 回包），只是执行器与用途不同——逐档试出哪些推理级别真能用，随后写回补全 */
export const PROBE_STREAM_ROUTE = `/api/${PLUGIN_NS}/probe`
/** 同一路由的文档相对形式（去掉前导斜杠），供浏览器半 `fetch` 直接使用 */
export const PROBE_STREAM_URL = PROBE_STREAM_ROUTE.slice(1)

/** 「能力探测」进度流的路由：与前两条同型，载荷多带能力勾选（图片输入 / 工具调用）与同名两个开关；Node 半走 wire 级裸 HTTP 探测（见 docs/decisions.md「能力探测」） */
export const CAPS_STREAM_ROUTE = `/api/${PLUGIN_NS}/caps`
/** 同一路由的文档相对形式（去掉前导斜杠），供浏览器半 `fetch` 直接使用 */
export const CAPS_STREAM_URL = CAPS_STREAM_ROUTE.slice(1)

/** 推理级别取值，与 harness 的 ModelThinkingLevel 一致（由低到高：浏览器半取「最低档位」即取首个命中项） */
export const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 推理级别中文名：键取宿主算显示名的同一形式（id 首字母大写，Node 半换名时用同一表达式查表），于是与本仓对宿主 UI 呈现的英文逐字对得上。Node 半换名见 `src/effort-name.ts` */
export const EFFORT_NAMES_ZH: Readonly<Record<string, string>> = {
    Off: '关',
    Minimal: '极低',
    Low: '低',
    Medium: '中',
    High: '高',
    Xhigh: '极高',
    Max: '最大',
    Default: '默认',
}

/** 「中文名 · 原档位名」的分隔符（U+00B7 中点，与宿主分隔符口径一致）。浏览器半的 Default 伪菜单项（`src/client/locale-patch.ts`）与 Node 半的档位换名（`src/effort-name.ts`）两处拼装同一形态，故放共享层防走样 */
export const EFFORT_NAME_SEP = ' · '

/** RPC channel 的端点名常量：跨 Node 半（注册分发）与浏览器半（发起调用）共享，统一放 shared 层避免两端写同一个裸字符串（一端改漏另一端 runtime 报 unknown-endpoint） */

/** 卡片「强制更新」按钮调用的 endpoint 名 */
export const ENDPOINT_FORCE_UPDATE = 'forceUpdate'
/** 卡片「重置推理级别」按钮调用的 endpoint 名 */
export const ENDPOINT_RESET_MODELS = 'resetModels'
/** 卡片「恢复备份」按钮调用的 endpoint 名 */
export const ENDPOINT_RESTORE_MODELS = 'restoreModels'
/** 浏览器半启动时上报探测语言的 endpoint 名（Node 侧没有 locale 服务，见 effort-name.ts 的语言解析） */
export const ENDPOINT_REPORT_LOCALE = 'reportLocale'

/** settings 写回冲突与语言上报共用的重试次数（纯数值，跨半共享）。值变更须同步两端——差异直接造成写入行为不一致 */
export const MAX_ATTEMPTS = 3

/** 三个写回端点的等待上限（毫秒，跨半共享）：宿主 `rpc.call` 除调用方给的 `signal` 外没有任何计时器，不给就有一条「等不到结果即永远占着卡片占用态」的挂死路径。超时只中止这次等待，Node 半的写回照跑完，故文案说「未收到结果」而不是「未写入」（取值与取舍见 docs/decisions.md「写回端点」） */
export const WRITEBACK_MS = 10_000
