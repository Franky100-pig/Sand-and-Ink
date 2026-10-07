/* 墨息 · Ink Quiet — Service Worker（离线缓存，仅同源静态资源）
 *
 * 隐私立场不变：connect-src 'none'，本 SW 只缓存本站同名文件，不向任何外部域发请求。
 * 注册本身由 app.js 在 http(s) 下才触发，桌面 Electron（file://）跳过。
 *
 * ⚠️ 维护约定：只要改了下面 ASSETS 里任何一个文件的内容或清单，
 *    必须同时把 CACHE 的版本号 +1。原因见下面 install / fetch 的注释。
 */
const CACHE = 'ink-quiet-v4'
const ASSETS = [
  'index.html',
  'styles.css',
  'lib/three.min.js',
  'lib/suminagashi.js',
  'lib/sandsim.js',
  'src/app.js',
  'src/sound.js',
  'src/movie.js',
  'manifest.webmanifest',
  'icon.svg',
]

self.addEventListener('install', (e) => {
  // 逐个 fetch 而不是 addAll，两个原因：
  //  1) `cache: 'reload'` 绕过 HTTP 缓存 —— 否则预缓存可能把浏览器/CDN 缓存的**旧副本**
  //     当成新资源塞进新缓存（GitHub Pages 的 max-age=600 会让这件事真的发生）。
  //  2) addAll 是原子的：任一文件失败整次安装就作废、旧 SW 继续留任；逐个来则单个失败无妨。
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ASSETS.map((u) =>
        fetch(new Request(u, { cache: 'reload' }))
          .then((res) => { if (res && res.ok) return c.put(u, res) })
          .catch(() => {})
      )))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  // 换 CACHE 名字后，这里会把所有旧版本缓存删干净。
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  // 导航请求：network-first，保证页面本身能及时更新；离线或失败则回退缓存页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    )
    return
  }

  // 静态资源：stale-while-revalidate。
  // 先用缓存立刻响应（离线可用），同时在后台拉一份新的写回缓存。
  // 这样即使 sw.js 字节没变、浏览器不重装 SW，下一次打开也能拿到新版本 ——
  // 修复「index.html 是新的、app.js 还是旧的」这类半新半旧的问题（2026-10-02 实录）。
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const cp = res.clone()
            caches.open(CACHE).then((c) => c.put(req, cp))
          }
          return res
        })
        .catch(() => cached)
      return cached || fresh
    })
  )
})
