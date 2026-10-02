/* 墨息 · Ink Quiet — 短视频录制（离线）
 *
 * 把用户的“创作过程”录成一段约 15 秒的小视频（WebM / MP4）。
 * 设计立场：
 *   - 纯前端、零网络、零文件依赖——画面来自页面里的两块画布，编码用浏览器内置
 *     MediaRecorder + captureStream，没有任何上传或外部库。
 *   - “约 15 秒”是硬约束：无论用户实际画了 5 秒还是 5 分钟，导出都固定 ≈15s。
 *     做法：录制时以 ~10fps 把合成画面存成 JPEG 帧；导出时把 N 帧按索引映射到
 *     450 个输出帧（30fps × 15s），于是长过程被压缩、短过程被放慢。
 *   - 不评分、不裁剪、不失败：录太短只是温和提示，不会报错崩溃。
 */
(function () {
  'use strict'

  var OUT_FPS = 30            // 导出帧率
  var TARGET_SEC = 15         // 目标时长（秒）
  var TOTAL_FRAMES = OUT_FPS * TARGET_SEC   // 450 个输出帧
  var CAPTURE_FPS = 10        // 录制采样率
  var MAX_FRAMES = 1500       // 帧上限（≈2.5 分钟），超出不再追加，避免内存膨胀
  var LONGEST = 720           // 导出最长边（像素），缩小以加快编码、压低体积

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
      this._grab = grab
      return { ok: true }
    },

    // 由主循环每帧调用；内部节流到 ~10fps，并把合成画面存成 JPEG Blob。
    capture: function (src) {
      if (!this._rec || !src) return
      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
      if (now - this._lastCap < 1000 / CAPTURE_FPS) return
      this._lastCap = now
      if (this._frames.length >= MAX_FRAMES) return
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
      // toBlob 异步；录制期间很快完成，停止时窗口足够短
      this._capCv.toBlob(function (b) { if (b) self._frames.push(b) }, 'image/jpeg', 0.7)
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
      try { stream = out.captureStream(OUT_FPS) } catch (e) { return Promise.resolve({ ok: false, reason: 'capturestream', err: String(e) }) }
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
              octx.drawImage(bm, 0, 0, w, h)
              return sleep(frameMs)
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
