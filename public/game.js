/**
 * Italy Card Game — Client v3
 * Globe UI + explicit Reveal Trump button
 */

const socket = io();

// ── State ──────────────────────────────────────────────
let myPos         = -1;
let myHand        = [];
let validIds      = [];
let isMyTurn      = false;
let currentBid    = 0;
let currentBidder = -1;
let trumpSuit     = null;
let trumpRevealed = false;
let leadSuit      = null;
let scores        = { A:0, B:0 };
let roundNum      = 1;
let matchTarget   = 30;
let players       = [];
let bidLog        = [];
let handCounts    = { 0:0,1:0,2:0,3:0 };
let dealerPos     = 0;
let dragId        = null;
let canRevealTrump= false;

// ── Audio ──────────────────────────────────────────────
let actx = null;
const aC = () => { if(!actx) actx=new(window.AudioContext||window.webkitAudioContext)(); return actx; };
function tone(f,d=.12,t='sine',v=.15){
  try{const c=aC(),o=c.createOscillator(),g=c.createGain();
    o.connect(g);g.connect(c.destination);o.type=t;o.frequency.value=f;
    g.gain.setValueAtTime(v,c.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,c.currentTime+d);
    o.start(c.currentTime);o.stop(c.currentTime+d);}catch(e){}
}
const sfxCard  = ()=>tone(440,.08,'square',.12);
const sfxDeal  = ()=>tone(660,.06,'sine',.10);
const sfxBid   = ()=>tone(392,.10,'triangle',.15);
const sfxErr   = ()=>tone(200,.15,'sawtooth',.12);
const sfxWin   = ()=>{tone(523,.15,'sine',.14);setTimeout(()=>tone(659,.15,'sine',.12),120);};
const sfxTrump = ()=>{tone(784,.2,'sine',.17);setTimeout(()=>tone(1047,.25,'sine',.14),200);};
const sfxGame  = ()=>[523,659,784,1047].forEach((f,i)=>setTimeout(()=>tone(f,.2,'sine',.14),i*150));

// ── Constants ──────────────────────────────────────────
const SYM  = {spades:'♠',hearts:'♥',diamonds:'♦',clubs:'♣'};
const COL  = {spades:'black',hearts:'red',diamonds:'red',clubs:'black'};
const TEAM_COLORS = { A:'#90caf9', B:'#ef9a9a' };

function teamOf(p){ return p%2===0?'A':'B'; }
// Translate server pos to visual slot relative to my seat
function vslot(sp){ return ['bottom','right','top','left'][((sp-myPos)+4)%4]; }

const $  = id => document.getElementById(id);
const showScreen = n => { document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); $(n).classList.add('active'); };
const showOv = id => $(id).classList.add('open');
const hideOv = id => $(id).classList.remove('open');
const hideAllOv = () => document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('open'));

function toast(msg,dur=2800){
  const el=document.createElement('div'); el.className='toast'; el.textContent=msg;
  $('toasts').appendChild(el); setTimeout(()=>el.remove(),dur+300);
}

// ── Card building ──────────────────────────────────────
function mkCard(card,cls=''){
  const d=document.createElement('div');
  d.className=`card ${COL[card.suit]} ${cls}`;
  d.dataset.id=card.id;
  d.innerHTML=`<span class="cr-tl">${card.rank}</span>
    <span class="cs-tl">${SYM[card.suit]}</span>
    <span class="cs-c">${SYM[card.suit]}</span>
    <span class="cr-br">${card.rank}</span>
    <span class="cs-br">${SYM[card.suit]}</span>`;
  return d;
}
function mkBack(cls=''){const d=document.createElement('div');d.className=`card back ${cls}`;return d;}

// ── Render my hand ─────────────────────────────────────
function renderHand(animate=false){
  const wrap=$('my-hand'); if(!wrap)return;
  wrap.innerHTML='';
  myHand.forEach((card,i)=>{
    const el=mkCard(card,'mc');
    const ok=isMyTurn&&validIds.includes(card.id);
    if(isMyTurn) el.classList.add(ok?'vh':'inv');
    if(animate){el.classList.add('deal');el.style.animationDelay=`${i*55}ms`;}
    el.addEventListener('click',()=>{
      if(!isMyTurn)return;
      if(!validIds.includes(card.id)){sfxErr();toast('Cannot play that card now!');return;}
      socket.emit('playCard',{cardId:card.id});
    });
    el.draggable=true;
    el.addEventListener('dragstart',e=>{
      if(!isMyTurn||!validIds.includes(card.id)){e.preventDefault();return;}
      dragId=card.id; el.classList.add('dragging');
      e.dataTransfer.setData('text/plain',card.id);
    });
    el.addEventListener('dragend',()=>{el.classList.remove('dragging');dragId=null;});
    wrap.appendChild(el);
  });
}

// ── Trick slots ────────────────────────────────────────
function setTrickCard(sp,card){
  const el=$(`ts-${vslot(sp)}`); if(!el)return;
  el.innerHTML=''; if(card) el.appendChild(mkCard(card,'tc played'));
}
function clearTrick(){
  ['top','bottom','left','right'].forEach(s=>{const e=$(`ts-${s}`);if(e)e.innerHTML='';});
}

// ── Trump indicator panel ──────────────────────────────
function updateTrumpPanel(){
  const slot=$('ti-card-slot'), suit=$('ti-suit');
  if(!trumpRevealed){
    if(slot){slot.innerHTML='';slot.appendChild(mkBack('sm'));}
    if(suit)suit.textContent='Hidden';
  }else{
    if(suit)suit.innerHTML=`${SYM[trumpSuit]} ${trumpSuit}`;
  }
}
function revealTrumpPanel(card){
  const slot=$('ti-card-slot'); if(!slot)return;
  slot.innerHTML='';
  const c=mkCard(card,'trump-face');
  c.style.animation='dealIn .4s ease-out';
  slot.appendChild(c);
  $('ti-suit').innerHTML=`${SYM[card.suit]} ${card.suit}`;
}

// ── Reveal Trump button ────────────────────────────────
function setRevealBtn(show){
  const btn=$('btn-reveal'); if(!btn)return;
  btn.classList.toggle('show',show);
  canRevealTrump=show;
}

function onRevealTrump(){
  socket.emit('revealTrump');
  setRevealBtn(false);
}

// ── Avatar helpers ─────────────────────────────────────
function avatarLetter(name){ return name?name.charAt(0).toUpperCase():'?'; }

function setActiveAvatar(sp){
  ['top','bottom','left','right'].forEach(s=>{
    const el=$(`av-${s==='bottom'?'me':s}`); if(el)el.classList.remove('active');
  });
  if(sp<0)return;
  const s=vslot(sp);
  const el=$(s==='bottom'?'av-me':`av-${s}`); if(el)el.classList.add('active');
}

// ── Render players ─────────────────────────────────────
function renderPlayers(ps){
  ps.forEach(p=>{
    const team=teamOf(p.position);
    const isMe=p.position===myPos;
    const s=isMe?'bottom':vslot(p.position);

    // Name + team
    if(isMe){
      $('nm-bottom').textContent=p.name+' (You)';
      const nt=$('nt-bottom');
      nt.textContent=`Team ${team}`;
      nt.className=`nb-team ${team}`;
      $('av-me-letter').textContent=avatarLetter(p.name);
      $('av-me').className=`avatar-frame ${team} sm`;
    }else{
      $(`nm-${s}`).textContent=p.name;
      const nt=$(`nt-${s}`);
      nt.textContent=`Team ${team}`;
      nt.className=`nb-team ${team}`;
      $(`av-${s}-letter`).textContent=avatarLetter(p.name);
      $(`av-${s}`).className=`avatar-frame ${team}`;
    }
  });
}

function markDealer(dp){
  ['top','left','right','bottom'].forEach(s=>{
    const el=$(s==='bottom'?'dr-bottom':`dr-${s}`); if(el)el.classList.remove('show');
  });
  if(dp<0)return;
  const s=dp===myPos?'bottom':vslot(dp);
  const el=$(s==='bottom'?'dr-bottom':`dr-${s}`); if(el)el.classList.add('show');
}

function updateOppFan(vslotName,count){
  const el=$(`fan-${vslotName}`); if(!el)return;
  el.innerHTML='';
  const n=Math.min(count,13);
  for(let i=0;i<n;i++){const d=document.createElement('div');d.className='cback';el.appendChild(d);}
}

function updateTricks(tw){
  $('ta').textContent=tw.A; $('tb').textContent=tw.B;
  players.forEach(p=>{
    const s=p.position===myPos?'bottom':vslot(p.position);
    const el=$(`ntr-${s}`); if(el)el.textContent=`${tw[teamOf(p.position)]} tricks`;
  });
}

function updateHUD(){
  $('score-a').textContent=scores.A;
  $('score-b').textContent=scores.B;
  $('hud-round').textContent=`Round ${roundNum}`;
  $('hud-target').textContent=`Target: ${matchTarget}`;
}

// ── Dealing animation ──────────────────────────────────
function showDealAnim(dealerName,firstActiveName){
  const ov=$('deal-ov'); if(!ov)return;
  $('deal-title').textContent=`${dealerName} is dealing…`;
  $('deal-sub').textContent=`${firstActiveName} will start bidding`;
  const row=$('deal-row'); row.innerHTML='';
  for(let i=0;i<8;i++){const d=document.createElement('div');d.className='deal-c';d.style.animationDelay=`${i*75}ms`;row.appendChild(d);}
  ov.classList.add('show');
  setTimeout(()=>ov.classList.remove('show'),2400);
}

// ── Seats grid (waiting room) ──────────────────────────
function renderSeats(ps){
  const grid=$('seats-grid'); if(!grid)return;
  grid.innerHTML='';
  for(let i=0;i<4;i++){
    const p=ps.find(pl=>pl.position===i);
    const isMe=p&&p.position===myPos;
    const div=document.createElement('div');
    div.className=`seat-card${p?' filled':''}${isMe?' is-me':''}`;

    if(p){
      const tm=teamOf(i);
      div.innerHTML=`
        <div class="seat-avatar ${tm}">${avatarLetter(p.name)}</div>
        <div class="seat-info">
          <div class="seat-num">Seat ${i+1}${isMe?' <span class="you-tag">★ You</span>':''}</div>
          <div class="seat-name">${p.name}</div>
        </div>
        <span class="t-badge ${tm}">Team ${tm}</span>`;
    }else{
      div.innerHTML=`
        <div class="seat-avatar empty">＋</div>
        <div class="seat-info">
          <div class="seat-num">Seat ${i+1}</div>
          <div class="seat-name" style="opacity:.3">Empty</div>
        </div>`;
    }
    if(!isMe) div.addEventListener('click',()=>socket.emit('swapSeat',{targetPos:i}));
    grid.appendChild(div);
  }
  const cnt=ps.length;
  $('wait-note').textContent=cnt<4?`Waiting for players… (${cnt}/4)`:'All 4 players ready!';
  const sb=$('start-btn');
  if(sb)sb.disabled=cnt<4||myPos!==0;
  const sbox=$('settings-box');
  if(sbox)sbox.style.display=myPos===0?'block':'none';
}

// ── Bid panel ──────────────────────────────────────────
function openBidPanel(current,canPass,hand){
  $('bid-info').textContent=current>0
    ?`Current bid: ${current} — must bid higher or pass`
    :'No bid yet — open the bidding!';
  [7,8,9].forEach(n=>{$(`bid${n}`).disabled=(n<=current);});
  const nb=$('bid-nil'); nb.disabled=!canPass; nb.textContent=canPass?'Pass (Nil)':'You MUST bid!';

  const logEl=$('bid-log'); logEl.innerHTML='';
  bidLog.forEach(e=>{
    const d=document.createElement('div'); d.className='bl-entry';
    d.innerHTML=`${e.name}: ${e.bid==='nil'?'<span style="opacity:.5">Pass</span>':`<span class="bl-bid">${e.bid}</span>`}`;
    logEl.appendChild(d);
  });

  const hp=$('hp-cards'); hp.innerHTML='';
  if(hand)hand.forEach(c=>hp.appendChild(mkCard(c)));

  showOv('ov-bid'); sfxBid();
}
function placeBid(bid){ socket.emit('makeBid',{bid}); hideOv('ov-bid'); }

// ── Power card panel ───────────────────────────────────
function openPowerPanel(hand){
  const c=$('pwr-hand'); c.innerHTML='';
  hand.forEach(card=>{
    const el=mkCard(card,'mc');
    el.style.marginLeft='0';
    el.addEventListener('click',()=>{
      socket.emit('choosePowerCard',{cardId:card.id});
      hideOv('ov-power'); toast('Power card placed face-down 🂠'); sfxDeal();
    });
    c.appendChild(el);
  });
  showOv('ov-power');
}

// ── Round end panel ────────────────────────────────────
function openRoundEnd(data){
  const{roundScore,totalScores,message,powerCard}=data;
  $('re-title').textContent=`Round ${roundNum} Over`;
  $('re-result').textContent=message;
  if(powerCard){
    $('re-pc').innerHTML=''; $('re-pc').appendChild(mkCard(powerCard));
    $('re-power').style.display='flex';
  }else{$('re-power').style.display='none';}
  ['a','b'].forEach(t=>{
    const T=t.toUpperCase(), v=roundScore[T];
    const el=$(`re-r${t}`); el.textContent=v>=0?`+${v}`:`${v}`;
    el.className=`sc-r ${v>0?'plus':v<0?'minus':''}`;
    $(`re-t${t}`).textContent=`Total: ${totalScores[T]}`;
  });
  $('re-ready').textContent=''; showOv('ov-round');
}
function onReadyNext(){ socket.emit('readyForNextRound'); $('re-ready').textContent='Waiting for others…'; }

// ── Lobby actions ──────────────────────────────────────
function onCreateRoom(){
  const n=$('inp-name').value.trim();
  if(!n){$('lobby-err').textContent='Please enter your name';sfxErr();return;}
  $('lobby-err').textContent=''; socket.emit('createRoom',{name:n});
}
function onJoinRoom(){
  const n=$('inp-name-j').value.trim(), c=$('inp-code').value.trim().toUpperCase();
  if(!n){$('lobby-err').textContent='Please enter your name';sfxErr();return;}
  if(c.length<4){$('lobby-err').textContent='Enter a valid code';sfxErr();return;}
  $('lobby-err').textContent=''; socket.emit('joinRoom',{name:n,code:c});
}
function onStartGame()  { socket.emit('startGame'); }
function onRestartGame(){ socket.emit('restartGame'); }
function copyCode(){
  navigator.clipboard?.writeText($('disp-code').textContent).then(()=>toast('Code copied! 📋'));
}
let selTarget=30;
function selectTarget(v){
  selTarget=v;
  $('t30').classList.toggle('sel',v===30);
  $('t50').classList.toggle('sel',v===50);
  socket.emit('setTarget',{target:v});
}

// ── Drag-and-drop ──────────────────────────────────────
document.addEventListener('DOMContentLoaded',()=>{
  const g=$('globe'); if(!g)return;
  g.addEventListener('dragover',e=>{if(isMyTurn&&dragId)e.preventDefault();});
  g.addEventListener('drop',e=>{
    e.preventDefault();
    const cid=e.dataTransfer.getData('text/plain')||dragId;
    if(cid&&isMyTurn&&validIds.includes(cid)) socket.emit('playCard',{cardId:cid});
  });
  const ci=$('inp-code');
  if(ci)ci.addEventListener('input',e=>e.target.value=e.target.value.toUpperCase());
});

document.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  const a=document.querySelector('.screen.active'); if(!a)return;
  if(a.id==='screen-lobby'){
    if(['inp-code','inp-name-j'].includes(document.activeElement?.id))onJoinRoom();
    else onCreateRoom();
  }
});

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════

// ── Lobby / Waiting ────────────────────────────────────
socket.on('roomCreated',({code,position,players:ps})=>{
  myPos=position; players=ps;
  $('disp-code').textContent=code;
  renderSeats(ps); showScreen('screen-waiting');
  toast(`Room created! Code: ${code}`);
});
socket.on('roomJoined',({code,position,players:ps})=>{
  myPos=position; players=ps;
  $('disp-code').textContent=code;
  renderSeats(ps); showScreen('screen-waiting');
  toast(`Joined room ${code}!`);
});
socket.on('playerJoined',({players:ps})=>{
  players=ps; renderSeats(ps); sfxDeal();
  toast(`${ps[ps.length-1].name} joined!`);
});
socket.on('allReady',({players:ps})=>{
  players=ps; renderSeats(ps);
  toast('All 4 players ready! Seat 1 can start.');
});
socket.on('targetSet',({target})=>{
  matchTarget=target;
  $('t30')?.classList.toggle('sel',target===30);
  $('t50')?.classList.toggle('sel',target===50);
  toast(`Match target: ${target} pts`);
});
socket.on('yourPosition',({position})=>{
  myPos=position; renderSeats(players);
});
socket.on('seatsUpdated',({players:ps})=>{
  players=ps; renderSeats(ps); toast('Seats updated!'); sfxDeal();
});
socket.on('gameReset',({players:ps})=>{
  players=ps; myHand=[]; validIds=[]; isMyTurn=false;
  trumpSuit=null; trumpRevealed=false; scores={A:0,B:0}; bidLog=[];
  hideAllOv(); showScreen('screen-waiting'); renderSeats(ps);
  toast('Game reset');
});

// ── Round Start ────────────────────────────────────────
socket.on('roundBegin',({roundNumber:rn,scores:sc,players:ps,matchTarget:mt,
  dealerPos:dp,dealerName,firstActiveName})=>{
  roundNum=rn; scores=sc; matchTarget=mt; players=ps; dealerPos=dp;
  myHand=[]; validIds=[]; isMyTurn=false;
  trumpSuit=null; trumpRevealed=false; leadSuit=null;
  bidLog=[]; handCounts={0:0,1:0,2:0,3:0};

  hideAllOv(); showScreen('screen-game');
  clearTrick(); updateHUD(); renderPlayers(ps); markDealer(dp);
  updateTricks({A:0,B:0}); updateTrumpPanel();
  setRevealBtn(false);
  $('trick-num').textContent='Trick 1/13';
  $('status-bar').textContent='Dealing cards…';
  setActiveAvatar(-1);
  players.forEach(p=>{if(p.position!==myPos)updateOppFan(vslot(p.position),0);});
  showDealAnim(dealerName,firstActiveName); sfxDeal();
});

socket.on('handUpdate',({hand,dealPhase})=>{
  myHand=hand; handCounts[myPos]=hand.length;
  renderHand(dealPhase==='initial');
});

// ── Calling ────────────────────────────────────────────
socket.on('callingStarted',({callerPos,callerName})=>{
  setActiveAvatar(callerPos);
  $('status-bar').textContent=`${callerName} is deciding their bid…`;
});
socket.on('callingTurn',({callerPos,callerName,currentBid:cb})=>{
  currentBid=cb; setActiveAvatar(callerPos);
  $('status-bar').textContent=`${callerName} is deciding their bid…`;
});
socket.on('yourCallingTurn',({currentBid:cb,canPass,hand})=>{
  currentBid=cb; openBidPanel(cb,canPass,hand);
});
socket.on('bidEvent',({type,pos,name,bid})=>{
  if(type==='pass'){bidLog.push({name,bid:'nil'});toast(`${name} passed`);$('status-bar').textContent=`${name} passed`;}
  else if(type==='bid'){bidLog.push({name,bid});currentBid=bid;currentBidder=pos;toast(`${name} bid ${bid}!`);sfxBid();$('status-bar').textContent=`${name} bid ${bid}…`;}
  else if(type==='cardReturned'){toast(`${name}'s power card returned`);}
});
socket.on('powerCardReturned',()=>toast('Your power card was returned'));
socket.on('selectPowerCard',({hand})=>{myHand=hand;renderHand();openPowerPanel(hand);});
socket.on('powerCardPlaced',({bidderPos,bidderName,bid})=>{
  currentBidder=bidderPos;
  $('status-bar').textContent=`${bidderName} placed power card (bid:${bid})`;
  toast(`${bidderName} placed power card face-down`);
});
socket.on('callingDone',({bidder,bidderName,bid})=>{
  currentBidder=bidder;
  $('status-bar').textContent=`${bidderName} wins bid at ${bid}. Dealing cards…`;
  toast(`${bidderName} wins bid at ${bid}!`);
});

// ── Dealing ────────────────────────────────────────────
socket.on('fullHandDealt',({hand,bidder,bid,powerCardSuit})=>{
  myHand=hand;
  for(let i=0;i<4;i++) handCounts[i]=13;
  handCounts[bidder]=12;
  players.forEach(p=>{if(p.position!==myPos)updateOppFan(vslot(p.position),handCounts[p.position]);});
  renderHand(true); sfxDeal();
  if(myPos===bidder&&powerCardSuit)
    toast(`Your power card suit: ${SYM[powerCardSuit]} ${powerCardSuit} — secret!`,3500);
});
socket.on('dealingComplete',({bidderName,bid})=>{
  $('status-bar').textContent=`${bidderName} bid ${bid}. Game starting!`;
});

// ── Playing ────────────────────────────────────────────
socket.on('playingStarted',({currentPlayer:cp,currentPlayerName,trickNumber})=>{
  setActiveAvatar(cp); $('status-bar').textContent=`${currentPlayerName} leads Trick 1`;
  $('trick-num').textContent=`Trick ${trickNumber}/13`;
});
socket.on('turnChanged',({currentPlayer:cp,currentPlayerName})=>{
  setActiveAvatar(cp);
  if(cp!==myPos){
    isMyTurn=false; validIds=[]; setRevealBtn(false); renderHand();
    $('status-bar').textContent=`${currentPlayerName}'s turn`;
  }
});
socket.on('yourTurn',({validCardIds:vids,leadSuit:ls,trumpSuit:ts,trumpRevealed:tr,canRevealTrump:cr})=>{
  isMyTurn=true; validIds=vids; leadSuit=ls;
  if(tr){trumpSuit=ts;trumpRevealed=tr;updateTrumpPanel();}
  setRevealBtn(!!cr);
  renderHand();
  $('status-bar').textContent=ls
    ?`Your turn — follow ${SYM[ls]} ${ls}`
    :'Your turn — lead any card';
  if(cr) $('status-bar').textContent='No running suit! Play any card or Reveal Trump';
});

socket.on('cardPlayed',({position,name,card})=>{
  setTrickCard(position,card);
  if(position!==myPos){
    handCounts[position]=Math.max(0,(handCounts[position]||0)-1);
    updateOppFan(vslot(position),handCounts[position]);
  }
  sfxCard();
});

// Trump revealed via button
socket.on('trumpRevealed',({trumpSuit:ts,powerCard,revealedByName})=>{
  trumpSuit=ts; trumpRevealed=true;
  revealTrumpPanel(powerCard);
  sfxTrump();
  toast(`🔮 ${revealedByName} revealed Trump: ${SYM[ts]} ${ts}!`,3000);
  $('status-bar').textContent=`Trump revealed: ${SYM[ts]} ${ts}!`;
  // After reveal, if it's still our turn, we already got a new yourTurn from server
});

socket.on('trickComplete',({winnerPos,winnerName,winnerTeam,tricksWon,trickNumber})=>{
  sfxWin(); updateTricks(tricksWon);
  $('status-bar').textContent=`${winnerName} (Team ${winnerTeam}) wins trick ${trickNumber}!`;
  toast(`${winnerName} wins the trick! 🎉`,2000);
});
socket.on('newTrickStarting',({trickNumber,leader,leaderName})=>{
  clearTrick(); leadSuit=null;
  $('trick-num').textContent=`Trick ${trickNumber}/13`;
  $('status-bar').textContent=`${leaderName} leads Trick ${trickNumber}`;
  setRevealBtn(false);
});

// ── Round / Game End ───────────────────────────────────
socket.on('roundEnd',data=>{
  scores=data.totalScores; updateHUD();
  updateTricks(data.tricksWon);
  isMyTurn=false; validIds=[]; setRevealBtn(false); renderHand();
  openRoundEnd(data);
});
socket.on('readyCount',({ready,total})=>{
  const el=$('re-ready'); if(el)el.textContent=`${ready}/${total} players ready…`;
});
socket.on('gameOver',({winner,scores:sc})=>{
  hideAllOv(); scores=sc; updateHUD();
  $('go-a').textContent=sc.A; $('go-b').textContent=sc.B;
  const b=$('win-banner');
  b.textContent=`Team ${winner} Wins!`; b.className=`win-banner ${winner}`;
  sfxGame(); showScreen('screen-gameover');
});
socket.on('playerLeft',({name})=>toast(`⚠ ${name} disconnected`,3500));
socket.on('err',msg=>{
  sfxErr(); toast(`⚠ ${msg}`,3000);
  const le=$('lobby-err'); if(le)le.textContent=msg;
  const we=$('wait-err');  if(we)we.textContent=msg;
});
