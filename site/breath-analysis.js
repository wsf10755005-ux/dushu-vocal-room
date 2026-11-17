// This estimates sustained sibilant sound from microphone evidence. It does not
// measure lung capacity, physical airflow or a sung pitch.
const finite=Number.isFinite;
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const percentile=(values,p)=>{const a=[...values].sort((x,y)=>x-y);if(!a.length)return 0;const at=(a.length-1)*p,lo=Math.floor(at),hi=Math.ceil(at);return a[lo]+(a[hi]-a[lo])*(at-lo)};
export const BREATH_PLAN=Object.freeze({calibrationSeconds:3,setSeconds:30,restSeconds:10,sets:4,totalSeconds:153});

export function createBreathTimeline(){
  const phases=[{phase:'calibration',set:1,setIndex:0,start:0,end:3}];
  let start=3;
  for(let setIndex=0;setIndex<4;setIndex++){
    phases.push({phase:'work',set:setIndex+1,setIndex,start,end:start+30});start+=30;
    if(setIndex<3){phases.push({phase:'rest',set:setIndex+1,setIndex,start,end:start+10});start+=10}
  }
  return phases;
}
const TIMELINE=createBreathTimeline();
export function breathPhaseAt(elapsed=0){
  const time=finite(elapsed)?Math.max(0,elapsed):0;
  const p=TIMELINE.find(p=>time<p.end);
  if(!p)return{phase:'complete',set:4,setIndex:3,start:153,end:153,phaseElapsed:0,remaining:0};
  return{...p,phaseElapsed:Math.max(0,time-p.start),remaining:Math.max(0,p.end-time)};
}

/** Web Audio FFT values are dB power values. Relative powers avoid introducing
 * gain or changing the raw RMS used by other exercises. The optional flatness
 * rejects narrow tones while accepting broad, unvoiced sibilant energy. */
export function readBreathSpectrum(frequencyDb,sampleRate,fftSize){
  const invalid={highBandPower:0,highBandRatio:0,highBandFlatness:0,valid:false};
  if(!frequencyDb||!Number.isInteger(fftSize)||fftSize<64||!finite(sampleRate)||sampleRate<8000||frequencyDb.length<fftSize/2)return invalid;
  const binHz=sampleRate/fftSize,upper=Math.min(12000,sampleRate/2),highUpper=Math.min(8000,sampleRate/2);
  let total=0,high=0,logHigh=0,countHigh=0;
  for(let i=1;i<fftSize/2;i++){
    const hz=i*binHz;if(hz<80||hz>upper)continue;
    const db=frequencyDb[i];if(db!==-Infinity&&!finite(db))return invalid;
    const power=db===-Infinity?0:10**(clamp(db,-300,0)/10);
    total+=power;
    if(hz>=1500&&hz<=highUpper){high+=power;logHigh+=Math.log(Math.max(1e-30,power));countHigh++}
  }
  const flatness=countHigh&&high>0?Math.exp(logHigh/countHigh)/(high/countHigh):0;
  return{highBandPower:high,highBandRatio:total>0?clamp(high/total,0,1):0,highBandFlatness:clamp(flatness,0,1),valid:true};
}
const validFrame=f=>f&&f.valid!==false&&finite(f.rms)&&f.rms>=0&&finite(f.highBandPower)&&f.highBandPower>=0&&finite(f.highBandRatio)&&f.highBandRatio>=0&&f.highBandRatio<=1&&(f.highBandFlatness==null||finite(f.highBandFlatness)&&f.highBandFlatness>=0&&f.highBandFlatness<=1);

/** Call with the quiet countdown's frames. A very low absolute floor permits
 * soft hiss; the high band must still rise above the measured ambient sound. */
export function calibrateBreath(frames=[]){
  const quiet=(Array.isArray(frames)?frames:[]).filter(f=>validFrame(f)&&(!finite(f.time)||f.time>=.25&&f.time<3));
  const noiseRms=percentile(quiet.map(f=>f.rms),.75),noiseHighBandPower=percentile(quiet.map(f=>f.highBandPower),.75);
  return{ready:quiet.length>=5,sampleCount:quiet.length,noiseRms,noiseHighBandPower,minRms:Math.max(1e-5,noiseRms*1.1),minHighBandPower:Math.max(1e-18,noiseHighBandPower*1.7),minHighBandRatio:.28,minHighBandFlatness:.02};
}
export function classifyBreathFrame(frame,calibration){
  if(!validFrame(frame)||!calibration?.ready||!finite(calibration.minRms)||!finite(calibration.minHighBandPower))return{state:'unavailable',detected:false};
  const spectral=frame.highBandPower>=calibration.minHighBandPower&&frame.highBandRatio>=calibration.minHighBandRatio&&(frame.highBandFlatness==null||frame.highBandFlatness>=calibration.minHighBandFlatness);
  if(frame.rms>=calibration.minRms&&spectral)return{state:'hiss',detected:true};
  const aboveAmbient=frame.rms>Math.max(1e-5,calibration.noiseRms*1.03)||frame.highBandPower>Math.max(1e-18,calibration.noiseHighBandPower*1.15);
  return{state:aboveAmbient?'uncertain':'quiet',detected:false};
}
export const isHissFrame=(frame,calibration)=>classifyBreathFrame(frame,calibration).detected;

/** Each sample supplies at most 80 ms of evidence. Paused tabs, absent samples
 * and rest periods cannot turn into sustained hiss or inflate completion. */
export function analyseBreathSession({frames=[],calibration,duration=0}={}){
  const elapsed=clamp(finite(duration)?duration:0,0,153),ordered=(Array.isArray(frames)?frames:[]).filter(f=>f&&finite(f.time)&&f.time>=0&&f.time<elapsed).sort((a,b)=>a.time-b.time);
  const gaps=ordered.slice(1).map((f,i)=>f.time-ordered[i].time).filter(g=>g>.004&&g<=.08);
  const hop=clamp(percentile(gaps,.5)||1/30,.01,.08);
  const sets=TIMELINE.filter(p=>p.phase==='work').map(p=>({set:p.set,setIndex:p.setIndex,start:p.start,end:p.end,observedSeconds:0,activeSeconds:0,coverage:0,longestSeconds:0,completed:elapsed>=p.end}));
  const tails=sets.map(()=>({end:-Infinity,start:0}));
  for(let i=0;i<ordered.length;i++){
    const frame=ordered[i],next=ordered[i+1],delta=next?next.time-frame.time:hop;
    if(delta<=0)continue;
    const end=Math.min(elapsed,frame.time+Math.min(.08,delta));
    for(const s of sets){
      const a=Math.max(s.start,frame.time),b=Math.min(s.end,end);if(b<=a)continue;
      const valid=validFrame(frame);if(valid)s.observedSeconds+=b-a;
      const tail=tails[s.setIndex];
      if(valid&&isHissFrame(frame,calibration)){
        s.activeSeconds+=b-a;if(a>tail.end+.000001)tail.start=a;tail.end=b;
        s.longestSeconds=Math.max(s.longestSeconds,b-tail.start);
      }else tail.end=-Infinity;
    }
  }
  for(const s of sets){s.observedSeconds=clamp(s.observedSeconds,0,30);s.activeSeconds=clamp(s.activeSeconds,0,30);s.longestSeconds=clamp(s.longestSeconds,0,s.activeSeconds);s.coverage=100*s.activeSeconds/30}
  return{sets,activeSeconds:sets.reduce((n,s)=>n+s.activeSeconds,0),duration:elapsed,completedSets:sets.filter(s=>s.completed).length,calibrated:!!calibration?.ready};
}
