import 'dotenv/config';
import { seedDevelopmentDatabase } from './seed-runner';

seedDevelopmentDatabase(process.env).then((result) => {
  console.log(result === 'created' ? 'Development account and team created.' : 'Account already exists; no changes made.');
}).catch(() => {
  // Never print supplied credentials, connection URLs or database error details.
  console.error('Development seed refused or failed. Check non-production opt-in, credentials and the development database.');
  process.exitCode = 1;
});
