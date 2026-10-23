import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { requireBindableFiles } from './attachments';

test('附件绑定统一验证归属和所有用途，仅允许复用当前缺陷的附件', () => {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE platform_file(id TEXT, uploaded_by_user_id TEXT)');
    db.run('CREATE TABLE submission_bug_attachment(file_id TEXT, bug_id TEXT)');
    const exclusive = [
      'submission_verification_attachment',
      'submission_reopen_attachment',
      'submission_external_deployment_report_attachment',
    ];
    for (const table of exclusive) db.run(`CREATE TABLE ${table}(file_id TEXT)`);
    db.run("INSERT INTO platform_file VALUES ('file', 'tester')");
    expect(() => requireBindableFiles(db, 'tester', ['file'])).not.toThrow();
    for (const [user, file] of [
      ['outsider', 'file'],
      ['tester', 'missing'],
    ])
      expect(() => requireBindableFiles(db, user!, [file!])).toThrow();
    db.run("INSERT INTO submission_bug_attachment VALUES ('file', 'bug')");
    expect(() => requireBindableFiles(db, 'tester', ['file'])).toThrow();
    expect(() => requireBindableFiles(db, 'tester', ['file'], 'bug')).not.toThrow();
    expect(() => requireBindableFiles(db, 'tester', ['file'], 'other')).toThrow();
    db.run('DELETE FROM submission_bug_attachment');
    for (const table of exclusive) {
      db.run(`INSERT INTO ${table} VALUES ('file')`);
      expect(() => requireBindableFiles(db, 'tester', ['file'])).toThrow();
      db.run(`DELETE FROM ${table}`);
    }
  } finally {
    db.close();
  }
});
