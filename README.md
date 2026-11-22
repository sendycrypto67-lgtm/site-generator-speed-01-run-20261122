# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sendycrypto67-lgtm/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sendycrypto67-lgtm/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0 static site generator: `run(input)` returns the exact same output tree, byte for byte, on every case, but runs several times faster.

## How it is faster

- Templates are compiled once per case into plain JavaScript functions (via code generation), instead of being interpreted as an AST on every render. Includes, loops and conditionals become direct code; scope lookup rides a chain of null-prototype frames.
- The Markdown renderer is a fused single-pass lexer and renderer: blocks are rendered while scanning lines, and inline text escapes plain runs in bulk instead of one character at a time.
- `slugify` results are cached per case (tags repeat heavily), with a direct loop for pure ASCII text.
- Minimal allocation in hot paths: strings are built with array push and join, no object spread in rendering.

## Layout

- `solve.js` — the whole entry: front matter, Markdown, template compiler and the build pipeline. ES module, zero dependencies, no imports.
- `main.ts` — the driver, kept as the house baseline ships it: reads `/input/cases.json`, answers each case with `run`, writes `/output/answers.json`.
- `LICENSE` — MIT.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<out dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=y8skhesk&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
