import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const cliEnv = {
  ...process.env, NODE_OPTIONS: '', NODE_ENV: 'development' as const, ALLOW_DEV_SEED: 'false',
  POSTGRES_URL: 'postgres://unused@127.0.0.1:1/unused',
  SEED_EMAIL: 'cli@example.invalid', SEED_PASSWORD: 'synthetic-cli-password'
};

it('loads seed dependencies in real Node/tsx and preserves bcrypt compatibility without mocks', async () => {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import bcrypt from 'bcryptjs';
    const imported = await import('./lib/auth/passwords.ts');
    const passwords = imported.default ?? imported;
    const runner = await import('./lib/db/seed-runner.ts');
    assert.equal(typeof (runner.default ?? runner).seedDevelopmentDatabase, 'function');
    const legacy = await bcrypt.hash('legacy-test-password', 10);
    assert.equal(await passwords.comparePasswords('legacy-test-password', legacy), true);
    assert.equal(await passwords.comparePasswords('legacy-test-password', legacy.replace('$2b$', '$2a$')), true);
    const current = await passwords.hashPassword('new-test-password');
    assert.equal(bcrypt.getRounds(current), 10);
    assert.equal(await bcrypt.compare('new-test-password', current), true);
    assert.equal(await passwords.comparePasswords('wrong-password', current), false);
    console.log('CLI imports and bcrypt compatibility OK');
  `], { env: cliEnv });
  expect(stdout.trim()).toBe('CLI imports and bcrypt compatibility OK');
});

it.each([
  { ALLOW_DEV_SEED: 'false', NODE_ENV: 'development' as const },
  { ALLOW_DEV_SEED: 'true', NODE_ENV: 'production' as const },
  { ALLOW_DEV_SEED: 'true', NODE_ENV: 'development' as const, SEED_PASSWORD: '' }
])('refuses unauthorized, production or invalid seed before connecting: %j', async (overrides) => {
  try {
    await exec(process.execPath, ['--import', 'tsx', 'lib/db/seed.ts'], { env: { ...cliEnv, ...overrides } });
    throw new Error('Seed unexpectedly succeeded');
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Development seed refused or failed');
    expect(result.stderr).not.toContain('Server Component');
    expect(result.stderr).not.toContain('synthetic-cli-password');
    expect(result.stderr).not.toContain('postgres://');
    expect(result.stdout).not.toContain('created');
  }
});
