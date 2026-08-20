import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // An unbuilt TypeScript workspace package rather than a compiled dependency, so the
  // bundler has to compile it rather than consume it. Only @requirely/ui needs this:
  // @requirely/core is not a dependency here, and would not need an entry if it were
  // (verified — see this app's CLAUDE.md).
  transpilePackages: ['@requirely/ui'],

  // Note on TypeScript 7: `next build` typechecks by shelling out to the
  // project-local tsc (experimental.useTypeScriptCli, default true since 16.3).
  // That is the ONLY reason TS 7 works here — 7.0 ships no JS compiler API, so
  // the old in-process integration cannot load it. Do not set it to false.
};

export default nextConfig;
