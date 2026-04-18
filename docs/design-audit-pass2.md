# Design Audit — Pass 2 Roadmap

**Scope:** All field-app-facing work staged from the Dr. Crusher audit bundles (v1 + v2).
**Applies to:** `appv2.html` (19,149 lines), the field-service SPA at `/app`.
**Why separate pass:** Every item below requires surgical edits inside a large, tightly-coupled HTML/JS file that Jon uses daily. Batching them with the website/portal/chat work in Pass 1 would risk breaking his live tools. This doc is the complete punch list so the next session (or the Captain) has one place to track it.

---

## From the v1 audit (original bundle)

| # | Severity | Surface | Summary |
|---|---|---|---|
| 02 | High | All | Orange is doing too much — carve out a supporting palette for tags, stats, decoration; keep orange for CTA + brand mark only |
| 07 | Critical | App · Home | Lead home with a full-width **Today** card (next stop, address, ETA, Navigate CTA). Demote month-calendar to a tab. |
| 08 | High | App · Status tags | Three tag classes with distinct grammar: service-type (outlined neutral), person (small round avatar + initials), status (filled + color-coded: amber overdue, green complete, red emergency). Max 2 tags per card. |
| 09 | Medium | App · Home overdue banner | Amber, not red. Left-border accent instead of full-width fill. Show oldest one's age (e.g. "23 days overdue"). Red reserved for 911/emergency. |
| 10 | Critical | Job detail · Complete flow | Group invoicing in a single bordered block. Primary CTA spelled out: **"Complete job · Send $349 invoice"**. Prompt-pay moves inside the invoice block as a conditional sub-control. |
| 11 | Medium | App · Bottom nav | Rename: `Today · Jobs · Clients · Money · Crew` (from `Cal / Jobs / Clients / Money / Techs`). Minimum 44×44 touch targets. Larger icons. Active state = color + filled background. |

## From the v2 audit (additions)

| # | Severity | Surface | Summary |
|---|---|---|---|
| 18 | Critical | Reports · AR aging | Detect the 100%-in-90+-bucket anomaly and surface it with a red-left-border card ("100% of receivables are 90+ days old — review collections"). Horizontal stacked bar for aging buckets. |
| 19 | High | Reports · KPI hero | Drop the orange-fill KPI block. Dark-background KPI cards with large numeral (Fraunces), label (mono), and a trend delta (+14% YTD green / −$2.10 amber). Sparklines where space allows. |
| 20 | Medium | Reports · Monthly rows | Each month gets a small progress bar filled to collected/billed ratio. Green >80%, orange 60-80%, red <60%. Dollars still shown but the bar leads. |
| 21 | Critical | Riker · Tabular responses | Detect tabular AI responses (e.g. "show me my overdue jobs"); render as a list of cards (one per row) with structured fields — client, location, service tag, days overdue, flag. Tappable to open the job. Real tables only on explicit request. |
| 22 | High | Riker · Action suggestions | When Riker offers an action ("Want me to reschedule?"), render 1-3 tappable action buttons directly under the message ("Reschedule all 12", "Just the 4 flagged", "Start with oldest"). Tap commits; typing is fallback. |
| 23 | Medium | Riker · Parity | ✅ **Addressed in Pass 1.** External chat renamed to "Stephens Support" (customer-facing). Riker stays as operator persona in-app. Same model, different personas + permissions. |
| 24 | Critical | Site → App · Logo gesture | ✅ **Partially addressed in Pass 2 (team.html + /team route + footer link).** Full fix: `/app` itself becomes a proper sign-in page. Pin-only gate gets the new page as its shell. |
| 25 | Critical | App · Reports hidden | Reports currently accessible only via logo tap. Add as an explicit destination — options per audit: (a) 6th bottom-nav slot, (b) profile-menu item in the avatar top-right, (c) dedicated "Business" tab replacing "Techs" for solo operators. |
| 26 | High | App · Pin gate | Replace pin 264526 with: SMS-link sign-in tied to Jon's number, device cookie (30 days), Face ID/fingerprint on revisit. Faster AND safer. Bus-factor 1 → scalable. |

## From the v2 Corrections section

Dr. Crusher's fixes after reviewing real screenshots:

| # | Observed | Fix |
|---|---|---|
| C1 | Job-detail header has a blue "Add to Today's Schedule" CTA | Off-palette. Orange-outline or ghost variant. |
| C2 | Overdue banner IS red-on-red as reconstructed | Amber + accent border (confirms issue #09). Tap-through: "Ask Riker to handle these" instead of generic list. |
| C3 | Status tags are different colors but arbitrary | Establish a taxonomy: shape + color together (issue #08). |
| C4 | Jobs list has OVERDUE section header, swipe reveals "Delete" + "All", "SERVICE REQUEST" white badge | Rename "All" — unclear. Make SERVICE REQUEST visually distinct from scheduled jobs (not just a badge). |
| C5 | Prompt-pay: "Customer paying now? / 10% prompt-pay discount applied if paid within 24 hours" | Copy good, placement bad. Move inside the invoice block (issue #10). |
| C6 | Real Riker FAB is purple/blue stacked WITH an orange "+" quick-create | Two stacked FABs without labels = "which one do I tap?" every time. Either label both, merge, or split to different screen edges. |

---

## Suggested build order for Pass 2

1. **Palette surgery (issue #02)** — low risk, enables everything else. Introduce `--slate` and `--sand` CSS variables; retrofit status tags and decoration to use them so orange reads as CTA only.
2. **Bottom nav (issue #11)** — contained change: rename, resize targets, refresh active-state affordance. Ship + test.
3. **Overdue banner (issue #09 + C2)** — small component swap. Amber left-border, age display, Riker tap-through handler.
4. **Status tags (issue #08 + C3)** — taxonomy rollout: service-type / status / person. Touches every job card but mostly CSS + small markup updates.
5. **Home screen Today card (issue #07)** — biggest UX shift on home. Build as new component; gate with a feature flag or query-string toggle (`?home=v2`) so Jon can A/B before ripping out the calendar.
6. **Job detail complete flow (issue #10 + C1 + C5)** — the highest-stakes rebuild. Invoicing block, explicit CTA ("Complete job · Send $X invoice"), prompt-pay conditional, CTA color correction.
7. **Reports view (issues #18, #19, #20, #25)** — rework the orange-block KPIs, add the AR anomaly card, add monthly progress bars, wire an explicit nav entry so it's reachable without the logo-tap easter egg.
8. **Riker tabular + agentic UX (issues #21, #22)** — server-side response shaping (detect tabular content, return as structured card data) + client-side card renderer + action-button renderer for proposals.
9. **FAB stacking (C6)** — merge or separate. Probably merge behind one labeled "Quick actions" button that reveals Riker and "+" as choices.
10. **App entry + pin rebuild (issues #24, #26)** — biggest auth change. SMS-link flow with device cookies + biometrics. Ships `/app` as a real sign-in destination, deprecates the pin. Coordinate with Twilio + a device-token scheme; plan for 2-3 days of work.

Items 1-4 are "a week of disciplined design" per the audit. 5-6 are the stakes-highest shifts. 7-10 are substantial net-new features that deserve their own discussion with the Captain before build.

---

## Files that will get touched in Pass 2

- **`appv2.html`** — most of the above
- **`api/riker-core.js`** or a new `api/riker-render.js` — server-side response-shape detection for issue #21
- Possibly a new `api/auth-sms.js` for issue #26
- **`vercel.json`** — if `/app` becomes a dedicated route distinct from the field app itself
- **`docs/design-audit/`** — already current with v2 bundle (see commit history)

## Kept in scope from Pass 1 (already shipped)

Reference the commit log for provenance:
- Commit `26af7a5` — Pass 1: website (hero, stats, services), portal dark theme, chat starters, type system + palette. Addresses v1 issues 1, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17 + v2 issue 23.
- Commit pending — team.html entry page + /team route + footer link. Partial credit on v2 issue 24.
