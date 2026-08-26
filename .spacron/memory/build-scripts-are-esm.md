# `scripts/*.js` are ES modules, and only `tauri build` proves it

`package.json` has `"type": "module"`, so every `.js` file under `scripts/` is
loaded by Node as an **ES module**. `require`, `module.exports`, `__dirname` and
`__filename` do not exist there. Use `import`, and rebuild the directory with:

```js
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
```

## Why this bites in the worst possible place

`scripts/build-server-sidecar.js` shipped with `require(...)` at the top and
nothing caught it. The reason is the call graph:

- `npm run check`, `npm test`, `npm run build` — **never load these scripts.**
- `scripts/sync-version.js` runs on `npm version`, so a broken one fails while
  you are still cutting the release, locally.
- `scripts/build-server-sidecar.js` runs **only** as the Tauri
  `beforeBuildCommand` (`src-tauri/tauri.conf.json`), i.e. inside
  `npm run tauri build`. Nothing in `.github/workflows/build.yml`'s check steps
  reaches it before the final `tauri build` step, and nothing local reaches it
  at all unless you deliberately run `npm run server:build`.

So a CommonJS slip here is green everywhere and red only in the release matrix,
after the tag has been pushed — which is exactly what happened to the first
v1.0.0 tag (`ReferenceError: require is not defined in ES module scope`, all
three platforms, before a line of Rust compiled).

## The cheap check

Before tagging, run `npm run server:build` once — it is the only thing that
exercises the `beforeBuildCommand` path without a full bundle. See
[[release-flow]] for the rest of the pre-tag list.
