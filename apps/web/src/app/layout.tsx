import type { Metadata, Viewport } from 'next';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { LiveProvider } from '@/components/live';
import './globals.css';

const archivo = Archivo({ subsets: ['latin'], axes: ['wdth'], variable: '--font-archivo', display: 'swap' });
const plexMono = IBM_Plex_Mono({ subsets: ['latin'], weight: '500', variable: '--font-plex-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'Control Room · Switchboard', template: '%s · Switchboard' },
  description: 'Switchboard for Northgate Plant & Access Hire: every hire desk on a live T-card rack, with its signals, drafts and sign-offs.',
  robots: { index: false, follow: false },
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EEF1F3' },
    { media: '(prefers-color-scheme: dark)', color: '#121518' },
  ],
};

// Theme before first paint: the saved choice, else the system preference (no flash on reload).
const themeScript = `try{var t=localStorage.getItem('sb-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" className={`${archivo.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <body data-overlay="off">
        <Script id="sb-theme" strategy="beforeInteractive">
          {themeScript}
        </Script>
        <LiveProvider>{children}</LiveProvider>
      </body>
    </html>
  );
}
