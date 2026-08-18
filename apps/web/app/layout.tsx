import { cn } from '@requirely/ui/lib/utils';
import type { Metadata } from 'next';
import { Geist_Mono, Inter } from 'next/font/google';
import '@requirely/ui/globals.css';

import { ThemeProvider } from '@/components/theme-provider';

/**
 * `next/font/google` downloads and self-hosts the font at BUILD time, so a cold
 * `next build` needs network access. Offline, it fails with a font error that
 * reads like a bundler problem. Switch to `next/font/local` if that becomes a
 * constraint.
 *
 * `variable: '--font-sans'` is the wiring the design system depends on:
 * globals.css maps Tailwind's --font-sans theme token to this CSS variable
 * inside `@theme inline`, so the font reaches every component through the token
 * rather than through a class on the body.
 */
const fontSans = Inter({ subsets: ['latin'], variable: '--font-sans' });
const fontMono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' });

export const metadata: Metadata = {
  title: 'Requirely',
  description: 'Turns unstructured input into a complete understanding of what should be built.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is required by next-themes: it writes the theme
    // class onto <html> before React hydrates, so server and client markup
    // legitimately differ on this one element.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn('antialiased', 'font-sans', fontSans.variable, fontMono.variable)}
    >
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
