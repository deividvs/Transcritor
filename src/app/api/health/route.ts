import { NextResponse } from 'next/server'
import { BIN, INSTALL_HINT, missingBins } from '@/lib/bin'
import { ACCEPTED_UPLOAD, MAX_UPLOAD_BYTES, cloudKey, currentMode } from '@/lib/mode'

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
    upload: { maxBytes: MAX_UPLOAD_BYTES, accept: ACCEPTED_UPLOAD },
  })
}
