import { Button } from '@requirely/ui/components/button';

/**
 * Structural placeholder, deliberately unstyled beyond the neutral b0 tokens.
 *
 * Its job is to prove the toolchain end to end — workspace symlink, the design
 * system's wildcard subpath export, transpilePackages, Tailwind's cross-package
 * class scan, and static prerendering — not to express any visual identity.
 * The design system is a separate, later task; nothing here should survive it.
 *
 * A server component with no data fetching, so Next prerenders it to HTML at
 * build time. Adding `'use client'` or an uncached fetch here would silently
 * turn this route dynamic.
 */
export default function Page() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-6">
      <div className="flex max-w-md flex-col gap-2 text-center">
        <h1 className="font-medium text-2xl">Requirely</h1>
        <p className="text-muted-foreground text-sm">
          Turns unstructured input into a complete understanding of what should be built.
        </p>
      </div>
      <Button>Placeholder</Button>
      <p className="font-mono text-muted-foreground text-xs">
        Press <kbd>d</kbd> to toggle dark mode
      </p>
    </main>
  );
}
