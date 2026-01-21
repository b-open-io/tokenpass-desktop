import type { ElectrobunConfig } from "electrobun";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("./package.json", "utf8"));

const config: ElectrobunConfig = {
  app: {
    name: "TokenPass",
    identifier: "app.tokenpass",
    version: packageJson.version,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
      external: [],
    },
    copy: {
      // Tray icon
      "extraResources/icon.png": "views/assets/icon.png",
      // Bundle the entire Next.js standalone server
      "server": "server",
    },
    mac: {
      codesign: true,
      notarize: true,
      bundleCEF: true, // Required for BrowserWindow
      entitlements: {},
      icons: "icon.iconset",
    },
    linux: {
      bundleCEF: true, // Required for BrowserWindow
    },
    win: {
      bundleCEF: true, // Required for BrowserWindow
    },
  },
  release: {
    bucketUrl: process.env.RELEASE_BUCKET_URL || "",
  },
};

export default config;
