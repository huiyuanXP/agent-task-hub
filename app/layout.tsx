import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'点子工坊 · Agent Task Hub',description:'从原始点子到可验收的任务',icons:{icon:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
