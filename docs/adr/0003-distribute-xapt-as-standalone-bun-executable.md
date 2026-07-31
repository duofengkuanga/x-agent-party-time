---
status: accepted
---

# xapt 以包含 Bun 运行时的单文件程序分发

xapt 继续复用现有 TypeScript Runner 实现，并通过 Bun 的 standalone compile 能力生成不依赖用户预装 Node 或 Bun 的可执行文件；“不依赖 Node 环境”指用户只需下载和运行 xapt，不要求程序内部排除 JavaScript 运行时。这个选择用更大的二进制体积换取现有实现、测试和协议逻辑的复用，不为了运行时纯粹性立即将 Runner 重写为 Go 或 Rust。
