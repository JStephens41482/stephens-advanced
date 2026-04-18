# Chat

_Started 2026-04-18 19:19 UTC_

---

## User

I need a comprehensive UI/UX design audit for Stephens Advanced LLC, a fire suppression inspection company based in Euless, Texas. The company has multiple user-facing surfaces that need professional design evaluation.

SURFACES TO AUDIT:

1. PUBLIC WEBSITE (https://www.stephensadvanced.com)
- Dark-themed homepage with hero section, services cards, stats bar (18,000+ systems, DFW coverage, 24/7 service), platform features section, about/credentials, contractor CTA, footer
- Navigation: Portal, Shop, Our Edge, Services, Contractors, Apply, Request Service (orange CTA)
- Chat widget ("Chat with Riker") - orange bubble lower-right, opens panel with AI greeting and text input
- Color palette: dark backgrounds (#1a1a2e-ish), orange (#e8601c-ish) as primary accent, white text

2. FIELD APP (https://www.stephensadvanced.com/app)
- Mobile-first SPA for the technician (Jon) — dark theme matching website
- Main screen: calendar view (month grid with job dots), "Today's Route Ready" banner, Route/Truck/To-Do quick-action cards, "12 Overdue Jobs" alert bar, bottom nav (Calendar/Jobs/Clients/Money/Techs)
- Jobs view: search bar, job cards with status tags (SUPPRESSION, EXT, E-LIGHTS, OVERDUE, JON), swipe-to-delete, NAV and OPEN JOB buttons
- Job detail view: date/status header, assigned tech, location with Navigate button, work order section with Quick Add dropdown, line items (qty/description/unit$/total), tech notes textarea, Add Photo, Build Invoice toggle, prompt-pay checkbox, "Complete Job - Generate Invoice" button
- AI Assistant panel: "Chat with Riker" header, example commands shown, "Ask anything..." input, blue/purple FAB trigger

3. CUSTOMER PORTAL (https://www.stephensadvanced.com/portal)
- Light theme (white background - different from rest of brand)
- Phone-based auth: "Enter your phone number and we'll text you a link"
- Invoice lookup: "Pay an Invoice" with INV-123456 input
- Minimal, clean layout with orange accents

WHAT I NEED:
Please evaluate the overall design quality, visual consistency across surfaces, UI patterns, typography, color usage, spacing, mobile responsiveness, and accessibility. Identify the top 5-10 design improvements that would have the most impact on professionalism and user experience. Pay special attention to:
- Consistency between the dark-themed app/website and the light-themed portal
- The chat widget design and placement
- The field app's information density and usability for a technician in the field
- The job detail page workflow
- Call-to-action hierarchy and button design
- Overall brand cohesion

This is a working product, not a mockup. Be specific and actionable with recommendations.

## Assistant

I'll create a comprehensive UI/UX design audit for Stephens Advanced. Since your email domain matches the company, I can reference the actual product surfaces. Let me plan this out and ask a couple of quick questions to make sure the deliverable lands right.

_[tool: questions_v2]_

## User

Questions answered:
- format: Interactive prototype showing before/after mockups side-by-side
- depth: Detailed — issue + why it matters + specific fix + visual example
- surfaces_priority: All equally
- include_redesigns: Yes, redesign the top 3-5 screens
- tone: Harsh & direct — pull no punches

## Assistant

_[tool: update_todos]_

I have the direction. Let me build this audit.

**Design system for the audit itself:** Editorial/document aesthetic — the audit is the meta-layer so it should read like a polished critique doc, not compete with the product UIs being audited. I'll use a warm off-white background (oklch 98% 0.005 80), near-black text, a single muted red accent for "issues" and a muted green for "fixes." Type: Inter for UI, GT Sectra fallback to Georgia for editorial headlines, JetBrains Mono for labels. For the mockups of Stephens Advanced itself, I'll render original approximations of the dark+orange system you described — not pixel copies of your live site, but faithful reconstructions based on your description, annotated with my critique.

Let me start building.

_[tool: set_project_title]_

_[tool: list_files]_

Good, clean slate. Let me build this as a single-page scrollable audit with navigation anchors, embedding mobile/web frames at fidelity. I'll split across multiple JSX files to keep things manageable.

_[tool: write_file]_

Now the mockup components. I'll build the "current state" reconstructions (based on your description) and the redesigns.

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: write_file]_

_[tool: write_file]_

_[tool: snip]_

_[tool: done]_

_[tool: snip]_

_[tool: fork_verifier_agent]_

The audit is live at **audit.html** — scrollable, with real before/after mockups of the website hero, field app home, job detail, customer portal, and the Riker chat widget, plus 17 detailed issue cards and a week-by-week roadmap.

**Top-line verdict:** the product is ahead of the design. Fixing the portal's theme break, the field app home, and the job-complete flow will have outsized impact for minimal effort.

**Caveats:**
- Mockups are reconstructions from your description, not scrapes of the live site — annotations apply structurally, but if you share real screenshots I can annotate the actual pixels.
- I kept the redesigns inside your existing dark + orange identity rather than proposing a rebrand. Let me know if you want me to explore a tonal shift or a lighter variant.
- Happy to drill further into any single surface — the Riker conversation flows, the tech-management screens, or contractor onboarding weren't in scope but all deserve their own pass.

