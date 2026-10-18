import './globals.css';
import type { Metadata, Viewport } from 'next';
import { getUser, getTeamForUser } from '@/lib/db/queries';
import { SWRConfig } from 'swr';

export const metadata: Metadata = {
  title: 'DealPilot AI | 智能需求与报价',
  description: '客户需求管理、AI 需求分析与人工确认报价工作台。'
};

export const viewport: Viewport = {
  maximumScale: 1
};


export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className={`bg-white dark:bg-gray-950 text-black dark:text-white font-sans`}
    >
      <body className="min-h-[100dvh] bg-gray-50">
        <SWRConfig
          value={{
            fallback: {
              // We do NOT await here
              // Only components that read this data will suspend
              '/api/user': getUser(),
              '/api/team': getTeamForUser()
            }
          }}
        >
          {children}
        </SWRConfig>
      </body>
    </html>
  );
}
