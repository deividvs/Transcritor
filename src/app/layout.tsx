import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Transcritor',
  description: 'Baixa vídeo do YouTube/Instagram, converte para MP3 e transcreve localmente.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen bg-zinc-950 text-zinc-200 antialiased">{children}</body>
    </html>
  )
}
