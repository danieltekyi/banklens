/** Shared Worker bindings, so the route modules and the entry point agree. */
export type Bindings = {
  DB: D1Database;
  REPORTS: R2Bucket;
  ASSETS: Fetcher;
  ADMIN_API_KEY?: string;
  RESEND_API_KEY?: string;
  SESSION_PEPPER?: string;
};

export type AppEnv = { Bindings: Bindings };
