/**
 * Phase 1 import-graph policy. Rules are evaluated against actual resolved
 * TypeScript imports by dependency-cruiser, not source-text substring scans.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular-dependencies",
      severity: "error",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-unresolved-typescript-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true }
    },
    {
      name: "domain-packages-must-not-depend-on-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" }
    },
    {
      name: "postgres-drivers-must-remain-inside-database",
      severity: "error",
      from: { pathNot: "^packages/database/" },
      to: { path: "^node_modules/(pg|kysely)/" }
    },
    {
      name: "api-may-depend-only-on-phase4-boundaries",
      severity: "error",
      from: { path: "^apps/api/" },
      to: { pathNot: "^(apps/api/|packages/(core|database|shared)/|node_modules/argon2/|(node:)?(crypto|fs(?:/promises)?|path|readline|process)$)" }
    },
    {
      name: "api-must-not-depend-on-domain-engines",
      severity: "error",
      from: { path: "^apps/api/" },
      to: { path: "^packages/(market-data|strategies|risk|trading|portfolio|execution)/" }
    },
    {
      name: "worker-must-not-depend-on-auth-or-database",
      severity: "error",
      from: { path: "^apps/worker/" },
      to: { path: "^(apps/api/|packages/database/)" }
    },
    {
      name: "shared-must-remain-foundational",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { pathNot: "^packages/shared/" }
    },
    {
      name: "core-may-depend-only-on-shared",
      severity: "error",
      from: { path: "^packages/core/" },
      to: { pathNot: "^packages/(core|shared)/" }
    },
    {
      name: "database-may-depend-only-on-approved-contracts-and-drivers",
      severity: "error",
      from: { path: "^packages/database/" },
      to: { pathNot: "^(packages/(database|core|shared)/|node_modules/(kysely|pg)/|(fs|path)$)" }
    },
    {
      name: "market-data-may-depend-only-on-shared",
      severity: "error",
      from: { path: "^packages/market-data/" },
      to: { pathNot: "^packages/(market-data|shared)/" }
    },
    {
      name: "trading-may-depend-only-on-shared",
      severity: "error",
      from: { path: "^packages/trading/" },
      to: { pathNot: "^packages/(trading|shared)/" }
    },
    {
      name: "strategies-allowed-dependencies",
      severity: "error",
      from: { path: "^packages/strategies/" },
      to: { pathNot: "^packages/(strategies|shared|market-data|trading)/" }
    },
    {
      name: "strategies-must-not-depend-on-execution",
      severity: "error",
      from: { path: "^packages/strategies/" },
      to: { path: "^packages/execution/" }
    },
    {
      name: "risk-may-depend-only-on-trading",
      severity: "error",
      from: { path: "^packages/risk/" },
      to: { pathNot: "^packages/(risk|trading)/" }
    },
    {
      name: "portfolio-may-depend-only-on-shared",
      severity: "error",
      from: { path: "^packages/portfolio/" },
      to: { pathNot: "^packages/(portfolio|shared)/" }
    },
    {
      name: "execution-may-depend-only-on-trading",
      severity: "error",
      from: { path: "^packages/execution/" },
      to: { pathNot: "^packages/(execution|trading)/" }
    },
    {
      name: "execution-must-not-depend-on-strategies",
      severity: "error",
      from: { path: "^packages/execution/" },
      to: { path: "^packages/strategies/" }
    },
    {
      name: "web-must-not-depend-on-execution",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/execution/" }
    },
    {
      name: "web-must-not-depend-on-database",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/database/" }
    },
    {
      name: "apps-must-not-depend-on-other-apps",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" }
    }
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    // Domain contracts are mostly `import type`; include them in the graph.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" }
  }
};
