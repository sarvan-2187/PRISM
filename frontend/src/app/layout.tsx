import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PRISM — Payment Risk & Intent Security Model',
  description: 'Secure 4-layer payment authentication system',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
