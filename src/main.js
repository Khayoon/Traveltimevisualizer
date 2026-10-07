import 'leaflet/dist/leaflet.css';
import '@fontsource/archivo/latin-400.css';
import '@fontsource/archivo/latin-500.css';
import '@fontsource/archivo/latin-600.css';
import '@fontsource/archivo/latin-700.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';
import { cities, findCity } from './cities.js';
import { createMap } from './map-view.js';
import { calculateReachable } from './routing.js';

const icons = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  pin:'<circle cx="12" cy="10" r="3"/><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  share:'<path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8"/>',
  play:'<path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
  pause:'<path d="M8 5v14M16 5v14" stroke-width="4"/>',
  compare:'<path d="M12 3v18M3 6h6v12H3zM15 6h6v12h-6z"/>',
  reset:'<path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
};
const icon = name => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.arrow}</svg>`;
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = n=>Math.round(n).toLocaleString('en-CA');
const duration = n=>{n=Math.max(0,Math.round(n));return `${Math.floor(n/60)}h ${String(n%60).padStart(2,'0')}m`;};
const params = new URLSearchParams(location.search);
const readOrigin = (key,fallback) => {
  const found=findCity(params.get(key)); if(found)return found;
  const coordinate=(params.get(`${key}Coord`)||'').split(',').map(Number);
  if(coordinate.length===2&&coordinate.every(Number.isFinite)&&coordinate[0]>=-95.2&&coordinate[0]<=-74&&coordinate[1]>=41.5&&coordinate[1]<=57)return {name:(params.get(key)||'Dropped pin').slice(0,90),coordinates:coordinate};
  return findCity(fallback);
};
const initial=Number(params.get('minutes'));
const state = {mode:params.get('mode')==='gta'?'gta':'ontario',origin:readOrigin('origin','Toronto'),other:readOrigin('compare','Mississauga'),compare:params.has('compare'),time:Number.isFinite(initial)?Math.max(0,Math.min(5000,initial)):0,max:180,playing:false,data:null,graph:null,result:null,otherResult:null,selecting:false,busy:false,generation:0};
let graphCache=new Map(), pending=new Map(), requestId=0, mainMap, secondMap, lastFrame=0, cityArrivals=[], playbackFrame, toastTimer;
const worker = new Worker(new URL('./routing.worker.js',import.meta.url),{type:'module'});
worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);if(data.type==='error'||data.error)p.reject(new Error(data.error||data.message||'Routing failed'));else p.resolve(data);};
worker.onerror=event=>{for(const p of pending.values())p.reject(new Error(event.message));pending.clear();};
const request=(type,extra={})=>new Promise((resolve,reject)=>{const id=++requestId;pending.set(id,{resolve,reject});worker.postMessage({id,type,mode:state.mode,...extra});});

document.querySelector('#app').innerHTML=`
  <header class="masthead">
    <a href="./" class="brand" aria-label="Ontario Drive-Time Explorer home"><span class="brand-symbol"><svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M11 31 17 5h5l5 26M6 31h26M20 9l-1 6m-1 4-1 6" stroke="currentColor" stroke-width="2"/></svg></span><span><strong>ONTARIO</strong><span>Drive-Time Explorer</span></span></a>
    <nav class="mode-tabs" aria-label="Map region"><button data-mode="ontario">Ontario <span>01</span></button><button data-mode="gta">GTA & Golden Horseshoe <span>02</span></button></nav>
    <div class="header-actions"><button class="text-button" id="about-button">About the data ${icon('info')}</button><button class="share-button" id="share-button">${icon('share')}<span>Share view</span></button></div>
  </header>
  <main class="explorer">
    <aside class="sidebar">
      <div class="mobile-handle"></div>
      <div class="intro"><div class="eyebrow"><span class="live-dot"></span> A ROAD ATLAS IN MOTION</div><h1>Follow the roads.<br>See what’s possible.</h1><p>One starting point. Every road within reach.</p></div>
      <section class="origin-section"><label class="field-label" for="origin-search">YOUR STARTING POINT</label><div class="origin-control"><span class="origin-dot"></span><input id="origin-search" autocomplete="off" aria-controls="search-results" aria-expanded="false" placeholder="Search a city or address"/><button id="search-button" aria-label="Search for an address">${icon('search')}</button></div><div id="search-results" class="search-results" role="listbox" hidden></div><div class="origin-tools"><button class="text-button" id="pin-button">${icon('pin')} Choose on map</button><button class="text-button" id="reset-origin" title="Return to Toronto">Reset</button></div><p class="search-note" id="search-note" hidden></p></section>
      <section class="readout" aria-live="off"><div class="eyebrow">DRIVING FROM <span id="origin-label">TORONTO</span></div><div class="region-title" id="region-title">Ontario</div><div class="time-value"><span id="hours">0</span><span class="time-unit">h</span><span id="minutes">00</span><span class="time-unit">m</span></div><div class="time-caption">behind the wheel</div><div class="reach-stat"><span id="percent">0.0</span><span class="percent-symbol">%</span><span class="reach-caption">of the mapped road<br>network reachable</span></div><div class="reach-meter"><span id="reach-meter-fill"></span></div><div class="distance-row"><span><strong id="distance">0</strong> km within reach</span><span id="total-distance">Loading network…</span></div></section>
      <section class="destinations"><div class="section-heading"><h2>Along the way</h2><span id="destination-count">FROM YOUR ORIGIN</span></div><div id="city-list" class="city-list"><p class="muted">Calculating the road ahead…</p></div></section>
      <section class="legend"><div class="section-heading"><h2>The road network</h2><button id="method-button" class="small-link">How it works ↗</button></div><div class="legend-grid"><span><i style="--road:#137f78"></i>Freeways</span><span><i style="--road:#d45b40"></i>Trunk highways</span><span><i style="--road:#b58a2f"></i>Primary roads</span><span><i style="--road:#547cb0"></i>Secondary roads</span><span><i style="--road:#a87993"></i>Local & tertiary</span><span><i class="unreached"></i>Not yet reached</span></div></section>
      <div class="sidebar-footer"><span class="estimate-dot"></span><span>Estimated free-flow driving. No live traffic.</span></div>
    </aside>
    <section class="map-workspace" aria-label="Interactive driving-time map">
      <div class="map-toolbar"><div class="map-caption"><span id="edition-number">01</span><div><strong id="map-title">The provincial view</strong><span id="coverage-label">Major-road network · OpenStreetMap</span></div></div><button id="compare-button" class="compare-button">${icon('compare')} Compare origins</button></div>
      <div class="compare-bar" id="compare-bar" hidden><div><span class="a-dot">A</span><strong id="compare-name-a">Toronto</strong></div><span class="comparison-line">SAME CLOCK. A DIFFERENT START.</span><label><span class="b-dot">B</span><select id="compare-origin" aria-label="Second comparison origin"></select></label><button id="close-compare" aria-label="Close comparison">${icon('close')}</button></div>
      <div class="maps" id="maps"><div class="map-pane"><div id="map-a" class="map"></div><div class="map-result" id="map-result-a" hidden></div></div><div class="map-pane second-pane" id="second-pane" hidden><div id="map-b" class="map"></div><div class="map-result" id="map-result-b"></div></div></div>
      <div class="map-decoration"><div class="north-arrow"><span>N</span><svg width="18" height="32" viewBox="0 0 18 32" aria-hidden="true"><path d="M9 2 17 25 9 20 1 25Z" fill="#293d39"/><path d="M9 2v18L1 25Z" fill="#faf9f4" stroke="#293d39"/></svg></div><div class="zoom-controls"><button id="zoom-in" aria-label="Zoom in">+</button><button id="zoom-out" aria-label="Zoom out">−</button><button id="fit-map" aria-label="Fit the map to the region">${icon('reset')}</button></div></div>
      <div class="map-note" id="map-note"><span class="note-rule"></span><span>Distance follows the road.<br>Not a straight line.</span></div>
      <div class="loading-overlay" id="loading"><span class="loading-road"></span><strong id="loading-title">Opening the atlas</strong><span id="loading-text">Loading real roads. Finding the connections.</span><button id="retry-button" hidden>Try again</button></div>
      <div class="selection-hint" id="selection-hint" hidden>Click a road to set your starting point <button id="cancel-pin">Cancel</button></div>
      <section class="timeline" aria-label="Driving time controls"><div class="timeline-heading"><div><span class="eyebrow">SET YOUR DRIVING TIME</span><span id="timeline-status">Start the clock. Watch the network unfold.</span></div><button id="speed-button" aria-label="Change animation speed">1× <span>playback</span></button></div><div class="timeline-main"><button id="play-button" class="play-button" aria-label="Play driving-time animation">${icon('play')}</button><div class="slider-wrap"><label class="sr-only" for="time-slider">Driving time in minutes</label><input id="time-slider" type="range" min="0" max="180" value="0" step="1"/><div class="slider-ticks" id="slider-ticks"><span>0h</span><span>1h</span><span>2h</span><span>3h</span></div></div><output id="time-output" for="time-slider">0h 00m</output></div><div class="timeline-bottom"><div class="time-presets" id="time-presets"></div><span id="max-label">Maximum from the road graph</span></div></section>
      <footer class="map-footer"><span id="network-status">READING THE NETWORK</span><span>Built on real roads <span class="footer-cross">+</span> Made for the curious</span></footer>
    </section>
  </main>
  <dialog id="about-dialog"><div class="dialog-heading"><span class="eyebrow">THE MAP, EXPLAINED</span><button id="close-about" aria-label="Close about the data">${icon('close')}</button></div><h2>Roads, not radii.</h2><p class="dialog-lead">The network lights up only when a driving route can get you there in the time you’ve chosen.</p><div id="data-facts"></div><h3>How reachability is calculated</h3><p>Each intersection is a graph node. Road segments connect them with a cost in minutes, using OpenStreetMap speed limits where available and road-class defaults otherwise. Dijkstra’s algorithm finds the lowest driving time from your selected point. One-way roads are respected. A road gradually fills as the clock advances.</p><h3>What the percentage means</h3><p>Reachable kilometres divided by all road kilometres in the selected dataset. A road reached from both ends is counted once; divided carriageways are separate mapped roads. Disconnected components remain in the denominator. This is road length, never land area.</p><h3>Know the limits</h3><p>Ontario mode is a major-road overview, not the complete provincial network. GTA mode adds residential and local detail within its extraction boundary. Routes cannot leave the dataset and re-enter. Origins snap to the nearest included road; the snap distance is shown. Travel to that road is not included.</p><p>These are free-flow estimates: no live traffic, traffic lights, turn restrictions, weather, temporary closures, or border delays. Posted speeds are not a prediction of average driving speed. Seasonal roads are not a guarantee of year-round access. Use a navigation service for actual trips.</p><h3>Data & attribution</h3><p>Road data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>, available under the ODbL. Boundaries and lakes: <a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noreferrer">Natural Earth</a>, public domain. The basemap is bundled locally. Address lookup uses <a href="https://github.com/komoot/photon" target="_blank" rel="noreferrer">Photon</a> only when you submit a search, with local caching. Address queries are sent to its public demo service; availability is not guaranteed.</p><div class="data-downloads"><a id="download-graph" href="/data/ontario.json.gz" download>Download road graph (.gz) ↗</a><a href="/data/provenance.json" target="_blank">View data provenance ↗</a></div></dialog>
  <div id="toast" class="toast" role="status" hidden></div>`;

const $=s=>document.querySelector(s);
const toast=(message)=>{clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);};
function setBusy(busy){state.busy=busy;$('#app').classList.toggle('routing',busy);$('#time-slider').disabled=busy;$('#play-button').disabled=busy;$('#time-presets').querySelectorAll('button').forEach(button=>button.disabled=busy);}
const showError=error=>{$('#loading').hidden=false;$('#loading-title').textContent='The network couldn’t load';$('#loading-text').textContent=error.message;$('#retry-button').hidden=false;$('#network-status').textContent='NETWORK UNAVAILABLE';console.error(error);};
const persist=()=>{
  const p=new URLSearchParams();p.set('mode',state.mode);p.set('origin',state.origin.name);p.set('minutes',Math.round(state.time));
  if(!findCity(state.origin.name))p.set('originCoord',state.origin.coordinates.join(','));
  if(state.compare){p.set('compare',state.other.name);if(!findCity(state.other.name))p.set('compareCoord',state.other.coordinates.join(','));}
  history.replaceState(null,'',`${location.pathname}?${p}`);
};
function routeLabels(){
  $('#origin-search').value=state.origin.name;$('#origin-label').textContent=state.origin.name.toUpperCase();$('#compare-name-a').textContent=state.origin.name;
  $('#region-title').textContent=state.mode==='gta'?'The Golden Horseshoe':'Ontario';
  $('#map-title').textContent=state.mode==='gta'?'Closer to home':'The provincial view';
  $('#coverage-label').textContent=state.mode==='gta'?'Detailed regional network · OpenStreetMap':'Major-road network · OpenStreetMap';
  $('#edition-number').textContent=state.mode==='gta'?'02':'01';
  document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===state.mode);b.setAttribute('aria-pressed',b.dataset.mode===state.mode);});
  $('#download-graph').href=`/data/${state.mode}.json.gz`;
}
async function loadMode(){
  const generation=++state.generation;pause();setBusy(true);state.result=null;state.otherResult=null;state.data=null;
  $('#loading').hidden=false;$('#retry-button').hidden=true;$('#loading-title').textContent='Opening the atlas';$('#loading-text').textContent=state.mode==='gta'?'Loading the detailed GTA road graph…':'Loading Ontario’s major-road graph…';
  routeLabels();updateCompareOptions();
  try{
    const mode=state.mode;
    if(!graphCache.has(mode)){const response=await request('load');graphCache.set(mode,{data:response.data});}
    if(generation!==state.generation)return;
    Object.assign(state,graphCache.get(mode));
    mainMap.setData(state.data);mainMap.setMode(mode);mainMap.setCities(mode==='gta'?cities.filter(c=>c.gta):cities);mainMap.fitRegion(mode);
    if(secondMap){secondMap.setData(state.data);secondMap.setMode(mode);secondMap.setCities(mode==='gta'?cities.filter(c=>c.gta):cities);}
    const facts=$('#data-facts');facts.innerHTML=`<div class="fact"><strong>${number(state.data.edges.length)}</strong><span>road segments</span></div><div class="fact"><strong>${number(state.data.nodes.length)}</strong><span>junctions & road ends</span></div><div class="fact"><strong>${state.mode==='gta'?'GTA':'Ontario'}</strong><span>${state.mode==='gta'?'regional detail':'major-road subset'}</span></div>`;
    await compute(generation);
  }catch(error){if(generation===state.generation)showError(error);}finally{if(generation===state.generation)setBusy(false);}
}
async function compute(generation=++state.generation){
  setBusy(true);pause();$('#network-status').textContent='CALCULATING SHORTEST DRIVING TIMES';
  try{
    const shortlist=state.mode==='gta'?['Mississauga','Brampton','Hamilton','Markham','Oshawa','Oakville','Newmarket','Toronto']:['Hamilton','London','Kingston','Ottawa','Sudbury','Thunder Bay','Windsor','Sault Ste. Marie','Kenora','Toronto'];
    const destinations=shortlist.filter(name=>name!==state.origin.name).map(findCity);
    const responses=await Promise.all([request('route',{origin:state.origin.coordinates,destinations}),state.compare?request('route',{origin:state.other.coordinates}):null]);
    if(generation!==state.generation)return;
    state.result=responses[0].result;state.otherResult=responses[1]?.result||null;
    state.max=state.mode==='gta'?180:Math.max(60,Math.ceil(Math.max(state.result.maxMinutes,state.otherResult?.maxMinutes||0)/60)*60);
    state.time=Math.min(state.time,state.max);mainMap.setRoute(state.result);mainMap.setOrigin(state.result.snap.coordinate,state.origin.name);
    if(secondMap&&state.otherResult){secondMap.setRoute(state.otherResult);secondMap.setOrigin(state.otherResult.snap.coordinate,state.other.name);}
    cityArrivals=(responses[0].destinations||[]).map(item=>({city:findCity(item.name),minutes:item.minutes,snapKm:item.snap?.distanceKm||0})).sort((a,b)=>a.minutes-b.minutes);
    $('#loading').hidden=true;$('#network-status').textContent=`${number(state.data.edges.length)} SEGMENTS · SHORTEST-TIME ROUTING`;
    $('#total-distance').textContent=`${number(state.result.totalKm)} km mapped`;
    const snap=state.result.snap.distanceKm;$('#search-note').hidden=false;$('#search-note').textContent=`Origin snapped ${snap<1?`${Math.round(snap*1000)} m`:`${snap.toFixed(1)} km`} to an included road.${snap>5?' This is far from the selected point.':''}`;
    setupTimeline();routeLabels();renderTime();persist();
  }catch(error){if(generation===state.generation)showError(error);}finally{if(generation===state.generation)setBusy(false);}
}
async function selectOrigin(city){
  if(!state.data){toast('The road network is still loading.');return;}
  state.origin=city;state.selecting=false;mainMap.setSelectMode(false);$('#selection-hint').hidden=true;$('#pin-button').classList.remove('selected');$('#search-results').hidden=true;$('#origin-search').setAttribute('aria-expanded','false');routeLabels();
  if(state.mode==='gta'&&city.gta===false){state.mode='ontario';await loadMode();}else await compute();
}
function setupTimeline(){
  $('#time-slider').max=state.max;
  const ticks=state.mode==='gta'?[0,30,60,90,120,150,180]:[0,.25,.5,.75,1].map(v=>Math.round(v*state.max));
  $('#slider-ticks').innerHTML=ticks.map(t=>`<span>${t<60?`${t}m`:`${+(t/60).toFixed(1)}h`}</span>`).join('');
  const presets=state.mode==='gta'?[15,30,60,90,120,180]:[60,120,240,480,720,state.max].filter((v,i,a)=>v<=state.max&&a.indexOf(v)===i);
  $('#time-presets').innerHTML=presets.map(t=>`<button data-time="${t}">${t<60?`${t}m`:`${t/60}h`}</button>`).join('');
  $('#max-label').textContent=state.mode==='gta'?'Fine detail · 3-hour window':`Furthest reachable road · ${duration(state.result.maxMinutes)}`;
}
function renderTime(){
  const rounded=Math.round(state.time);$('#hours').textContent=Math.floor(rounded/60);$('#minutes').textContent=String(rounded%60).padStart(2,'0');$('#time-output').textContent=duration(state.time);$('#time-slider').value=state.time;$('#time-slider').style.setProperty('--progress',`${100*state.time/state.max}%`);
  document.querySelectorAll('[data-time]').forEach(b=>b.classList.toggle('active',+b.dataset.time===rounded));
  if(!state.result)return;
  mainMap.setTime(state.time);const reachable=calculateReachable(state.data,state.result,state.time);
  $('#percent').textContent=reachable.percent.toFixed(1);$('#distance').textContent=number(reachable.lengthKm);$('#reach-meter-fill').style.width=`${reachable.percent}%`;
  $('#map-result-a').innerHTML=`<span class="a-dot">A</span> ${escape(state.origin.name)} <strong>${reachable.percent.toFixed(1)}% <small>reachable</small></strong>`;
  if(secondMap&&state.otherResult){secondMap.setTime(state.time);const other=calculateReachable(state.data,state.otherResult,state.time);$('#map-result-b').innerHTML=`<span class="b-dot">B</span> ${escape(state.other.name)} <strong>${other.percent.toFixed(1)}% <small>reachable</small></strong>`;}
  const reached=cityArrivals.filter(c=>Number.isFinite(c.minutes)&&c.minutes<=state.time);
  const upcoming=cityArrivals.filter(c=>c.minutes>state.time);
  const shown=[...reached.slice(-2),...upcoming].slice(0,4);
  if(shown.length<4)shown.unshift(...reached.slice(0,Math.max(0,4-shown.length)).filter(c=>!shown.includes(c)));
  $('#city-list').innerHTML=shown.map(({city,minutes})=>`<button class="city-row" data-city="${escape(city.name)}"><span>${escape(city.name)}</span><span class="${minutes<=state.time?'arrived':'not-arrived'}">${!Number.isFinite(minutes)?'No connected route':minutes<=state.time?`${duration(minutes)} <b>✓</b>`:`${duration(minutes-state.time)} to go`}</span></button>`).join('');
  $('#destination-count').textContent=`${reached.length} OF ${cityArrivals.length} REACHED`;
  $('#timeline-status').textContent=state.time===0?'Start the clock. Watch the network unfold.':state.playing?'Following every possible road…':`${duration(state.time)} from ${state.origin.name}`;
}
let playbackSpeed=1;
function pause(){state.playing=false;cancelAnimationFrame(playbackFrame);$('#play-button').innerHTML=icon('play');$('#play-button').setAttribute('aria-label','Play driving-time animation');}
function animate(timestamp){if(!state.playing)return;if(!lastFrame)lastFrame=timestamp;const elapsed=Math.min(250,timestamp-lastFrame);if(elapsed>=60){state.time=Math.min(state.max,state.time+elapsed/1000*state.max/65*playbackSpeed);lastFrame=timestamp;renderTime();}if(state.time>=state.max){pause();persist();}else playbackFrame=requestAnimationFrame(animate);}
function togglePlay(){if(state.busy||!state.result)return;if(state.playing){pause();persist();renderTime();return;}if(state.time>=state.max)state.time=0;state.playing=true;lastFrame=0;$('#play-button').innerHTML=icon('pause');$('#play-button').setAttribute('aria-label','Pause driving-time animation');playbackFrame=requestAnimationFrame(animate);}
function updateCompareOptions(){
  const options=cities.filter(c=>state.mode!=='gta'||c.gta);if(!options.some(c=>c.name===state.other.name))state.other=findCity('Mississauga');
  $('#compare-origin').innerHTML=options.map(c=>`<option value="${escape(c.name)}" ${c.name===state.other.name?'selected':''}>${escape(c.name)}</option>`).join('');
}
async function setCompare(enabled){
  state.compare=enabled;$('#compare-bar').hidden=!enabled;$('#second-pane').hidden=!enabled;$('#map-result-a').hidden=!enabled;$('#maps').classList.toggle('comparing',enabled);$('#compare-button').classList.toggle('active',enabled);$('#compare-button').setAttribute('aria-pressed',enabled);
  if(enabled&&!secondMap){secondMap=createMap($('#map-b'),{onOrigin:async city=>{state.other=city;updateCompareOptions();await compute();}});if(state.data)secondMap.setData(state.data);secondMap.setMode(state.mode);secondMap.setCities(state.mode==='gta'?cities.filter(c=>c.gta):cities);mainMap.syncWith(secondMap);}
  requestAnimationFrame(()=>{mainMap.invalidateSize();secondMap?.invalidateSize();});
  if(state.result)await compute();persist();
}

let remoteSearching=false,lastSearch=0;const searchCache=new Map();
function showSearch(matches,remote=false){const box=$('#search-results');box.innerHTML=matches.length?matches.slice(0,8).map((city,index)=>`<button role="option" data-index="${index}"><span>${escape(city.name)}</span><small>${remote?'Address result':city.gta?'Golden Horseshoe':'Ontario'}</small></button>`).join(''):'<div class="empty-search">No local match. Press Enter to look up an address.</div>';box.hidden=false;$('#origin-search').setAttribute('aria-expanded','true');box.querySelectorAll('button').forEach(button=>button.onclick=()=>selectOrigin(matches[Number(button.dataset.index)]));}
async function searchAddress(){
  const term=$('#origin-search').value.trim();if(!term)return;
  const exact=findCity(term);if(exact){await selectOrigin(exact);return;}
  const coords=term.split(',').map(Number);if(coords.length===2&&coords.every(Number.isFinite)&&coords[0]>=-95.2&&coords[0]<=-74&&coords[1]>=41.5&&coords[1]<=57){await selectOrigin({name:'Dropped pin',coordinates:coords});return;}
  if(searchCache.has(term)){showSearch(searchCache.get(term),true);return;}
  if(remoteSearching||Date.now()-lastSearch<1500)return;lastSearch=Date.now();remoteSearching=true;$('#search-note').hidden=false;$('#search-note').textContent='Looking up your address with Photon…';
  try{const bbox=state.mode==='gta'?'-80.25,43.05,-78.5,44.3':'-95.2,41.5,-74,57';const response=await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(term)}&bbox=${bbox}&limit=8&lang=en`,{signal:AbortSignal.timeout(12000)});if(!response.ok)throw new Error('Address lookup is unavailable. Choose a city or a map point.');const data=await response.json();const matches=data.features.filter(f=>!f.properties.state||/ontario/i.test(f.properties.state)).map(f=>({name:[f.properties.name||[f.properties.housenumber,f.properties.street].filter(Boolean).join(' '),f.properties.city].filter(Boolean).join(', '),coordinates:f.geometry.coordinates}));searchCache.set(term,matches);showSearch(matches,true);$('#search-note').textContent=matches.length?'Select a result to move your origin.':'No Ontario results. Try adding the municipality name.';}catch(error){$('#search-note').textContent=error.message;}finally{remoteSearching=false;}
}

mainMap=createMap($('#map-a'),{onOrigin:selectOrigin});
$('#origin-search').addEventListener('focus',()=>{$('#origin-search').select();showSearch(cities.filter(c=>state.mode!=='gta'||c.gta));});
$('#origin-search').addEventListener('input',()=>{const value=$('#origin-search').value.toLowerCase();showSearch(cities.filter(c=>(state.mode!=='gta'||c.gta)&&c.name.toLowerCase().includes(value)));});
$('#origin-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchAddress();}if(e.key==='Escape'){$('#search-results').hidden=true;$('#origin-search').setAttribute('aria-expanded','false');}if(e.key==='ArrowDown'){e.preventDefault();$('#search-results button')?.focus();}});
$('#search-results').addEventListener('keydown',event=>{const buttons=[...$('#search-results').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}if(event.key==='Escape'){$('#search-results').hidden=true;$('#origin-search').focus();}});
$('#search-button').onclick=searchAddress;
document.addEventListener('click',event=>{if(!event.target.closest('.origin-section')){$('#search-results').hidden=true;$('#origin-search').setAttribute('aria-expanded','false');}});
document.querySelectorAll('[data-mode]').forEach(button=>button.onclick=()=>{if(button.dataset.mode===state.mode)return;state.mode=button.dataset.mode;if(state.mode==='gta'&&!state.origin.gta)state.origin=findCity('Toronto');state.time=Math.min(state.time,state.mode==='gta'?180:state.time);loadMode();});
$('#retry-button').onclick=loadMode;
$('#time-slider').oninput=()=>{pause();state.time=+$('#time-slider').value;renderTime();};$('#time-slider').onchange=persist;
  $('#time-presets').onclick=event=>{const button=event.target.closest('[data-time]');if(button&&!state.busy){pause();state.time=+button.dataset.time;renderTime();persist();}};
$('#play-button').onclick=togglePlay;$('#speed-button').onclick=()=>{playbackSpeed=playbackSpeed===1?2:playbackSpeed===2?4:1;$('#speed-button').innerHTML=`${playbackSpeed}× <span>playback</span>`;};
$('#pin-button').onclick=()=>{state.selecting=!state.selecting;mainMap.setSelectMode(state.selecting);$('#selection-hint').hidden=!state.selecting;$('#pin-button').classList.toggle('selected',state.selecting);};$('#cancel-pin').onclick=()=>{$('#pin-button').click();};
$('#reset-origin').onclick=()=>selectOrigin(findCity('Toronto'));
$('#city-list').onclick=event=>{const button=event.target.closest('[data-city]');if(button)selectOrigin(findCity(button.dataset.city));};
$('#compare-button').onclick=()=>setCompare(!state.compare);$('#close-compare').onclick=()=>setCompare(false);$('#compare-origin').onchange=()=>{state.other=findCity($('#compare-origin').value);compute();};
$('#zoom-in').onclick=()=>mainMap.zoomIn();$('#zoom-out').onclick=()=>mainMap.zoomOut();$('#fit-map').onclick=()=>mainMap.fitRegion(state.mode);
$('#share-button').onclick=async()=>{persist();try{await navigator.clipboard.writeText(location.href);toast('Link copied. Your origins, time and map mode are saved.');}catch{toast('Your view is saved in the address bar. Copy that URL to share.');}};
const openAbout=()=>$('#about-dialog').showModal();$('#about-button').onclick=openAbout;$('#method-button').onclick=openAbout;$('#close-about').onclick=()=>$('#about-dialog').close();$('#about-dialog').addEventListener('click',event=>{if(event.target===$('#about-dialog'))$('#about-dialog').close();});
document.addEventListener('keydown',event=>{if(event.code==='Space'&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName)&&!$('#about-dialog').open){event.preventDefault();togglePlay();}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();persist();}});
routeLabels();updateCompareOptions();if(state.compare)setCompare(true);loadMode();
