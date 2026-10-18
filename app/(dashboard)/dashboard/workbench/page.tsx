import { redirect } from 'next/navigation';
import { getUser } from '@/lib/db/queries';
import Workbench from './workbench';
export default async function WorkbenchPage() {
  if (!await getUser()) redirect('/sign-in');
  return <Workbench />;
}
