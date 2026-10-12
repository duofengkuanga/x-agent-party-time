export function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    if (
      error instanceof TypeError &&
      /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/u.test(
        error.message,
      )
    )
      return '未收到服务器响应，无法确认操作结果。请检查网络及服务是否可用，恢复连接后先核对当前记录，再决定是否重试。';
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
      return '请求已中断或等待超时，无法确认操作结果。请先核对当前记录，再决定是否重试。';
    if (/^Body exceeded [\d.]+\s*\w+ limit\./u.test(error.message))
      return '整次提交超过了服务端请求大小限制。请减少附件总大小；若附件均符合页面限制，请联系维护者检查上传配置。';
    if (error.name === 'UnrecognizedActionError' || error.name === 'ChunkLoadError')
      return '当前页面版本已失效。请先复制保留已填写内容，再刷新页面重新操作；如已提交，请先核对当前记录。';
    if (error.message === 'An unexpected response was received from the server.')
      return '服务器未返回可识别的处理结果。请先核对当前记录；若仍有问题，请将操作时间和页面地址提供给维护者检查服务日志。';
  }
  return `${fallback} 请先核对当前记录；若仍有问题，请将操作时间和页面地址提供给维护者检查。`;
}
