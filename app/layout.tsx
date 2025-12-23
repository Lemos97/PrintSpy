import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'PrintSpy - 3D Printer Camera Monitor',
  description: 'Monitor multiple 3D printer cameras simultaneously',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}



