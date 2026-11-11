// Fixed city coordinates only. No geolocation, key, account, storage or paid API.
export const WEATHER_URL='https://api.open-meteo.com/v1/forecast?latitude=43.589&longitude=-79.644&current=temperature_2m,precipitation,rain,snowfall,weather_code,cloud_cover&timezone=UTC';
export const WEATHER_REFRESH_MS=15*60*1000;
export const WEATHER_STALE_MS=90*60*1000;
const clamp=n=>Math.max(0,Math.min(1,n));
const labels=new Map([[0,'Clear'],[1,'Mainly clear'],[2,'Partly cloudy'],[3,'Overcast'],[45,'Fog'],[48,'Rime fog'],[51,'Light drizzle'],[53,'Drizzle'],[55,'Dense drizzle'],[56,'Freezing drizzle'],[57,'Dense freezing drizzle'],[61,'Light rain'],[63,'Rain'],[65,'Heavy rain'],[66,'Freezing rain'],[67,'Heavy freezing rain'],[71,'Light snow'],[73,'Snow'],[75,'Heavy snow'],[77,'Snow grains'],[80,'Light showers'],[81,'Showers'],[82,'Heavy showers'],[85,'Light snow showers'],[86,'Snow showers'],[95,'Thunderstorm'],[96,'Thunderstorm with hail'],[99,'Thunderstorm with heavy hail']]);
const rainCodes=new Set([51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99]),snowCodes=new Set([71,73,75,77,85,86]);
export function parseWeather(data,{now=Date.now()}={}){
 const c=data?.current,u=data?.current_units;
 if(!c||u?.temperature_2m!=='°C'||u?.precipitation!=='mm'||u?.rain!=='mm'||u?.snowfall!=='cm'||u?.cloud_cover!=='%')throw Error('Weather response units unavailable or unexpected');
 const timestamp=Date.parse(c.time+( /(?:Z|[+-]\d\d:\d\d)$/.test(c.time)?'':'Z'));
 if(data.utc_offset_seconds!==0||!Number.isFinite(timestamp)||timestamp>now+30*60*1000||!['temperature_2m','precipitation','rain','snowfall','weather_code','cloud_cover'].every(k=>Number.isFinite(c[k]))||c.cloud_cover<0||c.cloud_cover>100||Math.min(c.precipitation,c.rain,c.snowfall)<0)throw Error('Invalid current model weather');
 const known=labels.has(c.weather_code),rain=known&&rainCodes.has(c.weather_code)?clamp(Math.max(c.rain,c.precipitation)/2):0,snow=known&&snowCodes.has(c.weather_code)?clamp(c.snowfall/.6):0;
 return {timestamp,fetchedAt:now,temperature:c.temperature_2m,code:c.weather_code,label:labels.get(c.weather_code)||'Unknown weather code',known,cloud:known?c.cloud_cover/100:0,wet:rain,rain,snow,provider:'Open-Meteo current model estimate',coordinates:[43.589,-79.644]};
}
export function createWeatherFeed({fetcher=globalThis.fetch,now=Date.now}={}){
 let cached=null,inflight=null,lastAttempt=null,error=null;
 const getState=()=>({status:cached?(now()-cached.timestamp>WEATHER_STALE_MS||error?'stale':'current'):error?'unavailable':'not-loaded',current:cached,lastAttempt,error});
 return {getState,refresh({force=false}={}){
  if(inflight)return inflight;
  if(!force&&lastAttempt!==null&&now()-lastAttempt<WEATHER_REFRESH_MS)return Promise.resolve(getState());
  lastAttempt=now();
  inflight=(async()=>{try{const r=await fetcher(WEATHER_URL,{signal:AbortSignal.timeout(8000),credentials:'omit',referrerPolicy:'no-referrer',cache:'no-cache'});if(!r.ok)throw Error('Weather service HTTP '+r.status);cached=parseWeather(await r.json(),{now:now()});error=null;}catch(e){error=e.message||'Weather unavailable';}finally{inflight=null;}return getState();})();
  return inflight;
 }};
}
export function weatherEffects(state,enabled=true){
 // Stale/unknown estimates remain visible as evidence but do not assert current precipitation.
 const c=state?.status==='current'&&enabled?state.current:null;
 return {cloud:c?.cloud||0,wet:c?.wet||0,rain:c?.rain||0,snow:c?.snow||0};
}
