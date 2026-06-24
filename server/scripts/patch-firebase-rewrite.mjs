#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const firebasePath = path.join(root, "firebase.json");
const config = JSON.parse(readFileSync(firebasePath, "utf8"));

config.hosting.rewrites = [
  {
    source: "/api/**",
    run: {
      serviceId: "mm-scroller-api",
      region: process.env.GCP_REGION || "us-central1",
    },
  },
];

writeFileSync(firebasePath, `${JSON.stringify(config, null, 2)}\n`);
console.log("Added Cloud Run rewrite for mm-scroller-api");
