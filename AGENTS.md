# dsh-model-fix

## 项目简介

DSH 插件：按 [models.dev](https://models.dev) 为非官方（自定义）提供方的模型补全并同步推理级别与模型参数、维护路由 compat，管理会话侧的推理级别记忆，并在宿主设置页提供对应卡片。功能与用法见 [`README.md`](README.md)。

## 技术栈与目录

Node.js（ESM）+ `@deepseek-ai/cordis`；tsdown 双配置构建到 `lib/`（Node 半 + 浏览器半）；TS 严格模式，产物不带 sourcemap；ESLint 10 扁平配置。

- `src/`：Node 半，入口 `src/index.ts`（导出 `Config` + 单一 `apply` 编排体）。
- `src/client/`：浏览器半（席位注册、卡片、词典），调 Node 半的唯一出口是 `src/client/rpc-carrier.ts`。
- `src/shared/`：跨半共享层，零 Node 依赖，禁反向 import Node 半。
- `test/`：纯函数与零 ctx 编排的测试。

逐文件职责与数据流骨架见 [`docs/architecture.md`](docs/architecture.md)。

## 硬约束（违反即坏）

### 宿主契约文档纪律

本插件对宿主的一切依赖——服务调用与事件订阅（含签名与参数位序假设）、宿主类型导入面、依赖宿主字面量的键/码/路由/slot 名、宿主运行时行为假设、版本基线与平台模块表——一律登记在 [`docs/host-api.md`](docs/host-api.md)。**改动落在上述任一类，同一轮必须更新该文档**；修宿主 bug、升宿主版本、发现新的宿主行为假设时同样适用，升宿主大版本还要过一遍该文档末尾的「升级宿主时的检查清单」。

其余细则下沉到专题文档：改动落在哪份文档范围内就更新那一份，不回头改本文件——只有架构变更或专题文档列表变化时才动 `AGENTS.md`。

### 导入与打包

- 源码导入只用 `@/`（→`src/`）与 `@test/`（→`test/`），禁相对路径；别名须同时声明在 tsconfig `paths` 与各 tsdown 配置 `alias`（tsdown 不读 paths），键锚定 `@` 以免吞 `@deepseek-ai/*`。
- 代码合规检查一律归 lint，编译配置（`tsdown.config.ts`）只管编译。跨半纯度是 `eslint.config.ts` 的三条 lint 规则（Node 半禁 `@/client` 值导入；浏览器半的 `@/` 与 `@deepseek-ai/*` 值导入只放行 `@/shared/*`、`@/client/*` 与基线 `BROWSER_HOST_BASELINE`）；只判值导入（`import type` 由 `verbatimModuleSyntax` + `consistent-type-imports` 保证）。
- 宿主模块排除表单一来源 `scripts/build-externals.mjs`（tsdown 与 eslint 共用），按半各一份、只列该半运行期实际值导入的宿主包；浏览器半基座以宿主 `PLATFORM_MODULES`（冻结表）为准，漂移即运行期 require 未命中。
- settings 命名空间键 = `cordis.patch.yml` 的 `id` = `PLUGIN_NS`，浏览器半 `configForms.get(NS)` 与 Node 半写回共用同一字面量。
- `package.json` 的 `dsh.client.inject` 是**依赖包图边**（槽位所有者包），不是 cordis 服务名；服务名只写 `src/client/index.tsx` 的 `export const inject`。声明 `dsh.client` 后缺 `lib/client.js` 会让宿主激活期聚合抛错 ⇒ **build 必须先于安装**。
- 宿主类型面一律 type-only 导入 devDep（构建期擦除），导入清单与理由见 [`docs/host-api.md`](docs/host-api.md)「宿主类型导入清单」。
- 对外纪律：`@deepseek-ai/cordis`/`schemastery` 取宿主本体声明的线、`peerDependencies` 同版下限（pnpm 会把 `>=` 归一成成品版本号，加完须手工改回）；官方包一律 optional peer + devDep 同版兜底，`dependencies` 保持为空；两处 `engines.dsh` 同值、range 一律 `>=`；**不写 `@deepseek-ai/dsh` peer**（pnpm 默认 `autoInstallPeers: true`，缺失 peer 会被真装并拖入整棵 CLI 树）。

### 写 settings

细则与宿主源码引用见 [`docs/host-api.md`](docs/host-api.md) 的 settings 两节。

### 版本形态

判据与台阶链写法见 [`docs/versioning.md`](docs/versioning.md)。

## UI 无痕融合纪律

官方用导出组件就用同一组件；官方自绘且无同款导出原语就在本地逐字复刻其源码——数值零自造，只有数据、文本与业务逻辑属于我们。逐条见 [`docs/ui-fusion.md`](docs/ui-fusion.md)。

## 设计裁决索引

代码里看不出动机的前提按主题分组记在 [`docs/decisions.md`](docs/decisions.md)，改动对应模块前先读该组：

| 主题 | 条目 |
| --- | --- |
| 配置解析、填充与空壳字段 | [解析与填充](docs/decisions.md#解析与填充) |
| `excludes` 排除与动态列表 | [排除与列表](docs/decisions.md#排除与列表) |
| 模型参数来源与 id 匹配 | [参数来源](docs/decisions.md#参数来源) |
| 推理级别记忆的存取与剪枝 | [推理级别记忆](docs/decisions.md#推理级别记忆) |
| 子智能体推理级别 | [子智能体](docs/decisions.md#子智能体) |
| 档位自调 | [档位自调](docs/decisions.md#档位自调) |
| 重置 / 恢复的写回端点 | [写回端点](docs/decisions.md#写回端点) |
| 验证模型 | [验证](docs/decisions.md#验证) |
| 探测档位 | [探测档位](docs/decisions.md#探测档位) |
| 能力探测（图片输入 / 工具调用） | [能力探测](docs/decisions.md#能力探测) |
| 宿主接线与卡片行为 | [宿主与卡片](docs/decisions.md#宿主与卡片) |

## 命令

`pnpm typecheck` / `lint` / `test` / `build`；提交前必跑。只认这些已定义脚本、不得裸跑 bin，且必须直接在 shell 里执行、不得经 Node 子进程包裹 pnpm（细则见 [`docs/workflow.md`](docs/workflow.md)）。测试范围见其「测试规范」。

## 专题文档

| 文档 | 内容 |
| --- | --- |
| [`docs/decisions.md`](docs/decisions.md) | 设计裁决：代码里看不出动机的前提与理由 |
| [`docs/host-api.md`](docs/host-api.md) | 宿主契约：各面的实际用法与宿主源码引用 |
| [`docs/architecture.md`](docs/architecture.md) | 目录职责与数据流 |
| [`docs/ui-fusion.md`](docs/ui-fusion.md) | UI 无痕融合纪律 |
| [`docs/versioning.md`](docs/versioning.md) | 版本快照与冻结形态 |
| [`docs/workflow.md`](docs/workflow.md) | 命令、工具链陷阱与测试规范 |

`docs/` 下这些文件都不是构建产物，一律不进 `files`。
