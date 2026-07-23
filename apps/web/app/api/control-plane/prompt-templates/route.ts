import { NextResponse } from 'next/server';
import { controlPlane, controlPlaneFailure } from '@/lib/control-plane/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({
      items: await controlPlane().listPromptTemplates(),
    });
  } catch (error) {
    return controlPlaneFailure(error, '无法读取提示词模板');
  }
}
