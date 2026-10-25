/** 聚合器的逻辑渠道名：模型 ID 第一个 `/` 前的段（如 `wb/cn:deepseek-v4.1-flash` → `wb`）；无前缀回退实际 provider。
 * 只用于分组、短路与展示，不改发给宿主的完整模型 ID。 */
export function logicalProviderOf(provider: string, model: string): string {
    const slash = model.indexOf('/')
    return slash > 0 ? model.slice(0, slash) : provider
}
