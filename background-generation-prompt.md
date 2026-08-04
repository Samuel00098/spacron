# Spacron IDE Background Image Generation

You are generating 22 background wallpaper images for Spacron, a cross-platform developer workspace (code editor + terminal + AI agent orchestrator). These images sit behind a frosted-glass UI overlay at 75% opacity, so they must be atmospheric and even-toned — never busy, sharp, or high-contrast.

## Technical Specifications

- **Resolution:** 2560×1440 (2K, 16:9 landscape)
- **Format:** WebP (lossless or high-quality lossy, q=85+)
- **Style:** Photorealistic but atmospheric. Painterly softness is preferred over photographic sharpness. Think "fine art print" not "stock photo"
- **Luminance rule:** Even exposure across the entire frame. No bright hot spots (>70% luminance) in dark mode images. No deep shadow pockets (<25% luminance) in light mode images
- **Composition rule:** No sharp foreground objects. No readable text, signs, or recognizable faces. No hard geometric lines that could clash with a UI grid
- **Mood:** Calm, contemplative, and ambient. These are backgrounds you could work with for 8 hours without fatigue
- **File naming:** Use the exact filenames listed below with `.webp` extension

---

## LIGHT MODE IMAGES (11 total)

### 1. `light-office.webp`
**Theme name:** Solace Sky Workspace
**Prompt:** Aerial view looking across a vast sea of soft cumulus clouds from above, as if viewed from a high-altitude aircraft window on a calm morning. Warm white and pale gold cloud tops rolling gently across the entire frame. Diffused, even daylight with no harsh shadows or direct sun. The clouds fill the frame edge to edge with no visible ground or horizon. Serene, expansive, and minimal. Photorealistic, soft focus, 2560×1440.

### 2. `light-architecture.webp`
**Theme name:** Architectural Curves
**Prompt:** Interior of a sweeping modern architectural space inspired by Santiago Calatrava — flowing white concrete curves, ribbed vaults, and organic structural forms. Soft natural daylight filtering through high skylights, casting gentle gradients and soft shadows across the white and light grey surfaces. No people, no furniture, no objects — pure architectural form and diffused light. Clean, sculptural, minimal. Photorealistic, 2560×1440.

### 3. `light-greenhouse.webp`
**Theme name:** Solarpunk Greenhouse
**Prompt:** View from inside a glass greenhouse looking outward through rain-streaked glass panels. Lush tropical foliage is visible through the wet glass but heavily diffused into a soft green wash — no individual leaves or plants are in focus. The glass surface with its water droplets and condensation is the foreground subject. Soft, even overcast daylight. Fresh, green, tranquil. Photorealistic with artistic blur, 2560×1440.

### 4. `light-desert.webp`
**Theme name:** Canyon Desert Oasis
**Prompt:** Wide telephoto shot of layered desert canyon walls at sunrise, compressing the geological strata into horizontal bands of warm terracotta, ochre, pale sandstone, and dusty rose. Soft atmospheric haze between each layer creates depth separation. Shot from a great distance — no foreground rocks, vegetation, or objects. Just pure, abstracted geological colour bands stretching across the frame. Warm, ancient, serene. Photorealistic, 2560×1440.

### 5. `light-meadows.webp`
**Theme name:** Alpine Meadow
**Prompt:** Elevated view looking across a rolling alpine meadow toward distant snow-capped mountain peaks. Soft overcast light bathes the scene in muted sage greens and pale blues. Wildflowers are present but completely out of focus — just soft impressions of colour (lavender, yellow, white) scattered through the grass. The scene opens up toward a hazy mountain horizon that dissolves into cloud. Fresh, expansive, and quiet. Photorealistic, 2560×1440.

### 6. `light-library.webp`
**Theme name:** Grand Library
**Prompt:** Atmospheric interior of a grand classical library, but captured in soft focus throughout. Warm amber light streams through tall arched windows, creating visible dust-mote sunbeams. Towering bookshelves are suggested as warm, blurred vertical forms — no individual books or text are readable. Rich wood and brass tones glow softly. The mood is warm, scholarly, and hushed — like entering a cathedral of knowledge. Painterly, dreamlike quality. 2560×1440.

### 7. `light-cloud-atrium.webp`
**Theme name:** Cloud Atrium
**Prompt:** Circular glass atrium flooded with pale morning haze, with soft white marble walkways, translucent railings, and blurred greenery below. Diffused daylight washes through the roof so evenly that the entire space feels weightless and cloudlike. No people, no signage, no hard reflections — just gentle architecture, soft plant forms, and air. Bright, serene, and spacious. Photorealistic, 2560×1440.

### 8. `light-salt-marsh-dawn.webp`
**Theme name:** Salt Marsh Dawn
**Prompt:** Mirror-still tidal marsh at sunrise, seen from a low elevated vantage point. Thin ribbons of water weave through soft reeds and shallow pools, reflecting a pastel sky in pale peach, silver, and muted blue. The horizon is hazy and low-contrast, and all plant detail is softened by mist. Quiet, expansive, and balanced. Photorealistic, 2560×1440.

### 9. `light-paper-studio.webp`
**Theme name:** Paper Studio
**Prompt:** Minimal studio interior with translucent paper screens, pale wood flooring, and a diffuse wash of morning light. The screens create layered, semi-opaque planes that blur the room into soft whites, creams, and light honey tones. Nothing is sharp or cluttered — only calm geometry, paper texture, and evenly spread light. Clean, contemplative, and refined. Photorealistic, 2560×1440.

### 10. `light-stone-cloister.webp`
**Theme name:** Stone Cloister
**Prompt:** Quiet cloister courtyard framed by pale limestone arches and a central garden of moss and trimmed gravel. Soft overcast daylight removes harsh contrast, letting the architecture read as gentle curves and warm stone tones. No people, no ornament, no dramatic shadow — only repeating arches, still air, and a sense of pause. Minimal, monastic, and restful. Photorealistic, 2560×1440.

### 11. `light-rooftop-garden.webp`
**Theme name:** Rooftop Garden
**Prompt:** Elevated rooftop garden with white planters, soft green foliage, and a hazy city skyline beyond. The skyline is intentionally indistinct, dissolving into warm daylight and atmospheric blur while the plants remain soft and rounded rather than detailed. The whole scene should feel bright but muted, like a city breathing quietly above the streets. Fresh, airy, and modern. Photorealistic, 2560×1440.

---

## DARK MODE IMAGES (11 total)

### 1. `dark-street.webp`
**Theme name:** Tokyo Neon Street
**Prompt:** A narrow Tokyo alley at night during heavy rain, shot from a distance with a telephoto lens. Neon signs in pink, purple, and cyan are completely defocused into soft, floating colour orbs and halos against the dark, wet environment. Rain-slicked pavement reflects the blurred lights as soft vertical streaks. No readable Japanese text, no sharp edges, no visible people — just a warm, glowing, rain-soaked urban atmosphere dissolving into darkness at the edges. Photorealistic, 2560×1440.

### 2. `dark-workspace.webp`
**Theme name:** Cosmic Bridge Console
**Prompt:** Deep space view from inside a dim, darkened spacecraft cockpit. The cockpit's structural frame is barely visible as a very dark silhouette framing the edges of the image. Through the large viewport: a vast, dark starfield with a faint, subtle blue-white nebula wash drifting across the centre. Very minimal and restrained — the darkness dominates (at least 70% of the frame is near-black), with only subtle colour wisps and a scattering of soft, dim star points. Contemplative, vast, and quiet. Photorealistic/sci-fi concept art, 2560×1440.

### 3. `dark-obsidian.webp`
**Theme name:** Icelandic Black Sand
**Prompt:** Wide panoramic shot of an Icelandic black sand beach (Reynisfjara-style) at twilight. Low, gentle waves wash across the dark volcanic sand, creating soft silver-white reflections that trace the wave lines. A heavy, moody overcast sky merges with the horizon in a seamless dark grey gradient. One or two distant basalt sea stacks are barely visible as dark silhouettes through the coastal mist. Desaturated, powerful, and open. Cool grey-blue and charcoal palette. Photorealistic, 2560×1440.

### 4. `dark-forest.webp`
**Theme name:** Mystical Neon Woods
**Prompt:** Dark forest at night with a faint, ethereal green-blue bioluminescent fog drifting between ancient tree trunks. The trees themselves are dark silhouettes — tall, vertical, and spaced apart. The fog is the only light source, providing soft, diffused, mysterious illumination that fades with distance. No individual leaves, branches, or undergrowth are in focus. Deep greens, teals, and blacks dominate. Fantasy-like, tranquil, and otherworldly. Photorealistic with subtle digital art enhancement, 2560×1440.

### 5. `dark-server-room.webp`
**Theme name:** Cyber-Organic Core
**Prompt:** Abstract extreme close-up of server rack LED status lights in a dark data centre corridor, shot with very shallow depth of field. The tiny teal, amber, and white indicator lights are completely defocused into soft bokeh circles of varying sizes, floating in deep darkness like digital fireflies. No readable hardware, cables, or text — just a rhythmic field of gentle light points on a near-black background. Tech-noir, minimal, and hypnotic. Photorealistic, 2560×1440.

### 6. `dark-ocean.webp`
**Theme name:** Moonlit Coastal Cliff
**Prompt:** Dark ocean viewed from a high cliff edge at night under a full moon. Moonlight creates a broad, soft silver-white reflection path across the dark, gently rippling water surface, stretching from the mid-frame to the distant horizon. The cliff itself is just a dark, featureless silhouette at the very bottom of the frame. The distant horizon is barely visible where dark sea meets dark sky. Deep navy, charcoal, and silver palette. Vast, contemplative, and quiet. Photorealistic, 2560×1440.

### 7. `dark-midnight-observatory.webp`
**Theme name:** Midnight Observatory
**Prompt:** A domed observatory at night seen as a soft silhouette against a faint starfield and a barely glowing horizon. The dome, railings, and surrounding structure remain subdued and blurred so the scene feels quiet rather than technical. Deep navy, slate, and muted silver tones with tiny points of starlight scattered sparsely across the sky. Calm, scientific, and contemplative. Photorealistic, 2560×1440.

### 8. `dark-foggy-harbor.webp`
**Theme name:** Foggy Harbor
**Prompt:** Dark harbor water at night with a few distant lamps and mast lights dissolving into dense coastal fog. The reflections are stretched into soft vertical smears, and the boats and piers are reduced to barely-there silhouettes. Black water, cool grey mist, and faint amber glows dominate. Quiet, wet, and atmospheric. Photorealistic, 2560×1440.

### 9. `dark-empty-subway.webp`
**Theme name:** Empty Subway
**Prompt:** An empty underground subway platform or tunnel at night, lit by a small number of soft amber ceiling lights that repeat into the distance. Wet concrete floors pick up blurred reflections, while the tunnel recedes into a velvety darkness with no signs, ads, or people. Industrial but hushed, with long gradients of brown, charcoal, and warm gold. Photorealistic, 2560×1440.

### 10. `dark-candle-alcove.webp`
**Theme name:** Candle Alcove
**Prompt:** A near-black alcove with a concealed candle glow filtered through frosted glass or a translucent partition. The light should feel hidden rather than obvious, creating soft amber gradients on surrounding stone or plaster surfaces. No flame detail, no objects in focus, only a calm pocket of warmth in deep darkness. Intimate, minimal, and soft. Photorealistic, 2560×1440.

### 11. `dark-snowy-pine-ridge.webp`
**Theme name:** Snowy Pine Ridge
**Prompt:** A dark pine ridge at night or late twilight with light snowfall drifting through a blue-black sky. The trees form a soft serrated silhouette, while the snow catches just enough moonlight to create a subtle silver veil across the scene. Deep greens, charcoal, and cold blue tones, with low contrast and a quiet winter stillness. Photorealistic, 2560×1440.

---

## Quality Checklist

Before delivering each image, verify:
- [ ] Resolution is exactly 2560×1440
- [ ] Format is WebP
- [ ] No sharp, in-focus foreground objects
- [ ] No readable text, signs, or recognizable faces
- [ ] Even luminance — no hot spots or deep shadow pockets
- [ ] The image looks good when viewed at 75% opacity over a solid white (light) or black (dark) background
- [ ] The image looks good when a 20px Gaussian blur is applied (simulating the app's blur feature)
- [ ] No harsh geometric lines (building edges, window frames) that would clash with a UI grid
- [ ] The mood is calm and ambient, not dramatic or attention-grabbing

## File Output

Save each image as `[filename].webp` in `static/backgrounds/`. Use the exact filenames from the headings above (e.g., `light-office.webp`, `dark-street.webp`, etc.).
