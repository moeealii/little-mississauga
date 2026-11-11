// Ridgeway Roulette inside the map's place drawer: a no-build port of the React app at
// ridgeway.thealifamily.ca. The pure logic below (filters, opening hours, spin maths, slang)
// follows that app's lib.ts line for line; only the rendering is rewritten for plain DOM.
// Restaurant data is a dated snapshot in data/ridgeway-restaurants.json. Filters and recent
// spins stay in this browser's localStorage; nothing is sent anywhere.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const href=v=>{try{const u=new URL(v);return u.protocol==='https:'||u.protocol==='http:'?u.href:null;}catch{return null;}};

// ---- data ---------------------------------------------------------------------------------
const str=v=>typeof v==='string'?v:undefined,num=v=>typeof v==='number'?v:undefined,bool=v=>typeof v==='boolean'?v:undefined;
const strArr=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):[];
export function mapRecords(data){
 const records=Array.isArray(data?.records)?data.records:[],seen=new Set();
 return records.map(r=>r?.fields&&typeof r.fields==='object'?r.fields:{}).filter(f=>{const name=(str(f['Restaurant Name'])??'').trim();if(!name||seen.has(name))return false;seen.add(name);return true;})
  .map((f,i)=>({id:i,name:str(f['Restaurant Name'])??'',address:str(f['Address']),googleRating:num(f['Google Rating']),myRating:num(f['My Rating']),
   gfRec1:str(f['Gluten-Free Recommendation 1']),gfRec2:str(f['Gluten-Free Recommendation 2']),regRec1:str(f['Regular Recommendation 1']),regRec2:str(f['Regular Recommendation 2']),
   vibe:strArr(f['Vibe / Occasion']),priceRange:str(f['Price Range']),tiktokLink:str(f['TikTok Video Link']),menuLink:str(f['Menu Link']),mapsLink:str(f['Google Maps Link']),
   notes:str(f['Notes']),brunch:bool(f['Brunch']),brunchHours:str(f['Brunch Hours']),lunchHours:str(f['Lunch Hours']),dinnerHours:str(f['Dinner Hours'])}));
}

// ---- logic (lib.ts) -----------------------------------------------------------------------
const LS_HISTORY_KEY='sauga_ridgeway_history_v1',LS_FILTERS_KEY='sauga_ridgeway_filters_v1';
const WHEEL_COLORS=['#c44d3e','#e0915e','#d4a04c','#8b9d5e','#6b8e9b','#a85a6e','#c4844f','#7a8b5e'];
const wheelColor=i=>WHEEL_COLORS[i%WHEEL_COLORS.length]??WHEEL_COLORS[0];
const DEFAULT_FILTERS=()=>({vibe:'All',minRating:null,ratingSource:'my',openOnly:false});
function load(key,fallback){try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):fallback();}catch{return fallback();}}
function save(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{/* storage unavailable */}}
export function applyVibeTap(vibe,excludedVibes,tap,isDouble){
 if(tap==='All')return {vibe:'All',excludedVibes:[]};
 if(isDouble)return {vibe:'All',excludedVibes:excludedVibes.includes(tap)?excludedVibes.filter(v=>v!==tap):[...excludedVibes,tap]};
 if(excludedVibes.includes(tap))return {vibe,excludedVibes:excludedVibes.filter(v=>v!==tap)};
 return {vibe:tap,excludedVibes:[...excludedVibes]};
}
const pushHistory=(history,winner)=>[winner,...history].slice(0,20);
const DAY_IDX={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6};
function toMinutes(h,m,ap){h=h%12;if(ap.toLowerCase()==='pm')h+=12;return h*60+m;}
const torontoNow=()=>new Date(new Date().toLocaleString('en-US',{timeZone:'America/Toronto'}));
// true / false, or null when there are no parseable hours. `at` overrides the time: {day, mins}.
export function isOpenNow(r,at,now=torontoNow()){
 const strs=[r.brunchHours,r.lunchHours,r.dinnerHours].filter(Boolean);if(!strs.length)return null;
 let foundRange=false;const day=at?at.day:now.getDay(),mins=at?at.mins:now.getHours()*60+now.getMinutes();
 for(const s of strs){
  let days=null;const range=/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s*(?:-|–|to)\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*/i.exec(s);
  if(range){const a=DAY_IDX[range[1].slice(0,3).toLowerCase()],b=DAY_IDX[range[2].slice(0,3).toLowerCase()];days=new Set();for(let d=a;;d=(d+1)%7){days.add(d);if(d===b)break;}}
  else if(!/daily|every/i.test(s)){const single=/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i.exec(s);if(single)days=new Set([DAY_IDX[single[1].slice(0,3).toLowerCase()]]);}
  const re=/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi;let m;
  while((m=re.exec(s))){
   const [,h1,min1,ap1,h2,min2,ap2]=m;foundRange=true;
   const start=toMinutes(+h1,+(min1??0),ap1),end=toMinutes(+h2,+(min2??0),ap2),wraps=end<=start,inRange=wraps?mins>=start||mins<end:mins>=start&&mins<end;
   if(days){if(days.has(day)&&inRange)return true;if(wraps&&days.has((day+6)%7)&&mins<end)return true;}else if(inRange)return true;
  }
 }
 return foundRange?false:null;
}
export function vibeOptions(restaurants,minCount=5){
 const counts=new Map();restaurants.forEach(r=>(r.vibe||[]).forEach(v=>counts.set(v,(counts.get(v)??0)+1)));
 return ['All',...[...counts.entries()].filter(([,n])=>n>=minCount).map(([v])=>v).sort()];
}
const ratedSourceCounts=pool=>({my:pool.filter(r=>(r.myRating??0)>0).length,google:pool.filter(r=>(r.googleRating??0)>0).length});
const ratingFilterAvailable=(pool,minRated=5)=>{const {my,google}=ratedSourceCounts(pool);return my>minRated||google>minRated;};
function fmtWhen(when,now=new Date()){
 const dt=new Date(when);let h=dt.getHours();const m=dt.getMinutes(),ap=h>=12?'PM':'AM';h=h%12||12;
 const time=`${h}${m?`:${String(m).padStart(2,'0')}`:''}${ap}`;
 return dt.toDateString()===now.toDateString()?time:`${dt.toLocaleDateString('en-US',{weekday:'short'}).toUpperCase()} ${time}`;
}
function defaultWhen(now=new Date()){const dt=new Date(now.getTime()+3600000),pad=n=>String(n).padStart(2,'0');return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:00`;}
export function filterRestaurants(located,filters,checkAt,now){
 const {vibe,minRating,ratingSource,openOnly}=filters,excluded=filters.excludedVibes??[];let list=located;
 if(vibe!=='All')list=list.filter(r=>(r.vibe||[]).includes(vibe));
 if(excluded.length>0)list=list.filter(r=>!(r.vibe||[]).some(v=>excluded.includes(v)));
 if(minRating!==null){if(ratingSource==='google')list=list.filter(r=>r.googleRating&&r.googleRating>=minRating);else list=list.filter(r=>r.myRating&&r.myRating>=minRating);}
 if(openOnly)list=list.filter(r=>isOpenNow(r,checkAt,now)===true);
 return list;
}
function searchRestaurants(located,searchQuery){
 if(!searchQuery.trim())return [];const q=searchQuery.toLowerCase().trim();
 return located.filter(r=>r.name.toLowerCase().includes(q)||(r.address??'').toLowerCase().includes(q)||(r.notes??'').toLowerCase().includes(q)).slice(0,8);
}
// The winner is drawn fairly from the whole filtered pool. The wheel shows 24 pockets, so a
// winner that is not on it is swapped into a random pocket before the spin.
export function computeSpin({pool,shown,rotation,rand}){
 const winner=pool[Math.floor(rand()*pool.length)];if(winner===undefined)throw new Error('computeSpin requires a nonempty pool');
 let shownArr=shown.slice(0,24),winnerIndex=shownArr.indexOf(winner),wheelSwap=null;
 if(winnerIndex===-1){winnerIndex=Math.floor(rand()*shownArr.length);shownArr=shownArr.slice();shownArr[winnerIndex]=winner;wheelSwap=shownArr;}
 const segAngle=360/shownArr.length,current=((rotation%360)+360)%360,target=(360-winnerIndex*segAngle-segAngle/2+360)%360,delta=(target-current+360)%360,wobble=(rand()-.5)*segAngle*.6;
 return {winner,newRotation:rotation+(5+Math.floor(rand()*3))*360+delta+wobble,wheelSwap};
}
const SLANG_TIERS={minSample:5,zHype:.75,zRisky:-.75,absHype:4.5,absRisky:3.8};
const SLANG_PACKS={hype:['wallahi a banger','certified plaza W','sheeeesh','elite pick no cap'],solid:['say less','good spin ahlie','solid ting','mans is eating tonight'],
 risky:['dicey one ahlie','spin again if you scared','brave pick wallahi','rolling the dice fam'],unrated:['mystery pick say less','uncharted ting','big plaza energy','you scout it first ahlie']};
export function ratingSentiment(rating,pool,tiers=SLANG_TIERS){
 if(!rating)return 'unrated';
 const rated=pool.map(r=>r.googleRating).filter(x=>typeof x==='number'&&x>0);
 if(rated.length>=tiers.minSample){const mean=rated.reduce((a,b)=>a+b,0)/rated.length,sd=Math.sqrt(rated.reduce((a,b)=>a+(b-mean)**2,0)/rated.length);if(sd>0){const z=(rating-mean)/sd;return z>=tiers.zHype?'hype':z<=tiers.zRisky?'risky':'solid';}}
 return rating>=tiers.absHype?'hype':rating>=tiers.absRisky?'solid':'risky';
}
const slangFor=(spinCount,sentiment='solid')=>{const pack=SLANG_PACKS[sentiment];return pack[((spinCount%pack.length)+pack.length)%pack.length]??'say less';};

// ---- view ---------------------------------------------------------------------------------
const PRICE_EMOJI={$:'💵','$$':'💵💵','$$$':'💵💵💵','$$$$':'💵💵💵💵'};
const VIBE_EMOJI={African:'🍲',American:'🍔',Cafe:'☕',Chinese:'🥡',Desi:'🍛',Desserts:'🍰',Italian:'🍝',Lounge:'🛋️',Mexican:'🌮','Middle Eastern':'🥙',Others:'✨',Persian:'🍢',Peruvian:'🍗',Turkish:'🌯'};
const SPIN_MS=3800;      // must equal --rr-dur-spin in ridgeway.css
function segment(name,i,count){
 const anglePer=360/count,R=180,C=200,a1=(i*anglePer-90)*Math.PI/180,a2=((i+1)*anglePer-90)*Math.PI/180,mid=(a1+a2)/2,tr=R*.62;
 return {path:`M ${C} ${C} L ${C+R*Math.cos(a1)} ${C+R*Math.sin(a1)} A ${R} ${R} 0 ${anglePer>180?1:0} 1 ${C+R*Math.cos(a2)} ${C+R*Math.sin(a2)} Z`,tx:C+tr*Math.cos(mid),ty:C+tr*Math.sin(mid),rot:mid*180/Math.PI+90,label:name.length>14?name.substring(0,12)+'…':name};
}
const pocketFill=i=>i%8===0?'var(--rr-olive)':i%2===1?'var(--rr-rust)':'var(--rr-ink)';
function wheelSVG(items){
 return `<svg viewBox="0 0 400 400" class="rr-roulette-svg" role="img" aria-label="Roulette wheel with ${items.length} restaurants"><defs>
 <radialGradient id="rr-dish" cx="50%" cy="50%" r="50%"><stop offset="58%" stop-color="rgba(28,24,20,0)"/><stop offset="88%" stop-color="rgba(28,24,20,0.10)"/><stop offset="100%" stop-color="rgba(28,24,20,0.24)"/></radialGradient>
 <radialGradient id="rr-dome" cx="38%" cy="30%" r="75%"><stop offset="0%" stop-color="#4a4138"/><stop offset="55%" stop-color="#2a2520"/><stop offset="100%" stop-color="#17130f"/></radialGradient></defs>
 ${items.map((r,i)=>{const s=segment(r.name,i,items.length);return `<g><path d="${s.path}" fill="${pocketFill(i)}" stroke="#f5f0e8" stroke-width="2"/><text x="${s.tx}" y="${s.ty}" fill="#f5f0e8" font-size="10" font-weight="500" text-anchor="middle" dominant-baseline="middle" transform="rotate(${s.rot} ${s.tx} ${s.ty})">${esc(s.label)}</text></g>`;}).join('')}
 <circle cx="200" cy="200" r="199" fill="url(#rr-dish)"/><circle cx="200" cy="200" r="35" fill="#17130f" opacity=".5" transform="translate(0 2)"/><circle cx="200" cy="200" r="34" fill="url(#rr-dome)"/>
 ${[0,45,90,135].map(d=>`<rect x="166" y="196" width="68" height="8" rx="4" fill="url(#rr-dome)" transform="rotate(${d} 200 200)"/>`).join('')}
 <circle cx="200" cy="200" r="11" fill="#17130f" opacity=".6" transform="translate(0 1)"/><circle cx="200" cy="200" r="10" fill="#f5f0e8"/><circle cx="197" cy="197" r="4" fill="#fff" opacity=".7"/></svg>`;
}

const S={loading:true,error:false,restaurants:[],snapshot:null,spinning:false,result:null,spinCount:0,rotation:0,modalOpen:false,searchQuery:'',searchOpen:false,filtersOpen:false,
 history:[],wheelItems:null,filterVibe:'All',excludedVibes:[],minRating:null,ratingSource:'my',openOnly:false,checkWhen:null};
let root=null,hooks={},lastVibeTap=null,filteredCache=[],started=false;
const $=sel=>root.querySelector(sel);
const checkAt=()=>{if(!S.checkWhen)return null;const dt=new Date(S.checkWhen);return Number.isNaN(dt.getTime())?null:{day:dt.getDay(),mins:dt.getHours()*60+dt.getMinutes()};};
const filtersNow=()=>({vibe:S.filterVibe,excludedVibes:S.excludedVibes,minRating:S.minRating,ratingSource:S.ratingSource,openOnly:S.openOnly});

function build(){
 root=document.createElement('div');root.className='rr';
 root.innerHTML=`<header class="rr-header"><p class="rr-eyebrow" data-rr="eyebrow"></p><h2 class="rr-title">what should we eat<span>.</span></h2></header>
 <div class="rr-toggles"><button type="button" class="rr-pill" data-act="filters" aria-expanded="false"></button><button type="button" class="rr-pill" data-act="search" aria-expanded="false">search</button></div>
 <div class="rr-search" data-rr="search" hidden><input class="rr-search-input" type="search" placeholder="find a restaurant..." aria-label="Find a restaurant" autocomplete="off"><div data-rr="search-results"></div></div>
 <div class="rr-filters" data-rr="filters" hidden></div>
 <div class="rr-wheel"><div class="rr-stage"><div class="rr-rim" aria-hidden="true">${Array.from({length:8},(_,i)=>`<span class="rr-stud" style="transform:rotate(${i*45}deg)"></span>`).join('')}</div>
  <div class="rr-roulette" data-rr="wheel" data-spinning="false"></div><div class="rr-sheen" aria-hidden="true"></div><div class="rr-lip" aria-hidden="true"></div>
  <div class="rr-ball-track" data-rr="ball" data-spinning="false" aria-hidden="true"><span class="rr-ball"></span></div></div>
  <button type="button" class="rr-spin" data-act="spin">spin</button><p class="rr-none" data-rr="none" hidden>no restaurants match your filters</p></div>
 <section class="rr-history" data-rr="history" hidden></section>
 <p class="rr-foot" data-rr="foot"></p><div class="rr-live" role="status" aria-live="polite" data-rr="live"></div>`;
 root.addEventListener('click',onClick);
 root.querySelector('.rr-search-input').addEventListener('input',e=>{S.searchQuery=e.target.value;renderSearch();});
 root.addEventListener('change',e=>{if(e.target.matches('.rr-time')){S.checkWhen=e.target.value||null;changed();}});
}
function onClick(e){
 const b=e.target.closest('[data-act]');if(!b||b.disabled)return;const act=b.dataset.act,v=b.dataset.v;
 if(act==='spin')return spin();
 if(act==='filters'){S.filtersOpen=!S.filtersOpen;return renderChrome();}
 if(act==='search'){S.searchOpen=!S.searchOpen;renderChrome();if(S.searchOpen)$('.rr-search-input').focus();return;}
 if(act==='open-result'){S.result=(b.dataset.from==='history'?S.history:searchRestaurants(S.restaurants,S.searchQuery))[Number(v)]||null;if(!S.result)return;if(b.dataset.from==='search'){S.searchOpen=false;S.searchQuery='';$('.rr-search-input').value='';renderSearch();renderChrome();}return openModal();}
 if(act==='history-toggle'){S.historyOpen=!S.historyOpen;return renderHistory();}
 if(act==='clear-history'){S.history=[];save(LS_HISTORY_KEY,[]);return renderHistory();}
 if(S.spinning)return;
 if(act==='vibe'){
  // Two taps on one chip within 350 ms toggle exclusion, resolved against the state before tap one.
  const now=Date.now(),prev=lastVibeTap;let next;
  if(prev&&prev.vibe===v&&now-prev.at<350){lastVibeTap=null;next=applyVibeTap(prev.before.vibe,prev.before.excludedVibes,v,true);}
  else{lastVibeTap={vibe:v,at:now,before:{vibe:S.filterVibe,excludedVibes:S.excludedVibes}};next=applyVibeTap(S.filterVibe,S.excludedVibes,v,false);}
  S.filterVibe=next.vibe;S.excludedVibes=next.excludedVibes;return changed();
 }
 if(act==='open'){if(v==='any'){S.openOnly=false;S.checkWhen=null;}else if(v==='now'){S.openOnly=true;S.checkWhen=null;}else{S.openOnly=true;S.checkWhen=S.checkWhen??defaultWhen();}return changed();}
 if(act==='source'){S.ratingSource=v;S.minRating=null;return changed();}
 if(act==='rating'){S.minRating=v==='any'?null:Number(v);return changed();}
}
// Persisted picks must not keep filtering after their control disappears.
function reconcile(){
 const R=S.restaurants;if(!R.length)return;const vibes=vibeOptions(R),show=ratingFilterAvailable(R),src=ratedSourceCounts(R);
 if(S.filterVibe!=='All'&&!vibes.includes(S.filterVibe))S.filterVibe='All';
 if(!show&&S.minRating!==null)S.minRating=null;
 if(show&&S.ratingSource==='my'&&src.my<=5&&src.google>5){S.ratingSource='google';S.minRating=null;}
 if(S.excludedVibes.some(v=>!vibes.includes(v)))S.excludedVibes=S.excludedVibes.filter(v=>vibes.includes(v));
}
function changed(){reconcile();save(LS_FILTERS_KEY,filtersNow());S.wheelItems=null;filteredCache=filterRestaurants(S.restaurants,filtersNow(),checkAt());renderChrome();renderFilters();renderWheel();}
function renderChrome(){
 const n=(S.filterVibe!=='All'?1:0)+(S.excludedVibes.length>0?1:0)+(S.minRating!==null?1:0)+(S.openOnly?1:0),f=root.querySelector('[data-act=filters]'),s=root.querySelector('[data-act=search]');
 $('[data-rr=eyebrow]').textContent=S.loading?'hold tight fam...':S.error?'ridgeway roulette · list unavailable':`ridgeway roulette · ${filteredCache.length} of ${S.restaurants.length}`;
 f.textContent=n===0?'all restaurants':`${n} filter${n>1?'s':''}`;f.disabled=s.disabled=S.loading;f.setAttribute('aria-expanded',S.filtersOpen);s.setAttribute('aria-expanded',S.searchOpen);
 $('[data-rr=filters]').hidden=!S.filtersOpen||S.loading;$('[data-rr=search]').hidden=!S.searchOpen||S.loading;
 const spinBtn=root.querySelector('[data-act=spin]');spinBtn.disabled=S.spinning||S.loading||filteredCache.length===0;spinBtn.dataset.spinning=S.spinning;spinBtn.textContent=S.loading||S.spinning?'...':'spin';spinBtn.style.setProperty('--rr-spin-accent',wheelColor(S.spinCount));
 $('[data-rr=none]').hidden=S.loading||filteredCache.length>0;
 $('[data-rr=foot]').innerHTML=S.snapshot?`List saved ${esc(S.snapshot.saved_at)} · hours and ratings can change · <a href="${esc(href(S.snapshot.source)||'#')}" target="_blank" rel="noopener noreferrer">full Ridgeway Roulette ↗</a>`:'';
}
function renderSearch(){
 const hits=searchRestaurants(S.restaurants,S.searchQuery);
 $('[data-rr=search-results]').innerHTML=S.searchQuery.trim()&&!hits.length?'<p class="rr-search-empty">no matches found, wallahi</p>':hits.map((r,i)=>`<button type="button" class="rr-row" data-act="open-result" data-from="search" data-v="${i}"><span class="rr-row-1">${esc(r.name)}</span><span class="rr-row-2">${r.priceRange?(PRICE_EMOJI[r.priceRange]??'')+' ':''}${r.myRating?'★'.repeat(r.myRating):''}</span></button>`).join('');
}
function renderFilters(){
 const R=S.restaurants,dis=S.spinning?' disabled':'',chip=(act,v,label,on,ex=false)=>`<button type="button" class="rr-chip" data-act="${act}" data-v="${esc(v)}" aria-pressed="${on}"${ex?' data-excluded="true"':''}${dis}>${label}</button>`;
 const src=ratedSourceCounts(R),stars=S.ratingSource==='my'?[null,1,2,3,4,5]:[null,3.5,4,4.3,4.5];
 $('[data-rr=filters]').innerHTML=`<div class="rr-fsec"><p class="rr-flabel">vibe <small>· double-tap to exclude</small></p><div class="rr-chips">${vibeOptions(R).map(v=>chip('vibe',v,`${VIBE_EMOJI[v]??''} ${esc(v)}`,S.filterVibe===v,S.excludedVibes.includes(v))).join('')}</div></div>
 <div class="rr-fsec"><p class="rr-flabel">open</p><div class="rr-chips">${chip('open','any','anytime',!S.openOnly)}${chip('open','now','now',S.openOnly&&!S.checkWhen)}${chip('open','later','later…',S.openOnly&&S.checkWhen!==null)}${S.openOnly&&S.checkWhen?`<input type="datetime-local" class="rr-time" aria-label="Check opening hours at" value="${esc(S.checkWhen)}"${dis}>`:''}</div></div>
 ${ratingFilterAvailable(R)?`<div class="rr-fsec"><div class="rr-flabel-row"><p class="rr-flabel">minimum rating</p>${src.my>5&&src.google>5?`<span class="rr-seg">${['my','google'].map(s=>`<button type="button" class="rr-seg-btn" data-act="source" data-v="${s}" aria-pressed="${S.ratingSource===s}"${dis}>${s==='my'?'mine':'google'}</button>`).join('')}</span>`:`<span class="rr-seg-single">${S.ratingSource==='my'?'mine':'google'}</span>`}</div>
 <div class="rr-chips">${stars.map(n=>`<button type="button" class="rr-star" data-act="rating" data-v="${n??'any'}" aria-pressed="${S.minRating===n}"${dis}>${n===null?'any':S.ratingSource==='my'?'★'.repeat(n):`★ ${n.toFixed(1)}+`}</button>`).join('')}</div></div>`:''}`;
}
function renderWheel(){
 const el=$('[data-rr=wheel]'),items=(S.wheelItems??filteredCache).slice(0,24);
 el.innerHTML=S.loading?'<div class="rr-wheel-msg"><span class="rr-pulse"></span></div>':S.error?'<div class="rr-wheel-msg"><p>the list would not load</p><p class="rr-sub">try again in a bit</p></div>':items.length===0?'<div class="rr-wheel-msg"><p>nothing matches, ahlie</p><p class="rr-sub">try fewer filters</p></div>':wheelSVG(items);
}
function renderHistory(){
 const el=$('[data-rr=history]');el.hidden=!S.history.length;if(!S.history.length)return;
 el.innerHTML=`<button type="button" class="rr-hhead" data-act="history-toggle" aria-expanded="${Boolean(S.historyOpen)}"><span class="rr-htitle">recent spins</span><span class="rr-count">${S.history.length}</span><span class="rr-chev" data-open="${Boolean(S.historyOpen)}">▾</span></button>
 ${S.historyOpen?`<div class="rr-hbody">${S.history.map((r,i)=>`<button type="button" class="rr-row" data-act="open-result" data-from="history" data-v="${i}"><span class="rr-row-1">${esc(r.name)}</span>${r.priceRange?`<span class="rr-row-2">${PRICE_EMOJI[r.priceRange]??''}</span>`:''}</button>`).join('')}<button type="button" class="rr-text" data-act="clear-history">clear history</button></div>`:''}`;
}
function spin(){
 if(S.spinning||filteredCache.length===0)return;
 S.spinning=true;closeModal();
 const {winner,newRotation,wheelSwap}=computeSpin({pool:filteredCache,shown:S.wheelItems??filteredCache,rotation:S.rotation,rand:Math.random});
 if(wheelSwap){S.wheelItems=wheelSwap;renderWheel();}
 S.rotation=newRotation;renderChrome();renderFilters();
 const wheel=$('[data-rr=wheel]'),ball=$('[data-rr=ball]');wheel.dataset.spinning=ball.dataset.spinning='true';void wheel.offsetWidth;wheel.style.transform=`rotate(${newRotation}deg)`;
 $('[data-rr=live]').textContent='Spinning…';hooks.onSpin?.();
 setTimeout(()=>{
  S.spinning=false;S.result=winner;S.spinCount++;S.history=pushHistory(S.history,winner);save(LS_HISTORY_KEY,S.history);
  wheel.dataset.spinning=ball.dataset.spinning='false';renderChrome();renderFilters();renderHistory();
  $('[data-rr=live]').textContent=`The wheel picked ${winner.name}.`;openModal();confetti();hooks.onWinner?.(winner);
 },SPIN_MS);
}

// ---- result sheet + confetti (attached to <body>, above the map) --------------------------
let overlay=null,lastFocus=null;
function closeModal(){if(!overlay)return;overlay.remove();overlay=null;S.modalOpen=false;document.removeEventListener('keydown',onKey,true);lastFocus?.focus?.({preventScroll:true});}
function onKey(e){if(e.key==='Escape'){e.stopPropagation();e.preventDefault();closeModal();}}
function openModal(){
 closeModal();const r=S.result;if(!r)return;lastFocus=document.activeElement;
 const at=checkAt(),label=at&&S.checkWhen?fmtWhen(S.checkWhen):null,open=isOpenNow(r,at),slang=slangFor(S.spinCount,ratingSentiment(r.googleRating,S.restaurants));
 const dishes=[r.regRec1&&{name:r.regRec1,gf:false},r.regRec2&&{name:r.regRec2,gf:false},r.gfRec1&&{name:r.gfRec1,gf:true},r.gfRec2&&{name:r.gfRec2,gf:true}].filter(Boolean);
 const hours=[...(r.brunch?[]:[r.brunchHours]),r.lunchHours,r.dinnerHours].filter(Boolean),link=(u,text,primary)=>{const h=href(u);return h?`<a class="rr-btn"${primary?' data-primary':''} href="${esc(h)}" target="_blank" rel="noopener noreferrer">${text}</a>`:'';};
 overlay=document.createElement('div');overlay.className='rr-overlay';
 overlay.innerHTML=`<div class="rr-modal" role="dialog" aria-modal="true" aria-label="${esc(r.name)}" tabindex="-1"><div class="rr-modal-handle"></div><button type="button" class="rr-modal-close" aria-label="close">×</button>
 ${open!==null?`<p class="rr-open${open?'':' closed'}"><span class="rr-open-dot"></span>${open?(label?'OPEN AT '+esc(label):'OPEN NOW'):(label?'CLOSED AT '+esc(label):'CLOSED')}</p>`:''}
 <div class="rr-emoji-row">${(r.vibe||[]).map(v=>VIBE_EMOJI[v]).filter(Boolean).map(e=>`<span>${e}</span>`).join('')}<span class="rr-slang">${esc(slang)}</span></div>
 <h2 class="rr-name">${esc(r.name)}</h2>
 <div class="rr-badges">${r.priceRange?`<span class="rr-price">${esc(r.priceRange)}</span>`:''}${r.googleRating?`<span class="rr-google">★ ${Number(r.googleRating).toFixed(1)} on Google</span>`:''}${r.myRating?`<span class="rr-stars">${'★'.repeat(r.myRating)}<span>${'☆'.repeat(Math.max(0,5-r.myRating))}</span></span>`:''}</div>
 ${r.address?`<p class="rr-address">${esc(r.address)}</p>`:''}${r.notes?`<p class="rr-notes">${esc(r.notes)}</p>`:''}
 ${(r.vibe||[]).length?`<div class="rr-tags">${r.vibe.map(v=>`<span class="rr-tag">${esc(v)}</span>`).join('')}</div>`:''}
 ${dishes.length?`<div class="rr-section"><p class="rr-section-title">what to order</p><ul class="rr-dishes">${dishes.map(d=>`<li class="${d.gf?'gf':''}"><span class="rr-dish-dot"></span><span>${esc(d.name)}</span>${d.gf?'<span class="rr-gf">GF</span>':''}</li>`).join('')}</ul></div>`:''}
 ${r.brunchHours||r.lunchHours||r.dinnerHours?`<div class="rr-section"><p class="rr-section-title">hours</p>${r.brunch&&r.brunchHours?`<p class="rr-hours"><span class="rr-hours-label">Brunch</span><span>${esc(r.brunchHours)}</span></p>`:''}${hours.map(h=>`<p class="rr-hours"><span>${esc(h)}</span></p>`).join('')}</div>`:''}
 <div class="rr-links">${link(r.menuLink,'Menu',true)}${link(r.mapsLink,'Directions')}${link(r.tiktokLink,'TikTok')}</div></div>`;
 overlay.addEventListener('click',e=>{if(e.target===overlay||e.target.closest('.rr-modal-close'))closeModal();});
 document.body.append(overlay);S.modalOpen=true;document.addEventListener('keydown',onKey,true);overlay.querySelector('.rr-modal').focus({preventScroll:true});
}
function confetti(){
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 const el=document.createElement('div');el.className='rr-confetti';
 el.innerHTML=Array.from({length:30},()=>{const size=5+Math.random()*5;return `<i${Math.random()>.5?' data-round':''} style="left:${Math.random()*100}%;background:${WHEEL_COLORS[Math.floor(Math.random()*WHEEL_COLORS.length)]};width:${size}px;height:${size}px;animation-delay:${Math.random()*.2}s;animation-duration:${1+Math.random()}s"></i>`;}).join('');
 document.body.append(el);setTimeout(()=>el.remove(),2400);
}

/** Put the roulette into `container`. State survives the drawer being closed and reopened. */
export function mountRidgewayRoulette(container,options={}){
 hooks=options;
 if(!root){
  build();const saved=load(LS_FILTERS_KEY,DEFAULT_FILTERS);
  Object.assign(S,{history:load(LS_HISTORY_KEY,()=>[]),filterVibe:saved.vibe||'All',excludedVibes:saved.excludedVibes??[],minRating:saved.minRating||null,ratingSource:saved.ratingSource||'my',openOnly:saved.openOnly||false});
  if(!Array.isArray(S.history))S.history=[];
 }
 container.append(root);renderChrome();renderFilters();renderWheel();renderHistory();
 if(!started){started=true;fetch(options.url||'data/ridgeway-restaurants.json').then(r=>{if(!r.ok)throw Error('unavailable');return r.json();}).then(d=>{S.snapshot={saved_at:d.saved_at,source:d.source};S.restaurants=mapRecords(d);}).catch(()=>{S.error=true;}).finally(()=>{S.loading=false;changed();renderSearch();renderHistory();});}
}
