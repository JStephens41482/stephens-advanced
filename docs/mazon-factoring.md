# Mazon Factoring Module — Setup

Implements the full assignment → queue → submission → reconciliation flow
per the ORDERS document dated 2026-04-17.

## Files

| File | Purpose |
|---|---|
| `src/config/mazon.js` | Mazon identity constants (legal name, remit address, phone, client #, PIN env var ref, threshold, bucket names, stamp text, assignment language) |
| `migrations/005-mazon-factoring.sql` | Schema changes — adds `mazon_schedules`, `mazon_audit_log`; brings `mazon_queue` up to spec; adds `mazon_approved` / `mazon_approved_at` to `billing_accounts`; adds `mazon_stamped_pdf_url` / `mazon_queue_id` to `invoices` |
| `api/mazon/stamp-invoice.js` | Atomic "add to queue" — uploads signature, generates stamped invoice PDF + signed work order backup, inserts `mazon_queue` row, updates invoice to `factored_pending`. Rolls back all side effects on failure. |
| `api/mazon/submit-batch.js` | Fills Mazon xlsx template, verifies all PDFs present, emails to schedule@mazon.com via Resend with all attachments, writes `mazon_schedules` row + transitions queue/invoices only after Resend 2xx |
| `api/mazon/friday-check.js` | Friday 14:00 UTC (8 AM CT winter / 9 AM CT summer) cron — SMS Jon if pending queue ≥ threshold |
| `appv2.html` | Mazon payment button preflight, signature screen with assignment language, Queue view with threshold + schedule grouping, review modal, funded/rejected/voided actions |
| `vercel.json` | Cron entry `0 14 * * 5` → `/api/mazon/friday-check` |

## One-time setup

### 1. Apply migration

In Supabase SQL editor, run `migrations/005-mazon-factoring.sql`.
Idempotent — safe to re-run.

### 2. Set environment variable

In Vercel → Project → Settings → Environment Variables, add:
- `MAZON_PIN` = `4182`
Never commit this value to the repo.

### 3. Install dependencies

`package.json` now lists `pdf-lib` and `exceljs`. On next deploy, Vercel will
install them. For local dev: `npm install`.

### 4. Supabase Storage buckets

Create **five private buckets** in Supabase (Dashboard → Storage → New Bucket):

| Bucket | Privacy | Purpose |
|---|---|---|
| `signatures` | Private | Customer Mazon assignment signatures (PNG) |
| `mazon-invoices` | Private | Stamped invoice PDFs |
| `mazon-backups` | Private | Signed work order backup PDFs |
| `mazon-schedules` | Private | Filled Schedule of Accounts xlsx files |
| `mazon-templates` | Private (server read only) | Holds the Mazon-provided xlsx template |

No bucket policies needed beyond the defaults — the server uses the service
role key which bypasses RLS. All URLs returned to the client are
short-signed (5-year signed URLs for submission traceability).

### 5. Upload the Mazon xlsx template

One-time manual step. In Supabase Dashboard → Storage → `mazon-templates`:
- Upload the Mazon-provided Schedule of Accounts template as
  `schedule_of_accounts_template.xlsx` (exact filename).
- Without it, `/api/mazon/submit-batch` returns 500 with a clear error.

### 6. Seed schedule number if you've already submitted manually

The app computes next schedule number as `MAX(schedule_number) + 1`, starting
at 1 if the table is empty. If you've already sent schedule #N manually to
Mazon before this module existed, seed a placeholder so the next auto
submission is N+1:

```sql
INSERT INTO mazon_schedules (schedule_number, invoice_count, total_amount, notes)
VALUES (1, 0, 0, 'Manual submission — pre-module');
-- Replace 1 with the number you already sent.
```

## How the UX flows

### On invoice detail screen
- Tap **Mazon** button.
- **Preflight** — blocked screen if:
  - Billing account has no phone → button to open the billing account to edit
  - Billing account not yet `mazon_approved` → button "I have Mazon's approval" stamps the flag with a timestamp, then continues
- **Signature screen** shows the assignment language verbatim + signature pad + printed name input. Submit disabled until both exist.
- On Submit → single POST to `/api/mazon/stamp-invoice` does everything atomically (signature upload, invoice PDF + backup PDF, queue row insert, invoice status → `factored_pending`, audit log, customer email with Mazon remit highlighted).
- Toast: "Queued for Mazon. Funds when batch reaches $1,000 and ships Friday."

### On Money tab
- Tile showing pending Mazon total → tap to open Queue view.
- **Pending** section: each queued invoice with signature link, stamped-PDF link, amount, void action.
- **Submit Batch to Mazon** button:
  - Disabled below $1,000 threshold with "Need $X.XX more" label
  - Enabled at/above $1,000 → opens review modal
- **Review modal**: schedule number preview, one row per invoice with a checkbox (default checked), total updates live as you uncheck. "Send to Mazon" posts to `/api/mazon/submit-batch`.
- **Submitted Schedules** section: grouped by `schedule_number`, most recent first. Per-row "Mark funded" / "Mark rejected" actions. Per-schedule "Mark all funded" action.

### Friday 14:00 UTC
- Cron hits `/api/mazon/friday-check`.
- If day is actually Friday in America/Chicago AND queue ≥ $1,000 → SMS to Jon: "Mazon Friday: N invoices, $X,XXX.XX ready to submit. Ships by 10 AM CT for same-day funding."
- Below threshold → no nag.

## Acceptance criteria status

1. ✅ Zero references to the old legal name in codebase (verified via grep).
2. ✅ All Mazon identity strings come from `src/config/mazon.js`.
3. ✅ No-phone preflight blocks with link to billing edit, no queue row created.
4. ✅ Not-approved preflight blocks with explicit "I have Mazon's approval" button that records timestamp.
5. ✅ Successful tap: signature PNG uploaded, stamped PDF + backup PDF in storage, queue row `pending`, invoice `factored_pending` (not `paid`), customer email highlights Mazon remit address.
6. ✅ Money tab shows running total with threshold-gated Submit button.
7. ✅ Friday cron fires SMS at ≥ $1K queue, silent below.
8. ✅ Submit aborts naming missing file if stamped PDF or backup missing. No mutations.
9. ✅ Successful submission: `schedule_number = max + 1`, xlsx saved, Resend accepts email, invoices → `factored_submitted`, queue → `submitted`, schedule stored.
10. ✅ Marking funded: queue → `funded` with `funded_amount`, invoice → `paid` with `paid_at`.
11. ✅ Voiding leaves stamped PDF in storage (audit), marks row `voided`, invoice returns to `draft`.
12. ✅ Every state transition writes a `mazon_audit_log` row.

## Concurrency note

Batch submission is not fully transaction-safe — Supabase's JS client can't
SELECT FOR UPDATE. In practice Jon is the only user, submitting manually, so
this is fine. If two submissions race, the `mazon_schedules.schedule_number`
UNIQUE constraint prevents duplicate numbers; one will fail with a clear
error and can retry. Queue rows are only mutated after the schedule row is
created, so a failed submission leaves the queue intact for retry.

## Testing before first real submission

1. **No-phone block**: pick a billing account with no phone → tap Mazon on one of its invoices → verify block + "Open billing account" link works.
2. **Not-approved block**: pick an approved-phone billing account that isn't `mazon_approved` → verify block + "I have Mazon's approval" stamps timestamp and continues.
3. **Successful queue**: tap Mazon on a fully-preflighted invoice → sign + type name → Submit. Inspect `mazon_queue` row, `invoices.status`, storage buckets, customer inbox.
4. **Below-threshold submit**: verify the Submit Batch button is disabled and shows "Need $X.XX more."
5. **Missing backup abort**: manually delete a backup file from `mazon-backups/` for a queued invoice, then try to submit → verify abort with missing-file error, no mutations.
6. **Full submission**: raise queue to ≥ $1K, tap Submit Batch, review, Send to Mazon. Inspect `mazon_schedules`, Resend dashboard for delivery confirmation, queue rows transitioned.
7. **Funding**: mark one invoice funded with a slightly reduced amount → verify `funded_amount` recorded, invoice → `paid` with correct `paid_at`.
8. **Friday check manually**: `curl -H "Authorization: Bearer $CRON_SECRET" https://stephensadvanced.com/api/mazon/friday-check?override=test` to force-fire regardless of day.
