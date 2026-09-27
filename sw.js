/* 墨息 · Ink Quiet — Service Worker（离线缓存，仅同源静态资源）
 *
 * 隐私立场不变：connect-src 'none'，本 SW 只缓存本站同名文件，不向任何外部域发请求。
 * 注册本身由 app.js 在 http(s) 下才触发，桌面 Electron（file://）跳过。
 */
const CACHE = 'ink-quiet-v1'
const ASSETS = [
  'index.html',
  'styles.css',
  'lib/three.min.js',
  'lib/suminagashi.js',
  'lib/sandsim.js',
  'src/app.js',
  'src/sound.js',
  'manifest.webmanifest',
  'icon.svg',
]

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  // 导航请求：network-first，保证更新能及时生效；离线或失败则回退缓存页
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    )
    return
  }

  // 静态资源：cache-first，离线可用
  e.respondWith(
    caches.match(req).then((r) =>
      r || fetch(req)
        .then((res) => { const cp = res.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); return res })
        .catch(() => r)
    )
  )
})
