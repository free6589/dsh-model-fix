/**
 * 「能力探测」的写回层：只动模型 `input` 图片模态一个字段——supported 补 `['text','image']`、明确判不支持（且「剔除不支持」开）删键。
 * 工具调用在 `llm-pi-ai` 模型 schema 没有对应字段，**只展示不写**；`reasoningEfforts` 一概不碰（更绝不写 `{}` 空壳——过不了 provider 校验会连累整批写入）。
 * 写回走 `writebackApi` 的冲突重读重算骨架 + `guardedWritebackApi` 守卫；无预声明故不需要 probeBackup 兜底。
 * 空壳清理照旧过 `stripEmptyFields`（凡重建模型条目的写回路径都过它，口径见 docs/decisions.md「解析与填充」）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { isPlainObject, providersOf } from '@/shared/types'
import { stripEmptyFields } from '@/empty'
import { guardedWritebackApi } from '@/writeback'
import { API_NS } from '@/shared/constants'
import { descriptorOf } from '@/section'

/** 写回只动这一个模型字段（与 fix.ts 的 `input` 图片模态同义） */
const INPUT_FIELD = 'input'

/** 图片输入受支持时写入的模态数组（`MODALITIES` 只有 text/image，见 docs/host-api.md「能力探测」） */
const INPUT_IMAGE: readonly string[] = ['text', 'image']

/** 一次图片模态改写：`set` = 补 `['text','image']`，`unset` = 删 `input` 键 */
export interface CapInputApply {
    provider: string
    model: string
    op: 'set' | 'unset'
}

/** 写入计划的结果：ops 与增删模型数（口径与 `ProbeFillResult` 对齐：models 为实际改动的模型数，added/removed 各按模型计） */
export interface CapInputPlan {
    modelOps: SettingsPathOp[]
    models: number
    added: number
    removed: number
}

/** `input` 是否已是 `['text','image']`（两个模态、无重复；MODALITIES 只有这两种，逐项存在即同集） */
function inputIsImage(value: unknown): boolean {
    return Array.isArray(value) && value.length === INPUT_IMAGE.length && INPUT_IMAGE.every((mod) => value.includes(mod))
}

/**
 * 图片模态改写计划（纯函数、可单测）：按 provider/model 落 `set`/`unset`，其余字段原样保留（重建后过 `stripEmptyFields` 清空壳）。
 * 目标态已达成（`set` 已是 `['text','image']`、`unset` 本就没键）即零变更零 op；范围只由 `entries` 决定（发跑时冻结的结论），
 * 遍历当次现读的 `providers`，entries 里已删目标自然不命中、不产 op。**绝不产出 `reasoningEfforts` 值**（含 `{}` 空壳）。
 */
export function planCapInput(
    providers: Record<string, unknown>,
    entries: readonly CapInputApply[],
): CapInputPlan {
    const wanted = new Map<string, CapInputApply['op']>()
    for (const entry of entries) wanted.set(JSON.stringify([entry.provider, entry.model]), entry.op)
    const modelOps: SettingsPathOp[] = []
    let models = 0
    let added = 0
    let removed = 0
    for (const [providerId, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider)) continue
        const list = provider.models
        if (!Array.isArray(list)) continue
        let next: Record<string, unknown>[] | undefined
        for (let i = 0; i < list.length; i++) {
            const model = list[i]
            if (!isPlainObject(model) || typeof model.id !== 'string') continue
            const op = wanted.get(JSON.stringify([providerId, model.id]))
            if (op === undefined) continue
            const current = model[INPUT_FIELD]
            if (op === 'set' && inputIsImage(current)) continue
            if (op === 'unset' && current === undefined) continue
            models++
            if (op === 'set') added++
            else removed++
            next ??= list.slice()
            const replaced = { ...model }
            if (op === 'set') replaced[INPUT_FIELD] = [...INPUT_IMAGE]
            else delete replaced[INPUT_FIELD]
            next[i] = stripEmptyFields(replaced)
        }
        if (next) modelOps.push({ op: 'set', path: ['providers', providerId, 'models'], value: next })
    }
    return { modelOps, models, added, removed }
}

/** 只算不写（「自动写入」关闭时的假设统计）：读最新段出计划即返回，不动 settings */
export function previewCapInput(ctx: Context, entries: readonly CapInputApply[]): CapInputPlan {
    const providers = providersOf(descriptorOf(ctx, API_NS)?.user)
    return planCapInput(providers ?? {}, entries)
}

/** 落盘：读最新段 → `planCapInput` 出计划 → 经 `writebackApi` 写 `llm-pi-ai`（守卫全程持有）；`SETTINGS_CONFLICT` 重读重算限次 */
export function applyCapInput(ctx: Context, entries: readonly CapInputApply[]): Promise<CapInputPlan> {
    return guardedWritebackApi(ctx, {
        label: '写入图片模态',
        // 段不可读即当「本就无可改写」静默早退（返回零计划，不打日志）
        unreadableProviders: () => ({ modelOps: [], models: 0, added: 0, removed: 0 }),
        plan: ({ providers }) => planCapInput(providers, entries),
        noChange: '写入图片模态：没有需要改写的图片模态',
        done: ({ models, added, removed }) => `写入图片模态完成：${models} 个模型、新增 ${added} 个、剔除 ${removed} 个`,
    })
}
