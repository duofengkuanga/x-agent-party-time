import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json({ error: '缺少 projectId' }, { status: 400 });
    return NextResponse.json({
      items: await controlPlane().listRepairDispatches(projectId),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取修复收集');
  }
}
