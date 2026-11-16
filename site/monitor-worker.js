import {detectPitch} from './audio.js';
self.onmessage=({data})=>{
  try {
    const {samples,sampleRate}=data;
    if(!(samples instanceof Float32Array)||!Number.isFinite(sampleRate)||sampleRate<8000||samples.length/sampleRate>481)throw new Error('請使用 8 分鐘以內的音檔。');
    const factor=Math.max(1,Math.floor(sampleRate/16000)),rate=sampleRate/factor,mono=new Float32Array(Math.floor(samples.length/factor));
    for(let i=0;i<mono.length;i++){let sum=0;for(let j=0;j<factor;j++)sum+=samples[i*factor+j];mono[i]=sum/factor;}
    const size=4096,hop=Math.round(rate*.04),frames=[];
    for(let i=0;i<mono.length;i+=hop){
      const window=new Float32Array(size),start=i-Math.floor(size/2);
      window.set(mono.subarray(Math.max(0,start),Math.min(mono.length,start+size)),Math.max(0,-start));
      const pitch=detectPitch(window,rate);let rms=pitch?.rms;
      if(rms===undefined){let sum=0;for(const s of window)sum+=s*s;rms=Math.sqrt(sum/size);}
      frames.push({time:i/rate,midi:pitch?.midi??null,rms,confidence:pitch?.confidence??0});
      if(frames.length%100===0)self.postMessage({type:'progress',progress:i/mono.length});
    }
    self.postMessage({type:'done',frames,duration:samples.length/sampleRate});
  }catch(e){self.postMessage({type:'error',error:e.message||'無法分析這個音檔。'});}
};
