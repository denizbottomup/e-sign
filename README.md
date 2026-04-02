# E-Sign

Lightweight document e-signing app. Upload PDFs, add signature fields, send for signing via email.

## Features
- PDF upload & signature field detection
- Dual-signature flow (sender + signer)
- Canvas signature (draw or auto-generated)
- Public signing links (no login required)
- Gmail integration for invitations

## Setup

```bash
npm install
cd web && npm install && npm run build && cd ..
npm start
```

## Environment Variables

```
PORT=3002
ANTHROPIC_API_KEY=...     # Optional: AI email generation
GOOGLE_CLIENT_SECRET=...  # Optional: Gmail sending
```
