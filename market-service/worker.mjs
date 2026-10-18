/* Private personal quote service. Does not receive or store financial account data. */
const DAY=86400000,MAX_CALLS=20,TICKER=/^[A-Z]{1,6}(?:[.-][A-Z])?$/;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export async function tokenMatches(given,expected){
  if(!expected||!given||given.length>200)return false;
  const enc=new TextEncoder(),[a,b]=await Promise.all([crypto.subtle.digest('SHA-256',enc.encode(given)),crypto.subtle.digest('SHA-256',enc.encode(expected))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let different=0;for(let n=0;n<x.length;n++)different|=x[n]^y[n];return different===0;
}
export function normalizeDaily(body,symbol,now=Date.now()){
  const data=body?.['Time Series (Daily)'];if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Daily prices unavailable');
  const today=new Date(now).toISOString().slice(0,10),history=Object.entries(data).map(([date,row])=>{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||date>today||!/^\d+(\.\d+)?$/.test(String(row?.['4. close'])))throw Error('Invalid daily price');
    const close=Math.round(Number(row['4. close'])*100);if(!Number.isSafeInteger(close)||close<=0||close>1e12)throw Error('Invalid daily price');return {date,close};
  }).sort((a,b)=>a.date.localeCompare(b.date)).slice(-100);
  if(history.length<2)throw Error('Insufficient daily data');
  return {symbol,currency:'USD',price:history.at(-1).close,previousClose:history.at(-2).close,asOf:history.at(-1).date,fetchedAt:new Date(now).toISOString(),history};
}
export default {
  async fetch(request,env){
    const origin=request.headers.get('Origin'),allowed=env.ALLOWED_ORIGIN;
    const wrap=response=>{const headers=new Headers(response.headers);if(origin===allowed){headers.set('Access-Control-Allow-Origin',allowed);headers.set('Vary','Origin');}headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});};
    if(!allowed||!env.ALPHA_VANTAGE_KEY||!env.POCKET_PLAN_TOKEN||!env.QUOTES)return wrap(json({error:'Finish configuring the service secrets and allowed origin.'},503));
    if(origin!==allowed)return wrap(json({error:'Origin not allowed'},403));
    if(request.method==='OPTIONS')return wrap(new Response(null,{status:204,headers:{'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Authorization','Access-Control-Max-Age':'3600'}}));
    if(request.method!=='GET')return wrap(json({error:'Method not allowed'},405));
    const given=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
    if(!await tokenMatches(given,env.POCKET_PLAN_TOKEN))return wrap(json({error:'Unauthorized'},401));
    const url=new URL(request.url);if(url.pathname==='/health')return wrap(json({ready:true,requestCap:MAX_CALLS,cacheHours:24}));
    if(url.pathname!=='/quote')return wrap(json({error:'Not found'},404));
    const symbol=url.searchParams.get('symbol')||'',symbols=(env.ALLOWED_SYMBOLS||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);
    if(!TICKER.test(symbol))return wrap(json({error:'Invalid U.S. USD ticker'},400));
    if(!symbols.includes(symbol))return wrap(json({error:'Symbol not allowed'},403));
    try{
      const stub=env.QUOTES.get(env.QUOTES.idFromName('personal-quotes-v1'));
      return wrap(await stub.fetch(new Request('https://internal/quote?symbol='+encodeURIComponent(symbol))));
    }catch(_){return wrap(json({error:'Quote service temporarily unavailable'},503));}
  }
};
export class QuoteStore {
  constructor(state,env){this.state=state;this.env=env;}
  async fetch(request){
    return this.state.blockConcurrencyWhile(async()=>{
      const symbol=new URL(request.url).searchParams.get('symbol');if(!TICKER.test(symbol||''))return json({error:'Invalid symbol'},400);
      const now=Date.now(),key='quote:'+symbol,cache=await this.state.storage.get(key);
      if(cache&&now-Date.parse(cache.fetchedAt)<DAY)return json(cache);
      const failure=await this.state.storage.get('failure:'+symbol);if(failure&&failure.until>now)return json({error:failure.message},failure.status);
      const blockedUntil=await this.state.storage.get('blockedUntil');if(blockedUntil>now)return json({error:'Provider allowance unavailable; try later'},429);
      const calls=(await this.state.storage.get('calls')||[]).filter(t=>t>now-DAY);
      if(calls.length>=MAX_CALLS)return json({error:'Personal service daily request cap reached'},429);
      // Reserve before any external I/O; failures count too. One persistent singleton serializes callers.
      calls.push(now);await this.state.storage.put('calls',calls);
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
      try{
        const url=new URL('https://www.alphavantage.co/query');url.searchParams.set('function','TIME_SERIES_DAILY');url.searchParams.set('symbol',symbol);url.searchParams.set('outputsize','compact');url.searchParams.set('apikey',this.env.ALPHA_VANTAGE_KEY);
        const response=await fetch(url,{signal:controller.signal,redirect:'error'});
        if(!response.ok)throw Error('Provider unavailable');
        const body=await response.json();
        if(body?.Information||body?.Note){await this.state.storage.put('blockedUntil',now+DAY);return json({error:'Provider limit or access restriction. Check your Alpha Vantage plan/key; retry later.'},429);}
        if(body?.['Error Message']){await this.state.storage.put('failure:'+symbol,{until:now+DAY,status:422,message:'Symbol unsupported by daily-price provider'});return json({error:'Symbol unsupported by daily-price provider'},422);}
        const quote=normalizeDaily(body,symbol,now);await this.state.storage.put(key,quote);return json(quote);
      }catch(_){await this.state.storage.put('failure:'+symbol,{until:now+300000,status:502,message:'Could not retrieve a valid daily price; try again later'});return json({error:'Could not retrieve a valid daily price; previous app price is unchanged'},502);}
      finally{clearTimeout(timer);}
    });
  }
}
