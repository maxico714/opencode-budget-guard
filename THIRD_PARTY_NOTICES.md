# Third-party notices

This package has **no runtime dependencies**. It imports only Node.js built-in modules
(`node:crypto`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`, `node:readline`, `node:url`).

The following packages are development-only and are not shipped in the published tarball's dependency
graph. Their licences are reproduced by reference to their published metadata.

| Package            | Version | Licence    | Purpose                                                                |
| ------------------ | ------- | ---------- | ---------------------------------------------------------------------- |
| `@opencode/plugin` | 2.1.2   | MIT        | Type definitions used for `satisfies Plugin.Plugin` (type-only import) |
| `@types/node`      | 24.19.2 | MIT        | Node.js type definitions                                               |
| `oxlint`           | 1.89.0  | MIT        | Linter                                                                 |
| `prettier`         | 3.9.10  | MIT        | Formatter                                                              |
| `typescript`       | 5.9.3   | Apache-2.0 | Compiler and type checker                                              |

No third-party source code, assets, fonts or data are vendored into this repository. Fixtures and
examples were written for this project.
