# Spacron IDE Background Image Generation

You are generating 32 background wallpaper images for Spacron, a cross-platform developer workspace (code editor + terminal + AI agent orchestrator). These images sit behind a frosted-glass UI overlay at 75% opacity, so they must be atmospheric and even-toned — never busy, sharp, or high-contrast.

## Technical Specifications

- **Resolution:** 2560×1440 (2K, 16:9 landscape)
- **Format:** WebP (lossless or high-quality lossy, q=85+)
- **Style:** Photorealistic but atmospheric. Painterly softness is preferred over photographic sharpness. Think "fine art print" not "stock photo"
- **Luminance rule:** Even exposure across the entire frame. No bright hot spots (>70% luminance) in dark mode images. No deep shadow pockets (<25% luminance) in light mode images
- **Composition rule:** No sharp foreground objects. No readable text, signs, or recognizable faces. No hard geometric lines that could clash with a UI grid
- **Mood:** Calm, contemplative, and ambient. These are backgrounds you could work with for 8 hours without fatigue
- **File naming:** Use the exact filenames listed below with `.webp` extension

---

## LIGHT MODE IMAGES (16 total)

### 1. `light-office.webp`
**Theme name:** Solace Sky Workspace
**Prompt:** Aerial view looking across a vast sea of soft cumulus clouds from above, as if viewed from a high-altitude aircraft window on a calm morning. Warm white and pale gold cloud tops rolling gently across the entire frame. Diffused, even daylight with no harsh shadows or direct sun. The clouds fill the frame edge to edge with no visible ground or horizon. Serene, expansive, and minimal. Photorealistic, soft focus, 2560×1440.

### 2. `light-architecture.webp`
**Theme name:** Architectural Curves
**Prompt:** Interior of a sweeping modern architectural space inspired by Santiago Calatrava — flowing white concrete curves, ribbed vaults, and organic structural forms. Soft natural daylight filtering through high skylights, casting gentle gradients and soft shadows across the white and light grey surfaces. No people, no furniture, no objects — pure architectural form and diffused light. Clean, sculptural, minimal. Photorealistic, 2560×1440.

### 3. `light-desk.webp`
**Theme name:** Lo-Fi Desk Workspace
**Prompt:** Close-up of a warm, honey-toned wooden desk surface with soft morning sunlight streaming across it from the left. Shallow depth of field — the wood grain texture is the main subject, rich and detailed in the centre, falling into warm bokeh at the edges. A blurred ceramic coffee cup with faint steam visible in the far corner, completely out of focus. Warm, intimate, quiet morning mood. No other objects visible. Photorealistic, macro lens feel, 2560×1440.

### 4. `light-beach.webp`
**Theme name:** Amalfi Coastline
**Prompt:** Distant view of a Mediterranean coastal cliff at golden hour, shot from the water with a telephoto lens. Soft atmospheric haze dissolves the cliff face, pastel-coloured buildings, and terraced gardens into a painterly wash of warm peach, terracotta, pale yellow, and soft blue. No sharp detail anywhere — the entire scene is dreamy and impressionistic, like a watercolour painting rendered photographically. Warm, romantic, distant. 2560×1440.

### 5. `light-scandi.webp`
**Theme name:** Fjord Cabin Shore
**Prompt:** Calm Norwegian fjord at dawn, viewed from the end of a weathered wooden dock extending into still water. Perfect mirror reflections of layered mountain ridges that recede into soft, rolling fog. Cool blue-grey colour palette throughout. Even overcast lighting with no direct sun. No foreground objects closer than the water's edge — the dock is only visible as a subtle wooden texture at the very bottom of frame. Still, Nordic, contemplative. Photorealistic, 2560×1440.

### 6. `light-library.webp`
**Theme name:** Grand Library
**Prompt:** Atmospheric interior of a grand classical library, but captured in soft focus throughout. Warm amber light streams through tall arched windows, creating visible dust-mote sunbeams. Towering bookshelves are suggested as warm, blurred vertical forms — no individual books or text are readable. Rich wood and brass tones glow softly. The mood is warm, scholarly, and hushed — like entering a cathedral of knowledge. Painterly, dreamlike quality. 2560×1440.

### 7. `light-greenhouse.webp`
**Theme name:** Solarpunk Greenhouse
**Prompt:** View from inside a glass greenhouse looking outward through rain-streaked glass panels. Lush tropical foliage is visible through the wet glass but heavily diffused into a soft green wash — no individual leaves or plants are in focus. The glass surface with its water droplets and condensation is the foreground subject. Soft, even overcast daylight. Fresh, green, tranquil. Photorealistic with artistic blur, 2560×1440.

### 8. `light-desert.webp`
**Theme name:** Canyon Desert Oasis
**Prompt:** Wide telephoto shot of layered desert canyon walls at sunrise, compressing the geological strata into horizontal bands of warm terracotta, ochre, pale sandstone, and dusty rose. Soft atmospheric haze between each layer creates depth separation. Shot from a great distance — no foreground rocks, vegetation, or objects. Just pure, abstracted geological colour bands stretching across the frame. Warm, ancient, serene. Photorealistic, 2560×1440.

### 9. `light-meadows.webp`
**Theme name:** Alpine Meadow
**Prompt:** Elevated view looking across a rolling alpine meadow toward distant snow-capped mountain peaks. Soft overcast light bathes the scene in muted sage greens and pale blues. Wildflowers are present but completely out of focus — just soft impressions of colour (lavender, yellow, white) scattered through the grass. The scene opens up toward a hazy mountain horizon that dissolves into cloud. Fresh, expansive, and quiet. Photorealistic, 2560×1440.

### 10. `light-zen-garden.webp`
**Theme name:** Kyoto Zen Garden
**Prompt:** Overhead aerial view looking straight down at a Japanese zen rock garden (karesansui). Perfectly raked white-grey gravel forms rhythmic, parallel wave patterns around carefully placed smooth stones. The meditative repetition of the rake lines is the visual focus. Soft, shadowless overcast light illuminates the scene evenly from above. Warm grey-beige colour palette. Minimal, precise, calming. Photorealistic, 2560×1440.

### 11. `light-cafe.webp`
**Theme name:** Parisian Cafe Patio
**Prompt:** Soft-focus impressionistic view of a Parisian cobblestone courtyard in warm late-afternoon light. The curved backs of wrought-iron bistro chairs and a round marble-topped table are visible in the mid-ground but heavily blurred into painterly shapes. Climbing ivy on a warm honey-coloured stone wall fills the background. Everything is soft, warm, and nostalgic — like a Renoir painting rendered photographically. Warm amber and green tones. 2560×1440.

### 12. `light-sakura.webp`
**Theme name:** Sakura River Path
**Prompt:** Looking upward through a canopy of cherry blossom branches in full bloom. Soft pink and white petals fill the upper frame against a pale, luminous sky. Shot with shallow depth of field so individual blossoms dissolve into soft clouds of pink and white colour. A few petals drift gently downward through the frame. Dreamy, light, airy, and ephemeral. The lower portion of the frame fades to soft, blurred pink-white bokeh. Photorealistic, 2560×1440.

### 13. `light-autumn-path.webp`
**Theme name:** Autumn Forest Path
**Prompt:** A straight forest path receding into soft golden autumn fog. Tall trees line both sides but are softened by the mist into warm amber and gold columns fading into the distance. A carpet of fallen leaves covers the ground but is rendered out of focus — just a warm golden-brown texture. Even, warm, diffused light with no harsh shadows or sunbeams. The fog creates a soft vanishing point. Peaceful, seasonal, contemplative. Photorealistic, 2560×1440.

### 14. `light-balcony-morning.webp`
**Theme name:** Mediterranean Balcony Morning
**Prompt:** View from a Mediterranean stone balcony looking out over a calm, glassy sea at dawn. A weathered terracotta balustrade edge is visible in soft focus at the very bottom of frame. Beyond it, open turquoise-blue water stretches to a hazy horizon under a pale pink and gold sky. A few distant coastal hills are barely visible as faint silhouettes. Clean, open, and breezy. Morning light is soft and warm. Photorealistic, 2560×1440.

### 15. `light-attic-study.webp`
**Theme name:** Attic Study Sanctuary
**Prompt:** Warm attic space with a large skylight letting in soft, diffused daylight that fills the room with gentle, even illumination. Exposed wooden roof beams cross the upper frame in warm honey-brown tones. Bookshelves and a reading chair are suggested in the background but remain heavily blurred — only their warm shapes and colours register. The mood is intimate, quiet, and scholarly. Amber, cream, and warm wood tones throughout. Photorealistic, 2560×1440.

### 16. `light-lakefront-cabin.webp`
**Theme name:** Sunny Lakeside Cabin
**Prompt:** Calm lake at sunrise, viewed from the shoreline looking across still water. A perfect mirror reflection of the distant pine treeline and pale sky doubles the scene on the water surface. A thin veil of morning mist hovers just above the water. Cool blue-grey tones in the water transition to a pale warm gold in the sky. No dock, no cabin, no boats — just the peaceful expanse of water and the soft treeline on the horizon. Photorealistic, 2560×1440.

---

## DARK MODE IMAGES (16 total)

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

### 6. `dark-fireplace.webp`
**Theme name:** Cozy Fireplace Cabin
**Prompt:** Warm cabin interior at night, lit by a fireplace that is *out of frame to the left* — only its warm glow is visible, washing across a rough-hewn wooden wall and the curved edge of a worn leather armchair in the right portion of the frame. Deep amber, cognac, and dark brown tones. Very dark in the corners and upper areas (near-black). The firelight creates soft, organic, flickering gradients on the wood grain. Intimate, quiet, and warm. No flames visible — only the ambient glow. Photorealistic, 2560×1440.

### 7. `dark-ocean.webp`
**Theme name:** Moonlit Coastal Cliff
**Prompt:** Dark ocean viewed from a high cliff edge at night under a full moon. Moonlight creates a broad, soft silver-white reflection path across the dark, gently rippling water surface, stretching from the mid-frame to the distant horizon. The cliff itself is just a dark, featureless silhouette at the very bottom of the frame. The distant horizon is barely visible where dark sea meets dark sky. Deep navy, charcoal, and silver palette. Vast, contemplative, and quiet. Photorealistic, 2560×1440.

### 8. `dark-nebula.webp`
**Theme name:** Cosmic Stargazing
**Prompt:** Deep space nebula — a soft, painterly wash of dark purple, deep indigo, and faint dusty rose spreading across a black void like cosmic ink. A scattering of bright star points, but no hard-edged objects: no silhouettes, no planets, no spacecraft, no people. Just smooth, organic gas cloud forms dissolving gradually into darkness at the edges. The nebula occupies the centre and fades to pure black at the frame edges. Muted, awe-inspiring, and abstract. Digital art, painterly quality, 2560×1440.

### 9. `dark-rainy-window.webp`
**Theme name:** Rainy City Skyline
**Prompt:** View through a rain-streaked window at night. The city lights beyond are *completely* defocused into warm amber, soft gold, and cool blue bokeh circles of varying sizes, scattered organically across a dark background. The only sharp elements are the rain droplets and streaks on the glass surface itself, catching faint reflections of the bokeh behind them. Meditative, melancholy, warm. The dark upper portion of the frame has fewer lights, fading to near-black. Photorealistic, 2560×1440.

### 10. `dark-industrial-loft.webp`
**Theme name:** Industrial Loft Twilight
**Prompt:** Raw, textured concrete wall of an industrial loft space at twilight. A single warm tungsten light source from above and to the right (out of frame) washes across the rough surface, revealing its texture — pores, imperfections, and subtle colour variations in warm grey. One exposed steel pipe or duct runs along the upper edge of the frame, softly out of focus. Deep warm greys and amber tones. Architectural, minimal, raw, and moody. No furniture, no objects, just wall and light. Photorealistic, 2560×1440.

### 11. `dark-volcanic-cave.webp`
**Theme name:** Basalt Lava Cave
**Prompt:** Interior of a basalt lava tube cave looking toward a distant, dim opening. The cave walls are dark, textured volcanic rock with subtle columnar jointing patterns. A faint, warm orange-red glow emanates from deep within the cave or from a distant lava source — not visible molten lava, just a subtle warm ambient light that gently tints the lower portions of the dark rock. The upper areas and edges are near-black. Deep blacks, charcoal, and dark ember tones. Atmospheric, primal, and quiet. Photorealistic, 2560×1440.

### 12. `dark-cyber-rooftop.webp`
**Theme name:** Cyber Neon Rooftop
**Prompt:** High aerial view looking down at a rain-soaked cyberpunk city at night from far above. The buildings are far below and reduced to a soft, muted grid of neon light — pink, teal, and purple — on a dark base, like a glowing circuit board. No individual buildings, signs, or vehicles are distinguishable. Heavy low cloud and rain haze diffuses everything further. The city glow occupies the lower two-thirds; the upper third is dark sky merging into blackness. Photorealistic/digital art, 2560×1440.

### 13. `dark-tokyo-skyline.webp`
**Theme name:** Tokyo Skyline Night
**Prompt:** Tokyo skyline at blue hour (civil twilight, not full night), shot from across Tokyo Bay at a distance of 3+ miles. The city buildings are small and merged into a soft, warm silhouette along the horizon, with thousands of tiny warm window lights glowing like distant embers. The twilight sky transitions from deep steel blue at the top to a faint warm orange-pink at the horizon. Heavy atmospheric haze softens all building detail into a unified glow. Tokyo Tower is a faint, small red suggestion in the haze — not a sharp landmark. Photorealistic, 2560×1440.

### 14. `dark-chicago-skyline.webp`
**Theme name:** Chicago Skyline Night
**Prompt:** Chicago skyline reflected in the calm surface of Lake Michigan at blue hour, shot from far offshore on the water. The city is a soft, warm band of golden-white lights along the horizon, with the mirror reflection doubling the glow on the dark water surface below. Heavy atmospheric haze dissolves all building detail into a unified warm shimmer. The sky transitions from deep blue at the top to a faint warm amber at the horizon. The composition is symmetrical: sky above, city glow in the middle, reflection below. Photorealistic, 2560×1440.

### 15. `dark-hongkong-skyline.webp`
**Theme name:** Hong Kong Night Harbour
**Prompt:** Hong Kong Victoria Harbour at night, viewed from high on Victoria Peak through light rolling fog. The harbour lights, building glow, and neon below are diffused by the mist into a soft, jewel-toned wash of cyan, magenta, and warm gold scattered across dark water. No individual buildings, signs, or boats are readable — just the abstract, organic pattern of a glowing harbour dissolving into fog. The upper portion is dark hillside silhouette fading to black. Photorealistic, 2560×1440.

### 16. `dark-sydney-skyline.webp`
**Theme name:** Sydney Harbour Lights
**Prompt:** Sydney Harbour at civil twilight, shot from the north shore looking south across calm water. The Opera House sails and Harbour Bridge are distant, soft silhouettes against a deep blue-to-indigo twilight sky. Harbour lights reflect on the still water as soft, elongated golden streaks. Atmospheric haze softens all detail. The landmarks are gentle suggestions, not sharp postcard elements — the mood is quiet, painterly, and contemplative. Deep blue, indigo, and warm gold palette. Photorealistic, 2560×1440.

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

Save each image as `[filename].webp` in a `backgrounds/` directory. Use the exact filenames from the headings above (e.g., `light-office.webp`, `dark-street.webp`, etc.).
