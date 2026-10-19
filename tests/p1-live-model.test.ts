import { expect, it } from 'vitest';
import { analyzeRequirement } from '@/lib/dealpilot/ai';
import { demoCases } from '@/lib/dealpilot/domain';
// No default paid calls. Explicit operator opt-in and server configuration required.
it.skipIf(process.env.P1_LIVE_MODEL_TEST !== 'true')('real configured model: fictional bilingual and missing-information cases', async () => {
  if (process.env.DEALPILOT_AI_MODE !== 'live' || !process.env.DEALPILOT_AI_API_KEY || !process.env.DEALPILOT_AI_MODEL) throw new Error('Live model test needs explicit server configuration');
  for (const input of demoCases) {
    const output = await analyzeRequirement(input); expect(output.mode).toBe('live');
    if (input === demoCases[2]) { expect(output.result.budget).toBeNull(); expect(output.result.delivery).toBeNull(); }
  }
}, 90000);
