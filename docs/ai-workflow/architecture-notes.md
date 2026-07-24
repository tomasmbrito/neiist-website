# Architecture Notes

Key architectural patterns and conventions in the NEIIST Website codebase.

## Database Access Pattern
- Single `pg.Pool` instance in `src/utils/dbUtils.ts`.
- All queries use parameterized SQL (`$1, $2, ...`).
- DB rows are mapped to TypeScript interfaces via mapper functions.
- Schema is defined in `docker/schema.sql` under the `neiist` schema.
- Schema uses a dedicated `neiist_app_user` role for application access.

## Authentication
- Fenix OAuth flow via `src/utils/authUtils.ts`.
- Callback at `/api/auth/callback`.
- Session management via cookies/JWT.

## Deployment
- Blue/green deployment via PM2 on production server.
- GitHub Actions workflows trigger on release (prod) or push to staging branch.
- SSH-based deployment scripts in `scripts/`.

## Key Integration Points
- **Notion API**: Calendar events sync (`@notionhq/client`).
- **Google Calendar**: Service account integration (`googleapis`).
- **Google Drive**: File uploads (CVs, sweats photos).
- **SumUp**: Payment processing for shop.
- **Nodemailer**: Email sending via SMTP.
