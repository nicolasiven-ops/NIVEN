# NIVEN · MyHomeLab

Personal landing page and project hub for Nicol.

## Stack

- Static HTML / CSS / JS (no build step yet)
- Deployed on Vercel, auto-deploys on push to `main`
- Future: Supabase for data + auth, serverless functions in `/api/`

## Local dev

Serve the folder over HTTP (file:// breaks relative paths in some contexts):

```
python -m http.server 5173
```

Then open http://localhost:5173
