# OKV Inventory Management System — Online Edition (Phase 2)

Multi-tenant, multi-user, works offline and syncs when connected. **Every
organisation gets its own dedicated Google Spreadsheet**, created
automatically at signup; a small Master spreadsheet tracks all of them
centrally. No other server needed — the whole backend is Google Sheets +
Apps Script. Every new signup gets a real 7-day free trial with full access.

---

## 1. File structure

```
okv-ims-online/
├── index.html            THE MARKETING SITE — first page any visitor lands on
├── demo.html               Live demo — same app, sample data, read-only
├── pricing.html            Monthly / Bi-Annually / Yearly, Starter/Growth
├── signup.html             Org + Admin sign-up — creates a new tenant
├── login.html               Shared login for BOTH org users and the Super
│                          Admin (see Section 5) — tries an org login first,
│                          falls back to Super Admin automatically
├── app.html                  The org-facing system — gated behind login
├── super-admin.html          OKV's own dashboard — organisations, capacity
│                          monitoring, messaging, and system settings
│                          (contact/payment/branding/pricing) — see Section 5
├── install.html              Install-only page (no login form)
├── reset-password.html        Token-based password reset (Admin self-serve)
├── manifest.json / sw.js / icons/    PWA shell
├── apps-script/
│   └── Code.gs                THE ENTIRE BACKEND — paste into Apps Script
├── manuals/
│   ├── OKV-IMS-Admin-Manual.pdf
│   └── OKV-IMS-Staff-Manual.pdf
├── mock_server.js              Local test server (optional, see Section 8)
└── README.md                  This file
```

Every HTML file that talks to the backend points at a placeholder:
```js
const API_URL = window.OKV_API_URL || 'PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE';
```
Once you deploy `Code.gs` (Section 3), replace that placeholder with your
real deployment URL in `signup.html`, `login.html`, `app.html`,
`super-admin.html`, and `reset-password.html`.

---

## 2. Architecture: one spreadsheet per organisation

This is the core change in Phase 2.1. Instead of one shared spreadsheet
holding every org's data, the backend now manages:

**One small Master spreadsheet** (created by `initMaster()`, Section 3) —
holds only non-transactional oversight data, never any org's actual
products/sales/customers:
| Sheet | Holds |
|---|---|
| `TenantRegistry` | One row per org: name, admin contact, **spreadsheetId**, plan, billing cycle, subscription dates, and (Super Admin-only) cell-capacity fields |
| `UserIndex` | One row per login, across every org: username, password hash, session/reset tokens, status. This is the only place credentials live. |
| `SubscriptionRequests` | Every "I paid, upgrade me" submission — reviewed centrally (Section 6) |
| `SuperAdmins` | OKV's own login(s) |
| `CapacityHistory` | Daily cell-usage snapshots per org, used to estimate growth rate |
| `SystemConfig` | Key/value store the Super Admin Dashboard edits — contact info, bank accounts, payment gateways, branding, pricing plans, reminder cadence |
| `SuperAdminMessages` | Log of announcements/messages the Super Admin sends to org Admins |

**One dedicated spreadsheet per tenant** — created automatically the moment
someone signs up (`SpreadsheetApp.create('OKV IMS — ' + orgName)`), holding
only that org's own transactional data:
| Sheet | Holds |
|---|---|
| `Users` | Full profile per login in that org — name, email, phone, roles (no passwords or session tokens — those live only in Master's `UserIndex`) |
| `Data` | Every business record — products, sales, stock, etc. — tagged by `entityType`, exactly as in earlier builds |
| `Messages` | Communications-tab sends to that org's own customers |
| `ChatMessages` | Team Chat between that org's Admin and staff |

**Nothing in the code ever hardcodes a spreadsheet.** Every function resolves
which spreadsheet it needs at call time:
- `getMaster_()` — opens the Master spreadsheet via its ID in Script Properties
- `getOrgSpreadsheet_(orgId)` — looks up that org's spreadsheet ID in
  `TenantRegistry` and opens it (cached for 6 hours via `CacheService` so
  repeat calls don't re-scan the registry every time)

This means an org's data can never leak into another org's spreadsheet, and
each org's cell usage (Section 4) can be measured and capped independently.

---

## 3. Apps Script deployment steps

Unlike earlier builds, this is now a **standalone** Apps Script project (not
bound to any one spreadsheet) — it manages many spreadsheets, not just one.

1. Go to [script.google.com](https://script.google.com) → **New project**.
2. Delete the default `myFunction(){}` placeholder and paste in the entire
   contents of `apps-script/Code.gs`. Rename the project to something like
   "OKV IMS Backend".
3. In the function dropdown (next to Run/Debug), select **`initMaster`**,
   then click **Run**. The first time, Google will ask you to authorize the
   script — accept the permissions (it needs to create/edit spreadsheets,
   use Drive for payment-proof screenshots, and send email). This creates
   the Master spreadsheet, seeds `SystemConfig` with sensible defaults, and
   seeds one Super Admin login:
   **username `technologyokv@gmail.com`, password `OKVIMS557`** ("the
   system name" + 557, as requested) — **change this from the Super Admin
   Dashboard → My Account after your first login.** Check the execution
   log (View → Logs) for a link to the new Master spreadsheet.
4. Select **`installTriggers`** and click **Run** once. This installs:
   - an `onEdit` trigger on the Master's `SubscriptionRequests` sheet
     (type `Confirmed`/`Rejected` to approve an upgrade — Section 6)
   - a daily trigger for cell-capacity monitoring (Section 4)
   - a daily trigger for trial/subscription reminder emails (Section 7)
5. **Deploy → New deployment**. Gear icon next to "Select type" → **Web
   app**. Execute as **Me**, Access **Anyone**. Deploy, copy the Web App URL.
6. Paste that URL into `signup.html`, `login.html`, `app.html`,
   `super-admin.html`, and `reset-password.html` (replacing
   `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE`).
7. Host the HTML files anywhere static (GitHub Pages, Netlify, Google
   Sites, etc.) or just open them locally for testing.

Every time you edit `Code.gs` afterwards: paste the changes in, then
**Deploy → Manage deployments → pick the existing deployment → Edit (pencil)
→ New version → Deploy**. This keeps the same URL, so you don't need to
update the HTML files again.

---

## 4. Cell-capacity monitoring (Super Admin only)

Google Sheets has a hard limit of **10,000,000 cells per spreadsheet file**,
summed across every tab. Since each org now has its own file, a very active
tenant could theoretically approach that ceiling — this feature watches for
it automatically.

**How it works:**
- `checkAllTenantsCapacity_()` runs once a day (the trigger from Section 3,
  step 4) — never on a page load. For each org, it opens their spreadsheet,
  sums actual used cells across every tab (`getDataRange()`, not the full
  default grid), and calculates:
  - current cell count and % of the 10,000,000 limit
  - a daily growth-rate estimate, by comparing against a snapshot from
    roughly 30 days ago in `CapacityHistory`
  - an estimated number of days until that org reaches 90% capacity, at
    its current growth rate
- Results are written back to that org's row in `TenantRegistry`, alongside
  a status flag:
  - **Healthy** — under 70% used
  - **Monitor** (70%+) — "Usage is climbing — worth planning ahead. Consider
    archiving old records in the next few months."
  - **Action Needed** (85%+) — "Archive older transactional records into a
    separate archive spreadsheet soon, or split this tenant's data…"
- The first time an org crosses into **Action Needed**, an email alert goes
  to the Super Admin's contact address automatically (only once per
  crossing, not every day).

**This data is Super Admin-only.** Org Admins and staff never see it — it's
purely for OKV's own system-wide oversight, surfaced only on the Super Admin
Dashboard's Capacity Monitor tab. You can also trigger an on-demand check
from there ("Run Check Now") instead of waiting for the daily schedule.

### Archive Old Records — turning the recommendation into a one-click action

Every row in the Capacity Monitor table has an **Archive Old Records**
button. It opens a small form: a cutoff (6/12/24/36 months) and a checklist
of which record types to move — pre-populated with historical/transactional
types only (`stockIn`, `stockOut`, `salesOrders`, `purchaseOrders`,
`adjustments`, `expenses`, `batches`). Master/reference data (products,
customers, suppliers, settings, categories) is deliberately left off the
list, since it isn't historical and archiving it would break the live app.

Behind the scenes, `archiveOldRecords_`:
1. Finds every row in that org's `Data` sheet matching the chosen types and
   older than the cutoff.
2. Copies them into a dedicated **Archive spreadsheet for that org**
   ("OKV IMS Archive — <org name>"), created the first time and reused on
   every later run (its ID is remembered in `TenantRegistry.archiveSpreadsheetId`).
3. Deletes those rows from the live tenant spreadsheet (bottom-up, so row
   numbers don't shift mid-delete).
4. Immediately re-runs the capacity check for just that one org
   (`checkOneTenantCapacity_`, shared with the daily bulk check) so the
   dashboard reflects the freed-up space right away, without waiting for
   the next scheduled run.

---

## 5. Super Admin Dashboard

`super-admin.html` is a separate dashboard from the org-facing `app.html`,
reachable through the **same login page** (`login.html`) — the login form
tries an org account first, and quietly falls back to a Super Admin login
if the username isn't a recognised org user. The default seeded login is
described in Section 3, step 3.

From this dashboard, the Super Admin can:

- **Organizations** — every tenant in one table (name, admin contact, plan,
  subscription status, org status), searchable. Click **Manage** on any row
  to edit contact details, override plan/billing cycle/subscription expiry
  (e.g. for a manually-applied or off-platform payment), suspend/reactivate
  the whole organisation (suspending force-logs-out every login in it), or
  jump straight to that org's own spreadsheet.
- **Capacity Monitor** — the table described in Section 4.
- **Messaging** — send Announcement/Personalized/Other messages to org
  Admins by Email, SMS, and/or WhatsApp, individually, to everyone, or to
  orgs expiring within 14 days / already expired. Same `{{name}}`
  personalization and SMS/WhatsApp gateway setup as org-side Message
  Members (Section 6) — see `SMS_GATEWAY_URL`/`WHATSAPP_GATEWAY_URL` Script
  Properties.
- **Contact & Payment** — edit the support email/phone/WhatsApp/website
  shown everywhere; add/edit/enable/disable bank accounts for manual
  transfers; and configure Paystack, Remita, and Flutterwave (enable
  toggle + their keys) as automatic gateways. All of this is stored in
  `SystemConfig` and read live by the backend — no code edits needed for
  routine changes. **Note:** this build stores gateway keys and renders
  the enabled/disabled state; wiring up each gateway's actual checkout flow
  (e.g. Paystack's inline JS, generating a Remita RRR, Flutterwave's
  checkout) is a further integration step per provider — the configuration
  layer here is what a checkout implementation would read from.
- **Branding** — primary/gold/cream colors and a logo URL, stored in
  `SystemConfig` under `branding`.
- **Pricing & Plans** — add/edit/remove plans (id, name, prices per billing
  cycle, feature list). `pricing.html` and the in-app Upgrade &
  Subscription tab both read this the same way `getPublicConfig` does.
- **Reminders** — how many days before expiry to start reminding, and the
  minimum gap between reminder emails (Section 7).
- **My Account** — change the Super Admin's own password.

---

## 6. Upgrade & Subscription workflow

Unchanged in spirit from earlier builds, but `SubscriptionRequests` now
lives in the **Master** spreadsheet (org-level oversight data), not each
tenant's own file — so every pending request across every org is reviewable
in one place instead of opening each tenant spreadsheet separately.

1. An org Admin fills in the Upgrade & Subscription tab (bank details shown
   there come from `SystemConfig` → Contact & Payment), uploads a payment
   screenshot, and submits.
2. That's saved to Master's `SubscriptionRequests`, the screenshot goes to
   a Drive folder ("OKV IMS Payment Proofs"), and the Super Admin's contact
   address gets an emailed notification with a link to it.
3. **To approve or reject: open the `SubscriptionRequests` sheet in the
   Master spreadsheet (or manage it via a future dashboard action) and type
   `Confirmed` or `Rejected` into that row's Status column.** The
   `installTriggers()` trigger (Section 3, step 4) does the rest: emails
   the org their decision, and if confirmed, updates that org's single
   `TenantRegistry` row directly — `subscriptionStatus: active`, a new
   `subscriptionExpiry` (extended from whichever is later, today or their
   current expiry, by 30/182/365 days for Monthly/Bi-Annually/Yearly), and
   the chosen plan.
4. Every login in that org picks this up automatically within a few minutes
   (the app polls `whoAmI` every 5 minutes) — no logout/login needed.

### Message Members (org-side) & Team Chat

Unchanged — see the in-app tabs. Email works immediately (`MailApp`); SMS
and WhatsApp need a gateway configured via Script Properties
(`SMS_GATEWAY_URL`/`SMS_API_KEY`, `WHATSAPP_GATEWAY_URL`/`WHATSAPP_API_KEY`)
or, more conveniently now, via the Super Admin Dashboard's payment-gateway
style config — either mechanism is read the same way.

---

## 7. Trial & subscription reminders

The Admin Dashboard shows a near/due banner automatically on every load —
no separate trigger needed for that part; it's computed live from
`subscriptionDaysLeft`/`subscriptionExpired` in the session (returned by
`login`/`whoAmI`). It appears for a trial at any point, and for an *active*
subscription once it's within 7 days of renewal or already past it.

**Reminder emails are deliberately infrequent** — twice a month, not daily,
per spec. `sendTrialReminders_()` runs once a day (Section 3, step 4) but
only actually sends to a given org when:
- they're within the configured window of expiry (default 14 days,
  editable from the Super Admin Dashboard → Reminders), and
- it's been at least the configured minimum gap since their last reminder
  (default 14 days)

Each email includes their current plan's features and a short pitch for
whichever other plan they're not on, both pulled live from `SystemConfig`
→ Plans — so editing pricing/plans from the dashboard automatically updates
what these reminder emails say, with no code changes.

**A note on expired access:** logging in no longer blocks an Admin outright
once a trial/subscription has expired — they still need to reach the
Upgrade & Subscription tab to pay. Instead, the frontend restricts an
expired org's Admin to Dashboard, Upgrade & Subscription, Settings, and the
User Manual; everything else shows a toast explaining why. Non-Admin staff
logins are still blocked on an expired org, since they can't upgrade it.

---

## 8. Testing locally without a real deployment

Two small Node scripts (not needed for production — you can delete them)
let you test the entire system without deploying anything to Google. The
mock now simulates **separate spreadsheets** the same way Google does —
`SpreadsheetApp.create()`/`openById()` each return an isolated sheet
namespace — so local testing exercises the same multi-tenant code paths as
production.

```bash
# Terminal 1 — runs the real, unmodified Code.gs inside a local mock of
# the Apps Script/Sheets APIs, exposed as an HTTP server
node mock_server.js 8950

# Terminal 2 — serves the HTML files
python3 -m http.server 8951
```

Then open `http://localhost:8951/signup.html`, after temporarily pointing
the `API_URL` line in each HTML file at `http://localhost:8950` instead of
the placeholder. The default Super Admin login (Section 3, step 3) is
seeded automatically when the mock server starts. A debug endpoint at
`http://localhost:8950/_debug/sheets` dumps every mock spreadsheet's raw
rows (Master + each tenant) if you need to inspect state directly.

---

## 9. One-time migration from a single-spreadsheet build

If you're upgrading from an earlier (pre-2.1) build that kept everything in
one container-bound spreadsheet:

1. Open `apps-script/Code.gs` and set `OLD_SPREADSHEET_ID` (near the bottom,
   just above `migrateToMultiTenant_`) to that old spreadsheet's ID.
2. Run `initMaster()` first if you haven't already (Section 3, step 3).
3. Run `migrateToMultiTenant_()` once from the Apps Script editor. For every
   distinct `orgId` found in the old `Users` sheet, this creates a new
   tenant spreadsheet, copies that org's Users/Data/Messages/ChatMessages
   rows into it, and adds a matching row to `TenantRegistry` +
   `UserIndex`. Old `SubscriptionRequests` rows are copied into Master's
   copy of that sheet.
4. Safe to re-run — it skips any `orgId` already present in
   `TenantRegistry`, so a partial or repeated run won't duplicate data.
5. Check the execution log for a count of organisations migrated.

---

## 10. Roles reference

Unchanged from earlier builds — the Admin can tick any combination of these
for a User; access is the union of every role they hold.

| Role | Sees |
|---|---|
| Inventory Super Admin | Everything (same breadth as Admin, but still a "User" account type — can't manage Team & Access) |
| Store Manager | Everything except Team & Access |
| Storekeeper / Warehouse Officer | Products, Inventory, Stock In/Out, Reorder Alerts, Adjustments, Batch & Expiry |
| Sales Officer | Products, Customers, Sales Orders, POS, Message Members |
| Cashier / POS Operator | POS, Customers, Message Members |
| Procurement Officer | Products, Suppliers, Purchase Orders, Reorder Alerts, Stock In |
| Inventory Auditor / Viewer | Inventory, Batch & Expiry, Profit & Loss, Reports (read-focused) |

Dashboard, Settings, Team Chat, and User Manual are available to every
logged-in user regardless of role.

---

Developed by: OKV Technology Consults
