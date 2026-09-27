/* 墨息 · Ink Quiet — 环境音景（纯合成白噪声，零外部文件，完全离线）
 *
 * 为什么不用音频文件 / AI 作曲：
 *   - 同学 healing 项目里的 .mp3 是原创素材，复用需授权 → 不碰；
 *   - AI 作曲风格不稳，且偏离“安静”定位；
 *   - 用 Web Audio API 实时合成雨声 / 潮声（白·棕噪声 + 滤波器 + 缓慢 LFO），
 *     不发起任何网络请求、不写任何文件、不依赖任何素材，天然符合离线隐私承诺。
 */
(function () {
  'use strict'

  // 噪声缓冲：一次性生成，循环播放。棕噪声在缓冲首尾做极短淡入淡出，降低循环接缝的咔哒声。
  function makeNoiseBuffer(ctx, type) {
    const len = Math.floor(ctx.sampleRate * 4)   // 4 秒，足够长，接缝不易被察觉
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    if (type === 'brown') {
      let last = 0
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.5
      }
    } else { // white
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
    }
    // 首尾 20ms 淡变，软化循环接缝
    const fade = Math.floor(ctx.sampleRate * 0.02)
    for (let i = 0; i < fade; i++) {
      const g = i / fade
      d[i] *= g
      d[len - 1 - i] *= g
    }
    return buf
  }

  // 两个预置：各自描述用什么噪声、怎么染色、怎么“呼吸”。
  const PRESETS = {
    rain: {
      noise: 'white',
      build(ctx, src, out) {
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'; hp.frequency.value = 800
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'; lp.frequency.value = 6500
        // 轻微“沙沙”起伏，让雨声不那么死板
        const trem = ctx.createGain(); trem.gain.value = 0.9
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.7
        const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.12
        lfo.connect(lfoGain); lfoGain.connect(trem.gain)
        src.connect(hp); hp.connect(lp); lp.connect(trem); trem.connect(out)
        lfo.start()
        return [lfo]
      },
    },
    tide: {
      noise: 'brown',
      build(ctx, src, out) {
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'; lp.frequency.value = 520
        // 潮水起落：慢 LFO 调制总音量（约 9 秒一轮），再叠一层更长的大涌
        const swell = ctx.createGain(); swell.gain.value = 0.5
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11
        const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.45
        lfo.connect(lfoGain); lfoGain.connect(swell.gain)
        const lfo2 = ctx.createOscillator(); lfo2.frequency.value = 0.035
        const lfo2Gain = ctx.createGain(); lfo2Gain.gain.value = 0.2
        lfo2.connect(lfo2Gain); lfo2Gain.connect(swell.gain)
        src.connect(lp); lp.connect(swell); swell.connect(out)
        lfo.start(); lfo2.start()
        return [lfo, lfo2]
      },
    },
  }

  const S = {
    ctx: null,
    master: null,
    current: 'off',
    volume: 0.5,
    nodes: [],      // 当前预置的源 + 振荡器，切预置时停掉
    stopTimer: 0,
  }

  function ensureCtx() {
    if (!S.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      S.ctx = new AC()
      S.master = S.ctx.createGain()
      S.master.gain.value = S.volume * 0.6   // 整体压低，保持安静
      S.master.connect(S.ctx.destination)
    }
    return S.ctx
  }

  function stopNodes() {
    S.nodes.forEach((n) => { try { n.stop && n.stop() } catch (e) {}; try { n.disconnect() } catch (e) {} })
    S.nodes = []
  }

  function rampMaster(ctx, to, t) {
    const now = ctx.currentTime
    S.master.gain.cancelScheduledValues(now)
    S.master.gain.setValueAtTime(Math.max(0.0001, S.master.gain.value), now)
    S.master.gain.linearRampToValueAtTime(to, now + t)
  }

  function start(name) {
    clearTimeout(S.stopTimer)
    const ctx = ensureCtx()
    if (!ctx) return false
    if (ctx.state === 'suspended') ctx.resume()
    stopNodes()
    const preset = PRESETS[name]
    if (!preset) return false
    const src = ctx.createBufferSource()
    src.buffer = makeNoiseBuffer(ctx, preset.noise)
    src.loop = true
    const extra = preset.build(ctx, src, S.master)
    S.nodes = [src].concat(extra || [])
    src.start()
    S.current = name
    rampMaster(ctx, S.volume * 0.6, 0.25)   // 缓入，避免咔哒
    return true
  }

  function stop() {
    if (S.ctx && S.master) rampMaster(S.ctx, 0.0001, 0.25)  // 缓出
    clearTimeout(S.stopTimer)
    S.stopTimer = setTimeout(stopNodes, 300)
    S.current = 'off'
  }

  function setVolume(v) {
    S.volume = Math.min(1, Math.max(0, v))
    if (S.ctx && S.master && S.current !== 'off') rampMaster(S.ctx, S.volume * 0.6, 0.1)
  }

  window.Soundscape = {
    presets: ['off', 'rain', 'tide'],
    start, stop, setVolume,
    setPreset(name) { if (name === 'off') stop(); else start(name) },
    current() { return S.current },
    get volume() { return S.volume },
  }
})()
