import { database } from '../server/database/index.ts';
import { AuthService } from '../server/auth/service.ts';

const password = process.env.AGENT_PARTY_TIME_SEED_PASSWORD ?? '123456';
const users = [
  { id: 'user-xujiequan', username: 'xujiequan', displayName: '徐捷泉' },
  { id: 'user-zhoumingbo', username: 'zhoumingbo', displayName: '周明波' },
  { id: 'user-tianguohui', username: 'tianguohui', displayName: '田国会' },
] as const;

const auth = new AuthService(database());
for (const user of users) await auth.seedUser({ ...user, password });

process.stdout.write(
  `已创建或确认 ${users.length} 个开发用户。默认密码来自 AGENT_PARTY_TIME_SEED_PASSWORD${process.env.AGENT_PARTY_TIME_SEED_PASSWORD ? '' : '（当前使用本地开发默认值）'}。\n`,
);
