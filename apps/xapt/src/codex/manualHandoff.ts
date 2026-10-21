import { asRecord } from './wireValues';

export class CodexManualHandoff extends Error {
  readonly name = 'CodexManualHandoff';
  constructor(readonly questions: string[]) {
    super('会话已交给工程负责人确认');
  }
}

export function asyncQuestions(value: unknown): string[] | null {
  const item = asRecord(value);
  if (
    item.type !== 'agentMessage' ||
    item.delivery !== 'async' ||
    !Array.isArray(item.questions)
  )
    return null;
  const questions = item.questions.map((question) => asRecord(question).title);
  if (
    !questions.length ||
    questions.some((question) => typeof question !== 'string' || !question.trim())
  )
    return null;
  return questions as string[];
}
