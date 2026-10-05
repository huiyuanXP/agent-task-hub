'use client';
import { useState, type FormEvent } from 'react';
export default function SignIn(){
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();setBusy(true);setError('');const data=new FormData(event.currentTarget);
  try{
   const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:data.get('username'),password:data.get('password')})});
   if(!response.ok){setError(response.status===429?'尝试次数过多，请稍后重试':'用户名或密码无效');return;}
   const value=new URLSearchParams(location.search).get('return_to')??'/';const url=new URL(value,location.origin);
   location.assign(value.startsWith('/')&&!value.startsWith('//')&&!/[\\\x00-\x20]/.test(value)&&url.origin===location.origin&&!/^\/(signin|api\/auth)(\/|$)/.test(url.pathname)?url.pathname+url.search+url.hash:'/');
  }catch{setError('暂时无法登录，请重试');}finally{setBusy(false);}
 }
 return <main style={{maxWidth:420,margin:'12vh auto',padding:24}}><h1>登录本地工作区</h1><p>使用本机创建的账户登录。</p><form onSubmit={submit}><label>用户名<input name="username" autoComplete="username" required maxLength={64}/></label><label>密码<input name="password" type="password" autoComplete="current-password" required maxLength={256}/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy} type="submit">{busy?'正在登录…':'登录'}</button></form></main>;
}
