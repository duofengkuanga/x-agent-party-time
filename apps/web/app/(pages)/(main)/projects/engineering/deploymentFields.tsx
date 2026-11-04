import type { DeploymentScript } from '@/contracts/projects/engineering';

export function DeploymentFields({
  commandName = 'command',
  compact = false,
  deployment,
}: {
  commandName?: string;
  compact?: boolean;
  deployment?: DeploymentScript;
}) {
  return (
    <label className="field-wide">
      <span>部署命令</span>
      <input
        defaultValue={deployment?.command}
        maxLength={4000}
        name={commandName}
        placeholder="例如：bun run deploy:test"
        required
      />
      <small>
        {compact
          ? '由本机 Agent 执行，密钥使用环境变量'
          : '不要填写令牌、密码或密钥，请在 Agent 本机使用环境变量。'}
      </small>
    </label>
  );
}
