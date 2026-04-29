# technicians.work

Static landing page for the `technicians.work` domain. Single self-contained
HTML file, no build step, no dependencies.

## Deploy

This is intentionally separate from the main `stephens-advanced` Vercel project
so the two domains don't share routing, caching, or auth assumptions.

### Option A — separate Vercel project (recommended)

1. In Vercel, create a new project pointed at the same GitHub repo
   (`stephens-advanced`).
2. **Root Directory**: `technicians-work`
3. **Framework Preset**: Other (it's a static HTML file)
4. **Build Command**: leave empty
5. **Output Directory**: `.` (or leave default)
6. Deploy. Vercel will serve `index.html` at the root.
7. **Add domain**: Project Settings → Domains → add `technicians.work`.
   Vercel will tell you the DNS records to set in Namecheap (usually an
   A record at `@` → `76.76.21.21` and a CNAME at `www` → `cname.vercel-dns.com`).
8. In Namecheap: Domain List → Manage → Advanced DNS → set those records.

### Option B — Namecheap shared hosting (if you bought hosting too)

1. FTP `index.html` to the public_html folder of your Namecheap hosting.
2. DNS is already pointed at Namecheap nameservers; the file just shows up.

### Option C — anywhere else

It's one HTML file with everything inline. Drop it on GitHub Pages,
Netlify, Cloudflare Pages, an S3 bucket, whatever.

## What's on the page

- Domain name as the brand
- "Brainstorming Stage" sticker top-right
- Two short framing panels (what this might be / who it's for)
- Email signup that opens the visitor's mail client to send to
  `jon@stephensadvanced.com` — zero backend needed for now

## When this stops being a placeholder

If real demand shows up, replace the `mailto:` form with a fetch to a real
endpoint (could share `api/` with the main repo via webhook, or a separate
small backend). Until then, the placeholder works.
