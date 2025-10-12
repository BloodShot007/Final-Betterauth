require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { betterAuth } = require('better-auth');
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.EMAIL_PROVIDER_API_KEY;
const MAIL_FROM = process.env.MAIL_FROM || 'CerebraUI <onboarding@resend.dev>';
const SERVICE_PUBLIC_URL = process.env.SERVICE_PUBLIC_URL || 'http://localhost:4000';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

if (!RESEND_API_KEY) {
  console.warn('[BetterAuth] EMAIL_PROVIDER_API_KEY is not set. Test email route will fail until you set it.');
}

const resend = new Resend(RESEND_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

(async () => {
  const { Pool } = await import('pg');
  const { bearer } = await import('better-auth/plugins');
  const crypto = await import('node:crypto');

  // ---- DB Pool ----
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // tiny query helper
  async function q(text, params) {
    const { rows } = await pool.query(text, params);
    return rows;
  }

  // token helpers
  function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
  }
  
  function hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }
  
  function buildResetLink(token, redirectTo) {
    const base = redirectTo && redirectTo.startsWith('/') ? redirectTo : '/auth/reset-password/confirm';
    const url = new URL(base, FRONTEND_URL);
    url.searchParams.set('token', token);
    return url.toString();
  }

  // ---- BetterAuth ----
  const auth = betterAuth({
    database: pool,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    tokens: {
      emailVerificationTokenExpiresIn: '24h',
      passwordResetTokenExpiresIn: '1h',
    },
    plugins: [bearer()],
  });

  // ---- Auth Routes ----
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const result = await auth.api.signUpEmail({ body: req.body });
      res.json(result);
    } catch (err) {
      console.error('signup error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const result = await auth.api.signInEmail({ body: req.body });
      res.json(result);
    } catch (err) {
      console.error('login error:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // ==== PASSWORD RESET FLOWS ====

  // 1) Request password reset email
  app.post('/api/auth/forgot-password', async (req, res) => {
    try {
      const { email, redirectTo } = req.body || {};
      if (!email) return res.status(400).json({ error: '`email` is required' });

      console.log(`[Password Reset] Request received for email: ${email}`);

      const u = await q('SELECT id FROM "user" WHERE email = $1 LIMIT 1', [email.toLowerCase()]);
      
      if (u[0]) {
        const userId = u[0].id;
        const raw = randomToken(32);
        const hashed = hashToken(raw);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

        console.log(`[Password Reset] User found: ${userId}, creating reset token`);

        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS password_resets (
              user_id TEXT PRIMARY KEY,
              token_hash TEXT NOT NULL,
              expires_at TIMESTAMP NOT NULL,
              created_at TIMESTAMP DEFAULT NOW(),
              updated_at TIMESTAMP DEFAULT NOW()
            )
          `);
        } catch (e) {
          console.warn('[Password Reset] Table creation warning:', e.message);
        }

        await pool.query(
          `INSERT INTO password_resets(user_id, token_hash, expires_at, created_at, updated_at)
           VALUES ($1,$2,$3,NOW(),NOW())
           ON CONFLICT (user_id)
           DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, updated_at = NOW()`,
          [userId, hashed, expiresAt]
        );

        if (!RESEND_API_KEY) {
          console.error('[Password Reset] RESEND_API_KEY missing; skipping email send.');
        } else {
          const link = buildResetLink(raw, redirectTo);
          console.log(`[Password Reset] Sending email to ${email} with link: ${link}`);
          
          try {
            await resend.emails.send({
              from: MAIL_FROM,
              to: [email],
              subject: 'Reset your CerebraUI password',
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                  <h2>Reset Your Password</h2>
                  <p>You requested to reset your password for your CerebraUI account.</p>
                  <p>Click the button below to reset your password:</p>
                  <p style="margin: 30px 0;">
                    <a href="${link}" 
                       style="background-color: #A855F7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                      Reset Password
                    </a>
                  </p>
                  <p>Or copy and paste this link into your browser:</p>
                  <p style="word-break: break-all; color: #666;">${link}</p>
                  <p style="color: #999; font-size: 14px; margin-top: 30px;">
                    This link expires in 1 hour. If you didn't request this, please ignore this email.
                  </p>
                </div>
              `,
              text: `Reset your password: ${link}\n\nThis link expires in 1 hour.`,
            });
            
            console.log(`[Password Reset] Email sent successfully`);
          } catch (emailError) {
            console.error('[Password Reset] Email send error:', emailError);
            return res.status(500).json({ error: 'Failed to send reset email' });
          }
        }
      } else {
        console.log(`[Password Reset] No user found for email: ${email}`);
      }

      return res.json({ status: true, message: 'If an account exists, a reset link was sent.' });
    } catch (err) {
      console.error('[Password Reset] Error:', err);
      return res.status(500).json({ error: 'Internal error' });
    }
  });

  // 2) Confirm password reset with token + new password - USE BETTERAUTH NATIVE
  app.post('/api/auth/reset-password', async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });

      console.log(`[Password Reset Confirm] Verifying token`);

      const hashed = hashToken(String(token));
      const rows = await q(
        `SELECT pr.user_id, u.email
           FROM password_resets pr
           JOIN "user" u ON u.id = pr.user_id
          WHERE pr.token_hash = $1 AND pr.expires_at > NOW()
          LIMIT 1`,
        [hashed]
      );

      if (!rows[0]) {
        console.log(`[Password Reset Confirm] Invalid or expired token`);
        return res.status(400).json({ error: 'Invalid or expired token' });
      }

      const { user_id: userId, email } = rows[0];
      console.log(`[Password Reset Confirm] Valid token for user: ${userId}, email: ${email}`);

      // Use BetterAuth's native setPassword method instead of manual hashing
      try {
        // BetterAuth has internal methods for password hashing
        // We'll call the updatePassword API
        await auth.api.changePassword({
          body: {
            newPassword: password,
            // We need to provide current password or use internal method
            // Since this is a reset, we'll update directly but let BetterAuth handle hashing
          },
          // Create a temporary session context for this user
          headers: {
            'user-id': userId
          }
        });

        console.log('[Password Reset Confirm] BetterAuth changePassword succeeded');
      } catch (authError) {
        console.log('[Password Reset Confirm] changePassword failed, trying direct approach:', authError.message);
        
        // Import BetterAuth's internal crypto module
        const { hashPassword } = await import('better-auth/crypto');
        
        // Use BetterAuth's native password hashing
        const hashedPassword = await hashPassword(password);
        
        console.log('[Password Reset Confirm] Password hashed using BetterAuth crypto');

        // Update in account table
        const updateResult = await pool.query(
          `UPDATE account
              SET password = $1, "updatedAt" = NOW()
            WHERE "userId" = $2 AND "providerId" = 'credential'
           RETURNING id`,
          [hashedPassword, userId]
        );

        if (updateResult.rowCount === 0) {
          console.error('[Password Reset Confirm] No account found to update');
          return res.status(400).json({ error: 'No password account found' });
        }

        console.log('[Password Reset Confirm] Password updated using BetterAuth hash');
      }

      // Invalidate the reset token
      await pool.query('DELETE FROM password_resets WHERE user_id = $1', [userId]);

      console.log(`[Password Reset Confirm] Password reset complete for user: ${userId}`);

      return res.json({ status: true, message: 'Password has been reset successfully.' });
    } catch (err) {
      console.error('[Password Reset Confirm] Error:', err);
      return res.status(500).json({ error: 'Internal error: ' + err.message });
    }
  });

  // ---- Test Email (Resend) ----
  app.post('/api/auth/test-email', async (req, res) => {
    try {
      const { to } = req.body || {};
      if (!to) return res.status(400).json({ error: '`to` is required' });
      if (!RESEND_API_KEY) return res.status(500).json({ error: 'EMAIL_PROVIDER_API_KEY is not configured' });

      const response = await resend.emails.send({
        from: MAIL_FROM,
        to: Array.isArray(to) ? to : [to],
        subject: 'Resend test (dev)',
        html: '<p>Hello from <b>BetterAuth + Resend (dev)</b></p>',
        text: 'Hello from BetterAuth + Resend (dev)',
      });

      res.json({ ok: true, id: response?.data?.id || response?.id || null });
    } catch (e) {
      console.error('[Test Email] Error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // === EMAIL VERIFICATION ===

  app.post('/api/auth/request-verification', async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: '`email` is required' });

      const u = await q('SELECT id, "emailVerified" FROM "user" WHERE email = $1 LIMIT 1', [email]);
      const user = u[0];
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.emailVerified) return res.json({ ok: true, message: 'Already verified' });

      await q('DELETE FROM verification WHERE identifier = $1', [email]);

      const raw = randomToken(32);
      const hashed = hashToken(raw);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await q(
        `INSERT INTO verification (identifier, value, "expiresAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [email, hashed, expiresAt]
      );

      const verifyLink = `${SERVICE_PUBLIC_URL}/api/auth/verify?token=${encodeURIComponent(raw)}&email=${encodeURIComponent(email)}`;

      await resend.emails.send({
        from: MAIL_FROM,
        to: [email],
        subject: 'Verify your email',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Verify Your Email</h2>
            <p>Thanks for joining CerebraUI!</p>
            <p>Click the button below to verify your email address:</p>
            <p style="margin: 30px 0;">
              <a href="${verifyLink}" 
                 style="background-color: #A855F7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                Verify Email
              </a>
            </p>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verifyLink}</p>
            <p style="color: #999; font-size: 14px; margin-top: 30px;">
              This link expires in 24 hours.
            </p>
          </div>
        `,
        text: `Verify your email: ${verifyLink}`,
      });

      res.json({ ok: true });
    } catch (e) {
      console.error('[Verification] Error:', e);
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/auth/verify', async (req, res) => {
    try {
      const { token, email } = req.query || {};
      if (!token || !email) return res.status(400).send('Missing token or email');

      const hashed = hashToken(String(token));
      const rows = await q(
        `SELECT 1 FROM verification
         WHERE identifier = $1 AND value = $2 AND "expiresAt" > NOW()
         LIMIT 1`,
        [email, hashed]
      );

      if (!rows[0]) return res.status(400).send('Invalid or expired token');

      await q(`UPDATE "user" SET "emailVerified" = true, "updatedAt" = NOW() WHERE email = $1`, [email]);
      await q(`DELETE FROM verification WHERE identifier = $1 AND value = $2`, [email, hashed]);

      res.redirect(`${FRONTEND_URL}/auth/login?verified=true`);
    } catch (e) {
      console.error('[Verification Confirm] Error:', e);
      res.status(400).send('Verification failed');
    }
  });

  // ---- Session Introspection ----
  app.get('/api/auth/me', async (req, res) => {
    try{
      const authHeader = req.headers.authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
      }
      const session = await auth.api.getSession({ headers: req.headers });
      if (!session?.user) return res.status(401).json({ error: 'Invalid session' });
      res.json({ user: session.user });
    } catch (e) {
      console.error('me error:', e);
      res.status(400).json({ error: e.message });
    }
  });

  console.log('🔧 Configuration:');
  console.log(`  - RESEND_API_KEY: ${RESEND_API_KEY ? '✅ Set' : '❌ Missing'}`);
  console.log(`  - MAIL_FROM: ${MAIL_FROM}`);
  console.log(`  - FRONTEND_URL: ${FRONTEND_URL}`);
  console.log(`  - SERVICE_PUBLIC_URL: ${SERVICE_PUBLIC_URL}`);

  app.listen(4000, () => console.log('✅ BetterAuth service running on port 4000'));
})();