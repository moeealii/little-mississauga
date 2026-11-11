import {LEGACY_PROJECTION_ID,ONTARIO_PROJECTION_ID,supportedProjection,validateOntarioFrame} from './projection.mjs';
export const PROJECTION_ID=LEGACY_PROJECTION_ID;
export {ONTARIO_PROJECTION_ID};
export const MASK_ENCODING='R-window_G-threshold-times-R_B-streetpool';
export const colors=Object.freeze({activity:'#2a78d6',hotspot:'#eb6834',context:'#1baf7a'});
export const kindNames=Object.freeze({activity:'Programme venue',hotspot:'City hotspot',context:'Landscape / city context'});
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Retained from local-atlas: detail-only official handoff, never enrollment actions.
export function officialDetailUrl(value){try{const u=new URL(value),hosts=new Set(['ca.apm.activecommunities.com','anc.ca.apm.activecommunities.com']),p=decodeURIComponent(u.pathname),params=new Set(['activity_id','locale','onlineSiteId','from_original_cui']);const legacy=/^\/activemississauga\/Activity_Search\/?$/i.test(p)&&/^\d+$/.test(u.searchParams.get('activity_id')||''),detail=/^\/activemississauga\/(?:Activity_Search\/[^/]+\/\d+|activity\/search\/detail\/\d+)\/?$/i.test(p);if(u.protocol!=='https:'||!hosts.has(u.hostname)||(u.port&&u.port!=='443')||u.username||u.password||!(legacy||detail)||[...u.searchParams.keys()].some(k=>!params.has(k)))return null;u.hash='';return u.href;}catch{return null;}}
export function screenPoint(p,c,w,h){return [(p[0]-c.x)*c.scale+w/2,h/2-(p[1]-c.y)*c.scale];}
export function worldPoint(p,c,w,h){return [(p[0]-w/2)/c.scale+c.x,(h/2-p[1])/c.scale+c.y];}
export function zoomCamera(c,factor,anchor,w,h,min,max){const p=worldPoint(anchor,c,w,h);c.scale=Math.max(min,Math.min(max,c.scale*factor));c.x=p[0]-(anchor[0]-w/2)/c.scale;c.y=p[1]+(anchor[1]-h/2)/c.scale;}
export function intersects(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];}
function rect(v){return Array.isArray(v)&&v.length===4&&v.every(Number.isFinite)&&v[2]>v[0]&&v[3]>v[1];}
function pixels(v){return Array.isArray(v)&&v.length===2&&v.every(n=>Number.isInteger(n)&&n>0);}
function asset(v){return v&&/^art\/[a-zA-Z0-9_./-]+\.(png|webp)$/i.test(v.url)&&!v.url.split('/').includes('..')&&/^[a-f0-9]{64}$/.test(v.sha256);}
export function validateMaskBinding(mask,canvas,{isAsset=asset,baseSha256=null}={}){
 if(!isAsset(mask)||mask.frame_id!==canvas.frame_id||mask.encoding!==MASK_ENCODING||(baseSha256&&mask.base_sha256!==baseSha256))throw Error('Mask is not bound to the artwork frame/base');
 return mask;
}
export function validateManifest(m){
 if(m.schema_version!==1||!supportedProjection(m.projection_id)||!Array.isArray(m.canvases))throw Error('Unrecognized geographic canvas manifest');
 if(m.projection_id===ONTARIO_PROJECTION_ID)validateOntarioFrame(m.projection);
 const ids=new Set();
 for(const c of m.canvases){
  if(ids.has(c.id)||!c.id||!c.frame_id||!['genuine-joint-canvas','genuine-model-tile','genuine-citywide-mosaic'].includes(c.kind)||!pixels(c.pixels)||!rect(c.projected_rect_m)||!Array.isArray(c.levels)||!c.levels.length)throw Error('Invalid registered canvas');ids.add(c.id);
  if(m.projection_id===ONTARIO_PROJECTION_ID&&!['genuine-model-tile','genuine-citywide-mosaic'].includes(c.kind))throw Error('Ontario artwork requires explicit fresh-model provenance');
  if(c.kind==='genuine-citywide-mosaic'&&(c.provenance?.kind!=='genuine-fresh-model-citywide'||!/^[a-f0-9]{64}$/.test(c.provenance.adapter_sha256||'')))throw Error('Citywide mosaic lacks fresh-model provenance');
  if(c.kind==='genuine-model-tile'){
   const p=c.provenance,s=c.source_binding;
   if(m.projection_id!==ONTARIO_PROJECTION_ID||p?.kind!=='genuine-fresh-model-render'||p.native_pixels?.[0]!==896||p.native_pixels?.[1]!==896||c.pixels[0]!==896||c.pixels[1]!==896||![p.adapter_sha256,p.render_sha256,p.generation_sha256,p.decode_sha256,s?.geometry_sha256,s?.terrain_sha256,s?.terrain_contract_sha256,s?.source_sha256].every(h=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h))||s.terrain_contract_sha256!==m.projection.terrain_contract_sha256||!Number.isFinite(p.strength)||p.strength<.5||p.strength>1.5||p.fixture_only===true)throw Error('Fresh model tile lacks native model/source/datum provenance');
  }
  if(Math.abs((c.projected_rect_m[2]-c.projected_rect_m[0])/(c.projected_rect_m[3]-c.projected_rect_m[1])-c.pixels[0]/c.pixels[1])>1e-6)throw Error('Canvas aspect does not match the canonical image-plane placement');
  const levelIds=new Set();
  for(const l of c.levels){
   if(!l.id||levelIds.has(l.id)||!pixels(l.pixels)||!Array.isArray(l.tiles)||!l.tiles.length||l.pixels[0]>c.pixels[0]||l.pixels[1]>c.pixels[1]||Math.abs(l.pixels[0]/l.pixels[1]-c.pixels[0]/c.pixels[1])>2/l.pixels[1])throw Error('Invalid registered level');levelIds.add(l.id);
   const tileIds=new Set();
   for(const t of l.tiles){
    if(!t.id||tileIds.has(t.id)||!rect(t.rect_px)||!t.rect_px.every(Number.isInteger)||t.rect_px[0]<0||t.rect_px[1]<0||t.rect_px[2]>l.pixels[0]||t.rect_px[3]>l.pixels[1]||!asset(t.base))throw Error('Invalid registered tile');tileIds.add(t.id);
    if(c.kind==='genuine-model-tile'&&l.pixels[0]===896&&l.pixels[1]===896&&t.base.sha256!==c.provenance.render_sha256)throw Error('Native model tile hash differs from reviewed render');
    if(t.mask)validateMaskBinding(t.mask,c);
   }
  }
 }
 return m;
}
// Fail closed: diagnostic delivery is not visual acceptance. Landmark holds also
// apply spatially, so omitting a known landmark from a canvas cannot clear it.
export function acceptanceFor(c,m,places=[]){
 const a=c.acceptance;
 if(a?.status!=='accepted'||a.coverage_status!=='accepted'||typeof a.reviewed_at!=='string'||!Number.isFinite(Date.parse(a.reviewed_at))||!Array.isArray(a.landmarks))return {allowed:false,reason:a?.reason||'Artwork awaiting explicit architectural/coverage acceptance'};
 for(const gate of m.landmark_gates||[]){
  const p=places.find(p=>p.id===gate.place_id)?.point;
  const b=c.projected_rect_m;
  const spatial=p&&p[0]>=b[0]-200&&p[0]<=b[2]+200&&p[1]>=b[1]-200&&p[1]<=b[3]+200;
  const named=a.landmarks.some(l=>l.id===gate.id);
  if((spatial||named)&&(gate.status!=='accepted'||!a.landmarks.some(l=>l.id===gate.id&&l.status==='accepted')))return {allowed:false,reason:gate.reason||'Landmark acceptance withheld'};
 }
 if(a.landmarks.some(l=>l.status!=='accepted'))return {allowed:false,reason:'One or more depicted landmarks remain withheld'};
 return {allowed:true,reason:'Accepted visual checkpoint, not full-city geographic certification'};
}
export function tileWorldRect(c,l,t){const b=c.projected_rect_m,r=t.rect_px,w=b[2]-b[0],h=b[3]-b[1];return [b[0]+r[0]/l.pixels[0]*w,b[3]-r[3]/l.pixels[1]*h,b[0]+r[2]/l.pixels[0]*w,b[3]-r[1]/l.pixels[1]*h];}
export function chooseLevel(c,scale){const sorted=[...c.levels].sort((a,b)=>a.pixels[0]-b.pixels[0]);return sorted.find(l=>l.pixels[0]/(c.projected_rect_m[2]-c.projected_rect_m[0])>=scale)||sorted.at(-1);}
export function programmeCard(a,venueById,{showVenue=true}={}){const s=a.schedule,p=a.price,amount=p?.from_amount,fee=amount===null||amount===undefined?'Fee shown on the City page':`From ${p.currency||''} ${amount}`.replace('  ',' '),detail=officialDetailUrl(a.detail_url),status=a.availability?.source_status_text;return `<article class="programme-card"><h3>${esc(a.name)}</h3>${showVenue?`<p>${a.venue_ids.map(id=>esc(venueById.get(id)?.name||id)).join(' · ')}</p>`:''}<p>${s?esc([s.date_text,s.days_text,s.time_text].filter(Boolean).join(' · ')):'Schedule on the City page'}</p><p>${esc(a.age_text||'Ages on the City page')}</p><p>${esc(fee)}</p><p>${status?esc(status):({enrollment_link_shown:'Open for registration when saved',registration_info_only:'Registration details on the City page',waitlist:'Waitlist',full:'Full'})[a.availability?.status]||'Availability on the City page'}</p>${detail?`<a class="official-link" href="${esc(detail)}" target="_blank" rel="noopener noreferrer">Details / register on Active Mississauga ↗</a>`:'<span class="source-stamp">Official detail link unavailable in this snapshot</span>'}<span class="source-stamp">Checked ${esc(dateText(a.fetched_at))} · ${a.record_completeness==='map_teaser'?'Partial listing':'City listing'}${a.course_number?` · Course ${esc(a.course_number)}`:''}</span></article>`;}
export const dateText=v=>v?new Date(v).toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric',timeZone:'America/Toronto'}):'Unknown';
