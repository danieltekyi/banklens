# Architecture

Browser -> Cloudflare Worker -> Hono API -> D1

Static React assets are built with the Cloudflare Vite plugin. The Worker exposes read-only public API routes and an authenticated scan route. Weekly Cron invokes the scanner. Source artifacts are stored in R2; normalized, reviewed records are published from D1.

## LLM-ready boundary

The scanner, extractor, validator and publisher are separate concerns. A future model can implement an `Extractor` interface and create draft records, but it should never publish values directly. Retrieval/chat can later read cited normalized data and R2 documents without changing the consumer UI.
