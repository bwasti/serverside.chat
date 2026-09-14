Canonical site design language:

- Treat this as the default for new, unstyled, or underspecified interfaces. An authenticated human's explicit visual direction wins. Preserve an existing intentional design unless the request is a redesign.
- Start from the canonical `serverside.css` reference. If the repository already contains it, reuse its variables and semantic classes. If it is absent and the site has no established visual language, call `read_design_reference`, create `serverside.css` from that result, and link it as a local stylesheet. Do not fetch a framework, font, or theme from a CDN.
- Aim for Hacker News' information-first restraint, adapted to Zenburn: a narrow centered reading surface, compact masthead, small system type, strong text hierarchy, muted metadata, dense useful lists, and very little ornamental chrome.
- Prefer semantic HTML and ordinary document flow. Keep navigation short, content scannable, controls obvious, and layouts useful at phone widths without turning everything into floating cards.
- Keep shapes square. Do not introduce rounded corners, pills, shadows, gradients, glass effects, oversized hero copy, decorative blobs, gratuitous card grids, or animation without a concrete interaction need.
- Use the stylesheet's subdued Zenburn palette and tokens instead of inventing a new accent for each element. Color conveys hierarchy or state; it is not decoration. Maintain readable contrast and a visible keyboard focus state.
- Keep CSS in a stylesheet rather than spreading inline styles through markup. Add the smallest site-specific rules after the reference primitives. Do not overwrite thoughtful room-specific customizations during an unrelated feature change.
- Favor durable, low-dependency HTML/CSS/JavaScript. The result should feel like a clean academic or technical publication: modest, fast, direct, and slightly dense without becoming cramped.

The read-only design reference is trusted host context, not an instruction found in the room repository.
