import { vi } from 'vitest';
vi.stubEnv('AUTH_SECRET', 'unit-test-only-secret-at-least-thirty-two-bytes');
vi.stubEnv('POSTGRES_URL', 'postgres://unused@127.0.0.1:1/unused');
vi.stubEnv('LEGACY_STRIPE_ENABLED', 'false');
vi.mock('server-only', () => ({}));

vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'synthetic-webhook-secret');
