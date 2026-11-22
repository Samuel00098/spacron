# T3 device presentation renderer

Vendored from https://github.com/pingdotgg/t3code/tree/main/packages/client-runtime/src/device
on 2026-11-22. MIT license and copyright are retained in LICENSE.

Spacron adaptations: local platform and screen metadata types; brand-specific shape
profiles and foldable camera layout; our transport, device lifecycle and input
injection remain outside this directory. Do not replace these files from upstream
without retaining those adapters.

T3's GLB device models are NOT used: T3's own sources.json records they were converted
from Apple's apple.com AR files with no redistribution licence. `resolveDeviceModelId`
resolves nothing, so every device renders Spacron's original procedural chassis
(families in T3DeviceView.tsx `chassisFamily`). Do not ship or commit those GLBs.

Upstream main resolved during import: 2e62a7189366a3541329479c7b6b4d40cab2916a.
GLB assets retain the embedded original-model Apple Inc. copyright metadata.
