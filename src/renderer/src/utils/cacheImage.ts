/**
 * 把远程封面/头像改写成同源的缓存代理地址。
 *
 * 主进程 `/media/cover` 会带 LRU 落盘；data:、/media 等本地地址原样返回。
 */
export function cachedImage(url: string | null | undefined): string {
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) return url;
  return `/media/cover?url=${encodeURIComponent(url)}`;
}
