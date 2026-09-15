# Trading Platform

This repository contains **Phase 1 only**: the architecture and TypeScript domain-contract foundation for a multi-market trading platform. It is not production-ready and cannot trade, connect to brokers, persist financial records, or enable live execution.

## Commands

Use Node.js `22.23.2` (pinned in [`.nvmrc`](.nvmrc)) before installing dependencies. The default system `node` may be a different version; load the pinned runtime (for example, `nvm use`) and verify `node --version` before running install, build, test, or audit commands.

```sh
npm install
npm run typecheck
npm test
```

See [`docs/architecture.md`](docs/architecture.md) and [`docs/open-decisions.md`](docs/open-decisions.md) before starting another phase.
