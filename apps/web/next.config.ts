import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Both are unbuilt TypeScript workspace packages rather than compiled
  // dependencies, so the bundler has to compile them rather than consume them.
  transpilePackages: ['@requirely/ui'],

  // Note on TypeScript 7: `next build` typechecks by shelling out to the
  // project-local tsc (experimental.useTypeScriptCli, default true since 16.3).
  // That is the ONLY reason TS 7 works here — 7.0 ships no JS compiler API, so
  // the old in-process integration cannot load it. Do not set it to false.
};

export default nextConfig;
