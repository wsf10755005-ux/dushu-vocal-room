import {AudioEngine,rmsToDb} from './audio.js';
import {BREATH_PLAN,breathPhaseAt,readBreathSpectrum,calibrateBreath,classifyBreathFrame,analyseBreathSession} from './breath-analysis.js';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const seconds=n=>`${Math.max(0,n).toFixed(1)} 秒`;

/** A microphone exercise for unvoiced /s/. No pitch result is required or scored. */
export function mountBreath(root,{settings={},onBusyChange=()=>{}}={}){
  root.innerHTML=`<section class="card breath-card"><div class="breath-heading"><div><span class="eyebrow">STEADY BREATH</span><h2>嘶聲氣息訓練</h2></div><span class="pill green">30 秒 × 4 組</span></div><p class="breath-instruction">均勻吐氣發出「嘶——」，不用唱出音高。</p><div class="breath-rounds" aria-label="四組練習進度">${Array.from({length:4},(_,i)=>`<div data-breath-round="${i}"><span>${String(i+1).padStart(2,'0')}</span><small>第 ${i+1} 組</small></div>`).join('')}</div><div class="breath-clock" id="breath-clock"><svg viewBox="0 0 160 160" aria-hidden="true"><circle class="breath-ring-track" cx="80" cy="80" r="71"/><circle class="breath-ring-progress" id="breath-ring" cx="80" cy="80" r="71"/></svg><div class="breath-clock-content"><span id="breath-phase">準備練習</span><strong id="breath-countdown">30</strong><span id="breath-round">第 1 組／共 4 組</span></div></div><p class="breath-cue" id="breath-cue">開始後先安靜 3 秒，量測環境聲。</p><div class="breath-live-stats"><div><small>本組偵測到嘶聲</small><strong id="breath-active">—</strong></div><div><small>本組最長持續</small><strong id="breath-longest">—</strong></div></div><div class="microphone-input breath-input"><div class="microphone-caption"><span id="breath-input-status">麥克風尚未開啟</span><span id="breath-input-level">— dB</span></div><div class="microphone-meter" role="meter" aria-label="氣息練習麥克風音量" aria-valuemin="-110" aria-valuemax="-10" aria-valuenow="-110"><div id="breath-input-fill"></div></div></div><p class="breath-status" id="breath-status" role="status" aria-live="polite">每組 30 秒，組間休息 10 秒，共四組。</p><div class="breath-transport"><button class="btn" id="breath-start">● 開始四組練習</button><button class="btn danger" id="breath-stop" hidden>■ 結束練習</button></div></section><section class="card breath-report" id="breath-report" hidden><div class="breath-heading"><h2>氣息練習回顧</h2><span class="pill" id="breath-report-completed"></span></div><p id="breath-report-message"></p><div class="breath-results" id="breath-results"></div><p class="breath-result-caption">依麥克風中的嘶聲估計持續時間。</p></section>`;
  const $=id=>root.querySelector('#'+id),engine=new AudioEngine();
  let mode='idle',destroyed=false,generation=0,startedAt=null,frames=[],quietFrames=[],calibration=null,spectrum=null,raf=0,previousPhase='',previousSet=-1,lastSummary=-1,wakeLock=null;
  const busy=()=>['pending','calibration','work','rest'].includes(mode);
  const elapsed=()=>startedAt===null?0:clamp(performance.now()/1000-startedAt,0,BREATH_PLAN.totalSeconds);
  function setBusy(value){onBusyChange(value)}
  function meter(frame,message){
    const rms=Number.isFinite(frame?.rms)?Math.max(0,frame.rms):0,db=rmsToDb(rms),level=clamp(db,-110,-10),fill=$('breath-input-fill');
    fill.style.width=rms?`${clamp((db+110)/100*100,0,100)}%`:'0%';
    fill.parentElement.setAttribute('aria-valuenow',String(Math.round(rms?level:-110)));
    fill.parentElement.classList.toggle('clipping',rms>.7);
    $('breath-input-level').textContent=rms?`${db.toFixed(1)} dB`:'— dB';
    if(message&&$('breath-input-status').textContent!==message)$('breath-input-status').textContent=message;
  }
  function controls(){const active=busy();$('breath-start').hidden=active;$('breath-stop').hidden=!active;$('breath-start').textContent=mode==='report'?'↻ 再練四組':'● 開始四組練習'}
  function release(){engine.stop();cancelAnimationFrame(raf);raf=0;if(wakeLock){wakeLock.release().catch(()=>{});wakeLock=null}}
  function updateTimeline(time){
    const phase=breathPhaseAt(time);
    if(phase.phase==='complete'){finish('四組練習已結束。',BREATH_PLAN.totalSeconds);return}
    mode=phase.phase;
    if(phase.phase!==previousPhase||phase.setIndex!==previousSet){
      previousPhase=phase.phase;previousSet=phase.setIndex;
      $('breath-phase').textContent=phase.phase==='calibration'?'環境校正':phase.phase==='rest'?'放鬆休息':'持續嘶聲';
      $('breath-cue').textContent=phase.phase==='calibration'?'請先保持安靜，正在量測環境聲。':phase.phase==='rest'?'放鬆換氣，倒數後開始下一組。':'均勻吐氣，維持舒服、連續的「嘶——」。';
      $('breath-status').textContent=phase.phase==='calibration'?'安靜 3 秒後自動開始。':phase.phase==='rest'?`第 ${phase.set} 組結束，休息 10 秒。`:`第 ${phase.set} 組開始，持續 30 秒。`;
      $('breath-clock').dataset.phase=phase.phase;
      for(const el of root.querySelectorAll('[data-breath-round]')){const index=Number(el.dataset.breathRound);el.classList.toggle('active',phase.phase!=='calibration'&&index===phase.setIndex);el.classList.toggle('complete',index<phase.setIndex||(phase.phase==='rest'&&index===phase.setIndex))}
    }
    $('breath-countdown').textContent=String(Math.ceil(Math.max(0,phase.remaining)));
    $('breath-round').textContent=`第 ${phase.set} 組／共 4 組`;
    const length=phase.end-phase.start,progress=length>0?clamp(phase.phaseElapsed/length,0,1):0;
    $('breath-ring').style.strokeDashoffset=String(446.11*(1-progress));
    if(phase.phase==='work'&&time-lastSummary>=.5&&calibration){
      lastSummary=time;const set=analyseBreathSession({frames,calibration,duration:time}).sets[phase.setIndex];
      $('breath-active').textContent=seconds(set.activeSeconds);$('breath-longest').textContent=seconds(set.longestSeconds);
    }else if(phase.phase==='calibration'){$('breath-active').textContent='—';$('breath-longest').textContent='—'}
  }
  function animate(){if(!busy()||startedAt===null||destroyed)return;updateTimeline(elapsed());if(busy())raf=requestAnimationFrame(animate)}
  function onFrame(raw,token){
    if(destroyed||token!==generation||!busy())return;
    if(startedAt===null){startedAt=raw.observedAt;mode='calibration';animate()}
    const time=clamp(raw.time-startedAt,0,BREATH_PLAN.totalSeconds),phase=breathPhaseAt(elapsed());
    if(!engine.analyser)return;
    if(!spectrum||spectrum.length!==engine.analyser.frequencyBinCount)spectrum=new Float32Array(engine.analyser.frequencyBinCount);
    engine.analyser.getFloatFrequencyData(spectrum);
    const frame={time,rms:raw.rms,...readBreathSpectrum(spectrum,engine.context.sampleRate,engine.analyser.fftSize)};
    frames.push(frame);
    if(phase.phase==='calibration'&&time>.25)quietFrames.push(frame);
    if(phase.phase!=='calibration'&&!calibration)calibration=calibrateBreath(quietFrames);
    const classification=classifyBreathFrame(frame,calibration);
    const message=phase.phase==='calibration'?'正在量測環境聲':phase.phase==='rest'?'休息中':classification.state==='hiss'?'有偵測到嘶聲':classification.state==='unavailable'?'收音資料不足':classification.state==='quiet'?'尚未收到明顯嘶聲':'聲音接近背景，尚未確認嘶聲';
    meter(frame,message);
    $('breath-clock').classList.toggle('detecting',phase.phase==='work'&&classification.detected);
  }
  async function start(){
    if(destroyed||busy())return;
    const token=++generation;release();mode='pending';startedAt=null;frames=[];quietFrames=[];calibration=null;spectrum=null;previousPhase='';previousSet=-1;lastSummary=-1;
    $('breath-report').hidden=true;$('breath-countdown').textContent='3';$('breath-phase').textContent='開啟麥克風';$('breath-status').textContent='請允許麥克風，準備環境校正。';$('breath-ring').style.strokeDashoffset='446.11';$('breath-clock').classList.remove('detecting');
    meter(null,'等待麥克風');controls();setBusy(true);
    try{
      engine.setInputThresholdDb(settings.microphoneThresholdDb??-100);
      await engine.start(frame=>onFrame(frame,token));
      if(destroyed||token!==generation)return;
      if(navigator.wakeLock?.request){const lock=await navigator.wakeLock.request('screen').catch(()=>null);if(destroyed||token!==generation){lock?.release().catch(()=>{})}else wakeLock=lock}
    }catch(error){if(destroyed||token!==generation)return;release();mode='idle';controls();setBusy(false);meter(null,'麥克風未開啟');$('breath-phase').textContent='尚未開始';$('breath-status').textContent=error.name==='NotAllowedError'?'麥克風未獲允許，請在瀏覽器設定中允許收音。':`無法開啟麥克風：${error.message}`;}
  }
  function finish(message='已提早結束練習。',duration=elapsed()){
    if(!busy())return;generation++;release();setBusy(false);meter(null,'已結束收音');$('breath-clock').classList.remove('detecting');
    if(startedAt===null){mode='idle';controls();$('breath-phase').textContent='已取消';$('breath-status').textContent='已取消開啟麥克風。';return}
    calibration??=calibrateBreath(quietFrames);
    const report=analyseBreathSession({frames,calibration,duration});mode='report';controls();
    $('breath-phase').textContent=report.completedSets===4?'四組完成':'已結束';$('breath-countdown').textContent=report.completedSets===4?'✓':'—';$('breath-status').textContent=message;
    $('breath-cue').textContent=report.calibrated?'本次結果已整理在下方。':'環境校正尚未完成，請重新開始。';
    const lastSet=report.sets[breathPhaseAt(duration).setIndex];$('breath-active').textContent=seconds(lastSet.activeSeconds);$('breath-longest').textContent=seconds(lastSet.longestSeconds);
    if(report.completedSets===4)$('breath-ring').style.strokeDashoffset='0';
    $('breath-report-completed').textContent=`完成 ${report.completedSets}／4 組`;$('breath-report-message').textContent=message;
    $('breath-results').innerHTML=report.sets.map(set=>`<article class="breath-result" data-breath-result="${set.setIndex}" data-active-seconds="${set.activeSeconds}" data-longest-seconds="${set.longestSeconds}"><div class="breath-result-heading"><h3>第 ${set.set} 組</h3><span>${set.completed?'完成 30 秒':set.observedSeconds>0?'提前結束':'尚未完成'}</span></div><dl><div><dt>偵測到嘶聲</dt><dd>${seconds(set.activeSeconds)}<small>／30 秒</small></dd></div><div><dt>最長持續</dt><dd>${seconds(set.longestSeconds)}</dd></div><div><dt>30 秒達成率</dt><dd>${Math.round(clamp(set.activeSeconds/30*100,0,100))}%</dd></div></dl></article>`).join('');
    $('breath-report').hidden=false;
    for(const el of root.querySelectorAll('[data-breath-round]')){el.classList.remove('active');el.classList.toggle('complete',report.sets[Number(el.dataset.breathRound)].completed)}
  }
  const clickStart=()=>start(),clickStop=()=>finish(),visibility=()=>{if(document.hidden&&busy())finish('練習已因切換到背景而結束。')};
  $('breath-start').addEventListener('click',clickStart);$('breath-stop').addEventListener('click',clickStop);document.addEventListener('visibilitychange',visibility);
  return{get isBusy(){return !destroyed&&busy()},destroy(){if(destroyed)return;destroyed=true;generation++;release();engine.destroy().catch(()=>{});setBusy(false);document.removeEventListener('visibilitychange',visibility);$('breath-start')?.removeEventListener('click',clickStart);$('breath-stop')?.removeEventListener('click',clickStop)}};
}
