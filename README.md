# Kestrel Heating & Air (concept site)

Single-page marketing website for a fictional HVAC company in Houston, TX.
Built as a portfolio project by Slobodan Dabic.

- One self-contained HTML file (Tailwind CSS compiled and inlined), vanilla JavaScript
- Responsive layout with a sticky "Call now" bar on mobile
- Thermal-camera hero with an interactive thermostat, a scroll-linked "buddy" who cools down as you read, flat-rate prices, service call timeline, Comfort Club, service area map, FAQ, booking form (demo)

Kestrel Heating & Air is not a real business. The phone number uses the reserved 555 range.

## Content panel (/admin)

The owner can change the headline, the hero photo, contact details, service prices and the Comfort Club perks at `/admin`, without touching code.

- `worker/index.js` serves the static files as before and writes saved edits into the page on the way out (HTMLRewriter). Editable elements carry `data-cms` attributes in `index.html`.
- Edits and uploaded photos live in a SQLite Durable Object (`CmsStore`), so a save shows on the site right away.
- Login: username in `wrangler.jsonc` (`ADMIN_USER`), password in the Worker secret `ADMIN_PASSWORD` (Cloudflare dashboard → Settings → Variables and secrets). Sessions last 8 hours; 8 wrong passwords lock an IP out for 15 minutes.
- Local: put `ADMIN_PASSWORD=...` in `.dev.vars` (not committed) and run `npx wrangler dev`.
