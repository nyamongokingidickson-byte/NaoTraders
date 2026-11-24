// Diagnostics endpoint: confirms whether Vercel built api/ as a function at all.
export default function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.status(200).json({
    ok: true,
    where: 'vercel-function',
    node: process.version,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    url: req.url,
  });
}
