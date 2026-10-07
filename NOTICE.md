# NOTICE — 第三方代码与许可

本项目在 `lib/` 下使用了两份以 MIT 许可证发布的第三方代码。
按 MIT 的要求，其版权声明随文件一起分发（见各文件头部），许可全文见仓库根目录的 [`LICENSE`](LICENSE)。

---

## 1. 水墨流体引擎 `lib/suminagashi.js`

第三方 MIT 水墨引擎的改编版。原始版权声明保留在该文件头部：

```
Portions copyright (c) 2026 Fisher
SPDX-License-Identifier: MIT
```

许可全文见 [`LICENSE`](LICENSE)。

**本项目做的改动**：将原 ESM `import * as THREE from 'three'` 改为使用全局 `THREE`（UMD 形式），
以便页面零构建、完全离线（双击 `index.html` 即可运行）；将 `Suminagashi` / `INKS` / `INK_KEYS`
暴露为全局，供 `src/app.js` 以经典脚本方式使用；新增 `clear()` 方法（原引擎无清屏能力）。
其余模拟逻辑（Navier–Stokes 流体解算、和纸减法混色）保持原样。

---

## 2. three.js `lib/three.min.js`

```
Copyright 2010-2022 Three.js Authors
SPDX-License-Identifier: MIT
```

以 UMD 形式本地化打包，用于离线运行，不向任何服务器发起请求。许可全文见 [`LICENSE`](LICENSE)。

---

## 3. 沙盒引擎 `lib/sandsim.js`（原创）

本文件为 **Franky100-pig** 的原创实现，从零编写，未复制任何第三方引擎代码。

```
Copyright (c) 2026 Franky100-pig
SPDX-License-Identifier: MIT
```

许可全文见 [`LICENSE`](LICENSE)。

---

## 本项目本身的许可

交互层（`src/`、`index.html`、`styles.css`、`sw.js` 等）由 **Franky100-pig** 原创并以 MIT 发布。
