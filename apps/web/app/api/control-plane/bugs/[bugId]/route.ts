import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeBugDetail } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  context: { params: Promise<{ bugId: string }> },
) {
  try {
    const { bugId } = await context.params;
    return NextResponse.json({
      bug: sanitizeBugDetail(await controlPlane().getBug(bugId)),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取 Bug 详情');
  }
}
