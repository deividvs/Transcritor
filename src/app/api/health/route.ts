import { NextResponse } from 'next/server'
import { BIN, INSTALL_HINT, missingBins } from '@/lib/bin'
import { cloudKey, currentMode, uploadLimits } from '@/lib/mode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const missing = missingBins()
  const mode = currentMode()
  const hasKey = Boolean(cloudKey())

  return NextResponse.json({
    mode,
    // No modo nuvem os binários locais não são requisito — a chave da Groq é.
    ok: mode === 'local' ? missing.length === 0 : hasKey,
    hasCloudKey: hasKey,
    bins: BIN,
    missing: missing.map((key) => ({ key, hint: INSTALL_HINT[key] })),
    // maxBytes 0 = sem teto (local grava por streaming).
    upload: uploadLimits(mode),
  })
}
