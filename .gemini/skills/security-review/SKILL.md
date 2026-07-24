---
name: security-review
description: Screen for secrets, tokens, .env files, sensitive logs, SQL injection, and auth bypass. Use before any commit or PR.
---

# Skill: security-review

## Objective
Prevent secrets and unsafe operations from entering the codebase.

## What to Check
- **Secrets in code**: API keys, tokens, passwords, connection strings hardcoded.
- **Secret files**: `.env`, `.env.*`, `google-key.json`, `client_secret.json`,
  `token.json` — must never be committed (check `.gitignore`).
- **SQL injection**: all queries must use parameterized values (`$1, $2, ...`).
- **Auth bypass**: API routes must check authentication where required.
- **Sensitive logs**: no tokens/PII in `console.log` or error messages.
- **XSS**: user input rendered with `dangerouslySetInnerHTML` must be sanitized.

## Checklist
- [ ] `git diff` scanned for secret patterns.
- [ ] No secret file added or modified.
- [ ] All SQL uses parameterized queries.
- [ ] API routes check authentication.
- [ ] No sensitive data logged.

## STOP conditions
- Any real secret found → **P0**, stop, do not proceed. Ask the human.
- Auth flow change needed → ask the human.
