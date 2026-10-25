/** Shared model-ID route heuristic for aggregator-backed providers. */
export function logicalProviderOf(provider: string, model: string): string {
    const slash = model.indexOf('/')
    return slash > 0 ? model.slice(0, slash) : provider
}
