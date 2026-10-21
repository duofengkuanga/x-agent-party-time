import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDirectories } from '../testing/directories';
import { CodexAppServerExecutor } from './appServer';

const directory = testDirectories('xapt-handoff-');

test('包含确认措辞的普通消息仍正常完成，不触发人工接管', async () => {
  const root = await directory();
  const executable = join(root, 'codex');
  await writeFile(
    executable,
    `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line), send=value=>console.log(JSON.stringify(value));
  if(m.method==='initialize') send({id:m.id,result:{}});
  if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'ordinary'}}});
  if(m.method==='turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'item/completed',params:{threadId:'ordinary',turnId:'turn',item:{type:'agentMessage',text:'确认过权限范围，继续验证。',delivery:'async'}}});
    send({method:'turn/completed',params:{threadId:'ordinary',turnId:'turn',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});
  }
});`,
    { mode: 0o700 },
  );
  const executor = new CodexAppServerExecutor(executable);
  let handoffs = 0;
  try {
    const execution = await executor.begin(
      {
        approvalPolicy: 'on-request',
        executionId: 'ordinary',
        repositoryPath: root,
        text: 'repair',
        skill: null,
        outputSchema: {},
        attachments: [],
        taskId: null,
        onInteraction: async () => ({}),
        onManualHandoff: async () => {
          handoffs++;
        },
      },
      new AbortController().signal,
    );
    expect(await execution.completion).toEqual({ ok: true });
    expect(handoffs).toBe(0);
  } finally {
    await executor.close();
  }
});

test('异步提问持久化后释放自己的会话进程，重复事件只交接一次', async () => {
  const root = await directory();
  const executable = join(root, 'codex');
  const children: ChildProcess[] = [];
  await writeFile(
    executable,
    `#!/usr/bin/env node
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  const send = value => console.log(JSON.stringify(value));
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'thread'}}});
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'turn'}}});
    for (const method of ['item/started','item/completed']) send({method,params:{threadId:'thread',turnId:'turn',item:{id:'question',type:'agentMessage',delivery:'async',phase:'final_answer',text:'确认修改权限？',questions:[{title:'确认修改权限？',options:null}]}}});
  }
  if (m.method === 'turn/interrupt') send({id:m.id,result:{}});
});
`,
    { mode: 0o700 },
  );
  const executor = new CodexAppServerExecutor(executable, ((
    ...args: Parameters<typeof spawn>
  ) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn);
  let prepared = 0;
  const input = {
    approvalPolicy: 'on-request' as const,
    executionId: 'execution',
    repositoryPath: root,
    text: 'repair',
    skill: null,
    outputSchema: {},
    attachments: [],
    taskId: null,
    onInteraction: async () => {
      throw new Error('异步消息不是同步审批');
    },
    onManualHandoff: async (questions: string[]) => {
      expect(questions).toEqual(['确认修改权限？']);
      expect(children[0]!.exitCode).toBeNull();
      prepared += 1;
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await executor.begin(input, new AbortController().signal);
    const result = await Promise.race([
      started.completion.catch((error) => error),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('仍占用会话'), 1000);
      }),
    ]);
    expect(result).toMatchObject({
      name: 'CodexManualHandoff',
      questions: ['确认修改权限？'],
    });
    expect(prepared).toBe(1);
    expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
  } finally {
    clearTimeout(timer);
    await executor.close();
  }
});
