TIMONA — Geospatial and Surveying
Mapping Tomorrow, Today

WHAT'S IN THIS PACKAGE
  --- the website (static, no setup) ---
  index.html            Home page
  training.html         Training & capacity building (9 courses, enquiry form)
  sitetrackerpro.html   SiteTrackerPro product page
  demo/                 Interactive SiteTrackerPro demo (browser only)
  assets/style.css      Shared stylesheet
  img/                  Logo, favicons, icon set and photographs

  --- the real application (needs a server) ---
  sitetrackerpro-app/            Full Node.js + PostgreSQL application source,
                                 database schema, deploy scripts and docs
  DEPLOY-SITETRACKERPRO.txt      Start here to get it running

HOW TO VIEW THE WEBSITE
  Double-click index.html. Everything is static — no server, no build step.
  The demo is at demo/index.html.

HOW TO PUBLISH THE WEBSITE
  Upload the contents to any web host, keeping the folder structure:
      https://timonageospatialsurvey.com/
      https://timonageospatialsurvey.com/training.html
      https://timonageospatialsurvey.com/sitetrackerpro.html
      https://timonageospatialsurvey.com/demo/
  Works on Netlify, Cloudflare Pages, GitHub Pages, cPanel/FTP, Apache or Nginx.
  Do not upload sitetrackerpro-app/ to a static host — it needs Node + PostgreSQL.

CONTACT FORMS
  Both forms open the visitor's email app with the details filled in (mailto:),
  so they work on plain static hosting. Sending enquiries server-side instead
  needs a form endpoint.

IMPORTANT NOTES
  * Photographs are illustrative, from Wikimedia Commons (CC0 / CC BY / CC BY-SA).
    The credits panel at the bottom of the gallery lists the sources. Replace them
    with your own project photography before launch, or keep the credits visible.
  * The hero photo is the best image on hand; swapping in your own needs one line
    changed in index.html (search for img/hero-field.jpg).
  * The demo stores data in the browser only (localStorage). It is a sales demo,
    not the live product.

(c) 2026 TIMONA Geospatial and Surveying. All rights reserved.
