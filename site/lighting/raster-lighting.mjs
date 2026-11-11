/* Adapted from MIT-licensed Isometric Toronto lighting. See LICENSE-TORONTO.txt
 * and README.md. Uses only caller-supplied, registered artwork and emission masks.
 * No image analysis, automatic bright-pixel detection or Toronto assets are included.
 * Optional pane appearance follows three-fenestra's independent lit/tone/brightness
 * decision pattern (MIT, Copyright 2026 Edgar Perez; LICENSE-FENESTRA.txt).
 */
const clamp = n => Math.min(1, Math.max(0, n));
const mix = (a,b,t) => a + (b-a)*t;
export const LIGHT_COLOURS = Object.freeze({
  window:Object.freeze([1,243/255,220/255]),
  windowCool:Object.freeze([223/255,232/255,1]),
  street:Object.freeze([214/255,226/255,1]),
});
const TINT = [.33,.43,.66], LIFT = [.012,.02,.044];
export function detailFromScale(screenPixelsPerArtworkPixel) {
  if (!Number.isFinite(screenPixelsPerArtworkPixel) || screenPixelsPerArtworkPixel < 0) throw new RangeError('Scale must be finite and nonnegative');
  return clamp((screenPixelsPerArtworkPixel - .22) / .28);
}
export function lightingUniforms({ night = 0, share = .3, detail = 1, wet = 0, cloud = 0, coreOnly = false } = {}) {
  for (const [k,v] of Object.entries({night,share,detail,wet,cloud})) {
    if (!Number.isFinite(v)) throw new TypeError(`${k} must be finite`);
  }
  night=clamp(night); share=clamp(share); detail=clamp(detail); wet=clamp(wet); cloud=clamp(cloud);
  return { night,share,detail,wet,cloud,coreOnly:Boolean(coreOnly),
    windowStrength: Math.min(1,night*1.15)*(.95+2.2*(1-detail)),
    poolStrength: .42*Math.min(1,night*1.3)*(1+.7*(1-detail)),
  };
}
export function gradeNight(rgb, night) {
  const y = .2126*rgb[0] + .7152*rgb[1] + .0722*rgb[2];
  return rgb.map((c,i) => mix(c, Math.max(0,(y+(c-y)*.46)*TINT[i]+LIFT[i])**1.08, clamp(night)));
}
export function gradeCloud(rgb,cloud,night=0){
  const t=clamp(cloud)*(1-clamp(night));
  // Restrained atmospheric daylight reduction; not an emission/occlusion mask.
  return rgb.map((c,i)=>c*(1-t*[.16,.14,.10][i]));
}
function wetFactor(x,y,wet) {
  const fract = n => n-Math.floor(n);
  const column=Math.floor(x/3), run=Math.floor(y/7);
  const h=fract(Math.sin(column*12.9898)*43758.5453);
  const h2=fract(Math.sin(column*3.17+run*7.31)*24634.6345);
  return 1+wet*(.45+(h>.62?.5+.8*h2:0));
}
function emission(r,g,b,u,x,y,appearance=null) {
  const w=r/255, pool=b/255, threshold=(g/255)/Math.max(w,.004);
  const lit=mix(u.share,threshold<=u.share?1:0,u.detail);
  const brightness=appearance ? (.6+.4*appearance[1]/255)*(appearance[3]/255) : 1;
  const aw=clamp(w*lit*u.windowStrength*brightness);
  const ap=clamp(pool*u.poolStrength*wetFactor(x,y,u.wet))*(1-aw);
  const colour=appearance?(appearance[0]/255>=.78?[.64,.80,1]:[1,.80,.56]):threshold<.16?LIGHT_COLOURS.windowCool:LIGHT_COLOURS.window;
  return { alpha:aw+ap, poolAlpha:ap,premultiplied:colour.map((c,i)=>c*aw+LIGHT_COLOURS.street[i]*ap) };
}
/** Mask RGB byte inputs; returns premultiplied display-RGB emission (0..1).
 * R=window coverage/strength, G=R*stable threshold, B=street pool; A ignored.
 */
export function emissionPixel(r,g,b,state={},x=.5,y=.5,appearance=null) {
  return emission(r,g,b,lightingUniforms(state),x,y,appearance);
}
function dimensions(width,height) {
  if (!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0) throw new RangeError('Positive integer dimensions required');
}
function rgba(data,width,height,name) {
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length!==width*height*4) {
    throw new TypeError(`${name} must be width*height*4 RGBA bytes, in top-left row order`);
  }
}
/** CPU reference/fallback. Straight-alpha RGBA bytes in and out; masks never inferred. */
export function compositeRasterCPU({base,mask,appearance=null,width,height,lighting={},output}) {
  dimensions(width,height); rgba(base,width,height,'base'); rgba(mask,width,height,'mask');if(appearance)rgba(appearance,width,height,'appearance');
  const out=output??new Uint8ClampedArray(base.length); rgba(out,width,height,'output');
  if(out.buffer===mask.buffer||out.buffer===base.buffer)throw new TypeError('Output must not alias either input buffer');
  const u=lightingUniforms(lighting);
  for(let p=0;p<base.length;p+=4) {
    const source=[base[p]/255,base[p+1]/255,base[p+2]/255], alpha=base[p+3]/255;
    const c=gradeCloud(gradeNight(source,u.night),u.cloud,u.night), pixel=p/4;
    // gl_FragCoord is bottom-left based; wet-reflection pattern matches that convention.
    const e=emission(mask[p],mask[p+1],mask[p+2],u,pixel%width+.5,height-Math.floor(pixel/width)-.5,appearance?appearance.subarray(p,p+4):null);
    const a=e.alpha+alpha*(1-e.alpha);
    for(let i=0;i<3;i++)out[p+i]=u.coreOnly?e.premultiplied[i]*255:a?(e.premultiplied[i]+c[i]*alpha*(1-(appearance?e.poolAlpha:e.alpha)))/a*255:0;
    out[p+3]=u.coreOnly?255:a*255;
  }
  return out;
}

export const RASTER_VERTEX_GLSL = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main(){ gl_Position=vec4(a_position,0.,1.); v_uv=vec2((a_position.x+1.)*.5,(1.-a_position.y)*.5); }
`;
/** Display-RGB, not linear-light: matches the source's photographic/artwork grading.
 * Exposed for integration into a tile renderer without importing an entire viewer.
 */
export const RASTER_FRAGMENT_GLSL = `#version 300 es
precision highp float;
uniform sampler2D u_base;
uniform sampler2D u_mask;
uniform sampler2D u_appearance;
uniform float u_appearanceOn;
uniform float u_coreOnly;
uniform float u_night;
uniform float u_share;
uniform float u_detail;
uniform float u_windowStrength;
uniform float u_poolStrength;
uniform float u_wet;
uniform float u_cloud;
in vec2 v_uv;
out vec4 outColour;
vec3 nightGrade(vec3 c){
  float y=dot(c,vec3(.2126,.7152,.0722));
  vec3 g=(vec3(y)+(c-vec3(y))*.46)*vec3(.33,.43,.66)+vec3(.012,.02,.044);
  return mix(c,pow(max(g,vec3(0.)),vec3(1.08)),u_night);
}
float wetFactor(){
  float col=floor(gl_FragCoord.x/3.),run=floor(gl_FragCoord.y/7.);
  float h=fract(sin(col*12.9898)*43758.5453),h2=fract(sin(col*3.17+run*7.31)*24634.6345);
  return 1.+u_wet*(.45+(h>.62?.5+.8*h2:0.));
}
void main(){
  vec4 base=texture(u_base,v_uv), mask=texture(u_mask,v_uv);
  float threshold=mask.g/max(mask.r,.004);
  float lit=mix(u_share,step(threshold,u_share),u_detail);
  vec4 appearance=texture(u_appearance,v_uv);
  float brightness=mix(1.,(.6+.4*appearance.g)*appearance.a,u_appearanceOn);
  float aw=clamp(mask.r*lit*u_windowStrength*brightness,0.,1.);
  float ap=clamp(mask.b*u_poolStrength*wetFactor(),0.,1.)*(1.-aw);
  vec3 win=threshold<.16?vec3(${LIGHT_COLOURS.windowCool.join(',')}):vec3(${LIGHT_COLOURS.window.join(',')});
  if(u_appearanceOn>.5)win=appearance.r>=.78?vec3(.64,.80,1.):vec3(1.,.80,.56);
  vec3 pool=vec3(${LIGHT_COLOURS.street.join(',')});
  float alpha=aw+ap+base.a*(1.-aw-ap);
  vec3 graded=nightGrade(base.rgb)*(vec3(1.)-u_cloud*(1.-u_night)*vec3(.16,.14,.10));
  vec3 core=win*aw+pool*ap;
  vec3 premult=core+graded*base.a*(1.-ap-aw*(1.-u_appearanceOn));
  outColour=u_coreOnly>.5?vec4(core,1.):vec4(alpha>0.?premult/alpha:vec3(0.),alpha);
}
`;

/** Owns its buffers/textures/program, but NOT the caller's WebGL context/canvas.
 * Prefer a dedicated canvas: render mutates ordinary WebGL drawing state.
 */
export function createWebGLCompositor(canvasOrGL) {
  const gl=typeof canvasOrGL.getContext==='function'
    ?canvasOrGL.getContext('webgl2',{alpha:true,premultipliedAlpha:false,antialias:false,preserveDrawingBuffer:true})
    :canvasOrGL;
  if(!gl||typeof gl.createVertexArray!=='function')throw new Error('WebGL2 is unavailable');
  function compile(type,source) {
    const shader=gl.createShader(type); gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
      const message=gl.getShaderInfoLog(shader);gl.deleteShader(shader);throw new Error(message);
    }
    return shader;
  }
  const vertex=compile(gl.VERTEX_SHADER,RASTER_VERTEX_GLSL),fragment=compile(gl.FRAGMENT_SHADER,RASTER_FRAGMENT_GLSL);
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)) {
    const message=gl.getProgramInfoLog(program);gl.deleteProgram(program);throw new Error(message);
  }
  const vao=gl.createVertexArray(),buffer=gl.createBuffer();
  gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'a_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  const names=['base','mask','appearance','appearanceOn','coreOnly','night','share','detail','windowStrength','poolStrength','wet','cloud'];
  const locations=Object.fromEntries(names.map(n=>[n,gl.getUniformLocation(program,'u_'+n)]));
  const textures=[gl.createTexture(),gl.createTexture(),gl.createTexture()];let loaded=false,disposed=false,appearanceOn=false;
  function alive(){if(disposed)throw new Error('Compositor has been disposed');if(gl.isContextLost())throw new Error('WebGL context was lost');}
  function upload(texture,source,width,height,isMask){
    gl.bindTexture(gl.TEXTURE_2D,texture);
    // G/R is a threshold, not ordinary colour: never interpolate thresholds across windows.
    const filter=isMask?gl.NEAREST:gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
    if(ArrayBuffer.isView(source)) {rgba(source,width,height,isMask?'mask':'base');gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,source);}
    else {
      const w=source?.naturalWidth??source?.videoWidth??source?.width,h=source?.naturalHeight??source?.videoHeight??source?.height;
      if(w!==width||h!==height)throw new RangeError('Image dimensions must match the registered layer dimensions');
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);
    }
  }
  return {
    gl,
    setLayers({base,mask,appearance=null,width,height}) {
      alive();loaded=false;dimensions(width,height);
      if(width>gl.getParameter(gl.MAX_TEXTURE_SIZE)||height>gl.getParameter(gl.MAX_TEXTURE_SIZE))throw new RangeError('Layer exceeds GPU texture limit; use registered tiles');
      gl.activeTexture(gl.TEXTURE0);upload(textures[0],base,width,height,false);
      gl.activeTexture(gl.TEXTURE1);upload(textures[1],mask,width,height,true);
      gl.activeTexture(gl.TEXTURE2);upload(textures[2],appearance||new Uint8Array(4),appearance?width:1,appearance?height:1,true);appearanceOn=Boolean(appearance);
      const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`WebGL layer upload failed (${error})`);
      loaded=true;
    },
    render(lighting={}, {width=gl.canvas.width,height=gl.canvas.height,framebuffer=null}={}) {
      alive();if(!loaded)throw new Error('Upload registered base and mask layers first');dimensions(width,height);
      const u=lightingUniforms(lighting);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.viewport(0,0,width,height);
      gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.DITHER);gl.colorMask(true,true,true,true);
      gl.useProgram(program);gl.bindVertexArray(vao);
      textures.forEach((t,i)=>{gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,t);});
      gl.uniform1i(locations.base,0);gl.uniform1i(locations.mask,1);gl.uniform1i(locations.appearance,2);gl.uniform1f(locations.appearanceOn,appearanceOn?1:0);gl.uniform1f(locations.coreOnly,u.coreOnly?1:0);
      for(const name of ['night','share','detail','windowStrength','poolStrength','wet','cloud'])gl.uniform1f(locations[name],u[name]);
      gl.drawArrays(gl.TRIANGLES,0,6);
    },
    dispose(){if(disposed)return;disposed=true;textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteVertexArray(vao);gl.deleteProgram(program);},
  };
}
