# Studio Velox — Treetops Kiosk Sign & Referral Strategy (Handoff Notes, Part 3)

This covers the Treetops shopping centre kiosk thread — separate from Part 1 (Google Places lead-gen CRM) and Part 2 (chatbot + billing).

## Background
Phil approached the owner of a small kiosk in the middle of Treetops shopping centre (sells phone covers, iPad covers, and similar accessories) about cross-promoting Studio Velox's website services.

**Outcome:** the kiosk owner agreed to display a single **A4 sign in a small plastic stand**, and explicitly said he doesn't want a referral kickback — free advertising.

**Strategy if it works:** Phil plans to approach other small kiosks around the Gold Coast with the same offer if this one performs well.

## Original plan discussed (before the free-advertising outcome)
For reference, in case it's useful for future kiosks that DO want a kickback:
- Two Studio Velox offers to promote: free 1-page site + $147/mo, OR $997 full website + $147/mo
- Suggested kickback structure: ~$25–30/month ongoing (for as long as the client stays) for a free-tier signup referral; ~$150–200 one-off for a $997 full-build referral — rewards the higher-value referral
- Idea of tracked/different QR codes per referral source (signs vs. business cards) so Phil can tell where a lead came from

## The A4 sign — final design
Built as a print-ready HTML file (`treetops-a4-sign.html`), sized to A4 portrait, using Studio Velox's brand colours (charcoal `#1A1A1A` + warm orange/red accent `#E8491D` on an off-white `#FAF7F4` background).

**Content on the sign:**
- Small "Studio Velox" wordmark at the top (kept small — the offer is the attention-grabber, not the brand name)
- Headline: **"FREE\* 1-Page Websites"**
- Sub-note: "*for Gold Coast small businesses"
- Subline: **"Then just $147/mo — cancel anytime"**
- QR code (see below) with caption "Scan to get started"
- Three trust points: ✓ Live within 24 hours ✓ No design skills needed ✓ Local & personal
- Footer: `studiovelox.com` + fine print disclaimer covering the $147/mo ongoing fee and the $997 full-build option

**Turnaround claim — IMPORTANT CHANGE:** originally said "Live in 30 minutes," but Phil changed this to **"Live within 24 hours."** Reason: he does gig delivery driving (DoorDash/UberEats) as his day job, and an instant-turnaround promise creates pressure if someone inquires while he's mid-shift and can't respond immediately. "24 hours" gives him breathing room without losing the fast-turnaround selling point. **This preference should apply to all future Studio Velox marketing copy, not just this sign** — avoid promising instant/immediate turnaround in headlines or pitches.

## QR code & tracking
- QR code target: `studiovelox.com/?src=treetops`
- The `?src=treetops` query parameter is the tracking mechanism — lets Phil filter site analytics later to see traffic/leads specifically from this kiosk, separate from any other kiosk added in future (each new kiosk should get its own `?src=` value, e.g. `?src=kioskname`)
- QR image generated via QuickChart's free QR API (`quickchart.io/qr`), embedded directly in the HTML as an `<img>` tag pointing to the API — loads live when the page is opened/printed, no local QR library needed
- **Open item:** need to confirm `studiovelox.com` is live and handles the `?src=` query parameter gracefully before printing/displaying the sign

## File delivered
`treetops-a4-sign.html` — open in any browser and use Print → Save as PDF (or print directly); the page is set to A4 size so it should print edge-to-edge without resizing.

## Not yet decided
- Whether to build the same sign concept for other kiosks now, or wait and see how Treetops performs first
- What the `studiovelox.com/?src=treetops` landing experience should actually show (a dedicated quick-offer page vs. the normal homepage) — this ties back to the "sign QR → punchy landing page" idea raised earlier in the marketing discussion, not yet built
