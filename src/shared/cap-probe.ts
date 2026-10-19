/**
 * 「能力探测」（图片输入 / 工具调用）的跨半契约：能力标识、三态结论与逐条结论形状。
 * 放共享层是供浏览器半渲染记录行与开关（浏览器半不能反向 import Node 半）。
 * 只有类型与纯常量，零 Node 依赖；wire 层与判定矩阵在 Node 半 `src/probe-caps.ts`。
 */

/** 能力标识：图片输入 / 工具调用（v1 就这两种，新增能力在此扩） */
export type CapId = 'image' | 'tool'

/** 能力取值全集（有序，弹层勾选与计划展开共用） */
export const CAP_IDS: readonly CapId[] = ['image', 'tool']

/** 能力结论三态：支持 / 不支持 / 未得出结论。判定矩阵见 src/probe-caps.ts，裁决见 docs/decisions.md「能力探测」 */
export type CapResult = 'supported' | 'unsupported' | 'unknown'

/** 一条能力探测的结论：三态 + 原因（原始 status + 有界错误体摘要，或 `dialect-scope` / `no-credential` 等稳定标记）。密钥与请求头永不入此对象 */
export interface CapProbeVerdict {
    capability: CapId
    result: CapResult
    /** 仅 `unsupported` / `unknown` 携带；`supported` 无原因 */
    reason?: string
}

/** 一轮能力探测的三态计数（终帧汇总用；逐条明细仍在 `VerifySummary.results`） */
export interface CapTally {
    supported: number
    unsupported: number
    unknown: number
}
