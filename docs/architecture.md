# 目录职责与数据流

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | Node 半入口：`Config` schema + 单一 `apply`（备份 → 配置源与段变更接线 → 各功能安装 → 启动链） |
| `src/config.ts` | 配置解析（快照优先级）与配置源持有 |
| `src/migrate.ts` | 启动迁移、旧快照清理与自愈（排除列表去重） |
| `src/upgrade.ts` | 冻结的升级台阶链（v7 → 当前版） |
| `src/catalog.ts` | models.dev 目录拉取、缓存读写与拍平索引 |
| `src/lookup.ts` | 模型 id 匹配（三级归一）与档位转换 |
| `src/compat.ts` | 路由 compat 纯写入计划 |
| `src/fix.ts` | 填充与写回：纯计划函数 `planFill` 出 op，`fix` 只做编排 |
| `src/memory.ts` | 推理级别记忆的失效清理：存活清单 → 纯 `planPruneMemory` → 只写 `efforts` 键 |
| `src/empty.ts` | 空壳字段判据 `stripEmptyFields`，所有写回路径共用 |
| `src/reset.ts` | 重置推理级别（仅剔除 `reasoningEfforts`） |
| `src/restore.ts` | 启动备份捕获与恢复 |
| `src/guard.ts` | 事件流守卫：写回期间短路整条事件链 |
| `src/host.ts` | settings 写回必经的 `queueTask` 收口（HMR 事务感知） |
| `src/section.ts` | settings 节读取收口（读不到一律 `undefined`） |
| `src/writeback.ts` | 写回 `llm-pi-ai` 段的统一外壳（计划 → 写回 → 冲突限次重试） |
| `src/probe-verdict.ts` | 验证与探测共用的判定层（失败分类、两级短路判据） |
| `src/probe-plan.ts` | 共用的计划层（入参校验、展开、分组、配额） |
| `src/probe-route.ts` | 聚合器逻辑渠道推导：模型 ID 首段前缀 → 渠道名，供分组、短路与汇总共用 |
| `src/probe-report.ts` | 共用的汇报层（逐逻辑渠道结论、全局统计） |
| `src/probe-engine.ts` | 共用执行引擎（单次请求受理判定、并发、进度帧） |
| `src/verify.ts` | 「验证模型」执行器（只读） |
| `src/probe.ts` | 「探测档位」执行器：兜底备份 → 预声明 → 逐档探测 → 收敛写回 |
| `src/fill.ts` | 探测档位的两次写回（预声明 / 收敛） |
| `src/probe-backup.ts` | 探测的崩溃兜底：备份与启动回退 |
| `src/rpc.ts` | 三个写回端点 + 两条 SSE 进度流端点（channel 自注册） |
| `src/rpc-route.ts` | RPC 信封解码与路由分发 |
| `src/refresh.ts` | 目录保鲜刷新（窗口过期才拉取，失败限次重试） |
| `src/official-filter.ts` | 「隐藏官方API」：遮蔽 `listModels`，未配密钥返回空清单 |
| `src/effort-name.ts` | 档位名本地化：遮蔽 `resolveModelInfo`，按开关 + 界面语言换显示名 |
| `src/subagent.ts` | 「跟随父智能体」：`agent/request` 瀑布最外层按三条件改写路由 |
| `src/self-tune.ts` | 「自主调节档位」：装/卸两枚工具与一段系统提示词 |
| `src/types.ts` | 当前版本配置形态与冻结的旧版类型 |
| `src/constants.ts` | Node 半常量 |
| `src/shared/` | 跨半共享层（零 Node 依赖）：常量、`errorText`、探测/验证契约、当前版本配置 schema 与行键表 |
| `src/client/index.tsx` | 浏览器半入口：席位注册、卡片、词典、调用面接线、scope 释放，全挂 `configForms` 子 fiber |
| `src/client/card.tsx` | 五席共用的可折叠卡片外壳（草稿与保存、写回动作、瓦片与弹层挂接） |
| `src/client/tile.tsx` | 瓦片层：布尔矩阵组 / 动态排除集合两种形态 |
| `src/client/card-meta.tsx` | 卡片联系行（仓库 / 版本 / 反馈） |
| `src/client/card-styles.ts` | 卡片样式层：全部样式数值的唯一出处 |
| `src/client/confirm.tsx` | 四层二次确认的共用外壳 |
| `src/client/diagnose-dialog.tsx` | 验证 / 探测弹层的共用外壳（双选项卡 + 记录区） |
| `src/client/probe-dialog.tsx` | 探测弹层组装层 |
| `src/client/card-verify.ts` | 验证的整轮编排 hook |
| `src/client/card-probe.ts` | 探测的整轮编排 hook |
| `src/client/card-records.ts` | 两条诊断记录区的纯文案层 |
| `src/client/card-notice.ts` | 卡片状态行助手 |
| `src/client/composer.tsx` | 输入框工具行的「模型优化」入口与「跟随」状态灯 |
| `src/client/model.ts` | 快照↔配置纯映射（候选拍取、收敛目标、未填充判据） |
| `src/client/effort.ts` | 记忆纯逻辑（查表、写后形态、档位公告判定） |
| `src/client/scope.ts` | ConfigForm 的 decode 与写回转发包装 |
| `src/client/memory-listener.ts` | 记忆存取监听（换模型恢复、换级别写回 + 自动设置） |
| `src/client/rpc-carrier.ts` | 浏览器半调 Node 半的唯一出口 |
| `src/client/effort-name.ts` | 浏览器界面语言上报（补 Node 侧探测盲区） |
| `src/client/locale-patch.ts` | 宿主 model NS 词典的 Default 词条本地化 |
| `src/client/locale-keys.ts` | 卡片文案键契约（键并入宿主 `LocaleNamespaceMap`） |
| `src/client/locale-zh.ts` `locale-en.ts` | 卡片词典（中 / 英） |
| `src/client/visibility.tsx` | 「UI 与行为」组：三个 slot 上四个部件的挂载 / 卸载 |
| `public/models-cache.json` | 构建期复制进 `lib/` 的目录缓存（首启离线可用） |
| `icon.svg` `cordis.patch.yml` `locale/*.json` | 包根静态资源，不经 tsdown；补丁行 `id` 即 settings 命名空间键 |

## 数据流

- 段变更按 ns 分流：自有段「自愈 → 填充 → 记忆清理」，llm-pi-ai 段「填充 → 保鲜刷新 → 记忆清理」，入口先判事件流守卫。
- 记忆三条链：浏览器半 `memory-listener` 管存取；Node 半 `memory.ts` 按宿主全量模型列表做失效清理；三条诊断链路（验证只读 / 探测档位写回 / 能力探测）共用 probe 四层，进度走 SSE。
- 请求期链：`agent/request` 瀑布判定「跟随父智能体」；工具链：`self-tune` 按开关装/卸注入面。两者均不写配置。
- 只读遮蔽支线：`official-filter` 遮 `listModels`、`effort-name` 遮 `resolveModelInfo`，判定逐次现算，不挂事件。

## 文档纪律

`docs/` 下文件不是构建产物，不进 `files`。索引见 `AGENTS.md`「专题文档」。
