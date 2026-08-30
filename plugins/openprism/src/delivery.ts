/**
 * 简报投递适配（D7/D8）：微信通道（im-bridge）没有跨插件服务缝——按 workbench 的
 * 同款结论，OpenPrism 提供通用的 webhook 投递缝：任何能收 HTTP POST 的通道
 * （im-bridge fork 暴露的 HTTP、企业微信 bot、Bark、ntfy 等）都可以接上。
 *
 * - 未配置 OPENPRISM_DELIVERY_WEBHOOK 时为 no-op（简报仍落盘，会话内可见）；
 * - 投递失败只 warn，不影响简报生成（D7：投递是增强，不是依赖）。
 *
 * @module openprism/delivery
 */

export interface DeliveryPort {
  /** 投递一份简报；返回是否成功（未配置端口返回 false）。 */
  deliver(title: string, path: string, markdown: string): Promise<boolean>
}

export function noopDelivery(): DeliveryPort {
  return { deliver: async () => false }
}

/** webhook 投递：POST {title, path, markdown, source:'openprism'} 到配置的 URL。 */
export function webhookDelivery(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): DeliveryPort {
  return {
    async deliver(title, path, markdown) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'openprism', title, path, markdown }),
        })
        return response.ok
      } catch (error) {
        console.warn(`openprism: 简报投递失败（${String(url)}）：${String(error)}`)
        return false
      }
    },
  }
}

export function resolveDelivery(): DeliveryPort {
  const url = process.env.OPENPRISM_DELIVERY_WEBHOOK
  return url !== undefined && url.length > 0 ? webhookDelivery(url) : noopDelivery()
}
