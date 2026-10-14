// Copyright 2026 XAGI Labs Private Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * The workflow `melra demo durable-core` runs. It ships inside the CLI because
 * the published package has no `examples/` directory: reading the repo's copy
 * worked from a checkout and failed with ENOENT from every npm install. A test
 * keeps it identical to examples/workflows/restart-safe.json, which the docs use.
 */
export const RESTART_SAFE_WORKFLOW = {
  "schemaVersion": "1.0.0",
  "id": "7d57f7ba-9b98-4ff5-8f73-a24fbaf66d28",
  "version": 1,
  "name": "restart-safe-verified-file",
  "nodes": [
    {
      "id": "inspect",
      "type": "operation",
      "dependsOn": [],
      "request": {
        "goal": "Inspect the local runtime",
        "operation": {
          "kind": "system",
          "action": "info"
        }
      }
    },
    {
      "id": "write",
      "type": "operation",
      "dependsOn": [
        "inspect"
      ],
      "request": {
        "goal": "Create a restart-safe verified artifact",
        "operation": {
          "kind": "file",
          "action": "write",
          "path": "durable-core-result.txt",
          "content": "verified after restart"
        },
        "requiredEvidence": [
          {
            "type": "file_exists",
            "path": "durable-core-result.txt"
          }
        ]
      }
    },
    {
      "id": "checkpoint",
      "type": "checkpoint",
      "dependsOn": [
        "write"
      ]
    }
  ]
} as const;
