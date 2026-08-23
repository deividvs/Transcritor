import { NextResponse } from 'next/server'
import { BIN, INSTALL_HINT, missingBins } from '@/lib/bin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const missing = missingBins()
  return NextResponse.json({
    ok: missing.length === 0,
    bins: BIN,
    missing: missing.map((key) => ({ key, hint: INSTALL_HINT[key] })),
  })
}
