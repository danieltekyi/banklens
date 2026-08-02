# BankLens

A human-centered Ghana bank comparison app built with React, TypeScript, Cloudflare Workers, D1, R2 and Cron Triggers.

> All included financial figures are clearly marked demonstration data. Replace them with verified, sourced values before public launch.

## Local setup

1. Install Node.js 22+.
2. Run `npm install`.
3. Copy `.dev.vars.example` to `.dev.vars`.
4. Run `npm run db:local`.
5. Run `npm run dev`.
6. Open the local URL shown by Vite.

The app falls back to demo data if D1 is not configured, so the interface can still be tested immediately.

## Cloudflare setup

```bash
npx wrangler login
npx wrangler d1 create banklens-db
npx wrangler r2 bucket create banklens-reports
```

Copy the D1 database ID into `wrangler.jsonc`, then run:

```bash
npm run db:remote
npx wrangler secret put ADMIN_API_KEY
npm run deploy
```

In Cloudflare, add the custom domain `banklens.tiwaak.com` to the deployed Worker. Ensure `tiwaak.com` is active in the same Cloudflare account.

## GitHub

```bash
git init
git add .
git commit -m "Initial BankLens app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/banklens.git
git push -u origin main
```

For GitHub Actions, add repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Weekly scanner

The Monday 04:00 UTC Cron Trigger calls `worker/scanner.ts`. It checks only source URLs you add to the `sources` table, hashes responses, stores changed originals in R2, and writes an audit record. It deliberately does not auto-publish extracted numbers. Add a deterministic PDF/table extraction service and admin review workflow before production automation.

Test manually after local startup:

```bash
curl -X POST http://localhost:5173/api/admin/scan -H "Authorization: Bearer change-me-locally"
```

## Production checklist

- Replace demo figures with sourced data.
- Have the scoring methodology reviewed by a Ghanaian banking/compliance professional.
- Add Terms, Privacy, Corrections, Sources and Contact pages.
- Restrict CORS to your domain.
- Add Turnstile/rate limits to public forms.
- Configure monitoring and D1 backups.
- Respect source site terms, robots directives and reasonable request rates.

## Secure admin and smart discovery

Open `/admin`. The migration creates the initial username `banklensadmin` and initial password `banklensadmin`, with `must_change_password=1`. Change it immediately. Recovery email is `samueltekyi@gmail.com`. Configure outgoing reset email with `npx wrangler secret put RESEND_API_KEY`. Never commit that key.

The crawler starts from each enabled country's verified central-bank directory. Ghana is seeded with the Bank of Ghana registered-banks page. Candidate financial reports, product/rate pages, news and review links are stored for review. It does not perform unrestricted crawling or auto-publish unverified values.
