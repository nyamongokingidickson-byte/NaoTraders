// Vercel Node function — all API routes are dispatched by src/cloud/handler.js
//
// Vercel's zero-config build only detects plain-named files under api/, so a
// bracketed catch-all (api/[...path].js) is published as a static asset instead
// of being built as a function. vercel.json therefore rewrites every /api/* and
// /healthz request here, passing the original path in __p. This restores that
// path on req.url before delegating, so the router sees the request unchanged.
import { handler } from '../src/cloud/handler.js';

const PATH_PARAM = '__p';

export default function entry(req, res) {
  const original = req.query ? req.query[PATH_PARAM] : undefined;

  if (typeof original === 'string' && original.startsWith('/')) {
    const url = new URL(req.url, 'http://localhost');
    url.searchParams.delete(PATH_PARAM);
    const qs = url.searchParams.toString();
    req.url = original + (qs ? `?${qs}` : '');
  }

  return handler(req, res);
}
