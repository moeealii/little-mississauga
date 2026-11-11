// Citywide simulated road actors (NOT live traffic). Official City centreline lanes with
// Ontario-DTM heights, streamed in 1 km tiles and joined into a lane graph at run time, so
// cars cross intersections, turn, queue and take turns at busy junctions. Lane counts and
// speeds come from the painted pavement width in the semantic mask. Cars are drawn as small
// projected sprites; building pixels in the mask cut them per pixel, so buildings occlude them.
// Car following uses the Intelligent Driver Model with the driver constants of Slop Toronto's
// js/traffic.js (MIT, (c) 2026 Mr.doob, John Fewell); the code here is our own.
import {pointAt} from './motion-source.mjs';
import {projectActor} from './runtime-motion.mjs';

const MIN_SCALE=1.2;            // screen px per metre before cars appear
const MAX_TILES=16, MASK_TILE=512, MARGIN_M=160;
const SIZE=1.3;                 // the painted miniature draws vehicles about this much over life size
const TRIM=5.5;                 // metres a lane stops short of the junction node
const LANE_W=3.3, YAW_STEPS=48;
const DRIVER={a:1.6,b:2.6,T:1.2,s0:2.0,aLat:3.0};   // Slop Toronto CAR_DRIVER, a little gentler
const BODIES=[
 {len:4.6,parts:[[-2.3,2.3,-2.25,2.2,.9,.86,.3,.82,0],[-1.35,1.0,-1.0,.45,.84,.7,.82,1.38,1]]},       // sedan
 {len:4.8,parts:[[-2.4,2.4,-2.35,2.3,.95,.92,.32,1.0,0],[-2.15,1.05,-2.1,.7,.9,.8,1.0,1.72,1]]},       // SUV / hatch
 {len:5.4,parts:[[-2.7,2.7,-2.7,2.4,1.0,.98,.3,1.15,0],[-2.6,1.6,-2.6,1.0,.98,.95,1.15,2.25,2]]}];     // van
const PAINTS=['#f1f2f0','#f1f2f0','#1f2328','#1f2328','#9aa1a8','#9aa1a8','#5d646c','#24406e','#8e2328','#e9e4d6','#2f4f3d','#c25a1c'];
const GLASS='#26313d';
const NIGHT_TINT=[20,28,52];

const overlaps=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const hex=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
const rgb=(c,k,night)=>`rgb(${c.map((v,i)=>Math.round(Math.min(255,v*k)*(1-night*.72)+NIGHT_TINT[i]*night*.72)).join(',')})`;
let seed=7;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647;

export function createCityTraffic({index,canvas,projection,loadJSON,loadBitmap}){
 const roads=new Map(),masks=new Map(),starts=new Map(),ends=new Map(),nodes=new Set();
 const l0=[...canvas.levels].sort((a,b)=>b.pixels[0]-a.pixels[0])[0];
 const maskByCell=new Map(l0.tiles.filter(t=>t.motion_mask).map(t=>[`${t.rect_px[0]/MASK_TILE}_${t.rect_px[1]/MASK_TILE}`,t]));
 const R=canvas.projected_rect_m,W=l0.pixels[0],H=l0.pixels[1];
 const toPx=([x,y])=>[(x-R[0])/(R[2]-R[0])*W,(R[3]-y)/(R[3]-R[1])*H];
 const state={active:false,visibleCars:0,loadedTiles:0,cones:0,simulatedCars:0,routes:0,signals:0,stopped:0,meanSpeed:0};
 const cam=(()=>{const [r,u]=[projection.right,projection.up],n=[r[1]*u[2]-r[2]*u[1],r[2]*u[0]-r[0]*u[2],r[0]*u[1]-r[1]*u[0]],s=n[1]<0?-1:1;return n.map(v=>v*s);})();
 const light=(()=>{const l=[cam[0]-.35,cam[1]+1.2,cam[2]+.25],m=Math.hypot(...l);return l.map(v=>v/m);})();
 const plane=(x,y,z)=>[x*projection.right[0]+y*projection.right[1]+z*projection.right[2],x*projection.up[0]+y*projection.up[1]+z*projection.up[2]];

 // ---- mask lookups -------------------------------------------------------------------------
 function ensureMask(key){
  if(masks.has(key))return masks.get(key);
  const tile=maskByCell.get(key),row={status:tile?'loading':'none',tile};masks.set(key,row);
  if(tile)loadBitmap(tile.motion_mask).then(bmp=>{
   const c=new OffscreenCanvas(bmp.width,bmp.height),g=c.getContext('2d');g.drawImage(bmp,0,0);
   const img=g.getImageData(0,0,bmp.width,bmp.height),d=img.data,a=new Uint8Array(bmp.width*bmp.height);
   for(let i=0;i<a.length;i++){a[i]=d[i*4+3];d[i*4+3]=a[i]?255:0;}
   g.putImageData(img,0,0);   // keep-matte: everything that is not a building
   Object.assign(row,{bitmap:bmp,keep:c,alpha:a,w:bmp.width,status:'ready'});
  }).catch(()=>{row.status='error';});
  return row;
 }
 // 255 road/parking, 128 ground, 0 building, -1 not loaded / outside the art.
 function maskAt(x,y){
  x=Math.floor(x);y=Math.floor(y);if(x<0||y<0||x>=W||y>=H)return 0;
  const m=ensureMask(`${Math.floor(x/MASK_TILE)}_${Math.floor(y/MASK_TILE)}`);
  return m.status==='ready'?m.alpha[(y%MASK_TILE)*m.w+(x%MASK_TILE)]:m.status==='loading'?-1:0;
 }
 const maskAtWorld=(x,y,z)=>maskAt(...toPx(projectActor({x,y,z},projection)));

 // ---- lane graph ---------------------------------------------------------------------------
 const cell=(x,z)=>`${Math.floor(x/10)},${Math.floor(z/10)}`;
 const put=(m,x,z,r)=>{const k=cell(x,z);if(!m.has(k))m.set(k,[]);m.get(k).push(r);};
 function near(m,x,z,rad){const out=[],cx=Math.floor(x/10),cz=Math.floor(z/10);for(let i=-1;i<=1;i++)for(let j=-1;j<=1;j++)for(const r of m.get(`${cx+i},${cz+j}`)||[])if(Math.hypot(r[m===starts?'sx':'ex']-x,r[m===starts?'sz':'ez']-z)<rad)out.push(r);return out;}
 const dir=(a,b)=>{const l=Math.hypot(b.x-a.x,b.z-a.z)||1;return [(b.x-a.x)/l,(b.z-a.z)/l];};
 function makeRoute(raw,tile){
  const s=raw.samples,n=s.length,d0=dir(s[0],s[1]),d1=dir(s[n-2],s[n-1]);
  return {samples:s,length:raw.length,tile,sx:s[0].x,sz:s[0].z,ex:s[n-1].x,ez:s[n-1].z,d0,d1,next:[],twin:null,endNode:null,cars:[],lanes:0,v0:9};
 }
 function link(r){
  r.next=[];r.twin=null;
  for(const q of near(starts,r.ex,r.ez,9)){
   if(q===r)continue;const dot=q.d0[0]*r.d1[0]+q.d0[1]*r.d1[1],ahead=(q.sx-r.ex)*r.d1[0]+(q.sz-r.ez)*r.d1[1];
   if(dot<-.85){if(Math.hypot(q.sx-r.ex,q.sz-r.ez)<6)r.twin=q;continue;}
   if(ahead>-4)r.next.push(q);
  }
  if(!r.next.length){r.endNode=null;return;}
  let node=r.endNode||r.next.find(q=>q.startNode)?.startNode;
  if(!node){node={ins:new Set(),axis:Math.atan2(r.d1[0],r.d1[1]),green:0,t:rand()*8,req:[0,0],nextGreen:1};nodes.add(node);}
  node.ins.add(r);r.endNode=node;for(const q of r.next)q.startNode=node;
 }
 function ensureRoad(t){
  if(roads.has(t.id))return roads.get(t.id);
  const row={status:'loading',t};roads.set(t.id,row);
  loadJSON(t).then(d=>{
   row.routes=d.routes.map(x=>makeRoute(x,row));
   for(const r of row.routes){put(starts,r.sx,r.sz,r);put(ends,r.ex,r.ez,r);}
   const fresh=new Set(row.routes);for(const r of row.routes)link(r);
   for(const r of row.routes)for(const p of near(ends,r.sx,r.sz,9))if(!fresh.has(p))link(p);
   d.routes.forEach((x,i)=>{for(const c of x.cars)addCar(row.routes[i],c.distance%x.length,c.paint);});
   row.status='ready';
  }).catch(()=>{row.status='error';});
  return row;
 }
 function addCar(r,s,paint){
  const h=rand(),body=h<.58?0:h<.9?1:2;
  const car={r,s,v:0,acc:0,lane:Math.floor(rand()*3),lat:0,f:.85+rand()*.3,body,half:BODIES[body].len*SIZE/2,paint:PAINTS[(paint*5+Math.floor(rand()*PAINTS.length))%PAINTS.length],
   alpha:0,conn:null,plan:undefined,fade:false,x:0,y:0,z:0,yaw:0};
  car.v=r.v0*car.f*.6;car.lat=laneOff(r,car.lane);insert(r,car);place(car);return car;
 }
 function insert(r,car){const a=r.cars;let i=a.length;a.push(car);while(i>0&&a[i-1].s>car.s){a[i]=a[i-1];i--;}a[i]=car;}
 const remove=(r,car)=>{const i=r.cars.indexOf(car);if(i>=0)r.cars.splice(i,1);};

 // Pavement width to the right of the lane, from the painted mask: lane count and street speed.
 function probe(r){
  if(r.lanes)return;
  const out=[];
  for(const f of [.25,.5,.75]){
   const p=pointAt(r,r.length*f),y=heightAt(r,r.length*f),rx=-Math.cos(p.yaw),rz=Math.sin(p.yaw);let d=0,v;
   for(;d<12;d+=.5){v=maskAtWorld(p.x+rx*d,y,p.z+rz*d);if(v!==255)break;}
   if(v===-1)return;
   out.push(d);
  }
  out.sort((a,b)=>a-b);const half=out[1]+1.8;
  r.lanes=half>=7.6?3:half>=4.9?2:1;r.v0=r.lanes>1?14:half>=3.6?10:8;
  // Wider streets carry more simulated cars (ambient density only).
  const want=r.lanes>1?Math.floor(r.length*r.lanes/70):0;
  for(let k=r.cars.length;k<want;k++){const s=rand()*r.length;if(r.cars.every(c=>Math.abs(c.s-s)>14))addCar(r,s,Math.floor(rand()*7));}
 }

 // ---- motion -------------------------------------------------------------------------------
 function heightAt(r,d){const s=r.samples;let lo=0,hi=s.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(s[m].distance<d)lo=m;else hi=m;}const a=s[lo],b=s[hi];return a.y+(b.y-a.y)*Math.max(0,Math.min(1,(d-a.distance)/((b.distance-a.distance)||1)));}
 const exitS=r=>r.length-(r.next.length?TRIM:0);
 const laneOff=(r,lane)=>r.lanes>1?Math.min(lane,r.lanes-1)*LANE_W-.15:0;
 function lanePoint(r,s,lat){
  const p=pointAt(r,s),a=pointAt(r,Math.max(0,s-2)),b=pointAt(r,Math.min(r.length,s+2)),yaw=Math.atan2(b.x-a.x,b.z-a.z);
  return {x:p.x-Math.cos(yaw)*lat,y:heightAt(r,s),z:p.z+Math.sin(yaw)*lat,yaw};
 }
 function place(car){
  let p;
  if(car.conn){const c=car.conn,t=Math.max(0,Math.min(1,(car.s-c.s0)/c.len)),u=1-t,k=[u*u*u,3*u*u*t,3*u*t*t,t*t*t],dk=[-3*u*u,3*u*u-6*u*t,6*u*t-3*t*t,3*t*t];
   p={x:k.reduce((s,w,i)=>s+w*c.p[i][0],0),z:k.reduce((s,w,i)=>s+w*c.p[i][1],0),y:c.y0+(c.y1-c.y0)*t,yaw:Math.atan2(dk.reduce((s,w,i)=>s+w*c.p[i][0],0),dk.reduce((s,w,i)=>s+w*c.p[i][1],0))};}
  else p=lanePoint(car.r,Math.max(0,Math.min(car.r.length,car.s)),car.lat);
  car.x=p.x;car.y=p.y;car.z=p.z;car.yaw=p.yaw;
 }
 function choose(r){
  if(!r.next.length)return r.twin||null;
  let total=0;const w=r.next.map(q=>{const turn=Math.atan2(r.d1[0]*q.d0[1]-r.d1[1]*q.d0[0],r.d1[0]*q.d0[0]+r.d1[1]*q.d0[1]),x=Math.abs(turn)<.6?4:turn>0?1:1.4;total+=x;return x;});
  let k=rand()*total;for(let i=0;i<w.length;i++)if((k-=w[i])<=0)return r.next[i];return r.next[0];
 }
 function connect(car,q){
  const r=car.r,uturn=q===r.twin&&!r.next.length,enter=uturn?0:TRIM,a=lanePoint(r,exitS(r),car.lat);
  if(q.lanes)car.lane=Math.floor(rand()*q.lanes);car.lat=laneOff(q,car.lane);const b=lanePoint(q,Math.min(enter,q.length),car.lat);
  const da=[Math.sin(a.yaw),Math.cos(a.yaw)],db=[Math.sin(b.yaw),Math.cos(b.yaw)],gap=Math.hypot(b.x-a.x,b.z-a.z),k=uturn?4.5:Math.max(1,gap*.42);
  const p=[[a.x,a.z],[a.x+da[0]*k,a.z+da[1]*k],[b.x-db[0]*k,b.z-db[1]*k],[b.x,b.z]];let len=0;
  for(let i=1,last=p[0];i<=8;i++){const t=i/8,u=1-t,w=[u*u*u,3*u*u*t,3*u*t*t,t*t*t],pt=[0,1].map(j=>w.reduce((s,x,n)=>s+x*p[n][j],0));len+=Math.hypot(pt[0]-last[0],pt[1]-last[1]);last=pt;}
  const turn=Math.abs(Math.atan2(da[0]*db[1]-da[1]*db[0],da[0]*db[0]+da[1]*db[1]));
  return {p,len:Math.max(len,.5),y0:a.y,y1:b.y,s0:enter-len,enter,vmax:turn<.3?99:Math.sqrt(DRIVER.aLat*Math.max(2,len/turn))};
 }
 function axisOf(node,r){const y=Math.atan2(r.d1[0],r.d1[1]);return Math.abs(Math.sin(y-node.axis))>.707?1:0;}
 const idm=(v,v0,gap,dv)=>{const ss=DRIVER.s0+Math.max(0,v*DRIVER.T+v*dv/(2*Math.sqrt(DRIVER.a*DRIVER.b)));return DRIVER.a*(1-(v/Math.max(v0,.1))**4-(ss/Math.max(gap,.1))**2);};

 function accel(car){
  const r=car.r,v=car.v,v0=r.v0*car.f,ex=exitS(r),lane=Math.min(car.lane,Math.max(0,r.lanes-1));
  if(car.fade)return 0;
  let a=car.conn?Math.min(idm(v,Math.min(v0,car.conn.vmax),1e3,0),0)+(v<car.conn.vmax?DRIVER.a*.6:0):idm(v,v0,1e3,0);
  const cars=r.cars,i=cars.indexOf(car);let lead=null;
  for(let j=i+1;j<cars.length&&j<i+8;j++){const o=cars[j];if(o.conn||car.conn||Math.min(o.lane,Math.max(0,r.lanes-1))===lane){lead=o;break;}}
  if(lead)a=Math.min(a,idm(v,v0,lead.s-car.s-lead.half-car.half,v-lead.v));
  if(car.conn)return Math.max(-9,a);
  const left=ex-car.s;
  if(car.plan===undefined&&left<60)car.plan=choose(r);
  const q=car.plan&&simSet.has(car.plan)?car.plan:null;
  // Withheld bridges and unloaded tiles end a lane: drive on and fade out there, never queue.
  if(!q&&left<8){car.fade=true;return 0;}
  if(left<70){
   if(q){
    if(!lead){const o=q.cars[0];if(o)a=Math.min(a,idm(v,v0,left+TRIM*2+(o.s-TRIM)-o.half-car.half,v-o.v));}
    const vt=q===r.twin&&!r.next.length?3.5:Math.sqrt(DRIVER.aLat*7);   // slow for the turn ahead
    if(Math.abs(Math.atan2(r.d1[0]*q.d0[1]-r.d1[1]*q.d0[0],r.d1[0]*q.d0[0]+r.d1[1]*q.d0[1]))>.5||!r.next.length)a=Math.min(a,idm(v,Math.min(v0,Math.sqrt(vt*vt+2*DRIVER.b*Math.max(0,left-car.half))),1e3,0));
   }
   const node=r.endNode;
   if(node&&node.ins.size>=3&&left<40){
    const ax=axisOf(node,r);node.req[ax]++;active.add(node);
    const gap=left-car.half-.5;
    if(node.green!==ax&&!(v*v/(2*Math.max(gap,.1))>4.5&&gap<v*1.2))a=Math.min(a,idm(v,v0,gap,v));
   }
  }
  return Math.max(-9,a);
 }
 const active=new Set();
 let simSet=new Set();
 function step(routes,dt,view){
  const moving=[];
  for(const r of routes)for(const c of r.cars){c.acc=accel(c);moving.push(c);}
  for(const c of moving){
   c.v=Math.max(0,c.v+c.acc*dt);c.s+=c.v*dt;
   if(c.conn&&c.s>=c.conn.enter)c.conn=null;
   const lt=laneOff(c.r,c.lane);if(!c.conn)c.lat+=Math.sign(lt-c.lat)*Math.min(Math.abs(lt-c.lat),1.2*dt);
   if(c.fade)c.alpha=Math.max(0,c.alpha-dt*2.5);
   const r=c.r;
   if(!c.conn&&c.s>=exitS(r)){
    const q=c.plan===undefined?choose(r):c.plan;
    if(!q||!simSet.has(q)){c.s=exitS(r);c.v=0;c.fade=true;}
    else{const conn=connect(c,q);remove(r,c);c.r=q;c.s=conn.s0+(c.s-exitS(r));c.conn=conn;c.plan=undefined;insert(q,c);}
   }
   if(c.fade&&c.alpha<.02)respawn(c,routes,view);
  }
  for(const r of routes){const a=r.cars;for(let i=1;i<a.length;i++){const c=a[i];let j=i;while(j>0&&a[j-1].s>c.s){a[j]=a[j-1];j--;}a[j]=c;}}
  for(const node of active){
   if(node.green===-1){if((node.t+=dt)>1.5){node.green=node.nextGreen;node.t=0;}}
   else{const g=node.green,o=1-g;node.t+=dt;if(node.req[o]&&((node.t>4&&!node.req[g])||node.t>14)){node.green=-1;node.nextGreen=o;node.t=0;}}
   node.req[0]=node.req[1]=0;
  }
  active.clear();
 }
 // Re-enter off screen, preferring lanes that begin where the loaded lane graph begins.
 function respawn(c,routes,view){
  for(let k=0;k<40;k++){
   const r=routes[Math.floor(rand()*routes.length)];if(!r||r.length<50)continue;
   const source=!near(ends,r.sx,r.sz,9).some(p=>p!==r.twin&&simSet.has(p)),s=source?rand()*10:rand()*r.length*.8,[u,v]=projectActor({...pointAt(r,s),y:heightAt(r,s)},projection);
   if(k<30&&(u>view[0]-20&&u<view[2]+20&&v>view[1]-20&&v<view[3]+20||k<15&&!source))continue;
   if(r.cars.some(o=>Math.abs(o.s-s)<15))continue;
   remove(c.r,c);Object.assign(c,{r,s,v:r.v0*.5,conn:null,plan:undefined,fade:false,alpha:0});c.lat=laneOff(r,c.lane);insert(r,c);return;
  }
 }
 function inView(view){const m=MARGIN_M;return index.tiles.filter(t=>overlaps([view[0]-m,view[1]-m,view[2]+m,view[3]+m],t.rect_m)).slice(0,MAX_TILES);}
 const simRoutes=view=>inView(view).flatMap(t=>{const r=ensureRoad(t);return r.status==='ready'?r.routes:[];});

 // ---- drawing ------------------------------------------------------------------------------
 const sprites=new Map();let spriteKey='';
 function canvasFor(w,h){return new OffscreenCanvas(Math.max(1,Math.ceil(w)),Math.max(1,Math.ceil(h)));}
 // Back-face-culled shaded boxes (body, glasshouse) projected through the map camera.
 function carSprite(body,paint,yb,nb,ppm){
  const key=`${body}|${paint}|${yb}|${nb}`;let s=sprites.get(key);if(s)return s;
  const yaw=yb/YAW_STEPS*Math.PI*2,fx=Math.sin(yaw),fz=Math.cos(yaw),rx=fz,rz=-fx,night=nb/4,col=hex(paint),glass=hex(GLASS);
  const w=(x,y,z)=>[rx*x*SIZE+fx*z*SIZE,y*SIZE,rz*x*SIZE+fz*z*SIZE];
  const faces=[];
  const sh=[[-1.05,-2.55],[1.05,-2.55],[1.05,2.55],[-1.05,2.55]].map(([x,z])=>w(x*BODIES[body].len/4.6,0,z*BODIES[body].len/4.6));
  for(const [z0,z1,t0,t1,xb,xt,y0,y1,kind] of BODIES[body].parts){
   const B=[w(-xb,y0,z0),w(xb,y0,z0),w(xb,y0,z1),w(-xb,y0,z1)],T=[w(-xt,y1,t0),w(xt,y1,t0),w(xt,y1,t1),w(-xt,y1,t1)];
   const quads=[[T[0],T[1],T[2],T[3],'top'],[B[0],B[1],T[1],T[0],'back'],[B[2],B[3],T[3],T[2],'front'],[B[1],B[2],T[2],T[1],'side'],[B[3],B[0],T[0],T[3],'side']];
   const mid=w(0,(y0+y1)/2,(z0+z1+t0+t1)/4);
   for(const [a,b,c,d,f] of quads){
    const u=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],v=[d[0]-b[0],d[1]-b[1],d[2]-b[2]],n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],out=[0,1,2].map(i=>(a[i]+b[i]+c[i]+d[i])/4-mid[i]),m=(Math.hypot(...n)||1)*(n[0]*out[0]+n[1]*out[1]+n[2]*out[2]<0?-1:1);
    const nn=n.map(x=>x/m),facing=nn[0]*cam[0]+nn[1]*cam[1]+nn[2]*cam[2];if(facing<=.02&&f!=='top')continue;
    const isGlass=kind===1?f!=='top':kind===2&&f==='front';
    const k=(isGlass?.75:.62)+(isGlass?.35:.5)*Math.max(0,nn[0]*light[0]+nn[1]*light[1]+nn[2]*light[2]);
    faces.push({pts:[a,b,c,d],fill:rgb(isGlass?glass:col,Math.min(1.12,k),night)});
   }
  }
  const all=[...sh,...faces.flatMap(f=>f.pts)].map(p=>plane(...p)),pad=2;
  const x0=Math.min(...all.map(p=>p[0])),x1=Math.max(...all.map(p=>p[0])),y0=Math.min(...all.map(p=>p[1])),y1=Math.max(...all.map(p=>p[1]));
  const c=canvasFor((x1-x0)*ppm+pad*2,(y1-y0)*ppm+pad*2),g=c.getContext('2d'),to=p=>{const q=plane(...p);return [(q[0]-x0)*ppm+pad,(y1-q[1])*ppm+pad];};
  const poly=pts=>{g.beginPath();pts.forEach((p,i)=>i?g.lineTo(...to(p)):g.moveTo(...to(p)));g.closePath();};
  g.fillStyle=`rgba(10,14,20,${.32-night*.12})`;poly(sh);g.fill();
  g.lineJoin='round';g.lineWidth=Math.max(.6,ppm*.06);
  for(const f of faces){poly(f.pts);g.fillStyle=f.fill;g.strokeStyle=f.fill;g.fill();g.stroke();}
  s={c,ax:(0-x0)*ppm+pad,ay:(y1-0)*ppm+pad};sprites.set(key,s);return s;
 }
 function glowSprite(color,ppm){
  const key=`glow|${color}`;let s=sprites.get(key);if(s)return s;
  const r=Math.max(3,ppm*.9),c=canvasFor(r*2,r*2),g=c.getContext('2d'),grad=g.createRadialGradient(r,r,0,r,r,r);
  grad.addColorStop(0,color);grad.addColorStop(.25,color.replace(/[\d.]+\)$/,'.55)'));grad.addColorStop(1,color.replace(/[\d.]+\)$/,'0)'));
  g.fillStyle=grad;g.fillRect(0,0,r*2,r*2);s={c,ax:r,ay:r};sprites.set(key,s);return s;
 }
 // Low-beam pool on the road ahead: 1.5 m to 13 m, brightest by the car.
 function beamSprite(yb,ppm){
  const key=`beam|${yb}`;let s=sprites.get(key);if(s)return s;
  const yaw=yb/YAW_STEPS*Math.PI*2,fx=Math.sin(yaw),fz=Math.cos(yaw),rx=fz,rz=-fx,front=2.3*SIZE,P=(f,x)=>plane(rx*x+fx*(front+f),0,rz*x+fz*(front+f));
  const q=[P(.2,-.9),P(.2,.9),P(12,3.6),P(12,-3.6)],x0=Math.min(...q.map(p=>p[0])),x1=Math.max(...q.map(p=>p[0])),y0=Math.min(...q.map(p=>p[1])),y1=Math.max(...q.map(p=>p[1]));
  const c=canvasFor((x1-x0)*ppm+4,(y1-y0)*ppm+4),g=c.getContext('2d'),to=p=>[(p[0]-x0)*ppm+2,(y1-p[1])*ppm+2],n=to(P(.2,0)),f=to(P(12,0)),grad=g.createLinearGradient(...n,...f);
  grad.addColorStop(0,'rgba(255,236,196,.9)');grad.addColorStop(.35,'rgba(255,230,184,.42)');grad.addColorStop(1,'rgba(255,226,176,0)');
  g.fillStyle=grad;g.beginPath();q.map(to).forEach((p,i)=>i?g.lineTo(...p):g.moveTo(...p));g.closePath();g.fill();
  s={c,ax:(0-x0)*ppm+2,ay:(y1-0)*ppm+2};sprites.set(key,s);return s;
 }
 const layers={};
 function layer(name,w,h){let c=layers[name];if(!c||c.width!==w||c.height!==h)c=layers[name]=new OffscreenCanvas(w,h);const g=c.getContext('2d');g.setTransform(1,0,0,1,0,0);g.globalCompositeOperation='source-over';g.globalAlpha=1;g.clearRect(0,0,w,h);return [c,g];}
 // Paint the visible mask tiles (raw for light on pavement, keep-matte for car occlusion).
 function matte(view,toScreen,kind,w,h,k){
  const [mc,g]=layer('matte',w,h);g.setTransform(k,0,0,k,0,0);const a=toPx([view[0],view[3]]),b=toPx([view[2],view[1]]);
  for(let cy=Math.floor(a[1]/MASK_TILE);cy<=Math.floor(b[1]/MASK_TILE);cy++)for(let cx=Math.floor(a[0]/MASK_TILE);cx<=Math.floor(b[0]/MASK_TILE);cx++){
   const m=ensureMask(`${cx}_${cy}`);if(m.status!=='ready')continue;const r=m.tile.rect_px;
   const s0=toScreen([R[0]+r[0]/W*(R[2]-R[0]),R[3]-r[1]/H*(R[3]-R[1])]),s1=toScreen([R[0]+r[2]/W*(R[2]-R[0]),R[3]-r[3]/H*(R[3]-R[1])]);
   g.drawImage(kind==='keep'?m.keep:m.bitmap,s0[0],s0[1],s1[0]-s0[0],s1[1]-s0[1]);
  }
  return mc;
 }
 let lastDraw=null;
 return {state,
  active(scale){return scale>=MIN_SCALE;},
  advance(dt,view){
   let left=Math.max(0,Math.min(Number.isFinite(dt)?dt:0,.3));const routes=simRoutes(view);simSet=new Set(routes);
   while(left>1e-4){const h=Math.min(left,.08);step(routes,h,view);left-=h;}
   for(const r of routes)for(const c of r.cars)place(c);
  },
  draw(ctx,view,scale,toScreen,night,dpr,size){
   state.active=scale>=MIN_SCALE;state.visibleCars=0;state.cones=0;state.candidates=0;if(!state.active){lastDraw=null;return false;}
   const now=performance.now(),fdt=lastDraw===null?0:Math.min(.25,(now-lastDraw)/1000);lastDraw=now;
   const routes=simRoutes(view);let sim=0,stopped=0,speed=0;const cars=[];
   for(const r of routes)for(const c of r.cars){
    sim++;speed+=c.v;if(c.v<.3)stopped++;
    const [u,v]=projectActor(c,projection);if(u<view[0]-10||u>view[2]+10||v<view[1]-10||v>view[3]+10)continue;
    state.candidates++;probe(c.r);const m=maskAt(...toPx([u,v])),target=c.fade?0:m===255?1:0;
    c.alpha+=(target-c.alpha)*Math.min(1,fdt*5);if(target&&fdt===0)c.alpha=1;
    if(c.alpha>.02)cars.push([c,u,v]);
   }
   Object.assign(state,{loadedTiles:[...roads.values()].filter(r=>r.status==='ready').length,simulatedCars:sim,routes:routes.length,stopped,meanSpeed:sim?+(speed/sim).toFixed(2):0,signals:[...nodes].filter(n=>n.ins.size>=3).length,visibleCars:cars.length});
   if(!cars.length)return true;
   const k=Math.min(dpr,2),w=Math.max(1,Math.round(size[0]*k)),h=Math.max(1,Math.round(size[1]*k)),o=toScreen([0,0]),e=toScreen([1,0]),ppm=Math.hypot(e[0]-o[0],e[1]-o[1])*k;
   const bucket=Math.round(Math.log2(ppm)*4)/4,sp=2**bucket,fit=ppm/sp,nb=Math.round(Math.max(0,Math.min(1,night))*4);
   if(spriteKey!==String(bucket)){sprites.clear();spriteKey=String(bucket);}
   cars.sort((a,b)=>b[2]-a[2]);
   const yawBucket=y=>((Math.round(y/(Math.PI*2)*YAW_STEPS)%YAW_STEPS)+YAW_STEPS)%YAW_STEPS;
   const blit=(g,s,x,y,a)=>{g.globalAlpha=a;g.drawImage(s.c,x-s.ax*fit,y-s.ay*fit,s.c.width*fit,s.c.height*fit);};
   if(nb>0){
    // Beams fall only on pavement (and dimly on ground), never on buildings.
    const [lc,lg]=layer('light',w,h);lg.globalCompositeOperation='lighter';
    for(const [c] of cars){const p=toScreen(projectActor(c,projection)).map(n=>n*k);blit(lg,beamSprite(yawBucket(c.yaw),sp),p[0],p[1],c.alpha*night*.55);state.cones++;}
    lg.globalAlpha=1;lg.globalCompositeOperation='destination-in';lg.drawImage(matte(view,toScreen,'raw',w,h,k),0,0);
    ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.globalCompositeOperation='lighter';ctx.drawImage(lc,0,0,ctx.canvas.width,ctx.canvas.height);ctx.restore();
   }
   const [cc,cg]=layer('cars',w,h);
   for(const [c] of cars){
    const p=toScreen(projectActor(c,projection)).map(n=>n*k);
    blit(cg,carSprite(c.body,c.paint,yawBucket(c.yaw),nb,sp),p[0],p[1],c.alpha);
    if(nb>0||c.acc<-2.2){
     const fx=Math.sin(c.yaw),fz=Math.cos(c.yaw),rx=fz,rz=-fx,L=c.half-.1,lamp=(f,x,y)=>toScreen(projectActor({x:c.x+fx*f+rx*x,y:c.y+y,z:c.z+fz*f+rz*x},projection)).map(n=>n*k);
     cg.globalCompositeOperation='lighter';
     if(nb>0)for(const x of [-.72,.72]){const q=lamp(L,x*SIZE,.7*SIZE);blit(cg,glowSprite('rgba(255,246,220,1)',sp),q[0],q[1],c.alpha*night);}
     const brake=c.acc<-2.2?1:.55*night;
     if(brake>.05)for(const x of [-.75,.75]){const q=lamp(-L,x*SIZE,.75*SIZE);blit(cg,glowSprite('rgba(255,40,24,1)',sp*.6),q[0],q[1],c.alpha*brake);}
     cg.globalCompositeOperation='source-over';
    }
   }
   cg.globalAlpha=1;cg.globalCompositeOperation='destination-in';cg.drawImage(matte(view,toScreen,'keep',w,h,k),0,0);
   ctx.save();ctx.setTransform(1,0,0,1,0,0);ctx.drawImage(cc,0,0,ctx.canvas.width,ctx.canvas.height);ctx.restore();
   return true;
  }};
}
