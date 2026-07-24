# Problem Registry

Bugs, issues, and unexpected problems encountered during development.
Each entry records root cause and fix for future reference.

| ID | Date | Problem | Root Cause | Fix | Regression Test? |
|----|------|---------|-----------|-----|-----------------|
| P001 | 2026-07-24 | `npm install` fails with ERESOLVE | Conflicting peer deps between eslint packages | Use `yarn install` instead (project uses Yarn) | N/A — workflow |
| P002 | 2026-07-24 | TypeScript errors for `react-markdown` and `node-cron` | Missing type declarations, node_modules not fully installed | Run `yarn install` to resolve all dependencies | `yarn type:check` |
