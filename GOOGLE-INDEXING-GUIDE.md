# Getting OKV IMS indexed on Google

Two files are already in place at the root of this site: `robots.txt` and `sitemap.xml`.
Both currently point at a placeholder domain — replace it before going live.

## 1. Swap in your real domain

In **both** `robots.txt` and `sitemap.xml`, replace every occurrence of:

```
REPLACE-WITH-YOUR-DOMAIN.com
```

with your actual live domain (e.g. `app.okvtechnology.com` or whatever domain the
system is deployed to). Find-and-replace across both files — there are 7 occurrences total
(1 in robots.txt, 6 in sitemap.xml).

## 2. Confirm the files are reachable

Once deployed, both files must load directly in a browser:
- `https://yourdomain.com/robots.txt`
- `https://yourdomain.com/sitemap.xml`

If either 404s, your host isn't serving root-level files correctly — check that they sit
in the same folder as `index.html`, not in a subfolder.

## 3. Submit to Google Search Console

1. Go to [search.google.com/search-console](https://search.google.com/search-console) and sign in with the account you want to manage this from.
2. Add your domain as a property (Google will ask you to verify ownership — either via a DNS TXT record, or by uploading an HTML verification file your host gives you).
3. Once verified, open **Sitemaps** in the left menu, and submit `sitemap.xml`.
4. Google will crawl and index the pages over the following days to weeks — there's no way to force this instantly, but submitting the sitemap is what makes it happen faster than waiting for Google to find the site on its own.

## 4. What's included vs excluded

The sitemap only lists the **public marketing pages** — the ones you'd want a stranger
searching Google to land on: `index.html`, `pricing.html`, `signup.html`, `login.html`,
`privacy-policy.html`, `terms.html`.

`robots.txt` explicitly blocks the app itself (`app.html`, `demo.html`, `super-admin.html`,
`reset-password.html`, `install.html`) from being indexed — those are gated, per-organization,
or one-time-use pages with no reason to show up in search results, and indexing them could
expose internal URLs.

## 5. Optional but recommended

Each public HTML page already has a `<title>` and a `<meta name="description">` tag — those
are what show up in Google search results, so it's worth reviewing them are accurate and
compelling once you know the final domain and messaging.
