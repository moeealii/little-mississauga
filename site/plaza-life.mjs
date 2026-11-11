// Simulated plaza life (NOT observed people or parking): parked cars in the painted stalls and
// little pedestrians walking between storefronts and cars. Layout comes from
// pipeline/life/build_plaza.py, which reads the same pavement / ground / building mask the
// street traffic uses. Runs inside the traffic draw pass and shares its car sprites.
import {projectActor} from './runtime-motion.mjs';

const SIZE=1.3;                 // same over-life-size factor as the cars
const CARS_MIN_SCALE=1.2,PEOPLE_MIN_SCALE=2.4;
const SHIRTS=['#e4572e','#f2b134','#2e86ab','#4f9d69','#f4f1ea','#7d5ba6','#d7263d','#1b998b','#ff8fa3','#33415c','#f4a259','#e9e9e4','#3a86ff','#8ac926'];
const PANTS=['#2b3445','#3d3a36','#4a5a7a','#6b6257','#1f2328','#7a7f8c','#3b4a3f'];
const SKIN=['#f1c9a5','#e0ac7e','#c68b59','#a56b43','#7a4a2b','#f5d6ba'];
const HAIR=['#1d1a17','#2e221a','#4a3222','#111111','#6b4a2f','#d8d2c4','#8a8f98'];
const SCARF=['#2e3a59','#7a2e3a','#e8e2d4','#3f5f4a','#5a4a78','#c7b08a','#1f1f24'];
const NIGHT=[20,28,52];
const hex=c=>[1,3,5].map(i=>parseInt(c.slice(i,i+2),16));
const shade=(c,night,k=1)=>`rgb(${hex(c).map((v,i)=>Math.round(Math.min(255,v*k)*(1-night*.62)+NIGHT[i]*night*.62)).join(',')})`;

export function createPlazaLife({data,projection}){
 if(data?.kind!=='simulated-plaza-life-v1')throw Error('Unrecognized plaza data');
 let seed=20261111;const rand=()=>(seed=(seed*16807)%2147483647)/2147483647,pick=a=>a[Math.floor(rand()*a.length)];
 const rect=data.rect_m,W=data.walk,[gw,gh]=W.size,[ox,oz]=W.origin,cs=W.cell;
 // two bits per cell: 0 blocked, 1 storefront walk, 2 lawn, 3 open asphalt
 const cost=new Uint8Array(gw*gh);{const raw=atob(W.cost);for(let i=0;i<gw*gh;i++){const b=i*2,bit=n=>(raw.charCodeAt(n>>3)>>(7-(n&7)))&1;cost[i]=bit(b)|bit(b+1)<<1;}}
 const Hh=data.heights,carFit=(data.car_scale||SIZE)/SIZE;   // parked cars reuse the traffic sprites, drawn a touch smaller
 function heightAt(x,z){
  const fx=Math.max(0,Math.min(Hh.size[0]-1.001,(x-Hh.origin[0])/Hh.cell)),fz=Math.max(0,Math.min(Hh.size[1]-1.001,(z-Hh.origin[1])/Hh.cell)),ix=Math.floor(fx),iz=Math.floor(fz),tx=fx-ix,tz=fz-iz,at=(a,b)=>Hh.y[b*Hh.size[0]+a];
  return (at(ix,iz)*(1-tx)+at(ix+1,iz)*tx)*(1-tz)+(at(ix,iz+1)*(1-tx)+at(ix+1,iz+1)*tx)*tz;
 }
 const cars=data.cars.map(([x,y,z,yaw,body,paint])=>{const [u,v]=projectActor({x,y,z},projection);return {x,y,z,yaw,body,paint,u,v};});
 const spots=[...data.doors.map(p=>({c:p,door:true})),...data.car_spots.map(p=>({c:p,door:false}))].filter(s=>cost[s.c[1]*gw+s.c[0]]);
 const doors=spots.filter(s=>s.door);
 const centre=([c,r])=>[ox+(c+.5)*cs,oz+(r+.5)*cs];

 // ---- paths: A* over the walk grid, then pulled straight where the way is clear -----------
 const g=new Float32Array(gw*gh),from=new Int32Array(gw*gh),stamp=new Uint32Array(gw*gh);let run=0;
 const STEP=[0,1,2.4,2];         // per-metre cost by cell kind; people prefer storefront walks
 function clear(a,b){
  const n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])*2);
  for(let i=1;i<n;i++){const c=Math.round(a[0]+(b[0]-a[0])*i/n),r=Math.round(a[1]+(b[1]-a[1])*i/n);if(cost[r*gw+c]!==1&&cost[r*gw+c]!==cost[a[1]*gw+a[0]])return false;}
  return true;
 }
 function route(a,b){
  run++;const start=a[1]*gw+a[0],goal=b[1]*gw+b[0],heap=[[0,start]];g[start]=0;stamp[start]=run;from[start]=-1;let pops=0;
  const push=n=>{heap.push(n);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p][0]<=heap[i][0])break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p;}};
  const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let i=0;for(;;){const l=i*2+1,r=l+1;let m=i;if(l<heap.length&&heap[l][0]<heap[m][0])m=l;if(r<heap.length&&heap[r][0]<heap[m][0])m=r;if(m===i)break;[heap[m],heap[i]]=[heap[i],heap[m]];i=m;}}return top;};
  while(heap.length&&pops++<24000){
   const [,cur]=pop();if(cur===goal)break;const cx=cur%gw,cy=(cur-cx)/gw;
   for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    if(!dx&&!dy)continue;const nx=cx+dx,ny=cy+dy;if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const n=ny*gw+nx,k=cost[n];if(!k)continue;
    if(dx&&dy&&(!cost[cy*gw+nx]||!cost[ny*gw+cx]))continue;
    const d=g[cur]+(dx&&dy?1.414:1)*STEP[k];if(stamp[n]===run&&g[n]<=d)continue;
    g[n]=d;stamp[n]=run;from[n]=cur;push([d+Math.hypot(b[0]-nx,b[1]-ny),n]);
   }
  }
  if(stamp[goal]!==run)return null;
  const cells=[];for(let n=goal;n!==-1;n=from[n])cells.push([n%gw,Math.floor(n/gw)]);cells.reverse();
  const out=[cells[0]];for(let i=0,j;i<cells.length-1;i=j){j=i+1;for(let k=Math.min(cells.length-1,i+14);k>i+1;k--)if(clear(cells[i],cells[k])){j=k;break;}out.push(cells[j]);}
  return out.map(centre);
 }

 // ---- people -----------------------------------------------------------------------------
 const people=[];let cheer=0,clock=0;
 function look(kid){
  const scarf=!kid&&rand()<.2;
  return {shirt:pick(SHIRTS),pants:pick(PANTS),skin:pick(SKIN),hair:scarf?pick(SCARF):pick(HAIR),scarf,bag:!kid&&rand()<.22?pick(['#f4f1ea','#c98b4a','#e4572e','#2e86ab']):null,tall:kid?.62+rand()*.12:.92+rand()*.16};
 }
 function trip(warm){
  for(let tries=0;tries<6;tries++){
   const a=pick(spots),b=rand()<.7?pick(doors):pick(spots);if(!a||!b||a===b)continue;
   const d=Math.hypot(a.c[0]-b.c[0],a.c[1]-b.c[1]);if(d<12||d>170)continue;
   const path=route(a.c,b.c);if(!path||path.length<2)continue;
   const lens=[0];for(let i=1;i<path.length;i++)lens.push(lens[i-1]+Math.hypot(path[i][0]-path[i-1][0],path[i][1]-path[i-1][1]));
   const total=lens.at(-1),speed=(1.15+rand()*.5)*SIZE,start=warm?rand()*total*.9:0,n=rand()<.3?2:rand()<.1?3:1,group=[];
   for(let i=0;i<n;i++){const kid=i===2||(n===2&&rand()<.25);group.push({path,lens,total,speed,s:start-i*.2,side:(i-(n-1)/2)*.75+(rand()-.5)*.3,phase:rand()*6.28,alpha:warm?1:0,wait:0,done:false,look:look(kid),x:0,y:0,z:0,dx:0,dz:1,moving:true,linger:rand()<.18?2+rand()*7:0});}
   return group;
  }
  return null;
 }
 function place(p){
  const s=Math.max(0,Math.min(p.total,p.s));let i=1;while(i<p.lens.length-1&&p.lens[i]<s)i++;
  const a=p.path[i-1],b=p.path[i],len=p.lens[i]-p.lens[i-1]||1,t=(s-p.lens[i-1])/len,dx=(b[0]-a[0])/len,dz=(b[1]-a[1])/len;
  p.dx+=(dx-p.dx)*.25;p.dz+=(dz-p.dz)*.25;
  p.x=a[0]+(b[0]-a[0])*t-dz*p.side;p.z=a[1]+(b[1]-a[1])*t+dx*p.side;p.y=heightAt(p.x,p.z);
 }
 let spawnDebt=0;
 return {rect,state:{cars:cars.length,people:0,visiblePeople:0,visibleCars:0},
  cheer(){cheer=2.4;},
  advance(dt,night=0){
   dt=Math.max(0,Math.min(Number.isFinite(dt)?dt:0,.25));clock+=dt;cheer=Math.max(0,cheer-dt);
   const want=Math.round(Math.max(14,Math.min(120,doors.length*.36))*(1-.4*night)),fresh=people.length===0;
   // path-finding is spread over frames: at most two new groups per tick after the first fill
   spawnDebt=Math.min(spawnDebt+dt*3,2);
   for(let k=0;people.length<want&&(fresh?k<want:spawnDebt>=1);k++){const group=trip(fresh);if(!fresh)spawnDebt--;if(group)people.push(...group);else if(!fresh)break;}
   for(let i=people.length-1;i>=0;i--){
    const p=people[i];
    if(p.s>=p.total){if(p.linger>0){p.linger-=dt;p.moving=false;}else{p.done=true;p.moving=false;}}
    else{p.s+=p.speed*dt;p.phase+=dt*p.speed*4.2/p.look.tall;p.moving=true;}
    if(p.done){p.alpha-=dt*1.8;if(p.alpha<=0){people.splice(i,1);continue;}}
    else if(p.s>=0)p.alpha=Math.min(1,p.alpha+dt*1.8);
    place(p);
   }
   this.state.people=people.length;
  },
  // env comes from the traffic pass: device-pixel scale k, sprite helpers and the shared mask.
  draw({ctx,view,scale,toScreen,night,nb,k,sp,fit,carSprite,yawBucket,paints,maskAt}){
   if(scale<CARS_MIN_SCALE||view[0]>rect[2]||view[2]<rect[0]||view[1]>rect[3]||view[3]<rect[1])return;
   const list=[];
   for(const c of cars)if(c.u>view[0]-8&&c.u<view[2]+8&&c.v>view[1]-8&&c.v<view[3]+8)list.push([c.v,0,c]);
   this.state.visibleCars=list.length;let seen=0;
   if(scale>=PEOPLE_MIN_SCALE)for(const p of people){
    if(p.alpha<=.02||p.s<0)continue;const [u,v]=projectActor(p,projection);if(u<view[0]-4||u>view[2]+4||v<view[1]-4||v>view[3]+4)continue;
    const m=maskAt(u,v);if(m<=0)continue;      // behind a building, or the mask is still loading
    list.push([v,1,p,u]);seen++;
   }
   this.state.visiblePeople=seen;if(!list.length)return;
   list.sort((a,b)=>b[0]-a[0]);
   const ppm=sp*fit,up=projection.up[1],fade=Math.min(1,(scale-PEOPLE_MIN_SCALE)/.5+.35);
   ctx.save();ctx.setTransform(1,0,0,1,0,0);
   for(const [v,kind,a,u] of list){
    if(kind===0){
     const s=carSprite(a.body,paints[a.paint%paints.length],yawBucket(a.yaw),nb,sp),p=toScreen([a.u,a.v]),f=fit*carFit;
     ctx.globalAlpha=1;ctx.drawImage(s.c,p[0]*k-s.ax*f,p[1]*k-s.ay*f,s.c.width*f,s.c.height*f);continue;
    }
    const p=toScreen([u,v]),x=p[0]*k,y=p[1]*k,L=a.look,H=1.72*SIZE*L.tall*up*ppm,wd=.5*SIZE*L.tall*ppm;
    // walking direction on screen, for the stride
    const sx=a.dx*projection.right[0]+a.dz*projection.right[2],sy=-(a.dx*projection.up[0]+a.dz*projection.up[2]),sl=Math.hypot(sx,sy)||1;
    const swing=a.moving?Math.sin(a.phase):0,stride=.3*SIZE*L.tall*ppm*swing,hop=cheer>0?Math.abs(Math.sin((cheer+a.side)*9))*H*.3:0,bob=(a.moving?Math.abs(Math.cos(a.phase))*H*.035:0)+hop;
    ctx.globalAlpha=a.alpha*fade*(.3-night*.1);ctx.fillStyle='#0a0e14';ctx.beginPath();ctx.ellipse(x,y,wd*.62,wd*.3,0,0,6.283);ctx.fill();
    ctx.globalAlpha=a.alpha*fade;
    const hip=y-H*.46-bob,sho=y-H*.8-bob,head=y-H*.93-bob,lw=Math.max(1,wd*.36);
    ctx.lineCap='round';ctx.lineWidth=lw;ctx.strokeStyle=shade(L.pants,night);
    for(const dir of [1,-1]){ctx.beginPath();ctx.moveTo(x+dir*wd*.14,hip);ctx.lineTo(x+dir*wd*.14+sx/sl*stride*dir,y-hop+sy/sl*stride*dir*.5-(dir*swing>0?0:H*.03));ctx.stroke();}
    ctx.fillStyle=shade(L.shirt,night);ctx.beginPath();ctx.roundRect(x-wd*.5,sho,wd,hip-sho+lw*.4,wd*.28);ctx.fill();
    if(H>9){ctx.lineWidth=Math.max(1,wd*.24);ctx.strokeStyle=shade(L.shirt,night,.86);for(const dir of [1,-1]){const reach=cheer>0?-H*.2:H*.26;ctx.beginPath();ctx.moveTo(x+dir*wd*.52,sho+H*.05);ctx.lineTo(x+dir*wd*.6-sx/sl*stride*dir*.6,sho+H*.05+reach);ctx.stroke();}}
    if(L.bag){ctx.fillStyle=shade(L.bag,night);ctx.fillRect(x+wd*.5,hip-H*.1,wd*.42,H*.17);}
    const r=Math.max(1.2,H*.115);
    ctx.fillStyle=shade(L.skin,night);ctx.beginPath();ctx.arc(x,head,r,0,6.283);ctx.fill();
    ctx.fillStyle=shade(L.hair,night);ctx.beginPath();
    if(L.scarf){ctx.arc(x,head,r*1.12,Math.PI*.9,Math.PI*2.1);ctx.lineTo(x+r*.9,head+r*1.2);ctx.lineTo(x-r*.9,head+r*1.2);}else ctx.arc(x,head-r*.12,r*1.02,Math.PI,Math.PI*2);
    ctx.fill();
   }
   ctx.restore();
  }};
}
