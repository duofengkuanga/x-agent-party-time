import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';
import { sanitizeDeploymentBatch } from '@/lib/control-plane/public';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId)
      return NextResponse.json({ error: '缺少 projectId' }, { status: 400 });
    const batches = await controlPlane().listDeploymentBatches(projectId);
    return NextResponse.json({ items: batches.map(sanitizeDeploymentBatch) });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取部署批次');
  }
}
