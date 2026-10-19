/** 浏览器半入口（dsh.client 声明的 web 侧 cordis 插件）。宿主 settings 面为 ctx.configForms，经 makeScope 包装后供卡片与记忆监听消费。
 * 五个席位一律经 `ctx.slots.inject` 注册：对无声明方的席位只挂一个 pending wait（声明到达才跑回调，fiber 卸载即取消），故缺席者静默不发生；向未声明的 slot 直接 register 会抛 `slot "..." is not declared`，且该抛错发生在 fiber 启动期、连累同一 fiber 里后续的全部注册。
 * 其中两席在此直接注册；另三个 slot 承载的四个部件受「UI 与行为」组支配，由 visibility.tsx 编排挂载与卸载 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// ctx.slots 服务面（SlotRegistry）
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// ctx.locale 服务面
import type {} from '@deepseek-ai/dsh-client-locale/client'
// ctx.configForms 服务面 + ConfigForm 类型
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Connection RPC 调用面（宿主真类型，type-only）
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
// SlotMap 的 'settings.models.footer' 键声明合并
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// SlotMap 的 'plugins.bundle.config' / 'plugins.row.config' 键声明合并（宿主 ui-plugin-manager 类型面）
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// SlotMap 的 'conversation.input.left' 键声明合并（输入框工具行 list 席位，无 owner props）
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Card } from '@/client/card'
import { en } from '@/client/locale-en'
import { CARD_NS } from '@/client/locale-keys'
import { zh } from '@/client/locale-zh'
import { makeRpcCarrier } from '@/client/rpc-carrier'
import { applyEffortMemoryListener } from '@/client/memory-listener'
import { applyLocalePatch } from '@/client/locale-patch'
import { applyLocaleReporter } from '@/client/effort-name'
import { API_NS as PI_AI_NS, PLUGIN_NAME, PLUGIN_NS as MODEL_FIX_NS } from '@/shared/constants'
import { decodeSection } from '@/client/model'
import type { Flags } from '@/client/model'
import { makeScope, type DecodedScope } from '@/client/scope'
import { applySlotVisibility } from '@/client/visibility'
import { decodeHostModelSelection, HOST_MODEL_SELECTION_NS, type HostModelSelectionView } from '@/client/composer'

/** 提供方 scope 的解码占位值：本卡只消费 snapshot.user（原始用户层），value 无用途；decode 必须永不返回 undefined */
const PROVIDERS_VIEW: readonly unknown[] = []

export const name = PLUGIN_NAME
export const inject = ['slots', 'locale', 'connection']

export function apply(ctx: ClientContext): void {
    // 宿主 get 只收一个 entryId 参数（无 decode spec），段值解码由 makeScope 的 decode 完成
    ctx.inject(['configForms', 'connection'], (child) => {
        const configForms = child.get('configForms') as { get: (ns: string) => ConfigForm<unknown> }
        // connection 已在父级 inject 中声明（必然存在）；rpc 与整套编排同取 child，落在同一 fiber
        const rpc = (child.get('connection') as unknown as { rpc: ClientConnectionRpc }).rpc
        boot(child,
            makeScope(configForms.get(MODEL_FIX_NS), decodeSection),
            makeScope(configForms.get(PI_AI_NS), () => PROVIDERS_VIEW),
            makeScope(configForms.get(HOST_MODEL_SELECTION_NS), decodeHostModelSelection),
            rpc,
        )
    })
}

/** 编排体：词典注册、调用面接线、席位注册、记忆监听子 fiber。
 * `ctx` 是子 fiber 的 ctx（`apply` 里那个 `ctx.inject` 的 child）：注册一律挂它，子 fiber 卸载即级联撤销；挂父 ctx 则卸载不清理、重建时重复注册（理由见 docs/decisions.md「宿主与卡片」） */
function boot(
    ctx: ClientContext,
    scope: DecodedScope<Flags>,
    providersScope: DecodedScope<readonly unknown[]>,
    hostModelScope: DecodedScope<HostModelSelectionView>,
    rpc: ClientConnectionRpc,
): void {
    // 词典注册返回 disposer；经 effect 挂载，卸载/HMR 时自动撤销
    ctx.effect(() => ctx.locale.register(CARD_NS, { zh, en }), `${name}: card dictionaries`)
    // scope 的 form 订阅释放挂入本 fiber
    ctx.effect(() => () => { scope.dispose(); providersScope.dispose(); hostModelScope.dispose() }, `${name}: scope disposal`)
    // 浏览器半调 Node 半的全部出口（三个写回端点 + 三条诊断链的读流）见 rpc-carrier.ts
    const { forceUpdate, resetModels, restoreModels, verifyModels, probeEfforts, probeCapabilities } =
        makeRpcCarrier(rpc)
    // 五席共用的卡片入参：载体与 scope 逐席相同
    const cardProps = {
        scope,
        providersScope,
        forceUpdate,
        resetModels,
        restoreModels,
        verifyModels,
        probeEfforts,
        probeCapabilities,
    }
    // 插件详情页的配置段：keyed 按 entryKey 分发，key 是 npm 包名（不是 patch 条目 id）
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: name,
        locale: CARD_NS,
    }, (props) => <Card {...props} defaultOpen {...cardProps} />))
    // patch 声明的组件实例自己的配置页：key = `<npm 包名>#<patch 条目 id>`（宿主 rowConfigKey 拼接）。
    // 注册后「包含的组件」里该实例的 title 变为可点按钮，进入组件详情页；不注册则 title 是纯文本。
    // 与 bundle 席位共用同一张卡（单实例 bundle 两层 UI 同体）
    ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${name}#${MODEL_FIX_NS}`,
        locale: CARD_NS,
    }, (props) => <Card {...props} defaultOpen {...cardProps} />))
    // 三个 slot 上四个部件的挂载与卸载编排：受「UI 与行为」组支配，开=挂载、关=撤销条目（真卸载）
    applySlotVisibility(ctx, scope, cardProps, { scope, hostModelScope, providersScope })

    // 每模型推理级别记忆的运行时监听见 memory-listener.ts
    applyEffortMemoryListener(ctx, scope)
    // 界面语言上报：Node 半换名依赖它补齐自动探测的盲区，见 effort-name.ts
    applyLocaleReporter(ctx)
    // 宿主 Default 词条 patch：Scope 订阅挂进本 fiber，随卸载自动恢复原状，见 locale-patch.ts
    applyLocalePatch(ctx, scope)
}
