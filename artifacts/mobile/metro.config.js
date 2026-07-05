const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// pdfkit is a server-only dependency (used by the API server for PDF export).
// It is never imported by the mobile app, but pnpm hoists it into the shared
// workspace node_modules, where Metro's file crawler would otherwise try to
// watch it — including transient pnpm install staging dirs (pdfkit_tmp_*),
// whose disappearance crashes the watcher with ENOENT. Block it from Metro.
config.resolver.blockList = /\/node_modules\/\.pnpm\/pdfkit@[^/]+\/.*/;

module.exports = config;
