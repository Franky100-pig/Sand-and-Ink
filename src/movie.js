/* 墨息 · Ink Quiet — 短视频录制（离线）
 *
 * 把用户的“创作过程”录成一段约 15 秒的小视频（优先 MP4，退而 WebM）。
 * 设计立场：
 *   - 纯前端、零网络、零文件依赖——画面来自页面里的两块画布，编码用浏览器内置
 *     MediaRecorder + captureStream，没有任何上传或外部库。
 *   - “约 15 秒”是硬约束：无论用户实际画了 5 秒还是 5 分钟，导出都固定 ≈15s。
 *     做法：录制时把合成画面存成 JPEG 帧；导出时把 N 帧按索引映射到 450 个输出帧
 *     （30fps × 15s），于是长过程被压缩、短过程被放慢。
 *   - 采样从满 30fps 起步：源帧数 ≥ 输出帧数（450）时，每张输出帧都拿到不同的源帧，
 *     画面顺滑。缓冲到上限就抽稀一半并把间隔翻倍，于是内存严格有界、录制时长不受限，
 *     代价只是「近处密、远处疏」的延时摄影节奏。
 *     固定低采样率会让每帧被重复播放多次，成片看起来「一帧一帧」。
 *   - 输出帧用 requestFrame() 精确产出，不靠 30fps 采样器轮询，避免重复/漏帧。
 *   - 不评分、不裁剪、不失败：录太短只是温和提示，不会报错崩溃。
 */
(function () {
  'use strict'

  var OUT_FPS = 30            // 导出帧率
  var TARGET_SEC = 15         // 目标时长（秒）
  var TOTAL_FRAMES = OUT_FPS * TARGET_SEC   // 450 个输出帧
  var FRAME_BUDGET = 1200     // 帧缓冲上限（≈40 秒 @30fps；JPEG 约 50MB）
  // 起始采样间隔 = 30fps。特意减 1ms：rAF 步长约 16.67ms，两个步长正好是 33.33ms，
  // 卡在阈值上会因浮点误差时常判不过，实际掉到 ~25fps。留 1ms 余量可稳定拿到 30fps。
  var MIN_INTERVAL = 1000 / OUT_FPS - 1
  var LONGEST = 720           // 导出最长边（像素），缩小以加快编码、压低体积

  function nowMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now())
  }

  // 抽稀：保留偶数帧（时间上均匀）+ 最新一帧，长度约减半。
  // 最新帧必须留 —— 否则抽稀会把刚画完的状态丢掉。
  function thinFrames(frames) {
    var n = frames.length
    if (n <= 2) return frames.slice()
    var kept = []
    for (var i = 0; i < n; i += 2) kept.push(frames[i])
    if (kept[kept.length - 1] !== frames[n - 1]) kept.push(frames[n - 1])
    return kept
  }

  function supported() {
    return (typeof MediaRecorder !== 'undefined') &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function'
  }

  // 编码格式候选：MP4(H.264) 优先——最常见，相册 / 微信 / iOS 直接能播能转，
  // 也免得手机上还要拿 WebM 去转码。浏览器不支持就逐级退到 WebM：
  // Safari / Chrome / Edge 会用上 MP4，Firefox 只支持 WebM，会自动落到后三个。
  var MIME_CANDS = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ]

  function pickMime() {
    if (!supported()) return null
    for (var i = 0; i < MIME_CANDS.length; i++) {
      try { if (MediaRecorder.isTypeSupported(MIME_CANDS[i])) return MIME_CANDS[i] } catch (e) {}
    }
    return null
  }

  // isTypeSupported 有时过于乐观（报 true 但构造失败），所以逐个真造一次，
  // 哪个真的能建起来就用哪个。全都不行返回 null。
  function chooseRecorder(stream) {
    for (var i = 0; i < MIME_CANDS.length; i++) {
      var m = MIME_CANDS[i]
      try { if (!MediaRecorder.isTypeSupported(m)) continue } catch (e) { continue }
      try {
        return { rec: new MediaRecorder(stream, { mimeType: m, videoBitsPerSecond: 4000000 }), mime: m }
      } catch (e2) { /* 这个格式建不起来，试下一个 */ }
    }
    return null
  }

  function blobToBitmap(b) {
    if (window.createImageBitmap) return window.createImageBitmap(b)
    return new Promise(function (res, rej) {
      var img = new Image()
      img.onload = function () { res(img) }
      img.onerror = rej
      img.src = URL.createObjectURL(b)
    })
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

  var Movie = {
    _rec: false,
    _frames: [],          // 录制期间累积的 JPEG Blob
    _lastCap: 0,
    _grab: null,          // 提供合成画布的回调
    _capCv: null,
    _capCtx: null,

    supported: supported,
    isRecording: function () { return this._rec },
    frameCount: function () { return this._frames.length },

    // 格式候选顺序（测试用）：MP4 必须排在 WebM 前面
    _candidates: MIME_CANDS,
    _pickMime: pickMime,
    // 抽稀 / 帧预算（测试用）
    _thinFrames: thinFrames,
    _frameBudget: FRAME_BUDGET,
    _minInterval: MIN_INTERVAL,

    // 缓冲满了就抽稀一半，并把采样间隔翻倍：内存严格有界，录制时长不受限。
    // 副产物是「近处密、远处疏」—— 开头快速掠过、收尾更接近真实速度，正合适。
    _thin: function () {
      this._frames = thinFrames(this._frames)
      this._interval *= 2
    },

    // 把源帧索引映射到 450 个输出帧（最近邻）。N<=1 时恒为 0。供测试与编码共用。
    _mapIndex: function (i, n) {
      if (n <= 1) return 0
      return Math.min(n - 1, Math.floor(i / (TOTAL_FRAMES - 1) * (n - 1)))
    },

    start: function (grab) {
      if (!supported()) return { ok: false, reason: 'unsupported' }
      this._rec = true
      this._frames = []
      this._lastCap = 0
      this._t0 = nowMs()
      this._pending = false
      this._interval = MIN_INTERVAL
      this._grab = grab
      return { ok: true }
    },

    // 由主循环每帧调用；按 _interval 节流（满 30fps 起步，缓冲满后逐次减半），
    // 把合成画面存成 JPEG Blob。
    capture: function (src) {
      if (!this._rec || !src || this._pending) return
      var now = nowMs()
      if (now - this._lastCap < this._interval) return
      this._lastCap = now
      var w = src.width || 800, h = src.height || 600
      var scale = Math.min(1, LONGEST / Math.max(w, h))
      var cw = Math.max(2, Math.round(w * scale))
      var ch = Math.max(2, Math.round(h * scale))
      if (!this._capCv) {
        this._capCv = document.createElement('canvas')
        this._capCtx = this._capCv.getContext('2d')
      }
      this._capCv.width = cw
      this._capCv.height = ch
      try { this._capCtx.drawImage(src, 0, 0, cw, ch) } catch (e) { return }
      var self = this
      // toBlob 异步。同一时刻只允许一个在途，保证 push 顺序与抓取顺序一致
      // （否则高采样率下回调可能乱序，成片会跳针）。
      this._pending = true
      this._capCv.toBlob(function (b) {
        self._pending = false
        if (!b) return
        self._frames.push(b)
        if (self._frames.length >= FRAME_BUDGET) self._thin()
      }, 'image/jpeg', 0.7)
    },

    stop: function () {
      if (!this._rec) return Promise.resolve({ ok: false, reason: 'not-recording' })
      this._rec = false
      var frames = this._frames
      this._frames = []
      if (!supported()) return Promise.resolve({ ok: false, reason: 'unsupported' })
      if (frames.length < 2) return Promise.resolve({ ok: false, reason: 'too-short', count: frames.length })
      if (!pickMime()) return Promise.resolve({ ok: false, reason: 'no-mime' })
      return encode(frames)
    }
  }

  // 把 N 帧重新定时为 450 输出帧（≈15s），实时绘制进输出画布并由 MediaRecorder 采集。
  function encode(frames) {
    return blobToBitmap(frames[0]).then(function (first) {
      var w = first.width, h = first.height
      if (first.close) first.close()
      var out = document.createElement('canvas')
      out.width = w
      out.height = h
      var octx = out.getContext('2d')
      var stream
      try { stream = out.captureStream(0) } catch (e) { return Promise.resolve({ ok: false, reason: 'capturestream', err: String(e) }) }
      // captureStream(0) = 只有 requestFrame() 时才产出一帧 —— 每张画上去的画面都精确变成一帧视频，
      // 不会被 30fps 采样器重复或漏掉（编码耗时抖动会让它重复采样同一帧，是画面「顿」的第二个来源）。
      // 不支持 requestFrame 的浏览器退回按帧率自动采样。
      var track = stream.getVideoTracks && stream.getVideoTracks()[0]
      var manual = !!(track && typeof track.requestFrame === 'function')
      if (!manual) {
        try { stream = out.captureStream(OUT_FPS) } catch (e) { return Promise.resolve({ ok: false, reason: 'capturestream', err: String(e) }) }
      }
      // 优先 MP4，构造失败自动退到下一个候选（见 MIME_CANDS）
      var picked = chooseRecorder(stream)
      if (!picked) return Promise.resolve({ ok: false, reason: 'mediarecorder' })
      var rec = picked.rec
      var mime = picked.mime

      var chunks = []
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data) }
      var stopped = new Promise(function (res) { rec.onstop = res })

      rec.start(100)

      // 解码 LRU 缓存：避免一次性解码上千帧撑爆内存
      var cache = new Map()
      var MAXC = 24
      function getB(idx) {
        if (cache.has(idx)) {
          var b = cache.get(idx)
          cache.delete(idx)
          cache.set(idx, b)
          return Promise.resolve(b)
        }
        return blobToBitmap(frames[idx]).then(function (bm) {
          cache.set(idx, bm)
          if (cache.size > MAXC) {
            var k = cache.keys().next().value
            var old = cache.get(k)
            cache.delete(k)
            if (old.close) old.close()
          }
          return bm
        })
      }

      var n = frames.length
      var frameMs = 1000 / OUT_FPS
      var chain = Promise.resolve()
      for (var i = 0; i < TOTAL_FRAMES; i++) {
        (function (ii) {
          chain = chain.then(function () {
            var si = Movie._mapIndex(ii, n)
            return getB(si).then(function (bm) {
              var t0 = nowMs()
              octx.drawImage(bm, 0, 0, w, h)
              if (manual) { try { track.requestFrame() } catch (e) {} }
              // 扣掉解码 / 绘制耗时，让 450 帧真的落在 ≈15 秒上
              return sleep(Math.max(0, frameMs - (nowMs() - t0)))
            })
          })
        })(i)
      }

      return chain.then(function () {
        rec.stop()
        return stopped
      }).then(function () {
        cache.forEach(function (b) { if (b.close) b.close() })
        cache.clear()
        if (!chunks.length) return { ok: false, reason: 'empty' }
        var blob = new Blob(chunks, { type: mime })
        var ext = (mime.indexOf('mp4') >= 0) ? 'mp4' : 'webm'
        var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        var name = 'ink-quiet-movie-' + ts + '.' + ext
        var url = URL.createObjectURL(blob)
        var a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(function () { URL.revokeObjectURL(url) }, 8000)
        return { ok: true, name: name, size: blob.size, frames: n, seconds: TARGET_SEC }
      })
    })
  }

  window.Movie = Movie
})()
