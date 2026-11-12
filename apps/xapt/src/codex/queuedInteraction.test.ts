import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDirectories } from '../testing/directories';
import { CodexAppServerExecutor } from './appServer';

const directory = testDirectories('xapt-queued-interaction-');

test('App Server 异常退出并留下孤儿工具时不把根进程消失当作释放证明', async () => {
  const root = await directory();
  const executable = join(root, 'codex');
  const pidPath = join(root, 'orphanPid');
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),send=v=>console.log(JSON.stringify(v));
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'crashed-session'}}});
 if(m.method!=='turn/start')return;
 send({id:m.id,result:{turn:{id:'turn'}}});
 cp.spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`)}],{detached:true,stdio:'ignore'});
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidPath)})){clearInterval(timer);process.exit(1);}},5);
});`,
    { mode: 0o700 },
  );
  const executor = new CodexAppServerExecutor(executable);
  const ownership: number[][] = [];
  let toolPid: number | undefined;
  try {
    const started = await executor.begin(
      {
        approvalPolicy: 'on-request',
        executionId: 'crashed',
        repositoryPath: root,
        text: 'work',
        skill: null,
        outputSchema: {},
        attachments: [],
        taskId: null,
        managedInteractions: true,
        onProcessGroups: async (groups) => {
          ownership.push(groups);
        },
        onInteraction: async () => ({}),
      },
      new AbortController().signal,
    );
    const failure = await started.completion.then(
      () => null,
      (error) => error,
    );
    toolPid = Number(await readFile(pidPath, 'utf8'));
    expect(failure).toMatchObject({
      name: 'CodexSessionReleaseError',
      ownershipUncertain: true,
    });
    expect(ownership.at(-1)?.length).toBeGreaterThan(0);
    expect(() => process.kill(toolPid!, 0)).not.toThrow();
  } finally {
    if (toolPid) {
      try {
        process.kill(toolPid, 'SIGKILL');
      } catch {}
    }
    await executor.close().catch(() => undefined);
  }
});

for (const options of [true, ['A', 7]])
  test('异步问题选项损坏时明确失败，不显示被删改的选择题', async () => {
    const root = await directory();
    const executable = join(root, 'codex');
    await writeFile(
      executable,
      `#!/usr/bin/env node
let resumed=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), send=v=>console.log(JSON.stringify(v));
 if(m.method==='initialize')send({id:m.id,result:{}});
 if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'invalid-question'}}});
 if(m.method==='thread/resume'){resumed=true;send({id:m.id,result:{thread:{id:'invalid-question'}}});}
 if(m.method==='turn/interrupt')send({id:m.id,result:{}});
 if(m.method!=='turn/start')return;
 send({id:m.id,result:{turn:{id:'turn'}}});
 if(resumed)send({method:'turn/completed',params:{threadId:'invalid-question',turnId:'turn',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});
 else send({method:'item/completed',params:{threadId:'invalid-question',turnId:'turn',item:{id:'question',type:'agentMessage',delivery:'async',questions:[{title:'选择？',options:${JSON.stringify(options)}}]}}});
});`,
      { mode: 0o700 },
    );
    const executor = new CodexAppServerExecutor(executable);
    let asked = false;
    try {
      const started = await executor.begin(
        {
          approvalPolicy: 'on-request',
          executionId: 'invalid-question',
          repositoryPath: root,
          text: 'work',
          skill: null,
          outputSchema: {},
          attachments: [],
          taskId: null,
          managedInteractions: true,
          onInteraction: async () => {
            asked = true;
            return { answers: { 'question:0': { answers: ['A'] } } };
          },
        },
        new AbortController().signal,
      );
      await expect(started.completion).rejects.toThrow('提问格式无效');
      expect(asked).toBe(false);
    } finally {
      await executor.close();
    }
  });

for (const managed of [true, false])
  test(
    managed
      ? '让位后独立进程组中的工具也退出，不能继续写工作区'
      : 'Update 完成保留工程脚本留下的后台进程',
    async () => {
      const root = await directory();
      const executable = join(root, 'codex');
      const pidPath = join(root, 'toolPid');
      await writeFile(
        executable,
        `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process');
let resumed=false;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line), send=v=>console.log(JSON.stringify(v));
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'owned-session'}}});
 if(m.method==='thread/resume'){resumed=true;send({id:m.id,result:{thread:{id:'owned-session'}}});}
 if(m.method==='turn/interrupt') send({id:m.id,result:{}});
 if(m.method!=='turn/start') return;
 send({id:m.id,result:{turn:{id:'turn'}}});
 if(resumed){send({method:'turn/completed',params:{threadId:'owned-session',turnId:'turn',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});return;}
 cp.spawn(process.execPath,['-e',${JSON.stringify(`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`)}],{stdio:'ignore',detached:${managed}});
 const timer=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(pidPath)}))return;clearInterval(timer);
 if(${managed})send({method:'item/completed',params:{threadId:'owned-session',turnId:'turn',item:{id:'question',type:'agentMessage',delivery:'async',questions:[{title:'继续？',options:null}]}}});
 else send({method:'turn/completed',params:{threadId:'owned-session',turnId:'turn',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'{"ok":true}'}]}}});},5);
});`,
        { mode: 0o700 },
      );
      const executor = new CodexAppServerExecutor(executable);
      let toolPid: number | undefined;
      try {
        const started = await executor.begin(
          {
            approvalPolicy: 'on-request',
            executionId: 'owned',
            repositoryPath: root,
            text: 'work',
            skill: null,
            outputSchema: {},
            attachments: [],
            taskId: null,
            managedInteractions: managed,
            onInteraction: async () => {
              toolPid = Number(await readFile(pidPath, 'utf8'));
              return { answers: { 'question:0': { answers: ['继续'] } } };
            },
          },
          new AbortController().signal,
        );
        expect(await started.completion).toEqual({ ok: true });
        toolPid = Number(await readFile(pidPath, 'utf8'));
        let alive = true;
        try {
          process.kill(toolPid!, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(!managed);
      } finally {
        if (toolPid) {
          try {
            process.kill(toolPid, 'SIGKILL');
          } catch {}
        }
        await executor.close();
      }
    },
  );

test('平台回答异步问题后，在原会话继续且保留完整选项', async () => {
  const root = await directory();
  const executable = join(root, 'codex');
  const children: ChildProcess[] = [];
  const ownership: number[][] = [];
  await writeFile(
    executable,
    `#!/usr/bin/env node
let resumed = false;
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line), send = value => console.log(JSON.stringify(value));
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/start') send({id:m.id,result:{thread:{id:'original-session'}}});
  if (m.method === 'thread/resume') {
    resumed = m.params.threadId === 'original-session';
    send({id:m.id,result:{thread:{id:m.params.threadId}}});
  }
  if (m.method === 'turn/interrupt') send({id:m.id,result:{}});
  if (m.method !== 'turn/start') return;
  send({id:m.id,result:{turn:{id:resumed?'second-turn':'first-turn'}}});
  if (!resumed) {
    send({method:'item/completed',params:{threadId:'original-session',turnId:'first-turn',item:{id:'question-item',type:'agentMessage',delivery:'async',text:'请选择',questions:[{title:'选择哪种修复？',options:['方案 A','方案 B']}]}}});
    return;
  }
  const text = JSON.stringify(m.params.input);
  const result = {choice:text.includes('方案 B')?'B':'missing'};
  send({method:'turn/completed',params:{threadId:'original-session',turnId:'second-turn',turn:{id:'second-turn',status:'completed',items:[{type:'agentMessage',text:JSON.stringify(result)}]}}});
});`,
    { mode: 0o700 },
  );
  const executor = new CodexAppServerExecutor(executable, ((
    ...args: Parameters<typeof spawn>
  ) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  let answered = false;
  try {
    const started = await executor.begin(
      {
        approvalPolicy: 'on-request',
        executionId: 'queued-interaction',
        repositoryPath: root,
        text: '修复问题',
        skill: null,
        outputSchema: {},
        attachments: [],
        taskId: null,
        managedInteractions: true,
        onProcessGroups: async (groups) => {
          ownership.push(groups);
        },
        onInteraction: async ({ method, payload }) => {
          expect(method).toBe('xapt/asyncQuestions');
          expect(payload).toMatchObject({
            questions: [
              {
                id: 'question-item:0',
                question: '选择哪种修复？',
                options: [{ label: '方案 A' }, { label: '方案 B' }],
              },
            ],
          });
          answered = true;
          return { answers: { 'question-item:0': { answers: ['方案 B'] } } };
        },
      },
      controller.signal,
    );
    expect(await started.completion).toEqual({ choice: 'B' });
    expect(started.sessionId).toBe('original-session');
    expect(answered).toBe(true);
    expect(ownership.at(-1)).toEqual([]);
    expect(
      children.every((child) => child.exitCode !== null || child.signalCode !== null),
    ).toBe(true);
  } finally {
    clearTimeout(timer);
    controller.abort();
    await executor.close();
  }
});
