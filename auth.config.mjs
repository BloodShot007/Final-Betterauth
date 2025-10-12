// auth.config.mjs
import 'dotenv/config';
import { betterAuth } from 'better-auth';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const auth = betterAuth({
  database: pool, // Postgres via pg.Pool
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
});

// Export both ways so the CLI can find it
export default auth;
