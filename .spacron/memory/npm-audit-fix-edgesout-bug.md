# `npm audit fix` fails with "Cannot read properties of null (reading 'edgesOut')"

Seen on npm 10.9.7 / node 22 while bumping the 2026-09 audit advisories
(vitest, devalue, joi). Plain `npm audit fix`, `npm update <pkg>` and even
`npm install <pkg>@latest` all abort with the same cryptic
`Cannot read properties of null (reading 'edgesOut')` — it is npm's lockfile
resolution bug, not a broken project lockfile.

The workaround that actually ran to completion:

```sh
npm audit fix --legacy-peer-deps
```

Check the resulting `package-lock.json` diff afterwards: on this repo it
bumped exactly the advisory packages and nothing else. `npm test` after is the
real gate — two unrelated store tests were already red in the working tree
(string-literal drift in `embeddedRun`/`notification`), so run the specific
touched suites rather than reading the summary line alone.

Related: [[release-flow]]
