# Studio Velox — Chatbot & Billing/Invoicing (Handoff Notes, Part 2)

This covers everything discussed *after* the first handoff doc (`studio-velox-crm-handoff.md`, covering the Google Places lead-gen pipeline and `/crm` page on Cloudflare). This part covers three new threads: an AI chatbot for the website, invoicing, and recurring billing for the $147/month care plan.

## 1. AI Chatbot for studiovelox.com

**Job:** dual-purpose — answer FAQs/pricing questions AND capture leads (name/email/phone). Phil chose "both equally" over picking one.

**Plan discussed:**
- **Knowledge base** the bot should be scoped to: Studio Velox pricing ($997 upfront build + $147/month ongoing care, $60/hour for extra work), the "site live in 30 minutes" pitch, what's included in the $147/mo plan, typical turnaround time, and how the process works generally.
- **Lead capture trigger:** after a few exchanges, or when the bot can't answer something, it should prompt the visitor for name + email/phone — framed as "get a custom quote" or "book a free mockup" rather than a hard sell.
- **Escalation:** if it can't help, hand off to Phil rather than guessing or making things up.
- **Infrastructure reuse:** planned to reuse the same Cloudflare Worker + Claude API pattern already being built for the `/crm` lead-gen system (see Part 1 doc), rather than standing up separate infrastructure.
- **Idea floated:** leads captured by the chatbot could feed into the same Cloudflare D1 database as the scraped Google Places leads — one unified lead list rather than two separate systems.
- **Future potential:** once proven on Studio Velox's own site, the chatbot could become a sellable add-on product offered to Studio Velox's SME clients.

**Not yet decided:**
- Exact system prompt / tone for the bot
- Where on the site it appears (every page vs specific pages)
- Whether it's built before or after the `/crm` lead-gen system

## 2. Invoicing

Phil wants a digital invoice template for client billing.

**Decision:** the $147/month recurring fee will be handled by automated billing (see #3 below), which auto-generates its own invoices/receipts — so a manual invoice template is **not needed for the recurring fee**.

**Still needed:** an invoice template for the **$997 upfront build fee**, which is a one-off charge, not recurring. Two options discussed but not yet decided between:
- Generate the one-off invoice via the same billing platform (e.g. Stripe one-off invoice) — keeps everything in one system
- A standalone branded Word/PDF invoice template Phil sends manually

**Open question:** which of the two above Phil wants — this was offered but not yet chosen when the conversation moved to the handoff doc request.

## 3. Recurring billing for the $147/month care plan

**Decision:** Phil chose **automated recurring billing** (Stripe Billing or Xero-style) over manual invoicing + reminder emails.

**How it works (as discussed):**
- Create a "Studio Velox Care Plan — $147/mo" product/subscription in the billing platform (Stripe was the main example discussed)
- Client enters their card once via a checkout link
- Platform then auto-charges monthly, auto-sends invoice/receipt, and handles failed-payment retries and dunning emails automatically — no manual sending required going forward

**Why this was picked over manual invoicing:** removes ongoing admin entirely — nothing to remember to send, no reminder emails to write, no chasing overdue payments manually.

**Not yet decided:**
- Stripe vs Xero vs another platform — Stripe was used as the working example but no final platform choice was made
- How this integrates (if at all) with the CRM/lead-gen system from Part 1 — not discussed yet

## Related context (for reference, not new decisions)
- Studio Velox pricing: $997 upfront + $147/month ongoing, or $60/hour for extra work
- studiovelox.com is hosted on Cloudflare (same platform used for the CRM build in Part 1)
- Business is positioned broadly across Gold Coast SMEs (not niched to one industry)
