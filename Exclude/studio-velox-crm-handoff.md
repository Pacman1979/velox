# Studio Velox — Lead-Gen CRM Project (Handoff Notes)

## Context
Phil runs **Studio Velox** (studiovelox.com), a website creation and AI services business for Gold Coast SMEs. Pricing: $997 upfront per website + $147/month ongoing care, plus $60/hour for extra work. Uses a "build first, sell second" mockup-based lead model. Business is positioned broadly (not niched to one industry), with a warm orange/red brand accent colour.

Phil has an existing similar pipeline for a friend's business (**Watt Utilities** — energy broker referrals): web scraping strata companies → outbound email sequence → Google Sheets CRM → AWS SES delivery, built with Claude Code. He also runs **OpenClaw** ("Clawdbot"), a broader AI agent orchestration framework (orchestrator/worker pattern, Claude + Anthropic APIs, Telegram interface, AWS EC2/LightSail).

**Decision made:** the Studio Velox lead-gen system will be a **separate stack** from Watt Utilities/OpenClaw — not sharing infrastructure. Claude/AI handles everything **up to but not including contacting leads** — outreach stays human (Phil or his VA, Mary).

## Goal
Build an automated pipeline that:
1. Finds Gold Coast SME leads via Google Places API (business category × suburb search)
2. Flags businesses with **no website at all** as top-tier leads automatically
3. For businesses that DO have a website, fetches the site and has Claude score it (mobile-friendly? modern? clear CTA? outdated?)
4. Surfaces results on a new `/crm` page on studiovelox.com — for Phil and Mary (his VA) to review and manually action outreach

## Hosting / Infra decisions
- **studiovelox.com is hosted on Cloudflare.**
- Decided to build everything on Cloudflare (one account, one platform) rather than introducing AWS for this project:
  - **Cloudflare Pages** — hosts the `/crm` page itself
  - **Cloudflare Access** (or a simple password gate) — protects `/crm` since it's not meant to be public; only Phil and Mary need access
  - **Cloudflare Worker** — runs the actual logic: calls Google Places API, fetches/scores websites via Claude, writes results
  - **Cloudflare D1** (built-in SQLite database) — stores lead results; the `/crm` page queries this directly and renders a results table **on the page itself** (Phil explicitly chose this over a Google Sheet, to keep it self-contained)
  - **Cloudflare Cron Trigger** — built into Workers, used for the daily automatic run (no separate scheduler needed)
- Trigger methods: (a) manual — a "Run Search" button on `/crm` calls the Worker via fetch, (b) automatic — Cron Trigger fires the same Worker logic on a schedule
- Note: Cloudflare Workers run JS/TS, not Python — so the working Python logic (see below) will need to be **ported/rewritten**, not copy-pasted, once validated.

## Google Places API
- Phil already has a Google Places API key set up for a separate project ("smart solar" / AI-guided solar marketplace).
- Decision: fine to reuse that key for initial testing, but get a **separate key under its own Cloud project** once past the test stage — keeps quota/billing independent between projects.

## Build order agreed
1. **Validate data first** — run a Python test script locally (already built, see below) for ONE category + suburb, confirm the Google Places data returned is actually useful, before building anything bigger.
2. Port the working logic into a Cloudflare Worker (JS/TS rewrite).
3. Set up a D1 table for leads: `name, category, suburb, address, phone, website, has_website, score, score_reason, date_found`.
4. Build the `/crm` page: login/access gate → "Run Search" button → results table pulling live from D1.
5. Add the Cron Trigger for the daily automatic run once the manual version is confirmed working.
6. Full category × suburb matrix — expand beyond the single test query once the pipeline is proven (business is positioned broadly, so this should span multiple categories relevant to Gold Coast SMEs, not one niche).

## Test script (already built, not yet run)
Python script for Stage 1 — a single test query against Google Places Text Search + Place Details, dumped to CSV. Confirms the Google Places integration and data quality before anything else is built.

```python
"""
Studio Velox Lead-Gen — Step 1: Test Query
--------------------------------------------
Runs ONE category + suburb search against the Google Places API (Text Search)
and dumps the raw results to a CSV so we can check the data is useful before
building the full category/suburb matrix.

Setup:
    pip install requests
    export GOOGLE_PLACES_API_KEY="your_key_here"

Usage:
    python test_query.py
"""

import os
import csv
import time
import requests

API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY")
if not API_KEY:
    raise SystemExit(
        "Set GOOGLE_PLACES_API_KEY as an environment variable first.\n"
        "  export GOOGLE_PLACES_API_KEY='your_key_here'"
    )

# --- Test query settings — change these to try different categories/suburbs ---
CATEGORY = "cafe"
SUBURB = "Burleigh Heads, QLD"
QUERY = f"{CATEGORY} in {SUBURB}"

TEXT_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/textsearch/json"
DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json"

OUTPUT_CSV = "leads_test.csv"


def text_search(query, api_key):
    """Run a Places Text Search and return all results, following pagination."""
    results = []
    params = {"query": query, "key": api_key}
    while True:
        resp = requests.get(TEXT_SEARCH_URL, params=params, timeout=15)
        data = resp.json()

        status = data.get("status")
        if status not in ("OK", "ZERO_RESULTS"):
            print(f"Warning: Places API returned status '{status}': {data.get('error_message', '')}")
            break

        results.extend(data.get("results", []))

        next_token = data.get("next_page_token")
        if not next_token:
            break

        # Google requires a short delay before the next_page_token becomes valid
        time.sleep(2)
        params = {"pagetoken": next_token, "key": api_key}

    return results


def get_place_details(place_id, api_key):
    """Fetch phone number and website for a single place."""
    params = {
        "place_id": place_id,
        "fields": "name,formatted_phone_number,website,formatted_address",
        "key": api_key,
    }
    resp = requests.get(DETAILS_URL, params=params, timeout=15)
    data = resp.json()
    return data.get("result", {})


def main():
    print(f"Searching: {QUERY}")
    places = text_search(QUERY, API_KEY)
    print(f"Found {len(places)} raw results. Fetching details...")

    rows = []
    for place in places:
        place_id = place.get("place_id")
        details = get_place_details(place_id, API_KEY)

        rows.append({
            "name": details.get("name", place.get("name", "")),
            "category": CATEGORY,
            "suburb": SUBURB,
            "address": details.get("formatted_address", place.get("formatted_address", "")),
            "phone": details.get("formatted_phone_number", ""),
            "website": details.get("website", ""),
            "has_website": bool(details.get("website")),
        })

        # Small delay to stay polite with rate limits
        time.sleep(0.2)

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "name", "category", "suburb", "address", "phone", "website", "has_website"
        ])
        writer.writeheader()
        writer.writerows(rows)

    no_website_count = sum(1 for r in rows if not r["has_website"])
    print(f"\nDone. {len(rows)} businesses written to {OUTPUT_CSV}")
    print(f"{no_website_count} of them have NO website listed (your hottest leads).")


if __name__ == "__main__":
    main()
```

## Not yet decided / open questions
- Exact list of business categories to target (business is positioned broadly — "any Gold Coast SME" — so this needs a defined but wide category list)
- Exact scoring rubric/prompt for Claude to use when assessing an existing website's quality
- Whether Mary's role extends to outreach/follow-up on surfaced leads, or purely lead discovery (still open — noted as a question during planning, not resolved)
- Whether to keep using the existing "smart solar" Google Places API key long-term or split off a dedicated key now vs. later

## Related context (not part of this build, but relevant background)
- Phil is also considering asking his neighbour (not currently working, early 30s, does casual beauty therapy from her garage) to generate leads informally via referral — separate idea, not part of the automated pipeline, proposed as a low-commitment referral-fee arrangement.
