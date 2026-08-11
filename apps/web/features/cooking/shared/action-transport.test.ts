import { expect, test } from 'bun:test';
import { RedirectType } from 'next/navigation';
import {
  runInteractiveMutation,
  runRedirectMutation,
  type InteractiveTransportDependencies,
} from './action-transport';

test('Interactive transport 统一上传、refresh 与未绑定文件清理', async () => {
  const deleted: string[] = [];
  const refreshed: string[] = [];
  let nextFile = 0;
  const dependencies: InteractiveTransportDependencies = {
    currentUser: async () => ({ id: 'user-one' }),
    fileStore: () =>
      ({
        put: async () => ({ id: `file-${++nextFile}` }),
        deleteUnbound: async (fileId: string) => {
          deleted.push(fileId);
          return true;
        },
      }) as never,
    refresh: (path) => refreshed.push(path),
    logValidation: () => {},
  };
  const formData = new FormData();
  formData.append(
    'attachments',
    new File(['evidence'], 'evidence.txt', { type: 'text/plain' }),
  );
  const success = await runInteractiveMutation(
    {
      validationEvent: 'test_validation',
      command: async ({ uploadFiles }) => {
        const uploaded = await uploadFiles(formData, 'attachments');
        return {
          result: { uploaded },
          boundFileIds: uploaded,
          cleanupFileIds: ['old-file'],
          refreshPaths: ['/cooking'],
        };
      },
    },
    dependencies,
  );
  expect(success).toEqual({ ok: true, result: { uploaded: ['file-1'] } });
  expect(deleted).toEqual(['old-file']);
  expect(refreshed).toEqual(['/cooking']);

  const failure = await runInteractiveMutation(
    {
      validationEvent: 'test_validation',
      command: async ({ uploadFiles }) => {
        await uploadFiles(formData, 'attachments');
        throw new Error('domain failed');
      },
    },
    dependencies,
  );
  expect(failure).toEqual({
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用，请稍后重试。' },
  });
  expect(deleted).toEqual(['old-file', 'file-2']);
});

test('Redirect transport 对成功与失败都生成 replace redirect', async () => {
  const redirects: Array<{
    path: string;
    type: typeof RedirectType.replace;
  }> = [];
  const dependencies = {
    currentUser: async () => ({ id: 'user-one' }),
    refresh: () => {},
    redirect: (path: string, type: typeof RedirectType.replace): never => {
      redirects.push({ path, type });
      throw new Error('redirected');
    },
  };
  await expect(
    runRedirectMutation(
      {
        formData: new FormData(),
        errorPath: () => '/error-parent',
        command: () => ({ path: '/success-parent', message: '已完成' }),
      },
      dependencies,
    ),
  ).rejects.toThrow('redirected');
  await expect(
    runRedirectMutation(
      {
        formData: new FormData(),
        errorPath: () => '/error-parent',
        command: () => {
          throw new Error('failed');
        },
      },
      dependencies,
    ),
  ).rejects.toThrow('redirected');

  expect(redirects).toHaveLength(2);
  expect(redirects[0]).toMatchObject({ type: RedirectType.replace });
  expect(redirects[0]!.path).toContain('/success-parent?success=');
  expect(redirects[1]).toMatchObject({ type: RedirectType.replace });
  expect(redirects[1]!.path).toContain('/error-parent?error=');
});
